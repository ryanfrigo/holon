import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { execFileSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Holon } from '../src/holon.ts'
import { Terminal } from '../src/terminal.ts'
import { DEFAULT_SETTINGS, gatesFor, mergeSettings, place } from '../src/org.ts'

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
  const eng = h.spawn(dir.id, { label: 'Eng', cli: 'claude', cwd: repo, lead: true, grade: 2, why: 'G1: test' })
  const b = h.spawn(eng.id, { label: 'Builder', cli: 'claude', cwd: repo, grade: 0, worktree: true })
  mkdirSync(join(b.cwd, 'auth')); writeFileSync(join(b.cwd, 'auth', 'login.ts'), 'export {}\n')
  git(b.cwd, 'add', '.'); git(b.cwd, 'commit', '-qm', 'login')
  return { repo, git, dir, sec, qa, eng, b }
}

it('token totals survive a daemon restart and keep agents that have finished', async () => {
  ;(h as any).usageCache.set('gone-1', { input: 10, output: 5, cacheRead: 0, cacheWrite: 0, costUsd: null, label: 'Old builder', cli: 'claude', model: 'opus' })
  await h.refreshUsage()
  const again = new Holon({ home, socketPath: join(home, 'y.sock'), mcpEntry: '/dev/null' })
  const report = await again.refreshUsage()
  expect(report.find(r => r.id === 'gone-1')).toMatchObject({ label: 'Old builder', model: 'opus', tokens: 15 })
  again.shutdown()
})

describe('directive suggestions', () => {
  it("the Director's rewrite waits for the owner; approve applies it, reject keeps the old one and tells the Director", async () => {
    const dir = h.create({ label: 'Director', cli: 'claude', cwd: home, lead: true })
    running(dir.id)
    const r = await h.setDirective(dir.id, 'Build infinite rooms.', 'owner widened it') as { pending: string }
    expect(h.getDirective()!.text).toBe('t')
    expect(h.getDirective()!.drafts![0]).toMatchObject({ id: r.pending, by: 'the Director', status: 'pending' })
    await h.decideDirective(r.pending, true, 'yes')
    expect(h.getDirective()!.text).toBe('Build infinite rooms.')
    const r2 = await h.setDirective(dir.id, 'Pivot to a game.', 'idea') as { pending: string }
    await h.decideDirective(r2.pending, false, 'not now')
    expect(h.getDirective()!.text).toBe('Build infinite rooms.')
    await expect(h.decideDirective(r2.pending, true)).rejects.toThrow(/already rejected/)
    await new Promise(r => setTimeout(r, 400))
    expect(h.readScreen(null, dir.id).text).toMatch(/rejected the suggested directive/)
  })

  it('unfolded owner messages become a drafted update, at most one pending at a time', async () => {
    const dir = h.create({ label: 'Director', cli: 'claude', cwd: home, lead: true })
    running(dir.id)
    ;(h as any).directive.messages = [{ id: 'm1', ts: '', text: 'make it infinite rooms', title: 'Infinite rooms', brief: '- one room of many' }]
    let seen: string[] = []
    const d = await h.draftFromMessages(async (cur, msgs) => { seen = msgs; return cur + ' Now with infinite rooms, one of many, all connected and growing.' })
    expect(seen[0]).toMatch(/Infinite rooms/)
    expect(d).toMatchObject({ pending: expect.any(String) })
    expect(await h.draftFromMessages(async () => 'x'.repeat(100))).toBeNull()   // one pending suggestion at a time
  })

  it('drafts a first directive from what is in the project folder', async () => {
    const ws = join(home, 'proj'); mkdirSync(ws); writeFileSync(join(ws, 'README.md'), '# Tidyboard\nA leaderboard for greedy algorithms.')
    let notes = ''
    const r = await h.draftDirectiveFor(ws, async n => { notes = n; return 'Make Tidyboard the place people compare greedy algorithms.' })
    expect(notes).toMatch(/leaderboard for greedy algorithms/)
    expect(r.text).toMatch(/Tidyboard/)
    await expect(h.draftDirectiveFor(join(home, 'nope'))).rejects.toThrow(/no folder/)
  })
})

it('a department with a standing duty is nudged on its schedule, only when its head is free', async () => {
  const dir = h.create({ label: 'Director', cli: 'claude', cwd: home, lead: true })
  running(dir.id)
  h.setSettings({ departments: [{ dept: 'Finance', charter: 'costs', persona: 'frugal', grade: 1, duty: 'run the cost report and write COST-ADVICE.md', everyMin: 60 }] })
  const fin = await h.openDepartment(dir.id, 'Finance')
  await new Promise(r => setTimeout(r, 1500))
  const t0 = Date.parse(h.list().find(n => n.id === fin.id)!.createdAt)
  expect(h.duties(t0 + 30 * 60_000)).toEqual([])
  expect(h.duties(t0 + 61 * 60_000)).toEqual([fin.id])
  expect(h.duties(t0 + 90 * 60_000)).toEqual([])
  await new Promise(r => setTimeout(r, 400))
  expect(h.readScreen(null, fin.id).text).toMatch(/Standing duty/)
})

