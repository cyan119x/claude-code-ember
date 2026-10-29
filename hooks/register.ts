import type { EngineInterface, Register, RenderElement } from 'claude-code'
import { SANS } from './font'
import { ADVANCES } from './outfit-metrics'

// Ember: a ribbon above the prompt, after robonuggets/ribbon (MIT), over cache-tax 3.0.0's cache logic.
// Text takes the app's theme colours (theme keys); drawings carry both palettes and follow the app through
// prefers-color-scheme. The ribbon draws no background: the app's band holds it.
const TEXT = 'text'
const MUTED = 'inactive'
const SMOKE = '#8D8775'
const INK = '#1C1A16'
// Every tag's word: white in light mode, 3.9:1 or better on each tag colour in bold; in dark mode an ivory a shade
// softer so it does not glare, still 3.3:1 or better.
const TAG_INK: [string, string] = ['#FFFFFF', '#F0EBE5']
// The hairlines of an open band: the theme key the desktop paints with its own border colour, which follows the mode.
const RULE = 'promptBorderShimmer'
// A blank Braille cell: it takes a character's width and draws nothing, the label of the Button over the tag.
const BLANK = '\u2800'
// The blank's advance: macOS draws it from Apple Braille, 0.6836em at every size (measured with CoreText).
const BLANK_EM = 0.6836
// How far the Button's layer reaches past each side of the tag, in columns: room for the label to overshoot the pill.
const OVERLAY_COLS = 3
// A usage window under this much left adds LOW: success over half, warning down to this, error under it.
const LOW_AT = 15
// The last stretch of a 1h cache draws Ember low and the tag in the warning colour.
const COOLING_MS = 10 * 60 * 1000
const TICK_MS = 30 * 1000
const KEEP_CHOICES: Array<[string, number]> = [['1h', 60 * 60 * 1000], ['2h', 2 * 60 * 60 * 1000], ['3h', 3 * 60 * 60 * 1000], ['6h', 6 * 60 * 60 * 1000]]

// The prompt cache lives 1h or 5m; which one the session writes is read from its transcript after each turn.
const TTL_1H = 60 * 60 * 1000
const TTL_5M = 5 * 60 * 1000
// Below this a ping every few minutes costs more than it saves, so keepwarm sends none.
const MIN_KEEPWARM_TTL = 10 * 60 * 1000
// The transcript's tail read for the latest cache write: a few turns' rows.
const TAIL_BYTES = 262144
const PING_AFTER_MS = 50 * 60 * 1000
const MIN_PING_MS = 60 * 1000
const MAX_RETRIES = 3
const DEFAULT_WINDOW_MS = 6 * 60 * 60 * 1000
// Over this the cold-send question also points at /handoff, when that mod is installed.
const HANDOFF_HINT_TOKENS = 150000
const BIG_TOKENS = 50000
const PING_PROMPT = 'Reply with the single word: warm'
const KEY_DEADLINE = 'deadline'
const KEY_EVERY = 'every'
const KEY_GUARD = 'guard'
const KEY_ALWAYS = 'always'
// Each session's last request time and cache life, so a plugin reload (whose module starts from a fresh state) or a
// relaunch on the same conversation still shows the cache. One small record per session, rewritten in place.
const KEY_CACHE = 'cache'

// Prompts no person sent, so nobody could send them again after a refusal. Every
// other origin, including sdk, unclassified and the person's own Slack or channel
// messages, may carry a person's words and keeps the guard.
const UNATTENDED = new Set(['task-notification', 'scheduled-trigger', 'peer', 'peer-send-message', 'projects-relay', 'coordinator', 'observer', 'observer-activity'])

const LONG_PROMPT_TOKENS = 100000

// $ per million tokens, [cache read, 1h cache write, output], list prices October 2026.
// More specific families first: a model id takes the first row it matches.
const PRICES: Array<[string | RegExp, number, number, number]> = [
  ['fable-5-1', 0.25, 20, 50],
  ['mythos-5-1', 0.25, 20, 50],
  ['fable-5', 1, 20, 50],
  ['mythos-5', 1, 20, 50],
  ['opus-5-5', 0.2, 8, 20],
  ['opus-5', 0.5, 10, 25],
  // Opus 4 and 4.1 in every spelling (claude-opus-4-1-20250805, claude-opus-4@20250514, the -0 and -1 aliases), never Opus 4.5 and later.
  [/opus-4(?:-[01])?(?:$|[^-\d]|-20\d{6})/, 1.5, 30, 75],
  ['opus-4', 0.5, 10, 25],
  ['sonnet-5-5', 0.1, 4, 10],
  ['sonnet-5', 0.2, 4, 10],
  ['sonnet', 0.3, 6, 15],
  ['haiku-5-5', 0.01, 0.2, 0.5],
  ['3-5-haiku', 0.08, 1.6, 4],
  ['haiku-3-5', 0.08, 1.6, 4],
  ['haiku', 0.1, 2, 5],
]

// A request whose prompt, cache reads and writes included, is over 100k tokens pays these instead.
const LONG_PRICES: Array<[string, number, number, number]> = [
  ['haiku-5-5', 0.05, 1, 2.5],
]

type PingRecord = { at: number; read: number; write: number; usd: number | null; warm: boolean }
type Miss = { at: number; tokens: number; usd: number | null }
type GuardMode = 'refuse' | 'warn'

export type State = {
  hasBand: boolean
  sid: string
  deadline: number
  every: number
  always: boolean
  lastRequestAt: number
  lastModel: string | null
  ctx: number
  compacted: boolean
  resumedAt: number
  transcript: number
  guard: GuardMode
  ackedAt: number
  coldWritePending: boolean
  misses: Miss[]
  pending: { cancel: () => void } | null
  last: PingRecord | null
  stopped: string | null
  waitForTurn: boolean
  retries: number
  retryReason: string
  gen: number
  tick: number
  offs: number
  turnOffs: number | null
  inFlight: boolean
  stepWrites: StepWrites | null
  steps: number
  endingSid: string
  /** The cache's life as the latest main-thread write showed it: TTL_1H until a row says otherwise. */
  ttl: number
  /** A cold send held for the person's answer at the band: its text, sent again as theirs on "Send anyway". */
  held: { text: string; at: number } | null
  hasHandoff: boolean
  /** The usage windows the last response reported, 7-day first. */
  windows: UsageWindow[]
  /** The model's context window, for the card's share of it. */
  ctxWindow: number
  /** The Keep warm choices are open under the band's row. */
  menu: boolean
  /** The detail card's open or closed, held only for the cache state it was set in. */
  fold: { mode: string; open: boolean } | null
  /** The keepwarm window last opened, as asked (6h is 6h however much of it is left); 0 when not known, as after a restart. */
  keepWindow: number
}

export type UsageWindow = { kind: string; percentUsed: number; resetsAt?: string }

/** What this turn's main requests wrote before any compaction it saw, priced per request where the steps reported usage. */
type StepWrites = { tokens: number; usd: number; priced: boolean }

function priceOf(model: string | null, promptTokens: number): [number, number, number] | null {
  const m = (model ?? '').toLowerCase().replace(/[\s.]+/g, '-')
  if (promptTokens > LONG_PROMPT_TOKENS) {
    for (const [family, read, write, output] of LONG_PRICES) if (m.includes(family)) return [read, write, output]
  }
  for (const [family, read, write, output] of PRICES) {
    if (typeof family === 'string' ? m.includes(family) : family.test(m)) return [read, write, output]
  }
  return null
}

export function parseDuration(text: string): number | null {
  const m = /^(?:(\d+)h)?(?:(\d+)m)?$/.exec(text.trim())
  if (!m || (m[1] === undefined && m[2] === undefined)) return null
  return (Number(m[1] ?? 0) * 60 + Number(m[2] ?? 0)) * 60 * 1000
}

export function fmtDuration(ms: number): string {
  const total = Math.max(0, Math.round(ms / 60000))
  const h = Math.floor(total / 60)
  const m = total % 60
  if (h >= 48) return `${Math.floor(h / 24)}d ${h % 24}h`
  return h > 0 ? `${h}h${String(m).padStart(2, '0')}m` : `${m}m`
}

function fmtUsd(usd: number | null): string {
  return usd == null ? 'n/a' : '$' + (usd >= 100 ? usd.toFixed(0) : usd.toFixed(2))
}

function fmtTok(n: number): string {
  return n >= 1e6 ? (n / 1e6).toFixed(1) + 'M' : n >= 1000 ? Math.round(n / 1000) + 'k' : String(n)
}

function coldUsd(s: State): number | null {
  const price = priceOf(s.lastModel, s.ctx)
  return price ? s.ctx * price[1] / 1e6 : null
}

function warmUsd(s: State): number | null {
  const price = priceOf(s.lastModel, s.ctx)
  return price ? s.ctx * price[0] / 1e6 : null
}

/** Everything a fork bills: the cache read, any cache write, uncached input at the base rate (half the 1h write rate), and the output. */
function pingUsd(u: { input_tokens: number; output_tokens: number; cache_read_input_tokens: number; cache_creation_input_tokens: number }, price: [number, number, number]): number {
  return (u.cache_read_input_tokens * price[0] + u.cache_creation_input_tokens * price[1] + u.input_tokens * price[1] / 2 + u.output_tokens * price[2]) / 1e6
}

/** The read-only upper bound: pings at the cache-read rate that cost as much as one cold write of the same context. */
function breakEvenPings(s: State): number | null {
  const price = priceOf(s.lastModel, s.ctx)
  if (!price || s.ctx <= 0) return null
  return Math.floor(price[1] / price[0])
}

function isCold(s: State, now: number): boolean {
  return s.lastRequestAt > 0 && !s.compacted && now - s.lastRequestAt >= s.ttl
}

export function ttlLabel(ttl: number): string {
  return ttl <= TTL_5M ? '5m' : '1h'
}

/**
 * The cache's life from a transcript's tail: the newest main-thread assistant row that wrote the cache says 5m or 1h
 * (`message.usage.cache_creation.ephemeral_5m_input_tokens` / `ephemeral_1h_input_tokens`). A row that only read is
 * passed over; none in the tail answers null. The first line may be cut by the tail and is skipped when it does not parse.
 */
export function cacheTtlFromTranscript(text: string): number | null {
  const lines = text.split('\n')
  for (let i = lines.length - 1; i >= 0; i--) {
    const line = lines[i]?.trim()
    if (!line || !line.includes('"assistant"')) continue
    let row: { type?: unknown; isSidechain?: unknown; message?: { usage?: { cache_creation?: { ephemeral_5m_input_tokens?: unknown; ephemeral_1h_input_tokens?: unknown } } } }
    try {
      row = JSON.parse(line)
    } catch {
      continue
    }
    if (row.type !== 'assistant' || row.isSidechain === true) continue
    const cc = row.message?.usage?.cache_creation
    if (!cc) continue
    if (typeof cc.ephemeral_1h_input_tokens === 'number' && cc.ephemeral_1h_input_tokens > 0) return TTL_1H
    if (typeof cc.ephemeral_5m_input_tokens === 'number' && cc.ephemeral_5m_input_tokens > 0) return TTL_5M
  }
  return null
}

