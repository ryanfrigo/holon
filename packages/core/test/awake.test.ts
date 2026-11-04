import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Holon } from '../src/holon.ts'
import { parseBatt, warnerFile, type Power } from '../src/awake.ts'
import { addProject } from '../src/projects.ts'

const BATT = (pct: number) => `Now drawing from 'Battery Power'\n -InternalBattery-0 (id=1)\t${pct}%; discharging; 1:00 remaining present: true\n`
const AC = `Now drawing from 'AC Power'\n -InternalBattery-0 (id=1)\t55%; charging; 1:00 remaining present: true\n`

let h: Holon
let power: Power | null
let held: number[]          // pids a sleep assertion was taken for
let released: number
let seats: number           // seats we pretend are running
const mk = () => {
  const home = mkdtempSync(join(tmpdir(), 'holon-awake-'))
  h = new Holon({
    home, socketPath: join(home, 'holon.sock'), mcpEntry: '/dev/null',
    power: async () => power,
    caffeinate: pid => { held.push(pid); return { stop: () => { released++ } } },
  })
  vi.spyOn(h, 'list').mockImplementation(() => Array.from({ length: seats }, (_, i) => ({ id: `t${i}`, state: 'running' })) as any)
}
beforeEach(() => { power = { source: 'ac', pct: 90 }; held = []; released = 0; seats = 1; mk() })
afterEach(() => { h.shutdown(); vi.restoreAllMocks() })

const asks = () => h.listEscalations().filter(e => e.from === 'holon')
const open = () => asks().filter(e => e.status === 'open')
const actions = (name: string) => h.recentActions().filter(a => a.action === name)

describe('parseBatt', () => {
  it('reads battery and AC', () => {
    expect(parseBatt(BATT(2))).toEqual({ source: 'battery', pct: 2 })
    expect(parseBatt(AC)).toEqual({ source: 'ac', pct: 55 })
  })
  it('a desktop with no battery line is AC at 100; garbage is unknown', () => {
    expect(parseBatt("Now drawing from 'AC Power'\n")).toEqual({ source: 'ac', pct: 100 })
    expect(parseBatt('')).toBeNull()
  })
})

describe('low battery', () => {
  it('asks once below 20%, again below 10%, never every minute', async () => {
    power = { source: 'battery', pct: 19 }
    await h.checkAwake(); await h.checkAwake(); await h.checkAwake()
    expect(open()).toHaveLength(1)
    expect(open()[0]).toMatchObject({ to: null, kind: 'need' })
    expect(open()[0].message).toBe('Plug in the Mac: 19% on battery, 1 org running; it will sleep and every org stops')
    expect(actions('low_battery')).toHaveLength(1)           // the app turns this into a desktop notification
    power = { source: 'battery', pct: 15 }
    await h.checkAwake()
    expect(asks()).toHaveLength(1)
    power = { source: 'battery', pct: 9 }
    await h.checkAwake(); await h.checkAwake()
    expect(asks()).toHaveLength(2)
    expect(actions('low_battery')).toHaveLength(2)
  })

  it('plugging in clears the asks and re-arms the warning', async () => {
    power = { source: 'battery', pct: 8 }
    await h.checkAwake()
    expect(open()).toHaveLength(1)
    power = { source: 'ac', pct: 8 }
    await h.checkAwake()
    expect(open()).toHaveLength(0)
    power = { source: 'battery', pct: 18 }
    await h.checkAwake()
    expect(open()).toHaveLength(1)
  })

  it('says nothing when no org is running or battery is fine', async () => {
    power = { source: 'battery', pct: 50 }
    await h.checkAwake()
    seats = 0; power = { source: 'battery', pct: 5 }
    await h.checkAwake()
    expect(asks()).toHaveLength(0)
  })
})

describe('sleep assertion', () => {
  it('is held while an org runs on AC, once, and released when none runs', async () => {
    await h.checkAwake(); await h.checkAwake()
    expect(held).toEqual([process.pid])
    expect(h.awake.holding).toBe(true)
    seats = 0
    await h.checkAwake()
    expect(released).toBe(1)
    expect(h.awake.holding).toBe(false)
  })
  it('is released on battery and taken again on AC; shutdown releases it', async () => {
    await h.checkAwake()
    power = { source: 'battery', pct: 80 }
    await h.checkAwake()
    expect(released).toBe(1)
    power = { source: 'ac', pct: 80 }
    await h.checkAwake()
    expect(held).toHaveLength(2)
    h.shutdown()
    expect(released).toBe(2)
  })
  it('is never taken with no org running', async () => {
    seats = 0
    await h.checkAwake()
    expect(held).toEqual([])
  })
})

