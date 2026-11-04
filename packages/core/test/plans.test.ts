import { describe, expect, it } from 'vitest'
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { claudeKeychain, codexPlan, freePlan, goPlan, opencodeSpend, weekSurplus } from '../src/plans.ts'

it('reads Codex limits from the newest session log', () => {
  const dir = mkdtempSync(join(tmpdir(), 'codex-'))
  mkdirSync(join(dir, '2026', '10', '21'), { recursive: true })
  const rl = { primary: { used_percent: 42, window_minutes: 300, resets_at: Math.floor(Date.now() / 1000) + 3600 }, secondary: { used_percent: 22, window_minutes: 10080 }, plan_type: 'plus' }
  writeFileSync(join(dir, '2026', '10', '21', 'rollout-a.jsonl'), JSON.stringify({ type: 'event_msg', payload: { type: 'token_count', rate_limits: rl } }) + '\n')
  const p = codexPlan(dir)
  expect(p).toMatchObject({ provider: 'Codex', plan: 'plus' })
  expect(p.bars.map(b => [b.label, b.usedPct])).toEqual([['5-hour', 42], ['week', 22]])
  // The 5-hour window reset after the log was written: it reads empty, not 42%.
  const stale = { ...rl, primary: { ...rl.primary, resets_at: Math.floor(Date.now() / 1000) - 60 } }
  writeFileSync(join(dir, '2026', '10', '21', 'rollout-b.jsonl'), JSON.stringify({ type: 'event_msg', payload: { type: 'token_count', rate_limits: stale } }) + '\n')
  expect(codexPlan(dir).bars.map(b => [b.label, b.usedPct, b.resetsAt])).toEqual([['5-hour', 0, undefined], ['week', 22, undefined]])
  expect(codexPlan(join(dir, 'none')).error).toBe('no recent sessions')
})

describe('OpenCode Go Plus and free inference, from the OpenCode database', () => {
  it('sums each model over the 5h, week and month windows and shows the tightest one against its allowance', async () => {
    const { DatabaseSync } = await import('node:sqlite')
    const file = join(mkdtempSync(join(tmpdir(), 'oc-')), 'opencode.db')
    const db = new DatabaseSync(file)
    db.exec("create table session_message (id text, session_id text, type text, seq integer, time_created integer, time_updated integer, data text)")
    const at = Date.parse('2026-10-27T20:00:00Z')
    const add = (hoursAgo: number, provider: string, model: string, cost: number, tokens = 1000) =>
      db.prepare("insert into session_message values (?, 's', 'assistant', 0, ?, 0, ?)").run(String(Math.random()), at - hoursAgo * 3600_000,
        JSON.stringify({ model: { id: model, providerID: provider }, cost, tokens: { input: tokens, output: 0, reasoning: 0, cache: { read: 0, write: 0 } } }))
    add(1, 'opencode-go', 'kimi-k3', 6)        // 5h: $6 of $12
    add(48, 'opencode-go', 'kimi-k3', 24)      // week: $30 of $30
    add(20 * 24, 'opencode-go', 'kimi-k3', 10) // month only
    add(2, 'opencode-go', 'glm-5.3-flash', 1)
    add(3, 'opencode', 'big-pickle', 0, 5_000_000)
    add(3, 'openrouter', 'nvidia/nemotron-3-ultra-550b-a55b:free', 0, 2_000_000)
    add(3, 'omniroute', 'free-coding', 0, 1_000_000)
    add(3, 'anthropic', 'claude-x', 0)   // a provider outside both cards
    db.close()
    const spend = await opencodeSpend(at, file)
    expect(spend.find(s => s.model === 'kimi-k3')!.cost).toEqual({ h5: 6, d7: 30, d30: 40 })
    const go = goPlan(spend)
    expect(go.bars[0]).toEqual({ label: 'kimi-k3 · week $30.00 of $30', usedPct: 100 })
    expect(go.plan).toBe('$31.00 in 7d · 0.0M tokens')
    const free = freePlan(spend)
    expect(free.plan).toBe('8.0M tokens in 7d')
    expect(free.note).toMatch(/^opencode 5\.0M · openrouter 2\.0M · omniroute 1\.0M/)
  })
})

describe('claudeKeychain', () => {
  it('keeps the keychain tool quiet and answers null when the item is missing', () => {
    let opts: any
    const exec = ((_c: string, _a: string[], o: any) => { opts = o; throw new Error('security: item could not be found') }) as any
    expect(claudeKeychain(exec)).toBeNull()
    expect(opts.stdio[2]).toBe('ignore')   // inherited stderr put "security: SecKeychainSearchCopyNext..." in every daemon log
  })
  it('returns the stored secret trimmed', () => {
    expect(claudeKeychain((() => '{"a":1}\n') as any)).toBe('{"a":1}')
  })
})

describe('weekSurplus', () => {
  const t = Date.parse('2026-11-02T19:00:00Z')
  const at = (bars: object[]) => { const f = join(mkdtempSync(join(tmpdir(), 'surplus-')), 'claude-plan.json'); writeFileSync(f, JSON.stringify({ plan: { bars } })); return f }
  const week = { label: 'week', usedPct: 52, resetsAt: '2026-11-03T19:00:00Z' }
  it('reports unused week close to its reset', () => expect(weekSurplus(at([week]), t)).toEqual({ unusedPct: 48, hoursLeft: 24 }))
  it('is null while the 5-hour window is nearly spent', () => expect(weekSurplus(at([week, { label: '5-hour', usedPct: 95 }]), t)).toBeNull())
  it('is null when the reset is days away or little is left', () => {
    expect(weekSurplus(at([{ ...week, resetsAt: '2026-11-06T19:00:00Z' }]), t)).toBeNull()
    expect(weekSurplus(at([{ ...week, usedPct: 85 }]), t)).toBeNull()
  })
})
