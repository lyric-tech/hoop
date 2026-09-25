package reviewapi

import (
	"errors"
	"net/url"
	"testing"

	"github.com/aws/smithy-go/ptr"
	"github.com/hoophq/hoop/gateway/models"
)

func TestParseReviewListOptions(t *testing.T) {
	for _, tc := range []struct {
		name    string
		qs      string
		check   func(t *testing.T, opt models.ReviewListOptions)
		wantErr string
	}{
		{name: "no options means no filter", qs: "", check: func(t *testing.T, opt models.ReviewListOptions) {
			if opt.Limit != 0 || opt.Statuses != nil || opt.Type != "" || opt.OwnerID != "" {
				t.Errorf("expected zero options, got %+v", opt)
			}
		}},
		{name: "status list is trimmed and upper-cased", qs: "status=pending,%20approved", check: func(t *testing.T, opt models.ReviewListOptions) {
			if len(opt.Statuses) != 2 || opt.Statuses[0] != models.ReviewStatusPending || opt.Statuses[1] != models.ReviewStatusApproved {
				t.Errorf("got %v", opt.Statuses)
			}
		}},
		{name: "unknown status", qs: "status=PENDING,bogus", wantErr: "status"},
		{name: "type jit", qs: "type=jit", check: func(t *testing.T, opt models.ReviewListOptions) {
			if opt.Type != models.ReviewTypeJit {
				t.Errorf("got %q", opt.Type)
			}
		}},
		{name: "unknown type", qs: "type=weekly", wantErr: "type"},
		{name: "connection", qs: "connection=pg-prod", check: func(t *testing.T, opt models.ReviewListOptions) {
			if opt.ConnectionName != "pg-prod" {
				t.Errorf("got %q", opt.ConnectionName)
			}
		}},
		{name: "user=me resolves to the caller", qs: "user=me", check: func(t *testing.T, opt models.ReviewListOptions) {
			if opt.OwnerID != "caller-id" || opt.OwnerEmail != "" {
				t.Errorf("got owner id %q email %q", opt.OwnerID, opt.OwnerEmail)
			}
		}},
		{name: "user email", qs: "user=a%40b.c", check: func(t *testing.T, opt models.ReviewListOptions) {
			if opt.OwnerEmail != "a@b.c" || opt.OwnerID != "" {
				t.Errorf("got owner id %q email %q", opt.OwnerID, opt.OwnerEmail)
			}
		}},
		{name: "user neither me nor email", qs: "user=alice", wantErr: "user"},
		{name: "dates in UTC", qs: "start_date=2026-09-01T10:00:00%2B05:30&end_date=2026-09-02T00:00:00Z", check: func(t *testing.T, opt models.ReviewListOptions) {
			if opt.StartDate == nil || opt.StartDate.Hour() != 4 || opt.StartDate.Minute() != 30 || opt.EndDate == nil {
				t.Errorf("got start %v end %v", opt.StartDate, opt.EndDate)
			}
		}},
		{name: "bad date", qs: "start_date=yesterday", wantErr: "start_date"},
		{name: "limit clamped to the max page", qs: "limit=500", check: func(t *testing.T, opt models.ReviewListOptions) {
			if opt.Limit != models.MaxReviewListLimit {
				t.Errorf("got %d", opt.Limit)
			}
		}},
		{name: "limit zero", qs: "limit=0", wantErr: "limit"},
		{name: "limit not a number", qs: "limit=abc", wantErr: "limit"},
		{name: "offset", qs: "offset=40", check: func(t *testing.T, opt models.ReviewListOptions) {
			if opt.Offset != 40 {
				t.Errorf("got %d", opt.Offset)
			}
		}},
		{name: "offset too deep", qs: "offset=10001", wantErr: "offset"},
		{name: "negative offset", qs: "offset=-1", wantErr: "offset"},
	} {
		t.Run(tc.name, func(t *testing.T) {
			qs, err := url.ParseQuery(tc.qs)
			if err != nil {
				t.Fatal(err)
			}
			opt, err := parseReviewListOptions(qs, "caller-id")
			if tc.wantErr != "" {
				var optErr *invalidReviewListOptionError
				if !errors.As(err, &optErr) || optErr.option != tc.wantErr {
					t.Fatalf("expected an invalid %q option error, got %v", tc.wantErr, err)
				}
				return
			}
			if err != nil {
				t.Fatalf("unexpected error: %v", err)
			}
			tc.check(t, opt)
		})
	}
}

