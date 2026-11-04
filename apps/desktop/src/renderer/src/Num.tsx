// A number that eases to its new value instead of jumping: it counts up or down over ~400ms,
// so a changing total reads as movement rather than a flicker. Anyone who asked for reduced
// motion gets the number straight away.
import { useEffect, useRef, useState } from 'react'

const DURATION = 400
const easeOut = (t: number) => 1 - (1 - t) ** 3
const plain = (n: number) => Math.round(n).toLocaleString()

// live: a running total that arrives in steps. Each step is spread over the time the previous one
// took to arrive, so the number keeps climbing between updates instead of jumping and waiting.
export function Num({ value, format, duration = DURATION, live = false }: { value: number; format?: (n: number) => string; duration?: number; live?: boolean }) {
  const [shown, setShown] = useState(value)
  const at = useRef(value)
  const frame = useRef<number | undefined>(undefined)
  const changedAt = useRef(0)

  useEffect(() => {
    // The first real value (data arriving after a 0) shows at once rather than counting up from nothing.
    if (at.current === 0 || window.matchMedia('(prefers-reduced-motion: reduce)').matches) {
      at.current = value
      setShown(value)
      return
    }
    const from = at.current
    if (from === value) return
    const start = performance.now()
    const span = live ? Math.min(90_000, Math.max(2000, changedAt.current ? start - changedAt.current : 30_000)) : duration
    changedAt.current = start
    const step = (now: number) => {
      const t = Math.min(1, (now - start) / span)
      // A long roll (a live counter between polls) moves at a steady rate; a short one eases out.
      const v = t === 1 ? value : from + (value - from) * (span >= 2000 ? t : easeOut(t))
      at.current = v
      setShown(v)
      if (t < 1) frame.current = requestAnimationFrame(step)
    }
    frame.current = requestAnimationFrame(step)
    return () => { const f = frame.current; if (f !== undefined) cancelAnimationFrame(f) }
  }, [value, duration, live])

  return <span className="num-anim">{(format ?? plain)(shown)}</span>
}
