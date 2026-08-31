import { Group, UnstyledButton, Text } from '@mantine/core'
import { ChevronUp, ChevronDown } from 'lucide-react'
import Table from '@/components/Table'

export default function SortableTh({ label, sortKey, sort, onSort, ...props }) {
  const active = sort?.key === sortKey
  const Icon = active && sort.dir === -1 ? ChevronDown : ChevronUp
  return (
    <Table.Th {...props}>
      <UnstyledButton onClick={() => onSort(sortKey)} aria-label={`Sort by ${label}`}>
        <Group gap={4} wrap="nowrap">
          <Text size="xs" fw={600} c={active ? undefined : 'dimmed'}>
            {label}
          </Text>
          {active && <Icon size={12} aria-hidden />}
        </Group>
      </UnstyledButton>
    </Table.Th>
  )
}
