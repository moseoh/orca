import { execFileSync } from 'node:child_process'
import * as fs from 'node:fs'
import { createRequire } from 'node:module'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { setTimeout as delay } from 'node:timers/promises'
import * as pty from 'node-pty'
import { afterEach, describe, expect, it } from 'vitest'

// Why: when the daemon's libuv threadpool wedges (#8104-class incidents), the
// async fs.write completions inside node-pty's CustomWriteStream never arrive
// and every pty write queues forever with no error. A FIFO reader-open pins a
// threadpool worker until a writer appears, so opening one per worker
// reproduces the wedge deterministically.
const describeOnUnix = process.platform === 'win32' ? describe.skip : describe

const THREADPOOL_SIZE = Number(process.env.UV_THREADPOOL_SIZE || 4)

type CustomWriteStreamClass = {
  new (
    fd: number,
    encoding?: string
  ): {
    write: (data: string) => void
    dispose: () => void
  }
  WRITE_CALLBACK_TIMEOUT_MS: number
}

function loadCustomWriteStream(): CustomWriteStreamClass {
  const requireFromHere = createRequire(import.meta.url)
  const unixTerminal = requireFromHere('node-pty/lib/unixTerminal') as {
    CustomWriteStream: CustomWriteStreamClass
  }
  return unixTerminal.CustomWriteStream
}

type FifoStarvation = {
  release: () => void
}

function starveThreadpool(fifoPath: string): FifoStarvation {
  execFileSync('mkfifo', [fifoPath])
  const openedFds: number[] = []
  for (let i = 0; i < THREADPOOL_SIZE + 2; i++) {
    fs.open(fifoPath, 'r', (err, fd) => {
      if (!err) {
        openedFds.push(fd)
      }
    })
  }
  return {
    release: () => {
      // Why: a FIFO writer-open wakes every pending reader-open. Open it from a
      // background subshell so release itself never blocks.
      execFileSync('sh', ['-c', `echo > "${fifoPath}" &`])
      setTimeout(() => {
        for (const fd of openedFds) {
          try {
            fs.closeSync(fd)
          } catch {
            // already closed
          }
        }
      }, 500).unref()
    }
  }
}

describeOnUnix('node-pty write threadpool stall fallback', () => {
  const cleanups: (() => void)[] = []

  afterEach(() => {
    while (cleanups.length > 0) {
      cleanups.pop()?.()
    }
  })

  it('delivers pty input via sync fallback while the libuv threadpool is stalled', async () => {
    const dir = fs.mkdtempSync(join(tmpdir(), 'pty-stall-'))
    cleanups.push(() => fs.rmSync(dir, { recursive: true, force: true }))

    // Shrink the fallback wait so the test runs fast
    const CustomWriteStream = loadCustomWriteStream()
    const originalTimeout = CustomWriteStream.WRITE_CALLBACK_TIMEOUT_MS
    CustomWriteStream.WRITE_CALLBACK_TIMEOUT_MS = 300
    cleanups.push(() => {
      CustomWriteStream.WRITE_CALLBACK_TIMEOUT_MS = originalTimeout
    })

    const proc = pty.spawn('/bin/sh', ['-c', 'read line; echo "GOT:$line"'], {
      name: 'xterm-256color',
      cols: 80,
      rows: 24,
      cwd: process.cwd(),
      env: process.env as Record<string, string>
    })
    let output = ''
    proc.onData((data) => {
      output += data
    })
    cleanups.push(() => proc.kill())

    // Let the shell reach its `read` before starving the pool
    await delay(300)
    const starvation = starveThreadpool(join(dir, 'stall.fifo'))
    cleanups.push(() => starvation.release())

    // Sanity: async fs completions must no longer come back
    let statDone = false
    fs.stat('/tmp', () => {
      statDone = true
    })
    await delay(300)
    expect(statDone).toBe(false)

    // The first write is sacrificed to the wedged fs.write (abandoned when the
    // fallback engages). What matters is that writes after the fallback reach
    // the shell.
    proc.write('x')
    await delay(700)
    proc.write('hello\n')

    const deadline = Date.now() + 5000
    while (Date.now() < deadline && !output.includes('GOT:')) {
      await delay(100)
    }

    expect(output).toContain('GOT:hello')
  }, 20000)
})

