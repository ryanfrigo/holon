import { afterEach, beforeEach, expect, it } from 'vitest'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { goLimit } from '../src/plans.ts'
import { Holon } from '../src/holon.ts'
import type { Plan } from '../src/plans.ts'

let dir: string
beforeEach(() => { dir = mkdtempSync(join(tmpdir(), 'oc-')) })

// The shape OpenCode 2.x stores for a request Go refused (2026-10-28, its own database).
const refused = (at: number, retryAfterMs: number, limitName = 'weekly') => JSON.stringify({
  time: { created: at }, outcome: 'failed',
  error: { type: 'provider.quota', message: 'Go usage limit exceeded', status: 429,
    response: { body: JSON.stringify({ type: 'error', error: { type: 'GoUsageLimitError', message: 'Go usage limit exceeded' }, metadata: { limitName } }) },
    retryAfterMs },
})

const db = (rows: [number, string, string][]) => {
  const file = join(dir, 'opencode.db')
  const d = new DatabaseSync(file)
  d.exec('create table session_message (id text, session_id text, type text, seq int, time_created int, time_updated int, data text)')
  for (const [t, type, data] of rows) d.prepare('insert into session_message values (?, ?, ?, 0, ?, ?, ?)').run(String(t), 's', type, t, t, data)
  d.close()
  return file
}

it('reads when Go lets requests through again from the last refusal it recorded', async () => {
  const at = Date.parse('2026-10-28T23:14:37Z')
  const file = db([[at - 60_000, 'idle', refused(at - 60_000, 1000)], [at, 'idle', refused(at, 348_323_000)], [at + 5, 'assistant', '{}']])
  expect(await goLimit(at + 1000, file)).toEqual({ limitName: 'weekly', resetsAt: new Date(at + 348_323_000).toISOString() })
  expect(await goLimit(at + 348_323_001, file)).toBeNull()        // that window has passed
})

it('has no limit when nothing was refused', async () => {
  expect(await goLimit(Date.now(), db([[Date.now(), 'idle', '{"outcome":"ok"}']]))).toBeNull()
  expect(await goLimit(Date.now(), join(dir, 'missing.db'))).toBeNull()
})

it('an org walled on Go waits for Go\'s own reset, not the hourly retry', async () => {
  const home = mkdtempSync(join(tmpdir(), 'holon-'))
  const now = Date.now() + 30_000
  const reset = new Date(now + 96 * 3600_000).toISOString()
  const plans: Plan[] = [{ provider: 'OpenCode Go Plus', bars: [{ label: 'weekly limit', usedPct: 100, resetsAt: reset }], checkedAt: '' }]
  const h = new Holon({ home, socketPath: join(home, 'holon.sock'), mcpEntry: '/dev/null', plans: async () => plans })
  try {
    h.setSettings({ opencodeGo: true })
    // nothing else to move to: the free OpenCode models and both paid CLIs are out too
    ;(h as any).providerOutUntil.opencode = now + 3600_000
    ;(h as any).quotaOutUntil = { claude: now + 3600_000, codex: now + 3600_000 }
    const eng = h.create({ label: 'Eng', cli: 'opencode', cwd: home, grade: 0 })
    await h.wait(null, eng.id, 2000, 20000)
    await h.type(null, eng.id, "printf 'Error: Go usage limit exceeded\\n'")
    await h.wait(null, eng.id, 1000)
    await h.heal(now, false)
    expect(h.paused).toMatchObject({ until: reset })
  } finally { h.shutdown() }
})

afterEach(() => {})
