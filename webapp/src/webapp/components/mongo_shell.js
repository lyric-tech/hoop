// Tolerant parser for legacy `mongo --quiet` shell output.
//
// The shell prints documents as pseudo-JSON that is NOT valid JSON:
//   { "_id" : ObjectId("6854..."), "createdAt" : ISODate("2025-06-19T...") }
// one document per line, or multi-line under .pretty(). Values may include the
// shell-only wrappers ObjectId(...), ISODate(...), NumberLong(...),
// NumberInt(...), NumberDecimal("..."), Timestamp(t, i), plus nested
// objects/arrays and normal JSON scalars.
//
// We parse with a string-aware recursive-descent scanner. A regex approach
// silently corrupts string values that contain `ObjectId(` or braces and can't
// segment multi-line documents; the scanner owns quote/escape state so those
// cases are safe. Recognized wrappers become tagged nodes (see MONGO_TYPE) so
// the renderer can show ObjectId('...') / a formatted date; anything unknown is
// captured verbatim as a generic call node — never fatal.

const MONGO_TYPE = '__mongoType'

const makeNode = (type, extra) => ({ [MONGO_TYPE]: type, ...extra })

const isWs = (c) => c === ' ' || c === '\t' || c === '\n' || c === '\r'
const isDigit = (c) => c >= '0' && c <= '9'
const isIdentStart = (c) => /[A-Za-z_$]/.test(c)
const isIdentChar = (c) => /[A-Za-z0-9_$.]/.test(c)

class Scanner {
  constructor(s) {
    this.s = s
    this.i = 0
    this.n = s.length
  }

  eof() { return this.i >= this.n }
  cur() { return this.s[this.i] }

  skipWs() {
    while (this.i < this.n && isWs(this.s[this.i])) this.i += 1
  }

  parseValue() {
    this.skipWs()
    if (this.eof()) throw new Error('unexpected end of input')
    const c = this.s[this.i]
    if (c === '{') return this.parseObject()
    if (c === '[') return this.parseArray()
    if (c === '"' || c === "'") return this.parseString()
    if (c === '/') return this.parseRegex()
    if (isIdentStart(c)) return this.parseIdentOrCall()
    if (isDigit(c) || c === '-' || c === '+' || c === '.') return this.parseNumber()
    throw new Error(`unexpected character '${c}' at ${this.i}`)
  }

  parseObject() {
    const obj = {}
    this.i += 1 // consume {
    this.skipWs()
    if (this.s[this.i] === '}') { this.i += 1; return obj }
    for (;;) {
      this.skipWs()
      const key = (this.s[this.i] === '"' || this.s[this.i] === "'")
        ? this.parseString()
        : this.parseBareKey()
      this.skipWs()
      if (this.s[this.i] !== ':') throw new Error(`expected ':' at ${this.i}`)
      this.i += 1
      obj[key] = this.parseValue()
      this.skipWs()
      const ch = this.s[this.i]
      if (ch === ',') { this.i += 1; continue }
      if (ch === '}') { this.i += 1; break }
      throw new Error(`expected ',' or '}' at ${this.i}`)
    }
    return obj
  }

  parseArray() {
    const arr = []
    this.i += 1 // consume [
    this.skipWs()
    if (this.s[this.i] === ']') { this.i += 1; return arr }
    for (;;) {
      arr.push(this.parseValue())
      this.skipWs()
      const ch = this.s[this.i]
      if (ch === ',') { this.i += 1; this.skipWs(); if (this.s[this.i] === ']') { this.i += 1; break } continue }
      if (ch === ']') { this.i += 1; break }
      throw new Error(`expected ',' or ']' at ${this.i}`)
    }
    return arr
  }

  parseString() {
    const quote = this.s[this.i]
    this.i += 1 // opening quote
    let out = ''
    while (this.i < this.n) {
      const c = this.s[this.i]
      if (c === '\\') {
        const next = this.s[this.i + 1]
        switch (next) {
          case 'n': out += '\n'; break
          case 't': out += '\t'; break
          case 'r': out += '\r'; break
          case 'b': out += '\b'; break
          case 'f': out += '\f'; break
          case 'u': {
            const hex = this.s.slice(this.i + 2, this.i + 6)
            out += String.fromCharCode(parseInt(hex, 16))
            this.i += 6
            continue
          }
          default: out += next
        }
        this.i += 2
        continue
      }
      if (c === quote) { this.i += 1; return out }
      out += c
      this.i += 1
    }
    throw new Error('unterminated string')
  }

  parseBareKey() {
    const start = this.i
    while (this.i < this.n && isIdentChar(this.s[this.i])) this.i += 1
    if (this.i === start) throw new Error(`expected key at ${this.i}`)
    return this.s.slice(start, this.i)
  }

