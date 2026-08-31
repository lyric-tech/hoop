import { Group, Paper, SimpleGrid, Stack, Text } from '@mantine/core'
import { Server, CircleDot, Boxes, CalendarClock } from 'lucide-react'
import StatCard from '@/components/StatCard'
import RingProgress from '@/components/RingProgress'
import BarChart from '@/components/BarChart'
import Table from '@/components/Table'
import { parseCpu, parseMemMi, podStatusBucket } from './parser'
import { formatAge, formatCores, formatMi } from './utils'
import { PanelUnavailable } from './components/ViewShell'

export default function OverviewView({ sections }) {
  const nodes = sections.nodes?.rows ?? []
  const pods = sections.pods?.rows ?? []
  const deploys = sections.deploys?.rows ?? []
  const cronjobs = sections.cronjobs?.rows ?? []
  const topnodes = sections.topnodes
  const events = sections.events?.rows ?? []

  const nodesReady = nodes.filter((n) => n.ready === 'True').length
  const buckets = { running: 0, pending: 0, failed: 0, completed: 0 }
  for (const pod of pods) buckets[podStatusBucket(pod)]++
  const deploysReady = deploys.filter(
    (d) => d.ready !== '' && d.ready === d.desired,
  ).length

  // Cluster gauges: usage from `kubectl top nodes`, capacity from allocatable.
  const capacity = nodes.reduce(
    (acc, n) => ({
      cpu: acc.cpu + (parseCpu(n.allocCpu) ?? 0),
      mem: acc.mem + (parseMemMi(n.allocMem) ?? 0),
    }),
    { cpu: 0, mem: 0 },
  )
  const usage = (topnodes?.rows ?? []).reduce(
    (acc, r) => ({
      cpu: acc.cpu + (parseCpu(r.cpu) ?? 0),
      mem: acc.mem + (parseMemMi(r.mem) ?? 0),
    }),
    { cpu: 0, mem: 0 },
  )
  const metricsOk = topnodes?.rc === 0 && (topnodes.rows?.length ?? 0) > 0

  // Top 8 namespaces by pod count, from the pods projection.
  const perNamespace = {}
  for (const pod of pods)
    perNamespace[pod.namespace] = (perNamespace[pod.namespace] ?? 0) + 1
  const topNamespaces = Object.entries(perNamespace)
    .sort((a, b) => b[1] - a[1])
    .slice(0, 8)
    .map(([namespace, count]) => ({ namespace, pods: count }))

  const recentWarnings = events.slice(-15).reverse()

  return (
    <Stack gap="md">
      <SimpleGrid cols={{ base: 2, sm: 3, lg: 6 }} spacing="sm">
        <StatCard icon={Server} label="Nodes" value={`${nodesReady} / ${nodes.length}`} detail="ready" />
        <StatCard icon={CircleDot} label="Pods" value={pods.length} detail={`${buckets.running} running`} />
        <StatCard label="Pending" value={buckets.pending} />
        <StatCard label="Failed" value={buckets.failed} />
        <StatCard icon={Boxes} label="Deploys" value={`${deploysReady} / ${deploys.length}`} detail="ready" />
        <StatCard icon={CalendarClock} label="CronJobs" value={cronjobs.length} />
      </SimpleGrid>

      {metricsOk ? (
        <SimpleGrid cols={{ base: 1, sm: 2 }} spacing="sm">
          <GaugeCard
            label="Cluster CPU"
            pct={capacity.cpu ? (usage.cpu / capacity.cpu) * 100 : 0}
            detail={`${formatCores(usage.cpu)} of ${formatCores(capacity.cpu)} cores`}
          />
          <GaugeCard
            label="Cluster Memory"
            pct={capacity.mem ? (usage.mem / capacity.mem) * 100 : 0}
            detail={`${formatMi(usage.mem)} of ${formatMi(capacity.mem)}`}
          />
        </SimpleGrid>
      ) : (
        <PanelUnavailable
          label="Metrics unavailable"
          detail="kubectl top failed — metrics-server may not be installed on this cluster."
        />
      )}

      {topNamespaces.length > 0 && (
        <Paper withBorder p="md" radius="md">
          <Text size="sm" fw={600} mb="sm">
            Top namespaces by pods
          </Text>
          <BarChart
            h={220}
            data={topNamespaces}
            dataKey="namespace"
            orientation="vertical"
            barProps={{ radius: 4 }}
            series={[{ name: 'pods', label: 'Pods', color: 'indigo.5' }]}
          />
        </Paper>
      )}

      <Paper withBorder p="md" radius="md">
        <Text size="sm" fw={600} mb="sm">
          Recent warnings
        </Text>
        {recentWarnings.length === 0 ? (
          <Text size="sm" c="dimmed">
            No warning events — the cluster looks healthy.
          </Text>
        ) : (
          <Table striped={false}>
            <Table.Thead>
              <Table.Tr>
                <Table.Th>Last seen</Table.Th>
                <Table.Th>Namespace</Table.Th>
                <Table.Th>Object</Table.Th>
                <Table.Th>Reason</Table.Th>
                <Table.Th>Count</Table.Th>
                <Table.Th>Message</Table.Th>
              </Table.Tr>
            </Table.Thead>
            <Table.Tbody>
              {recentWarnings.map((event, i) => (
                <Table.Tr key={i}>
                  <Table.Td>{formatAge(event.lastSeen)}</Table.Td>
                  <Table.Td>{event.namespace}</Table.Td>
                  <Table.Td>{`${event.kind}/${event.objectName}`}</Table.Td>
                  <Table.Td>{event.reason}</Table.Td>
                  <Table.Td>{event.count}</Table.Td>
                  <Table.Td>
                    <Text size="xs" lineClamp={2}>
                      {event.message}
                    </Text>
                  </Table.Td>
                </Table.Tr>
              ))}
            </Table.Tbody>
          </Table>
        )}
      </Paper>
    </Stack>
  )
}

function GaugeCard({ label, pct, detail }) {
  return (
    <Paper withBorder p="md" radius="md">
      <Group gap="md">
        <RingProgress value={Math.min(100, pct)} size={72} thickness={6} />
        <Stack gap={2}>
          <Text size="sm" fw={600}>
            {label}
          </Text>
          <Text size="xs" c="dimmed">
            {detail}
          </Text>
        </Stack>
      </Group>
    </Paper>
  )
}
