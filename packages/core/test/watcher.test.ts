import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Holon } from '../src/holon.ts'
import { Terminal } from '../src/terminal.ts'
import { chainBase, chattyHeads, credentialHunt, diagnose, promptOn, redact, suspicious, type Seen } from '../src/watcher.ts'

const seen = (screen: string, over: Partial<Seen> = {}): Seen => ({ label: 'b1', cli: 'codex', screen, quietMs: 0, exitCode: null, hasLead: true, ...over })

it('scrubs credentials before a screen leaves the machine', () => {
  const out = redact('key sk-live-abcdefghijklmnop123 and\nSTRIPE_SECRET_KEY=whsec_123456\nghp_abcdefghijklmnopqrst ok')
  expect(out).not.toMatch(/abcdefghijklmnop123|whsec_123456|ghp_abcdef/)
  expect(out).toContain('STRIPE_SECRET_KEY=[secret]')
})

it('recognizes the failures that kept orgs stuck', () => {
  expect(diagnose(seen('Update available · 0.157 → 0.163\n1. Update now\n2. Skip'))?.press).toEqual(['Down', 'Enter'])
  expect(diagnose(seen('■ You’ve hit your usage limit. Upgrade to Pro', { quietMs: 30_000 }))?.issue).toBe('quota')
  expect(diagnose(seen('■ You’ve hit your usage limit.', { quietMs: 1000 }))).toBeNull()            // still moving
  const quoting = ['⏺ The Codex reviewer said "You’ve hit your usage limit", so I failed over.', ...Array(15).fill('more work'), '❯ ']
  expect(diagnose(seen(quoting.join('\n'), { quietMs: 60_000 }))).toBeNull()                         // quoted, not blocked
  expect(diagnose(seen('bye', { exitCode: 1 }))?.issue).toBe('crashed')
  expect(diagnose(seen('bye', { exitCode: 129 }))).toBeNull()               // killed on purpose
  expect(diagnose(seen('Do you want to proceed?\n❯ 1. Yes', { quietMs: 6 * 60_000 }))?.issue).toBe('stuck-prompt')
  expect(diagnose(seen('Do you want to proceed?', { quietMs: 30_000 }))).toBeNull()  // give the lead time
  expect(diagnose(seen('⏺ Your message looks cut off. It starts mid-sentence'))?.issue).toBe('truncated-brief')
  expect(diagnose(seen('✻ Worked for 3m · done 1:00 PM'))).toBeNull()
  const dropped = "⎿ API Error: Can't reach the API server — check your internet or DNS (ENOTFOUND)\n❯ "
  expect(diagnose(seen(dropped, { quietMs: 2 * 60_000 }))?.type).toMatch(/Carry on/)
  expect(diagnose(seen('⎿ API Error: Your computer went to sleep mid-response.', { quietMs: 2 * 60_000 }))?.issue).toBe('api-dropped')
  expect(diagnose(seen(dropped, { quietMs: 10_000 }))).toBeNull()                    // it may retry by itself
  expect(diagnose(seen('⎿ API Error: 400 too many total text bytes', { quietMs: 2 * 60_000 }))?.issue).not.toBe('api-dropped')
})

it('quota strings in passing output are not quota', () => {
  const passing = '✓ routes a spawn off a vendor whose pool is out of quota'
  expect(diagnose(seen(passing, { cli: 'shell', quietMs: 30_000 }))).toBeNull()
  expect(diagnose(seen(passing, { quietMs: 30_000 }))).toBeNull()          // any CLI, passing line
  // A raw banner without a pass marker is still quota, shells included.
  const banner = 'You have hit your usage limit.'
  expect(diagnose(seen(banner, { cli: 'shell', quietMs: 30_000 }))?.issue).toBe('quota')
  expect(diagnose(seen(banner, { quietMs: 30_000 }))?.issue).toBe('quota')
  // The quota bypass still reaches shell crash detection.
  expect(diagnose(seen(passing, { cli: 'shell', exitCode: 1, quietMs: 30_000 }))?.issue).toBe('crashed')
})

it('matches the new free-model quota strings', () => {
  expect(diagnose(seen('Free limit reached', { quietMs: 30_000 }))?.issue).toBe('quota')
  expect(diagnose(seen('Free usage exceeded', { quietMs: 30_000 }))?.issue).toBe('quota')
  expect(diagnose(seen('Error: Go usage limit exceeded', { quietMs: 30_000 }))?.issue).toBe('quota')   // OpenCode Go's 429
  expect(diagnose(seen('Free limit reached', { quietMs: 1000 }))).toBeNull()
  expect(diagnose(seen('free usage exceeded', { quietMs: 30_000 }))?.issue).toBe('quota') // case-insensitive
})

