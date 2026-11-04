import { useEffect, useRef } from 'react'
import { Terminal } from '@xterm/xterm'
import { FitAddon } from '@xterm/addon-fit'
import { holon, type Node } from './holon.ts'

const theme = {
  background: '#171613',
  foreground: '#e8e2d6',
  cursor: '#e8a33d',
  selectionBackground: '#4a3f2c',
  black: '#2a2824', brightBlack: '#6b655a',
}

// A live, typeable view of one terminal. You and its lead can both type into it.
export function Pane({ node, parentLabel, focused, onFocus, expanded = false, onToggle }: {
  node: Node
  parentLabel?: string
  focused: boolean
  onFocus: () => void
  expanded?: boolean
  onToggle?: () => void
}) {
  const host = useRef<HTMLDivElement>(null)
  const termRef = useRef<Terminal | null>(null)

  useEffect(() => {
    const term = new Terminal({
      fontFamily: '"JetBrains Mono", "SF Mono", Menlo, monospace',
      fontSize: 12,
      lineHeight: 1.15,
      cursorBlink: true,
      scrollback: 5000,
      theme,
    })
    const fit = new FitAddon()
    term.loadAddon(fit)
    term.open(host.current!)
    termRef.current = term

    // Bytes that arrive while the snapshot is in flight are replayed after it.
    let ready = false
    const queued: string[] = []
    const off = holon.onEvent(({ event, payload }) => {
      if (event !== 'data' || payload.id !== node.id) return
      if (ready) term.write(payload.data)
      else queued.push(payload.data)
    })
    holon.call<string>('snapshot', { id: node.id }).then(snap => {
      term.write(snap)
      for (const d of queued) term.write(d)
      ready = true
    })

    const input = term.onData(data => { holon.call('write', { id: node.id, data }) })
    const resize = () => {
      try {
        fit.fit()
        holon.call('resize', { id: node.id, cols: term.cols, rows: term.rows })
      } catch {}
    }
    const ro = new ResizeObserver(resize)
    ro.observe(host.current!)

    return () => { off(); input.dispose(); ro.disconnect(); term.dispose() }
  }, [node.id])

  useEffect(() => { if (focused) termRef.current?.focus() }, [focused])

  return (
    <section className={`pane ${focused ? 'focused' : ''} ${expanded ? 'expanded' : ''}`} onMouseDown={onFocus}>
      <header onDoubleClick={onToggle}>
        <span className={`dot ${node.state}`} />
        <strong>{node.label}</strong>
        <span className="muted">{node.cli}{node.lead ? ' · lead' : ''}{node.yolo ? ' · yolo' : ''}</span>
        {parentLabel && <span className="muted">reports to {parentLabel}</span>}
        <span className="muted cwd">{'\u200E' + node.cwd}</span>
        {onToggle && <button className="grow" title={expanded ? 'Back to all terminals' : 'Make this terminal big'} aria-label={expanded ? 'Back to all terminals' : 'Make this terminal big'} onClick={onToggle}>{expanded ? '⤡' : '⤢'}</button>}
      </header>
      <div className="xterm-host" ref={host} />
    </section>
  )
}
