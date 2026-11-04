import net from 'node:net'
import { chmodSync, existsSync, unlinkSync } from 'node:fs'
import type { Holon } from './holon.ts'
import { installedClis } from './adapters.ts'

// Newline-delimited JSON over a unix socket.
//   request  {id, method, params}      response {id, result} | {id, error}
//   event    {event, payload}          (only on connections that called "subscribe")
// params.caller is the acting terminal's id; absent means you.
type Params = Record<string, any>

function methods(h: Holon): Record<string, (p: Params) => unknown> {
  const caller = (p: Params) => (typeof p.caller === 'string' ? p.caller : null)
  return {
    create: p => h.create(p as any),
    list: () => h.list(),
    write: p => h.write(p.id, p.data),
    resize: p => h.resize(p.id, p.cols, p.rows),
    snapshot: p => h.snapshot(p.id),
    kill: p => h.kill(p.id),
    pause: p => h.pause(p.reason ?? ''),
    resume: () => h.resume(),
    paused: () => h.paused,
    system_suspend: p => h.systemSuspend(String(p.reason ?? 'sleep'), !!p.lock),
    system_resume: p => h.systemResume(Number(p.sleptMs) || 0),
    merging: () => h.merging(),
    busy_seats: () => h.busySeats(),
    paused_seats: () => h.pausedSeats(),
    summary: () => h.summary(),
    list_reports: p => h.listReports(caller(p)),
    read_screen: p => h.readScreen(caller(p), p.id, p.scrollback),
    type: p => h.type(caller(p), p.id, p.text, p.submit),
    press: p => h.press(caller(p), p.id, p.key),
    wait: p => h.wait(caller(p), p.id, p.quietMs, p.timeoutMs),
    escalate: p => h.escalate(caller(p), p.message, p.timeoutMs, p.kind, { blocks: p.blocks, recommend: p.recommend, items: p.items }),
    update_human: p => h.update(caller(p), p.text),
    set_autopilot: p => h.setAutopilot(!!p.on),
    answer: p => h.answer(caller(p), p.id, p.text),
    withdraw: p => h.withdraw(caller(p), p.id, p.reason),
    answer_item: p => h.answerItem(caller(p), p.id, p.index, p.text),
    escalations: () => h.listEscalations(),
    nudges: () => h.dueNudges(),
    // The daemon runs under the login PATH, so only it can say which agent CLIs are really installed.
    installed_clis: () => installedClis(),
    start_directive: p => h.startDirective(p.text, p.workspace, p.heartbeatMin, p.shape, p.audit, p.template),
    board_list: p => h.listTasks(p.status),
    board_post: p => h.postTask(caller(p), p.title, p.detail),
    board_claim: p => h.claimTask(caller(p), p.id),
    board_update: p => h.updateTask(caller(p), p.id, { title: p.title, detail: p.detail }),
    board_card: p => h.boardCard(p.id),
    board_done: p => h.finishTask(caller(p), p.id, p.result, p.dropped),
    review: () => h.review(Date.now(), 120, true),
    scorecard: () => h.scorecard(),
    trace_dir: () => h.traceDir(),
    usage: () => h.refreshUsage(),
    heal: p => h.heal(Date.now(), p.useModel !== false),
    second_opinion: p => h.secondOpinion(caller(p), p.question, p.evidence ?? '', p.timeoutMs, p.reviewers),
    verdict: p => h.verdict(caller(p), p.id, p.decision, p.reasoning),
    dissolve_council: () => h.dissolveCouncil(),
    critique: p => h.critique(caller(p), p.id, p.text),
    set_treasury: p => h.setTreasury(p as any),
    treasury: p => h.treasuryView(caller(p)),
    kill_report: p => h.killReport(caller(p), p.id, p.reason ?? '', p.force),
    merge_report: p => h.mergeReport(caller(p), p.id, p.testCmd),
    set_test_cmd: p => h.setTestCmd(p.cmd ?? null),
    kb_search: p => h.kbSearch(p.query ?? '', p.kind),
    kb_read: p => h.kbRead(caller(p), p.path),
    kb_write: p => h.kbWrite(caller(p), p.kind, p.title, p.body, !!p.shared),
    kb: () => h.kbOverview(),
    kb_list: () => h.kbList(),
    set_heartbeat: p => h.setHeartbeat(p.minutes ?? null),
    directive: () => h.getDirective(),
    set_goals: p => h.setGoals(caller(p), p.goals, p.proposalId),
    seat_council: p => h.seatCouncil(p.clis),
    propose: p => h.propose(caller(p), p.title, p.rationale, p.timeoutMs),
    vote: p => h.vote(caller(p), p.id, p.vote, p.reason),
    deliver: p => h.deliver(caller(p), { label: p.label, kind: p.kind, value: p.value, note: p.note }),
    complete: p => h.complete(caller(p), p.summary, p.proposalId),
    ask_director: p => h.askDirector(p.text),
    set_status: p => h.setStatus(caller(p), p.status),
    note_message: p => h.noteMessage(caller(p), p.id, p.status, p.text, p.owner),
    actions: () => h.recentActions(),
    settings: () => h.getSettings(),
    set_settings: p => h.setSettings(p.settings ?? {}),
    roles: () => h.roles(),
    set_grade: p => h.setGrade(caller(p), p.id, p.grade, p.reason ?? ''),
    fire: p => h.fire(caller(p), p.id, p.reason ?? ''),
    promote: p => h.promote(caller(p), p.id, p.dept, p.grade),
    update_role: p => h.updateRole(caller(p), p.id, { charter: p.charter, persona: p.persona }),
    open_department: p => h.openDepartment(caller(p), p.dept, p.charter ? { charter: p.charter, persona: p.persona, grade: p.grade, gate: p.gate } : undefined),
    approve: p => h.approve(caller(p), p.id, p.note),
    reject: p => h.reject(caller(p), p.id, p.reason ?? ''),
    culture: () => h.culture(),
    message: p => h.message(caller(p), p.to, p.text ?? ''),
    set_directive: p => h.setDirective(caller(p), p.text ?? '', p.reason),
    decide_directive: p => h.decideDirective(p.id, !!p.approve, p.note ?? '', p.text),
    design_org: p => h.designOrg(p.text ?? h.getDirective()?.text ?? '', p.workspace ?? h.getDirective()?.workspace ?? ''),
    reshape: p => h.reshape(p.shape ?? 'hierarchy', p.template ?? 'departments', p.departments),
    draft_directive: p => (p.workspace ? h.draftDirectiveFor(p.workspace) : h.draftFromMessages()),
    digest: p => h.refreshDigest(Date.now(), !!p.force),
    set_culture: p => h.setCulture(caller(p), p.text ?? '', p.reason),
    spawn: p => h.spawn(caller(p), { label: p.label, cli: p.cli, cwd: p.cwd, lead: p.lead, yolo: p.yolo, model: p.model, tier: p.tier, worktree: p.worktree, purpose: p.purpose, grade: p.grade, why: p.why, check: p.check }),
  }
}

