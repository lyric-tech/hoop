// Runs TAGGER_JS -- the JavaScript the generated scripts carry into the mongo
// shell -- against stand-ins for BOTH shells, then reads the result back.
//
// This lives outside the karma suite because it evaluates TAGGER_JS in a scope
// where the BSON globals are the constructors, which is what the legacy 5.0
// shell looks like and what karma cannot provide. The karma suite covers the
// READER half; this covers the tagger half plus the round trip.
//
//   node webapp/test/js/verify_tagger.mjs
//
// Exits non-zero on any mismatch.
import * as MT from '../../src/webapp/components/mongo_types.js'

// ---- legacy 5.0 shell stand-ins: the globals ARE the constructors, no _bsontype
function ObjectId(hex) { this.str = hex }
ObjectId.prototype.toString = function () { return 'ObjectId("' + this.str + '")' }
function NumberLong(s) { this.s = s }
NumberLong.prototype.toString = function () { return 'NumberLong("' + this.s + '")' }
function NumberInt(s) { this.s = s }
NumberInt.prototype.toString = function () { return 'NumberInt(' + this.s + ')' }
function NumberDecimal(s) { this.s = s }
NumberDecimal.prototype.toString = function () { return 'NumberDecimal("' + this.s + '")' }
function BinData(sub, b64) { this.sub = sub; this.b64 = b64 }
BinData.prototype.toString = function () { return 'BinData(' + this.sub + ', "' + this.b64 + '")' }
function Timestamp(t, i) { this.t = t; this.i = i }
Timestamp.prototype.toString = function () { return 'Timestamp(' + this.t + ', ' + this.i + ')' }
function MinKey() {}
function MaxKey() {}
function Code(c) { this.code = c }
function DBRef(c, o) { this.collection = c; this.oid = o }
DBRef.prototype.toString = function () { return 'DBRef("' + this.collection + '", "' + this.oid + '")' }

// ---- mongosh stand-ins: bson instances carrying _bsontype
const mongoshOid = { _bsontype: 'ObjectId', toString: () => '68f1a2b3c4d5e6f708192a3b' }
const mongoshLong = { _bsontype: 'Long', toString: () => '9007199254740993' }
const mongoshInt = { _bsontype: 'Int32', toString: () => '-42' }
const mongoshDec = { _bsontype: 'Decimal128', toString: () => '1234.5678' }
const mongoshBin = { _bsontype: 'Binary', sub_type: 4, toString: () => 'ZmFrZS11dWlkLTE2Yg==' }
const mongoshTs = { _bsontype: 'Timestamp', toString: () => 'Timestamp(1735689600, 7)' }
const mongoshMin = { _bsontype: 'MinKey' }
const mongoshRegex = { _bsontype: 'BSONRegExp', pattern: '^a.*z$', options: 'i' }

// evaluate the tagger in this scope
const tag = new Function(
  'ObjectId','NumberLong','NumberInt','NumberDecimal','BinData','Timestamp','MinKey','MaxKey','Code','DBRef','print',
  MT.TAGGER_JS + '\nreturn { __hoopTag: __hoopTag, __hoopEmit: __hoopEmit };'
)(ObjectId, NumberLong, NumberInt, NumberDecimal, BinData, Timestamp, MinKey, MaxKey, Code, DBRef, () => {})

let fails = 0
const canon = (x) => {
  if (Array.isArray(x)) return x.map(canon)
  if (x && typeof x === 'object') return Object.fromEntries(Object.keys(x).sort().map(k => [k, canon(x[k])]))
  return x
}
const check = (label, got, want) => {
  const ok = JSON.stringify(canon(got)) === JSON.stringify(canon(want))
  if (!ok) { fails++; console.log(`  FAIL ${label}\n    got  ${JSON.stringify(got)}\n    want ${JSON.stringify(want)}`) }
  else console.log(`  ok   ${label} -> ${JSON.stringify(got)}`)
}

const roundtrip = (v) => MT.value(JSON.parse(JSON.stringify(tag.__hoopTag(v))))

console.log('LEGACY 5.0 SHELL')
check('ObjectId', roundtrip(new ObjectId('68f1a2b3c4d5e6f708192a3b')), { kind: 'objectId', text: '68f1a2b3c4d5e6f708192a3b' })
check('int64 past 2^53', roundtrip(new NumberLong('9007199254740993')), { kind: 'int64', text: '9007199254740993' })
check('int32 negative', roundtrip(new NumberInt('-42')), { kind: 'int32', text: '-42' })
check('decimal128', roundtrip(new NumberDecimal('1234.5678')), { kind: 'decimal128', text: '1234.5678' })
check('timestamp', roundtrip(new Timestamp(1735689600, 7)), { kind: 'timestamp', text: 'Timestamp(1735689600, 7)', t: 1735689600, i: 7 })
check('minKey', roundtrip(new MinKey()), { kind: 'minKey', text: 'minKey' })

