import { describe, expect, mock, test, tier } from 'claude-code/testing'
import type { Plugin, TestBody } from 'claude-code/testing'
import type { CommandRunInput, ConfigSetInput, ModelForkResult, On, PromptSubmitInput, RenderPropsOf, SessionStartInput, TurnCompleteInput, TurnUsage } from 'claude-code'

import { cacheTtlFromTranscript, cellsSvg, cellsText, outfitWidth, tagBlanks, fmtDuration, fmtSpan, freshState, litCells, tagOf, parseDuration, rankOf, resetForClear, seedFromResume, stackPieces } from '../hooks/register'

tier('user')

const MIN = 60 * 1000
const HOUR = 60 * MIN
const START = 1_000_000

const session: SessionStartInput = { surface: null, isInteractive: false, cwd: '/work' }

const usage = (over: Partial<TurnUsage> = {}): TurnUsage => ({
  input_tokens: 2, output_tokens: 10, cache_read_input_tokens: 200000, cache_creation_input_tokens: 500, model: 'claude-fable-5-1', ...over,
})

// TurnCompleteInput is a union on `reason`; the tests only drive the answered arm.
type AnsweredTurn = Exclude<TurnCompleteInput, { reason: 'refusal' }>
let turns = 0
const turn = (over: Partial<AnsweredTurn> = {}): TurnCompleteInput => ({
  answer: 'ok', durationMs: 1000, isAborted: false, turnId: 't' + ++turns, reason: 'answer', usage: usage(), ...over,
})

const run = (command: 'keepwarm' | 'ember', args: string): CommandRunInput => ({
  command, args, origin: { kind: 'composer' }, presentation: { isFullscreen: false, columns: 80 },
})

const prompt = (text: string): PromptSubmitInput => ({ text, wait: false, origin: { kind: 'composer' } })
const themeChange = (value: string): ConfigSetInput => ({ key: 'theme', value, previous: 'dark', provider: { plugin: 'engine', tier: 'core' }, origin: { kind: 'composer' } })

type ForkAnswer = null | ModelForkResult | { read: number; write: number; out?: number; input?: number }

// The store's keepwarm keys, without the cache records each turn rewrites (cache:<sid>), which outlive a conversation.
const windowKeys = (store: Map<string, unknown>) => [...store.keys()].filter(k => !k.startsWith('cache:'))

// The world beneath the mod: its store, the engine's answers, and a fork that
// replies from a script so each test decides what the cache looked like.
function world(on: On, forkAnswers: ForkAnswer[], opts: { store?: Map<string, unknown>; commands?: string[]; live?: { tokens?: number }; startedAt?: () => number; sid?: string | (() => string); model?: string | (() => string); bandText?: string; theme?: { value: string }; noColor?: boolean; denyTheme?: boolean; writtenTheme?: string; gate?: () => Promise<void>; steps?: TurnUsage[]; rateLimits?: Array<{ kind: string; percentUsed: number; resetsAt?: string }>; stack?: Array<[string, string]>; storeGate?: (op: 'get' | 'set' | 'delete', key: string) => Promise<void> } = {}) {
  if (opts.store) {
    const store = opts.store
    // A read takes its value first and is delivered after the gate, as a reply can arrive late.
    on('store.get', async ($, e) => { const value = store.get(e.key); await opts.storeGate?.('get', e.key); return { value } })
    on('store.set', async ($, e) => { await opts.storeGate?.('set', e.key); store.set(e.key, e.value); return { value: undefined } })
    on('store.delete', async ($, e) => { await opts.storeGate?.('delete', e.key); store.delete(e.key); return { value: undefined } })
    on('store.keys', () => ({ value: [...store.keys()] }))
  } else mock.store(on, {})
  const reads = { theme: 0, env: 0 }
  on('env.get', ($, e) => { reads.env++; return { value: e.name === 'NO_COLOR' && opts.noColor ? '1' : undefined } })
  on('config.list', () => {
    reads.theme++
    return { value: [{ key: 'theme', label: 'Theme', kind: 'choice', value: opts.theme?.value ?? 'dark', provider: { plugin: 'engine', tier: 'core' }, isLocked: false }] }
  })
  on('config.set', ($, e) => opts.denyTheme ? { deny: 'theme locked' } : { value: opts.writtenTheme ?? e.value })
  const forks: number[] = []
  const status: Array<string | undefined> = []
  const logs: string[] = []
  const entered: string[] = []
  on('session.start', ($, e) => ({ cwd: e.cwd }))
  on('session.end', ($, e) => ({ sessionId: e.sessionId }))
  on('session.id', () => ({ value: typeof opts.sid === 'function' ? opts.sid() : opts.sid ?? 'S1' }))
  on('session.model', () => ({ value: (typeof opts.model === 'function' ? opts.model() : opts.model) ?? 'claude-fable-5-1' }))
  on('session.usage', () => ({ value: { startedAt: opts.startedAt?.() ?? START, context: { window: 1000000, tokens: opts.live?.tokens }, rateLimits: opts.rateLimits ?? [] } }))
  on('session.measure', ($, e) => ({ changed: e.changed }))
  on('command.register', ($, e) => ({ value: { command: e.name } }))
  on('command.list', () => ({ value: (opts.commands ?? []).map(name => ({ name, description: '', source: 'plugin' as const })) }))
  on('turn.complete', ($, e) => ({ text: e.answer }))
  on('turn.step', async function* ($, e) {
    const u = opts.steps?.shift() ?? null
    yield { kind: 'stop' as const, stopReason: 'end_turn' as const, usage: u }
    return { turnId: e.turnId, index: e.index, answer: '', toolUses: [], stopReason: 'end_turn' as const, usage: u }
  })
  on('prompt.submit', ($, e) => { entered.push(e.text); return { text: e.text } })
  on('session.compact', ($, e) => ({ messages: e.messages }))
  on('classic.SessionStart', () => ({}))
  on('classic.Stop', () => ({}))
  on('ui.log', ($, e) => { logs.push(e.text); return { value: undefined } })
  on('ui.status', ($, e) => { status.push(e.text); return { value: undefined } })
  on('ui.render', ($, e) => {
    const { Box, Text } = $.ui.resolve(e)
    // The mods beneath as a band-stack of keyed cards, when a test gives one.
    if (opts.stack) return Box({ key: 'band-stack', flexDirection: 'column', children: opts.stack.map(([key, text]) => Box({ key, children: [Text({ children: [text] })] })) })
    return Text({ children: [opts.bandText ?? ''] })
  })
  on('model.fork', async () => {
    forks.push(forks.length)
    if (opts.gate) await opts.gate()
    const a = forkAnswers.shift()
    // Older Claude Code releases returned null instead of a failure object.
    if (a === null || a === undefined) return { value: null as unknown as ModelForkResult }
    if ('isAnswered' in a) return { value: a }
    const value: ModelForkResult = { isAnswered: true, text: 'warm', usage: { input_tokens: a.input ?? 2, output_tokens: a.out ?? 1, cache_read_input_tokens: a.read, cache_creation_input_tokens: a.write } }
    return { value }
  })
  return { forks, status, logs, entered, reads }
}

const warm: ForkAnswer = { read: 200000, write: 0 }
// A ping that finds nothing to fork leaves the window waiting, with a wake at the cold mark and no further fork.
const nothing: ForkAnswer = { isAnswered: false, reason: 'nothing-to-fork' }
const busy: ForkAnswer = { isAnswered: false, reason: 'api-error', status: 429, error: 'rate_limit', usage: usage() }

const bandProps: RenderPropsOf['AbovePrompt'] = {
  hasSurvey: false, isWorking: false, maxRows: 10, bodyColumns: 160,
  scroll: { offset: 0, bodyRows: 10 }, view: {},
}

type UiLike = {
  find: (q: { type?: string; key?: string; text?: string | RegExp }) => Promise<{ text: string; props: Record<string, unknown> } | undefined>
  drawn: () => Promise<unknown>
}
type DrawnNode = { type?: string; props?: Record<string, unknown>; children?: unknown[] }
// What a person sees of a drawn node: its text, an Svg's alt (the desktop draws its words in Outfit), a Button's label.
const shown = (n: unknown): string => {
  if (typeof n === 'string') return n
  if (!n || typeof n !== 'object') return ''
  const node = n as DrawnNode
  if (node.type === 'Svg') return String(node.props?.alt ?? '')
  if (node.type === 'Button') return String(node.props?.label ?? '').replace(/\u2800+/g, '')
  return (node.children ?? []).map(shown).join('')
}
const byKey = (n: unknown, key: string): DrawnNode | undefined => {
  if (!n || typeof n !== 'object') return undefined
  const node = n as DrawnNode
  if (node.props?.key === key) return node
  for (const c of node.children ?? []) {
    const hit = byKey(c, key)
    if (hit) return hit
  }
  return undefined
}
const keyed = async (ui: UiLike, key: string) => {
  const node = byKey(await ui.drawn(), key)
  return node ? shown(node).trim() : undefined
}
const tagRaw = async (ui: UiLike) => (await keyed(ui, 'ember-tag')) ?? ''
const tagOn = async (ui: UiLike) => (await tagRaw(ui)).replace(/ [▾▴]$/, '') || undefined
const timeOn = async (ui: UiLike) => keyed(ui, 'ember-time')
// The time's colour: an Outfit drawing's fill on the desktop, the Text's colour on the terminal.
const timeColor = async (ui: UiLike) => {
  const node = byKey(await ui.drawn(), 'ember-time')
  const leaf = node?.children?.[0] as DrawnNode | undefined
  if (leaf?.type === 'Svg') return /<text [^>]*fill="(#[0-9A-Fa-f]{6})"/.exec(String(leaf.props?.source ?? ''))?.[1]
  return leaf?.props?.color as string | undefined
}

