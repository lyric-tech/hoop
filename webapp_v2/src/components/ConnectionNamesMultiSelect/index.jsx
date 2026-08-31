import { useMemo } from 'react'
import { usePaginatedConnections } from '@/hooks/usePaginatedConnections'
import { qualifyConnection, qualifyName } from '@/utils/cluster'
import PaginatedMultiSelect from '@/components/PaginatedMultiSelect'

/**
 * Resource-role (connection) multi-select keyed by **name**, for APIs whose
 * payload carries `connection_names`. The id-keyed twin is
 * `@/components/ConnectionsMultiSelect`.
 *
 * The value is the bare name (the stored identifier); only the label carries
 * the qualified "<cluster>/<resource>" form. A selection outside the loaded
 * pages has no known cluster, so its chip falls back to the bare name.
 *
 * Usage:
 *   <ConnectionNamesMultiSelect value={form.connectionNames} onChange={setNames} />
 */
export default function ConnectionNamesMultiSelect({
  value = [],
  onChange,
  label = 'Resource Roles',
  placeholder = 'Select resource roles...',
  required = false,
  disabled = false,
}) {
  const { items, loading, hasMore, searchValue, setSearch, loadMore, ensureLoaded } =
    usePaginatedConnections({ pageSize: 50 })

  const options = useMemo(
    () =>
      items.map((c) => ({
        value: c.name,
        label: qualifyConnection(c),
        name: c.name,
        cluster: c.cluster ?? '',
      })),
    [items],
  )

  const clusterByName = useMemo(
    () => new Map(items.map((c) => [c.name, c.cluster ?? ''])),
    [items],
  )

  const selectedOptions = useMemo(
    () =>
      value.map((name) => ({
        value: name,
        label: qualifyName(clusterByName.get(name), name),
        name,
        cluster: clusterByName.get(name) ?? '',
      })),
    [value, clusterByName],
  )

  return (
    <PaginatedMultiSelect
      label={label}
      placeholder={placeholder}
      required={required}
      disabled={disabled}
      value={value}
      onChange={onChange}
      options={options}
      selectedOptions={selectedOptions}
      loading={loading}
      hasMore={hasMore}
      onLoadMore={loadMore}
      searchValue={searchValue}
      onSearchChange={setSearch}
      onDropdownOpen={ensureLoaded}
    />
  )
}
