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
  const eng = h.spawn(dir.id, { label: 'Eng', cli: 'claude', cwd: repo, lead: true, grade: 2 })
  const b = h.spawn(eng.id, { label: 'Builder', cli: 'claude', cwd: repo, grade: 0, worktree: true })
  mkdirSync(join(b.cwd, 'auth')); writeFileSync(join(b.cwd, 'auth', 'login.ts'), 'export {}\n')
  git(b.cwd, 'add', '.'); git(b.cwd, 'commit', '-qm', 'login')
  return { repo, git, dir, sec, qa, eng, b }
}

describe('digest', () => {
  it('summarises what happened for the human, only when something happened, with secrets scrubbed', async () => {
    const dir = h.create({ label: 'Director', cli: 'claude', cwd: home, lead: true })
    running(dir.id)
    ;(h as any).directive.startedAt = new Date(Date.now() - 60_000).toISOString()
    let seen = ''
    const fake = async (input: string) => { seen = input; return '- Engineering started the world server.' }
    h.setCulture(dir.id, 'x', 'founding with key sk-or-v1-abcdefabcdefabcdefabcdefabcdef')
    const d = await h.refreshDigest(Date.now(), false, fake)
    expect(d!.text).toBe('- Engineering started the world server.')
    expect(seen).toMatch(/set_culture/)
    expect(seen).not.toMatch(/sk-or-v1-abcdef/)
    expect(h.getDirective()!.digest!.text).toMatch(/world server/)
    let calls = 0
    await h.refreshDigest(Date.now() + 1000, false, async () => { calls++; return '- x' })
    expect(calls).toBe(0)   // nothing new since the last digest
  })
})

it('secrets an agent pastes into the KB are scrubbed before they are stored', () => {
  const dir = h.create({ label: 'Director', cli: 'claude', cwd: home, lead: true })
  running(dir.id)
  ;(h as any).openKb(home)
  const { path } = h.kbWrite(dir.id, 'fact', 'Stripe setup', 'live key ' + 'sk_live' + '_51Habcdefghijklmnopqrstuv and token sk-or-v1-0123456789abcdef0123456789abcdef')
  const body = h.kbRead(null, path).body
  expect(body).not.toMatch(/sk_live_51Habcdef|sk-or-v1-0123/)
})

it('the Director or the human can rewrite the directive; heads are told; nobody else can', async () => {
  const dir = h.create({ label: 'Director', cli: 'claude', cwd: home, lead: true })
  running(dir.id)
  h.setSettings({ departments: DEFAULT_SETTINGS.departments.map(d => ({ ...d, grade: 1 })) })
  const eng = await h.openDepartment(dir.id, 'Engineering')
  await expect(h.setDirective(eng.id, 'x')).rejects.toThrow(/only the Director/)
  h.setSettings({ directiveApproval: false })   // approval is covered by its own test
  await h.setDirective(dir.id, 'Build infinite rooms, each its own world.', 'human widened the vision')
  expect(h.getDirective()!.text).toBe('Build infinite rooms, each its own world.')
  expect(h.recentActions().some(a => a.action === 'set_directive')).toBe(true)
  await new Promise(r => setTimeout(r, 400))
  expect(h.readScreen(null, eng.id).text).toMatch(/directive was revised/)
})

it("the owner's messages are kept, clarified into briefs, and marked folded when the directive is revised", async () => {
  const dir = h.create({ label: 'Director', cli: 'claude', cwd: home, lead: true })
  running(dir.id)
  ;(h as any).openKb(home)
  ;(h as any).clarifyMessage = async () => null   // no model in tests; clarified explicitly below
  await h.askDirector('imagine infinite rooms lol and agents dont overwrite each other')
  const [m] = h.getDirective()!.messages!
  expect(m.text).toMatch(/infinite rooms/)
  const c = await Holon.prototype.clarifyMessage.call(h, m.id, async () => ({ title: 'Infinite rooms', brief: '- Make the scene one room of many\n- No overwriting' }))
  expect(c).toMatchObject({ title: 'Infinite rooms' })
  expect(h.kbSearch('Infinite rooms').length).toBeGreaterThan(0)
  await h.setDirective(null, 'Build infinite rooms.', 'owner message')
  expect(h.getDirective()!.messages![0].folded).toBeTruthy()
})

it('heads message each other directly, without the Director in the loop', async () => {
  const dir = h.create({ label: 'Director', cli: 'claude', cwd: home, lead: true })
  running(dir.id)
  h.setSettings({ departments: DEFAULT_SETTINGS.departments.map(d => ({ ...d, grade: 1 })) })
  const sec = await h.openDepartment(dir.id, 'Security')
  const eng = await h.openDepartment(dir.id, 'Engineering')
  await h.message(sec.id, eng.id, 'send me the sandbox diff when it is committed')
  await new Promise(r => setTimeout(r, 400))
  expect(h.readScreen(null, eng.id).text).toMatch(/message from Security/)
  expect(h.recentActions().find(a => a.action === 'message')).toMatchObject({ caller: sec.id, target: eng.id })
  await expect(h.message(sec.id, sec.id, 'x')).rejects.toThrow(/you/)
})

