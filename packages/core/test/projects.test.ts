import { expect, it } from 'vitest'
import { existsSync, mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { addProject, claimHome, listProjects, socketFor } from '../src/projects.ts'

it('the existing home becomes the first project, named after its workspace', () => {
  const root = mkdtempSync(join(tmpdir(), 'holon-'))
  writeFileSync(join(root, 'directive.json'), JSON.stringify({ workspace: '/x/holon-orgs/acme' }))
  expect(listProjects(root)).toEqual([{ slug: 'acme', name: 'acme', home: root, workspace: '/x/holon-orgs/acme' }])
})

it('new projects get their own home and a unique slug', () => {
  const root = mkdtempSync(join(tmpdir(), 'holon-'))
  expect(listProjects(root)[0]).toMatchObject({ slug: 'main', home: root })
  const ws = mkdtempSync(join(tmpdir(), 'gb-'))
  const g = addProject(root, 'Tidyboard', ws)
  expect(g).toMatchObject({ slug: 'tidyboard', home: join(root, 'projects', 'tidyboard'), workspace: ws })
  expect(existsSync(g.home)).toBe(true)
  expect(addProject(root, 'tidyboard').slug).toBe('tidyboard-2')
  expect(listProjects(root).map(p => p.slug)).toEqual(['main', 'tidyboard', 'tidyboard-2'])
  expect(() => addProject(root, '  ')).toThrow(/name/)
})

it('a home too deep for a unix socket path gets a short one', () => {
  expect(socketFor('/Users/x/.holon/projects/tidyboard')).toBe('/Users/x/.holon/projects/tidyboard/holon.sock')
  const deep = socketFor('/private/tmp/' + 'x'.repeat(100))
  expect(deep).toMatch(/^\/tmp\/holon-[0-9a-f]{12}\.sock$/)
  expect(socketFor('/private/tmp/' + 'x'.repeat(100))).toBe(deep)
})

it('an existing folder alone is enough, and a missing one is refused', () => {
  const root = mkdtempSync(join(tmpdir(), 'holon-'))
  const repo = mkdtempSync(join(tmpdir(), 'tidyboard-'))
  expect(addProject(root, '', repo + '/')).toMatchObject({ name: repo.split('/').pop(), workspace: repo + '/' })
  expect(() => addProject(root, '', '/nope/not/here')).toThrow(/no folder/)
})

it('only one daemon may own a project home; a stale lock is taken over', () => {
  const home = mkdtempSync(join(tmpdir(), 'holon-'))
  expect(claimHome(home, process.pid)).toEqual({ ok: true })
  expect(claimHome(home, 999999)).toEqual({ ok: false, owner: process.pid })   // we are alive and own it
  writeFileSync(join(home, 'daemon.pid'), '999998')                                  // a dead owner
  expect(claimHome(home, process.pid)).toEqual({ ok: true })
})

it('a call on a closed daemon connection fails fast instead of hanging, so the app can reconnect', async () => {
  const { createServer } = await import('node:net')
  const { HolonClient } = await import('../src/client.ts')
  const sock = join(mkdtempSync(join(tmpdir(), 'hc-')), 's.sock')
  const server = createServer(s => s.destroy())   // a daemon that goes away
  await new Promise<void>(r => server.listen(sock, r))
  const c = await HolonClient.connect(sock)
  await new Promise(r => c.once('close', r))
  expect(c.closed).toBe(true)
  await expect(c.call('list')).rejects.toThrow(/disconnected/)
  server.close()
})
