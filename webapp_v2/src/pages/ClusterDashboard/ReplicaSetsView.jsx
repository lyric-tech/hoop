import { useMemo } from 'react'
import { Paper, Stack, Text } from '@mantine/core'
import Table from '@/components/Table'
import Badge from '@/components/Badge'
import { formatAge } from './utils'
import SortableTh from './components/SortableTh'
import { useSortedRows } from './useSortedRows'

export default function ReplicaSetsView({ sections }) {
  // Fully scaled-down ReplicaSets are rollout history, not running state.
  const rows = useMemo(
    () =>
      (sections.replicasets?.rows ?? []).filter(
        (r) => Number(r.desired) > 0,
      ),
    [sections],
  )

  const { sorted, sort, toggleSort } = useSortedRows(rows, {
    accessors: {
      created: (r) => Date.parse(r.created) || 0,
      revision: (r) => Number(r.revision) || 0,
    },
  })

  return (
    <Stack gap="md">
      <Text size="xs" c="dimmed">
        {`${sorted.length} active ReplicaSets (scaled-to-zero history hidden)`}
      </Text>
      <Paper withBorder radius="md">
        <Table striped>
          <Table.Thead>
            <Table.Tr>
              <SortableTh label="Name" sortKey="name" sort={sort} onSort={toggleSort} />
              <SortableTh label="Namespace" sortKey="namespace" sort={sort} onSort={toggleSort} />
              <Table.Th>Owner</Table.Th>
              <SortableTh label="Revision" sortKey="revision" sort={sort} onSort={toggleSort} />
              <Table.Th>Ready</Table.Th>
              <SortableTh label="Age" sortKey="created" sort={sort} onSort={toggleSort} />
            </Table.Tr>
          </Table.Thead>
          <Table.Tbody>
            {sorted.map((rs) => {
              const healthy = (Number(rs.ready) || 0) >= Number(rs.desired)
              return (
                <Table.Tr key={`${rs.namespace}/${rs.name}`}>
                  <Table.Td>
                    <Text size="xs" fw={500} lineClamp={1}>
                      {rs.name}
                    </Text>
                  </Table.Td>
                  <Table.Td>{rs.namespace}</Table.Td>
                  <Table.Td>
                    <Text size="xs" c="dimmed" lineClamp={1}>
                      {rs.ownerKind ? `${rs.ownerKind}/${rs.ownerName}` : '—'}
                    </Text>
                  </Table.Td>
                  <Table.Td>{rs.revision || '—'}</Table.Td>
                  <Table.Td>
                    <Badge variant={healthy ? 'active' : 'warning'}>
                      {`${rs.ready || 0}/${rs.desired}`}
                    </Badge>
                  </Table.Td>
                  <Table.Td>{formatAge(rs.created)}</Table.Td>
                </Table.Tr>
              )
            })}
          </Table.Tbody>
        </Table>
      </Paper>
    </Stack>
  )
}
