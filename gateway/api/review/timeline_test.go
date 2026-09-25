package reviewapi

import (
	"testing"
	"time"

	"github.com/aws/smithy-go/ptr"
	"github.com/hoophq/hoop/gateway/models"
)

func TestBuildTimeline(t *testing.T) {
	now := time.Date(2026, 9, 24, 12, 0, 0, 0, time.UTC)
	at := func(min int) *time.Time { v := now.Add(time.Duration(min) * time.Minute); return &v }
	ended := *at(-50)

	t.Run("approved, session, revoked", func(t *testing.T) {
		rev := &models.Review{
			SessionID: "carrier",
			Type:      models.ReviewTypeJit, Status: models.ReviewStatusRevoked, ConnectionName: "pg",
			AccessDurationSec: 3600, OwnerEmail: "owner@test.local", CreatedAt: *at(-60),
			RevokedAt: at(0), RejectionReason: ptr.String("done for today"),
			ReviewGroups: []models.ReviewGroups{
				{GroupName: "sre", Status: models.ReviewStatusApproved, OwnerEmail: ptr.String("a@test.local"), ReviewedAt: at(-55)},
				{GroupName: "dba", Status: models.ReviewStatusPending},
				{GroupName: "sre", Status: models.ReviewStatusRevoked, OwnerEmail: ptr.String("r@test.local"), ReviewedAt: at(-10)},
			},
		}
		sessions := []models.Session{{ID: "s1", Verb: "exec", UserEmail: "owner@test.local", CreatedAt: *at(-52), EndSession: &ended, ExitCode: ptr.Int(0)}}
		got := buildTimeline(rev, sessions, now)
		want := []struct{ kind, by, detail string }{
			{TimelineRequested, "owner@test.local", "1h on pg"},
			{TimelineApproved, "a@test.local", "group sre"},
			{TimelineSession, "owner@test.local", "exec · 2m0s · exit 0"},
			{TimelineRevoked, "r@test.local", "done for today"},
		}
		if len(got) != len(want) {
			t.Fatalf("got %d events, want %d: %+v", len(got), len(want), got)
		}
		for i, w := range want {
			if got[i].Kind != w.kind || got[i].By != w.by || got[i].Detail != w.detail {
				t.Errorf("event %d: got %s/%s/%q, want %s/%s/%q", i, got[i].Kind, got[i].By, got[i].Detail, w.kind, w.by, w.detail)
			}
		}
		if got[0].SessionID != "carrier" || got[2].SessionID != "s1" {
			t.Errorf("session ids: requested %q, session %q", got[0].SessionID, got[2].SessionID)
		}
	})

	t.Run("forced approval then expiry", func(t *testing.T) {
		rev := &models.Review{
			Type: models.ReviewTypeJit, Status: models.ReviewStatusApproved, ConnectionName: "pg",
			AccessDurationSec: 1800, CreatedAt: *at(-40), RevokedAt: at(-5),
			ReviewGroups: []models.ReviewGroups{{GroupName: "oncall", Status: models.ReviewStatusApproved, ForcedReview: true, ReviewedAt: at(-35)}},
		}
		got := buildTimeline(rev, nil, now)
		if len(got) != 3 || got[0].Detail != "30m on pg" || got[1].Kind != TimelineForced || got[2].Kind != TimelineExpired {
			t.Fatalf("got %+v", got)
		}
	})

	t.Run("approved window still open has no expiry", func(t *testing.T) {
		rev := &models.Review{Type: models.ReviewTypeJit, Status: models.ReviewStatusApproved, CreatedAt: *at(-1), RevokedAt: at(30)}
		for _, e := range buildTimeline(rev, nil, now) {
			if e.Kind == TimelineExpired {
				t.Fatal("an open window must not be reported as expired")
			}
		}
	})

	t.Run("one-time rejection", func(t *testing.T) {
		rev := &models.Review{
			Type: models.ReviewTypeOneTime, Status: models.ReviewStatusRejected, ConnectionName: "mongo",
			CreatedAt: *at(-3), RejectionReason: ptr.String("not in prod"),
			ReviewGroups: []models.ReviewGroups{{GroupName: "sre", Status: models.ReviewStatusRejected, OwnerEmail: ptr.String("a@test.local"), ReviewedAt: at(-2)}},
		}
		got := buildTimeline(rev, nil, now)
		if len(got) != 2 || got[0].Detail != "command on mongo" || got[1].Kind != TimelineRejected || got[1].Detail != "not in prod" {
			t.Fatalf("got %+v", got)
		}
	})
}

func TestFormatAccessDuration(t *testing.T) {
	for sec, want := range map[int64]string{900: "15m", 3600: "1h", 5400: "1h30m", 172800: "48h"} {
		if got := formatAccessDuration(sec); got != want {
			t.Errorf("%d: got %q, want %q", sec, got, want)
		}
	}
}
