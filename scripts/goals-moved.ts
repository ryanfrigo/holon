// How many org goal numbers changed in the last N hours (default 24), from each org's goal-history.jsonl.
// The first reading of a number is not a move. The holon org itself is left out: it measures the others.
// A fall to 0 that returns to its old value moved nothing: a failed check or an outage that ended, not progress.
// Usage: node scripts/goals-moved.ts [hours] [--list]
import { existsSync, readdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'

const root = join(process.env.HOME!, '.holon')   // not HOLON_HOME: inside an org that points at the org's own home
const hours = Number(process.argv.slice(2).find(a => /^\d+(\.\d+)?$/.test(a)) ?? 24)
const since = Date.now() - hours * 3600_000
const homes: [string, string][] = [['root', root]]   // the first org lives in ~/.holon itself
const projects = join(root, 'projects')
if (existsSync(projects)) for (const p of readdirSync(projects)) if (p !== 'holon') homes.push([p, join(projects, p)])

let moves = 0
for (const [org, home] of homes) {
  const f = join(home, 'goal-history.jsonl')
  if (!existsSync(f)) continue
  // A metric tagged output today is output in its older, untagged rows too.
  let output = new Set<string>()
  try { output = new Set((JSON.parse(readFileSync(join(home, 'directive.json'), 'utf8')).goalMetrics ?? []).filter((m: { kind?: string } | null) => m?.kind === 'output').map((m: { name: string }) => m.name)) } catch {}
  const last = new Map<string, number>()
  const fell = new Map<string, { at: string; name: string; value: number; from: number }>()   // a fall to 0 not yet settled
  const count = (e: { at: string; name: string; value: number }) => {
    if (Date.parse(e.at) < since) return
    moves++
    if (process.argv.includes('--list')) console.log(`${e.at} ${org}: ${e.name} -> ${e.value}`)
  }
  for (const line of readFileSync(f, 'utf8').split('\n')) {
    if (!line.trim()) continue
    let e: { at: string; name: string; value: number; kind?: string }
    try { e = JSON.parse(line) } catch { continue }
    if (e.kind === 'output' || output.has(e.name)) continue
    const prev = last.get(e.name)
    last.set(e.name, e.value)
    // The first reading is not a move, and neither is a re-measure of the same value.
    if (prev === undefined || prev === e.value) continue
    const down = fell.get(e.name)
    fell.delete(e.name)
    if (down?.from === e.value) continue
    if (down) count(down)
    if (e.value === 0) fell.set(e.name, { ...e, from: prev })
    else count(e)
  }
  for (const down of fell.values()) count(down)
}
console.log(moves)
