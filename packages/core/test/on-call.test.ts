import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { execFileSync } from 'node:child_process'
import { appendFileSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { homedir, tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { Holon } from '../src/holon.ts'
import { transcriptFor } from '../src/trace.ts'
import { claudeContext, claudeTail } from '../src/usage.ts'
import { DEFAULT_SETTINGS } from '../src/org.ts'
import { seen } from '../../../test-support/seen.ts'

let home: string
let h: Holon
beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), 'holon-'))
  h = new Holon({ home, socketPath: join(home, 'holon.sock'), mcpEntry: '/dev/null' })
})
afterEach(() => h.shutdown())

const running = (directorId: string, workspace = home) => {
  ;(h as any).directive = { text: 't', workspace, directorId, goals: ['g1'], deliverables: [], status: 'running', startedAt: '', shape: 'hierarchy', template: 'departments' }
}
const later = (min: number) => Date.now() + min * 60_000
// A seat counts as running for a real second after its last output. Wait for what bench and
// compact actually check: the shell has shown its prompt and then gone quiet. A fixed sleep
// is outlasted by a slow shell start on a loaded machine.
const quiet = async (id: string) => {
  await seen(h, id, /\S/)
  await vi.waitFor(() => expect(h.list().find(n => n.id === id)?.state).toBe('quiet'), { timeout: 20_000, interval: 50 })
}

describe('on-call department heads', () => {
  it('a quiet head is closed, and a message to its old id or its department wakes a fresh one', async () => {
    const dir = h.create({ label: 'Director', cli: 'claude', cwd: home, lead: true })
    running(dir.id)
    h.setSettings({ departments: DEFAULT_SETTINGS.departments.map(d => ({ ...d, grade: 1 })) })
    const qa = await h.openDepartment(dir.id, 'QA')
    await quiet(qa.id)

    expect(h.bench(later(5))).toEqual([])                 // not quiet long enough
    expect(h.bench(later(31))).toEqual([qa.id])
    expect(h.list().some(n => n.dept === 'QA')).toBe(false)
    expect((h as any).directive.benched.QA.id).toBe(qa.id)
    expect(h.bench(later(31))).toEqual([])                // the Director is never benched

    await h.message(dir.id, qa.id, 'please review b-1')
    const woken = h.list().find(n => n.dept === 'QA')!
    expect(woken.id).not.toBe(qa.id)
    expect((h as any).directive.benched.QA).toBeUndefined()
    expect(h.recentActions().some(a => a.action === 'wake_head' && a.args.dept === 'QA')).toBe(true)

    // a department name reaches the open head, without waking a second one
    await h.message(dir.id, 'qa', 'and b-2')
    expect(h.list().filter(n => n.dept === 'QA')).toHaveLength(1)
  })

  it('a woken head is told what the closed one was doing', async () => {
    const dir = h.create({ label: 'Director', cli: 'claude', cwd: home, lead: true })
    running(dir.id)
    h.setSettings({ departments: DEFAULT_SETTINGS.departments.map(d => ({ ...d, grade: 1 })) })
    const qa = await h.openDepartment(dir.id, 'QA')
    h.setStatus(qa.id, 'drafts a, b await review')
    await quiet(qa.id)
    h.bench(later(31))
    expect((h as any).directive.benched.QA.status).toBe('drafts a, b await review')
    const typed: string[] = []
    const orig = (h as any).entry.bind(h)
    ;(h as any).entry = (id: string) => { const e = orig(id); const t = e.term.type.bind(e.term); e.term.type = (s: string) => { typed.push(s); return t(s) }; return e }
    await h.message(dir.id, 'QA', 'review b-1')
    expect(typed.some(s => s.includes('drafts a, b await review'))).toBe(true)
  })

  it("a Director spawning a department's head by hand gets an on-call head", async () => {
    const dir = h.create({ label: 'Director', cli: 'claude', cwd: home, lead: true })
    running(dir.id)
    h.setSettings({ departments: DEFAULT_SETTINGS.departments.map(d => ({ ...d, grade: 1 })) })
    const qa = await h.openDepartment(dir.id, 'QA')
    await quiet(qa.id)
    h.bench(later(31))
    const again = h.spawn(dir.id, { label: 'QA', cli: 'shell', cwd: home, lead: true })
    expect(h.list().find(n => n.id === again.id)!.dept).toBe('QA')
    expect((h as any).directive.benched.QA).toBeUndefined()
    expect(qa.id).not.toBe(again.id)
  })

  it('a head with reports stays open', async () => {
    const dir = h.create({ label: 'Director', cli: 'claude', cwd: home, lead: true })
    running(dir.id)
    h.setSettings({ departments: DEFAULT_SETTINGS.departments.map(d => ({ ...d, grade: 1 })) })
    const eng = await h.openDepartment(dir.id, 'Engineering')
    h.spawn(eng.id, { label: 'Builder', cli: 'shell', cwd: home })
    await quiet(eng.id)
    expect(h.bench(later(31))).toEqual([])
  })

  it('a benched QA still gates a free builder, and is woken to review it', async () => {
    const repo = join(home, 'repo')
    const git = (cwd: string, ...a: string[]) => execFileSync('git', ['-C', cwd, ...a], { encoding: 'utf8' })
    mkdirSync(repo); git(repo, 'init', '-q', '-b', 'main')
    git(repo, 'config', 'user.email', 't@t'); git(repo, 'config', 'user.name', 't')
    writeFileSync(join(repo, 'README'), 'x\n'); git(repo, 'add', '.'); git(repo, 'commit', '-qm', 'init')
    const dir = h.create({ label: 'Director', cli: 'claude', cwd: repo, lead: true })
    running(dir.id, repo)
    h.setSettings({ departments: DEFAULT_SETTINGS.departments.map(d => ({ ...d, grade: 1 })) })
    const qa = await h.openDepartment(dir.id, 'QA')
    await quiet(qa.id)
    h.bench(later(31))
    expect(h.list().some(n => n.id === qa.id)).toBe(false)

    const eng = h.spawn(dir.id, { label: 'Eng', cli: 'claude', cwd: repo, lead: true, grade: 2, why: 'G1: test' })
    const b = h.spawn(eng.id, { label: 'Builder', cli: 'shell', cwd: repo, worktree: true })
    mkdirSync(join(b.cwd, 'src')); writeFileSync(join(b.cwd, 'src', 'app.ts'), 'export {}\n')
    git(b.cwd, 'add', '.'); git(b.cwd, 'commit', '-qm', 'app')

    const r = await h.mergeReport(eng.id, b.id)
    expect(r.merged).toBe(false)
    expect(r.reason).toMatch(/QA/)
    const woken = h.list().find(n => n.dept === 'QA')!
    expect(r.reason).toContain(woken.id)
    h.approve(woken.id, b.id, 'ok')
    expect((await h.mergeReport(eng.id, b.id)).merged).toBe(true)
  })
})

