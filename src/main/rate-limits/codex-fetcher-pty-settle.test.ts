import { beforeEach, describe, expect, it, vi } from 'vitest'

const { childSpawnMock, resolveCodexCommandMock, ptySpawnMock } = vi.hoisted(() => ({
  childSpawnMock: vi.fn(),
  resolveCodexCommandMock: vi.fn(),
  ptySpawnMock: vi.fn()
}))

vi.mock('node:child_process', () => ({
  spawn: childSpawnMock
}))

vi.mock('../codex-cli/command', () => ({
  resolveCodexCommand: resolveCodexCommandMock
}))

vi.mock('node-pty', () => ({
  spawn: ptySpawnMock
}))

// Auth gate is covered separately; these tests assume a signed-in Codex.
vi.mock('./codex-auth-presence', () => ({
  probeCodexAuthPresence: vi.fn(() => 'present')
}))

import { fetchCodexRateLimits } from './codex-fetcher'

function makeDisposable() {
  return { dispose: vi.fn() }
}

describe('fetchCodexRateLimits PTY settle timers', () => {
  beforeEach(() => {
    vi.useFakeTimers()
    vi.clearAllMocks()
    resolveCodexCommandMock.mockReturnValue('codex')
  })

  it('coalesces the PTY fallback status settle timer while output keeps streaming', async () => {
    const ptyHandlers: { onData?: (data: string) => void } = {}

    childSpawnMock.mockImplementation(() => {
      throw new Error('rpc unavailable')
    })
    ptySpawnMock.mockReturnValue({
      onData: vi.fn((callback) => {
        ptyHandlers.onData = callback
        return makeDisposable()
      }),
      onExit: vi.fn(() => makeDisposable()),
      write: vi.fn(),
      kill: vi.fn()
    })

    const resultPromise = fetchCodexRateLimits()
    await vi.advanceTimersByTimeAsync(0)

    const onPtyData = ptyHandlers.onData
    if (!onPtyData) {
      throw new Error('PTY data handler was not registered')
    }

    onPtyData('>')
    expect(vi.getTimerCount()).toBe(1)

    onPtyData('5h limit: 17%\n')
    onPtyData('Weekly limit: 23%\n')
    onPtyData('still rendering\n')
    expect(vi.getTimerCount()).toBe(2)

    await vi.advanceTimersByTimeAsync(500)

    await expect(resultPromise).resolves.toMatchObject({
      session: { usedPercent: 17 },
      weekly: { usedPercent: 23 },
      status: 'ok'
    })
  })

  it('keeps the reset text on the weekly window for weekly-only plans', async () => {
    const ptyHandlers: { onData?: (data: string) => void } = {}

    childSpawnMock.mockImplementation(() => {
      throw new Error('rpc unavailable')
    })
    ptySpawnMock.mockReturnValue({
      onData: vi.fn((callback) => {
        ptyHandlers.onData = callback
        return makeDisposable()
      }),
      onExit: vi.fn(() => makeDisposable()),
      write: vi.fn(),
      kill: vi.fn()
    })

    const resultPromise = fetchCodexRateLimits()
    await vi.advanceTimersByTimeAsync(0)

    const onPtyData = ptyHandlers.onData
    if (!onPtyData) {
      throw new Error('PTY data handler was not registered')
    }

    onPtyData('>')
    onPtyData('Weekly limit: 76%\nResets in 5d 23h\n')

    await vi.advanceTimersByTimeAsync(500)

    const fiveDays23h = (5 * 24 + 23) * 60 * 60 * 1000
    await expect(resultPromise).resolves.toMatchObject({
      session: null,
      weekly: {
        usedPercent: 76,
        resetDescription: '5d 23h',
        resetsAt: Date.now() + fiveDays23h
      },
      status: 'ok'
    })
  })

  it('keeps each window reset text on its own window for dual-window plans', async () => {
    const ptyHandlers: { onData?: (data: string) => void } = {}

    childSpawnMock.mockImplementation(() => {
      throw new Error('rpc unavailable')
    })
    ptySpawnMock.mockReturnValue({
      onData: vi.fn((callback) => {
        ptyHandlers.onData = callback
        return makeDisposable()
      }),
      onExit: vi.fn(() => makeDisposable()),
      write: vi.fn(),
      kill: vi.fn()
    })

    const resultPromise = fetchCodexRateLimits()
    await vi.advanceTimersByTimeAsync(0)

    const onPtyData = ptyHandlers.onData
    if (!onPtyData) {
      throw new Error('PTY data handler was not registered')
    }

    onPtyData('>')
    onPtyData('5h limit: 17% (resets in 2h 30m)\nWeekly limit: 23% (resets in 5d 3h)\n')

    await vi.advanceTimersByTimeAsync(500)

    await expect(resultPromise).resolves.toMatchObject({
      session: {
        usedPercent: 17,
        resetDescription: '2h 30m',
        resetsAt: Date.now() + (2 * 60 + 30) * 60 * 1000
      },
      weekly: {
        usedPercent: 23,
        resetDescription: '5d 3h',
        resetsAt: Date.now() + (5 * 24 + 3) * 60 * 60 * 1000
      },
      status: 'ok'
    })
  })
})
