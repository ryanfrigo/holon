import { afterEach, beforeEach, expect, it } from 'vitest'
import { execFileSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type net from 'node:net'
import { Holon } from '../src/holon.ts'
import { serve } from '../src/server.ts'
import { waitForMerges } from '../src/ship.ts'

let home: string
let h: Holon
let server: net.Server | undefined
beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), 'holon-'))
  h = new Holon({ home, socketPath: join(home, 'holon.sock'), mcpEntry: '/dev/null' })
})
afterEach(() => { server?.close(); server = undefined; h.shutdown() })

const sock = (home: string) => join(home, 'holon.sock')

it('counts a merge as running from the moment it is queued until it lands or is refused', async () => {
  const dir = join(home, 'repo')
  const git = (cwd: string, ...a: string[]) => execFileSync('git', ['-C', cwd, ...a], { encoding: 'utf8' })
  mkdirSync(dir); git(dir, 'init', '-q', '-b', 'main')
  git(dir, 'config', 'user.email', 't@t'); git(dir, 'config', 'user.name', 't')
  writeFileSync(join(dir, 'README'), 'x\n'); git(dir, 'add', '.'); git(dir, 'commit', '-qm', 'init')
  const lead = h.create({ label: 'Lead', cli: 'claude', cwd: dir, lead: true })
  const b = h.spawn(lead.id, { label: 'Builder', cli: 'claude', cwd: dir, grade: 0, worktree: true, check: 'sleep 1' })
  writeFileSync(join(b.cwd, 'app.ts'), 'export {}\n')
  git(b.cwd, 'add', '.'); git(b.cwd, 'commit', '-qm', 'work')
  expect(h.merging()).toBe(0)
  const merge = h.mergeReport(lead.id, b.id)
  expect(h.merging()).toBe(1)
  expect((await merge).merged).toBe(true)
  expect(h.merging()).toBe(0)
})

it('a ship waits until no org has a merge running', async () => {
  server = await serve(h, sock(home))
  ;(h as any).mergesInFlight = 1
  setTimeout(() => { (h as any).mergesInFlight = 0 }, 400)
  const t = Date.now()
  expect(await waitForMerges([home], { pollMs: 50, timeoutMs: 5000, socketOf: sock })).toEqual([])
  expect(Date.now() - t).toBeGreaterThanOrEqual(350)
})

it('gives up after its bound and names the orgs still merging', async () => {
  server = await serve(h, sock(home))
  ;(h as any).mergesInFlight = 1
  const waits: string[][] = []
  expect(await waitForMerges([home], { pollMs: 50, timeoutMs: 300, socketOf: sock, onWait: b => waits.push(b) })).toEqual([home])
  expect(waits[0]).toEqual([home])
})

it('a daemon that is down or predates the merging call does not hold a ship', async () => {
  const gone = mkdtempSync(join(tmpdir(), 'holon-'))
  expect(await waitForMerges([gone], { pollMs: 50, timeoutMs: 1000, socketOf: sock })).toEqual([])
})
