import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Holon } from '../src/holon.ts'
import { Terminal } from '../src/terminal.ts'

let home: string
let h: Holon
beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), 'holon-'))
  h = new Holon({ home, socketPath: join(home, 'holon.sock'), mcpEntry: '/dev/null' })
})
afterEach(() => h.shutdown())

const running = (directorId: string) => {
  ;(h as any).directive = { text: 't', workspace: home, directorId, goals: ['g1'], deliverables: [], status: 'running', startedAt: '', shape: 'hierarchy', template: 'departments' }
}

it('asking the Director answers at once: the message is kept even while the typing is still running', async () => {
  const dir = h.create({ label: 'Director', cli: 'claude', cwd: home, lead: true })
  running(dir.id)
  // The Director's terminal never finishes typing.
  vi.spyOn(Terminal.prototype, 'type').mockImplementation(() => new Promise<void>(() => {}))
  const started = Date.now()
  const msg = await h.askDirector('ship the thing')
  expect(Date.now() - started).toBeLessThan(500)
  expect(msg.id).toMatch(/^m-/)
  expect(h.getDirective()!.messages!.map(m => m.text)).toContain('ship the thing')
})
