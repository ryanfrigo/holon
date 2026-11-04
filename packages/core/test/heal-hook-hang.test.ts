import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Holon } from '../src/holon.ts'
import { diagnose, hookHang, HOOK_HANG_MS, type Seen } from '../src/watcher.ts'

// Screen shapes copied from a live trace of fix-spend-accounting-416b / Engineering-b37f, 2026-11-02:
// the status line sits above the prompt box, and the timer is the whole turn's.
const SCREEN = (line: string) => [
  '  src/jobs/decide.py cli.py 2>/dev/null; ls tests | head -50', '', '', '', '', '',
  line, '',
  '─'.repeat(100), '❯ ', '─'.repeat(100),
  '  Haiku 5.5 │ fix-spend-accounting-416b ░░░░░░░░░░ 6%',
  '  ⏵⏵ auto mode on (shift+tab to cycle) · ← 1 agent',
].join('\n')
const PRE = '✻ Kneading… (running PreToolUse hook · 15m 58s · ↓ 374 tokens · thought for 1s)'
const POST = '✢ Leavening… (running PostToolUse hook · 1h 14m 1s · ↓ 2.9k tokens)'

describe('hook hang rule', () => {
  const seen = (screen: string, hookForMs?: number): Seen => ({ label: 'builder', cli: 'claude', screen, quietMs: 0, exitCode: null, hasLead: true, hookForMs })
  it('reads the hook and the status line off real screens', () => {
    expect(hookHang(SCREEN(PRE))).toMatchObject({ hook: 'PreToolUse' })
    expect(hookHang(SCREEN(POST))).toMatchObject({ hook: 'PostToolUse' })
    expect(hookHang(SCREEN('✻ Kneading… (49s · ↓ 1.2k tokens)'))).toBeNull()
  })
  it('only fires once the same hook line has been on screen for 90 seconds', () => {
    expect(diagnose(seen(SCREEN(PRE)))).toBeNull()
    expect(HOOK_HANG_MS).toBe(90_000)
    expect(diagnose(seen(SCREEN(PRE), HOOK_HANG_MS - 1))).toBeNull()
    expect(diagnose(seen(SCREEN(PRE), HOOK_HANG_MS))).toMatchObject({ issue: 'hook-hang', press: ['Escape'] })
    expect(diagnose({ ...seen(SCREEN(PRE), HOOK_HANG_MS), cli: 'codex' })).toBeNull()
  })
})

describe('healing a seat stuck in a hook', () => {
  let home: string
  let h: InstanceType<typeof Holon>
  beforeEach(() => { home = mkdtempSync(join(tmpdir(), 'holon-')); h = new Holon({ home, socketPath: join(home, 'holon.sock'), mcpEntry: '/dev/null' }) })
  afterEach(() => h.shutdown())

  it('interrupts it, tells it to carry on, and tells its lead when it keeps happening', async () => {
    const lead = h.create({ label: 'Lead', cli: 'claude', cwd: home, lead: true })
    const b = h.create({ label: 'Builder', cli: 'claude', cwd: home, parentId: lead.id })
    await h.wait(null, b.id, 2000, 20000)
    const e = (h as any).entry(b.id)
    const keys: string[] = [], typed: string[] = []
    e.term.press = (k: string) => { keys.push(k) }
    const type0 = e.term.type.bind(e.term)
    e.term.type = (s: string) => { typed.push(s); return type0(s) }
    const leadTyped: string[] = []
    const le = (h as any).entry(lead.id)
    const lt0 = le.term.type.bind(le.term)
    le.term.type = (s: string) => { leadTyped.push(s); return lt0(s) }
    await h.type(null, b.id, `printf '%s\\n' '${PRE}'`)
    await h.wait(null, b.id, 1000)
    const t0 = Date.now()
    expect(await h.heal(t0, false)).toEqual([])                       // first sighting: a hook can run for a moment
    expect(await h.heal(t0 + 60_000, false)).toEqual([])             // under 90 s: still not a hang
    const acted = await h.heal(t0 + 2 * 60_000, false)                // still there past 90 s: hung
    expect(acted.map(a => a.finding.issue)).toEqual(['hook-hang'])
    expect(keys).toEqual(['Escape'])
    expect(typed.some(s => /hook hung your last turn/.test(s))).toBe(true)
    const log = h.recentActions().find(a => a.action === 'heal' && a.target === b.id)!
    expect(String(log.args.screen)).toMatch(/running PreToolUse hook · 15m 58s/)
    // It hangs again, twice more inside the hour: the lead hears about it.
    for (const at of [11, 17]) {
      await h.heal(t0 + at * 60_000 - 5 * 60_000, false)
      await h.heal(t0 + at * 60_000, false)
    }
    expect(keys.length).toBe(3)
    expect(leadTyped.some(s => /hooks have hung 3 times/.test(s))).toBe(true)
  }, 40_000)
})
