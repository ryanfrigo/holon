import { afterEach, beforeEach, expect, it } from 'vitest'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { DEFAULT_SETTINGS, mergeSettings, modelProvider, place } from '../src/org.ts'
import { Holon } from '../src/holon.ts'

let home: string
beforeEach(() => { home = mkdtempSync(join(tmpdir(), 'holon-')) })
afterEach(() => h?.shutdown())
let h!: Holon

const bothPools = mergeSettings(DEFAULT_SETTINGS, { freePools: { opencode: true, omniroute: true, openrouter: false } })

it('place keeps G0 off a walled provider unless every free pool is out', () => {
  const out = (p: string) => p === 'omniroute'
  const turns = [0, 1, 2, 3, 4, 5, 6].map(t => place(0, 'claude', bothPools, t, out).model!)
  expect(turns.every(m => modelProvider(m) !== 'omniroute')).toBe(true)
  // Every pool out is no worse than a paid G1: it still returns a model.
  const allOut = place(0, 'claude', bothPools, 0, () => true)
  expect(allOut.model).toBeTruthy()
  expect(allOut.grade).toBe(0)
})

it('a dead local gateway walls omniroute, so new G0 seats never land on it', async () => {
  h = new Holon({ home, socketPath: join(home, 'holon.sock'), mcpEntry: '/dev/null', gatewayUp: async () => false })
  h.setSettings({ freePools: { opencode: true, omniroute: true, openrouter: false } })
  const dir = h.create({ label: 'Director', cli: 'claude', cwd: home, lead: true })
  await h.heal(Date.now(), false)
  expect(h.recentActions().find(a => a.action === 'gateway_down')?.args).toMatchObject({ host: '127.0.0.1', port: 20128 })
  const models = [0, 1, 2, 3].map(i => h.spawn(dir.id, { label: `B${i}`, cli: 'claude', cwd: home, grade: 0 }).model)
  expect(models.every(m => !m!.startsWith('omniroute/'))).toBe(true)
})

it('a live gateway clears the wall and logs nothing new on the next look', async () => {
  h = new Holon({ home, socketPath: join(home, 'holon.sock'), mcpEntry: '/dev/null', gatewayUp: async () => true })
  h.setSettings({ freePools: { opencode: true, omniroute: true, openrouter: false } })
  await h.heal(Date.now(), false)
  expect(h.recentActions().find(a => a.action === 'gateway_down')).toBeUndefined()
  expect((h as any).providerOutUntil.omniroute).toBeUndefined()
})
