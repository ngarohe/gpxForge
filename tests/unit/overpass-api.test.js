import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { fetchBridgesAndTunnels } from '../../src/api/overpass.js'

function makeResponse(status, body, headers = {}) {
  return {
    ok: status >= 200 && status < 300,
    status,
    headers: { get: (k) => headers[k] ?? headers[k?.toLowerCase?.()] ?? null },
    text: async () => body,
  }
}

function makePayload() {
  return JSON.stringify({
    elements: [
      { type: 'count', tags: { ways: 1 } },
      {
        type: 'way',
        id: 1001,
        tags: { bridge: 'yes', name: 'Bridge A' },
        geometry: [{ lat: 46.0, lon: 14.0 }, { lat: 46.0001, lon: 14.0001 }],
      },
      { type: 'count', tags: { ways: 1 } },
      {
        type: 'way',
        id: 2002,
        tags: { tunnel: 'yes', name: 'Tunnel B' },
        geometry: [{ lat: 46.01, lon: 14.01 }, { lat: 46.011, lon: 14.011 }],
      },
    ],
  })
}

const BOUNDS = { minLat: 0, minLon: 0, maxLat: 0.01, maxLon: 0.01 }

describe('api/overpass hardening', () => {
  beforeEach(() => {
    vi.stubGlobal('fetch', vi.fn())
  })

  afterEach(() => {
    vi.useRealTimers()
    vi.unstubAllGlobals()
    vi.restoreAllMocks()
  })

  it('parses a successful Overpass response', async () => {
    global.fetch.mockResolvedValueOnce(makeResponse(200, makePayload()))
    const res = await fetchBridgesAndTunnels(BOUNDS)
    expect(res.bridges).toHaveLength(1)
    expect(res.tunnels).toHaveLength(1)
    expect(res.bridges[0].name).toBe('Bridge A')
    expect(res.tunnels[0].name).toBe('Tunnel B')
  })

  it('retries transient 504 errors and succeeds on next mirror', async () => {
    vi.useFakeTimers()
    global.fetch
      .mockResolvedValueOnce(makeResponse(504, '{"message":"gateway timeout"}'))
      .mockResolvedValueOnce(makeResponse(504, '{"message":"gateway timeout"}'))
      .mockResolvedValueOnce(makeResponse(504, '{"message":"gateway timeout"}'))
      .mockResolvedValueOnce(makeResponse(200, makePayload()))

    const promise = fetchBridgesAndTunnels(BOUNDS)
    await vi.runAllTimersAsync()
    const res = await promise

    expect(res.bridges).toHaveLength(1)
    expect(res.tunnels).toHaveLength(1)
    expect(global.fetch).toHaveBeenCalledTimes(4)
  })

  it('fails cleanly when all mirrors return non-transient 403', async () => {
    vi.useFakeTimers()
    global.fetch
      .mockResolvedValueOnce(makeResponse(403, 'forbidden'))
      .mockResolvedValueOnce(makeResponse(403, 'forbidden'))
      .mockResolvedValueOnce(makeResponse(403, 'forbidden'))
      .mockResolvedValueOnce(makeResponse(403, 'forbidden'))

    const assertion = expect(fetchBridgesAndTunnels(BOUNDS)).rejects.toThrow(/Overpass unavailable/i)
    await vi.runAllTimersAsync()
    await assertion
  })
})
