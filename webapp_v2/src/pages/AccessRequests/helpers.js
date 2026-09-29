// The ceiling the gateway applies when a rule sets no access_max_duration
// (gateway/api/accessrequests/requests.go).
const MAX_DURATION_SEC = 48 * 60 * 60

const PRESETS = [
  { value: 900, label: '15 minutes' },
  { value: 1800, label: '30 minutes' },
  { value: 3600, label: '1 hour' },
  { value: 7200, label: '2 hours' },
  { value: 14400, label: '4 hours' },
  { value: 28800, label: '8 hours' },
  { value: 86400, label: '24 hours' },
  { value: 172800, label: '48 hours' },
]

// durationOptions keeps only the presets the rule allows, and always offers the
// rule's own maximum so an odd cap (say 45 minutes) is still reachable.
export function durationOptions(accessMaxDuration) {
  const max = accessMaxDuration ?? MAX_DURATION_SEC
  const options = PRESETS.filter((p) => p.value <= max)
  if (!options.some((p) => p.value === max)) {
    options.push({ value: max, label: formatDuration(max) })
  }
  return options.map((p) => ({ value: String(p.value), label: p.label }))
}

export function formatDuration(seconds) {
  const hours = Math.floor(seconds / 3600)
  const minutes = Math.round((seconds % 3600) / 60)
  const parts = []
  if (hours > 0) parts.push(`${hours} hour${hours === 1 ? '' : 's'}`)
  if (minutes > 0) parts.push(`${minutes} minute${minutes === 1 ? '' : 's'}`)
  return parts.join(' ') || `${seconds} seconds`
}

// A pending request the signed-in user raised on this rule. Only one can be
// open at a time, so the first match is the one to show.
export function pendingRequestFor(reviews, ruleName, userEmail) {
  return reviews.find(
    (r) =>
      r.access_request_rule_name === ruleName &&
      r.status === 'PENDING' &&
      r.review_owner?.email === userEmail,
  )
}

// Requests waiting on the signed-in user: still pending overall, raised by
// somebody else, and with at least one of their groups yet to answer.
export function awaitingMyApproval(reviews, userGroups, userEmail) {
  const groups = new Set(userGroups ?? [])
  return reviews.filter(
    (r) =>
      r.status === 'PENDING' &&
      r.review_owner?.email !== userEmail &&
      (r.review_groups_data ?? []).some(
        (rg) => rg.status === 'PENDING' && groups.has(rg.group),
      ),
  )
}
