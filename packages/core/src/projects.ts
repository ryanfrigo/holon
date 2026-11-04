// Projects: one company each, with its own Holon home (daemon, org, KB, settings). The
// registry lives in the root home; the first project is the root home itself, so an org
// that was already running before projects existed keeps running untouched.
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { basename, join } from 'node:path'
import { createHash } from 'node:crypto'

export interface Project {
  slug: string
  name: string
  home: string
  workspace?: string   // the repo or folder its org works in
}

const file = (root: string) => join(root, 'projects.json')

// Unix socket paths max out around 104 bytes; a deep home gets a short, stable one in /tmp.
export const socketFor = (home: string) => {
  const p = join(home, 'holon.sock')
  return p.length < 100 ? p : `/tmp/holon-${createHash('sha1').update(home).digest('hex').slice(0, 12)}.sock`
}

export const slugify = (name: string) => name.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 32) || 'project'

export function listProjects(root: string): Project[] {
  if (existsSync(file(root))) return JSON.parse(readFileSync(file(root), 'utf8'))
  // Before projects: the root home is the one project, named after its org's workspace.
  let workspace: string | undefined
  try { workspace = JSON.parse(readFileSync(join(root, 'directive.json'), 'utf8'))?.workspace } catch {}
  const name = workspace ? basename(workspace) : 'Main'
  const first = [{ slug: slugify(name), name, home: root, ...(workspace ? { workspace } : {}) }]
  mkdirSync(root, { recursive: true })
  writeFileSync(file(root), JSON.stringify(first, null, 2))
  return first
}

export function addProject(root: string, name: string, workspace?: string): Project {
  const all = listProjects(root)
  // An existing folder is enough: the project is named after it.
  if (workspace?.trim() && !existsSync(workspace.trim())) throw new Error(`no folder at ${workspace.trim()}`)
  if (!name.trim() && workspace?.trim()) name = basename(workspace.trim().replace(/\/+$/, ''))
  if (!name.trim()) throw new Error('a project needs a name or a folder')
  let slug = slugify(name)
  for (let i = 2; all.some(p => p.slug === slug); i++) slug = `${slugify(name)}-${i}`
  const p: Project = { slug, name: name.trim(), home: join(root, 'projects', slug), ...(workspace?.trim() ? { workspace: workspace.trim() } : {}) }
  mkdirSync(p.home, { recursive: true })
  writeFileSync(file(root), JSON.stringify([...all, p], null, 2))
  return p
}

// One daemon per project: a second one would drive the same agents twice. The lock is the pid of
// the daemon that owns the home; a stale lock (its process is gone) is taken over.
export function claimHome(home: string, pid = process.pid): { ok: true } | { ok: false; owner: number } {
  const lock = join(home, 'daemon.pid')
  if (existsSync(lock)) {
    const owner = Number(readFileSync(lock, 'utf8').trim())
    if (owner && owner !== pid) {
      try { process.kill(owner, 0); return { ok: false, owner } } catch {}
    }
  }
  writeFileSync(lock, String(pid))
  return { ok: true }
}

// The machine-wide Holon home: a project's home is <root>/projects/<slug>, the first project is the root itself.
export const rootOf = (home: string) => (/\/projects\/[^/]+\/?$/.test(home) ? home.replace(/\/projects\/[^/]+\/?$/, '') : home)
