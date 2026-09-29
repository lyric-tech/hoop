import { Paper, Text, Group, Stack } from '@mantine/core'

/**
 * Compact stat tile: big value, small label, optional secondary detail and a
 * leading icon. Value accepts a ReactNode so callers can compose "12 / 14".
 */
export default function StatCard({ label, value, detail, icon: Icon, ...props }) {
  return (
    <Paper withBorder p="md" radius="md" {...props}>
      <Group gap="sm" align="flex-start" wrap="nowrap">
        {Icon && <Icon size={18} strokeWidth={1.6} aria-hidden />}
        <Stack gap={2}>
          <Text size="xs" c="dimmed" tt="uppercase" fw={600}>
            {label}
          </Text>
          <Text fz="xl" fw={700} lh={1.2}>
            {value ?? '—'}
          </Text>
          {detail && (
            <Text size="xs" c="dimmed">
              {detail}
            </Text>
          )}
        </Stack>
      </Group>
    </Paper>
  )
}
