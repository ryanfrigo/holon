import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { mkdtempSync, readFileSync } from 'node:fs'
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

describe('treasury', () => {
  const org = () => {
    const dir = h.create({ label: 'Director', cli: 'shell', cwd: home, lead: true })   // heavy tier: 1 per minute
    ;(h as any).directive = { text: 't', workspace: home, directorId: dir.id, goals: [], deliverables: [], status: 'running', startedAt: '' }
    return dir
  }

  it('charges running terminals, credits settled MRR, and shuts the org down at zero', () => {
    const dir = org()
    h.setTreasury({ budgetMin: 10, minPerDollar: 50 })
    const t = h.getDirective()!.treasury!
    t.mrr = 30 * 24 * 60 / 50   // earns exactly one agent-minute per minute
    ;(h as any).nodes.get(dir.id).term.lastChangeAt = Date.now() // running
    h.tick(60_000)
    expect(t.spentMin).toBeCloseTo(1)
    expect(t.earnedMin).toBeCloseTo(1)
    t.mrr = 0
    for (let i = 0; i < 10; i++) { (h as any).nodes.get(dir.id).term.lastChangeAt = Date.now(); h.tick(60_000) }
    expect(h.getDirective()!.status).toBe('dead')
    expect(h.list()).toEqual([])
  })

  it('idle terminals cost nothing', async () => {
    const dir = org()
    h.setTreasury({ budgetMin: 10 })
    await h.wait(null, dir.id, 1500, 20000)
    h.tick(60_000)
    expect(h.getDirective()!.treasury!.spentMin).toBe(0)
  })

  it('reads MRR from the revenue command, as JSON or a bare number', async () => {
    org()
    h.setTreasury({ budgetMin: 10, revenueCmd: `echo '{"mrr": 99}'` })
    await h.refreshRevenue()
    expect(h.getDirective()!.treasury!.mrr).toBe(99)
    h.setTreasury({ budgetMin: 10, revenueCmd: 'echo 42.5' })
    await h.refreshRevenue()
    expect(h.getDirective()!.treasury!.mrr).toBe(42.5)
  })
})

it('the heartbeat still fires while a question waits on the human, and says so', async () => {
  const dir = h.create({ label: 'Director', cli: 'shell', cwd: home })
  ;(h as any).directive = { text: 't', workspace: home, directorId: dir.id, goals: [], deliverables: [], status: 'running', startedAt: '', heartbeatMin: 5 }
  void h.escalate(dir.id, 'approve spend?')
  await h.wait(null, dir.id, 1500, 20000)
  const t0 = Date.now()
  h.beat(t0)
  expect(h.beat(t0 + 6 * 60_000)).toBe(true)
  await seen(h, dir.id, "still waiting on the human")
})

describe('council', () => {
  const seat = () => {
    const dir = h.create({ label: 'Director', cli: 'shell', cwd: home })
    const a = h.create({ label: 'Co A', cli: 'shell', cwd: home })
    const b = h.create({ label: 'Co B', cli: 'shell', cwd: home })
    ;(h as any).directive = { text: 't', workspace: home, directorId: dir.id, goals: [], deliverables: [], status: 'running', startedAt: '',
      council: { members: [dir.id, a.id, b.id], quorum: 2 }, proposals: [] }
    return { dir, a, b }
  }

  it('passes with 2 of 3, types the proposal into the others, and unblocks set_goals', async () => {
    const { dir, a, b } = seat()
    await h.wait(null, a.id, 1500, 20000)
    expect(() => h.setGoals(dir.id, ['g'])).toThrow(/council must pass/)
    const pending = h.propose(dir.id, 'Adopt goals G1-G3', 'evidence in docs/')
    const p = h.getDirective()!.proposals![0]
    await seen(h, a.id, `Council proposal ${p.id}`)
    h.vote(b.id, p.id, 'yes', 'checked')
    expect((await pending).status).toBe('passed')
    expect(() => h.vote(a.id, p.id, 'no', 'late')).toThrow(/already passed/)
    h.setGoals(dir.id, ['g'], p.id)
    expect(h.getDirective()!.goals).toEqual(['g'])
  })

  it('rejects with 2 no votes; non-members cannot vote', async () => {
    const { dir, a, b } = seat()
    const rep = h.create({ label: 'Rep', cli: 'shell', cwd: home, parentId: dir.id })
    const pending = h.propose(a.id, 'Pivot to dentists', 'hunch')
    const p = h.getDirective()!.proposals![0]
    expect(() => h.vote(rep.id, p.id, 'yes', 'x')).toThrow(/only council members/)
    h.vote(dir.id, p.id, 'no', 'no evidence')
    h.vote(b.id, p.id, 'no', 'agree')
    expect((await pending).status).toBe('rejected')
  })

  it('gemini starts in its own folder with the holon MCP server configured', async () => {
    const { launchFor } = await import('../src/adapters.ts')
    const { readFileSync } = await import('node:fs')
    const l = launchFor('gemini', { id: 'g1', cwd: '/work', home, socketPath: 's', mcpEntry: 'm', lead: true, yolo: true })
    expect(l.args).toEqual(['--include-directories', '/work', '--yolo'])
    expect(JSON.parse(readFileSync(join(l.cwd!, '.gemini', 'settings.json'), 'utf8')).mcpServers.holon.env.HOLON_TERMINAL_ID).toBe('g1')
  })
})

