// Sets up the spec's demo in the running app: a Claude lead, a report in an empty repo,
// and one task typed into the lead. After that, nobody touches the keyboard.
//
//   node scripts/demo.ts --report codex|claude
import { execFileSync } from 'node:child_process'
import { mkdirSync, mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { parseArgs } from 'node:util'
import { HolonClient, SOCKET_PATH } from '../packages/core/src/index.ts'

const { values } = parseArgs({ options: { report: { type: 'string', default: 'codex' } } })
const root = mkdtempSync(join(tmpdir(), 'holon-demo-'))
const repo = join(root, 'fizzbuzz'), leadDir = join(root, 'lead')
for (const d of [repo, leadDir]) mkdirSync(d)
execFileSync('git', ['init', '-q'], { cwd: repo })

const c = await HolonClient.connect(SOCKET_PATH)
const sleep = (ms: number) => new Promise(r => setTimeout(r, ms))
const lead = await c.call('create', { label: 'Lead', cli: 'claude', cwd: leadDir, lead: true })
const report = await c.call('create', { label: 'Builder', cli: values.report, cwd: repo, parentId: lead.id })
console.log(`root ${root}\nlead ${lead.id} → report ${report.id} (${values.report})`)

await c.call('wait', { id: lead.id, quietMs: 3000, timeoutMs: 60_000 })
if (/trust this folder/i.test((await c.call('read_screen', { id: lead.id })).text)) {
  await c.call('press', { id: lead.id, key: 'Down' }); await sleep(300)
  await c.call('press', { id: lead.id, key: 'Enter' })
  await c.call('wait', { id: lead.id, quietMs: 3000, timeoutMs: 60_000 })
}
await c.call('type', { id: lead.id, text:
  `Have your report "${report.id}" (${values.report}, in ${repo}) build a Node fizzbuzz CLI: fizzbuzz.js prints 1..N with ` +
  `Fizz/Buzz/FizzBuzz, plus fizzbuzz.test.js runnable with \`node --test\`. Have it run the tests and make sure they pass. ` +
  `Answer any prompts it shows by reading its screen. Reply HOLON-DONE when the tests pass.` })
console.log('task sent')
c.close()
