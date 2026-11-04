import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { execSync } from 'node:child_process'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Holon } from '../src/holon.ts'
import { rootOf } from '../src/projects.ts'
import { Terminal } from '../src/terminal.ts'
import { seen } from '../../../test-support/seen.ts'

let home: string
let h: Holon
beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), 'holon-'))
  h = new Holon({ home, socketPath: join(home, 'holon.sock'), mcpEntry: '/dev/null' })
})
afterEach(() => { h.shutdown(); vi.restoreAllMocks() })

describe('Holon', () => {
  it('records the org tree and writes org.json', () => {
    const lead = h.create({ label: 'Lead', cli: 'shell', cwd: home })
    const rep = h.create({ label: 'Worker', cli: 'shell', cwd: home, parentId: lead.id })
    expect(h.listReports(lead.id).map(n => n.id)).toEqual([rep.id])
    const saved = JSON.parse(readFileSync(join(home, 'org.json'), 'utf8'))
    expect(saved.map((n: { parentId: string | null }) => n.parentId)).toEqual([null, lead.id])
  })

  it('lets a lead drive its report and logs each action', async () => {
    const lead = h.create({ label: 'Lead', cli: 'shell', cwd: home })
    const rep = h.create({ label: 'Worker', cli: 'shell', cwd: home, parentId: lead.id })
    await h.wait(lead.id, rep.id, 2000, 20000)
    await h.type(lead.id, rep.id, 'echo driven-by-lead')
    const { screen } = await h.wait(lead.id, rep.id, 1500)
    expect(screen).toMatch(/^driven-by-lead$/m)
    const actions = readFileSync(join(home, 'actions.jsonl'), 'utf8').trim().split('\n').map(l => JSON.parse(l).action)
    expect(actions).toEqual(['wait', 'wait_done', 'type', 'wait', 'wait_done'])
  })

  it('wait returns state prompt when the report sits at a permission prompt', async () => {
    const lead = h.create({ label: 'Lead', cli: 'shell', cwd: home })
    const rep = h.spawn(lead.id, { label: 'Worker', cli: 'shell', cwd: home })
    await h.wait(lead.id, rep.id, 2000, 20000)
    await h.type(lead.id, rep.id, "printf '\\n△ Permission required\\nAccess external directory ~/.holon\\nAllow once  Allow always  Reject\\n'; read -n 1 k")
    const r = await h.wait(lead.id, rep.id, 1500)
    expect(r).toMatchObject({ state: 'prompt' })
    expect(r.prompt).toContain('Permission required')
    expect(r.prompt).toContain('Allow once  Allow always  Reject')
  })

  it('wait never reports a prompt on an exited terminal, even if its frozen screen shows one', async () => {
    const lead = h.create({ label: 'Lead', cli: 'shell', cwd: home })
    const rep = h.spawn(lead.id, { label: 'Worker', cli: 'shell', cwd: home })
    await h.wait(lead.id, rep.id, 2000, 20000)
    await h.type(lead.id, rep.id, "printf '\\n△ Permission required\\nAccess external directory ~/.holon\\nAllow once  Allow always  Reject\\n'; exit")
    const r = await h.wait(lead.id, rep.id, 1500, 20_000)
    expect(r.state).toBe('exited')
    expect(r.prompt).toBeUndefined()
    expect(r.screen).toContain('Permission required')
  })

  it('kill_report refuses a report under 5 minutes old, unless forced', () => {
    const lead = h.create({ label: 'Lead', cli: 'shell', cwd: home })
    const rep = h.spawn(lead.id, { label: 'New', cli: 'shell', cwd: home })
    expect(() => h.killReport(lead.id, rep.id, 'done and merged')).toThrow(/only .* min old/)
    h.killReport(lead.id, rep.id, 'done and merged', true)
    expect(h.list().some(n => n.id === rep.id)).toBe(false)
  })

  it('kill_report needs a reason, and the kill action keeps it', () => {
    const lead = h.create({ label: 'Lead', cli: 'shell', cwd: home })
    const rep = h.spawn(lead.id, { label: 'Worker', cli: 'shell', cwd: home })
    expect(() => h.killReport(lead.id, rep.id, '   ')).toThrow(/kill_report needs a reason/)
    expect(h.recentActions().some(a => a.action === 'kill')).toBe(false)
    h.killReport(lead.id, rep.id, 'done and merged', true)
    const kills = h.recentActions().filter(a => a.action === 'kill')
    expect(kills).toHaveLength(1)
    expect(kills[0].args.reason).toBe('done and merged')
    const logged = readFileSync(join(home, 'actions.jsonl'), 'utf8').trim().split('\n').map(l => JSON.parse(l)).filter(a => a.action === 'kill')
    expect(logged).toHaveLength(1)
    expect(logged[0].args.reason).toBe('done and merged')
    expect(logged[0].args.label).toBe('Worker')
  })

  it('refuses to let a terminal drive anything but its own reports', async () => {
    const a = h.create({ label: 'A', cli: 'shell', cwd: home })
    const b = h.create({ label: 'B', cli: 'shell', cwd: home })
    const grandchild = h.create({ label: 'C', cli: 'shell', cwd: home, parentId: h.create({ label: 'Mid', cli: 'shell', cwd: home, parentId: a.id }).id })
    await expect(h.type(a.id, b.id, 'echo nope')).rejects.toThrow(/not your report/)
    expect(() => h.press(a.id, grandchild.id, 'Enter')).toThrow(/not your report/)
  })

  it('spawn creates the new terminal as a report of the caller', () => {
    const lead = h.create({ label: 'Lead', cli: 'shell', cwd: home })
    const rep = h.spawn(lead.id, { label: 'New', cli: 'shell', cwd: home })
    expect(rep.parentId).toBe(lead.id)
  })

  it('kill removes a terminal and its whole sub-org', () => {
    const lead = h.create({ label: 'Lead', cli: 'shell', cwd: home })
    h.spawn(h.spawn(lead.id, { label: 'Mid', cli: 'shell', cwd: home }).id, { label: 'Leaf', cli: 'shell', cwd: home })
    h.kill(lead.id)
    expect(h.list()).toEqual([])
  })
})

