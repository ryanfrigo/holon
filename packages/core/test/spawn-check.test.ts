import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { execFileSync } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Holon } from '../src/holon.ts'

let home: string
let h: Holon
beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), 'holon-'))
  h = new Holon({ home, socketPath: join(home, 'holon.sock'), mcpEntry: '/dev/null' })
})
afterEach(() => h.shutdown())

// A plain repo, a lead and a builder in its own worktree. No departments, so no gates:
// the only thing that can stop a merge here is the builder's own acceptance check.
const plainRepo = () => {
  const dir = join(home, 'repo')
  const git = (cwd: string, ...a: string[]) => execFileSync('git', ['-C', cwd, ...a], { encoding: 'utf8' })
  mkdirSync(dir); git(dir, 'init', '-q', '-b', 'main')
  git(dir, 'config', 'user.email', 't@t'); git(dir, 'config', 'user.name', 't')
  writeFileSync(join(dir, 'README'), 'x\n'); git(dir, 'add', '.'); git(dir, 'commit', '-qm', 'init')
  const lead = h.create({ label: 'Lead', cli: 'claude', cwd: dir, lead: true })
  return { dir, git, lead }
}

describe('an acceptance check on the spawn', () => {
  it('a reseated builder keeps its task and check: failure refuses the merge and passing merges', async () => {
    const { dir, git, lead } = plainRepo()
    const b = h.spawn(lead.id, { label: 'Builder', cli: 'claude', cwd: dir, grade: 0, worktree: true, check: 'test -f DONE' })
    expect(h.recentActions().find(a => a.action === 'spawn')!.args.check).toBe('test -f DONE')

    writeFileSync(join(b.cwd, 'app.ts'), 'export {}\n')
    git(b.cwd, 'add', '.'); git(b.cwd, 'commit', '-qm', 'work')

    const brief = `TASK-MARKER ${'implement the thing carefully. '.repeat(8)}`
    await h.type(lead.id, b.id, brief)
    await h.reseat(b.id, 1, 'test grade change')

    const refused = await h.mergeReport(lead.id, b.id)
    expect(refused.merged).toBe(false)
    expect(refused.reason).toMatch(/acceptance check failed/)
    expect(refused.reason).toMatch(/test -f DONE/)
    expect(h.list().find(n => n.id === b.id)).toMatchObject({ check: 'test -f DONE', brief })
    const saved = JSON.parse(readFileSync(join(home, 'org.json'), 'utf8'))
    expect(saved.find((n: { id: string }) => n.id === b.id)).toMatchObject({ check: 'test -f DONE', brief })
    expect(existsSync(join(dir, 'app.ts'))).toBe(false)          // nothing landed on the base
    expect(h.recentActions().some(a => a.action === 'merged')).toBe(false)
    const failed = h.recentActions().find(a => a.action === 'check_failed')!
    expect(failed.args.check).toBe('test -f DONE')
    expect(failed.args.label).toBe('Builder')
    expect(h.roles().find(r => r.id === b.id)!.record.rejections).toBe(1)

    // The builder does the thing the check asks for: now it merges.
    writeFileSync(join(b.cwd, 'DONE'), 'ok\n')
    git(b.cwd, 'add', '.'); git(b.cwd, 'commit', '-qm', 'done')
    const merged = await h.mergeReport(lead.id, b.id)
    expect(merged.merged).toBe(true)
    expect(readFileSync(join(dir, 'app.ts'), 'utf8')).toBe('export {}\n')
    expect(existsSync(join(dir, 'DONE'))).toBe(true)
    expect(h.recentActions().some(a => a.action === 'check_passed' && a.args.check === 'test -f DONE')).toBe(true)
    // reseat() waits out a 3s quiet window (clearStartup) before briefing the new process, and the
    // brief is a paste: that is ~4s of real waiting with nothing to poll for, so 5s was a coin flip.
  }, 30_000)

  it('a read-only seat cannot spawn a seat that can write', () => {
    const { dir, lead } = plainRepo()
    const reviewer = h.create({ label: 'Reviewer', cli: 'claude', cwd: dir, parentId: lead.id, lead: true, readOnly: true })
    expect(() => h.spawn(reviewer.id, { label: 'Hired', cli: 'shell', cwd: dir, yolo: true })).toThrow(/read-only seat/)
    expect(h.list().some(n => n.label === 'Hired')).toBe(false)
    expect(h.spawn(lead.id, { label: 'Fine', cli: 'shell', cwd: dir }).label).toBe('Fine')   // a normal lead still can
  })

  it('the daemon stays responsive while a slow check runs', async () => {
    const { dir, git, lead } = plainRepo()
    const b = h.spawn(lead.id, { label: 'Builder', cli: 'claude', cwd: dir, grade: 0, worktree: true, check: 'sleep 1 && test -f DONE' })
    writeFileSync(join(b.cwd, 'app.ts'), 'export {}\n')
    git(b.cwd, 'add', '.'); git(b.cwd, 'commit', '-qm', 'work')

    const order: string[] = []
    setTimeout(() => order.push('tick'), 50)
    const refused = await h.mergeReport(lead.id, b.id).then(r => { order.push('merge'); return r })
    expect(refused.merged).toBe(false)
    expect(refused.reason).toMatch(/acceptance check failed/)
    expect(order).toEqual(['tick', 'merge'])   // the event loop kept running during the check
  })

  it('a builder with no check merges as before', async () => {
    const { dir, git, lead } = plainRepo()
    const b = h.spawn(lead.id, { label: 'Builder', cli: 'claude', cwd: dir, grade: 0, worktree: true })
    writeFileSync(join(b.cwd, 'app.ts'), 'export {}\n')
    git(b.cwd, 'add', '.'); git(b.cwd, 'commit', '-qm', 'work')
    expect((await h.mergeReport(lead.id, b.id)).merged).toBe(true)
    expect(readFileSync(join(dir, 'app.ts'), 'utf8')).toBe('export {}\n')
    expect(h.recentActions().some(a => a.action === 'check_failed' || a.action === 'check_passed')).toBe(false)
  })
})