// A live listener answers a connect; a stale file refuses it. Only a stale file may be replaced:
// unlinking a live daemon's socket strands it, with nobody able to reach it.
const answers = (socketPath: string) => new Promise<boolean>(resolve => {
  const probe = net.createConnection(socketPath)
  probe.once('connect', () => { probe.destroy(); resolve(true) })
  probe.once('error', () => resolve(false))
})

export async function serve(h: Holon, socketPath: string): Promise<net.Server> {
  if (existsSync(socketPath)) {
    if (await answers(socketPath)) throw new Error(`another Holon daemon is already listening on ${socketPath}`)
    unlinkSync(socketPath)
  }
  const table = methods(h)
  const subscribers = new Set<net.Socket>()
  for (const event of ['data', 'exit', 'org', 'action', 'escalation', 'directive', 'settings', 'culture', 'paused']) {
    h.on(event, payload => {
      const line = JSON.stringify({ event, payload }) + '\n'
      for (const s of subscribers) s.write(line)
    })
  }

  const server = net.createServer(sock => {
    let buf = ''
    sock.on('data', chunk => {
      buf += chunk
      let nl: number
      while ((nl = buf.indexOf('\n')) >= 0) {
        const line = buf.slice(0, nl)
        buf = buf.slice(nl + 1)
        if (line.trim()) handle(line)
      }
    })
    sock.on('close', () => subscribers.delete(sock))
    sock.on('error', () => subscribers.delete(sock))

    async function handle(line: string) {
      let id: unknown
      try {
        const req = JSON.parse(line)
        id = req.id
        if (req.method === 'subscribe') {
          subscribers.add(sock)
          return reply({ id, result: true })
        }
        const fn = table[req.method]
        if (!fn) throw new Error(`unknown method "${req.method}"`)
        reply({ id, result: (await fn(req.params ?? {})) ?? null })
      } catch (err) {
        reply({ id, error: (err as Error).message })
      }
    }
    function reply(msg: object) {
      if (!sock.destroyed) sock.write(JSON.stringify(msg) + '\n')
    }
  })

  return new Promise((resolve, reject) => {
    server.once('error', reject)
    // The socket is the only door into the daemon and any caller on it can act as the human, so it
    // is owner-only: created under a 077 umask (no window where it is wider) and chmod'ed to be sure.
    const umask = process.umask(0o077)
    try {
      server.listen(socketPath, () => { chmodSync(socketPath, 0o600); resolve(server) })
    } finally { process.umask(umask) }
  })
}
