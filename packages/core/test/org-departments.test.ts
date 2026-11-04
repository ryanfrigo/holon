import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { execFileSync } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
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

// A real repo with a QA seat, a lead and a G0 builder worktree that touches no gated path:
// only QA has to sign this one off.
const qaRepo = async () => {
  const repo = join(home, 'repo')
  const git = (cwd: string, ...a: string[]) => execFileSync('git', ['-C', cwd, ...a], { encoding: 'utf8' })
  mkdirSync(repo); git(repo, 'init', '-q', '-b', 'main')
  git(repo, 'config', 'user.email', 't@t'); git(repo, 'config', 'user.name', 't')
  writeFileSync(join(repo, 'README'), 'x\n'); git(repo, 'add', '.'); git(repo, 'commit', '-qm', 'init')
  const dir = h.create({ label: 'Director', cli: 'claude', cwd: repo, lead: true })
  running(dir.id, repo)
  h.setSettings({ departments: DEFAULT_SETTINGS.departments.map(d => ({ ...d, grade: 1 })) })
  const qa = await h.openDepartment(dir.id, 'QA')
  const eng = h.spawn(dir.id, { label: 'Eng', cli: 'claude', cwd: repo, lead: true, grade: 2, why: 'G1: test' })
  const b = h.spawn(eng.id, { label: 'Builder', cli: 'claude', cwd: repo, grade: 0, worktree: true })
  mkdirSync(join(b.cwd, 'src')); writeFileSync(join(b.cwd, 'src', 'app.ts'), 'export {}\n')
  git(b.cwd, 'add', '.'); git(b.cwd, 'commit', '-qm', 'app')
  return { repo, git, dir, qa, eng, b }
}

describe('departments', () => {
  it('a seat with no grade is gated like a free builder: a shell seat waits for QA before it lands', async () => {
    const repo = join(home, 'repo')
    const git = (cwd: string, ...a: string[]) => execFileSync('git', ['-C', cwd, ...a], { encoding: 'utf8' })
    mkdirSync(repo); git(repo, 'init', '-q', '-b', 'main')
    git(repo, 'config', 'user.email', 't@t'); git(repo, 'config', 'user.name', 't')
    writeFileSync(join(repo, 'README'), 'x\n'); git(repo, 'add', '.'); git(repo, 'commit', '-qm', 'init')
    const dir = h.create({ label: 'Director', cli: 'claude', cwd: repo, lead: true })
    running(dir.id, repo)
    h.setSettings({ departments: DEFAULT_SETTINGS.departments.map(d => ({ ...d, grade: 1 })) })
    const qa = await h.openDepartment(dir.id, 'QA')
    const eng = h.spawn(dir.id, { label: 'Eng', cli: 'claude', cwd: repo, lead: true, grade: 2, why: 'G1: test' })
    // A shell seat carries no grade at all, so it must be gated like a free G0 builder.
    const b = h.spawn(eng.id, { label: 'ShellBuilder', cli: 'shell', cwd: repo, worktree: true })
    expect(h.list().find(n => n.id === b.id)!.grade).toBeUndefined()
    mkdirSync(join(b.cwd, 'src')); writeFileSync(join(b.cwd, 'src', 'app.ts'), 'export {}\n')
    git(b.cwd, 'add', '.'); git(b.cwd, 'commit', '-qm', 'app')

    const first = await h.mergeReport(eng.id, b.id)
    expect(first.merged).toBe(false)
    expect(first.reason).toMatch(/QA/)
    expect(existsSync(join(repo, 'src', 'app.ts'))).toBe(false)   // nothing landed yet
    h.approve(qa.id, b.id, 'checked it')
    expect((await h.mergeReport(eng.id, b.id)).merged).toBe(true)
    expect(readFileSync(join(repo, 'src', 'app.ts'), 'utf8')).toBe('export {}\n')
  })

  it('the last gate lands the branch it was already holding, with no second merge_report', async () => {
    const { repo, qa, eng, b } = await qaRepo()
    const waiting = await h.mergeReport(eng.id, b.id)
    expect(waiting.merged).toBe(false)
    expect(waiting.reason).toMatch(/QA/)

    h.approve(qa.id, b.id, 'tests are green')

    await vi.waitFor(() => expect(h.recentActions().some(a => a.action === 'merged' && a.args.commit)).toBe(true))
    expect(readFileSync(join(repo, 'src', 'app.ts'), 'utf8')).toBe('export {}\n')
    expect(h.recentActions().filter(a => a.action === 'gate_wait')).toHaveLength(1)   // no second merge_report
    await vi.waitFor(() => expect(h.readScreen(null, eng.id).text).toMatch(/All gates approved/))
  })

  it('the default Security gate matches deploy config in json, jsonc and toml, but not other files', () => {
    const sec = DEFAULT_SETTINGS.departments.find(d => d.dept === 'Security')!
    const matches = (file: string) => sec.gate!.paths!.some(p => new RegExp(p).test(file))
    expect(['wrangler.jsonc', 'wrangler.json', 'wrangler.toml', 'vercel.json', 'convex.json', 'deploy/wrangler.jsonc'].every(matches)).toBe(true)
    expect(matches('wrangler.js')).toBe(false)
    expect(matches('src/app.ts')).toBe(false)
  })

  it('an approval with no merge_report waiting merges nothing', async () => {
    const { repo, qa, b } = await qaRepo()
    h.approve(qa.id, b.id, 'looks fine')
    await new Promise(r => setTimeout(r, 500))
    expect(h.recentActions().some(a => a.action === 'merged')).toBe(false)
    expect(existsSync(join(repo, 'src', 'app.ts'))).toBe(false)
  })

})

