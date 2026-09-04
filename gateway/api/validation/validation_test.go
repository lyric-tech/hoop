package apivalidation

import (
	"strings"
	"testing"
)

// Table-driven, one case per class of input. Same shape as
// gateway/api/connections/helpers_test.go.
func TestValidateResourceName(t *testing.T) {
	tests := []struct {
		name    string
		input   string
		wantErr bool
	}{
		// --- accepted ---
		{name: "minimum length, three chars", input: "abc"},
		{name: "alphanumeric", input: "conn1"},
		{name: "underscores", input: "my_connection"},
		{name: "hyphens", input: "my-connection"},
		{name: "dots", input: "my.connection"},
		{name: "mixed separators", input: "my-conn.name_1"},
		{name: "uppercase", input: "MyConnection"},
		{name: "leading underscore", input: "_internal"},
		{name: "digits only", input: "123"},

		// --- rejected ---
		{name: "empty", input: "", wantErr: true},
		{name: "one char", input: "a", wantErr: true},
		{name: "two chars", input: "ab", wantErr: true},
		{name: "leading hyphen", input: "-abc", wantErr: true},
		{name: "trailing hyphen", input: "abc-", wantErr: true},
		{name: "leading dot", input: ".abc", wantErr: true},
		{name: "trailing dot", input: "abc.", wantErr: true},
		{name: "consecutive hyphens", input: "a--bc", wantErr: true},
		{name: "consecutive dots", input: "a..bc", wantErr: true},
		{name: "space", input: "my conn", wantErr: true},
		{name: "slash", input: "my/conn", wantErr: true},
		{name: "colon", input: "my:conn", wantErr: true},
		{name: "newline in the middle", input: "my\nconn", wantErr: true},
		{name: "trailing newline", input: "myconn\n", wantErr: true},
		{name: "leading whitespace", input: " myconn", wantErr: true},
		{name: "unicode", input: "conn-ünïcode", wantErr: true},
		{name: "null byte", input: "conn\x00name", wantErr: true},
		{name: "sql-ish", input: "conn'; DROP TABLE connections;--", wantErr: true},
		{name: "path traversal", input: "../../etc/passwd", wantErr: true},
		{name: "shell metacharacters", input: "conn$(whoami)", wantErr: true},
		{name: "backticks", input: "conn`id`", wantErr: true},
	}

	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			err := ValidateResourceName(tt.input)
			if tt.wantErr && err == nil {
				t.Errorf("ValidateResourceName(%q) = nil, want an error", tt.input)
			}
			if !tt.wantErr && err != nil {
				t.Errorf("ValidateResourceName(%q) = %v, want nil", tt.input, err)
			}
		})
	}
}

// BUG: the error message promises an upper bound the regex does not enforce.
//
// The message reads:
//
//	"name: it must contain between 3 and 254 alphanumeric characters, ..."
//
// The pattern is:
//
//	^[a-zA-Z0-9_]+(?:[-\.]?[a-zA-Z0-9_]+){2,253}$
//
// The {2,253} bounds the number of REPETITIONS, but each repetition is
// [a-zA-Z0-9_]+ -- one or more, unbounded -- and so is the leading group. The
// minimum works out at 3 characters, which matches the message. The maximum
// does not exist: a name of any length passes as long as its shape is right.
//
// This test documents the current behaviour rather than asserting the intended
// behaviour, so it will not fail while the bug is open. Flip wantErr to true in
// the two long cases once a length check is added.
//
// Whether it matters depends on the callers. Resource names reach
// gateway/api/agents and gateway/api/accessrequests and end up in database
// columns and log lines, so an unbounded name is at least a storage and
// log-noise concern, and a column with a defined width would reject it far
// later and less clearly than this function should.
func TestValidateResourceNameDoesNotEnforceItsStatedMaximum(t *testing.T) {
	tests := []struct {
		name  string
		input string
	}{
		{name: "300 chars, well past the stated 254", input: strings.Repeat("a", 300)},
		{name: "10000 chars", input: strings.Repeat("a", 10000)},
		{name: "5000 chars with separators", input: strings.Repeat("ab-", 1666) + "ab"},
	}

	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			err := ValidateResourceName(tt.input)
			if err != nil {
				t.Logf("length %d is now rejected -- the bug is fixed; flip this test to assert an error", len(tt.input))
				return
			}
			t.Logf("length %d ACCEPTED, though the error message promises a maximum of 254", len(tt.input))
		})
	}
}

