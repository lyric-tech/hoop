import { useEffect, useMemo, useState } from 'react'
import { Box, Group, Pill, Stack, Text, Title } from '@mantine/core'
import { Check, Clock, X } from 'lucide-react'
import Badge from '@/components/Badge'
import Button from '@/components/Button'
import PageLoader from '@/components/PageLoader'
import Table from '@/components/Table'
import useCountdown from '@/hooks/useCountdown'
import EmptyState from '@/layout/EmptyState'
import { useUserStore } from '@/stores/useUserStore'
import { showSnackbar } from '@/utils/snackbar'
import { useAccessRequestsStore } from './store'
import { awaitingMyApproval, formatDuration, pendingRequestFor } from './helpers'
import RequestAccessModal from './sections/RequestAccessModal'

function GrantCountdown({ expiresAt }) {
  const { label, expired } = useCountdown(expiresAt)
  if (expired || !label) return <Text size="sm">Expired</Text>
  return (
    <Group gap={6}>
      <Clock size={14} />
      <Text size="sm">{`Active for ${label}`}</Text>
    </Group>
  )
}

function RuleRow({ rule, pendingRequest, onRequest }) {
  return (
    <Table.Tr>
      <Table.Td>
        <Stack gap={2}>
          <Text fw={500}>{rule.name}</Text>
          {rule.description ? (
            <Text size="xs" c="dimmed">
              {rule.description}
            </Text>
          ) : null}
        </Stack>
      </Table.Td>
      <Table.Td>
        <Group gap="xs">
          {rule.resources.map((resource) => (
            <Pill key={resource}>{resource}</Pill>
          ))}
        </Group>
      </Table.Td>
      <Table.Td>
        {rule.active_grant ? (
          <GrantCountdown expiresAt={rule.active_grant.expires_at} />
        ) : pendingRequest ? (
          <Badge color="yellow">Waiting approval</Badge>
        ) : (
          <Text size="sm" c="dimmed">
            No access
          </Text>
        )}
      </Table.Td>
      <Table.Td>
        <Button
          size="xs"
          variant="default"
          disabled={Boolean(rule.active_grant || pendingRequest)}
          onClick={() => onRequest(rule)}
        >
          Request access
        </Button>
      </Table.Td>
    </Table.Tr>
  )
}

export default function AccessRequests() {
  const rules = useAccessRequestsStore((s) => s.rules)
  const rulesStatus = useAccessRequestsStore((s) => s.rulesStatus)
  const reviews = useAccessRequestsStore((s) => s.reviews)
  const submitting = useAccessRequestsStore((s) => s.submitting)
  const refresh = useAccessRequestsStore((s) => s.refresh)
  const requestAccess = useAccessRequestsStore((s) => s.requestAccess)
  const reviewRequest = useAccessRequestsStore((s) => s.reviewRequest)

  const user = useUserStore((s) => s.user)
  const [selectedRule, setSelectedRule] = useState(null)

  useEffect(() => {
    refresh()
  }, [refresh])

  const toApprove = useMemo(
    () => awaitingMyApproval(reviews, user?.groups, user?.email),
    [reviews, user],
  )

  async function handleSubmit(payload) {
    const { ok, error } = await requestAccess(payload)
    if (!ok) {
      showSnackbar({
        level: 'error',
        text: 'Failed to request access.',
        description: error?.response?.data?.message,
      })
      return
    }
    setSelectedRule(null)
    showSnackbar({ level: 'success', text: 'Access requested. Approvers have been notified.' })
  }

  async function handleReview(review, status) {
    const { ok, error } = await reviewRequest(review.id, status)
    if (!ok) {
      showSnackbar({
        level: 'error',
        text: `Failed to ${status.toLowerCase()} the request.`,
        description: error?.response?.data?.message,
      })
      return
    }
    showSnackbar({ level: 'success', text: `Request ${status.toLowerCase()}.` })
  }

  if (rulesStatus === 'loading' && rules.length === 0) return <PageLoader />

  return (
    <Box p="lg">
      <Stack gap="xl">
        <Stack gap={4}>
          <Title order={2}>Access Requests</Title>
          <Text c="dimmed">
            Ask for a time window over a group of resources. One approval covers every resource in
            the group until the window closes, so you do not need to run a command first.
          </Text>
        </Stack>

        {rules.length === 0 ? (
          <EmptyState
            compact
            title="Nothing to request"
            description="No access request rule grants a time window to your groups. Ask an administrator to set one up."
          />
        ) : (
          <Table>
            <Table.Thead>
              <Table.Tr>
                <Table.Th>Group</Table.Th>
                <Table.Th>Resources</Table.Th>
                <Table.Th>Your access</Table.Th>
                <Table.Th />
              </Table.Tr>
            </Table.Thead>
            <Table.Tbody>
              {rules.map((rule) => (
                <RuleRow
                  key={rule.name}
                  rule={rule}
                  pendingRequest={pendingRequestFor(reviews, rule.name, user?.email)}
                  onRequest={setSelectedRule}
                />
              ))}
            </Table.Tbody>
          </Table>
        )}

        {toApprove.length > 0 ? (
          <Stack gap="sm">
            <Title order={4}>Waiting for your approval</Title>
            <Table>
              <Table.Thead>
                <Table.Tr>
                  <Table.Th>Requester</Table.Th>
                  <Table.Th>Group</Table.Th>
                  <Table.Th>Window</Table.Th>
                  <Table.Th />
                </Table.Tr>
              </Table.Thead>
              <Table.Tbody>
                {toApprove.map((review) => (
                  <Table.Tr key={review.id}>
                    <Table.Td>
                      {review.review_owner?.name || review.review_owner?.email}
                    </Table.Td>
                    <Table.Td>{review.access_request_rule_name}</Table.Td>
                    <Table.Td>
                      {formatDuration(Math.round(review.access_duration / 1e9))}
                    </Table.Td>
                    <Table.Td>
                      <Group gap="xs" justify="flex-end">
                        <Button
                          size="xs"
                          variant="default"
                          leftSection={<X size={14} />}
                          loading={submitting}
                          onClick={() => handleReview(review, 'REJECTED')}
                        >
                          Reject
                        </Button>
                        <Button
                          size="xs"
                          leftSection={<Check size={14} />}
                          loading={submitting}
                          onClick={() => handleReview(review, 'APPROVED')}
                        >
                          Approve
                        </Button>
                      </Group>
                    </Table.Td>
                  </Table.Tr>
                ))}
              </Table.Tbody>
            </Table>
          </Stack>
        ) : null}
      </Stack>

      <RequestAccessModal
        rule={selectedRule}
        opened={Boolean(selectedRule)}
        submitting={submitting}
        onClose={() => setSelectedRule(null)}
        onSubmit={handleSubmit}
      />
    </Box>
  )
}
