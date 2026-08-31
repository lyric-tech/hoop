import { useMemo } from 'react'
import { Stack } from '@mantine/core'
import Tabs from '@/components/Tabs'
import Badge from '@/components/Badge'
import { formatAge } from './utils'
import { SectionTable } from './NetworkingView'

export default function StorageView({ sections }) {
  // PVC → consuming workload, via the pods' volume claims. Owner of the first
  // pod that mounts the claim, or the pod itself when unowned — same join
  // lyric-cluster-dashboard's storage.go builds server-side.
  const claimToWorkload = useMemo(() => {
    const map = {}
    for (const pod of sections.podvolumes?.rows ?? []) {
      for (const claim of (pod.claims ?? '').trim().split(/\s+/)) {
        if (!claim) continue
        const key = `${pod.namespace}/${claim}`
        if (!map[key])
          map[key] = pod.ownerKind
            ? `${pod.ownerKind}/${pod.ownerName}`
            : `Pod/${pod.name}`
      }
    }
    return map
  }, [sections])

  const claimedVolumes = useMemo(
    () =>
      new Set(
        (sections.pvcs?.rows ?? []).map((p) => p.volume).filter(Boolean),
      ),
    [sections],
  )

  return (
    <Tabs defaultValue="pvcs">
      <Tabs.List>
        <Tabs.Tab value="pvcs">PVCs</Tabs.Tab>
        <Tabs.Tab value="pvs">PVs</Tabs.Tab>
        <Tabs.Tab value="storageclasses">StorageClasses</Tabs.Tab>
      </Tabs.List>

      <Tabs.Panel value="pvcs" pt="md">
        <SectionTable
          section={sections.pvcs}
          headers={['Namespace', 'Name', 'Status', 'Capacity', 'Class', 'Access', 'Used by', 'Age']}
          renderRow={(p) => [
            p.namespace, p.name,
            <Badge key="s" variant={p.phase === 'Bound' ? 'active' : 'warning'}>
              {p.phase}
            </Badge>,
            p.capacity || '—', p.storageClass || '—',
            p.accessModes?.trim() || '—',
            claimToWorkload[`${p.namespace}/${p.name}`] || '—',
            formatAge(p.created),
          ]}
        />
      </Tabs.Panel>

      <Tabs.Panel value="pvs" pt="md">
        <Stack gap="md">
          <SectionTable
            section={sections.pvs}
            headers={['Name', 'Status', 'Capacity', 'Reclaim', 'Class', 'Claim', 'Source', 'Age']}
            renderRow={(v) => {
              const orphaned =
                v.phase === 'Released' ||
                (v.claimName && !claimedVolumes.has(v.name) && v.phase !== 'Available')
              return [
                v.name,
                <Badge
                  key="s"
                  variant={
                    v.phase === 'Bound'
                      ? 'active'
                      : orphaned
                        ? 'danger'
                        : 'warning'
                  }
                >
                  {orphaned && v.phase !== 'Bound' ? `${v.phase} (orphaned)` : v.phase}
                </Badge>,
                v.capacity || '—', v.reclaim || '—', v.storageClass || '—',
                v.claimName ? `${v.claimNamespace}/${v.claimName}` : '—',
                v.csiDriver || 'non-CSI',
                formatAge(v.created),
              ]
            }}
          />
        </Stack>
      </Tabs.Panel>

      <Tabs.Panel value="storageclasses" pt="md">
        <SectionTable
          section={sections.storageclasses}
          headers={['Name', 'Provisioner', 'Reclaim', 'Binding', 'Default', 'Age']}
          renderRow={(sc) => [
            sc.name, sc.provisioner, sc.reclaim || '—', sc.bindingMode || '—',
            sc.isDefault === 'true' ? 'yes' : '—', formatAge(sc.created),
          ]}
        />
      </Tabs.Panel>
    </Tabs>
  )
}
