import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { mkdtempSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Holon } from '../src/holon.ts'
import { redact, redactJson } from '../src/watcher.ts'

describe('redact() and redactJson()', () => {
  it('redact scrubs fake key strings at runtime', () => {
    const fakeKey = 'sk-' + 'a'.repeat(30)
    const text = `My key is ${fakeKey} and also STRIPE_SECRET_KEY=${fakeKey}`
    const out = redact(text)
    expect(out).not.toContain(fakeKey)
    expect(out).toContain('[secret]')
  })

  it('redactJson deep-walks objects and arrays', () => {
    const fakeKey = 'sk-' + 'a'.repeat(30)
    const input = {
      message: fakeKey,
      nested: { token: fakeKey },
      list: [fakeKey, { inner: fakeKey }],
      number: 42,
      bool: true,
      nullish: null,
    }
    const out = redactJson(input)
    expect(out).toEqual({
      message: '[secret]',
      nested: { token: '[secret]' },
      list: ['[secret]', { inner: '[secret]' }],
      number: 42,
      bool: true,
      nullish: null,
    })
    // keys unchanged
    expect(Object.keys(out)).toEqual(['message', 'nested', 'list', 'number', 'bool', 'nullish'])
  })
})

describe('Secrets redacted at every persisted sink', () => {
  let home: string
  let h: Holon
  let fakeKey: string

  beforeEach(() => {
    home = mkdtempSync(join(tmpdir(), 'holon-secrets-'))
    h = new Holon({ home, socketPath: join(home, 'holon.sock'), mcpEntry: '/dev/null' })
    fakeKey = 'sk-' + 'a'.repeat(30)
  })
  afterEach(() => h.shutdown())

  it('actions.jsonl (global) has no secret', async () => {
    const dir = h.create({ label: 'Director', cli: 'shell', cwd: home })
    ;(h as any).directive = { text: 't', workspace: home, directorId: dir.id, goals: [], deliverables: [], status: 'running', startedAt: '' }
    await h.wait(null, dir.id, 2000, 20000)
    await h.type(null, dir.id, `echo MY_KEY=${fakeKey}`)
    await h.wait(null, dir.id, 1000)

    const actions = readFileSync(join(home, 'actions.jsonl'), 'utf8')
    expect(actions).not.toContain(fakeKey)
    expect(actions).toContain('[secret]')
  })

  it('trace actions.jsonl has no secret', async () => {
    const dir = h.create({ label: 'Director', cli: 'shell', cwd: home })
    ;(h as any).openKb(home)
    ;(h as any).directive = { text: 'trace me', workspace: home, directorId: dir.id, goals: [], deliverables: [], status: 'running', startedAt: '2026-10-21T10:00:00Z' }
    const { Trace } = await import('../src/trace.ts')
    ;(h as any).trace = Trace.forRun(home, home, '2026-10-21T10:00:00Z')
    await h.wait(null, dir.id, 2000, 20000)
    await h.type(null, dir.id, `echo MY_KEY=${fakeKey}`)
    await h.wait(null, dir.id, 1000)

    const t = h.traceDir()!
    const traceActions = readFileSync(join(t, 'actions.jsonl'), 'utf8')
    expect(traceActions).not.toContain(fakeKey)
    expect(traceActions).toContain('[secret]')
  })

  it('escalations.json has no secret', async () => {
    const dir = h.create({ label: 'Director', cli: 'shell', cwd: home })
    ;(h as any).directive = { text: 't', workspace: home, directorId: dir.id, goals: [], deliverables: [], status: 'running', startedAt: '' }
    await h.wait(null, dir.id, 2000, 20000)
    const pending = h.escalate(dir.id, `need ${fakeKey}`)
    h.answer(null, h.listEscalations()[0].id, 'ok')
    await pending

    const esc = readFileSync(join(home, 'escalations.json'), 'utf8')
    expect(esc).not.toContain(fakeKey)
    expect(esc).toContain('[secret]')
  })

  it('directive.json has no secret', async () => {
    const dir = h.create({ label: 'Director', cli: 'shell', cwd: home })
    ;(h as any).openKb(home)
    ;(h as any).directive = { text: 't', workspace: home, directorId: dir.id, goals: [`API key: ${fakeKey}`], deliverables: [], status: 'running', startedAt: '' }
    await h.wait(null, dir.id, 2000, 20000)
    ;(h as any).saveDirective()

    const dirJson = readFileSync(join(home, 'directive.json'), 'utf8')
    expect(dirJson).not.toContain(fakeKey)
    expect(dirJson).toContain('[secret]')
  })
})
it.each([
  ['export X_TOKEN=abc', 'export X_TOKEN=[secret]'],
  ['curl --api-key=abcd1234efgh', 'curl --api-key=[secret]'],   // gitleaks:allow secret-scan:allow
  ['{"access_token": "abcd1234efgh"}', '{"access_token": "[secret]"}'],   // gitleaks:allow secret-scan:allow
  ['{"apiKey":"abcd1234efgh"}', '{"apiKey":"[secret]"}'],   // gitleaks:allow secret-scan:allow
  ['-H "x-api-key: abc123"', '-H "x-api-key: [secret]"'],
  ['Authorization: Basic dXNlcjpwYXNz', 'Authorization: Basic [secret]'],
  ['Cookie: session=abc; other=def', 'Cookie: [secret]'],
  ['key lin_api_abcdefghijklmnop1234', 'key [secret]'],
  ['id GOCSPX-abcdefghijklmnop1234', 'id [secret]'],
])('redacts %s', (line, want) => { expect(redact(line)).toBe(want) })

it('leaves ordinary text about these things alone', () => {
  for (const line of ['the cookie banner is fixed', 'export FOO=bar', '{"title": "a token of thanks"}', 'run --help for flags']) expect(redact(line)).toBe(line)
})
