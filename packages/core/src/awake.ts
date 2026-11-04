import { execFile, spawn } from 'node:child_process'
import { existsSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { listProjects, rootOf } from './projects.ts'

// Keeps the Mac awake while an org runs, and says loudly when it will not stay awake: a closed
// lid on battery stopped every org for 5h20m on 2026-11-02. Every system call is injectable, so
// tests never run pmset or caffeinate.
export interface Power { source: 'ac' | 'battery'; pct: number }

// `pmset -g batt` → "Now drawing from 'Battery Power'\n -InternalBattery-0 (id=..)\t2%; discharging; ..."
// A desktop Mac has no battery line: that is AC at 100.
export function parseBatt(text: string): Power | null {
  const source = /drawing from 'Battery Power'/i.test(text) ? 'battery' : /drawing from 'AC Power'/i.test(text) ? 'ac' : null
  if (!source) return null
  const pct = /(\d{1,3})%/.exec(text)
  return { source, pct: pct ? Number(pct[1]) : 100 }
}

export const readPmset = (): Promise<Power | null> => new Promise(resolve =>
  execFile('pmset', ['-g', 'batt'], { timeout: 5000 }, (err, out) => resolve(err ? null : parseBatt(out))))

// Holds an idle-sleep assertion for as long as `pid` lives; stop() releases it.
export const runCaffeinate = (pid: number): { stop(): void } => {
  const child = spawn('caffeinate', ['-i', '-w', String(pid)], { stdio: 'ignore' })
  child.on('error', () => {})
  child.unref()
  return { stop: () => { try { child.kill() } catch { /* already gone */ } } }
}

// Several daemons share one machine, and the owner needs one warning, not one per project.
// The warner is whoever holds <root>/awake.json with a fresh timestamp; the rest stay quiet.
const STALE_MS = 3 * 60_000
export const warnerFile = (root: string) => join(root, 'awake.json')
export function readWarner(root: string): { id: string; home: string; ts: number } | null {
  try { return JSON.parse(readFileSync(warnerFile(root), 'utf8')) } catch { return null }
}
export function claimWarner(home: string, now = Date.now()): boolean {
  const root = rootOf(home), cur = readWarner(root)
  if (cur && cur.home !== home && now - cur.ts < STALE_MS) return false
  try { writeFileSync(warnerFile(root), JSON.stringify({ id: `${process.pid}:${home}`, home, ts: now })) } catch { return false }
  return true
}
// Each daemon says how many seats it has running; the warner adds them up across projects.
const runningFile = (home: string) => join(home, 'awake-running.json')
export const publishRunning = (home: string, running: number, now = Date.now()) => {
  try { writeFileSync(runningFile(home), JSON.stringify({ ts: now, running })) } catch { /* the warning just counts fewer orgs */ }
}
export function orgsRunning(home: string, now = Date.now()): number {
  let homes = [home]
  try { homes = listProjects(rootOf(home)).map(p => p.home) } catch { /* fall back to this org alone */ }
  let n = 0
  for (const h of new Set(homes)) {
    try {
      if (!existsSync(runningFile(h))) continue
      const f = JSON.parse(readFileSync(runningFile(h), 'utf8'))
      if (now - f.ts < STALE_MS && f.running > 0) n++
    } catch { /* unreadable: not counted */ }
  }
  return n
}

export interface AwakeDeps {
  claim: () => boolean                                    // true when this daemon is the machine's one warner
  orgs: () => number                                      // orgs running across every project on the machine
  power: () => Promise<Power | null>
  caffeinate: (pid: number) => { stop(): void }
  running: () => number                                   // seats working right now
  notify: (action: string, args: Record<string, unknown>) => void   // logged; the app shows it on the desktop
  ask: (message: string) => string                        // posts an owner ask, returns its id
  clearAsk: (id: string, why: string) => void
  pid?: number
  now?: () => number
}

const LEVELS = [20, 10]
// More than this between two minute checks means the machine was asleep, not busy.
const GAP_MS = 3 * 60_000

export class Awake {
  private level = 0                       // 0: none warned, 1: warned under 20, 2: warned under 10
  private askIds = new Set<string>()
  private assertion: { stop(): void } | null = null
  private lastSeen: number
  private sleepWarned = false
  last: Power | null = null

  private d: AwakeDeps
  constructor(d: AwakeDeps) { this.d = d; this.lastSeen = (d.now ?? Date.now)() }

  get holding() { return this.assertion !== null }

  // Called every minute. Returns the sleep it noticed, if any.
  async check(): Promise<{ sleptMin: number } | null> {
    const now = (this.d.now ?? Date.now)()
    const gap = now - this.lastSeen
    this.lastSeen = now
    const slept = gap > GAP_MS ? this.slept(gap) : null
    const p = this.last = await this.d.power()
    const mine = this.d.running() > 0
    const warner = this.d.claim()   // every check, so the lock stays fresh while this daemon is the one warning
    const onAc = p?.source === 'ac'

    if (mine && onAc) this.assertion ??= this.d.caffeinate(this.d.pid ?? process.pid)
    else this.release()

    let orgs = 0
    if (!p || onAc) {
      if (onAc) this.plugged()
    } else if (p.source === 'battery') {
      const at = p.pct < LEVELS[1] ? 2 : p.pct < LEVELS[0] ? 1 : 0
      if (at === 0) this.level = 0
      else if (warner && at > this.level && (orgs = this.d.orgs()) > 0) {
        this.level = at
        const message = `Plug in the Mac: ${p.pct}% on battery, ${orgs} org${orgs > 1 ? 's' : ''} running; it will sleep and every org stops`
        this.d.notify('low_battery', { pct: p.pct, orgs, text: message })
        this.askIds.add(this.d.ask(message))
      }
    }
    return slept
  }

  private plugged() {
    this.level = 0
    for (const id of this.askIds) this.d.clearAsk(id, 'plugged in')
    this.askIds.clear()
  }

  private release() { this.assertion?.stop(); this.assertion = null }

  // The system is about to sleep (lid closed, suspend) or the screen locked. A lock alone stops
  // nothing on AC; on battery it is the lid closing that sleeps the Mac, so only then does it warn.
  async suspending(reason: string, lock = false) {
    if (lock && (await this.d.power())?.source !== 'battery') return false
    const orgs = this.d.orgs()
    if (!orgs || this.sleepWarned || !this.d.claim()) return false
    this.sleepWarned = true
    const message = `The Mac is going to sleep (${reason}) with ${orgs} org${orgs > 1 ? 's' : ''} running; every org stops until it wakes. Open the lid or plug in and keep it awake.`
    this.d.notify('sleeping', { reason, orgs, text: message })
    this.askIds.add(this.d.ask(message))
    return true
  }

  // The app saw the machine wake; it knows exactly how long it was out.
  resumed(sleptMs: number) {
    this.lastSeen = (this.d.now ?? Date.now)()   // the gap detector must not count this sleep twice
    return this.slept(sleptMs)
  }

  private slept(ms: number) {
    this.sleepWarned = false
    for (const id of this.askIds) this.d.clearAsk(id, 'awake again')
    this.askIds.clear()
    return { sleptMin: Math.round(ms / 60_000) }
  }

  shutdown() { this.release() }
}
