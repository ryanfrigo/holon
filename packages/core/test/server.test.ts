import { afterEach, expect, it, vi } from 'vitest'
import { mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type net from 'node:net'
import { Holon } from '../src/holon.ts'
import { serve } from '../src/server.ts'
import { HolonClient } from '../src/client.ts'

let h: Holon, server: net.Server, client: HolonClient
afterEach(() => { client?.close(); server?.close(); h?.shutdown() })

it('serves the API over a unix socket and streams events', async () => {
  const home = mkdtempSync(join(tmpdir(), 'holon-'))
  const sock = join(home, 'holon.sock')
  h = new Holon({ home, socketPath: sock, mcpEntry: '/dev/null' })
  server = await serve(h, sock)
  client = await HolonClient.connect(sock)
  await client.call('subscribe')
  const actions: string[] = []
  let bytes = ''
  client.on('action', a => actions.push(a.action))
  client.on('data', d => { bytes += d.data })

  const lead = await client.call('create', { label: 'Lead', cli: 'shell', cwd: home })
  const rep = await client.call('create', { label: 'Worker', cli: 'shell', cwd: home, parentId: lead.id })
  // Typed input waits in the pty until the shell reads it, so there is no need to wait for a quiet
  // screen first; and the output is awaited by what it says, not by how long the screen sits still.
  await client.call('type', { caller: lead.id, id: rep.id, text: 'echo over-the-socket' })
  await vi.waitFor(async () => {
    const { text } = await client.call('read_screen', { caller: lead.id, id: rep.id, scrollback: 30 })
    expect(text).toMatch(/^over-the-socket$/m)
  }, { timeout: 20_000, interval: 50 })
  await vi.waitFor(() => expect(bytes).toContain('over-the-socket'), { timeout: 20_000, interval: 50 })
  expect(bytes).toContain('over-the-socket')
  expect(actions).toContain('type')
  await expect(client.call('type', { caller: rep.id, id: lead.id, text: 'x' })).rejects.toThrow(/not your report/)
  expect(typeof (await client.call('snapshot', { id: rep.id }))).toBe('string')
})

it('refuses to take over a socket a live daemon answers on, and replaces a stale one', async () => {
  const home = mkdtempSync(join(tmpdir(), 'holon-'))
  const sock = join(home, 'holon.sock')
  h = new Holon({ home, socketPath: sock, mcpEntry: '/dev/null' })
  server = await serve(h, sock)
  const second = new Holon({ home: mkdtempSync(join(tmpdir(), 'holon-')), socketPath: sock, mcpEntry: '/dev/null' })
  await expect(serve(second, sock)).rejects.toThrow(`another Holon daemon is already listening on ${sock}`)
  second.shutdown()
  client = await HolonClient.connect(sock)
  expect(await client.call('subscribe')).toBe(true)

  // A socket file nobody listens on (its daemon died) is replaced, as before.
  client.close(); server.close(); server = undefined as any
  writeFileSync(sock, '')
  const third = new Holon({ home: mkdtempSync(join(tmpdir(), 'holon-')), socketPath: sock, mcpEntry: '/dev/null' })
  server = await serve(third, sock)
  client = await HolonClient.connect(sock)
  expect(await client.call('subscribe')).toBe(true)
  third.shutdown()
})

it('creates the socket owner-only, even under a permissive umask', async () => {
  const { statSync } = await import('node:fs')
  const home = mkdtempSync(join(tmpdir(), 'holon-'))
  const sock = join(home, 'holon.sock')
  h = new Holon({ home, socketPath: sock, mcpEntry: '/dev/null' })
  const old = process.umask(0)
  try { server = await serve(h, sock) } finally { process.umask(old) }
  expect(statSync(sock).mode & 0o777).toBe(0o600)
})

it('installed_clis reports the daemon\'s PATH: codex alone, claude absent', async () => {
  const home = mkdtempSync(join(tmpdir(), 'holon-'))
  const bin = mkdtempSync(join(tmpdir(), 'holon-'))
  writeFileSync(join(bin, 'codex'), '#!/bin/sh\n', { mode: 0o755 })
  vi.stubEnv('PATH', bin)
  const sock = join(home, 'holon.sock')
  h = new Holon({ home, socketPath: sock, mcpEntry: '/dev/null' })
  server = await serve(h, sock)
  client = await HolonClient.connect(sock)
  const list: string[] = await client.call('installed_clis')
  vi.unstubAllEnvs()
  expect(list).toContain('codex')
  expect(list).toContain('shell')
  expect(list).not.toContain('claude')
})
