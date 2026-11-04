import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { execFileSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Holon } from '../src/holon.ts'
import { Terminal } from '../src/terminal.ts'
import { seen } from '../../../test-support/seen.ts'

let home: string
let h: Holon
beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), 'holon-'))
  h = new Holon({ home, socketPath: join(home, 'holon.sock'), mcpEntry: '/dev/null' })
})
afterEach(() => { h.shutdown(); vi.restoreAllMocks() })

describe('holon shape', () => {
  const ring = () => {
    const ids = ['A', 'B', 'C'].map(l => h.create({ label: `Peer ${l}`, cli: 'shell', cwd: home }).id)
    ;(h as any).openKb(home)
    ;(h as any).directive = { text: 't', workspace: home, directorId: ids[0], goals: [], deliverables: [], status: 'running', startedAt: new Date(0).toISOString(),
      shape: 'holon', council: { members: ids, quorum: 2 }, proposals: [], tasks: [], autoscaleMin: 20 }
    return ids
  }

  it('task board: post, claim once, finish with evidence', () => {
    const [a, b] = ring()
    const t = h.postTask(a, 'Fix signup copy', 'why + done-when')
    h.claimTask(b, t.id)
    expect(() => h.claimTask(a, t.id)).toThrow(/already claimed/)
    h.finishTask(b, t.id, 'commit abc123')
    expect(h.listTasks('done')[0]).toMatchObject({ owner: 'Peer B', result: 'commit abc123' })
  })

  it('every proposal gets a critic, and nobody votes until the critique is in', async () => {
    const [a, b, c] = ring()
    const pending = h.propose(a, 'Pivot pricing', 'data')
    const p = h.getDirective()!.proposals![0]
    expect([b, c]).toContain(p.critic)
    const voter = p.critic === b ? c : b
    expect(() => h.vote(voter, p.id, 'yes', 'ok')).toThrow(/wait for the critic/)
    expect(() => h.critique(voter, p.id, 'x')).toThrow(/only the designated critic/)
    h.critique(p.critic!, p.id, 'margins drop 30%')
    h.vote(p.critic!, p.id, 'no', 'see critique')
    h.vote(voter, p.id, 'yes', 'worth it')
    const decided = await pending   // proposer yes + voter yes beats the critic's no
    expect(decided.status).toBe('passed')
    expect(decided.critique).toBe('margins drop 30%')
  })

  it('retires idle helpers but never peers, and tells the parent', async () => {
    const [a] = ring()
    const helper = h.spawn(a, { label: 'Helper', cli: 'shell', cwd: home })
    await h.wait(null, helper.id, 1500, 20000)
    expect(h.autoscale(Date.now())).toEqual([])                    // not idle long enough
    expect(h.autoscale(Date.now() + 21 * 60_000)).toEqual([helper.id])
    expect(h.list().map(n => n.id)).not.toContain(helper.id)
    expect(h.list()).toHaveLength(3)
  })

  it('sends the auditor new claims at most every round, and only when there are any', () => {
    const [a] = ring()
    const auditor = h.create({ label: 'Auditor', cli: 'shell', cwd: home })
    h.getDirective()!.auditorId = auditor.id
    expect(h.audit(Date.now())).toBe(false)                         // no claims yet
    h.update(a, 'Shipped signup fix')
    expect(h.audit(Date.now())).toBe(true)
    h.update(a, 'Another claim')
    expect(h.audit(Date.now())).toBe(false)                         // within the round
    expect(h.audit(Date.now() + 31 * 60_000)).toBe(true)
  })
})

it('the auditor is held to its role: no spawning, merging, claiming, proposing or updates', async () => {
  const peer = h.create({ label: 'Peer', cli: 'shell', cwd: home })
  const auditor = h.create({ label: 'Auditor', cli: 'shell', cwd: home })
  ;(h as any).openKb(home)
  ;(h as any).directive = { text: 't', workspace: home, directorId: peer.id, goals: [], deliverables: [], status: 'running', startedAt: '',
    shape: 'holon', council: { members: [peer.id], quorum: 1 }, proposals: [], tasks: [], auditorId: auditor.id }
  const t = h.postTask(auditor.id, 'Fix false claim', 'evidence')   // allowed
  expect(() => h.spawn(auditor.id, { label: 'x', cli: 'shell', cwd: home })).toThrow(/you are the auditor/)
  expect(() => h.claimTask(auditor.id, t.id)).toThrow(/you are the auditor/)
  expect(() => h.update(auditor.id, 'x')).toThrow(/you are the auditor/)
  await expect(h.propose(auditor.id, 'x', 'y')).rejects.toThrow(/you are the auditor/)
  h.kbWrite(auditor.id, 'fact', 'Audit 2026-10-21 12:00', 'VERIFIED: x')   // allowed
  expect(h.kbSearch('audit', 'fact')).toHaveLength(1)
})

