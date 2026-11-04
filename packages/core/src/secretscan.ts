import { redact } from './watcher.ts'

// What a branch adds, scanned for anything that looks like a credential. The scan names the
// file and the line and nothing else: the secret never leaves the machine that holds it, and
// nothing here blocks a merge. It is a warning a reviewer can act on.

export interface SecretWarning {
  file: string
  line: number
  rule: string
}

export interface AllowedLine {
  file: string
  line: number
}

export interface ScanResult {
  warnings: SecretWarning[]
  allowed: AllowedLine[]
}

// A line that carries this marker is a secret somebody meant to add: it is listed, not flagged.
export const ALLOW_MARKER = 'secret-scan:allow'

// The patterns watcher.ts redacts with, in the same order, under names. redact() replaces what
// it finds and keeps no name, so the rule behind a warning comes from here.
const RULES: { name: string; re: RegExp }[] = [
  { name: 'aws-secret-key', re: /\b([A-Za-z0-9_]*aws_secret_access_key[A-Za-z0-9_]*)(\s*[=:]\s*)["']?[A-Za-z0-9/+=]{40,}["']?/i },
  { name: 'github-token', re: /\b(ghp|gho|github_pat)[A-Za-z0-9_-]{10,}\b/ },
  { name: 'github-token', re: /\bgh[sur]_[A-Za-z0-9_-]{30,}\b/ },
  { name: 'slack-token', re: /\bxox[abpr][A-Za-z0-9_-]{10,}\b/ },
  { name: 'stripe-webhook-secret', re: /\bwhsec_[A-Za-z0-9_-]{20,}\b/ },
  { name: 'pem', re: /-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?-----END [A-Z ]*PRIVATE KEY-----/ },
  { name: 'url-credentials', re: /(\b[a-z][a-z0-9+.-]*:\/\/)([^:@\s]*):([^@\s/]+)(@)/ },
  { name: 'generic-secret', re: /\b(password|passwd|secret|token|api_?key)(\s*[=:]\s*)["']?(?=[A-Za-z0-9/+=_-]*\d)[A-Za-z0-9/+=_-]{12,}["']?/i },
  { name: 'provider-key', re: /\b(sk|rk|pk)[-_](live|test|proj|ant|or)?[-_]?[A-Za-z0-9_-]{12,}/ },
  { name: 'aws-access-key', re: /\b(AKIA|AIza)[A-Za-z0-9_-]{10,}/ },
  { name: 'jwt', re: /\b(eyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,})/ },
  { name: 'env-secret', re: /^([A-Z][A-Z0-9_]*(KEY|TOKEN|SECRET|PASSWORD|PASS)[A-Z0-9_]*\s*[=:]\s*).+$/m },
]

// Why a line was flagged: the first pattern that matches it, or a plain shape when none does.
const ruleName = (line: string): string => {
  for (const r of RULES) if (r.re.test(line)) return r.name
  return 'secret-shaped'
}

// A line longer than this is scanned in windows: the patterns above can walk one long line
// quadratically, and one huge line must not hang a merge. The windows overlap by half their
// length, so a secret up to OVERLAP characters long is still found whole.
const WINDOW = 1024
const OVERLAP = 512

// The rule a line trips, or null when nothing in it looks like a secret.
const secretRule = (content: string): string | null => {
  if (content.length <= WINDOW) return redact(content) === content ? null : ruleName(content)
  for (let i = 0; i < content.length; i += WINDOW - OVERLAP) {
    const w = content.slice(i, i + WINDOW)
    if (redact(w) !== w) return ruleName(w)
  }
  return null
}

// A hunk header: '@@ -1,3 +4,6 @@'. The new side starts at the second number.
const HUNK = /^@@ -\d+(?:,\d+)? \+(\d+)(?:,\d+)? @@/

// The new side of a file header: '+++ b/path', or '/dev/null' for a file that is gone.
const newPath = (header: string): string => {
  const path = header.slice(3).split('\t')[0].trim()
  if (path === '/dev/null') return ''
  return path.replace(/^b\//, '')
}

// Walks the unified diff of what a branch adds and checks every added line, outside binary
// files, for a credential. The result holds file and line only: never the line itself.
export function scanAdded(diffText: string): ScanResult {
  const warnings: SecretWarning[] = []
  const allowed: AllowedLine[] = []
  let file = ''
  let newLine = 0
  // 'head': between a file header and its hunks. 'body': in a file, between hunks.
  // 'hunk': inside a hunk. 'binary': a binary file, which has no lines to read.
  let state: 'head' | 'body' | 'hunk' | 'binary' = 'head'

  const check = (content: string, at: number) => {
    if (content.includes(ALLOW_MARKER)) { allowed.push({ file, line: at }); return }
    // A PEM header on its own is the start of a private key, even without its end line.
    if (content.includes('-----BEGIN') && content.includes('PRIVATE KEY-----')) { warnings.push({ file, line: at, rule: 'pem' }); return }
    const rule = secretRule(content)
    if (rule) warnings.push({ file, line: at, rule })
  }

  for (const line of diffText.split('\n')) {
    if (line.startsWith('diff --git ')) { state = 'head'; file = ''; newLine = 0; continue }
    if (state === 'binary') continue
    if (state === 'head') {
      if (line.startsWith('Binary files ') || line.startsWith('GIT binary patch')) { state = 'binary'; continue }
      if (line.startsWith('+++')) { file = newPath(line); state = 'body'; continue }
      continue                       // '---', index, mode and rename lines
    }
    // A hunk header starts a new run of new-side lines, in this file or the next one.
    const m = HUNK.exec(line)
    if (m) { newLine = Number(m[1]); state = 'hunk'; continue }
    if (state === 'body') {
      if (line.startsWith('+++')) { file = newPath(line); continue }
      continue
    }
    if (line === '') continue
    const c = line[0]
    if (c === '+') { check(line.slice(1), newLine); newLine++; continue }
    if (c === '-') continue           // a deletion does not move the new side
    if (c === ' ') { newLine++; continue }
    continue                         // '\ No newline at end of file'
  }
  return { warnings, allowed }
}