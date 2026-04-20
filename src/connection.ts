import { randomUUID } from 'node:crypto'

import { z } from 'zod'

import type {
    ConnectionFunction,
    ConnectionLogger,
    InvocationContext,
    InvocationTask,
    LocalConnection,
    RegisteredFunctionDefinition,
    RegisterFunctionOptions,
    ResultPayload,
} from './types.js'

import { RapidHttpClient, TokenRevokedError } from './http-client.js'
import { SDK_VERSION } from './version.js'


const FUNCTION_NAME_PATTERN = /^[a-zA-Z][a-zA-Z0-9_]*$/
const DEFAULT_RETRY_DELAY_MS = 3_000
const DEFAULT_MAX_CONCURRENCY = 10
const MAX_BACKOFF_MS = 60_000
const DEFAULT_BASE_URL = 'https://run.rapidfolio.com'
const SANDBOX_TOKEN_PREFIX = 'run_sandbox_'
const LIVE_TOKEN_PREFIX = 'run_live_'

export interface ConnectionOptions {
    /**
     * Connection token (`run_sandbox_xxx` / `run_live_xxx`).
     * If omitted, reads from the `RAPID_TOKEN` environment variable.
     */
    token?: string
    /** Override the API base URL. Default: `RAPID_API_URL` env var or `https://run.rapidfolio.com` */
    baseUrl?: string
    /** Delay before re-polling after an idle or error cycle, in milliseconds. Default: 3000 */
    retryDelayMs?: number
    /**
     * Maximum number of handler invocations to run concurrently.
     * When the limit is reached, polling pauses until a slot frees up.
     * Default: 10. Increase if your handlers are I/O-bound and memory-safe.
     */
    maxConcurrency?: number
    /**
     * Stable identifier for this worker instance. Included in all requests as `X-Worker-ID`
     * and in registration metadata — useful for debugging in K8s (set to pod name).
     * Default: auto-generated UUID, or read from `RAPID_WORKER_ID` environment variable.
     */
    workerId?: string
    logger?: ConnectionLogger
}

export class Connection {
    private readonly functions = new Map<string, ConnectionFunction>()
    private readonly token: string | undefined
    private readonly baseUrl: string
    private readonly retryDelayMs: number
    private readonly maxConcurrency: number
    private readonly workerId: string
    private readonly log: ConnectionLogger

    private running = false
    private readonly inflight = new Set<Promise<void>>()
    private pollAbort = new AbortController()
    private pollLoopPromise: Promise<void> | null = null

    constructor(options: ConnectionOptions = {}) {
        this.token = options.token
        this.baseUrl = (
            options.baseUrl ??
            process.env.RAPID_API_URL ??
            DEFAULT_BASE_URL
        ).replace(/\/$/, '')
        this.retryDelayMs = options.retryDelayMs ?? DEFAULT_RETRY_DELAY_MS
        this.maxConcurrency = options.maxConcurrency ?? DEFAULT_MAX_CONCURRENCY
        this.workerId = options.workerId ?? process.env.RAPID_WORKER_ID ?? randomUUID()
        this.log = options.logger ?? {
            info: (msg, meta) => console.info(msg, meta ?? ''),
            warn: (msg, meta) => console.warn(msg, meta ?? ''),
            error: (msg, meta) => console.error(msg, meta ?? ''),
            debug: () => undefined,
        }
    }

    // ─── Registration ────────────────────────────────────────────────────────

    /**
     * Register a function handler. Chainable — returns `this`.
     *
     * @example
     * conn.register('getCustomer', {
     *   description: 'Fetch a customer by ID',
     *   input: z.object({ customerId: z.string() }),
     *   handler: async ({ customerId }, ctx) => fetchCustomer(customerId),
     * })
     */
    register<TInput extends z.ZodType>(
        name: string,
        options: RegisterFunctionOptions<TInput>,
    ): this {
        if (!FUNCTION_NAME_PATTERN.test(name)) {
            throw new Error(
                `Invalid function name '${name}'. ` +
                'Names must start with a letter and contain only letters, numbers, and underscores.',
            )
        }
        if (this.functions.has(name)) {
            throw new Error(`Function '${name}' is already registered.`)
        }

        this.functions.set(name, {
            name,
            description: options.description,
            isRetryable: options.isRetryable ?? true,
            inputSchema: options.input,
            inputJsonSchema: z.toJSONSchema(options.input) as Record<string, unknown>,
            handler: options.handler as (args: unknown, ctx: InvocationContext) => Promise<unknown>,
        })

        return this
    }

