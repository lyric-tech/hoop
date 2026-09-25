package models_test

import (
	"database/sql"
	"testing"
	"time"

	"github.com/google/uuid"
	"github.com/hoophq/hoop/gateway/models"
	"github.com/hoophq/hoop/gateway/models/modelstest"
)

func newTestReview(orgID, ownerID string, groups ...string) *models.Review {
	rev := &models.Review{
		ID:             uuid.NewString(),
		OrgID:          orgID,
		SessionID:      uuid.NewString(),
		Type:           models.ReviewTypeJit,
		Status:         models.ReviewStatusPending,
		ConnectionName: "conn-test",
		ConnectionID:   sql.NullString{String: uuid.NewString(), Valid: true},
		OwnerID:        ownerID,
		OwnerEmail:     ownerID + "@test.local",
		CreatedAt:      time.Now().UTC(),
	}
	for _, g := range groups {
		rev.ReviewGroups = append(rev.ReviewGroups, models.ReviewGroups{
			ID:        uuid.NewString(),
			OrgID:     orgID,
			GroupName: g,
			Status:    models.ReviewStatusPending,
		})
	}
	return rev
}

func mustCreateReview(t *testing.T, rev *models.Review) {
	t.Helper()
	if err := models.CreateReview(rev, ""); err != nil {
		t.Fatalf("create review: %v", err)
	}
}

func mustGetReview(t *testing.T, orgID, id string) *models.Review {
	t.Helper()
	rev, err := models.GetReviewByIdOrSid(orgID, id)
	if err != nil {
		t.Fatalf("get review %s: %v", id, err)
	}
	return rev
}

// A forced approval must survive any later write of the review: UpdateReview
// saves every loaded group row with all of its columns.
func TestUpdateReviewKeepsForcedReview(t *testing.T) {
	orgID := modelstest.StartDB(t)
	rev := newTestReview(orgID, "owner-1", "sre", "dba")
	mustCreateReview(t, rev)
	forcedID := rev.ReviewGroups[0].ID
	if err := models.DB.Exec(`UPDATE private.review_groups SET forced_review = true WHERE id = ?`, forcedID).Error; err != nil {
		t.Fatalf("mark forced: %v", err)
	}

	loaded := mustGetReview(t, orgID, rev.ID)
	loaded.Status = models.ReviewStatusRejected
	if err := models.UpdateReview(loaded); err != nil {
		t.Fatalf("update review: %v", err)
	}

	for _, rg := range mustGetReview(t, orgID, rev.ID).ReviewGroups {
		if rg.ID == forcedID && !rg.ForcedReview {
			t.Fatalf("group %s lost forced_review after an unrelated update", rg.GroupName)
		}
	}
}

func TestListReviewsReturnsTimeWindow(t *testing.T) {
	orgID := modelstest.StartDB(t)
	rev := newTestReview(orgID, "owner-1", "sre")
	rev.TimeWindow = &models.ReviewTimeWindow{
		Type:          "time_range",
		Configuration: map[string]string{"start_time": "09:00", "end_time": "17:00"},
	}
	mustCreateReview(t, rev)

	reviews, err := models.ListReviews(orgID)
	if err != nil {
		t.Fatalf("list reviews: %v", err)
	}
	if len(*reviews) != 1 {
		t.Fatalf("got %d reviews, want 1", len(*reviews))
	}
	got := (*reviews)[0].TimeWindow
	if got == nil || got.Configuration["start_time"] != "09:00" || got.Configuration["end_time"] != "17:00" {
		t.Fatalf("time window not returned by ListReviews, got %+v", got)
	}
}

func TestReviewGroupsOrderedByDecisionTime(t *testing.T) {
	orgID := modelstest.StartDB(t)
	rev := newTestReview(orgID, "owner-1", "second", "pending", "first")
	now := time.Now().UTC().Truncate(time.Millisecond)
	t1, t2 := now.Add(-2*time.Minute), now.Add(-time.Minute)
	rev.ReviewGroups[0].ReviewedAt = &t2
	rev.ReviewGroups[2].ReviewedAt = &t1
	mustCreateReview(t, rev)

	var got []string
	for _, rg := range mustGetReview(t, orgID, rev.ID).ReviewGroups {
		got = append(got, rg.GroupName)
	}
	want := []string{"first", "second", "pending"}
	if len(got) != len(want) {
		t.Fatalf("got groups %v, want %v", got, want)
	}
	for i := range want {
		if got[i] != want[i] {
			t.Fatalf("got groups %v, want %v", got, want)
		}
	}
}

