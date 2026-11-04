// Starts an org from the terminal, with no app: the same call the app's "Start org" button makes.
// The Director uses Claude when installed, otherwise Codex; sign in to whichever you have.
// The daemon (npm run daemon) must be running for the same HOLON_HOME.
//   node scripts/start-org.ts <workspace-dir> "<directive>"
import { existsSync } from 'node:fs'
import { resolve } from 'node:path'
import { HolonClient, SOCKET_PATH } from '../packages/core/src/index.ts'

const [dir, ...rest] = process.argv.slice(2)
const text = rest.join(' ').trim()
if (!dir || !text) { console.error('usage: node scripts/start-org.ts <workspace-dir> "<directive>"'); process.exit(2) }
const workspace = resolve(dir)
if (!existsSync(workspace)) { console.error(`${workspace} does not exist: point it at a git repo (or a throwaway checkout)`); process.exit(2) }

const c = await HolonClient.connect(SOCKET_PATH).catch(() => {
  console.error(`no daemon at ${SOCKET_PATH}: start one with npm run daemon (same HOLON_HOME)`)
  process.exit(1)
})
const director = await c.call('start_directive', { text, workspace })
console.log(`org started: Director ${director.id} (${director.cli}) in ${workspace}\nwatch it: node scripts/status.ts`)
c.close()
