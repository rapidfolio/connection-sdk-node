import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { z } from 'zod'

import { Connection } from '../connection.js'

const SANDBOX_TOKEN = 'run_sandbox_abc123def456789012345678901234567890123456789012345678901234'

function makeConnection(overrides?: {
    retryDelayMs?: number
    baseUrl?: string
    token?: string
}): Connection {
    return new Connection({
        token: overrides?.token ?? SANDBOX_TOKEN,
        baseUrl: overrides?.baseUrl ?? 'http://localhost:3002',
        retryDelayMs: overrides?.retryDelayMs ?? 60_000,
    })
}

// Mock fetch globally for all tests
const fetchMock = vi.fn()
vi.stubGlobal('fetch', fetchMock)

beforeEach(() => {
    fetchMock.mockReset()
})

afterEach(() => {
    vi.clearAllTimers()
    delete process.env.RAPID_TOKEN
})

// ===== constructor =====

describe('Connection constructor', () => {
    it('accepts no arguments (zero-config, reads env at start)', () => {
        expect(() => new Connection()).not.toThrow()
    })

    it('accepts token option', () => {
        expect(() => new Connection({ token: SANDBOX_TOKEN })).not.toThrow()
    })
})

// ===== start() — token resolution =====

describe('Connection.start() — token resolution', () => {
    it('throws when no token and RAPID_TOKEN not set', async () => {
        delete process.env.RAPID_TOKEN
        const conn = new Connection({ baseUrl: 'http://localhost:3002' })
        await expect(conn.start()).rejects.toThrow('No token provided')
    })

    it('reads RAPID_TOKEN from env when no token option provided', async () => {
        process.env.RAPID_TOKEN = SANDBOX_TOKEN
        fetchMock.mockResolvedValueOnce(
            new Response(JSON.stringify({ success: true }), { status: 200 }),
        )
        fetchMock.mockResolvedValue(
            new Response(JSON.stringify({ invocations: [] }), { status: 200 }),
        )

        const conn = new Connection({ baseUrl: 'http://localhost:3002', retryDelayMs: 60_000 })
        await conn.start()
        conn.stop()

        expect(fetchMock.mock.calls[0][1].headers['Authorization']).toBe(
            `Bearer ${SANDBOX_TOKEN}`,
        )
    })

    it('throws on invalid token format', async () => {
        const conn = new Connection({
            token: 'invalid_token',
            baseUrl: 'http://localhost:3002',
        })
        await expect(conn.start()).rejects.toThrow('Invalid token format')
    })

    it('calls POST /connect/register with function definitions', async () => {
        fetchMock.mockResolvedValueOnce(
            new Response(JSON.stringify({ success: true }), { status: 200 }),
        )
        fetchMock.mockResolvedValue(
            new Response(JSON.stringify({ invocations: [] }), { status: 200 }),
        )

        const conn = makeConnection({ retryDelayMs: 100_000 })
        conn.register('myFunc', {
            description: 'A function',
            input: z.object({ x: z.number() }),
            handler: async ({ x }) => ({ y: x + 1 }),
        })

        await conn.start()
        conn.stop()

        const registerCall = fetchMock.mock.calls[0]
        expect(registerCall[0]).toBe('http://localhost:3002/v1/connect/register')
        const body = JSON.parse(registerCall[1].body as string)
        expect(body.functions).toHaveLength(1)
        expect(body.functions[0].name).toBe('myFunc')
        expect(body.sdkVersion).toBeDefined()
    })

    it('throws immediately on 4xx registration error (no retry)', async () => {
        fetchMock.mockResolvedValueOnce(
            new Response('Unauthorized', { status: 401 }),
        )

        const conn = makeConnection()
        await expect(conn.start()).rejects.toThrow('Registration failed: 401')
        expect(fetchMock.mock.calls).toHaveLength(1) // no retry
    })

    it('retries registration on 5xx and succeeds', async () => {
        vi.useFakeTimers()

        fetchMock
            .mockResolvedValueOnce(new Response('Server Error', { status: 500 }))
            .mockResolvedValueOnce(new Response(JSON.stringify({ success: true }), { status: 200 }))
            .mockResolvedValue(new Response(JSON.stringify({ invocations: [] }), { status: 200 }))

        const conn = makeConnection({ retryDelayMs: 100_000 })
        const startPromise = conn.start()

        await vi.advanceTimersByTimeAsync(1_500) // skip the retry sleep
        await startPromise
        conn.stop()

        const registerCalls = fetchMock.mock.calls.filter((c) =>
            (c[0] as string).endsWith('/v1/connect/register'),
        )
        expect(registerCalls).toHaveLength(2)

        vi.useRealTimers()
    })

    it('throws if start() is called while already running', async () => {
        fetchMock
            .mockResolvedValueOnce(new Response(JSON.stringify({ success: true }), { status: 200 }))
            .mockResolvedValue(new Response(JSON.stringify({ invocations: [] }), { status: 200 }))

        const conn = makeConnection({ retryDelayMs: 60_000 })
        await conn.start()

        await expect(conn.start()).rejects.toThrow('Connection is already running')

        await conn.stop()
    })
})

