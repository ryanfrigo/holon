import { expect, it } from 'vitest'
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { launchFor } from '../src/adapters.ts'

const home = mkdtempSync(join(tmpdir(), 'holon-'))
mkdirSync(join(home, 'mcp'))
const ctx = { id: 'x', cwd: home, home, socketPath: 's', mcpEntry: 'm', lead: true }

// The OpenRouter key, built at run time and written to a temp file: the adapter reads the key
// from a file, so the test gives it one. It never sits in the repo.
const KEY = 'sk-or-v1-' + 'a'.repeat(64)
const keyFile = join(home, 'openrouter.key')
writeFileSync(keyFile, KEY + '\n')

it('passes each CLI its own skip-permissions flag only when yolo is on', () => {
  expect(launchFor('claude', { ...ctx, yolo: true }).args).toContain('--dangerously-skip-permissions')
  expect(launchFor('claude', { ...ctx, yolo: false }).args).not.toContain('--dangerously-skip-permissions')
  expect(launchFor('codex', { ...ctx, yolo: true }).args).toContain('--dangerously-bypass-approvals-and-sandbox')
  expect(launchFor('codex', { ...ctx, yolo: false }).args[0]).toBe('--no-daemon')
  expect(launchFor('codex', { ...ctx, yolo: false }).args).not.toContain('--dangerously-bypass-approvals-and-sandbox')
})

it('a codex lead pre-approves the holon MCP tools so reviewers can record a verdict', () => {
  expect(launchFor('codex', { ...ctx, yolo: false }).args).toContain('mcp_servers.holon.default_tools_approval_mode="approve"')
  expect(launchFor('codex', { ...ctx, yolo: false, lead: false }).args).not.toContain('mcp_servers.holon.default_tools_approval_mode="approve"')
})

it('opencode gets its own config with the holon MCP server, and defaults to a free model', async () => {
  const { readFileSync } = await import('node:fs')
  const l = launchFor('opencode', { ...ctx, yolo: true })
  // OpenCode 2.1.3 dropped --model from the interactive launch: the model is set in the config.
  expect(l.args).toEqual([])
  const config = JSON.parse(readFileSync(l.env!.OPENCODE_CONFIG, 'utf8'))
  expect(config.model).toBe('opencode/big-pickle')
  expect(config.mcp.holon.environment.HOLON_TERMINAL_ID).toBe('x')
  expect(config.permission.bash).toBe('allow')
  expect(config.permission.external_directory).toBe('allow')
  expect(JSON.stringify(config)).not.toMatch(/sk-or-/)   // the key stays out of the file
})

it('opencode ignores model names that are not full provider ids', async () => {
  const { modelFor } = await import('../src/adapters.ts')
  expect(modelFor('opencode', 'standard', 'glm-5.3')).toBe('opencode/big-pickle')
  expect(modelFor('opencode', 'heavy')).toBe('opencode/big-pickle')
  expect(modelFor('opencode', 'heavy', undefined, true)).toBe('opencode-go/kimi-k3')
  expect(modelFor('opencode', 'heavy', 'opencode/big-pickle', true)).toBe('opencode/big-pickle')
  expect(modelFor('opencode', 'light', 'openrouter/google/gemma-4-31b-it:free')).toBe('openrouter/google/gemma-4-31b-it:free')
  expect(modelFor('claude', 'light')).toBe('haiku')
})

it('opencode also takes its own free models and the local OmniRoute gateway, and both cost no runway', async () => {
  const { modelFor, isFree, launchFor } = await import('../src/adapters.ts')
  expect(modelFor('opencode', 'light', 'opencode/big-pickle')).toBe('opencode/big-pickle')
  expect(modelFor('opencode', 'light', 'omniroute/free-coding')).toBe('omniroute/free-coding')
  for (const m of ['opencode/big-pickle', 'opencode/glm-5.3-flash-free', 'omniroute/free-coding']) expect(isFree('opencode', m)).toBe(true)
  // opencode/<model> without -free bills console credits, which are not free
  expect(isFree('opencode', 'opencode/glm-5.3')).toBe(false)
  expect(isFree('opencode', 'opencode-go/glm-5.3-flash')).toBe(true)
  expect(isFree('opencode', 'openrouter/anthropic/claude-sonnet')).toBe(false)
  process.env.OMNIROUTE_API_KEY = 'sk-test-omni'
  try {
    const l = launchFor('opencode', { ...ctx, yolo: true, model: 'omniroute/free-coding' })
    const config = JSON.parse((await import('node:fs')).readFileSync(l.env!.OPENCODE_CONFIG, 'utf8'))
    expect(config.provider.omniroute.options.baseURL).toBe('http://127.0.0.1:20128/v1')
    expect(JSON.stringify(config)).not.toMatch(/sk-test-omni/)   // the key stays out of the file
    expect(l.env!.OMNIROUTE_API_KEY).toBe('sk-test-omni')
  } finally { delete process.env.OMNIROUTE_API_KEY }
})

