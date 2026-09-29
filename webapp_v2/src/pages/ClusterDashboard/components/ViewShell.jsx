import { Alert, Anchor, Stack, Text } from '@mantine/core'
import { TriangleAlert, Hourglass, ShieldAlert } from 'lucide-react'
import PageLoader from '@/components/PageLoader'
import EmptyState from '@/layout/EmptyState'
import { useMinDelay } from '@/hooks/useMinDelay'

// Friendly copy for every terminal error the exec pipeline can produce. The
// audience is non-technical: raw API messages stay in `detail` (shown small),
// never as the headline.
const ERROR_COPY = {
  forbidden: {
    title: 'Your role can’t run cluster queries',
    description:
      'Auditor accounts are read-only and can’t execute commands. Ask an admin to run the dashboard or adjust your role.',
  },
  not_found: {
    title: 'Connection not found or no access',
    description:
      'This connection doesn’t exist anymore, or your groups don’t have access to it.',
  },
  exec_failed: {
    title: 'Execution isn’t available for this connection',
    description:
      'The gateway couldn’t start the command. Execution may be disabled for this connection, or its agent is offline.',
  },
  agent_offline: {
    title: 'This cluster’s agent is disconnected',
    description:
      'The agent that serves this connection isn’t connected to the gateway right now, so no queries can run. Check the agent’s deployment or pick a connection on a live agent.',
  },
  no_kubectl: {
    title: 'This cluster’s agent can’t run kubectl',
    description:
      'The agent serving this connection runs a minimal image without kubectl. Deploy the tools-based agent image to use dashboards.',
  },
  rejected: {
    title: 'The approval request was rejected',
    description: 'A reviewer rejected or revoked this dashboard query.',
  },
  review_timeout: {
    title: 'Still waiting for approval',
    description:
      'No reviewer approved the query within 2 minutes. The request stays open — retry after it’s approved.',
  },
  timeout: {
    title: 'The cluster took too long to answer',
    description:
      'The query is still running in the background but exceeded the dashboard’s wait. Very large clusters can hit this — retry in a moment.',
  },
  bad_output: {
    title: 'Unexpected response from the cluster',
    description:
      'The command ran but returned something the dashboard couldn’t read. A guardrail or shell error likely replaced the output.',
  },
  network: {
    title: 'Couldn’t reach the gateway',
    description: 'Check your network connection and try again.',
  },
}

export default function ViewShell({ slot, children }) {
  const { status, error, reviewUrl, truncated } = slot
  // Anti-flash: keep the loader up ≥500ms so quick execs don't blink.
  const showLoader = useMinDelay(status === 'executing' || status === 'idle')

  if (showLoader) {
    return <PageLoader h={320} />
  }

  if (status === 'pending_async') {
    return (
      <EmptyState
        compact
        title="Query still running…"
        description="This cluster is taking longer than usual. The dashboard keeps checking in the background."
      />
    )
  }

  if (status === 'pending_review') {
    return (
      <Stack align="center" py="xl" gap="sm">
        <ShieldAlert size={28} strokeWidth={1.5} aria-hidden />
        <Text fw={600}>This cluster requires approval</Text>
        <Text size="sm" c="dimmed" ta="center" maw={420}>
          A reviewer has to approve dashboard queries on this connection. The
          view loads automatically once it’s approved.
        </Text>
        {reviewUrl && (
          <Anchor href={reviewUrl} target="_blank" size="sm">
            View approval request
          </Anchor>
        )}
      </Stack>
    )
  }

  if (status === 'error') {
    const copy = ERROR_COPY[error?.code] ?? ERROR_COPY.network
    return (
      <Stack gap="xs">
        <EmptyState compact title={copy.title} description={copy.description} />
        {error?.detail && (
          <Text size="xs" c="dimmed" ta="center">
            {error.detail}
          </Text>
        )}
      </Stack>
    )
  }

  return (
    <Stack gap="md">
      {truncated && (
        <Alert
          color="yellow"
          icon={<TriangleAlert size={16} />}
          title="Some rows were omitted"
        >
          The cluster returned more data than one response can carry. Counts
          below may be lower than reality.
        </Alert>
      )}
      {children}
    </Stack>
  )
}

// Small inline notice for a single degraded panel (e.g. metrics-server
// missing) — the rest of the view stays useful.
export function PanelUnavailable({ label, detail }) {
  return (
    <Alert color="gray" icon={<Hourglass size={16} />} title={label}>
      {detail || 'This panel’s data source didn’t respond.'}
    </Alert>
  )
}
