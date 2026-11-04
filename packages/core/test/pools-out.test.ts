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

const wall = async (id: string) => {
  await h.wait(null, id, 2000, 20000)
  await h.type(null, id, "printf 'You have hit your usage limit.\\n'")
  await h.wait(null, id, 1000)
}

it('pauses the org until the earliest reset when every pool it can use is out, then resumes on its own', async () => {
  const lead = h.create({ label: 'Lead', cli: 'claude', cwd: home, grade: 2 })
  const eng = h.create({ label: 'Eng', cli: 'opencode', cwd: home, grade: 0, parentId: lead.id })
  const now = Date.now() + 30_000
  ;(h as any).quotaOutUntil = { claude: now + 3 * 3600_000, codex: now + 3 * 3600_000 }   // both paid pools are out for 3h
  await wall(eng.id)
  await h.heal(now, false)
  // opencode has no reset time of its own: the retry window (60 min) is the earliest return.
  expect(h.paused).toMatchObject({ until: new Date(now + 60 * 60_000).toISOString() })
  expect(h.paused!.reason).toMatch(/every model pool .* is out/)
  expect(h.list().filter(n => n.cli !== 'shell')).toEqual([])
  expect(h.recentActions().find(a => a.action === 'pools_out')?.args).toMatchObject({ pools: ['claude', 'opencode'] })

  expect(await h.wake(now + 59 * 60_000)).toBe(0)
  expect(h.paused).not.toBeNull()
  expect(await h.wake(now + 61 * 60_000)).toBe(2)
  expect(h.paused).toBeNull()
  expect(h.list().map(n => n.id).sort()).toEqual([lead.id, eng.id].sort())
})

it('uses the vendor reset time from the plan when it has one', async () => {
  const eng = h.create({ label: 'Eng', cli: 'claude', cwd: home, grade: 2 })
  const now = Date.now() + 30_000
  const reset = new Date(now + 2 * 3600_000).toISOString()
  plans = [{ provider: 'Claude', bars: [{ label: '5-hour', usedPct: 100, resetsAt: reset }, { label: 'week', usedPct: 40 }], checkedAt: '' }]
  ;(h as any).quotaOutUntil = { opencode: now + 5 * 3600_000 }
  await wall(eng.id)
  await h.heal(now, false)
  expect(h.paused).toMatchObject({ until: reset })
})

it('keeps working while one pool still has room', async () => {
  const eng = h.create({ label: 'Eng', cli: 'opencode', cwd: home, grade: 0 })
  h.create({ label: 'Lead', cli: 'claude', cwd: home, grade: 2 })
  await wall(eng.id)
  await h.heal(Date.now() + 30_000, false)
  expect(h.paused).toBeNull()
})

it('a manual pause never resumes on its own', async () => {
  h.create({ label: 'Eng', cli: 'opencode', cwd: home, grade: 0 })
  h.pause('owner')
  expect(await h.wake(Date.now() + 365 * 864e5)).toBe(0)
  expect(h.paused).toMatchObject({ reason: 'owner' })
})