describe('knowledge base wiring', () => {
  it('captures human answers, passed proposals and round summaries automatically', async () => {
    const dir = h.create({ label: 'Director', cli: 'shell', cwd: home })
    const co = h.create({ label: 'Co', cli: 'shell', cwd: home })
    ;(h as any).openKb(home)
    ;(h as any).directive = { text: 't', workspace: home, directorId: dir.id, goals: [], deliverables: [], status: 'running', startedAt: '',
      council: { members: [dir.id, co.id], quorum: 2 }, proposals: [] }
    const q = h.escalate(dir.id, 'Run ads at $20/day?')
    h.answer(null, h.listEscalations()[0].id, 'yes, cap $280')
    await q
    const pr = h.propose(dir.id, 'Adopt G1', 'because')
    h.vote(co.id, h.getDirective()!.proposals![0].id, 'yes', 'ok')
    await pr
    h.complete(dir.id, 'shipped G1', h.getDirective()!.proposals![0].id)
    h.kbWrite(dir.id, 'lesson', 'Codex update prompt', 'skip it')
    const o = h.kbOverview()!
    expect(o.counts).toMatchObject({ decision: 2, fact: 1, lesson: 1 })
    expect(h.kbSearch('ads')[0].title).toMatch(/^Human: Run ads/)
    expect(h.kbRead(null, h.kbSearch('ads')[0].path).body).toContain('yes, cap $280')
  })
})

describe('worktrees through the org', () => {
  it('a lead spawns two builders in their own worktrees and merges both through the queue', async () => {
    const { execFileSync } = await import('node:child_process')
    const { writeFileSync, existsSync } = await import('node:fs')
    const repo = join(home, 'repo')
    const git = (cwd: string, ...a: string[]) => execFileSync('git', ['-C', cwd, ...a], { encoding: 'utf8' })
    execFileSync('git', ['init', '-q', '-b', 'main', repo])
    git(repo, 'config', 'user.email', 't@t'); git(repo, 'config', 'user.name', 't')
    writeFileSync(join(repo, 'README'), 'x\n'); git(repo, 'add', '.'); git(repo, 'commit', '-qm', 'init')
    const lead = h.create({ label: 'Lead', cli: 'shell', cwd: repo })
    const b1 = h.spawn(lead.id, { label: 'B1', cli: 'shell', cwd: repo, worktree: true })
    const b2 = h.spawn(lead.id, { label: 'B2', cli: 'shell', cwd: repo, worktree: true })
    expect(b1.cwd).not.toBe(repo)
    for (const [b, f] of [[b1, 'one.txt'], [b2, 'two.txt']] as const) {
      writeFileSync(join(b.cwd, f), f); git(b.cwd, 'add', f); git(b.cwd, 'commit', '-qm', f)
    }
    const [r1, r2] = await Promise.all([h.mergeReport(lead.id, b1.id, 'true'), h.mergeReport(lead.id, b2.id, 'true')])
    expect([r1.merged, r2.merged]).toEqual([true, true])   // the second rebased onto the first
    expect(existsSync(join(repo, 'one.txt')) && existsSync(join(repo, 'two.txt'))).toBe(true)
    await expect(h.mergeReport(b1.id, b2.id)).rejects.toThrow(/not your report/)
    h.kill(b1.id)
    expect(existsSync(b1.cwd)).toBe(false)
  })
})

it('escalations survive a restart, and a late answer is typed into the asker', async () => {
  const dir = h.create({ label: 'Director', cli: 'shell', cwd: home })
  void h.escalate(dir.id, 'approve $2 test?')
  h.shutdown()
  const again = new Holon({ home, socketPath: join(home, 'holon.sock'), mcpEntry: '/dev/null' })
  await again.restore()
  const [esc] = again.listEscalations()
  expect(esc).toMatchObject({ message: 'approve $2 test?', status: 'open', to: null })
  const restored = again.list()[0]
  await again.wait(null, restored.id, 1500, 20000)
  again.answer(null, esc.id, 'yes')
  await seen(again, restored.id, `Answer to your escalation ${esc.id}`)
  again.shutdown()
})

