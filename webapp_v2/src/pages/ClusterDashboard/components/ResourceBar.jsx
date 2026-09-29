import { Group, Text, Box } from '@mantine/core'
import Progress from '@/components/Progress'
import { percent } from '../utils'

/**
 * Labeled utilization row: "CPU  1.2 / 4 cores  [=====   ] 30%".
 * `used`/`total` are numbers in the same unit; `format` renders them.
 */
export default function ResourceBar({ label, used, total, format = String }) {
  const pct = percent(used, total)
  return (
    <Group gap="xs" wrap="nowrap" align="center">
      <Text size="xs" c="dimmed" w={42}>
        {label}
      </Text>
      <Box flex={1}>
        <Progress value={pct} />
      </Box>
      <Text size="xs" w={110} ta="right">
        {pct == null ? '—' : `${format(used)} / ${format(total)} · ${pct}%`}
      </Text>
    </Group>
  )
}