console.log('MONGOSH')
check('ObjectId', roundtrip(mongoshOid), { kind: 'objectId', text: '68f1a2b3c4d5e6f708192a3b' })
check('int64 past 2^53', roundtrip(mongoshLong), { kind: 'int64', text: '9007199254740993' })
check('int32 negative', roundtrip(mongoshInt), { kind: 'int32', text: '-42' })
check('decimal128', roundtrip(mongoshDec), { kind: 'decimal128', text: '1234.5678' })
check('timestamp', roundtrip(mongoshTs), { kind: 'timestamp', text: 'Timestamp(1735689600, 7)', t: 1735689600, i: 7 })
check('minKey', roundtrip(mongoshMin), { kind: 'minKey', text: 'minKey' })
check('BSONRegExp', roundtrip(mongoshRegex), { kind: 'regex', text: '/^a.*z$/i' })

console.log('BOTH: Date is a real JS Date in either shell')
const d = new Date('2026-01-25T05:50:39.097Z')
const tagged = JSON.parse(JSON.stringify(tag.__hoopTag(d)))
check('date millis', MT.dateMillis(tagged), d.getTime())
check('date is not a string', MT.classify(tagged), 'date')

console.log('PASSTHROUGH + STRUCTURE')
const doc = { _id: new ObjectId('68f1a2b3c4d5e6f708192a3b'), name: 'x', n: 3, ok: true, nil: null,
              nested: { a: [1, new NumberLong('42')] } }
const t2 = JSON.parse(JSON.stringify(tag.__hoopTag(doc)))
check('string passthrough', MT.classify(t2.name), 'string')
check('number passthrough', MT.classify(t2.n), 'number')
check('bool passthrough', MT.classify(t2.ok), 'boolean')
check('null passthrough', MT.classify(t2.nil), 'null')
check('array', MT.classify(t2.nested.a), 'array')
check('nested tagged in array', MT.value(t2.nested.a[1]), { kind: 'int64', text: '42' })
check('$-prefixed field is not mistaken for a wrapper',
      MT.classify(JSON.parse(JSON.stringify(tag.__hoopTag({ $price: 5 })))), 'object')
check('fieldPaths', MT.fieldPaths([doc && t2]), ['_id','name','n','ok','nil','nested','nested.a'].sort())

console.log('DEGRADED, NOT WRONG')
check('unrecognized objectId form -> raw', MT.value({ [MT.TAG]: 'objectId', [MT.VAL]: 'not-an-oid' }),
      { kind: 'raw', text: 'not-an-oid', expected: 'objectId' })
check('unrecognized binary form -> raw', MT.value({ [MT.TAG]: 'binary', [MT.VAL]: 'Binary.createFromBase64("x")' }),
      { kind: 'raw', text: 'Binary.createFromBase64("x")', expected: 'binary' })
check('out-of-range date -> null millis', MT.dateMillis({ [MT.TAG]: 'date', [MT.VAL]: '99999999999999999' }), null)

console.log('ENVELOPE')
let emitted = ''
const tag2 = new Function('print', MT.TAGGER_JS + '\nreturn { __hoopEmit: __hoopEmit };')((s) => { emitted = s })
tag2.__hoopEmit({ ok: true, op: 'find', documents: [] })
check('emit round-trips', MT.readEnvelope(emitted), { ok: true, v: 1, op: 'find', documents: [] })
check('noise before envelope tolerated', MT.readEnvelope('WARNING: {brace}\n' + emitted).ok, true)
check('no sentinel -> null (legacy fallback)', MT.readEnvelope('switched to db x\n{ "a" : 1 }'), null)
check('truncated', MT.readEnvelope(MT.SENTINEL_OPEN + '{"v":1'), { ok: false, reason: 'truncated' })
check('malformed', MT.readEnvelope(MT.SENTINEL_OPEN + 'not json' + MT.SENTINEL_CLOSE), { ok: false, reason: 'malformed' })
check('unsupported version', MT.readEnvelope(MT.SENTINEL_OPEN + '{"v":2}' + MT.SENTINEL_CLOSE),
      { ok: false, reason: 'unsupported-version', version: 2 })

console.log(fails === 0 ? '\nALL GREEN' : `\n${fails} FAILURE(S)`)
process.exit(fails === 0 ? 0 : 1)