// ===== register() =====

describe('Connection.register()', () => {
    it('registers a function and returns this (chainable)', () => {
        const conn = makeConnection()
        const result = conn.register('getUser', {
            description: 'Fetch a user',
            input: z.object({ id: z.string() }),
            handler: async ({ id }) => ({ name: `User ${id}` }),
        })
        expect(result).toBe(conn)
    })

    it('is chainable for multiple registrations', () => {
        const conn = makeConnection()
        const result = conn
            .register('fn1', { description: 'First', input: z.object({}), handler: async () => ({}) })
            .register('fn2', { description: 'Second', input: z.object({}), handler: async () => ({}) })
        expect(result).toBe(conn)
    })

    it('rejects duplicate function names', () => {
        const conn = makeConnection()
        conn.register('getUser', {
            description: 'First',
            input: z.object({ id: z.string() }),
            handler: async ({ id }) => ({ name: id }),
        })
        expect(() =>
            conn.register('getUser', {
                description: 'Second',
                input: z.object({ id: z.string() }),
                handler: async ({ id }) => ({ name: id }),
            }),
        ).toThrow("Function 'getUser' is already registered.")
    })

    it('rejects names starting with a digit', () => {
        const conn = makeConnection()
        expect(() =>
            conn.register('123invalid', { description: 'Bad', input: z.object({}), handler: async () => ({}) }),
        ).toThrow('Invalid function name')
    })

    it('rejects names with spaces', () => {
        const conn = makeConnection()
        expect(() =>
            conn.register('my function', { description: 'Bad', input: z.object({}), handler: async () => ({}) }),
        ).toThrow('Invalid function name')
    })
})

// ===== stop() =====

describe('Connection.stop()', () => {
    it('stops polling after stop() is called', async () => {
        fetchMock
            .mockResolvedValueOnce(
                new Response(JSON.stringify({ success: true }), { status: 200 }),
            )
            .mockResolvedValue(
                new Response(JSON.stringify({ invocations: [] }), { status: 200 }),
            )

        const conn = makeConnection({ retryDelayMs: 50 })
        await conn.start()
        conn.stop()

        const callCountAfterStop = fetchMock.mock.calls.length
        await new Promise((r) => setTimeout(r, 200))

        expect(fetchMock.mock.calls.length).toBe(callCountAfterStop)
    })
})

// ===== polling + invocations =====

