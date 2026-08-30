import { Group, Stack, Text, UnstyledButton } from '@mantine/core'
import { ChevronDown, LogOut } from 'lucide-react'
import { useNavigate } from 'react-router-dom'
import ActionMenu from '@/components/ActionMenu'
import { useAuthStore } from '@/stores/useAuthStore'
import { useUserStore } from '@/stores/useUserStore'
import { getUserDisplayName } from '@/utils/user'
import { UserAvatar } from './UserAvatar'
import classes from './Header.module.css'

export function UserMenu() {
  const navigate = useNavigate()
  const { user, gatewayVersion } = useUserStore()
  const { logout } = useAuthStore()

  const handleLogout = () => {
    logout()
    navigate('/login')
  }

  const target = (
    <UnstyledButton className={classes.userButton} aria-label="Open user menu">
      <Group gap={4} wrap="nowrap">
        <UserAvatar user={user} />
        <ChevronDown size={16} aria-hidden="true" />
      </Group>
    </UnstyledButton>
  )

  return (
    <ActionMenu target={target} width={240}>
      {/* Name + email and the gateway version are additions on top of the
          Figma, which shows only the two actions. */}
      <ActionMenu.Label className={classes.menuLabel}>
        <Stack gap={2}>
          <Text fz="sm" fw={600} truncate>
            {getUserDisplayName(user)}
          </Text>
          {user?.email && (
            <Text fz="xs" c="dimmed" truncate>
              {user.email}
            </Text>
          )}
        </Stack>
      </ActionMenu.Label>

      <ActionMenu.Item
        danger
        className={classes.menuItem}
        leftSection={<LogOut size={16} aria-hidden="true" />}
        onClick={handleLogout}
      >
        Log out
      </ActionMenu.Item>

      {gatewayVersion && (
        <Text fz="xs" className={classes.menuFooter}>
          {`Gateway ${gatewayVersion}`}
        </Text>
      )}
    </ActionMenu>
  )
}
