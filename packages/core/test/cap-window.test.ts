import { afterEach, beforeEach, expect, it } from 'vitest'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Holon } from '../src/holon.ts'
import { inWindow, mergeSettings, nextWindowStart, DEFAULT_SETTINGS } from '../src/org.ts'

let home: string
let h: Holon
beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), 'holon-'))
  h = new Holon({ home, socketPath: join(home, 'holon.sock'), mcpEntry: '/dev/null' })
})
afterEach(() => h.shutdown())

const at = (d: number, hh: number, mm = 0) => new Date(2026, 9, d, hh, mm).getTime()   // local time
const spend = (usd: number) => (h as any).usageCache.set('seat-1', { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, costUsd: usd, label: 'Eng', cli: 'opencode' })

it('run windows: inside, overnight, and when the window next opens', () => {
  const day = { start: '09:00', end: '17:00' }
  expect(inWindow(day, at(28, 9))).toBe(true)
  expect(inWindow(day, at(28, 17))).toBe(false)
  expect(inWindow(null, at(28, 3))).toBe(true)
  const night = { start: '22:00', end: '06:00' }
  expect(inWindow(night, at(28, 23))).toBe(true)
  expect(inWindow(night, at(28, 5, 59))).toBe(true)
  expect(inWindow(night, at(28, 12))).toBe(false)
  expect(nextWindowStart(day, at(28, 18))).toBe(at(29, 9))
  expect(nextWindowStart(day, at(28, 7))).toBe(at(28, 9))
  expect(mergeSettings(DEFAULT_SETTINGS, { runWindow: { start: '25:00', end: '06:00' } }).runWindow).toBeNull()
  expect(mergeSettings(DEFAULT_SETTINGS, { dailyCapUsd: -3 }).dailyCapUsd).toBe(0)
})

it('pauses outside the run window until it opens, and an owner resume holds until the window opens again', async () => {
  h.setSettings({ runWindow: { start: '09:00', end: '17:00' } })
  h.checkWindow(at(28, 16))
  expect(h.paused).toBeNull()
  h.checkWindow(at(28, 17, 1))
  expect(h.paused).toMatchObject({ until: new Date(at(29, 9)).toISOString() })
  expect(h.paused!.reason).toMatch(/run window/)
  await h.resume('owner', at(28, 17, 30)) // the owner overrides it tonight
  h.checkWindow(at(28, 18))
  expect(h.paused).toBeNull()
  h.checkWindow(at(29, 10))              // back inside: the override ends
  h.checkWindow(at(29, 17, 1))
  expect(h.paused).not.toBeNull()
  expect(await h.wake(at(30, 9, 1))).toBe(0)
  expect(h.paused).toBeNull()
})

it('a pause that ends on its own does not let the org run outside its window', async () => {
  h.setSettings({ runWindow: { start: '09:00', end: '17:00' } })
  h.checkWindow(at(28, 12))
  h.create({ label: 'Eng', cli: 'opencode', cwd: home, grade: 0 })
  h.pause('pools out', at(28, 20))
  expect(await h.wake(at(28, 20, 1))).toBe(0)     // no seats restored just to stop them again
  expect(h.paused).toMatchObject({ until: new Date(at(29, 9)).toISOString() })
  expect(h.paused!.reason).toMatch(/run window/)
})

it('the daily dollar cap pauses the org until midnight, counting only what was spent today', async () => {
  h.setSettings({ dailyCapUsd: 5 })
  spend(40)                              // lifetime spend from earlier days
  h.countSpend(at(28, 9))
  expect(h.spentToday()).toBe(0)
  spend(43)
  h.countSpend(at(28, 10))
  expect(h.paused).toBeNull()
  spend(45.5)
  h.countSpend(at(28, 11))
  expect(h.spentToday()).toBe(5.5)
  expect(h.paused).toMatchObject({ until: new Date(at(29, 0)).toISOString() })
  expect(h.paused!.reason).toMatch(/daily cap \$5/)
  await h.resume()                       // the owner lets it run on today
  spend(50)
  h.countSpend(at(28, 12))
  expect(h.paused).toBeNull()
  spend(51)
  h.countSpend(at(29, 0, 5))             // a new day starts from zero
  expect(h.spentToday()).toBe(1)
})

it('a seat whose session changed counts its new session in full', () => {
  spend(10)
  h.countSpend(at(28, 9))
  spend(2)                               // reseated: a new session, smaller total
  h.countSpend(at(28, 10))
  expect(h.spentToday()).toBe(2)
})
