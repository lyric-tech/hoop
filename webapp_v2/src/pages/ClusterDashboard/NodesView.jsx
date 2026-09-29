import { useMemo } from 'react'
import { Group, Paper, SimpleGrid, Stack, Text } from '@mantine/core'
import StatCard from '@/components/StatCard'
import Badge from '@/components/Badge'
import { parseCpu, parseMemMi } from './parser'
import { formatAge, formatCores, formatMi } from './utils'
import ResourceBar from './components/ResourceBar'
import { PanelUnavailable } from './components/ViewShell'

export default function NodesView({ sections }) {
  const top = sections.topnodes
  const metricsOk = top?.rc === 0 && (top.rows?.length ?? 0) > 0

  const nodes = useMemo(() => {
    const rows = sections.nodes?.rows ?? []
    const pods = sections.pods?.rows ?? []
    const usage = {}
    for (const r of top?.rows ?? []) usage[r.name] = r
    const podsPerNode = {}
    for (const p of pods)
      if (p.node) podsPerNode[p.node] = (podsPerNode[p.node] ?? 0) + 1

    return rows.map((n) => ({
      ...n,
      cordoned: n.unschedulable === 'true',
      isReady: n.ready === 'True',
      cpuUsed: usage[n.name] ? parseCpu(usage[n.name].cpu) : null,
      memUsed: usage[n.name] ? parseMemMi(usage[n.name].mem) : null,
      cpuAlloc: parseCpu(n.allocCpu),
      memAlloc: parseMemMi(n.allocMem),
      podCount: podsPerNode[n.name] ?? 0,
      podCap: Number(n.allocPods) || null,
    }))
  }, [sections, top])

  const ready = nodes.filter((n) => n.isReady).length
  const zones = new Set(nodes.map((n) => n.zone).filter(Boolean)).size
  const totalPods = nodes.reduce((acc, n) => acc + n.podCount, 0)
  const totalPodCap = nodes.reduce((acc, n) => acc + (n.podCap ?? 0), 0)
  const avg = (key, alloc) => {
    const usable = nodes.filter((n) => n[key] != null && n[alloc])
    if (usable.length === 0) return null
    return (
      usable.reduce((acc, n) => acc + (n[key] / n[alloc]) * 100, 0) / usable.length
    )
  }
  const avgCpu = avg('cpuUsed', 'cpuAlloc')
  const avgMem = avg('memUsed', 'memAlloc')

  return (
    <Stack gap="md">
      <SimpleGrid cols={{ base: 2, sm: 3, lg: 6 }} spacing="sm">
        <StatCard label="Ready" value={`${ready} / ${nodes.length}`} />
        <StatCard label="Cordoned" value={nodes.filter((n) => n.cordoned).length} />
        <StatCard label="CPU avg" value={avgCpu == null ? '—' : `${Math.round(avgCpu)}%`} />
        <StatCard label="Mem avg" value={avgMem == null ? '—' : `${Math.round(avgMem)}%`} />
        <StatCard label="Pods" value={totalPodCap ? `${totalPods} / ${totalPodCap}` : totalPods} />
        <StatCard label="Zones" value={zones} />
      </SimpleGrid>

      {!metricsOk && (
        <PanelUnavailable
          label="Metrics unavailable"
          detail="kubectl top failed — usage bars show pod counts only."
        />
      )}

      <SimpleGrid cols={{ base: 1, lg: 2 }} spacing="sm">
        {nodes.map((node) => (
          <Paper key={node.name} withBorder p="md" radius="md">
            <Stack gap="sm">
              <Group justify="space-between" wrap="nowrap">
                <Group gap="xs" wrap="nowrap">
                  <Badge variant={node.isReady ? 'active' : 'danger'}>
                    {node.isReady ? 'Ready' : 'NotReady'}
                  </Badge>
                  <Text size="sm" fw={600} lineClamp={1}>
                    {node.name}
                  </Text>
                </Group>
                {node.cordoned && (
                  <Badge variant="light" color="orange">
                    Cordoned
                  </Badge>
                )}
              </Group>

              <Group gap="lg">
                <Meta label="Type" value={node.instanceType} />
                <Meta label="Zone" value={node.zone} />
                <Meta label="Arch" value={node.arch} />
                <Meta label="IP" value={node.internalIP} />
                <Meta label="Kubelet" value={node.kubeletVersion} />
                <Meta label="Age" value={formatAge(node.created)} />
              </Group>

              <Stack gap={6}>
                {metricsOk && (
                  <>
                    <ResourceBar label="CPU" used={node.cpuUsed} total={node.cpuAlloc} format={formatCores} />
                    <ResourceBar label="Mem" used={node.memUsed} total={node.memAlloc} format={formatMi} />
                  </>
                )}
                <ResourceBar label="Pods" used={node.podCount} total={node.podCap} format={String} />
              </Stack>
            </Stack>
          </Paper>
        ))}
      </SimpleGrid>
    </Stack>
  )
}

function Meta({ label, value }) {
  return (
    <Stack gap={0}>
      <Text size="xs" c="dimmed">
        {label}
      </Text>
      <Text size="xs">{value || '—'}</Text>
    </Stack>
  )
}