describe('permissions', () => {
  it('skips permission prompts for leads by default, not for reports, and either can override', () => {
    const lead = h.create({ label: 'Lead', cli: 'shell', cwd: home, lead: true })
    const rep = h.create({ label: 'Rep', cli: 'shell', cwd: home, parentId: lead.id })
    const careful = h.create({ label: 'Careful', cli: 'shell', cwd: home, lead: true, yolo: false })
    const wild = h.create({ label: 'Wild', cli: 'shell', cwd: home, parentId: lead.id, yolo: true })
    expect([lead.yolo, rep.yolo, careful.yolo, wild.yolo]).toEqual([true, false, false, true])
  })
})

describe('escalation', () => {
  it('a top-level lead asks the human without blocking, and the answer is typed in later', async () => {
    const lead = h.create({ label: 'Lead', cli: 'shell', cwd: home })
    const typed: string[] = []
    vi.spyOn(Terminal.prototype, 'type').mockImplementation(async (text: string) => { typed.push(text) })
    const asked = await h.escalate(lead.id, 'JSON or CSV?')
    expect(asked).toContain('Asked the human')
    const [esc] = h.listEscalations()
    expect(esc).toMatchObject({ from: lead.id, to: null, status: 'open', message: 'JSON or CSV?' })
    expect(() => h.answer(lead.id, esc.id, 'mine')).toThrow(/not sent to you/)
    h.answer(null, esc.id, 'yes')
    expect(typed.join('\n')).toContain('Answer to your escalation')
    expect(typed.join('\n')).toContain('yes')
    expect(h.listEscalations()[0]).toMatchObject({ status: 'answered', answer: 'yes', answeredBy: null })
  })

  it("a sub-lead's escalation is typed into its lead's terminal, and the lead answers it", async () => {
    const top = h.create({ label: 'Top', cli: 'shell', cwd: home })
    const sub = h.create({ label: 'Sub', cli: 'shell', cwd: home, parentId: top.id })
    await h.wait(null, top.id, 2000, 20000)
    const pending = h.escalate(sub.id, 'which port?')
    await h.wait(null, top.id, 1000)
    const [esc] = h.listEscalations()
    expect(esc.to).toBe(top.id)
    expect(h.readScreen(null, top.id, 20).text).toContain(`Escalation ${esc.id} from your report "Sub"`)
    h.answer(top.id, esc.id, '8080')
    expect(await pending).toBe('8080')
  })

  it('an escalation to your lead still blocks until it answers', async () => {
    const lead = h.create({ label: 'Lead', cli: 'shell', cwd: home })
    const rep = h.create({ label: 'Rep', cli: 'shell', cwd: home, parentId: lead.id })
    vi.spyOn(Terminal.prototype, 'type').mockImplementation(async () => {})
    let settled = false
    const pending = h.escalate(rep.id, 'which port?').then(a => { settled = true; return a })
    await new Promise(r => setTimeout(r, 50))
    expect(settled).toBe(false)
    const [esc] = h.listEscalations()
    expect(esc.to).toBe(lead.id)
    h.answer(lead.id, esc.id, 'ok')
    expect(await pending).toBe('ok')
  })

  it("a new Director's brief says how to delegate, not just what to build", async () => {
    const ws = join(home, 'ws'); mkdirSync(ws)
    const typed: string[] = []
    vi.spyOn(Terminal.prototype, 'type').mockImplementation(async (text: string) => { typed.push(text) })
    await h.startDirective('Make tidyboard great.', ws)
    const brief = typed.join('\n')
    expect(brief).toContain('Delegate ruthlessly.')
    expect(brief).toContain('more than about three tool calls')
    vi.restoreAllMocks()
  })

  it('a lead escalation that times out keeps the escalation open, and a late answer is typed in', async () => {
    const lead = h.create({ label: 'Lead', cli: 'shell', cwd: home })
    const rep = h.create({ label: 'Rep', cli: 'shell', cwd: home, parentId: lead.id })
    const typed: string[] = []
    vi.spyOn(Terminal.prototype, 'type').mockImplementation(async (text: string) => { typed.push(text) })
    const r = await h.escalate(rep.id, 'which port?', 50)
    expect(r).toContain('no answer before timeout')
    const [esc] = h.listEscalations()
    expect(esc).toMatchObject({ to: lead.id, status: 'open' })
    h.answer(lead.id, esc.id, 'late')
    expect(typed.join('\n')).toContain('Answer to your escalation')
    expect(typed.join('\n')).toContain('late')
    expect(h.listEscalations()[0]).toMatchObject({ status: 'answered', answer: 'late' })
  })

  it('node views carry a headline from bullet lines on screen', async () => {
    const t = h.create({ label: 'T', cli: 'shell', cwd: home })
    await h.wait(null, t.id, 2000, 20000)
    await h.type(null, t.id, "printf '● Ran node --test\\n'")
    await h.wait(null, t.id, 1000)
    expect(h.list()[0].headline).toBe('Ran node --test')
  })
})

