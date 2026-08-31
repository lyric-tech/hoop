package config

import "testing"

// The published agent chart sets HOOP_KEY, so a fork-built agent deployed by
// that chart must still find its DSN.
func TestGetEnvCredentials(t *testing.T) {
	for _, tc := range []struct {
		name       string
		env        map[string]string
		wantLegacy bool
		want       string
	}{
		{"current name", map[string]string{"LYRIC_IAM_KEY": "new"}, false, "new"},
		{"chart name", map[string]string{"HOOP_KEY": "old"}, false, "old"},
		{"current wins", map[string]string{"LYRIC_IAM_KEY": "new", "HOOP_KEY": "old"}, false, "new"},
		{"legacy dsn", map[string]string{"HOOP_DSN": "dsn"}, true, "dsn"},
		{"key beats dsn", map[string]string{"HOOP_KEY": "k", "LYRIC_IAM_DSN": "d"}, false, "k"},
		{"unset", nil, true, ""},
	} {
		t.Run(tc.name, func(t *testing.T) {
			for _, n := range append(append([]string{}, credentialEnvNames...), legacyCredentialEnvNames...) {
				t.Setenv(n, "")
			}
			for k, v := range tc.env {
				t.Setenv(k, v)
			}
			legacy, got := getEnvCredentials()
			if got != tc.want || legacy != tc.wantLegacy {
				t.Fatalf("got (%v, %q), want (%v, %q)", legacy, got, tc.wantLegacy, tc.want)
			}
		})
	}
}

// Embedded mode copies the agent's environment into the connection; every name
// that can hold the DSN must be filtered out of that copy.
func TestIsCredentialEnvName(t *testing.T) {
	for _, name := range []string{"LYRIC_IAM_KEY", "HOOP_KEY", "LYRIC_IAM_DSN", "HOOP_DSN"} {
		if !IsCredentialEnvName(name) {
			t.Errorf("%s must be treated as a credential", name)
		}
	}
	if IsCredentialEnvName("PATH") {
		t.Error("PATH must not be treated as a credential")
	}
}
