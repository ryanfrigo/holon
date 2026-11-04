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

describe('model tiers', () => {
  it('reports default to standard, leads to heavy, and runway is charged by tier', () => {
    const lead = h.create({ label: 'Lead', cli: 'claude', cwd: home, lead: true })
    const light = h.spawn(lead.id, { label: 'Copy', cli: 'claude', cwd: home, tier: 'light', why: 'test' })
    const std = h.spawn(lead.id, { label: 'Code', cli: 'codex', cwd: home, why: 'test' })
    expect([lead.model, light.model, std.model]).toEqual(['opus', 'haiku', 'gpt-6-astra'])
    ;(h as any).directive = { text: 't', workspace: home, directorId: lead.id, goals: [], deliverables: [], status: 'running', startedAt: '' }
    h.setTreasury({ budgetMin: 100 })
    for (const id of [lead.id, light.id, std.id]) (h as any).nodes.get(id).term.lastChangeAt = Date.now()
    h.tick(60_000)
    expect(h.getDirective()!.treasury!.spentMin).toBeCloseTo(1 + 0.25 + 0.5)
  })

  it('a lead under another lead defaults to standard; heavy only when asked', () => {
    const dir = h.create({ label: 'Director', cli: 'claude', cwd: home, lead: true })
    const sub = h.spawn(dir.id, { label: 'Outbound', cli: 'claude', cwd: home, lead: true })
    const hard = h.spawn(dir.id, { label: 'Arch', cli: 'claude', cwd: home, lead: true, tier: 'heavy' })
    expect([dir.model, sub.model, hard.model]).toEqual(['opus', 'sonnet', 'opus'])
  })
})

it('a passed "Ask the human" proposal becomes a need in the human inbox', async () => {
  const dir = h.create({ label: 'Director', cli: 'shell', cwd: home })
  const co = h.create({ label: 'Co', cli: 'shell', cwd: home })
  ;(h as any).directive = { text: 't', workspace: home, directorId: dir.id, goals: [], deliverables: [], status: 'running', startedAt: '', autopilot: true,
    council: { members: [dir.id, co.id], quorum: 2 }, proposals: [] }
  const pending = h.propose(dir.id, 'Ask the human for: a Porkbun mailbox ($3/month)', 'needed for the email pilot')
  h.vote(co.id, h.getDirective()!.proposals![0].id, 'yes', 'ok')
  await pending
  const need = h.listEscalations().find(e => e.to === null)
  expect(need).toMatchObject({ kind: 'need', status: 'open' })
  expect(need!.message).toContain('Porkbun mailbox')
})

it('restore leaves exited terminals gone, and leads can kill their own reports', async () => {
  const lead = h.create({ label: 'Lead', cli: 'shell', cwd: home })
  const a = h.spawn(lead.id, { label: 'A', cli: 'shell', cwd: home })
  const b = h.spawn(lead.id, { label: 'B', cli: 'shell', cwd: home })
  await h.wait(null, a.id, 1500, 20000)
  const exited = new Promise(r => (h as any).nodes.get(a.id).term.once('exit', r))
  await h.type(null, a.id, 'exit')
  await exited
  expect(() => h.killReport(b.id, lead.id, 'closing it')).toThrow(/not your report/)
  h.shutdown()
  const again = new Holon({ home, socketPath: join(home, 'holon.sock'), mcpEntry: '/dev/null' })
  await again.restore()
  expect(again.list().map(n => n.label).sort()).toEqual(['B', 'Lead'])
  again.killReport(lead.id, b.id, 'restored, then closed', true)
  expect(again.list().map(n => n.label)).toEqual(['Lead'])
  again.shutdown()
})

it('a blocked member cannot deadlock the council: a full tie among able members rejects', async () => {
  const ids = ['A', 'B', 'C'].map(l => h.create({ label: `Peer ${l}`, cli: 'shell', cwd: home }).id)
  ;(h as any).directive = { text: 't', workspace: home, directorId: ids[0], goals: [], deliverables: [], status: 'running', startedAt: '',
    council: { members: ids, quorum: 2 }, proposals: [] }
  ;(h as any).nodes.get(ids[2]).info.blocked = 'out of quota'
  const pending = h.propose(ids[0], 'Plan v1', 'why')
  h.vote(ids[1], h.getDirective()!.proposals![0].id, 'no', 'tests too thin')
  expect((await pending).status).toBe('rejected')
  const again = h.propose(ids[0], 'Plan v2 with more tests', 'addresses the critique')
  h.vote(ids[1], h.getDirective()!.proposals![1].id, 'yes', 'fixed')
  expect((await again).status).toBe('passed')
})

it('with an even number of able voters, the auditor breaks the tie', async () => {
  const ids = ['A', 'B', 'C'].map(l => h.create({ label: `Peer ${l}`, cli: 'shell', cwd: home }).id)
  const auditor = h.create({ label: 'Auditor', cli: 'shell', cwd: home }).id
  ;(h as any).directive = { text: 't', workspace: home, directorId: ids[0], goals: [], deliverables: [], status: 'running', startedAt: '',
    shape: 'holon', council: { members: ids, quorum: 2 }, proposals: [], tasks: [], auditorId: auditor }
  ;(h as any).nodes.get(ids[2]).info.blocked = 'out of quota'
  const pending = h.propose(ids[0], 'Plan', 'why')
  const p = h.getDirective()!.proposals![0]
  expect(p.tiebreaker).toBe(auditor)
  h.critique(p.critic!, p.id, 'tests too thin')
  h.vote(p.critic!, p.id, 'no', 'see critique')
  expect(p.status).toBe('open')                       // 1-1 is not the end: the auditor decides
  h.vote(auditor, p.id, 'yes', 'critique is minor; plan is sound')
  expect((await pending).status).toBe('passed')
})

