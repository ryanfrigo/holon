import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { existsSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Holon } from '../src/holon.ts'
import { Terminal } from '../src/terminal.ts'

let home: string
let h: Holon
const fresh = () => new Holon({ home, socketPath: join(home, 'holon.sock'), mcpEntry: '/dev/null' })
const directive = (directorId: string, status = 'running') =>
  writeFileSync(join(home, 'directive.json'), JSON.stringify({ text: 't', workspace: home, directorId, goals: [], deliverables: [], status, startedAt: new Date().toISOString() }))
beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), 'holon-'))
  h = fresh()
})
afterEach(() => { h.shutdown(); vi.restoreAllMocks() })

describe('the Director runs on Opus', () => {
  it('waits out a quota wall instead of falling back', async () => {
    const dir = h.create({ label: 'Director', cli: 'claude', cwd: home, lead: true })
    ;(h as any).directive = { directorId: dir.id, status: 'running' }
    expect(await (h as any).fallBack(dir.id, 'Opus limit reached', Date.now())).toBe(false)
    expect(h.list()[0]).toMatchObject({ cli: 'claude', model: 'opus', grade: 3 })
  })

  it('a Director a fallback moved to another vendor, even one that exited, comes back on Claude Opus', async () => {
    const dir = h.create({ label: 'Director', cli: 'opencode', model: 'opencode-go/kimi-k3', tier: 'heavy', cwd: home, lead: true })
    const head = h.create({ label: 'Eng', cli: 'shell', cwd: home, parentId: dir.id })
    h.shutdown()
    const org = JSON.parse(readFileSync(join(home, 'org.json'), 'utf8'))
    org[0] = { ...org[0], exited: true, gradeFrom: 3, cliFrom: 'claude', status: 'merged d1b9560' }
    writeFileSync(join(home, 'org.json'), JSON.stringify(org))
    directive(dir.id)
    h = fresh()
    const typed: string[] = []
    vi.spyOn(Terminal.prototype, 'type').mockImplementation(async (text: string) => { typed.push(text) })
    vi.spyOn(Terminal.prototype, 'waitQuiet').mockResolvedValue(undefined as never)
    expect(await h.restore()).toBe(2)
    expect(h.list().find(n => n.id === dir.id)).toMatchObject({ cli: 'claude', model: 'opus', grade: 3, gradeFrom: undefined })
    expect(h.listReports(dir.id).map(n => n.id)).toEqual([head.id])
    expect(typed.some(t => t.includes('now on Claude Opus') && t.includes('merged d1b9560'))).toBe(true)
  })

  it('while paused, a moved Director is put back on Opus on disk, and gets its handoff on resume', async () => {
    const dir = h.create({ label: 'Director', cli: 'codex', model: 'gpt-6-astra', tier: 'heavy', cwd: home, lead: true })
    directive(dir.id)
    h.pause()
    h.shutdown()
    h = fresh()
    expect(await h.restore()).toBe(0)
    expect(JSON.parse(readFileSync(join(home, 'org.json'), 'utf8'))[0]).toMatchObject({ cli: 'claude', model: 'opus', grade: 3, movedFrom: { cli: 'codex' } })
    const typed: string[] = []
    vi.spyOn(Terminal.prototype, 'type').mockImplementation(async (text: string) => { typed.push(text) })
    vi.spyOn(Terminal.prototype, 'waitQuiet').mockResolvedValue(undefined as never)
    expect(await h.resume()).toBe(1)
    expect(h.list()[0]).toMatchObject({ cli: 'claude', model: 'opus' })
    expect(typed.some(t => t.includes('now on Claude Opus') && t.includes('codex'))).toBe(true)
    expect(JSON.parse(readFileSync(join(home, 'org.json'), 'utf8'))[0].movedFrom).toBeUndefined()
  })

  it('a dead directive does not bring its Director back', async () => {
    const dir = h.create({ label: 'Director', cli: 'shell', cwd: home, lead: true })
    h.shutdown()
    const org = JSON.parse(readFileSync(join(home, 'org.json'), 'utf8'))
    writeFileSync(join(home, 'org.json'), JSON.stringify([{ ...org[0], exited: true }]))
    directive(dir.id, 'dead')
    h = fresh()
    expect(await h.restore()).toBe(0)
  })
})

