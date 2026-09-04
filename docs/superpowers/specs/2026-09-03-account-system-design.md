# Account system: sign-in required before wallet connect / Confirm

## Motivation

Today there is no account of any kind. A "session" is an unauthenticated
`x-session-id` header, living only in server memory for as long as that browser tab
does — gone on a backend restart, never shared across devices, and (per ADR-0011/0012)
already required to prove wallet ownership before a Confirm can spend anything, but
that proof lives only in that same ephemeral session.

Two things are being asked for:

1. A real, durable account (email/password or Google, via Supabase Auth) that a Trader
   can come back to from any device.
2. A stricter gate than today's: signing in becomes *required* before connecting a
   wallet or reaching Confirm at all — Deck browsing and Practice Run stay completely
   open, matching how a centralized exchange like Luno lets you look at markets freely
   but requires an account before you can actually trade. The difference from Luno:
   this app never custodies funds, so "your balance" is still your own wallet, not a
   balance this app holds — the account layer sits in front of wallet-connect, it does
   not replace it.

## What this does NOT change

- **Wallet-based authorization is untouched.** ADR-0011 (the Trader's own wallet signs
  every fill) and ADR-0012 (a session must prove wallet ownership via
  `/auth/challenge` + `/auth/verify`, and `/fill/settle` decides outcomes from the
  chain) both keep working exactly as built. An account never grants spending
  permission by itself — it only gates *reaching* the wallet-connect step at all.
- **The chain remains the source of truth for money** (ADR-0003). No real Position, no
  balance, is ever cached in a new table. What's newly persisted here (Risk Budget
  setting, Practice Run history, a linked wallet address, preferences, an activity
  log) is account *preference and history* data, never a balance or a Position.
  Real holdings still come from `GET /positions` reading the chain fresh, unchanged.
- **Practice Run's zero-friction path stays zero-friction.** It still spends nothing,
  still reaches no signer (`apps/api/src/practice.ts`'s own import-graph guarantee is
  untouched), and still requires no sign-in — it's explicitly part of the free preview
  under this design, same as browsing the Deck.
- **Anonymous browsing keeps working exactly as it does today** for anyone who never
  signs in: in-memory `Session` keyed by `x-session-id`, Risk Budget resets per tab,
  Practice Run available. This design adds a second, parallel track for signed-in
  Traders; it does not remove the first one.
- **The multi-wallet connector (browser-extension picker + WalletConnect protocol for
  phone wallets)** is a separate, later feature — out of scope here. This design
  assumes today's single-injected-wallet `wallet.ts` continues to be what "Connect
  wallet" calls.
- **No migration of pre-signin activity.** Whatever happened anonymously before
  signing in (Deck browsing, a Practice Run) is not carried into the new account.
  Persistence begins the moment an account exists, going forward only.

## Design

### 1. Two parallel identity tracks

**Anonymous** (no account token sent): unchanged. In-memory `Session`, keyed by
`x-session-id`, exactly as `sessions.ts` already implements it. Deck browsing and
Practice Run both work; Risk Budget uses the in-memory default and resets per tab;
wallet-connect and Confirm are unreachable (see Section 3).

**Signed in** (a valid Supabase account session token is presented): Risk Budget,
default asset/direction, a linked wallet, Practice Run history, and an activity log
all live in Postgres tables (below), keyed by the account's Supabase user id — durable
across devices and restarts. Wallet-connect and Confirm require this track.

The two tracks are never merged or reconciled with each other. A Trader either has an
account-backed session or an anonymous one for a given request; which one applies is
decided per-request by whether a valid account token was sent.

### 2. New database tables (Supabase Postgres)

Same pattern as `forecast_usage_log` (already in the codebase): RLS enabled, no
policies, so only this backend's service-role key can read or write them — the
frontend never queries these tables directly, only through this API.

```sql
account_settings (
  user_id           uuid primary key references auth.users(id),
  risk_budget_usdc  numeric not null default 5,
  default_asset     text,       -- an UnderlyingSymbol, or null if never set
  default_direction text,       -- 'UP' | 'DOWN', or null if never set
  updated_at        timestamptz not null default now()
)

linked_wallets (
  user_id        uuid primary key references auth.users(id),  -- one wallet per account
  wallet_address text not null,
  verified_at    timestamptz not null
)

practice_positions (
  id            uuid primary key default gen_random_uuid(),
  user_id       uuid not null references auth.users(id),
  -- same figures shape practice.ts's in-memory PracticePosition already carries:
  -- strike, contracts, premiumUsdc, maxLossUsdc, breakevenPrice, expiry (each a Figure)
  figures       jsonb not null,
  asset         text not null,
  direction     text not null,
  opened_at     timestamptz not null default now()
)

account_activity (
  id          uuid primary key default gen_random_uuid(),
  user_id     uuid not null references auth.users(id),
  action_type text not null,   -- 'propose' | 'practice' | 'fill_prepared' | 'fill_settled'
                                -- | 'budget_changed' | 'wallet_linked' -- exactly these six for
                                -- the first pass; a disconnect/unlink event is not logged, since
                                -- there is no unlink action in this design (relinking overwrites
                                -- the one row in `linked_wallets` rather than clearing it first)
  detail      jsonb not null,
  created_at  timestamptz not null default now()
)
```

`auth.users` itself is Supabase-managed — created automatically by Supabase Auth on
signup, never written to by this backend directly.

### 3. Backend: a new, independent auth check