    // ─── Lifecycle ───────────────────────────────────────────────────────────

    /**
     * Resolve the token, register functions with the platform, and start polling.
     * Throws if no token is available or the token format is invalid.
     */
    async start(): Promise<void> {
        if (this.running) throw new Error('Connection is already running. Call stop() first.')

        const token = this.token ?? process.env.RAPID_TOKEN
        if (!token) {
            throw new Error(
                'No token provided. Set the RAPID_TOKEN environment variable or pass it as the token option.',
            )
        }

        const environment = parseTokenEnvironment(token)
        const client = new RapidHttpClient(this.baseUrl, token, SDK_VERSION, this.workerId)

        await client.registerFunctions(this.buildFunctionDefinitions())

        this.running = true
        this.pollAbort = new AbortController()
        this.log.info('Connection started', {
            functions: this.functions.size,
            environment,
            retryDelayMs: this.retryDelayMs,
            maxConcurrency: this.maxConcurrency,
            workerId: this.workerId,
        })

        this.pollLoopPromise = this.pollLoop(client, environment).catch((err) => {
            this.log.error('Unexpected polling failure', {
                error: err instanceof Error ? err.message : String(err),
            })
        })
    }

    /**
     * Stop the polling loop and wait for all in-flight handlers to complete.
     * Aborts any active long-poll immediately so the process can exit cleanly.
     */
    async stop(): Promise<void> {
        this.running = false
        this.pollAbort.abort()
        await Promise.allSettled([
            this.pollLoopPromise,
            ...this.inflight,
        ])
        this.log.info('Connection stopped')
    }

    /**
     * Run handlers in-process without any network calls.
     * Useful for unit testing — no token required.
     */
    connectLocal(options?: { environment?: 'sandbox' | 'live' }): LocalConnection {
        const environment = options?.environment ?? 'sandbox'
        return {
            invoke: async (functionName: string, args: unknown): Promise<unknown> => {
                const fn = this.functions.get(functionName)
                if (!fn) throw new Error(`Function '${functionName}' not registered`)

                const parsed = fn.inputSchema.parse(args)
                const ctx: InvocationContext = {
                    id: 'local',
                    environment,
                    runId: null,
                    procedureId: null,
                    procedureVersion: null,
                    heartbeat: async () => undefined,
                }
                return fn.handler(parsed, ctx)
            },
        }
    }

    // ─── Polling ─────────────────────────────────────────────────────────────

    private buildFunctionDefinitions(): RegisteredFunctionDefinition[] {
        return Array.from(this.functions.values()).map((fn) => ({
            name: fn.name,
            description: fn.description,
            isRetryable: fn.isRetryable,
            inputSchema: fn.inputJsonSchema,
        }))
    }

    private async pollLoop(
        client: RapidHttpClient,
        environment: 'sandbox' | 'live',
    ): Promise<void> {
        let backoffMs = this.retryDelayMs

        while (this.running) {
            // Back-pressure: pause polling when all concurrency slots are full.
            // Matches Temporal's slot-based gating — only poll when a slot is available.
            if (this.inflight.size >= this.maxConcurrency) {
                this.log.debug('Concurrency limit reached, waiting for a slot', {
                    inflight: this.inflight.size,
                    maxConcurrency: this.maxConcurrency,
                })
                await this.sleepInterruptible(this.retryDelayMs)
                continue
            }

            try {
                const hadWork = await this.pollOnce(client)
                backoffMs = this.retryDelayMs // reset on success

                // If server returned no work (long-poll timeout), pause briefly before
                // re-polling. This prevents hot-spinning if the server ever returns
                // instantly (e.g. in tests or under network issues).
                // If work was found, re-poll immediately — there may be more.
                if (!hadWork) {
                    await this.sleepInterruptible(this.retryDelayMs)
                }
            } catch (err) {
                if (!this.running) break

                if (err instanceof Error && err.name === 'AbortError') break

                if (err instanceof TokenRevokedError) {
                    this.running = false
                    this.log.error(
                        `Token rejected for the ${environment} environment. ` +
                        'Regenerate it from the dashboard and restart.',
                    )
                    return
                }

                this.log.warn('Poll error — backing off', {
                    error: err instanceof Error ? err.message : String(err),
                    backoffMs,
                })
                backoffMs = Math.min(backoffMs * 2, MAX_BACKOFF_MS)

                if (!this.running) break

                // Jitter: sleep between 50–100% of backoff to spread retries across instances
                const jitteredMs = backoffMs * (0.5 + Math.random() * 0.5)
                await this.sleepInterruptible(jitteredMs)
            }
        }
    }

