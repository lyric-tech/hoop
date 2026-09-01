import Badge from '@/components/Badge'

// Badge's semantic variants own their colors, so the bucket → variant map is
// the whole story here.
const VARIANTS = {
  running: 'active',
  completed: 'inactive',
  pending: 'warning',
  restarting: 'warning',
  failed: 'danger',
}

export default function StatusPill({ bucket, label }) {
  return <Badge variant={VARIANTS[bucket] ?? 'inactive'}>{label}</Badge>
}
