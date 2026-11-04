import { afterEach, beforeEach, expect, it } from 'vitest'
import { mkdtempSync } from 'node:fs'
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

// world security-4b01 (opencode, nowhere to fall back to) was re-reported every 30-45 min.
it('a seat walled on its only pool is reported once, then quiet until the pool is due back', async () => {
  const lead = h.create({ label: 'Lead', cli: 'claude', cwd: home, grade: 2, lead: true })
  const eng = h.create({ label: 'Eng', cli: 'opencode', cwd: home, grade: 0, parentId: lead.id })
  h.setSettings({ quotaFallback: false })   // no paid pool to move to; OpenCode has only the one provider
  await h.wait(null, eng.id, 2000, 20000)
  await h.type(null, eng.id, "printf 'Error: Go usage limit exceeded\\n'")
  await h.wait(null, eng.id, 1000)
  const t0 = Date.now() + 30_000
  const heals = () => h.recentActions().filter(a => a.action === 'heal' && a.target === eng.id)

  await h.heal(t0, false)
  expect(heals()).toHaveLength(1)
  const info = () => h.list().find(n => n.id === eng.id)!
  const until = (h as any).quotaOutUntil.opencode as number
  expect(until).toBeGreaterThan(t0)
  expect((h as any).nodes.get(eng.id).info).toMatchObject({ blocked: expect.any(String), blockedUntil: until })
  await h.wait(null, lead.id, 1000)
  const screen = h.readScreen(null, lead.id).text
  expect(screen).toMatch(/kill it or reassign its task to a pool that is in quota/)

  // The wall message scrolls out of view; later passes, past the 20 min cooldown, stay silent.
  await h.type(null, eng.id, 'for i in $(seq 1 40); do echo line $i; done')
  await h.wait(null, eng.id, 1000)
  await h.heal(t0 + 25 * 60_000, true)
  await h.heal(t0 + 45 * 60_000, true)
  expect(heals()).toHaveLength(1)
  expect((h as any).nodes.get(eng.id).info.blocked).toBeTruthy()

  // Once the pool is due back and the seat shows no wall, it is unblocked.
  await h.heal(until + 1000, false)
  expect((h as any).nodes.get(eng.id).info.blocked).toBeUndefined()
  expect((h as any).nodes.get(eng.id).info.blockedUntil).toBeUndefined()
}, 40_000)