it("the owner's backlog: items carry an owner and status, and every heartbeat lists what is still open", async () => {
  const dir = h.create({ label: 'Director', cli: 'claude', cwd: home, lead: true })
  running(dir.id)
  ;(h as any).directive.messages = [
    { id: 'm-1', ts: new Date().toISOString(), text: 'refactor periodically', title: 'Periodic refactoring' },
    { id: 'm-2', ts: new Date().toISOString(), text: 'track my items', title: 'Track items', status: 'done' },
  ]
  h.noteMessage(dir.id, 'm-1', 'doing', 'Engineering has a daily refactor duty now', 'Engineering')
  expect(h.getDirective()!.messages![0]).toMatchObject({ status: 'doing', owner: 'Engineering' })
  const note = h.backlogNote()
  expect(note).toMatch(/1 open item/)
  expect(note).toMatch(/m-1 \[doing, Engineering\] Periodic refactoring/)
  expect(note).not.toMatch(/Track items/)
})

describe('reshaping a running org', () => {
  it('a peer ring becomes a departments org without losing the backlog, goals or deliverables', async () => {
    const ws = join(home, 'ws'); mkdirSync(ws)
    await h.startDirective('Make tidyboard great.', ws, 10, 'holon', true)
    const d = h.getDirective()!
    d.goals = ['G1 ingest hardening']; d.messages = [{ id: 'm-1', ts: new Date().toISOString(), text: 'track my items', status: 'doing', owner: 'Peer' }]
    d.deliverables = [{ label: 'Site', kind: 'url', value: 'https://tidyboard.com', ts: '' }]
    const peers = h.list().map(n => n.id)
    const top = await h.reshape('hierarchy', 'departments')
    expect(h.list().some(n => peers.includes(n.id))).toBe(false)
    expect(top.label).toBe('Director')
    const now = h.getDirective()!
    expect(now).toMatchObject({ shape: 'hierarchy', template: 'departments', text: 'Make tidyboard great.', goals: ['G1 ingest hardening'] })
    expect(now.messages![0].owner).toBe('Peer')
    expect(now.deliverables[0].value).toBe('https://tidyboard.com')
    expect(h.recentActions().some(a => a.action === 'reshape')).toBe(true)
  })

  it('a designed org keeps valid departments, drops unsafe gates, and always has AR', async () => {
    const depts = await h.designOrg('x', home, async () => [
      { dept: 'Data', charter: 'Owns ingest.', persona: 'Careful.', grade: 3, gatePaths: ['^data/', '(['], reviewsFreeWork: true },
      { dept: '', charter: 'nameless' },
      { nonsense: true },
    ])
    expect(depts.map(d => d.dept)).toEqual(['Data', 'AR'])
    expect(depts[0]).toMatchObject({ grade: 3, gate: { paths: ['^data/'], freeBuilders: true } })
  })
})

it('the shared brain: lessons written as shared are found by another project; decisions stay private', async () => {
  const root = mkdtempSync(join(tmpdir(), 'root-'))
  const mk = (slug: string) => { const hh = join(root, 'projects', slug); mkdirSync(hh, { recursive: true }); return new Holon({ home: hh, socketPath: join(hh, 's'), mcpEntry: '/dev/null' }) }
  const a = mk('acme'), b = mk('world')
  for (const [x, ws] of [[a, 'vc'], [b, 'wd']] as const) { const w = join(root, ws); mkdirSync(w); (x as any).directive = { text: 't', workspace: w, directorId: 'd', goals: [], deliverables: [], status: 'running', startedAt: '' }; (x as any).openKb(w) }
  a.kbWrite(null, 'lesson', 'Cold email needs SPF DKIM and DMARC aligned', 'Set all three before the first send.', true)
  expect(() => a.kbWrite(null, 'decision', 'Price', 'x', true)).toThrow(/only lessons and playbooks/)
  a.kbWrite(null, 'decision', 'Acme pricing', 'private')
  const found = b.kbSearch('DKIM DMARC')
  expect(found[0]).toMatchObject({ shared: true, title: 'Cold email needs SPF DKIM and DMARC aligned' })
  expect(b.kbRead(null, found[0].path).body).toMatch(/from vc/)
  expect(b.kbSearch('Acme pricing').some(e => e.title === 'Acme pricing')).toBe(false)
  a.shutdown(); b.shutdown()
})

it('completing a round closes builders and temporary teams but keeps department heads in their seats', async () => {
  const dir = h.create({ label: 'Director', cli: 'claude', cwd: home, lead: true })
  running(dir.id)
  h.setSettings({ departments: DEFAULT_SETTINGS.departments.map(d => ({ ...d, grade: 1 })) })
  const eng = await h.openDepartment(dir.id, 'Engineering')
  const builder = h.spawn(eng.id, { label: 'b', cli: 'claude', cwd: home, grade: 0 })
  const temp = h.spawn(dir.id, { label: 'Temp lead', cli: 'claude', cwd: home, lead: true, why: 'no goal: test' })
  h.complete(dir.id, 'round 1 done')
  const ids = h.list().map(n => n.id)
  expect(ids).toContain(eng.id)
  expect(ids).not.toContain(builder.id)
  expect(ids).not.toContain(temp.id)
})
