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

// world and acme, 10-27/28: G0 builders hit "Go usage limit exceeded" at launch and were killed
// 12-22 s later, before heal could see the wall; every respawn walled the same way.
it('a lead killing a seat that walled at launch marks its pool out, so the next G0 spawn reroutes', async () => {
  const eng = h.create({ label: 'Eng', cli: 'opencode', cwd: home, grade: 0 })
  await h.wait(null, eng.id, 2000, 20000)
  await h.type(null, eng.id, "printf 'Error: Go usage limit exceeded\\n'")
  await h.wait(null, eng.id, 500)
  h.killReport(null, eng.id, 'Go usage limit at launch; no work started')
  const until = (h as any).quotaOutUntil.opencode as number
  expect(until).toBeGreaterThan(Date.now())
  expect(h.recentActions().find(a => a.action === 'quota_wall')?.args).toMatchObject({ cli: 'opencode', via: 'kill' })
  const b = h.spawn(null, { label: 'Builder', cli: 'claude', grade: 0, cwd: home })
  expect(b).toMatchObject({ cli: 'claude', grade: 1 })
  expect(b.reroute).toMatch(/opencode pool out/)
})

it('killing a seat that is merely done marks nothing', async () => {
  const eng = h.create({ label: 'Eng', cli: 'opencode', cwd: home, grade: 0 })
  await h.wait(null, eng.id, 2000, 20000)
  h.killReport(null, eng.id, 'merged')
  expect((h as any).quotaOutUntil.opencode).toBeUndefined()
})
