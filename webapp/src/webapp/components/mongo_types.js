// Typed reader for the MongoDB Compass surfaces.
//
// WHY THIS EXISTS
// ---------------
// The shell's default output is lossy: `mongo --quiet` prints pseudo-JSON
// (`ObjectId("..")`, `ISODate(..)`) that needs the character-at-a-time scanner
// in mongo_shell.js, and even then an int64 past 2^53 and a date are
// indistinguishable from a string once they land. That scanner stays for the
// Shell tab and for historical sessions; the Compass surfaces do not use it.
//
// Instead every generated script embeds TAGGER_JS, which walks the result and
// tags each BSON leaf before serializing. The output is therefore plain JSON:
// one `JSON.parse`, no scanning, and full type fidelity.
//
// SHELL AGNOSTIC ON PURPOSE
// -------------------------
// The tagger does NOT use `EJSON`, which only mongosh has, and does NOT depend
// on any single accessor. It identifies a BSON value two ways, because the two
// shells disagree:
//
//   * `_bsontype` -- the discriminator the `bson` package sets on every
//     instance. This is what identifies values in mongosh, where `NumberLong`
//     is a factory function and `v instanceof NumberLong` is false.
//   * `instanceof <global>` -- what the legacy 5.0 shell needs, where the
//     globals ARE the constructors and there is no `_bsontype`.
//     gateway/api/connections/queries_schema.go already relies on this, so it
//     is known to work there.
//
// The payload then travels as the shell's own string form, and this module
// extracts it by SHAPE (24 hex characters, a run of digits, ...) rather than
// trusting a format. An extraction that does not match its shape yields
// {kind: 'raw'}, which renders as text with a marker -- visibly degraded
// rather than silently wrong.
//
// The consequence worth knowing: this works today on the legacy train and
// keeps working after INCLUDE_LEGACY_MONGO flips to mongosh, with no
// migration, no feature flag and no agent coordination.
//
// STATUS: NOT WIRED UP YET.
// No generated script embeds TAGGER_JS, so nothing in the app produces an
// envelope and this reader's tagged path is currently unreachable -- the
// Documents view still goes through mongo_shell.js. Verified against a real
// mongo:5 container (both shells), where four shapes still differ from what
// the tagger assumes and must be fixed before anything emits an envelope:
//
//   legacy shell  MinKey()/MaxKey() have typeof 'function', so they are tagged
//                 'unsupported' instead of minKey/maxKey.
//   legacy shell  BinData stringifies as UUID("...") for subtype 4, so the
//                 BinData(sub, "b64") extraction misses. The display text
//                 happens to be right, but subtype/base64 come back empty.
//   mongosh       Timestamp stringifies as a single int64 ("7454730068007321607"),
//                 not Timestamp(t, i), so t/i are lost.
//   mongosh       a stored regex arrives as neither a JS RegExp nor a
//                 BSONRegExp, so it falls through to {} and the pattern is lost.
//
// The reader degrades visibly rather than lying in each case, which is why
// leaving this unwired is safe -- but do not treat it as verified.

export const TAG = '__ht' // hoop type
export const VAL = '__hv' // hoop value, as the shell's own string form

export const SENTINEL_OPEN = '@@hoop-mongo-1@@'
export const SENTINEL_CLOSE = '@@/hoop-mongo-1@@'

// A rich parse walks the whole payload and builds a component tree. Above this
// the raw Logs tab is the right tool. The page size control caps a Documents
// page at 100 documents, so this only guards a runaway script in the Shell tab.
export const MAX_PARSE_BYTES = 16 * 1024 * 1024

