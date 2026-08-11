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

## 2. Signing in

The platform issues its own user IDs and passwords (**PRD amendment A1** —
supersedes FR-1.1's SSO-only assumption). Sign-in is two steps:

1. **Email and password**
2. **Six-digit code** from an authenticator app — enrolled on first sign-in

Between the two the server holds no session, only a signed five-minute
challenge. A browser that completes step one and stops has access to nothing.

### Getting in the first time

`eiaawsolutions@gmail.com` is already an **active Managing Partner**.

1. Go to `/sign-in` → **Forgotten your password**
2. Enter the address; a reset link arrives within a minute or two
3. Set a password — at least 12 characters, nothing connected to you or the firm
4. Sign in with it
5. You will be asked to **set up two-step verification**: scan the QR code with
   Google Authenticator, Microsoft Authenticator, 1Password or similar, then
   enter the code it shows
6. **Save the ten recovery codes.** They are shown once. Without them, a lost
   phone means an administrator has to reset your second step

### Creating everyone else

Admin → Users → _Create an account_. You receive a temporary password **once**,
on screen, to hand over in person or by phone. It is deliberately not emailed:
sending a working credential to a mailbox the firm has not verified is the
classic account-takeover path. The recipient must change it at first sign-in and
then enrol an authenticator app.

`ALLOWED_EMAIL_DOMAINS` currently permits `chambersofkoon.com.my`,
`eiaawsolutions.com` and `gmail.com`. Narrow it to the firm's own domain once
their partners are onboarded, and clear `BOOTSTRAP_ADMIN_EMAIL` at the same time
so the boot-time grant stops running.

### When someone is locked out

| Situation                      | What to do                                                                                                               |
| ------------------------------ | ------------------------------------------------------------------------------------------------------------------------ |
| Eight wrong passwords          | Locks for 15 minutes. Admin → Users → **Unlock** lifts it early                                                          |
| Forgotten password             | They use **Forgotten your password** themselves                                                                          |
| Lost phone, has recovery codes | Sign in, then _Use a recovery code_ on the second step                                                                   |
| Lost phone, no codes left      | Admin → Users → **Reset 2FA**, after confirming who they are by another channel. This is a real privilege and is audited |
| Leaver                         | Admin → Users → **Suspend**. Live sessions end on their next request                                                     |

Suspending, changing a role, resetting a password and clearing 2FA all revoke
live sessions immediately.

### Security properties worth knowing

- Passwords are scrypt-hashed at N=2^17, above the OWASP minimum
- An unknown address and a wrong password are indistinguishable, in wording and
  in response time
- A password reset does **not** clear the second factor, so mailbox access alone
  is not enough to take an account over
- Reset tokens are stored only as hashes, expire in 45 minutes, work once, and a
  newer request cancels an older one
- A TOTP code cannot be replayed inside its own 30-second window

### Optional: SSO alongside passwords

Google Workspace and Microsoft Entra remain supported. Configure
`AUTH_GOOGLE_ID` / `AUTH_GOOGLE_SECRET` in Infisical and point the Railway
handles at them; the buttons then appear alongside the password form. Redirect
URI: `https://web-production-782ae5.up.railway.app/api/auth/callback/google`.

### Still outstanding

- **Dedicated R2 bucket.** The firm currently shares `eiaaw-smt-prod` under a
  `chambersofkoon/` prefix because the available token is scoped to it.
- **Dedicated `FIELD_ENCRYPTION_KEY`.** Derived from `AUTH_SECRET` via HKDF
  until one exists, which couples rotation. Add one before rotating
  `AUTH_SECRET`.
- **Turnstile** is off and has no site key registered.
- **Firm precedent templates** are needed before document generation is useful.

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
