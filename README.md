# @rapidfolio/connection-sdk-node

Node.js SDK for exposing functions from your internal systems to Rapidfolio procedures via private connections.

## Installation

```bash
npm install @rapidfolio/connection-sdk-node
```

## Quick start

1. Create a **Private Connection** in the Rapidfolio dashboard. A token is generated for you.
2. Copy the token and set it as an environment variable.
3. Write your functions:

```typescript
import { connect } from '@rapidfolio/connection-sdk-node'
import { z } from 'zod'

const conn = await connect({
  getCustomer: {
    description: 'Fetch a customer by ID from the internal database',
    input: z.object({ customerId: z.string() }),
    handler: async ({ customerId }) => {
      // your internal logic here
      return { name: 'Jane Doe', email: 'jane@example.com' }
    },
  },
})

// Graceful shutdown — call from your SIGTERM / SIGINT handler
// await conn.stop()
```

```bash
RAPID_TOKEN=run_sandbox_xxx node index.js
```

## Authentication

Each Private Connection has a token per environment (sandbox / live). Copy it from the connection's settings page in the dashboard.

| Token format | Environment |
|---|---|
| `run_sandbox_…` | Sandbox |
| `run_live_…` | Live |

The token is long-lived. Use **Regenerate token** in the dashboard to rotate it. The old token stops working immediately.

## Deployment

The same token works everywhere — dev machine, Docker, Kubernetes. Just set it as an environment variable.

**Dev / local:**
```bash
RAPID_TOKEN=run_sandbox_xxx node index.js
```

**Docker:**
```bash
docker run -e RAPID_TOKEN=run_sandbox_xxx my-app
```

**Kubernetes:**
```bash
kubectl create secret generic rapid-token \
  --from-literal=RAPID_TOKEN=run_sandbox_xxx
```
```yaml
env:
  - name: RAPID_TOKEN
    valueFrom:
      secretKeyRef:
        name: rapid-token
        key: RAPID_TOKEN
```

## Options

```typescript
await connect(functions, {
  token?: string          // Default: RAPID_TOKEN env var
  baseUrl?: string        // Default: RAPID_API_URL env var or https://run.rapidfolio.com
  retryDelayMs?: number   // Delay before re-polling after an idle or error cycle. Default: 3000
  maxConcurrency?: number // Max concurrent handler invocations. Default: 10
  workerId?: string       // Stable worker ID, e.g. pod name. Default: RAPID_WORKER_ID env var or random UUID
  logger?: ConnectionLogger
})
```

## Function options

```typescript
{
  description: string       // What the AI agent sees when deciding how to call this function
  input: z.ZodObject        // Zod schema; input is validated at runtime
  isRetryable?: boolean     // Set to false for non-idempotent operations. Default: true
  handler: async (input, ctx) => result
}
```

- Function names must start with a letter and contain only letters, numbers, and underscores.
- Input is validated against the zod schema at runtime. Throw to fail the step.

## Local testing (no network)

```typescript
const conn = new Connection()

conn.register('getCustomer', {
  description: '...',
  input: z.object({ customerId: z.string() }),
  handler: async ({ customerId }) => ({ name: 'Jane Doe' }),
})

const local = conn.connectLocal()
const result = await local.invoke('getCustomer', { customerId: 'cust_123' })
```

Runs handlers inline without any network calls. Useful for unit tests. No token required.

## Advanced: class API

For incremental registration or custom lifecycle control, use `Connection` directly:

```typescript
import { Connection } from '@rapidfolio/connection-sdk-node'

const conn = new Connection({ token: 'run_sandbox_xxx' })

conn.register('fn1', { ... })
conn.register('fn2', { ... })

await conn.start()

// later...
await conn.stop()
```

## Token revocation

If a token is revoked (via **Regenerate token** in the dashboard):

1. The SDK logs: `Token rejected for the sandbox environment. Regenerate it from the dashboard and restart.`
2. Polling stops.
3. Copy the new token from the dashboard, update your environment variable, and restart.

## Environment variables

| Variable | Description |
|---|---|
| `RAPID_TOKEN` | Connection token (`run_sandbox_…` or `run_live_…`) |
| `RAPID_API_URL` | Override the API base URL (useful for local dev or self-hosted) |
| `RAPID_WORKER_ID` | Stable worker identifier, e.g. Kubernetes pod name |
