import { TextInput } from '@mantine/core'
import { Search } from 'lucide-react'

/**
 * TextInput preconfigured for filtering lists: search icon, clearable feel via
 * controlled value, no label. Same ad-hoc pattern FilterPopover and the header
 * search were building by hand, promoted to a wrapper.
 */
export default function SearchInput({ value, onChange, placeholder = 'Search…', ...props }) {
  return (
    <TextInput
      value={value}
      onChange={(e) => onChange(e.currentTarget.value)}
      placeholder={placeholder}
      leftSection={<Search size={14} aria-hidden />}
      size="xs"
      {...props}
    />
  )
}
