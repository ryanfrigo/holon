import { afterEach, beforeEach, expect, it } from 'vitest'
import { mkdirSync, mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type net from 'node:net'
import { Holon } from '../src/holon.ts'
import { serve } from '../src/server.ts'
import { HolonClient } from '../src/client.ts'

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

const wait = (ms: number) => new Promise(r => setTimeout(r, ms))

it('kb_list returns every entry, newest first', async () => {
  openKb(join(home, 'ws'))
  h.kbWrite(null, 'decision', 'Pricing is $99', 'Chosen over $150.')
  await wait(5)
  h.kbWrite(null, 'fact', 'Runway is 120 minutes', 'Measured on Oct 21.')
  await wait(5)
  h.kbWrite(null, 'lesson', 'Codex update prompt eats tasks', 'Start it with check_for_update_on_startup=false.')

  const list = h.kbList()
  expect(list).toHaveLength(3)
  expect(list.map(e => e.title)).toEqual([
    'Codex update prompt eats tasks',
    'Runway is 120 minutes',
    'Pricing is $99',
  ])
  expect(list[0]).toMatchObject({ kind: 'lesson', by: 'human' })
  expect(list.map(e => e.path)).toEqual(['lessons/codex-update-prompt-eats-tasks.md', 'facts/runway-is-120-minutes.md', 'decisions/pricing-is-99.md'])
  expect(Object.keys(list[0]).sort()).toEqual(['by', 'kind', 'lastRead', 'path', 'reads', 'title', 'updated'])
})

it('the daemon serves kb_list over the socket', async () => {
  openKb(join(home, 'ws'))
  h.kbWrite(null, 'fact', 'One fact', 'Body.')
  const sock = join(home, 'holon.sock')
  const server: net.Server = await serve(h, sock)
  const client = await HolonClient.connect(sock)
  const list = await client.call('kb_list') as { title: string }[]
  expect(list.map(e => e.title)).toEqual(['One fact'])
  client.close()
  server.close()
})