// TAGGER_JS is injected verbatim into every generated script. It defines
// __hoopTag(value) and __hoopEmit(envelope).
//
// Deliberately ES5: `var`, no arrow functions, no template literals, no
// `const`. The legacy 5.0 shell handles ES6, but staying ES5 removes one
// variable from a surface that already spans two runtimes.
export const TAGGER_JS = `
var __hoopHas = function (o, k) { return Object.prototype.hasOwnProperty.call(o, k); };
var __hoopStr = function (x) { try { return String(x); } catch (e) { return ''; } };

function __hoopTag(v) {
  if (v === null) return null;
  var t = typeof v;
  if (t === 'undefined') return { ${TAG}: 'undefined' };
  if (t === 'string' || t === 'boolean' || t === 'number') return v;
  if (t === 'function') return { ${TAG}: 'unsupported', ${VAL}: 'function' };
  if (Array.isArray(v)) {
    var a = [];
    for (var i = 0; i < v.length; i++) a.push(__hoopTag(v[i]));
    return a;
  }
  if (v instanceof Date) return { ${TAG}: 'date', ${VAL}: __hoopStr(v.getTime()) };
  if (v instanceof RegExp) return { ${TAG}: 'regex', ${VAL}: __hoopStr(v) };

  // mongosh: the bson package's own discriminator.
  var bt = v._bsontype;
  if (bt) {
    if (bt === 'ObjectID' || bt === 'ObjectId') return { ${TAG}: 'objectId', ${VAL}: __hoopStr(v) };
    if (bt === 'Long') return { ${TAG}: 'int64', ${VAL}: __hoopStr(v) };
    if (bt === 'Int32') return { ${TAG}: 'int32', ${VAL}: __hoopStr(v) };
    if (bt === 'Double') return { ${TAG}: 'double', ${VAL}: __hoopStr(v) };
    if (bt === 'Decimal128') return { ${TAG}: 'decimal128', ${VAL}: __hoopStr(v) };
    if (bt === 'Binary') return { ${TAG}: 'binary', ${VAL}: 'BinData(' + (v.sub_type || 0) + ', "' + __hoopStr(v.toString('base64')) + '")' };
    if (bt === 'Timestamp') return { ${TAG}: 'timestamp', ${VAL}: __hoopStr(v) };
    if (bt === 'MinKey') return { ${TAG}: 'minKey' };
    if (bt === 'MaxKey') return { ${TAG}: 'maxKey' };
    if (bt === 'Code') return { ${TAG}: 'code', ${VAL}: __hoopStr(v.code) };
    if (bt === 'BSONSymbol' || bt === 'Symbol') return { ${TAG}: 'symbol', ${VAL}: __hoopStr(v) };
    if (bt === 'BSONRegExp') return { ${TAG}: 'regex', ${VAL}: '/' + v.pattern + '/' + (v.options || '') };
    if (bt === 'DBRef') return { ${TAG}: 'dbRef', ${VAL}: __hoopStr(v.collection) + '/' + __hoopStr(v.oid) };
  }

  // Legacy 5.0 shell: the globals are the constructors. Each is typeof-guarded
  // because \`x instanceof Undefined\` throws when the global is absent, and
  // the two shells do not define the same set.
  if (typeof ObjectId !== 'undefined' && v instanceof ObjectId) return { ${TAG}: 'objectId', ${VAL}: __hoopStr(v) };
  if (typeof NumberLong !== 'undefined' && v instanceof NumberLong) return { ${TAG}: 'int64', ${VAL}: __hoopStr(v) };
  if (typeof NumberInt !== 'undefined' && v instanceof NumberInt) return { ${TAG}: 'int32', ${VAL}: __hoopStr(v) };
  if (typeof NumberDecimal !== 'undefined' && v instanceof NumberDecimal) return { ${TAG}: 'decimal128', ${VAL}: __hoopStr(v) };
  if (typeof BinData !== 'undefined' && v instanceof BinData) return { ${TAG}: 'binary', ${VAL}: __hoopStr(v) };
  if (typeof Timestamp !== 'undefined' && v instanceof Timestamp) return { ${TAG}: 'timestamp', ${VAL}: __hoopStr(v) };
  if (typeof MinKey !== 'undefined' && v instanceof MinKey) return { ${TAG}: 'minKey' };
  if (typeof MaxKey !== 'undefined' && v instanceof MaxKey) return { ${TAG}: 'maxKey' };
  if (typeof Code !== 'undefined' && v instanceof Code) return { ${TAG}: 'code', ${VAL}: __hoopStr(v.code || v) };
  if (typeof DBRef !== 'undefined' && v instanceof DBRef) return { ${TAG}: 'dbRef', ${VAL}: __hoopStr(v) };

  var o = {};
  for (var k in v) { if (__hoopHas(v, k)) o[k] = __hoopTag(v[k]); }
  return o;
}

// Emits one sentinel-delimited line. Sentinels rather than "the whole stdout
// is JSON" because both shells write connection and deprecation notices to the
// same stream, and because it keeps the raw Logs tab readable by a human.
function __hoopEmit(env) {
  env.v = 1;
  print('${SENTINEL_OPEN}' + JSON.stringify(env) + '${SENTINEL_CLOSE}');
}
`

// ---------------------------------------------------------------------------
// Reader
// ---------------------------------------------------------------------------

const HEX24 = /[0-9a-f]{24}/i
const INTEGER = /-?\d+/
const DECIMAL = /-?\d+(?:\.\d+)?(?:[eE][-+]?\d+)?/
const BINDATA = /BinData\(\s*(\d+)\s*,\s*"([^"]*)"\s*\)/
const TIMESTAMP = /Timestamp\(\s*(\d+)\s*,\s*(\d+)\s*\)/

