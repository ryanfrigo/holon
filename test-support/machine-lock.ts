import { mkdirSync, readFileSync, rmSync, rmdirSync, statSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const LOCK_DIR = join(tmpdir(), 'holon-test.lock')
const GUARD_DIR = `${LOCK_DIR}.guard`
const PID_FILE = join(LOCK_DIR, 'pid')
const PID_GRACE_MS = 5000
const WAIT_TIMEOUT_MS = 10 * 60 * 1000
const POLL_MS = 1000

const sleep = (ms: number) => new Promise(resolve => setTimeout(resolve, ms))

function isAlive(pid: number): boolean {
  try {
    process.kill(pid, 0)
    return true
  } catch (err) {
    return (err as NodeJS.ErrnoException).code !== 'ESRCH'
  }
}

function ownerPid(): number | null {
  try {
    const pid = Number.parseInt(readFileSync(PID_FILE, 'utf8').trim(), 10)
    return Number.isInteger(pid) && pid > 0 ? pid : null
  } catch {
    return null
  }
}

function lockAgeMs(): number {
  try {
    return Date.now() - statSync(LOCK_DIR).mtimeMs
  } catch {
    return 0
  }
}

async function acquire(): Promise<void> {
  const deadline = Date.now() + WAIT_TIMEOUT_MS
  let announcedPid: number | null = null

  for (;;) {
    try {
      mkdirSync(GUARD_DIR)
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== 'EEXIST') throw err
      // shortcut: never reclaim a guard automatically; after confirming no contender remains, remove it manually.
      if (Date.now() > deadline) {
        throw new Error(`holon test lock: acquisition guard ${GUARD_DIR} is still held after ${WAIT_TIMEOUT_MS / 60_000} minutes; stop all test contenders before removing it and rerunning.`)
      }
      await sleep(POLL_MS)
      continue
    }

    let pid: number | null
    let abandoned = false
    try {
      try {
        mkdirSync(LOCK_DIR)
        writeFileSync(PID_FILE, String(process.pid))
        return
      } catch (err) {
        if ((err as NodeJS.ErrnoException).code !== 'EEXIST') throw err
      }

      pid = ownerPid()
      // A missing pid can be the short gap between mkdir and writing the owner.
      abandoned = pid === null ? lockAgeMs() > PID_GRACE_MS : !isAlive(pid)
      if (abandoned) rmSync(LOCK_DIR, { recursive: true, force: true })
    } finally {
      rmdirSync(GUARD_DIR)
    }

    if (abandoned) continue
    if (pid !== null && pid !== announcedPid) {
      console.log(`holon test lock: waiting for pid ${pid}`)
      announcedPid = pid
    }
    if (Date.now() > deadline) {
      throw new Error(`holon test lock: still held by pid ${pid ?? 'unknown'} after ${WAIT_TIMEOUT_MS / 60_000} minutes; giving up. If that process is gone, remove ${LOCK_DIR} and rerun.`)
    }
    await sleep(POLL_MS)
  }
}

let held = false

function release(): void {
  if (!held) return
  held = false
  try {
    if (ownerPid() === process.pid) rmSync(LOCK_DIR, { recursive: true, force: true })
  } catch {}
}

export default async function setup() {
  await acquire()
  held = true
  process.on('exit', release)
  return async () => {
    process.off('exit', release)
    release()
  }
}