describe('pause', () => {
  it('stops every agent, refuses new ones, and stays paused across a daemon restart until resumed', async () => {
    const dir = h.create({ label: 'Director', cli: 'claude', cwd: home, lead: true })
    const b = h.create({ label: 'Builder', cli: 'opencode', cwd: home, parentId: dir.id })
    const sh = h.create({ label: 'Shell', cli: 'shell', cwd: home })
    directive(dir.id)
    await h.restore()   // loads the directive; every seat is already up
    h.pause('out of credits')
    expect(h.list().map(n => n.id)).toEqual([sh.id])   // shells cost nothing and stay
    expect(() => h.create({ label: 'x', cli: 'claude', cwd: home })).toThrow(/paused/)
    // the seats on disk are untouched, so resume knows what to bring back
    expect(JSON.parse(readFileSync(join(home, 'org.json'), 'utf8')).map((n: { id: string }) => n.id)).toEqual([dir.id, b.id, sh.id])
    expect(existsSync(join(home, 'paused.json'))).toBe(true)

    h.shutdown()
    h = fresh()
    expect(h.paused?.reason).toBe('out of credits')
    expect(await h.restore()).toBe(0)
    expect(h.list()).toEqual([])

    vi.spyOn(Terminal.prototype, 'type').mockResolvedValue(undefined)
    vi.spyOn(Terminal.prototype, 'waitQuiet').mockResolvedValue(undefined as never)
    expect(await h.resume()).toBe(3)
    expect(h.paused).toBeNull()
    expect(existsSync(join(home, 'paused.json'))).toBe(false)
    expect(h.listReports(dir.id).map(n => n.id)).toEqual([b.id])
  })

  it('resume does not duplicate shells that kept running', async () => {
    const sh = h.create({ label: 'Shell', cli: 'shell', cwd: home })
    const a = h.create({ label: 'Agent', cli: 'opencode', cwd: home })
    h.pause()
    vi.spyOn(Terminal.prototype, 'type').mockResolvedValue(undefined)
    vi.spyOn(Terminal.prototype, 'waitQuiet').mockResolvedValue(undefined as never)
    await h.resume()
    expect(h.list().map(n => n.id).sort()).toEqual([sh.id, a.id].sort())
  })
})

describe('stale fallback markers and the resume message', () => {
  it('a Director with an old fallback marker loses it without being restarted, and a Director with no reports is not told about any', async () => {
    const dir = h.create({ label: 'Director', cli: 'claude', cwd: home, lead: true })
    directive(dir.id)
    h.shutdown()
    const org = JSON.parse(readFileSync(join(home, 'org.json'), 'utf8'))
    writeFileSync(join(home, 'org.json'), JSON.stringify([{ ...org[0], gradeFrom: 3, fallbackAt: '2026-10-27T19:04:57.051Z' }]))
    h = fresh()
    const typed: string[] = []
    vi.spyOn(Terminal.prototype, 'type').mockImplementation(async (text: string) => { typed.push(text) })
    vi.spyOn(Terminal.prototype, 'waitQuiet').mockResolvedValue(undefined as never)
    await h.restore()
    expect(h.roles()[0].gradeFrom).toBeNull()
    expect(typed.some(t => t.includes('no reports right now') && !t.includes('Your reports were restarted'))).toBe(true)
    // one already in memory (from before this fix) is dropped by regrade, with no reseat
    ;(h as any).entry(dir.id).info.gradeFrom = 3
    await new Promise(r => setTimeout(r, 1200))
    expect(await h.regrade(Date.now() + 2 * 60 * 60_000)).toEqual([])
    expect(h.roles()[0].gradeFrom).toBeNull()
    expect(h.recentActions().some(a => a.action === 'quota_restore')).toBe(false)
  })
})

describe('new goals reopen a completed directive', () => {
  it('setGoals flips complete back to running and clears completedAt', () => {
    const dir = h.create({ label: 'Director', cli: 'shell', cwd: home, lead: true })
    ;(h as any).directive = { text: 't', workspace: home, directorId: dir.id, goals: [], deliverables: [], status: 'complete', completedAt: new Date().toISOString(), startedAt: new Date().toISOString() }
    h.setGoals(null, ['ship the thing'])
    const d = h.getDirective()!
    expect(d.status).toBe('running')
    expect(d.completedAt).toBeUndefined()
    expect(d.goals).toEqual(['ship the thing'])
  })
})