describeOnUnix('CustomWriteStream sync fallback', () => {
  const FAKE_FD = 987654

  type WriteHarness = {
    stream: InstanceType<CustomWriteStreamClass>
    syncWrites: string[]
    pendingCallbacks: ((err: NodeJS.ErrnoException | null, written: number) => void)[]
    releaseEagain: () => void
    restore: () => void
  }

  // Intercepts fs.write/fs.writeSync for FAKE_FD only, so the stream can be
  // driven without a real pty and without touching vitest's own fs usage.
  // Patches the CJS fs exports object (what the node-pty lib captured via
  // require) — the ESM namespace is frozen and cannot be spied.
  function createHarness(opts?: { eagainSyncWrites?: number }): WriteHarness {
    const CustomWriteStream = loadCustomWriteStream()
    const originalTimeout = CustomWriteStream.WRITE_CALLBACK_TIMEOUT_MS
    CustomWriteStream.WRITE_CALLBACK_TIMEOUT_MS = 50

    const syncWrites: string[] = []
    const pendingCallbacks: WriteHarness['pendingCallbacks'] = []
    let remainingEagain = opts?.eagainSyncWrites ?? 0

    const cjsFs = createRequire(import.meta.url)('fs') as typeof fs
    const realWrite = cjsFs.write
    const realWriteSync = cjsFs.writeSync

    cjsFs.write = ((fd: number, ...rest: unknown[]) => {
      if (fd !== FAKE_FD) {
        return (realWrite as unknown as (...args: unknown[]) => unknown)(fd, ...rest)
      }
      const callback = rest.at(-1) as WriteHarness['pendingCallbacks'][number]
      pendingCallbacks.push(callback)
      return undefined
    }) as typeof fs.write

    cjsFs.writeSync = ((fd: number, buffer: Buffer, offset?: number) => {
      if (fd !== FAKE_FD) {
        return (realWriteSync as unknown as (...args: unknown[]) => number)(fd, buffer, offset)
      }
      if (remainingEagain > 0) {
        remainingEagain--
        const err = new Error('EAGAIN') as NodeJS.ErrnoException
        err.code = 'EAGAIN'
        throw err
      }
      syncWrites.push(buffer.subarray(offset ?? 0).toString('utf8'))
      return buffer.byteLength - (offset ?? 0)
    }) as typeof fs.writeSync

    const stream = new CustomWriteStream(FAKE_FD, 'utf8')
    return {
      stream,
      syncWrites,
      pendingCallbacks,
      releaseEagain: () => {
        remainingEagain = 0
      },
      restore: () => {
        stream.dispose()
        cjsFs.write = realWrite
        cjsFs.writeSync = realWriteSync
        CustomWriteStream.WRITE_CALLBACK_TIMEOUT_MS = originalTimeout
      }
    }
  }

  it('abandons the stalled write instead of re-sending it synchronously', async () => {
    const harness = createHarness()
    try {
      harness.stream.write('abc')
      harness.stream.write('def')
      await delay(150)

      // Fallback engaged: 'abc' is abandoned (its in-flight fs.write may still
      // land in the kernel; re-sending it could deliver the bytes twice).
      // 'def' is delivered synchronously.
      expect(harness.syncWrites).toEqual(['def'])

      // Later writes keep using the sync path.
      harness.stream.write('ghi')
      expect(harness.syncWrites).toEqual(['def', 'ghi'])
    } finally {
      harness.restore()
    }
  })

  it('ignores the stalled completion arriving while sync writes are queued behind EAGAIN', async () => {
    const harness = createHarness({ eagainSyncWrites: Number.MAX_SAFE_INTEGER })
    try {
      harness.stream.write('abc')
      harness.stream.write('def')
      await delay(150)

      // Fallback engaged, but 'def' is still queued: every writeSync hits
      // EAGAIN and the drain is waiting on its retry timer.
      expect(harness.syncWrites).toEqual([])

      // The stalled completion finally arrives. Without the guard it would run
      // the async completion logic and shift the queued 'def' out of the queue,
      // silently losing it.
      harness.pendingCallbacks[0]?.(null, 3)

      harness.releaseEagain()
      await delay(100)
      expect(harness.syncWrites).toEqual(['def'])
    } finally {
      harness.restore()
    }
  })

  it('never falls back while async completions arrive normally', async () => {
    const harness = createHarness()
    try {
      harness.stream.write('abc')
      // Deliver the async completion promptly, like a healthy threadpool.
      harness.pendingCallbacks.shift()?.(null, 3)
      await delay(150)

      harness.stream.write('def')
      harness.pendingCallbacks.shift()?.(null, 3)
      await delay(50)

      expect(harness.syncWrites).toEqual([])
    } finally {
      harness.restore()
    }
  })

  it('retries EAGAIN during the sync drain instead of dropping input', async () => {
    const harness = createHarness({ eagainSyncWrites: 1 })
    try {
      harness.stream.write('abc')
      harness.stream.write('def')
      await delay(200)

      expect(harness.syncWrites).toEqual(['def'])
    } finally {
      harness.restore()
    }
  })
})