// Every advertised option must be handled by the parser; a key added to the
// list but not to the switch would be silently ignored.
func TestParseReviewListOptionsCoversEveryAdvertisedOption(t *testing.T) {
	sample := map[string]string{
		reviewOptionStatus: "PENDING", reviewOptionType: "jit", reviewOptionConnection: "c",
		reviewOptionUser: "me", reviewOptionStartDate: "2026-01-01T00:00:00Z",
		reviewOptionEndDate: "2026-01-02T00:00:00Z", reviewOptionLimit: "5", reviewOptionOffset: "1",
	}
	for _, key := range availableReviewOptions {
		val, ok := sample[key]
		if !ok {
			t.Fatalf("option %q has no sample value in this test", key)
		}
		opt, err := parseReviewListOptions(url.Values{key: {val}}, "me-id")
		if err != nil {
			t.Fatalf("option %q: %v", key, err)
		}
		if (models.ReviewListOptions{}).Limit == opt.Limit && opt.Statuses == nil && opt.Type == "" &&
			opt.ConnectionName == "" && opt.OwnerID == "" && opt.StartDate == nil && opt.EndDate == nil && opt.Offset == 0 {
			t.Errorf("option %q was accepted but did not change the options", key)
		}
	}
}

func TestToOpenApiReviewOwnerConnectionVerb(t *testing.T) {
	got := toOpenApiReview(&models.Review{
		ID: "r1", OwnerID: "u1", OwnerEmail: "u1@test.local", OwnerName: ptr.String("User One"),
		ConnectionName: "pg-prod", Verb: "exec",
	})
	if got.Owner == nil || got.Owner.ID != "u1" || got.Owner.Email != "u1@test.local" || got.Owner.Name != "User One" {
		t.Errorf("owner: got %+v", got.Owner)
	}
	if got.ConnectionName != "pg-prod" || got.Verb != "exec" {
		t.Errorf("connection %q verb %q", got.ConnectionName, got.Verb)
	}
}

func TestCanAccessReview(t *testing.T) {
	rev := &models.Review{OwnerID: "owner", ReviewGroups: []models.ReviewGroups{{GroupName: "sre"}, {GroupName: "dba"}}}
	for _, tc := range []struct {
		name   string
		userID string
		groups []string
		want   bool
	}{
		{"owner", "owner", nil, true},
		{"admin", "x", []string{"admin"}, true},
		{"auditor", "x", []string{"auditor"}, true},
		{"group member", "x", []string{"engineering", "dba"}, true},
		{"stranger", "x", []string{"finance"}, false},
		{"no groups", "x", nil, false},
	} {
		if got := canAccessReview(newFakeContext(tc.userID, tc.userID+"@test.local", tc.groups), rev); got != tc.want {
			t.Errorf("%s: got %v, want %v", tc.name, got, tc.want)
		}
	}
}

func TestHTTPStatusForReviewError(t *testing.T) {
	for err, want := range map[error]int{
		nil:                     200,
		ErrNotFound:             404,
		ErrUnknownStatus:        400,
		ErrNotEligible:          400,
		ErrSelfApproval:         400,
		ErrWrongState:           400,
		ErrGroupAlreadyReviewed: 400,
		ErrForbidden:            403,
		errors.New("db down"):   500,
	} {
		if got := HTTPStatusForReviewError(err); got != want {
			t.Errorf("%v: got %d, want %d", err, got, want)
		}
	}
}

// A malformed id must not reach the database; it is simply not found.
func TestDoReviewRejectsNonUUID(t *testing.T) {
	_, err := DoReview(newFakeContext("u", "u@test.local", nil), "not-a-uuid", models.ReviewStatusApproved, nil, false, "")
	if err != ErrNotFound {
		t.Fatalf("got %v, want ErrNotFound", err)
	}
}
