import { execFile } from 'node:child_process'

// The self-healing watcher: looks at every terminal's screen for the failures that keep an
// org stuck, fixes the ones it safely can, and tells a lead about the rest. Known patterns
// are rules (instant, free); anything else that looks wrong goes to a free model via jev,
// after secrets are scrubbed from the screen.

export interface Finding {
  issue: string                 // stable id for cooldowns and lessons
  summary: string
  press?: string[]              // safe keys to send, for a recognized menu
  type?: string                 // a line to send, for a turn cut off by the network
  notify?: string               // message for the terminal's lead (or the top of the org)
}

export interface Seen {
  label: string
  cli: string
  screen: string
  quietMs: number
  promptForMs?: number          // how long the same permission prompt has been on screen (set by heal)
  exitCode: number | null
  hasLead: boolean
  hookForMs?: number   // how long the same "running ... hook" line has been on screen across heal passes
}

// Removes anything that looks like a credential before a screen leaves the machine.
//
// This runs on every screen, trace and log write, so it has to stay fast on a long line: a
// minified file printed in a terminal is one 150 KB line, and three of the patterns below
// used to walk that line quadratically - a URL scheme that scanned to the end of the line
// looking for '://', a value whose digit was looked for at the end of the line, and an
// identifier whose keyword was looked for one position at a time. Each one is bounded or
// checked in code now, and none of them leaves a secret on the screen that used to be caught.
function redactLines(text: string): string {
  return text
    // 1. AWS secret access key = 40-char value, case-insensitive - keep the key and separator as written
    .replace(/\b([A-Za-z0-9_]*aws_secret_access_key[A-Za-z0-9_]*)(\s*[=:]\s*)["']?[A-Za-z0-9/+=]{40,}["']?/gi, '$1$2[secret]')
    // 2. GitHub tokens: ghp/gho/github_pat (10+), ghs_/ghu_/ghr_ (30+)
    .replace(/\b(ghp|gho|github_pat)[A-Za-z0-9_-]{10,}\b/g, '[secret]')
    .replace(/\bgh[sur]_[A-Za-z0-9_-]{30,}\b/g, '[secret]')
    // 3. Slack tokens: xoxb/p/a/r/s/e/o... + 10+ chars, and app-level xapp-
    .replace(/\bxox[a-z][A-Za-z0-9_-]{10,}\b/g, '[secret]')
    .replace(/\bxapp-[A-Za-z0-9_-]{10,}\b/g, '[secret]')
    // Bearer headers, npm, Hugging Face, GitLab and Google OAuth tokens
    .replace(/\b(Bearer\s+)[A-Za-z0-9._~+/=-]{16,}/gi, '$1[secret]')
    .replace(/\b(?:npm|hf)_[A-Za-z0-9]{30,}\b/g, '[secret]')
    .replace(/\bglpat-[A-Za-z0-9_-]{20,}/g, '[secret]')
    .replace(/\bya29\.[A-Za-z0-9_-]{20,}/g, '[secret]')
    // SendGrid keys (SG.<id>.<secret>), Twilio SIDs (AC/SK + 32 hex) with the 32-hex auth token
    // written next to them, and Vercel tokens (new vc?_ prefixes, blob tokens, CLI --token)
    .replace(/\bSG\.[A-Za-z0-9_-]{16,}\.[A-Za-z0-9_-]{16,}/g, '[secret]')
    .replace(/\b(?:AC|SK)[0-9a-f]{32}\b(?:[\s:,/]{1,4}[0-9a-f]{32}\b)?/g, '[secret]')
    .replace(/\bvercel_blob_rw_[A-Za-z0-9_-]{16,}/g, '[secret]')
    .replace(/\bvc[aipkr]_[A-Za-z0-9]{20,}/g, '[secret]')
    .replace(/(--token[=\s]\s*)[A-Za-z0-9_-]{20,}/g, '$1[secret]')
    // Flags, quoted JSON keys, headers and two more prefixes. Name lengths are capped so none of these walks a long line.
    .replace(/(--[a-z-]{0,30}(?:api-?key|secret|password)[=\s]\s*)[^\s"']{8,}/gi, '$1[secret]')
    .replace(/(["'][A-Za-z0-9_-]{0,40}(?:token|secret|password|passwd|api_?key)["']\s*:\s*["'])[^"'\s]{8,}/gi, '$1[secret]')
    .replace(/\b(x-api-key|x-auth-token)(\s*:\s*)[^\s"']+/gi, '$1$2[secret]')
    .replace(/\b(authorization\s*:\s*basic\s+)[A-Za-z0-9+/=]{8,}/gi, '$1[secret]')
    .replace(/\b((?:set-)?cookie\s*:\s*)[^\n"']+/gi, '$1[secret]')
    .replace(/\b(?:lin_api_[A-Za-z0-9]{16,}|GOCSPX-[A-Za-z0-9_-]{16,})/g, '[secret]')
    // 4. Stripe webhook signing secret: whsec_ + 20+ chars
    .replace(/\bwhsec_[A-Za-z0-9_-]{20,}\b/g, '[secret]')
    // 5. PEM block: -----BEGIN ... PRIVATE KEY----- ... -----END ... PRIVATE KEY----- multi-line
    .replace(/-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?-----END [A-Z ]*PRIVATE KEY-----/g, '[secret]')
    // 6. URL credentials: scheme://user:pass@host -> scheme://user:[secret]@host (pass must not contain '/')
    //    The scheme is capped at 32 characters: the longest scheme in the IANA registry is 31,
    //    and an open-ended one made this pattern read to the end of the line at every word
    //    boundary - 10 s on 150 KB.
    .replace(/(\b[a-z][a-z0-9+.-]{0,31}:\/\/)([^:@\s]*):([^@\s/]+)(@)/g, '$1$2:[secret]$4')
    // 7. Generic assignments: password|passwd|secret|token|api_key|apikey =/: value (12+ chars, no spaces, must contain a digit) - keep key and separator
    //    The digit is checked in code, on the value the pattern already took. A lookahead for
    //    it read to the end of the line for every key on it - 3 s on 150 KB - and the value is
    //    swallowed either way, so a value without a digit still comes back as it was.
    .replace(
      /\b(password|passwd|secret|token|api_?key)(\s*[=:]\s*)(?:["']?)([A-Za-z0-9/+=_-]{12,})(?:["']?)/gi,
      (m: string, key: string, sep: string, value: string) => (/\d/.test(value) ? `${key}${sep}[secret]` : m)
    )
    // Existing patterns
    .replace(/\b(sk|rk|pk)[-_](live|test|proj|ant|or)?[-_]?[A-Za-z0-9_-]{12,}/g, '[secret]')
    .replace(/\b(AKIA|ASIA|AIza)[A-Za-z0-9_-]{10,}/g, '[secret]')
    .replace(/\b(eyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,})/g, '[secret]')
    // The keyword is checked in code, on the name the pattern already took: looking for it
    // one position at a time inside the name made this pattern quadratic on a long line of
    // upper-case names - 4 s on 150 KB. The name is searched from its second letter, because
    // the first [A-Z] of the old pattern ate the first letter of the keyword.
    .replace(
      /^(export[ \t]+)?([A-Z][A-Z0-9_]*)(\s*[=:]\s*).+$/gm,
      (m: string, exp: string | undefined, name: string, sep: string) => (/KEY|TOKEN|SECRET|PASSWORD|PASS/.test(name.slice(1)) ? `${exp ?? ''}${name}${sep}[secret]` : m)
    )
}

// A screen wraps at its column width, so a long key can be cut by a newline and no pattern sees
// it whole. A run of long lines is joined, and the join is used only when it is redacted where
// the lines alone were not: ordinary wrapped text keeps its newlines.
const WRAP_MIN = 40
const tokenEdge = /[A-Za-z0-9_=+/-]/
function unwrapSecrets(text: string): string {
  if (!text.includes('\n')) return text
  const lines = text.split('\n')
  const out: string[] = []
  for (let i = 0; i < lines.length;) {
    let j = i
    while (j + 1 < lines.length && j - i < 200 && lines[j].length >= WRAP_MIN && tokenEdge.test(lines[j].at(-1)!) && tokenEdge.test(lines[j + 1][0] ?? ' ')) j++
    if (j > i) {
      const group = lines.slice(i, j + 1)
      // One pass over the join; the lines alone are redacted only when the join changed.
      const flat = group.join('')
      const joined = redactLines(flat)
      // The whole run is consumed either way: starting again one line later would be quadratic.
      out.push(...(joined !== flat && joined !== group.map(redactLines).join('') ? [joined] : group))
      i = j + 1
      continue
    }
    out.push(lines[i]); i++
  }
  return out.join('\n')
}

export const redact = (text: string): string => redactLines(unwrapSecrets(text))

// Deep-walks objects/arrays and applies redact() to every string (keys unchanged), returning a copy.
export function redactJson<T>(value: T): T {
  if (typeof value === 'string') return redact(value) as T
  if (Array.isArray(value)) return (value as unknown[]).map((v) => redactJson(v)) as T
  if (value && typeof value === 'object') {
    if (value instanceof Date || value instanceof RegExp) return value
    const out: Record<string, unknown> = {}
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) out[k] = redactJson(v)
    return out as T
  }
  return value
}

const tail = (screen: string, n: number) => screen.split('\n').slice(-n).join('\n')

// The task behind a label, without the attempt counter or the id the daemon adds:
// 'sec-hunt', 'sec-hunt3', 'sec-hunt-2' and 'sec-hunt-7a01' are the same task, so a lead
// that spawns them again and again is running one chain, not four.
export function chainBase(label: string): string {
  const start = label.trim()
  let base = start
  const cut = (re: RegExp) => { const m = re.exec(base); if (m) base = base.slice(0, m.index) }
  cut(/-[0-9a-f]{4,8}$/)   // the id the daemon adds: sec-hunt-7a01
  cut(/-\d+$/)             // an attempt counter: sec-hunt-2
  cut(/\d+$/)              // an attempt counter without the dash: sec-hunt3
  cut(/-[a-z]$/)           // a lettered attempt: sec-hunt-a
  return base || start
}

// A head that sends one seat more than 30 messages in 10 minutes is chatty: in the World's
// trace one head sent 129 messages in 3 hours for 12 merges, and the org sent 510 in 3 hours.
// The count is per (caller, target): a head that talks to two seats is not one chatty head.
export interface MessageEvent {
  ts: number          // epoch ms
  caller: string
  target: string
}

export const CHATTY_LIMIT = 30
export const CHATTY_WINDOW_MS = 10 * 60_000
export const CHATTY_COOLDOWN_MS = 30 * 60_000

// The (caller, target) pairs over the limit in the last 10 minutes. Older events don't count.
export function chattyHeads(events: MessageEvent[], now: number): { caller: string; target: string; count: number }[] {
  const counts = new Map<string, { caller: string; target: string; count: number }>()
  for (const e of events) {
    if (now - e.ts > CHATTY_WINDOW_MS) continue            // older than the window
    const key = `${e.caller}:${e.target}`
    const seen = counts.get(key)
    if (seen) seen.count++
    else counts.set(key, { caller: e.caller, target: e.target, count: 1 })
  }
  return [...counts.values()].filter(c => c.count > CHATTY_LIMIT)
}

// The terminal is sitting at a permission prompt if the visible bottom says so.
export function promptOn(screen: string): string | null {
  const last = tail(screen, 15)
  return /(Permission required|Allow once|Allow always|Do you want to proceed|requires approval|\(y\/n\)|Yes, and don't ask again)/i.test(last)
    ? last.trim() : null
}

// A broad credential search on a terminal: flagged and counted, never blocked.
const SECRET_PATH = /(?:~|\$HOME|\/Users\/[^/\s]+)\/(?:\.ssh|\.aws|\.gnupg|\.netrc|\.config\/gcloud|\.docker\/config\.json|\.gemini\/oauth_creds\.json|\.kimi\/credentials|\.config\/openrouter\/key)(?=[\s/'"]|$)/
const NAME_GLOB = /-name\s+["']?(?:\*\.env|\.env\*|\*\.pem|id_rsa\*|\*credentials\*)/
const RECURSIVE = /\s-[a-zA-Z]*[rR][a-zA-Z]*(?=\s|$)|\s--recursive(?=\s|$)/
const HOME_TARGET = /\s(?:~|\$HOME|\/Users)(?:\/\S*)?(?=\s|$)/
const SECRET_WORD = /password|passwd|secret|token|api_?key/i

function isCredentialHunt(cmd: string): boolean {
  if (/^(cat|less|head|tail|cp|scp|base64)\s/.test(cmd)) return SECRET_PATH.test(cmd)
  if (/^find\s+(?:\/|~|\$HOME)\/?(?=\s|$)/.test(cmd)) return NAME_GLOB.test(cmd)
  if (/^ls\s+-[a-zA-Z]*R/.test(cmd) && /\s(?:\/|~|\$HOME)\/?(?=\s|$)/.test(cmd)) return /\.env|\.pem|id_rsa|credentials/.test(cmd)
  if (/^rg\s/.test(cmd) || (/^grep\s/.test(cmd) && RECURSIVE.test(cmd))) return HOME_TARGET.test(cmd) && SECRET_WORD.test(cmd)
  if (/^security\s+(?:find-generic-password|dump-keychain)\b/.test(cmd)) return true
  return /^(?:printenv|env)\b.*\|\s*grep\b.*(?:key|token|secret|password)/i.test(cmd)
}

// The most recent command line in the last 15 lines that searches for credentials, or null.
export function credentialHunt(screen: string): string | null {
  for (const line of tail(screen, 15).split('\n').reverse()) {
    const cmd = line.replace(/^[\s┃│|❯›>$#%]+/, '').trim()
    if (isCredentialHunt(cmd)) return redact(line.trim().slice(0, 160))
  }
  return null
}

// Claude's status line while a hook runs: "✻ Kneading… (running PreToolUse hook · 15m 58s · ↓ 374 tokens)".
// The timer is the turn's, not the hook's. A hook normally takes milliseconds, so a screen that still
// says this minutes later is a hang (one org, 2026-11-02: 2 h 28 m in PostToolUse, then 2 h+ in PreToolUse).
export function hookHang(screen: string): { hook: string; line: string } | null {
  for (const line of tail(screen, 15).split('\n').reverse()) {
    const m = /\(running (\w+) hook · /.exec(line)
    if (m) return { hook: m[1]!, line: line.trim().slice(0, 160) }
  }
  return null
}
export const HOOK_HANG_MS = 90_000
// Heal runs every 30 s, so a prompt reaches its lead within 45-75 s of appearing.
export const PROMPT_NUDGE_MS = 45_000

const RULES: ((s: Seen) => Finding | null)[] = [
  s => /Update available/.test(s.screen) && /Update now/.test(s.screen) && /Skip/.test(s.screen)
    ? { issue: 'codex-update-menu', summary: 'Codex update menu is blocking input', press: ['Down', 'Enter'] } : null,
  // Escape ended the stuck turn at once ("Escape freed it", Engineering); the next turn may hang again.
  s => s.cli === 'claude' && (s.hookForMs ?? 0) >= HOOK_HANG_MS && hookHang(s.screen)
    ? { issue: 'hook-hang', summary: `${s.label} has sat in a ${hookHang(s.screen)!.hook} hook for ${Math.round(s.hookForMs! / 60_000)}+ min`,
        press: ['Escape'], type: 'A hook hung your last turn, so it was interrupted. Carry on from where you were.' } : null,
  // Only the bottom of a still screen counts: an agent quoting another's limit message mid-
  // conversation is not itself blocked. Passing output (a ✓ test line) mentioning quota is
  // success, not blockage, whichever CLI printed it.
  s => s.quietMs > 20_000 && /(hit your usage limit|usage limit reached|rate limit(ed)? exceeded|5h limit: 0%|out of (credits|quota)|free limit reached|free usage exceeded|usage limit exceeded|go usage limit)/i.test(
    tail(s.screen, 12).split('\n').filter(l => !/^\s*(?:✓|✔|✅|PASS)\s/.test(l)).join('\n'))
    ? { issue: 'quota', summary: `${s.label} is out of model quota`,
        notify: `${s.label} (${s.cli}) has hit its usage limit and can't work until it resets. Reassign its task: kill it and spawn the work on another CLI (cli opencode runs free models).` } : null,
  // A turn the network or a sleeping laptop cut off: the agent sits at its prompt looking idle
  // until a heartbeat, which can be hours away once they back off. Telling it to go on is safe.
  s => s.quietMs > 60_000 && /API Error: (?:Your computer went to sleep|Can't reach the API server|Connection (?:dropped|refused)|529 Overloaded|The response stopped arriving|Server error mid-response)/.test(tail(s.screen, 10))
    ? { issue: 'api-dropped', summary: `${s.label}'s last turn was cut off by a network or API error`,
        type: 'Your last turn was cut off by a network or API error. Carry on from where you were.' } : null,
  s => s.exitCode !== null && s.exitCode !== 0 && s.exitCode !== 129
    ? { issue: 'crashed', summary: `${s.label} exited with code ${s.exitCode}`,
        notify: `${s.label} exited unexpectedly (code ${s.exitCode}). Read its last screen with read_screen, then respawn it or reassign the work.` } : null,
  // A builder at a permission prompt is blocked until its lead presses. promptForMs counts from the
  // first pass that saw the prompt, so a spinner or clock redrawing nearby can't hold it back (the old
  // quietMs-only rule took 5 to 16 minutes). The lead gets the prompt text and answers with press.
  s => ((s.promptForMs ?? 0) >= PROMPT_NUDGE_MS || s.quietMs > 5 * 60_000) && promptOn(s.screen)
    ? { issue: 'stuck-prompt', summary: `${s.label} is waiting at a permission prompt`,
        notify: `${s.label} is waiting at a permission prompt. It cannot continue until you press. Screen:\n${redact(promptOn(s.screen)!)}\nread_screen it if you need more, then press the option (an approval is yours to judge, nothing is auto-approved).` } : null,
  s => /(message (looks|was|arrived) cut off|starts mid-sentence|got cut off)/i.test(s.screen)
    ? { issue: 'truncated-brief', summary: `${s.label} says its brief arrived cut off`,
        notify: `${s.label} says the message it received was cut off. Send its brief again (type), in full.` } : null,
]

export function diagnose(s: Seen): Finding | null {
  for (const rule of RULES) {
    const f = rule(s)
    if (f) return f
  }
  return null
}

// CLI chrome that reads like trouble but never blocks the agent: Claude Code's footer after its
// background self-update fails. Left in, the classifier blamed it for idle Directors 8 times on 11-03.
const chrome = (screen: string) => screen.split('\n').filter(l => !/Auto-update failed/.test(l)).join('\n')

// Only screens that look wrong and have been still a while are worth a model call.
export const suspicious = (s: Seen) =>
  s.quietMs > 10 * 60_000 && /(error|failed|exception|panic|traceback|ECONN|ENOENT|EADDRINUSE|✗|stuck|timed? ?out)/i.test(chrome(s.screen))

export const FREE_WATCH_MODEL = 'nvidia/nemotron-3.5-lightning:free'

// The model read a screen anyone can write to, so its prose is steerable and goes only to the log.
// The lead gets the slug, which can't carry a sentence, and looks for itself.
export function parseFinding(label: string, stdout: string): Finding | null {
  const m = /ISSUE:\s*([\w-]+)\s*\|\s*(.+)/.exec(stdout)
  return m ? { issue: `model:${m[1]}`, summary: m[2].trim(), notify: `${label} may be stuck (${m[1].slice(0, 40)}). Read its screen.` } : null
}

// Asks a free model what's wrong. It may only suggest a note for the lead, never keystrokes.
export function classify(s: Seen, model = FREE_WATCH_MODEL): Promise<Finding | null> {
  const prompt = 'You watch AI coding agents running in terminals. Below is the bottom of one terminal that has been idle for a while. ' +
    'If the agent is fine (finished, or waiting for a new task), reply exactly OK. If it is stuck, crashed, looping or blocked, reply ONE line: ' +
    'ISSUE: <short slug> | <one sentence on what is wrong and what its lead should do>.'
  // Under tests there is no real jev; a failed call is treated the same way here.
  if (process.env.HOLON_FAKE_CLIS === '1') return Promise.resolve(null)
  return new Promise(resolve => {
    const child = execFile('jev', [prompt], { env: { ...process.env, JEV_MODEL: model }, timeout: 60_000 }, (err, stdout) => {
      if (err) return resolve(null)
      resolve(parseFinding(s.label, stdout))
    })
    child.stdin?.end(redact(chrome(s.screen)).split('\n').slice(-40).join('\n'))
  })
}
