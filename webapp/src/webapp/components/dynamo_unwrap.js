// DynamoDB (and the AWS CLI) return items in the "attribute value" wire format,
// where every scalar is wrapped by its type:
//   { "id": { "S": "abc" }, "count": { "N": "3" }, "tags": { "SS": ["a","b"] } }
// Rendering that verbatim shows noisy wrapper keys. unwrapDynamo() converts an
// already-JSON.parse'd value into plain JS (matching how the DynamoDB console
// displays items), so the shared DocumentTree can render it cleanly.
//
// Numbers stay strings to avoid precision loss (DynamoDB N is arbitrary
// precision); Binary/Set types are represented faithfully.

const ATTR_KEYS = new Set(['S', 'N', 'B', 'SS', 'NS', 'BS', 'M', 'L', 'NULL', 'BOOL'])

function isAttributeValue(obj) {
  if (!obj || typeof obj !== 'object' || Array.isArray(obj)) return false
  const keys = Object.keys(obj)
  return keys.length === 1 && ATTR_KEYS.has(keys[0])
}

function unwrapAttribute(attr) {
  const [type] = Object.keys(attr)
  const value = attr[type]
  switch (type) {
    case 'S': return value
    case 'N': return value // keep as string — arbitrary precision
    case 'B': return value
    case 'BOOL': return value
    case 'NULL': return null
    case 'SS': return value
    case 'NS': return value
    case 'BS': return value
    case 'L': return value.map(unwrapDynamo)
    case 'M': return unwrapMap(value)
    default: return attr
  }
}

function unwrapMap(map) {
  const out = {}
  for (const k of Object.keys(map)) out[k] = unwrapDynamo(map[k])
  return out
}

function unwrapDynamo(value) {
  if (Array.isArray(value)) return value.map(unwrapDynamo)
  if (isAttributeValue(value)) return unwrapAttribute(value)
  if (value && typeof value === 'object') return unwrapMap(value)
  return value
}

// Unwrap the common DynamoDB response envelopes (scan/query → { Items: [...] },
// get-item → { Item: {...} }) into a list of plain documents. Returns null when
// the shape isn't a recognizable DynamoDB response so callers can fall back.
function unwrapDynamoResponse(parsed) {
  if (!parsed || typeof parsed !== 'object') return null
  if (Array.isArray(parsed.Items)) return parsed.Items.map(unwrapDynamo)
  if (parsed.Item && typeof parsed.Item === 'object') return [unwrapDynamo(parsed.Item)]
  return null
}

module.exports = { unwrapDynamo, unwrapDynamoResponse }