it('only idle screens with error-looking text are worth a model call', () => {
  expect(suspicious(seen('Error: ECONNREFUSED 127.0.0.1:5432', { quietMs: 11 * 60_000 }))).toBe(true)
  expect(suspicious(seen('Error: ECONNREFUSED', { quietMs: 60_000 }))).toBe(false)
  expect(suspicious(seen('all green', { quietMs: 20 * 60_000 }))).toBe(false)
})

it('promptOn reads the permission prompt off the bottom of the screen', () => {
  const prompt = '△ Permission required\nAccess external directory ~/.holon\nAllow once  Allow always  Reject'
  const filler = Array.from({ length: 20 }, (_, i) => `reading file ${i}`)
  const screen = [...filler, prompt].join('\n')
  expect(promptOn(screen)).toBe([...filler.slice(-12), prompt].join('\n'))   // only the last 15 lines, trimmed
  expect(promptOn('$ ls\nREADME\ndriven-by-lead\n$ ')).toBeNull()             // a plain shell prompt
})

it('promptOn ignores "(y/n)" prose higher up the screen than the last 15 lines', () => {
  const prose = '⏺ The deploy step asked (y/n) in its own console, so I answered it there and moved on'
  const filler = Array.from({ length: 15 }, (_, i) => `reading file ${i}`)
  expect(promptOn([prose, ...filler, '❯ '].join('\n'))).toBeNull()            // quoted prose, not a live prompt
})

it('redact pattern 1: AWS secret access key', () => {
  const fake = 'aws_secret_access_key=' + 'a'.repeat(40)
  expect(redact(fake)).toBe('aws_secret_access_key=[secret]')
  expect(redact('AWS_SECRET_ACCESS_KEY = ' + 'b'.repeat(40))).toBe('AWS_SECRET_ACCESS_KEY = [secret]')
})

it('redact pattern 2: GitHub tokens ghs_/ghu_/ghr_ + 30+ chars', () => {
  expect(redact('ghs_' + 'a'.repeat(36))).toBe('[secret]')
  expect(redact('ghu_' + 'b'.repeat(36))).toBe('[secret]')
  expect(redact('ghr_' + 'c'.repeat(36))).toBe('[secret]')
  // existing ghp/gho/github_pat should still work
  expect(redact('ghp_' + 'd'.repeat(36))).toBe('[secret]')
  expect(redact('gho_' + 'e'.repeat(36))).toBe('[secret]')
})

it('redact pattern 3: Slack tokens xox[abpr] + 30+ chars', () => {
  expect(redact('xoxa' + 'a'.repeat(36))).toBe('[secret]')
  expect(redact('xoxb' + 'b'.repeat(36))).toBe('[secret]')
  expect(redact('xoxp' + 'c'.repeat(36))).toBe('[secret]')
  expect(redact('xoxr' + 'd'.repeat(36))).toBe('[secret]')
})

it('redact pattern 4: Stripe webhook whsec_ + 20+ chars', () => {
  expect(redact('whsec_' + 'a'.repeat(24))).toBe('[secret]')
})

it('redact pattern 5: PEM private key block multi-line', () => {
  const pem = `-----BEGIN RSA PRIVATE KEY-----
MIIEowIBAAKCAQEA1234567890abcdef
-----END RSA PRIVATE KEY-----`
  expect(redact(pem)).toBe('[secret]')
  
  const pem2 = `-----BEGIN PRIVATE KEY-----
MIIEvQIBADANBgkqhkiG9w0BAQEFAASCBKcwggSjAgEAAoIBAQD
-----END PRIVATE KEY-----`
  expect(redact(pem2)).toBe('[secret]')
})

it('redact pattern 6: URL credentials scheme://user:pass@host', () => {
  expect(redact('https://user:password123@example.com')).toBe('https://user:[secret]@example.com')
  expect(redact('postgres://admin:secretpass@localhost:5432/db')).toBe('postgres://admin:[secret]@localhost:5432/db')
  expect(redact('ftp://user:pass@host')).toBe('ftp://user:[secret]@host')
  // must NOT change: path-like @ in URL
  expect(redact('http://localhost:3000/foo@bar')).toBe('http://localhost:3000/foo@bar')
})

