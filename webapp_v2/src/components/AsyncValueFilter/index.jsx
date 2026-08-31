import { useRef, useState } from 'react'
import {
  Box,
  Flex,
  Group,
  Image,
  Loader,
  Popover,
  ScrollArea,
  Stack,
  Text,
} from '@mantine/core'
import { Check, ChevronLeft, ChevronRight, Search, X } from 'lucide-react'
import Button from '@/components/Button'
import TextInput from '@/components/TextInput'
import { groupByCluster, hasClusters } from '@/utils/cluster'
import classes from './AsyncValueFilter.module.css'

/**
 * Single-value filter dropdown over a paginated, server-searched option source —
 * the async counterpart of `ValueFilter`. `selected` is the chosen option
 * (`{ value, label }`) or null; `onSelect` receives the full option. An option
 * may carry an optional `iconUrl`, rendered before its label (connection-type
 * icons come from `usePaginatedConnections`).
 *
 * When the options carry a `cluster` (resource pickers do), the dropdown
 * becomes a two-step drill-down: the cluster is chosen first, then the resource
 * within it. Searching bypasses the drill-down and lists matches across every
 * cluster. Options without a cluster render as one flat list, unchanged.
 *
 * Usage:
 *   <AsyncValueFilter
 *     icon={Rotate3d} label="Resource Role"
 *     selected={selected} onSelect={setSelected} onClear={() => setSelected(null)}
 *     options={options} loading={loading} hasMore={hasMore} onLoadMore={loadMore}
 *     searchValue={search} onSearchChange={setSearch} onOpen={ensureLoaded}
 *   />
 */
export default function AsyncValueFilter({
  icon,
  label,
  placeholder,
  selected,
  onSelect,
  onClear,
  options = [],
  loading = false,
  hasMore = false,
  onLoadMore,
  searchValue = '',
  onSearchChange,
  onOpen,
}) {
  const Icon = icon
  const [open, setOpen] = useState(false)
  // Which cluster the drill-down is inside; null = showing the cluster list.
  const [openCluster, setOpenCluster] = useState(null)
  const viewportRef = useRef(null)

  // Only the resource pickers carry clusters. Searching flattens the list so a
  // match in another cluster is still reachable.
  // ponytail: clusters are derived from the pages loaded so far, so the cluster
  // list and its counts grow as the user scrolls. Fine at one page of 50; if
  // deployments outgrow that, have the gateway return the cluster list.
  const searching = searchValue.trim() !== ''
  const grouped = hasClusters(options) && !searching
  const clusterGroups = grouped ? groupByCluster(options) : []
  const activeGroup = clusterGroups.find((g) => g.cluster === openCluster) ?? null
  const visibleOptions = grouped ? (activeGroup?.options ?? []) : options

  const handleScrollPositionChange = () => {
    if (!hasMore || loading) return
    const el = viewportRef.current
    if (!el) return
    if (el.scrollHeight - el.scrollTop - el.clientHeight < 50) {
      onLoadMore?.()
    }
  }

  const hasSelected = selected != null

  const close = () => {
    setOpen(false)
    setOpenCluster(null)
    onSearchChange?.('')
  }

  const handleTrigger = () => {
    const next = !open
    setOpen(next)
    if (next) onOpen?.()
  }

  return (
    <Popover
      opened={open}
      onChange={setOpen}
      position="bottom-start"
      width={320}
      withinPortal
    >
      {/* The trigger reads one step below the app-wide button scale: a 14px
          dimmed label instead of 16px near-black, matching the legacy Radix
          filter chip (text size "2" on gray-11). Only the type is toned down —
          the chip keeps the md height so it lines up with the other controls
          in the filter bar. */}
      <Popover.Target>
        <Button
          variant={hasSelected ? 'light' : 'default'}
          color="gray"
          fz="sm"
          c="dimmed"
          onClick={handleTrigger}
          leftSection={<Icon size={16} />}
          rightSection={
            hasSelected ? (
              <X
                size={14}
                onClick={(event) => {
                  event.stopPropagation()
                  onClear()
                  close()
                }}
              />
            ) : null
          }
        >
          {hasSelected ? selected.label : label}
        </Button>
      </Popover.Target>
      <Popover.Dropdown p="xs">
        <Stack gap="xs">
          {hasSelected && (
            <Box
              px="sm"
              py="xs"
              className={classes.row}
              onClick={() => {
                onClear()
                close()
              }}
            >
              <Text size="sm" c="dimmed">
                Clear filter
              </Text>
            </Box>
          )}
          {grouped && activeGroup != null && (
            <Flex
              align="center"
              gap="xs"
              px="sm"
              py="xs"
              className={classes.row}
              onClick={() => setOpenCluster(null)}
            >
              <ChevronLeft size={14} />
              <Text size="sm" fw={600} lineClamp={1}>
                {activeGroup.cluster}
              </Text>
            </Flex>
          )}
          <TextInput
            placeholder={placeholder}
            value={searchValue}
            onChange={(event) => onSearchChange?.(event.currentTarget.value)}
            leftSection={<Search size={14} />}
          />
          <ScrollArea
            h={288}
            type="auto"
            viewportRef={viewportRef}
            onScrollPositionChange={handleScrollPositionChange}
          >
            {grouped && activeGroup == null ? (
              <Stack gap={0}>
                {clusterGroups.map((group) => (
                  <Flex
                    key={group.cluster}
                    align="center"
                    justify="space-between"
                    px="sm"
                    py="xs"
                    className={classes.row}
                    onClick={() => setOpenCluster(group.cluster)}
                  >
                    <Text size="sm" lineClamp={1}>
                      {group.cluster}
                    </Text>
                    <Group gap="xs" wrap="nowrap">
                      <Text size="xs" c="dimmed">
                        {String(group.options.length)}
                      </Text>
                      <ChevronRight size={14} />
                    </Group>
                  </Flex>
                ))}
              </Stack>
            ) : visibleOptions.length > 0 ? (
              <Stack gap={0}>
                {visibleOptions.map((option) => (
                  <Flex
                    key={option.value}
                    align="center"
                    justify="space-between"
                    px="sm"
                    py="xs"
                    className={classes.row}
                    onClick={() => {
                      onSelect(option)
                      close()
                    }}
                  >
                    <Group gap="xs" wrap="nowrap" miw={0}>
                      {option.iconUrl && (
                        <Image
                          src={option.iconUrl}
                          w={16}
                          h={16}
                          miw={16}
                          fit="contain"
                          alt=""
                        />
                      )}
                      <Text size="sm" lineClamp={1}>
                        {grouped ? option.name : option.label}
                      </Text>
                    </Group>
                    {option.value === selected?.value && <Check size={14} />}
                  </Flex>
                ))}
              </Stack>
            ) : (
              !loading && (
                <Box px="sm" py="md">
                  <Text size="xs" c="dimmed" fs="italic">
                    {searchValue
                      ? `No ${label.toLowerCase()} found`
                      : `No ${label.toLowerCase()} available`}
                  </Text>
                </Box>
              )
            )}
            {loading && (
              <Group justify="center" py="xs">
                <Loader size="xs" />
              </Group>
            )}
          </ScrollArea>
        </Stack>
      </Popover.Dropdown>
    </Popover>
  )
}