func TestListReviewsFiltered(t *testing.T) {
	orgID := modelstest.StartDB(t)
	admin := models.ReviewListCaller{UserID: "admin", IsAuditorOrAdmin: true}
	list := func(t *testing.T, caller models.ReviewListCaller, opt models.ReviewListOptions) []models.Review {
		t.Helper()
		got, err := models.ListReviewsFiltered(models.DB, orgID, caller, opt)
		if err != nil {
			t.Fatalf("list: %v", err)
		}
		return got
	}

	// alice: 1 pending jit on pg (group sre), 1 approved onetime on mongo (group dba)
	// bob:   1 rejected jit on pg (group dba)
	a1 := newTestReview(orgID, "alice", "sre")
	a1.ConnectionName = "pg"
	a2 := newTestReview(orgID, "alice", "dba")
	a2.ConnectionName, a2.Type, a2.Status = "mongo", models.ReviewTypeOneTime, models.ReviewStatusApproved
	a2.CreatedAt = a1.CreatedAt.Add(time.Second)
	b1 := newTestReview(orgID, "bob", "dba")
	b1.ConnectionName, b1.Status, b1.OwnerEmail = "pg", models.ReviewStatusRejected, "Bob@Test.Local"
	b1.CreatedAt = a1.CreatedAt.Add(2 * time.Second)
	for _, r := range []*models.Review{a1, a2, b1} {
		mustCreateReview(t, r)
	}
	modelstest.SeedSession(t, orgID, a1.SessionID, "exec", "alice")

	t.Run("filters", func(t *testing.T) {
		if got := list(t, admin, models.ReviewListOptions{Statuses: []models.ReviewStatusType{models.ReviewStatusPending, models.ReviewStatusRejected}}); len(got) != 2 {
			t.Errorf("status filter: got %d, want 2", len(got))
		}
		if got := list(t, admin, models.ReviewListOptions{Type: models.ReviewTypeOneTime}); len(got) != 1 || got[0].ID != a2.ID {
			t.Errorf("type filter: got %v", ids(got))
		}
		if got := list(t, admin, models.ReviewListOptions{ConnectionName: "pg"}); len(got) != 2 {
			t.Errorf("connection filter: got %d, want 2", len(got))
		}
		if got := list(t, admin, models.ReviewListOptions{OwnerID: "alice"}); len(got) != 2 {
			t.Errorf("owner id filter: got %d, want 2", len(got))
		}
		if got := list(t, admin, models.ReviewListOptions{OwnerEmail: "bob@test.local"}); len(got) != 1 || got[0].ID != b1.ID {
			t.Errorf("owner email filter must ignore case, got %v", ids(got))
		}
		future := time.Now().Add(time.Hour)
		if got := list(t, admin, models.ReviewListOptions{StartDate: &future}); len(got) != 0 {
			t.Errorf("start date filter: got %d, want 0", len(got))
		}
	})

	t.Run("newest first and paging", func(t *testing.T) {
		got := list(t, admin, models.ReviewListOptions{})
		if len(got) != 3 || got[0].ID != b1.ID || got[2].ID != a1.ID {
			t.Fatalf("order: got %v, want newest first", ids(got))
		}
		page := list(t, admin, models.ReviewListOptions{Limit: 2, Offset: 2})
		if len(page) != 1 || page[0].ID != a1.ID {
			t.Errorf("second page: got %v", ids(page))
		}
	})

	t.Run("visibility", func(t *testing.T) {
		alice := models.ReviewListCaller{UserID: "alice", UserGroups: []string{"engineering"}}
		if got := list(t, alice, models.ReviewListOptions{}); len(got) != 2 {
			t.Errorf("owner sees own reviews: got %v", ids(got))
		}
		dba := models.ReviewListCaller{UserID: "carol", UserGroups: []string{"dba"}}
		if got := list(t, dba, models.ReviewListOptions{}); len(got) != 2 {
			t.Errorf("group member sees reviews for her group: got %v", ids(got))
		}
		stranger := models.ReviewListCaller{UserID: "dave", UserGroups: []string{"finance"}}
		if got := list(t, stranger, models.ReviewListOptions{}); len(got) != 0 {
			t.Errorf("stranger must see nothing: got %v", ids(got))
		}
		nogroups := models.ReviewListCaller{UserID: "erin"}
		if got := list(t, nogroups, models.ReviewListOptions{}); len(got) != 0 {
			t.Errorf("caller without groups must see nothing: got %v", ids(got))
		}
	})

	t.Run("verb", func(t *testing.T) {
		for _, r := range list(t, admin, models.ReviewListOptions{}) {
			want := ""
			if r.ID == a1.ID {
				want = "exec"
			}
			if r.Verb != want {
				t.Errorf("review %s: verb %q, want %q", r.ID, r.Verb, want)
			}
		}
	})

	t.Run("bounds", func(t *testing.T) {
		for _, opt := range []models.ReviewListOptions{
			{Limit: -1}, {Limit: models.MaxReviewListLimit + 1},
			{Offset: -1}, {Offset: models.MaxReviewListOffset + 1},
			{Statuses: []models.ReviewStatusType{"bogus"}},
		} {
			if _, err := models.ListReviewsFiltered(models.DB, orgID, admin, opt); err == nil {
				t.Errorf("options %+v: expected an error", opt)
			}
		}
	})
}

