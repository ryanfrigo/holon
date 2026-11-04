// Before ship-self restarts the daemons: a restart kills a merge mid-run (its tests die and the
// branch never lands), so wait until no org has one queued or running. Bounded: a stuck merge
// must not leave main shipped and the daemons on old code.
import { HolonClient } from './client.ts'
import { socketFor } from './projects.ts'

async function merging(socket: string) {
  try {
    const c = await HolonClient.connect(socket)
    try { return Number(await c.call('merging')) || 0 } finally { c.close() }
  } catch { return 0 }   // down, or a daemon that predates the call: nothing to wait for
}

// Returns the homes still merging when the bound ran out ([] once every org is quiet).
export async function waitForMerges(homes: string[], o: { timeoutMs?: number; pollMs?: number; socketOf?: (home: string) => string; onWait?: (busy: string[]) => void } = {}) {
  const { timeoutMs = 20 * 60_000, pollMs = 5_000, socketOf = socketFor } = o
  const end = Date.now() + timeoutMs
  let told = false
  for (;;) {
    const busy: string[] = []
    for (const home of homes) if (await merging(socketOf(home)) > 0) busy.push(home)
    if (!busy.length) return []
    if (!told) { o.onWait?.(busy); told = true }
    if (Date.now() >= end) return busy
    await new Promise(r => setTimeout(r, Math.min(pollMs, Math.max(0, end - Date.now()))))
  }
}

async function busySeats(socket: string): Promise<string[]> {
  try {
    const c = await HolonClient.connect(socket)
    try { const r = await c.call('busy_seats'); return Array.isArray(r) ? r.map(String) : [] } finally { c.close() }
  } catch { return [] }   // down, or a daemon that predates the call: nothing to wait for
}

// A restart SIGTERMs every seat's shell, killing a command in flight (exit 137). Waits until none of
// `homes` has a seat mid-command on `quietPolls` consecutive polls (a single sample can land between
// spinner frames, so any busy poll resets the count). Returns the busy seat ids per home still busy
// when the bound ran out ({} once quiet), so the caller can log them.
export async function waitForQuiet(homes: string[], o: { timeoutMs?: number; pollMs?: number; quietPolls?: number; socketOf?: (home: string) => string; onWait?: (busy: Record<string, string[]>) => void } = {}) {
  const { timeoutMs = 10 * 60_000, pollMs = 5_000, quietPolls = 3, socketOf = socketFor } = o
  const end = Date.now() + timeoutMs
  let told = false
  let quiet = 0
  let last: Record<string, string[]> = {}
  for (;;) {
    const busy: Record<string, string[]> = {}
    for (const home of homes) { const ids = await busySeats(socketOf(home)); if (ids.length) busy[home] = ids }
    if (Object.keys(busy).length) {
      quiet = 0; last = busy
      if (!told) { o.onWait?.(busy); told = true }
    } else if (++quiet >= quietPolls) return {}
    if (Date.now() >= end) return last
    await new Promise(r => setTimeout(r, Math.min(pollMs, Math.max(0, end - Date.now()))))
  }
}

// Restarts the orgs one at a time so seats mid-command are only ever cut off in the org being
// restarted, and only after it has had its chance to go quiet: wait for its merges, then for its
// seats (each bounded; on timeout the busy ids are logged and the restart goes ahead), restart it,
// and wait for it to come back before touching the next. A failed org stops the sequence. Returns
// the homes that did not come back.
export async function rollingRestart(homes: string[], o: {
  restart: (home: string) => Promise<void>
  up: (home: string) => Promise<boolean>
  say?: (line: string) => void
  name?: (home: string) => string
  mergeWaitMs?: number
  quietWaitMs?: number
  pollMs?: number
  socketOf?: (home: string) => string
}) {
  const say = o.say ?? (() => {})
  const name = o.name ?? (h => h)
  const { pollMs, socketOf } = o
  for (const home of homes) {
    const merging = await waitForMerges([home], { timeoutMs: o.mergeWaitMs, pollMs, socketOf, onWait: () => say(`${name(home)}: waiting for merges to finish before restarting`) })
    if (merging.length) say(`${name(home)}: still merging after the wait; restarting anyway`)
    const busy = await waitForQuiet([home], { timeoutMs: o.quietWaitMs, pollMs, socketOf, onWait: b => say(`${name(home)}: waiting for ${b[home].length} seat(s) mid-command: ${b[home].join(', ')}`) })
    if (busy[home]) say(`${name(home)}: seats still mid-command after the wait (${busy[home].join(', ')}); restarting anyway`)
    await o.restart(home)
    if (!await o.up(home)) return [home]
  }
  return []
}
