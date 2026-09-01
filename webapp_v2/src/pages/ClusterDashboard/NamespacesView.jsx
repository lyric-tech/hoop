import { useMemo } from 'react'
import { Paper, Stack } from '@mantine/core'
import Table from '@/components/Table'
import Badge from '@/components/Badge'
import { formatAge } from './utils'
import SortableTh from './components/SortableTh'
import { useSortedRows } from './useSortedRows'

// Counts are computed client-side from the sibling sections — the cluster is
// asked for nothing beyond the same projections other views already use.
export default function NamespacesView({ sections }) {
  const rows = useMemo(() => {
    const count = (sectionRows) => {
      const per = {}
      for (const r of sectionRows ?? [])
        per[r.namespace] = (per[r.namespace] ?? 0) + 1
      return per
    }
    const podCount = count(sections.pods?.rows)
    const svcCount = count(sections.services?.rows)
    const workloadCount = count([
      ...(sections.deploys?.rows ?? []),
      ...(sections.statefulsets?.rows ?? []),
      ...(sections.daemonsets?.rows ?? []),
    ])

    return (sections.namespaces?.rows ?? []).map((ns) => ({
      ...ns,
      pods: podCount[ns.name] ?? 0,
      workloads: workloadCount[ns.name] ?? 0,
      services: svcCount[ns.name] ?? 0,
    }))
  }, [sections])

  const { sorted, sort, toggleSort } = useSortedRows(rows, {
    initial: { key: 'pods', dir: -1 },
    accessors: { created: (r) => Date.parse(r.created) || 0 },
  })

  return (
    <Stack gap="md">
      <Paper withBorder radius="md">
        <Table striped>
          <Table.Thead>
            <Table.Tr>
              <SortableTh label="Name" sortKey="name" sort={sort} onSort={toggleSort} />
              <Table.Th>Status</Table.Th>
              <SortableTh label="Pods" sortKey="pods" sort={sort} onSort={toggleSort} />
              <SortableTh label="Workloads" sortKey="workloads" sort={sort} onSort={toggleSort} />
              <SortableTh label="Services" sortKey="services" sort={sort} onSort={toggleSort} />
              <SortableTh label="Age" sortKey="created" sort={sort} onSort={toggleSort} />
            </Table.Tr>
          </Table.Thead>
          <Table.Tbody>
            {sorted.map((ns) => (
              <Table.Tr key={ns.name}>
                <Table.Td>{ns.name}</Table.Td>
                <Table.Td>
                  <Badge variant={ns.phase === 'Active' ? 'active' : 'warning'}>
                    {ns.phase}
                  </Badge>
                </Table.Td>
                <Table.Td>{ns.pods}</Table.Td>
                <Table.Td>{ns.workloads}</Table.Td>
                <Table.Td>{ns.services}</Table.Td>
                <Table.Td>{formatAge(ns.created)}</Table.Td>
              </Table.Tr>
            ))}
          </Table.Tbody>
        </Table>
      </Paper>
    </Stack>
  )
}
