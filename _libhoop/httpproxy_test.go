package libhoop

import (
	"bufio"
	"bytes"
	"context"
	"fmt"
	"io"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
)

func newTestProxy(t *testing.T, clientW io.Writer, upstream string, extra map[string]string) Proxy {
	t.Helper()
	opts := map[string]string{"remote_url": upstream}
	for k, v := range extra {
		opts[k] = v
	}
	p, err := NewHttpProxy(context.Background(), clientW, nil, opts)
	if err != nil {
		t.Fatalf("NewHttpProxy: %v", err)
	}
	return p
}

func readResponse(t *testing.T, b []byte) *http.Response {
	t.Helper()
	resp, err := http.ReadResponse(bufio.NewReader(bytes.NewReader(b)), nil)
	if err != nil {
		t.Fatalf("client received unparseable response %q: %v", b, err)
	}
	return resp
}

func TestHttpProxyForwardsAndInjectsHeaders(t *testing.T) {
	var gotPath, gotAuth, gotQuery string
	up := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		gotPath, gotAuth, gotQuery = r.URL.Path, r.Header.Get("Authorization"), r.URL.RawQuery
		w.Header().Set("Content-Type", "application/json")
		_, _ = w.Write([]byte(`{"kind":"PodList"}`))
	}))
	defer up.Close()

	var client bytes.Buffer
	p := newTestProxy(t, &client, up.URL, map[string]string{"HEADER_AUTHORIZATION": "Bearer minted"})

	req := "GET /api/v1/namespaces/hoop/pods?limit=5 HTTP/1.1\r\nHost: x\r\n\r\n"
	if _, err := p.Write([]byte(req)); err != nil {
		t.Fatalf("write: %v", err)
	}
	if gotPath != "/api/v1/namespaces/hoop/pods" {
		t.Errorf("path = %q", gotPath)
	}
	if gotQuery != "limit=5" {
		t.Errorf("query = %q", gotQuery)
	}
	// The minted service-account token must reach the API server.
	if gotAuth != "Bearer minted" {
		t.Errorf("authorization = %q, want %q", gotAuth, "Bearer minted")
	}
	resp := readResponse(t, client.Bytes())
	body, _ := io.ReadAll(resp.Body)
	if string(body) != `{"kind":"PodList"}` {
		t.Errorf("body = %q", body)
	}
}

// A request arriving across several packets must be served once, when it is
// complete — not parsed as a truncated request.
func TestHttpProxyBuffersSplitRequest(t *testing.T) {
	var calls int
	var gotBody string
	up := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		calls++
		b, _ := io.ReadAll(r.Body)
		gotBody = string(b)
	}))
	defer up.Close()

	var client bytes.Buffer
	p := newTestProxy(t, &client, up.URL, nil)

	body := `{"apiVersion":"v1"}`
	req := fmt.Sprintf("POST /api/v1/namespaces HTTP/1.1\r\nHost: x\r\nContent-Length: %d\r\n\r\n%s", len(body), body)
	for _, chunk := range []string{req[:20], req[20:60], req[60:]} {
		if _, err := p.Write([]byte(chunk)); err != nil {
			t.Fatalf("write: %v", err)
		}
	}
	if calls != 1 {
		t.Fatalf("upstream calls = %d, want 1", calls)
	}
	if gotBody != body {
		t.Errorf("body = %q, want %q", gotBody, body)
	}
}

// Two pipelined requests in one Write must both be served, in order.
func TestHttpProxyServesPipelinedRequests(t *testing.T) {
	var paths []string
	up := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		paths = append(paths, r.URL.Path)
	}))
	defer up.Close()

	var client bytes.Buffer
	p := newTestProxy(t, &client, up.URL, nil)
	two := "GET /a HTTP/1.1\r\nHost: x\r\n\r\nGET /b HTTP/1.1\r\nHost: x\r\n\r\n"
	if _, err := p.Write([]byte(two)); err != nil {
		t.Fatalf("write: %v", err)
	}
	if len(paths) != 2 || paths[0] != "/a" || paths[1] != "/b" {
		t.Fatalf("paths = %v, want [/a /b]", paths)
	}
}