// Extractors return null when the payload does not match the shape the type
// promises. A null becomes {kind:'raw'} at the call site, which renders the
// text with a marker instead of a wrong value.
//
// Built from an ARRAY of [key, fn] pairs, and this is load-bearing. Two earlier
// shapes were both broken by Closure's advanced pass and both passed every
// dev-mode test:
//
//   const EXTRACT = { objectId: fn }        -> EXTRACT[kind] missed, because
//                                             the literal's keys were renamed
//   new Map(Object.entries({ objectId: fn })) -> Object.entries enumerated the
//                                             RENAMED keys, so the Map was
//                                             built with them
//
// Here the keys are array elements -- ordinary string values with no property
// name in the source -- so there is nothing to rename. See "Stable keys across
// the JS -> ClojureScript boundary" below.
const EXTRACT = new Map([
  ['objectId', (s) => {
    // NOTE: the literal "ObjectId" contains b, c, d and e, which are hex
    // digits. Stripping non-hex characters would prepend "becd" to the id, so
    // this matches a 24-run instead.
    const m = HEX24.exec(s)
    return m ? m[0].toLowerCase() : null
  }],
  ['int64', (s) => (INTEGER.test(s) ? INTEGER.exec(s)[0] : null)],
  ['int32', (s) => (INTEGER.test(s) ? INTEGER.exec(s)[0] : null)],
  ['double', (s) => (DECIMAL.test(s) ? DECIMAL.exec(s)[0] : null)],
  ['decimal128', (s) => (DECIMAL.test(s) ? DECIMAL.exec(s)[0] : null)],
  ['date', (s) => (INTEGER.test(s) ? INTEGER.exec(s)[0] : null)],
  ['binary', (s) => {
    const m = BINDATA.exec(s)
    if (m) return ['subtype', Number(m[1]), 'base64', m[2]]
    // mongosh's Binary stringifies differently; keep the text rather than
    // guessing a format.
    return null
  }],
  ['timestamp', (s) => {
    const m = TIMESTAMP.exec(s)
    return m ? ['t', Number(m[1]), 'i', Number(m[2])] : null
  }],
])

const NO_PAYLOAD = new Set(['null', 'undefined', 'minKey', 'maxKey'])

// ---------------------------------------------------------------------------
// Stable keys across the JS -> ClojureScript boundary
// ---------------------------------------------------------------------------
//
// Every object this module hands to ClojureScript is built with BRACKET
// assignment and string literals, never an object literal with shorthand keys.
//
// This is not style. Closure's advanced pass renames properties on literals it
// believes it owns, and it did: a release build turned `bytes` into `ag` and
// `kind` into `k`. The CLJS side enumerates with js-keys and then reads keys BY
// NAME, so a renamed key silently becomes nil -- correct in every dev-mode
// test, broken only in the shipped bundle. Bracket assignment with a string
// literal is the documented way to opt a property out of renaming.
//
// If you add a field to either shape, add it here the same way.

function assign(o, pairs) {
  // pairs is a FLAT array: [key, value, key, value, ...]. The keys are array
  // ELEMENTS, i.e. ordinary string values, so there is no property name in the
  // source for Closure to rename. An {a: 1} literal here would be renamed and
  // a matching `'a' in extra` string check would then silently miss it -- which
  // is exactly what happened to `bytes` before this rewrite.
  for (let n = 0; n + 1 < pairs.length; n += 2) o[pairs[n]] = pairs[n + 1]
  return o
}

function leaf(kind, text, pairs) {
  const o = {}
  o['kind'] = kind
  o['text'] = text
  return pairs ? assign(o, pairs) : o
}

function failure(reason, pairs) {
  const o = {}
  o['ok'] = false
  o['reason'] = reason
  return pairs ? assign(o, pairs) : o
}

/**
 * classify(v) -> a kind string for any node in a tagged result.
 * O(1), called at render time on the node the renderer is already visiting, so
 * a collapsed subtree costs nothing. Never walks the tree.
 */
export function classify(v) {
  if (v === null) return 'null'
  const t = typeof v
  if (t === 'string') return 'string'
  if (t === 'boolean') return 'boolean'
  if (t === 'number') return 'number'
  if (t !== 'object') return 'object'
  if (Array.isArray(v)) return 'array'
  const tag = v[TAG]
  return typeof tag === 'string' ? tag : 'object'
}

/** True when the node is a tagged BSON leaf rather than a document or array. */
export function isTagged(v) {
  return v !== null && typeof v === 'object' && !Array.isArray(v) && typeof v[TAG] === 'string'
}

