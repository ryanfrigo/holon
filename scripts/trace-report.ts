// Review a Holon run from its trace.
//
//   node scripts/trace-report.ts                 # newest run in ~/.holon/traces
//   node scripts/trace-report.ts <run dir> [--ai] # --ai: a free model suggests Holon improvements
import { execFileSync } from 'node:child_process'
import { existsSync, readFileSync, readdirSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { redact } from '../packages/core/src/watcher.ts'

const args = process.argv.slice(2)
const traces = join(process.env.HOLON_HOME ?? join(homedir(), '.holon'), 'traces')
const run = args.find(a => !a.startsWith('--')) ?? join(traces, readdirSync(traces).sort().pop()!)
const read = (f: string) => (existsSync(join(run, f)) ? readFileSync(join(run, f), 'utf8') : '')
const manifest = JSON.parse(read('manifest.json') || '{}')
const directive = JSON.parse(read('directive.json') || '{}')
const actions: any[] = read('actions.jsonl').trim().split('\n').filter(Boolean).map(l => JSON.parse(l))
const label = new Map<string, string>((manifest.terminals ?? []).map((t: any) => [t.id, t.label]))
const who = (id: string | null) => (id === null ? 'human' : label.get(id) ?? id)
const out: string[] = []
const say = (s = '') => out.push(s)

const first = actions[0]?.ts, last = actions.at(-1)?.ts
say(`# Run: ${run.split('/').pop()}`)
say(`Directive: ${(manifest.directive ?? '').slice(0, 300)}`)
say(`Shape: ${manifest.shape} · ${first?.slice(0, 16)} → ${last?.slice(0, 16)} (${first && last ? Math.round((Date.parse(last) - Date.parse(first)) / 60_000) : 0} min) · status ${directive.status ?? '?'}`)

say('\n## Terminals')
const byCli: Record<string, number> = {}
for (const t of manifest.terminals ?? []) byCli[`${t.cli}/${t.model ?? 'default'}`] = (byCli[`${t.cli}/${t.model ?? 'default'}`] ?? 0) + 1
say(Object.entries(byCli).map(([k, n]) => `${n}× ${k}`).join(' · '))

const t = directive.treasury
if (t) {
  say('\n## Spend')
  say(`runway left ${Math.round(t.budgetMin + t.earnedMin - t.spentMin)} of ${t.budgetMin} · settled MRR $${t.mrr}`)
  for (const [id, m] of Object.entries(t.spentBy ?? {}).sort((a: any, b: any) => b[1] - a[1]).slice(0, 8)) say(`  ${String(Math.round(m as number)).padStart(5)} min  ${who(id)}`)
}

if (directive.usage) {
  say('\n## Tokens')
  say(`${(directive.usage.tokens / 1e6).toFixed(1)}M tokens · ~$${directive.usage.costUsd.toFixed(2)} API-equivalent${directive.usage.unpriced.length ? ` (unpriced: ${directive.usage.unpriced.join(', ')})` : ''}`)
}

const count: Record<string, number> = {}
for (const a of actions) count[a.action] = (count[a.action] ?? 0) + 1
say('\n## Activity')
say(Object.entries(count).sort((a, b) => b[1] - a[1]).map(([k, n]) => `${k} ${n}`).join(' · '))

const KEY = new Set(['directive', 'set_goals', 'spawn', 'kill', 'retired', 'merged', 'merge_refused', 'escalate', 'answer', 'propose', 'critique',
  'proposal_passed', 'proposal_rejected', 'critic_reassigned', 'deliver', 'complete', 'update', 'heal', 'org_review', 'org_died', 'restore'])
say('\n## Timeline')
for (const a of actions.filter(a => KEY.has(a.action))) {
  const d = a.args.title ?? a.args.text ?? a.args.message ?? a.args.summary ?? a.args.reason ?? a.args.label ?? a.args.issue ?? ''
  say(`${a.ts.slice(11, 16)}  ${who(a.caller).padEnd(24).slice(0, 24)} ${a.action.padEnd(17)} ${String(d).replace(/\s+/g, ' ').slice(0, 110)}`)
}

const problems = actions.filter(a => ['merge_refused', 'heal', 'critic_reassigned', 'org_died'].includes(a.action))
say(`\n## Problems (${problems.length})`)
for (const a of problems) say(`- ${a.ts.slice(11, 16)} ${a.action} on ${who(a.target)}: ${String(a.args.reason ?? a.args.summary ?? '').slice(0, 160)}`)

const asks = actions.filter(a => a.action === 'escalate' && a.target === null)
say(`\n## Asked the human (${asks.length})`)
for (const a of asks) say(`- ${a.ts.slice(11, 16)} ${who(a.caller)}: ${String(a.args.message).replace(/\s+/g, ' ').slice(0, 200)}`)

const report = out.join('\n')
console.log(report)

if (args.includes('--ai')) {
  const screens = readdirSync(join(run, 'terminals')).map(f => `--- ${f}\n` + readFileSync(join(run, 'terminals', f), 'utf8').split('\n').slice(-60).join('\n')).join('\n')
  const prompt = 'You review runs of Holon, a tool where AI agents drive other AI agents through terminals as an org. From this run report and the ' +
    'last screens of each terminal, list the 5 most important problems in how Holon itself behaved (not the business), each with evidence and a ' +
    'concrete change to Holon. Be specific and terse.'
  console.log('\n## AI review (free model)\n' + execFileSync('jev', [prompt], {
    input: redact(report + '\n\n' + screens).slice(0, 400_000), encoding: 'utf8',
    env: { ...process.env, JEV_MODEL: process.env.JEV_MODEL ?? 'nvidia/nemotron-3-ultra-550b-a55b:free' },
  }))
}
