// Plan limits for every connected provider: how much of each window is used and when it resets.
// Read from each vendor's own source; tokens are read from local credential stores and never logged.
import { execFileSync } from 'node:child_process'
import { existsSync, linkSync, readdirSync, readFileSync, renameSync, statSync, unlinkSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { randomUUID } from 'node:crypto'
import { join } from 'node:path'
import { isInstalled } from './adapters.ts'
import { rootOf } from './projects.ts'

export interface PlanBar { label: string; usedPct: number; resetsAt?: string }
export interface Plan { provider: string; plan?: string; bars: PlanBar[]; note?: string; checkedAt: string; error?: string }

const now = () => new Date().toISOString()
const pct = (n: unknown) => Math.max(0, Math.min(100, Math.round(Number(n) || 0)))

let version: string | undefined
const claudeVersion = () => (version ??= (() => { try { return execFileSync('claude', ['--version'], { encoding: 'utf8' }).trim().split(' ')[0] } catch { return '2.0.0' } })())

// Every daemon and the app read Claude's usage, and the endpoint rate-limits them all together.
// One file shared by every process: a fresh reading is reused, one lock file lets a single process
// fetch while the rest read the cache, and after a refusal nobody asks again until Retry-After
// (or, without one, a doubling wait of 10 min up to 1 h). The last good bars stay on screen.
const CLAUDE_CACHE = () => join(rootOf(process.env.HOLON_HOME || join(homedir(), '.holon')), 'claude-plan.json')
type ClaudeRead = Plan & { retryAfterMs?: number }
type ClaudeCache = { plan?: Plan; at?: number; retryAt?: number; fails?: number }

// Retry-After is seconds or an HTTP date.
export function retryAfterMs(h: string | null | undefined, at = Date.now()): number | undefined {
  if (!h) return undefined
  const s = Number(h)
  const ms = Number.isFinite(s) ? s * 1000 : Date.parse(h) - at
  return Number.isFinite(ms) && ms > 0 ? ms : undefined
}

// Well under the 60 s stale-lock limit, so a hung fetch gives up before another process may take over.
export const CLAUDE_FETCH_TIMEOUT_MS = 20_000

// Atomically takes the lock file out of the way, asks `drop` about the file it actually got (its
// token and mtime), and deletes it only on yes. On no it links it back; if another process has
// taken the lock meanwhile that link fails and theirs stands.
export function discardLock(lock: string, drop: (token: string, mtimeMs: number) => boolean): boolean {
  const aside = `${lock}.${randomUUID()}`
  try { renameSync(lock, aside) } catch { return false }
  let yes = false
  try { yes = drop(readFileSync(aside, 'utf8'), statSync(aside).mtimeMs) } catch {}
  if (!yes) { try { linkSync(aside, lock) } catch {} }
  try { unlinkSync(aside) } catch {}
  return yes
}

export async function claudePlan(file = CLAUDE_CACHE(), fetchPlan: () => Promise<ClaudeRead> = () => fetchClaudePlan()): Promise<Plan> {
  const load = (): ClaudeCache => { try { return JSON.parse(readFileSync(file, 'utf8')) } catch { return {} } }
  let c = load()
  const t = Date.now()
  const stale = (why: string): Plan => c.plan?.bars.length
    ? { ...c.plan, note: `as of ${new Date(c.at!).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' })} (${why})` }
    : { provider: 'Claude', bars: [], checkedAt: now(), error: why }
  if (c.plan?.bars.length && t - (c.at ?? 0) < 5 * 60_000) return c.plan
  if ((c.retryAt ?? 0) > t) return stale('rate limited; retrying later')
  // One fetcher at a time across processes; a lock older than a minute belongs to a dead process.
  const lock = file + '.lock'
  // The lock holds a random token. Removing it is never "look, then unlink": that lets another
  // process take a fresh lock in between and have it deleted. discardLock moves the file aside
  // first (one process wins the rename), judges the very file it moved, and puts it back if it
  // should stay.
  const token = randomUUID()
  try { writeFileSync(lock, token, { flag: 'wx' }) } catch {
    discardLock(lock, (_, mtimeMs) => Date.now() - mtimeMs > 60_000)
    return stale('another process is fetching')
  }
  try {
    c = load()                                        // someone may have just finished
    if (c.plan?.bars.length && t - (c.at ?? 0) < 5 * 60_000) return c.plan
    if ((c.retryAt ?? 0) > t) return stale('rate limited; retrying later')
    const p = await fetchPlan()
    const save = (x: ClaudeCache) => { try { writeFileSync(file, JSON.stringify(x)) } catch {} }
    if (p.bars.length) { save({ plan: p, at: Date.now() }); return p }
    // Not signed in is a local keychain read, not a refusal: nothing to back off from, and signing in
    // later must show up on the next look instead of after an hour of "rate limited".
    if (p.error === 'not signed in') return p
    const fails = (c.fails ?? 0) + 1
    save({ ...c, fails, retryAt: Date.now() + (p.retryAfterMs ?? Math.min(10 * 2 ** (fails - 1), 60) * 60_000) })
    return stale(p.error ?? 'unavailable')
  } finally { discardLock(lock, tok => tok === token) }
}

// The keychain item Claude Code writes when you sign in. `security` complains on stderr when it
// is missing (a machine that never signed in), and that line must not reach the daemon log.
export function claudeKeychain(exec: typeof execFileSync = execFileSync): string | null {
  try { return exec('security', ['find-generic-password', '-s', 'Claude Code-credentials', '-w'], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim() } catch { return null }
}

// Unused Claude week close to its reset is lost. Read from the shared cache only, so a heartbeat
// never fetches: null unless at least 20% is unused and the week resets within 48 hours, and
// never while the 5-hour window is nearly spent (more work would only hit that wall).
export function weekSurplus(file = CLAUDE_CACHE(), t = Date.now()): { unusedPct: number; hoursLeft: number } | null {
  try {
    const bars = (JSON.parse(readFileSync(file, 'utf8')).plan?.bars ?? []) as PlanBar[]
    if ((bars.find(b => b.label === '5-hour')?.usedPct ?? 0) >= 90) return null
    const bar = bars.find(b => b.label === 'week')
    const hoursLeft = bar?.resetsAt ? (Date.parse(bar.resetsAt) - t) / 3_600_000 : 0
    const unusedPct = 100 - (bar?.usedPct ?? 100)
    return hoursLeft > 0 && hoursLeft <= 48 && unusedPct >= 20 ? { unusedPct, hoursLeft: Math.round(hoursLeft) } : null
  } catch { return null }
}

// Claude Max/Pro: the same usage endpoint Claude Code's /usage reads, with its keychain login.
export async function fetchClaudePlan(keychain: () => string | null = claudeKeychain, timeoutMs = CLAUDE_FETCH_TIMEOUT_MS): Promise<ClaudeRead> {
  try {
    const raw = keychain()
    const token = raw ? JSON.parse(raw).claudeAiOauth?.accessToken : null
    if (!token) return { provider: 'Claude', bars: [], checkedAt: now(), error: 'not signed in' }
    // The endpoint rate-limits unknown clients hard; it answers Claude Code's own user agent.
    const r = await fetch('https://api.anthropic.com/api/oauth/usage', { headers: { Authorization: `Bearer ${token}`, 'anthropic-beta': 'oauth-2025-04-20', 'User-Agent': `claude-code/${claudeVersion()}` }, signal: AbortSignal.timeout(timeoutMs) })
    if (!r.ok) return { provider: 'Claude', bars: [], checkedAt: now(), error: r.status === 429 ? 'rate limited; retrying later' : `HTTP ${r.status}`, retryAfterMs: retryAfterMs(r.headers.get('retry-after')) }
    const j = await r.json() as Record<string, { utilization?: number; resets_at?: string } | null>
    const names: Record<string, string> = { five_hour: '5-hour', seven_day: 'week', seven_day_opus: 'week, Opus', seven_day_sonnet: 'week, Sonnet' }
    const bars = Object.entries(j).filter(([, v]) => v && typeof v === 'object' && 'utilization' in v)
      .map(([k, v]) => ({ label: names[k] ?? k.replace(/_/g, ' '), usedPct: pct(v!.utilization), resetsAt: v!.resets_at ?? undefined }))
    return { provider: 'Claude', plan: 'Max', bars, checkedAt: now() }
  } catch (e) {
    return { provider: 'Claude', bars: [], checkedAt: now(), error: (e as Error).message.split('\n')[0].slice(0, 80) }
  }
}

// Codex writes its rate limits into every session log; the newest one is current.
export function codexPlan(dir = join(homedir(), '.codex', 'sessions')): Plan {
  const files: { f: string; t: number }[] = []
  const walk = (d: string) => { for (const e of existsSync(d) ? readdirSync(d, { withFileTypes: true }) : []) {
    const p = join(d, e.name)
    if (e.isDirectory()) walk(p); else if (/^rollout-.*\.jsonl$/.test(e.name)) files.push({ f: p, t: statSync(p).mtimeMs })
  } }
  walk(dir)
  for (const { f } of files.sort((a, b) => b.t - a.t).slice(0, 15)) {
    const lines = readFileSync(f, 'utf8').trim().split('\n').reverse()
    for (const l of lines) {
      if (!l.includes('"rate_limits"')) continue
      try {
        const rl = JSON.parse(l).payload?.rate_limits
        if (!rl?.primary) continue
        const bar = (label: string, w: { used_percent: number; resets_at?: number }) => ({ label, usedPct: pct(w.used_percent), resetsAt: w.resets_at ? new Date(w.resets_at * 1000).toISOString() : undefined })
        // A window that has reset since the log was written is empty now; its old percentage is stale.
        const fresh = (b: ReturnType<typeof bar>) => b.resetsAt && Date.parse(b.resetsAt) <= Date.now() ? { label: b.label, usedPct: 0 } : b
        return { provider: 'Codex', plan: rl.plan_type, bars: [fresh(bar('5-hour', rl.primary)), ...(rl.secondary ? [fresh(bar('week', rl.secondary))] : [])], checkedAt: new Date(statSync(f).mtimeMs).toISOString(), note: 'as of its last session' }
      } catch {}
    }
  }
  return { provider: 'Codex', bars: [], checkedAt: now(), error: 'no recent sessions' }
}

// OpenRouter: credits bought versus used. Free models need no credit, but are capped per day.
const OPENROUTER_KEYS = [join(homedir(), '.config', 'holon', 'openrouter.key'), join(homedir(), '.config', 'openrouter', 'key')]
export async function openrouterPlan(keyFile = OPENROUTER_KEYS.find(f => existsSync(f) && readFileSync(f, 'utf8').trim()) ?? OPENROUTER_KEYS[1]): Promise<Plan> {
  if (!existsSync(keyFile)) return { provider: 'OpenRouter', bars: [], checkedAt: now(), error: 'no key' }
  try {
    const key = readFileSync(keyFile, 'utf8').trim()
    const r = await fetch('https://openrouter.ai/api/v1/credits', { headers: { Authorization: `Bearer ${key}` } })
    const d = (await r.json() as { data?: { total_credits: number; total_usage: number } }).data
    if (!d) return { provider: 'OpenRouter', bars: [], checkedAt: now(), error: `HTTP ${r.status}` }
    const left = d.total_credits - d.total_usage
    return { provider: 'OpenRouter', plan: `$${left.toFixed(2)} credit left`, bars: [{ label: `$${d.total_usage.toFixed(0)} of $${d.total_credits.toFixed(0)}`, usedPct: pct((d.total_usage / (d.total_credits || 1)) * 100) }],
      note: ':free models ~1000 requests/day', checkedAt: now() }
  } catch (e) {
    return { provider: 'OpenRouter', bars: [], checkedAt: now(), error: (e as Error).message.slice(0, 80) }
  }
}

// OpenCode Go Plus: each model has a monthly dollar allowance, and at most 20% of it per 5 hours
// and 50% per week (opencode.ai/docs/go, read 2026-10-27; the owner is on Go Plus). Spend counts
// at the plan's token prices, which is the cost OpenCode records per message.
export const GO_PLUS_MONTHLY: Record<string, number> = {
  'glm-5.3-flash': 180, 'glm-5.3': 120, 'glm-5.2': 180, 'kimi-k3.1-pro': 60, 'kimi-k3': 60, 'kimi-k2.7-code': 180,
  'longcat-2.0': 240, 'step-5-preview': 60, 'mimo-v2.6-flash': 120, 'mimo-v2.6-pro': 60, 'mimo-v2.5': 120, 'mimo-v2.5-pro': 60,
  'minimax-m3.1-flash': 80, 'minimax-m3': 180, 'qwen3.8-max': 60, 'qwen3.8-flash': 90, 'qwen3.7-plus': 180,
  'deepseek-v4.1-flash': 160, 'deepseek-v4-pro': 60, 'hy4-preview': 120, 'hy3': 240, 'grok-4.7': 60,
  'gpt-6-luna': 60, 'gpt-5.6-luna': 60, 'claude-haiku-5-5': 60, 'gemini-4-argon': 120,
}
const WINDOWS = [{ key: 'h5', label: '5h', share: 0.2 }, { key: 'd7', label: 'week', share: 0.5 }, { key: 'd30', label: 'month', share: 1 }] as const

export interface ModelSpend { provider: string; model: string; steps: number; tokens: number; cost: { h5: number; d7: number; d30: number }; tokens7d: number }

// Per-model spend and tokens from OpenCode's own database, over the plan's three windows. Its stats
// endpoint ignores a start date, so this reads the messages (2.x: session_message) directly.
export async function opencodeSpend(at = Date.now(), dbFile = join(homedir(), '.local', 'share', 'opencode', 'opencode.db')): Promise<ModelSpend[]> {
  if (!existsSync(dbFile)) return []
  const { DatabaseSync } = await import('node:sqlite')
  const db = new DatabaseSync(dbFile, { readOnly: true })
  try {
    const v2 = db.prepare("select 1 from sqlite_master where type = 'table' and name = 'session_message'").get()
    const [src, prov, model, where] = v2
      ? ['session_message', '$.model.providerID', '$.model.id', "type = 'assistant'"]
      : ['message', '$.providerID', '$.modelID', "json_extract(data, '$.role') = 'assistant'"]
    const tok = "coalesce(json_extract(data, '$.tokens.input'), 0) + coalesce(json_extract(data, '$.tokens.output'), 0) + coalesce(json_extract(data, '$.tokens.reasoning'), 0) + coalesce(json_extract(data, '$.tokens.cache.read'), 0) + coalesce(json_extract(data, '$.tokens.cache.write'), 0)"
    const cost = "coalesce(json_extract(data, '$.cost'), 0)"
    const rows = db.prepare(`select json_extract(data, '${prov}') p, json_extract(data, '${model}') m, count(*) n, sum(${tok}) t,
      sum(case when time_created >= :d7 then ${tok} else 0 end) t7,
      sum(case when time_created >= :h5 then ${cost} else 0 end) c5, sum(case when time_created >= :d7 then ${cost} else 0 end) c7, sum(${cost}) c30
      from ${src} where ${where} and time_created >= :d30 group by 1, 2`)
      .all({ h5: at - 5 * 3600_000, d7: at - 7 * 864e5, d30: at - 30 * 864e5 }) as any[]
    return rows.map(r => ({ provider: String(r.p), model: String(r.m), steps: r.n, tokens: r.t, tokens7d: r.t7, cost: { h5: r.c5, d7: r.c7, d30: r.c30 } }))
  } finally { db.close() }
}

const tok = (n: number) => n >= 1e9 ? `${(n / 1e9).toFixed(1)}B` : `${(n / 1e6).toFixed(1)}M`

// The bars are the models closest to a limit, each at its tightest window.
export function goPlan(spend: ModelSpend[]): Plan {
  const go = spend.filter(s => s.provider === 'opencode-go' && GO_PLUS_MONTHLY[s.model])
  const bars = go.map(s => {
    const limit = GO_PLUS_MONTHLY[s.model]
    const worst = WINDOWS.map(w => ({ w, used: s.cost[w.key], cap: limit * w.share })).sort((a, b) => b.used / b.cap - a.used / a.cap)[0]
    return { label: `${s.model} · ${worst.w.label} $${worst.used.toFixed(2)} of $${worst.cap}`, usedPct: pct(worst.used / worst.cap * 100) }
  }).sort((a, b) => b.usedPct - a.usedPct).slice(0, 4)
  const cost7 = go.reduce((n, s) => n + s.cost.d7, 0)
  const tokens7 = spend.filter(s => s.provider === 'opencode-go').reduce((n, s) => n + s.tokens7d, 0)
  return { provider: 'OpenCode Go Plus', plan: `$${cost7.toFixed(2)} in 7d · ${tok(tokens7)} tokens`, bars,
    note: bars.length ? 'per model: 20% of its monthly allowance per 5h, 50% per week' : 'no Go usage in 30 days', checkedAt: now() }
}

// Free inference: no bill, but real tokens. OpenCode's free models (opencode/*-free, big-pickle,
// Go's *-free promos), OpenRouter :free and the local OmniRoute gateway, from the same database.
export function freePlan(spend: ModelSpend[]): Plan {
  const free = spend.filter(s => s.tokens7d > 0 && (s.provider === 'omniroute' || /(:free|-free)$/.test(s.model) || s.model === 'big-pickle'))
  const by = new Map<string, number>()
  for (const s of free) by.set(s.provider, (by.get(s.provider) ?? 0) + s.tokens7d)
  const total = free.reduce((n, s) => n + s.tokens7d, 0)
  const top = free.sort((a, b) => b.tokens7d - a.tokens7d).slice(0, 3).map(s => `${s.model} ${tok(s.tokens7d)}`).join(', ')
  return { provider: 'Free inference', plan: `${tok(total)} tokens in 7d`, bars: [],
    note: [...by].sort((a, b) => b[1] - a[1]).map(([p, n]) => `${p} ${tok(n)}`).join(' · ') + (top ? ` — top: ${top}` : ''), checkedAt: now() }
}

// When Go lets requests through again: OpenCode stores each refusal with the window that bound
// (limitName) and how long until it opens (retryAfterMs). The newest refusal is the current state.
export async function goLimit(at = Date.now(), dbFile = join(homedir(), '.local', 'share', 'opencode', 'opencode.db')): Promise<{ limitName: string; resetsAt: string } | null> {
  if (!existsSync(dbFile)) return null
  const { DatabaseSync } = await import('node:sqlite')
  const db = new DatabaseSync(dbFile, { readOnly: true })
  try {
    if (!db.prepare("select 1 from sqlite_master where type = 'table' and name = 'session_message'").get()) return null
    const r = db.prepare(`select time_created t, json_extract(data, '$.error.retryAfterMs') ms, json_extract(data, '$.error.response.body') body
      from session_message where json_extract(data, '$.error.type') = 'provider.quota' and json_extract(data, '$.error.retryAfterMs') is not null
      order by time_created desc limit 1`).get() as { t: number; ms: number; body: string | null } | undefined
    if (!r || r.t + r.ms <= at) return null
    let limitName = 'usage'
    try { limitName = JSON.parse(r.body ?? '{}').metadata?.limitName ?? limitName } catch {}
    return { limitName, resetsAt: new Date(r.t + r.ms).toISOString() }
  } finally { db.close() }
}

export async function opencodePlans(): Promise<Plan[]> {
  try {
    const spend = await opencodeSpend()
    const go = goPlan(spend)
    const limit = await goLimit()
    if (limit) go.bars = [{ label: `${limit.limitName} limit reached`, usedPct: 100, resetsAt: limit.resetsAt }, ...go.bars]
    return [go, freePlan(spend)]
  } catch (e) {
    return [{ provider: 'OpenCode Go Plus', bars: [], checkedAt: now(), error: (e as Error).message.split('\n')[0].slice(0, 80) }]
  }
}

export async function allPlans(): Promise<Plan[]> {
  return Promise.all([...(isInstalled('claude') ? [claudePlan()] : []), Promise.resolve(codexPlan()), openrouterPlan(), opencodePlans()]).then(ps => ps.flat())
}
