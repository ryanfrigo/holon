import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { execFileSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Holon } from '../src/holon.ts'
import { Terminal } from '../src/terminal.ts'
import { DEFAULT_SETTINGS, gatesFor, loadSettings, mergeSettings, place } from '../src/org.ts'

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

// A real repo with Security and QA seats, a lead and a builder worktree touching auth/.
const gateRepo = async () => {
  const repo = join(home, 'repo')
  const git = (cwd: string, ...a: string[]) => execFileSync('git', ['-C', cwd, ...a], { encoding: 'utf8' })
  mkdirSync(repo); git(repo, 'init', '-q', '-b', 'main')
  git(repo, 'config', 'user.email', 't@t'); git(repo, 'config', 'user.name', 't')
  writeFileSync(join(repo, 'README'), 'x\n'); git(repo, 'add', '.'); git(repo, 'commit', '-qm', 'init')
  const dir = h.create({ label: 'Director', cli: 'claude', cwd: repo, lead: true })
  running(dir.id, repo)
  h.setSettings({ departments: DEFAULT_SETTINGS.departments.map(d => ({ ...d, grade: 1 })) })
  const sec = await h.openDepartment(dir.id, 'Security')
  const qa = await h.openDepartment(dir.id, 'QA')
  const eng = h.spawn(dir.id, { label: 'Eng', cli: 'claude', cwd: repo, lead: true, grade: 2 })
  const b = h.spawn(eng.id, { label: 'Builder', cli: 'claude', cwd: repo, grade: 0, worktree: true })
  mkdirSync(join(b.cwd, 'auth')); writeFileSync(join(b.cwd, 'auth', 'login.ts'), 'export {}\n')
  git(b.cwd, 'add', '.'); git(b.cwd, 'commit', '-qm', 'login')
  return { repo, git, dir, sec, qa, eng, b }
}