func ids(reviews []models.Review) []string {
	out := make([]string, 0, len(reviews))
	for _, r := range reviews {
		out = append(out, r.OwnerID+"/"+r.ConnectionName)
	}
	return out
}

// UpdateReview must insert a group row it has not seen before (revoke appends
// one) and leave the existing rows as they were.
func TestUpdateReviewInsertsAppendedGroupRow(t *testing.T) {
	orgID := modelstest.StartDB(t)
	rev := newTestReview(orgID, "owner-1", "sre")
	approvedAt := time.Now().UTC().Add(-time.Hour).Truncate(time.Millisecond)
	rev.Status = models.ReviewStatusApproved
	rev.ReviewGroups[0].Status = models.ReviewStatusApproved
	rev.ReviewGroups[0].ReviewedAt = &approvedAt
	approver := "approver@test.local"
	rev.ReviewGroups[0].OwnerEmail = &approver
	mustCreateReview(t, rev)
	modelstest.SeedSession(t, orgID, rev.SessionID, "connect", "owner-1")

	loaded := mustGetReview(t, orgID, rev.ID)
	revokedAt := time.Now().UTC().Truncate(time.Millisecond)
	revoker, reason := "revoker@test.local", "done for today"
	loaded.ReviewGroups = append(loaded.ReviewGroups, models.ReviewGroups{
		ID: uuid.NewString(), OrgID: orgID, ReviewID: rev.ID, GroupName: "sre",
		Status: models.ReviewStatusRevoked, OwnerEmail: &revoker, ReviewedAt: &revokedAt,
	})
	loaded.Status = models.ReviewStatusRevoked
	loaded.RejectionReason = &reason
	if err := models.UpdateReview(loaded); err != nil {
		t.Fatalf("update review: %v", err)
	}

	got := mustGetReview(t, orgID, rev.ID)
	if len(got.ReviewGroups) != 2 {
		t.Fatalf("got %d group rows, want 2", len(got.ReviewGroups))
	}
	first, last := got.ReviewGroups[0], got.ReviewGroups[1]
	if first.Status != models.ReviewStatusApproved || !first.ReviewedAt.Equal(approvedAt) || *first.OwnerEmail != approver {
		t.Errorf("approval row changed: %+v", first)
	}
	if last.Status != models.ReviewStatusRevoked || *last.OwnerEmail != revoker {
		t.Errorf("revoke row: %+v", last)
	}
	if got.RejectionReason == nil || *got.RejectionReason != reason || got.RevokedByEmail() != revoker {
		t.Errorf("reason %v revoked by %q", got.RejectionReason, got.RevokedByEmail())
	}
	var status string
	if err := models.DB.Raw(`SELECT status FROM private.sessions WHERE id = ?`, rev.SessionID).Scan(&status).Error; err != nil || status != "done" {
		t.Errorf("session status %q (err %v), want done", status, err)
	}
}