/**
 * value(v) -> {kind, text} for a tagged leaf, or {kind, text, ...extra}.
 * kind 'raw' means the shell's string form did not match the shape its type
 * promised: the text is shown as-is and marked, so a shell whose format we did
 * not anticipate degrades visibly instead of rendering a wrong value.
 */
export function value(v) {
  const kind = classify(v)
  if (NO_PAYLOAD.has(kind)) return leaf(kind, kind)
  const raw = v && v[VAL]
  if (typeof raw !== 'string') return leaf('raw', String(raw === undefined ? '' : raw))
  const extractor = EXTRACT.get(kind)
  if (!extractor) return leaf(kind, raw)
  const got = extractor(raw)
  if (got === null) return leaf('raw', raw, ['expected', kind])
  if (Array.isArray(got)) return leaf(kind, raw, got)
  return leaf(kind, got)
}

/**
 * dateMillis(v) -> a finite number, or null.
 * Returns null rather than a Date for an instant outside the JS range: the
 * renderer then omits the humanized form instead of printing "Invalid Date".
 * MongoDB can store instants JS cannot represent.
 */
export function dateMillis(v) {
  if (classify(v) !== 'date') return null
  const leafValue = value(v)
  if (leafValue['kind'] !== 'date') return null
  const n = Number(leafValue['text'])
  if (!Number.isFinite(n)) return null
  // Date's representable range is +/- 8.64e15 ms from the epoch.
  if (Math.abs(n) > 8.64e15) return null
  return n
}

/** uuidFromBinary(v) -> a hyphenated UUID for subtype 4, else null. */
export function uuidFromBinary(v) {
  const parsedLeaf = value(v)
  if (parsedLeaf['kind'] !== 'binary' || parsedLeaf['subtype'] !== 4 || !parsedLeaf['base64']) return null
  let bytes
  try {
    const bin = atob(parsedLeaf['base64'])
    bytes = Array.from(bin, (ch) => ch.charCodeAt(0).toString(16).padStart(2, '0'))
  } catch (e) {
    return null
  }
  if (bytes.length !== 16) return null
  const h = bytes.join('')
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-${h.slice(12, 16)}-${h.slice(16, 20)}-${h.slice(20)}`
}

/**
 * readEnvelope(raw) -> the parsed envelope, or a {ok:false, reason} object, or
 * null when there is no envelope at all (the caller then falls back to the
 * legacy mongo_shell.js reader for a Shell-tab run or a historical session).
 *
 * Never throws.
 */
export function readEnvelope(raw) {
  if (!raw || typeof raw !== 'string') return null
  const i = raw.indexOf(SENTINEL_OPEN)
  if (i === -1) return null
  const j = raw.indexOf(SENTINEL_CLOSE, i)
  // An opening sentinel with no closing one means the output was cut, not that
  // it was malformed. The two need different messages: one says "reduce the
  // limit", the other says "this looks like a bug".
  if (j === -1) return failure('truncated')
  const body = raw.slice(i + SENTINEL_OPEN.length, j)
  if (body.length > MAX_PARSE_BYTES) return failure('too-large', ['bytes', body.length])
  let parsed
  try {
    parsed = JSON.parse(body)
  } catch (e) {
    return failure('malformed')
  }
  if (parsed === null || typeof parsed !== 'object') return failure('malformed')
  // An unrecognized version must say so. Rendering an empty table for a
  // resource running a newer gateway is the failure mode this guard exists to
  // prevent.
  //
  // Bracket notation, not `parsed.v`: this object comes from JSON.parse, so its
  // keys exist only at runtime. Closure's advanced pass can rename a dotted
  // access on a type it believes it owns, which would leave the access looking
  // for a key the parsed object does not have -- correct in dev, broken in the
  // release build. Every read of externally-created keys in this file uses
  // brackets for that reason.
  const version = parsed['v']
  if (version !== 1) return failure('unsupported-version', ['version', version])
  const env = { ...parsed }
  env['ok'] = true
  return env
}

/**
 * fieldPaths(docs) -> sorted dotted paths present in the given documents.
 * Feeds autocomplete for a collection the schema tree has not loaded. Bounded
 * by depth so a pathological document cannot stall the editor.
 */
export function fieldPaths(docs, { maxDepth = 6 } = {}) {
  const seen = new Set()
  const walk = (node, prefix, depth) => {
    if (depth > maxDepth || node === null || typeof node !== 'object') return
    if (Array.isArray(node)) {
      for (const item of node) walk(item, prefix, depth)
      return
    }
    if (isTagged(node)) return
    for (const k of Object.keys(node)) {
      const path = prefix ? `${prefix}.${k}` : k
      seen.add(path)
      walk(node[k], path, depth + 1)
    }
  }
  for (const d of docs || []) walk(d, '', 0)
  return Array.from(seen).sort()
}
