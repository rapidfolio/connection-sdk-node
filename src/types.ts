import type { z } from 'zod'

// ===== Wire protocol — shapes exchanged with the Rapidfolio API =====

export interface RegisteredFunctionDefinition {
    name: string
    description: string
    isRetryable: boolean
    inputSchema: Record<string, unknown>
}

/**
 * Metadata about the procedure run that triggered an invocation.
 * Passed as the second argument to every function handler.
 */
export interface InvocationContext {
    /** Unique ID for this specific invocation. */
    id: string
    /** Whether this is a sandbox or live run. */
    environment: 'sandbox' | 'live'
    /** The procedure run that triggered this call. Null when invoked via `connectLocal()`. */
    runId: string | null
    /** The procedure definition ID. Null when invoked via `connectLocal()`. */
    procedureId: string | null
    /** The procedure version name. Null when invoked via `connectLocal()`. */
    procedureVersion: string | null
    /**
     * Signal the server that this function is still running, extending its timeout window.
     * Call periodically for functions that may take longer than 60 seconds.
     * Throttled internally — safe to call in a loop without flooding the server.
     * No-op when invoked via `connectLocal()`.
     */
    heartbeat: () => Promise<void>
}

export interface InvocationTask {
    id: string
    functionName: string
    args: unknown
    /** Wire-protocol context from server — `heartbeat` is injected by the SDK before reaching handlers. */
    context: Omit<InvocationContext, 'heartbeat'>
}

export interface PollResponse {
    invocations: InvocationTask[]
    queueDepth: number
}

export interface ResultPayload {
    invocationId: string
    success: boolean
    data?: unknown
    error?: { code: string; message: string }
}

// ===== SDK-level types =====

/** Options passed to {@link Connection.register}. */
export interface RegisterFunctionOptions<TInput extends z.ZodType> {
    /** Human-readable description shown to the AI agent. */
    description: string
    /** Zod schema that validates incoming arguments. */
    input: TInput
    /** The function implementation. Receives validated input and invocation context. */
    handler: (args: z.infer<TInput>, ctx: InvocationContext) => Promise<unknown>
    /**
     * When false, the platform will not retry this function on failure.
     * Set to false for non-idempotent operations like charging a card or sending an email.
     * Default: true.
     */
    isRetryable?: boolean
}

/** Returned by {@link Connection.connectLocal} — runs handlers in-process without any network calls. */
export interface LocalConnection {
    invoke: (functionName: string, args: unknown) => Promise<unknown>
}

export interface ConnectionLogger {
    info(msg: string, meta?: Record<string, unknown>): void
    warn(msg: string, meta?: Record<string, unknown>): void
    error(msg: string, meta?: Record<string, unknown>): void
    debug(msg: string, meta?: Record<string, unknown>): void
}

// Internal — resolved form stored in the functions Map
export interface ConnectionFunction {
    name: string
    description: string
    isRetryable: boolean
    inputSchema: z.ZodType
    inputJsonSchema: Record<string, unknown>
    handler: (args: unknown, ctx: InvocationContext) => Promise<unknown>
}
