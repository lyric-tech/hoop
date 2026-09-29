import { Progress as MantineProgress } from '@mantine/core'

/**
 * Linear utilization bar with threshold coloring: green below `warnAt`,
 * yellow between `warnAt` and `dangerAt`, red at or above `dangerAt`.
 * Pass `color` to opt out of thresholds. `value` is 0-100 (null renders 0).
 */
export default function Progress({
  value,
  warnAt = 50,
  dangerAt = 80,
  color,
  size = 'sm',
  radius = 'sm',
  ...props
}) {
  const v = value ?? 0
  const resolved =
    color ?? (v >= dangerAt ? 'red' : v >= warnAt ? 'yellow.6' : 'teal')

  return (
    <MantineProgress value={v} color={resolved} size={size} radius={radius} {...props} />
  )
}
