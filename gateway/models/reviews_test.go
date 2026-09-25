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