it('read-only seats can read but not change anything, in every CLI', async () => {
  const { readFileSync } = await import('node:fs')
  expect(launchFor('claude', { ...ctx, yolo: true, readOnly: true }).args).toEqual(expect.arrayContaining(['--permission-mode', 'dontAsk', 'mcp__holon', 'Edit']))
  expect(launchFor('claude', { ...ctx, yolo: true, readOnly: true }).args).not.toContain('--dangerously-skip-permissions')
  expect(launchFor('codex', { ...ctx, yolo: true, readOnly: true }).args).toEqual(expect.arrayContaining(['--sandbox', 'read-only']))
  const oc = launchFor('opencode', { ...ctx, yolo: true, readOnly: true })
  expect(JSON.parse(readFileSync(oc.env!.OPENCODE_CONFIG, 'utf8')).permission).toMatchObject({ edit: 'deny', bash: 'deny', external_directory: 'deny' })
})

it('gemini does not count as free: Google refuses the CLI\'s personal-OAuth free tier', async () => {
  const { AGENT_COMMANDS, CLI_TABLE, isFree } = await import('../src/adapters.ts')
  expect(isFree('gemini')).toBe(false)
  expect(isFree('claude')).toBe(false)
  expect(isFree('opencode', 'openrouter/x:free')).toBe(true)
  expect(AGENT_COMMANDS.has('gemini')).toBe(true)
  expect(AGENT_COMMANDS.has('jev')).toBe(true)
  expect(AGENT_COMMANDS.has(CLI_TABLE.shell.command)).toBe(false)
})

it('a gemini read-only seat never runs yolo', () => {
  expect(launchFor('gemini', { ...ctx, yolo: true, readOnly: true }).args).not.toContain('--yolo')
  expect(launchFor('gemini', { ...ctx, yolo: true, readOnly: false }).args).toContain('--yolo')
})

it('hermes runs OpenRouter on its own model and never on the user\'s own config', () => {
  const l = launchFor('hermes', { ...ctx, keyFile, yolo: true })
  expect(l.args).toEqual(['--provider', 'openrouter', '-m', 'nvidia/nemotron-3-ultra-550b-a55b:free', '--ignore-user-config', '--yolo'])
  expect(l.env!.HERMES_HOME).toBe(join(home, 'hermes', 'x'))
  const calm = launchFor('hermes', { ...ctx, keyFile, yolo: false })
  expect(calm.args).not.toContain('--yolo')
  expect(calm.args).toContain('--ignore-user-config')
})

it('hermes writes a per-terminal config.yaml: the model, the provider and, for leads, the holon MCP server', () => {
  const lead = launchFor('hermes', { ...ctx, id: 'lead-1', keyFile, yolo: false })
  const config = JSON.parse(readFileSync(join(lead.env!.HERMES_HOME, 'config.yaml'), 'utf8'))
  expect(config.model).toEqual({ default: 'nvidia/nemotron-3-ultra-550b-a55b:free', provider: 'openrouter' })
  expect(config.mcp_servers.holon.command).toBe(process.execPath)
  expect(config.mcp_servers.holon.args).toEqual(['m'])
  expect(config.mcp_servers.holon.env.HOLON_TERMINAL_ID).toBe('lead-1')
  const plain = launchFor('hermes', { ...ctx, id: 'plain-1', lead: false, keyFile, yolo: false })
  const plainConfig = JSON.parse(readFileSync(join(plain.env!.HERMES_HOME, 'config.yaml'), 'utf8'))
  expect(plainConfig.mcp_servers).toBeUndefined()
  expect(plainConfig.model.provider).toBe('openrouter')
})

