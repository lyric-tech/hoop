package utils

import "testing"

func TestSlicesHasIntersection(t *testing.T) {
	tests := []struct {
		name string
		a    []string
		b    []string
		want bool
	}{
		{name: "one common element", a: []string{"x", "y"}, b: []string{"y", "z"}, want: true},
		{name: "identical", a: []string{"a"}, b: []string{"a"}, want: true},
		{name: "all common", a: []string{"a", "b"}, b: []string{"b", "a"}, want: true},
		{name: "disjoint", a: []string{"a", "b"}, b: []string{"c", "d"}},
		{name: "both empty", a: []string{}, b: []string{}},
		{name: "a empty", a: []string{}, b: []string{"a"}},
		{name: "b empty", a: []string{"a"}, b: []string{}},
		{name: "both nil", a: nil, b: nil},
		{name: "a nil", a: nil, b: []string{"a"}},
		{name: "case sensitive", a: []string{"Admin"}, b: []string{"admin"}},
		{name: "empty string is a value like any other", a: []string{""}, b: []string{""}, want: true},
		{name: "duplicates do not change the answer", a: []string{"a", "a"}, b: []string{"a"}, want: true},
		{name: "match only at the end", a: []string{"a", "b", "c"}, b: []string{"x", "y", "c"}, want: true},
	}

	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			if got := SlicesHasIntersection(tt.a, tt.b); got != tt.want {
				t.Errorf("SlicesHasIntersection(%v, %v) = %v, want %v", tt.a, tt.b, got, tt.want)
			}
			// Membership is symmetric, and every caller relies on that even
			// though none of them says so.
			if got := SlicesHasIntersection(tt.b, tt.a); got != tt.want {
				t.Errorf("SlicesHasIntersection(%v, %v) = %v, want %v (argument order must not matter)",
					tt.b, tt.a, got, tt.want)
			}
		})
	}
}

// Worth its own test because this is a security decision, not a utility call.
//
// SlicesHasIntersection is what decides whether a request needs review:
//
//	transport/interceptors/accessrequest/accessrequest.go:211
//	    needsReview := utils.SlicesHasIntersection(accessRule.ApprovalRequiredGroups, pctx.UserGroups)
//	accessrequest.go:241 and connections/connection_credentials.go:1215
//	    ... SlicesHasIntersection(accessRule.SkipReviewGroups, ctx.GetUserGroups())
//
// A false negative on the first skips a required review. A false positive on
// the second skips review entirely. Both directions are a security failure, so
// the empty and nil cases matter: an empty group list must NOT intersect
// anything.
func TestSlicesHasIntersectionEmptyGroupsNeverMatch(t *testing.T) {
	userGroups := []string{"engineering", "sre"}

	for _, name := range []string{"nil rule groups", "empty rule groups"} {
		t.Run(name, func(t *testing.T) {
			var ruleGroups []string
			if name == "empty rule groups" {
				ruleGroups = []string{}
			}
			if SlicesHasIntersection(ruleGroups, userGroups) {
				t.Error("an empty group list must not intersect anything: it would skip a required review, or grant one")
			}
		})
	}

	// And a user in no groups must not match a rule that names groups.
	if SlicesHasIntersection([]string{"admins"}, nil) {
		t.Error("a user with no groups must not match a rule that requires one")
	}
}

func TestSlicesFindFirstIntersection(t *testing.T) {
	t.Run("returns nil when disjoint", func(t *testing.T) {
		if got := SlicesFindFirstIntersection([]string{"a"}, []string{"b"}); got != nil {
			t.Errorf("got %v, want nil", *got)
		}
	})

	t.Run("returns the common element", func(t *testing.T) {
		got := SlicesFindFirstIntersection([]string{"a", "b"}, []string{"b", "c"})
		if got == nil {
			t.Fatal("got nil, want b")
		}
		if *got != "b" {
			t.Errorf("got %q, want b", *got)
		}
	})

	t.Run("works with a non-string comparable", func(t *testing.T) {
		got := SlicesFindFirstIntersection([]int{1, 2, 3}, []int{3, 4})
		if got == nil || *got != 3 {
			t.Fatalf("got %v, want 3", got)
		}
	})
}

