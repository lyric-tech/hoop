// Unit tests for the Cluster Dashboard exec primitives. Run with:
//   npm run test:unit   (node --test, no framework dependencies)
import test from 'node:test'
import assert from 'node:assert/strict'
import {
  buildViewScript,
  makeNonce,
  MARKER_PREFIX,
  SECTIONS,
  VIEW_SECTIONS,
  VIEW_IDS,
} from '../src/pages/ClusterDashboard/script.js'
import {
  parseScriptOutput,
  parseCpu,
  parseMemMi,
  parseContainers,
  podStatusBucket,
  isCrdMissing,
} from '../src/pages/ClusterDashboard/parser.js'

const NONCE = 'aabbccdd00112233'
const M = `${MARKER_PREFIX}:${NONCE}`

// Reproduces what the bash `emit` function prints for one section.
function emit(id, { out = '', rc = 0, err = '' } = {}) {
  let block = `${M}:BEGIN:${id}##\n${out}\n${M}:RC:${id}:${rc}##\n`
  if (err) block += `${M}:ERR:${id}##\n${err}\n`
  return block + `${M}:END:${id}##\n`
}

test('makeNonce is 16 hex chars and unique', () => {
  const a = makeNonce()
  assert.match(a, /^[0-9a-f]{16}$/)
  assert.notEqual(a, makeNonce())
})

test('every view builds a script with all its sections and exit 0', () => {
  for (const view of VIEW_IDS) {
    const script = buildViewScript(view, NONCE)
    assert.ok(script.includes('set -u'), `${view}: set -u`)
    assert.ok(script.trimEnd().endsWith('exit 0'), `${view}: exits 0`)
    assert.ok(script.includes('command -v kubectl'), `${view}: precheck`)
    for (const id of VIEW_SECTIONS[view]) {
      assert.ok(script.includes(`run ${id} `), `${view}: runs ${id}`)
      assert.ok(script.includes(`emit ${id}`), `${view}: emits ${id}`)
    }
  }
  assert.throws(() => buildViewScript('nope', NONCE))
})

test('every kubectl call carries --request-timeout', () => {
  for (const [id, spec] of Object.entries(SECTIONS)) {
    assert.ok(
      spec.cmd.includes('--request-timeout=15s'),
      `${id} must bound its API call`,
    )
  }
})

test('SECURITY: secrets and configmaps use table printing only — no -o flag', () => {
  const config = buildViewScript('config', NONCE)
  const secretCommands = config
    .split('\n')
    .filter((l) => /\bget secrets\b|\bget configmaps\b/.test(l))
  assert.equal(secretCommands.length, 2)
  for (const cmd of secretCommands) {
    assert.ok(!cmd.includes('-o '), `no output flag allowed: ${cmd}`)
    assert.ok(!cmd.includes('jsonpath'), `no jsonpath allowed: ${cmd}`)
    assert.ok(cmd.includes('--no-headers'), `table mode: ${cmd}`)
  }
  // ...and no other section sneaks a secrets read in.
  for (const [id, spec] of Object.entries(SECTIONS)) {
    if (id === 'secrets') continue
    assert.ok(!/\bsecrets?\b/.test(spec.cmd), `${id} must not touch secrets`)
  }
})

test('parses a full multi-section response', () => {
  const raw =
    'motd noise before first marker\n' +
    emit('precheck', { rc: 0 }) +
    emit('deploys', {
      out: 'default\tapi\t3\t3\t2026-01-01T00:00:00Z\nweb\tfront\t1\t2\t2026-02-01T00:00:00Z',
    }) +
    emit('topnodes', { rc: 1, err: 'error: Metrics API not available' })

  const { valid, sections } = parseScriptOutput(raw, NONCE)
  assert.equal(valid, true)
  assert.equal(sections.precheck.rc, 0)
  assert.equal(sections.deploys.rows.length, 2)
  assert.deepEqual(sections.deploys.rows[0], {
    namespace: 'default',
    name: 'api',
    ready: '3',
    desired: '3',
    created: '2026-01-01T00:00:00Z',
  })
  assert.equal(sections.topnodes.rc, 1)
  assert.equal(sections.topnodes.rows, null)
  assert.match(sections.topnodes.stderr, /Metrics API/)
})

test('review URL / non-script output is invalid, not an empty dashboard', () => {
  const { valid } = parseScriptOutput('https://gw.example/sessions/abc', NONCE)
  assert.equal(valid, false)
})

test('markers with a different nonce are payload, not structure', () => {
  const foreign = `${MARKER_PREFIX}:ffffffffffffffff:BEGIN:evil##`
  const raw = emit('events', {
    out: `2026-01-01T00:00:00Z\tns\tPod\tp1\tBackOff\t3\tmessage containing ${foreign} inline`,
  })
  const { sections } = parseScriptOutput(raw, NONCE)
  assert.equal(sections.events.rows.length, 1)
  assert.ok(sections.events.rows[0].message.includes(foreign))
})

test('tail column absorbs tabs; short rows are dropped and counted', () => {
  const raw = emit('events', {
    out: [
      '2026-01-01T00:00:00Z\tns\tPod\tp1\tBackOff\t3\tmsg with\ttabs inside',
      'continuation line of a multiline message',
      '2026-01-02T00:00:00Z\tns\tPod\tp2\tFailed\t1\tplain',
    ].join('\n'),
  })
  const { sections } = parseScriptOutput(raw, NONCE)
  assert.equal(sections.events.rows.length, 2)
  assert.equal(sections.events.rows[0].message, 'msg with\ttabs inside')
  assert.equal(sections.events.parseWarnings, 1)
})

test('BEGIN without END marks the section corrupt (truncated stream)', () => {
  const raw = `${M}:BEGIN:deploys##\nns\tapi\t1\t1\t2026-01-01T00:00:00Z`
  const { valid, sections } = parseScriptOutput(raw, NONCE)
  assert.equal(valid, true)
  assert.equal(sections.deploys.corrupt, true)
})

test('table parse splits on whitespace runs, folds overflow right', () => {
  const raw = emit('secrets', {
    out: 'kube-system   default-token   kubernetes.io/service-account-token   3   270d',
  })
  const { sections } = parseScriptOutput(raw, NONCE)
  assert.deepEqual(sections.secrets.rows[0], {
    namespace: 'kube-system',
    name: 'default-token',
    type: 'kubernetes.io/service-account-token',
    data: '3',
    age: '270d',
  })
})

test('value helpers', () => {
  assert.equal(parseCpu('250m'), 0.25)
  assert.equal(parseCpu('4'), 4)
  assert.equal(parseCpu(''), null)
  assert.equal(parseMemMi('1024Ki'), 1)
  assert.equal(parseMemMi('2Gi'), 2048)
  assert.equal(parseMemMi('512Mi'), 512)
  assert.deepEqual(parseContainers('true:0 false:3 true:1'), {
    ready: 2,
    total: 3,
    restarts: 4,
  })
  assert.equal(podStatusBucket({ phase: 'Running', deleting: '' }), 'running')
  assert.equal(
    podStatusBucket({ phase: 'Running', deleting: '2026-01-01T00:00:00Z' }),
    'pending',
  )
  assert.equal(podStatusBucket({ phase: 'CrashLoopBackOff', deleting: '' }), 'failed')
  assert.ok(
    isCrdMissing({ rc: 1, stderr: "error: the server doesn't have a resource type \"verticalpodautoscalers\"" }),
  )
  assert.ok(!isCrdMissing({ rc: 1, stderr: 'Forbidden' }))
})
