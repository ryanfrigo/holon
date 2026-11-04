// Real-agent proof of second_opinion with a chosen reviewer model, e.g. Gemini via OpenCode.
//
//   node scripts/e2e-review.ts [opencode model id]   (default: Gemini 3.1 Flash Lite on OpenRouter)
import { execFileSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Holon, serve, MCP_ENTRY } from '../packages/core/src/index.ts'

const model = process.argv[2] ?? 'openrouter/google/gemini-3.1-flash-lite'
const root = mkdtempSync(join(tmpdir(), 'holon-review-')), home = join(root, 'home'), repo = join(root, 'calc')
mkdirSync(home); mkdirSync(repo)
const git = (...a: string[]) => execFileSync('git', ['-C', repo, ...a], { encoding: 'utf8' })
execFileSync('git', ['init', '-q', '-b', 'main', repo]); git('config', 'user.email', 'h@l'); git('config', 'user.name', 'h')
// A planted bug the reviewer should catch without being told where it is.
writeFileSync(join(repo, 'add.js'), 'export const add = (a, b) => a - b\n')
writeFileSync(join(repo, 'README.md'), '# calc\nadd(a, b) returns the sum of a and b.\n')
git('add', '.'); git('commit', '-qm', 'add()')

const h = new Holon({ home, socketPath: join(home, 's'), mcpEntry: MCP_ENTRY })
const server = await serve(h, join(home, 's'))
;(h as any).openKb(repo)
const asker = h.create({ label: 'Director', cli: 'shell', cwd: repo, lead: true })
;(h as any).directive = { text: 't', workspace: repo, directorId: asker.id, goals: [], deliverables: [], status: 'running', startedAt: new Date().toISOString() }
h.on('action', a => { if (['second_opinion', 'reviewer_failover', 'verdict'].includes(a.action)) console.log(`  ${a.action} ${JSON.stringify(a.args).slice(0, 160)}`) })
const t0 = Date.now()
const v = await h.secondOpinion(asker.id, 'Ship add.js to production as-is?', 'The README says add returns the sum. I did not run anything.', 10 * 60_000, [{ cli: 'opencode', model }])
console.log(`\nverdict after ${Math.round((Date.now() - t0) / 1000)}s: ${v.decision}\n${v.reasoning.slice(0, 600)}`)
const caught = v.decision !== 'approve' && v.decision !== 'none' && /subtract|minus|a\s*-\s*b|difference/i.test(v.reasoning)
console.log(caught ? 'RESULT: PASS (reviewer caught the planted bug)' : 'RESULT: FAIL')
h.shutdown(); server.close()
process.exit(caught ? 0 : 1)
