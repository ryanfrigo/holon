// What your subscriptions bought: every token Holon's agents spent, per plan, priced at API rates.
// Read from each CLI's own logs (Claude transcripts, Codex sessions, OpenCode's database), only for
// terminals that ran inside a Holon project or its worktrees. Nothing is sent anywhere.
//   node scripts/receipt.ts [--since 2026-10-21] [--paid claude=200,codex=20,opencode-go=10] [--json]
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs'
import { homedir } from 'node:os'
import { join, sep } from 'node:path'
import { listProjects, rootOf } from '../packages/core/src/projects.ts'
import { claudeUsage, codexSessions, codexUsage, opencodeSessions, total, type Usage } from '../packages/core/src/usage.ts'

const arg = (f: string) => { const i = process.argv.indexOf(f); return i >= 0 ? process.argv[i + 1] : undefined }
const since = Date.parse(arg('--since') ?? new Date(Date.now() - 30 * 86_400_000).toISOString().slice(0, 10))
const paid = Object.fromEntries((arg('--paid') ?? '').split(',').filter(Boolean).map(kv => kv.split('=')).map(([k, v]) => [k, Number(v)]))
const projects = listProjects(rootOf(process.env.HOLON_HOME || join(homedir(), '.holon'))).filter(p => p.workspace)
const inHolon = (cwd: string) => projects.some(p => cwd === p.workspace || cwd.startsWith(join(p.home, 'worktrees') + sep))

type Line = { plan: string; tokens: number; usd: number; sessions: number }
const lines = new Map<string, Line>()
const add = (plan: string, u: Usage) => {
  const l = lines.get(plan) ?? { plan, tokens: 0, usd: 0, sessions: 0 }
  l.tokens += total(u); l.usd += u.costUsd ?? 0; l.sessions++
  lines.set(plan, l)
}

// Claude seats start with --session-id, and the org state, action log and trace snapshots record it.
// Your own Claude sessions in the same repo aren't Holon's, so the workspace folder counts only those
// ids; worktree folders hold nothing but Holon builders.
const seats = new Set<string>()
const scan = (f: string) => { try { for (const m of readFileSync(f, 'utf8').matchAll(/"sessionId"\s*:\s*"([0-9a-f-]{36})"/g)) seats.add(m[1]) } catch {} }
for (const p of projects) {
  for (const f of ['org.json', 'org.pre-pause.json', 'actions.jsonl']) scan(join(p.home, f))
  const t = join(p.home, 'traces')
  if (existsSync(t)) for (const tr of readdirSync(t)) {
    scan(join(t, tr, 'actions.jsonl'))
    if (existsSync(join(t, tr, 'org'))) for (const f of readdirSync(join(t, tr, 'org'))) scan(join(t, tr, 'org', f))
  }
}

// Claude: one transcript folder per working directory, named after it with every non-alphanumeric as '-'.
const claudeRoot = join(homedir(), '.claude', 'projects')
const mangle = (p: string) => p.replace(/[^A-Za-z0-9]/g, '-')
const dirs = existsSync(claudeRoot) ? readdirSync(claudeRoot) : []
for (const p of projects) {
  const ws = mangle(p.workspace!), wt = mangle(join(p.home, 'worktrees')) + '-'
  for (const d of dirs.filter(d => d === ws || d.startsWith(wt)))
    for (const f of readdirSync(join(claudeRoot, d)))
      if (f.endsWith('.jsonl') && (d !== ws || seats.has(f.slice(0, -6))) && statSync(join(claudeRoot, d, f)).mtimeMs >= since)
        add('Claude', claudeUsage(join(claudeRoot, d, f)))
}

const codexModel = (file: string) => readFileSync(file, 'utf8').match(/"model":"([^"]+)"/)?.[1]
for (const s of codexSessions(since)) if (s.start >= since && inHolon(s.cwd)) add('Codex', codexUsage(s.file, projects[0].home, codexModel(s.file)))

// Same split as the Plan limits panel: Go is the OpenCode plan, the free pools cost nothing, the rest is OpenRouter credit.
const isFree = (m = '') => m.startsWith('omniroute/') || /(:free|-free)$/.test(m) || m.endsWith('/big-pickle')
for (const s of await opencodeSessions(since)) if (inHolon(s.cwd)) {
  const m = s.model ?? ''
  add(m.startsWith('opencode-go/') ? 'OpenCode Go' : isFree(m) ? 'Free models' : 'OpenRouter', s.usage)
}

const rows = [...lines.values()].sort((a, b) => b.tokens - a.tokens)
const merges = projects.reduce((n, p) => {
  const f = join(p.home, 'actions.jsonl')
  if (!existsSync(f)) return n
  return n + readFileSync(f, 'utf8').split('\n').filter(l => l.includes('"action":"merged"') && Date.parse(l.slice(7, 31)) >= since).length
}, 0)
const sum = { tokens: rows.reduce((n, r) => n + r.tokens, 0), usd: rows.reduce((n, r) => n + r.usd, 0) }
const spent = Object.values(paid).reduce((n, v) => n + v, 0)
const days = Math.max(1, Math.round((Date.now() - since) / 86_400_000))

if (process.argv.includes('--json')) {
  console.log(JSON.stringify({ since: new Date(since).toISOString(), days, orgs: projects.length, merges, rows, ...sum, paid }, null, 2))
  process.exit(0)
}

const tok = (n: number) => n >= 1e9 ? `${(n / 1e9).toFixed(2)}B` : `${(n / 1e6).toFixed(1)}M`
const usd = (n: number) => `$${Math.round(n).toLocaleString('en-US')}`
const W = 46
const row = (a: string, b: string, c: string) => a.padEnd(16) + b.padStart(12) + c.padStart(W - 28)
const rule = '─'.repeat(W)
console.log([
  rule,
  'HOLON RECEIPT'.padEnd(W - 10) + `${days} days`.padStart(10),
  `${new Date(since).toISOString().slice(0, 10)} → ${new Date().toISOString().slice(0, 10)} · ${projects.length} orgs · ${merges} merges`,
  rule,
  row('plan', 'tokens', 'at API prices'),
  ...rows.map(r => row(r.plan, tok(r.tokens), r.plan === 'Free models' ? '$0' : usd(r.usd))),
  rule,
  row('total', tok(sum.tokens), usd(sum.usd)),
  ...(spent ? [row('you paid', '', usd(spent)), row('multiple', '', `${(sum.usd / spent).toFixed(1)}×`)] : []),
  rule,
].join('\n'))
