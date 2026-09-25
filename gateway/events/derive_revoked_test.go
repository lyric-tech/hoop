package events_test

import (
	"encoding/json"
	"reflect"
	"testing"
	"time"

	"github.com/aws/smithy-go/ptr"
	"github.com/google/uuid"
	"github.com/hoophq/hoop/gateway/events"
	"github.com/hoophq/hoop/gateway/models"
	"github.com/hoophq/hoop/gateway/models/modelstest"
)

// The revoke event carries the same fields as the deny event, so a subscriber
// can treat both as "access ended by a person".
func TestCatalogJitRevokedMatchesDenied(t *testing.T) {
	revoked, ok := events.Catalog["access.jit_revoked"]
	if !ok {
		t.Fatal("access.jit_revoked is not in the catalog; Publish would drop it silently")
	}
	if !reflect.DeepEqual(revoked.Schema, events.Catalog["access.jit_denied"].Schema) {
		t.Errorf("schema differs from access.jit_denied:\n%v\n%v", revoked.Schema, events.Catalog["access.jit_denied"].Schema)
	}
}

func TestDeriveFromReviewRevokedPublishesEvent(t *testing.T) {
	orgID := modelstest.StartDB(t)
	approvedAt := time.Now().UTC().Add(-time.Hour)
	revokedAt := time.Now().UTC()
	rev := &models.Review{
		ID: uuid.NewString(), OrgID: orgID, SessionID: uuid.NewString(),
		Type: models.ReviewTypeJit, Status: models.ReviewStatusRevoked,
		RejectionReason: ptr.String("incident closed"),
		ReviewGroups: []models.ReviewGroups{
			{GroupName: "sre", Status: models.ReviewStatusApproved, OwnerEmail: ptr.String("approver@test.local"), ReviewedAt: &approvedAt},
			{GroupName: "sre", Status: models.ReviewStatusRevoked, OwnerEmail: ptr.String("revoker@test.local"), ReviewedAt: &revokedAt},
		},
	}
	session := &models.Session{ID: rev.SessionID, UserEmail: "owner@test.local", Connection: "pg"}

	// Twice: the producer event id makes the second publish a no-op.
	events.DeriveFromReview(orgID, rev, session)
	events.DeriveFromReview(orgID, rev, session)

	var rows []models.Event
	if err := models.DB.Table("private.events").
		Where("org_id = ? AND event_type = ?", orgID, "access.jit_revoked").Find(&rows).Error; err != nil {
		t.Fatalf("query events: %v", err)
	}
	if len(rows) != 1 {
		t.Fatalf("got %d access.jit_revoked rows, want 1", len(rows))
	}
	var payload map[string]any
	if err := json.Unmarshal(rows[0].Payload, &payload); err != nil {
		t.Fatal(err)
	}
	if payload["reviewer"] != "revoker@test.local" || payload["reason"] != "incident closed" || payload["review_id"] != rev.ID {
		t.Errorf("payload %v", payload)
	}
}