  parseNumber() {
    const start = this.i
    if (this.s[this.i] === '+' || this.s[this.i] === '-') this.i += 1
    while (this.i < this.n && /[0-9.eE+-]/.test(this.s[this.i])) this.i += 1
    const raw = this.s.slice(start, this.i)
    const num = Number(raw)
    return Number.isNaN(num) ? raw : num
  }

  parseRegex() {
    const start = this.i
    this.i += 1 // opening /
    while (this.i < this.n && this.s[this.i] !== '/') {
      if (this.s[this.i] === '\\') this.i += 1
      this.i += 1
    }
    this.i += 1 // closing /
    while (this.i < this.n && /[a-z]/.test(this.s[this.i])) this.i += 1 // flags
    return makeNode('Regex', { value: this.s.slice(start, this.i) })
  }

  parseIdentOrCall() {
    const start = this.i
    while (this.i < this.n && isIdentChar(this.s[this.i])) this.i += 1
    const name = this.s.slice(start, this.i)
    let save = this.i
    // whitespace between the identifier and its ( is legal
    while (save < this.n && isWs(this.s[save])) save += 1
    if (this.s[save] === '(') {
      this.i = save
      return this.parseCall(name, start)
    }
    switch (name) {
      case 'true': return true
      case 'false': return false
      case 'null': return null
      case 'undefined': return null
      case 'NaN': return NaN
      case 'Infinity': return Infinity
      case 'MinKey': return makeNode('MinKey', {})
      case 'MaxKey': return makeNode('MaxKey', {})
      default: return makeNode('Ident', { name })
    }
  }

  parseCall(name, start) {
    this.i += 1 // consume (
    const args = []
    this.skipWs()
    if (this.s[this.i] !== ')') {
      for (;;) {
        args.push(this.parseValue())
        this.skipWs()
        const ch = this.s[this.i]
        if (ch === ',') { this.i += 1; continue }
        if (ch === ')') break
        throw new Error(`expected ',' or ')' at ${this.i}`)
      }
    }
    this.i += 1 // consume )
    const raw = this.s.slice(start, this.i)
    switch (name) {
      case 'ObjectId': return makeNode('ObjectId', { value: args[0] ?? '' })
      case 'ISODate':
      case 'Date':
        return makeNode('ISODate', { value: args[0] ?? null })
      case 'NumberLong': return makeNode('NumberLong', { value: String(args[0] ?? '') })
      case 'NumberInt': return makeNode('NumberInt', { value: String(args[0] ?? '') })
      case 'NumberDecimal': return makeNode('NumberDecimal', { value: String(args[0] ?? '') })
      case 'Timestamp': return makeNode('Timestamp', { t: args[0], i: args[1] })
      default: return makeNode('Call', { name, args, raw })
    }
  }
}

// Removes the leading "switched to db <name>" line the shell emits for a
// `use <db>` and any blank lead-in.
function stripPreamble(raw) {
  if (!raw) return ''
  let out = raw
  out = out.replace(/^\s*switched to db .*\r?\n/, '')
  return out.replace(/^\s+/, '')
}

// Cheap check used to decide whether to attempt a parse / offer the tree.
function looksLikeMongo(raw) {
  if (!raw) return false
  const body = stripPreamble(raw)
  return /^[[{]/.test(body) || body.includes('ObjectId(') || body.includes('ISODate(')
}

/**
 * Parse mongo shell output into renderable documents. Never throws.
 * Returns null when nothing usable parsed (caller falls back to raw text),
 * else { documents: [{ ok:true, value } | { ok:false, raw }], docCount, okCount }.
 */
function parseOutput(raw) {
  const body = stripPreamble(raw)
  if (!body) return null
  const scanner = new Scanner(body)
  const documents = []
  let okCount = 0
  let guard = 0
  while (true) {
    scanner.skipWs()
    if (scanner.eof()) break
    if (guard++ > 100000) break // safety against a pathological non-advancing loop
    const startedAt = scanner.i
    try {
      const value = scanner.parseValue()
      documents.push({ ok: true, value })
      okCount += 1
    } catch {
      // Recovery: capture the rest of the current line as a raw doc and skip it.
      const nl = body.indexOf('\n', startedAt)
      const end = nl === -1 ? body.length : nl
      const rawLine = body.slice(startedAt, end).trim()
      if (rawLine) documents.push({ ok: false, raw: rawLine })
      scanner.i = end + 1
    }
  }
  if (documents.length === 0 || okCount === 0) return null
  // Only treat this as mongo documents if at least one parsed value is a real
  // object/array. This rejects plain text and error messages, whose words would
  // otherwise parse as a run of bare-identifier nodes.
  const isDocLike = (v) => Array.isArray(v) || (v && typeof v === 'object' && !(MONGO_TYPE in v))
  if (!documents.some((d) => d.ok && isDocLike(d.value))) return null
  return { documents, docCount: documents.length, okCount }
}

module.exports = { MONGO_TYPE, stripPreamble, looksLikeMongo, parseOutput }
