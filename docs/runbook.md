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

Infisical **is wired and resolving**. The app authenticates to the shared
`eiaaw-all-projects` vault (env `prod`) with the bootstrap machine identity, and
`/api/health` confirms `secrets: ok` and `anthropic: ok`.

Handles are mapped to the names the vault actually holds:

| App variable                | Infisical secret                | Status    |
| --------------------------- | ------------------------------- | --------- |
| `ANTHROPIC_API_KEY`         | `ANTHROPIC_API_KEY`             | resolving |
| `EMBEDDING_API_KEY`         | `VOYAGE_API_KEY`                | resolving |
| `RESEND_API_KEY`            | `RESEND_API`                    | resolving |
| `RESEND_WEBHOOK_SECRET`     | `RESEND_WEBHOOK_SIGNING_SECRET` | resolving |
| `AUTH_SECRET`               | `SESSION_SECRET`                | resolving |
| `STORAGE_ACCESS_KEY_ID`     | `R2_ACCESS_KEY_ID`              | resolving |
| `STORAGE_SECRET_ACCESS_KEY` | `R2_SECRET_ACCESS_KEY`          | resolving |
| `STORAGE_ACCOUNT_ID`        | `R2_ACCOUNT_ID`                 | resolving |

Three things remain, and none of them can be borrowed from another project.

### Step 1 — Register an OIDC client (blocking)

**Nobody can sign in until this exists.** The vault has no Google Workspace or
Microsoft Entra credentials for this application, and an OAuth client is a
per-application registration inside the firm's own tenant.

For Google Workspace: Google Cloud Console → APIs & Services → Credentials →
Create OAuth client ID → Web application. Authorised redirect URI:

```
https://web-production-782ae5.up.railway.app/api/auth/callback/google
```

For Microsoft 365: Entra admin centre → App registrations → New registration.
Redirect URI as above with `/microsoft-entra-id`.

Add the resulting values to Infisical under `prod` as `AUTH_GOOGLE_ID`,
`AUTH_GOOGLE_SECRET` (and/or `AUTH_MICROSOFT_ID`, `AUTH_MICROSOFT_SECRET`,
`AUTH_MICROSOFT_TENANT_ID`), then point the Railway variables at them:

```bash
railway variables --service web   --set 'AUTH_GOOGLE_ID=secret://eiaaw-all-projects/prod/AUTH_GOOGLE_ID'   --set 'AUTH_GOOGLE_SECRET=secret://eiaaw-all-projects/prod/AUTH_GOOGLE_SECRET'
```

Confirm `ALLOWED_EMAIL_DOMAINS` is the firm's real domain before anyone signs in.

**First sign-in matters:** the first person from an allow-listed domain to sign
in against an empty `users` table becomes Managing Partner and is active
immediately. Everyone after them lands in `invited` with no access. Have the
managing partner go first, deliberately.

### Step 2 — Create a dedicated R2 bucket

The R2 credentials in the vault authenticate correctly, but the token is scoped
to the existing `eiaaw-smt-prod` bucket. This platform is configured for
`chambersofkoon-matters`, which does not exist yet.

Do **not** repoint it at the shared bucket. A law firm's privileged matter files
should not share a bucket with another product's assets; segregation is the
whole point of a per-client bucket.

1. Cloudflare dashboard → R2 → Create bucket `chambersofkoon-matters`, private.
2. Create an R2 API token scoped to that bucket with read and write.
3. Either add its values to Infisical as new secrets and repoint the handles, or
   extend the existing token's scope to include the new bucket.

`/api/health` will report `storage: ok` once the bucket is reachable. Until
then, archive upload and document download are the only features affected;
everything else runs.

### Step 3 — Add a dedicated field-encryption key

There is no `FIELD_ENCRYPTION_KEY` in the vault, so the app derives one from
`AUTH_SECRET` via HKDF-SHA256 with a fixed domain-separation label. That is
sound — the derived key is independent of the signing key — but it couples
rotation: **while the fallback is in use, rotating `AUTH_SECRET` makes existing
encrypted client identifiers undecryptable.**

Before the first rotation:

```bash
openssl rand -base64 32     # add to Infisical as FIELD_ENCRYPTION_KEY
railway variables --service web   --set 'FIELD_ENCRYPTION_KEY=secret://eiaaw-all-projects/prod/FIELD_ENCRYPTION_KEY'
```

Any identifiers encrypted under the derived key must be re-encrypted at the same
time. At present there are none, so doing this early is free.

### Step 4 — Worker service (required for anything to process)

The web service does not run jobs. Triage, slot proposal, milestone email, text
extraction and embedding all need the worker. Until it runs, enquiries are
recorded but never triaged and no draft is ever generated.

```bash
railway add --service worker --repo eiaawsolutions/Messrs-ChambersofKoon-Platform --branch main
```

Give it the same variables as `web` (including the three `INFISICAL_*` bootstrap
credentials) and set its start command to `npm run worker`.

### Step 5 — Widget embed

On chambersofkoon.com.my:

```html
<script
  src="https://<domain>/widget.js"
  data-key="<WIDGET_PUBLIC_KEY from Railway>"
  data-firm="Chambers of Koon"
  defer
></script>
```

`WIDGET_PUBLIC_KEY` is public by design — it ships in the page source. It raises
the cost of casual abuse; the origin allow-list, rate limiter and Turnstile do
the real work. Add the site's origin to `WIDGET_ALLOWED_ORIGINS`, and set
`TURNSTILE_ENABLED=true` with a registered site key before go-live.

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