describe('Polling and invocation execution', () => {
    it('executes a handler and posts result for a claimed invocation', async () => {
        fetchMock.mockResolvedValueOnce(
            new Response(JSON.stringify({ success: true }), { status: 200 }),
        )
        fetchMock.mockResolvedValueOnce(
            new Response(
                JSON.stringify({
                    invocations: [
                        {
                            id: 'inv-1',
                            functionName: 'double',
                            args: { n: 5 },
                            context: {
                                id: 'inv-1',
                                environment: 'sandbox',
                                runId: 'run-abc',
                                procedureId: 'proc-abc',
                                procedureVersion: 'pv-abc',
                            },
                        },
                    ],
                }),
                { status: 200 },
            ),
        )
        const resultCapture = vi.fn().mockResolvedValue(
            new Response(JSON.stringify({ success: true }), { status: 200 }),
        )
        fetchMock.mockImplementation((url: string, init?: RequestInit) => {
            if ((url as string).endsWith('/v1/connect/result')) return resultCapture(url, init)
            return Promise.resolve(
                new Response(JSON.stringify({ invocations: [] }), { status: 200 }),
            )
        })

        const conn = makeConnection({ retryDelayMs: 5_000 })
        conn.register('double', {
            description: 'Double a number',
            input: z.object({ n: z.number() }),
            handler: async ({ n }) => ({ result: n * 2 }),
        })

        await conn.start()
        await new Promise((r) => setTimeout(r, 100))
        conn.stop()

        expect(resultCapture).toHaveBeenCalledOnce()
        const resultBody = JSON.parse(
            resultCapture.mock.calls[0][1]?.body ?? '{}',
        ) as { invocationId: string; success: boolean; data: unknown }
        expect(resultBody.invocationId).toBe('inv-1')
        expect(resultBody.success).toBe(true)
        expect(resultBody.data).toEqual({ result: 10 })
    })

    it('posts failure result when handler throws', async () => {
        fetchMock.mockResolvedValueOnce(
            new Response(JSON.stringify({ success: true }), { status: 200 }),
        )
        fetchMock.mockResolvedValueOnce(
            new Response(
                JSON.stringify({
                    invocations: [
                        {
                            id: 'inv-fail',
                            functionName: 'boom',
                            args: {},
                            context: {
                                id: 'inv-fail',
                                environment: 'sandbox',
                                runId: null,
                                procedureId: null,
                                procedureVersion: null,
                            },
                        },
                    ],
                }),
                { status: 200 },
            ),
        )
        const resultCapture = vi.fn().mockResolvedValue(
            new Response(JSON.stringify({ success: true }), { status: 200 }),
        )
        fetchMock.mockImplementation((url: string, init?: RequestInit) => {
            if ((url as string).endsWith('/v1/connect/result')) return resultCapture(url, init)
            return Promise.resolve(
                new Response(JSON.stringify({ invocations: [] }), { status: 200 }),
            )
        })

        const conn = makeConnection({ retryDelayMs: 5_000 })
        conn.register('boom', {
            description: 'Always throws',
            input: z.object({}),
            handler: async () => { throw new Error('Intentional error') },
        })

        await conn.start()
        await new Promise((r) => setTimeout(r, 100))
        conn.stop()

        expect(resultCapture).toHaveBeenCalledOnce()
        const body = JSON.parse(
            resultCapture.mock.calls[0][1]?.body ?? '{}',
        ) as { success: boolean; error: { code: string; message: string } }
        expect(body.success).toBe(false)
        expect(body.error.code).toBe('EXECUTION_ERROR')
        expect(body.error.message).toBe('Intentional error')
    })

    it('applies exponential backoff on network errors', async () => {
        vi.useFakeTimers()

        fetchMock.mockResolvedValueOnce(
            new Response(JSON.stringify({ success: true }), { status: 200 }),
        )
        fetchMock.mockRejectedValueOnce(new Error('Network error'))
        fetchMock.mockResolvedValue(
            new Response(JSON.stringify({ invocations: [] }), { status: 200 }),
        )

        const conn = makeConnection({ retryDelayMs: 1_000 })
        await conn.start()

        await vi.advanceTimersByTimeAsync(2500)

        expect(fetchMock.mock.calls.length).toBeGreaterThan(2)

        conn.stop()
        vi.useRealTimers()
    })

    it('stops polling and logs error on 401 from poll', async () => {
        const errorLog = vi.fn()
        const conn = new Connection({
            token: SANDBOX_TOKEN,
            baseUrl: 'http://localhost:3002',
            retryDelayMs: 60_000,
            logger: {
                info: vi.fn(),
                warn: vi.fn(),
                error: errorLog,
                debug: vi.fn(),
            },
        })

        fetchMock.mockResolvedValueOnce(
            new Response(JSON.stringify({ success: true }), { status: 200 }),
        )
        fetchMock.mockResolvedValueOnce(new Response('Unauthorized', { status: 401 }))

        await conn.start()
        await new Promise((r) => setTimeout(r, 50))

        expect(errorLog).toHaveBeenCalledWith(
            expect.stringContaining('sandbox'),
        )

        conn.stop()
    })

    it('includes X-SDK-Version header on poll requests', async () => {
        // Register: resolves immediately
        fetchMock.mockResolvedValueOnce(new Response(JSON.stringify({ success: true }), { status: 200 }))
        // Poll: resolves immediately with empty work, then hangs (abort-aware) so stop() can interrupt
        fetchMock.mockResolvedValueOnce(new Response(JSON.stringify({ invocations: [] }), { status: 200 }))
        fetchMock.mockImplementation(
            (_url: unknown, init?: RequestInit) => new Promise<Response>((_resolve, reject) => {
                const onAbort = () => reject(new DOMException('signal is aborted without reason', 'AbortError'))
                if (init?.signal?.aborted) { onAbort(); return }
                init?.signal?.addEventListener('abort', onAbort, { once: true })
            }),
        )

        const conn = makeConnection({ retryDelayMs: 60_000 })
        await conn.start()
        await conn.stop()

        const pollCall = fetchMock.mock.calls.find((c) => (c[0] as string).includes('/v1/connect/poll'))
        expect(pollCall).toBeDefined()
        expect((pollCall![1] as RequestInit).headers as Record<string, string>).toMatchObject({
            'X-SDK-Version': expect.any(String),
        })
    })

    it('stop() resolves quickly even when a long-poll fetch is in flight', async () => {
        // Register mock: returns immediately
        fetchMock.mockResolvedValueOnce(
            new Response(JSON.stringify({ success: true }), { status: 200 }),
        )
        // Poll mock: hangs until aborted — simulates a 25s long-poll.
        // Respects AbortSignal so stop() can interrupt it.
        fetchMock.mockImplementationOnce(
            (_url: unknown, init?: RequestInit) => new Promise<Response>((_resolve, reject) => {
                const onAbort = () => reject(new DOMException('signal is aborted without reason', 'AbortError'))
                if (init?.signal?.aborted) { onAbort(); return }
                init?.signal?.addEventListener('abort', onAbort, { once: true })
            }),
        )

        const conn = makeConnection({ retryDelayMs: 60_000 })
        await conn.start()

        // stop() should abort the hanging poll and return quickly (well under 1s)
        const t0 = Date.now()
        await conn.stop()
        const elapsed = Date.now() - t0

        expect(elapsed).toBeLessThan(500)
    })

    it('retries /result on 429 (treats it as transient, not a client error)', async () => {
        vi.useFakeTimers()

        fetchMock.mockResolvedValueOnce(
            new Response(JSON.stringify({ success: true }), { status: 200 }),
        )
        fetchMock.mockResolvedValueOnce(
            new Response(
                JSON.stringify({
                    invocations: [{
                        id: 'inv-429',
                        functionName: 'doWork',
                        args: {},
                        context: {
                            id: 'inv-429', environment: 'sandbox',
                            runId: null, procedureId: null, procedureVersion: null,
                        },
                    }],
                }),
                { status: 200 },
            ),
        )

        const resultCapture = vi.fn()
            .mockResolvedValueOnce(new Response('Too Many Requests', { status: 429 }))
            .mockResolvedValueOnce(new Response(JSON.stringify({ success: true }), { status: 200 }))

        fetchMock.mockImplementation((url: string, init?: RequestInit) => {
            if ((url as string).endsWith('/v1/connect/result')) return resultCapture(url, init)
            return Promise.resolve(new Response(JSON.stringify({ invocations: [] }), { status: 200 }))
        })

        const conn = makeConnection({ retryDelayMs: 60_000 })
        conn.register('doWork', {
            description: 'Does work',
            input: z.object({}),
            handler: async () => ({ done: true }),
        })

        await conn.start()
        // Let the invocation be received and first /result call happen
        await vi.advanceTimersByTimeAsync(100)
        // Advance past RESULT_RETRY_DELAY_MS (2000ms) to trigger the retry
        await vi.advanceTimersByTimeAsync(2_500)

        conn.stop()

        // Should have retried — two calls to /result
        expect(resultCapture).toHaveBeenCalledTimes(2)

        vi.useRealTimers()
    })

    it('never exceeds maxConcurrency simultaneous handlers', async () => {
        const maxConcurrency = 2

        fetchMock.mockResolvedValueOnce(
            new Response(JSON.stringify({ success: true }), { status: 200 }),
        )

        // Return 4 invocations at once — more than maxConcurrency
        const makeInvocation = (id: string) => ({
            id,
            functionName: 'slow',
            args: {},
            context: { id, environment: 'sandbox', runId: null, procedureId: null, procedureVersion: null },
        })
        fetchMock.mockResolvedValueOnce(
            new Response(JSON.stringify({
                invocations: [
                    makeInvocation('inv-a'),
                    makeInvocation('inv-b'),
                    makeInvocation('inv-c'),
                    makeInvocation('inv-d'),
                ],
            }), { status: 200 }),
        )
        fetchMock.mockResolvedValue(
            new Response(JSON.stringify({ success: true }), { status: 200 }),
        )

        let peakConcurrency = 0
        let currentConcurrency = 0
        const conn = new Connection({
            token: SANDBOX_TOKEN,
            baseUrl: 'http://localhost:3002',
            retryDelayMs: 5_000,
            maxConcurrency,
        })
        conn.register('slow', {
            description: 'Tracks concurrency',
            input: z.object({}),
            handler: async () => {
                currentConcurrency++
                peakConcurrency = Math.max(peakConcurrency, currentConcurrency)
                await new Promise((r) => setTimeout(r, 50))
                currentConcurrency--
                return {}
            },
        })

        await conn.start()
        await new Promise((r) => setTimeout(r, 500))
        await conn.stop()

        expect(peakConcurrency).toBeLessThanOrEqual(maxConcurrency)
    })

    it('sends X-Worker-ID header on poll requests', async () => {
        fetchMock
            .mockResolvedValueOnce(new Response(JSON.stringify({ success: true }), { status: 200 }))
            .mockResolvedValueOnce(new Response(JSON.stringify({ invocations: [] }), { status: 200 }))
            .mockImplementation(
                (_url: unknown, init?: RequestInit) => new Promise<Response>((_resolve, reject) => {
                    const onAbort = () => reject(new DOMException('signal is aborted without reason', 'AbortError'))
                    if (init?.signal?.aborted) { onAbort(); return }
                    init?.signal?.addEventListener('abort', onAbort, { once: true })
                }),
            )

        const conn = new Connection({
            token: SANDBOX_TOKEN,
            baseUrl: 'http://localhost:3002',
            retryDelayMs: 60_000,
            workerId: 'test-worker-1',
        })
        await conn.start()
        await conn.stop()

        const pollCall = fetchMock.mock.calls.find((c) => (c[0] as string).includes('/v1/connect/poll'))
        expect(pollCall).toBeDefined()
        expect((pollCall![1] as RequestInit).headers as Record<string, string>).toMatchObject({
            'X-Worker-ID': 'test-worker-1',
        })
    })

    it('heartbeat throttles rapid calls to one HTTP request per interval', async () => {
        fetchMock
            .mockResolvedValueOnce(new Response(JSON.stringify({ success: true }), { status: 200 }))
            .mockResolvedValueOnce(
                new Response(JSON.stringify({
                    invocations: [{
                        id: 'inv-hb',
                        functionName: 'beater',
                        args: {},
                        context: {
                            id: 'inv-hb', environment: 'sandbox',
                            runId: null, procedureId: null, procedureVersion: null,
                        },
                    }],
                }), { status: 200 }),
            )
            .mockResolvedValue(new Response(JSON.stringify({ success: true }), { status: 200 }))

        const conn = makeConnection({ retryDelayMs: 5_000 })
        conn.register('beater', {
            description: 'Calls heartbeat rapidly',
            input: z.object({}),
            handler: async (_args, ctx) => {
                // Call heartbeat 5 times in a tight loop — should only produce 1 HTTP request
                await ctx.heartbeat()
                await ctx.heartbeat()
                await ctx.heartbeat()
                await ctx.heartbeat()
                await ctx.heartbeat()
                return {}
            },
        })

        await conn.start()
        await new Promise((r) => setTimeout(r, 200))
        await conn.stop()

        const heartbeatCalls = fetchMock.mock.calls.filter((c) =>
            (c[0] as string).endsWith('/v1/connect/heartbeat'),
        )
        expect(heartbeatCalls).toHaveLength(1)
    })

    it('passes InvocationContext to the handler', async () => {
        fetchMock.mockResolvedValueOnce(
            new Response(JSON.stringify({ success: true }), { status: 200 }),
        )
        const invCtx = {
            id: 'inv-ctx',
            environment: 'live',
            runId: 'run-xyz',
            procedureId: 'proc-xyz',
            procedureVersion: 'pv-xyz',
        }
        fetchMock.mockResolvedValueOnce(
            new Response(
                JSON.stringify({
                    invocations: [
                        { id: 'inv-ctx', functionName: 'withCtx', args: {}, context: invCtx },
                    ],
                }),
                { status: 200 },
            ),
        )
        fetchMock.mockResolvedValue(
            new Response(JSON.stringify({ success: true }), { status: 200 }),
        )

        const capturedCtx = vi.fn()
        const conn = makeConnection({ retryDelayMs: 5_000 })
        conn.register('withCtx', {
            description: 'Captures context',
            input: z.object({}),
            handler: async (_args, ctx) => {
                capturedCtx(ctx)
                return {}
            },
        })

        await conn.start()
        await new Promise((r) => setTimeout(r, 100))
        conn.stop()

        expect(capturedCtx).toHaveBeenCalledOnce()
        expect(capturedCtx.mock.calls[0][0]).toMatchObject(invCtx)
    })

})

