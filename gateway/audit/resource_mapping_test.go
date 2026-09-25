package audit

import "testing"

func TestDeriveResourceAndActionReviewRoutes(t *testing.T) {
	for _, tc := range []struct {
		path, method string
		resource     ResourceType
		action       Action
	}{
		{"/api/reviews/9f9745b4-c77b-4d52-84d3-e24f67e3623c", "PUT", ResourceReview, ActionUpdate},
		{"/api/sessions/35db0a2f-e5ce-4ad8-a308-55c3108956e5/review", "PUT", ResourceReview, ActionUpdate},
		// Other session routes keep the raw first-segment fallback.
		{"/api/sessions/35db0a2f-e5ce-4ad8-a308-55c3108956e5/kill", "POST", ResourceType("sessions"), ActionCreate},
		// Existing mappings are untouched.
		{"/api/users/groups", "POST", ResourceUserGroup, ActionCreate},
	} {
		resource, action := DeriveResourceAndAction(tc.path, tc.method)
		if resource != tc.resource || action != tc.action {
			t.Errorf("%s %s: got (%s, %s), want (%s, %s)", tc.method, tc.path, resource, action, tc.resource, tc.action)
		}
	}
}

// A review decision must keep what was decided after redaction.
func TestRedactKeepsReviewDecisionFields(t *testing.T) {
	got := Redact(map[string]any{"status": "REVOKED", "rejection_reason": "done for today", "force_review": true})
	if got["status"] != "REVOKED" || got["rejection_reason"] != "done for today" || got["force_review"] != true {
		t.Fatalf("decision fields were redacted: %v", got)
	}
}
