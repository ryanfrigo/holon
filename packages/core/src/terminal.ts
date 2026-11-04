import { basename } from 'node:path'
import { EventEmitter } from 'node:events'
import { closeSync, fstatSync, readdirSync } from 'node:fs'
import pty from 'node-pty'
import headless from '@xterm/headless'
import { keyBytes } from './keys.ts'
import { AGENT_COMMANDS } from './adapters.ts'

export type TerminalState = 'running' | 'quiet' | 'exited'

export interface TerminalSpec {
  command: string
  args?: string[]
  cwd: string
  env?: Record<string, string>
  cols?: number
  rows?: number
}

export interface Screen {
  text: string
  cursor: { row: number; col: number }
  state: TerminalState
}

// Agents launched from inside another agent session must not inherit its identity.
function cleanEnv(): Record<string, string> {
  const env: Record<string, string> = {}
  for (const [k, v] of Object.entries(process.env)) {
    if (v === undefined) continue
    if (/^CLAUDE/.test(k) && k !== 'CLAUDE_CONFIG_DIR') continue
    env[k] = v
  }
  // An app started from Finder has no locale, and a shell in the C locale garbles the UTF-8 that agent TUIs draw.
  if (!env.LANG && !env.LC_ALL && !env.LC_CTYPE) env.LANG = 'en_US.UTF-8'
  return env
}

const sleep = (ms: number) => new Promise(r => setTimeout(r, ms))


// One PTY plus a headless xterm that mirrors exactly what a viewer would see.
// Open character-device descriptors of this process (ptys among them).
function charDevices(): Set<number> {
  const out = new Set<number>()
  try { for (const f of readdirSync('/dev/fd')) { const fd = Number(f); try { if (fstatSync(fd).isCharacterDevice()) out.add(fd) } catch {} } } catch {}
  return out
}

export class Terminal extends EventEmitter {
  readonly pty: pty.IPty
  readonly screen: headless.Terminal
  exitCode: number | null = null
  // Agent TUIs repaint constantly while idle, so "quiet" means the rendered screen
  // stopped changing, not that the byte stream stopped.
  private lastChangeAt = Date.now()
  private lastSnapshot = ''
  private disposed = false

  constructor(spec: TerminalSpec) {
    super()
    const cols = spec.cols ?? 120
    const rows = spec.rows ?? 40
    this.screen = new headless.Terminal({ cols, rows, scrollback: 5000, allowProposedApi: true })
    // Tests must never spend real quota by launching an agent CLI; they run /bin/sh instead.
    // The set comes from the adapter table, so a new CLI is covered the moment it is added.
    // The guard follows the test runner, not the config: vitest started from another folder never
    // loads the root config, so HOLON_FAKE_CLIS is unset there and a real CLI would otherwise launch.
    if ((process.env.HOLON_FAKE_CLIS === '1' || process.env.VITEST || process.env.NODE_ENV === 'test') && AGENT_COMMANDS.has(basename(spec.command)))
      throw new Error('refusing to start a real agent CLI under tests: ' + spec.command)
    const before = charDevices()
    this.pty = pty.spawn(spec.command, spec.args ?? [], {
      name: 'xterm-256color',
      cols,
      rows,
      cwd: spec.cwd,
      env: { ...cleanEnv(), ...spec.env, TERM: 'xterm-256color' },
    })
    // node-pty opens the master twice and only ever closes the copy it uses, so each terminal
    // leaked one pty: a daemon or test run hit macOS's limit of 511 and new terminals failed with
    // posix_spawnp. The spare copy appeared during this synchronous call, so it is certainly ours.
    const used = (this.pty as unknown as { _fd?: number })._fd
    for (const fd of charDevices()) if (!before.has(fd) && fd !== used) { try { closeSync(fd) } catch {} }
    this.pty.onData(data => {
      if (this.disposed) return
      this.screen.write(data, () => this.noteChange())
      this.emit('data', data)
    })
    this.pty.onExit(({ exitCode }) => {
      this.exitCode = exitCode
      this.dropPendingWrites()
      this.emit('exit', exitCode)
    })
    // Answer terminal queries (cursor position, device attributes) the way a real terminal would.
    this.screen.onData(reply => this.write(reply))
  }

