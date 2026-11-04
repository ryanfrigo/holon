import { afterEach, beforeEach, expect, it } from 'vitest'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Holon } from '../src/holon.ts'

// Log shape from a real org on 2026-11-02 17:12-17:37Z: the Director sat in wait() on one report while
// Security's "approved" message (17:37:26) was typed into its terminal and unread until the wait ended.
let home: string
let h: InstanceType<typeof Holon>
beforeEach(() => { home = mkdtempSync(join(tmpdir(), 'holon-')); h = new Holon({ home, socketPath: join(home, 'holon.sock'), mcpEntry: '/dev/null' }) })
afterEach(() => h.shutdown())

it('a lead waiting on one report is woken when another seat messages it', async () => {
  const lead = h.create({ label: 'Director', cli: 'claude', cwd: home, lead: true })
  const busy = h.create({ label: 'Builder', cli: 'claude', cwd: home, parentId: lead.id })
  const sec = h.create({ label: 'Security', cli: 'claude', cwd: home, parentId: lead.id })
  await h.wait(null, busy.id, 2000, 20000)
  await h.type(null, busy.id, 'for i in $(seq 1 400); do echo working $i; sleep 0.2; done')   // a screen that never goes quiet
  const t0 = Date.now()
  const waiting = h.wait(lead.id, busy.id, 3000, 600_000)
  setTimeout(() => { void h.message(sec.id, lead.id, 'Security: sec-batch4-8007 is approved at f3cb5a31.') }, 1500)
  const r = await waiting
  expect(r.state).toBe('message')
  expect(Date.now() - t0).toBeLessThan(10_000)
  expect(h.recentActions().filter(a => a.action === 'wait_done' && a.caller === lead.id).map(a => a.args.state)).toEqual(['message'])
}, 30_000)

it('a message sent before the wait began does not cut it short', async () => {
  const lead = h.create({ label: 'Director', cli: 'claude', cwd: home, lead: true })
  const b = h.create({ label: 'Builder', cli: 'claude', cwd: home, parentId: lead.id })
  await h.wait(null, b.id, 2000, 20000)
  await h.message(null, lead.id, 'owner: hello')
  const r = await h.wait(lead.id, b.id, 1500, 120_000)
  expect(r.state).toBe('quiet')
}, 30_000)
