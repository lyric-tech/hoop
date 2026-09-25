package models

import (
	"strings"
	"testing"
	"time"
)

func TestReviewListWhereGolden(t *testing.T) {
	admin := ReviewListCaller{IsAuditorOrAdmin: true}
	member := ReviewListCaller{UserID: "u1", UserGroups: []string{"sre"}}
	now := time.Now()

	if got := reviewListWhere(admin, ReviewListOptions{}); got != "rv.org_id = @org_id" {
		t.Fatalf("admin without filters: got %q", got)
	}
	if got := reviewListWhere(member, ReviewListOptions{}); !strings.Contains(got, "rv.owner_id = @user_id OR EXISTS") {
		t.Fatalf("non-admin must get the visibility predicate, got %q", got)
	}

	for _, tc := range []struct {
		name string
		opt  ReviewListOptions
		want string
	}{
		{"statuses", ReviewListOptions{Statuses: []ReviewStatusType{ReviewStatusPending}}, "rv.status = ANY(CAST(@statuses AS private.enum_reviews_status[]))"},
		{"type", ReviewListOptions{Type: ReviewTypeJit}, "rv.type = CAST(@type AS private.enum_reviews_type)"},
		{"connection", ReviewListOptions{ConnectionName: "pg"}, "rv.connection_name = @connection"},
		{"owner id", ReviewListOptions{OwnerID: "u1"}, "rv.owner_id = @owner_id"},
		{"owner email", ReviewListOptions{OwnerEmail: "a@b.c"}, "LOWER(rv.owner_email) = LOWER(@owner_email)"},
		{"start date", ReviewListOptions{StartDate: &now}, "rv.created_at >= @start_date"},
		{"end date", ReviewListOptions{EndDate: &now}, "rv.created_at <= @end_date"},
	} {
		got := reviewListWhere(admin, tc.opt)
		if got != "rv.org_id = @org_id\n\tAND "+tc.want {
			t.Errorf("%s: got %q, want exactly one extra predicate %q", tc.name, got, tc.want)
		}
	}
}
