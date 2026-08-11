# Runbook — Matter Velocity Platform

Operational procedures for the Chambers of Koon deployment.

---

## 1. Current deployment

|                 |                                                                             |
| --------------- | --------------------------------------------------------------------------- |
| Railway project | `matter-velocity-platform` (`430bb960-ee9b-4f1f-b12a-b28840677096`)         |
| Region          | Southeast Asia (Singapore) — PRD NFR-2.1                                    |
| Web service     | `web` → https://web-production-782ae5.up.railway.app                        |
| Database        | `Postgres` — `ghcr.io/railwayapp-templates/postgres-ssl:18`, 48.8 GB volume |
| Repository      | https://github.com/eiaawsolutions/Messrs-ChambersofKoon-Platform            |
| Deploys         | Automatic on push to `main`                                                 |

`npm run release` runs `db:migrate && db:seed && start`, so schema and reference data are applied on every deploy. Both are idempotent.

### Health

`GET /api/health` checks database, storage, queue, Claude reachability and the secrets resolver, each with its own 4s timeout.

- `ok` — everything reachable
- `degraded` — database up, something else is not. **The app still serves.**
- `unhealthy` (503) — database unreachable

Only the database failing returns 503, so a Claude or Resend outage does not put the container into a restart loop.

Point the external uptime monitor at `/api/health` and alert on 503 or on `status != "ok"` for more than 15 minutes.

---

## 2. Finishing production setup

The application is deployed and running. It is **fail-closed**: no one can sign in and no AI feature works until the secrets below exist. That is deliberate — the alternative is a system that looks live but silently cannot do its job.

### Step 1 — Create the Infisical workspace

In the Infisical UI (**Claude does not create secrets — this is a human step, by design**):

1. Create project `chambersofkoon-prod` with environments `dev`, `staging`, `prod`.
2. Create machine identity `chambersofkoon-app` with `secrets:read`, scoped to that workspace only.
3. Populate `prod`:

| Secret                                                | Source                                           |
| ----------------------------------------------------- | ------------------------------------------------ |
| `ANTHROPIC_API_KEY`                                   | console.anthropic.com                            |
| `EMBEDDING_API_KEY`                                   | Voyage AI                                        |
| `RESEND_API_KEY`                                      | Resend                                           |
| `RESEND_WEBHOOK_SECRET`                               | Resend webhook config (`whsec_…`)                |
| `STORAGE_ACCESS_KEY_ID` / `STORAGE_SECRET_ACCESS_KEY` | Cloudflare R2 token                              |
| `AUTH_SECRET`                                         | `openssl rand -base64 32`                        |
| `AUTH_GOOGLE_ID` / `AUTH_GOOGLE_SECRET`               | Google Cloud OAuth client                        |
| `AUTH_MICROSOFT_ID` / `_SECRET` / `_TENANT_ID`        | Entra app registration                           |
| `FIELD_ENCRYPTION_KEY`                                | `openssl rand -base64 32` — **32 bytes exactly** |
| `TURNSTILE_SECRET_KEY`                                | Cloudflare Turnstile                             |
| `SENTRY_DSN`                                          | Sentry project                                   |

The handles are already set in Railway and point at exactly these names. Nothing in Railway needs to change except step 2.

### Step 2 — Enable the resolver

```bash
railway variables --service web \
  --set 'INFISICAL_RESOLVER_ENABLED=true' \
  --set 'INFISICAL_APP_CLIENT_ID=<client id>' \
  --set 'INFISICAL_APP_CLIENT_SECRET=<client secret>' \
  --set 'INFISICAL_PROJECT_ID=<workspace id>'
```

These three are the **only** raw secrets permitted anywhere. If you find yourself typing `sk-ant-`, `re_` or `whsec_` into a Railway variable, stop — that is the mistake this architecture exists to prevent.

### Step 3 — Storage

Create the R2 bucket `chambersofkoon-matters`, private, no public access. Then:

```bash
railway variables --service web \
  --set 'STORAGE_ENDPOINT=https://<account>.r2.cloudflarestorage.com'
```

`STORAGE_ENDPOINT` is account-scoped configuration, not a secret, so it is a literal.

### Step 4 — Verify

```bash
curl -s https://<domain>/api/health | jq
```

All five checks should read `ok: true`. If `secrets` is true but `storage` says _credentials unresolved_, the resolver is on but that particular handle does not match a real Infisical secret.

### Step 5 — Identity provider

Register the redirect URI `https://<domain>/api/auth/callback/google` (and/or `.../microsoft-entra-id`). Set `ALLOWED_EMAIL_DOMAINS` to the firm's domain.

**First sign-in:** the first person from an allow-listed domain to sign in against an empty `users` table becomes Managing Partner and is active immediately. Everyone after them lands in `invited` and must be activated. Have the managing partner sign in first, deliberately.

### Step 6 — Worker service

The web service does not process jobs. Triage, slot proposal, milestone email, OCR and embedding all need the worker:

```bash
railway add --service worker --repo eiaawsolutions/Messrs-ChambersofKoon-Platform --branch main
railway variables --service worker --set 'DATABASE_URL=${{Postgres.DATABASE_URL}}' # + the same env as web
# start command: npm run worker
```

