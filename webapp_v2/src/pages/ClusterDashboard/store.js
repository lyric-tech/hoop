import { create } from 'zustand'
import { sessionsService } from '@/services/sessions'
import { buildViewScript, makeNonce, VIEW_SECTIONS } from './script'
import { parseScriptOutput } from './parser'

// One slot per connection+view. Results stay cached across view switches so
// coming back is instant; FRESH_MS gates the implicit refetch on re-entry.
// Every slot write is guarded by (slotKey, epoch): an in-flight request whose
// slot was since reloaded simply discards itself. The POST is never aborted —
// cancelling the HTTP call would not stop the exec on the agent and would
// orphan the session_id.

const FRESH_MS = 120_000
const MAX_SLOTS = 27 // 3 connections × 9 views

const REVIEW_POLL_MS = 2_500
const REVIEW_POLL_MAX = 48 // ≈2min — mirrors the CLJS editor's review loop
const ASYNC_POLL_MS = 5_000
const ASYNC_POLL_MAX = 24 // ≈2min after the gateway's own 50s

const slotKey = (connection, view) => `${connection}::${view}`

const idleSlot = {
  status: 'idle', // idle|executing|pending_async|pending_review|success|error
  epoch: 0,
  sessionId: null,
  reviewUrl: null,
  sections: null,
  fetchedAt: null,
  truncated: false,
  executionTimeMs: null,
  error: null, // { code, detail }
}

// Maps an axios error from POST /sessions to a user-facing error code. The
// gateway reports access-control denials as 400 "connection not found" on
// purpose, so the copy for 400 covers both meanings.
function mapExecError(err) {
  const status = err?.response?.status
  const message = err?.response?.data?.message ?? err.message ?? ''
  if (status === 403) return { code: 'forbidden', detail: message }
  if (status === 400) return { code: 'not_found', detail: message }
  if (status === 500) return { code: 'exec_failed', detail: message }
  return { code: 'network', detail: message }
}

export const useClusterDashboardStore = create((set, get) => ({
  slots: {},

  getSlot: (connection, view) =>
    get().slots[slotKey(connection, view)] ?? idleSlot,

  loadView: async (connection, view, { force = false } = {}) => {
    if (!VIEW_SECTIONS[view]) return
    const key = slotKey(connection, view)
    const slot = get().slots[key] ?? idleSlot

    if (['executing', 'pending_async', 'pending_review'].includes(slot.status))
      return
    if (
      !force &&
      slot.status === 'success' &&
      Date.now() - slot.fetchedAt < FRESH_MS
    )
      return

    const epoch = slot.epoch + 1
    const writeSlot = (patch) => {
      const live = get().slots[key]
      if (live && live.epoch !== epoch) return false // superseded
      set((state) => ({
        slots: evict({
          ...state.slots,
          [key]: { ...(state.slots[key] ?? idleSlot), epoch, ...patch },
        }),
      }))
      return true
    }

    writeSlot({
      status: 'executing',
      error: null,
      sessionId: null,
      reviewUrl: null,
    })

    const nonce = makeNonce()
    let res
    try {
      res = await sessionsService.execute({
        script: buildViewScript(view, nonce),
        connection,
        metadata: { source: 'cluster-dashboard', view },
        correlation_id: 'cluster-dashboard',
      })
    } catch (err) {
      writeSlot({ status: 'error', error: mapExecError(err) })
      return
    }

    const data = res.data ?? {}

    // Review must be checked BEFORE parsing: output is a review URL, not
    // script output.
    if (data.has_review) {
      writeSlot({
        status: 'pending_review',
        sessionId: data.session_id,
        reviewUrl: data.output,
      })
      pollSession(writeSlot, data.session_id, {
        intervalMs: REVIEW_POLL_MS,
        maxAttempts: REVIEW_POLL_MAX,
        timeoutCode: 'review_timeout',
        nonce,
      })
      return
    }

    // 202: the exec outlived the gateway's 50s window and continues async.
    if (res.status === 202 || data.output_status === 'running') {
      writeSlot({ status: 'pending_async', sessionId: data.session_id })
      pollSession(writeSlot, data.session_id, {
        intervalMs: ASYNC_POLL_MS,
        maxAttempts: ASYNC_POLL_MAX,
        timeoutCode: 'timeout',
        nonce,
      })
      return
    }

    ingestOutput(writeSlot, data.output, nonce, {
      truncated: data.truncated === true,
      executionTimeMs: data.execution_time ?? null,
    })
  },

  refresh: (connection, view) =>
    get().loadView(connection, view, { force: true }),
}))

