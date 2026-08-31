package cluster

import "testing"

func TestFromAgentName(t *testing.T) {
	for _, tt := range []struct {
		agentName string
		want      string
	}{
		{"remix-agent", "remix"},
		{"zeta-agent", "zeta"},
		{"development-agent", "development"},
		// no suffix to strip: the agent is its own cluster label
		{"arqa-prod", "arqa-prod"},
		{"default", "default"},
		// stripping would leave nothing, keep the name intact
		{"-agent", "-agent"},
		// a resource with no agent renders bare, never "/name"
		{"", ""},
		// only a trailing suffix counts
		{"agent-remix", "agent-remix"},
		{"remix-agent-agent", "remix-agent"},
	} {
		if got := FromAgentName(tt.agentName); got != tt.want {
			t.Errorf("FromAgentName(%q) = %q, want %q", tt.agentName, got, tt.want)
		}
	}
}

func TestSplit(t *testing.T) {
	for _, tt := range []struct {
		qualified   string
		wantCluster string
		wantName    string
	}{
		{"remix/mongodb-remix-ro", "remix", "mongodb-remix-ro"},
		{"mongodb-remix-ro", "", "mongodb-remix-ro"},
		{"", "", ""},
		// an empty cluster segment must not resolve as unqualified
		{"/name", "", "name"},
		{"remix/", "remix", ""},
	} {
		gotCluster, gotName := Split(tt.qualified)
		if gotCluster != tt.wantCluster || gotName != tt.wantName {
			t.Errorf("Split(%q) = (%q, %q), want (%q, %q)",
				tt.qualified, gotCluster, gotName, tt.wantCluster, tt.wantName)
		}
	}
}

func TestQualify(t *testing.T) {
	if got := Qualify("remix", "db"); got != "remix/db" {
		t.Errorf("Qualify(remix, db) = %q, want remix/db", got)
	}
	// no agent: bare name, not "/db"
	if got := Qualify("", "db"); got != "db" {
		t.Errorf("Qualify(\"\", db) = %q, want db", got)
	}
}

func TestQualifyRoundTrip(t *testing.T) {
	for _, tt := range []struct{ clusterLabel, name string }{
		{"remix", "mongodb-remix-ro"},
		{"", "mongodb-remix-ro"},
		{"arqa-prod", "pg.demo_1"},
	} {
		gotCluster, gotName := Split(Qualify(tt.clusterLabel, tt.name))
		if gotCluster != tt.clusterLabel || gotName != tt.name {
			t.Errorf("round trip (%q, %q) = (%q, %q)", tt.clusterLabel, tt.name, gotCluster, gotName)
		}
	}
}

func TestQualifyFromAgentName(t *testing.T) {
	if got := QualifyFromAgentName("remix-agent", "mongodb-remix-ro"); got != "remix/mongodb-remix-ro" {
		t.Errorf("got %q, want remix/mongodb-remix-ro", got)
	}
	// unassigned agent renders the bare resource name
	if got := QualifyFromAgentName("", "orphan"); got != "orphan" {
		t.Errorf("got %q, want orphan", got)
	}
}

func TestAgentNameCandidates(t *testing.T) {
	got := AgentNameCandidates("remix")
	want := []string{"remix", "remix-agent"}
	if len(got) != len(want) || got[0] != want[0] || got[1] != want[1] {
		t.Errorf("AgentNameCandidates(remix) = %v, want %v", got, want)
	}
	// the candidates must recover any label FromAgentName produces
	for _, agentName := range []string{"remix-agent", "arqa-prod", "-agent"} {
		label := FromAgentName(agentName)
		var found bool
		for _, c := range AgentNameCandidates(label) {
			if c == agentName {
				found = true
			}
		}
		if !found {
			t.Errorf("AgentNameCandidates(%q) does not recover agent %q", label, agentName)
		}
	}
}

func TestIsQualified(t *testing.T) {
	if !IsQualified("remix/db") || IsQualified("db") {
		t.Error("IsQualified misclassified a name")
	}
}
