package libhoop

import (
	"bufio"
	"bytes"
	"context"
	"crypto/tls"
	"fmt"
	"io"
	"net/http"
	"net/http/httputil"
	"net/url"
	"strings"
	"sync"

	"libhoop/aianalyzer"
)

// httpProxy forwards HTTP requests arriving on the client stream to a fixed
// upstream, and writes each response back to the client writer.
//
// It is driven entirely by Write: the agent controller never calls Run for
// this proxy, and one Write carries the whole round trip. Requests may arrive
// split across several Writes, so bytes are buffered until a complete request
// (headers plus body) is present.
//
// Scope: this is the fork's own implementation, not the upstream one. It
// serves plain HTTP request/response traffic — enough for the Kubernetes API
// (get, list, apply, logs). It deliberately refuses what it cannot serve
// correctly rather than half-serving it; see ErrUpgradeUnsupported.
//
// Known limitation: a long-lived streaming response (a watch, or `logs -f`)
// holds Write for as long as the upstream keeps the body open, so no further
// request on the same connection is served until it ends. Correct for the
// streaming request itself, but it makes the connection single-flight.
type httpProxy struct {
	ctx     context.Context
	cancel  context.CancelFunc
	clientW io.Writer
	remote  *url.URL
	headers http.Header
	// allowClientAuth leaves a client-supplied Authorization header in place
	// instead of replacing it with the connection's own credential.
	allowClientAuth bool
	client          *http.Client
	done            chan struct{}
	closeOne        sync.Once

	// buf accumulates client bytes until a full request is available.
	mu  sync.Mutex
	buf bytes.Buffer
}

// ErrUpgradeUnsupported is returned for a request that asks to switch
// protocols (WebSocket, or the SPDY upgrade `kubectl exec` and `port-forward`
// use). Those need bidirectional frame relaying, which this build does not
// implement. Failing here is deliberate: forwarding the request without the
// upgrade would leave the client waiting on a stream that never arrives.
// maxBufferedRequestBytes bounds the partial-request buffer.
const maxBufferedRequestBytes = 32 << 20

type ErrUpgradeUnsupported struct{ Protocol string }

func (e *ErrUpgradeUnsupported) Error() string {
	return fmt.Sprintf("this build cannot proxy a %q protocol upgrade; streaming commands "+
		"(exec, attach, port-forward, watch) are not supported on this connection", e.Protocol)
}

// NewHttpProxy builds the proxy from the connection's options: remote_url, an
// optional insecure flag, and HEADER_* entries injected upstream.
func NewHttpProxy(ctx context.Context, clientW io.Writer, analyzer aianalyzer.Analyzer, opts map[string]string) (Proxy, error) {
	if err := CheckGuardRailEnforcement(opts["guard_rail_rules"], "httpproxy"); err != nil {
		return nil, err
	}
	// A configured analyzer that this build silently ignored would leave a
	// connection believing its traffic is being classified when it is not.
	if analyzer != nil {
		return nil, fmt.Errorf("connection has an AI session analyzer configured, but this build " +
			"has no analysis engine for the http proxy; remove the analyzer from this connection")
	}

	rawURL := opts["remote_url"]
	if rawURL == "" {
		return nil, fmt.Errorf("missing remote_url option")
	}
	remote, err := url.Parse(rawURL)
	if err != nil {
		return nil, fmt.Errorf("failed parsing remote_url %q: %w", rawURL, err)
	}
	if remote.Scheme == "" || remote.Host == "" {
		return nil, fmt.Errorf("remote_url %q must include a scheme and host", rawURL)
	}

	ctx, cancel := context.WithCancel(ctx)
	p := &httpProxy{
		ctx:             ctx,
		cancel:          cancel,
		clientW:         clientW,
		remote:          remote,
		headers:         injectedHeaders(opts),
		allowClientAuth: opts["allow_client_authorization"] == "true",
		done:            make(chan struct{}),
		client: &http.Client{
			Transport: &http.Transport{
				TLSClientConfig: &tls.Config{InsecureSkipVerify: opts["insecure"] == "true"}, // #nosec G402 -- opt-in per connection
			},
			// Redirects are the client's to follow: the upstream response must
			// reach it unchanged, or a relative Location would resolve against
			// the wrong host.
			CheckRedirect: func(*http.Request, []*http.Request) error { return http.ErrUseLastResponse },
		},
	}
	return p, nil
}

// injectedHeaders turns HEADER_X_API_KEY into X-Api-Key. The agent builds
// these keys from the connection's env vars, where a hyphen is not legal.
func injectedHeaders(opts map[string]string) http.Header {
	h := http.Header{}
	for k, v := range opts {
		if !strings.HasPrefix(strings.ToUpper(k), "HEADER_") {
			continue
		}
		name := strings.ReplaceAll(k[len("HEADER_"):], "_", "-")
		h.Set(http.CanonicalHeaderKey(name), v)
	}
	return h
}

