# Matter Velocity Platform

Single-tenant legal operations platform for **Messrs Chambers of Koon** (Kuala Lumpur, Petaling Jaya, Ipoh).

Built by **EIAAW Solutions Sdn Bhd** (202603133419) against the PRD _Matter Velocity Platform — Messrs Chambers of Koon v1.0_, which is the engineering contract for this build.

---

## What it does

Four AI-assisted workflows, all under lawyer control with a full audit trail:

| Milestone | Capability                                                    | Status                             |
| --------- | ------------------------------------------------------------- | ---------------------------------- |
| M1        | SSO, RBAC, immutable audit log                                | Implemented                        |
| M2        | Intake widget + triage agent                                  | Implemented                        |
| M3        | Availability, slot proposal, lawyer approval, `.ics` delivery | Implemented                        |
| M4        | `.docx` generation from firm templates                        | Implemented (needs firm templates) |
| M5        | Archive ingest, OCR, chunking, embeddings                     | Implemented (see limits below)     |
| M6        | Permission-scoped hybrid precedent retrieval                  | Implemented                        |
| M7        | Milestone client communication + delivery webhooks            | Implemented                        |
| M8        | Lawyer dashboard                                              | Implemented                        |
| M9        | Administration                                                | Implemented                        |

## Product principles (from the PRD, enforced in code)

- **Lawyer-in-the-loop.** No AI output reaches a client without a human approving it. `proposeSlot()` has no code path that can email an enquirer; only `acceptProposal()` and `cancelAppointment()` do, and both require an authorised actor.
- **No claims we cannot keep.** The platform does not file on court systems, does not read external calendars, and does not train models on firm content.
- **Auditable by default.** `audit_events` is append-only _at the database level_ — triggers reject `UPDATE`, `DELETE` and `TRUNCATE`, verified to hold against a superuser.
- **Firm-owned data.** Matter data, drafts and embeddings live in the firm's own database and bucket. Client identifiers are tokenised before any prompt leaves the platform.

---

## Stack

| Layer       | Choice                                                                  | Why                                                                                           |
| ----------- | ----------------------------------------------------------------------- | --------------------------------------------------------------------------------------------- |
| Application | Next.js 16 (App Router), React 19, TypeScript, Tailwind v4              | PRD-fixed                                                                                     |
| Database    | PostgreSQL 18 + pgvector on Railway (Southeast Asia)                    | PRD-fixed; data residency                                                                     |
| ORM         | Drizzle                                                                 | pgvector needs raw SQL; no binary engine to ship                                              |
| Jobs        | pg-boss on the same Postgres                                            | One fewer service to secure, back up and restore; the restore rehearsal then covers the queue |
| AI          | Anthropic Claude (Sonnet for drafting/triage, Haiku for classification) | PRD-fixed. Model IDs are configuration, never constants                                       |
| Embeddings  | Voyage `voyage-law-2`, 1024-dim                                         | Legal-domain tuned; pluggable to OpenAI                                                       |
| Email       | Resend                                                                  | PRD-fixed                                                                                     |
| Auth        | Auth.js v5, OIDC to Google Workspace / Microsoft Entra                  | No local password store                                                                       |

---

## Running locally

```bash
# 1. Postgres with pgvector
docker run -d --name mvp-postgres \
  -e POSTGRES_PASSWORD=postgres -e POSTGRES_DB=matter_velocity \
  -p 55433:5432 pgvector/pgvector:pg17

# 2. Environment
cp .env.example .env      # then set DATABASE_URL to the container above

# 3. Schema and reference data
npm install
npm run db:migrate        # extensions → tables → vector/search/triggers
npm run db:seed           # permissions, roles, stages, templates, holidays

# 4. Run
npm run dev               # app
npm run worker            # background jobs (separate terminal)
```

`npm run verify` runs the full gate: format, lint, typecheck, tests.

### Migrations

Three ordered stages, because pgvector and the audit trigger cannot be expressed in the Drizzle DSL:

1. `drizzle/pre/*.sql` — extensions (`vector`, `pg_trgm`, `pgcrypto`, `btree_gist`)
2. Drizzle journal — generated table DDL
3. `drizzle/post/*.sql` — vector + tsvector columns, HNSW/GIN/trigram indexes, audit immutability, `updated_at` triggers, check and exclusion constraints

Every stage-1 and stage-3 statement is individually idempotent, so a partially applied migration cannot wedge the next deploy.

---

## Security posture

- **Authentication** is email + password with a mandatory authenticator-app second factor enrolled at first sign-in (**PRD amendment A1**). scrypt at N=2^17; per-account lockout; no user enumeration in wording or timing; reset tokens stored only as hashes, single-use, and never clearing the second factor.
- **Authorisation** is a single sanctioned path (`src/lib/auth/guard.ts`). Route handlers and pages hold no database access at all; reads go through `src/lib/queries/*`, which take an `Actor` and apply the permission scope themselves. ESLint blocks the shortcut.
- **Scope before rank.** Retrieval applies the permitted-matter predicate inside the CTE all three ranking arms read from. Filtering after ranking would leak the existence _and relevance_ of matters the caller cannot open.
- **Session revocation.** JWT sessions are revocable via `users.session_epoch`; `getActor()` re-reads the user on every request, so a suspended user loses access on their next request, not their next login.
- **Fail closed.** A missing secret throws in production rather than silently degrading. When auth is unconfigured, every protected route redirects to `/sign-in`, which says so.
- **No enumeration.** Authorisation failures return one generic message; a missing row and a forbidden row are indistinguishable to the caller.

