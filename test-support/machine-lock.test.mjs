import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { access, mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { once } from 'node:events'
import test from 'node:test'

const lockModule = new URL('./machine-lock.ts', import.meta.url).href
const childCode = `import setup from ${JSON.stringify(lockModule)}; await setup(); console.log('acquired'); await new Promise(r => setTimeout(r, Number(process.argv[1])));`

function startChild(tempDir, holdMs, code = childCode, extraEnv = {}, arg = String(holdMs)) {
  const child = spawn(process.execPath, ['--experimental-strip-types', '--input-type=module', '-e', code, arg], {
    env: { ...process.env, TMPDIR: tempDir, ...extraEnv },
    stdio: ['pipe', 'pipe', 'inherit'],
  })
  let output = ''
  child.stdout.setEncoding('utf8').on('data', chunk => { output += chunk })
  return { child, output: () => output, exited: once(child, 'exit') }
}

async function waitFor(child, message) {
  const deadline = Date.now() + 15000
  while (!child.output().includes(message)) {
    assert.equal(child.child.exitCode, null, `child exited before ${message}`)
    assert.ok(Date.now() < deadline, `timed out waiting for ${message}`)
    await new Promise(resolve => setTimeout(resolve, 10))
  }
}

for (const signal of ['SIGINT', 'SIGTERM']) {
  test(`${signal} keeps the lock until cleanup finishes`, { timeout: 40000 }, async () => {
    const tempDir = await mkdtemp(join(tmpdir(), 'holon-lock-signal-'))
    const children = []
    try {
      const first = startChild(tempDir, 0, `
        import setup from ${JSON.stringify(lockModule)};
        const teardown = await setup();
        process.on('${signal}', () => console.log('signalled'));
        process.stdin.on('data', async () => { await teardown(); process.exit(0) });
        console.log('acquired');
      `)
      children.push(first)
      await waitFor(first, 'acquired')
      first.child.kill(signal)
      await waitFor(first, 'signalled')
      assert.equal(await readFile(join(tempDir, 'holon-test.lock', 'pid'), 'utf8'), String(first.child.pid))
      const second = startChild(tempDir, 0)
      children.push(second)
      await waitFor(second, 'waiting for pid')
      assert.ok(!second.output().includes('acquired'))
      first.child.stdin.write('finish\n')
      await waitFor(second, 'acquired')
      assert.equal((await first.exited)[0], 0)
      assert.equal((await second.exited)[0], 0)
    } finally {
      for (const { child } of children) if (child.exitCode === null) child.kill('SIGKILL')
      await Promise.all(children.map(child => child.exited))
      await rm(tempDir, { recursive: true, force: true })
    }
  })
}

test('separate processes serialize and a dead owner is recovered', async () => {
  const tempDir = await mkdtemp(join(tmpdir(), 'holon-lock-check-'))
  try {
    const first = startChild(tempDir, 1200)
    while (!first.output().includes('acquired')) await new Promise(resolve => setTimeout(resolve, 10))
    const second = startChild(tempDir, 0)
    const [firstCode] = await first.exited
    assert.equal(firstCode, 0)
    const [secondCode] = await second.exited
    assert.equal(secondCode, 0)
    assert.match(second.output(), /waiting for pid/)
    assert.ok(second.output().indexOf('waiting for pid') < second.output().indexOf('acquired'))

    const stale = join(tempDir, 'holon-test.lock')
    await mkdir(stale)
    await writeFile(join(stale, 'pid'), '2147483647')
    const recovered = startChild(tempDir, 0)
    const [recoveredCode] = await recovered.exited
    assert.equal(recoveredCode, 0)
    assert.match(recovered.output(), /acquired/)
    await assert.rejects(readFile(stale))
  } finally {
    await rm(tempDir, { recursive: true, force: true })
  }
})

test('stale recovery is serialized with other acquisition attempts', { timeout: 30000 }, async () => {
  const tempDir = await mkdtemp(join(tmpdir(), 'holon-lock-race-'))
  const stale = join(tempDir, 'holon-test.lock')
  const barriers = join(tempDir, 'barriers')
  await mkdir(stale)
  await writeFile(join(stale, 'pid'), '2147483647')
  await mkdir(barriers)
  const code = `
    import fs from 'node:fs';
    import { join } from 'node:path';
    import { syncBuiltinESMExports } from 'node:module';
    const dir = process.env.HOLON_LOCK_BARRIERS;
    const role = process.argv[1];
    const originalMkdir = fs.mkdirSync;
    const originalRead = fs.readFileSync;
    const waitFor = name => {
      const until = Date.now() + 10000;
      while (!fs.existsSync(join(dir, name))) {
        if (Date.now() > until) throw new Error('timed out at barrier ' + name);
        Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 5);
      }
    };
    fs.mkdirSync = function(path, ...args) {
      try { return originalMkdir.call(this, path, ...args); }
      catch (error) {
        if (String(path).endsWith('/holon-test.lock.guard') && error.code === 'EEXIST') {
          fs.writeFileSync(join(dir, 'guard-wait'), '');
          console.log('guard-wait');
        }
        throw error;
      }
    };
    fs.readFileSync = function(path, ...args) {
      if (String(path).endsWith('/holon-test.lock/pid')) {
        const snapshot = originalRead.call(this, path, ...args);
        fs.writeFileSync(join(dir, role + '-observed'), '');
        console.log(role + '-observed');
        if (role === 'first') waitFor('resume-first');
        return snapshot;
      }
      return originalRead.call(this, path, ...args);
    };
    syncBuiltinESMExports();
    const { default: setup } = await import(${JSON.stringify(lockModule)});
    await setup();
    console.log('acquired');
    await new Promise(resolve => process.stdin.once('data', resolve));
  `
  const children = []
  try {
    const env = { HOLON_LOCK_BARRIERS: barriers }
    const first = startChild(tempDir, 0, code, env, 'first')
    children.push(first)
    await waitFor(first, 'first-observed')
    const second = startChild(tempDir, 0, code, env, 'second')
    children.push(second)
    const deadline = Date.now() + 10000
    while (!second.output().includes('guard-wait') && !second.output().includes('acquired')) {
      assert.equal(second.child.exitCode, null, 'second contender exited before reaching the lock')
      assert.ok(Date.now() < deadline, 'timed out waiting for second contender')
      await new Promise(resolve => setTimeout(resolve, 10))
    }
    assert.ok(second.output().includes('guard-wait'), 'second contender passed the first contender\'s stale inspection')
    assert.ok(!second.output().includes('acquired'))
    assert.equal(await readFile(join(stale, 'pid'), 'utf8'), '2147483647')
    await writeFile(join(barriers, 'resume-first'), '')
    await waitFor(first, 'acquired')
    await waitFor(second, 'waiting for pid')
    assert.equal(await readFile(join(stale, 'pid'), 'utf8'), String(first.child.pid))
    first.child.stdin.end('finish\n')
    await waitFor(second, 'acquired')
    second.child.stdin.end('finish\n')
    assert.equal((await second.exited)[0], 0)
    assert.equal((await first.exited)[0], 0)
  } finally {
    for (const { child } of children) if (child.exitCode === null) child.kill('SIGKILL')
    await Promise.all(children.map(child => child.exited))
    await rm(tempDir, { recursive: true, force: true })
  }
})

test('an abandoned acquisition guard fails closed at the overall timeout', { timeout: 30000 }, async () => {
  const tempDir = await mkdtemp(join(tmpdir(), 'holon-lock-guard-'))
  const lock = join(tempDir, 'holon-test.lock')
  const guard = join(tempDir, 'holon-test.lock.guard')
  await mkdir(lock)
  await writeFile(join(lock, 'pid'), String(process.pid))
  await mkdir(guard)
  const code = `
    let calls = 0;
    Date.now = () => ++calls === 1 ? 1000 : 601001;
    const { default: setup } = await import(${JSON.stringify(lockModule)});
    try { await setup(); } catch (error) { console.log(error.message); }
  `
  const children = []
  try {
    const child = startChild(tempDir, 0, code)
    children.push(child)
    const [exitCode] = await child.exited
    assert.equal(exitCode, 0)
    assert.match(child.output(), /acquisition guard .*holon-test\.lock\.guard.*stop all test contenders.*removing it/)
    assert.equal(await readFile(join(lock, 'pid'), 'utf8'), String(process.pid))
    await access(guard)
  } finally {
    for (const { child } of children) if (child.exitCode === null) child.kill('SIGKILL')
    await Promise.all(children.map(child => child.exited))
    await rm(tempDir, { recursive: true, force: true })
  }
})
