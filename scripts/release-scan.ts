// What must not reach the public export. The generic rules (a real person's home path, an email)
// live here; the owner's own names, other projects and allowed text come from a local deny list
// that is never committed (release.ts reads ~/.holon/release-deny.txt), so this file names no one.
const HOME_RE = /\/(?:Users|home)\/(?!x\/|alex\/|you\/|me\/|user\/|\$|<|\.\.\.)[A-Za-z][\w.-]*\//
const EMAIL_RE = /[\w.+-]+@(?!example\.|users\.noreply\.github\.com|localhost|t\.t\b)[\w-]+\.[a-z]{2,}/i

// One name per line, case-insensitive; '#' starts a comment; a line starting with '+' is text to allow.
export function parseDenyList(text: string): { deny: string[]; allow: string[] } {
  const lines = text.split('\n').map(l => l.trim()).filter(l => l && !l.startsWith('#'))
  return { deny: lines.filter(l => !l.startsWith('+')), allow: lines.filter(l => l.startsWith('+')).map(l => l.slice(1).trim()) }
}

const esc = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')

export function findLeaks(path: string, text: string, list: { deny: string[]; allow: string[] } = { deny: [], allow: [] }): string[] {
  const nameRe = list.deny.length ? new RegExp(list.deny.map(esc).join('|'), 'i') : null
  const allowRe = list.allow.length ? new RegExp(list.allow.map(esc).join('|'), 'gi') : null
  const hits: string[] = []
  text.split('\n').forEach((raw, i) => {
    const line = allowRe ? raw.replace(allowRe, '') : raw
    const m = nameRe?.exec(line) || HOME_RE.exec(line) || EMAIL_RE.exec(line)
    if (m) hits.push(`${path}:${i + 1}: ${m[0]}`)
  })
  return hits
}
