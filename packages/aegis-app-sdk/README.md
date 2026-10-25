# `@heurion/aegis-app-sdk` — Aegis Application Protocol (AAP-1.0) SDK

Official TypeScript / Node.js SDK for exposing any first-party or third-party application to **Aegis-OS Runtime** (`agy` / `hermes`).

## Features

- **`defineAegisManifest(manifest)`** — Type-safe validation for `/.well-known/aegis-app.json` (`protocol: "aegis-app/1.0"`).
- **`issueAegisGrantTokenString(appId)` & `parseAegisGrantTokenString(rawToken, appId)`** — Issue and verify user-bound `aegis_at_<app_id>.<grant_id>.<secret>` tokens.
- **`extractAegisHeaders(headers)`** — Extract `Authorization`, `X-Aegis-Agent-Id`, `X-Aegis-Session-Id`, and `X-Aegis-Lease-Token`.
- **`generateAegisNodeKeyPair()` / `signAegisLeaseToken()` / `verifyEd25519LeaseToken()`** — Zero-dependency Ed25519 offline verification for `[Lease-Gated]` Tier-2 operations.
- **`formatLeaseRequiredError()`** — Standard AAP-1.0 `lease_required` escalation payload.

## Quick Start (Hono / Fetch Server)

```ts
import { Hono } from 'hono'
import {
  defineAegisManifest,
  extractAegisHeaders,
  verifyEd25519LeaseToken,
  formatLeaseRequiredError,
} from '@heurion/aegis-app-sdk'

const manifest = defineAegisManifest({
  protocol: 'aegis-app/1.0',
  app: {
    id: 'my-lab-eln',
    name: 'My Lab ELN',
    version: '1.0.0',
    vendor: 'Acme Bio',
    description: 'Electronic Lab Notebook for Aegis-OS',
  },
  mcp: {
    transport: 'streamable-http',
    endpoint: '/api/aegis/mcp',
    eager_tools: ['eln_search', 'eln_read'],
    lazy_tools: 'all_remaining',
  },
  auth: {
    modes: ['user_grant_token', 'session_jwt'],
    token_exchange_endpoint: '/api/aegis/auth/token',
    token_revoke_endpoint: '/api/aegis/auth/token',
    token_prefix: 'aegis_at_my-lab-eln.',
    identity_binding: {
      requires_user_account: true,
      supports_org_tenancy: true,
      binds_aegis_node_pubkey: true,
    },
    required_headers: ['Authorization', 'X-Aegis-Agent-Id'],
  },
  capabilities: [],
  security: {
    network_egress: ['localhost'],
    supports_cow_turn_revert: true,
    lease_verification: {
      supports_ed25519_offline_verify: true,
      supports_server_escalation: true,
    },
  },
})

const app = new Hono()
app.get('/.well-known/aegis-app.json', c => c.json(manifest))
```