function guardText(s: State, now: number): string {
  const price = priceOf(s.lastModel, s.ctx)
  const rate = price ? `$${price[1]}/MTok` : 'the cache-write rate'
  const warm = warmUsd(s)
  return `the prompt cache (${ttlLabel(s.ttl)}) went cold ${fmtDuration(now - s.lastRequestAt - s.ttl)} ago. Sending this re-writes ` +
    `up to ${s.ctx.toLocaleString('en-US')} tokens at ${rate} = ${fmtUsd(coldUsd(s))}` +
    (warm == null ? '' : ` (a warm turn would have cost ${fmtUsd(warm)})`) + '.'
}

export type ResumeFields = {
  source: string
  model?: string
  context_tokens?: number
  seconds_since_last_response?: number
  prompt_cache_likely_expired?: boolean
  estimated_cache_write_usd?: number
}

/** /clear starts a new conversation in the same process; nothing priced before it still exists. */
export function resetForClear(s: State) {
  s.ctx = 0
  s.lastRequestAt = 0
  s.compacted = false
  s.resumedAt = 0
  s.transcript = 0
  s.ackedAt = 0
  s.coldWritePending = false
  s.misses = []
  s.waitForTurn = false
  s.stepWrites = null
  s.steps = 0
  s.held = null
  outdate(s)
  disarm(s)
}

/** Applies a resumed session's fields to the state; returns the line to log, if any. */
export function seedFromResume(s: State, e: ResumeFields, now: number): string | null {
  if (e.source !== 'resume' && e.source !== 'fork') return null
  if (typeof e.context_tokens === 'number' && e.context_tokens > 0) s.ctx = e.context_tokens
  if (typeof e.seconds_since_last_response === 'number') {
    s.lastRequestAt = now - e.seconds_since_last_response * 1000
    s.resumedAt = 0
  }
  if (typeof e.model === 'string') s.lastModel = e.model
  s.compacted = false
  if (e.prompt_cache_likely_expired !== true || s.ctx < BIG_TOKENS) return null
  const usd = typeof e.estimated_cache_write_usd === 'number' ? fmtUsd(e.estimated_cache_write_usd) : fmtUsd(coldUsd(s))
  return `resuming cold. The first message re-writes ${s.ctx.toLocaleString('en-US')} tokens, about ${usd}. /clear and paste a summary if you only need the conclusions.`
}

/** A transcript resumed without the time of its last response: that response came after its first launch, so an hour after that launch the cache may be cold. */
function mayBeCold(s: State, now: number): boolean {
  return s.resumedAt > 0 && !s.lastRequestAt && now - s.resumedAt >= s.ttl
}

/** The line for a resumed session whose last response time never arrived: the cache may be cold, and this is what that would cost. */
function unknownText(s: State): string {
  const price = priceOf(s.lastModel, s.ctx)
  const rate = price ? `$${price[1]}/MTok` : 'the cache-write rate'
  return `resumed with up to ${s.ctx.toLocaleString('en-US')} tokens of context and no time of its last response, so the cache may be cold. ` +
    `If it is, this message re-writes them at ${rate} = ${fmtUsd(coldUsd(s))}.`
}

/** The conversation was summarized: the next request is the first over the new prefix, and a ping out for the old one is dropped. */
function markCompacted(s: State) {
  s.compacted = true
  s.transcript = 0
  s.ackedAt = 0
  outdate(s)
}

function statusText(s: State, now: number): string | undefined {
  if (s.stopped) return `keepwarm stopped: ${s.stopped}`
  if (!s.deadline) return undefined
  const pingText = s.last ? ` · last ping read ${fmtTok(s.last.read)} ${fmtUsd(s.last.usd)}` : ''
  const nextText = !s.lastRequestAt ? ' · waiting for the first turn'
    : s.compacted ? ' · waiting for the first turn after compaction'
    : s.ttl < MIN_KEEPWARM_TTL ? ` · the cache lives ${ttlLabel(s.ttl)} now, no pings: one every few minutes costs more than it saves`
    : isCold(s, now) ? ` · cold now, first ping ${fmtDuration(s.every)} after the next turn`
    : s.waitForTurn ? ' · nothing to fork yet, first ping after the next turn'
    : s.retries ? ` · API busy, ping retry ${s.retries} of ${MAX_RETRIES}`
    : ` · ping in ${fmtDuration(s.lastRequestAt + s.every - now)}`
  return `keepwarm ${fmtDuration(s.deadline - now)} left${nextText}${pingText}`
}

function updateStatus($: EngineInterface, s: State, now: number) {
  if (s.hasBand) $.ui.invalidate('ui.render')
  else $.ui.status(statusText(s, now))
}

/** Cancels the timer. Every new timer is set right after this, so the tick also says the schedule changed. */
function disarm(s: State) {
  if (s.pending) s.pending.cancel()
  s.pending = null
  s.tick++
}

/** Outdates any ping in flight: /clear, a resume, compaction or stop replaced the state it was sent for. Re-arming or extending the window does not, so a ping out at that moment still counts; a main request outdates it through the request clock. */
function outdate(s: State) {
  s.gen++
}

// The window and its ping period belong to the session that armed them, so a
// second session, or one resumed from another transcript, never inherits them
// and cannot turn them off. The always switch and the guard mode stay global.
function deadlineKey(s: State): string {
  return `${KEY_DEADLINE}:${s.sid}`
}

function everyKey(s: State): string {
  return `${KEY_EVERY}:${s.sid}`
}

function cacheKey(s: State): string {
  return `${KEY_CACHE}:${s.sid}`
}

/** Writes this session's last request time and cache life to the store, where a reload finds them. */
async function saveCache($: EngineInterface, s: State) {
  if (s.sid && s.lastRequestAt) await $.store.set(cacheKey(s), { at: s.lastRequestAt, ttl: s.ttl })
}

/** Reads them back into a fresh state: a reload starts the module over, and without them the ribbon would hide the cache until the next turn. */
export async function restoreCache($: EngineInterface, s: State, now: number) {
  if (!s.sid || s.lastRequestAt) return
  const saved = await $.store.get(cacheKey(s)) as { at?: unknown; ttl?: unknown } | undefined
  if (!saved || typeof saved.at !== 'number' || saved.at <= 0 || saved.at > now) return
  s.lastRequestAt = saved.at
  if (saved.ttl === TTL_1H || saved.ttl === TTL_5M) s.ttl = saved.ttl
  s.resumedAt = 0
}

/** Clears this session's own dead window and the bare keys a store written before 2.1.1 still holds. Other sessions' keys are never touched: a read followed by a delete cannot be made atomic against their renewal. */
async function prune($: EngineInterface, s: State, now: number) {
  for (const key of [KEY_DEADLINE, deadlineKey(s)]) {
    const deadline = await $.store.get(key)
    if (deadline === undefined) continue
    if (typeof deadline === 'number' && deadline > now) continue
    await $.store.delete(key)
    await $.store.delete(KEY_EVERY + key.slice(KEY_DEADLINE.length))
  }
}

async function stop($: EngineInterface, s: State, why: string | null, forgetAlways = false) {
  // Set before any await, so a window being opened at the same moment sees the off and does not write itself back.
  if (forgetAlways) {
    s.always = false
    s.offs++
  }
  s.deadline = 0
  s.every = PING_AFTER_MS
  s.stopped = why
  s.retries = 0
  outdate(s)
  disarm(s)
  await $.store.delete(deadlineKey(s))
  await $.store.delete(everyKey(s))
  if (forgetAlways) await $.store.delete(KEY_ALWAYS)
  updateStatus($, s, await $.clock.now())
}

/** The conversation ended under /clear or an in-process resume. The next one's id cannot be read until the engine has switched, so the state is left unseated. */
async function endConversation($: EngineInterface, s: State, reason: 'clear' | 'resume') {
  // Claimed before any await: a second end or a classic start for the same conversation finds it already gone, and an
  // end cut short by its budget leaves no timer and no old id behind, only the keys below.
  const keys = [deadlineKey(s), everyKey(s)]
  const ending = s.sid
  resetForClear(s)
  s.sid = ''
  s.endingSid = ending
  // /clear ends the conversation the window was armed for. A resume carries the window on to the next one, under its
  // id: the old id's keys go here, or a /keepwarm off there could never find them and the old session would re-arm them.
  if (reason === 'clear') {
    s.deadline = 0
    s.every = PING_AFTER_MS
    s.stopped = null
    s.retries = 0
  }
  for (const key of keys) await $.store.delete(key)
  if (reason === 'clear') updateStatus($, s, await $.clock.now())
}

/** Reads the session the process runs now: its id, its model and the engine's figures for its context. Returns the time read with them. */
async function seat($: EngineInterface, s: State, id?: string): Promise<number> {
  s.sid = id ?? await $.session.id()
  s.endingSid = ''
  s.lastModel = await $.session.model()
  const usage = await $.session.usage()
  const now = await $.clock.now()
  if (usage.context.tokens) s.ctx = usage.context.tokens
  if (usage.context.window) s.ctxWindow = usage.context.window
  s.windows = cleanWindows(usage.rateLimits ?? [])
  // A resumed transcript's last response came somewhere between its first launch and now; only the resume fields say where.
  s.resumedAt = !s.lastRequestAt && usage.context.tokens ? usage.startedAt : 0
  return now
}

/** Seats the state in the conversation that followed a /clear or a resume, once, and arms what always or a window opened meanwhile asks for. */
async function reseat($: EngineInterface, s: State) {
  if (s.sid) return
  const id = await $.session.id()
  // The host still answers with the conversation being ended: the next one is not there to seat yet, so nothing is
  // seated under the old id, and a window opened meanwhile waits in memory for the id it belongs to.
  if (id === s.endingSid) return
  const now = await seat($, s, id)
  if (s.always) await startWindow($, s, DEFAULT_WINDOW_MS, PING_AFTER_MS)
  // A window carried over, or armed while the conversation was ending, is written under this id.
  else if (s.deadline) await startWindow($, s, s.deadline - now, s.every)
  else updateStatus($, s, now)
}

