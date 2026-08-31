import { Paper, Stack, Text } from '@mantine/core'
import Tabs from '@/components/Tabs'
import Table from '@/components/Table'
import Badge from '@/components/Badge'
import EmptyState from '@/layout/EmptyState'
import { isCrdMissing } from './parser'
import { formatAge } from './utils'
import { PanelUnavailable } from './components/ViewShell'

// HPA health mirrors lyric-cluster-dashboard's client-side classification.
function hpaHealth(h) {
  const current = Number(h.current) || 0
  const desired = Number(h.desired) || 0
  if (current >= Number(h.max)) return 'capped'
  if (current <= Number(h.min) && desired > current) return 'starved'
  return 'ok'
}

export default function NetworkingView({ sections }) {
  return (
    <Tabs defaultValue="services">
      <Tabs.List>
        <Tabs.Tab value="services">Services</Tabs.Tab>
        <Tabs.Tab value="ingresses">Ingresses</Tabs.Tab>
        <Tabs.Tab value="hpa">HPA</Tabs.Tab>
        <Tabs.Tab value="vpa">VPA</Tabs.Tab>
        <Tabs.Tab value="gatewayapi">Gateway API</Tabs.Tab>
      </Tabs.List>

      <Tabs.Panel value="services" pt="md">
        <SectionTable
          section={sections.services}
          headers={['Namespace', 'Name', 'Type', 'Cluster IP', 'Ports', 'External', 'Age']}
          renderRow={(s) => [
            s.namespace, s.name, s.type, s.clusterIP || '—',
            s.ports?.trim() || '—', s.external?.trim() || '—', formatAge(s.created),
          ]}
        />
      </Tabs.Panel>

      <Tabs.Panel value="ingresses" pt="md">
        <SectionTable
          section={sections.ingresses}
          headers={['Namespace', 'Name', 'Class', 'Hosts', 'TLS', 'Load balancer', 'Age']}
          renderRow={(i) => [
            i.namespace, i.name, i.className || '—', i.hosts?.trim() || '—',
            i.tlsCount ? 'yes' : '—', i.lb?.trim() || '—', formatAge(i.created),
          ]}
        />
      </Tabs.Panel>

      <Tabs.Panel value="hpa" pt="md">
        <SectionTable
          section={sections.hpa}
          headers={['Namespace', 'Name', 'Target', 'Replicas', 'Min/Max', 'Health', 'Age']}
          renderRow={(h) => {
            const health = hpaHealth(h)
            return [
              h.namespace, h.name, `${h.targetKind}/${h.targetName}`,
              `${h.current || 0} → ${h.desired || 0}`, `${h.min}–${h.max}`,
              <Badge
                key="health"
                variant={health === 'ok' ? 'active' : 'warning'}
              >
                {health}
              </Badge>,
              formatAge(h.created),
            ]
          }}
        />
      </Tabs.Panel>

      <Tabs.Panel value="vpa" pt="md">
        <CrdTable
          section={sections.vpa}
          crdLabel="Vertical Pod Autoscaler"
          headers={['Namespace', 'Name', 'Target', 'Mode', 'Age']}
          renderRow={(v) => [
            v.namespace, v.name, `${v.targetKind}/${v.targetName}`,
            v.updateMode || '—', formatAge(v.created),
          ]}
        />
      </Tabs.Panel>

      <Tabs.Panel value="gatewayapi" pt="md">
        <Stack gap="md">
          <CrdTable
            section={sections.gateways}
            crdLabel="Gateway API"
            headers={['Namespace', 'Name', 'Class', 'Age']}
            renderRow={(g) => [g.namespace, g.name, g.className || '—', formatAge(g.created)]}
          />
          {sections.httproutes?.rc === 0 && (
            <>
              <Text size="sm" fw={600}>
                HTTP routes
              </Text>
              <SectionTable
                section={sections.httproutes}
                headers={['Namespace', 'Name', 'Hostnames', 'Age']}
                renderRow={(r) => [
                  r.namespace, r.name, r.hostnames?.trim() || '—', formatAge(r.created),
                ]}
              />
            </>
          )}
        </Stack>
      </Tabs.Panel>
    </Tabs>
  )
}

export function SectionTable({ section, headers, renderRow }) {
  if (!section || section.rc !== 0) {
    return (
      <PanelUnavailable
        label="Couldn’t load this panel"
        detail={section?.stderr?.split('\n')[0]}
      />
    )
  }
  const rows = section.rows ?? []
  if (rows.length === 0) {
    return <EmptyState compact title="Nothing here yet" />
  }
  return (
    <Paper withBorder radius="md">
      <Table striped>
        <Table.Thead>
          <Table.Tr>
            {headers.map((h) => (
              <Table.Th key={h}>{h}</Table.Th>
            ))}
          </Table.Tr>
        </Table.Thead>
        <Table.Tbody>
          {rows.map((row, i) => (
            <Table.Tr key={i}>
              {renderRow(row).map((cell, j) => (
                <Table.Td key={j}>
                  {typeof cell === 'string' || typeof cell === 'number' ? (
                    <Text size="xs" lineClamp={1}>
                      {cell}
                    </Text>
                  ) : (
                    cell
                  )}
                </Table.Td>
              ))}
            </Table.Tr>
          ))}
        </Table.Tbody>
      </Table>
    </Paper>
  )
}

// CRD-backed panels: absence of the CRD is an expected state, not an error.
function CrdTable({ section, crdLabel, ...props }) {
  if (section && isCrdMissing(section)) {
    return (
      <EmptyState
        compact
        title={`${crdLabel} isn’t installed on this cluster`}
      />
    )
  }
  return <SectionTable section={section} {...props} />
}
