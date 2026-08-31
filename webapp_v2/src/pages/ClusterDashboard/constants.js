import {
  LayoutDashboard,
  Server,
  Layers,
  Boxes,
  Copy,
  CircleDot,
  ArrowLeftRight,
  Database,
  FileKey,
} from 'lucide-react'

// Sidebar order mirrors the lyric-cluster-dashboard the views are modeled on.
export const VIEWS = [
  { id: 'overview', label: 'Overview', icon: LayoutDashboard },
  { id: 'nodes', label: 'Nodes', icon: Server },
  { id: 'namespaces', label: 'Namespaces', icon: Layers },
  { id: 'workloads', label: 'Workloads', icon: Boxes },
  { id: 'replicasets', label: 'ReplicaSets', icon: Copy },
  { id: 'pods', label: 'Pods', icon: CircleDot },
  { id: 'networking', label: 'Networking & Scaling', icon: ArrowLeftRight },
  { id: 'storage', label: 'PV & PVCs', icon: Database },
  { id: 'config', label: 'Config & Secrets', icon: FileKey },
]

export const DEFAULT_VIEW = 'overview'

// Pods table renders at most this many rows until "Show all" — matches the
// RENDER_LIMIT pattern in lyric-cluster-dashboard's PodsView.
export const PODS_RENDER_LIMIT = 200
