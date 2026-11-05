// Electron main: makes sure the Holon daemon is running, then bridges its socket to the window.
import { app, BrowserWindow, dialog, ipcMain, type IpcMainInvokeEvent, Notification, powerMonitor, shell } from 'electron'
import { pathToFileURL } from 'node:url'
import { existsSync, readFileSync, statSync, writeFileSync } from 'node:fs'
import { spawn } from 'node:child_process'
import { mkdirSync, openSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { HolonClient } from '../../../../packages/core/src/client.ts'
import { addProject, listProjects, rootOf, socketFor, type Project } from '../../../../packages/core/src/projects.ts'
import { askHeadline, nudgeBody, nudgeButtons, type HumanAsk } from '../../../../packages/core/src/asks.ts'
import { CLIS } from '../../../../packages/core/src/adapters.ts'
import { allPlans, type Plan } from '../../../../packages/core/src/plans.ts'
import { readWarner } from '../../../../packages/core/src/awake.ts'

// The root home holds the project registry; each project runs its own daemon in its own home.
// A project's home (a Director's terminal sets HOLON_HOME to one) still means its root: the app shows every project.
const ROOT = rootOf(process.env.HOLON_HOME || join(homedir(), '.holon'))
// Baked in at build time so the packaged app can find the daemon in this checkout.
declare const __HOLON_ROOT__: string
const REPO_ROOT = __HOLON_ROOT__
const ICON = join(REPO_ROOT, 'apps/desktop/build/icon.png')

app.setName('Holon')

const sleep = (ms: number) => new Promise(r => setTimeout(r, ms))

// The daemon runs on system Node (so node-pty needs no Electron rebuild) and outlives the app.
async function connectOrStartDaemon(home: string): Promise<HolonClient> {
  const SOCKET = socketFor(home)
  try {
    return await HolonClient.connect(SOCKET)
  } catch {
    mkdirSync(home, { recursive: true })
    const log = openSync(join(home, 'daemon.log'), 'a')
    // Through a login shell: apps opened from Finder get a bare PATH, and the daemon
    // needs yours to find node, claude and codex.
    const shell = process.env.SHELL || '/bin/zsh'
    spawn(shell, ['-lc', `exec node ${JSON.stringify(join(REPO_ROOT, 'packages/core/src/daemon.ts'))}`], {
      detached: true,
      stdio: ['ignore', log, log],
      env: { ...process.env, HOLON_HOME: home, HOLON_SOCKET: SOCKET },
    }).unref()
    for (let i = 0; i < 100; i++) {
      await sleep(100)
      try { return await HolonClient.connect(SOCKET) } catch {}
    }
    throw new Error(`holon daemon did not start; see ${join(home, 'daemon.log')}`)
  }
}

// `Holon --shots <dir>`: open hidden, save a PNG of every project's every view, then quit.
// Agents improving the UI look at what the owner sees (scripts/screens.ts runs it).
const shotsAt = process.argv.indexOf('--shots')
const SHOTS = shotsAt > 0 ? process.argv[shotsAt + 1] : undefined

async function captureAll(win: BrowserWindow, dir: string, ensureProject: () => Promise<boolean>) {
  mkdirSync(dir, { recursive: true })
  const js = (code: string) => win.webContents.executeJavaScript(code).catch(e => { throw new Error(`${e.message} in: ${code.slice(0, 120)}`) })
  const settle = () => new Promise(r => setTimeout(r, 2500))
  const name = (t: string) => t.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '')
  const save = async (file: string) => writeFileSync(join(dir, `${file}.png`), (await win.webContents.capturePage()).toPNG())
  await settle()
  // A stranger's first run (screens.ts --fresh) gets a project and a seeded multi-item ask, then a reload to show them.
  if (await ensureProject()) {
    const loaded = new Promise(r => win.webContents.once('did-finish-load', r))
    win.webContents.reload()
    await loaded
    await settle()
  }
  const projects: string[] = await js(`[...document.querySelectorAll('nav.projects > button:not(.add)')].map(b => b.childNodes[0]?.textContent ?? b.textContent)`)
  for (let i = 0; i < projects.length; i++) {
    await js(`document.querySelectorAll('nav.projects > button:not(.add)')[${i}].click()`)
    await settle()
    const views: string[] = await js(`[...document.querySelectorAll('.tabs > button')].map(b => b.childNodes[0]?.textContent ?? b.textContent)`)
    if (!views.length) { await save(name(projects[i])); continue }
    for (let j = 0; j < views.length; j++) {
      await js(`document.querySelectorAll('.tabs > button')[${j}].click()`)
      await settle()
      await save(`${name(projects[i])}-${name(views[j])}`)
    }
  }
  // What a newcomer sees, on the first project: welcome text, the new-terminal CLI choices, settings model rows, plan panel.
  const first = projects.findIndex(n => n !== 'All projects')
  if (first >= 0) {
    const tab = async (label: string) => { await js(`[...document.querySelectorAll('.tabs > button')].find(b => b.textContent.startsWith(${JSON.stringify(label)}))?.click()`); await settle() }
    await js(`document.querySelectorAll('nav.projects > button:not(.add)')[${first}].click()`)
    await settle()
    await tab('Board')
    if (await js(`!!document.querySelector('.welcome')`)) await save('welcome')
    const options: string[] = await js(`(() => {
      const d = document.querySelector('details.new-terminal'); d.open = true
      const sel = d.querySelector('select'); sel.size = sel.options.length   // an open list, since a native popup is not in a capture
      d.scrollIntoView({ block: 'center' })   // asks above it push it out of the sidebar's view
      return [...sel.options].map(o => o.textContent)
    })()`)
    await settle()
    writeFileSync(join(dir, 'new-terminal-options.txt'), options.join('\n') + '\n')
    await save('new-terminal')
    await js(`document.querySelector('details.new-terminal select').size = 0`)
    await js(`document.querySelector('.usage-panel')?.scrollIntoView()`)
    await save('plan-panel')
    if (await js(`!!document.querySelector('.ask-items')`)) {
      await js(`document.querySelector('details.new-terminal').open = false`)
      await tab('Board')
      await js(`document.querySelector('.inbox-card:not(.compact)')?.scrollIntoView()`)
      await save('ask-items')
    }
    await tab('Settings')
    await save('settings-models')
  }
}

