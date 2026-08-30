package models

import "testing"

func TestAIAgentNameForOwner(t *testing.T) {
	if got, want := AIAgentNameForOwner("ABC"), "ABC's AI agent"; got != want {
		t.Fatalf("name = %q, want %q", got, want)
	}
}

// An owned agent reports its owner's address; an agent without an owner keeps
// echoing its own name, which is what rows created before owners hold.
func TestAIAgentUserEmail(t *testing.T) {
	for _, tc := range []struct {
		name, agentName, ownerEmail, want string
	}{
		{"owned", "ABC's AI agent", "abc@example.com", "abc@example.com"},
		{"unowned", "ro-agent-user", "", "ro-agent-user"},
	} {
		t.Run(tc.name, func(t *testing.T) {
			if got := aiAgentUserEmail(tc.agentName, tc.ownerEmail); got != tc.want {
				t.Fatalf("email = %q, want %q", got, tc.want)
			}
		})
	}
}
