import { useMemo, useState } from 'react'

const collator = new Intl.Collator(undefined, { numeric: true })

/**
 * Client-side sorting for section tables. `columns[key]` may provide a value
 * accessor; default is the row field itself. Numeric-aware string compare so
 * "9" sorts before "10" and "250m" before "1".
 */
export function useSortedRows(rows, { initial = null, accessors = {} } = {}) {
  const [sort, setSort] = useState(initial) // { key, dir: 1|-1 }

  const sorted = useMemo(() => {
    if (!rows || !sort) return rows ?? []
    const get = accessors[sort.key] ?? ((row) => row[sort.key])
    return [...rows].sort((a, b) => {
      const va = get(a)
      const vb = get(b)
      if (typeof va === 'number' && typeof vb === 'number')
        return (va - vb) * sort.dir
      return collator.compare(String(va ?? ''), String(vb ?? '')) * sort.dir
    })
  }, [rows, sort, accessors])

  const toggleSort = (key) =>
    setSort((prev) =>
      prev?.key === key ? { key, dir: -prev.dir } : { key, dir: 1 },
    )

  return { sorted, sort, toggleSort }
}