describe('compaction', () => {
  it('a seat chaining tool calls far past the limit is interrupted once, then compacted at its prompt', async () => {
    ;(h as any).bootAt = 0
    const t = h.create({ label: 'Head', cli: 'claude', cwd: home, lead: true })
    const e = (h as any).entry(t.id)
    e.info.sessionId = `test-${Date.now()}-run`
    const file = transcriptFor('claude', e.info.cwd, e.info.sessionId)!
    mkdirSync(dirname(file), { recursive: true })
    const keys: string[] = []
    e.term.press = (k: string) => { keys.push(k) }
    try {
      const turn = (stop: string) => JSON.stringify({ type: 'assistant', message: { id: 'm', stop_reason: stop, usage: { input_tokens: 1, cache_read_input_tokens: 700_000, cache_creation_input_tokens: 0 } } })
      writeFileSync(file, turn('tool_use') + '\n')
      await quiet(t.id)
      expect(h.compact(later(3))).toEqual([])
      expect(keys).toEqual(['Escape'])
      expect(h.compact(later(4))).toEqual([])
      expect(keys).toEqual(['Escape'])                         // once, not every minute
      // What real Claude writes after Escape (copied from a ~/.claude/projects transcript, content redacted):
      // a user line, text "[Request interrupted by user]", with interruptedMessageId. No end_turn follows.
      const interrupt = JSON.stringify({ parentUuid: 'p', isSidechain: false, type: 'user', message: { role: 'user', content: [{ type: 'text', text: '[Request interrupted by user]' }] }, uuid: 'u', timestamp: 't', interruptedMessageId: 'm', promptId: 'x', session_id: 's' })
      writeFileSync(file, turn('tool_use') + '\n' + interrupt + '\n')
      expect(claudeTail(file).atPrompt).toBe(true)
      const typed: string[] = []
      const type0 = e.term.type.bind(e.term)
      e.term.type = (s: string) => { typed.push(s); return type0(s) }
      expect(h.compact(later(5))).toEqual([t.id])
      expect(typed[0]).toMatch(/^\/compact /)
      // /compact finished: the transcript ends with the "Compacted" stdout line. The turn is typed back in once.
      const compactedLine = (text: string) => JSON.stringify({ type: 'user', message: { role: 'user', content: `<local-command-stdout>${text}</local-command-stdout>` } })
      appendFileSync(file, '{"type":"system","subtype":"compact_boundary"}\n' + compactedLine('\x1b[2mCompacted (ctrl+o to see full summary)\x1b[22m') + '\n')
      expect(claudeTail(file)).toMatchObject({ atPrompt: true, compacted: true })
      await quiet(t.id)
      expect(h.compact(later(6))).toEqual([])
      expect(typed.filter(s => s === 'continue')).toHaveLength(1)
      expect(h.compact(later(7))).toEqual([])
      expect(typed.filter(s => s === 'continue')).toHaveLength(1)   // once
    } finally {
      rmSync(dirname(file), { recursive: true, force: true })
    }
  })

  it('a seat that is still working (never quiet) is interrupted once its context passes four thirds of the limit', async () => {
    ;(h as any).bootAt = 0
    const t = h.create({ label: 'Busy', cli: 'claude', cwd: home, lead: true })
    const e = (h as any).entry(t.id)
    e.info.sessionId = `test-${Date.now()}-busy`
    const file = transcriptFor('claude', e.info.cwd, e.info.sessionId)!
    mkdirSync(dirname(file), { recursive: true })
    const keys: string[] = []
    e.term.press = (k: string) => { keys.push(k) }
    try {
      const turn = (read: number) => JSON.stringify({ type: 'assistant', message: { id: 'm', stop_reason: 'tool_use', usage: { input_tokens: 1, cache_read_input_tokens: read, cache_creation_input_tokens: 0 } } })
      await quiet(t.id)
      void h.type(null, t.id, 'while true; do echo working; sleep 0.1; done')           // a seat chaining tool calls: its screen never settles
      await vi.waitFor(() => expect(h.list().find(n => n.id === t.id)?.state).toBe('running'), { timeout: 20_000, interval: 20 })
      writeFileSync(file, turn(190_000) + '\n')                               // past the limit, under four thirds of it: left alone
      expect(h.compact(later(3))).toEqual([])
      expect(keys).toEqual([])
      writeFileSync(file, turn(210_000) + '\n')
      expect(h.compact(later(3))).toEqual([])
      expect(keys).toEqual(['Escape'])
      expect(h.compact(later(4))).toEqual([])
      expect(keys).toEqual(['Escape'])                                         // once, not every minute
      expect(h.compact(later(40))).toEqual([])
      expect(keys).toEqual(['Escape', 'Escape'])                               // it ran on past the interrupt: again after 30 minutes
      expect(h.recentActions().filter(a => a.action === 'interrupt_to_compact')).toHaveLength(2)
    } finally {
      rmSync(dirname(file), { recursive: true, force: true })
    }
  })

  it('reads the size of the last turn from the transcript tail', () => {
    const f = join(home, 's.jsonl')
    const turn = (read: number) => JSON.stringify({ type: 'assistant', message: { id: `m${read}`, usage: { input_tokens: 10, cache_read_input_tokens: read, cache_creation_input_tokens: 5 } } })
    writeFileSync(f, [turn(1000), '{"type":"user"}', turn(200_000), ''].join('\n'))
    expect(claudeContext(f)).toBe(200_015)
    writeFileSync(f, [turn(200_000), '{"type":"system","subtype":"compact_boundary"}', '{"type":"user"}', ''].join('\n'))
    expect(claudeContext(f)).toBe(0)
    expect(claudeContext(join(home, 'missing.jsonl'))).toBe(0)
  })

  it('a quiet Claude seat past the limit gets /compact once, not again within 30 minutes', async () => {
    const t = h.create({ label: 'Head', cli: 'claude', cwd: home, lead: true })
    ;(h as any).bootAt = 0   // past the quiet minutes after a daemon start
    const info = (h as any).entry(t.id).info
    info.sessionId = `test-${Date.now()}`
    const file = transcriptFor('claude', info.cwd, info.sessionId)!
    mkdirSync(dirname(file), { recursive: true })
    try {
      const turn = (stop: string) => JSON.stringify({ type: 'assistant', message: { id: 'm', stop_reason: stop, usage: { input_tokens: 1, cache_read_input_tokens: 400_000, cache_creation_input_tokens: 0 } } })
      // mid-turn (a tool call pending): /compact would be queued as a plain message, so wait
      writeFileSync(file, turn('tool_use') + '\n')
      await quiet(t.id)
      expect(h.compact(later(3))).toEqual([])
      writeFileSync(file, turn('end_turn') + '\n' + JSON.stringify({ type: 'system', subtype: 'turn_duration' }) + '\n')
      expect(h.compact(Date.now() + 5_000)).toEqual([])      // output seconds ago: not yet quiet
      expect(h.compact(Date.now() + 45_000)).toEqual([t.id])   // 45 s quiet at a confirmed prompt is enough (it was 2 min)
      expect(h.recentActions().find(a => a.action === 'compact')?.args.contextK).toBe(400)
      expect(h.compact(later(10))).toEqual([])
      h.setSettings({ compactAtK: 500 })
      expect(h.compact(later(60))).toEqual([])               // under the new limit
    } finally {
      rmSync(dirname(file), { recursive: true, force: true })
    }
  })
})

