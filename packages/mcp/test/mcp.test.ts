import { afterEach, expect, it } from 'vitest'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type net from 'node:net'
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js'
import { MCP_ENTRY } from '../../core/src/paths.ts'
import { Holon, serve } from '../../core/src/index.ts'

let h: Holon, server: net.Server, mcp: Client
afterEach(async () => { await mcp?.close(); server?.close(); h?.shutdown() })

const text = (r: any) => r.content[0].text as string

it('exposes the lead tools and drives a report through them', async () => {
  const home = mkdtempSync(join(tmpdir(), 'holon-'))
  const sock = join(home, 'holon.sock')
  h = new Holon({ home, socketPath: sock, mcpEntry: MCP_ENTRY })
  server = await serve(h, sock)
  const lead = h.create({ label: 'Lead', cli: 'shell', cwd: home })
  const rep = h.create({ label: 'Worker', cli: 'shell', cwd: home, parentId: lead.id })

  mcp = new Client({ name: 'test', version: '0' })
  await mcp.connect(new StdioClientTransport({
    command: process.execPath,
    args: [MCP_ENTRY],
    env: { ...process.env as Record<string, string>, HOLON_TERMINAL_ID: lead.id, HOLON_SOCKET: sock },
  }))

  const { tools } = await mcp.listTools()
  expect(tools.map(t => t.name).sort()).toEqual(['answer', 'approve', 'board_claim', 'board_done', 'board_list', 'board_post', 'board_update', 'complete', 'critique', 'culture', 'deliver', 'escalate', 'fire', 'kb_read', 'kb_search', 'kb_write', 'kill_report', 'list_reports', 'merge_report', 'message', 'note_message', 'open_department', 'press', 'promote', 'propose', 'read_screen', 'reject', 'roles', 'second_opinion', 'set_culture', 'set_directive', 'set_goals', 'set_grade', 'set_status', 'spawn', 'treasury', 'type', 'update_human', 'verdict', 'vote', 'wait', 'withdraw'])

  const reports = JSON.parse(text(await mcp.callTool({ name: 'list_reports', arguments: {} })))
  expect(reports.map((r: any) => r.id)).toEqual([rep.id])

  await mcp.callTool({ name: 'wait', arguments: { id: rep.id, quietMs: 2000 } })
  await mcp.callTool({ name: 'type', arguments: { id: rep.id, text: 'echo via-mcp' } })
  const waited = JSON.parse(text(await mcp.callTool({ name: 'wait', arguments: { id: rep.id, quietMs: 1500 } })))
  expect(waited.screen).toMatch(/^via-mcp$/m)

  const denied = await mcp.callTool({ name: 'type', arguments: { id: lead.id, text: 'x' } })
  expect(denied.isError).toBe(true)
  expect(text(denied)).toMatch(/not your report/)
})

it('reconnects to the daemon after it restarts on the same socket', async () => {
  const home = mkdtempSync(join(tmpdir(), 'holon-'))
  const sock = join(home, 'holon.sock')
  h = new Holon({ home, socketPath: sock, mcpEntry: MCP_ENTRY })
  server = await serve(h, sock)
  const conns = new Set<net.Socket>()
  server.on('connection', c => conns.add(c))
  const lead = h.create({ label: 'Lead', cli: 'shell', cwd: home })
  const rep = h.create({ label: 'Worker', cli: 'shell', cwd: home, parentId: lead.id })

  mcp = new Client({ name: 'test', version: '0' })
  await mcp.connect(new StdioClientTransport({
    command: process.execPath,
    args: [MCP_ENTRY],
    env: { ...process.env as Record<string, string>, HOLON_TERMINAL_ID: lead.id, HOLON_SOCKET: sock },
  }))
  const ids = async () => JSON.parse(text(await mcp.callTool({ name: 'list_reports', arguments: {} }))).map((r: any) => r.id)
  expect(await ids()).toEqual([rep.id])

  // The daemon goes away and comes back on the same socket path.
  await new Promise<void>(resolve => { server.close(() => resolve()); for (const c of conns) c.destroy() })
  // A real restart takes seconds; give the MCP process a moment to see its socket close.
  await new Promise(r => setTimeout(r, 300))
  server = await serve(h, sock)
  expect(await ids()).toEqual([rep.id])
})