describe('screen lock', () => {
  it('on AC a lock warns nobody', async () => {
    await h.checkAwake()
    expect(await h.systemSuspend('screen locked', true)).toBe(false)
    expect(asks()).toHaveLength(0)
  })
  it('on battery a lock warns, once', async () => {
    power = { source: 'battery', pct: 60 }
    await h.checkAwake()
    expect(await h.systemSuspend('screen locked on battery', true)).toBe(true)
    expect(await h.systemSuspend('screen locked on battery', true)).toBe(false)
    expect(open()).toHaveLength(1)
  })
  it('a real suspend warns on AC too', async () => {
    expect(await h.systemSuspend('lid closed')).toBe(true)
  })
})

describe('sleep and wake', () => {
  it('suspend with an org running notifies and asks once; resume logs slept minutes and clears the ask', async () => {
    expect(await h.systemSuspend('lid closed')).toBe(true)
    expect(await h.systemSuspend('screen locked')).toBe(false)
    expect(open()).toHaveLength(1)
    expect(actions('sleeping')).toHaveLength(1)
    h.systemResume(320 * 60_000)
    expect(actions('slept')[0].args).toEqual({ minutes: 320 })
    expect(open()).toHaveLength(0)
  })
  it('suspend with no org running says nothing', async () => {
    seats = 0
    expect(await h.systemSuspend('lid closed')).toBe(false)
    expect(asks()).toHaveLength(0)
  })
  it('an unlock after a plain lock is not logged as a sleep, but re-arms the warning', async () => {
    await h.systemSuspend('lid closed')
    h.systemResume(0)
    expect(actions('slept')).toHaveLength(0)
    expect(await h.systemSuspend('lid closed')).toBe(true)
  })
  it('a long gap between minute checks is logged as a sleep, without the app', async () => {
    let t = Date.now()
    const spy = vi.spyOn(Date, 'now').mockImplementation(() => t)
    mk()
    await h.checkAwake()
    t += 5 * 60 * 60_000 + 20 * 60_000
    await h.checkAwake()
    spy.mockRestore()
    expect(actions('slept')[0].args).toEqual({ minutes: 320 })
  })
})

// Six projects on one machine are six daemons; the owner gets one warning.
describe('machine-wide warning', () => {
  const fleet = (n: number, running: boolean[] = []) => {
    const root = mkdtempSync(join(tmpdir(), 'holon-fleet-'))
    mkdirSync(root, { recursive: true })
    const homes = [root, ...Array.from({ length: n - 1 }, (_, i) => addProject(root, `proj${i}`).home)]
    return homes.map((home, i): { h: Holon; seats: number } => {
      const box = { h: null as unknown as Holon, seats: running[i] === false ? 0 : 1 }
      box.h = new Holon({ home, socketPath: join(home, 'holon.sock'), mcpEntry: '/dev/null', power: async () => power, caffeinate: () => ({ stop() {} }) })
      vi.spyOn(box.h, 'list').mockImplementation(() => Array.from({ length: box.seats }, (_, k) => ({ id: `t${k}`, state: 'running' })) as any)
      return box
    })
  }
  afterEach(() => { for (const b of boxes) b.h.shutdown() })
  let boxes: { h: Holon; seats: number }[] = []

  it('six daemons, one low battery: one notification and one ask, counting every running org', async () => {
    boxes = fleet(6, [true, true, true, false, true, false])
    for (const b of boxes) await b.h.checkAwake()     // each publishes how many seats it runs
    power = { source: 'battery', pct: 15 }
    for (const b of boxes) await b.h.checkAwake()
    for (const b of boxes) await b.h.checkAwake()
    const all = boxes.flatMap(b => b.h.listEscalations().filter(e => e.from === 'holon'))
    expect(all).toHaveLength(1)
    expect(all[0].message).toBe('Plug in the Mac: 15% on battery, 4 orgs running; it will sleep and every org stops')
    expect(boxes.flatMap(b => b.h.recentActions().filter(a => a.action === 'low_battery'))).toHaveLength(1)
  })

  it('suspend asks once however many daemons are told, and every daemon logs the sleep', async () => {
    boxes = fleet(3)
    for (const b of boxes) await b.h.checkAwake()
    const told = await Promise.all(boxes.map(b => b.h.systemSuspend('lid closed')))
    expect(told.filter(Boolean)).toHaveLength(1)
    for (const b of boxes) b.h.systemResume(90 * 60_000)
    for (const b of boxes) expect(b.h.recentActions().filter(a => a.action === 'slept')[0].args).toEqual({ minutes: 90 })
  })

  it('a dead warner is replaced once its lock goes stale', async () => {
    boxes = fleet(2)
    const root = boxes[0].h.opts.home
    await boxes[0].h.checkAwake()
    expect(JSON.parse(readFileSync(warnerFile(root), 'utf8')).home).toBe(root)
    writeFileSync(warnerFile(root), JSON.stringify({ id: 'gone', home: root, ts: Date.now() - 4 * 60_000 }))
    await boxes[1].h.checkAwake()
    expect(JSON.parse(readFileSync(warnerFile(root), 'utf8')).home).toBe(boxes[1].h.opts.home)
  })
})
