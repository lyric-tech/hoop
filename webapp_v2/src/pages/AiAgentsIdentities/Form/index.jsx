import { useState, useEffect } from 'react'
import { useNavigate, useParams } from 'react-router-dom'
import { Button, Grid, Group, Stack, Text, Title, Box } from '@mantine/core'
import { showSnackbar } from '@/utils/snackbar'
import { ArrowLeft } from 'lucide-react'
import { useMinDelay } from '@/hooks/useMinDelay'
import PageLoader from '@/components/PageLoader'
import TextInput from '@/components/TextInput'
import MultiSelect from '@/components/MultiSelect'
import Select from '@/components/Select'
import { aiAgentsService } from '@/services/aiAgents'
import { usersService } from '@/services/users'

const LIST_PATH = '/ai-agents-identities'
const CREATED_PATH = '/ai-agents-identities/created'

function SectionRow({ title, description, children }) {
  return (
    <Grid columns={7} gutter="xl">
      <Grid.Col span={2}>
        <Stack gap="xs">
          <Title order={4}>{title}</Title>
          <Text size="sm" c="dimmed">
            {description}
          </Text>
        </Stack>
      </Grid.Col>
      <Grid.Col span={5}>{children}</Grid.Col>
    </Grid>
  )
}

export default function AiAgentsIdentitiesForm() {
  const navigate = useNavigate()
  const { id } = useParams()
  const isEdit = Boolean(id)

  const [name, setName] = useState('')
  const [groups, setGroups] = useState([])
  const [availableGroups, setAvailableGroups] = useState([])
  const [ownerUserId, setOwnerUserId] = useState(null)
  const [availableUsers, setAvailableUsers] = useState([])
  const [loading, setLoading] = useState(isEdit)
  const [saving, setSaving] = useState(false)

  const showLoader = useMinDelay(loading)

  // Mirrors models.AIAgentNameForOwner so the field previews what the API will
  // store; the API remains the one that assigns it.
  const ownerLabel = availableUsers.find((u) => u.value === ownerUserId)?.label ?? ''
  const ownerName = ownerUserId ? `${ownerLabel.replace(/ \(.*\)$/, '')}'s AI agent` : ''

  useEffect(() => {
    async function loadData() {
      try {
        const [groupsRes, usersRes, agentRes] = await Promise.all([
          usersService.listGroups(),
          usersService.list(),
          isEdit ? aiAgentsService.get(id) : Promise.resolve(null),
        ])
        const groupData = groupsRes.data ?? []
        setAvailableGroups(groupData.map((g) => ({ value: g, label: g })))
        setAvailableUsers(
          (usersRes.data ?? []).map((u) => ({
            value: u.id,
            label: u.email ? `${u.name || u.email} (${u.email})` : u.name,
          }))
        )
        if (agentRes) {
          const agent = agentRes.data
          setName(agent.name ?? '')
          setGroups(agent.groups ?? [])
          setOwnerUserId(agent.owner_user_id ?? null)
        }
      } catch {
        showSnackbar({ level: 'error', text: 'Failed to load data.' })
      } finally {
        setLoading(false)
      }
    }
    loadData()
  }, [id, isEdit])

  async function handleSubmit() {
    // An owned agent is named after its owner by the API, so the name field is
    // only required when there is no owner to derive it from.
    if (!ownerUserId && !name.trim()) {
      showSnackbar({ level: 'error', text: 'Name is required.' })
      return
    }
    setSaving(true)
    try {
      // '' detaches the owner; the API leaves it untouched when absent.
      const payload = { name, groups, owner_user_id: ownerUserId ?? '' }
      if (isEdit) {
        await aiAgentsService.update(id, payload)
        showSnackbar({ level: 'success', text: 'AI Agent updated.' })
        navigate(LIST_PATH)
      } else {
        const res = await aiAgentsService.create(payload)
        navigate(CREATED_PATH, { state: { agent: res.data } })
      }
    } catch {
      showSnackbar({
        level: 'error',
        text: `Failed to ${isEdit ? 'update' : 'create'} AI Agent.`,
      })
    } finally {
      setSaving(false)
    }
  }

  if (showLoader) return <PageLoader />

  return (
    <Stack gap={0}>
      <Box>
        <Button
          variant="transparent"
          color="gray"
          leftSection={<ArrowLeft size={16} />}
          onClick={() => navigate(LIST_PATH)}
          px={0}
          w="fit-content"
          mb="xl"
        >
          Back
        </Button>
      </Box>

      <Group justify="space-between" align="center" mb="xxxlAlt">
        <Title order={1}>
          {isEdit ? 'Configure AI Agent Identity' : 'Create new AI Agent Identity'}
        </Title>
        <Button onClick={handleSubmit} loading={saving}>
          Save
        </Button>
      </Group>

      <Stack gap="xxlAlt">
        <SectionRow
          title="Set basic information"
          description="Used to identify this AI Agent and its actions across Lyric IAM."
        >
          <Stack gap="md">
            <Select
              label="Owner"
              placeholder="Select the user this agent acts for"
              data={availableUsers}
              value={ownerUserId}
              onChange={setOwnerUserId}
              searchable
              clearable
            />
            <TextInput
              label="Name"
              placeholder="e.g. AI Agent SRE"
              value={ownerUserId ? ownerName : name}
              onChange={(e) => setName(e.currentTarget.value)}
              disabled={Boolean(ownerUserId)}
              description={
                ownerUserId
                  ? "Derived from the owner. The agent's sessions, reviews and audit entries are recorded against the owner's email."
                  : undefined
              }
              required={!ownerUserId}
            />
          </Stack>
        </SectionRow>

        <SectionRow
          title="Groups configuration"
          description="Select which groups this AI Agent will belong to."
        >
          <MultiSelect
            label="Groups"
            placeholder="Select one or more groups"
            data={availableGroups}
            value={groups}
            onChange={setGroups}
            searchable
            clearable
          />
        </SectionRow>
      </Stack>
    </Stack>
  )
}