describe('grades', () => {
  it('fresh and legacy homes default to free OpenCode; Go is an explicit, persisted opt-in', () => {
    expect(loadSettings(home).opencodeGo).toBe(false)
    writeFileSync(join(home, 'settings.json'), JSON.stringify({ freePools: { opencode: true } }))
    expect(loadSettings(home).opencodeGo).toBe(false)
    for (const grade of [0, 1, 2, 3] as const) {
      expect(place(grade, 'opencode', loadSettings(home)).model).toBe('opencode/big-pickle')
    }
    expect(h.create({ label: 'Free', cli: 'opencode', cwd: home, lead: true }).model).toBe('opencode/big-pickle')
    h.setSettings({ opencodeGo: true })
    expect(loadSettings(home).opencodeGo).toBe(true)
    expect(place(0, 'opencode', loadSettings(home)).model).toBe('opencode-go/glm-5.3-flash')
    expect(place(3, 'opencode', loadSettings(home)).model).toBe('opencode-go/kimi-k3')
    expect(h.create({ label: 'Go', cli: 'opencode', cwd: home, lead: true }).model).toBe('opencode-go/kimi-k3')
    h.setSettings({ opencodeGo: false })
    expect(loadSettings(home).opencodeGo).toBe(false)
    expect(mergeSettings(DEFAULT_SETTINGS, { opencodeGo: 'true' } as any).opencodeGo).toBe(false)
  })

  it('Go plan exhaustion only blocks OpenCode when Go is enabled', async () => {
    const now = Date.now()
    const until = now + 7200_000
    ;(h as any).opts.plans = async () => [{ provider: 'OpenCode Go Plus', bars: [{ usedPct: 100, resetsAt: new Date(until).toISOString() }] }]
    await h.refreshPools(now)
    expect((h as any).quotaOutUntil.opencode).toBeUndefined()
    expect(await (h as any).resetOf('opencode', now)).toBe(now + DEFAULT_SETTINGS.fallbackRetryMin * 60_000)
    h.setSettings({ opencodeGo: true })
    await h.refreshPools(now)
    expect((h as any).quotaOutUntil.opencode).toBe(until)
    expect(await (h as any).resetOf('opencode', now)).toBe(until)
  })

  it('G0 rotates across the free pools that are on, and falls back to G1 with none', () => {
    const s = mergeSettings(DEFAULT_SETTINGS, { opencodeGo: true })
    const models = [0, 1, 2, 3, 4, 5].map(t => place(0, 'claude', s, t).model)
    // OpenRouter (:free, capped) and OmniRoute (dead key) are off by default; the plan carries G0.
    expect(new Set(models.map(m => m!.split('/')[0]))).toEqual(new Set(['opencode-go']))
    expect(models).toContain('opencode-go/glm-5.3-flash')
    expect(place(0, 'claude', s, 0).cli).toBe('opencode')
    const allOn = mergeSettings(s, { freePools: { opencode: true, omniroute: true, openrouter: true } })
    expect(models).not.toContain('opencode-go/kimi-k3')   // the plan's priciest model is for heavy seats
    // turns 3, 4, 5 of the rotation: the last opencode plan model, then OmniRoute, then OpenRouter
    const every = [3, 4, 5].map(t => place(0, 'claude', allOn, t).model!.split('/')[0])
    expect(new Set(every)).toEqual(new Set(['opencode-go', 'omniroute', 'openrouter']))
    const none = mergeSettings(s, { freePools: { opencode: false, omniroute: false, openrouter: false } })
    expect(place(0, 'claude', none)).toMatchObject({ cli: 'claude', model: 'haiku', grade: 1 })
    expect(place(3, 'claude', s)).toMatchObject({ cli: 'claude', model: 'opus', tier: 'heavy' })
    expect(place(2, 'codex', s)).toMatchObject({ cli: 'codex', model: 'gpt-6-luna' })
    expect(place(3, 'codex', s)).toMatchObject({ cli: 'codex', model: 'gpt-6-astra' })
  })

  it('spawn by grade picks cli and model; settings persist per project', () => {
    const dir = h.create({ label: 'Director', cli: 'claude', cwd: home, lead: true })
    const free = h.spawn(dir.id, { label: 'Builder', cli: 'claude', cwd: home, grade: 0 })
    expect(free).toMatchObject({ cli: 'opencode', grade: 0 })
    expect(dir.grade).toBe(3)
    h.setSettings({ gradeModels: { claude: { 3: 'claude-opus-5-5' } } as any })
    const again = new Holon({ home, socketPath: join(home, 'x.sock'), mcpEntry: '/dev/null' })
    expect(again.getSettings().gradeModels.claude[3]).toBe('claude-opus-5-5')
    expect(again.getSettings().gradeModels.claude[2]).toBe('sonnet')
  })

  it('only someone above a role can regrade it; the change lands when it is quiet, same id and reports', async () => {
    const dir = h.create({ label: 'Director', cli: 'claude', cwd: home, lead: true })
    const head = h.spawn(dir.id, { label: 'Eng', cli: 'claude', cwd: home, lead: true, grade: 3 })
    const builder = h.spawn(head.id, { label: 'B', cli: 'claude', cwd: home, grade: 0 })
    expect(() => h.setGrade(builder.id, head.id, 1, 'no')).toThrow(/above/)
    expect(h.setGrade(dir.id, head.id, 2, 'two merges in six hours').pendingGrade).toBe(2)
    await new Promise(r => setTimeout(r, 1500))
    expect(await h.regrade()).toEqual([head.id])
    const after = h.list().find(n => n.id === head.id)!
    expect(after).toMatchObject({ grade: 2, model: 'sonnet', parentId: dir.id })
    expect(after.pendingGrade).toBeUndefined()
    expect(h.listReports(head.id).map(n => n.id)).toEqual([builder.id])
    expect(h.recentActions().some(a => a.action === 'set_grade' && a.args.reason === 'two merges in six hours')).toBe(true)
  })

  it('out of quota, a role drops one grade, then tries its own grade again later', async () => {
    const dir = h.create({ label: 'Director', cli: 'claude', cwd: home, lead: true })
    await (h as any).fallBack(dir.id, 'Opus limit reached', Date.now())
    expect(h.list()[0]).toMatchObject({ grade: 2, gradeFrom: 3 })
    await new Promise(r => setTimeout(r, 1500))
    expect(await h.regrade(Date.now() + 61 * 60_000)).toEqual([dir.id])
    expect(h.list()[0].grade).toBe(3)
    expect(h.list()[0].gradeFrom).toBeUndefined()
  })
})

describe('free first', () => {
  it('a builder on paid labor needs a reason, logged; leads, free builders and the human need none', () => {
    const dir = h.create({ label: 'Director', cli: 'claude', cwd: home, lead: true })
    expect(() => h.spawn(dir.id, { label: 'b', cli: 'claude', cwd: home })).toThrow(/free first/)
    expect(() => h.spawn(dir.id, { label: 'b', cli: 'claude', cwd: home, grade: 2 })).toThrow(/free first/)
    expect(h.spawn(dir.id, { label: 'free', cli: 'claude', cwd: home, grade: 0 }).cli).toBe('opencode')
    expect(h.spawn(dir.id, { label: 'head', cli: 'claude', cwd: home, lead: true }).grade).toBe(2)
    h.spawn(dir.id, { label: 'auth', cli: 'claude', cwd: home, grade: 2, why: 'subtle auth fix; G0 got it wrong twice' })
    expect(h.recentActions().find(a => a.action === 'spawn' && a.args.label === 'auth')!.args.why).toMatch(/G0 got it wrong/)
    h.setSettings({ freeFirst: false })
    expect(h.spawn(dir.id, { label: 'x', cli: 'claude', cwd: home }).grade).toBe(2)
  })
})

