import { afterEach, beforeEach, expect, it } from 'vitest'
import { mkdirSync, mkdtempSync } from 'node:fs'
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

// The KB belongs to the project a directive runs in; open one without starting any terminal.
function openKb(workspace: string) {
  mkdirSync(workspace, { recursive: true })
  ;(h as any).directive = { text: 't', workspace, directorId: 'd', goals: [], deliverables: [], status: 'running', startedAt: '' }
  ;(h as any).openKb(workspace)
}

it('an agent read is counted and shows in kbList', () => {
  openKb(join(home, 'ws'))
  h.kbWrite(null, 'fact', 'One fact', 'Body.')
  const path = h.kbList()[0].path
  const agent = h.create({ label: 'Engineering', cli: 'shell', cwd: home })

  const read = h.kbRead(agent.id, path)
  expect(read.reads).toBe(1)
  expect(read.readBy).toEqual({ Engineering: 1 })
  expect(read.lastRead).not.toBe('')

  const list = h.kbList()
  expect(list[0].reads).toBe(1)
  expect(list[0].lastRead).toBe(read.lastRead)
})

it('the owner browsing the KB does not count as a read', () => {
  openKb(join(home, 'ws'))
  h.kbWrite(null, 'fact', 'One fact', 'Body.')
  const path = h.kbList()[0].path

  h.kbRead(null, path)
  const list = h.kbList()
  expect(list[0].reads).toBe(0)
  expect(list[0].lastRead).toBe('')
})

it('a shared entry counts under its full path', () => {
  openKb(join(home, 'ws'))
  const agent = h.create({ label: 'Engineering', cli: 'shell', cwd: home })
  const { path } = h.kbWrite(agent.id, 'lesson', 'Cold email needs SPF', 'Set all three.', true)
  expect(path.startsWith('shared:')).toBe(true)

  h.kbRead(agent.id, path)
  const found = h.kbSearch('SPF')[0]
  expect(found.path).toBe(path)
  expect(found.reads).toBe(1)
  expect(found.lastRead).not.toBe('')
})

it('the count survives a new Holon on the same home', () => {
  openKb(join(home, 'ws'))
  h.kbWrite(null, 'fact', 'One fact', 'Body.')
  const path = h.kbList()[0].path
  const agent = h.create({ label: 'QA', cli: 'shell', cwd: home })
  h.kbRead(agent.id, path)
  h.shutdown()

  const again = new Holon({ home, socketPath: join(home, 'holon.sock'), mcpEntry: '/dev/null' })
  const workspace = join(home, 'ws')
  ;(again as any).directive = { text: 't', workspace, directorId: 'd', goals: [], deliverables: [], status: 'running', startedAt: '' }
  ;(again as any).openKb(workspace)
  const list = again.kbList()
  expect(list[0].reads).toBe(1)
  expect(list[0].lastRead).not.toBe('')
  again.shutdown()
})
