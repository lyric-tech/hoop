// Parses the marker-delimited output produced by buildViewScript. The nonce
// makes marker collisions with real kubectl output (event messages, config
// names) practically impossible: only lines carrying THIS request's nonce are
// treated as structure, everything else is payload.
// .js extension kept so tests can run this module directly under `node --test`
import { MARKER_PREFIX, SECTIONS } from './script.js'

/**
 * @returns {{ valid: boolean, sections: Object<string, Section> }}
 * Section = { rc, stdout, stderr, rows|null, parseWarnings }
 * `valid` is false when zero markers matched — the output was not produced by
 * our script (review URL, guardrail message, shell error) and the caller must
 * treat the whole response as an error, not an empty dashboard.
 */
export function parseScriptOutput(raw, nonce) {
  const prefix = `${MARKER_PREFIX}:${nonce}:`
  const sections = {}
  let current = null // { id, target: 'stdout'|'stderr', out: [], err: [], rc }
  let sawMarker = false

  for (const line of String(raw ?? '').split('\n')) {
    if (line.startsWith(prefix)) {
      sawMarker = true
      const body = line.slice(prefix.length)

      if (body.startsWith('BEGIN:')) {
        current = {
          id: body.slice('BEGIN:'.length).replace(/##$/, ''),
          target: 'stdout',
          out: [],
          err: [],
          rc: null,
        }
      } else if (body.startsWith('RC:') && current) {
        const m = body.match(/^RC:([^:]+):(-?\d+)##$/)
        if (m && m[1] === current.id) current.rc = Number(m[2])
      } else if (body.startsWith('ERR:') && current) {
        current.target = 'stderr'
      } else if (body.startsWith('END:') && current) {
        sections[current.id] = finalizeSection(current)
        current = null
      }
      continue
    }
    if (!current) continue // pre-BEGIN noise (shell banners) is ignored
    ;(current.target === 'stdout' ? current.out : current.err).push(line)
  }

  // BEGIN without END — the stream was cut (truncated response). Keep what we
  // have but mark it so the view can show a partial-data warning.
  if (current) {
    const section = finalizeSection(current)
    section.corrupt = true
    sections[current.id] = section
  }

  return { valid: sawMarker, sections }
}

function finalizeSection({ id, out, err, rc }) {
  const stdout = out.join('\n')
  const stderr = err.join('\n').trim()
  const section = {
    rc: rc ?? 125,
    stdout,
    stderr,
    rows: null,
    parseWarnings: 0,
  }

  const spec = SECTIONS[id]
  if (spec && section.rc === 0) {
    const parsed =
      spec.parse === 'tsv'
        ? parseTsv(stdout, spec.cols, spec.tail === true)
        : spec.parse === 'table'
          ? parseTable(stdout, spec.cols)
          : null
    if (parsed) {
      section.rows = parsed.rows
      section.parseWarnings = parsed.warnings
    }
  }
  return section
}

// Tab-separated rows. With `tail`, the last declared column absorbs any extra
// tabs (free text); rows with fewer than cols-1 tabs are continuation lines of
// a multi-line message — dropped and counted.
function parseTsv(stdout, cols, tail) {
  const rows = []
  let warnings = 0

  for (const line of stdout.split('\n')) {
    if (line === '') continue
    const parts = line.split('\t')
    if (parts.length < cols.length) {
      warnings++
      continue
    }
    if (parts.length > cols.length && !tail) {
      warnings++
      continue
    }
    const row = {}
    cols.forEach((col, i) => {
      row[col] =
        tail && i === cols.length - 1 ? parts.slice(i).join('\t') : parts[i]
    })
    rows.push(row)
  }
  return { rows, warnings }
}

// Server-side table print (`--no-headers`): columns are whitespace-free by
// construction (names, types, counts, ages), so runs of whitespace are safe
// delimiters. Extra columns (kubectl version drift) fold into the last one.
function parseTable(stdout, cols) {
  const rows = []
  let warnings = 0

  for (const line of stdout.split('\n')) {
    if (line.trim() === '') continue
    const parts = line.trim().split(/\s+/)
    if (parts.length < cols.length) {
      warnings++
      continue
    }
    const row = {}
    cols.forEach((col, i) => {
      row[col] =
        i === cols.length - 1 ? parts.slice(i).join(' ') : parts[i]
    })
    rows.push(row)
  }
  return { rows, warnings }
}

// ---- shared value helpers (used by the views) ----

// "250m" → 0.25 cores, "4" → 4 cores
export function parseCpu(value) {
  if (!value) return null
  if (value.endsWith('m')) return Number(value.slice(0, -1)) / 1000
  if (value.endsWith('n')) return Number(value.slice(0, -1)) / 1e9
  const n = Number(value)
  return Number.isFinite(n) ? n : null
}

// "16Gi" / "16384Mi" / "123456Ki" / plain bytes → MiB
const MEM_UNITS = { Ki: 1 / 1024, Mi: 1, Gi: 1024, Ti: 1024 * 1024 }
export function parseMemMi(value) {
  if (!value) return null
  const m = String(value).match(/^(\d+(?:\.\d+)?)(Ki|Mi|Gi|Ti)?$/)
  if (!m) return null
  const n = Number(m[1])
  return m[2] ? n * MEM_UNITS[m[2]] : n / (1024 * 1024)
}

// containers column: "true:0 false:3" → { ready, total, restarts }
export function parseContainers(value) {
  const pairs = String(value ?? '')
    .trim()
    .split(/\s+/)
    .filter(Boolean)
  let ready = 0
  let restarts = 0
  for (const pair of pairs) {
    const [flag, count] = pair.split(':')
    if (flag === 'true') ready++
    restarts += Number(count) || 0
  }
  return { ready, total: pairs.length, restarts }
}

// Pod status bucket shared by the summary chips and the table pills. Mirrors
// the CLJS kubectl_table.cljs buckets, plus Terminating via deletionTimestamp.
export function podStatusBucket(row) {
  if (row.deleting) return 'pending'
  switch (row.phase) {
    case 'Running':
      return 'running'
    case 'Succeeded':
      return 'completed'
    case 'Pending':
      return 'pending'
    default:
      return 'failed'
  }
}

// CRD sections: distinguish "not installed" from a real failure so the
// Networking view can hide the panel instead of erroring.
export function isCrdMissing(section) {
  return (
    section.rc !== 0 &&
    /doesn't have a resource type|the server could not find the requested resource/i.test(
      section.stderr,
    )
  )
}
