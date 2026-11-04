// Real-agent proof of the council: a Director must win a co-director's vote before set_goals.
//
//   node scripts/e2e-council.ts [co-director cli, default claude]
import { mkdirSync, mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Holon, serve, MCP_ENTRY, type Cli } from '../packages/core/src/index.ts'

const coClis = (process.argv[2] ?? 'claude').split(',') as Cli[]
const root = mkdtempSync(join(tmpdir(), 'holon-council-'))
const home = join(root, 'home'), ws = join(root, 'ws')
mkdirSync(home); mkdirSync(ws)
const sock = join(home, 'holon.sock')
const h = new Holon({ home, socketPath: sock, mcpEntry: MCP_ENTRY })
const server = await serve(h, sock)
h.on('action', a => {
  if (['propose', 'vote', 'proposal_passed', 'proposal_rejected', 'set_goals', 'seat_council'].includes(a.action)) console.log(`  ${a.ts.slice(11, 19)} ${a.action} ${JSON.stringify(a.args).slice(0, 160)}`)
})
// Seat the council before the Director can set goals on its own.
let goalsSetAfterVote = false
h.on('action', a => { if (a.action === 'set_goals' && h.getDirective()?.proposals?.some(p => p.status === 'passed')) goalsSetAfterVote = true })
await h.startDirective('Plan a one-page website for a neighborhood bakery. Keep it tiny: no code, just goals.', ws)
await h.seatCouncil(coClis)
const deadline = Date.now() + 12 * 60_000
while (Date.now() < deadline && !goalsSetAfterVote) await new Promise(r => setTimeout(r, 5000))
const d = h.getDirective()!
const passed = d.proposals?.find(p => p.status === 'passed')
const checks = {
  [`council seated (${coClis.length + 1} members)`]: d.council?.members.length === coClis.length + 1,
  'a proposal passed': !!passed,
  'co-director voted with a reason': !!passed && Object.entries(passed.votes).some(([m, v]) => m !== passed.by && v.reason.length > 10),
  'goals set after the vote': goalsSetAfterVote,
  'decision captured in kb': (h.kbOverview()?.counts.decision ?? 0) >= 1,
}
console.log('goals:', d.goals)
console.log(JSON.stringify(checks, null, 2))
const ok = Object.values(checks).every(Boolean)
console.log(ok ? 'RESULT: PASS' : 'RESULT: FAIL')
h.shutdown(); server.close()
process.exit(ok ? 0 : 1)
