import { afterEach, beforeEach, expect, it } from 'vitest'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type net from 'node:net'
import { Holon } from '../src/holon.ts'
import { serve } from '../src/server.ts'
import { rollingRestart, waitForQuiet } from '../src/ship.ts'

let home: string
let h: Holon
let server: net.Server | undefined
beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), 'holon-'))
  h = new Holon({ home, socketPath: join(home, 'holon.sock'), mcpEntry: '/dev/null' })
})
afterEach(() => { server?.close(); server = undefined; h.shutdown() })
const sock = (home: string) => join(home, 'holon.sock')

it('busy_seats lists only seats whose screen is changing, and waitForQuiet returns once they settle', async () => {
  server = await serve(h, sock(home))
  let busy: string[] = ['a', 'b']
  ;(h as any).busySeats = () => busy
  setTimeout(() => { busy = [] }, 300)
  const t = Date.now()
  const seen: Record<string, string[]>[] = []
  expect(await waitForQuiet([home], { pollMs: 50, timeoutMs: 5000, socketOf: sock, onWait: b => seen.push(b) })).toEqual({})
  expect(Date.now() - t).toBeGreaterThanOrEqual(250)
  expect(seen).toEqual([{ [home]: ['a', 'b'] }])
})

it('a real idle sh seat is not busy once its screen stops changing', async () => {
  const seat = h.create({ label: 'S', cli: 'shell', cwd: home })
  await new Promise(r => setTimeout(r, 1500))
  expect(h.busySeats()).not.toContain(seat.id)
})

it('waitForQuiet times out and names the busy seats', async () => {
  server = await serve(h, sock(home))
  ;(h as any).busySeats = () => ['x']
  expect(await waitForQuiet([home], { pollMs: 50, timeoutMs: 300, socketOf: sock })).toEqual({ [home]: ['x'] })
})

it('a seat that alternates busy and quiet never counts as quiet; 3 quiet polls in a row do', async () => {
  server = await serve(h, sock(home))
  let n = 0
  ;(h as any).busySeats = () => (n++ % 2 ? [] : ['flicker'])
  expect(await waitForQuiet([home], { pollMs: 20, timeoutMs: 500, socketOf: sock })).toEqual({ [home]: ['flicker'] })
  const seq = [['a'], [], [], ['a'], [], [], []]   // two quiet then busy again: only the final three count
  let i = 0
  ;(h as any).busySeats = () => seq[Math.min(i++, seq.length - 1)]
  expect(await waitForQuiet([home], { pollMs: 20, timeoutMs: 5000, socketOf: sock })).toEqual({})
  expect(i).toBe(7)
})

it('a down daemon does not hold the wait', async () => {
  const gone = mkdtempSync(join(tmpdir(), 'holon-'))
  expect(await waitForQuiet([gone], { pollMs: 50, timeoutMs: 1000, socketOf: sock })).toEqual({})
})

it('restarts orgs one at a time, each only after its own quiet wait and the previous org is back', async () => {
  const homes = [mkdtempSync(join(tmpdir(), 'holon-')), mkdtempSync(join(tmpdir(), 'holon-'))]
  const hs = homes.map(x => new Holon({ home: x, socketPath: sock(x), mcpEntry: '/dev/null' }))
  const servers = await Promise.all(hs.map((x, i) => serve(x, sock(homes[i]))))
  const log: string[] = []
  ;(hs[0] as any).busySeats = () => { log.push('poll0'); return log.includes('restart0') ? [] : (log.filter(l => l === 'poll0').length < 3 ? ['s'] : []) }
  ;(hs[1] as any).busySeats = () => { log.push('poll1'); return [] }
  try {
    const down = await rollingRestart(homes, {
      restart: async x => { log.push('restart' + homes.indexOf(x)) },
      up: async x => { log.push('up' + homes.indexOf(x)); return true },
      pollMs: 20, quietWaitMs: 5000, socketOf: sock,
    })
    expect(down).toEqual([])
    const order = log.filter(l => !l.startsWith('poll'))
    expect(order).toEqual(['restart0', 'up0', 'restart1', 'up1'])
    expect(log.indexOf('poll1')).toBeGreaterThan(log.indexOf('up0'))   // org 1 is not even polled until org 0 is back
    expect(log.filter(l => l === 'poll0').length).toBeGreaterThanOrEqual(3)
  } finally { servers.forEach(s => s.close()); hs.forEach(x => x.shutdown()) }
})

it('on a quiet timeout it logs the busy ids and restarts anyway; a failed org stops the sequence', async () => {
  const homes = [mkdtempSync(join(tmpdir(), 'holon-')), mkdtempSync(join(tmpdir(), 'holon-'))]
  const hs = homes.map(x => new Holon({ home: x, socketPath: sock(x), mcpEntry: '/dev/null' }))
  const servers = await Promise.all(hs.map((x, i) => serve(x, sock(homes[i]))))
  ;(hs[0] as any).busySeats = () => ['stuck-1']
  const said: string[] = []
  const restarted: string[] = []
  try {
    const down = await rollingRestart(homes, {
      restart: async x => { restarted.push(x) }, up: async () => false,
      say: l => said.push(l), name: x => 'org' + homes.indexOf(x),
      pollMs: 20, quietWaitMs: 200, socketOf: sock,
    })
    expect(down).toEqual([homes[0]])
    expect(restarted).toEqual([homes[0]])
    expect(said.some(l => l.includes('stuck-1') && l.includes('restarting anyway'))).toBe(true)
  } finally { servers.forEach(s => s.close()); hs.forEach(x => x.shutdown()) }
})