async function arm($: EngineInterface, s: State) {
  disarm(s)
  s.retries = 0
  if (!s.deadline) return
  const now = await $.clock.now()
  // A timer set while the clock was read, such as a retry, is replaced here, never left running beside this one;
  // from this line to the assignment below nothing awaits.
  disarm(s)
  s.retries = 0
  if (now >= s.deadline) return stop($, s, null)
  // A 5-minute cache would need a ping every few minutes: the window stays open and sends none until a 1h write is seen.
  if (s.ttl < MIN_KEEPWARM_TTL) {
    s.pending = $.clock.after(s.deadline - now, () => { void arm($, s) })
    updateStatus($, s, now)
    return
  }
  // A cold window still needs expiry cleanup, but must not send a model request.
  if (s.lastRequestAt && !s.compacted && !isCold(s, now)) {
    const untilCold = s.lastRequestAt + s.ttl - now
    // Waiting for a turn sends nothing, but wakes when the cache goes cold so the row says so.
    if (s.waitForTurn) s.pending = $.clock.after(Math.min(s.deadline - now, untilCold), () => { void arm($, s) })
    else {
      const delay = Math.min(s.deadline - now, untilCold, Math.max(1000, s.lastRequestAt + s.every - now))
      s.pending = $.clock.after(delay, () => { void ping($, s) })
    }
  } else {
    s.pending = $.clock.after(s.deadline - now, () => { void arm($, s) })
  }
  updateStatus($, s, now)
}

async function ping($: EngineInterface, s: State) {
  s.pending = null
  if (!s.deadline) return
  const tick = s.tick
  const now = await $.clock.now()
  // A timer set or cancelled while the clock was read (an extension, a retry, a turn) owns the window now;
  // if that left no timer, a window still open is armed again rather than left without one.
  if (s.tick !== tick) return s.pending || s.inFlight ? undefined : arm($, s)
  // One fork at a time: the one already out re-arms when it settles. Checked after the await, and set
  // below with no await in between, so two timers can never both send.
  if (s.inFlight) return
  if (now >= s.deadline) return arm($, s)
  if (isCold(s, now)) return arm($, s)
  if (s.compacted || s.waitForTurn || !s.lastRequestAt) return arm($, s)
  // A request since this timer was set moved the clock; schedule from it.
  if (now - s.lastRequestAt < s.every - 1000) return arm($, s)
  // A host that slept past a retry's slot must not send it inside the last minute.
  if (s.retries && now >= s.lastRequestAt + s.ttl - MIN_PING_MS) return stop($, s, s.retryReason + afterRetries(s.retries))
  const gen = s.gen
  const sentAt = s.lastRequestAt
  s.inFlight = true
  const sent = await $.model.fork({ prompt: PING_PROMPT }).then(reply => ({ reply }), (err: unknown) => ({ err }))
  const at = await $.clock.now()
  s.inFlight = false
  // Checked after the last await. A stop, /clear, resume or compaction, or a main request that moved the
  // cache clock, replaced what this fork was sent for: its reply is dropped and the window armed afresh.
  if (gen !== s.gen || s.lastRequestAt !== sentAt) return s.pending ? undefined : arm($, s)
  if ('err' in sent) return stop($, s, `the ping failed, ${sent.err instanceof Error ? sent.err.message : String(sent.err)}`)
  const reply = sent.reply
  if (reply === null) return stop($, s, 'the engine did not send the ping, either the snapshot was cold or the API call failed')
  if (reply.isAnswered === false) {
    // A restarted process has no conversation to fork until its first turn; the window waits for one instead of ending.
    if (reply.reason === 'nothing-to-fork') {
      s.waitForTurn = true
      return arm($, s)
    }
    const reason = reply.reason === 'api-error' ? `the API call failed${reply.status === null ? '' : ` (${reply.status})`}`
      : reply.reason === 'aborted' ? 'the ping was interrupted'
      : 'the ping returned no text'
    // A busy or failing API is usually brief; retry while a ping can still land a minute before the cache goes cold.
    if (reply.reason === 'api-error' && (reply.status === null || reply.status === 429 || reply.status >= 500)) {
      const wait = MIN_PING_MS * 2 ** s.retries
      if (s.retries < MAX_RETRIES && at + wait < Math.min(s.deadline, s.lastRequestAt + s.ttl - MIN_PING_MS)) {
        s.retries++
        s.retryReason = reason
        // Replaces any timer set while the fork was out, such as a window extension's, so only the retry fires.
        disarm(s)
        s.pending = $.clock.after(wait, () => { void ping($, s) })
        updateStatus($, s, at)
        return
      }
    }
    return stop($, s, reason + afterRetries(s.retries))
  }
  const u = reply.usage
  const price = priceOf(s.lastModel, u.input_tokens + u.cache_read_input_tokens + u.cache_creation_input_tokens)
  // A warm ping reads the prefix and writes only its own message; a write of a tenth of the read or more means the prefix broke.
  const warm = u.cache_read_input_tokens > 0 && u.cache_creation_input_tokens < 0.1 * u.cache_read_input_tokens
  const usd = price ? pingUsd(u, price) : null
  s.last = { at: now, read: u.cache_read_input_tokens, write: u.cache_creation_input_tokens, usd, warm }
  if (!warm) return stop($, s, `the ping read ${fmtTok(u.cache_read_input_tokens)} and wrote ${fmtTok(u.cache_creation_input_tokens)} tokens (${fmtUsd(usd)}), the cache was already gone`)
  s.lastRequestAt = now
  await saveCache($, s)
  await arm($, s)
}

function afterRetries(n: number): string {
  return n ? ` after ${n} ${n === 1 ? 'retry' : 'retries'}` : ''
}

/** The reply to an arming command; on a cold cache it says when the first ping can come. */
function armedText(s: State, now: number, windowMs: number): string {
  if (s.ttl < MIN_KEEPWARM_TTL) return `keepwarm on for ${fmtDuration(windowMs)}, but the cache lives ${ttlLabel(s.ttl)} now, so no pings go out until a 1h cache write is seen`
  if (isCold(s, now)) return `keepwarm on for ${fmtDuration(windowMs)}. The cache is cold now, so the first ping comes ${fmtDuration(s.every)} after the next turn`
  return `keepwarm on for ${fmtDuration(windowMs)}, a ping ${fmtDuration(s.every)} after each idle stretch keeps the cache read, not re-written`
}

// A /keepwarm off after `offs` was read wins: the window it cancelled is not written back. A caller that awaited
// before deciding to open a window passes the count it read first.
async function startWindow($: EngineInterface, s: State, windowMs: number, every: number, offs = s.offs) {
  if (s.offs !== offs) return
  const now = await $.clock.now()
  if (s.offs !== offs) return
  const deadline = now + windowMs
  s.keepWindow = windowMs
  s.every = every
  s.deadline = deadline
  s.stopped = null
  // Unseated, between a conversation's end and the host reporting the next, the window has no id to be written under; the seat writes it.
  if (!s.sid) return arm($, s)
  if (every === PING_AFTER_MS) await $.store.delete(everyKey(s))
  else await $.store.set(everyKey(s), every)
  await $.store.set(deadlineKey(s), deadline)
  if (s.offs !== offs) {
    // Remove only what this call wrote; a window armed after the off is left alone.
    if ((await $.store.get(deadlineKey(s))) === deadline) {
      await $.store.delete(deadlineKey(s))
      if (!s.deadline) await $.store.delete(everyKey(s))
    }
    return
  }
  await arm($, s)
}

function card(s: State, now: number): string {
  const lines: string[] = []
  lines.push(`${s.lastModel ?? 'model not seen yet'}`)
  if (s.compacted) lines.push('state       reset by compaction, waiting for the first turn')
  else if (s.resumedAt) lines.push(mayBeCold(s, now) ? 'state       unknown, resumed without the time of its last response' : `state       resumed without the time of its last response, warm for up to ${fmtDuration(s.resumedAt + s.ttl - now)} more`)
  else if (!s.lastRequestAt) lines.push('state       no request yet this session')
  else if (isCold(s, now)) lines.push(`state       COLD, last request ${fmtDuration(now - s.lastRequestAt)} ago`)
  else lines.push(`state       warm, ${fmtDuration(s.lastRequestAt + s.ttl - now)} left`)
  lines.push(`cache life  ${ttlLabel(s.ttl)}, from the latest cache write in the transcript`)
  lines.push(`context     ${s.ctx.toLocaleString('en-US')} tokens`)
  lines.push(`cold cost   ${fmtUsd(coldUsd(s))} to re-write it (warm turn ${fmtUsd(warmUsd(s))})`)
  const always = s.always ? ' (always)' : ''
  const idle = s.always ? 'off until the next turn, which arms 6h00m (always)' : 'off (/keepwarm to arm it for 6h00m)'
  lines.push(`keepwarm    ${s.deadline ? (statusText(s, now) ?? '').replace(/^keepwarm /, 'on, ') + always : s.stopped ? `stopped, ${s.stopped}${always}` : idle}`)
  const pings = breakEvenPings(s)
  if (pings != null) lines.push(`break-even  up to ${pings} pings at the read rate cost one cold write, about ${fmtDuration(pings * s.every)} of idle at one ping per ${fmtDuration(s.every)}`)
  lines.push(`guard       ${s.guard === 'refuse' ? 'ask: a cold send waits for Send anyway or Cancel at the ribbon, or is refused once where no ribbon is drawn (/ember guard warn to only show the price)' : 'warn only (/ember guard ask to be asked)'}`)
  const paid = s.misses.reduce((a, m) => a + (m.usd ?? 0), 0)
  lines.push(`session     ${s.misses.length} cold write${s.misses.length === 1 ? '' : 's'} paid, ${fmtUsd(paid)}`)
  return lines.join('\n')
}

export function freshState(): State {
  return {
    hasBand: false, sid: '', deadline: 0, every: PING_AFTER_MS, always: false, lastRequestAt: 0, lastModel: null, ctx: 0, compacted: false,
    resumedAt: 0, transcript: 0, guard: 'refuse', ackedAt: 0, coldWritePending: false, misses: [], pending: null, last: null, stopped: null,
    waitForTurn: false, retries: 0, retryReason: '', gen: 0, tick: 0, offs: 0, turnOffs: null, inFlight: false, stepWrites: null, steps: 0, endingSid: '',
    ttl: TTL_1H, held: null, hasHandoff: false, windows: [], ctxWindow: 0, menu: false, fold: null, keepWindow: 0,
  }
}

let bandRefresh: (() => void) | undefined

/** The ribbon's minutes left count down: redrawn every half minute while a ribbon is seated. */
function seatBand($: EngineInterface) {
  if (!bandRefresh) bandRefresh = $.clock.every(TICK_MS, () => $.ui.invalidate('ui.render'))
}

/** Reads the cache's life from the transcript's tail; re-arms keepwarm and redraws when it changed. */
async function readTtl($: EngineInterface, s: State, transcriptPath: unknown) {
  if (typeof transcriptPath !== 'string' || transcriptPath === '') return
  let ttl: number | null = null
  try {
    const run = await $.process.run(['tail', '-c', String(TAIL_BYTES), transcriptPath], { timeoutMs: 3000 })
    if (run.exitCode === 0) ttl = cacheTtlFromTranscript(run.stdout)
  } catch {
    return
  }
  if (ttl == null || ttl === s.ttl) return
  s.ttl = ttl
  await saveCache($, s)
  if (s.deadline) await arm($, s)
  else updateStatus($, s, await $.clock.now())
}

