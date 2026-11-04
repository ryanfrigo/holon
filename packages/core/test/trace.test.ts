import { expect, it } from 'vitest'
import { existsSync, mkdtempSync, readFileSync, readdirSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Holon } from '../src/holon.ts'

it('records screens on change (secrets scrubbed), actions, org shape and a manifest', async () => {
  const home = mkdtempSync(join(tmpdir(), 'holon-'))
  const h = new Holon({ home, socketPath: join(home, 's'), mcpEntry: '/dev/null' })
  const dir = h.create({ label: 'Director', cli: 'shell', cwd: home, lead: true })
  ;(h as any).openKb(home)
  ;(h as any).directive = { text: 'trace me', workspace: home, directorId: dir.id, goals: [], deliverables: [], status: 'running', startedAt: '2026-10-21T10:00:00Z' }
  ;(h as any).trace = (await import('../src/trace.ts')).Trace.forRun(home, home, '2026-10-21T10:00:00Z')
  await h.wait(null, dir.id, 1500, 20000)
  await h.type(null, dir.id, 'echo STRIPE_SECRET_KEY=' + 'sk_live' + '_abcdefghijklmnop999')
  await h.wait(null, dir.id, 1000)
  expect(h.snapshotScreens()).toBe(1)
  expect(h.snapshotScreens()).toBe(0)                 // unchanged: nothing new written
  h.update(dir.id, 'shipped')
  h.spawn(dir.id, { label: 'B', cli: 'shell', cwd: home })
  const t = h.traceDir()!
  const term = readFileSync(join(t, 'terminals', readdirSync(join(t, 'terminals'))[0]), 'utf8')
  expect(term).toContain('[secret]')
  expect(term).not.toContain('abcdefghijklmnop999')
  expect(readFileSync(join(t, 'actions.jsonl'), 'utf8')).toContain('"update"')
  expect(readdirSync(join(t, 'org')).length).toBeGreaterThan(0)
  const m = JSON.parse(readFileSync(join(t, 'manifest.json'), 'utf8'))
  expect(m.directive).toBe('trace me')
  expect(m.terminals.map((x: { label: string }) => x.label)).toEqual(['Director', 'B'])
  expect(existsSync(t)).toBe(true)
  h.shutdown()
})
