// Output per token, per org, over a window: Claude tokens (re-read context, output) from each
// seat's transcript plus Codex/OpenCode session totals, against merges from actions.jsonl. Answers "did that change help?".
//   node scripts/efficiency.ts [--since 2026-10-28T16:00] [--until 2026-10-28T23:00]
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs'
import { homedir } from 'node:os'
import { join, sep } from 'node:path'
import { countLanded } from '../packages/core/src/landed.ts'
import { listProjects, rootOf } from '../packages/core/src/projects.ts'

import { codexSessions, codexUsage, opencodeSessions } from '../packages/core/src/usage.ts'

const arg = (f: string) => { const i = process.argv.indexOf(f); return i >= 0 ? process.argv[i + 1] : undefined }
// Times are UTC; a bare 2026-10-28T16:00 would otherwise parse as local time.
const utc = (t: string) => new Date(/Z|[+-]\d\d:?\d\d$/.test(t) ? t : t + 'Z').toISOString()
const since = utc(arg('--since') ?? new Date(Date.now() - 24 * 3600_000).toISOString())
const until = utc(arg('--until') ?? new Date().toISOString())
const hours = (Date.parse(until) - Date.parse(since)) / 3600_000
const root = join(homedir(), '.claude', 'projects')
const mangle = (p: string) => p.replace(/[^A-Za-z0-9]/g, '-')

const sinceMs = Date.parse(since), untilMs = Date.parse(until)
// shortcut: Codex/OpenCode totals cover whole sessions started in the window; use event deltas for exact window accounting.
const codex = codexSessions(sinceMs).filter(s => s.start >= sinceMs && s.start < untilMs)
const opencode = (await opencodeSessions(sinceMs)).filter(s => s.start < untilMs)
const rows = []
for (const p of listProjects(rootOf(process.env.HOLON_HOME || join(homedir(), '.holon')))) {
  if (!p.workspace) continue
  const ws = mangle(p.workspace), wt = mangle(join(p.home, 'worktrees')) + '-'
  const dirs = (existsSync(root) ? readdirSync(root) : []).filter(d => d === ws || d.startsWith(wt))
  let read = 0, out = 0, turns = 0
  for (const d of dirs) for (const f of readdirSync(join(root, d))) {
    const file = join(root, d, f)
    if (!f.endsWith('.jsonl') || statSync(file).mtimeMs < Date.parse(since)) continue
    const seen = new Set<string>()
    for (const line of readFileSync(file, 'utf8').split('\n')) {
      if (!line.includes('"usage"')) continue
      let j: any
      try { j = JSON.parse(line) } catch { continue }
      if (!j.timestamp || j.timestamp < since || j.timestamp >= until) continue
      const id = j.message?.id, us = j.message?.usage
      if (!us || (id && seen.has(id))) continue
      if (id) seen.add(id)
      read += us.cache_read_input_tokens ?? 0
      out += us.output_tokens ?? 0
      turns++
    }
  }
  const matches = (cwd: string) => cwd === p.workspace || cwd.startsWith(join(p.home, 'worktrees') + sep)
  let codexOc = 0
  for (const s of codex) if (matches(s.cwd)) {
    const u = codexUsage(s.file, p.home)
    codexOc += u.input + u.cacheRead
  }
  for (const s of opencode) if (matches(s.cwd)) codexOc += s.usage.input + s.usage.cacheRead
  let merges = 0
  const acts = join(p.home, 'actions.jsonl')
  if (existsSync(acts)) for (const line of readFileSync(acts, 'utf8').split('\n')) {
    const ts = line.slice(7, 31)
    if (ts >= since && ts < until && line.includes('"action":"merged"')) merges++
  }
  // Work also lands without the queue (a Director committing on its branch): count first-parent
  // commits where the org's seats were cut from, as well as the workspace checkout, or an org that
  // ships that way reads as idle.
  const landed = countLanded(p.home, p.workspace, since, until)
  rows.push({ org: p.slug, codexOcM: codexOc / 1e6, turns, readM: read / 1e6, outK: out / 1e3, merges, landed, readPerTurnK: turns ? read / turns / 1e3 : 0 })
}

const f = (n: number, d = 1) => n.toFixed(d)
console.log(`${since} → ${until} (${f(hours)}h), Claude turns + Codex/OpenCode session totals`)
console.log('org             turns  re-read M  out k  merges  landed  re-read/turn k  re-read M/merge  re-read M/landed  codex+oc M')
const per = (n: number, d: number) => d ? f(n / d) : '—'
for (const r of rows) console.log(`${r.org.padEnd(15)} ${String(r.turns).padStart(5)}  ${f(r.readM).padStart(9)}  ${f(r.outK, 0).padStart(5)}  ${String(r.merges).padStart(6)}  ${String(r.landed).padStart(6)}  ${f(r.readPerTurnK, 0).padStart(14)}  ${per(r.readM, r.merges).padStart(15)}  ${per(r.readM, r.landed).padStart(16)}  ${f(r.codexOcM).padStart(10)}`)
const t = rows.reduce((a, r) => ({ codexOcM: a.codexOcM + r.codexOcM, turns: a.turns + r.turns, read: a.read + r.readM, merges: a.merges + r.merges, landed: a.landed + r.landed }), { codexOcM: 0, turns: 0, read: 0, merges: 0, landed: 0 })
console.log(`all             ${String(t.turns).padStart(5)}  ${f(t.read).padStart(9)}         ${String(t.merges).padStart(6)}  ${String(t.landed).padStart(6)}  ${f(t.turns ? t.read * 1e3 / t.turns : 0, 0).padStart(14)}  ${per(t.read, t.merges).padStart(15)}  ${per(t.read, t.landed).padStart(16)}  ${f(t.codexOcM).padStart(10)}`)