async function sendHeld($: EngineInterface, s: State) {
  const held = s.held
  if (!held) return
  s.held = null
  s.coldWritePending = true
  $.ui.invalidate('ui.render')
  await $.prompt.submit({ text: held.text, asUser: true })
}

async function cancelHeld($: EngineInterface, s: State) {
  const held = s.held
  if (!held) return
  s.held = null
  $.ui.invalidate('ui.render')
  // The words go back to the prompt box, so nothing typed is lost.
  try {
    await $.prompt.fill({ text: held.text })
  } catch {
    // A host without a prompt box for plugins keeps the text only in the transcript's refusal.
  }
}

/** The held send's question. */
function heldLines(s: State, now: number): string[] {
  const warm = warmUsd(s)
  const lines = [
    `The ${ttlLabel(s.ttl)} cache went cold ${fmtDuration(now - s.lastRequestAt - s.ttl)} ago. Sending now re-writes ${fmtTok(s.ctx)} tokens, about ${fmtUsd(coldUsd(s))}.` +
      (warm == null ? '' : ` While warm, the same send costs about ${fmtUsd(warm)}.`),
  ]
  if (s.hasHandoff && s.ctx >= HANDOFF_HINT_TOKENS) lines.push('Context is large. Run /handoff to carry on in a fresh session instead.')
  return lines
}

// The desktop app hosts Claude Code through the SDK, so session.start sees no
// surface and the app attaches afterwards (session.attach). The ribbon is seated from either.
const drawsBand = (surface: string | null | undefined) => surface === 'terminal' || surface === 'desktop'

/** Whether a ribbon surface is attached already, as when a reload runs session.start in a desktop session. */
async function bandAttached($: EngineInterface): Promise<boolean> {
  try {
    return (await $.session.surfaces()).some(drawsBand)
  } catch {
    return false
  }
}

/** What state the ribbon draws the cache in: it picks Ember's sprite and holds the card's Show or Hide. */
export type Mode = 'WARM' | 'COOLING' | 'COLD' | 'KEPT' | 'WAITING' | 'STOPPED'

export function modeOf(s: State, now: number): Mode {
  if (s.stopped) return 'STOPPED'
  if (!s.lastRequestAt || s.compacted) return 'WAITING'
  if (isCold(s, now)) return 'COLD'
  if (s.deadline) return 'KEPT'
  if (s.ttl > COOLING_MS && s.lastRequestAt + s.ttl - now <= COOLING_MS) return 'COOLING'
  return 'WARM'
}

/** A span the way the ribbon writes it: 42m, 3h, 3h 5m, 1d 9h. */
export function fmtSpan(ms: number): string {
  const mins = Math.max(0, Math.round(ms / 60000))
  if (mins < 60) return `${mins}m`
  const hours = Math.floor(mins / 60)
  if (hours < 24) return mins % 60 ? `${hours}h ${mins % 60}m` : `${hours}h`
  return hours % 24 ? `${Math.floor(hours / 24)}d ${hours % 24}h` : `${Math.floor(hours / 24)}d`
}

/**
 * The tag's fill and the time's colour. Mid-tone on purpose: a Button draws its label in the theme's own text
 * colour (dark in light mode, light in dark mode), and each of these holds 3.5:1 or better against both.
 */
const HUE = { warm: '#C96442', cooling: '#A8741C', cold: '#3D86A8', muted: '#7D786C' } as const
type Hue = keyof typeof HUE

/** The tag beside Ember (its word and hue) and the bold time after it, in the same hue. */
export type Tag = { word: string; hue: Hue; time: string }

/** A keepwarm window as the tag names it: 6H, 90M as 1H 30M. */
export function windowLabel(ms: number): string {
  return fmtSpan(ms).toUpperCase()
}

export function tagOf(s: State, now: number): Tag {
  const mode = modeOf(s, now)
  // While a window keeps the cache warm the tag says KEPT and its window: the mark of a cache held on purpose.
  // The window as it was chosen; after a restart only the time left is known, rounded up to the hour.
  const kept = s.always ? 'KEPT ∞' : `KEPT ${windowLabel(s.keepWindow > 0 ? s.keepWindow : Math.ceil((s.deadline - now) / TTL_1H) * TTL_1H)}`
  if (mode === 'STOPPED') return { word: isCold(s, now) ? 'COLD' : 'WARM', hue: 'muted', time: 'keepwarm stopped' }
  if (mode === 'WAITING') return s.deadline
    ? { word: kept, hue: 'muted', time: 'from your next turn' }
    : { word: 'CACHE', hue: 'muted', time: 'rebuilt next turn' }
  if (mode === 'COLD') {
    const usd = coldUsd(s)
    // A window opened while cold starts with the next send; the time says so, or the choice would seem to do nothing.
    const keeping = s.deadline || s.always ? ' · kept next turn' : ''
    return { word: 'COLD', hue: 'cold', time: `${fmtSpan(now - s.lastRequestAt)}${usd == null ? '' : ` · ${fmtUsd(usd)}`}${keeping}` }
  }
  if (mode === 'KEPT') return { word: kept, hue: 'warm', time: s.always ? 'kept warm' : `${fmtSpan(s.deadline - now)} left` }
  return { word: 'WARM', hue: mode === 'COOLING' ? 'cooling' : 'warm', time: `${fmtSpan(s.lastRequestAt + s.ttl - now)} left` }
}

// ---------- The usage meter: ten rounded squares ----------
const CELLS = 10
/** A narrow band's meter: five squares, a fifth each. */
const FEW_CELLS = 5
const CELL_PX = 10
const CELL_GAP = 1
const CELL_R = 3
const meterWidth = (count: number) => count * CELL_PX + (count - 1) * CELL_GAP
const METER_W = meterWidth(CELLS)

type Level = 'good' | 'mid' | 'low'
/**
 * Three steps of the Keep warm palette: clay while half or more is left (the WARM tag's own colour), amber under
 * half, red under 15%. The percent beside the squares takes the same colour; each reads on the band in both modes.
 */
const LEVEL_HEX: Record<Level, string> = { good: '#C96442', mid: '#C2841F', low: '#D2423A' }
/** The squares used up: a light warm grey in light mode; in dark mode a grey that shows on the band yet stays quiet. */
const CELL_OFF: [string, string] = ['#E2DDD7', '#4A4740']

export function levelOf(left: number): Level {
  return left >= 50 ? 'good' : left >= LOW_AT ? 'mid' : 'low'
}

/** How many squares are lit: to the nearest square (a tenth of ten, a fifth of five), and one whenever anything is left. */
export function litCells(share: number, count = CELLS): number {
  const n = Math.round(Math.max(0, Math.min(1, share)) * count)
  return share > 0 && n === 0 ? 1 : n
}

/** The meter as an SVG: the lit squares in the colour, the rest in the off grey, which follows the app's mode. */
export function cellsSvg(share: number, hex: string, count = CELLS): string {
  const n = litCells(share, count)
  const width = meterWidth(count)
  let lit = ''
  let off = ''
  for (let i = 0; i < count; i++) {
    const cell = `<rect x="${i * (CELL_PX + CELL_GAP)}" width="${CELL_PX}" height="${CELL_PX}" rx="${CELL_R}"/>`
    if (i < n) lit += cell
    else off += cell
  }
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${CELL_PX}" viewBox="0 0 ${width} ${CELL_PX}">` +
    `<style>.o{fill:${CELL_OFF[0]}}@media (prefers-color-scheme: dark){.o{fill:${CELL_OFF[1]}}}</style>` +
    `<g fill="${hex}">${lit}</g><g class="o">${off}</g></svg>`
}

/** The meter in text for the terminal: a square a tenth, or a fifth on a narrow band. */
export function cellsText(share: number, count = CELLS): [string, string] {
  const n = litCells(share, count)
  return ['■'.repeat(n), '□'.repeat(count - n)]
}

// ---------- Text in Outfit, as SVG ----------
// The row is set in Outfit (ribbon's face, SIL OFL, ./font.ts). A Text can only take the app's own type, so the row's
// words are drawn as SVG carrying the font, each sized from Outfit's measured advances (./outfit-metrics.ts).
const TEXT_PX = 14
const LINE_PX = 18
// The baseline that sets Outfit's capitals on the squares' middle line.
const BASELINE = 13.5
/** The theme's secondary and primary text, light then dark, for the words drawn in Outfit. */
const MUTED_HEX: [string, string] = ['#6B6A64', '#A5A49A']
const TEXT_HEX: [string, string] = ['#141413', '#F5F4EE']
/** The pixel width a desktop column stands for: the app's 1ch at its body size. */
const COLUMN_PX = 8.2

type Weight = 400 | 600 | 700
export type Run = { text: string; weight: Weight; color: string | [string, string] } | { cells: number; hex: string; count?: number } | { gap: number }

/** A text's width in Outfit; a glyph Outfit lacks (∞) falls back to the system face and is counted at 0.75em. */
export function outfitWidth(text: string, weight: Weight, px = TEXT_PX): number {
  const table = ADVANCES[weight] ?? {}
  let em = 0
  for (const ch of text) em += table[ch] ?? 0.75
  return em * px
}

/**
 * The tag Button's blanks: enough to span the pill (its word, a pixel of slack, the sm padding each side taken as
 * 8px, the border), counted at the band's 14px, so a press anywhere on the pill lands on the Button. The overshoot is
 * under one blank, well inside the layer's OVERLAY_COLS each side, so the app never cuts the label to "…".
 */
export function tagBlanks(word: string): number {
  const pill = outfitWidth(word, 700) + 1 + 2 * 8 + 2
  return Math.max(1, Math.ceil(pill / (BLANK_EM * TEXT_PX)))
}

function escapeXml(text: string): string {
  return text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
}

