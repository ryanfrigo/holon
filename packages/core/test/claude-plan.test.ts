import { expect, it, vi } from 'vitest'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { claudePlan, type Plan } from '../src/plans.ts'

// Lets a test run code at the instant just before a lock file is moved or deleted: the gap another
// process gets between another process's "is it stale?" and its removal.
const gap = vi.hoisted(() => ({ before: null as null | ((p: string) => void) }))
vi.mock('node:fs', async importOriginal => {
  const m = await importOriginal<typeof import('node:fs')>()
  const hook = <A extends unknown[], R>(f: (p: string, ...a: A) => R) => (p: string, ...a: A) => {
    const run = gap.before; gap.before = null; run?.(String(p)); return f(p, ...a)
  }
  return { ...m, unlinkSync: hook(m.unlinkSync as any), renameSync: hook(m.renameSync as any) }
})

it('one Claude reading serves every process, and a 429 keeps the last good bars', async () => {
  const file = join(mkdtempSync(join(tmpdir(), 'holon-')), 'claude-plan.json')
  let calls = 0
  const good = async (): Promise<Plan> => { calls++; return { provider: 'Claude', bars: [{ label: '5-hour', usedPct: 40 }], checkedAt: '' } }
  const limited = async (): Promise<Plan> => { calls++; return { provider: 'Claude', bars: [], checkedAt: '', error: 'rate limited; retrying later' } }
  expect((await claudePlan(file, good)).bars[0].usedPct).toBe(40)
  expect((await claudePlan(file, limited)).bars[0].usedPct).toBe(40)   // fresh: no second fetch
  expect(calls).toBe(1)
  const { writeFileSync, readFileSync } = await import('node:fs')
  const c = JSON.parse(readFileSync(file, 'utf8')); c.at -= 6 * 60_000; writeFileSync(file, JSON.stringify(c))
  const p = await claudePlan(file, limited)
  expect(p.bars[0].usedPct).toBe(40)
  expect(p.note).toMatch(/rate limited/)
  expect(calls).toBe(2)
  await claudePlan(file, limited)                                       // backing off: nobody asks
  expect(calls).toBe(2)
})

import { retryAfterMs } from '../src/plans.ts'
import { existsSync, readFileSync, writeFileSync } from 'node:fs'

const ok = async () => ({ provider: 'Claude', bars: [{ label: 'week', usedPct: 10 }], checkedAt: '' })
const refused = (retryAfterMs?: number) => async () => ({ provider: 'Claude', bars: [], checkedAt: '', error: 'rate limited; retrying later', retryAfterMs })
const fresh = () => join(mkdtempSync(join(tmpdir(), 'holon-')), 'claude-plan.json')

it('reads Retry-After as seconds or as an HTTP date', () => {
  expect(retryAfterMs('2857')).toBe(2_857_000)
  expect(retryAfterMs('Mon, 02 Nov 2026 16:20:00 GMT', Date.parse('Mon, 02 Nov 2026 16:10:00 GMT'))).toBe(600_000)
  expect(retryAfterMs(null)).toBeUndefined()
  expect(retryAfterMs('soon')).toBeUndefined()
})

it('waits out Retry-After, then backs off by doubling and clears on success', async () => {
  const file = fresh()
  let calls = 0
  const count = (f: () => Promise<any>) => async () => { calls++; return f() }
  await claudePlan(file, count(ok))
  const age = (ms: number) => { const c = JSON.parse(readFileSync(file, 'utf8')); c.at -= ms; if (c.retryAt) c.retryAt -= ms; writeFileSync(file, JSON.stringify(c)) }
  age(6 * 60_000)
  await claudePlan(file, count(refused(2_857_000)))             // told to wait 48 min
  expect(calls).toBe(2)
  age(40 * 60_000); await claudePlan(file, count(ok)); expect(calls).toBe(2)   // 40 min in: still waiting
  age(9 * 60_000); await claudePlan(file, count(refused())); expect(calls).toBe(3)   // 49 min: asks; no header → 20 min
  age(19 * 60_000); await claudePlan(file, count(ok)); expect(calls).toBe(3)
  age(2 * 60_000); expect((await claudePlan(file, count(ok))).bars[0].usedPct).toBe(10); expect(calls).toBe(4)
  expect(JSON.parse(readFileSync(file, 'utf8')).fails).toBeUndefined()
})

it('a plain error (not just a 429) also backs off', async () => {
  const file = fresh()
  let calls = 0
  const boom = async () => { calls++; return { provider: 'Claude', bars: [], checkedAt: '', error: 'HTTP 500' } }
  await claudePlan(file, boom); await claudePlan(file, boom); await claudePlan(file, boom)
  expect(calls).toBe(1)
})