describe('org limits, goals and status', () => {
  it('caps reports per lead and org depth', () => {
    const top = h.create({ label: 'Top', cli: 'shell', cwd: home })
    for (let i = 0; i < 5; i++) h.spawn(top.id, { label: `R${i}`, cli: 'shell', cwd: home })
    expect(() => h.spawn(top.id, { label: 'R6', cli: 'shell', cwd: home })).toThrow(/already have 5 reports/)
    const d1 = h.listReports(top.id)[0]
    const d2 = h.spawn(d1.id, { label: 'D2', cli: 'shell', cwd: home })
    const d3 = h.spawn(d2.id, { label: 'D3', cli: 'shell', cwd: home })
    expect(() => h.spawn(d3.id, { label: 'D4', cli: 'shell', cwd: home })).toThrow(/depth limit/)
  })

  it('only the top of the org sets goals; anyone posts a status', () => {
    const top = h.create({ label: 'Top', cli: 'shell', cwd: home })
    const sub = h.create({ label: 'Sub', cli: 'shell', cwd: home, parentId: top.id })
    expect(() => h.setGoals(top.id, ['x'])).toThrow(/no directive/)
    ;(h as any).directive = { text: 't', workspace: home, directorId: top.id, goals: [], startedAt: '' }
    h.setGoals(top.id, ['ship v1'])
    expect(h.getDirective()?.goals).toEqual(['ship v1'])
    expect(() => h.setGoals(sub.id, ['mine'])).toThrow(/only the top/)
    h.setStatus(sub.id, 'writing tests')
    expect(h.list().find(n => n.id === sub.id)?.status).toBe('writing tests')
  })
})