  private noteChange() {
    if (this.disposed) return
    const snap = this.readScreen().text
    if (snap !== this.lastSnapshot) {
      this.lastSnapshot = snap
      this.lastChangeAt = Date.now()
    }
  }

  quietForMs(now = Date.now()) {
    return now - this.lastChangeAt
  }

  get state(): TerminalState {
    if (this.exitCode !== null) return 'exited'
    return Date.now() - this.lastChangeAt >= 1000 ? 'quiet' : 'running'
  }

  // node-pty flushes queued input with fs.write after the call returns. Input still queued when the
  // process exits or the terminal is killed would land on a closed pty and log "Unhandled pty write
  // error" (EIO/EBADF), so the queue is emptied at that point.
  private dropPendingWrites() {
    const ws = (this.pty as unknown as { _writeStream?: { _writeQueue?: unknown[]; dispose?: () => void } })._writeStream
    if (ws?._writeQueue) ws._writeQueue.length = 0
    try { ws?.dispose?.() } catch {}
  }

  write(data: string) {
    if (this.exitCode !== null || this.disposed) return
    try { this.pty.write(data) } catch {} // the process can exit between the check and the write
  }

  // Long or multi-line text goes in as one bracketed paste when the app asks for that
  // (agent TUIs do); typed raw, it arrives in bursts and the app keeps only part of it.
  // Enter is sent only after the screen settles, so it can't land mid-paste.
  async type(text: string, submit = true) {
    const paste = this.screen.modes.bracketedPasteMode && (text.includes('\n') || text.length > 200)
    this.write(paste ? `\x1b[200~${text.replace(/\r?\n/g, '\r')}\x1b[201~` : text)
    if (submit) {
      await sleep(250)
      if (paste) await this.waitQuiet(500, 15_000)
      this.write('\r')
    }
  }

  press(key: string) {
    this.write(keyBytes(key, this.screen.modes.applicationCursorKeysMode))
  }

  readScreen(scrollback = 0): Screen {
    const buf = this.screen.buffer.active
    const start = Math.max(0, buf.viewportY - scrollback)
    const end = buf.viewportY + this.screen.rows
    const lines: string[] = []
    for (let i = start; i < end; i++) {
      const line = buf.getLine(i)
      const text = line?.translateToString(true) ?? ''
      // Rows the terminal soft-wrapped are one logical line to whoever is reading.
      if (line?.isWrapped && lines.length) lines[lines.length - 1] += text
      else lines.push(text)
    }
    while (lines.length && lines[lines.length - 1].trim() === '') lines.pop()
    return { text: lines.join('\n'), cursor: { row: buf.cursorY, col: buf.cursorX }, state: this.exitCode !== null ? 'exited' : Date.now() - this.lastChangeAt >= 1000 ? 'quiet' : 'running' }
  }

  // Resolves once the screen has been still for quietMs, the process exits, or timeoutMs passes.
  // `stop` ends the wait early with state 'stopped' (checked every 50ms).
  async waitQuiet(quietMs = 3000, timeoutMs = 600_000, stop?: () => boolean): Promise<{ state: TerminalState | 'timeout' | 'stopped' }> {
    const start = Date.now()
    const deadline = start + timeoutMs
    while (true) {
      if (this.exitCode !== null) return { state: 'exited' }
      if (stop?.()) return { state: 'stopped' }
      // Stillness counts from when the wait began, so input sent just before the call
      // has time to show up before the screen is judged quiet.
      if (Date.now() - Math.max(this.lastChangeAt, start) >= quietMs) return { state: 'quiet' }
      if (Date.now() > deadline) return { state: 'timeout' }
      await sleep(50)
    }
  }

  resize(cols: number, rows: number) {
    if (this.disposed) return
    if (this.exitCode === null) try { this.pty.resize(cols, rows) } catch {} // the process can exit between the check and the ioctl
    this.screen.resize(cols, rows)
  }

  kill() {
    if (this.disposed) return
    this.disposed = true
    this.dropPendingWrites()
    if (this.exitCode === null) this.pty.kill()
    this.screen.dispose()
  }
}