it('simultaneous callers make one request', async () => {
  const file = fresh()
  let calls = 0
  const slow = async () => { calls++; await new Promise(r => setTimeout(r, 50)); return ok() }
  const out = await Promise.all([1, 2, 3, 4, 5, 6, 7].map(() => claudePlan(file, slow)))
  expect(calls).toBe(1)
  expect(out.filter(p => p.bars.length).length).toBeGreaterThanOrEqual(1)
  expect(existsSync(file + '.lock')).toBe(false)
})

import { readFileSync as read, utimesSync } from 'node:fs'
import { CLAUDE_FETCH_TIMEOUT_MS } from '../src/plans.ts'

it('a fetch that hangs past the stale limit does not delete the lock the next process took', async () => {
  const file = join(mkdtempSync(join(tmpdir(), 'holon-')), 'claude-plan.json')
  const lock = file + '.lock'
  const ok: Plan = { provider: 'Claude', bars: [{ label: '5-hour', usedPct: 10 }], checkedAt: '' }
  let releaseFirst!: () => void, releaseSecond!: () => void
  const first = claudePlan(file, () => new Promise<Plan>(r => { releaseFirst = () => r(ok) }))
  const firstToken = read(lock, 'utf8')
  const old = new Date(Date.now() - 61_000)
  utimesSync(lock, old, old)                                   // the first holder is now past the stale limit
  expect((await claudePlan(file, async () => ok)).error).toMatch(/another process/)   // this call clears the stale lock
  const second = claudePlan(file, () => new Promise<Plan>(r => { releaseSecond = () => r(ok) }))
  const secondToken = read(lock, 'utf8')
  expect(secondToken).not.toBe(firstToken)
  releaseFirst(); await first
  expect(existsSync(lock) && read(lock, 'utf8')).toBe(secondToken)   // the first holder left the second's lock alone
  releaseSecond(); await second
  expect(existsSync(lock)).toBe(false)
})

it('a stale lock is reclaimed without deleting the fresh lock another process takes in the gap', async () => {
  const file = join(mkdtempSync(join(tmpdir(), 'holon-')), 'claude-plan.json')
  const lock = file + '.lock'
  const { unlinkSync, writeFileSync: write } = await import('node:fs')
  write(lock, 'dead-holder'); const old = new Date(Date.now() - 61_000); utimesSync(lock, old, old)
  // The taker saw the lock stale. Before it removes anything, a second taker clears it and holds a fresh one.
  gap.before = () => { unlinkSync(lock); write(lock, 'second-taker') }
  const out = await claudePlan(file, async () => ok0)
  expect(out.error ?? out.note).toMatch(/another process/)
  expect(read(lock, 'utf8')).toBe('second-taker')            // the second taker still holds its lock
  expect(readdirSync(dirname(file)).filter(f => /\.lock\./.test(f))).toEqual([])   // nothing left aside
})
const ok0: Plan = { provider: 'Claude', bars: [{ label: '5-hour', usedPct: 10 }], checkedAt: '' }
import { readdirSync } from 'node:fs'
import { dirname } from 'node:path'

import { fetchClaudePlan } from '../src/plans.ts'

it('the usage fetch is aborted at its timeout, reports it, and the lock is released', async () => {
  const file = join(mkdtempSync(join(tmpdir(), 'holon-')), 'claude-plan.json')
  let signal: AbortSignal | undefined
  vi.stubGlobal('fetch', (_url: string, init: RequestInit) => new Promise((_res, rej) => {
    signal = init.signal!
    signal.addEventListener('abort', () => rej(signal!.reason))
  }))
  try {
    const t0 = Date.now()
    const out = await claudePlan(file, () => fetchClaudePlan(() => '{"claudeAiOauth":{"accessToken":"t"}}', 50))
    expect(signal).toBeDefined()
    expect(signal!.aborted).toBe(true)                      // the request was cancelled, not abandoned
    expect(out.error).toMatch(/timeout|aborted/i)
    expect(Date.now() - t0).toBeLessThan(5_000)
    expect(existsSync(file + '.lock')).toBe(false)          // and the lock is free for the next process
  } finally { vi.unstubAllGlobals() }
})

it('the usage fetch gives up well before the lock goes stale', () => {
  expect(CLAUDE_FETCH_TIMEOUT_MS).toBeLessThan(60_000)
})

it('no Claude login is not a refusal: no backoff, and signing in shows up on the next look', async () => {
  const file = join(mkdtempSync(join(tmpdir(), 'holon-')), 'claude-plan.json')
  const out = async (): Promise<Plan> => ({ provider: 'Claude', bars: [], checkedAt: '', error: 'not signed in' })
  const signedIn = async (): Promise<Plan> => ({ provider: 'Claude', bars: [{ label: '5-hour', usedPct: 10 }], checkedAt: '' })
  expect((await claudePlan(file, out)).error).toBe('not signed in')
  expect((await claudePlan(file, out)).error).toBe('not signed in')   // asked again, not "rate limited"
  expect((await claudePlan(file, signedIn)).bars[0].usedPct).toBe(10)
})
