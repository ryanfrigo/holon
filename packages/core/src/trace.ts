import { appendFileSync, existsSync, mkdirSync, readdirSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { basename, join } from 'node:path'
import { redact, redactJson } from './watcher.ts'

// A reviewable record of one run: every terminal's screen over time (secrets scrubbed),
// every action, the org's shape as it changed, and pointers to each agent's own transcript.
export class Trace {
  readonly dir: string
  private lastScreen = new Map<string, string>()

  constructor(dir: string) {
    this.dir = dir
    mkdirSync(join(dir, 'terminals'), { recursive: true })
    mkdirSync(join(dir, 'org'), { recursive: true })
  }

  static forRun(home: string, workspace: string, startedAt: string) {
    const stamp = startedAt.slice(0, 16).replace(/[:T]/g, '-')
    return new Trace(join(home, 'traces', `${stamp}-${basename(workspace).replace(/[^\w.-]+/g, '-')}`))
  }

  action(entry: object) {
    appendFileSync(join(this.dir, 'actions.jsonl'), JSON.stringify(redactJson(entry)) + '\n')
  }

  // Appends the screen only when it changed since the last snapshot.
  screen(id: string, label: string, state: string, text: string, now = new Date()) {
    if (this.lastScreen.get(id) === text) return false
    this.lastScreen.set(id, text)
    const file = join(this.dir, 'terminals', `${label.replace(/[^\w.-]+/g, '-')}-${id}.txt`)
    appendFileSync(file, `\n===== ${now.toISOString()} [${state}]\n${redact(text)}\n`)
    return true
  }

  org(nodes: object[], now = new Date()) {
    writeFileSync(join(this.dir, 'org', `${now.toISOString().replace(/[:.]/g, '-')}.json`), JSON.stringify(nodes, null, 2))
  }

  manifest(m: object) {
    writeFileSync(join(this.dir, 'manifest.json'), JSON.stringify(m, null, 2))
  }
}

// Where each CLI keeps its own full transcript, for drilling into a single agent.
export function transcriptFor(cli: string, cwd: string, sessionId?: string): string | undefined {
  if (cli === 'claude' && sessionId) return join(homedir(), '.claude', 'projects', cwd.replace(/[^A-Za-z0-9]/g, '-'), `${sessionId}.jsonl`)
  if (cli === 'codex') return join(homedir(), '.codex', 'sessions')
  if (cli === 'opencode') return join(homedir(), '.local', 'share', 'opencode')
  return undefined
}

export const listRuns = (home: string) => existsSync(join(home, 'traces')) ? readdirSync(join(home, 'traces')).sort() : []
