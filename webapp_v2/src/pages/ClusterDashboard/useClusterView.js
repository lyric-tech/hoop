import { useEffect } from 'react'
import { useClusterDashboardStore } from './store'

/**
 * Binds one view of one connection to its store slot. Fires the load on mount
 * and whenever the connection/view pair changes; a fresh cached result
 * (<120s) renders instantly without re-executing.
 */
export function useClusterView(connectionName, view, { enabled = true } = {}) {
  const slot = useClusterDashboardStore((s) => s.getSlot(connectionName, view))
  const loadView = useClusterDashboardStore((s) => s.loadView)
  const refresh = useClusterDashboardStore((s) => s.refresh)

  useEffect(() => {
    if (connectionName && enabled) loadView(connectionName, view)
  }, [connectionName, view, enabled, loadView])

  return {
    ...slot,
    busy: ['executing', 'pending_async', 'pending_review'].includes(slot.status),
    refresh: () => refresh(connectionName, view),
  }
}
