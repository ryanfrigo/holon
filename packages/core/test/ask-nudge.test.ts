import { afterEach, beforeEach, expect, it } from 'vitest'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Holon } from '../src/holon.ts'
import { askAge, DAY, nudgeBody, nudgeButtons, openAskSummary } from '../src/asks.ts'
import { seen } from '../../../test-support/seen.ts'

let home: string
let h: Holon
beforeEach(() => {
  process.env.HOLON_FAKE_CLIS = '1'
  home = mkdtempSync(join(tmpdir(), 'holon-'))
  h = new Holon({ home, socketPath: join(home, 'holon.sock'), mcpEntry: '/dev/null' })
})
afterEach(() => h.shutdown())

const ask = (dir: string, msg: string, extra = {}) => { void h.escalate(dir, msg, 1000, 'need', { blocks: 'none', ...extra }) }
const age = (id: string, ms: number) => { (h as any).escalations.get(id).ts = new Date(Date.now() - ms).toISOString() }

it('an ask keeps what it blocks and the recommended answer', () => {
  const dir = h.create({ label: 'Director', cli: 'shell', cwd: home })
  ask(dir.id, 'Ship G7?', { blocks: 'G7 launch', recommend: 'yes' })
  expect(h.listEscalations()[0]).toMatchObject({ blocks: 'G7 launch', recommend: 'yes' })
})

it('only open human asks older than a day are due, once a day each', () => {
  const dir = h.create({ label: 'Director', cli: 'shell', cwd: home })
  const rep = h.spawn(dir.id, { label: 'Rep', cli: 'shell', cwd: home })
  ask(dir.id, 'old human ask', { recommend: 'no' })
  ask(dir.id, 'fresh human ask')
  ask(dir.id, 'old but answered')
  void h.escalate(rep.id, 'old, to a lead')
  const [old, fresh, done, toLead] = h.listEscalations()
  age(old.id, 9 * DAY); age(fresh.id, DAY - 60_000); age(done.id, 3 * DAY); age(toLead.id, 3 * DAY)
  h.answer(null, done.id, 'yes')

  const now = Date.now()
  expect(h.dueNudges(now).map(e => e.id)).toEqual([old.id])
  expect(h.dueNudges(now + 1000)).toEqual([])                       // already nudged today
  expect(h.dueNudges(now + DAY + 1000).map(e => e.id)).toEqual([old.id, fresh.id])   // a day later, both
  expect(h.listEscalations().find(e => e.id === old.id)!.lastNudgedAt).toBeDefined()
})

it('the nudge reads as question, age, blocks, recommendation; the recommended button is first', () => {
  const e = { id: 'esc-1', to: null, status: 'open' as const, message: 'Ship G7?', ts: new Date(Date.now() - 9 * DAY).toISOString(), blocks: 'G7 launch', recommend: 'no' as const }
  expect(askAge(e.ts)).toBe('9 days')
  expect(nudgeBody(e)).toBe('Ship G7?\nWaiting 9 days. Blocks: G7 launch.\nRecommended: No')
  expect(nudgeButtons(e).map(b => b.text)).toEqual(['★ No', 'Yes'])
  expect(nudgeButtons({ recommend: 'yes' }).map(b => b.text)).toEqual(['★ Yes', 'No'])
  // An open-ended ask ("which domain?") has no recommendation: no buttons, so no one-tap "yes".
  expect(nudgeButtons({})).toEqual([])
})

it('tapping a button answers through the same call as the Answer button', async () => {
  const dir = h.create({ label: 'Director', cli: 'shell', cwd: home })
  ask(dir.id, 'Ship G7?', { recommend: 'yes' })
  const [esc] = h.listEscalations()
  age(esc.id, 2 * DAY)
  const [due] = h.dueNudges()
  const reply = nudgeButtons(due)[0].answer
  h.answer(null, due.id, reply)                      // what the daemon's "answer" method runs for both paths
  expect(h.listEscalations()[0]).toMatchObject({ status: 'answered', answer: 'yes', answeredBy: null })
  expect(h.dueNudges(Date.now() + 5 * DAY)).toEqual([])
  await seen(h, dir.id, `Answer to your escalation ${esc.id}`)
})

it('openAskSummary: count, oldest age, first line of what it blocks', () => {
  const now = Date.parse('2026-11-02T00:00:00Z')
  const a = (id: string, ts: string, extra = {}) => ({ id, to: null, status: 'open' as const, message: 'm', ts, ...extra })
  expect(openAskSummary([], now)).toBeNull()
  expect(openAskSummary([a('1', '2026-11-01T00:00:00Z'), { ...a('2', '2026-10-24T00:00:00Z', { blocks: 'G7 ship\nmore' }) }, { ...a('3', '2026-10-01T00:00:00Z'), status: 'answered' as const }], now))
    .toEqual({ count: 2, age: '9 days', blocks: 'G7 ship' })
  expect(openAskSummary([a('1', '2026-11-01T00:00:00Z')], now)).toEqual({ count: 1, age: '1 day' })
})

it('openAskSummary: shows the first open ask that has blocks when the oldest lacks it', () => {
  const now = Date.parse('2026-11-02T00:00:00Z')
  const a = (id: string, ts: string, extra = {}) => ({ id, to: null, status: 'open' as const, message: 'm', ts, ...extra })
  expect(openAskSummary([a('1', '2026-10-01T00:00:00Z'), a('2', '2026-10-20T00:00:00Z', { blocks: 'G4 builders' }), a('3', '2026-10-25T00:00:00Z', { blocks: 'G5' })], now))
    .toEqual({ count: 3, age: '32 days', blocks: 'G4 builders' })
})

it('a need to the human must say what it blocks; "none" is accepted and not stored', async () => {
  const dir = h.create({ label: 'Director', cli: 'shell', cwd: home })
  await expect(h.escalate(dir.id, 'Need a token', 1000, 'need')).rejects.toThrow(/Say what this answer unblocks/)
  await expect(h.escalate(dir.id, 'Need a token', 1000, 'need', { blocks: '  ' })).rejects.toThrow(/Say what this answer unblocks/)
  expect(h.listEscalations()).toEqual([])
  await h.escalate(dir.id, 'Need a token', 1000, 'need', { blocks: 'none' })
  expect(h.listEscalations()[0].blocks).toBeUndefined()
  await h.escalate(dir.id, 'Need a login', 1000, 'need', { blocks: 'G4 outside builders 0 of 5' })
  expect(h.listEscalations()[1]).toMatchObject({ blocks: 'G4 outside builders 0 of 5' })
})

it('a question to the human needs no blocks', async () => {
  const dir = h.create({ label: 'Director', cli: 'shell', cwd: home })
  await h.escalate(dir.id, 'Which name?', 1000, 'question')
  expect(h.listEscalations()[0]).toMatchObject({ kind: 'question', status: 'open' })
})
