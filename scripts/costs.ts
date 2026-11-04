// What Holon costs, across every project: plan limits, tokens and API-equivalent dollars by model,
// output (merges), and quota trouble. The Finance seat reads this before saying what's worth paying for.
//   node scripts/costs.ts [--hours 24] [--json]
import { existsSync, readFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { listProjects } from '../packages/core/src/projects.ts'
import { allPlans } from '../packages/core/src/plans.ts'

const args = process.argv.slice(2)
const hours = Number(args[args.indexOf('--hours') + 1]) || 24
const root = process.env.HOLON_HOME || join(homedir(), '.holon')
const since = Date.now() - hours * 3_600_000

type U = { input: number; output: number; cacheRead: number; cacheWrite: number; costUsd: number | null; cli: string; model?: string; label: string }
const tokens = (u: U) => u.input + u.output + u.cacheRead + u.cacheWrite
const readJson = <T>(f: string, d: T): T => { try { return JSON.parse(readFileSync(f, 'utf8')) } catch { return d } }
const lines = (f: string) => (existsSync(f) ? readFileSync(f, 'utf8').trim().split('\n') : []).flatMap(l => { try { return [JSON.parse(l)] } catch { return [] } })

const byModel = new Map<string, { tokens: number; usd: number; agents: number }>()
const projects = listProjects(root).map(p => {
  const usage = Object.values(readJson<Record<string, U>>(join(p.home, 'usage.json'), {}))
  for (const u of usage) {
    const k = u.model ?? u.cli
    const m = byModel.get(k) ?? { tokens: 0, usd: 0, agents: 0 }
    m.tokens += tokens(u); m.usd += u.costUsd ?? 0; m.agents++
    byModel.set(k, m)
  }
  const acts = lines(join(p.home, 'actions.jsonl')).filter(a => Date.parse(a.ts) > since)
  const count = (n: string) => acts.filter(a => a.action === n).length
  const spawns = acts.filter(a => a.action === 'spawn')
  const usd = usage.reduce((s, u) => s + (u.costUsd ?? 0), 0)
  const merges = count('merged')
  return {
    project: p.name, merges, usd: Math.round(usd), tokens: usage.reduce((s, u) => s + tokens(u), 0),
    usdPerMerge: merges ? Math.round(usd / Math.max(1, lines(join(p.home, 'actions.jsonl')).filter(a => a.action === 'merged').length)) : null,
    spawns: spawns.length, freeSpawns: spawns.filter(a => a.args?.grade === 0).length,
    paidWithReason: spawns.filter(a => a.args?.why).map(a => `${a.args.label}: ${a.args.why}`).slice(0, 5),
    quotaHits: acts.filter(a => a.action === 'quota_fallback' || (a.action === 'heal' && String(a.args?.issue).includes('quota'))).length,
  }
})

const plans = await allPlans()
const report = {
  at: new Date().toISOString(), windowHours: hours,
  plans: plans.map(p => ({ provider: p.provider, plan: p.plan, bars: p.bars.map(b => `${b.label} ${b.usedPct}%${b.resetsAt ? ` (resets ${b.resetsAt.slice(0, 16)})` : ''}`), error: p.error })),
  models: [...byModel.entries()].sort((a, b) => b[1].tokens - a[1].tokens).map(([model, m]) => ({ model, agents: m.agents, tokensM: +(m.tokens / 1e6).toFixed(1), apiEquivalentUsd: Math.round(m.usd) })),
  projects,
}

if (args.includes('--json')) console.log(JSON.stringify(report, null, 2))
else {
  console.log(`# Holon costs, ${report.at.slice(0, 16)} (activity: last ${hours}h; tokens: whole run)\n`)
  console.log('## Plan limits')
  for (const p of report.plans) console.log(`- ${p.provider}${p.plan ? ` (${p.plan})` : ''}: ${p.bars.join(', ') || p.error}`)
  console.log('\n## Tokens by model (API-equivalent $ is what this would cost without a subscription)')
  for (const m of report.models) console.log(`- ${m.model}: ${m.tokensM}M tokens, ${m.agents} agents, ~$${m.apiEquivalentUsd}`)
  console.log('\n## Projects')
  for (const p of projects) console.log(`- ${p.project}: ${p.merges} merges, ~$${p.usd} API-equivalent${p.usdPerMerge !== null ? ` (~$${p.usdPerMerge}/merge)` : ''}, ${p.freeSpawns}/${p.spawns} spawns free, ${p.quotaHits} quota hits${p.paidWithReason.length ? `\n  paid builders: ${p.paidWithReason.join(' | ')}` : ''}`)
}
