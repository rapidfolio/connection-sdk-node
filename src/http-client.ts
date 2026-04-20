import { z } from 'zod'

import type {
    InvocationTask,
    RegisteredFunctionDefinition,
    ResultPayload,
} from './types.js'

const InvocationContextSchema = z.object({
    id: z.string(),
    environment: z.enum(['sandbox', 'live']),
    runId: z.string().nullable(),
    procedureId: z.string().nullable(),
    procedureVersion: z.string().nullable(),
})

const InvocationTaskSchema = z.object({
    id: z.string(),
    functionName: z.string(),
    args: z.unknown(),
    context: InvocationContextSchema,
})

const PollResponseSchema = z.object({
    invocations: z.array(InvocationTaskSchema),
    queueDepth: z.number().default(0),
})

const FETCH_TIMEOUT_MS = 35_000
const REGISTER_MAX_ATTEMPTS = 3
const RESULT_RETRY_DELAY_MS = 2_000
const HEARTBEAT_MIN_INTERVAL_MS = 30_000

function sleep(ms: number): Promise<void> {
    return new Promise((resolve) => setTimeout(resolve, ms))
}

/**
 * Thin HTTP client for the three Rapid API endpoints used by the SDK:
 * function registration, invocation polling, and result reporting.
 */
export class RapidHttpClient {
    private readonly headers: Record<string, string>
    private readonly lastHeartbeat = new Map<string, number>()

    constructor(
        private readonly baseUrl: string,
        token: string,
        private readonly sdkVersion: string,
        private readonly workerId: string,
    ) {
        this.headers = {
            'Content-Type': 'application/json',
            Authorization: `Bearer ${token}`,
            'X-SDK-Version': sdkVersion,
            'X-Worker-ID': workerId,
        }
    }

    /**
     * Registers function definitions with the platform so the AI agent knows
     * what functions are available and what arguments they accept.
     *
     * Retries up to {@link REGISTER_MAX_ATTEMPTS} times on network errors or
     * 5xx responses. Client errors (4xx) are thrown immediately.
     */
    async registerFunctions(functions: RegisteredFunctionDefinition[]): Promise<void> {
        const body = JSON.stringify({ functions, sdkVersion: this.sdkVersion, workerId: this.workerId })

        for (let attempt = 1; attempt <= REGISTER_MAX_ATTEMPTS; attempt++) {
            let response: Response
            try {
                response = await fetch(`${this.baseUrl}/v1/connect/register`, {
                    method: 'POST',
                    headers: this.headers,
                    body,
                    signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
                })
            } catch {
                if (attempt === REGISTER_MAX_ATTEMPTS) {
                    throw new Error('Registration failed: network error')
                }
                await sleep(attempt * 1_000)
                continue
            }

            if (response.ok) return

            const text = await response.text().catch(() => '')

            // Client errors (4xx) indicate a config problem — retrying won't help
            if (response.status < 500 || attempt === REGISTER_MAX_ATTEMPTS) {
                throw new Error(`Registration failed: ${response.status} ${text}`)
            }

            await sleep(attempt * 1_000)
        }
    }

    /**
     * Polls for pending invocations.
     * Throws {@link TokenRevokedError} on 401 so the caller can stop the loop cleanly.
     * Pass a `stopSignal` to abort the long-poll immediately (e.g. from `stop()`).
     * Pass `limit` to request only as many tasks as available concurrency slots (reserve-before-poll).
     */
    async poll(stopSignal?: AbortSignal, limit = 5): Promise<{ invocations: InvocationTask[], queueDepth: number }> {
        const signals: AbortSignal[] = [AbortSignal.timeout(FETCH_TIMEOUT_MS)]
        if (stopSignal) signals.push(stopSignal)
        const url = `${this.baseUrl}/v1/connect/poll?limit=${Math.min(Math.max(1, limit), 10)}`
        const response = await fetch(url, {
            headers: this.headers,
            signal: AbortSignal.any(signals),
        })

        if (response.status === 401) {
            throw new TokenRevokedError()
        }

        if (!response.ok) {
            throw new Error(`Poll failed: ${response.status}`)
        }

        const { invocations, queueDepth } = PollResponseSchema.parse(await response.json())
        return { invocations: invocations as InvocationTask[], queueDepth }
    }

    /**
     * Posts a function result back to the platform.
     * Retries once after a short delay on failure. Returns false if both
     * attempts fail so the caller can log a warning.
     */
    async postResult(payload: ResultPayload): Promise<boolean> {
        const body = JSON.stringify(payload)

        for (let attempt = 0; attempt < 2; attempt++) {
            if (attempt > 0) await sleep(RESULT_RETRY_DELAY_MS)
            try {
                const response = await fetch(`${this.baseUrl}/v1/connect/result`, {
                    method: 'POST',
                    headers: this.headers,
                    body,
                    signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
                })
                if (response.ok) return true
                // Client errors (4xx except 429) are deterministic — retrying won't help.
                // e.g. 422 when the invocation already timed out server-side.
                // 429 (Too Many Requests) is transient — treat it like a 5xx and retry.
                const isNonRetryable = response.status >= 400 && response.status < 500 && response.status !== 429
                if (isNonRetryable) return false
            } catch {
                // transient network error — retry after delay
            }
        }

        return false
    }

    /**
     * Signals the server that an invocation is still running, extending its timeout window.
     * Throttled: at most one request per {@link HEARTBEAT_MIN_INTERVAL_MS} per invocation.
     * Non-fatal — heartbeat failures are swallowed by the caller.
     */
    async heartbeat(invocationId: string): Promise<void> {
        const now = Date.now()
        const last = this.lastHeartbeat.get(invocationId) ?? 0
        if (now - last < HEARTBEAT_MIN_INTERVAL_MS) return
        this.lastHeartbeat.set(invocationId, now)
        await fetch(`${this.baseUrl}/v1/connect/heartbeat`, {
            method: 'POST',
            headers: this.headers,
            body: JSON.stringify({ invocationId }),
            signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
        })
    }

    /** Remove heartbeat tracking for a completed invocation. */
    clearHeartbeat(invocationId: string): void {
        this.lastHeartbeat.delete(invocationId)
    }
}

/**
 * Thrown by {@link RapidHttpClient.poll} when the API returns 401.
 * Signals that the token has been revoked and polling should stop.
 */
export class TokenRevokedError extends Error {
    constructor() {
        super('Token revoked')
        this.name = 'TokenRevokedError'
    }
}