it('redact pattern 7: Generic assignments password|passwd|secret|token|api_key|apikey', () => {
  expect(redact('password=secretvalue123')).toBe('password=[secret]')
  expect(redact('passwd:secretvalue123')).toBe('passwd:[secret]')
  expect(redact('secret = "secretvalue123"')).toBe('secret = [secret]')
  expect(redact('token: "secretvalue123"')).toBe('token: [secret]')
  expect(redact('api_key=secretvalue123')).toBe('api_key=[secret]')
  expect(redact('apikey: secretvalue123')).toBe('apikey: [secret]')
  expect(redact('API_KEY=secretvalue123')).toBe('API_KEY=[secret]')
  // must change: value contains a digit
  expect(redact('api_key=abcdef1234567890xyz')).toBe('api_key=[secret]')
  // must NOT change: value has no digit
  expect(redact('token: classification-pipeline-fix')).toBe('token: classification-pipeline-fix')
  expect(redact('secret: handling-of-env-files')).toBe('secret: handling-of-env-files')
})

it('must NOT redact lookalikes that are not secrets', () => {
  const diskMsg = 'disk-nearly-full-on-the-org-machine-2026-10-21'
  const pathMsg = '/var/disk-usage-report-2026'
  const taskMsg = 'task-risk-assessment-notes'
  const passwordField = 'the password field is required'
  const url = 'https://example.com/a/b?c=d'
  const gitSha = 'a'.repeat(40)
  const uuid = '550e8400-e29b-41d4-a716-446655440000'
  
  expect(redact(diskMsg)).toBe(diskMsg)
  expect(redact(pathMsg)).toBe(pathMsg)
  expect(redact(taskMsg)).toBe(taskMsg)
  expect(redact(passwordField)).toBe(passwordField)
  expect(redact(url)).toBe(url)
  expect(redact(gitSha)).toBe(gitSha)
  expect(redact(uuid)).toBe(uuid)
})

it('finds the task behind a retry chain, whatever the attempt suffix is', () => {
  expect(chainBase('sec-hunt')).toBe('sec-hunt')
  expect(chainBase('sec-hunt3')).toBe('sec-hunt')
  expect(chainBase('sec-hunt-2')).toBe('sec-hunt')
  expect(chainBase('b-wayfinder-2')).toBe('b-wayfinder')
  expect(chainBase('b-hub-7a01')).toBe('b-hub')
})

it('flags broad credential searches on the last lines of a screen, never prose', () => {
  const hunt = (cmd: string) => credentialHunt(['earlier output', `$ ${cmd}`, '⏺ working', '❯ '].join('\n'))
  for (const cmd of [
    'cat ~/.ssh/id_ed25519', 'find / -name "*.env" 2>/dev/null', 'grep -ri password ~',
    'security find-generic-password -s foo -w', 'printenv | grep -i token', '┃  $ cat ~/.aws/credentials',
    'cat ~/.gemini/oauth_creds.json',
  ]) expect(hunt(cmd), cmd).not.toBeNull()
  for (const cmd of [
    'cat .env.example', 'grep -r token src/', 'cat ~/.config/getacme/mailbox.env', 'ls ~/.ssh',
    'Never run cat ~/.ssh/id_rsa or find / -name .env',
  ]) expect(hunt(cmd), cmd).toBeNull()
  const old = ['$ cat ~/.ssh/id_rsa', ...Array(15).fill('reading file'), '❯ ']
  expect(credentialHunt(old.join('\n'))).toBeNull()                                  // older than the last 15 lines
  expect(credentialHunt('$ cat ~/.netrc')).toBe('$ cat ~/.netrc')
})

it('credentialHunt: the other command shapes, and the ones that only look similar', () => {
  const hunt = (cmd: string) => credentialHunt(`$ ${cmd}`)
  for (const cmd of [
    'less /Users/alex/.docker/config.json', 'scp ~/.ssh/id_rsa host:/tmp', 'base64 ~/.kimi/credentials', 'cp ~/.config/openrouter/key /tmp/k',
    'find ~ -name id_rsa*', 'find $HOME/ -name "*.pem"', 'ls -laR ~ | grep credentials', 'ls -R / | grep .env',
    'rg -i api_key ~', 'grep -rn token $HOME/projects', 'grep --recursive secret /Users', 'security dump-keychain', 'env | grep -i password',
  ]) expect(hunt(cmd), cmd).not.toBeNull()
  for (const cmd of [
    'find . -name "*.env"', 'find /tmp -name "*.pem"', 'ls -R ~ | wc -l', 'ls -R src | grep .env', 'rg token src', 'grep token ~/notes.txt',
    'security find-identity', 'env | sort', 'cat ~/.sshconfig', 'cat ~/.ssh2/id_rsa',
  ]) expect(hunt(cmd), cmd).toBeNull()
})

