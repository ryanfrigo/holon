import { homedir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { socketFor } from './projects.ts'

export const HOLON_HOME = process.env.HOLON_HOME || join(homedir(), '.holon')
// The same rule the app uses, so a daemon started from anywhere is found at the same address.
export const SOCKET_PATH = process.env.HOLON_SOCKET || socketFor(HOLON_HOME)
export const MCP_ENTRY = fileURLToPath(new URL('../../mcp/src/index.ts', import.meta.url))