app.whenReady().then(async () => {
  app.dock?.setIcon(ICON)

  const win = new BrowserWindow({
    width: 1500,
    height: 950,
    backgroundColor: '#12110f',
    title: 'Holon',
    icon: ICON,
    titleBarStyle: 'hiddenInset',
    trafficLightPosition: { x: 14, y: 16 },
    webPreferences: { preload: join(import.meta.dirname, '../preload/index.mjs'), sandbox: false },
    show: !SHOTS,
  })
  // Only the app's own page may run in this window or reach its IPC: a dragged link or file must not.
  const home = process.env.ELECTRON_RENDERER_URL ?? pathToFileURL(join(import.meta.dirname, '../renderer/index.html')).href
  const trusted = (url?: string) => {
    if (!url) return false
    return process.env.ELECTRON_RENDERER_URL ? url.startsWith(new URL(home).origin + '/') : url.split(/[?#]/)[0] === home
  }
  win.webContents.on('will-navigate', (e, url) => { if (!trusted(url)) e.preventDefault() })
  win.webContents.setWindowOpenHandler(({ url }) => { if (/^https?:\/\//.test(url)) void shell.openExternal(url); return { action: 'deny' } })
  const handle = (channel: string, fn: (e: IpcMainInvokeEvent, ...args: any[]) => unknown) =>
    ipcMain.handle(channel, (e, ...args) => {
      if (!trusted(e.senderFrame?.url)) throw new Error(`refused ${channel} from an untrusted page`)
      return fn(e, ...args)
    })
  if (SHOTS) win.webContents.once('did-finish-load', () => void captureAll(win, SHOTS, ensureShotsProject).catch(e => console.error('shots failed:', e)).finally(() => app.quit()))

  // Keep the human posted without them watching: updates and asks become notifications.
  const notified = new Set<string>()
  const notify = (title: string, body: string) => { if (!SHOTS) new Notification({ title, body, icon: ICON }).show() }

  // One client per project, connected (and its daemon started) on first use.
  const clients = new Map<string, Promise<HolonClient>>()
  const client = (p: Project) => {
    if (!clients.has(p.slug)) clients.set(p.slug, connectOrStartDaemon(p.home).then(async c => {
      await c.call('subscribe')
      for (const event of ['data', 'exit', 'org', 'action', 'escalation', 'directive', 'settings', 'culture', 'paused']) {
        c.on(event, payload => {
          if (!win.isDestroyed()) win.webContents.send('holon:event', { slug: p.slug, event, payload })
        })
      }
      c.on('action', (a: { action: string; args: Record<string, unknown> }) => {
        if (a.action === 'update') notify(`${p.name}: update`, String(a.args.text))
        if (a.action === 'stuck_prompt') notify(`${p.name}: ${String(a.args.label)} needs you`, String(a.args.text).slice(0, 300))
        if (a.action === 'low_battery' || a.action === 'sleeping') notify(`${p.name}: Mac may stop the org`, String(a.args.text))
      })
      c.on('escalation', (escs: HumanAsk[]) => {
        for (const e of escs) {
          if (e.to !== null || e.status !== 'open' || notified.has(e.id)) continue
          notified.add(e.id)
          notify(`${p.name} needs you`, askHeadline(e).slice(0, 180))
        }
      })
      // The daemon decides which open asks are a day overdue; here they become a notification with answer buttons.
      const nudge = async () => {
        try {
          for (const e of await c.call('nudges') as HumanAsk[]) {
            if (SHOTS) continue
            const buttons = nudgeButtons(e)
            const n = new Notification({
              title: `${p.name}: still waiting on you`, body: nudgeBody(e), icon: ICON, timeoutType: 'never',
              ...(buttons.length ? { actions: buttons.map(b => ({ type: 'button' as const, text: b.text })) } : {}),
            })
            // The same call the Answer button makes.
            n.on('action', (_ev, i) => { void c.call('answer', { id: e.id, text: buttons[i].answer }).catch(() => {}) })
            n.on('click', () => { if (!win.isDestroyed()) { win.show(); win.focus(); win.webContents.send('holon:open-project', p.slug) } })
            n.show()
          }
        } catch { /* daemon gone; the next connection checks again */ }
      }
      void nudge()
      const nudgeTimer = setInterval(nudge, 30 * 60_000)
      // The daemon restarted (or died): forget this connection so the next call reconnects.
      c.on('close', () => { clearInterval(nudgeTimer); clients.delete(p.slug) })
      return c
    }).catch(err => { clients.delete(p.slug); throw err }))
    return clients.get(p.slug)!
  }
  const project = (slug: string) => {
    const p = listProjects(ROOT).find(x => x.slug === slug)
    if (!p) throw new Error(`no project "${slug}"`)
    return p
  }
  const ensureShotsProject = async () => {
    // Only in a scratch HOME (screens.ts --fresh): never put a demo ask into the owner's real orgs.
    if (process.env.HOLON_SHOTS_SEED !== '1') return false
    const c = await client(listProjects(ROOT)[0] ?? addProject(ROOT, 'Demo'))
    // A shell seat with a seven-decision ask, one item already answered, so the item UI has something to show.
    const seat = await c.call('create', { label: 'Director', cli: 'shell', cwd: homedir() }) as { id: string }
    await c.call('escalate', { caller: seat.id, kind: 'need', blocks: 'G4 launch 0 of 1', message: [
      'Seven calls before launch:', '1. Ship the beta on Friday?', '2. Charge $9 a month?', '3. Use the new blue logo?',
      '4. Open sign-ups to the waitlist first?', '5. Add a free tier?', '6. Announce on Hacker News?', '7. Hire a part-time support person?'].join('\n') })
    const [ask] = await c.call('escalations') as { id: string }[]
    await c.call('answer_item', { id: ask.id, index: 1, text: 'no' })
    return true
  }
  // Every project's daemon comes up with the app, so asks and updates reach you from all of them.
  for (const p of listProjects(ROOT)) void client(p).catch(() => {})

  // The Mac sleeping stops every org. One daemon warns the owner for the whole machine (the one
  // holding awake.json), so suspend goes to that one; resume goes to all, so every org logs the sleep.
  const eachDaemon = (method: string, params: Record<string, unknown>) => {
    for (const p of listProjects(ROOT)) void client(p).then(c => c.call(method, params)).catch(() => {})
  }
  const warnerDaemon = () => {
    const projects = listProjects(ROOT)
    return projects.find(p => p.home === readWarner(ROOT)?.home) ?? projects[0]
  }
  const toWarner = (method: string, params: Record<string, unknown>) => {
    const p = warnerDaemon()
    if (p) void client(p).then(c => c.call(method, params)).catch(() => {})
  }
  let suspendedAt = 0
  powerMonitor.on('suspend', () => { suspendedAt = Date.now(); toWarner('system_suspend', { reason: 'lid closed or system sleep' }) })
  // A lock alone stops nothing; the daemon only warns for it on battery, where a closed lid sleeps the Mac.
  powerMonitor.on('lock-screen', () => toWarner('system_suspend', { reason: 'screen locked on battery', lock: true }))
  powerMonitor.on('unlock-screen', () => toWarner('system_resume', { sleptMs: 0 }))
  powerMonitor.on('resume', () => {
    if (suspendedAt) eachDaemon('system_resume', { sleptMs: Date.now() - suspendedAt })
    suspendedAt = 0
  })

  // Deliverables: links open in your browser, files are revealed in Finder.
  handle('holon:open', (_e, kind: string, value: string) => {
    if (kind === 'url' && /^https?:\/\//.test(value)) return shell.openExternal(value)
    if (kind === 'file') return shell.showItemInFolder(value)
  })
  handle('holon:projects', () => listProjects(ROOT))
  handle('holon:pickFolder', async () => {
    const r = await dialog.showOpenDialog(win, { properties: ['openDirectory', 'createDirectory'], defaultPath: join(homedir(), 'dev') })
    return r.canceled ? null : r.filePaths[0]
  })
  handle('holon:addProject', async (_e, name: string, workspace?: string) => {
    const p = addProject(ROOT, name, workspace)
    await client(p)
    return p
  })
  // Plan limits, polled at most every 10 minutes; a provider that errors keeps its last good bars.
  let plans: { at: number; list: Plan[] } = { at: 0, list: [] }
  handle('holon:plans', async () => {
    if (Date.now() - plans.at > 10 * 60_000) {
      const fresh = await allPlans()
      plans = { at: Date.now(), list: fresh.map(p => (p.error && plans.list.find(o => o.provider === p.provider)?.bars.length ? { ...plans.list.find(o => o.provider === p.provider)!, error: p.error } : p)) }
    }
    return plans.list
  })
  // Which agent CLIs are installed, asked of a daemon: an app opened from Finder has a bare PATH, the daemon the login one.
  // With no daemon reachable, offer everything rather than nothing.
  handle('holon:clis', async () => {
    for (const p of listProjects(ROOT)) {
      try { return await (await client(p)).call('installed_clis') } catch { /* try the next project */ }
    }
    return CLIS
  })
  // The Finance seat's latest verdict on what is worth paying for.
  handle('holon:advice', () => {
    const f = join(ROOT, 'COST-ADVICE.md')
    return existsSync(f) ? { text: readFileSync(f, 'utf8').slice(0, 4000), at: statSync(f).mtime.toISOString(), path: f } : null
  })
  // Tokens by model, summed over every project's agents.
  handle('holon:usage', async () => {
    const byModel = new Map<string, { model: string; cli: string; tokens: number; output: number; cacheRead: number; usd: number; agents: number }>()
    for (const p of listProjects(ROOT)) {
      try {
        // One slow or dead project must not freeze the whole panel.
        const rows = await Promise.race([(await client(p)).call('usage'), new Promise((_, no) => setTimeout(() => no(new Error('timeout')), 20_000))]) as { cli: string; model?: string; tokens: number; output: number; cacheRead: number; costUsd: number | null }[]
        for (const r of rows) {
          const k = `${r.cli}:${r.model ?? 'default'}`
          const m = byModel.get(k) ?? { model: r.model ?? 'default', cli: r.cli, tokens: 0, output: 0, cacheRead: 0, usd: 0, agents: 0 }
          m.tokens += r.tokens; m.output += r.output ?? 0; m.cacheRead += r.cacheRead ?? 0; m.usd += r.costUsd ?? 0; m.agents++; byModel.set(k, m)
        }
      } catch {}
    }
    return [...byModel.values()].sort((a, b) => b.usd - a.usd || b.tokens - a.tokens)
  })
  handle('holon:call', async (_e, slug: string, method: string, params: Record<string, unknown>) => (await client(project(slug))).call(method, params))

  if (process.env.ELECTRON_RENDERER_URL) win.loadURL(process.env.ELECTRON_RENDERER_URL)
  else win.loadFile(join(import.meta.dirname, '../renderer/index.html'))
})

app.on('window-all-closed', () => app.quit())
