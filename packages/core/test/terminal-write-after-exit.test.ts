import { afterEach, expect, it, vi } from 'vitest'
import { Terminal } from '../src/terminal.ts'

const sleep = (ms: number) => new Promise(r => setTimeout(r, ms))
afterEach(() => vi.restoreAllMocks())

// node-pty queues writes and flushes them with fs.write; a flush that lands on a closed pty logs
// "Unhandled pty write error" (EIO/EBADF). Nothing may reach the pty once it is killed or has exited.
async function quietAfter(act: (t: Terminal) => void | Promise<void>) {
  const err = vi.spyOn(console, 'error').mockImplementation(() => {})
  const unhandled: unknown[] = []
  const on = (e: unknown) => { unhandled.push(e) }
  process.on('unhandledRejection', on); process.on('uncaughtException', on)
  const t = new Terminal({ command: '/bin/sh', cwd: process.cwd() })
  await t.waitQuiet(200, 5000)
  await act(t)
  await sleep(400)
  process.off('unhandledRejection', on); process.off('uncaughtException', on)
  expect(err.mock.calls.filter(c => String(c[0]).includes('pty write error'))).toEqual([])
  expect(unhandled).toEqual([])
}

it('writes, presses, types and resizes after kill are no-ops', () => quietAfter(async t => {
  t.kill()
  t.write('echo hi\r'); t.press('Enter'); await t.type('echo hi'); t.resize(100, 30)
}))

it('input still queued when the terminal is killed is dropped, not flushed into a closed pty', () => quietAfter(t => {
  for (let i = 0; i < 200; i++) t.write('x'.repeat(4096))
  t.kill()
}))

it('a terminal query answered after the process exited writes nothing', () => quietAfter(async t => {
  t.write('exit\r')
  await t.waitQuiet(200, 5000)
  await sleep(300)
  // xterm answers a device-attributes query by emitting data; that reply must not hit the dead pty.
  t.screen.write('\x1b[c')
}))
