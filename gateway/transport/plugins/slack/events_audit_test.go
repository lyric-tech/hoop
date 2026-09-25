package slack

import (
	"encoding/json"
	"testing"

	"github.com/hoophq/hoop/gateway/models"
)

func TestSlackDecisionAuditBody(t *testing.T) {
	var got map[string]string
	if err := json.Unmarshal(slackDecisionAuditBody(models.ReviewStatusRejected, "not today"), &got); err != nil {
		t.Fatal(err)
	}
	if got["status"] != "REJECTED" || got["source"] != "slack" || got["rejection_reason"] != "not today" {
		t.Errorf("got %v", got)
	}
	var approved map[string]string
	if err := json.Unmarshal(slackDecisionAuditBody(models.ReviewStatusApproved, ""), &approved); err != nil {
		t.Fatal(err)
	}
	if _, ok := approved["rejection_reason"]; ok || approved["status"] != "APPROVED" {
		t.Errorf("approve must carry its status and no rejection reason: %v", approved)
	}
}