describe('deliverables and completion', () => {
  const setup = () => {
    const dir = h.create({ label: 'Director', cli: 'shell', cwd: home })
    const rep = h.create({ label: 'Rep', cli: 'shell', cwd: home, parentId: dir.id })
    ;(h as any).directive = { text: 't', workspace: home, directorId: dir.id, goals: [], deliverables: [], status: 'running', startedAt: '' }
    return { dir, rep }
  }

  it('only the Director delivers; re-delivering a label replaces it', () => {
    const { dir, rep } = setup()
    h.deliver(dir.id, { label: 'Site', kind: 'url', value: 'http://localhost:1' })
    h.deliver(dir.id, { label: 'Site', kind: 'url', value: 'http://localhost:2' })
    expect(h.getDirective()!.deliverables.map(d => d.value)).toEqual(['http://localhost:2'])
    expect(() => h.deliver(rep.id, { label: 'x', kind: 'file', value: '/x' })).toThrow(/only the top of the org/)
  })

  it('complete shuts down the sub-org but keeps the Director; asking reopens it', async () => {
    const { dir } = setup()
    h.complete(dir.id, 'all done')
    expect(h.getDirective()).toMatchObject({ status: 'complete', summary: 'all done' })
    expect(h.list().map(n => n.id)).toEqual([dir.id])
    await h.wait(null, dir.id, 1500, 20000)
    await h.askDirector('one more thing')
    expect(h.getDirective()!.status).toBe('running')
    await seen(h, dir.id, /From the human \(m-[0-9a-f]{4}\): one more thing/)
  })
})

describe('owner message notes', () => {
  it('noteMessage records what was done and its status, redacting secrets', () => {
    const dir = h.create({ label: 'Director', cli: 'shell', cwd: home })
    ;(h as any).directive = { text: 't', workspace: home, directorId: dir.id, goals: [], deliverables: [], status: 'running', startedAt: '', messages: [] }
    ;(h as any).directive.messages.push({ id: 'm-ab12', ts: new Date().toISOString(), text: 'add the inbox filter', status: 'new' })
    const m = h.noteMessage(null, 'm-ab12', 'done', 'shipped in abc123 with sk-test_ABCDEFGHIJKLMNOP')
    expect(m.status).toBe('done')
    expect(m.actions![0].text).toContain('shipped')
    expect(m.actions![0].text).not.toContain('sk-test_ABCDEFGHIJKLMNOP')
    expect(() => h.noteMessage(null, 'm-nope', 'done', 'x')).toThrow(/no owner message/)
  })

  it('note_message is for leads and the human only, and rejects unknown statuses', () => {
    const dir = h.create({ label: 'Director', cli: 'shell', cwd: home })
    const lead = h.create({ label: 'Lead', cli: 'shell', cwd: home, lead: true, parentId: dir.id })
    const rep = h.create({ label: 'Builder', cli: 'shell', cwd: home, parentId: lead.id })
    ;(h as any).directive = { text: 't', workspace: home, directorId: dir.id, goals: [], deliverables: [], status: 'running', startedAt: '', messages: [] }
    ;(h as any).directive.messages.push({ id: 'm-ab12', ts: new Date().toISOString(), text: 'add the inbox filter', status: 'new' })
    expect(() => h.noteMessage(rep.id, 'm-ab12', 'done', 'shipped')).toThrow(/only a lead/)
    expect(() => h.noteMessage(lead.id, 'm-ab12', 'bogus' as any, 'shipped')).toThrow(/unknown status/)
    expect(h.noteMessage(lead.id, 'm-ab12', 'doing', 'on it').status).toBe('doing')
    expect(h.noteMessage(null, 'm-ab12', 'done', 'shipped').status).toBe('done')
  })
})

it('a new directive can start once the previous one is complete', async () => {
  const old = h.create({ label: 'Director', cli: 'shell', cwd: home })
  ;(h as any).directive = { text: 't', workspace: home, directorId: old.id, goals: [], deliverables: [], status: 'running', startedAt: '' }
  await expect(h.startDirective('next', home)).rejects.toThrow(/already running/)
  h.complete(old.id, 'done')
  // startDirective launches a real claude; only check that the old Director was retired.
  const started = h.startDirective('next', join(home, 'next')).catch(() => {})
  expect(h.list().some(n => n.id === old.id)).toBe(false)
  h.shutdown(); await started
})

