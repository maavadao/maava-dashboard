# Inbox (Phase 1) — Gmail & Outlook

Phase 1 ships the foundation for the Inbox feature: connect a Gmail or Outlook
account via OAuth, store tokens encrypted at rest, and expose a per-account AI
handling policy with safe defaults (`approval_required`).

## Required environment variables

### Token encryption (REQUIRED in production)
- `INBOX_TOKEN_ENCRYPTION_KEY` — 32-byte key, supplied as base64 (recommended),
  hex, or a 32-character string. Used to AES-256-GCM encrypt OAuth tokens
  before they hit Postgres.
  - Generate one: `node -e "console.log(require('crypto').randomBytes(32).toString('base64'))"`
  - If unset, the lib derives a key from `JWT_SECRET` (insecure — dev only,
    logs a warning).

### OAuth state signing (optional)
- `INBOX_OAUTH_STATE_SECRET` — HMAC secret for the short-lived JWT state
  parameter. Falls back to `JWT_SECRET` when unset.

### Gmail OAuth client
- `GMAIL_OAUTH_CLIENT_ID`
- `GMAIL_OAUTH_CLIENT_SECRET`
- `GMAIL_OAUTH_REDIRECT_URI` *(default: `https://agent.mawadao.com/api/inbox/oauth/gmail/callback`)*

Configure in Google Cloud Console → APIs & Services → Credentials → OAuth 2.0
Client. Add the redirect URI verbatim. Required scopes are auto-requested by
the start route (`gmail.readonly`, `gmail.send`, `gmail.modify`, `openid`,
`email`, `profile`).

### Microsoft Graph (Outlook) OAuth client
- `MS_GRAPH_CLIENT_ID`
- `MS_GRAPH_CLIENT_SECRET`
- `MS_GRAPH_TENANT_ID` *(default: `common`)*
- `MS_GRAPH_REDIRECT_URI` *(default: `https://agent.mawadao.com/api/inbox/oauth/outlook/callback`)*

Configure in Azure Portal → App registrations. Add the redirect URI as a
**Web** platform redirect. Required delegated scopes: `offline_access`,
`openid`, `profile`, `email`, `Mail.Read`, `Mail.Send`, `Mail.ReadWrite`.

## Routes

| Path | Method | Purpose |
| --- | --- | --- |
| `/inbox` | page | Connections UI, AI policy summary |
| `/api/inbox/accounts` | GET | List the current user's connected accounts |
| `/api/inbox/accounts?id=<uuid>` | DELETE | Disconnect (soft revoke) |
| `/api/inbox/accounts/<id>/policy` | GET, PUT | Read/update AI handling policy |
| `/api/inbox/oauth/gmail/start` | GET | Begin Gmail OAuth |
| `/api/inbox/oauth/gmail/callback` | GET | Gmail OAuth callback |
| `/api/inbox/oauth/outlook/start` | GET | Begin Outlook OAuth |
| `/api/inbox/oauth/outlook/callback` | GET | Outlook OAuth callback |

## Database

Tables (created idempotently on app boot via `src/lib/db.ts`; also packaged as
`db/migrations/037_inbox_accounts.sql`):

- `inbox_accounts` — one row per (user, provider, email). `token_ciphertext`
  is AES-256-GCM. `status ∈ {active, revoked, error}`.
- `inbox_ai_policies` — 1:1 with `inbox_accounts`, cascade delete. All
  send/forward/delete capabilities default `FALSE`,
  `approval_required_for_send = TRUE`, `mode = 'approval_required'`,
  `max_actions_per_hour = 20`.
- `inbox_oauth_states` — short-lived CSRF tokens for OAuth round-trips.

## Phase 1 scope (DONE)
- Sidebar entry (`Inbox` in user-card dropdown + dedicated `InboxSidebar`).
- `/inbox` page shell: connect cards, connected list, disconnect dialog.
- DB migration + on-boot table creation.
- OAuth start + callback routes for Gmail and Outlook.
- Encrypted token storage, soft-revoke disconnect.
- AI policy schema with safe defaults.

## Phase 2-4 (deferred)
- Per-account policy editor UI (autonomy, label rules, custom instructions).
- Message sync + listing (`/inbox/messages`).
- Approval queue (`/inbox/approvals`).
- Activity log (`/inbox/activity`).
- mawaDao Agent gateway action handlers (draft, reply, send, label).
