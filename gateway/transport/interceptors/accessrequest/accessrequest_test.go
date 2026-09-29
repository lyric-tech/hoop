package accessrequestinterceptor

import (
	"testing"
	"time"
)

func TestGrantWindow(t *testing.T) {
	now := time.Date(2026, 9, 22, 12, 0, 0, 0, time.UTC)
	open := now.Add(20 * time.Minute)
	closed := now.Add(-1 * time.Second)
	var zero time.Time

	for _, tt := range []struct {
		name      string
		revokedAt *time.Time
		want      time.Duration
		wantOK    bool
	}{
		{"open window", &open, 20 * time.Minute, true},
		{"closed window", &closed, 0, false},
		{"exactly expired", &now, 0, false},
		{"no expiry", nil, 0, false},
		{"zero expiry", &zero, 0, false},
	} {
		t.Run(tt.name, func(t *testing.T) {
			got, ok := grantWindow(tt.revokedAt, now)
			if ok != tt.wantOK {
				t.Fatalf("ok = %v, want %v", ok, tt.wantOK)
			}
			if ok && got != tt.want {
				t.Fatalf("remaining = %v, want %v", got, tt.want)
			}
		})
	}
}