describe('second opinion', () => {
  it('spawns a read-only reviewer from another vendor, returns its verdict, then closes it', async () => {
    const dir = h.create({ label: 'Director', cli: 'shell', cwd: home, lead: true })
    ;(h as any).openKb(home)
    ;(h as any).directive = { text: 't', workspace: home, directorId: dir.id, goals: [], deliverables: [], status: 'running', startedAt: '' }
    ;(h as any).clearStartup = async () => {}                // shells have no startup screens
    h.reviewPollMs = 50
    const pending = h.secondOpinion(dir.id, 'Rotate the JWT key in prod?', 'old key leaked in a log')
    await new Promise(r => setTimeout(r, 300))
    const reviewer = h.list().find(n => n.label.startsWith('Reviewer'))!
    expect(reviewer).toMatchObject({ parentId: dir.id, readOnly: true, cli: 'codex' })
    expect(() => h.verdict(dir.id, 'rev-x', 'approve', 'x')).toThrow(/no review/)
    const id = reviewer.label.split(' ')[1]
    h.verdict(reviewer.id, id, 'revise', 'rotate, but keep the old key in JWKS for 24h so sessions survive')
    expect(await pending).toMatchObject({ decision: 'revise' })
    expect(h.list().some(n => n.id === reviewer.id)).toBe(false)
    expect(h.kbSearch('second opinion JWT', 'decision')).toHaveLength(1)
  })
})

it('second opinion fails over when the first reviewer is out of quota', async () => {
  const dir = h.create({ label: 'Director', cli: 'shell', cwd: home, lead: true })
  ;(h as any).openKb(home)
  ;(h as any).directive = { text: 't', workspace: home, directorId: dir.id, goals: [], deliverables: [], status: 'running', startedAt: '' }
  ;(h as any).clearStartup = async () => {}
  h.reviewPollMs = 50
  const pending = h.secondOpinion(dir.id, 'Ship it?', 'tests green')
  await new Promise(r => setTimeout(r, 300))
  const first = h.list().find(n => n.label.startsWith('Reviewer'))!
  expect(first.cli).toBe('codex')
  await h.type(null, first.id, "printf 'You have hit your usage limit.\\n'")
  await new Promise(r => setTimeout(r, 1500))
  const second = h.list().find(n => n.label.startsWith('Reviewer'))!
  expect(second.cli).toBe('opencode')
  h.verdict(second.id, second.label.split(' ')[1], 'approve', 'tests and diff check out')
  expect(await pending).toMatchObject({ decision: 'approve' })
})

it('second opinion fails over when the first reviewer is stuck at a permission prompt', async () => {
  const dir = h.create({ label: 'Director', cli: 'shell', cwd: home, lead: true })
  ;(h as any).openKb(home)
  ;(h as any).directive = { text: 't', workspace: home, directorId: dir.id, goals: [], deliverables: [], status: 'running', startedAt: '' }
  ;(h as any).clearStartup = async () => {}
  h.reviewPollMs = 50
  const pending = h.secondOpinion(dir.id, 'Delete the old bucket?', 'nothing references it')
  await new Promise(r => setTimeout(r, 300))
  const first = h.list().find(n => n.label.startsWith('Reviewer'))!
  expect(first.cli).toBe('codex')
  await h.type(null, first.id, "printf 'Allow once\\n'")
  await new Promise(r => setTimeout(r, 300))
  ;(h as any).nodes.get(first.id).term.lastChangeAt = Date.now() - 6 * 60_000
  await new Promise(r => setTimeout(r, 800))
  const second = h.list().find(n => n.label.startsWith('Reviewer'))!
  expect(second.cli).toBe('opencode')
  const actions = readFileSync(join(home, 'actions.jsonl'), 'utf8').trim().split('\n').map(l => JSON.parse(l))
  expect(actions.some(a => a.action === 'reviewer_failover' && a.caller === dir.id && a.args.from === 'codex')).toBe(true)
  h.verdict(second.id, second.label.split(' ')[1], 'approve', 'nothing references it')
  expect(await pending).toMatchObject({ decision: 'approve' })
})

it('a ring peer out of quota releases its tasks and the others are told to cover', async () => {
  const ids = ['A', 'B'].map(l => h.create({ label: `Peer ${l}`, cli: 'shell', cwd: home }).id)
  ;(h as any).directive = { text: 't', workspace: home, directorId: ids[0], goals: [], deliverables: [], status: 'running', startedAt: '',
    shape: 'holon', council: { members: ids, quorum: 2 }, proposals: [], tasks: [] }
  const t = h.postTask(ids[0], 'T1', '')
  h.claimTask(ids[0], t.id)
  await h.wait(null, ids[0], 1500, 20000)
  await h.type(null, ids[0], "printf 'You have hit your usage limit.\\n'")
  await h.wait(null, ids[0], 1000)
  await h.heal(Date.now() + 30_000, false)
  expect(h.listTasks('open').map(x => x.id)).toEqual([t.id])
  await seen(h, ids[1], 'Peer A is out of model quota')
})

it('finishing an unclaimed task records the finisher as its owner', () => {
  const a = h.create({ label: 'Peer A', cli: 'shell', cwd: home })
  ;(h as any).directive = { text: 't', workspace: home, directorId: a.id, goals: [], deliverables: [], status: 'running', startedAt: '', tasks: [] }
  const t = h.postTask(null, 'T', '')
  h.finishTask(a.id, t.id, 'commit abc')
  expect(h.listTasks('done')[0].owner).toBe('Peer A')
})

