// Ages are computed client-side from raw ISO creationTimestamps — the script
// never asks kubectl for humanized AGE columns (locale- and version-fragile).
export function formatAge(iso) {
  if (!iso) return '—'
  const ms = Date.now() - Date.parse(iso)
  if (!Number.isFinite(ms) || ms < 0) return '—'
  const minutes = Math.floor(ms / 60_000)
  if (minutes < 60) return `${minutes}m`
  const hours = Math.floor(minutes / 60)
  if (hours < 48) return `${hours}h`
  const days = Math.floor(hours / 24)
  if (days < 365) return `${days}d`
  return `${Math.floor(days / 365)}y ${days % 365}d`
}

export function formatCores(cores) {
  if (cores == null) return '—'
  return cores >= 10 ? `${Math.round(cores)}` : cores.toFixed(1)
}

export function formatMi(mi) {
  if (mi == null) return '—'
  if (mi >= 1024) return `${(mi / 1024).toFixed(1)} Gi`
  return `${Math.round(mi)} Mi`
}

export function formatFetchedAgo(fetchedAt) {
  if (!fetchedAt) return ''
  const s = Math.max(0, Math.round((Date.now() - fetchedAt) / 1000))
  if (s < 60) return `${s}s ago`
  return `${Math.floor(s / 60)}m ago`
}

export function percent(used, total) {
  if (used == null || !total) return null
  return Math.min(100, Math.round((used / total) * 100))
}