// Shared poll loop for pending_review and pending_async. setTimeout chains
// self-terminate when writeSlot reports the epoch was superseded.
function pollSession(writeSlot, sessionId, { intervalMs, maxAttempts, timeoutCode, nonce }) {
  let attempts = 0

  const tick = async () => {
    attempts++
    let session
    try {
      session = (await sessionsService.getById(sessionId)).data
    } catch {
      session = null // transient — keep polling until attempts run out
    }

    if (session) {
      const review = session.review?.status
      if (['REJECTED', 'REVOKED'].includes(review)) {
        writeSlot({ status: 'error', error: { code: 'rejected', detail: review } })
        return
      }
      if (session.status === 'done') {
        let output = ''
        try {
          const full = (
            await sessionsService.getById(sessionId, { expandEventStream: true })
          ).data
          output = decodeEventStream(full?.event_stream)
        } catch (err) {
          writeSlot({
            status: 'error',
            error: { code: 'network', detail: err.message ?? '' },
          })
          return
        }
        ingestOutput(writeSlot, output, nonce, { truncated: false, executionTimeMs: null })
        return
      }
    }

    if (attempts >= maxAttempts) {
      writeSlot({ status: 'error', error: { code: timeoutCode, detail: '' } })
      return
    }
    // Reschedule only while this epoch still owns the slot ("touch" write).
    if (writeSlot({})) setTimeout(tick, intervalMs)
  }

  setTimeout(tick, intervalMs)
}

// event_stream with format=base64 arrives as a list of base64-encoded event
// payloads; the CLJS editor decodes the first element (editor_plugin.cljs:172).
function decodeEventStream(eventStream) {
  const first = Array.isArray(eventStream) ? eventStream[0] : null
  if (typeof first !== 'string') return ''
  try {
    return atob(first)
  } catch {
    return ''
  }
}

function ingestOutput(writeSlot, output, nonce, { truncated, executionTimeMs }) {
  const { valid, sections } = parseScriptOutput(output, nonce)

  if (!valid) {
    const text = String(output ?? '')
    // The gateway reports a dead agent as a 200 with the gRPC error as the
    // whole output — no markers ever existed, so catch it before bad_output.
    const code = /agent is offline|agent not found/i.test(text)
      ? 'agent_offline'
      : 'bad_output'
    writeSlot({
      status: 'error',
      error: { code, detail: text.slice(0, 500) },
    })
    return
  }
  if (sections.precheck?.rc === 127) {
    writeSlot({ status: 'error', error: { code: 'no_kubectl', detail: '' } })
    return
  }
  writeSlot({
    status: 'success',
    sections,
    fetchedAt: Date.now(),
    truncated,
    executionTimeMs,
    error: null,
  })
}

// Drop the oldest successful slots beyond the cap. Slots that are mid-flight
// are never evicted — their epoch guard would strand the eventual write.
function evict(slots) {
  const keys = Object.keys(slots)
  if (keys.length <= MAX_SLOTS) return slots
  const evictable = keys
    .filter((k) => ['success', 'error', 'idle'].includes(slots[k].status))
    .sort((a, b) => (slots[a].fetchedAt ?? 0) - (slots[b].fetchedAt ?? 0))
  const next = { ...slots }
  for (const k of evictable.slice(0, keys.length - MAX_SLOTS)) delete next[k]
  return next
}
