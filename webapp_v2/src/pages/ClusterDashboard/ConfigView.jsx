import { Alert, Stack } from '@mantine/core'
import { Info } from 'lucide-react'
import Tabs from '@/components/Tabs'
import { SectionTable } from './NetworkingView'

// Values are never fetched: the script reads configmaps/secrets through the
// server-side table printer only (names, entry counts, age). See the security
// invariant in script.js.
export default function ConfigView({ sections }) {
  return (
    <Stack gap="md">
      <Alert color="gray" icon={<Info size={16} />}>
        The dashboard lists names and entry counts only — values never leave
        the cluster.
      </Alert>

      <Tabs defaultValue="configmaps">
        <Tabs.List>
          <Tabs.Tab value="configmaps">ConfigMaps</Tabs.Tab>
          <Tabs.Tab value="secrets">Secrets</Tabs.Tab>
        </Tabs.List>

        <Tabs.Panel value="configmaps" pt="md">
          <SectionTable
            section={sections.configmaps}
            headers={['Namespace', 'Name', 'Entries', 'Age']}
            renderRow={(c) => [c.namespace, c.name, c.data, c.age]}
          />
        </Tabs.Panel>

        <Tabs.Panel value="secrets" pt="md">
          <SectionTable
            section={sections.secrets}
            headers={['Namespace', 'Name', 'Type', 'Entries', 'Age']}
            renderRow={(s) => [s.namespace, s.name, s.type, s.data, s.age]}
          />
        </Tabs.Panel>
      </Tabs>
    </Stack>
  )
}
