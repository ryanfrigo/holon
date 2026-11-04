import { afterEach, beforeEach, expect, it } from 'vitest'
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

it('the asker can withdraw its own open escalation', async () => {
  const dir = h.create({ label: 'Director', cli: 'shell', cwd: home })
  const rep = h.spawn(dir.id, { label: 'Rep', cli: 'shell', cwd: home })
  void h.escalate(dir.id, 'Need a token', 1000, 'need', { blocks: 'none' })
  const [esc] = h.listEscalations()

  expect(() => h.withdraw(rep.id, esc.id, 'got it myself')).toThrow(/only the asker can withdraw/)

  h.withdraw(dir.id, esc.id, 'found the token')
  const done = h.listEscalations().find(e => e.id === esc.id)!
  expect(done.status).toBe('answered')
  expect(done.answer).toMatch(/^withdrawn by asker/)

  expect(() => h.withdraw(dir.id, esc.id, 'again')).toThrow(/already answered/)
})