it('credentialHunt: reports the most recent hunt, trims the line to 160 chars and redacts any key in it', () => {
  const key = 'sk-' + 'b'.repeat(40)
  const out = credentialHunt(['$ cat ~/.ssh/id_rsa', '$ cat ~/.aws/credentials', '❯ '].join('\n'))
  expect(out).toBe('$ cat ~/.aws/credentials')
  const long = credentialHunt(`$ cat ~/.netrc ${'x'.repeat(300)}`)
  expect(long!.length).toBeLessThanOrEqual(160)
  expect(credentialHunt(`$ grep -r ${key} ~ password`)).not.toContain(key)
})

it('counts a head that messages one seat over and over inside 10 minutes', () => {
  const now = Date.UTC(2026, 9, 22, 12, 0, 0)
  const msgs = (n: number, target = 'qa', ageMs = 0) =>
    Array.from({ length: n }, (_, i) => ({ ts: now - ageMs - i * 1000, caller: 'eng', target }))
  expect(chattyHeads(msgs(31), now)).toEqual([{ caller: 'eng', target: 'qa', count: 31 }])   // 31 is over the limit
  expect(chattyHeads(msgs(30), now)).toEqual([])                                          // 30 is not
  expect(chattyHeads(msgs(31, 'qa', 11 * 60_000), now)).toEqual([])                        // older than 10 min
  const edge = [...msgs(30), { ts: now - 10 * 60_000, caller: 'eng', target: 'qa' }]
  expect(chattyHeads(edge, now)).toEqual([{ caller: 'eng', target: 'qa', count: 31 }])     // exactly 10 min old still counts
  expect(chattyHeads([...msgs(20, 'qa'), ...msgs(20, 'ops')], now)).toEqual([])            // two targets, counted apart
  expect(chattyHeads([...msgs(31, 'qa'), ...msgs(31, 'ops')], now)).toHaveLength(2)
})

describe('the chatty-head flag', () => {
  let home: string
  let h: Holon
  beforeEach(() => {
    home = mkdtempSync(join(tmpdir(), 'holon-'))
    h = new Holon({ home, socketPath: join(home, 'holon.sock'), mcpEntry: '/dev/null' })
  })
  afterEach(() => { h.shutdown(); vi.restoreAllMocks() })

  // Every terminal's typing is captured instead of run: the note has to reach one seat only.
  const capture = () => {
    const typed: { term: Terminal; text: string }[] = []
    vi.spyOn(Terminal.prototype, 'type').mockImplementation(async function (this: Terminal, text: string) {
      typed.push({ term: this, text })
    })
    return typed
  }
  const notes = (typed: { term: Terminal; text: string }[]) => typed.filter(t => t.text.includes('Batch status into one message'))

  it('tells the lead once that its head is flooding one seat with messages', async () => {
    const lead = h.create({ label: 'Eng Lead', cli: 'shell', cwd: home, lead: true })
    const head = h.create({ label: 'Engineering', cli: 'shell', cwd: home, parentId: lead.id })
    const seat = h.create({ label: 'QA', cli: 'shell', cwd: home, parentId: lead.id })
    const typed = capture()
    for (let i = 0; i < 31; i++) await h.message(head.id, seat.id, `status ${i}`)
    const flags = h.recentActions().filter(a => a.action === 'chatty-head')
    expect(flags).toHaveLength(1)                                   // once, not once per message
    expect(flags[0].args).toMatchObject({ caller: 'Engineering', target: 'QA', count: 31 })
    expect(notes(typed)).toHaveLength(1)
    expect(notes(typed)[0].text).toContain('Engineering sent 31 messages to QA in 10 min.')
    expect(notes(typed)[0].term).toBe((h as any).entry(lead.id).term)  // the lead is the one told
    expect(h.recentActions().filter(a => a.action === 'message')).toHaveLength(31)   // no message was dropped
  })

  it('says nothing when a head sends a handful of messages', async () => {
    const lead = h.create({ label: 'Eng Lead', cli: 'shell', cwd: home, lead: true })
    const head = h.create({ label: 'Engineering', cli: 'shell', cwd: home, parentId: lead.id })
    const seat = h.create({ label: 'QA', cli: 'shell', cwd: home, parentId: lead.id })
    const typed = capture()
    for (let i = 0; i < 5; i++) await h.message(head.id, seat.id, `status ${i}`)
    expect(h.recentActions().filter(a => a.action === 'chatty-head')).toHaveLength(0)
    expect(notes(typed)).toHaveLength(0)
  })

  it('records the finding but tells nobody when the chatty head has no lead', async () => {
    const director = h.create({ label: 'Director', cli: 'shell', cwd: home, lead: true })
    const seat = h.create({ label: 'QA', cli: 'shell', cwd: home, parentId: director.id })
    const typed = capture()
    for (let i = 0; i < 31; i++) await h.message(director.id, seat.id, `status ${i}`)
    expect(h.recentActions().filter(a => a.action === 'chatty-head')).toHaveLength(1)
    expect(notes(typed)).toHaveLength(0)
  })
})

