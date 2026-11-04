import { expect, it } from 'vitest'
import { execFileSync } from 'node:child_process'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { findLeaks, parseDenyList } from '../../../scripts/release-scan.ts'

const ROOT = join(import.meta.dirname, '../../..')
// made-up names: the real list lives in ~/.holon/release-deny.txt, not in the repo
const list = parseDenyList('# comment\nacmecorp\nZed Quill\n+github.com/zedquill/thing\n')

it('flags listed names, real home paths and emails; honours the allow list', () => {
  expect(list).toEqual({ deny: ['acmecorp', 'Zed Quill'], allow: ['github.com/zedquill/thing'] })
  expect(findLeaks('a.ts', 'ws: ~/orgs/AcmeCorp', list)).toHaveLength(1)
  expect(findLeaks('a.ts', 'by zed quill', list)).toHaveLength(1)
  expect(findLeaks('a.ts', 'git clone https://github.com/zedquill/thing', list)).toEqual([])
  expect(findLeaks('a.ts', 'git clone https://github.com/zedquill/other', list)).toEqual([])
  expect(findLeaks('a.ts', ['/Users', 'bob', 'dev/x'].join('/'))).toHaveLength(1)
  expect(findLeaks('a.ts', ['mail me at someone', 'gmail.com'].join('@'))).toHaveLength(1)
  expect(findLeaks('a.ts', "'/Users/x/.holon', 'a@example.com', '/home/$USER/'")).toEqual([])
  expect(findLeaks('a.ts', 'acmecorp')).toEqual([])   // no list, no name rule
})

// Every file the export keeps must pass the generic rules.
it('tracked files that ship in the export have no home paths or emails', () => {
  const files = execFileSync('git', ['ls-files'], { cwd: ROOT, encoding: 'utf8' }).split('\n').filter(Boolean)
  // an export-ignore on a directory covers what's inside it, and check-attr only matches the directory itself
  const dirs = [...new Set(files.flatMap(f => f.split('/').slice(0, -1).map((_, i, a) => a.slice(0, i + 1).join('/'))))]
  const ignoredPaths = new Set(execFileSync('git', ['check-attr', 'export-ignore', '--', ...files, ...dirs], { cwd: ROOT, encoding: 'utf8' })
    .split('\n').filter(l => l.endsWith(': set')).map(l => l.split(': ')[0]))
  const ignored = (f: string) => f.split('/').some((_, i, a) => ignoredPaths.has(a.slice(0, i + 1).join('/')))
  const hits = files.filter(f => !f.endsWith('package-lock.json') && !ignored(f)).flatMap(f => {
    let text: string
    try { text = readFileSync(join(ROOT, f), 'utf8') } catch { return [] }
    return text.includes('\0') ? [] : findLeaks(f, text)
  })
  expect(hits).toEqual([])
})
