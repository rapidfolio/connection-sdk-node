/**
 * Example runner — registers mock functions and starts polling.
 *
 * Usage:
 *   RAPID_TOKEN=run_sandbox_xxx npm run example
 *   RAPID_API_URL=http://localhost:3002 RAPID_TOKEN=run_sandbox_xxx npm run example
 */

import { z } from 'zod'
import { connect } from '../src/index.js'

if (!process.env.RAPID_TOKEN) {
    console.error('Error: set RAPID_TOKEN=run_sandbox_xxx')
    process.exit(1)
}

console.log('Starting example runner...')
console.log(`API: ${process.env.RAPID_API_URL ?? 'https://run.rapidfolio.com'}`)
console.log()

const conn = await connect(
    {
        add: {
            description: 'Add two numbers',
            input: z.object({ a: z.number(), b: z.number() }),
            handler: async ({ a, b }) => {
                console.log(`  add(${a}, ${b}) called`)
                return { result: a + b }
            },
        },
        lookupCustomer: {
            description: 'Look up a customer record by ID',
            input: z.object({ customerId: z.string() }),
            handler: async ({ customerId }) => {
                console.log(`  lookupCustomer("${customerId}") called`)
                await new Promise((r) => setTimeout(r, 50))
                return {
                    id: customerId,
                    name: 'Jane Doe',
                    email: 'jane@example.com',
                    accountBalance: 1_250.00,
                }
            },
        },
        runRiskCheck: {
            description: 'Run a risk assessment for a transaction',
            input: z.object({
                userId: z.string(),
                amount: z.number(),
                currency: z.string(),
            }),
            handler: async ({ userId, amount, currency }) => {
                console.log(`  runRiskCheck(user=${userId}, ${amount} ${currency}) called`)
                await new Promise((r) => setTimeout(r, 100))
                const riskScore = Math.min(1, amount / 10_000)
                return {
                    approved: amount < 5_000,
                    riskScore: Math.round(riskScore * 100) / 100,
                    reason: amount >= 5_000 ? 'Amount exceeds threshold' : undefined,
                }
            },
        },
    },
    {
        baseUrl: process.env.RAPID_API_URL,
        retryDelayMs: 2_000,
        logger: {
            info:  (msg, meta) => console.log(`[info]  ${msg}`, meta ? JSON.stringify(meta) : ''),
            warn:  (msg, meta) => console.warn(`[warn]  ${msg}`, meta ? JSON.stringify(meta) : ''),
            error: (msg, meta) => console.error(`[error] ${msg}`, meta ? JSON.stringify(meta) : ''),
            debug: (msg, meta) => console.debug(`[debug] ${msg}`, meta ? JSON.stringify(meta) : ''),
        },
    },
)

console.log('Polling for invocations. Press Ctrl+C to stop.\n')

process.on('SIGINT', () => {
    console.log('\nStopping...')
    void conn.stop().then(() => process.exit(0))
})
