import { accessSync, constants, statSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { delimiter, isAbsolute, join } from 'node:path'
import { rootOf } from './projects.ts'

// Safe without a subscription or an OpenRouter key.
export const DEFAULT_FREE_MODEL = 'opencode/big-pickle'
// The models the Go plan covers, verified live 2026-10-22. Expensive ones that would burn the
// plan's pool fast (astra, gpt-5.5, opus-via-opencode) stay out of rotation.
export const GO_MODELS = new Set(['opencode-go/glm-5.3-flash', 'opencode-go/glm-5.3', 'opencode-go/kimi-k3',
  'opencode-go/kimi-k2.7-code', 'opencode-go/deepseek-v4.1-flash', 'opencode-go/minimax-m3.1-flash',
  'opencode-go/claude-haiku-5-5', 'opencode-go/gpt-6-luna'])
// Model tiers: spend each task on the cheapest model that can do it.
export type Tier = 'light' | 'standard' | 'heavy'
export const TIERS: Tier[] = ['light', 'standard', 'heavy']
// Runway charged per running minute; free models cost nothing.
export const TIER_COST: Record<Tier, number> = { light: 0.25, standard: 0.5, heavy: 1 }

// OpenCode needs a full provider/model id; a bare name like "glm-5.3" silently fails,
// so anything else falls back to the tier's model. The pools that can carry a seat:
// the OpenCode plan (opencode-go/...), OpenRouter's :free models, OpenCode's own free
// pool (opencode/...-free, big-pickle), and the local OmniRoute gateway (omniroute/free-coding).
const OPENCODE_PROVIDERS = ['opencode-go/', 'openrouter/', 'opencode/', 'omniroute/']

// Go tier models are selected only when the org opts into its subscription.
export const OPENCODE_TIER_MODELS: Record<Tier, string> = {
  light: 'opencode-go/glm-5.3-flash',
  standard: 'opencode-go/glm-5.3',
  heavy: 'opencode-go/kimi-k3',
}
// hermes reaches OpenRouter's :free pool, so it keeps its own ids (the Go plan is opencode-only)
const HERMES_TIER_MODELS: Record<Tier, string> = {
  light: 'nvidia/nemotron-3.5-lightning:free',
  standard: 'nvidia/nemotron-3-ultra-550b-a55b:free',
  heavy: 'nvidia/nemotron-3-ultra-550b-a55b:free',
}
// hermes names the provider in a flag, so its model ids carry no provider prefix.
const bareModel = (m: string) => m.replace(/^(openrouter|opencode)\//, '')

// The OpenRouter key: Holon's own file first, then the machine-wide one. Read at launch and
// handed to the child in the environment only.
const OPENROUTER_KEY_FILES = [join(homedir(), '.config', 'holon', 'openrouter.key'), join(homedir(), '.config', 'openrouter', 'key')]

export interface LaunchContext {
  id: string
  cwd: string
  lead: boolean
  yolo: boolean       // skip the CLI's permission prompts entirely
  readOnly?: boolean  // reviewers: may read and run nothing that changes state
  sessionId?: string  // claude only: the conversation to start, or resume
  resume?: boolean
  home: string        // ~/.holon
  socketPath: string
  mcpEntry: string    // absolute path to packages/mcp/src/index.ts
  model?: string
  keyFile?: string    // OpenRouter key file; tests point it at a temp path
}

export interface Launch {
  command: string
  args: string[]
  env?: Record<string, string>
  cwd?: string        // where to start it, when that differs from the terminal's workspace
}

export const READ_ONLY_TOOLS = ['mcp__holon', 'Read', 'Grep', 'Glob', 'WebFetch', 'WebSearch',
  'Bash(git log:*)', 'Bash(git diff:*)', 'Bash(git show:*)', 'Bash(git status:*)', 'Bash(ls:*)', 'Bash(cat:*)',
  'Bash(node --test:*)', 'Bash(npm test:*)', 'Bash(npx vitest run:*)']

export function leadInstructions(): string {
  const fake = process.env.HOLON_FAKE_CLIS === '1'
  const jev = fake || (process.env.PATH ?? '').split(delimiter).some(dir => {
    if (!dir) return false
    try {
      const file = join(dir, 'jev')
      accessSync(file, constants.X_OK)
      return statSync(file).isFile()
    } catch { return false }
  })
  return `You are a lead in Holon. Other terminals report to you, and you drive them
through the holon MCP tools exactly as a person at a keyboard would:

- list_reports shows who reports to you. spawn creates a new report.
- read_screen shows what is on a report's screen right now. Always read before you act.
- type sends text (and Enter by default). press sends one key: Enter, Escape, Tab, Up,
  Down, Left, Right, Backspace, Space, C-c, C-d, or a single character.
- wait blocks until a report's screen has been still for a few seconds, then returns
  the bottom of its screen. Use it after every type, instead of polling read_screen.
- escalate asks whoever you report to and blocks until they answer; a question to the
  human returns at once with a ticket and the answer is typed in later. Use it for
  decisions that aren't yours to make; don't guess.
- When "[holon] Escalation esc-…" arrives in your terminal, one of your reports is
  blocked on you: decide (or escalate further yourself) and reply with answer.
- Several reports can work at once: hand each its task, then wait on each in turn.
- Builders that change code: spawn them with worktree: true so each gets its own branch,
  have them commit, then merge_report brings the work back (rebase, tests, fast-forward,
  one branch at a time). Several builders can then work in parallel without colliding.
  Commit your own edits in the base checkout (logs, notes) before merge_report, or it refuses.
- kb_search / kb_read / kb_write are the org's shared memory. Search it before starting
  work, and record decisions, facts (with sources), lessons and playbooks as you go.
- Prefer grade over tier when you spawn: grade 0 runs free models (no runway cost) and is
  where execution belongs; give G0 builders small, explicit tasks (one goal, the files, the
  check that proves it's done) and review their work. Grades 1-3 are light, standard, heavy.
  roles shows everyone's grade and record; set_grade promotes or demotes anyone below you.
- Pick a tier for every spawn: light (quick lookups, copy, simple edits, test runs),
  standard (most coding, and most leads), heavy (hard design, subtle production code).
  Use the cheapest tier that can do the job; runway is charged by tier.
${fake || isInstalled('opencode') ? `- cli opencode defaults to opencode/big-pickle (free, no subscription or OpenRouter key).
  Only with the org setting opencodeGo enabled does it use Go: glm-5.3-flash for light work,
  glm-5.3 for most code, kimi-k3 for heavy work; claude-haiku-5-5 and gpt-6-luna are covered too.
  Builders AND leads run on it, and it costs no runway and no Claude/Codex quota — but it is
  still weaker than Claude on subtle production code: prefer claude or codex there when their
  quota allows. When those are out of quota, opencode is the whole org's working pool.
  Fallback models with no separate cost: opencode/big-pickle, opencode/deepseek-v4.1-flash-free,
  opencode/minimax-m3.1-flash-free (OpenCode's own)${omnirouteKey() ? `, and omniroute/free-coding (a local gateway
  that falls over between free models when one is rate-limited).` : '.'}
` : ''}${jev ? `- For bulk reading (big JSON, logs, many files), use the jev CLI in your own shell:
  jev "question" file...  It sends text to a cheap model and returns a short answer, which
  saves your context and the org's runway. Treat its output as a lead and spot-check it.
  Never pipe secrets, .env files or customer personal data through it.
` : ''}- treasury shows the org's runway. Running terminals cost agent-minutes; idle ones don't.
  Don't keep reports busy for the sake of it, and kill nothing you still need.

Reports are often other coding agents (Claude Code, Codex). They show menus and
permission prompts; read them and answer with press (arrow keys + Enter, or the
option's number). Give them clear, complete tasks. Check their work yourself
before reporting it done.`
}

function mcpServer(ctx: LaunchContext) {
  return {
    command: process.execPath,
    args: [ctx.mcpEntry],
    env: { HOLON_TERMINAL_ID: ctx.id, HOLON_SOCKET: ctx.socketPath },
  }
}

const toml = (v: unknown): string =>
  typeof v === 'string' ? JSON.stringify(v)
  : Array.isArray(v) ? `[${v.map(toml).join(',')}]`
  : `{${Object.entries(v as object).map(([k, x]) => `${k}=${toml(x)}`).join(',')}}`

const OMNIROUTE_URL = 'http://127.0.0.1:20128/v1'
const omnirouteKey = () => {
  if (process.env.OMNIROUTE_API_KEY) return process.env.OMNIROUTE_API_KEY
  const f = join(homedir(), '.config', 'omniroute', 'admin.env')
  return existsSync(f) ? readFileSync(f, 'utf8').match(/^OMNIROUTE_API_KEY=(\S+)/m)?.[1] : undefined
}

// One CLI is one table entry: the command it runs, how it starts, which model each tier
// runs on, and whether a model costs nothing.
export interface CliSpec {
  command: string
  launch(ctx: LaunchContext): Launch
  tierModels?: Record<Tier, string>
  free?: (model: string) => boolean
}

export const CLI_TABLE = {
  claude: {
    command: 'claude',
    launch(ctx: LaunchContext): Launch {
      const args = ctx.model ? ['--model', ctx.model] : []
      if (ctx.sessionId) args.push(ctx.resume ? '--resume' : '--session-id', ctx.sessionId)
      // Read-only seats: plan mode would also block their holon tools (votes, KB, verdicts),
      // so they run dontAsk with an allow-list of holon, reading and read-only shell tools.
      if (ctx.readOnly) args.push('--permission-mode', 'dontAsk', '--allowedTools', ...READ_ONLY_TOOLS, '--disallowedTools', 'Edit', 'Write', 'NotebookEdit')
      else if (ctx.yolo) args.push('--dangerously-skip-permissions')
      // The owner's Claude plugins and hooks load in every seat too. claude-settings.json in the
      // Holon root overrides them for seats only (e.g. a hook that blocks curl).
      const seat = join(rootOf(ctx.home), 'claude-settings.json')
      if (existsSync(seat)) args.push('--settings', seat)
      // Only Holon's MCP server: the owner's own servers (one seat started six) cost a process each
      // and their tool lists ride along in every turn.
      args.push('--strict-mcp-config')
      if (ctx.lead) {
        const file = join(ctx.home, 'mcp', `${ctx.id}.json`)
        // Servers leads still need from the owner's setup (a Cloudflare connector, say) go in the
        // root's claude-mcp.json, in the usual mcpServers shape.
        const extra = join(rootOf(ctx.home), 'claude-mcp.json')
        const servers = existsSync(extra) ? JSON.parse(readFileSync(extra, 'utf8')).mcpServers ?? {} : {}
        writeFileSync(file, JSON.stringify({ mcpServers: { ...servers, holon: mcpServer(ctx) } }, null, 2))
        args.push('--mcp-config', file, '--append-system-prompt', leadInstructions(), '--allowedTools', 'mcp__holon')
      }
      return { command: this.command, args }
    },
    tierModels: { light: 'haiku', standard: 'sonnet', heavy: 'opus' },
  },
  codex: {
    command: 'codex',
    launch(ctx: LaunchContext): Launch {
      // --no-daemon: Codex's shared background server refuses sessions started with
      // some flag combinations, and it exits before showing anything to drive.
      // No update prompt: a task typed into it selects "Update now", which exits.
      const args = ['--no-daemon', '-C', ctx.cwd, '-c', 'check_for_update_on_startup=false']
      if (ctx.model) args.push('-m', ctx.model)
      if (ctx.readOnly) args.push('--sandbox', 'read-only', '-a', 'never')
      else if (ctx.yolo) args.push('--dangerously-bypass-approvals-and-sandbox')
      if (ctx.lead) {
        const s = mcpServer(ctx)
        args.push(
          '-c', `mcp_servers.holon.command=${toml(s.command)}`,
          '-c', `mcp_servers.holon.args=${toml(s.args)}`,
          '-c', `mcp_servers.holon.env=${toml(s.env)}`,
          '-c', 'mcp_servers.holon.default_tools_approval_mode="approve"',
          '-c', `developer_instructions=${toml(leadInstructions())}`,
        )
      }
      return { command: this.command, args }
    },
    tierModels: { light: 'gpt-6-luna', standard: 'gpt-6-astra', heavy: 'gpt-6-astra' },
  },
  gemini: {
    command: 'gemini',
    launch(ctx: LaunchContext): Launch {
      // Gemini takes MCP servers only from a settings file, so it starts in a folder of its
      // own that holds one, and reaches the real workspace through --include-directories.
      const home = join(ctx.home, 'gemini', ctx.id)
      mkdirSync(join(home, '.gemini'), { recursive: true })
      writeFileSync(join(home, '.gemini', 'settings.json'), JSON.stringify(ctx.lead ? { mcpServers: { holon: mcpServer(ctx) } } : {}, null, 2))
      if (ctx.lead) writeFileSync(join(home, 'GEMINI.md'), leadInstructions() + `\n\nYour workspace is ${ctx.cwd}.\n`)
      const args = ['--include-directories', ctx.cwd]
      // --yolo approves everything without asking, so a read-only seat never gets it.
      if (ctx.yolo && !ctx.readOnly) args.push('--yolo')
      if (ctx.model) args.push('--model', ctx.model)
      return { command: this.command, args, cwd: home }
    },
  },
  opencode: {
    command: 'opencode',
    launch(ctx: LaunchContext): Launch {
      // Config (MCP server, permissions, instructions) lives in a file of its own per
      // terminal; the OpenRouter key is read at launch and only ever passed in the env.
      const dir = join(ctx.home, 'opencode', ctx.id)
      mkdirSync(dir, { recursive: true })
      // OpenCode 2.1.3 rejects --model on the interactive launch ("Unrecognized flag"): the model
      // goes in the config, which it reads as provider/model.
      const config: Record<string, unknown> = { $schema: 'https://opencode.ai/config.json', model: ctx.model ?? DEFAULT_FREE_MODEL }
      // Reading outside the workspace asks by default, and nobody answers a seat's prompts: a
      // read-only reviewer once sat 7 minutes on one while searching ~ for a secrets file.
      if (ctx.readOnly) config.permission = { edit: 'deny', bash: 'deny', webfetch: 'allow', external_directory: 'deny' }
      else if (ctx.yolo) config.permission = { edit: 'allow', bash: 'allow', webfetch: 'allow', external_directory: 'allow' }
      if (ctx.lead) {
        const s = mcpServer(ctx)
        config.mcp = { holon: { type: 'local', command: [s.command, ...s.args], environment: s.env, enabled: true } }
        writeFileSync(join(dir, 'LEAD.md'), leadInstructions())
        config.instructions = [join(dir, 'LEAD.md')]
      }
      const omniKey = omnirouteKey()
      if (omniKey) config.provider = { omniroute: { npm: '@ai-sdk/openai-compatible', name: 'OmniRoute',
        options: { baseURL: OMNIROUTE_URL, apiKey: '{env:OMNIROUTE_API_KEY}' }, models: { 'free-coding': { name: 'free-coding' } } } }
      writeFileSync(join(dir, 'opencode.json'), JSON.stringify(config, null, 2))
      // Holon's own OpenRouter key wins over the machine-wide one.
      const keyFile = OPENROUTER_KEY_FILES.find(f => existsSync(f) && readFileSync(f, 'utf8').trim()) ?? OPENROUTER_KEY_FILES[1]
      const env: Record<string, string> = { OPENCODE_CONFIG: join(dir, 'opencode.json') }
      if (existsSync(keyFile)) env.OPENROUTER_API_KEY = readFileSync(keyFile, 'utf8').trim()
      if (omniKey) env.OMNIROUTE_API_KEY = omniKey
      return { command: this.command, args: [], env }
    },
    tierModels: { light: DEFAULT_FREE_MODEL, standard: DEFAULT_FREE_MODEL, heavy: DEFAULT_FREE_MODEL },
    free: model =>
      /(:free|-free)$/.test(model) || model === 'opencode/big-pickle' || model.startsWith('omniroute/free') ||
      GO_MODELS.has(model),
  },
  hermes: {
    command: 'hermes',
    launch(ctx: LaunchContext): Launch {
      // hermes has no read-only mode: a reviewer that can write is not a reviewer.
      if (ctx.readOnly) throw new Error('hermes has no read-only mode')
      // The key is read at launch and never leaves the environment: not in argv, not in the
      // config file, not in a launch record. Without one there is no OpenRouter to talk to.
      const keyFile = ctx.keyFile ?? OPENROUTER_KEY_FILES.find(f => existsSync(f) && readFileSync(f, 'utf8').trim())
      if (!keyFile) throw new Error('hermes needs an OpenRouter key: none in ~/.config/holon/openrouter.key or ~/.config/openrouter/key')
      if (!existsSync(keyFile)) throw new Error(`hermes needs an OpenRouter key: ${keyFile} does not exist`)
      const key = readFileSync(keyFile, 'utf8').trim()
      if (!key) throw new Error(`hermes needs an OpenRouter key: ${keyFile} is empty`)
      const model = bareModel(ctx.model ?? HERMES_TIER_MODELS.standard)
      // hermes reads its config from HERMES_HOME, one folder per terminal. JSON is valid
      // YAML, so config.yaml holds JSON: the model, the provider, and the holon MCP server.
      const home = join(ctx.home, 'hermes', ctx.id)
      mkdirSync(home, { recursive: true })
      const config: Record<string, unknown> = { model: { default: model, provider: 'openrouter' } }
      if (ctx.lead) {
        const s = mcpServer(ctx)
        config.mcp_servers = { holon: { command: s.command, args: s.args, env: s.env } }
        // hermes reads SOUL.md from HERMES_HOME as its system prompt.
        writeFileSync(join(home, 'SOUL.md'), leadInstructions())
      }
      writeFileSync(join(home, 'config.yaml'), JSON.stringify(config, null, 2))
      // --ignore-user-config keeps hermes off the user's own config, so it never falls back to
      // their paid default model or their own credentials.
      const args = ['--provider', 'openrouter', '-m', model, '--ignore-user-config']
      if (ctx.yolo) args.push('--yolo')
      return { command: this.command, args, env: { HERMES_HOME: home, OPENROUTER_API_KEY: key } }
    },
    tierModels: { ...HERMES_TIER_MODELS },
    free: model => model.endsWith(':free'),
  },
  shell: {
    // Read at launch, not at import: the seat's shell is whatever the terminal was started with.
    get command() { return process.env.SHELL || '/bin/zsh' },
    launch(): Launch {
      // Under tests the shell is /bin/sh; a login /bin/sh on macOS sources /etc/bashrc, whose prompt makes
      // readline mangle any typed line wider than the terminal. Tests only need a plain prompt.
      return { command: this.command, args: process.env.HOLON_FAKE_CLIS === '1' ? [] : ['-l'] }
    },
  },
} satisfies Record<string, CliSpec>

export type Cli = keyof typeof CLI_TABLE
export const CLIS = Object.keys(CLI_TABLE) as Cli[]

// The commands a seat can run as an agent. The shell is one of them too, but it is a
// person's shell, not an agent, so it stays out.
export const AGENT_COMMANDS = new Set<string>([...Object.entries(CLI_TABLE).filter(([k]) => k !== 'shell').map(([, s]) => s.command), 'jev'])

const specOf = (cli: Cli): CliSpec => CLI_TABLE[cli]

export const modelFor = (cli: Cli, tier: Tier, explicit?: string, opencodeGo = false) => {
  const model = (cli === 'opencode' && explicit && !OPENCODE_PROVIDERS.some(p => explicit.startsWith(p)) ? undefined : explicit)
    ?? (cli === 'opencode' && opencodeGo ? OPENCODE_TIER_MODELS[tier] : specOf(cli).tierModels?.[tier])
  // hermes names the provider in a flag, so its model ids carry no prefix.
  return cli === 'hermes' && model ? bareModel(model) : model
}

export const isFree = (cli: Cli, model = DEFAULT_FREE_MODEL) => specOf(cli).free?.(model) ?? false

const INSTALL: Partial<Record<string, string>> = {
  claude: 'Claude Code (https://docs.anthropic.com/en/docs/claude-code)',
  codex: 'Codex (https://github.com/openai/codex)',
  opencode: 'OpenCode (https://opencode.ai)',
}

export function isInstalled(cli: Cli, pathVar = process.env.PATH ?? ''): boolean {
  const command = CLI_TABLE[cli].command
  return isAbsolute(command)
    ? existsSync(command)
    : pathVar.split(delimiter).some(dir => dir && existsSync(join(dir, command)))
}

// The paid CLI a seat gets by default: claude, unless only codex is installed. Neither installed keeps claude,
// so the start-up error names the thing to install.
export const preferredCli = (has: (cli: Cli) => boolean = c => isInstalled(c)): Cli => has('claude') || !has('codex') ? 'claude' : 'codex'

// What the desktop offers in its pickers: the agent CLIs on PATH (a shell is always there).
export const installedClis = (pathVar = process.env.PATH ?? ''): Cli[] => (Object.keys(CLI_TABLE) as Cli[]).filter(c => c === 'shell' || isInstalled(c, pathVar))

// A CLI that is not installed used to start a terminal that exited on a blank screen. Say so up front.
export function assertInstalled(cli: Cli, pathVar = process.env.PATH ?? ''): void {
  if (!isInstalled(cli, pathVar)) throw new Error(`${CLI_TABLE[cli].command} is not installed or not on PATH${INSTALL[cli] ? `; install ${INSTALL[cli]} and sign in` : ''}`)
}

export function launchFor(cli: Cli, ctx: LaunchContext): Launch {
  return CLI_TABLE[cli].launch(ctx)
}