it('the OpenRouter key rides in the environment alone: not in argv, not in the config, not in the launch record', () => {
  const l = launchFor('hermes', { ...ctx, id: 'key-1', keyFile, yolo: true })
  expect(l.env!.OPENROUTER_API_KEY).toBe(KEY)
  expect(JSON.stringify(l.args)).not.toContain(KEY)
  expect(readFileSync(join(l.env!.HERMES_HOME, 'config.yaml'), 'utf8')).not.toContain(KEY)
  expect(readFileSync(join(l.env!.HERMES_HOME, 'SOUL.md'), 'utf8')).not.toContain(KEY)
  const record = { command: l.command, args: l.args, env: { HERMES_HOME: l.env!.HERMES_HOME } }
  expect(JSON.stringify(record)).not.toContain(KEY)
})

it('hermes has no read-only mode, and no key file means no launch', () => {
  expect(() => launchFor('hermes', { ...ctx, keyFile, yolo: true, readOnly: true })).toThrow('hermes has no read-only mode')
  expect(() => launchFor('hermes', { ...ctx, keyFile: join(home, 'no-such.key'), yolo: false })).toThrow(/OpenRouter key/)
})

it('hermes runs the OpenRouter free pool without the provider prefix, and only :free models cost nothing', async () => {
  const { AGENT_COMMANDS, isFree, modelFor } = await import('../src/adapters.ts')
  expect(modelFor('hermes', 'standard')).toBe('nvidia/nemotron-3-ultra-550b-a55b:free')
  expect(modelFor('hermes', 'light')).toBe('nvidia/nemotron-3.5-lightning:free')
  expect(modelFor('hermes', 'standard', 'openrouter/nvidia/nemotron-3-ultra-550b-a55b:free')).toBe('nvidia/nemotron-3-ultra-550b-a55b:free')
  expect(isFree('hermes', 'nvidia/nemotron-3-ultra-550b-a55b:free')).toBe(true)
  expect(isFree('hermes', 'anthropic/claude-sonnet-4')).toBe(false)
  expect(AGENT_COMMANDS.has('hermes')).toBe(true)
})

it("Claude seats load the root's claude-settings.json, for a project home too", () => {
  const root = mkdtempSync(join(tmpdir(), 'holon-'))
  const proj = join(root, 'projects', 'p'); mkdirSync(join(proj, 'mcp'), { recursive: true })
  expect(launchFor('claude', { ...ctx, home: proj, yolo: true }).args).not.toContain('--settings')
  writeFileSync(join(root, 'claude-settings.json'), '{"enabledPlugins":{}}')
  const args = launchFor('claude', { ...ctx, home: proj, yolo: true }).args
  expect(args[args.indexOf('--settings') + 1]).toBe(join(root, 'claude-settings.json'))
  expect(args).toContain('--strict-mcp-config')
  writeFileSync(join(root, 'claude-mcp.json'), '{"mcpServers":{"cf":{"type":"http","url":"https://x"}}}')
  const cfg = launchFor('claude', { ...ctx, home: proj, yolo: true }).args
  const servers = JSON.parse(readFileSync(cfg[cfg.indexOf('--mcp-config') + 1], 'utf8')).mcpServers
  expect(Object.keys(servers).sort()).toEqual(['cf', 'holon'])
})

// A fresh Holon root per case: claude-settings.json and claude-mcp.json are read from it.
const rootWith = (files: Record<string, string> = {}) => {
  const h = mkdtempSync(join(tmpdir(), 'holon-claude-'))
  mkdirSync(join(h, 'mcp'))
  for (const [f, text] of Object.entries(files)) writeFileSync(join(h, f), text)
  return { ...ctx, home: h }
}

it('claude: model, session id vs resume, and the strict MCP flag', () => {
  const c = rootWith()
  const fresh = launchFor('claude', { ...c, lead: false, yolo: false, model: 'sonnet', sessionId: 's-1' }).args
  expect(fresh).toEqual(expect.arrayContaining(['--model', 'sonnet', '--session-id', 's-1', '--strict-mcp-config']))
  expect(fresh).not.toContain('--resume')
  const again = launchFor('claude', { ...c, lead: false, yolo: false, sessionId: 's-1', resume: true }).args
  expect(again).toEqual(expect.arrayContaining(['--resume', 's-1']))
  expect(again).not.toContain('--session-id')
  expect(again).not.toContain('--model')
  expect(again).not.toContain('--mcp-config')                      // only leads get Holon's server
})

