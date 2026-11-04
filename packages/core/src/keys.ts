// Key names a lead may press, mapped to the bytes a terminal expects.
const PLAIN: Record<string, string> = {
  Enter: '\r',
  Escape: '\x1b',
  Tab: '\t',
  Backspace: '\x7f',
  Space: ' ',
  'C-c': '\x03',
  'C-d': '\x04',
}

const ARROWS: Record<string, string> = { Up: 'A', Down: 'B', Right: 'C', Left: 'D' }

export const KEY_NAMES = [...Object.keys(PLAIN), ...Object.keys(ARROWS)]

export function keyBytes(key: string, applicationCursor: boolean): string {
  if (key in PLAIN) return PLAIN[key]
  if (key in ARROWS) return (applicationCursor ? '\x1bO' : '\x1b[') + ARROWS[key]
  if ([...key].length === 1) return key
  throw new Error(`unknown key "${key}" (use ${KEY_NAMES.join(', ')} or a single character)`)
}
