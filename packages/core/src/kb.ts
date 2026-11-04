import { existsSync, mkdirSync, readdirSync, readFileSync, statSync, writeFileSync } from 'node:fs'
import { join, relative, resolve } from 'node:path'

// The org's shared memory: markdown files that outlive terminals, worktrees and directives.
export const KB_KINDS = ['decision', 'fact', 'lesson', 'playbook', 'person'] as const
export type KbKind = typeof KB_KINDS[number]

export interface KbEntry { path: string; kind: KbKind; title: string; by: string; updated: string; body: string }

const slug = (s: string) => s.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 60) || 'entry'

export class Kb {
  readonly dir: string

  constructor(dir: string) {
    this.dir = dir
    for (const k of KB_KINDS) mkdirSync(join(dir, `${k}s`), { recursive: true })
  }

  // Writing a title that already exists in that kind updates it in place.
  write(kind: KbKind, title: string, body: string, by: string): string {
    if (!KB_KINDS.includes(kind)) throw new Error(`kind must be one of ${KB_KINDS.join(', ')}`)
    const path = `${kind}s/${slug(title)}.md`
    const front = `---\nkind: ${kind}\ntitle: ${JSON.stringify(title)}\nby: ${by}\nupdated: ${new Date().toISOString()}\n---\n\n`
    writeFileSync(join(this.dir, path), front + body.trim() + '\n')
    return path
  }

  read(path: string): KbEntry {
    const full = resolve(this.dir, path)
    if (!full.startsWith(resolve(this.dir) + '/') || !existsSync(full)) throw new Error(`no kb entry "${path}"`)
    return parse(relative(this.dir, full), readFileSync(full, 'utf8'))
  }

  all(): KbEntry[] {
    return KB_KINDS.flatMap(k => readdirSync(join(this.dir, `${k}s`))
      .filter(f => f.endsWith('.md'))
      .map(f => parse(`${k}s/${f}`, readFileSync(join(this.dir, `${k}s`, f), 'utf8'))))
  }

  // Ranks entries by how many query words they contain, titles counting triple; newest first on ties.
  search(query: string, kind?: KbKind, limit = 8) {
    const words = query.toLowerCase().split(/\W+/).filter(w => w.length > 2)
    return this.all()
      .filter(e => !kind || e.kind === kind)
      .map(e => {
        const t = e.title.toLowerCase(), b = e.body.toLowerCase()
        const score = words.reduce((s, w) => s + (t.includes(w) ? 3 : 0) + (b.split(w).length - 1), 0)
        return { e, score }
      })
      .filter(x => words.length === 0 || x.score > 0)
      .sort((a, b) => b.score - a.score || b.e.updated.localeCompare(a.e.updated))
      .slice(0, limit)
      .map(({ e }) => ({ path: e.path, kind: e.kind, title: e.title, by: e.by, updated: e.updated, excerpt: e.body.slice(0, 280) }))
  }

  stats() {
    return Object.fromEntries(KB_KINDS.map(k => [k, readdirSync(join(this.dir, `${k}s`)).filter(f => f.endsWith('.md')).length]))
  }

  lastModified(): number {
    return Math.max(0, ...KB_KINDS.flatMap(k => readdirSync(join(this.dir, `${k}s`)).map(f => statSync(join(this.dir, `${k}s`, f)).mtimeMs)))
  }
}

function parse(path: string, text: string): KbEntry {
  const m = /^---\n([\s\S]*?)\n---\n\n?([\s\S]*)$/.exec(text)
  const meta = Object.fromEntries((m?.[1] ?? '').split('\n').map(l => {
    const i = l.indexOf(':')
    const v = l.slice(i + 1).trim()
    return [l.slice(0, i), v.startsWith('"') ? JSON.parse(v) : v]
  }))
  return { path, kind: meta.kind, title: meta.title ?? path, by: meta.by ?? '', updated: meta.updated ?? '', body: m?.[2] ?? text }
}