describe('the ribbon', () => {
  for (const surface of ['terminal', 'desktop'] as const) {
    test(`${surface}: waiting, kept warm, cold and warm again agree with the card, after the plugins beneath`, async ($, on) => {
      const clock = mock.clock(on, { now: 10 * HOUR })
      const w = world(on, [nothing], { bandText: 'other mod' })
      await $.session.start({ ...session, surface, isInteractive: true })
      const ui = await $.ui.mount({ plugin: 'ember', surface, component: 'AbovePrompt', props: bandProps })
      expect(await ui.find({ key: 'ember' })).toBe(undefined)
      await $.command.run(run('keepwarm', '3h'))
      expect(await tagOn(ui)).toBe('KEPT 3H')
      expect(await timeOn(ui)).toBe('from your next turn')
      await $.turn.complete(turn())
      expect(await tagOn(ui)).toBe('KEPT 3H')
      expect(await timeOn(ui)).toBe('3h left')
      await clock.advance(HOUR)
      expect(await tagOn(ui)).toBe('COLD')
      expect(await timeOn(ui)).toBe('1h · $4.01 · kept next turn')
      expect((await $.command.run(run('ember', ''))).text).toMatch(/state       COLD/)
      expect(w.forks.length).toBe(1)
      expect((await ui.find({ text: /^other mod$/ }))?.text).toBe('other mod')
      await $.turn.complete(turn())
      expect(await tagOn(ui)).toBe('KEPT 3H')
      expect(await timeOn(ui)).toBe('2h left')
      expect((await $.command.run(run('ember', ''))).text).toMatch(/state       warm/)
      expect(w.status.filter(Boolean)).toEqual([])
      await $.command.run(run('keepwarm', 'off'))
      expect(await tagOn(ui)).toBe('WARM')
      expect(await timeOn(ui)).toBe('1h left')
      expect(w.forks.length).toBe(1)
    })
  }

  test('the tag and the time share a colour: the last ten minutes of a 1h cache in warning, then COLD with the price', async ($, on) => {
    const clock = mock.clock(on, { now: START })
    world(on, [], { live: { tokens: 200000 } })
    await $.session.start({ ...session, surface: 'desktop', isInteractive: true })
    await $.turn.complete(turn())
    const ui = await $.ui.mount({ plugin: 'ember', surface: 'desktop', component: 'AbovePrompt', props: bandProps })
    expect(await timeColor(ui)).toBe('#C96442')
    expect((await ui.find({ key: 'ember-tag' }))?.props.backgroundColor).toBe('#C96442')
    await clock.advance(52 * MIN)
    expect(await timeOn(ui)).toBe('8m left')
    expect(await timeColor(ui)).toBe('#A8741C')
    await clock.advance(20 * MIN)
    expect(await tagOn(ui)).toBe('COLD')
    expect(await timeOn(ui)).toBe('1h 12m · $4.00')
    expect(await timeColor(ui)).toBe('#3D86A8')
    expect((await ui.find({ key: 'ember-tag' }))?.props.backgroundColor).toBe('#3D86A8')
  })

  test('a 5-minute cache counts its own five minutes down', async ($, on) => {
    mock.clock(on, { now: START })
    on('process.run', () => ({ value: { exitCode: 0, stdout: JSON.stringify({ type: 'assistant', message: { usage: { cache_creation: { ephemeral_5m_input_tokens: 900 } } } }) + '\n', stderr: '' } }))
    world(on, [])
    await $.session.start({ ...session, surface: 'terminal', isInteractive: true })
    await $.turn.complete(turn())
    await $.classic.Stop({ transcript_path: '/t.jsonl' })
    const ui = await $.ui.mount({ plugin: 'ember', surface: 'terminal', component: 'AbovePrompt', props: bandProps })
    expect(await tagOn(ui)).toBe('WARM')
    expect(await timeOn(ui)).toBe('5m left')
  })

  test('usage windows: 7D first, a bar and the percent in the colour of what is left, LOW under 15%, the reset time; no USAGE label', async ($, on) => {
    const clock = mock.clock(on, { now: Date.parse('2026-10-29T08:00:00Z') })
    world(on, [], { rateLimits: [
      { kind: 'five_hour', percentUsed: 91, resetsAt: '2026-10-29T10:14:00Z' },
      { kind: 'seven_day', percentUsed: 61.6, resetsAt: '2026-11-01T14:00:00Z' },
    ] })
    await $.session.start({ ...session, surface: 'terminal', isInteractive: true })
    const ui = await $.ui.mount({ plugin: 'ember', surface: 'terminal', component: 'AbovePrompt', props: bandProps })
    // Before the first reply there is no cache to show, only the usage.
    expect(await ui.find({ type: 'Text', text: 'USAGE' })).toBe(undefined)
    expect(await ui.find({ key: 'ember-status' })).toBe(undefined)
    expect((await ui.findAll({ type: 'Text', text: /^■+$/ })).map(x => [x.text, x.props.color])).toEqual([['■■■■', '#C2841F'], ['■', '#D2423A']])
    expect((await ui.find({ type: 'Text', text: /^□{6}$/ }))?.props.color).toBe('inactive')
    expect((await ui.find({ type: 'Text', text: /^38%$/ }))?.props.color).toBe('#C2841F')
    expect(await ui.find({ type: 'Text', text: ' · 3d 6h' })).toBeDefined()
    expect((await ui.find({ type: 'Text', text: /^9%$/ }))?.props.color).toBe('#D2423A')
    expect(await ui.find({ type: 'Text', text: ' LOW' })).toBeDefined()
    expect(await ui.find({ type: 'Text', text: /left/ })).toBe(undefined)
    const keys = (await ui.findAll({ type: 'Box' })).map(b => b.props.key).filter(k => typeof k === 'string' && k.startsWith('w-'))
    expect(keys).toEqual(['w-seven_day', 'w-five_hour'])
    await $.session.measure({ startedAt: START, context: { window: 1000000, tokens: 1000 }, rateLimits: [{ kind: 'five_hour', percentUsed: 40, resetsAt: '2026-10-29T10:14:00Z' }], changed: ['rateLimits'] })
    expect((await ui.find({ type: 'Text', text: /^60%$/ }))?.props.color).toBe('#C96442')
    expect(await ui.find({ key: 'w-seven_day' })).toBe(undefined)
    await clock.advance(3 * HOUR)
    expect(await ui.find({ type: 'Text', text: ' · resetting' })).toBeDefined()
  })

  test('every state reads right on one row', async ($, on) => {
    const clock = mock.clock(on, { now: Date.parse('2026-10-29T08:00:00Z') })
    const filled: string[] = []
    on('prompt.fill', ($, e) => { filled.push(e.text); return { isFilled: true } })
    world(on, [], { live: { tokens: 412000 }, model: 'claude-opus-5-5', commands: ['handoff'], rateLimits: [
      { kind: 'five_hour', percentUsed: 92, resetsAt: '2026-10-29T10:14:00Z' },
      { kind: 'seven_day', percentUsed: 27, resetsAt: '2026-10-30T17:00:00Z' },
    ] })
    await $.session.start({ ...session, surface: 'desktop', isInteractive: true })
    const desk = await $.ui.mount({ plugin: 'ember', surface: 'desktop', component: 'AbovePrompt', props: bandProps })
    const term = await $.ui.mount({ plugin: 'ember', surface: 'terminal', component: 'AbovePrompt', props: bandProps })
    const seen: string[] = []
    const look = async (name: string) => {
      // Every leaf a person sees, in order: Text, an Svg's alt (the desktop's Outfit words), a Button's label.
      const leaves = (n: unknown, out: string[] = []): string[] => {
        if (typeof n === 'string') { if (n.trim() !== '') out.push(n) }
        else if (n && typeof n === 'object') {
          const node = n as DrawnNode
          if (node.type === 'Svg') out.push(`[${String(node.props?.alt)}]`)
          else if (node.type === 'Button') out.push(`<${String(node.props?.label).replace(/\u2800+/, 'blank')}>`)
          else for (const c of node.children ?? []) leaves(c, out)
        }
        return out
      }
      seen.push(`${name}\n  desk: ${JSON.stringify(leaves(await desk.drawn()))}\n  term: ${JSON.stringify(leaves(await term.drawn()))}`)
    }
    await look('before any turn')
    await $.command.run(run('keepwarm', '6h'))
    await look('keepwarm 6h before the first turn')
    await $.turn.complete(turn({ usage: usage({ model: 'claude-opus-5-5' }) }))
    await look('kept 6h')
    await $.command.run(run('keepwarm', 'off'))
    await look('warm')
    await clock.advance(52 * MIN)
    await look('cooling')
    await clock.advance(20 * MIN)
    await look('cold')
    await $.prompt.submit(prompt('hi'))
    await look('held')
    await desk.press({ key: 'ember-cancel' })
    await desk.press({ key: 'ember-fold' })
    await look('cold, card hidden')
    await desk.press({ key: 'ember-keep' })
    await look('cold, Keep warm open')
    await desk.press({ key: 'ember-keep-always' })
    await look('always')
    await $.session.compact({ trigger: 'manual', messages: [{ role: 'user', text: 'summary', toolUses: [] }] })
    await look('always, after compaction')
    expect(seen).toEqual([
      "before any turn\n  desk: [\"[7D 73% left, resets in 1d 9h]\",\"[5H 8% left LOW, resets in 2h 14m]\"]\n  term: [\"7D\",\"■■■■■■■\",\"□□□\",\"73%\",\" · 1d 9h\",\"5H\",\"■\",\"□□□□□□□□□\",\"8%\",\" LOW\",\" · 2h 14m\"]",
      "keepwarm 6h before the first turn\n  desk: [\"[7D 73% left, resets in 1d 9h]\",\"[5H 8% left LOW, resets in 2h 14m]\",\"[Ember, kept 6h]\",\"[KEPT 6H]\",\"<blank>\",\"[from your next turn]\"]\n  term: [\"7D\",\"■■■■■■■\",\"□□□\",\"73%\",\" · 1d 9h\",\"5H\",\"■\",\"□□□□□□□□□\",\"8%\",\" LOW\",\" · 2h 14m\",\"<KEPT 6H>\",\"from your next turn\"]",
      "kept 6h\n  desk: [\"[7D 73% left, resets in 1d 9h]\",\"[5H 8% left LOW, resets in 2h 14m]\",\"[Ember, kept 6h]\",\"[KEPT 6H]\",\"<blank>\",\"[6h left]\",\"<Show>\"]\n  term: [\"7D\",\"■■■■■■■\",\"□□□\",\"73%\",\" · 1d 9h\",\"5H\",\"■\",\"□□□□□□□□□\",\"8%\",\" LOW\",\" · 2h 14m\",\"<KEPT 6H>\",\"6h left\",\"<Show>\"]",
      "warm\n  desk: [\"[7D 73% left, resets in 1d 9h]\",\"[5H 8% left LOW, resets in 2h 14m]\",\"[Ember, warm]\",\"[WARM]\",\"<blank>\",\"[1h left]\",\"<Show>\"]\n  term: [\"7D\",\"■■■■■■■\",\"□□□\",\"73%\",\" · 1d 9h\",\"5H\",\"■\",\"□□□□□□□□□\",\"8%\",\" LOW\",\" · 2h 14m\",\"<WARM>\",\"1h left\",\"<Show>\"]",
      "cooling\n  desk: [\"[7D 73% left, resets in 1d 8h]\",\"[5H 8% left LOW, resets in 1h 22m]\",\"[Ember, warm]\",\"[WARM]\",\"<blank>\",\"[8m left]\",\"<Show>\"]\n  term: [\"7D\",\"■■■■■■■\",\"□□□\",\"73%\",\" · 1d 8h\",\"5H\",\"■\",\"□□□□□□□□□\",\"8%\",\" LOW\",\" · 1h 22m\",\"<WARM>\",\"8m left\",\"<Show>\"]",
      "cold\n  desk: [\"[7D 73% left, resets in 1d 7h]\",\"[5H 8% left LOW, resets in 1h 2m]\",\"[Ember, cold]\",\"[COLD]\",\"<blank>\",\"[1h 12m · $3.30]\",\"<Hide>\",\"IDLE\",\"1h 12m\",\"[cold]\",\"went cold 12m ago\",\"RE-CACHE\",\"412k tokens\",\"[41% of the context]\",\"41% of the 1.0M context\",\"NEXT · OPUS 5.5\",\"$3.30\",\"warm \",\"$0.08\",\"  ·  \",\"cold \",\"$3.30\",\"Re-writes the whole cache.\"]\n  term: [\"7D\",\"■■■■■■■\",\"□□□\",\"73%\",\" · 1d 7h\",\"5H\",\"■\",\"□□□□□□□□□\",\"8%\",\" LOW\",\" · 1h 2m\",\"<COLD>\",\"1h 12m · $3.30\",\"<Hide>\",\"IDLE\",\"1h 12m\",\"■■■■■■■■■■\",\"went cold 12m ago\",\"RE-CACHE\",\"412k tokens\",\"■■■■\",\"□□□□□□\",\"41% of the 1.0M context\",\"NEXT · OPUS 5.5\",\"$3.30\",\"warm \",\"$0.08\",\"  ·  \",\"cold \",\"$3.30\",\"Re-writes the whole cache.\"]",
      "held\n  desk: [\"[7D 73% left, resets in 1d 7h]\",\"[5H 8% left LOW, resets in 1h 2m]\",\"[Ember, cold]\",\"[COLD]\",\"<blank>\",\"[1h 12m · $3.30]\",\"[HELD]\",\"Your message is waiting\",\"The 1h cache went cold 12m ago. Sending now re-writes 412k tokens, about $3.30. While warm, the same send costs about $0.08.\",\"Context is large. Run /handoff to carry on in a fresh session instead.\",\"<Send anyway>\",\"<Cancel>\"]\n  term: [\"7D\",\"■■■■■■■\",\"□□□\",\"73%\",\" · 1d 7h\",\"5H\",\"■\",\"□□□□□□□□□\",\"8%\",\" LOW\",\" · 1h 2m\",\"<COLD>\",\"1h 12m · $3.30\",\"HELD\",\"Your message is waiting\",\"The 1h cache went cold 12m ago. Sending now re-writes 412k tokens, about $3.30. While warm, the same send costs about $0.08.\",\"Context is large. Run /handoff to carry on in a fresh session instead.\",\"<Send anyway>\",\"<Cancel>\"]",
      "cold, card hidden\n  desk: [\"[7D 73% left, resets in 1d 7h]\",\"[5H 8% left LOW, resets in 1h 2m]\",\"[Ember, cold]\",\"[COLD]\",\"<blank>\",\"[1h 12m · $3.30]\",\"<Show>\"]\n  term: [\"7D\",\"■■■■■■■\",\"□□□\",\"73%\",\" · 1d 7h\",\"5H\",\"■\",\"□□□□□□□□□\",\"8%\",\" LOW\",\" · 1h 2m\",\"<COLD>\",\"1h 12m · $3.30\",\"<Show>\"]",
      "cold, Keep warm open\n  desk: [\"[7D 73% left, resets in 1d 7h]\",\"[5H 8% left LOW, resets in 1h 2m]\",\"[Ember, cold]\",\"[COLD]\",\"<blank>\",\"[1h 12m · $3.30]\",\"<Show>\",\"KEEP WARM FOR\",\"<1H>\",\"<2H>\",\"<3H>\",\"<6H>\",\"<Always>\",\"The cache is cold, so the first ping comes 50m after your next turn. After that, one tiny ping every 50m keeps it read, not re-written.\"]\n  term: [\"7D\",\"■■■■■■■\",\"□□□\",\"73%\",\" · 1d 7h\",\"5H\",\"■\",\"□□□□□□□□□\",\"8%\",\" LOW\",\" · 1h 2m\",\"<COLD>\",\"1h 12m · $3.30\",\"<Show>\",\"KEEP WARM FOR\",\"<1H>\",\"<2H>\",\"<3H>\",\"<6H>\",\"<Always>\",\"The cache is cold, so the first ping comes 50m after your next turn. After that, one tiny ping every 50m keeps it read, not re-written.\"]",
      "always\n  desk: [\"[7D 73% left, resets in 1d 7h]\",\"[5H 8% left LOW, resets in 1h 2m]\",\"[Ember, cold]\",\"[COLD]\",\"<blank>\",\"[1h 12m · $3.30 · kept next turn]\",\"<Show>\"]\n  term: [\"7D\",\"■■■■■■■\",\"□□□\",\"73%\",\" · 1d 7h\",\"5H\",\"■\",\"□□□□□□□□□\",\"8%\",\" LOW\",\" · 1h 2m\",\"<COLD>\",\"1h 12m · $3.30 · kept next turn\",\"<Show>\"]",
      "always, after compaction\n  desk: [\"[7D 73% left, resets in 1d 7h]\",\"[5H 8% left LOW, resets in 1h 2m]\",\"[Ember, kept ∞]\",\"[KEPT ∞]\",\"<blank>\",\"[from your next turn]\"]\n  term: [\"7D\",\"■■■■■■■\",\"□□□\",\"73%\",\" · 1d 7h\",\"5H\",\"■\",\"□□□□□□□□□\",\"8%\",\" LOW\",\" · 1h 2m\",\"<KEPT ∞>\",\"from your next turn\"]",
    ])
  })

  test('the meter: ten rounded squares lit to the nearest tenth, one whenever anything is left; the off grey follows the mode', () => {
    expect([litCells(0), litCells(0.001), litCells(0.44), litCells(0.45), litCells(1)]).toEqual([0, 1, 4, 5, 10])
    const svg = cellsSvg(0.3, '#C96442')
    expect(svg).toMatch(/viewBox="0 0 109 10"/)
    expect(svg).toMatch(/<g fill="#C96442">(<rect x="\d+" width="10" height="10" rx="3"\/>){3}<\/g>/)
    expect(svg).toMatch(/<g class="o">(<rect [^>]*\/>){7}<\/g>/)
    expect(svg).toMatch(/\.o\{fill:#E2DDD7\}@media \(prefers-color-scheme: dark\)\{\.o\{fill:#4A4740\}\}/)
    expect(svg).toMatch(/<rect x="99" width="10"/)
    expect(cellsText(0.62)).toEqual(['■■■■■■', '□□□□'])
    expect(cellsText(0)).toEqual(['', '□□□□□□□□□□'])
    // A narrow band's five: a fifth each, and the drawing shrinks to fit them.
    expect([litCells(0.62, 5), litCells(0.05, 5), litCells(1, 5)]).toEqual([3, 1, 5])
    expect(cellsSvg(0.62, '#C96442', 5)).toMatch(/viewBox="0 0 54 10"/)
    expect(cellsText(0.62, 5)).toEqual(['■■■', '□□'])
    expect(fmtSpan(60 * MIN)).toBe('1h')
    expect(fmtSpan(3 * HOUR + 19 * MIN)).toBe('3h 19m')
    expect(fmtSpan(33 * HOUR)).toBe('1d 9h')
    expect(fmtSpan(48 * HOUR)).toBe('2d')
  })

  test('desktop draws the bars and Ember as SVG; the terminal draws them in text', async ($, on) => {
    mock.clock(on, { now: START })
    world(on, [], { rateLimits: [{ kind: 'five_hour', percentUsed: 12 }] })
    await $.session.start({ ...session, surface: 'desktop', isInteractive: true })
    await $.turn.complete(turn())
    const desk = await $.ui.mount({ plugin: 'ember', surface: 'desktop', component: 'AbovePrompt', props: bandProps })
    const svgs = await desk.findAll({ type: 'Svg' })
    expect(svgs.map(x => x.props.alt)).toEqual(['5H 88% left', 'Ember, warm', 'WARM', '1h left'])
    // A usage window is one drawing in Outfit: its name, the ten squares and the percent.
    expect(svgs[0]?.props.source).toMatch(/@font-face\{font-family:Outfit;font-weight:100 900;src:url\(data:font\/woff2;base64,d09GMg/)
    expect(String(svgs[0]?.props.source).match(/<rect /g)?.length).toBe(10)
    expect(svgs[0]?.props.source).toMatch(/font-weight="700" fill="#C96442" xml:space="preserve">88%<\/text>/)
    expect(svgs[1]?.props.source).toMatch(/^<svg[^>]*viewBox="0 0 11 11"/)
    expect(svgs[1]?.props.source).toMatch(/animateTransform/)
    expect(svgs[1]?.props.isInteractive).toBe(true)
    const term = await $.ui.mount({ plugin: 'ember', surface: 'terminal', component: 'AbovePrompt', props: bandProps })
    expect(await term.find({ type: 'Svg' })).toBe(undefined)
    expect(await term.find({ type: 'Text', text: /^■{9}$/ })).toBeDefined()
    expect(await tagOn(term)).toBe('WARM')
  })

  test('the tag opens Keep warm; a choice keeps the cache warm without typing, and Stop turns it off; only Show stays outside', async ($, on) => {
    mock.clock(on, { now: START })
    const store = new Map<string, unknown>()
    world(on, [], { store, live: { tokens: 200000 } })
    await $.session.start({ ...session, surface: 'desktop', isInteractive: true })
    await $.turn.complete(turn())
    const ui = await $.ui.mount({ plugin: 'ember', surface: 'desktop', component: 'AbovePrompt', props: bandProps })
    expect((await ui.findAll({ type: 'Button' })).map(b => b.props.key)).toEqual(['ember-keep', 'ember-fold'])
    expect(await tagRaw(ui)).toBe('WARM')
    expect(await ui.find({ key: 'ember-keep-2h' })).toBe(undefined)
    await ui.press({ key: 'ember-keep' })
    expect(await tagRaw(ui)).toBe('WARM')
    expect(await ui.find({ key: 'ember-keep-1h' })).toBeDefined()
    expect((await ui.find({ key: 'ember-keep-1h' }))?.props.label).toBe('1H')
    expect((await ui.find({ key: 'ember-keep-6h' }))?.props.label).toBe('6H')
    expect((await ui.find({ key: 'ember-keep-always' }))?.props.label).toBe('Always')
    expect(await ui.find({ key: 'ember-keep-off' })).toBe(undefined)
    expect(await ui.find({ type: 'Text', text: /One tiny ping every 50m/ })).toBeDefined()
    await ui.press({ key: 'ember-keep-2h' })
    expect(await ui.find({ key: 'ember-keep-1h' })).toBe(undefined)
    expect(await tagOn(ui)).toBe('KEPT 2H')
    expect(await timeOn(ui)).toBe('2h left')
    expect((await $.command.run(run('keepwarm', 'status'))).text).toMatch(/^keepwarm 2h00m left · ping in 50m/)
    expect(store.get('deadline:S1')).toBe(START + 2 * HOUR)
    await ui.press({ key: 'ember-keep' })
    await ui.press({ key: 'ember-keep-off' })
    expect(await tagOn(ui)).toBe('WARM')
    expect(await timeOn(ui)).toBe('1h left')
    expect(store.get('deadline:S1')).toBe(undefined)
    await ui.press({ key: 'ember-keep' })
    await ui.press({ key: 'ember-keep-always' })
    expect(store.get('always')).toBe(true)
    expect(await tagOn(ui)).toBe('KEPT ∞')
    expect(await timeOn(ui)).toBe('kept warm')
  })

  test('the card: folded while warm, open when cold, Show and Hide hold until the cache flips', async ($, on) => {
    const clock = mock.clock(on, { now: START })
    world(on, [], { live: { tokens: 200000 }, model: 'claude-opus-5-5' })
    await $.session.start({ ...session, surface: 'desktop', isInteractive: true })
    await $.turn.complete(turn({ usage: usage({ model: 'claude-opus-5-5' }) }))
    const ui = await $.ui.mount({ plugin: 'ember', surface: 'desktop', component: 'AbovePrompt', props: bandProps })
    expect((await ui.find({ key: 'ember-fold' }))?.props.label).toBe('Show')
    expect(await ui.find({ key: 'card' })).toBe(undefined)
    await ui.press({ key: 'ember-fold' })
    expect((await ui.find({ key: 'ember-fold' }))?.props.label).toBe('Hide')
    expect(await ui.find({ type: 'Text', text: 'IN CACHE' })).toBeDefined()
    expect(await ui.find({ type: 'Text', text: '200k tokens' })).toBeDefined()
    expect(await ui.find({ type: 'Text', text: '20% of the 1.0M context' })).toBeDefined()
    expect(await ui.find({ type: 'Text', text: 'NEXT · OPUS 5.5' })).toBeDefined()
    expect(await ui.find({ type: 'Text', text: '$0.04' })).toBeDefined()
    expect(await ui.find({ type: 'Text', text: 'goes cold in 1h' })).toBeDefined()
    await clock.advance(2 * HOUR)
    // Cold opens the card by itself; the warm choice does not carry over.
    expect(await ui.find({ type: 'Text', text: 'RE-CACHE' })).toBeDefined()
    expect(await ui.find({ type: 'Text', text: '$1.60' })).toBeDefined()
    expect(await ui.find({ type: 'Text', text: 'went cold 1h ago' })).toBeDefined()
    await ui.press({ key: 'ember-fold' })
    expect(await ui.find({ key: 'card' })).toBe(undefined)
    await clock.advance(MIN)
    expect(await ui.find({ key: 'card' })).toBe(undefined)
  })

  test('a narrow band keeps one row: ten squares become five, then the reset times go, then the squares; then usage takes a row of its own', async ($, on) => {
    mock.clock(on, { now: Date.parse('2026-10-29T08:00:00Z') })
    world(on, [], { live: { tokens: 200000 }, rateLimits: [
      { kind: 'five_hour', percentUsed: 7, resetsAt: '2026-10-29T11:19:00Z' },
      { kind: 'seven_day', percentUsed: 25, resetsAt: '2026-10-30T17:00:00Z' },
    ] })
    await $.session.start({ ...session, surface: 'desktop', isInteractive: true })
    await $.turn.complete(turn())
    // Each form as the columns grow: 4 usage on its own row, 3 no squares, 2 five squares without the reset times,
    // 1 five squares with them, 0 all of it with ten.
    const formAt = async (bodyColumns: number) => {
      const ui = await $.ui.mount({ plugin: 'ember', surface: 'desktop', component: 'AbovePrompt', props: { ...bandProps, bodyColumns } })
      const tree = await ui.drawn()
      const seven = byKey(tree, 'w-seven_day')?.children?.[0] as DrawnNode | undefined
      const squares = String(seven?.props?.source ?? '').match(/<rect /g)?.length ?? 0
      const reset = String(seven?.props?.alt).includes('resets in')
      const form = squares === 10 && reset ? 0 : squares === 5 ? (reset ? 1 : 2) : squares === 0 && !reset ? 3 : -1
      return byKey(tree, 'row-usage') ? `split ${form}` : form
    }
    const steps: Array<[number, number | string]> = []
    for (let columns = 30; columns <= 140; columns++) {
      const form = await formAt(columns)
      if (steps.at(-1)?.[1] !== form) steps.push([columns, form])
    }
    // On a row of its own, usage keeps the widest of its forms that fits there.
    expect(steps).toEqual([[30, 'split 2'], [41, 'split 1'], [45, 3], [59, 2], [70, 1], [84, 0]])
  })

  test('an open band: a hairline under the row, and upright ones between the card\'s zones; the terminal draws none', async ($, on) => {
    const clock = mock.clock(on, { now: START })
    world(on, [], { live: { tokens: 200000 }, rateLimits: [{ kind: 'five_hour', percentUsed: 12 }] })
    await $.session.start({ ...session, surface: 'desktop', isInteractive: true })
    await $.turn.complete(turn())
    const ui = await $.ui.mount({ plugin: 'ember', surface: 'desktop', component: 'AbovePrompt', props: bandProps })
    expect(await ui.find({ key: 'rule-0' })).toBe(undefined)
    await clock.advance(2 * HOUR)
    const tree = await ui.drawn()
    const ribbon = byKey(tree, 'ember')
    expect((ribbon?.children ?? []).map(c => (c as DrawnNode).props?.key)).toEqual(['row', 'rule-0', 'card'])
    const hair = (byKey(tree, 'rule-0')?.children?.[0] as DrawnNode | undefined)?.props
    expect([hair?.width, hair?.height, hair?.backgroundColor]).toEqual(['100%', 0.05, 'promptBorderShimmer'])
    const card = byKey(tree, 'card')
    expect((card?.children ?? []).map(c => (c as DrawnNode).props?.key)).toEqual(['idle', 'card-rule-1', 'size', 'card-rule-2', 'cost'])
    expect([card?.props?.alignItems, card?.props?.paddingTop]).toEqual(['stretch', undefined])
    expect(byKey(tree, 'card-rule-1')?.props?.width).toBe(0.12)
    // Keep warm opening under the card takes a hairline of its own.
    await ui.press({ key: 'ember-keep' })
    expect(((byKey(await ui.drawn(), 'ember')?.children ?? []) as DrawnNode[]).map(c => c.props?.key)).toEqual(['row', 'rule-0', 'keep', 'rule-1', 'card'])
    // A narrow band's card takes five squares, as the row does.
    const narrow = await $.ui.mount({ plugin: 'ember', surface: 'desktop', component: 'AbovePrompt', props: { ...bandProps, bodyColumns: 40 } })
    const idleBar = (await narrow.findAll({ type: 'Svg' })).find(x => x.props.alt === 'cold')
    expect(String(idleBar?.props.source).match(/<rect /g)?.length).toBe(5)
    const term = await $.ui.mount({ plugin: 'ember', surface: 'terminal', component: 'AbovePrompt', props: bandProps })
    expect(await term.find({ key: 'rule-0' })).toBe(undefined)
    expect(await term.find({ key: 'card-rule-1' })).toBe(undefined)
  })

  test('Ember draws no fill of its own, sits under what the plugins beneath drew, and its tag is a bold pill a blank Button covers', async ($, on) => {
    mock.clock(on, { now: START })
    world(on, [], { bandText: 'beneath' })
    await $.session.start({ ...session, surface: 'desktop', isInteractive: true })
    await $.turn.complete(turn())
    const ui = await $.ui.mount({ plugin: 'ember', surface: 'desktop', component: 'AbovePrompt', props: bandProps })
    const ribbon = await ui.find({ key: 'ember' })
    expect([ribbon?.props.borderStyle, ribbon?.props.backgroundColor]).toEqual([undefined, undefined])
    const tree = await ui.drawn() as { props?: { key?: string; rowGap?: string }; children?: Array<{ props?: { key?: string }; type?: string }> }
    expect([tree.props?.key, tree.props?.rowGap]).toEqual(['band-stack', 'sm'])
    expect(tree.children?.map(c => c.props?.key ?? c.type)).toEqual(['Text', 'ember'])
    const pill = await ui.find({ key: 'ember-tag' })
    expect([pill?.props.borderStyle, pill?.props.backgroundColor, pill?.props.overflow]).toEqual(['single', '#C96442', 'hidden'])
    // The tag's word is Outfit, bold, in white, drawn exactly as wide as its measured advances.
    const word = byKey(await ui.drawn(), 'ember-word')?.children?.[0] as DrawnNode | undefined
    expect([word?.type, word?.props?.alt]).toEqual(['Svg', 'WARM'])
    expect(word?.props?.source).toMatch(/font-weight="700" class="c0" xml:space="preserve">WARM<\/text>/)
    expect(word?.props?.source).toMatch(/\.c0\{fill:#FFFFFF\}@media \(prefers-color-scheme: dark\)\{\.c0\{fill:#F0EBE5\}\}/)
    expect(word?.props?.width).toBe(Math.ceil(outfitWidth('WARM', 700)) + 1)
    const press = await ui.find({ key: 'ember-keep' })
    expect(press?.props.plain).toBe(true)
    // Show stands on the page's colour, a shade off the band.
    const show = await ui.find({ key: 'ember-show' })
    expect([show?.props.borderStyle, show?.props.backgroundColor]).toEqual(['single', 'clawd_background'])
    expect(String(press?.props.label)).toMatch(/^\u2800+$/)
    // The app cuts a label wider than its room to "\u2026" (it once showed under WARM): the label spans the pill and
    // fits the layer, which reaches three columns past each side.
    expect(String(press?.props.label).length).toBe(tagBlanks('WARM'))
    const layer = byKey(await ui.drawn(), 'ember-press')
    expect([layer?.props?.left, layer?.props?.right, layer?.props?.overflow]).toEqual([-3, -3, undefined])
  })

  test('with no request to time the cache from, the tag says why: NEW before the first message, SUMMARY after a compaction', () => {
    const s = freshState()
    expect(tagOf(s, 1_000)).toEqual({ word: 'NEW', hue: 'muted', time: 'cache starts with your first message' })
    s.lastRequestAt = 500
    s.compacted = true
    expect(tagOf(s, 1_000)).toEqual({ word: 'SUMMARY', hue: 'muted', time: 'cache rebuilt next turn · small write' })
  })

  test('the tag Button covers the pill and is never wide enough for the app to cut it to "\u2026"', () => {
    const BLANK_EM = 0.6836
    for (const word of ['WARM', 'COLD', 'NEW', 'SUMMARY', 'KEPT 1H', 'KEPT 2H', 'KEPT 6H', 'KEPT 48H', 'KEPT \u221e']) {
      const pill = outfitWidth(word, 700) + 1 + 2 * 8 + 2
      // At the band's 14px, and at 16px should the app's type run larger: the label, with the plain Button's
      // padding (4px a side), reaches the pill's edges and stays inside the layer (the pill and 3ch, 1ch = 0.6em, a side).
      for (const px of [14, 16]) {
        const label = tagBlanks(word) * BLANK_EM * px
        expect(label).toBeGreaterThanOrEqual(pill - 8)
        expect(label + 8).toBeLessThanOrEqual(pill + 2 * 3 * 0.6 * px)
      }
    }
  })

  test('an empty piece beneath is left out, so no gap opens above Ember', async ($, on) => {
    mock.clock(on, { now: START })
    world(on, [])
    await $.session.start({ ...session, surface: 'desktop', isInteractive: true })
    await $.turn.complete(turn())
    const ui = await $.ui.mount({ plugin: 'ember', surface: 'desktop', component: 'AbovePrompt', props: bandProps })
    const tree = await ui.drawn() as { children?: Array<{ props?: { key?: string } }> }
    expect(tree.children?.map(c => c.props?.key)).toEqual(['ember'])
  })

  test('band-stack: the cards beneath are flattened and sorted, Handoff on top, then Backstage, then the rest, Ember nearest the prompt', async ($, on) => {
    mock.clock(on, { now: START })
    world(on, [], { stack: [['backstage', '1 running'], ['other', 'someone else'], ['handoff', 'Hand off?'], ['blank', '']] })
    await $.session.start({ ...session, surface: 'desktop', isInteractive: true })
    await $.turn.complete(turn())
    const ui = await $.ui.mount({ plugin: 'ember', surface: 'desktop', component: 'AbovePrompt', props: bandProps })
    const tree = await ui.drawn() as { props?: { key?: string }; children?: Array<{ props?: { key?: string } }> }
    expect(tree.props?.key).toBe('band-stack')
    expect(tree.children?.map(c => c.props?.key)).toEqual(['handoff', 'backstage', 'other', 'ember'])
  })

  test('rankOf and stackPieces follow the shared order', () => {
    expect([rankOf({ props: { key: 'handoff' } }), rankOf({ props: { key: 'backstage' } }), rankOf({ props: { key: 'x' } }), rankOf({ props: { key: 'ember' } }), rankOf('text')]).toEqual([10, 20, 50, 90, 50])
    expect(stackPieces(null)).toEqual([])
    expect(stackPieces({ type: 'engine', ref: 0 })).toEqual([{ type: 'engine', ref: 0 }])
    expect(stackPieces({ type: 'Text', props: {}, children: [''] })).toEqual([])
    expect(stackPieces({ type: 'Box', props: { key: 'band-stack' }, children: [{ type: 'Box', props: { key: 'handoff' }, children: ['x'] }] })).toEqual([{ type: 'Box', props: { key: 'handoff' }, children: ['x'] }])
  })

  test('cold resume, compaction and clear reset the ribbon without a ping', async ($, on) => {
    const clock = mock.clock(on, { now: 10 * HOUR })
    const w = world(on, [], { store: new Map([['deadline:S1', 13 * HOUR]]) })
    await $.session.start({ ...session, surface: 'terminal', isInteractive: true })
    const ui = await $.ui.mount({ plugin: 'ember', surface: 'terminal', component: 'AbovePrompt', props: bandProps })
    await $.classic.SessionStart({ session_id: 'S1', source: 'resume', seconds_since_last_response: 7200, context_tokens: 200000, prompt_cache_likely_expired: true })
    expect(await tagOn(ui)).toBe('COLD')
    await $.session.compact({ trigger: 'manual', messages: [{ role: 'user', text: 'summary', toolUses: [] }] })
    expect(await tagOn(ui)).toBe('KEPT 3H')
    expect(await timeOn(ui)).toBe('from your next turn')
    await clock.advance(HOUR)
    expect(w.forks.length).toBe(0)
    await $.turn.complete(turn())
    expect(await tagOn(ui)).toBe('KEPT 2H')
    expect(await timeOn(ui)).toBe('2h left')
    await $.classic.SessionStart({ source: 'clear' })
    expect(await ui.find({ key: 'ember' })).toBe(undefined)
    await clock.advance(HOUR)
    expect(w.forks.length).toBe(0)
  })

  test('window expiry gives way to the cache\'s own state, and surveys keep their band', async ($, on) => {
    const clock = mock.clock(on, { now: START })
    const w = world(on, [], { bandText: 'survey' })
    await $.session.start({ ...session, surface: 'terminal', isInteractive: true })
    await $.turn.complete(turn())
    await $.command.run(run('keepwarm', '10m'))
    const ui = await $.ui.mount({ plugin: 'ember', surface: 'terminal', component: 'AbovePrompt', props: bandProps })
    const survey = await $.ui.mount({ plugin: 'ember', surface: 'terminal', component: 'AbovePrompt', props: { ...bandProps, hasSurvey: true } })
    expect(await survey.find({ key: 'ember' })).toBe(undefined)
    expect((await survey.find({ text: 'survey' }))?.text).toBe('survey')
    expect(await tagOn(ui)).toBe('KEPT 10M')
    expect(await timeOn(ui)).toBe('10m left')
    await clock.advance(10 * MIN)
    expect(await tagOn(ui)).toBe('WARM')
    expect(await timeOn(ui)).toBe('50m left')
    expect(w.forks.length).toBe(0)
  })

  test('a warm resume restores the warm tag and ignores subagent cache activity', async ($, on) => {
    const clock = mock.clock(on, { now: 10 * HOUR })
    const w = world(on, [nothing], { store: new Map<string, unknown>([['deadline:S1', 13 * HOUR]]) })
    await $.session.start({ ...session, surface: 'terminal', isInteractive: true })
    await $.classic.SessionStart({ session_id: 'S1', source: 'resume', seconds_since_last_response: 30 * 60, context_tokens: 200000 })
    const ui = await $.ui.mount({ plugin: 'ember', surface: 'terminal', component: 'AbovePrompt', props: bandProps })
    expect(await tagOn(ui)).toBe('KEPT 3H')
    expect(await timeOn(ui)).toBe('3h left')
    await $.turn.complete(turn({ agentId: 'worker' }))
    await $.session.compact({ trigger: 'manual', agentId: 'worker', messages: [{ role: 'user', text: 'summary', toolUses: [] }] })
    await clock.advance(30 * MIN)
    expect(await tagOn(ui)).toBe('COLD')
    expect(w.forks.length).toBe(1)
  })

  test('desktop under the SDK: the ribbon is seated when the app attaches', async ($, on) => {
    mock.clock(on, { now: START })
    const w = world(on, [])
    on('session.attach', ($, e) => ({ clientId: e.clientId }))
    await $.session.start({ ...session })
    await $.turn.complete(turn())
    await $.command.run(run('keepwarm', '90m'))
    const ui = await $.ui.mount({ plugin: 'ember', surface: 'desktop', component: 'AbovePrompt', props: bandProps })
    expect(await ui.find({ key: 'ember' })).toBe(undefined)
    expect(w.status.at(-1)).toBe('keepwarm 1h30m left · ping in 50m')
    await $.session.attach({ surface: 'desktop', clientId: 'desktop:default' })
    expect(w.status.at(-1)).toBe(undefined)
    expect(await tagOn(ui)).toBe('KEPT 1H 30M')
    expect(await timeOn(ui)).toBe('1h 30m left')
    expect(await ui.find({ type: 'Svg' })).toBeDefined()
  })

  test('each turn writes the last request time and cache life to the store', async ($, on) => {
    mock.clock(on, { now: START })
    const store = new Map<string, unknown>()
    world(on, [], { store })
    await $.session.start({ ...session, surface: 'desktop', isInteractive: true })
    expect(store.get('cache:S1')).toBe(undefined)
    await $.turn.complete(turn())
    expect(store.get('cache:S1')).toEqual({ at: START, ttl: HOUR })
  })

  // A reload starts the module over with a fresh state (the band once showed usage alone after /reload-plugins); the store
  // keeps what the last turn wrote, so the tag and its time come straight back.
  for (const [after, tag, time] of [[20 * MIN, 'WARM', '40m left'], [2 * HOUR, 'COLD', '2h']] as const) {
    test(`a reload ${after / MIN}m after the last turn shows ${tag} again without a new turn`, async ($, on) => {
      mock.clock(on, { now: START + after })
      const store = new Map<string, unknown>([['cache:S1', { at: START, ttl: HOUR }]])
      world(on, [], { store })
      await $.session.start({ ...session, surface: 'desktop', isInteractive: true })
      const ui = await $.ui.mount({ plugin: 'ember', surface: 'desktop', component: 'AbovePrompt', props: bandProps })
      expect(await tagOn(ui)).toBe(tag)
      expect(String(await timeOn(ui)).startsWith(time)).toBe(true)
    })
  }

  test('a record from the future or of another shape is passed over', async ($, on) => {
    mock.clock(on, { now: START })
    const store = new Map<string, unknown>([['cache:S1', { at: START + HOUR, ttl: HOUR }]])
    world(on, [], { store })
    await $.session.start({ ...session, surface: 'desktop', isInteractive: true })
    const ui = await $.ui.mount({ plugin: 'ember', surface: 'desktop', component: 'AbovePrompt', props: bandProps })
    expect(await ui.find({ key: 'ember-tag' })).toBe(undefined)
  })

  test('a reload in a desktop session finds the app already attached', async ($, on) => {
    mock.clock(on, { now: START })
    const w = world(on, [])
    on('session.surfaces', () => ({ value: ['desktop'] as const }))
    await $.session.start({ ...session })
    await $.turn.complete(turn())
    await $.command.run(run('keepwarm', '90m'))
    const ui = await $.ui.mount({ plugin: 'ember', surface: 'desktop', component: 'AbovePrompt', props: bandProps })
    expect(await tagOn(ui)).toBe('KEPT 1H 30M')
    expect(await timeOn(ui)).toBe('1h 30m left')
    expect(w.status.filter(Boolean)).toEqual([])
  })

  for (const surface of ['vscode', 'mobile', null] as const) {
    test(`${surface ?? 'headless'} keeps the plain status fallback`, async ($, on) => {
      mock.clock(on, { now: START })
      const w = world(on, [])
      await $.session.start({ ...session, surface })
      await $.turn.complete(turn())
      await $.command.run(run('keepwarm', '90m'))
      expect(w.status.at(-1)).toBe('keepwarm 1h30m left · ping in 50m')
      expect(w.status.at(-1)).not.toMatch(/\x1b/)
      expect(w.forks.length).toBe(0)
    })
  }

  test('a warm ping keeps the ribbon kept warm and a cold read stops it', async ($, on) => {
    const clock = mock.clock(on, { now: START })
    const w = world(on, [warm, { read: 0, write: 200000 }])
    await $.session.start({ ...session, surface: 'terminal', isInteractive: true })
    await $.turn.complete(turn())
    await $.command.run(run('keepwarm', '3h'))
    const ui = await $.ui.mount({ plugin: 'ember', surface: 'terminal', component: 'AbovePrompt', props: bandProps })
    await clock.advance(50 * MIN)
    expect(await timeOn(ui)).toBe('2h 10m left')
    expect((await $.command.run(run('keepwarm', 'status'))).text).toMatch(/last ping read 200k/)
    await clock.advance(50 * MIN)
    expect(await timeOn(ui)).toBe('keepwarm stopped')
    expect((await $.command.run(run('ember', ''))).text).toMatch(/cache was already gone/)
    await clock.advance(HOUR)
    expect(w.forks.length).toBe(2)
  })

  for (const failure of [
    { isAnswered: false, reason: 'api-error', status: 400, error: 'invalid_request', usage: usage() },
    { isAnswered: false, reason: 'empty-reply', usage: usage() },
    { isAnswered: false, reason: 'aborted', usage: usage() },
  ] satisfies ModelForkResult[]) {
    test(`structured fork failure ${failure.reason} stops without retrying`, async ($, on) => {
      const clock = mock.clock(on, { now: START })
      const w = world(on, [failure])
      await $.session.start({ ...session, surface: 'terminal', isInteractive: true })
      await $.turn.complete(turn())
      await $.command.run(run('keepwarm', '3h every 1m'))
      const ui = await $.ui.mount({ plugin: 'ember', surface: 'terminal', component: 'AbovePrompt', props: bandProps })
      await clock.advance(MIN)
      expect(await timeOn(ui)).toBe('keepwarm stopped')
      await clock.advance(2 * HOUR)
      expect(w.forks.length).toBe(1)
    })
  }
})

describe('parse and format', () => {
  test('durations', async () => {
    expect(parseDuration('6h')).toBe(6 * HOUR)
    expect(parseDuration('90m')).toBe(90 * MIN)
    expect(parseDuration('2h30m')).toBe(150 * MIN)
    expect(parseDuration('soon')).toBe(null)
    expect(fmtDuration(150 * MIN)).toBe('2h30m')
    expect(fmtDuration(7 * MIN)).toBe('7m')
    expect(fmtDuration((15 * 24 + 9) * 60 * MIN)).toBe('15d 9h')
  })
})

describe('guard', () => {
  test('refuses a cold send once with the price, then lets the resend through', async ($, on) => {
    const clock = mock.clock(on, { now: START })
    const w = world(on, [])
    await $.session.start(session)
    await $.turn.complete(turn())
    await clock.advance(3 * HOUR)
    const first = await $.prompt.submit(prompt('hi'))
    expect(first.drop).toMatch(/ember: the prompt cache \(1h\) went cold 2h00m ago\. Sending this re-writes up to 200,502 tokens at \$20\/MTok = \$4\.01/)
    expect(w.entered).toEqual([])
    const second = await $.prompt.submit(prompt('hi'))
    expect(second.drop).toBe(undefined)
    expect(w.entered).toEqual(['hi'])
  })

  test('lets slash commands, warm sends and small contexts through', async ($, on) => {
    const clock = mock.clock(on, { now: START })
    const w = world(on, [])
    await $.session.start(session)
    await $.turn.complete(turn())
    await clock.advance(30 * MIN)
    await $.prompt.submit(prompt('warm one'))
    await clock.advance(3 * HOUR)
    await $.prompt.submit(prompt('/clear'))
    await $.turn.complete(turn({ usage: usage({ cache_read_input_tokens: 20000 }) }))
    await clock.advance(3 * HOUR)
    await $.prompt.submit(prompt('small one'))
    expect(w.entered).toEqual(['warm one', '/clear', 'small one'])
  })

  test('warn mode shows the price and sends', async ($, on) => {
    const clock = mock.clock(on, { now: START })
    const w = world(on, [])
    await $.session.start(session)
    const r = await $.command.run(run('ember', 'guard warn'))
    expect(r.text).toMatch(/guard set to warn/)
    await $.turn.complete(turn())
    await clock.advance(3 * HOUR)
    await $.prompt.submit(prompt('hi'))
    expect(w.entered).toEqual(['hi'])
    expect(w.logs.at(-1)).toMatch(/Sending anyway/)
  })

  test('a paid cold write is scored and opens no keepwarm window by itself', async ($, on) => {
    const clock = mock.clock(on, { now: START })
    const w = world(on, [warm, warm, warm, warm])
    await $.session.start(session)
    await $.turn.complete(turn())
    await clock.advance(3 * HOUR)
    await $.prompt.submit(prompt('hi'))
    await $.prompt.submit(prompt('hi'))
    await $.turn.complete(turn({ usage: usage({ cache_read_input_tokens: 0, cache_creation_input_tokens: 200502 }) }))
    expect(w.logs.at(-1)).toBe('cold write of 201k tokens paid ($4.01). /keepwarm keeps the cache warm while you are away.')
    expect(w.status.at(-1)).toBe(undefined)
    await clock.advance(50 * MIN)
    expect(w.forks.length).toBe(0)
    const card = await $.command.run(run('ember', 'status'))
    expect(card.text).toMatch(/session     1 cold write paid, \$4\.01/)
    expect(card.text).toMatch(/keepwarm    off \(\/keepwarm to arm it for 6h00m\)/)
  })

  test('context comes from the live window, not the turn\'s summed usage', async ($, on) => {
    mock.clock(on, { now: START })
    const live: { tokens?: number } = {}
    const w = world(on, [], { live })
    await $.session.start(session)
    await $.turn.complete(turn())
    live.tokens = 100000
    await $.turn.complete(turn({ usage: usage({ cache_read_input_tokens: 500000, cache_creation_input_tokens: 2000 }) }))
    const card = await $.command.run(run('ember', 'status'))
    expect(card.text).toMatch(/context     100,000 tokens/)
    expect(card.text).toMatch(/0 cold writes paid/)
    expect(w.status.at(-1)).toBe(undefined)
  })

  test('/clear forgets the context, the clock and the tally', async () => {
    const s = freshState()
    s.ctx = 200000
    s.lastRequestAt = START - 2 * HOUR
    s.ackedAt = s.lastRequestAt
    s.misses = [{ at: START, tokens: 200000, usd: 4 }]
    let cancelled = false
    s.pending = { cancel: () => { cancelled = true } }
    resetForClear(s)
    expect(s.ctx).toBe(0)
    expect(s.lastRequestAt).toBe(0)
    expect(s.ackedAt).toBe(0)
    expect(s.misses).toEqual([])
    expect(s.pending).toBe(null)
    expect(cancelled).toBe(true)
  })

  test('an unguarded full miss is scored too', async ($, on) => {
    mock.clock(on, { now: START })
    const w = world(on, [warm])
    await $.session.start(session)
    await $.turn.complete(turn())
    await $.turn.complete(turn({ usage: usage({ cache_read_input_tokens: 0, cache_creation_input_tokens: 200502 }) }))
    const card = await $.command.run(run('ember', 'status'))
    expect(card.text).toMatch(/1 cold write paid/)
    expect(w.status.at(-1)).toBe(undefined)
  })

  test('stays quiet after a compaction until the first new turn', async ($, on) => {
    const clock = mock.clock(on, { now: START })
    const w = world(on, [])
    await $.session.start(session)
    await $.turn.complete(turn())
    await clock.advance(3 * HOUR)
    await $.session.compact({ trigger: 'manual', messages: [{ role: 'user', text: 'old', toolUses: [] }] })
    await $.prompt.submit(prompt('after compact'))
    expect(w.entered).toEqual(['after compact'])
    const card = await $.command.run(run('ember', 'status'))
    expect(card.text).toMatch(/reset by compaction/)
  })

  test('a cold resume seeds the guard before any turn and returns the estimate line', async () => {
    const s = freshState()
    const now = START
    const line = seedFromResume(s, { source: 'resume', model: 'claude-fable-5-1', context_tokens: 396113, seconds_since_last_response: 3 * 3600, prompt_cache_likely_expired: true, estimated_cache_write_usd: 7.92 }, now)
    expect(line).toMatch(/resuming cold\. The first message re-writes 396,113 tokens, about \$7\.92/)
    expect(s.ctx).toBe(396113)
    expect(s.lastRequestAt).toBe(now - 3 * HOUR)
    expect(seedFromResume(freshState(), { source: 'startup' }, now)).toBe(null)
    expect(seedFromResume(freshState(), { source: 'resume', context_tokens: 20000, prompt_cache_likely_expired: true }, now)).toBe(null)
  })

  test('warns once when cache-tax is still on beside it', async ($, on) => {
    mock.clock(on, { now: START })
    const w = world(on, [], { commands: ['cache-tax'] })
    await $.session.start(session)
    expect(w.logs.at(-1)).toMatch(/cache-tax is also on/)
  })
})

describe('keepwarm', () => {
  test('pings 50 minutes after the last request, then again, and reports the read', async ($, on) => {
    const clock = mock.clock(on, { now: START })
    const w = world(on, [warm, warm])
    await $.session.start(session)
    const r = await $.command.run(run('keepwarm', '6h'))
    expect(r.text).toMatch(/keepwarm on for 6h00m/)
    await $.turn.complete(turn())
    await clock.advance(49 * MIN)
    expect(w.forks.length).toBe(0)
    await clock.advance(1 * MIN)
    expect(w.forks.length).toBe(1)
    expect(w.status.at(-1)).toMatch(/keepwarm 5h10m left · ping in 50m · last ping read 200k \$0\.05/)
    await clock.advance(50 * MIN)
    expect(w.forks.length).toBe(2)
  })

  test('a new turn resets the countdown', async ($, on) => {
    const clock = mock.clock(on, { now: START })
    const w = world(on, [warm])
    await $.session.start(session)
    await $.command.run(run('keepwarm', '6h'))
    await $.turn.complete(turn())
    await clock.advance(40 * MIN)
    await $.turn.complete(turn())
    await clock.advance(40 * MIN)
    expect(w.forks.length).toBe(0)
    await clock.advance(10 * MIN)
    expect(w.forks.length).toBe(1)
  })

  test('stops when a ping reads cold', async ($, on) => {
    const clock = mock.clock(on, { now: START })
    const w = world(on, [{ read: 0, write: 180000 }, warm])
    await $.session.start(session)
    await $.command.run(run('keepwarm', '6h'))
    await $.turn.complete(turn())
    await clock.advance(50 * MIN)
    expect(w.forks.length).toBe(1)
    expect(w.status.at(-1)).toMatch(/keepwarm stopped: the ping read 0 and wrote 180k tokens \(\$3\.60\)/)
    await clock.advance(120 * MIN)
    expect(w.forks.length).toBe(1)
    const s = await $.command.run(run('keepwarm', 'status'))
    expect(s.text).toMatch(/stopped/)
  })

  test('stops when the engine returns null, a cold snapshot or an API error', async ($, on) => {
    const clock = mock.clock(on, { now: START })
    const w = world(on, [null])
    await $.session.start(session)
    await $.command.run(run('keepwarm', '1h'))
    await $.turn.complete(turn())
    await clock.advance(50 * MIN)
    expect(w.forks.length).toBe(1)
    expect(w.status.at(-1)).toMatch(/either the snapshot was cold or the API call failed/)
  })

  test('the window ends on its own, forgetting the every knob, and off cancels', async ($, on) => {
    const clock = mock.clock(on, { now: START })
    const store = new Map<string, unknown>()
    const w = world(on, [warm, warm, warm], { store })
    await $.session.start(session)
    await $.command.run(run('keepwarm', '3m every 1m'))
    await $.turn.complete(turn())
    await clock.advance(1 * MIN)
    expect(w.forks.length).toBe(1)
    await clock.advance(5 * MIN)
    expect(w.forks.length).toBe(2)
    expect(w.status.at(-1)).toBe(undefined)
    expect(store.has('every:S1')).toBe(false)
    expect(store.has('deadline:S1')).toBe(false)
    await $.command.run(run('keepwarm', '6h'))
    await $.turn.complete(turn())
    await clock.advance(10 * MIN)
    expect(w.forks.length).toBe(2)
    const off = await $.command.run(run('keepwarm', 'off'))
    expect(off.text).toBe('keepwarm is off')
    await clock.advance(60 * MIN)
    expect(w.forks.length).toBe(2)
  })

  test('the every knob lasts one window only', async ($, on) => {
    const clock = mock.clock(on, { now: START })
    const w = world(on, [warm, warm, warm, warm])
    await $.session.start(session)
    await $.command.run(run('keepwarm', '1h every 1m'))
    await $.turn.complete(turn())
    await clock.advance(2 * MIN)
    expect(w.forks.length).toBe(2)
    await $.command.run(run('keepwarm', 'off'))
    await $.command.run(run('keepwarm', '6h'))
    await $.turn.complete(turn())
    await clock.advance(10 * MIN)
    expect(w.forks.length).toBe(2)
    await $.command.run(run('keepwarm', '1h every 1m'))
    await $.turn.complete(turn())
    await clock.advance(1 * MIN)
    expect(w.forks.length).toBe(3)
    await $.command.run(run('keepwarm', '6h'))
    await $.turn.complete(turn())
    await clock.advance(10 * MIN)
    expect(w.forks.length).toBe(3)
  })

  test('a bare /keepwarm arms six hours', async ($, on) => {
    const clock = mock.clock(on, { now: START })
    const w = world(on, [warm])
    await $.session.start(session)
    const r = await $.command.run(run('keepwarm', ''))
    expect(r.text).toMatch(/^keepwarm on for 6h00m, a ping 50m after each idle stretch/)
    await $.turn.complete(turn())
    expect(w.status.at(-1)).toBe('keepwarm 6h00m left · ping in 50m')
    await clock.advance(50 * MIN)
    expect(w.forks.length).toBe(1)
  })

  test('always is remembered, arms every session start, and off ends it for good', async ($, on) => {
    const clock = mock.clock(on, { now: START })
    const store = new Map<string, unknown>([['always', true], ['deadline:S1', START - MIN], ['every:S1', MIN]])
    const w = world(on, [warm], { store })
    await $.session.start(session)
    expect(w.status.at(-1)).toBe('keepwarm 6h00m left · waiting for the first turn')
    expect(store.get('deadline:S1')).toBe(START + 6 * HOUR)
    expect(store.has('every:S1')).toBe(false)
    await $.turn.complete(turn())
    await clock.advance(1 * MIN)
    expect(w.forks.length).toBe(0)
    await clock.advance(49 * MIN)
    expect(w.forks.length).toBe(1)
    const card = await $.command.run(run('ember', ''))
    expect(card.text).toMatch(/keepwarm    on, 5h10m left · ping in 50m · last ping read 200k \$0\.05 \(always\)/)
    const off = await $.command.run(run('keepwarm', 'off'))
    expect(off.text).toBe('keepwarm is off, and always is off for every session from its next turn')
    expect(store.has('always')).toBe(false)
    expect(w.status.at(-1)).toBe(undefined)
  })

  test('/keepwarm always sets the switch and arms now', async ($, on) => {
    mock.clock(on, { now: START })
    const store = new Map<string, unknown>()
    const w = world(on, [], { store })
    await $.session.start(session)
    const r = await $.command.run(run('keepwarm', 'always'))
    expect(r.text).toMatch(/^keepwarm always on: every session stays warm until 6h00m after its last turn/)
    expect(store.get('always')).toBe(true)
    expect(store.get('deadline:S1')).toBe(START + 6 * HOUR)
    expect(w.status.at(-1)).toBe('keepwarm 6h00m left · waiting for the first turn')
  })

  test('always rolls the window forward with each turn, so a long session never outlives it', async ($, on) => {
    const clock = mock.clock(on, { now: START })
    const store = new Map<string, unknown>([['always', true]])
    const w = world(on, [warm, warm], { store })
    await $.session.start(session)
    expect(store.get('deadline:S1')).toBe(START + 6 * HOUR)
    // A turn five and a half hours in: a fixed window would end 30m later, before the first ping.
    await clock.advance(5 * HOUR + 30 * MIN)
    await $.turn.complete(turn())
    expect(store.get('deadline:S1')).toBe(START + 11 * HOUR + 30 * MIN)
    await clock.advance(50 * MIN)
    expect(w.forks.length).toBe(1)
    await clock.advance(50 * MIN)
    expect(w.forks.length).toBe(2)
  })

  test('the ping figure counts output tokens at the model\'s rate, Sonnet 5 priced as itself', async ($, on) => {
    const clock = mock.clock(on, { now: START })
    const w = world(on, [{ read: 200000, write: 0, out: 1000 }])
    await $.session.start(session)
    await $.command.run(run('keepwarm', '6h'))
    await $.turn.complete(turn({ usage: usage({ model: 'claude-sonnet-5' }) }))
    await clock.advance(50 * MIN)
    expect(w.status.at(-1)).toBe('keepwarm 5h10m left · ping in 50m · last ping read 200k $0.05')
    const card = await $.command.run(run('ember', ''))
    expect(card.text).toMatch(/cold cost   \$0\.80 to re-write it \(warm turn \$0\.04\)/)
    expect(card.text).toMatch(/break-even  up to 20 pings at the read rate cost one cold write, about 16h40m of idle at one ping per 50m/)
  })

  test('a partial write, a zero read, or a full write stops the loop; a ping\'s own few tokens do not', async ($, on) => {
    const clock = mock.clock(on, { now: START })
    const w = world(on, [{ read: 200000, write: 500 }, { read: 75000, write: 70000 }, warm])
    await $.session.start(session)
    await $.command.run(run('keepwarm', '6h every 1m'))
    await $.turn.complete(turn())
    await clock.advance(1 * MIN)
    expect(w.forks.length).toBe(1)
    expect(w.status.at(-1)).toMatch(/^keepwarm 5h59m left · ping in 1m · last ping read 200k/)
    await clock.advance(1 * MIN)
    expect(w.forks.length).toBe(2)
    expect(w.status.at(-1)).toMatch(/^keepwarm stopped: the ping read 75k and wrote 70k tokens/)
    await clock.advance(5 * MIN)
    expect(w.forks.length).toBe(2)
  })

  test('a ping that reads nothing stops the loop too', async ($, on) => {
    const clock = mock.clock(on, { now: START })
    const w = world(on, [{ read: 0, write: 0 }, warm])
    await $.session.start(session)
    await $.command.run(run('keepwarm', '6h'))
    await $.turn.complete(turn())
    await clock.advance(50 * MIN)
    expect(w.status.at(-1)).toMatch(/^keepwarm stopped: the ping read 0 and wrote 0 tokens/)
    await clock.advance(60 * MIN)
    expect(w.forks.length).toBe(1)
  })

  test('the ping figure counts uncached input at the base rate', async ($, on) => {
    const clock = mock.clock(on, { now: START })
    const w = world(on, [{ read: 200000, write: 0, input: 50000, out: 1000 }])
    await $.session.start(session)
    await $.command.run(run('keepwarm', '6h'))
    await $.turn.complete(turn({ usage: usage({ model: 'claude-sonnet-5' }) }))
    await clock.advance(50 * MIN)
    expect(w.status.at(-1)).toBe('keepwarm 5h10m left · ping in 50m · last ping read 200k $0.15')
  })

  test('the card states the break-even for Fable 5.1', async ($, on) => {
    mock.clock(on, { now: START })
    world(on, [])
    await $.session.start(session)
    await $.turn.complete(turn())
    const card = await $.command.run(run('ember', ''))
    expect(card.text).toMatch(/break-even  up to 80 pings at the read rate cost one cold write, about 2d 18h of idle at one ping per 50m/)
  })

  test('/keepwarm on a cold session schedules no fork before a turn, and does after one', async ($, on) => {
    const clock = mock.clock(on, { now: START })
    const w = world(on, [warm])
    await $.session.start(session)
    await $.turn.complete(turn())
    await clock.advance(15 * 24 * HOUR)
    const r = await $.command.run(run('keepwarm', ''))
    expect(r.text).toBe('keepwarm on for 6h00m. The cache is cold now, so the first ping comes 50m after the next turn')
    expect(w.status.at(-1)).toBe('keepwarm 6h00m left · cold now, first ping 50m after the next turn')
    await clock.advance(1 * MIN)
    expect(w.forks.length).toBe(0)
    await clock.advance(60 * MIN)
    expect(w.forks.length).toBe(0)
    const card = await $.command.run(run('ember', ''))
    expect(card.text).toMatch(/keepwarm    on, 4h59m left · cold now, first ping 50m after the next turn/)
    await $.turn.complete(turn())
    expect(w.status.at(-1)).toBe('keepwarm 4h59m left · ping in 50m')
    await clock.advance(49 * MIN)
    expect(w.forks.length).toBe(0)
    await clock.advance(1 * MIN)
    expect(w.forks.length).toBe(1)
  })

  test('the always switch on a cold resume schedules no fork before a turn, and does after one', async ($, on) => {
    const clock = mock.clock(on, { now: START })
    const store = new Map<string, unknown>([['always', true]])
    const w = world(on, [warm], { store })
    await $.session.start(session)
    await $.turn.complete(turn())
    await $.command.run(run('keepwarm', 'off'))
    await clock.advance(15 * 24 * HOUR)
    // The test kit cannot raise classic.SessionStart, so the cold state comes from the turn above and a second start arms the switch over it.
    store.set('always', true)
    await $.session.start(session)
    expect(w.status.at(-1)).toBe('keepwarm 6h00m left · cold now, first ping 50m after the next turn')
    await clock.advance(1 * MIN)
    expect(w.forks.length).toBe(0)
    const r = await $.command.run(run('keepwarm', 'always'))
    expect(r.text).toBe('keepwarm always on: every session stays warm until 6h00m after its last turn; /keepwarm off turns it off for good. The cache is cold now, so the first ping comes 50m after the next turn')
    await clock.advance(60 * MIN)
    expect(w.forks.length).toBe(0)
    await $.turn.complete(turn())
    await clock.advance(50 * MIN)
    expect(w.forks.length).toBe(1)
  })

  test('a cold window expires and a later cold write opens no window by itself', async ($, on) => {
    const clock = mock.clock(on, { now: START })
    const store = new Map<string, unknown>()
    const w = world(on, [warm], { store })
    await $.session.start(session)
    await $.turn.complete(turn())
    await clock.advance(2 * HOUR)
    await $.command.run(run('keepwarm', '90m every 1m'))
    await clock.advance(90 * MIN)
    expect(w.forks.length).toBe(0)
    expect(store.has('deadline:S1')).toBe(false)
    expect(store.has('every:S1')).toBe(false)
    expect(w.status.at(-1)).toBe(undefined)
    expect((await $.command.run(run('keepwarm', 'status'))).text).toBe('keepwarm is off')
    await $.turn.complete(turn({ usage: usage({ cache_read_input_tokens: 0, cache_creation_input_tokens: 200000 }) }))
    await clock.advance(50 * MIN)
    expect(w.forks.length).toBe(0)
    expect(store.has('deadline:S1')).toBe(false)
  })

  test('a turn after sleep clears the expired period and opens no window', async ($, on) => {
    let now = START
    on('clock.now', () => ({ value: now }))
    on('clock.after', () => new Promise<{ value: void }>(() => {}))
    const store = new Map<string, unknown>()
    const w = world(on, [], { store })
    await $.session.start(session)
    await $.turn.complete(turn())
    now += 2 * HOUR
    await $.command.run(run('keepwarm', '90m every 1m'))
    now += 91 * MIN
    expect(store.get('every:S1')).toBe(MIN)
    await $.turn.complete(turn({ usage: usage({ cache_read_input_tokens: 0, cache_creation_input_tokens: 200000 }) }))
    expect(store.has('every:S1')).toBe(false)
    expect(store.has('deadline:S1')).toBe(false)
    expect(w.status.at(-1)).toBe(undefined)
    expect(w.forks.length).toBe(0)
  })

  test('subagent turns do not touch the timer', async ($, on) => {
    const clock = mock.clock(on, { now: START })
    const w = world(on, [warm])
    await $.session.start(session)
    await $.command.run(run('keepwarm', '6h'))
    await $.turn.complete(turn())
    await clock.advance(40 * MIN)
    await $.turn.complete(turn({ agentId: 'a1' }))
    await clock.advance(10 * MIN)
    expect(w.forks.length).toBe(1)
  })
})

describe('store per session', () => {
  test('another session\'s window does not arm this one', async ($, on) => {
    const clock = mock.clock(on, { now: START })
    const store = new Map<string, unknown>([['deadline:other', START + HOUR], ['every:other', MIN]])
    const w = world(on, [warm], { store, sid: 'mine' })
    await $.session.start(session)
    expect(w.status.at(-1)).toBe(undefined)
    const r = await $.command.run(run('keepwarm', 'status'))
    expect(r.text).toBe('keepwarm is off')
    await $.turn.complete(turn())
    await clock.advance(50 * MIN)
    expect(w.forks.length).toBe(0)
    expect(store.get('deadline:other')).toBe(START + HOUR)
    expect(store.get('every:other')).toBe(MIN)
  })

  test('this session\'s own window is restored on start', async ($, on) => {
    const clock = mock.clock(on, { now: START })
    const store = new Map<string, unknown>([['deadline:mine', START + 2 * HOUR], ['every:mine', MIN]])
    const w = world(on, [warm], { store, sid: 'mine' })
    await $.session.start(session)
    expect(w.status.at(-1)).toBe('keepwarm 2h00m left · waiting for the first turn')
    await $.turn.complete(turn())
    await clock.advance(1 * MIN)
    expect(w.forks.length).toBe(1)
  })

  test('a window that lapsed less than a week ago is left for its own session', async ($, on) => {
    const now = START + 30 * 24 * HOUR
    mock.clock(on, { now })
    const store = new Map<string, unknown>([['deadline:recent', now - HOUR], ['every:recent', MIN]])
    world(on, [], { store, sid: 'mine' })
    await $.session.start(session)
    expect([...store.keys()]).toEqual(['deadline:recent', 'every:recent'])
  })

  test('/keepwarm off deletes only this session\'s keys', async ($, on) => {
    mock.clock(on, { now: START })
    const store = new Map<string, unknown>([['deadline:other', START + HOUR], ['every:other', MIN], ['always', true], ['guard', 'warn']])
    world(on, [], { store, sid: 'mine' })
    await $.session.start(session)
    await $.command.run(run('keepwarm', '1h every 1m'))
    expect(store.get('deadline:mine')).toBe(START + HOUR)
    expect(store.get('every:mine')).toBe(MIN)
    await $.command.run(run('keepwarm', 'off'))
    expect(store.has('deadline:mine')).toBe(false)
    expect(store.has('every:mine')).toBe(false)
    expect(store.has('always')).toBe(false)
    expect(store.get('deadline:other')).toBe(START + HOUR)
    expect(store.get('every:other')).toBe(MIN)
    expect(store.get('guard')).toBe('warn')
  })

  test('legacy bare keys are cleared on start; other sessions\' keys, live or dead, and the global switches stay', async ($, on) => {
    mock.clock(on, { now: START })
    const store = new Map<string, unknown>([
      ['deadline:old1', START - 8 * 24 * HOUR], ['every:old1', MIN],
      ['deadline:old2', 0],
      ['deadline', 0], ['every', MIN],
      ['deadline:live', START + HOUR], ['every:live', 2 * MIN],
      ['guard', 'warn'],
    ])
    world(on, [], { store, sid: 'mine' })
    await $.session.start(session)
    expect([...store.keys()]).toEqual(['deadline:old1', 'every:old1', 'deadline:old2', 'deadline:live', 'every:live', 'guard'])
  })

  test('this session\'s own dead window is cleared on start', async ($, on) => {
    mock.clock(on, { now: START })
    const store = new Map<string, unknown>([['deadline:mine', START - MIN], ['every:mine', MIN], ['deadline:other', START - MIN], ['every:other', MIN]])
    world(on, [], { store, sid: 'mine' })
    await $.session.start(session)
    expect([...store.keys()]).toEqual(['deadline:other', 'every:other'])
  })
})

describe('prices', () => {
  for (const [model, cold, warmTurn, pings] of [
    ['claude-opus-5-5', '1.60', '0.04', 40],
    ['claude-opus-5', '2.00', '0.10', 20],
    ['claude-sonnet-5-5', '0.80', '0.02', 40],
    ['claude-haiku-5-5', '0.20', '0.01', 20],
    ['claude-mythos-5-1', '4.00', '0.05', 80],
    ['claude-opus-4-1-20250805', '6.00', '0.30', 20],
    ['claude-opus-4-20250514', '6.00', '0.30', 20],
    ['claude-opus-4@20250514', '6.00', '0.30', 20],
    ['claude-opus-4-1@20250805', '6.00', '0.30', 20],
    ['anthropic.claude-opus-4-1-20250805-v1:0', '6.00', '0.30', 20],
    ['claude-opus-4-1', '6.00', '0.30', 20],
    ['claude-opus-4-5-20251101', '2.00', '0.10', 20],
    ['claude-opus-4-5@20251101', '2.00', '0.10', 20],
    ['anthropic.claude-opus-4-5-20251101-v1:0', '2.00', '0.10', 20],
    ['claude-opus-4-8', '2.00', '0.10', 20],
    ['claude-3-5-haiku-20241022', '0.32', '0.02', 20],
  ] as const) {
    test(`${model} at 200k tokens is priced from its own row`, async ($, on) => {
      mock.clock(on, { now: START })
      world(on, [], { live: { tokens: 200000 } })
      await $.session.start(session)
      await $.turn.complete(turn({ usage: usage({ model }) }))
      const card = await $.command.run(run('ember', ''))
      expect(card.text).toMatch(`cold cost   $${cold} to re-write it (warm turn $${warmTurn})`)
      expect(card.text).toMatch(`break-even  up to ${pings} pings`)
    })
  }

  test('Haiku 5.5 up to 100k tokens takes the short-prompt row', async ($, on) => {
    mock.clock(on, { now: START })
    world(on, [], { live: { tokens: 100000 } })
    await $.session.start(session)
    await $.turn.complete(turn({ usage: usage({ model: 'claude-haiku-5-5' }) }))
    const card = await $.command.run(run('ember', ''))
    expect(card.text).toMatch('cold cost   $0.02 to re-write it (warm turn $0.00)')
  })
})

describe('keepwarm input', () => {
  for (const args of ['3h every 60m', '3h every 90m', '3h every 2h']) {
    test(`${args} is refused, since it would only fire on a cold cache`, async ($, on) => {
      mock.clock(on, { now: START })
      world(on, [])
      await $.session.start(session)
      const r = await $.command.run(run('keepwarm', args))
      expect(r.text).toBe('every takes a period from 1m to 59m')
      expect((await $.command.run(run('keepwarm', 'status'))).text).toBe('keepwarm is off')
    })
  }

  test('every 59m pings before the cache goes cold', async ($, on) => {
    const clock = mock.clock(on, { now: START })
    const w = world(on, [warm])
    await $.session.start(session)
    await $.turn.complete(turn())
    await $.command.run(run('keepwarm', '3h every 59m'))
    await clock.advance(59 * MIN)
    expect(w.forks.length).toBe(1)
  })

  for (const args of ['0m', '0h', '0h0m']) {
    test(`a ${args} window is refused`, async ($, on) => {
      mock.clock(on, { now: START })
      world(on, [])
      await $.session.start(session)
      const r = await $.command.run(run('keepwarm', args))
      expect(r.text).toBe('keepwarm takes a window such as 6h or 90m, or always, off, or status')
    })
  }

  test('a stored period of an hour or more falls back to 50m', async ($, on) => {
    const clock = mock.clock(on, { now: START })
    const w = world(on, [warm], { store: new Map<string, unknown>([['deadline:S1', START + 3 * HOUR], ['every:S1', 90 * MIN]]) })
    await $.session.start(session)
    await $.turn.complete(turn())
    await clock.advance(50 * MIN)
    expect(w.forks.length).toBe(1)
  })
})

describe('always after /clear', () => {
  test('arms a fresh window under the new session id', async ($, on) => {
    const clock = mock.clock(on, { now: START })
    const store = new Map<string, unknown>([['always', true]])
    let sid = 'S1'
    const w = world(on, [warm], { store, sid: () => sid })
    await $.session.start(session)
    await $.turn.complete(turn())
    sid = 'S2'
    await $.classic.SessionStart({ source: 'clear' })
    expect(store.has('deadline:S1')).toBe(false)
    expect(store.get('deadline:S2')).toBe(START + 6 * HOUR)
    expect(w.status.at(-1)).toBe('keepwarm 6h00m left · waiting for the first turn')
    await $.turn.complete(turn())
    await clock.advance(50 * MIN)
    expect(w.forks.length).toBe(1)
  })

  test('without always, /clear leaves keepwarm off', async ($, on) => {
    const clock = mock.clock(on, { now: START })
    const w = world(on, [warm])
    await $.session.start(session)
    await $.command.run(run('keepwarm', '3h'))
    await $.turn.complete(turn())
    await $.classic.SessionStart({ source: 'clear' })
    await $.turn.complete(turn())
    await clock.advance(50 * MIN)
    expect(w.forks.length).toBe(0)
  })
})

describe('guard by origin', () => {
  for (const kind of ['task-notification', 'scheduled-trigger', 'peer', 'peer-send-message', 'observer'] as const) {
    test(`a cold ${kind} prompt is sent and scored, and the next typed prompt is still refused`, async ($, on) => {
      const clock = mock.clock(on, { now: START })
      const w = world(on, [])
      await $.session.start(session)
      await $.turn.complete(turn())
      await clock.advance(3 * HOUR)
      const r = await $.prompt.submit({ text: 'agent finished', wait: false, origin: { kind } })
      expect(r.drop).toBe(undefined)
      expect(w.entered).toEqual(['agent finished'])
      expect(w.logs.at(-1)).toMatch(new RegExp(`Sending anyway, since this ${kind} prompt cannot be sent again`))
      await $.turn.complete(turn({ usage: usage({ cache_read_input_tokens: 0, cache_creation_input_tokens: 200000 }) }))
      expect((await $.command.run(run('ember', ''))).text).toMatch(/session     1 cold write paid/)
      await $.command.run(run('keepwarm', 'off'))
      await clock.advance(3 * HOUR)
      expect((await $.prompt.submit(prompt('hi'))).drop).toMatch(/^ember: the prompt cache \(1h\) went cold/)
    })
  }

  for (const origin of [
    { kind: 'bridge' }, { kind: 'sdk' }, { kind: 'unclassified' }, { kind: 'slack-ping' },
    { kind: 'channel', server: 'telegram' }, { kind: 'auto-continuation' },
  ] satisfies PromptSubmitInput['origin'][]) {
    test(`a cold ${origin.kind} prompt, which a person may have sent, is refused like a typed one`, async ($, on) => {
      const clock = mock.clock(on, { now: START })
      world(on, [])
      await $.session.start(session)
      await $.turn.complete(turn())
      await clock.advance(3 * HOUR)
      expect((await $.prompt.submit({ text: 'hi', wait: false, origin })).drop).toMatch(/^ember:/)
    })
  }
})

describe('ping failures', () => {
  test('after a restart with nothing to fork, the window waits for the next turn instead of stopping', async ($, on) => {
    const clock = mock.clock(on, { now: 10 * HOUR })
    const store = new Map<string, unknown>([['deadline:S1', 13 * HOUR]])
    const w = world(on, [{ isAnswered: false, reason: 'nothing-to-fork' }, warm], { store })
    await $.session.start(session)
    await $.classic.SessionStart({ session_id: 'S1', source: 'resume', seconds_since_last_response: 40 * 60, context_tokens: 200000 })
    await clock.advance(10 * MIN)
    expect(w.forks.length).toBe(1)
    expect(w.status.at(-1)).toBe('keepwarm 2h50m left · nothing to fork yet, first ping after the next turn')
    expect(store.get('deadline:S1')).toBe(13 * HOUR)
    await clock.advance(HOUR)
    expect(w.forks.length).toBe(1)
    await $.turn.complete(turn())
    await clock.advance(50 * MIN)
    expect(w.forks.length).toBe(2)
    expect(w.status.at(-1)).toMatch(/ping in 50m · last ping read 200k/)
  })

  for (const status of [429, 529, 500, null]) {
    test(`an API error ${status} is retried and the loop goes on once a ping lands`, async ($, on) => {
      const clock = mock.clock(on, { now: START })
      const w = world(on, [{ isAnswered: false, reason: 'api-error', status, error: 'rate_limit', usage: usage() }, warm, warm])
      await $.session.start(session)
      await $.turn.complete(turn())
      await $.command.run(run('keepwarm', '3h'))
      await clock.advance(50 * MIN)
      expect(w.forks.length).toBe(1)
      expect(w.status.at(-1)).toBe('keepwarm 2h10m left · API busy, ping retry 1 of 3')
      await clock.advance(MIN)
      expect(w.forks.length).toBe(2)
      expect(w.status.at(-1)).toMatch(/ping in 50m · last ping read 200k/)
      await clock.advance(50 * MIN)
      expect(w.forks.length).toBe(3)
    })
  }

  test('a lasting 429 stops after three retries, before the cache goes cold', async ($, on) => {
    const clock = mock.clock(on, { now: START })
    const w = world(on, [busy, busy, busy, busy])
    await $.session.start(session)
    await $.turn.complete(turn())
    await $.command.run(run('keepwarm', '3h'))
    await clock.advance(57 * MIN)
    expect(w.forks.length).toBe(4)
    expect(w.status.at(-1)).toBe('keepwarm stopped: the API call failed (429) after 3 retries')
    await clock.advance(2 * HOUR)
    expect(w.forks.length).toBe(4)
  })

  test('a retry that would land within a minute of the cache going cold is not tried', async ($, on) => {
    const clock = mock.clock(on, { now: START })
    const w = world(on, [busy])
    await $.session.start(session)
    await $.turn.complete(turn())
    await $.command.run(run('keepwarm', '3h every 58m'))
    await clock.advance(58 * MIN)
    expect(w.forks.length).toBe(1)
    expect(w.status.at(-1)).toBe('keepwarm stopped: the API call failed (429)')
  })
})

describe('stale and late ping results', () => {
  // The tsconfig loads no DOM or Node types; the runtime has a real setTimeout to let a released fork finish.
  const realTimer = globalThis as unknown as { setTimeout(fn: () => void, ms: number): unknown }
  const settle = () => new Promise<void>(r => { realTimer.setTimeout(r, 20) })
  const gated = () => {
    let release = () => {}
    return { gate: () => new Promise<void>(r => { release = r }), release: () => release() }
  }

  test('a 429 that lands after a compaction schedules no retry', async ($, on) => {
    const clock = mock.clock(on, { now: START })
    const g = gated()
    const w = world(on, [busy], { gate: g.gate })
    await $.session.start(session)
    await $.turn.complete(turn())
    await $.command.run(run('keepwarm', '3h'))
    await clock.advance(50 * MIN)
    expect(w.forks.length).toBe(1)
    await $.session.compact({ trigger: 'manual', messages: [{ role: 'user', text: 'summary', toolUses: [] }] })
    g.release()
    await settle()
    await clock.advance(5 * MIN)
    expect(w.forks.length).toBe(1)
    expect(w.status.at(-1)).toBe('keepwarm 2h10m left · waiting for the first turn after compaction')
  })

  test('a 429 that lands after /clear with always on leaves the new window alone', async ($, on) => {
    const clock = mock.clock(on, { now: START })
    const store = new Map<string, unknown>([['always', true]])
    let sid = 'S1'
    const g = gated()
    const w = world(on, [busy], { store, sid: () => sid, gate: g.gate })
    await $.session.start(session)
    await $.turn.complete(turn())
    await clock.advance(50 * MIN)
    expect(w.forks.length).toBe(1)
    sid = 'S2'
    await $.classic.SessionStart({ source: 'clear' })
    g.release()
    await settle()
    expect(store.get('deadline:S2')).toBe(START + 50 * MIN + 6 * HOUR)
    expect(w.status.at(-1)).toBe('keepwarm 6h00m left · waiting for the first turn')
  })

  test('nothing to fork that lands after a turn does not hold the next ping', async ($, on) => {
    const clock = mock.clock(on, { now: START })
    const g = gated()
    const w = world(on, [nothing, warm], { gate: async () => { if (w.forks.length === 1) await g.gate() } })
    await $.session.start(session)
    await $.turn.complete(turn())
    await $.command.run(run('keepwarm', '3h'))
    await clock.advance(50 * MIN)
    await $.turn.complete(turn())
    g.release()
    await settle()
    await clock.advance(50 * MIN)
    expect(w.forks.length).toBe(2)
    expect(w.status.at(-1)).toMatch(/ping in 50m · last ping read 200k/)
  })

  test('a retry whose timer fires inside the last minute is not sent', async ($, on) => {
    let now = START
    const timers: Array<() => void> = []
    on('clock.now', () => ({ value: now }))
    on('clock.after', () => new Promise<{ value: void }>(r => { timers.push(() => r({ value: undefined })) }))
    const w = world(on, [busy, warm])
    await $.session.start(session)
    await $.turn.complete(turn())
    await $.command.run(run('keepwarm', '3h'))
    now += 50 * MIN
    timers.at(-1)?.()
    await settle()
    expect(w.forks.length).toBe(1)
    expect(w.status.at(-1)).toBe('keepwarm 2h10m left · API busy, ping retry 1 of 3')
    // The host slept through the retry's one-minute slot and wakes 30 seconds before the cache goes cold.
    now += 9.5 * 60 * 1000
    timers.at(-1)?.()
    await settle()
    expect(w.forks.length).toBe(1)
    expect(w.status.at(-1)).toBe('keepwarm stopped: the API call failed (429) after 1 retry')
  })
})

describe('price edge cases', () => {
  test('Claude Haiku 3.5 by display name takes the Haiku 3.5 row', async ($, on) => {
    mock.clock(on, { now: START })
    world(on, [], { live: { tokens: 200000 } })
    await $.session.start(session)
    await $.turn.complete(turn({ usage: usage({ model: 'Claude Haiku 3.5' }) }))
    expect((await $.command.run(run('ember', ''))).text).toMatch('cold cost   $0.32 to re-write it (warm turn $0.02)')
  })

  test('without step usage, a Haiku 5.5 comeback is priced at the tier of the context it re-sent', async ($, on) => {
    const clock = mock.clock(on, { now: START })
    world(on, [])
    await $.session.start(session)
    await $.command.run(run('ember', 'guard warn'))
    await $.turn.complete(turn({ usage: usage({ model: 'claude-haiku-5-5', cache_read_input_tokens: 0, cache_creation_input_tokens: 99000 }) }))
    await clock.advance(2 * HOUR)
    // Two requests summed: the 99k comeback write under 100k, then a step that crossed it.
    await $.turn.complete(turn({ usage: usage({ model: 'claude-haiku-5-5', cache_read_input_tokens: 0, cache_creation_input_tokens: 100500 }) }))
    expect((await $.command.run(run('ember', ''))).text).toMatch(/session     1 cold write paid, \$0\.02/)
  })
})

describe('per-request pricing and window extension', () => {
  const settle = () => new Promise<void>(r => { (globalThis as unknown as { setTimeout(fn: () => void, ms: number): unknown }).setTimeout(r, 20) })
  const haiku = (read: number, write: number) => usage({ model: 'claude-haiku-5-5', cache_read_input_tokens: read, cache_creation_input_tokens: write })
  const step = async ($: Parameters<TestBody>[0], index: number) => {
    for await (const c of $.turn.step({ turnId: 'comeback', index, model: 'claude-haiku-5-5', messageCount: 2 })) void c
  }

  test('a Haiku 5.5 comeback request over 100k is priced at the long tier though the context before was under it', async ($, on) => {
    const clock = mock.clock(on, { now: START })
    world(on, [], { steps: [haiku(0, 101000)] })
    await $.session.start(session)
    await $.command.run(run('ember', 'guard warn'))
    await $.turn.complete(turn({ usage: haiku(0, 99000) }))
    await clock.advance(2 * HOUR)
    await step($, 0)
    await $.turn.complete(turn({ usage: haiku(0, 101000) }))
    expect((await $.command.run(run('ember', ''))).text).toMatch(/session     1 cold write paid, \$0\.10/)
  })

  test('a Haiku 5.5 turn whose requests straddle 100k prices each write at its own tier', async ($, on) => {
    const clock = mock.clock(on, { now: START })
    world(on, [], { steps: [haiku(0, 99000), haiku(99000, 60000)] })
    await $.session.start(session)
    await $.command.run(run('ember', 'guard warn'))
    await $.turn.complete(turn({ usage: haiku(0, 99000) }))
    await clock.advance(2 * HOUR)
    await step($, 0)
    await step($, 1)
    // 99,000 at $0.20 plus 60,000 at $1, against $0.16 for all at $1 or $0.03 for all at $0.20.
    await $.turn.complete(turn({ usage: haiku(99000, 159000) }))
    expect((await $.command.run(run('ember', ''))).text).toMatch(/session     1 cold write paid, \$0\.08/)
  })

  test('a ping out when /keepwarm extends the window still counts', async ($, on) => {
    const clock = mock.clock(on, { now: START })
    let release = () => {}
    const w = world(on, [warm, warm], { gate: async () => { if (w.forks.length === 1) await new Promise<void>(r => { release = r }) } })
    await $.session.start(session)
    await $.turn.complete(turn())
    await $.command.run(run('keepwarm', '3h'))
    await clock.advance(50 * MIN)
    expect(w.forks.length).toBe(1)
    await $.command.run(run('keepwarm', '6h'))
    release()
    await settle()
    expect(w.status.at(-1)).toMatch(/ping in 50m · last ping read 200k/)
    await clock.advance(50 * MIN)
    expect(w.forks.length).toBe(2)
  })
})

describe('pings in flight', () => {
  const settle = () => new Promise<void>(r => { (globalThis as unknown as { setTimeout(fn: () => void, ms: number): unknown }).setTimeout(r, 20) })
  // Holds the first fork until released; later forks answer at once.
  const holdFirst = (w: () => { forks: number[] }) => {
    let release = () => {}
    const gate = async () => { if (w().forks.length === 1) await new Promise<void>(r => { release = r }) }
    return { gate, release: () => release() }
  }

  test('extending the window while a ping is out sends no second ping, and a cold reply then stops it', async ($, on) => {
    const clock = mock.clock(on, { now: START })
    const h = holdFirst(() => w)
    const w = world(on, [{ read: 0, write: 200000 }, warm], { gate: h.gate })
    await $.session.start(session)
    await $.turn.complete(turn())
    await $.command.run(run('keepwarm', '3h'))
    await clock.advance(50 * MIN)
    await $.command.run(run('keepwarm', '6h'))
    await clock.advance(5 * 1000)
    expect(w.forks.length).toBe(1)
    h.release()
    await settle()
    expect(w.forks.length).toBe(1)
    expect(w.status.at(-1)).toMatch(/keepwarm stopped: the ping read 0 and wrote 200k/)
  })

  test('a main request while a ping is out supersedes its cold reply', async ($, on) => {
    const clock = mock.clock(on, { now: START })
    const h = holdFirst(() => w)
    const w = world(on, [{ read: 0, write: 200000 }, warm], { gate: h.gate })
    await $.session.start(session)
    await $.turn.complete(turn())
    await $.command.run(run('keepwarm', '3h'))
    await clock.advance(50 * MIN)
    await clock.advance(MIN)
    for await (const c of $.turn.step({ turnId: 'next', index: 0, model: 'claude-fable-5-1', messageCount: 3 })) void c
    h.release()
    await settle()
    expect(w.status.at(-1)).not.toMatch(/stopped/)
    await $.turn.complete(turn())
    await clock.advance(50 * MIN)
    expect(w.forks.length).toBe(2)
    expect(w.status.at(-1)).toMatch(/ping in 50m · last ping read 200k/)
  })

  test('a turn aborted before any request keeps the reply of a ping that was out', async ($, on) => {
    const clock = mock.clock(on, { now: START })
    const h = holdFirst(() => w)
    const w = world(on, [warm, warm], { gate: h.gate })
    await $.session.start(session)
    await $.turn.complete(turn())
    await $.command.run(run('keepwarm', '3h'))
    await clock.advance(50 * MIN)
    await clock.advance(MIN)
    await $.turn.complete(turn({ isAborted: true, usage: undefined }))
    h.release()
    await settle()
    expect(w.status.at(-1)).toMatch(/last ping read 200k/)
    // The next ping counts from the ping's own read, not from the aborted turn.
    await clock.advance(49 * MIN)
    expect(w.forks.length).toBe(2)
  })
})

describe('ping timing races', () => {
  const settle = () => new Promise<void>(r => { (globalThis as unknown as { setTimeout(fn: () => void, ms: number): unknown }).setTimeout(r, 20) })

  test('a timer that fires while another ping waits on the clock never sends a second fork', async ($, on) => {
    let now = START
    let hold: Promise<void> | null = null
    let releaseClock = () => {}
    const timers: Array<() => void> = []
    on('clock.now', async () => {
      const h = hold
      hold = null
      if (h) await h
      return { value: now }
    })
    on('clock.after', () => new Promise<{ value: void }>(r => { timers.push(() => r({ value: undefined })) }))
    // Ping B's fork stays out until released, so it is in flight when A resumes.
    let releaseFork = () => {}
    const w = world(on, [warm, warm], { gate: async () => { if (w.forks.length === 1) await new Promise<void>(r => { releaseFork = r }) } })
    await $.session.start(session)
    await $.turn.complete(turn())
    await $.command.run(run('keepwarm', '3h'))
    now += 50 * MIN
    // Ping A's clock read is held; the extension's own reads go through.
    hold = new Promise<void>(r => { releaseClock = r })
    timers.at(-1)?.()
    await settle()
    await $.command.run(run('keepwarm', '6h'))
    now += 1000
    timers.at(-1)?.()
    await settle()
    expect(w.forks.length).toBe(1)
    releaseClock()
    await settle()
    expect(w.forks.length).toBe(1)
    releaseFork()
    await settle()
    expect(w.forks.length).toBe(1)
    expect(w.status.at(-1)).toMatch(/last ping read 200k/)
  })

  test('a superseded reply followed by an early timer still leaves the window armed', async ($, on) => {
    const clock = mock.clock(on, { now: START })
    let release = () => {}
    const w = world(on, [warm, warm], { gate: async () => { if (w.forks.length === 1) await new Promise<void>(r => { release = r }) } })
    await $.session.start(session)
    await $.turn.complete(turn())
    await $.command.run(run('keepwarm', '3h'))
    await clock.advance(50 * MIN)
    await $.command.run(run('keepwarm', '6h'))
    // A long tool call: the turn's first request lands, and the turn does not complete.
    for await (const c of $.turn.step({ turnId: 'long', index: 0, model: 'claude-fable-5-1', messageCount: 3 })) void c
    release()
    await settle()
    await clock.advance(2 * 1000)
    await clock.advance(50 * MIN)
    expect(w.forks.length).toBe(2)
  })
})

describe('retry after a window extension', () => {
  const settle = () => new Promise<void>(r => { (globalThis as unknown as { setTimeout(fn: () => void, ms: number): unknown }).setTimeout(r, 20) })

  test('a 429 that lands after /keepwarm extends the window waits the full retry delay', async ($, on) => {
    const clock = mock.clock(on, { now: START })
    let release = () => {}
    const w = world(on, [busy, warm], { gate: async () => { if (w.forks.length === 1) await new Promise<void>(r => { release = r }) } })
    await $.session.start(session)
    await $.turn.complete(turn())
    await $.command.run(run('keepwarm', '3h'))
    await clock.advance(50 * MIN)
    await $.command.run(run('keepwarm', '6h'))
    release()
    await settle()
    expect(w.status.at(-1)).toMatch(/API busy, ping retry 1 of 3/)
    // The extension's one-second timer is gone; only the one-minute retry remains.
    await clock.advance(30 * 1000)
    expect(w.forks.length).toBe(1)
    await clock.advance(30 * 1000)
    expect(w.forks.length).toBe(2)
    expect(w.status.at(-1)).toMatch(/last ping read 200k/)
  })
})

describe('one timer at a time', () => {
  const settle = () => new Promise<void>(r => { (globalThis as unknown as { setTimeout(fn: () => void, ms: number): unknown }).setTimeout(r, 20) })

  test('a 429 that lands while /keepwarm is reading the clock leaves one live timer', async ($, on) => {
    let now = START
    let holdNext = false
    let releaseClock = () => {}
    const timers: Array<() => void> = []
    on('clock.now', async () => {
      if (holdNext) {
        holdNext = false
        await new Promise<void>(r => { releaseClock = r })
      }
      return { value: now }
    })
    on('clock.after', () => new Promise<{ value: void }>(r => { timers.push(() => r({ value: undefined })) }))
    // The extension writes its deadline, then arms; holding the next clock read pauses it inside arm().
    let watch = false
    class Store extends Map<string, unknown> {
      override set(key: string, value: unknown) {
        if (watch && key === 'deadline:S1') holdNext = true
        return super.set(key, value)
      }
    }
    let releaseFork = () => {}
    const w = world(on, [busy, busy, busy, warm], { store: new Store(), gate: async () => { if (w.forks.length === 1) await new Promise<void>(r => { releaseFork = r }) } })
    await $.session.start(session)
    await $.turn.complete(turn())
    await $.command.run(run('keepwarm', '3h'))
    now += 50 * MIN
    timers.at(-1)?.()
    await settle()
    expect(w.forks.length).toBe(1)
    const before = timers.length
    watch = true
    const extension = $.command.run(run('keepwarm', '6h'))
    await settle()
    releaseFork()
    await settle()
    releaseClock()
    await extension
    await settle()
    // Two timers were set since the first ping: the retry's, then the extension's. Fire the extension's at
    // one second and the retry's at its minute, a beat apart, as the host would; only a live timer may send.
    expect(timers.length - before).toBe(2)
    now += 1000
    timers[before + 1]?.()
    await settle()
    expect(w.forks.length).toBe(2)
    now += MIN
    timers[before]?.()
    await settle()
    expect(w.forks.length).toBe(2)
  })
})

describe('a paused ping yields to a newer schedule', () => {
  const settle = () => new Promise<void>(r => { (globalThis as unknown as { setTimeout(fn: () => void, ms: number): unknown }).setTimeout(r, 20) })

  test('a ping paused on the clock does not send after a newer ping set a retry', async ($, on) => {
    let now = START
    let holdNext = false
    let releaseClock = () => {}
    const timers: Array<() => void> = []
    on('clock.now', async () => {
      if (holdNext) {
        holdNext = false
        await new Promise<void>(r => { releaseClock = r })
      }
      return { value: now }
    })
    on('clock.after', () => new Promise<{ value: void }>(r => { timers.push(() => r({ value: undefined })) }))
    const w = world(on, [busy, busy, busy, busy])
    await $.session.start(session)
    await $.turn.complete(turn())
    await $.command.run(run('keepwarm', '3h'))
    now += 50 * MIN
    // Ping A pauses on its clock read.
    holdNext = true
    timers.at(-1)?.()
    await settle()
    // The extension sets timer B; B pings, gets a 429 and schedules a one-minute retry.
    await $.command.run(run('keepwarm', '6h'))
    now += 1000
    timers.at(-1)?.()
    await settle()
    expect(w.forks.length).toBe(1)
    expect(w.status.at(-1)).toMatch(/API busy, ping retry 1 of 3/)
    releaseClock()
    await settle()
    expect(w.forks.length).toBe(1)
    expect(w.status.at(-1)).toMatch(/API busy, ping retry 1 of 3/)
  })
})

describe('/clear overlapping /keepwarm', () => {
  const settle = () => new Promise<void>(r => { (globalThis as unknown as { setTimeout(fn: () => void, ms: number): unknown }).setTimeout(r, 20) })

  test('a window armed while /clear is still running keeps a timer', async ($, on) => {
    let now = START
    let hold: Promise<void> | null = null
    const holdNextRead = () => {
      let release = () => {}
      hold = new Promise<void>(r => { release = r })
      return () => release()
    }
    const timers: Array<() => void> = []
    const waits: number[] = []
    on('clock.now', async () => {
      const h = hold
      hold = null
      if (h) await h
      return { value: now }
    })
    on('clock.after', ($, e) => new Promise<{ value: void }>(r => { waits.push(e.ms); timers.push(() => r({ value: undefined })) }))
    const w = world(on, [warm, warm])
    await $.session.start(session)
    await $.turn.complete(turn())
    await $.command.run(run('keepwarm', '3h'))
    now += 50 * MIN
    // Ping A fires and pauses on its clock read.
    const releaseA = holdNextRead()
    timers.at(-1)?.()
    await settle()
    // /clear stops the old window and pauses on its last clock read.
    const releaseClear = holdNextRead()
    const clearing = $.classic.SessionStart({ source: 'clear' })
    await settle()
    // /keepwarm arms a new window meanwhile; then /clear finishes.
    await $.command.run(run('keepwarm', '6h'))
    const beforeClearEnds = timers.length
    releaseClear()
    await clearing
    await settle()
    // /clear reset the state before it first awaited, so the window armed meanwhile kept its timer: the wake at the
    // deadline, since the new conversation has no request yet. Nothing is cancelled or set again when /clear ends.
    expect(timers.length).toBe(beforeClearEnds)
    expect(waits.at(-1)).toBe(6 * HOUR)
    // A wakes, finds the schedule changed and a timer in place, and sends nothing.
    releaseA()
    await settle()
    expect(w.forks.length).toBe(0)
    expect(timers.length).toBe(beforeClearEnds)
    // The first turn of the new conversation starts the pings as usual.
    await $.turn.complete(turn())
    now += 50 * MIN
    timers.at(-1)?.()
    await settle()
    expect(w.forks.length).toBe(1)
  })
})

describe('always covers any break up to six hours', () => {
  const alwaysOn = () => new Map<string, unknown>([['always', true]])

  test('a window that stopped comes back on the next turn', async ($, on) => {
    const clock = mock.clock(on, { now: START })
    const store = alwaysOn()
    const w = world(on, [{ read: 0, write: 200000 }, warm], { store })
    await $.session.start(session)
    await $.turn.complete(turn())
    await clock.advance(50 * MIN)
    expect(w.status.at(-1)).toMatch(/^keepwarm stopped: the ping read 0/)
    await $.turn.complete(turn())
    expect(store.get('deadline:S1')).toBe(START + 50 * MIN + 6 * HOUR)
    await clock.advance(50 * MIN)
    expect(w.forks.length).toBe(2)
    expect(w.status.at(-1)).toMatch(/ping in 50m · last ping read 200k/)
  })

  test('a shorter window and a testing period give way to six hours at 50m on the next turn', async ($, on) => {
    const clock = mock.clock(on, { now: START })
    const store = alwaysOn()
    const w = world(on, [warm], { store })
    await $.session.start(session)
    await $.turn.complete(turn())
    await $.command.run(run('keepwarm', '90m every 2m'))
    expect(store.get('every:S1')).toBe(2 * MIN)
    await $.turn.complete(turn())
    expect(store.get('deadline:S1')).toBe(START + 6 * HOUR)
    expect(store.has('every:S1')).toBe(false)
    await clock.advance(49 * MIN)
    expect(w.forks.length).toBe(0)
    await clock.advance(MIN)
    expect(w.forks.length).toBe(1)
  })

  test('an expired window with a testing period rolls at 50m, not at its old period', async ($, on) => {
    let now = START
    on('clock.now', () => ({ value: now }))
    on('clock.after', () => new Promise<{ value: void }>(() => {}))
    const store = alwaysOn()
    const w = world(on, [], { store })
    await $.session.start(session)
    await $.turn.complete(turn())
    await $.command.run(run('keepwarm', '90m every 1m'))
    now += 91 * MIN
    await $.turn.complete(turn())
    expect(store.has('every:S1')).toBe(false)
    expect(store.get('deadline:S1')).toBe(now + 6 * HOUR)
    expect(w.status.at(-1)).toBe('keepwarm 6h00m left · ping in 50m')
  })

  test('the window rolls in the conversation after /clear too', async ($, on) => {
    const clock = mock.clock(on, { now: START })
    const store = alwaysOn()
    let sid = 'S1'
    world(on, [], { store, sid: () => sid })
    await $.session.start(session)
    sid = 'S2'
    await $.classic.SessionStart({ source: 'clear' })
    await clock.advance(5 * HOUR)
    await $.turn.complete(turn())
    expect(store.get('deadline:S2')).toBe(START + 11 * HOUR)
  })

  test('without always a turn never moves the deadline', async ($, on) => {
    const clock = mock.clock(on, { now: START })
    const store = new Map<string, unknown>()
    const w = world(on, [], { store })
    await $.session.start(session)
    await $.command.run(run('keepwarm', '90m'))
    await clock.advance(80 * MIN)
    await $.turn.complete(turn())
    expect(store.get('deadline:S1')).toBe(START + 90 * MIN)
    await clock.advance(10 * MIN)
    expect((await $.command.run(run('keepwarm', 'status'))).text).toBe('keepwarm is off')
    expect(w.forks.length).toBe(0)
  })
})

describe('/keepwarm off during a rolling turn', () => {
  const settle = () => new Promise<void>(r => { (globalThis as unknown as { setTimeout(fn: () => void, ms: number): unknown }).setTimeout(r, 20) })

  test('off wins over the window a finishing turn was opening', async ($, on) => {
    const clock = mock.clock(on, { now: START })
    const store = new Map<string, unknown>([['always', true]])
    let holdEveryDelete = false
    let release = () => {}
    const storeGate = async (op: 'get' | 'set' | 'delete', key: string) => {
      if (holdEveryDelete && op === 'delete' && key === 'every:S1') {
        holdEveryDelete = false
        await new Promise<void>(r => { release = r })
      }
    }
    const w = world(on, [warm, warm], { store, storeGate })
    await $.session.start(session)
    await $.turn.complete(turn())
    await clock.advance(10 * MIN)
    // The next turn's roll pauses while saving its window; /keepwarm off runs to the end meanwhile.
    holdEveryDelete = true
    const finishing = $.turn.complete(turn())
    await settle()
    expect((await $.command.run(run('keepwarm', 'off'))).text).toMatch(/^keepwarm is off/)
    release()
    await finishing
    await settle()
    expect(store.has('deadline:S1')).toBe(false)
    expect(store.has('always')).toBe(false)
    expect((await $.command.run(run('keepwarm', 'status'))).text).toBe('keepwarm is off')
    await clock.advance(2 * HOUR)
    expect(w.forks.length).toBe(0)
  })
})

describe('always, from the PR review', () => {
  const settle = () => new Promise<void>(r => { (globalThis as unknown as { setTimeout(fn: () => void, ms: number): unknown }).setTimeout(r, 20) })
  const alwaysOn = () => new Map<string, unknown>([['always', true]])

  test('a longer window is kept, with its testing period reset to 50m', async ($, on) => {
    mock.clock(on, { now: START })
    const store = alwaysOn()
    world(on, [], { store })
    await $.session.start(session)
    await $.turn.complete(turn())
    const r = await $.command.run(run('keepwarm', '48h every 2m'))
    expect(r.text).toMatch(/Always is on, so your next turn makes it at least 6h00m at one ping per 50m$/)
    await $.turn.complete(turn())
    expect(store.get('deadline:S1')).toBe(START + 48 * HOUR)
    expect(store.has('every:S1')).toBe(false)
  })

  test('a 48h window without a testing period is untouched by a turn', async ($, on) => {
    const clock = mock.clock(on, { now: START })
    const store = alwaysOn()
    world(on, [], { store })
    await $.session.start(session)
    await $.command.run(run('keepwarm', '48h'))
    await clock.advance(HOUR)
    await $.turn.complete(turn())
    expect(store.get('deadline:S1')).toBe(START + 48 * HOUR)
  })

  test('a turn that failed before any response does not open a window over a cold cache', async ($, on) => {
    const clock = mock.clock(on, { now: START })
    const store = alwaysOn()
    const w = world(on, [warm], { store })
    await $.session.start(session)
    await $.turn.complete(turn())
    // Back after the six-hour window ended; the first request fails for good, with no usage.
    await clock.advance(7 * HOUR)
    const before = w.forks.length
    await $.turn.complete(turn({ usage: undefined }))
    expect(store.has('deadline:S1')).toBe(false)
    await clock.advance(50 * MIN)
    expect(w.forks.length).toBe(before)
  })

  test('the cold-write receipt prints with always on, and the guard promises no window', async ($, on) => {
    const clock = mock.clock(on, { now: START })
    const w = world(on, [], { store: alwaysOn() })
    await $.session.start(session)
    await $.turn.complete(turn())
    await clock.advance(2 * HOUR)
    expect((await $.prompt.submit(prompt('hi'))).drop).toMatch(/Send it again to pay it\. Or \/clear/)
    await $.prompt.submit(prompt('hi'))
    await $.turn.complete(turn({ usage: usage({ cache_read_input_tokens: 0, cache_creation_input_tokens: 200000 }) }))
    expect(w.logs.at(-1)).toBe('cold write of 200k tokens paid ($4.00).')
  })

  test('without always the receipt points at /keepwarm', async ($, on) => {
    const clock = mock.clock(on, { now: START })
    const w = world(on, [])
    await $.session.start(session)
    await $.turn.complete(turn())
    await clock.advance(2 * HOUR)
    expect((await $.prompt.submit(prompt('hi'))).drop).not.toMatch(/keepwarm/)
    await $.prompt.submit(prompt('hi'))
    await $.turn.complete(turn({ usage: usage({ cache_read_input_tokens: 0, cache_creation_input_tokens: 200000 }) }))
    expect(w.logs.at(-1)).toBe('cold write of 200k tokens paid ($4.00). /keepwarm keeps the cache warm while you are away.')
  })

  test('/keepwarm off in another session stops this one rolling at its next turn', async ($, on) => {
    const clock = mock.clock(on, { now: START })
    const store = alwaysOn()
    world(on, [], { store })
    await $.session.start(session)
    // Another session ran /keepwarm off: the shared switch is gone from the store.
    store.delete('always')
    await clock.advance(5 * HOUR)
    await $.turn.complete(turn())
    expect(store.get('deadline:S1')).toBe(START + 6 * HOUR)
  })

  test('/keepwarm off that lands while the roll reads the clock wins', async ($, on) => {
    let now = START
    let skip = -1
    let release = () => {}
    on('clock.now', async () => {
      if (skip === 0) {
        skip = -1
        await new Promise<void>(r => { release = r })
      } else if (skip > 0) skip--
      return { value: now }
    })
    on('clock.after', () => new Promise<{ value: void }>(() => {}))
    const store = alwaysOn()
    const w = world(on, [warm], { store })
    await $.session.start(session)
    await $.turn.complete(turn())
    now += 10 * MIN
    // The finishing turn reads the clock once, then the roll reads it again: hold that second read.
    skip = 1
    const finishing = $.turn.complete(turn())
    await settle()
    expect((await $.command.run(run('keepwarm', 'off'))).text).toMatch(/^keepwarm is off/)
    release()
    await finishing
    await settle()
    expect(store.has('deadline:S1')).toBe(false)
    expect((await $.command.run(run('keepwarm', 'status'))).text).toBe('keepwarm is off')
    expect(w.forks.length).toBe(0)
  })
})

describe('the shared always switch across a turn', () => {
  const settle = () => new Promise<void>(r => { (globalThis as unknown as { setTimeout(fn: () => void, ms: number): unknown }).setTimeout(r, 20) })
  const holdOnce = (op: 'get' | 'set' | 'delete', key: string) => {
    let armed = false
    let release = () => {}
    const gate = async (o: 'get' | 'set' | 'delete', k: string) => {
      if (armed && o === op && k === key) {
        armed = false
        await new Promise<void>(r => { release = r })
      }
    }
    return { gate, arm: () => { armed = true }, release: () => release() }
  }

  test('/keepwarm off while the turn reads the switch is not undone by the old value', async ($, on) => {
    const clock = mock.clock(on, { now: START })
    const store = new Map<string, unknown>([['always', true]])
    const h = holdOnce('get', 'always')
    const w = world(on, [warm], { store, storeGate: h.gate })
    await $.session.start(session)
    await $.turn.complete(turn())
    await clock.advance(10 * MIN)
    h.arm()
    const finishing = $.turn.complete(turn())
    await settle()
    await $.command.run(run('keepwarm', 'off'))
    h.release()
    await finishing
    await settle()
    expect(store.has('deadline:S1')).toBe(false)
    expect((await $.command.run(run('keepwarm', 'status'))).text).toBe('keepwarm is off')
    await clock.advance(2 * HOUR)
    expect(w.forks.length).toBe(0)
  })

  test('/keepwarm off during a cold-writing turn leaves no window', async ($, on) => {
    const clock = mock.clock(on, { now: START })
    const store = new Map<string, unknown>([['always', true]])
    const h = holdOnce('get', 'always')
    const w = world(on, [warm], { store, storeGate: h.gate })
    await $.session.start(session)
    await $.command.run(run('ember', 'guard warn'))
    await $.turn.complete(turn())
    await clock.advance(2 * HOUR)
    const before = w.forks.length
    h.arm()
    const finishing = $.turn.complete(turn({ usage: usage({ cache_read_input_tokens: 0, cache_creation_input_tokens: 200000 }) }))
    await settle()
    await $.command.run(run('keepwarm', 'off'))
    h.release()
    await finishing
    await settle()
    expect(store.has('deadline:S1')).toBe(false)
    expect(w.logs.at(-1)).toBe('cold write of 200k tokens paid ($4.00). /keepwarm keeps the cache warm while you are away.')
    await clock.advance(2 * HOUR)
    expect(w.forks.length).toBe(before)
  })

  test('always turned back on in another session reaches a session that saw it off', async ($, on) => {
    const clock = mock.clock(on, { now: START })
    const store = new Map<string, unknown>([['always', true]])
    world(on, [], { store })
    await $.session.start(session)
    store.delete('always')
    await clock.advance(HOUR)
    await $.turn.complete(turn())
    expect((await $.command.run(run('ember', ''))).text).not.toMatch(/\(always\)/)
    store.set('always', true)
    await clock.advance(HOUR)
    await $.turn.complete(turn())
    expect(store.get('deadline:S1')).toBe(START + 8 * HOUR)
  })
})

describe('/keepwarm off while a turn is running', () => {
  test('a cold write landing after the off opens no window', async ($, on) => {
    const clock = mock.clock(on, { now: START })
    const store = new Map<string, unknown>()
    const w = world(on, [warm], { store })
    await $.session.start(session)
    await $.turn.complete(turn())
    await clock.advance(2 * HOUR)
    expect((await $.prompt.submit(prompt('hi'))).drop).toMatch(/^ember:/)
    await $.prompt.submit(prompt('hi'))
    // The paid resend's request is out when /keepwarm off runs, and its turn finishes after.
    for await (const c of $.turn.step({ turnId: 'comeback', index: 0, model: 'claude-fable-5-1', messageCount: 3 })) void c
    await $.command.run(run('keepwarm', 'off'))
    await $.turn.complete(turn({ usage: usage({ cache_read_input_tokens: 0, cache_creation_input_tokens: 200000 }) }))
    expect(store.has('deadline:S1')).toBe(false)
    expect(w.logs.at(-1)).toBe('cold write of 200k tokens paid ($4.00). /keepwarm keeps the cache warm while you are away.')
    await clock.advance(2 * HOUR)
    expect(w.forks.length).toBe(0)
  })

  test('without an off the same cold write opens no window either', async ($, on) => {
    const clock = mock.clock(on, { now: START })
    const store = new Map<string, unknown>()
    world(on, [], { store })
    await $.session.start(session)
    await $.turn.complete(turn())
    await clock.advance(2 * HOUR)
    await $.prompt.submit(prompt('hi'))
    await $.prompt.submit(prompt('hi'))
    for await (const c of $.turn.step({ turnId: 'comeback', index: 0, model: 'claude-fable-5-1', messageCount: 3 })) void c
    await $.turn.complete(turn({ usage: usage({ cache_read_input_tokens: 0, cache_creation_input_tokens: 200000 }) }))
    expect(store.has('deadline:S1')).toBe(false)
  })
})

describe('a managed plugin above the user tier', () => {
  // Team and Enterprise accounts seat a builtin plugin at the prepend tier whose classic.* and session.compact hooks
  // continue beneath the user tier, so the mod's own hooks on those events never run.
  const managed: Plugin = {
    name: 'managed-sec',
    tier: 'prepend',
    register(on) {
      on('classic.SessionStart', ($, e, next) => next.to(e, 'append'))
      on('session.compact', ($, e, next) => next.to(e, 'append'))
    },
  }
  const end = ($: Parameters<TestBody>[0], sessionId: string, reason: 'clear' | 'resume' = 'clear') => $.session.end({ reason, sessionId, resume: { id: sessionId } })
  const step = async ($: Parameters<TestBody>[0], turnId: string, index: number, messageCount: number) => {
    for await (const c of $.turn.step({ turnId, index, model: 'claude-fable-5-1', messageCount })) void c
  }

  test('/clear reaches the mod through session.end: keepwarm stops, the tally empties and the new id is used', { plugins: [managed] }, async ($, on) => {
    const clock = mock.clock(on, { now: START })
    const store = new Map<string, unknown>()
    let sid = 'S1'
    let started = START
    const w = world(on, [warm], { store, sid: () => sid, startedAt: () => started })
    await $.session.start(session)
    await $.turn.complete(turn())
    await clock.advance(2 * HOUR)
    await $.prompt.submit(prompt('hi'))
    await $.prompt.submit(prompt('hi'))
    await $.turn.complete(turn({ usage: usage({ cache_read_input_tokens: 0, cache_creation_input_tokens: 200000 }) }))
    // A cold write opens no window by itself any more: keepwarm is armed by hand to see /clear stop it.
    await $.command.run(run('keepwarm', '3h'))
    expect(store.get('deadline:S1')).toBe(START + 5 * HOUR)
    await end($, 'S1')
    sid = 'S2'
    started = clock.now()
    await $.classic.SessionStart({ source: 'clear' })
    expect(store.has('deadline:S1')).toBe(false)
    expect(w.status.at(-1)).toBe(undefined)
    await clock.advance(50 * MIN)
    expect(w.forks.length).toBe(0)
    const card = (await $.command.run(run('ember', ''))).text
    expect(card).toMatch(/state       no request yet this session/)
    expect(card).toMatch(/session     0 cold writes paid/)
    await $.command.run(run('keepwarm', '2h'))
    expect(store.get('deadline:S2')).toBe(START + 4 * HOUR + 50 * MIN)
    expect(store.has('deadline:S1')).toBe(false)
  })

  test('always after /clear arms the new conversation under its own id', { plugins: [managed] }, async ($, on) => {
    const clock = mock.clock(on, { now: START })
    const store = new Map<string, unknown>([['always', true]])
    let sid = 'S1'
    let started = START
    const w = world(on, [warm], { store, sid: () => sid, startedAt: () => started })
    await $.session.start(session)
    await $.turn.complete(turn())
    await end($, 'S1')
    sid = 'S2'
    started = clock.now()
    await $.classic.SessionStart({ source: 'clear' })
    expect(store.has('deadline:S1')).toBe(false)
    await $.prompt.submit(prompt('hello'))
    expect(store.get('deadline:S2')).toBe(START + 6 * HOUR)
    expect(w.status.at(-1)).toBe('keepwarm 6h00m left · waiting for the first turn')
    await $.turn.complete(turn())
    await clock.advance(50 * MIN)
    expect(w.forks.length).toBe(1)
    expect(store.has('deadline:S1')).toBe(false)
  })

  test('a /clear delivered twice, through session.end and the classic start, arms always once', async ($, on) => {
    const clock = mock.clock(on, { now: START })
    const store = new Map<string, unknown>([['always', true]])
    let sid = 'S1'
    let started = START
    let sets = 0
    const w = world(on, [warm], { store, sid: () => sid, startedAt: () => started, storeGate: async (op, key) => { if (op === 'set' && key === 'deadline:S2') sets++ } })
    await $.session.start(session)
    await $.turn.complete(turn())
    await end($, 'S1')
    sid = 'S2'
    started = clock.now()
    await $.classic.SessionStart({ source: 'clear' })
    expect(sets).toBe(1)
    expect(store.has('deadline:S1')).toBe(false)
    expect(store.get('deadline:S2')).toBe(START + 6 * HOUR)
    expect(w.status.at(-1)).toBe('keepwarm 6h00m left · waiting for the first turn')
    await $.prompt.submit(prompt('hi'))
    expect(sets).toBe(1)
    // The end of a conversation already left changes nothing.
    await end($, 'S1')
    expect(store.get('deadline:S2')).toBe(START + 6 * HOUR)
    await $.turn.complete(turn())
    await clock.advance(50 * MIN)
    expect(w.forks.length).toBe(1)
  })

  test('a resumed session whose fields never arrive warns once with the price instead of refusing', { plugins: [managed] }, async ($, on) => {
    mock.clock(on, { now: START + 3 * HOUR })
    const w = world(on, [], { live: { tokens: 200000 } })
    await $.session.start(session)
    await $.classic.SessionStart({ session_id: 'S1', source: 'resume', seconds_since_last_response: 7200, context_tokens: 200000, prompt_cache_likely_expired: true })
    expect(w.logs).toEqual([])
    expect((await $.command.run(run('ember', ''))).text).toMatch(/state       unknown, resumed without the time of its last response/)
    expect((await $.prompt.submit(prompt('hi'))).drop).toBe(undefined)
    expect(w.entered).toEqual(['hi'])
    expect(w.logs).toEqual(['resumed with up to 200,000 tokens of context and no time of its last response, so the cache may be cold. If it is, this message re-writes them at $20/MTok = $4.00.'])
    await $.prompt.submit(prompt('again'))
    expect(w.logs.length).toBe(1)
    // The write it paid is still scored off the context the engine reported.
    await $.turn.complete(turn({ usage: usage({ cache_read_input_tokens: 0, cache_creation_input_tokens: 200000 }) }))
    expect(w.logs.at(-1)).toMatch(/^cold write of 200k tokens paid \(\$4\.00\)/)
  })

  test('a session first launched under an hour ago cannot be cold, so nothing is said', { plugins: [managed] }, async ($, on) => {
    mock.clock(on, { now: START + 30 * MIN })
    const w = world(on, [], { live: { tokens: 200000 } })
    await $.session.start(session)
    await $.classic.SessionStart({ session_id: 'S1', source: 'resume', seconds_since_last_response: 1800, context_tokens: 200000 })
    await $.prompt.submit(prompt('hi'))
    expect(w.logs).toEqual([])
    expect((await $.command.run(run('ember', ''))).text).toMatch(/state       no request yet this session/)
  })

  test('a resumed transcript too young to be cold is warned about once it is old enough', { plugins: [managed] }, async ($, on) => {
    const clock = mock.clock(on, { now: START + 30 * MIN })
    const w = world(on, [], { live: { tokens: 200000 } })
    await $.session.start(session)
    await $.classic.SessionStart({ session_id: 'S1', source: 'resume', seconds_since_last_response: 1800, context_tokens: 200000 })
    expect((await $.command.run(run('ember', ''))).text).toMatch(/state       resumed without the time of its last response, warm for up to 30m more/)
    await clock.advance(HOUR)
    expect((await $.command.run(run('ember', ''))).text).toMatch(/state       unknown, resumed without the time of its last response/)
    await $.prompt.submit(prompt('hi'))
    expect(w.logs.length).toBe(1)
    expect(w.logs[0]).toMatch(/^resumed with up to 200,000 tokens/)
  })

  test('with the resume fields delivered the guard prices the cold send and nothing is said twice', async ($, on) => {
    mock.clock(on, { now: START + 3 * HOUR })
    const w = world(on, [], { live: { tokens: 200000 } })
    await $.session.start(session)
    await $.classic.SessionStart({ session_id: 'S1', source: 'resume', seconds_since_last_response: 7200, context_tokens: 200000, prompt_cache_likely_expired: true })
    expect(w.logs.length).toBe(1)
    expect(w.logs[0]).toMatch(/^resuming cold/)
    expect((await $.prompt.submit(prompt('hi'))).drop).toMatch(/went cold 1h00m ago/)
    expect(w.logs.length).toBe(1)
  })

  test('an in-process resume moves the guard to the new transcript and keeps the window', { plugins: [managed] }, async ($, on) => {
    const clock = mock.clock(on, { now: START })
    const store = new Map<string, unknown>()
    let sid = 'S1'
    let started = START
    const live = { tokens: 200000 }
    const w = world(on, [], { store, sid: () => sid, startedAt: () => started, live })
    await $.session.start(session)
    await $.turn.complete(turn())
    await clock.advance(2 * HOUR)
    await $.command.run(run('keepwarm', '3h'))
    await end($, 'S1', 'resume')
    sid = 'S2'
    started = clock.now() - 30 * MIN
    live.tokens = 80000
    await $.classic.SessionStart({ session_id: 'S2', source: 'resume', seconds_since_last_response: 1800, context_tokens: 80000 })
    expect((await $.prompt.submit(prompt('hi'))).drop).toBe(undefined)
    expect(w.logs).toEqual([])
    expect(w.status.at(-1)).toBe('keepwarm 3h00m left · waiting for the first turn')
    const card = (await $.command.run(run('ember', ''))).text
    expect(card).toMatch(/context     80,000 tokens/)
    expect(card).toMatch(/session     0 cold writes paid/)
  })

  test('a restored window arms at session.start without the classic event', { plugins: [managed] }, async ($, on) => {
    const clock = mock.clock(on, { now: START })
    const store = new Map<string, unknown>([['deadline:S1', START + 10 * MIN]])
    const w = world(on, [], { store })
    await $.session.start(session)
    await $.classic.SessionStart({ session_id: 'S1', source: 'startup' })
    expect(w.status.at(-1)).toBe('keepwarm 10m left · waiting for the first turn')
    await clock.advance(10 * MIN)
    expect(w.status.at(-1)).toBe(undefined)
    expect(store.has('deadline:S1')).toBe(false)
  })

  test('the classic start arriving after session.start leaves one timer and one ping', async ($, on) => {
    const clock = mock.clock(on, { now: START })
    const store = new Map<string, unknown>([['deadline:S1', START + 3 * HOUR]])
    const w = world(on, [warm, warm], { store })
    await $.session.start(session)
    await $.classic.SessionStart({ session_id: 'S1', source: 'startup' })
    await $.turn.complete(turn())
    await clock.advance(50 * MIN)
    expect(w.forks.length).toBe(1)
    await clock.advance(50 * MIN)
    expect(w.forks.length).toBe(2)
  })

  test('a compaction that never reaches the mod is read off the next request\'s shorter transcript', { plugins: [managed] }, async ($, on) => {
    mock.clock(on, { now: START })
    const w = world(on, [])
    await $.session.start(session)
    await step($, 'first', 0, 40)
    await $.turn.complete(turn())
    await $.session.compact({ trigger: 'auto', messages: [{ role: 'user', text: 'summary', toolUses: [] }] })
    await step($, 'after', 0, 3)
    expect((await $.command.run(run('ember', ''))).text).toMatch(/state       reset by compaction/)
    await $.turn.complete(turn({ usage: usage({ cache_read_input_tokens: 0, cache_creation_input_tokens: 150000 }) }))
    expect(w.logs).toEqual([])
    expect(w.status.at(-1)).toBe(undefined)
    expect((await $.command.run(run('ember', ''))).text).toMatch(/session     0 cold writes paid/)
  })

  test('a summary written after a warm request in the same turn is no cold write', { plugins: [managed] }, async ($, on) => {
    mock.clock(on, { now: START })
    const w = world(on, [], { steps: [usage(), usage(), usage({ cache_read_input_tokens: 0, cache_creation_input_tokens: 150000 })] })
    await $.session.start(session)
    await step($, 'first', 0, 40)
    await $.turn.complete(turn())
    await step($, 'long', 0, 42)
    await $.session.compact({ trigger: 'auto', messages: [{ role: 'user', text: 'summary', toolUses: [] }] })
    await step($, 'long', 1, 3)
    await $.turn.complete(turn({ usage: usage({ cache_read_input_tokens: 200000, cache_creation_input_tokens: 150500 }) }))
    expect(w.logs).toEqual([])
    expect(w.status.at(-1)).toBe(undefined)
    expect((await $.command.run(run('ember', ''))).text).toMatch(/session     0 cold writes paid/)
  })

  test('a rewind of a few messages is not a compaction', async ($, on) => {
    mock.clock(on, { now: START })
    world(on, [])
    await $.session.start(session)
    await step($, 'first', 0, 40)
    await $.turn.complete(turn())
    await step($, 'rewound', 0, 38)
    expect((await $.command.run(run('ember', ''))).text).toMatch(/state       warm/)
  })

  test('a cold write and a compaction in the same turn still score the write', async ($, on) => {
    const clock = mock.clock(on, { now: START })
    const w = world(on, [], { steps: [usage(), usage({ cache_read_input_tokens: 0, cache_creation_input_tokens: 200000 }), usage({ cache_read_input_tokens: 0, cache_creation_input_tokens: 10000 })] })
    await $.session.start(session)
    await step($, 'first', 0, 40)
    await $.turn.complete(turn())
    await clock.advance(2 * HOUR)
    await step($, 'comeback', 0, 42)
    await step($, 'comeback', 1, 3)
    await $.turn.complete(turn({ usage: usage({ cache_read_input_tokens: 0, cache_creation_input_tokens: 210000 }) }))
    expect(w.logs.at(-1)).toMatch(/^cold write of 200k tokens paid \(\$4\.00\)/)
  })

  test('a classic clear after a command already seated the new conversation leaves its window alone', async ($, on) => {
    mock.clock(on, { now: START })
    const store = new Map<string, unknown>([['always', true]])
    let sid = 'S1'
    const w = world(on, [], { store, sid: () => sid })
    await $.session.start(session)
    await $.turn.complete(turn())
    await end($, 'S1')
    sid = 'S2'
    await $.command.run(run('keepwarm', '2h'))
    expect(store.get('deadline:S2')).toBe(START + 2 * HOUR)
    await $.classic.SessionStart({ session_id: 'S2', source: 'clear' })
    expect(store.get('deadline:S2')).toBe(START + 2 * HOUR)
    expect(w.status.at(-1)).toBe('keepwarm 2h00m left · waiting for the first turn')
  })

  test('a model switched at an in-process resume prices the new transcript', { plugins: [managed] }, async ($, on) => {
    mock.clock(on, { now: START + 3 * HOUR })
    let sid = 'S1'
    let model = 'claude-fable-5-1'
    const w = world(on, [], { sid: () => sid, model: () => model, live: { tokens: 200000 } })
    await $.session.start(session)
    await $.turn.complete(turn())
    await end($, 'S1', 'resume')
    sid = 'S2'
    model = 'claude-haiku-5-5'
    await $.classic.SessionStart({ session_id: 'S2', source: 'resume', seconds_since_last_response: 7200, context_tokens: 200000, prompt_cache_likely_expired: true })
    await $.prompt.submit(prompt('hi'))
    expect(w.logs.at(-1)).toBe('resumed with up to 200,000 tokens of context and no time of its last response, so the cache may be cold. If it is, this message re-writes them at $1/MTok = $0.20.')
    expect((await $.command.run(run('ember', ''))).text).toMatch(/^claude-haiku-5-5\n/)
  })

  test('a classic resume ahead of the old conversation\'s end keeps the seeded clock', async ($, on) => {
    const clock = mock.clock(on, { now: START })
    let sid = 'S1'
    const w = world(on, [], { sid: () => sid, live: { tokens: 200000 } })
    await $.session.start(session)
    await $.turn.complete(turn())
    await clock.advance(3 * HOUR)
    sid = 'S2'
    await $.classic.SessionStart({ session_id: 'S2', source: 'resume', seconds_since_last_response: 7200, context_tokens: 200000, prompt_cache_likely_expired: true })
    expect(w.logs.at(-1)).toMatch(/^resuming cold/)
    await end($, 'S1', 'resume')
    expect((await $.prompt.submit(prompt('hi'))).drop).toMatch(/went cold 1h00m ago/)
    expect(w.logs.length).toBe(1)
  })

  test('a window carried through a resume moves to the new id, so off and the old session find the right keys', { plugins: [managed] }, async ($, on) => {
    mock.clock(on, { now: START })
    const store = new Map<string, unknown>()
    let sid = 'S1'
    world(on, [], { store, sid: () => sid })
    await $.session.start(session)
    await $.turn.complete(turn())
    await $.command.run(run('keepwarm', '3h every 2m'))
    expect(store.get('deadline:S1')).toBe(START + 3 * HOUR)
    await end($, 'S1', 'resume')
    sid = 'S2'
    await $.prompt.submit(prompt('hi'))
    expect(windowKeys(store).sort()).toEqual(['deadline:S2', 'every:S2'])
    expect(store.get('deadline:S2')).toBe(START + 3 * HOUR)
    expect(store.get('every:S2')).toBe(2 * MIN)
    await $.command.run(run('keepwarm', 'off'))
    expect(windowKeys(store)).toEqual([])
  })

  const settle = () => new Promise<void>(r => { (globalThis as unknown as { setTimeout(fn: () => void, ms: number): unknown }).setTimeout(r, 20) })
  // Holds every delete of one key until released, in order, so two ends of the same conversation can be interleaved.
  const holdDeletes = (key: string) => {
    const waiting: Array<() => void> = []
    return {
      gate: async (op: 'get' | 'set' | 'delete', k: string) => { if (op === 'delete' && k === key) await new Promise<void>(r => { waiting.push(r) }) },
      release: () => waiting.shift()?.(),
      held: () => waiting.length,
    }
  }

  test('a session.end that lands while the classic resume is still deleting the old keys cannot wipe the seeded clock', async ($, on) => {
    const clock = mock.clock(on, { now: START })
    let sid = 'S1'
    const held = holdDeletes('deadline:S1')
    const w = world(on, [], { store: new Map<string, unknown>(), sid: () => sid, live: { tokens: 200000 }, storeGate: held.gate })
    await $.session.start(session)
    await $.turn.complete(turn())
    await clock.advance(3 * HOUR)
    sid = 'S2'
    const resuming = $.classic.SessionStart({ session_id: 'S2', source: 'resume', seconds_since_last_response: 7200, context_tokens: 200000, prompt_cache_likely_expired: true })
    await settle()
    expect(held.held()).toBe(1)
    const ending = end($, 'S1', 'resume')
    await settle()
    held.release()
    await resuming
    held.release()
    await ending
    expect(w.logs.length).toBe(1)
    expect(w.logs[0]).toMatch(/^resuming cold/)
    expect((await $.prompt.submit(prompt('hi'))).drop).toMatch(/went cold 1h00m ago/)
    expect(w.logs.length).toBe(1)
  })

  test('an end cut short in its store cleanup has already dropped the old timer and id', { plugins: [managed] }, async ($, on) => {
    const clock = mock.clock(on, { now: START })
    const store = new Map<string, unknown>()
    let sid = 'S1'
    const held = holdDeletes('deadline:S1')
    const w = world(on, [warm], { store, sid: () => sid, storeGate: held.gate })
    await $.session.start(session)
    await $.turn.complete(turn())
    await $.command.run(run('keepwarm', '3h'))
    const ending = end($, 'S1', 'resume')
    await settle()
    expect(held.held()).toBe(1)
    sid = 'S2'
    // The old conversation's ping is due while its end is still waiting on the store; the transcript it would fork is gone.
    await clock.advance(50 * MIN)
    expect(w.forks.length).toBe(0)
    await $.prompt.submit(prompt('hi'))
    expect(store.get('deadline:S2')).toBe(START + 3 * HOUR)
    held.release()
    await ending
    expect(store.has('deadline:S1')).toBe(false)
  })

  test('a /keepwarm while the old conversation is still ending waits for the host to report the next id', { plugins: [managed] }, async ($, on) => {
    mock.clock(on, { now: START })
    const store = new Map<string, unknown>()
    let sid = 'S1'
    let model = 'claude-fable-5-1'
    const held = holdDeletes('deadline:S1')
    const w = world(on, [], { store, sid: () => sid, model: () => model, storeGate: held.gate })
    await $.session.start(session)
    await $.turn.complete(turn())
    await $.command.run(run('keepwarm', '1h'))
    const ending = end($, 'S1')
    await settle()
    expect(held.held()).toBe(1)
    // The host still answers the old id: the window waits in memory, nothing is written under that id.
    expect((await $.command.run(run('keepwarm', '2h'))).text).toMatch(/^keepwarm on for 2h00m/)
    expect(store.get('deadline:S1')).toBe(START + HOUR)
    held.release()
    await ending
    expect(windowKeys(store)).toEqual([])
    sid = 'S2'
    model = 'claude-haiku-5-5'
    await $.prompt.submit(prompt('hi'))
    expect(windowKeys(store)).toEqual(['deadline:S2'])
    expect(store.get('deadline:S2')).toBe(START + 2 * HOUR)
    expect(w.status.at(-1)).toBe('keepwarm 2h00m left · waiting for the first turn')
    expect((await $.command.run(run('ember', ''))).text).toMatch(/^claude-haiku-5-5\n/)
  })

  test('a guarded cold send compacted before its first request pays the summary, not a cold write', { plugins: [managed] }, async ($, on) => {
    const clock = mock.clock(on, { now: START })
    const w = world(on, [], { steps: [usage(), usage({ cache_read_input_tokens: 0, cache_creation_input_tokens: 150000 })] })
    await $.session.start(session)
    await step($, 'first', 0, 40)
    await $.turn.complete(turn())
    await clock.advance(2 * HOUR)
    expect((await $.prompt.submit(prompt('hi'))).drop).toMatch(/^ember:/)
    await $.prompt.submit(prompt('hi'))
    await $.session.compact({ trigger: 'auto', messages: [{ role: 'user', text: 'summary', toolUses: [] }] })
    await step($, 'comeback', 0, 3)
    await $.turn.complete(turn({ usage: usage({ cache_read_input_tokens: 0, cache_creation_input_tokens: 150000 }) }))
    expect(w.logs).toEqual([])
    expect(w.status.at(-1)).toBe(undefined)
    expect((await $.command.run(run('ember', ''))).text).toMatch(/session     0 cold writes paid/)
  })

  test('a second compaction in one turn does not turn the first summary into a cold write', { plugins: [managed] }, async ($, on) => {
    mock.clock(on, { now: START })
    const summary = usage({ cache_read_input_tokens: 0, cache_creation_input_tokens: 120000 })
    const w = world(on, [], { steps: [usage(), usage(), summary, usage(), summary] })
    await $.session.start(session)
    await step($, 'first', 0, 40)
    await $.turn.complete(turn())
    await step($, 'long', 0, 42)
    await step($, 'long', 1, 3)
    await step($, 'long', 2, 15)
    await step($, 'long', 3, 3)
    await $.turn.complete(turn({ usage: usage({ cache_read_input_tokens: 200000, cache_creation_input_tokens: 241000 }) }))
    expect(w.logs).toEqual([])
    expect(w.status.at(-1)).toBe(undefined)
    expect((await $.command.run(run('ember', ''))).text).toMatch(/session     0 cold writes paid/)
  })
})

// 3.0: the cache's life read from the transcript, the cold send asked at the band, no keepwarm opened by itself.
const assistantRow = (cc: { m5?: number; h1?: number }, sidechain = false) => JSON.stringify({
  type: 'assistant', isSidechain: sidechain,
  message: { usage: { cache_creation: { ephemeral_5m_input_tokens: cc.m5 ?? 0, ephemeral_1h_input_tokens: cc.h1 ?? 0 } } },
})

describe('cache life from the transcript', () => {
  test('the newest main-thread write decides; reads, sidechains and a cut first line are passed over', () => {
    const tail = ['{"cut', assistantRow({ h1: 900 }), assistantRow({ m5: 400 }), assistantRow({}), assistantRow({ h1: 50 }, true), ''].join('\n')
    expect(cacheTtlFromTranscript(tail)).toBe(5 * MIN)
    expect(cacheTtlFromTranscript(assistantRow({ h1: 10 }))).toBe(HOUR)
    expect(cacheTtlFromTranscript('{"type":"user"}\n' + assistantRow({}))).toBe(null)
  })

  test('a 5-minute write seen at the turn end: the guard counts five minutes and keepwarm sends no ping', async ($, on) => {
    const clock = mock.clock(on, { now: START })
    const runs: string[][] = []
    on('process.run', ($, e) => { runs.push([...e.argv]); return { value: { exitCode: 0, stdout: assistantRow({ m5: 200000 }), stderr: '' } } })
    const w = world(on, [warm])
    await $.session.start(session)
    await $.turn.complete(turn())
    await $.classic.Stop({ session_id: 'S1', transcript_path: '/t/S1.jsonl', stop_hook_active: false })
    expect(runs.at(-1)).toEqual(['tail', '-c', '262144', '/t/S1.jsonl'])
    expect((await $.command.run(run('ember', ''))).text).toMatch(/cache life  5m/)
    expect((await $.command.run(run('keepwarm', '2h'))).text).toMatch(/lives 5m now, so no pings/)
    await clock.advance(6 * MIN)
    expect((await $.prompt.submit(prompt('hi'))).drop).toMatch(/the prompt cache \(5m\) went cold 1m ago/)
    await clock.advance(HOUR)
    expect(w.forks.length).toBe(0)
  })

  test('a transcript that cannot be read keeps the 1-hour default', async ($, on) => {
    const clock = mock.clock(on, { now: START })
    on('process.run', () => ({ value: { exitCode: 1, stdout: '', stderr: 'no such file' } }))
    world(on, [])
    await $.session.start(session)
    await $.turn.complete(turn())
    await $.classic.Stop({ session_id: 'S1', transcript_path: '/gone.jsonl', stop_hook_active: false })
    await clock.advance(30 * MIN)
    expect((await $.command.run(run('ember', ''))).text).toMatch(/state       warm, 30m left/)
  })
})

describe('the cold send is asked at the band', () => {
  test('desktop: the send waits, the question names /handoff on a big context, and Send anyway sends it as the person', async ($, on) => {
    const clock = mock.clock(on, { now: START })
    const w = world(on, [], { live: { tokens: 200000 }, commands: ['handoff'] })
    await $.session.start({ ...session, surface: 'desktop', isInteractive: true })
    await $.turn.complete(turn())
    await clock.advance(2 * HOUR)
    const ui = await $.ui.mount({ plugin: 'ember', surface: 'desktop', component: 'AbovePrompt', props: bandProps })
    expect((await $.prompt.submit(prompt('hi'))).drop).toMatch(/Send anyway/)
    expect(w.entered).toEqual([])
    expect(await ui.find({ type: 'Text', text: /The 1h cache went cold 1h00m ago/ })).toBeDefined()
    expect(await ui.find({ type: 'Text', text: /\/handoff/ })).toBeDefined()
    await ui.press({ key: 'ember-send' })
    expect(w.entered).toEqual(['hi'])
    expect(await ui.find({ key: 'ember-send' })).toBeUndefined()
    await $.turn.complete(turn({ usage: usage({ cache_read_input_tokens: 0, cache_creation_input_tokens: 200000 }) }))
    expect((await $.command.run(run('ember', ''))).text).toMatch(/session     1 cold write paid/)
    expect(w.logs.at(-1)).toMatch(/\/keepwarm keeps the cache warm/)
  })

  test('Cancel puts the words back in the prompt box and sends nothing; no /handoff line without the mod', async ($, on) => {
    const clock = mock.clock(on, { now: START })
    const filled: string[] = []
    on('prompt.fill', ($, e) => { filled.push(e.text); return { isFilled: true } })
    const w = world(on, [], { live: { tokens: 200000 } })
    await $.session.start({ ...session, surface: 'terminal', isInteractive: true })
    await $.turn.complete(turn())
    await clock.advance(2 * HOUR)
    const ui = await $.ui.mount({ plugin: 'ember', surface: 'terminal', component: 'AbovePrompt', props: bandProps })
    await $.prompt.submit(prompt('a long question'))
    expect(await ui.find({ type: 'Text', text: /\/handoff/ })).toBeUndefined()
    await ui.press({ key: 'ember-cancel' })
    expect(filled).toEqual(['a long question'])
    expect(w.entered).toEqual([])
    expect(await ui.find({ key: 'ember-cancel' })).toBeUndefined()
  })

  test('a new message replaces the open question, and warn mode never asks', async ($, on) => {
    const clock = mock.clock(on, { now: START })
    const w = world(on, [], { live: { tokens: 200000 } })
    await $.session.start({ ...session, surface: 'desktop', isInteractive: true })
    await $.turn.complete(turn())
    await clock.advance(2 * HOUR)
    const ui = await $.ui.mount({ plugin: 'ember', surface: 'desktop', component: 'AbovePrompt', props: bandProps })
    await $.prompt.submit(prompt('first'))
    await $.prompt.submit(prompt('second'))
    await ui.press({ key: 'ember-send' })
    expect(w.entered).toEqual(['second'])
    await $.command.run(run('ember', 'guard warn'))
    await $.turn.complete(turn())
    await clock.advance(2 * HOUR)
    await $.prompt.submit(prompt('third'))
    expect(w.entered).toEqual(['second', 'third'])
    expect(await ui.find({ key: 'ember-send' })).toBeUndefined()
  })
})
