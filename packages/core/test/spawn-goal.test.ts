import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Holon } from '../src/holon.ts'

let home: string
let h: Holon
beforeEach(() => {
  process.env.HOLON_FAKE_CLIS = '1'
  home = mkdtempSync(join(tmpdir(), 'holon-'))
  h = new Holon({ home, socketPath: join(home, 'holon.sock'), mcpEntry: '/dev/null' })
})
afterEach(() => h.shutdown())

const org = () => {
  const dir = h.create({ label: 'Director', cli: 'claude', cwd: home, lead: true })
  ;(h as any).directive = {
    text: 'grow', workspace: home, directorId: dir.id, goals: ['ship the API', 'cut checkout errors'],
    deliverables: [], status: 'running', startedAt: new Date().toISOString(), heartbeatMin: 10,
  }
  return dir
}
const spawn = (d: string, label: string, why?: string, extra: object = {}) =>
  h.spawn(d, { label, cli: 'claude', cwd: home, grade: 2, why, ...extra })

describe('spawn names its goal', () => {
  it('refuses a paid spawn with no goal, or an out-of-range one, and lists the goals', () => {
    const d = org()
    expect(() => spawn(d.id, 'a', 'subtle auth code')).toThrow(/G<n>.*Goals: G1 ship the API; G2 cut checkout errors/)
    expect(() => spawn(d.id, 'a')).toThrow(/free first/)   // no reason at all is caught by free-first
    expect(() => spawn(d.id, 'a', 'G3: nope')).toThrow(/G3 but the directive has 2 goal.*G2 cut checkout errors/)
  })

  it('accepts G<n>, G0 and "no goal:", and stores the goal on the node and in the log', () => {
    const d = org()
    expect((h as any).nodes.get(spawn(d.id, 'a', 'G2: cut checkout errors').id).info.goal).toBe(2)
    expect((h as any).nodes.get(spawn(d.id, 'b', 'G0: docs').id).info.goal).toBe(0)
    expect((h as any).nodes.get(spawn(d.id, 'c', 'No goal: tidy').id).info.goal).toBe(0)
    expect(h.recentActions().find(a => a.action === 'spawn' && a.args.label === 'a')!.args.goal).toBe(2)
  })

  it('does not block free work, the human, or an org with no goals yet', () => {
    const d = org()
    expect(h.spawn(d.id, { label: 'free', cli: 'claude', cwd: home, grade: 0 }).cli).toBe('opencode')
    expect(() => h.spawn(d.id, { label: 'free2', cli: 'claude', cwd: home, grade: 0, why: 'G9: x' })).toThrow(/2 goal/)
    expect(h.spawn(null, { label: 'mine', cli: 'claude', cwd: home, grade: 2 }).grade).toBe(2)
    ;(h as any).directive.goals = []
    expect(spawn(d.id, 'early', 'setting up').label).toBe('early')
  })
})

describe('seat-minutes per goal', () => {
  it('children inherit their lead goal; the heartbeat flags more than 25% on no goal', () => {
    const d = org()
    const lead = spawn(d.id, 'Lead', 'G1: ship the API', { lead: true })
    const kid = h.spawn(lead.id, { label: 'Kid', cli: 'claude', cwd: home, grade: 0 })
    const side = spawn(d.id, 'Audit', 'no goal: security lows')
    const running = new Set([lead.id, kid.id, side.id])
    const orig = h.list.bind(h)
    h.list = () => orig().map(n => running.has(n.id) ? { ...n, state: 'running' as const } : n)
    h.tick(60_000 * 10)
    const m = h.goalMinutes()
    expect(m.byGoal.G1).toBeCloseTo(20)   // lead + kid
    expect(m.noGoal.Audit).toBeCloseTo(10)
    expect(h.goalNote()).toMatch(/33% of seat-minutes \(10 of 30\) went to work tied to no goal: Audit \(10\)\. Put capacity on the goals\./)
  })

  it('stays quiet at or under 25%, outside 24h, and when there are no goals', () => {
    const d = org()
    const hour = (ago: number) => new Date(Math.floor((Date.now() - ago) / 3_600_000) * 3_600_000).toISOString()
    ;(h as any).directive.seatMin = { [hour(0)]: { G1: 75, '-:x': 25 }, [hour(30 * 3_600_000)]: { '-:old': 900 } }
    expect(h.goalNote()).toBe('')
    ;(h as any).directive.seatMin[hour(0)]['-:x'] = 26
    expect(h.goalNote()).toMatch(/26% .*\(26 of 101\).*x \(26\)/)
    ;(h as any).directive.goals = []
    expect(h.goalNote()).toBe('')
    void d
  })
})