describe('durability and heartbeat', () => {
  it('restores the org from disk with the same ids, tree and claude session ids', async () => {
    const top = h.create({ label: 'Top', cli: 'shell', cwd: home })
    h.create({ label: 'Sub', cli: 'shell', cwd: home, parentId: top.id })
    const before = h.list().map(n => [n.id, n.parentId])
    h.shutdown()
    const again = new Holon({ home, socketPath: join(home, 'holon.sock'), mcpEntry: '/dev/null' })
    expect(await again.restore()).toBe(2)
    expect(again.list().map(n => [n.id, n.parentId])).toEqual(before)
    again.shutdown()
  })

  it('re-types the last task into a non-claude builder after a daemon restart', async () => {
    const lead = h.create({ label: 'Lead', cli: 'shell', cwd: home, lead: true })
    const rep = h.create({ label: 'Builder', cli: 'opencode', cwd: home, parentId: lead.id })
    const task = `TASK-MARKER ${'implement the thing carefully. '.repeat(8)}`
    expect(task.length).toBeGreaterThanOrEqual(200)
    await h.type(lead.id, rep.id, task)
    // the seat keeps the brief, and so does the disk
    expect(h.list().find(n => n.id === rep.id)?.brief).toContain('TASK-MARKER')
    const saved = JSON.parse(readFileSync(join(home, 'org.json'), 'utf8'))
    expect(saved.find((n: { id: string }) => n.id === rep.id).brief).toContain('TASK-MARKER')
    // a short nudge is not a brief: it must not overwrite the task
    await h.type(lead.id, rep.id, 'any progress yet?')
    expect(h.list().find(n => n.id === rep.id)?.brief).toContain('TASK-MARKER')
    h.shutdown()
    // a restarted daemon hands the builder its task again instead of a blank screen
    const again = new Holon({ home, socketPath: join(home, 'holon.sock'), mcpEntry: '/dev/null' })
    const typed: string[] = []
    vi.spyOn(Terminal.prototype, 'type').mockImplementation(async (text: string) => { typed.push(text) })
    expect(await again.restore()).toBe(2)
    expect(typed.some(t => t.includes('daemon restarted') && t.includes('TASK-MARKER'))).toBe(true)
    again.shutdown()
  })

  it('claude terminals get a session id, and resume it when restored', async () => {
    const { launchFor } = await import('../src/adapters.ts')
    const ctx = { id: 'x', cwd: home, home, socketPath: 's', mcpEntry: 'm', lead: false, yolo: false, sessionId: 'abc' }
    expect(launchFor('claude', ctx).args).toEqual(expect.arrayContaining(['--session-id', 'abc']))
    expect(launchFor('claude', { ...ctx, resume: true }).args).toEqual(expect.arrayContaining(['--resume', 'abc']))
  })

  it('nudges the Director only after the whole org has been idle for the heartbeat period', async () => {
    const dir = h.create({ label: 'Director', cli: 'shell', cwd: home })
    ;(h as any).directive = { text: 't', workspace: home, directorId: dir.id, goals: [], deliverables: [], status: 'complete', startedAt: '', heartbeatMin: 10 }
    await h.wait(null, dir.id, 1500, 20000)
    const t0 = Date.now()
    expect(h.beat(t0)).toBe(false)                 // idle clock starts
    expect(h.beat(t0 + 9 * 60_000)).toBe(false)    // not yet
    expect(h.beat(t0 + 11 * 60_000)).toBe(true)    // nudged, and the directive reopens
    expect(h.getDirective()!.status).toBe('running')
    expect(h.beat(t0 + 12 * 60_000)).toBe(false)   // no second beat inside the period
  })

  it('backs the heartbeat off while nothing ships, and resets it when something merges', async () => {
    const dir = h.create({ label: 'Director', cli: 'shell', cwd: home })
    ;(h as any).directive = { text: 't', workspace: home, directorId: dir.id, goals: [], deliverables: [], status: 'running', startedAt: '', heartbeatMin: 10 }
    await h.wait(null, dir.id, 1500, 20000)
    const t0 = Date.now(), min = 60_000
    h.beat(t0)
    expect(h.beat(t0 + 10 * min)).toBe(true)     // first beat after 10 idle minutes
    expect(h.beat(t0 + 25 * min)).toBe(false)    // nothing shipped: the next waits 20, not 10
    expect(h.beat(t0 + 31 * min)).toBe(true)
    ;(h as any).recent.push({ ts: new Date(t0 + 32 * min).toISOString(), caller: dir.id, target: null, action: 'complete', args: {} })
    expect(h.beat(t0 + 65 * min)).toBe(false)    // then 40: the Director answering with complete is not progress
    expect(h.beat(t0 + 72 * min)).toBe(true)
    ;(h as any).recent.push({ ts: new Date(t0 + 80 * min).toISOString(), caller: dir.id, target: null, action: 'merged', args: {} })
    expect(h.beat(t0 + 83 * min)).toBe(true)     // a merge since the last beat: back to 10
  })

  it('caps the heartbeat backoff at an hour while goals are unmet, and asks for staff', async () => {
    const dir = h.create({ label: 'Director', cli: 'shell', cwd: home })
    ;(h as any).directive = { text: 't', workspace: home, directorId: dir.id, goals: ['g1', 'g2'], deliverables: [], status: 'running', startedAt: '', heartbeatMin: 10 }
    await h.wait(null, dir.id, 1500, 20000)
    const typed: string[] = []
    vi.spyOn(Terminal.prototype, 'type').mockImplementation(async (text: string) => { typed.push(text) })
    const t0 = Date.now(), min = 60_000
    h.beat(t0)
    let at = 10
    expect(h.beat(t0 + at * min)).toBe(true)
    expect(typed.at(-1)).toContain('unmet goals and no one working')   // no back-off gate: asked from the first beat
    for (const wait of [20, 40, 60, 60]) {                 // doubles, then holds at 60
      expect(h.beat(t0 + (at + wait - 1) * min)).toBe(false)
      at += wait
      expect(h.beat(t0 + at * min)).toBe(true)
    }
    expect(typed.at(-1)).toContain('unmet goals and no one working')
    // every goal waits on the human: the old 6 hour backoff applies
    ;(h as any).escalations = [{ id: 'e1', from: dir.id, to: null, message: 'a', status: 'open', ts: '' }, { id: 'e2', from: dir.id, to: null, message: 'b', status: 'open', ts: '' }]
    expect(h.beat(t0 + (at + 61) * min)).toBe(false)
  })

  it('asks for staff on a surplus beat with unmet goals and an idle org, and counts only open asks, naming them', async () => {
    const dir = h.create({ label: 'Director', cli: 'shell', cwd: home })
    ;(h as any).directive = { text: 't', workspace: home, directorId: dir.id, goals: ['g1', 'g2', 'g3'], deliverables: [], status: 'running', startedAt: '', heartbeatMin: 10 }
    await h.wait(null, dir.id, 1500, 20000)
    const t0 = Date.now(), min = 60_000
    writeFileSync(join(rootOf(home), 'claude-plan.json'), JSON.stringify({ plan: { bars: [{ label: 'week', usedPct: 60, resetsAt: new Date(t0 + 11 * 3600_000).toISOString() }] } }))
    ;(h as any).escalations = [
      { id: 'esc-open', from: dir.id, to: null, message: 'a', status: 'open', blocks: 'G1 pay requests 0', ts: '' },
      { id: 'esc-done', from: dir.id, to: null, message: 'b', status: 'answered', answer: 'done', ts: '' }]
    const typed: string[] = []
    vi.spyOn(Terminal.prototype, 'type').mockImplementation(async (text: string) => { typed.push(text) })
    h.beat(t0)
    for (let i = 1; i <= 3; i++) {                                  // surplus keeps the wait at 10 min
      expect(h.beat(t0 + i * 10 * min)).toBe(true)
      const last = typed.at(-1)!
      expect(last).toContain('of the Claude week is unused')
      expect(last).toContain('unmet goals and no one working')
      expect(last).toContain('1 question(s) are still waiting on the human (esc-open blocks: G1 pay requests 0)')
      expect(last).not.toContain('esc-done')
    }
  })

  it('counts an unmerged report branch as progress and tells the head to merge it', async () => {
    const repo = join(home, 'repo')
    mkdirSync(repo)
    const sh = (cwd: string, cmd: string) => execSync(cmd, { cwd, stdio: 'ignore', env: { PATH: process.env.PATH!, HOME: home, GIT_CONFIG_GLOBAL: '/dev/null' } })
    sh(repo, 'git init -q -b main && git -c user.name=t -c user.email=t@t commit -q --allow-empty -m init')
    const dir = h.create({ label: 'Director', cli: 'shell', cwd: repo })
    const rep = h.create({ label: 'Worker', cli: 'shell', cwd: repo, parentId: dir.id, worktree: true })
    sh(rep.worktree!.path, 'git -c user.name=t -c user.email=t@t commit -q --allow-empty -m work')
    ;(h as any).directive = { text: 't', workspace: repo, directorId: dir.id, goals: [], deliverables: [], status: 'running', startedAt: '', heartbeatMin: 10 }
    await h.wait(null, dir.id, 1500, 20000)
    const typed: string[] = []
    vi.spyOn(Terminal.prototype, 'type').mockImplementation(async (text: string) => { typed.push(text) })
    const t0 = Date.now(), min = 60_000
    h.beat(t0)
    expect(h.beat(t0 + 10 * min)).toBe(true)
    expect(typed.at(-1)).toContain(rep.worktree!.branch)
    expect(typed.at(-1)).toContain('Merge or gate')
    expect(h.beat(t0 + 20 * min)).toBe(false)  // same head as the last beat: backs off, wait is now 20
    sh(rep.worktree!.path, 'git -c user.name=t -c user.email=t@t commit -q --allow-empty -m more')
    expect(h.beat(t0 + 21 * min)).toBe(true)   // a new head is progress: back to 10
  })

  it('doubles the wait over 3 beats while the same unmerged head sits there', async () => {
    const repo = join(home, 'repo')
    mkdirSync(repo)
    const sh = (cwd: string, cmd: string) => execSync(cmd, { cwd, stdio: 'ignore', env: { PATH: process.env.PATH!, HOME: home, GIT_CONFIG_GLOBAL: '/dev/null' } })
    sh(repo, 'git init -q -b main && git -c user.name=t -c user.email=t@t commit -q --allow-empty -m init')
    const dir = h.create({ label: 'Director', cli: 'shell', cwd: repo })
    const rep = h.create({ label: 'Worker', cli: 'shell', cwd: repo, parentId: dir.id, worktree: true })
    sh(rep.worktree!.path, 'git -c user.name=t -c user.email=t@t commit -q --allow-empty -m work')
    ;(h as any).directive = { text: 't', workspace: repo, directorId: dir.id, goals: [], deliverables: [], status: 'running', startedAt: '', heartbeatMin: 10 }
    await h.wait(null, dir.id, 1500, 20000)
    const typed: string[] = []
    vi.spyOn(Terminal.prototype, 'type').mockImplementation(async (text: string) => { typed.push(text) })
    const t0 = Date.now(), min = 60_000
    h.beat(t0)
    expect(h.beat(t0 + 10 * min)).toBe(true)    // beat 1: first sight of the head
    expect(h.beat(t0 + 19 * min)).toBe(false)
    expect(h.beat(t0 + 30 * min)).toBe(true)    // beat 2 after 20
    expect(h.beat(t0 + 59 * min)).toBe(false)
    expect(h.beat(t0 + 70 * min)).toBe(true)    // beat 3 after 40
    expect(typed.at(-1)).toContain(rep.worktree!.branch)   // the nudge still names the branch
  })

  it('keeps beating at full pace while unused Claude week is about to be lost, and says so', async () => {
    const dir = h.create({ label: 'Director', cli: 'shell', cwd: home })
    ;(h as any).directive = { text: 't', workspace: home, directorId: dir.id, goals: [], deliverables: [], status: 'running', startedAt: '', heartbeatMin: 10 }
    await h.wait(null, dir.id, 1500, 20000)
    const t0 = Date.now(), min = 60_000
    writeFileSync(join(home, 'claude-plan.json'), JSON.stringify({ plan: { provider: 'Claude', bars: [{ label: 'week', usedPct: 34, resetsAt: new Date(t0 + 24 * 60 * min).toISOString() }], checkedAt: '' }, at: t0 }))
    const typed: string[] = []
    vi.spyOn(Terminal.prototype, 'type').mockImplementation(async (text: string) => { typed.push(text) })
    h.beat(t0)
    expect(h.beat(t0 + 10 * min)).toBe(true)
    expect(h.beat(t0 + 20 * min)).toBe(true)     // nothing shipped, but no back-off: the quota is use-it-or-lose-it
    expect(typed.at(-1)).toContain('66% of the Claude week is unused')
  })
})