it('heads default to cheaper grades; the Director is pinned to Opus elsewhere', () => {
  const g = Object.fromEntries(DEFAULT_SETTINGS.departments.map(d => [d.dept, d.grade]))
  expect(g).toMatchObject({ Engineering: 2, Growth: 1, Security: 2, QA: 2, Ops: 1 })
})

it('a card is edited in place, and a dropped card leads to the one that replaced it', () => {
  running('director-x')
  const a = h.postTask(null, 'owner card', 'v1')
  expect(h.updateTask(null, a.id, { detail: 'v2' }).detail).toBe('v2')
  expect(h.boardCard(a.id)!.detail).toBe('v2')
  const b = h.postTask(null, 'owner card again', 'v3')
  const c = h.postTask(null, 'owner card final', 'v4')
  h.finishTask(null, a.id, `Superseded by ${b.id}.`, true)
  h.finishTask(null, b.id, `Folded into final card ${c.id}.`, true)
  expect(h.boardCard(a.id)!.id).toBe(c.id)
  expect(() => h.updateTask(null, a.id, { detail: 'x' })).toThrow(/dropped/)
  expect(h.boardCard('t-0000')).toBeNull()
})

it('a card is edited only by its poster, its owner, a lead above them, or the human', () => {
  const dir = h.create({ label: 'Director', cli: 'shell', cwd: home, lead: true })
  running(dir.id)
  const mid = h.create({ label: 'Mid', cli: 'shell', cwd: home, lead: true, parentId: dir.id })
  const a = h.create({ label: 'Alice', cli: 'shell', cwd: home, parentId: mid.id })
  const b = h.create({ label: 'Bob', cli: 'shell', cwd: home, parentId: mid.id })
  const other = h.create({ label: 'Otto', cli: 'shell', cwd: home, lead: true, parentId: dir.id })
  const card = h.postTask(a.id, 'card', 'v1')
  expect(h.updateTask(a.id, card.id, { detail: 'by poster' }).detail).toBe('by poster')
  expect(() => h.updateTask(b.id, card.id, { detail: 'x' })).toThrow(/only its poster, its owner or a lead above/)
  expect(() => h.updateTask(other.id, card.id, { detail: 'x' })).toThrow(/lead above/)
  h.claimTask(b.id, card.id)
  expect(h.updateTask(b.id, card.id, { detail: 'by owner' }).detail).toBe('by owner')
  expect(h.updateTask(mid.id, card.id, { detail: 'by lead' }).detail).toBe('by lead')
  expect(h.updateTask(dir.id, card.id, { detail: 'by director' }).detail).toBe('by director')
  expect(h.updateTask(null, card.id, { detail: 'by human' }).detail).toBe('by human')
  expect(card.detail).toBe('by human')
})

it('a card is matched to its poster and owner by terminal id, so a seat with the same label gets no rights', () => {
  const dir = h.create({ label: 'Director', cli: 'shell', cwd: home, lead: true })
  running(dir.id)
  const a = h.create({ label: 'Builder', cli: 'shell', cwd: home, parentId: dir.id })
  const twin = h.create({ label: 'Builder', cli: 'shell', cwd: home, parentId: dir.id })
  const card = h.postTask(a.id, 'card', 'v1')
  expect(() => h.updateTask(twin.id, card.id, { detail: 'x' })).toThrow(/lead above/)
  h.claimTask(a.id, card.id)
  expect(() => h.updateTask(twin.id, card.id, { detail: 'x' })).toThrow(/lead above/)
  expect(h.updateTask(a.id, card.id, { detail: 'by poster' }).detail).toBe('by poster')
})
