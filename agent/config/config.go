package config

import (
	"fmt"
	"os"
	"strings"

	"github.com/hoophq/hoop/common/clientconfig"
	"github.com/hoophq/hoop/common/dsnkeys"
	"github.com/hoophq/hoop/common/envloader"
	"github.com/hoophq/hoop/common/grpc"
	"github.com/hoophq/hoop/common/log"
	"github.com/hoophq/hoop/common/proto"
)

type Config struct {
	Token     string
	URL       string
	Name      string
	Type      string
	AgentMode string
	insecure  bool
	tlsCA     string

	// keyFilePath is set when the agent was loaded in ModeSVID via
	// LYRIC_IAM_SPIFFE_KEY_FILE. It is used by Refresh() to re-read the file
	// when a new gRPC connection is established, so rotated JWT-SVIDs
	// are picked up without restarting the agent.
	keyFilePath string
}

// Load the configuration based on environment variables.
//
// Resolution order:
//  1. LYRIC_IAM_KEY / LYRIC_IAM_DSN: DSN-encoded token. The default, historical
//     production flow with a static, long-lived secret. When set,
//     LYRIC_IAM_KEY always wins; SPIFFE/legacy modes are ignored. To use
//     SPIFFE, leave LYRIC_IAM_KEY unset.
//  2. LYRIC_IAM_SPIFFE_KEY_FILE: path to a file containing a bare JWT-SVID.
//     Requires LYRIC_IAM_GRPCURL. This path is used by SPIFFE integrations
//     where an external sidecar (e.g. spiffe-helper) writes the SVID
//     to disk and rotates it.
//  3. LYRIC_IAM_TOKEN + LYRIC_IAM_GRPCURL: deprecated legacy env format.
func Load() (*Config, error) {
	isLegacy, key := getEnvCredentials()
	dsn, err := dsnkeys.Parse(key)
	if err != nil && err != dsnkeys.ErrEmpty {
		if isLegacy {
			return nil, fmt.Errorf("LYRIC_IAM_DSN (deprecated) is in wrong format, reason=%v", err)
		}
		return nil, fmt.Errorf("LYRIC_IAM_KEY is in wrong format, reason=%v", err)
	}
	if dsn != nil {
		if isLegacy {
			log.Warnf("LYRIC_IAM_DSN environment variable is deprecated, use LYRIC_IAM_KEY instead")
		}
		tlsCA, err := envloader.GetEnv("LYRIC_IAM_TLSCA")
		if err != nil {
			return nil, err
		}
		isTLS := dsn.Scheme == "grpcs" || dsn.Scheme == "https" || dsn.Scheme == "wss"
		return &Config{
			Name:      dsn.Name,
			Type:      clientconfig.ModeDsn,
			AgentMode: dsn.AgentMode,
			Token:     dsn.Key(),
			URL:       dsn.Address,
			insecure:  !isTLS,
			tlsCA:     tlsCA,
		}, nil
	}

	// LYRIC_IAM_SPIFFE_KEY_FILE is emitted unconditionally by the helm chart, so the
	// env var is set on every pod. Only treat it as a real SPIFFE credential
	// when the file actually exists on disk (i.e., a spiffe-helper sidecar has
	// mounted the SVID volume and written to it). Otherwise fall through to the
	// "missing LYRIC_IAM_KEY" error below, which is the right diagnostic for a pod
	// that was deployed without either credential.
	if path := os.Getenv("LYRIC_IAM_SPIFFE_KEY_FILE"); path != "" {
		return loadFromSVIDFile(path)
	}

	legacyToken := getLegacyHoopTokenCredentials()
	grpcURL := os.Getenv("LYRIC_IAM_GRPCURL")
	if legacyToken != "" && grpcURL != "" {
		log.Warnf("LYRIC_IAM_TOKEN and LYRIC_IAM_GRPCURL environment variables are deprecated, create a new token to use the new format")
		return &Config{
			Type:      clientconfig.ModeEnv,
			AgentMode: proto.AgentModeStandardType,
			Token:     legacyToken,
			URL:       grpcURL,
			insecure:  grpcURL == grpc.LocalhostAddr}, nil
	}
	return nil, fmt.Errorf("missing LYRIC_IAM_KEY environment variable")
}

