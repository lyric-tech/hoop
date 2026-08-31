import { useMemo, useState } from 'react'
import { Button, Group, Paper, Select, SimpleGrid, Stack, Text } from '@mantine/core'
import StatCard from '@/components/StatCard'
import SearchInput from '@/components/SearchInput'
import Table from '@/components/Table'
import { parseContainers, parseCpu, parseMemMi, podStatusBucket } from './parser'
import { formatAge, formatCores, formatMi } from './utils'
import { PODS_RENDER_LIMIT } from './constants'
import SortableTh from './components/SortableTh'
import StatusPill from './components/StatusPill'
import { useSortedRows } from './useSortedRows'

export default function PodsView({ sections }) {
  const [search, setSearch] = useState('')
  const [statusFilter, setStatusFilter] = useState(null)
  const [ownerFilter, setOwnerFilter] = useState(null)
  const [showAll, setShowAll] = useState(false)

  // Enrich each pod row once: status bucket, container counts, live usage.
  const pods = useMemo(() => {
    const usage = {}
    for (const r of sections.toppods?.rows ?? [])
      usage[`${r.namespace}/${r.name}`] = r
    return (sections.pods?.rows ?? []).map((row) => {
      const { ready, total, restarts } = parseContainers(row.containers)
      const bucket =
        restarts > 0 && podStatusBucket(row) === 'running'
          ? 'restarting'
          : podStatusBucket(row)
      const top = usage[`${row.namespace}/${row.name}`]
      return {
        ...row,
        bucket,
        ready,
        total,
        restarts,
        cpu: top ? parseCpu(top.cpu) : null,
        mem: top ? parseMemMi(top.mem) : null,
      }
    })
  }, [sections])

  const counts = useMemo(() => {
    const c = { running: 0, pending: 0, failed: 0, completed: 0, restarting: 0, restarts: 0, cpu: 0, mem: 0 }
    for (const p of pods) {
      c[p.bucket]++
      c.restarts += p.restarts
      c.cpu += p.cpu ?? 0
      c.mem += p.mem ?? 0
    }
    return c
  }, [pods])

  const owners = useMemo(
    () => [...new Set(pods.map((p) => p.ownerKind).filter(Boolean))].sort(),
    [pods],
  )

  const filtered = useMemo(() => {
    const q = search.trim().toLowerCase()
    return pods.filter(
      (p) =>
        (!q || p.name.toLowerCase().includes(q) || p.namespace.toLowerCase().includes(q)) &&
        (!statusFilter || p.bucket === statusFilter) &&
        (!ownerFilter || p.ownerKind === ownerFilter),
    )
  }, [pods, search, statusFilter, ownerFilter])

  const { sorted, sort, toggleSort } = useSortedRows(filtered, {
    accessors: {
      restarts: (r) => r.restarts,
      cpu: (r) => r.cpu ?? -1,
      mem: (r) => r.mem ?? -1,
      created: (r) => Date.parse(r.created) || 0,
    },
  })
  const visible = showAll ? sorted : sorted.slice(0, PODS_RENDER_LIMIT)
  const hidden = sorted.length - visible.length
  const namespaceCount = new Set(pods.map((p) => p.namespace)).size

  return (
    <Stack gap="md">
      <SimpleGrid cols={{ base: 2, sm: 4, lg: 7 }} spacing="sm">
        <StatCard label="Total" value={pods.length} detail={`${namespaceCount} namespaces`} />
        <StatCard label="Running" value={counts.running} />
        <StatCard label="Pending" value={counts.pending} />
        <StatCard label="Failed" value={counts.failed} />
        <StatCard label="Restarts" value={counts.restarts} />
        <StatCard label="CPU" value={formatCores(counts.cpu)} detail="cores in use" />
        <StatCard label="Memory" value={formatMi(counts.mem)} detail="in use" />
      </SimpleGrid>

      <Group gap="sm">
        <SearchInput value={search} onChange={setSearch} placeholder="Search pods…" w={240} />
        <Select
          size="xs"
          w={150}
          placeholder="Status"
          clearable
          data={['running', 'pending', 'failed', 'completed', 'restarting']}
          value={statusFilter}
          onChange={setStatusFilter}
        />
        <Select
          size="xs"
          w={170}
          placeholder="Owner kind"
          clearable
          data={owners}
          value={ownerFilter}
          onChange={setOwnerFilter}
        />
        <Text size="xs" c="dimmed">
          {`${sorted.length} of ${pods.length} pods`}
        </Text>
      </Group>

      <Paper withBorder radius="md">
        <Table striped>
          <Table.Thead>
            <Table.Tr>
              <SortableTh label="Name" sortKey="name" sort={sort} onSort={toggleSort} />
              <SortableTh label="Namespace" sortKey="namespace" sort={sort} onSort={toggleSort} />
              <Table.Th>Status</Table.Th>
              <Table.Th>Ready</Table.Th>
              <SortableTh label="Restarts" sortKey="restarts" sort={sort} onSort={toggleSort} />
              <SortableTh label="Age" sortKey="created" sort={sort} onSort={toggleSort} />
              <Table.Th>Pod IP</Table.Th>
              <Table.Th>Owner</Table.Th>
              <SortableTh label="CPU" sortKey="cpu" sort={sort} onSort={toggleSort} />
              <SortableTh label="Memory" sortKey="mem" sort={sort} onSort={toggleSort} />
            </Table.Tr>
          </Table.Thead>
          <Table.Tbody>
            {visible.map((pod) => (
              <Table.Tr key={`${pod.namespace}/${pod.name}`}>
                <Table.Td>
                  <Text size="xs" fw={500} lineClamp={1}>
                    {pod.name}
                  </Text>
                </Table.Td>
                <Table.Td>{pod.namespace}</Table.Td>
                <Table.Td>
                  <StatusPill bucket={pod.bucket} label={pod.deleting ? 'Terminating' : pod.phase} />
                </Table.Td>
                <Table.Td>{`${pod.ready}/${pod.total}`}</Table.Td>
                <Table.Td>{pod.restarts}</Table.Td>
                <Table.Td>{formatAge(pod.created)}</Table.Td>
                <Table.Td>{pod.podIP || '—'}</Table.Td>
                <Table.Td>
                  <Text size="xs" c="dimmed" lineClamp={1}>
                    {pod.ownerKind ? `${pod.ownerKind}/${pod.ownerName}` : '—'}
                  </Text>
                </Table.Td>
                <Table.Td>{pod.cpu == null ? '—' : formatCores(pod.cpu)}</Table.Td>
                <Table.Td>{pod.mem == null ? '—' : formatMi(pod.mem)}</Table.Td>
              </Table.Tr>
            ))}
          </Table.Tbody>
        </Table>
      </Paper>

      {hidden > 0 && (
        <Button variant="subtle" size="xs" onClick={() => setShowAll(true)}>
          {`Show all ${sorted.length} pods (${hidden} hidden)`}
        </Button>
      )}
    </Stack>
  )
}