it('seating co-directors one at a time grows the council and its quorum', async () => {
  const dir = h.create({ label: 'Director', cli: 'shell', cwd: home })
  ;(h as any).directive = { text: 't', workspace: home, directorId: dir.id, goals: [], deliverables: [], status: 'running', startedAt: '' }
  await h.seatCouncil(['shell'])
  expect(h.getDirective()!.council).toMatchObject({ quorum: 2 })
  await h.seatCouncil(['shell'])
  expect(h.getDirective()!.council!.members).toHaveLength(3)
  expect(h.getDirective()!.council!.quorum).toBe(2)
})

it('terminals on free models cost no runway', () => {
  const t = h.create({ label: 'Free', cli: 'shell', cwd: home })
  ;(h as any).nodes.get(t.id).info.cli = 'opencode'
  ;(h as any).directive = { text: 't', workspace: home, directorId: t.id, goals: [], deliverables: [], status: 'running', startedAt: '' }
  h.setTreasury({ budgetMin: 10 })
  ;(h as any).nodes.get(t.id).term.lastChangeAt = Date.now()
  h.tick(60_000)
  expect(h.getDirective()!.treasury!.spentMin).toBe(0)
})

it('roles and treasury show API-equivalent dollars from usageCache', () => {
  const t = h.create({ label: 'Bill', cli: 'shell', cwd: home })
  ;(h as any).directive = { text: 't', workspace: home, directorId: t.id, goals: [], deliverables: [], status: 'running', startedAt: '' }
  h.setTreasury({ budgetMin: 10 })
  ;(h as any).usageCache.set(t.id, { costUsd: 1.5, label: 'Bill', cli: 'opencode' })
  const role = h.roles().find(r => r.id === t.id)!
  expect(role.spentUsd).toBe(1.5)
  expect(role.spentMin).toBe(0)
  const tv = h.treasuryView(null)
  expect(tv.spentUsdBy).toMatchObject({ [t.id]: 1.5 })
  expect(tv.costBasis).toBe('api-equivalent estimate, not billed spend')
})

it('treasury still reports API-equivalent dollars with no budget set', () => {
  const t = h.create({ label: 'Bill', cli: 'shell', cwd: home })
  ;(h as any).directive = { text: 't', workspace: home, directorId: t.id, goals: [], deliverables: [], status: 'running', startedAt: '' }
  ;(h as any).usageCache.set(t.id, { costUsd: 1.5, label: 'Bill', cli: 'opencode' })
  const tv = h.treasuryView(null)
  expect(tv.treasury).toMatch(/none/)
  expect(tv.spentUsdBy).toMatchObject({ [t.id]: 1.5 })
  expect(tv.costBasis).toBe('api-equivalent estimate, not billed spend')
})

it('spentUsdBy keeps both roles when two share a label', () => {
  const a = h.create({ label: 'Twin', cli: 'shell', cwd: home })
  const b = h.create({ label: 'Twin', cli: 'shell', cwd: home })
  ;(h as any).directive = { text: 't', workspace: home, directorId: a.id, goals: [], deliverables: [], status: 'running', startedAt: '' }
  ;(h as any).usageCache.set(a.id, { costUsd: 1, label: 'Twin', cli: 'opencode' })
  ;(h as any).usageCache.set(b.id, { costUsd: 2, label: 'Twin', cli: 'opencode' })
  const tv = h.treasuryView(null)
  expect(tv.spentUsdBy).toEqual({ [a.id]: 1, [b.id]: 2 })
  expect(h.roles().find(r => r.id === b.id)!.spentUsd).toBe(2)
})

describe('autopilot', () => {
  it('the top of the org may only ask the human for needs, and posts updates instead', async () => {
    const dir = h.create({ label: 'Director', cli: 'shell', cwd: home })
    ;(h as any).directive = { text: 't', workspace: home, directorId: dir.id, goals: [], deliverables: [], status: 'running', startedAt: '', autopilot: true }
    await expect(h.escalate(dir.id, 'Should we run ads?')).rejects.toThrow(/Autopilot is on/)
    void h.escalate(dir.id, 'Need a Google Ads API token', 1000, 'need', { blocks: 'none' })
    expect(h.listEscalations()[0]).toMatchObject({ kind: 'need', status: 'open' })
    h.update(dir.id, 'Shipped G1')
    expect(h.getDirective()!.updates![0]).toMatchObject({ by: 'Director', text: 'Shipped G1' })
    const rep = h.create({ label: 'Rep', cli: 'shell', cwd: home, parentId: dir.id })
    expect(() => h.update(rep.id, 'x')).toThrow(/only the top/)
    void h.escalate(rep.id, 'question for my lead')   // reports can still ask their lead
    expect(h.listEscalations().some(e => e.from === rep.id && e.to === dir.id)).toBe(true)
  })
})

