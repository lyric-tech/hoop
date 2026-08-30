package controller

import (
	"bytes"
	"context"
	"crypto/tls"
	"encoding/json"
	"fmt"
	"net/http"
	"os"
	"strings"
	"time"
)

// Standard projection paths for the agent pod's own ServiceAccount. The token
// is deliberately read on every call rather than cached: kubelet rotates the
// projected file (hourly by default), so a token captured at agent start
// begins returning 401 an hour later.
const (
	defaultSATokenTTLSeconds = 3600
	saTokenRequestTimeout    = 15 * time.Second
)

// Vars rather than consts so tests can point them at a temp file; nothing
// outside tests reassigns them.
var (
	saTokenPath     = "/var/run/secrets/kubernetes.io/serviceaccount/token"
	saNamespacePath = "/var/run/secrets/kubernetes.io/serviceaccount/namespace"
)

type tokenRequestSpec struct {
	ExpirationSeconds int64    `json:"expirationSeconds"`
	Audiences         []string `json:"audiences,omitempty"`
}

type tokenRequest struct {
	APIVersion string           `json:"apiVersion"`
	Kind       string           `json:"kind"`
	Spec       tokenRequestSpec `json:"spec"`
}

type tokenRequestStatus struct {
	Status struct {
		Token string `json:"token"`
	} `json:"status"`
}

// agentServiceAccountNamespace returns the namespace the agent pod runs in.
func agentServiceAccountNamespace() (string, error) {
	b, err := os.ReadFile(saNamespacePath)
	if err != nil {
		return "", fmt.Errorf("failed reading agent service account namespace (%s): %w", saNamespacePath, err)
	}
	return strings.TrimSpace(string(b)), nil
}

// mintServiceAccountToken exchanges the agent's own ServiceAccount token for a
// short-lived token belonging to serviceAccount, via the TokenRequest API.
//
// The agent's ServiceAccount needs `create` on
// `serviceaccounts/token` for the target ServiceAccount; without it the API
// server answers 403 and the connection fails with that message rather than
// falling back to the agent's own (broader) identity.
func mintServiceAccountToken(ctx context.Context, clusterURL, namespace, serviceAccount string, ttlSeconds int64) (string, error) {
	agentToken, err := os.ReadFile(saTokenPath)
	if err != nil {
		return "", fmt.Errorf("failed reading agent service account token (%s), is the agent running in-cluster? %w", saTokenPath, err)
	}
	if ttlSeconds <= 0 {
		ttlSeconds = defaultSATokenTTLSeconds
	}

	body, err := json.Marshal(tokenRequest{
		APIVersion: "authentication.k8s.io/v1",
		Kind:       "TokenRequest",
		Spec:       tokenRequestSpec{ExpirationSeconds: ttlSeconds},
	})
	if err != nil {
		return "", fmt.Errorf("failed encoding token request: %w", err)
	}

	endpoint := fmt.Sprintf("%s/api/v1/namespaces/%s/serviceaccounts/%s/token",
		strings.TrimSuffix(clusterURL, "/"), namespace, serviceAccount)
	req, err := http.NewRequestWithContext(ctx, http.MethodPost, endpoint, bytes.NewReader(body))
	if err != nil {
		return "", fmt.Errorf("failed building token request: %w", err)
	}
	req.Header.Set("Authorization", "Bearer "+strings.TrimSpace(string(agentToken)))
	req.Header.Set("Content-Type", "application/json")

	// The API server presents a cert signed by the cluster CA, which is not in
	// the system trust store. The CA is mounted next to the token, but the
	// httpproxy this feeds has no CA option (it exposes `insecure` only), so
	// verification is skipped here too rather than shipping a config that
	// verifies on one hop and not the next.
	//
	// This hop never leaves the cluster: agent pod -> kubernetes.default.svc.
	// Remove both this transport and the `insecure` header once libhoop's
	// httpproxy accepts a CA bundle.
	client := &http.Client{
		Timeout: saTokenRequestTimeout,
		Transport: &http.Transport{
			TLSClientConfig: &tls.Config{InsecureSkipVerify: true}, // #nosec G402 -- see above
		},
	}
	resp, err := client.Do(req)
	if err != nil {
		return "", fmt.Errorf("failed requesting token for service account %s/%s: %w", namespace, serviceAccount, err)
	}
	defer resp.Body.Close()

	if resp.StatusCode != http.StatusCreated && resp.StatusCode != http.StatusOK {
		var msg struct {
			Message string `json:"message"`
		}
		_ = json.NewDecoder(resp.Body).Decode(&msg)
		return "", fmt.Errorf("token request for service account %s/%s failed with status %v: %s",
			namespace, serviceAccount, resp.StatusCode, msg.Message)
	}

	var out tokenRequestStatus
	if err := json.NewDecoder(resp.Body).Decode(&out); err != nil {
		return "", fmt.Errorf("failed decoding token response: %w", err)
	}
	if out.Status.Token == "" {
		return "", fmt.Errorf("token request for service account %s/%s returned an empty token", namespace, serviceAccount)
	}
	return out.Status.Token, nil
}
