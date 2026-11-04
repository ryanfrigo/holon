import { expect, it, vi } from 'vitest'

const fake = vi.hoisted(() => ({
  data: undefined as ((data: string) => void) | undefined,
  kill: vi.fn(),
}))
vi.mock('node-pty', () => ({ default: { spawn: () => ({
  onData: (callback: (data: string) => void) => { fake.data = callback },
  onExit: vi.fn(), write: vi.fn(), kill: fake.kill,
}) } }))
import { Terminal } from '../src/terminal.ts'

it('ignores queued screen callbacks and PTY output after disposal', () => {
  const terminal = new Terminal({ command: '/bin/sh', cwd: process.cwd() })
  let flushed: (() => void) | undefined
  const write = vi.spyOn(terminal.screen, 'write').mockImplementation((_data, callback) => { flushed = callback })
  const dispose = vi.spyOn(terminal.screen, 'dispose')
  const read = vi.spyOn(terminal, 'readScreen')
  fake.data!('before kill')
  expect(write).toHaveBeenCalledTimes(1)
  terminal.kill()
  expect(() => flushed!()).not.toThrow()
  expect(read).not.toHaveBeenCalled()
  fake.data!('late output')
  expect(write).toHaveBeenCalledTimes(1)
  terminal.kill()
  expect(dispose).toHaveBeenCalledTimes(1)
  expect(fake.kill).toHaveBeenCalledTimes(1)
})