`apps/api/src/account.ts` (new module, parallel to `auth.ts`):

- `verifyAccountToken(token: string): Promise<{ userId: string } | null>` — calls
  Supabase's own `auth.getUser(token)` via the existing service-role client
  (`apps/api/src/supabase.ts`) to validate the token and extract the account id. No
  hand-rolled JWT verification — Supabase's own SDK does it.
- `requireAccount(req, reply): Promise<string | undefined>` — a Fastify helper,
  parallel to the existing `requireToken`. Reads `x-account-token` (a **new header,
  distinct from** the existing `Authorization: Bearer <COPILOT_API_TOKEN>` shared
  secret, which keeps working unchanged), verifies it, and either returns the
  account's user id or sends `401` and returns `undefined`.

Route changes:

- **`POST /auth/challenge`, `POST /auth/verify`, `POST /fill/prepare`** — now call
  `requireAccount` in addition to the existing `requireToken`. No valid account, no
  challenge, no fill-prepare — this is what makes "sign-in required before
  wallet/Confirm" a real, server-enforced rule rather than a UI suggestion. A
  successful `/auth/verify` additionally upserts into `linked_wallets` for that
  account (one row per account, replacing any previous link — no separate "link
  wallet" endpoint needed).
- **`GET /session`, `POST /session/budget`, `POST /practice`, `GET /positions`** —
  become **account-aware**: if `x-account-token` is present and valid, read/write the
  new tables; if absent, fall back to exactly today's in-memory behavior. Same routes,
  two data paths, chosen per-request.
- **New: `GET /account`** — returns `{ settings, linkedWallet }` for the signed-in
  account (both possibly empty/null for a brand-new account).
- **New: `GET /account/activity`** — paginated read of `account_activity` for the
  signed-in account.

### 4. Frontend

- `apps/web/lib/supabaseClient.ts` (new) — a Supabase browser client using two new
  public env vars, `NEXT_PUBLIC_SUPABASE_URL` and `NEXT_PUBLIC_SUPABASE_ANON_KEY` (the
  anon key is safe to expose; it's the standard way every Supabase frontend talks to
  its project, distinct from the server-only `SUPABASE_SERVICE_ROLE_KEY` already in
  `.env`).
- `apps/web/app/login/page.tsx` (new) — email/password form plus a "Sign in with
  Google" button, both calling `supabase.auth.signInWithPassword` /
  `supabase.auth.signInWithOAuth({ provider: 'google' })`. On success, redirects back
  to `/`.
- `surface.ts` subscribes to `supabase.auth.onAuthStateChange(...)` and exposes
  `account: { userId, email } | null` alongside existing state.
- A new persistent header control (replacing what `WalletConnect.tsx` currently
  renders inside `ConfirmModal`) shows, in order: **signed out** → "Sign in / Sign up"
  (links to `/login`) → **signed in, no wallet** → "Connect wallet" (calls the
  existing `connectWallet()`/`verifyWalletFor()` flow, now also sending
  `x-account-token` on the `/auth/*` calls) → **verified** → the linked address.
- `ConfirmModal.tsx` drops its own wallet section entirely. Confirm's `disabled` check
  reads the same `walletVerified` state (now meaning "verified and linked to this
  account") from that persistent control; if a Trader somehow reaches the modal
  without it, Confirm shows a plain refusal rather than offering to connect inline.
- Every call that needs account context (`prepareFill`, `requestAuthChallenge`,
  `verifyAuthChallenge`, `getSession`, the budget/practice/positions calls) sends
  `x-account-token: <supabase access token>` when a session exists, alongside the
  existing `Authorization` header — the two headers serve two independent checks and
  neither replaces the other. The token attached is always read fresh from
  `supabase.auth.getSession()` immediately before each call rather than cached in
  React state — Supabase's client SDK auto-refreshes an expiring access token
  internally, so reading it right before use (not caching a copy that can go stale)
  is what keeps a long-lived tab from silently sending an expired token.

### 5. Error handling

- An expired or invalid `x-account-token` on an account-required route (`/fill/prepare`,
  `/auth/challenge`, `/auth/verify`) answers `401`, same status the existing
  `requireToken` check already uses for a missing/wrong shared secret — the frontend
  treats a `401` from any of these as "not actually signed in," clears its local
  `account` state, and falls back to showing "Sign in / Sign up."
- On the account-aware-but-not-required routes (`/session`, `/session/budget`,
  `/practice`, `/positions`), a missing or invalid `x-account-token` is **not** an
  error — it's simply treated as the anonymous track, exactly like today.
- A Supabase database write failure (e.g. `account_activity` insert) never blocks the
  actual action it's logging — same principle `usageLog.ts` already established for
  forecast usage logging: observability must never be able to break the real request.

### 6. Testing approach (sketch — full test plan is its own stage)

Following this project's existing convention (`stub-client.ts` stubs the Thetanuts SDK
at its module boundary; no test ever reaches a real chain or a real AI provider):
`apps/api/src/account.ts`'s Supabase calls get the same treatment — a stub swapped in
at the module boundary via `vi.mock`, so no automated test ever creates a real
Supabase Auth user or spends real Supabase quota. `apps/web`'s new `/login` page and
header control follow the existing no-React-component-tests policy; end-to-end
coverage happens in Playwright, with a fake `x-account-token` accepted by a stubbed
backend the same way the existing suite stubs `/auth/challenge`/`/auth/verify` today.

