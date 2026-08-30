import { useEffect, useState } from 'react'
import { useNavigate } from 'react-router-dom'
import { Box, Group, Stack, Text, Title } from '@mantine/core'
import Button from '@/components/Button'
import { useMinDelay } from '@/hooks/useMinDelay'
import PageLoader from '@/components/PageLoader'
import ProfileSelector from '@/features/ProtectionProfiles/ProfileSelector'
import { toApiProfile } from '@/features/ProtectionProfiles/constants'
import { protectionProfilesService } from '@/services/protectionProfiles'
import { useBridgeStore } from '@/stores/useBridgeStore'
import { useUserStore } from '@/stores/useUserStore'
import { showSnackbar } from '@/utils/snackbar'
import LyricLogo from '@/components/LyricLogo'
import { PRODUCT_NAME } from '@/utils/branding'

/**
 * Onboarding step shown to admins before the resource setup: pick a
 * protection profile so every connection created afterwards is already
 * guarded. Chrome-less (no sidebar), mirroring the legacy :auth layout.
 */
function OnboardingProtectionRules() {
  const navigate = useNavigate()
  const { user, setUser } = useUserStore()
  const [selected, setSelected] = useState(null)
  const [loading, setLoading] = useState(true)
  const [applying, setApplying] = useState(false)

  const showLoader = useMinDelay(loading)

  useEffect(() => {
    protectionProfilesService
      .get()
      // Preselect only when a profile was already applied — a fresh org
      // starts with nothing selected and the action button disabled.
      .then(({ profile }) => setSelected(profile ?? null))
      .catch(() => {})
      .finally(() => setLoading(false))
  }, [])

  async function handleApply() {
    setApplying(true)
    try {
      const { profile } = await protectionProfilesService.update({
        profile: toApiProfile(selected),
        source: 'onboarding',
      })
      // Keep the in-memory user in sync so the ProtectedRoute onboarding
      // gate sends the user to the setup step from now on.
      if (user) setUser({ ...user, default_protection_profile: profile })
      // The CLJS app caches the user in its own app-db; refresh it so its
      // :onboarding/check-user doesn't bounce back here on a stale profile.
      useBridgeStore.getState().refreshLegacyUser()
      navigate('/onboarding/setup')
    } catch (err) {
      showSnackbar({
        level: 'error',
        text: 'Failed to apply protection rules',
        description: err.response?.data?.message,
      })
      setApplying(false)
    }
  }

  if (showLoader) return <PageLoader overlay />

  return (
    <Box mih="100vh" bg="white">
      {/* Full width with the same 32px padding as the CLJS onboarding
          screens that follow — no centered max-width, so the pages read
          as one continuous flow. */}
      <Box p="xl">
        <Stack gap="xl">
          <Group justify="space-between" align="center">
            <LyricLogo markOnly height={40} />
            <Button loading={applying} disabled={!selected} onClick={handleApply}>
              Apply and continue
            </Button>
          </Group>

          <Stack gap="xs">
            <Title order={1}>Protect your resources</Title>
            <Text size="lg" c="dimmed">
              Pick how {PRODUCT_NAME} should guard everything you connect.
            </Text>
            <Text size="lg" c="dimmed">
              We set it all up. You can change any configuration later on.
            </Text>
          </Stack>

          <ProfileSelector value={selected} onChange={setSelected} />
        </Stack>
      </Box>
    </Box>
  )
}

export default OnboardingProtectionRules
