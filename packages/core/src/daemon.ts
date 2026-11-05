import { execFile } from 'node:child_process'
import { mkdirSync } from 'node:fs'
import { Holon } from './holon.ts'
import { serve } from './server.ts'
import { HOLON_HOME, MCP_ENTRY, SOCKET_PATH } from './paths.ts'
import { claimHome } from './projects.ts'
import { allPlans, type Plan } from './plans.ts'

// daemon.log is read after the fact: every line says when it happened.
for (const level of ['log', 'warn', 'error'] as const) {
  const write = console[level].bind(console)
  console[level] = (...args: unknown[]) => write(new Date().toISOString(), ...args)
}

mkdirSync(HOLON_HOME, { recursive: true })
const claim = claimHome(HOLON_HOME)
if (!claim.ok) {
  console.error(`another holon daemon (pid ${claim.owner}) already runs ${HOLON_HOME}; not starting a second one`)
  process.exit(1)
}
// Reset times for a walled pool. Cached: several seats can hit a wall in one heal pass, and
// Claude's usage endpoint rate-limits hard.
let plansAt = 0, plansCache: Promise<Plan[]> | null = null
const plans = () => {
  if (!plansCache || Date.now() - plansAt > 5 * 60_000) { plansAt = Date.now(); plansCache = allPlans() }
  return plansCache
}
const holon = new Holon({ home: HOLON_HOME, socketPath: SOCKET_PATH, mcpEntry: MCP_ENTRY, plans })
const server = await serve(holon, SOCKET_PATH)
console.log(`holon daemon listening on ${SOCKET_PATH}`)
// A Mac in a dark wake (lid shut or idle, up for seconds) reports no Graphics capability.
if (process.platform === 'darwin') holon.darkWake = () => new Promise(resolve =>
  execFile('pmset', ['-g', 'systemstate'], { timeout: 10_000 }, (err, out) => resolve(!err && /Capabilities are:/.test(out) && !/Capabilities are:.*Graphics/.test(out))))
const restored = await holon.restore()
if (restored) console.log(`restored ${restored} terminals`)
// A paused org runs nothing: no nudges, no heals, no model calls for digests. Each job logs its own
// failure: one seat closing mid-heal used to throw out of a timer and take the whole daemon down.
const every = (ms: number, name: string, job: () => unknown) => setInterval(() => {
  try { void Promise.resolve(job()).catch(err => console.error(`${name} failed:`, err)) } catch (err) { console.error(`${name} failed:`, err) }
}, ms)
every(60_000, 'minute jobs', () => { holon.checkWindow(); if (holon.paused) return holon.wake(); holon.beat(); void holon.measureGoals(); holon.autoscale(); holon.audit(); holon.review(); holon.needleReview().catch(err => console.error('needle review failed:', err)); holon.duties(); holon.bench(); holon.compact(); return holon.regrade() })
every(60_000, 'awake', () => holon.checkAwake())
every(30_000, 'heal', () => holon.paused ? undefined : holon.heal())
every(15_000, 'screens', () => holon.snapshotScreens())
// Often: the dashboard counts tokens live, and Claude transcripts are read incrementally.
every(30_000, 'usage', () => holon.refreshUsage())
void holon.refreshPools().catch(err => console.error('pools failed:', err))
every(5 * 60_000, 'pools', () => holon.refreshPools())
every(15_000, 'tick', () => holon.tick(15_000))
void holon.refreshRevenue()
every(60 * 60_000, 'revenue', () => holon.refreshRevenue())
every(10 * 60_000, 'digest', () => holon.paused ? undefined : holon.refreshDigest().then(() => holon.draftFromMessages()))

const stop = () => {
  holon.shutdown()
  server.close()
  process.exit(0)
}
process.on('SIGINT', stop)
process.on('SIGTERM', stop)