describe('self-healing watcher', () => {
  it('tells a lead its report is out of quota, once per cooldown, and records the lesson', async () => {
    const lead = h.create({ label: 'Lead', cli: 'shell', cwd: home })
    const rep = h.create({ label: 'Rep', cli: 'shell', cwd: home, parentId: lead.id })
    ;(h as any).openKb(home)
    ;(h as any).directive = { text: 't', workspace: home, directorId: lead.id, goals: [], deliverables: [], status: 'running', startedAt: '' }
    await h.wait(null, rep.id, 2000, 20000)
    await h.type(null, rep.id, "printf 'You have hit your usage limit. Try again at 3:03 PM\\n'")
    await seen(h, rep.id, /^You have hit your usage limit/m)
    const acted = await h.heal(Date.now() + 30_000, false)
    expect(acted.map(a => a.finding.issue)).toEqual(['quota'])
    await seen(h, lead.id, '[holon watcher] Rep (shell) has hit its usage limit')
    expect(await h.heal(Date.now() + 30_000, false)).toEqual([])          // cooldown
    expect(h.kbSearch('watcher quota', 'lesson')).toHaveLength(1)
  })

  it('tells a seat whose turn the network cut off to carry on, without counting it as stuck', async () => {
    const rep = h.create({ label: 'Rep', cli: 'shell', cwd: home })
    await h.wait(null, rep.id, 2000, 20000)
    await h.type(null, rep.id, "printf 'API Error: Can'\\''t reach the API server (ENOTFOUND)\\n'")
    await seen(h, rep.id, /^API Error: Can't reach/m)
    const acted = await h.heal(Date.now() + 2 * 60_000, false)
    expect(acted.map(a => a.finding.issue)).toEqual(['api-dropped'])
    await seen(h, rep.id, 'Carry on from where you were')
    expect(h.roles().find(r => r.label === 'Rep')?.record.stuck).toBe(0)
  })

  it('presses through a recognized blocking menu by itself', async () => {
    const t = h.create({ label: 'T', cli: 'shell', cwd: home })
    await h.wait(null, t.id, 2000, 20000)
    await h.type(null, t.id, "printf 'Update available\n1. Update now\n2. Skip\n'; read -n 3 k; echo got-keys")
    await seen(h, t.id, '2. Skip')
    const acted = await h.heal(Date.now(), false)
    expect(acted[0].finding.issue).toBe('codex-update-menu')
    await seen(h, t.id, /got-keys/)
  })

  it('routes a spawn off a vendor whose pool is out of quota, to opencode at grade 0', async () => {
    const lead = h.create({ label: 'Lead', cli: 'shell', cwd: home })
    const coder = h.create({ label: 'Coder', cli: 'codex', cwd: home, parentId: lead.id })
    await h.wait(null, coder.id, 2000, 20000)
    await h.type(null, coder.id, "printf 'You have hit your usage limit. Try again at 3:03 PM\\n'")
    await h.wait(null, coder.id, 1000)
    expect((await h.heal(Date.now() + 30_000, false)).map(a => a.finding.issue)).toEqual(['quota'])
    const node = h.spawn(null, { cli: 'codex', grade: 2, label: 'x', cwd: home })
    expect(node.cli).toBe('opencode')
    expect(node.grade).toBe(0)
    expect(node.reroute).toBe('rerouted: codex quota out, now opencode')
    const route = h.recentActions().filter(a => a.action === 'quota_route').find(a => a.args.label === 'x')
    expect(route?.args).toMatchObject({ label: 'x', fromCli: 'codex', toCli: 'opencode', lead: false })
  })

  it('routes a lead off codex to claude, keeping its grade', () => {
    ;(h as any).quotaOutUntil = { codex: Date.now() + 30_000 }
    const node = h.spawn(null, { cli: 'codex', grade: 2, label: 'Lead', cwd: home, lead: true })
    expect(node.cli).toBe('claude')
    expect(node.lead).toBe(true)
    expect(node.grade).toBe(2)
    expect(node.reroute).toBe('rerouted: codex quota out, now claude')
    const route = h.recentActions().find(a => a.action === 'quota_route')
    expect(route?.args).toMatchObject({ fromCli: 'codex', toCli: 'claude', lead: true })
  })

  it('routes a lead off claude to codex when claude is out', () => {
    ;(h as any).quotaOutUntil = { claude: Date.now() + 30_000 }
    const node = h.spawn(null, { cli: 'claude', grade: 1, label: 'Lead', cwd: home, lead: true })
    expect(node.cli).toBe('codex')
    expect(node.grade).toBe(1)
    expect(node.reroute).toBe('rerouted: claude quota out, now codex')
  })

  it('routes a lead to opencode on the plan when both paid pools are out of quota', () => {
    h.setSettings({ opencodeGo: true })
    const until = Date.now() + 30_000
    ;(h as any).quotaOutUntil = { claude: until, codex: until }
    const node = h.spawn(null, { cli: 'codex', grade: 2, label: 'Lead', cwd: home, lead: true })
    expect(node.cli).toBe('opencode')
    expect(node.grade).toBe(2)
    expect(node.reroute).toBe('rerouted: codex and claude quota out, now opencode (OpenCode Go)')
    const route = h.recentActions().find(a => a.action === 'quota_route')
    expect(route?.args).toMatchObject({ label: 'Lead', fromCli: 'codex', toCli: 'opencode', lead: true })
  })

  it('a seat walled again after a grade drop crosses to opencode on the plan at its original grade', async () => {
    h.setSettings({ opencodeGo: true })
    const b = h.create({ label: 'Eng', cli: 'claude', cwd: home, grade: 3 })
    ;(h as any).directive = { text: 't', workspace: home, directorId: 'director-x', goals: [], deliverables: [], status: 'running', startedAt: '' }
    const wall = (id: string) => h.type(null, id, "printf 'You have hit your usage limit. Try again at 3:03 PM\\n'")
    await h.wait(null, b.id, 2000, 20000)
    await wall(b.id)
    await h.wait(null, b.id, 1000)
    expect((await h.heal(Date.now() + 30_000, false)).map(a => a.finding.issue)).toEqual(['quota'])
    expect((h as any).nodes.get(b.id)!.info).toMatchObject({ gradeFrom: 3, cli: 'claude' })   // first walled: dropped to G2, conversation kept
    await wall(b.id)
    await h.wait(null, b.id, 1000)
    expect((await h.heal(Date.now() + 21 * 60_000, false)).map(a => a.finding.issue)).toEqual(['quota'])
    expect((h as any).nodes.get(b.id)!.info).toMatchObject({ cli: 'opencode', grade: 3, model: 'opencode-go/kimi-k3', cliFrom: 'claude', gradeFrom: 3 })
  })

  it('leaves a spawn alone when its pool is not out of quota', () => {
    ;(h as any).quotaOutUntil = { codex: Date.now() - 1_000 }
    const node = h.spawn(null, { cli: 'codex', grade: 2, label: 'Fine', cwd: home })
    expect(node.cli).toBe('codex')
    expect(node.reroute).toBeUndefined()
    expect(h.recentActions().find(a => a.action === 'quota_route')).toBeUndefined()
  })
})

describe('spawn purpose and retry chains', () => {
  const git = (cwd: string, ...a: string[]) => execFileSync('git', ['-C', cwd, ...a], { encoding: 'utf8' })

  // A real repo, so a builder can get a worktree and its work can merge.
  const repo = () => {
    const dir = join(home, 'repo')
    mkdirSync(dir)
    git(dir, 'init', '-q', '-b', 'main')
    git(dir, 'config', 'user.email', 't@t'); git(dir, 'config', 'user.name', 't')
    writeFileSync(join(dir, 'README'), 'x\n'); git(dir, 'add', '.'); git(dir, 'commit', '-qm', 'init')
    return dir
  }

  it('logs the purpose of a spawn: the explicit one, else code with a worktree, else research', () => {
    const dir = repo()
    const lead = h.create({ label: 'Lead', cli: 'opencode', cwd: dir, lead: true })
    h.spawn(lead.id, { label: 'x', cli: 'opencode', cwd: dir, worktree: true })
    h.spawn(lead.id, { label: 'y', cli: 'opencode', cwd: home })
    h.spawn(lead.id, { label: 'z', cli: 'opencode', cwd: dir, worktree: true, purpose: 'research' })
    h.spawn(lead.id, { label: 'w', cli: 'opencode', cwd: home, purpose: 'code' })
    const purposes = h.recentActions().filter(a => a.action === 'spawn').map(a => a.args.purpose)
    expect(purposes).toEqual(['code', 'research', 'research', 'code'])
    const logged = readFileSync(join(home, 'actions.jsonl'), 'utf8').trim().split('\n').map(l => JSON.parse(l)).filter(a => a.action === 'spawn')
    expect(logged.map(a => a.args.purpose)).toEqual(['code', 'research', 'research', 'code'])
  })

  it('tells a lead once when the third attempt at the same task has no merge', () => {
    const dir = repo()
    const lead = h.create({ label: 'Lead', cli: 'opencode', cwd: dir, lead: true })
    const typed: string[] = []
    vi.spyOn(Terminal.prototype, 'type').mockImplementation(async (text: string) => { typed.push(text) })
    h.spawn(lead.id, { label: 'x', cli: 'opencode', cwd: dir, worktree: true })
    h.spawn(lead.id, { label: 'x-2', cli: 'opencode', cwd: dir, worktree: true })
    h.spawn(lead.id, { label: 'x-3', cli: 'opencode', cwd: dir, worktree: true })
    const chains = h.recentActions().filter(a => a.action === 'retry-chain')
    expect(chains).toHaveLength(1)
    expect(chains[0].args).toMatchObject({ label: 'x-3', base: 'x', count: 3 })
    expect(typed.join('\n')).toContain('Third attempt at x with no merge')
    h.spawn(lead.id, { label: 'x-4', cli: 'opencode', cwd: dir, worktree: true })
    expect(h.recentActions().filter(a => a.action === 'retry-chain')).toHaveLength(1)   // once per base per caller
    expect(h.listReports(lead.id)).toHaveLength(4)                                    // the spawn was never blocked
  })

  it('says nothing when an earlier attempt of the chain merged', async () => {
    const dir = repo()
    const lead = h.create({ label: 'Lead', cli: 'opencode', cwd: dir, lead: true })
    const typed: string[] = []
    vi.spyOn(Terminal.prototype, 'type').mockImplementation(async (text: string) => { typed.push(text) })
    const x = h.spawn(lead.id, { label: 'x', cli: 'opencode', cwd: dir, worktree: true })
    const wt = h.list().find(n => n.id === x.id)!.worktree!.path
    writeFileSync(join(wt, 'work.txt'), 'done\n'); git(wt, 'add', '.'); git(wt, 'commit', '-qm', 'work')
    expect((await h.mergeReport(lead.id, x.id, 'true')).merged).toBe(true)
    h.spawn(lead.id, { label: 'x-2', cli: 'opencode', cwd: dir, worktree: true })
    h.spawn(lead.id, { label: 'x-3', cli: 'opencode', cwd: dir, worktree: true })
    expect(h.recentActions().filter(a => a.action === 'retry-chain')).toHaveLength(0)
    expect(typed.join('\n')).not.toContain('Third attempt')
  })

  it('a research seat is not a retry chain: it never merges, so it never counts', () => {
    const lead = h.create({ label: 'Lead', cli: 'opencode', cwd: home, lead: true })
    const typed: string[] = []
    vi.spyOn(Terminal.prototype, 'type').mockImplementation(async (text: string) => { typed.push(text) })
    h.spawn(lead.id, { label: 'x', cli: 'opencode', cwd: home, purpose: 'research' })
    h.spawn(lead.id, { label: 'x-2', cli: 'opencode', cwd: home, purpose: 'research' })
    h.spawn(lead.id, { label: 'x-3', cli: 'opencode', cwd: home, purpose: 'research' })
    expect(h.recentActions().filter(a => a.action === 'retry-chain')).toHaveLength(0)
    expect(typed.join('\n')).not.toContain('Third attempt')
  })
})

it('a silent critic is replaced, and with no one able, votes open without a critique', async () => {
  const ids = ['A', 'B', 'C'].map(l => h.create({ label: `Peer ${l}`, cli: 'shell', cwd: home }).id)
  ;(h as any).directive = { text: 't', workspace: home, directorId: ids[0], goals: [], deliverables: [], status: 'running', startedAt: '',
    shape: 'holon', council: { members: ids, quorum: 2 }, proposals: [], tasks: [] }
  h.critiqueTimeoutMs = 50
  ;(h as any).nodes.get(ids[1]).info.blocked = 'out of quota'
  const pending = h.propose(ids[0], 'Plan', 'why')
  const p = h.getDirective()!.proposals![0]
  expect(p.critic).toBe(ids[2])                         // the blocked peer is skipped
  await new Promise(r => setTimeout(r, 80))
  expect(p.critic).toBeUndefined()                      // nobody else able: votes open
  h.vote(ids[2], p.id, 'yes', 'fine')
  expect((await pending).status).toBe('passed')
})

describe('self-optimizing org', () => {
  it('co-directors cannot run teams in a hierarchy; idle helpers retire in any shape', async () => {
    const dir = h.create({ label: 'Director', cli: 'shell', cwd: home, lead: true })
    const co = h.create({ label: 'Co', cli: 'shell', cwd: home, lead: true })
    ;(h as any).directive = { text: 't', workspace: home, directorId: dir.id, goals: [], deliverables: [], status: 'running', startedAt: '',
      council: { members: [dir.id, co.id], quorum: 2 }, proposals: [] }
    expect(() => h.spawn(co.id, { label: 'x', cli: 'shell', cwd: home })).toThrow(/co-directors vote and review/)
    const helper = h.spawn(dir.id, { label: 'Helper', cli: 'shell', cwd: home })
    await h.wait(null, helper.id, 1500, 20000)
    expect(h.autoscale(Date.now() + 21 * 60_000)).toEqual([helper.id])
  })

  it('idle retirement keeps a seat that is waiting on a background shell', async () => {
    const dir = h.create({ label: 'Director', cli: 'shell', cwd: home, lead: true })
    ;(h as any).directive = { text: 't', workspace: home, directorId: dir.id, goals: [], deliverables: [], status: 'running', startedAt: '', proposals: [] }
    const waiting = h.spawn(dir.id, { label: 'Waiting', cli: 'shell', cwd: home })
    const idle = h.spawn(dir.id, { label: 'Idle', cli: 'shell', cwd: home })
    await h.type(dir.id, waiting.id, 'echo "auto mode on · 1 shell"')
    await h.wait(null, waiting.id, 1500, 20000)
    await h.wait(null, idle.id, 1500, 20000)
    expect(h.autoscale(Date.now() + 21 * 60_000)).toEqual([idle.id])
    expect(h.list().some(n => n.id === waiting.id)).toBe(true)
  })

  it('idle retirement keeps a builder whose commits are not merged yet', async () => {
    const { execFileSync } = await import('node:child_process')
    const repo = join(home, 'repo')
    const git = (cwd: string, ...a: string[]) => execFileSync('git', ['-C', cwd, ...a], { encoding: 'utf8' })
    mkdirSync(repo); git(repo, 'init', '-q', '-b', 'main')
    git(repo, 'config', 'user.email', 't@t'); git(repo, 'config', 'user.name', 't')
    writeFileSync(join(repo, 'README'), 'x\n'); git(repo, 'add', '.'); git(repo, 'commit', '-qm', 'init')
    const dir = h.create({ label: 'Director', cli: 'shell', cwd: repo, lead: true })
    ;(h as any).directive = { text: 't', workspace: repo, directorId: dir.id, goals: [], deliverables: [], status: 'running', startedAt: '', proposals: [] }
    const busy = h.spawn(dir.id, { label: 'Busy', cli: 'shell', cwd: repo, worktree: true })
    const idle = h.spawn(dir.id, { label: 'Idle', cli: 'shell', cwd: repo, worktree: true })
    const wt = h.list().find(n => n.id === busy.id)!.worktree!.path
    writeFileSync(join(wt, 'work.txt'), 'done\n'); git(wt, 'add', '.'); git(wt, 'commit', '-qm', 'work')
    await h.wait(null, idle.id, 1500, 20000)
    expect(h.autoscale(Date.now() + 21 * 60_000)).toEqual([idle.id])
    expect(h.list().some(n => n.id === busy.id)).toBe(true)
  })

  it('gives the Director a per-team scorecard and asks for a reorg', async () => {
    const dir = h.create({ label: 'Director', cli: 'shell', cwd: home, lead: true })
    const lead = h.spawn(dir.id, { label: 'Growth', cli: 'shell', cwd: home, lead: true })
    ;(h as any).directive = { text: 't', workspace: home, directorId: dir.id, goals: [], deliverables: [], status: 'running', startedAt: '' }
    expect(h.scorecard().map(r => r.team).sort()).toEqual(['Director', 'Growth'])
    await h.wait(null, dir.id, 1500, 20000)
    expect(h.review(Date.now(), 120, true)).toBe(true)
    expect(h.review(Date.now(), 120)).toBe(false)             // not again so soon
    await seen(h, dir.id, 'Org review. Scorecard per team')
    void lead
  })

  it.each([
    { claude: 0, codex: 0, pool: 'claude' },
    { claude: 120_000, codex: 0, pool: 'codex' },
    { claude: 120_000, codex: 60_000, pool: null },
  ])('review staffing respects exhausted pools: %j', ({ claude, codex, pool }) => {
    const dir = h.create({ label: 'Director', cli: 'shell', cwd: home, lead: true })
    ;(h as any).directive = { text: 't', workspace: home, directorId: dir.id, goals: [], deliverables: [], status: 'running', startedAt: '' }
    const now = Date.parse('2026-10-30T00:00:00Z')
    ;(h as any).quotaOutUntil = { opencode: now + 180_000, claude: now + claude, codex: now + codex }
    const type = vi.spyOn(Terminal.prototype, 'type').mockResolvedValue(undefined)
    expect(h.review(now, 120, true)).toBe(true)
    const prompt = type.mock.calls[0][0]
    expect(prompt).not.toContain('on free cli opencode builders')
    if (pool) {
      expect(prompt).toContain('OpenCode is out until 2026-10-30T00:03:00.000Z')
      expect(prompt).toContain(`spawning G0 already routes to the cheapest available paid pool (${pool}) at G1`)
      expect(prompt).toContain('staff at least one bounded task from an unblocked goal now, or name for each goal why it cannot move')
    } else {
      expect(prompt).toContain('Every model pool is out')
      expect(prompt).toContain('hold until the earliest reset at 2026-10-30T00:01:00.000Z rather than spawn')
      expect(prompt).not.toContain('staff at least one')
    }
  })

  it('does not count the Director completing a review round as shipping, so reviews do not chain', async () => {
    const dir = h.create({ label: 'Director', cli: 'shell', cwd: home, lead: true })
    ;(h as any).directive = { text: 't', workspace: home, directorId: dir.id, goals: [], deliverables: [], status: 'running', startedAt: '' }
    const t0 = Date.now()
    expect(h.review(t0, 120, true)).toBe(true)
    ;(h as any).recent.push({ ts: new Date(t0 + 60_000).toISOString(), caller: dir.id, target: null, action: 'complete', args: {} })
    expect(h.review(t0 + 3 * 60 * 60_000)).toBe(false)
    ;(h as any).recent.push({ ts: new Date(t0 + 120_000).toISOString(), caller: dir.id, target: null, action: 'merged', args: {} })
    expect(h.review(t0 + 3 * 60 * 60_000)).toBe(true)
  })
})


it('prices a Codex seat kept from before Codex had default rates, even after it exited', async () => {
  const session = join(home, 'codex-session.jsonl')
  writeFileSync(session, JSON.stringify({ type: 'event_msg', payload: { info: { total_token_usage: { input_tokens: 2_000_000, cached_input_tokens: 1_000_000, output_tokens: 100_000, reasoning_output_tokens: 0 } } } }) + '\n')
  writeFileSync(join(home, 'usage.json'), JSON.stringify({ 'gone-1': { input: 1_000_000, output: 100_000, cacheRead: 1_000_000, cacheWrite: 0, costUsd: null, source: session, label: 'Old builder', cli: 'codex', model: 'gpt-6-luna' } }))
  const row = (await h.refreshUsage()).find(r => r.id === 'gone-1')
  // gpt-6-luna: 1M input at $0.10, 0.1M output at $0.50, 1M cached at $0.01
  expect(row?.costUsd).toBeCloseTo(0.1 + 0.05 + 0.01, 6)
})
