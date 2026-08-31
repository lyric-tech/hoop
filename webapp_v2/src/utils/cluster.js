// A resource is displayed as "<cluster>/<resource>". The cluster is derived by
// the gateway from the name of the agent serving the resource and arrives on
// the payload as `cluster`; it is never part of the resource's identifier, so
// only labels use the qualified form — values stay the bare id or name.

export const UNGROUPED_CLUSTER = 'Unassigned'

// qualifyName renders "<cluster>/<name>", or the bare name when the gateway
// reported no cluster (no agent assigned, or an older gateway).
export function qualifyName(clusterLabel, name) {
  return clusterLabel ? `${clusterLabel}/${name}` : (name ?? '')
}

// qualifyConnection renders a connection row from the API.
export function qualifyConnection(connection) {
  if (!connection) return ''
  return qualifyName(connection.cluster, connection.name)
}

// clusterLabel is the group heading for an option, falling back to a bucket for
// resources with no agent so they stay reachable in a grouped list.
export function clusterLabel(clusterName) {
  return clusterName || UNGROUPED_CLUSTER
}

// groupByCluster turns a flat option list into [{ cluster, options }], ordered
// by cluster name with the unassigned bucket last. Options are expected to
// carry a `cluster` field.
export function groupByCluster(options) {
  const groups = new Map()
  for (const option of options) {
    const key = clusterLabel(option.cluster)
    if (!groups.has(key)) groups.set(key, [])
    groups.get(key).push(option)
  }
  return [...groups.entries()]
    .map(([cluster, opts]) => ({ cluster, options: opts }))
    .sort((a, b) => {
      if (a.cluster === UNGROUPED_CLUSTER) return 1
      if (b.cluster === UNGROUPED_CLUSTER) return -1
      return a.cluster.localeCompare(b.cluster)
    })
}

// hasClusters reports whether any option carries a cluster, so a list can fall
// back to a flat render when the concept does not apply.
export function hasClusters(options) {
  return options.some((option) => Boolean(option.cluster))
}
