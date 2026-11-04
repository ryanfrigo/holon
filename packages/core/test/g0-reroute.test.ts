import { afterEach, beforeEach, expect, it } from 'vitest'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Holon } from '../src/holon.ts'
import type { Plan } from '../src/plans.ts'

let home: string
let h: Holon
let plans: Plan[] = []
beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), 'holon-'))
  plans = []
  h = new Holon({ home, socketPath: join(home, 'holon.sock'), mcpEntry: '/dev/null', plans: async () => plans })
})
afterEach(() => h.shutdown())

const later = (h: number) => new Date(Date.now() + h * 3600_000).toISOString()

it('learns which pools are out from the vendors\' own limits, before any seat walls', async () => {
  h.setSettings({ opencodeGo: true })
  plans = [
    { provider: 'OpenCode Go Plus', bars: [{ label: 'weekly limit reached', usedPct: 100, resetsAt: later(96) }], checkedAt: '' },
    { provider: 'Claude', bars: [{ label: '5-hour', usedPct: 3, resetsAt: later(4) }], checkedAt: '' },
    { provider: 'Codex', bars: [{ label: '5-hour', usedPct: 100, resetsAt: later(2) }], checkedAt: '' },
  ]
  await h.refreshPools()
  const out = (h as any).quotaOutUntil
  expect(new Date(out.opencode).toISOString()).toBe(plans[0].bars[0].resetsAt)
  expect(new Date(out.codex).toISOString()).toBe(plans[2].bars[0].resetsAt)
  expect(out.claude).toBeUndefined()
})

it('a G0 builder goes to G1 on Claude while the OpenCode pool is out, instead of walling at once', () => {
  ;(h as any).quotaOutUntil = { opencode: Date.now() + 96 * 3600_000 }
  const b = h.spawn(null, { label: 'Builder', cli: 'claude', grade: 0, cwd: home })
  expect(b).toMatchObject({ cli: 'claude', grade: 1 })
  expect(b.reroute).toMatch(/opencode pool out .*now claude G1/)
  expect(h.recentActions().find(a => a.action === 'quota_route')?.args).toMatchObject({ label: 'Builder', fromCli: 'opencode', toCli: 'claude', grade: 1 })
})

it('takes Codex when Claude is out too, and stays on G0 when OpenCode has room', () => {
  ;(h as any).quotaOutUntil = { opencode: Date.now() + 3600_000, claude: Date.now() + 3600_000 }
  expect(h.spawn(null, { label: 'B1', cli: 'claude', grade: 0, cwd: home })).toMatchObject({ cli: 'codex', grade: 1 })
  ;(h as any).quotaOutUntil = {}
  expect(h.spawn(null, { label: 'B2', cli: 'claude', grade: 0, cwd: home })).toMatchObject({ cli: 'opencode', grade: 0 })
})

// A machine with only some CLIs. HOLON_FAKE_CLIS stays on, so every seat is a plain shell and no real
// agent CLI can start; only the install check is replaced.
const installedOnly = (...clis: string[]) => { ;(h as any).installed = (c: string) => clis.includes(c) }

it('with OpenCode not installed, a G0 builder goes to Claude G1, then Codex, then a clear error', () => {
  installedOnly('claude', 'codex')
  {
    expect(h.spawn(null, { label: 'B1', cli: 'claude', grade: 0, cwd: home })).toMatchObject({ cli: 'claude', grade: 1, reroute: expect.stringMatching(/opencode is not installed, now claude G1/) })
    ;(h as any).quotaOutUntil = { claude: Date.now() + 3600_000 }
    expect(h.spawn(null, { label: 'B2', cli: 'claude', grade: 0, cwd: home })).toMatchObject({ cli: 'codex', grade: 1 })
    installedOnly()
    expect(() => h.spawn(null, { label: 'B3', cli: 'claude', grade: 0, cwd: home })).toThrow(/install Claude Code .*Codex .*OpenCode/)
  }
})

it('the org review does not send leads to free opencode builders when OpenCode is not installed', () => {
  const dir = h.create({ label: 'Director', cli: 'shell', cwd: home, lead: true })
  ;(h as any).directive = { text: 't', workspace: home, directorId: dir.id, goals: [], deliverables: [], status: 'running', startedAt: '' }
  const typed: string[] = []
  ;(h as any).entry(dir.id).term.type = (t: string) => { typed.push(t) }
  installedOnly('claude')
  expect(h.review(Date.now(), 120, true)).toBe(true)
  expect(typed.join('')).toMatch(/OpenCode is not installed/)
  expect(typed.join('')).not.toMatch(/on free cli opencode builders/)
})