// Fake secrets, assembled at run time so no token-shaped literal sits in the repo.
it('redact covers the token formats a screen can carry out to a model', () => {
  const r = (n: number, c = 'a1') => c.repeat(n).slice(0, n)
  const tokens = {
    anthropic: 'sk-ant-api03-' + r(40), openaiProj: 'sk-proj-' + r(48), ghp: 'ghp_' + r(36), ghs: 'ghs_' + r(36),
    pat: 'github_pat_' + r(22) + '_' + r(40), stripeLive: 'sk_live_' + r(24), restricted: 'rk_live_' + r(24),
    akia: 'AKIA' + 'Q'.repeat(16), asia: 'ASIA' + 'Q'.repeat(16),
    slackBot: 'xoxb-1234567890-' + r(24), slackUser: 'xoxp-1234567890-' + r(24), slackSession: 'xoxs-1234567890-' + r(24), // secret-scan:allow
    slackRefresh: 'xoxe-1-' + r(60), slackApp: 'xapp-1-A0123-' + r(40),
    npm: 'npm_' + r(36), hf: 'hf_' + r(34), gitlab: 'glpat-' + r(20), google: 'ya29.' + r(50),
  }
  for (const [name, t] of Object.entries(tokens)) {
    const out = redact(`before ${t} after`)
    expect(out, name).toBe('before [secret] after')
  }
  const bearer = redact('curl -H "Authorization: Bearer ' + r(40) + '" https://x')
  expect(bearer).toContain('Bearer [secret]')
  expect(bearer).not.toContain(r(40))
  expect(redact('the task-force sk is fine; Bearer is a word')).toBe('the task-force sk is fine; Bearer is a word')
})

it('redact covers SendGrid, Twilio (with the auth token beside the SID) and Vercel tokens', () => {
  const r = (n: number, c = 'a1') => c.repeat(n).slice(0, n)
  const hex = (n: number) => 'ab12'.repeat(n).slice(0, 32)
  const cases: Record<string, [string, string]> = {
    sendgrid: [`key SG.${r(22)}.${r(43)} end`, 'key [secret] end'],
    twilioSid: [`sid AC${hex(8)} end`, 'sid [secret] end'],
    twilioKey: [`sid SK${hex(8)} end`, 'sid [secret] end'],
    twilioPair: [`curl -u AC${hex(8)}:${hex(8)} https://x`, 'curl -u [secret] https://x'],
    vercelBlob: [`BLOB=vercel_blob_rw_${r(30)}_${r(20)}`, 'BLOB=[secret]'],
    vercelNew: [`tok vcp_${r(40)} end`, 'tok [secret] end'],
    vercelCli: [`vercel deploy --token ${r(24)}`, 'vercel deploy --token [secret]'],
  }
  for (const [name, [input, want]] of Object.entries(cases)) expect(redact(input), name).toBe(want)
  expect(redact('SG.short and ACME has 32 hex-ish words')).toBe('SG.short and ACME has 32 hex-ish words')
})

it('redact catches a key a terminal wrapped across lines, and leaves ordinary wrapped text alone', () => {
  const key = 'sk-ant-api03-' + 'Zx9'.repeat(30)
  const line = 'export ANTHROPIC_API_KEY_COPY=' + key
  const wrapped = line.slice(0, 80) + '\n' + line.slice(80, 160) + '\n' + line.slice(160)
  const out = redact('$ ' + wrapped + '\n$ done')
  expect(out).not.toContain('Zx9Zx9')
  expect(out).toContain('[secret]')
  expect(out.endsWith('\n$ done')).toBe(true)
  const prose = ('word '.repeat(16)).slice(0, 80) + '\n' + ('text '.repeat(16)).slice(0, 80) + '\nend'
  expect(redact(prose)).toBe(prose)
  const wrappedPlain = 'a'.repeat(80) + '\n' + 'b'.repeat(80) + '\nc'
  expect(redact(wrappedPlain)).toBe(wrappedPlain)
})
