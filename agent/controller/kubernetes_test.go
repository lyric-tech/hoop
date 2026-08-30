package controller

import (
	"context"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"strings"
	"testing"
)

// withAgentToken points the projected-token path at a temp file so the minter
// can run outside a cluster.
func withAgentToken(t *testing.T, token string) {
	t.Helper()
	dir := t.TempDir()
	path := filepath.Join(dir, "token")
	if err := os.WriteFile(path, []byte(token+"\n"), 0600); err != nil {
		t.Fatal(err)
	}
	orig := saTokenPath
	saTokenPath = path
	t.Cleanup(func() { saTokenPath = orig })
}

func TestMintServiceAccountToken(t *testing.T) {
	withAgentToken(t, "agent-token")

	var gotPath, gotAuth, gotMethod string
	var gotSpec tokenRequest
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		gotPath, gotAuth, gotMethod = r.URL.Path, r.Header.Get("Authorization"), r.Method
		_ = json.NewDecoder(r.Body).Decode(&gotSpec)
		w.WriteHeader(http.StatusCreated)
		_, _ = w.Write([]byte(`{"status":{"token":"minted-token"}}`))
	}))
	defer srv.Close()

	got, err := mintServiceAccountToken(context.Background(), srv.URL, "team-a", "reader", 900)
	if err != nil {
		t.Fatalf("mint failed: %v", err)
	}
	if got != "minted-token" {
		t.Errorf("token = %q, want %q", got, "minted-token")
	}
	if want := "/api/v1/namespaces/team-a/serviceaccounts/reader/token"; gotPath != want {
		t.Errorf("path = %q, want %q", gotPath, want)
	}
	if gotMethod != http.MethodPost {
		t.Errorf("method = %q, want POST", gotMethod)
	}
	// The agent authenticates as itself; a trailing newline in the projected
	// file would make the API server reject the bearer.
	if want := "Bearer agent-token"; gotAuth != want {
		t.Errorf("authorization = %q, want %q", gotAuth, want)
	}
	if gotSpec.Spec.ExpirationSeconds != 900 {
		t.Errorf("expirationSeconds = %d, want 900", gotSpec.Spec.ExpirationSeconds)
	}
}

func TestMintServiceAccountTokenDefaultsTTL(t *testing.T) {
	withAgentToken(t, "agent-token")

	var gotSpec tokenRequest
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		_ = json.NewDecoder(r.Body).Decode(&gotSpec)
		w.WriteHeader(http.StatusCreated)
		_, _ = w.Write([]byte(`{"status":{"token":"t"}}`))
	}))
	defer srv.Close()

	if _, err := mintServiceAccountToken(context.Background(), srv.URL, "ns", "sa", 0); err != nil {
		t.Fatalf("mint failed: %v", err)
	}
	if gotSpec.Spec.ExpirationSeconds != defaultSATokenTTLSeconds {
		t.Errorf("expirationSeconds = %d, want %d", gotSpec.Spec.ExpirationSeconds, defaultSATokenTTLSeconds)
	}
}

// A denied TokenRequest must surface the API server's message: without the
// RBAC to mint, the connection has to fail rather than fall back to the
// agent's own broader identity.
func TestMintServiceAccountTokenForbidden(t *testing.T) {
	withAgentToken(t, "agent-token")

	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.WriteHeader(http.StatusForbidden)
		_, _ = w.Write([]byte(`{"message":"serviceaccounts \"reader\" is forbidden"}`))
	}))
	defer srv.Close()

	_, err := mintServiceAccountToken(context.Background(), srv.URL, "ns", "reader", 600)
	if err == nil {
		t.Fatal("expected an error for a forbidden token request")
	}
	if !strings.Contains(err.Error(), "is forbidden") {
		t.Errorf("error = %v, want it to carry the API server message", err)
	}
}

func TestMintServiceAccountTokenEmptyToken(t *testing.T) {
	withAgentToken(t, "agent-token")

	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.WriteHeader(http.StatusCreated)
		_, _ = w.Write([]byte(`{"status":{}}`))
	}))
	defer srv.Close()

	if _, err := mintServiceAccountToken(context.Background(), srv.URL, "ns", "sa", 600); err == nil {
		t.Fatal("expected an error when the API server returns no token")
	}
}