// Run is not used for this proxy: the controller drives it through Write and
// never calls Run. Implemented to satisfy Proxy.
func (p *httpProxy) Run(_ func(exitCode int, errMsg string)) {}

func (p *httpProxy) FlushMetrics(io.Writer) error { return nil }
func (p *httpProxy) Done() <-chan struct{}        { return p.done }

func (p *httpProxy) Close() error {
	p.closeOne.Do(func() {
		p.cancel()
		close(p.done)
	})
	return nil
}

// Write accepts client bytes and forwards every complete request they contain.
// A partial request is buffered and served once the rest arrives; blocking
// here would stall the packet handler that delivers the remainder.
func (p *httpProxy) Write(data []byte) (int, error) {
	p.mu.Lock()
	defer p.mu.Unlock()
	p.buf.Write(data)
	// A client that never completes a request would otherwise grow this
	// buffer without bound. The cap is far above any real request header plus
	// body we forward; exceeding it means the stream is not HTTP.
	if p.buf.Len() > maxBufferedRequestBytes {
		return 0, fmt.Errorf("buffered %d bytes without a complete http request, giving up on this connection", p.buf.Len())
	}

	for {
		req, n, err := readCompleteRequest(p.buf.Bytes())
		if err != nil {
			return 0, err
		}
		if req == nil {
			return len(data), nil // wait for more bytes
		}
		p.buf.Next(n)
		if err := p.forward(req); err != nil {
			return 0, err
		}
	}
}

// readCompleteRequest parses one request from buf. It returns (nil, 0, nil)
// when buf holds only part of a request.
func readCompleteRequest(buf []byte) (*http.Request, int, error) {
	req, err := http.ReadRequest(bufio.NewReader(bytes.NewReader(buf)))
	if err != nil {
		return nil, 0, nil // headers incomplete (or garbage; more bytes may fix it)
	}
	headerLen, err := headerLength(buf)
	if err != nil {
		return nil, 0, nil
	}
	if upgrade := req.Header.Get("Upgrade"); upgrade != "" {
		return nil, 0, &ErrUpgradeUnsupported{Protocol: upgrade}
	}

	switch {
	case req.ContentLength > 0:
		total := headerLen + int(req.ContentLength)
		if len(buf) < total {
			return nil, 0, nil
		}
		req.Body = io.NopCloser(bytes.NewReader(buf[headerLen:total]))
		return req, total, nil
	case isChunked(req):
		end := bytes.Index(buf[headerLen:], []byte("0\r\n\r\n"))
		if end < 0 {
			return nil, 0, nil
		}
		total := headerLen + end + len("0\r\n\r\n")
		body, err := io.ReadAll(httputil.NewChunkedReader(bytes.NewReader(buf[headerLen:total])))
		if err != nil {
			return nil, 0, fmt.Errorf("failed reading chunked request body: %w", err)
		}
		// Re-send with a known length: the upstream sees an equivalent request
		// and Go sets Content-Length for us.
		req.Body = io.NopCloser(bytes.NewReader(body))
		req.ContentLength = int64(len(body))
		req.TransferEncoding = nil
		return req, total, nil
	default:
		req.Body = http.NoBody
		return req, headerLen, nil
	}
}

func headerLength(buf []byte) (int, error) {
	i := bytes.Index(buf, []byte("\r\n\r\n"))
	if i < 0 {
		return 0, fmt.Errorf("incomplete headers")
	}
	return i + 4, nil
}

func isChunked(req *http.Request) bool {
	for _, te := range req.TransferEncoding {
		if te == "chunked" {
			return true
		}
	}
	return false
}

// forward performs the upstream round trip and streams the response back to
// the client exactly as received.
func (p *httpProxy) forward(req *http.Request) error {
	target := *p.remote
	target.Path = strings.TrimSuffix(p.remote.Path, "/") + req.URL.Path
	target.RawQuery = req.URL.RawQuery

	out, err := http.NewRequestWithContext(p.ctx, req.Method, target.String(), req.Body)
	if err != nil {
		return fmt.Errorf("failed building upstream request: %w", err)
	}
	out.Header = req.Header.Clone()
	out.Header.Del("Connection")
	out.ContentLength = req.ContentLength
	for name, values := range p.headers {
		// With allow_client_authorization the client authenticates as itself;
		// overriding its header would silently swap the identity upstream sees.
		if p.allowClientAuth && name == "Authorization" && req.Header.Get("Authorization") != "" {
			continue
		}
		out.Header[name] = values
	}
	out.Host = target.Host

	resp, err := p.client.Do(out)
	if err != nil {
		return fmt.Errorf("upstream request failed: %w", err)
	}
	defer resp.Body.Close()

	// Write the response verbatim: the client speaks HTTP and reassembles the
	// byte stream, so anything but a faithful serialization corrupts it.
	return resp.Write(p.clientW)
}
