import type { KeyboardEvent } from 'react'

// Props that make a clickable div or row work from the keyboard: Tab reaches it, Enter or Space
// does what a click does. Keys pressed inside a nested control (an input, a button) are left alone.
export const press = (fn: () => void) => ({
  role: 'button' as const,
  tabIndex: 0,
  onClick: fn,
  onKeyDown: (e: KeyboardEvent) => {
    if ((e.key === 'Enter' || e.key === ' ') && e.target === e.currentTarget) { e.preventDefault(); fn() }
  },
})
