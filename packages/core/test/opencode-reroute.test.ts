import { afterEach, beforeEach, expect, it } from 'vitest'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Holon } from '../src/holon.ts'
import { diagnose } from '../src/watcher.ts'
import { modelProvider } from '../src/org.ts'

// Fake CLIs only: HOLON_FAKE_CLIS (vitest.config.ts) makes every seat a plain shell.
let home: string
let h: Holon
beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), 'holon-'))
  h = new Holon({ home, socketPath: join(home, 'holon.sock'), mcpEntry: '/dev/null' })
  h.setSettings({ opencodeGo: true })
})
afterEach(() => h.shutdown())

const wall = async (id: string, text = 'Go usage limit exceeded') => {
  await h.wait(null, id, 2000, 20000)
  await h.type(null, id, `printf '${text}\\n'`)
  await h.wait(null, id, 1000)
}
const seat = () => h.create({ label: 'Security', cli: 'opencode', cwd: home, grade: 0, model: 'opencode-go/glm-5.3-flash' })

// world, security-4b01, 2026-11-02: three Go walls, each only logged, then the seat sat blocked until killed.
it('a seat that walls on one OpenCode provider moves to a model on another, and keeps its task', async () => {
  const a = seat()
  ;(h as any).entry(a.id).info.brief = 'TASK: review the MCP server. ' + 'x'.repeat(200)
  await wall(a.id)
  const acted = await h.heal(Date.now() + 30_000, false)
  expect(acted.map(x => x.id)).toEqual([a.id])
  const now = h.list().find(n => n.id === a.id)!
  expect(now.cli).toBe('opencode')
  expect(now.model).toBe('opencode/big-pickle')
  expect(modelProvider(now.model)).not.toBe('opencode-go')
  expect(h.recentActions().find(x => x.action === 'quota_route')?.args).toMatchObject({ fromModel: 'opencode-go/glm-5.3-flash', toCli: 'opencode' })
  expect((h as any).quotaOutUntil.opencode).toBeUndefined()   // only Go walled; the pool is not out
  expect((h as any).entry(a.id).info.blocked).toBeUndefined()
}, 30_000)

it('when every OpenCode provider has walled it goes to a paid CLI with room, and is not killed', async () => {
  const a = seat()
  for (const p of ['opencode', 'omniroute', 'openrouter']) (h as any).providerOutUntil[p] = Date.now() + 3600_000
  await wall(a.id)
  await h.heal(Date.now() + 30_000, false)
  expect(h.list().find(n => n.id === a.id)).toMatchObject({ cli: 'claude', grade: 1 })
}, 30_000)

it('with nothing left the org pauses until the first reset instead of churning or killing seats', async () => {
  const a = seat()
  for (const p of ['opencode', 'omniroute', 'openrouter']) (h as any).providerOutUntil[p] = Date.now() + 3600_000
  ;(h as any).quotaOutUntil = { claude: Date.now() + 3600_000, codex: Date.now() + 3600_000 }
  await wall(a.id)
  await h.heal(Date.now() + 30_000, false)
  expect((h as any).paused?.reason).toMatch(/every model pool/)
  expect(h.recentActions().some(x => x.action === 'pools_out')).toBe(true)
}, 30_000)

it('reads the Go wording as a quota wall', () => {
  const s = { label: 'S', cli: 'opencode' as const, screen: 'Error: Go usage limit reached for this period\n', quietMs: 60_000, exitCode: null, hasLead: true }
  expect(diagnose(s)?.issue).toBe('quota')
})
