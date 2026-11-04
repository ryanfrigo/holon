import { expect, vi } from 'vitest'

// Wait until a terminal's screen shows `want`, instead of a fixed quiet period that a
// loaded machine outlasts (the shell echo arrives late, and the read lands mid-output).
export function seen(h: { readScreen(caller: string | null, id: string, scrollback?: number): { text: string } }, id: string, want: string | RegExp, timeout = 20_000) {
  return vi.waitFor(() => {
    const text = h.readScreen(null, id, 30).text
    expect(typeof want === 'string' ? text.includes(want) : want.test(text), `screen of ${id} never showed ${want}`).toBe(true)
  }, { timeout, interval: 50 })
}