// loadFromSVIDFile builds a Config backed by a JWT-SVID file. The file must
// contain a single JWT (three dot-separated segments); leading/trailing
// whitespace is trimmed. LYRIC_IAM_GRPCURL is required because there is no DSN
// to carry the server address. LYRIC_IAM_SPIFFE_NAME provides the agent display
// name; it is optional because the gateway resolves identity from the
// SPIFFE mapping, not from this field.
func loadFromSVIDFile(path string) (*Config, error) {
	grpcURL := os.Getenv("LYRIC_IAM_GRPCURL")
	if grpcURL == "" {
		return nil, fmt.Errorf("LYRIC_IAM_SPIFFE_KEY_FILE requires LYRIC_IAM_GRPCURL to be set")
	}
	token, err := readTokenFile(path)
	if err != nil {
		return nil, err
	}
	tlsCA, err := envloader.GetEnv("LYRIC_IAM_TLSCA")
	if err != nil {
		return nil, err
	}
	// LYRIC_IAM_GRPC_INSECURE=true forces plaintext gRPC for non-loopback URLs.
	// Intended for local development against a gateway that doesn't terminate
	// TLS on its gRPC port; production deployments should always run TLS.
	insecure := grpcURL == grpc.LocalhostAddr || os.Getenv("LYRIC_IAM_GRPC_INSECURE") == "true"
	return &Config{
		Name:        os.Getenv("LYRIC_IAM_SPIFFE_NAME"),
		Type:        clientconfig.ModeSVID,
		AgentMode:   proto.AgentModeStandardType,
		Token:       token,
		URL:         grpcURL,
		insecure:    insecure,
		tlsCA:       tlsCA,
		keyFilePath: path,
	}, nil
}

// Refresh re-reads the token from LYRIC_IAM_SPIFFE_KEY_FILE when the config was
// loaded in ModeSVID. It is a no-op for all other modes. Callers should
// invoke Refresh before each reconnect attempt so a freshly-rotated
// JWT-SVID is picked up. A read error is returned but callers should
// usually log and retry with the stale token; the gateway will reject a
// long-expired SVID anyway, which triggers another reconnect.
func (c *Config) Refresh() error {
	if c.keyFilePath == "" {
		return nil
	}
	token, err := readTokenFile(c.keyFilePath)
	if err != nil {
		return err
	}
	c.Token = token
	return nil
}

func readTokenFile(path string) (string, error) {
	b, err := os.ReadFile(path)
	if err != nil {
		return "", fmt.Errorf("failed reading LYRIC_IAM_SPIFFE_KEY_FILE %q: %v", path, err)
	}
	token := strings.TrimSpace(string(b))
	if token == "" {
		return "", fmt.Errorf("LYRIC_IAM_SPIFFE_KEY_FILE %q is empty", path)
	}
	// cheap sanity check; the gateway will do the real validation
	if strings.Count(token, ".") != 2 {
		return "", fmt.Errorf("LYRIC_IAM_SPIFFE_KEY_FILE %q does not look like a JWT (expected three dot-separated segments)", path)
	}
	return token, nil
}

func (c *Config) GrpcClientConfig() (grpc.ClientConfig, error) {
	srvAddr, err := grpc.ParseServerAddress(c.URL)
	return grpc.ClientConfig{
		ServerAddress: srvAddr,
		Token:         c.Token,
		Insecure:      c.IsInsecure(),
		TLSServerName: os.Getenv("LYRIC_IAM_TLSSERVERNAME"),
		TLSCA:         c.tlsCA,
		TLSSkipVerify: os.Getenv("LYRIC_IAM_TLS_SKIP_VERIFY") == "true",
	}, err
}

func (c *Config) HasTlsCA() bool   { return c.tlsCA != "" }
func (c *Config) IsInsecure() bool { return c.insecure }
func (c *Config) IsValid() bool    { return c.Token != "" && c.URL != "" }

// getEnvToken backwards compatible with LYRIC_IAM_DSN env
func getEnvCredentials() (legacy bool, v string) {
	v = os.Getenv("LYRIC_IAM_KEY")
	if v != "" {
		return
	}
	return true, os.Getenv("LYRIC_IAM_DSN")
}

func getLegacyHoopTokenCredentials() string {
	token := os.Getenv("TOKEN")
	if token != "" {
		return token
	}
	return os.Getenv("LYRIC_IAM_TOKEN")
}