it('claude: a read-only seat gets the allow-list, never yolo, and cannot write', () => {
  const a = launchFor('claude', { ...rootWith(), lead: false, yolo: true, readOnly: true }).args
  expect(a).toEqual(expect.arrayContaining(['--permission-mode', 'dontAsk', '--allowedTools', '--disallowedTools', 'Edit', 'Write', 'NotebookEdit']))
  expect(a).not.toContain('--dangerously-skip-permissions')
})

it('claude: the root\'s claude-settings.json rides along only when it exists', () => {
  expect(launchFor('claude', { ...rootWith(), lead: false, yolo: false }).args).not.toContain('--settings')
  const c = rootWith({ 'claude-settings.json': '{}' })
  const a = launchFor('claude', { ...c, lead: false, yolo: false }).args
  expect(a[a.indexOf('--settings') + 1]).toBe(join(c.home, 'claude-settings.json'))
})

it('claude: a lead keeps the owner\'s extra MCP servers beside holon, and holon wins a name clash', () => {
  const c = rootWith({ 'claude-mcp.json': JSON.stringify({ mcpServers: { cloudflare: { command: 'cf' }, holon: { command: 'impostor' } } }) })
  const a = launchFor('claude', { ...c, yolo: false }).args
  const file = a[a.indexOf('--mcp-config') + 1]
  const servers = JSON.parse(readFileSync(file, 'utf8')).mcpServers
  expect(servers.cloudflare).toEqual({ command: 'cf' })
  expect(servers.holon.command).not.toBe('impostor')
  expect(servers.holon.env.HOLON_TERMINAL_ID).toBe('x')
  expect(a).toEqual(expect.arrayContaining(['--allowedTools', 'mcp__holon', '--append-system-prompt']))
  // With no extra file the lead still gets exactly holon.
  const plain = launchFor('claude', { ...rootWith(), yolo: false }).args
  expect(Object.keys(JSON.parse(readFileSync(plain[plain.indexOf('--mcp-config') + 1], 'utf8')).mcpServers)).toEqual(['holon'])
})

it('gemini starts in a folder of its own, and yolo never reaches a read-only seat', () => {
  const c = rootWith()
  const l = launchFor('gemini', { ...c, yolo: true, readOnly: true, model: 'g-1' })
  expect(l.cwd).toBe(join(c.home, 'gemini', 'x'))
  expect(l.args).toEqual(['--include-directories', c.cwd, '--model', 'g-1'])
  expect(JSON.parse(readFileSync(join(l.cwd!, '.gemini', 'settings.json'), 'utf8')).mcpServers.holon.env.HOLON_TERMINAL_ID).toBe('x')
  expect(readFileSync(join(l.cwd!, 'GEMINI.md'), 'utf8')).toContain(`Your workspace is ${c.cwd}`)
  const worker = launchFor('gemini', { ...rootWith(), lead: false, yolo: true })
  expect(worker.args).toContain('--yolo')
  expect(JSON.parse(readFileSync(join(worker.cwd!, '.gemini', 'settings.json'), 'utf8'))).toEqual({})
})

it('opencode: a read-only seat denies edits and shell, and yolo does not override that', () => {
  const l = launchFor('opencode', { ...rootWith(), lead: false, yolo: true, readOnly: true })
  const config = JSON.parse(readFileSync(l.env!.OPENCODE_CONFIG, 'utf8'))
  expect(config.permission).toMatchObject({ edit: 'deny', bash: 'deny', external_directory: 'deny' })
  expect(config.mcp).toBeUndefined()
})

it('hermes refuses read-only seats and a missing or empty key file, naming the file', () => {
  expect(() => launchFor('hermes', { ...rootWith(), keyFile, yolo: false, readOnly: true })).toThrow(/no read-only mode/)
  const gone = join(home, 'no-such.key')
  expect(() => launchFor('hermes', { ...rootWith(), keyFile: gone, yolo: false })).toThrow(`${gone} does not exist`)
  const empty = join(home, 'empty.key')
  writeFileSync(empty, '\n')
  expect(() => launchFor('hermes', { ...rootWith(), keyFile: empty, yolo: false })).toThrow(`${empty} is empty`)
})
