import { useMemo, useState } from 'react'
import { Group, Paper, Select, Stack, Text } from '@mantine/core'
import Table from '@/components/Table'
import Badge from '@/components/Badge'
import SearchInput from '@/components/SearchInput'
import { formatAge } from './utils'
import SortableTh from './components/SortableTh'
import { useSortedRows } from './useSortedRows'

const KINDS = [
  { id: 'deploys', kind: 'Deployment' },
  { id: 'statefulsets', kind: 'StatefulSet' },
  { id: 'daemonsets', kind: 'DaemonSet' },
  { id: 'jobs', kind: 'Job' },
  { id: 'cronjobs', kind: 'CronJob' },
]

function workloadStatus(w) {
  if (w.kind === 'CronJob') return w.suspend === 'true' ? 'suspended' : 'active'
  if (w.kind === 'Job') {
    if (Number(w.failed)) return 'failed'
    return Number(w.active) ? 'active' : 'complete'
  }
  const ready = Number(w.ready) || 0
  const desired = Number(w.desired) || 0
  if (desired === 0) return 'scaled to 0'
  return ready >= desired ? 'healthy' : 'degraded'
}

const STATUS_VARIANT = {
  healthy: 'active',
  active: 'active',
  complete: 'inactive',
  'scaled to 0': 'inactive',
  suspended: 'warning',
  degraded: 'warning',
  failed: 'danger',
}

export default function WorkloadsView({ sections }) {
  const [kindFilter, setKindFilter] = useState(null)
  const [search, setSearch] = useState('')

  const rows = useMemo(
    () =>
      KINDS.flatMap(({ id, kind }) =>
        (sections[id]?.rows ?? []).map((r) => ({ ...r, kind })),
      ),
    [sections],
  )

  const filtered = useMemo(() => {
    const q = search.trim().toLowerCase()
    return rows.filter(
      (w) =>
        (!kindFilter || w.kind === kindFilter) &&
        (!q || w.name.toLowerCase().includes(q) || w.namespace.toLowerCase().includes(q)),
    )
  }, [rows, kindFilter, search])

  const { sorted, sort, toggleSort } = useSortedRows(filtered, {
    accessors: { created: (r) => Date.parse(r.created) || 0 },
  })

  return (
    <Stack gap="md">
      <Group gap="sm">
        <SearchInput value={search} onChange={setSearch} placeholder="Search workloads…" w={240} />
        <Select
          size="xs"
          w={160}
          placeholder="Kind"
          clearable
          data={KINDS.map((k) => k.kind)}
          value={kindFilter}
          onChange={setKindFilter}
        />
        <Text size="xs" c="dimmed">
          {`${sorted.length} workloads`}
        </Text>
      </Group>

      <Paper withBorder radius="md">
        <Table striped>
          <Table.Thead>
            <Table.Tr>
              <SortableTh label="Name" sortKey="name" sort={sort} onSort={toggleSort} />
              <SortableTh label="Namespace" sortKey="namespace" sort={sort} onSort={toggleSort} />
              <SortableTh label="Kind" sortKey="kind" sort={sort} onSort={toggleSort} />
              <Table.Th>Ready</Table.Th>
              <Table.Th>Status</Table.Th>
              <SortableTh label="Age" sortKey="created" sort={sort} onSort={toggleSort} />
            </Table.Tr>
          </Table.Thead>
          <Table.Tbody>
            {sorted.map((w) => {
              const status = workloadStatus(w)
              return (
                <Table.Tr key={`${w.kind}/${w.namespace}/${w.name}`}>
                  <Table.Td>
                    <Text size="xs" fw={500} lineClamp={1}>
                      {w.name}
                    </Text>
                  </Table.Td>
                  <Table.Td>{w.namespace}</Table.Td>
                  <Table.Td>{w.kind}</Table.Td>
                  <Table.Td>
                    {w.kind === 'CronJob'
                      ? w.schedule
                      : w.kind === 'Job'
                        ? `${w.succeeded || 0} ok / ${w.failed || 0} failed`
                        : `${w.ready || 0}/${w.desired || 0}`}
                  </Table.Td>
                  <Table.Td>
                    <Badge variant={STATUS_VARIANT[status]}>{status}</Badge>
                  </Table.Td>
                  <Table.Td>{formatAge(w.created)}</Table.Td>
                </Table.Tr>
              )
            })}
          </Table.Tbody>
        </Table>
      </Paper>
    </Stack>
  )
}