    /**
     * Sleeps for `ms` milliseconds, but resolves immediately if `stop()` aborts the connection.
     * This ensures `stop()` can interrupt an inter-poll sleep without blocking.
     */
    private sleepInterruptible(ms: number): Promise<void> {
        return new Promise<void>((resolve) => {
            if (this.pollAbort.signal.aborted) {
                resolve()
                return
            }
            const timer = setTimeout(resolve, ms)
            const onAbort = () => { clearTimeout(timer); resolve() }
            this.pollAbort.signal.addEventListener('abort', onAbort, { once: true })
        })
    }

    private async pollOnce(client: RapidHttpClient): Promise<boolean> {
        const availableSlots = this.maxConcurrency - this.inflight.size
        const { invocations, queueDepth } = await client.poll(this.pollAbort.signal, availableSlots)
        if (invocations.length > 0) {
            this.log.debug('Poll returned work', {
                count: invocations.length,
                queueDepth,
                inflight: this.inflight.size,
            })
        }
        // Defensive cap: server should respect limit, but guard against returning more than we can handle
        for (const task of invocations.slice(0, availableSlots)) {
            const p = this.executeAndReport(client, task).finally(() => this.inflight.delete(p))
            this.inflight.add(p)
        }
        return invocations.length > 0
    }

    // ─── Invocation execution ────────────────────────────────────────────────

    private async executeAndReport(
        client: RapidHttpClient,
        task: InvocationTask,
    ): Promise<void> {
        const payload = await this.executeHandler(client, task)
        client.clearHeartbeat(task.id)
        const posted = await client.postResult(payload)

        if (!posted) {
            this.log.warn('Result not accepted by server (invocation may have timed out)', {
                invocationId: task.id,
                success: payload.success,
            })
        }
    }

    private async executeHandler(client: RapidHttpClient, task: InvocationTask): Promise<ResultPayload> {
        try {
            const fn = this.functions.get(task.functionName)
            if (!fn) throw new Error(`Function '${task.functionName}' not registered`)

            const args = fn.inputSchema.parse(task.args)
            const ctx: InvocationContext = {
                ...task.context,
                heartbeat: () => client.heartbeat(task.id).catch((err) => {
                    this.log.warn('Heartbeat failed (non-fatal)', {
                        invocationId: task.id,
                        error: err instanceof Error ? err.message : String(err),
                    })
                }),
            }
            const data = await fn.handler(args, ctx)

            return { invocationId: task.id, success: true, data }
        } catch (error) {
            return {
                invocationId: task.id,
                success: false,
                error: {
                    code: 'EXECUTION_ERROR',
                    message: error instanceof Error ? error.message : String(error),
                },
            }
        }
    }
}

// ─── connect() convenience helper ────────────────────────────────────────────

/**
 * Register functions and start polling in a single call.
 *
 * @example
 * const conn = await connect({
 *   getCustomer: {
 *     description: 'Fetch a customer by ID',
 *     input: z.object({ customerId: z.string() }),
 *     handler: async ({ customerId }) => db.customers.findById(customerId),
 *   },
 * })
 *
 * // Graceful shutdown:
 * process.on('SIGTERM', () => void conn.stop().then(() => process.exit(0)))
 */
export async function connect<T extends Record<string, RegisterFunctionOptions<z.ZodType>>>(
    functions: T,
    options?: ConnectionOptions,
): Promise<Connection> {
    const conn = new Connection(options)
    for (const [name, fnOptions] of Object.entries(functions)) {
        conn.register(name, fnOptions)
    }
    await conn.start()
    return conn
}

// ─── Helpers ─────────────────────────────────────────────────────────────────

/**
 * Parses the token prefix to determine the target environment.
 * Throws a descriptive error if the format is unrecognised.
 */
function parseTokenEnvironment(token: string): 'sandbox' | 'live' {
    if (token.startsWith(SANDBOX_TOKEN_PREFIX)) return 'sandbox'
    if (token.startsWith(LIVE_TOKEN_PREFIX)) return 'live'
    throw new Error(
        `Invalid token format. Expected a token starting with '${SANDBOX_TOKEN_PREFIX}' or '${LIVE_TOKEN_PREFIX}'.`,
    )
}
