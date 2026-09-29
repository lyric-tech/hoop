import { useEffect, useState } from 'react'
import { Group, Pill, Stack, Text } from '@mantine/core'
import Button from '@/components/Button'
import Modal from '@/components/Modal'
import Select from '@/components/Select'
import Textarea from '@/components/Textarea'
import { durationOptions } from '../helpers'

export default function RequestAccessModal({ rule, opened, submitting, onClose, onSubmit }) {
  const options = rule ? durationOptions(rule.access_max_duration) : []
  const [duration, setDuration] = useState(null)
  const [justification, setJustification] = useState('')

  // Reopening for another rule must not carry over a duration that rule caps out.
  useEffect(() => {
    if (!opened) return
    setDuration(options[0]?.value ?? null)
    setJustification('')
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [opened, rule?.name])

  if (!rule) return null

  return (
    <Modal opened={opened} onClose={onClose} title={`Request access to ${rule.name}`} size="lg">
      <Stack gap="md">
        <Stack gap="xs">
          <Text size="sm" fw={500}>
            One approval covers these resources
          </Text>
          <Group gap="xs">
            {rule.resources.map((resource) => (
              <Pill key={resource}>{resource}</Pill>
            ))}
          </Group>
        </Stack>

        <Select
          label="Access duration"
          description="Access ends automatically when the window closes."
          data={options}
          value={duration}
          onChange={setDuration}
          allowDeselect={false}
        />

        <Textarea
          label="Justification"
          description={`Shown to the approvers: ${rule.reviewers_groups.join(', ')}`}
          placeholder="Investigating INC-4821"
          value={justification}
          onChange={(event) => setJustification(event.currentTarget.value)}
          autosize
          minRows={3}
        />

        <Group justify="flex-end" gap="sm">
          <Button variant="default" onClick={onClose} disabled={submitting}>
            Cancel
          </Button>
          <Button
            loading={submitting}
            disabled={!duration}
            onClick={() =>
              onSubmit({
                rule_name: rule.name,
                duration_sec: Number(duration),
                justification,
              })
            }
          >
            Send request
          </Button>
        </Group>
      </Stack>
    </Modal>
  )
}
