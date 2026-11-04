import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { mkdtempSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

vi.mock('../src/watcher.ts', async orig => ({
  ...(await orig<typeof import('../src/watcher.ts')>()),
  classify: vi.fn(async () => ({ issue: 'model:odd-wall', summary: 'it is walled', notify: 'it is walled' })),
}))
const { Holon } = await import('../src/holon.ts')

let home: string
let h: InstanceType<typeof Holon>
beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), 'holon-'))
  h = new Holon({ home, socketPath: join(home, 'holon.sock'), mcpEntry: '/dev/null' })
})
afterEach(() => h.shutdown())

it('a classifier-only finding logs the redacted last screen lines, so a rule can be written from them', async () => {
  const fakeKey = 'sk-' + 'a'.repeat(30)
  const eng = h.create({ label: 'Eng', cli: 'opencode', cwd: home, grade: 0 })
  await h.wait(null, eng.id, 2000, 20000)
  await h.type(null, eng.id, `printf 'error: Go quota wall for ${fakeKey}\\n'`)
  await h.wait(null, eng.id, 1000)
  await h.heal(Date.now() + 11 * 60_000, true)
  const heal = h.recentActions().find(a => a.action === 'heal' && a.target === eng.id)!
  expect(heal.args.issue).toBe('model:odd-wall')
  expect(String(heal.args.screen)).toMatch(/Go quota wall/)
  expect(String(heal.args.screen).length).toBeLessThanOrEqual(1500)
  const onDisk = readFileSync(join(home, 'actions.jsonl'), 'utf8')
  expect(onDisk).toMatch(/Go quota wall/)
  expect(onDisk).not.toContain(fakeKey)
}, 30_000)
