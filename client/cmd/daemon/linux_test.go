package daemon

import (
	"os"
	"path/filepath"
	"strings"
	"testing"
)

func TestDerivePaths_Defaults(t *testing.T) {
	up, _ := userPaths(Options{ServiceName: "lyric-iamd"})
	if !strings.HasSuffix(up, "/.config/systemd/user/lyric-iamd.service") {
		t.Fatalf("unit path=%q, want ~/.config/systemd/user/lyric-iamd.service", up)
	}
}

func TestUserPaths(t *testing.T) {
	restore, home := withTempHome(t)
	defer restore()
	got, _ := userPaths(Options{ServiceName: "lyric-iamd"})
	want := filepath.Join(home, ".config", "systemd", "user", "lyric-iamd.service")
	if got != want {
		t.Fatalf("userPaths mismatch\n got = %q, want = %q", got, want)
	}
}

func TestRenderServiceFile(t *testing.T) {
	txt := renderServiceFile(unitData{
		Description: "lyric-iam-agent Service",
		ExecPath:    "/usr/bin/hoop",
		ExecArgs:    " start agent",
		Env: map[string]string{
			"LYRIC_IAM_KEY": "abc123",
			"FOO":      "bar",
		},
		WantedBy: "default.target",
	})

	requireContains(t, txt, "[Unit]")
	requireContains(t, txt, "Description=lyric-iam-agent Service")
	requireContains(t, txt, "[Service]")
	requireContains(t, txt, `Environment="LYRIC_IAM_KEY=abc123"`)
	requireContains(t, txt, `Environment="FOO=bar"`)
	requireContains(t, txt, "ExecStart=/usr/bin/hoop start agent")
	requireContains(t, txt, "[Install]")
	requireContains(t, txt, "WantedBy=default.target")
}

func TestRenderUnit_IncludesEnvAndExec(t *testing.T) {
	unit := renderServiceFile(unitData{
		Description: "Lyric IAM Service",
		ExecPath:    "/usr/bin/hoop",
		ExecArgs:    " agent start",
		Env: map[string]string{
			"FOO": "bar",
			"BAZ": "qux",
		},
		WantedBy: "multi-user.target",
	})

	wantContains := []string{
		"Description=Lyric IAM Service",
		"[Service]",
		`ExecStart=/usr/bin/hoop agent start`,
		`Environment="FOO=bar"`,
		`Environment="BAZ=qux"`,
		"[Install]",
		"WantedBy=multi-user.target",
	}

	for _, s := range wantContains {
		if !strings.Contains(unit, s) {
			t.Fatalf("rendered unit missing %q\n--- got ---\n%s", s, unit)
		}
	}
}

func TestLogsAgent_CallsJournalctl(t *testing.T) {
	mr := &mockRunner{}
	old := execRunner
	execRunner = mr
	defer func() { execRunner = old }()

	err := logsAgent("lyric-iam-agent")
	if err != nil {
		t.Fatalf("logsAgent returned error: %v", err)
	}

	if len(mr.callsLog) != 1 {
		t.Fatalf("expected 1 Logs call, got %d", len(mr.callsLog))
	}
	call := mr.callsLog[0]
	requireContains(t, call, "journalctl")
	requireContains(t, call, "--user -u lyric-iam-agent.service -f -o cat --no-pager")
}

func TestLogsAgent_ErrorBubblesUp(t *testing.T) {
	mr := &mockRunner{logsErr: os.ErrPermission}
	old := execRunner
	execRunner = mr
	defer func() { execRunner = old }()

	if err := logsAgent("lyric-iam-agent"); err == nil {
		t.Fatalf("expected error from logsAgent, got nil")
	}
}

func TestInstall_WritesUnitAndEnablesService(t *testing.T) {
	restore, home := withTempHome(t)
	defer restore()

	mr := &mockRunner{runOut: "ok"}
	old := execRunner
	execRunner = mr
	defer func() { execRunner = old }()

	opts := Options{
		ServiceName: "lyric-iam-agent",
		ExecArgs:    " start agent",
		Env:         map[string]string{"LYRIC_IAM_KEY": "abc123"},
		WantedBy:    "default.target",
	}

	if err := install(opts); err != nil {
		t.Fatalf("install failed: %v", err)
	}

	unit := filepath.Join(home, ".config", "systemd", "user", "lyric-iam-agent.service")
	if _, err := os.Stat(unit); err != nil {
		t.Fatalf("expected unit file to exist: %v", err)
	}

	joined := strings.Join(mr.callsRun, "\n")
	requireContains(t, joined, "systemctl --user daemon-reload")
	requireContains(t, joined, "systemctl --user enable --now lyric-iam-agent")
}

func TestInstall_DaemonReloadFailure(t *testing.T) {
	restore, _ := withTempHome(t)
	defer restore()

	mr := &mockRunner{
		runOut: "boom",
		runErr: os.ErrPermission,
	}

	old := execRunner
	execRunner = mr
	defer func() { execRunner = old }()

	opts := Options{ServiceName: "svc", WantedBy: "default.target"}
	err := install(opts)
	if err == nil {
		t.Fatalf("expected error, got nil")
	}
	if !strings.Contains(err.Error(), "daemon-reload") {
		t.Fatalf("expected daemon-reload in error, got: %v", err)
	}
}

func TestStop_Success(t *testing.T) {
	mr := &mockRunner{}
	old := execRunner
	execRunner = mr
	defer func() { execRunner = old }()

	if err := stop("svc"); err != nil {
		t.Fatalf("stop returned error: %v", err)
	}

	joined := strings.Join(mr.callsRun, "\n")
	requireContains(t, joined, "systemctl --user stop svc")
	requireContains(t, joined, "systemctl --user disable svc")
}

func TestStop_ErrorPropagates(t *testing.T) {
	mr := &mockRunner{
		runOut: "nope",
		runErr: os.ErrPermission,
	}
	old := execRunner
	execRunner = mr
	defer func() { execRunner = old }()

	if err := stop("svc"); err == nil {
		t.Fatalf("expected error from stop, got nil")
	}
}
