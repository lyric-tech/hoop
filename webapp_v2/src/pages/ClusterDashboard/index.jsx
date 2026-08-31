import { useEffect, useState } from 'react'
import { Navigate, useNavigate, useParams } from 'react-router-dom'
import { Button, Group, Stack, Text, Title } from '@mantine/core'
import { RefreshCw, SquareTerminal } from 'lucide-react'
import Tabs from '@/components/Tabs'
import PageLoader from '@/components/PageLoader'
import EmptyState from '@/layout/EmptyState'
import { connectionsService } from '@/services/connections'
import { useBridgeStore } from '@/stores/useBridgeStore'
import { DEFAULT_VIEW, VIEWS } from './constants'
import { useClusterView } from './useClusterView'
import { formatFetchedAgo } from './utils'
import ViewShell from './components/ViewShell'
import OverviewView from './OverviewView'
import PodsView from './PodsView'
import NodesView from './NodesView'
import NamespacesView from './NamespacesView'
import WorkloadsView from './WorkloadsView'
import ReplicaSetsView from './ReplicaSetsView'
import NetworkingView from './NetworkingView'
import StorageView from './StorageView'
import ConfigView from './ConfigView'

const VIEW_COMPONENTS = {
  overview: OverviewView,
  pods: PodsView,
  nodes: NodesView,
  namespaces: NamespacesView,
  workloads: WorkloadsView,
  replicasets: ReplicaSetsView,
  networking: NetworkingView,
  storage: StorageView,
  config: ConfigView,
}

export default function ClusterDashboard() {
  const { connectionName, view } = useParams()

  if (!VIEW_COMPONENTS[view]) {
    return (
      <Navigate
        replace
        to={`/cluster-dashboard/${encodeURIComponent(connectionName)}/${DEFAULT_VIEW}`}
      />
    )
  }
  // key remounts Dashboard per connection, so its fetch state never needs a
  // synchronous reset when the name changes.
  return <Dashboard key={connectionName} connectionName={connectionName} view={view} />
}

function Dashboard({ connectionName, view }) {
  const navigate = useNavigate()

  // The connection detail gates the whole page: exec disabled → explain
  // instead of firing a POST that can only fail.
  const [connection, setConnection] = useState(null)
  const [connectionError, setConnectionError] = useState(null)
  useEffect(() => {
    let cancelled = false
    connectionsService
      .getConnection(connectionName)
      .then((data) => !cancelled && setConnection(data))
      .catch((err) => !cancelled && setConnectionError(err?.response?.status ?? 0))
    return () => {
      cancelled = true
    }
  }, [connectionName])

  const execDisabled = connection?.access_mode_exec === 'disabled'
  // Load only once the connection is known and executable — never fire a POST
  // that can only fail.
  const slot = useClusterView(connectionName, view, {
    enabled: Boolean(connection) && !execDisabled,
  })

  // Re-render the "as of Xs ago" badge once per 30s.
  const [, forceTick] = useState(0)
  useEffect(() => {
    const t = setInterval(() => forceTick((n) => n + 1), 30_000)
    return () => clearInterval(t)
  }, [])

  const openInTerminal = () => {
    // view=terminal suppresses the CLJS k8s auto-redirect for this visit only.
    navigate(`/client?role=${encodeURIComponent(connectionName)}&view=terminal`)
    useBridgeStore.getState().syncPrimaryConnectionFromUrl()
  }

  if (connectionError) {
    return (
      <EmptyState
        title="Connection not found or no access"
        description="This connection doesn’t exist anymore, or your groups don’t have access to it."
        action={{ label: 'Go to Resources', onClick: () => navigate('/resources') }}
      />
    )
  }
  if (!connection) return <PageLoader h={400} />

  const ViewComponent = VIEW_COMPONENTS[view]

  return (
    <Stack gap="md">
      <Group justify="space-between" wrap="nowrap">
        <Stack gap={0}>
          <Title order={3}>{connectionName}</Title>
          <Text size="xs" c="dimmed">
            Kubernetes cluster dashboard — read-only, every query is audited
          </Text>
        </Stack>
        <Group gap="xs" wrap="nowrap">
          {slot.fetchedAt && (
            <Text size="xs" c="dimmed">
              {`as of ${formatFetchedAgo(slot.fetchedAt)}`}
            </Text>
          )}
          <Button
            size="xs"
            variant="default"
            leftSection={<RefreshCw size={14} />}
            onClick={slot.refresh}
            disabled={execDisabled || slot.busy}
            loading={slot.busy}
          >
            Refresh
          </Button>
          <Button
            size="xs"
            variant="subtle"
            leftSection={<SquareTerminal size={14} />}
            onClick={openInTerminal}
          >
            Open in terminal
          </Button>
        </Group>
      </Group>

      <Tabs
        orientation="vertical"
        value={view}
        onChange={(next) =>
          navigate(`/cluster-dashboard/${encodeURIComponent(connectionName)}/${next}`)
        }
        keepMounted={false}
      >
        <Tabs.List miw={190}>
          {VIEWS.map((v) => {
            const Icon = v.icon
            return (
              <Tabs.Tab key={v.id} value={v.id} leftSection={<Icon size={15} aria-hidden />}>
                {v.label}
              </Tabs.Tab>
            )
          })}
        </Tabs.List>

        <Tabs.Panel value={view} pl="md" w="100%">
          {execDisabled ? (
            <EmptyState
              compact
              title="Execution is disabled for this cluster"
              description="Dashboards run read-only kubectl queries through this connection, and its execution mode is turned off. An admin can enable it in the connection settings."
            />
          ) : (
            <ViewShell slot={slot}>
              {slot.sections && <ViewComponent sections={slot.sections} />}
            </ViewShell>
          )}
        </Tabs.Panel>
      </Tabs>
    </Stack>
  )
}