### Secrets

Follows the **EIAAW deploy contract**. The only raw secrets anywhere are the three Infisical bootstrap credentials. Everything else is a `secret://project/env/NAME` handle resolved at boot by `src/lib/secrets/resolver.ts`.

A pre-commit scanner blocks credential-shaped strings from entering history; it is tested against a planted key.

See [`docs/runbook.md`](docs/runbook.md) for the deployment procedure.

---

## Testing

```bash
npm run test        # 418 unit + integration tests
npm run evals       # AI eval suite (needs ANTHROPIC_API_KEY; costs money)
```

The eval suite gates merges in CI, but only on PRs that touch `src/lib/ai/`, `src/lib/rag/` or `evals/` — running it on every PR would burn model spend for no signal.

Coverage is concentrated where correctness is load-bearing rather than spread evenly: the permission matrix (28 tests incl. AT-05/06/07), the RFC 5545 wire format (26 tests incl. AT-03/04), and the scheduling engine (23 tests, incl. working-hours expiry and Malaysian holidays).

---

## Known gaps

Stated plainly so they are decisions, not surprises:

1. **Object storage is shared.** The firm's files live in `eiaaw-smt-prod` under a `chambersofkoon/` prefix, because the available R2 token is scoped to that bucket. A dedicated bucket is the right end state for privileged client material and is a single prefix copy away.
2. **No dedicated field-encryption key.** The vault has none, so the key is derived from `AUTH_SECRET` via HKDF-SHA256 with a fixed domain-separation label. That is cryptographically sound — the derived key is independent of the signing key — but it couples rotation: while the fallback is in use, rotating `AUTH_SECRET` makes existing encrypted client identifiers undecryptable. Add `FIELD_ENCRYPTION_KEY` to the vault before the first rotation.
3. **Scanned PDFs are not OCR'd end-to-end.** Native-text PDFs, DOCX, images and plain text all extract. A scanned PDF with no text layer needs a rasteriser to turn pages into images, which is not in this runtime; such files are flagged `failed` with an explanatory message and a retry button, rather than silently indexed as empty. Options: re-upload as page images, or add a rasteriser service. The PRD anticipated this ("dedicated OCR service only if accuracy fails UAT").
4. **Firm precedent templates are required** before document generation produces anything useful. They are a blocking discovery item in the PRD (§11). The template parser, placeholder mapping and assembly are built and waiting.
5. **Turnstile is off.** `TURNSTILE_ENABLED=false` and no site key is registered. The origin allow-list and rate limiter are active. Turn it on before go-live.
6. **`.ics` rendering has not been verified in Gmail, Outlook and Apple Mail.** The wire format is asserted by 26 tests, but AT-03 requires a human to accept an invitation in all three clients at UAT.
7. **Bahasa Malaysia is not translated.** The catalogue (`src/lib/i18n/catalogue.ts`) carries every client-facing string and the `ms-MY` entry is deliberately empty — machine-translating a firm's client correspondence into a language nobody on the delivery team can check is not a thing to ship. Adding it is one object, no code change (NFR-5.2). The staff dashboard is English by decision, not omission; see the module comment.
8. **Retention destroys nothing until the firm confirms the policy.** The sweep is written, scheduled weekly and audited, and `/admin/privacy` shows what the next pass would remove — read that number before the first run in production.

## Client-facing surfaces

Two of the three run without a login, so they are listed together rather than left to be discovered:

| Route                 | Who reaches it                             | Notes                                                                                                                                |
| --------------------- | ------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------ |
| `/enquiry`            | Anyone. Linkable; the widget's JS fallback | Server-rendered, no client bundle (FR-2.2)                                                                                           |
| `/reschedule/{token}` | The token in a confirmation email only     | Creates a proposal for lawyer approval; never books, never emails the client (FR-3.8)                                                |
| `/preview/widget`     | The firm, before go-live                   | The real widget on a mock firm page — enquiries made here are real. See [`docs/website-integration.md`](docs/website-integration.md) |

## Repository layout

```
src/
  app/            Next.js App Router — routes only, no database access
    (app)/        authenticated shell: dashboard, intake, precedent
    api/          route handlers
  lib/
    auth/         guard.ts is the single authorisation path
    queries/      read models; every function takes an Actor
    ai/           prompts (versioned + hashed), model routing, tokenisation
    rag/          chunking, embedding, hybrid retrieval, saved searches
    documents/    docx template parsing, assembly, revision and edit signals
    i18n/         client-facing message catalogue (NFR-5.2)
    privacy/      retention sweep, data subject export and erasure
    scheduling/   slot engine (pure) + service (database-backed)
    email/        RFC 5545 builder, Resend transport
    comms/        milestone dispatch, delivery write-back
    secrets/      Infisical resolver
  jobs/           pg-boss worker process
  widget/         embeddable intake widget (bundled to public/widget.js)
drizzle/          pre/ → journal → post/ migrations
evals/            AI eval suite
docs/             runbook, PRD
```

---

© EIAAW Solutions Sdn Bhd. Confidential.