// ===== connectLocal() =====

describe('Connection.connectLocal()', () => {
    it('runs handler inline without network', async () => {
        const conn = makeConnection()
        conn.register('double', {
            description: 'Double a number',
            input: z.object({ n: z.number() }),
            handler: async ({ n }) => ({ result: n * 2 }),
        })

        const local = conn.connectLocal()
        const result = await local.invoke('double', { n: 5 })
        expect(result).toEqual({ result: 10 })
    })

    it('works without a token (no start() needed)', async () => {
        const conn = new Connection()
        conn.register('ping', {
            description: 'Ping',
            input: z.object({}),
            handler: async () => ({ ok: true }),
        })

        const local = conn.connectLocal()
        const result = await local.invoke('ping', {})
        expect(result).toEqual({ ok: true })
    })

    it('validates input schema', async () => {
        const conn = makeConnection()
        conn.register('typed', {
            description: 'Needs a string',
            input: z.object({ name: z.string() }),
            handler: async ({ name }) => ({ greeting: `Hello ${name}` }),
        })

        const local = conn.connectLocal()
        await expect(local.invoke('typed', { name: 123 })).rejects.toThrow()
    })

    it('throws when function not found', async () => {
        const conn = makeConnection()
        const local = conn.connectLocal()
        await expect(local.invoke('nonExistent', {})).rejects.toThrow(
            "Function 'nonExistent' not registered",
        )
    })

    it('provides local InvocationContext to handler', async () => {
        const conn = makeConnection()
        const capturedCtx = vi.fn()
        conn.register('ctxCheck', {
            description: 'Check ctx',
            input: z.object({}),
            handler: async (_args, ctx) => {
                capturedCtx(ctx)
                return {}
            },
        })

        const local = conn.connectLocal()
        await local.invoke('ctxCheck', {})

        expect(capturedCtx).toHaveBeenCalledOnce()
        expect(capturedCtx.mock.calls[0][0]).toMatchObject({
            id: 'local',
            environment: 'sandbox',
            runId: null,
            procedureId: null,
            procedureVersion: null,
        })
    })
})