Until the worker runs, enquiries are recorded but never triaged.

### Step 7 — Widget embed

On chambersofkoon.com.my:

```html
<script
  src="https://<domain>/widget.js"
  data-key="<WIDGET_PUBLIC_KEY from Railway>"
  data-firm="Chambers of Koon"
  defer
></script>
```

`WIDGET_PUBLIC_KEY` is public by design — it ships in the page source. It raises the cost of casual abuse; the origin allow-list, rate limiter and Turnstile do the real work. Add the site's origin to `WIDGET_ALLOWED_ORIGINS`.

Set `TURNSTILE_ENABLED=true` before go-live.

---

## 3. Routine operations

### Deploy

Push to `main`. To roll back, redeploy the previous deployment from the Railway dashboard — migrations are additive, so a rollback of application code is safe without a database rollback.

### Rotate a secret

Change the value in Infisical. The resolver caches for `INFISICAL_CACHE_TTL` (default 300s), so a restart is only needed if you want it immediately:

```bash
railway service restart --service web
```

Never rotate by setting a raw value in Railway.

### Suspend a user immediately

Set `users.status = 'suspended'` and increment `users.session_epoch`. `getActor()` compares the epoch on every request, so the user is out on their **next request**, not their next login (AT-07).

### Retry a failed archive file

Failed extractions keep their error in `archive_files.ocr_error` and are listed by `listFailedFiles()`. Re-enqueue `archive.extract-text` for that file id. Re-running is safe: chunks are deleted and rewritten per file, and `content_hash` is unique, so re-upload cannot duplicate (FR-5.6).

### Investigate a failed job

Failed jobs land in the `dead-letter` queue rather than disappearing. Inspect via `pgboss.job` in the database.

---

## 4. Backup and restore (NFR-3.3, NFR-3.4)

**Targets: RPO 24 hours, RTO 4 hours.**

Railway takes automated daily Postgres backups. Verify retention is enabled on the `Postgres` service.

### Restore rehearsal (required at UAT and each quarterly checkpoint)

1. Note the start time.
2. Provision a scratch Postgres service in a non-production environment.
3. Restore the most recent backup into it.
4. Point a scratch app instance at it (`DATABASE_URL` only).
5. Verify: row counts on `matters`, `documents`, `audit_events`, `chunks`; `select count(*) from chunks where embedding is not null`; sign in; open a matter; run a precedent search.
6. Record elapsed time and sign off. **AT-13 requires this to complete inside 4 hours.**

The queue lives in the same database, so a restore recovers pending jobs too. This is the main reason pg-boss was chosen over a separate Redis.

---

## 5. Incident: "secret not found"

Cheapest checks first:

1. `INFISICAL_RESOLVER_ENABLED=true` in the target environment?
2. All three bootstrap credentials set?
3. Does the handle match a real Infisical secret — project segment, environment, path and name?
4. Is the machine identity scoped to that workspace?
5. Restart to clear the resolver cache.

**Never** fix this by setting a raw value in Railway. That defeats the architecture and creates N copies of the secret to rotate later. Escalate instead.

---

## 6. AI spend

Every model call is written to `ai_usage_events` with model, tokens, latency and estimated cost.

- At **80%** of `AI_MONTHLY_SPEND_CEILING_USD` the app logs a warning but keeps serving — a firm mid-draft should not be cut off without notice.
- At **100%** further calls throw `AiSpendCeilingError`. Drafting and triage stop; the rest of the platform keeps working.

Month-to-date spend:

```sql
select task, count(*), sum(cost_usd::numeric)
from ai_usage_events
where created_at >= date_trunc('month', now())
group by task order by 3 desc;
```

The estimate uses published per-token prices. Anthropic's invoice is authoritative.

---

## 7. Data subject requests (NFR-2.3)

Export and erasure must preserve audit integrity. Erasure **tombstones** the client (`clients.erased_at`) and clears personal fields; it does **not** delete audit rows — those are immutable by design, and the trigger will reject the attempt.

Retention: audit events 7 years, messages 7 years, unconverted enquiries 24 months then purge.

---

## 8. Pre-go-live checklist

- [ ] Infisical populated; all five health checks `ok`
- [ ] Worker service running
- [ ] `TURNSTILE_ENABLED=true`
- [ ] `WIDGET_ALLOWED_ORIGINS` set to the firm's real origins
- [ ] Resend domain authenticated (SPF/DKIM/DMARC) and webhook registered
- [ ] `.ics` invitation accepted in Gmail, Outlook and Apple Mail (**AT-03**)
- [ ] Reschedule verified: same UID, SEQUENCE+1, no duplicate calendar entry (**AT-04**)
- [ ] Pupil account verified against precedent search (**AT-05**) and finalisation (**AT-06**)
- [ ] Restore rehearsal completed within RTO and signed off (**AT-13**)
- [ ] Firm precedent templates uploaded with placeholders mapped
- [ ] Managing Partner signed in first (bootstrap)
- [ ] Custom domain mapped and HSTS confirmed