/** One line of runs as an SVG in Outfit: words, the ten squares, gaps. A colour that differs by mode rides as a class. */
export function outfitSvg(runs: Run[]): { source: string; width: number; height: number } {
  let x = 0
  let body = ''
  let css = ''
  let classes = 0
  const paint = (color: string | [string, string]) => {
    if (typeof color === 'string') return `fill="${color}"`
    const name = `c${classes++}`
    css += `.${name}{fill:${color[0]}}@media (prefers-color-scheme: dark){.${name}{fill:${color[1]}}}`
    return `class="${name}"`
  }
  for (const run of runs) {
    if ('gap' in run) {
      x += run.gap
    } else if ('cells' in run) {
      const y = (LINE_PX - CELL_PX) / 2
      const count = run.count ?? CELLS
      for (let i = 0; i < count; i++) {
        body += `<rect x="${x + i * (CELL_PX + CELL_GAP)}" y="${y}" width="${CELL_PX}" height="${CELL_PX}" rx="${CELL_R}" ${i < run.cells ? `fill="${run.hex}"` : 'class="o"'}/>`
      }
      x += meterWidth(count)
    } else {
      body += `<text x="${Math.round(x * 100) / 100}" y="${BASELINE}" font-weight="${run.weight}" ${paint(run.color)} xml:space="preserve">${escapeXml(run.text)}</text>`
      x += outfitWidth(run.text, run.weight)
    }
  }
  const width = Math.ceil(x) + 1
  const source = `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${LINE_PX}" viewBox="0 0 ${width} ${LINE_PX}">` +
    `<style>@font-face{font-family:Outfit;font-weight:100 900;src:url(data:font/woff2;base64,${SANS}) format('woff2')}` +
    `text{font-family:Outfit,system-ui,sans-serif;font-size:${TEXT_PX}px}` +
    `.o{fill:${CELL_OFF[0]}}@media (prefers-color-scheme: dark){.o{fill:${CELL_OFF[1]}}}${css}</style>${body}</svg>`
  return { source, width, height: LINE_PX }
}

/**
 * What a row takes on the terminal, in cells, to choose the widest form that fits on one line. The desktop measures
 * its Outfit drawings in pixels instead (outfitWidth) against the band's columns at 1ch each (COLUMN_PX).
 */
export function roomOf(surface: string, columns: number) {
  return surface !== 'terminal'
    ? { width: columns - 2, gap: 2, small: 1, bar: (count: number) => meterWidth(count) / 7.5, sprite: 3, text: (t: string, bold = false) => t.length * (bold ? 1 : 0.92), button: (t: string) => t.length * 0.92 + 3 }
    : { width: columns - 4, gap: 2, small: 1, bar: (count: number) => count, sprite: 0, text: (t: string, _bold = false) => t.length, button: (t: string) => t.length + 4 }
}

// ---------- Ember, the pixel flame: 11 × 11, one path per colour ----------
type Sprite = 'flame' | 'cooling' | 'cold' | 'keep'
const SPRITES: Record<Sprite, string[]> = {
  flame: ['.....O.....', '.....OO....', '....OOO....', '...OOOOO.O.', '..OOOIOOOO.', '..OOIIIOO..', '.OOIIIIIOO.', '.OIEIIIEIO.', '.OIIIIIIIO.', '.OOIIIIIOO.', '..OOOOOOO..'],
  cooling: ['...........', '...........', '...........', '.....O.....', '...OOOO....', '..OOOIOOO..', '.OOIIIIIOO.', '.OIEIIIEIO.', '.OIIIIIIIO.', '.OOIIIIIOO.', '..OOOOOOO..'],
  cold: ['...........', '......S....', '.....S.....', '......S....', '.....S.....', '...........', '...........', '...CCCCC...', '..CCCCGCC..', '.CCZZCZZCC.', '..CCCCCCC..'],
  keep: ['..........K', '.....O.....', 'K....OO....', '....OOO....', '...OOOOO.O.', '..OOOIOOOO.', '..OOIIIOO..', '.OOIIIIIOO.', '.OIEIIIEIO.', '.OOIIIIIOO.', 'LLLLLLLLLLL'],
}
const PIXEL: Record<string, string> = { O: 'outer', I: 'inner', E: 'eye', C: 'coal', Z: 'zz', G: 'glow', S: 'smoke', L: 'log', K: 'spark' }

function pixelPaths(rows: string[]): Record<string, string> {
  const d: Record<string, string> = {}
  rows.forEach((row, y) => [...row].forEach((ch, x) => {
    const k = PIXEL[ch]
    if (k) d[k] = (d[k] ?? '') + `M${x} ${y}h1v1h-1z`
  }))
  return d
}

export function spriteOf(mode: Mode, s: State, now: number): Sprite {
  if (mode === 'COLD' || (mode === 'STOPPED' && isCold(s, now))) return 'cold'
  if (mode === 'KEPT') return 'keep'
  if (mode === 'COOLING' || mode === 'WAITING') return 'cooling'
  return 'flame'
}

/** The flame as an SVG: it bobs and blinks while lit, the coal sleeps and smokes. SMIL only, so the Svg needs isInteractive. */
export function spriteSvg(kind: Sprite, size: number): string {
  const d = pixelPaths(SPRITES[kind])
  const outer = kind === 'cooling' ? '#C9853A' : '#E8743B'
  const inner = kind === 'cooling' ? '#E9C47A' : '#F8C25C'
  const path = (p: string | undefined, fill: string) => (p ? `<path d="${p}" fill="${fill}"/>` : '')
  const ease = 'calcMode="spline" keyTimes="0;0.5;1" keySplines=".45 0 .55 1;.45 0 .55 1"'
  const bob = kind === 'cold' ? '' : `<animateTransform attributeName="transform" type="translate" values="0 0;0 -0.7;0 0" dur="${kind === 'cooling' ? '2.6s' : '1.2s'}" repeatCount="indefinite" ${ease}/>`
  let body = path(d.log, '#7A5235')
  if (d.smoke) body += `<g opacity="0">${path(d.smoke, SMOKE)}<animate attributeName="opacity" values="0;.85;0" dur="2.8s" repeatCount="indefinite"/><animateTransform attributeName="transform" type="translate" values="0 1;0 -1.5" dur="2.8s" repeatCount="indefinite"/></g>`
  if (d.spark) body += `<g>${path(d.spark, '#F8C25C')}<animate attributeName="opacity" values="1;0" dur=".9s" calcMode="discrete" repeatCount="indefinite"/></g>`
  const blink = d.eye ? `<path d="${d.eye}" fill="${inner}" opacity="0"><animate attributeName="opacity" values="0;0;1;1;0" keyTimes="0;0.9;0.91;0.95;1" dur="3.4s" repeatCount="indefinite"/></path>` : ''
  body += `<g>${bob}${path(d.outer, outer)}${path(d.inner, inner)}${path(d.coal, '#5D5A52')}${path(d.glow, '#A2472A')}${path(d.eye, INK)}${path(d.zz, INK)}${blink}</g>`
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${size}" height="${size}" viewBox="0 0 11 11" shape-rendering="crispEdges">${body}</svg>`
}

// ---------- Usage windows, after ribbon ----------
const WINDOW_NAMES: Record<string, string> = { seven_day: '7D', five_hour: '5H', spend_limit: 'SPEND' }
const WINDOW_ORDER: Record<string, number> = { seven_day: 0, five_hour: 1 }

export function cleanWindows(list: readonly UsageWindow[]): UsageWindow[] {
  return list
    .map(w => ({ kind: w.kind, percentUsed: w.percentUsed, resetsAt: w.resetsAt }))
    .sort((a, b) => (WINDOW_ORDER[a.kind] ?? 9) - (WINDOW_ORDER[b.kind] ?? 9))
}

export function fmtReset(iso: string | undefined, now: number): string {
  if (!iso) return ''
  const ms = Date.parse(iso) - now
  if (Number.isNaN(ms)) return ''
  return ms <= 0 ? 'resetting' : fmtSpan(ms)
}

/** A model id as the card names it: claude-opus-5-5 is OPUS 5.5. */
export function modelName(model: string | null): string {
  const m = /(fable|mythos|opus|sonnet|haiku)[-\s]?(\d+)(?:[-.](\d+))?/.exec((model ?? '').toLowerCase())
  if (!m) return (model ?? 'this model').toUpperCase()
  return `${m[1].toUpperCase()} ${m[2]}${m[3] && m[3].length < 3 ? '.' + m[3] : ''}`
}

// The band-stack order the mods above the prompt share (Handoff 1.1.0 and Backstage too): each returns one column Box
// keyed STACK holding one keyed card per mod, flattens the STACK it gets from the mods beneath, adds its card and
// sorts by rank. A small rank sits higher; a piece no mod knows (another mod's, the app's) sits in the middle;
// Ember nearest the prompt.
const STACK = 'band-stack'
const RANK: Record<string, number> = { handoff: 10, backstage: 20, ember: 90 }
const UNKNOWN_RANK = 50

type StackNode = { type?: unknown; props?: { key?: unknown }; children?: unknown }

/**
 * The pieces the mods beneath drew: a STACK's cards, else the tree whole. A piece that draws nothing is left out,
 * or the column's gap would open beside it; the engine's own node stays (it is a slot, drawn as nothing when empty).
 */
export function stackPieces(rest: unknown): unknown[] {
  if (rest === null || rest === undefined || rest === false) return []
  const node = rest as StackNode
  const list = typeof rest === 'object' && node.type === 'Box' && node.props?.key === STACK && Array.isArray(node.children) ? node.children : [rest]
  return list.filter(piece => (piece as StackNode)?.type === 'engine' || shows(piece))
}

export function rankOf(piece: unknown): number {
  const key = typeof piece === 'object' && piece !== null ? (piece as StackNode).props?.key : undefined
  return typeof key === 'string' ? (RANK[key] ?? UNKNOWN_RANK) : UNKNOWN_RANK
}

/** Whether a tree draws anything a person sees: empty text and empty boxes take no room. */
function shows(el: unknown): boolean {
  if (typeof el === 'string') return el.trim() !== ''
  if (el === null || typeof el !== 'object') return false
  const type = (el as { type?: unknown }).type
  if (type !== 'Box' && type !== 'Text' && type !== 'fragment') return true
  const children = (el as { children?: unknown }).children
  return Array.isArray(children) && children.some(shows)
}

function redraw($: EngineInterface, s: State) {
  if (s.hasBand) $.ui.invalidate('ui.render')
}

/** A Keep warm choice: the same window /keepwarm <window> opens. */
async function keepFor($: EngineInterface, s: State, ms: number) {
  s.menu = false
  await startWindow($, s, ms, PING_AFTER_MS)
  redraw($, s)
}

/** Keep warm Always: /keepwarm always. */
async function keepAlways($: EngineInterface, s: State) {
  s.menu = false
  s.always = true
  await $.store.set(KEY_ALWAYS, true)
  await startWindow($, s, DEFAULT_WINDOW_MS, PING_AFTER_MS)
  redraw($, s)
}

/** Keep warm Stop: /keepwarm off. */
async function keepOff($: EngineInterface, s: State) {
  s.menu = false
  await stop($, s, null, true)
  redraw($, s)
}

function toggleMenu($: EngineInterface, s: State) {
  s.menu = !s.menu
  redraw($, s)
}

function toggleFold($: EngineInterface, s: State, mode: Mode, open: boolean) {
  s.fold = { mode, open: !open }
  redraw($, s)
}