// kubectl exec/attach/port-forward ask for a protocol upgrade. Forwarding it
// without relaying frames would hang the client, so it must fail loudly.
func TestHttpProxyRefusesUpgrade(t *testing.T) {
	up := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {}))
	defer up.Close()

	var client bytes.Buffer
	p := newTestProxy(t, &client, up.URL, nil)
	req := "GET /api/v1/namespaces/hoop/pods/x/exec HTTP/1.1\r\nHost: x\r\nUpgrade: SPDY/3.1\r\nConnection: Upgrade\r\n\r\n"
	_, err := p.Write([]byte(req))
	if err == nil {
		t.Fatal("expected an error for a protocol upgrade")
	}
	if !strings.Contains(err.Error(), "SPDY/3.1") {
		t.Errorf("error = %v, want it to name the protocol", err)
	}
}

// Guardrails and the AI analyzer have no implementation here; a connection
// configured with either must be refused rather than served unprotected.
func TestHttpProxyRefusesUnsupportedFeatures(t *testing.T) {
	if _, err := NewHttpProxy(context.Background(), io.Discard, nil, map[string]string{
		"remote_url":       "https://example.com",
		"guard_rail_rules": `{"input_rules":[]}`,
	}); err == nil {
		t.Error("expected a connection with guardrail rules to be refused")
	}
}

func TestHttpProxyRequiresRemoteURL(t *testing.T) {
	for _, raw := range []string{"", "not-a-url"} {
		if _, err := NewHttpProxy(context.Background(), io.Discard, nil, map[string]string{"remote_url": raw}); err == nil {
			t.Errorf("remote_url %q should be rejected", raw)
		}
	}
}

// With allow_client_authorization the client authenticates as itself; the
// connection's own credential must not silently replace its header.
func TestHttpProxyAllowClientAuthorization(t *testing.T) {
	var gotAuth string
	up := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		gotAuth = r.Header.Get("Authorization")
	}))
	defer up.Close()

	var client bytes.Buffer
	p := newTestProxy(t, &client, up.URL, map[string]string{
		"HEADER_AUTHORIZATION":       "Bearer connection-credential",
		"allow_client_authorization": "true",
	})
	req := "GET /a HTTP/1.1\r\nHost: x\r\nAuthorization: Bearer client-own\r\n\r\n"
	if _, err := p.Write([]byte(req)); err != nil {
		t.Fatalf("write: %v", err)
	}
	if gotAuth != "Bearer client-own" {
		t.Errorf("authorization = %q, want the client's own header", gotAuth)
	}
}

// Without the option the connection's credential wins, which is what makes
// the minted service-account token authoritative.
func TestHttpProxyConnectionCredentialWins(t *testing.T) {
	var gotAuth string
	up := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		gotAuth = r.Header.Get("Authorization")
	}))
	defer up.Close()

	var client bytes.Buffer
	p := newTestProxy(t, &client, up.URL, map[string]string{"HEADER_AUTHORIZATION": "Bearer minted"})
	req := "GET /a HTTP/1.1\r\nHost: x\r\nAuthorization: Bearer client-own\r\n\r\n"
	if _, err := p.Write([]byte(req)); err != nil {
		t.Fatalf("write: %v", err)
	}
	if gotAuth != "Bearer minted" {
		t.Errorf("authorization = %q, want the connection credential", gotAuth)
	}
}

func TestHttpProxyBoundsPartialRequest(t *testing.T) {
	var client bytes.Buffer
	p := newTestProxy(t, &client, "https://example.com", nil)
	// Never a complete request: no terminating CRLFCRLF.
	junk := bytes.Repeat([]byte("x"), 1<<20)
	var err error
	for i := 0; i < 40 && err == nil; i++ {
		_, err = p.Write(junk)
	}
	if err == nil {
		t.Fatal("expected the proxy to give up on an unbounded partial request")
	}
}