// BUG, and the reason this test exists.
//
// The function is called FindFIRST, but WHICH slice's ordering defines "first"
// depends on which argument happens to be LONGER:
//
//	if len(a) > len(b) { a, b = b, a }        // then scan a
//
// So with two elements in common, the element you get back is decided by the
// relative lengths of the inputs, not by the argument order the caller wrote.
// The caller in gateway/api/accessrequests/rules.go:21 is
//
//	connection := utils.SlicesFindFirstIntersection(foundRule.ConnectionNames, req.ConnectionNames)
//
// and which connection it picks therefore flips as soon as the request names
// more connections than the rule does. Nothing at the call site suggests that.
//
// The comment on the swap says it is "to optimize performance", and it does not:
// the work is IndexFunc over one slice with a Contains over the other, so it is
// O(len(a) x len(b)) whichever way round they go. The swap changes the RESULT
// without changing the cost.
//
// Two further sharp edges in the same three lines:
//   - it returns &a[index], a pointer INTO the caller's slice, so writing
//     through it mutates the caller's data
//   - after a swap that pointer is into the OTHER argument, so which slice a
//     caller would be mutating also depends on the lengths
//
// This test pins the behaviour as it is rather than asserting what it should
// be, so it will not fail while the bug is open. The fix -- dropping the swap
// -- is a one-line change but it alters behaviour at six call sites, so it
// wants a maintainer's decision rather than being smuggled into a test PR.
func TestSlicesFindFirstIntersectionResultDependsOnWhichSliceIsLonger(t *testing.T) {
	// Two elements in common: "b" and "c". Argument order is identical in both
	// calls; only the LENGTH of the second argument differs.
	shortFirst := SlicesFindFirstIntersection([]string{"c", "b"}, []string{"b", "c", "x"})
	longFirst := SlicesFindFirstIntersection([]string{"c", "b", "y", "z"}, []string{"b", "c"})

	if shortFirst == nil || longFirst == nil {
		t.Fatal("both calls should have found an intersection")
	}

	t.Logf("first arg shorter -> %q (scanned the first argument)", *shortFirst)
	t.Logf("first arg longer  -> %q (scanned the SECOND argument, after the swap)", *longFirst)

	if *shortFirst != *longFirst {
		t.Logf("CONFIRMED: the result changes with the relative lengths, not with argument order.")
		t.Logf("  Caller: gateway/api/accessrequests/rules.go:21 passes")
		t.Logf("  (foundRule.ConnectionNames, req.ConnectionNames) and gets whichever")
		t.Logf("  slice happens to be shorter scanned first.")
	} else {
		t.Logf("the two calls agreed -- if the swap has been removed, this test can assert argument order instead")
	}
}

// The returned pointer aliases the caller's slice. Documented because it is
// invisible at the call site and one mutation away from a confusing bug.
func TestSlicesFindFirstIntersectionReturnsAPointerIntoTheInput(t *testing.T) {
	a := []string{"keep", "target"}
	b := []string{"target"}

	got := SlicesFindFirstIntersection(a, b)
	if got == nil {
		t.Fatal("expected a match")
	}

	*got = "mutated"

	// b was the shorter slice, so the swap made it the one scanned, and the
	// pointer is into b -- not into a, which is the argument the caller wrote
	// first.
	if b[0] == "mutated" {
		t.Logf("the pointer aliased b (the shorter argument): callers can mutate it through the result")
	}
	if a[1] == "mutated" {
		t.Logf("the pointer aliased a: callers can mutate it through the result")
	}
	if b[0] != "mutated" && a[1] != "mutated" {
		t.Log("the result is a copy -- if the function now returns by value, this test can be deleted")
	}
}
