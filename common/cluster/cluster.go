// Package cluster derives and renders the cluster label of a resource.
//
// A cluster is not stored anywhere: it is derived from the name of the agent
// that serves the resource. Agents are named "<cluster>-agent" by convention,
// so the label is the agent name with that suffix removed.
//
// The qualified form "<cluster>/<resource>" is accepted as input and rendered
// as output, but it is never persisted. Resource names are validated against
// ^[a-zA-Z0-9_\-\.]{1,128}$ and so can never contain "/", which makes the
// split on the first "/" unambiguous.
package cluster

import "strings"

// agentNameSuffix is the naming convention agents follow: "<cluster>-agent".
const agentNameSuffix = "-agent"

// FromAgentName derives the cluster label from an agent name by removing a
// trailing "-agent". An agent that does not follow the convention is its own
// cluster label. An empty agent name yields an empty label, which Qualify
// renders as a bare resource name.
func FromAgentName(agentName string) string {
	if trimmed := strings.TrimSuffix(agentName, agentNameSuffix); trimmed != "" {
		return trimmed
	}
	return agentName
}

// AgentNameCandidates returns the agent names a cluster label can match:
// the label itself and the label with the "-agent" suffix. Used to build the
// SQL predicate that resolves a qualified name back to a resource.
func AgentNameCandidates(clusterLabel string) []string {
	return []string{clusterLabel, clusterLabel + agentNameSuffix}
}

// Split splits "<cluster>/<resource>" into its parts. A value with no "/"
// is a bare resource name and yields an empty cluster.
func Split(qualified string) (clusterLabel, name string) {
	if before, after, found := strings.Cut(qualified, "/"); found {
		return before, after
	}
	return "", qualified
}

// IsQualified reports whether a value carries a cluster prefix.
func IsQualified(qualified string) bool {
	return strings.Contains(qualified, "/")
}

// Qualify renders "<cluster>/<resource>", or the bare name when the cluster
// label is empty, so that a resource with no agent never renders as "/name".
func Qualify(clusterLabel, name string) string {
	if clusterLabel == "" {
		return name
	}
	return clusterLabel + "/" + name
}

// QualifyFromAgentName renders the qualified name of a resource served by the
// named agent. It is the composition callers reach for most.
func QualifyFromAgentName(agentName, name string) string {
	return Qualify(FromAgentName(agentName), name)
}
