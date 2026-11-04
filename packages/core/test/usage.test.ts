import { describe, expect, it } from 'vitest'
import { mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { claim, claudeUsage, codexUsage, opencodeSessions, total } from '../src/usage.ts'

it('sums Claude usage once per message id and prices it by model', () => {
  const dir = mkdtempSync(join(tmpdir(), 'usage-'))
  const f = join(dir, 's.jsonl')
  const line = (id: string, model: string) => JSON.stringify({ type: 'assistant', message: { id, model, usage: { input_tokens: 1000, output_tokens: 1000, cache_read_input_tokens: 1000, cache_creation_input_tokens: 0 } } })
  writeFileSync(f, [line('m1', 'claude-opus-5-5'), line('m1', 'claude-opus-5-5'), line('m2', 'claude-sonnet-5-5')].join('\n'))
  const u = claudeUsage(f)
  expect(total(u)).toBe(6000)                                   // m1 counted once
  expect(u.costUsd).toBeCloseTo((1000 * 4 + 1000 * 20 + 1000 * 0.2 + 1000 * 2 + 1000 * 10 + 1000 * 0.2) / 1e6)
})

it('matches each terminal to the first unclaimed session in its directory', () => {
  const s = [{ file: 'a', cwd: '/w', start: 1000 }, { file: 'b', cwd: '/w', start: 2000 }, { file: 'c', cwd: '/x', start: 1500 }]
  const claimed = new Set<string>()
  const first = claim(s, '/w', 900, claimed)!; claimed.add(first.file)
  const second = claim(s, '/w', 900, claimed)!
  expect([first.file, second.file]).toEqual(['a', 'b'])
})

describe('opencode sessions', () => {
  it('reads OpenCode 2.x session_v2 as well as the older session table, each id once', async () => {
    const { DatabaseSync } = await import('node:sqlite')
    const dir = mkdtempSync(join(tmpdir(), 'oc-'))
    const file = join(dir, 'opencode.db')
    const db = new DatabaseSync(file)
    const cols = 'id text, directory text, time_created integer, cost real, tokens_input integer, tokens_output integer, tokens_reasoning integer, tokens_cache_read integer, tokens_cache_write integer, model text'
    db.exec(`create table session (${cols}); create table session_v2 (${cols})`)
    const add = (t: string, id: string, provider: string, cost: number) =>
      db.prepare(`insert into ${t} values (?, '/w', 2000, ?, 100, 10, 0, 50, 0, ?)`).run(id, cost, JSON.stringify({ id: 'kimi-k3', providerID: provider }))
    add('session', 'ses_old', 'opencode', 0)
    add('session', 'ses_both', 'opencode', 0)
    add('session_v2', 'ses_both', 'opencode-go', 0.5)
    add('session_v2', 'ses_new', 'opencode-go', 1.25)
    db.close()
    const rows = await opencodeSessions(1000, file)
    expect(rows.map(r => [r.file.split('#')[1], r.model, r.usage.costUsd]).sort()).toEqual([
      ['ses_both', 'opencode-go/kimi-k3', 0.5], ['ses_new', 'opencode-go/kimi-k3', 1.25], ['ses_old', 'opencode/kimi-k3', 0]])
  })
})

describe('Codex pricing', () => {
  const session = () => {
    const home = mkdtempSync(join(tmpdir(), 'codex-usage-'))
    const file = join(home, 'session.jsonl')
    const event = (input: number) => JSON.stringify({ type: 'event_msg', payload: { info: { total_token_usage: {
      input_tokens: input, cached_input_tokens: 400, output_tokens: 200, reasoning_output_tokens: 0,
    } } } })
    writeFileSync(file, [event(500), event(1000)].join('\n'))
    return { home, file }
  }

  it.each([
    ['gpt-6-astra', 0.0164],
    ['gpt-6-luna', 0.000164],
  ])('prices %s with default rates', (model, cost) => {
    const { home, file } = session()
    const u = codexUsage(file, home, model)
    expect(u).toMatchObject({ input: 600, cacheRead: 400, output: 200 })
    expect(u.costUsd).toBeCloseTo(cost, 8)
  })

  it.each([{ in: 2, out: 3, read: 0.5 }, { in: 2, out: 3 }])('lets prices.json override defaults: %j', rates => {
    const { home, file } = session()
    writeFileSync(join(home, 'prices.json'), JSON.stringify({ 'gpt-6-astra': rates }))
    expect(codexUsage(file, home, 'gpt-6-astra').costUsd)
      .toBeCloseTo((600 * 2 + 200 * 3 + 400 * (rates.read ?? rates.in)) / 1e6, 8)
  })

  it('leaves an unknown model cost null', () => {
    const { home, file } = session()
    expect(codexUsage(file, home, 'unknown-model').costUsd).toBeNull()
  })
})

it('reads only what a growing transcript added, and starts over when it shrinks', async () => {
  const { appendFileSync } = await import('node:fs')
  const f = join(mkdtempSync(join(tmpdir(), 'usage-')), 's.jsonl')
  const line = (id: string) => JSON.stringify({ type: 'assistant', message: { id, model: 'claude-opus-5-5', usage: { input_tokens: 10, output_tokens: 0, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 } } })
  writeFileSync(f, line('a') + '\n')
  expect(total(claudeUsage(f))).toBe(10)
  appendFileSync(f, line('b') + '\n' + line('b') + '\n' + line('c').slice(0, 20))
  expect(total(claudeUsage(f))).toBe(20)                        // b once; the half-written c waits
  appendFileSync(f, line('c').slice(20) + '\n')
  expect(total(claudeUsage(f))).toBe(30)
  writeFileSync(f, line('z') + '\n')
  expect(total(claudeUsage(f))).toBe(10)
})