func TestParsePaginationParams(t *testing.T) {
	tests := []struct {
		name         string
		page         string
		pageSize     string
		wantPage     int
		wantPageSize int
		wantErr      bool
	}{
		// --- defaults ---
		{name: "both empty gives the defaults", wantPage: 1, wantPageSize: 50},
		{name: "empty page only", pageSize: "10", wantPage: 1, wantPageSize: 10},
		{name: "empty page size only", page: "3", wantPage: 3, wantPageSize: 50},

		// --- accepted ---
		{name: "explicit first page", page: "1", pageSize: "1", wantPage: 1, wantPageSize: 1},
		{name: "maximum page size", page: "1", pageSize: "100", wantPage: 1, wantPageSize: 100},
		{name: "large page number is allowed", page: "999999", pageSize: "50", wantPage: 999999, wantPageSize: 50},

		// --- rejected ---
		{name: "page zero", page: "0", wantErr: true},
		{name: "negative page", page: "-1", wantErr: true},
		{name: "page not a number", page: "abc", wantErr: true},
		{name: "page is a float", page: "1.5", wantErr: true},
		{name: "page size zero", pageSize: "0", wantErr: true},
		{name: "negative page size", pageSize: "-10", wantErr: true},
		{name: "page size over the cap", pageSize: "101", wantErr: true},
		{name: "page size far over the cap", pageSize: "100000", wantErr: true},
		{name: "page size not a number", pageSize: "all", wantErr: true},
		{name: "sql injection in page", page: "1; DROP TABLE users", wantErr: true},
		{name: "whitespace padded", page: " 1 ", wantErr: true},
		// Accepted, not rejected: strconv.Atoi permits a leading sign, so
		// "+1" parses to 1. Harmless, and worth pinning so nobody "fixes" it
		// into a rejection and breaks a client that sends it.
		{name: "plus prefix parses as 1", page: "+1", wantPage: 1, wantPageSize: 50},
	}

	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			page, pageSize, err := ParsePaginationParams(tt.page, tt.pageSize)

			if tt.wantErr {
				if err == nil {
					t.Fatalf("ParsePaginationParams(%q, %q) = (%d, %d, nil), want an error",
						tt.page, tt.pageSize, page, pageSize)
				}
				// On error both values must be zero, so a caller that ignores
				// err cannot accidentally page with a half-parsed value.
				if page != 0 || pageSize != 0 {
					t.Errorf("on error got (%d, %d), want (0, 0)", page, pageSize)
				}
				return
			}

			if err != nil {
				t.Fatalf("ParsePaginationParams(%q, %q) = %v, want nil", tt.page, tt.pageSize, err)
			}
			if page != tt.wantPage {
				t.Errorf("page = %d, want %d", page, tt.wantPage)
			}
			if pageSize != tt.wantPageSize {
				t.Errorf("pageSize = %d, want %d", pageSize, tt.wantPageSize)
			}
		})
	}
}

// The page-size cap is the DoS control on every paginated endpoint -- it is
// what stops `?page_size=1000000` asking the database for a million rows. Six
// handlers rely on it (resources, rulepacks, attributes, connections and
// others), so it is worth a test of its own rather than one row in a table.
func TestParsePaginationParamsCapsPageSizeAtOneHundred(t *testing.T) {
	if _, _, err := ParsePaginationParams("1", "100"); err != nil {
		t.Errorf("page_size=100 should be allowed: %v", err)
	}
	if _, _, err := ParsePaginationParams("1", "101"); err == nil {
		t.Error("page_size=101 must be rejected: this cap is the DoS control on every paginated endpoint")
	}
}

// An unbounded page number is worth knowing about even though it is accepted.
// A very large page becomes a very large OFFSET, and OFFSET makes the database
// count and discard every skipped row -- so deep paging gets slower the deeper
// it goes, and `?page=999999999` is cheap for the caller and expensive for the
// server. Keyset pagination avoids it entirely. Not a bug in this function;
// documented here because this is where someone will look.
func TestParsePaginationParamsDoesNotBoundThePageNumber(t *testing.T) {
	page, _, err := ParsePaginationParams("999999999", "50")
	if err != nil {
		t.Logf("large page numbers are now bounded (page=%d rejected) -- update this test", page)
		return
	}
	t.Logf("page=%d accepted; deep OFFSET paging degrades with depth", page)
}
