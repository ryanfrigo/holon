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

const wall = async (id: string) => {
  await h.wait(null, id, 2000, 20000)
  await h.type(null, id, "printf 'You have hit your usage limit.\\n'")
  await h.wait(null, id, 1000)
}

// Logged 2026-10-30T20:00:13Z: "heal failed: Error: no terminal "metering-8a89"" at reseat → view,
// 49 ms after its lead killed the seat that heal was dropping a grade.
it('a lead killing a seat while heal reseats it does not abort the heal pass', async () => {
  const a = h.create({ label: 'A', cli: 'claude', cwd: home, grade: 2 })
  const b = h.create({ label: 'B', cli: 'claude', cwd: home, grade: 2 })
  await wall(a.id)
  await wall(b.id)
  const clear = (h as any).clearStartup.bind(h)
  ;(h as any).clearStartup = async (id: string) => {
    await clear(id)
    if (id === a.id) h.kill(a.id)   // the lead closes the seat while its new process boots
  }
  const acted = await h.heal(Date.now() + 30_000, false)
  expect(h.list().map(n => n.id)).toEqual([b.id])
  expect(acted.map(x => x.id)).toContain(b.id)   // the pass went on to the next seat
  expect(h.list()[0]).toMatchObject({ grade: 1, gradeFrom: 2 })
}, 30_000)