export const register: Register = on => {
  const s = freshState()

  // Ember's own ribbon, a rounded card of the page's colour, drawn under whatever the plugins beneath drew, so it
  // sits nearest the prompt. Its row: each usage window's bar, percent and reset; Ember; the tag (it opens Keep
  // warm) and its time; Show. Under the row, as asked: the held send's question, the Keep warm choices, the card.
  on('ui.render', { component: 'AbovePrompt' }, async ($, e, next) => {
    const rest = await next(e)
    if (!s.hasBand || e.props.hasSurvey) return rest
    const now = await $.clock.now()
    const ui = $.ui.resolve(e)
    const { Box, Text, Button } = ui
    // Svg draws on the desktop; the terminal gets the text form.
    const Svg = e.surface !== 'terminal' && 'Svg' in ui ? ui.Svg : null
    // Every Text says how it wraps: an inner Text left alone wraps by itself, whatever its parent says.
    const T = (props: Record<string, unknown>, text: string) => Text({ ...props, wrap: 'truncate-end', children: [text] })

    const expired = s.deadline > 0 && now >= s.deadline
    const hasCache = s.lastRequestAt > 0 || s.deadline > 0 || s.stopped !== null
    const showCache = Boolean(s.held || (hasCache && !expired))
    if (!showCache && s.windows.length === 0) return rest

    const mode = modeOf(s, now)
    const tag = tagOf(s, now)
    const hue = HUE[tag.hue]
    const hasRequest = s.lastRequestAt > 0 && !s.compacted
    const stored = s.fold && s.fold.mode === mode ? s.fold.open : mode === 'COLD'
    const open = showCache && hasRequest && !s.held && stored
    const showFold = showCache && hasRequest && !s.held
    const foldLabel = open ? 'Hide' : 'Show'
    // The word alone: the whole tag presses, no arrow needed.
    const tagLabel = tag.word

    const windows = s.windows.map(w => {
      const left = Math.max(0, Math.min(100, Math.round(100 - w.percentUsed)))
      return { kind: w.kind, name: WINDOW_NAMES[w.kind] ?? w.kind.toUpperCase(), left, level: levelOf(left), reset: fmtReset(w.resetsAt, now) }
    })
    type Win = (typeof windows)[number]
    // The widest form that fits one row: 0 all of it, 1 the meter down to five squares,
    // 2 without the reset times, 3 without the squares too; past that, usage on a row of its own above the cache.
    const columns = e.props.bodyColumns ?? e.viewport?.columns ?? 100
    const cellsAt = (lvl: number) => (lvl === 0 ? CELLS : lvl <= 2 ? FEW_CELLS : 0)
    const resetAt = (lvl: number) => lvl <= 1
    const pctText = (w: Win) => `${w.left}%`
    const lowText = (w: Win) => (w.left < LOW_AT ? ' LOW' : '')
    const resetText = (w: Win) => (w.reset ? ` · ${w.reset}` : '')
    // Desktop: pixels, from Outfit's advances and the drawings' own sizes, against the band's columns at 1ch each.
    // Terminal: cells, as the text is drawn there.
    const room = roomOf(e.surface, columns)
    const winWidth = (w: Win, lvl: number) => {
      const count = cellsAt(lvl)
      return Svg
        ? outfitWidth(w.name, 600) + 6 + (count ? meterWidth(count) + 6 : 0) + outfitWidth(pctText(w) + lowText(w), 700) + (resetAt(lvl) ? outfitWidth(resetText(w), 400) : 0)
        : room.text(w.name, true) + room.small + (count ? room.bar(count) + room.small : 0) + room.text(pctText(w) + lowText(w), true) + (resetAt(lvl) ? room.text(resetText(w)) : 0)
    }
    const cacheWidth = () => Svg
      ? 20 + 8 + outfitWidth(tagLabel, 700) + 18 + 8 + outfitWidth(tag.time, 700) + (showFold ? 20 + foldLabel.length * 8 + 26 : 0)
      : room.sprite + room.small + room.button(tagLabel) + room.small + room.text(tag.time, true) + (showFold ? room.gap + room.button(foldLabel) : 0)
    const gap = Svg ? 20 : room.gap
    const width = Svg ? columns * COLUMN_PX - 8 : room.width
    const widthAt = (lvl: number, withCache = showCache) => {
      const parts = windows.map(w => winWidth(w, lvl))
      if (withCache) parts.push(cacheWidth())
      return parts.reduce((a, b) => a + b, 0) + gap * Math.max(0, parts.length - 1)
    }
    const level = [0, 1, 2, 3].find(lvl => widthAt(lvl) <= width) ?? 4
    // On a row of its own, usage takes the widest of its forms that fits there.
    const usageLevel = [0, 1, 2].find(lvl => widthAt(lvl, false) <= width) ?? 3

    // Outfit as one drawing per piece: a usage window (its name, squares, percent and reset) is one SVG.
    const outfit = (runs: Run[], alt: string) => {
      const art = outfitSvg(runs)
      return Svg ? Svg({ source: art.source, alt, width: art.width, height: art.height }) : null
    }
    const usageItems = (lvl: number): RenderElement[] => windows.map(w => {
      const count = cellsAt(lvl)
      const reset = w.reset && resetAt(lvl)
      const alt = `${w.name} ${w.left}% left${lowText(w)}${reset ? `, resets in ${w.reset}` : ''}`
      const drawn = outfit([
        { text: w.name, weight: 600, color: MUTED_HEX },
        { gap: 6 },
        ...(count ? [{ cells: litCells(w.left / 100, count), hex: LEVEL_HEX[w.level], count }, { gap: 6 }] : []),
        { text: pctText(w), weight: 700, color: LEVEL_HEX[w.level] },
        ...(lowText(w) ? [{ text: lowText(w), weight: 700 as const, color: TEXT_HEX }] : []),
        ...(reset ? [{ text: resetText(w), weight: 400 as const, color: MUTED_HEX }] : []),
      ], alt)
      if (drawn) return Box({ key: `w-${w.kind}`, flexDirection: 'row', alignItems: 'center', flexShrink: 0, children: [drawn] })
      const [lit, unlit] = cellsText(w.left / 100, count || CELLS)
      return Box({ key: `w-${w.kind}`, flexDirection: 'row', alignItems: 'center', columnGap: 'sm', flexShrink: 0, children: [
        T({ color: MUTED, bold: true }, w.name),
        ...(count ? [Box({ flexDirection: 'row', flexShrink: 0, children: [T({ color: LEVEL_HEX[w.level] }, lit), T({ color: MUTED }, unlit)] })] : []),
        Box({ flexDirection: 'row', flexShrink: 0, children: [
          T({ color: LEVEL_HEX[w.level], bold: true }, pctText(w)),
          ...(lowText(w) ? [T({ color: TEXT, bold: true }, lowText(w))] : []),
          ...(reset ? [T({ color: MUTED }, resetText(w))] : []),
        ] }),
      ] })
    })
    const word = outfit([{ text: tagLabel, weight: 700, color: TAG_INK }], tagLabel)
    const time = outfit([{ text: tag.time, weight: 700, color: hue }], tag.time)
    const cacheItems = (): RenderElement[] => !showCache ? [] : [
      Box({ key: 'ember-status', flexDirection: 'row', alignItems: 'center', columnGap: 'sm', flexShrink: 0, children: [
        ...(Svg ? [Svg({ source: spriteSvg(spriteOf(mode, s, now), 20), alt: `Ember, ${tag.word.toLowerCase()}`, width: 20, height: 20, isInteractive: true })] : []),
        // The tag. A desktop Button draws only its label, in the app's regular type, so the pill draws its own bold
        // Outfit word and a chrome-less Button lies over the whole pill: blank cells for a label, clipped to the pill,
        // so any press on the pill opens Keep warm and the pointer over it lights it. The terminal draws the Button.
        // The app cuts a label wider than its room and draws "…" (its [data-press-label] rule), so the label must fit:
        // the layer under the Button reaches OVERLAY_COLS past each side of the pill, and the label is just enough
        // blanks to span the pill (tagBlanks), so it covers the pill and still fits the layer.
        word
          ? Box({ key: 'ember-tag', position: 'relative', borderStyle: 'single', borderColor: hue, backgroundColor: hue, paddingX: 'sm', paddingY: 0, overflow: 'hidden', flexShrink: 0, children: [
              Box({ key: 'ember-word', flexShrink: 0, alignItems: 'center', children: [word] }),
              Box({ key: 'ember-press', position: 'absolute', top: 0, left: -OVERLAY_COLS, right: -OVERLAY_COLS, bottom: 0, flexDirection: 'row', alignItems: 'center', justifyContent: 'center', children: [
                Button({ key: 'ember-keep', label: BLANK.repeat(tagBlanks(tagLabel)), plain: true, onPress: () => { toggleMenu($, s) } }),
              ] }),
            ] })
          : Box({ key: 'ember-tag', flexShrink: 0, children: [Button({ key: 'ember-keep', label: tagLabel, plain: true, onPress: () => { toggleMenu($, s) } })] }),
        Box({ key: 'ember-time', flexShrink: 0, children: [time ?? T({ color: hue, bold: true }, tag.time)] }),
      ] }),
      Box({ key: 'grow', flexGrow: 1 }),
      // Show sits on a ground of the page's colour, a shade off the band so it reads as a control (white in light mode).
      ...(showFold ? [Box({ key: 'ember-show', flexShrink: 0, ...(Svg ? { borderStyle: 'single', borderColor: 'clawd_background', backgroundColor: 'clawd_background', paddingX: 0, paddingY: 0 } : {}), children: [
        Button({ key: 'ember-fold', label: foldLabel, plain: true, dimColor: true, onPress: () => { toggleFold($, s, mode, open) } }),
      ] })] : []),
    ]
    const line = (key: string, children: RenderElement[]) =>
      Box({ key, flexDirection: 'row', alignItems: 'center', flexWrap: 'nowrap', columnGap: 'lg', children })
    // Hairlines for an open band, as ribbon draws them: a filled Box a pixel thick. The desktop sizes a Box's height in
    // lines (lh) and its width in columns (ch), fractions admitted, so 0.05 of a line and 0.12 of a column are each
    // about a pixel at the band's type.
    const hrule = (key: string) => Box({ key, flexDirection: 'column', paddingY: 'xs', children: [
      Box({ width: '100%', height: 0.05, backgroundColor: RULE }),
    ] })
    const vrule = (key: string) => Box({ key, width: 0.12, flexShrink: 0, backgroundColor: RULE })
    const rows = level <= 3
      ? [line('row', [...usageItems(level), ...cacheItems()])]
      : [...(windows.length ? [line('row-usage', usageItems(usageLevel))] : []), ...(showCache ? [line('row-cache', cacheItems())] : [])]

    const sections: RenderElement[] = []
    // On the desktop a hairline parts the row from what opens under it, so the open part keeps no padding of its own.
    const section = (key: string, children: RenderElement[]) =>
      Box({ key, flexDirection: 'column', rowGap: 'sm', ...(Svg ? {} : { paddingTop: 'sm' as const }), children })

    if (s.held) {
      const [first, ...more] = heldLines(s, now)
      sections.push(section('held', [
        Box({ flexDirection: 'row', columnGap: 'sm', alignItems: 'center', children: [
          // Drawn in Outfit like the tag, so its word takes the same ink in each mode.
          Svg ? Box({ borderStyle: 'single', borderColor: HUE.cold, backgroundColor: HUE.cold, paddingX: 'sm', paddingY: 0, alignItems: 'center', children: [outfit([{ text: 'HELD', weight: 700, color: TAG_INK }], 'HELD')!] }) : T({ color: HUE.cold, bold: true }, 'HELD'),
          T({ color: TEXT, bold: true }, 'Your message is waiting'),
        ] }),
        Text({ color: TEXT, children: [first ?? ''] }),
        ...more.map(text => Text({ color: MUTED, children: [text] })),
        Box({ flexDirection: 'row', columnGap: 'sm', children: [
          Button({ key: 'ember-send', label: 'Send anyway', variant: 'primary', hotkey: '1', onPress: () => { void sendHeld($, s) } }),
          Button({ key: 'ember-cancel', label: 'Cancel', hotkey: '2', onPress: () => { void cancelHeld($, s) } }),
        ] }),
      ]))
    }

    if (showCache && s.menu) {
      // The windows alone, written as the tag writes them (1H), with no price beside them.
      const choices = KEEP_CHOICES.map(([name, ms]) =>
        Button({ key: `ember-keep-${name}`, label: name.toUpperCase(), onPress: () => { void keepFor($, s, ms) } }))
      choices.push(Button({ key: 'ember-keep-always', label: 'Always', onPress: () => { void keepAlways($, s) } }))
      if (s.deadline || s.always) choices.push(Button({ key: 'ember-keep-off', label: 'Stop', onPress: () => { void keepOff($, s) } }))
      const note = s.ttl < MIN_KEEPWARM_TTL ? `The cache lives ${ttlLabel(s.ttl)} now, so no pings go out until a 1h cache write is seen.`
        : isCold(s, now) ? `The cache is cold, so the first ping comes ${fmtSpan(s.every)} after your next turn. After that, one tiny ping every ${fmtSpan(s.every)} keeps it read, not re-written.`
        : `One tiny ping every ${fmtSpan(s.every)} keeps the cache from going cold.`
      sections.push(section('keep', [
        T({ color: MUTED, bold: true, size: 'caption' }, 'KEEP WARM FOR'),
        Box({ flexDirection: 'row', flexWrap: 'wrap', columnGap: 'sm', rowGap: 'sm', children: choices }),
        Text({ color: MUTED, size: 'footnote', children: [note] }),
      ]))
    }

    if (open) {
      const cold = mode === 'COLD'
      const idle = now - s.lastRequestAt
      const share = s.ctxWindow > 0 ? Math.min(1, s.ctx / s.ctxWindow) : 0
      const warm = warmUsd(s)
      const coldCost = coldUsd(s)
      // Each of the three zones gets a third of the band, less the gaps either side of its hairlines; too little
      // room for ten squares takes five, as the row does.
      const zoneRoom = Svg ? (width - 66) / 3 : (width - 4) / 3
      const cardCells = zoneRoom < (Svg ? METER_W : CELLS) ? FEW_CELLS : CELLS
      const bar = (part: number, alt: string) => {
        const [lit, unlit] = cellsText(part, cardCells)
        return Svg ? Svg({ source: cellsSvg(part, hue, cardCells), alt, width: meterWidth(cardCells), height: CELL_PX })
          : Box({ flexDirection: 'row', children: [T({ color: hue }, lit), T({ color: MUTED }, unlit)] })
      }
      const zone = (key: string, label: string, big: string, under: RenderElement, note: string) =>
        Box({ key, flexDirection: 'column', flexGrow: 1, flexShrink: 1, minWidth: 0, rowGap: 'xs', children: [
          T({ color: MUTED, bold: true, size: 'caption' }, label),
          T({ color: TEXT, size: 'heading', weight: 'semibold' }, big),
          under,
          Text({ color: MUTED, size: 'footnote', children: [note] }),
        ] })
      const keepNote = statusText(s, now)
      const idleNote = keepNote ?? (cold ? `went cold ${fmtSpan(idle - s.ttl)} ago` : `goes cold in ${fmtSpan(s.ttl - idle)}`)
      const zones = [
        zone('idle', 'IDLE', fmtSpan(idle), bar(cold ? 1 : idle / s.ttl, cold ? 'cold' : `${Math.round(idle / s.ttl * 100)}% of the cache life gone`), idleNote),
        zone('size', cold ? 'RE-CACHE' : 'IN CACHE', `${fmtTok(s.ctx)} tokens`, bar(share, `${Math.round(share * 100)}% of the context`),
          s.ctxWindow > 0 ? `${Math.round(share * 100)}% of the ${fmtTok(s.ctxWindow)} context` : 'context window not reported yet'),
        zone('cost', `NEXT · ${modelName(s.lastModel)}`, fmtUsd(cold ? coldCost : warm),
          Box({ flexDirection: 'row', children: [T({ color: HUE.warm, bold: true }, 'warm '), T({ color: TEXT }, fmtUsd(warm)), T({ color: MUTED }, '  ·  '), T({ color: HUE.cold, bold: true }, 'cold '), T({ color: TEXT }, fmtUsd(coldCost))] }),
          cold ? 'Re-writes the whole cache.' : 'Reads the cache.'),
      ]
      // The desktop parts the zones with upright hairlines the full height of the card.
      sections.push(Box({ key: 'card', flexDirection: 'row', columnGap: 'lg', ...(Svg ? { alignItems: 'stretch' as const } : { paddingTop: 'sm' as const }),
        children: Svg ? zones.flatMap((z, i) => (i ? [vrule(`card-rule-${i}`), z] : [z])) : zones }))
    }

    // The app gives every plugin one band (rounded, its own fill and padding), so Ember draws no fill of its own: a
    // second colour inside the band reads as a patch. The band's pieces follow the shared band-stack order, so Ember
    // sits nearest the prompt whichever order the app chains the plugins in.
    const opened = Svg ? sections.flatMap((part, i) => [hrule(`rule-${i}`), part]) : sections
    const ribbon = Box({ key: 'ember', flexDirection: 'column', rowGap: 'xs', children: [...rows, ...opened] })
    const pieces = [ribbon, ...stackPieces(rest)].sort((a, b) => rankOf(a) - rankOf(b))
    return Box({ key: STACK, flexDirection: 'column', rowGap: 'sm', children: pieces as RenderElement[] })
  })

  // The usage windows and the context window move with each response the engine measures.
  on('session.measure', async ($, e, next) => {
    const r = await next(e)
    if (e.changed.includes('rateLimits')) s.windows = cleanWindows(e.rateLimits)
    if (e.changed.includes('context') && e.context.window) s.ctxWindow = e.context.window
    redraw($, s)
    return r
  })

  // The desktop app attaching after session.start seats the ribbon then.
  on('session.attach', async ($, e, next) => {
    const r = await next(e)
    if (!s.hasBand && drawsBand(e.surface)) {
      s.hasBand = true
      $.ui.status(undefined)
      seatBand($)
      $.ui.invalidate('ui.render')
    }
    return r
  })

  on('session.start', async ($, e, next) => {
    const r = await next(e)
    s.hasBand = drawsBand(e.surface) || await bandAttached($)
    if (s.hasBand) {
      $.ui.status(undefined)
      seatBand($)
    }
    const now = await seat($, s)
    await prune($, s, now)
    await restoreCache($, s, now)
    const saved = await $.store.get(deadlineKey(s))
    const savedEvery = await $.store.get(everyKey(s))
    const savedGuard = await $.store.get(KEY_GUARD)
    s.deadline = typeof saved === 'number' && saved > now ? saved : 0
    s.every = typeof savedEvery === 'number' && savedEvery >= MIN_PING_MS && savedEvery < TTL_1H ? savedEvery : PING_AFTER_MS
    s.guard = savedGuard === 'warn' ? 'warn' : 'refuse'
    s.always = (await $.store.get(KEY_ALWAYS)) === true
    // Always means a fresh default window every session, whatever the last one left behind.
    if (s.always) await startWindow($, s, DEFAULT_WINDOW_MS, PING_AFTER_MS)
    // The classic start arms a restored window too, but a managed plugin above this tier may continue beneath it; arming twice leaves one timer.
    else if (s.deadline) await arm($, s)
    await $.command.register({
      name: 'keepwarm',
      description: 'Keep the prompt cache warm: bare for 6h, a window such as 90m, always, off, or status (ember)',
      argumentHint: '[6h | always | off | status]',
      immediate: true,
    })
    await $.command.register({
      name: 'ember',
      description: 'Prompt cache state, cold price and this session\'s cold writes; guard ask|warn (ember)',
      argumentHint: '[status | guard ask | guard warn]',
      immediate: true,
    })
    // Another cache guard installed beside this one would warn about or hold a cold send twice.
    const commands = await $.command.list()
    if (commands.some(c => c.name === 'cache-tax' || c.name === 'cache-tax:status')) {
      $.ui.log('cache-tax is also on, so a cold send is held twice. Turn cache-tax off, or /ember guard warn here.')
    }
    updateStatus($, s, now)
    return r
  })

  // On Team and Enterprise accounts a managed plugin seated above this tier handles classic.* and continues beneath it, so
  // nothing here is relied on alone: session.end carries the /clear, turn.step the compaction, and the engine's own figures
  // the resumed context. What arrives here refines that, once: a clear already ended is only seated, a seat is never redone.
  on('session.end', async ($, e, next) => {
    // Only the conversation this state sits in: after the classic start of the next one, the old id is history.
    if ((e.reason === 'clear' || e.reason === 'resume') && e.sessionId === s.sid) await endConversation($, s, e.reason)
    return next(e)
  })

  // Resume fields seed the guard before any turn of the resumed session has run.
  on('classic.SessionStart', async ($, e, next) => {
    const r = await next(e)
    // A resumed or cleared conversation is not the one a ping in flight was sent for.
    outdate(s)
    // The conversation moved under this state without session.end reaching it: the payload names another id, or a
    // clear names none. One that already seated the new id (a command ran first) is left as it is.
    if (s.sid && (e.session_id === undefined ? e.source === 'clear' : e.session_id !== s.sid)) await endConversation($, s, e.source === 'clear' ? 'clear' : 'resume')
    // No session.start fires after /clear, so this is where always arms the new conversation.
    await reseat($, s)
    if (e.source === 'clear') return r
    // The resumed transcript's last cache write says how long the cache lives before the first turn's comes.
    await readTtl($, s, (e as { transcript_path?: unknown }).transcript_path)
    const line = seedFromResume(s, e, await $.clock.now())
    if (line) $.ui.log(line)
    // The seeded clock decides whether a restored or always window pings before the first turn: never when it is cold.
    await arm($, s)
    return r
  })

  // Each turn's end: the transcript now holds its responses, the newest cache write among them says 5m or 1h.
  on('classic.Stop', async ($, e, next) => {
    const r = await next(e)
    await readTtl($, s, (e as { transcript_path?: unknown }).transcript_path)
    return r
  })

  on('command.run', { command: 'keepwarm' }, async ($, e) => {
    await reseat($, s)
    const words = String(e.args ?? '').trim().split(/\s+/).filter(Boolean)
    const now = await $.clock.now()
    if (words[0] === 'off') {
      const wasAlways = s.always
      await stop($, s, null, true)
      return { text: wasAlways ? 'keepwarm is off, and always is off for every session from its next turn' : 'keepwarm is off' }
    }
    if (words[0] === 'always') {
      s.always = true
      await $.store.set(KEY_ALWAYS, true)
      await startWindow($, s, DEFAULT_WINDOW_MS, PING_AFTER_MS)
      const cold = isCold(s, now) ? `. The cache is cold now, so the first ping comes ${fmtDuration(s.every)} after the next turn` : ''
      return { text: `keepwarm always on: every session stays warm until ${fmtDuration(DEFAULT_WINDOW_MS)} after its last turn; /keepwarm off turns it off for good${cold}` }
    }
    if (!words.length) {
      await startWindow($, s, DEFAULT_WINDOW_MS, PING_AFTER_MS)
      return { text: armedText(s, now, DEFAULT_WINDOW_MS) }
    }
    if (words[0] !== 'status') {
      const window = parseDuration(words[0])
      if (!window) return { text: 'keepwarm takes a window such as 6h or 90m, or always, off, or status' }
      // "every 2m" is a testing knob and lasts only for the window it was given with.
      let every = PING_AFTER_MS
      if (words[1] === 'every') {
        const period = parseDuration(words[2] ?? '')
        // A period of the cache's whole hour or more would fire only once the cache is already cold.
        if (period == null || period < MIN_PING_MS || period >= TTL_1H) return { text: 'every takes a period from 1m to 59m' }
        every = period
      }
      await startWindow($, s, window, every)
      const rolls = s.always && (window < DEFAULT_WINDOW_MS || every !== PING_AFTER_MS)
      return { text: armedText(s, now, window) + (rolls ? `. Always is on, so your next turn makes it at least ${fmtDuration(DEFAULT_WINDOW_MS)} at one ping per ${fmtDuration(PING_AFTER_MS)}` : '') }
    }
    return { text: statusText(s, now) ?? 'keepwarm is off' }
  })

  on('command.run', { command: 'ember' }, async ($, e) => {
    await reseat($, s)
    const words = String(e.args ?? '').trim().split(/\s+/).filter(Boolean)
    const now = await $.clock.now()
    if (words[0] === 'guard') {
      // "refuse" is the stored name of ask, kept from cache-tax.
      if (words[1] !== 'warn' && words[1] !== 'ask' && words[1] !== 'refuse') return { text: '/ember guard takes ask or warn' }
      s.guard = words[1] === 'warn' ? 'warn' : 'refuse'
      await $.store.set(KEY_GUARD, s.guard)
      return { text: s.guard === 'refuse' ? 'guard set to ask: a cold send waits for Send anyway or Cancel at the ribbon (refused once where no ribbon is drawn)' : 'guard set to warn: a cold send goes through with its price shown' }
    }
    return { text: card(s, now) }
  })

  // The message that pays. Only its first character is read.
  on('prompt.submit', async ($, e, next) => {
    if (e.origin.kind === 'plugin') return next(e)
    await reseat($, s)
    if (typeof e.text !== 'string' || e.text.trimStart().startsWith('/')) return next(e)
    // A new message replaces a question still open for an earlier one.
    if (s.held) {
      s.held = null
      $.ui.invalidate('ui.render')
    }
    const now = await $.clock.now()
    // Without the time of the last response nothing says whether the cache is cold: the price is shown once and the message goes through.
    if (s.resumedAt) {
      const cold = mayBeCold(s, now)
      s.resumedAt = 0
      if (cold && s.ctx >= BIG_TOKENS) $.ui.log(unknownText(s))
      return next(e)
    }
    if (!isCold(s, now) || s.ctx < BIG_TOKENS) return next(e)
    // A refused prompt that no person sent would be lost: nobody is there to send it again.
    const unattended = UNATTENDED.has(e.origin.kind)
    if (s.guard === 'warn' || unattended) {
      $.ui.log(`${guardText(s, now)} Sending anyway${unattended ? `, since this ${e.origin.kind} prompt cannot be sent again` : ''}.`)
      s.coldWritePending = true
      return next(e)
    }
    // With a band the send waits for the person's answer there; a prompt with attachments cannot be sent again
    // as theirs, so it keeps the refuse-once form.
    if (s.hasBand && !e.attachments?.length) {
      s.hasHandoff = (await $.command.list()).some(c => c.name === 'handoff')
      s.held = { text: e.text, at: now }
      $.ui.invalidate('ui.render')
      return { drop: 'ember: the cache is cold. Choose Send anyway or Cancel in the ribbon above the prompt.' }
    }
    if (s.ackedAt === s.lastRequestAt) {
      s.ackedAt = 0
      s.coldWritePending = true
      return next(e)
    }
    s.ackedAt = s.lastRequestAt
    return { drop: `ember: ${guardText(s, now)} Send it again to pay it. Or /clear and start from a note.` }
  })

  on('turn.step', async function* ($, e, next) {
    if (!e.agentId) {
      await reseat($, s)
      // The off count when the turn's first request went out: an off after it wins over what the turn opens.
      if (e.index === 0) s.turnOffs = s.offs
      // A compaction leaves a summary where tens of messages were; a rewind takes a few off. A request over fewer than half the
      // last one's messages is read as a compaction, whether or not session.compact arrived. The context stays as it was, so
      // turn.complete still scores a cold write this turn paid against it before the live figure replaces it.
      if (e.messageCount * 2 < s.transcript) markCompacted(s)
      s.transcript = e.messageCount
      // Only a request sent before any compaction this turn saw can hold a cold write; what follows one is the summary.
      if (!s.compacted) s.steps++
      s.lastRequestAt = await $.clock.now()
    }
    const r = yield* next(e)
    // Each request's write is priced at its own prompt length's tier (Haiku 5.5 changes price at 100k), not the turn's sum.
    const u = r.usage
    if (!e.agentId && u && !s.compacted) {
      const price = priceOf(u.model || e.model, u.input_tokens + u.cache_read_input_tokens + u.cache_creation_input_tokens)
      const was = s.stepWrites ?? { tokens: 0, usd: 0, priced: true }
      s.stepWrites = { tokens: was.tokens + u.cache_creation_input_tokens, usd: was.usd + (price ? u.cache_creation_input_tokens * price[1] / 1e6 : 0), priced: was.priced && price != null }
    }
    return r
  })

  on('turn.complete', async ($, e, next) => {
    const r = await next(e)
    if (e.agentId) return r
    // An off at any point in this turn wins over every window the turn would open; a host that raised no
    // step falls back to the count at completion.
    const offs = s.turnOffs ?? s.offs
    s.turnOffs = null
    const now = await $.clock.now()
    // A sleeping host may deliver this turn before the expired window's timer.
    if (s.deadline && now >= s.deadline) await stop($, s, null)
    // turn.step stamps the exact request time; when no step of this turn did, the turn's end is the floor.
    // A turn aborted before it sent anything touched no cache, so it leaves the clock alone.
    if ((e.usage || !e.isAborted) && now - s.lastRequestAt > e.durationMs) s.lastRequestAt = now
    await saveCache($, s)
    const compacted = s.compacted
    s.compacted = false
    if (s.lastRequestAt) s.resumedAt = 0
    s.waitForTurn = false
    s.ackedAt = 0
    // Always covers any break up to six hours after a turn that reached the cache (a turn that failed before any
    // response touched nothing, and its cache may be cold): a window of at least six hours at the default period,
    // which brings back a stopped window and replaces a shorter one or a testing period. Another session's
    // /keepwarm off or /keepwarm always changes the shared switch, so every such turn reads it.
    if (e.usage) {
      const shared = (await $.store.get(KEY_ALWAYS)) === true
      if (s.offs === offs) s.always = shared
      if (s.always) await startWindow($, s, Math.max(DEFAULT_WINDOW_MS, s.deadline - now), PING_AFTER_MS, offs)
    }
    const u = e.usage
    if (u) {
      if (u.model) s.lastModel = u.model
      const prev = s.ctx
      // A turn's usage is its responses summed, so a ten-step turn reports ten
      // reads of the context. The live window is the engine's figure; the sum
      // is only the fallback for a host that reports no tokens.
      const written = u.cache_creation_input_tokens
      const live = (await $.session.usage()).context.tokens
      s.ctx = live && live > 0 ? live : u.input_tokens + u.cache_read_input_tokens + written
      // A compaction since the last complete turn: what followed it is the summary, no cold write, so the turn is scored
      // on the requests before it alone. None before it leaves nothing to score, whatever the guard saw; requests before
      // it that reported no usage leave only the turn's total, an upper bound kept for a send the guard saw go cold.
      const writes = s.stepWrites
      const write = !compacted ? written : writes ? writes.tokens : s.steps && s.coldWritePending ? written : 0
      const full = prev > 20000 && write >= 0.5 * prev
      if (full || (s.coldWritePending && write > 0)) {
        // Priced per request when the steps reported usage; otherwise at the tier of the context the comeback re-sent.
        const price = priceOf(s.lastModel, prev || s.ctx)
        const usd = writes?.priced ? writes.usd : price ? write * price[1] / 1e6 : null
        s.misses.push({ at: now, tokens: write, usd })
        // Keepwarm is the person's to turn on: a paid cold write no longer opens a window by itself.
        $.ui.log(`cold write of ${fmtTok(write)} tokens paid (${fmtUsd(usd)}).` +
          (s.deadline ? '' : ' /keepwarm keeps the cache warm while you are away.'))
      }
    }
    s.coldWritePending = false
    s.stepWrites = null
    s.steps = 0
    await arm($, s)
    return r
  })

  on('session.compact', async ($, e, next) => {
    const r = await next(e)
    if (!e.agentId) {
      markCompacted(s)
      // Between turns nothing is left to score, and the next turn's summary write is not a cold write.
      s.ctx = 0
      disarm(s)
      await arm($, s)
    }
    return r
  })
}
