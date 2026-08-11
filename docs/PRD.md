# Product Requirements Document

Matter Velocity Platform — Messrs Chambers of Koon
Prepared by: EIAAW Solutions Sdn Bhd (202603133419)
Version: 1.0
Status: Ready for engineering kickoff
Source of truth: AI Integration Proposal deck, Chambers of Koon, 9 August 2026

# 1. Overview

## 1.1 Purpose

Build a single-tenant web platform for a Malaysian litigation-led law firm with offices in Kuala Lumpur, Petaling Jaya and Ipoh. The platform compresses the time between client enquiry and billable legal work through four AI-assisted workflows: enquiry triage, document drafting, precedent retrieval, and client milestone communication — all under lawyer control with a full audit trail.

## 1.2 Product principles

Lawyer-in-the-loop. No AI output reaches a client without a human approving it. No appointment is confirmed without the assigned lawyer accepting it.
No claims we cannot keep. The platform does not file on court systems, does not read lawyers' external calendars, and does not train models on firm content.
One codebase. Dashboard, admin console, API routes and the embeddable widget ship from one Next.js application.
Auditable by default. Every AI generation, every access to a matter, every permission change is written to an append-only log.
Firm-owned data. Matter data, drafts and embeddings live in the firm's dedicated database and object storage; identifiers are tokenised before any prompt leaves the platform.

## 1.3 Goals (measurable)

| TABLE |
| # | Goal | Target at go-live |
| G1 | Reduce time-to-first-consultation | Enquiry to proposed slot < 5 minutes, 24/7 |
| G2 | Reduce drafting time on top matter types | First draft available < 2 minutes after intake data complete |
| G3 | Reduce inbound client status calls | Milestone email sent within 60s of staff status change |
| G4 | Precedent retrieval available to all fee earners | Query to cited excerpt < 10 seconds |
| G5 | Access control defensible under professional conduct review | 100% of matter access events logged, immutable |

## 1.4 Non-goals (v1)

Court e-filing or any integration with Malaysian court systems (CMS / e-Filing).
Telephony or voice intake.
Google/Microsoft Calendar API read or write (free/busy sync).
Billing, time recording, trust accounting.
Native mobile applications (the dashboard is responsive web).
Multi-tenant SaaS. This is a single-firm deployment.

# 2. Users and roles

## 2.1 Personas

| TABLE |
| Persona | Context | Primary need |
| Managing Partner | Owns the firm, admin account holder | Oversight of all matters, control of who has access |
| Partner | Practice-area lead, one office | Approve drafts and appointments, manage own caseload |
| Senior Associate / Associate | Fee earner | Draft faster, find precedent, run consultations prepared |
| Pupil in chambers | Trainee, supervised | Prepare drafts and research without exposure to full client identity |
| Legal executive / clerk | Procedural work, filing | Record procedural stages, manage the intake queue |
| Practice manager / admin staff | Operations across three offices | Onboard/offboard users, keep matter index current |
| Prospective client | External, unauthenticated | Ask a question at 11pm and get a real response |

## 2.2 Role permission matrix

Roles are seeded from this matrix and editable by the admin account. "Own" = matters where the user is the assigned fee earner or supervisor.

| TABLE |
| Capability | Managing Partner | Partner | Snr Assoc / Assoc | Pupil | Legal exec / clerk | Practice mgr |
| View all matters (all offices) | Yes | Own office + practice area | Own only | Own only | Own only | Index and status only |
| View document contents | Yes | Yes | Own | Own, identifiers masked | Own | No |
| Run intake triage / view queue | Yes | Yes | Yes | No | Yes | No |
| Generate AI draft | Yes | Yes | Own | Own, cannot finalise | No | No |
| Finalise / send document | Yes | Yes | Own | No | No | No |
| Approve appointment slot | Yes | Yes | Own | No | On behalf, if delegated | No |
| RAG precedent search | Yes | Yes | Yes | Yes | No | No |
| Record procedural status | Yes | Yes | Yes | No | Yes | No |
| Create/edit users and roles | Yes | Request only | No | No | No | Delegated: onboard/offboard, reset 2FA |
| Toggle feature-level access | Yes | No | No | No | No | No |
| View audit log | Yes | Own office | No | No | No | No |

Rule: permissions are additive per role; a user has exactly one role plus optional per-matter assignment. Pupil masking is enforced server-side at query time, not in the UI.

# 3. System architecture

## 3.1 Stack (fixed — do not substitute without EIAAW sign-off)

| TABLE |
| Layer | Technology |
| Application | Next.js (App Router), React, TypeScript, Tailwind CSS |
| Hosting | Railway, asia-southeast1 (Singapore) |
| Database | PostgreSQL on Railway, pgvector extension |
| ORM / migrations | Prisma or Drizzle (team choice; must support pgvector via raw SQL) |
| Object storage | S3-compatible bucket (Railway volume-backed or Cloudflare R2), private, presigned URLs only |
| AI | Anthropic Claude API (Sonnet-class for drafting/triage, Haiku-class for classification and cheap passes) |
| Embeddings | Managed embedding API, dimension fixed at project start, recorded in embedding_model_version |
| Email + calendar invites | Resend (EIAAW verified sending domain; firm domain optional) |
| Auth | OIDC SSO against Google Workspace and Microsoft Entra ID; NextAuth/Auth.js |
| Document output | .docx assembly (docxtemplater or docx library) from firm templates |
| OCR | Claude vision on scanned PDFs/images; dedicated OCR service only if accuracy fails UAT |
| Background jobs | Queue with durable retries (BullMQ + Redis on Railway, or pg-boss on the same Postgres) |
| Observability | Structured JSON logs, Sentry for errors, uptime check on /api/health |

## 3.2 Component flow (logical)

[chambersofkoon.com.my]
| <script src="https://app.<domain>/widget.js" data-firm="cok">
v
[Intake Widget] ---- POST /api/public/enquiry ----+
|
[Lawyer Dashboard] --- Next.js App Router --------+
[Admin Console] --- Server Actions / API ------+
|
+-------------------+--------------------+
| Application (Railway) |
+---+--------+---------+--------+--------+
| | | |
v v v v
[PostgreSQL [Object [Claude [Resend] [Job queue: + pgvector] storage] API] .ics + OCR, embed,
tokenised email draft, digest]

## 3.3 Environments

| TABLE |
| Env | Purpose | Data |
| development | Local + Railway dev service | Synthetic only |
| uat | Firm acceptance testing | Anonymised sample + firm-supplied test matters |
| production | Live | Real client data |

Promotion is development to uat to production. No direct pushes to production. Each environment has its own database, bucket, Resend key and Claude API key.

# 4. Data model

Core entities. All tables carry id (uuid), created_at, updated_at, and where relevant created_by_user_id.

## 4.1 Identity and access

users — email (unique), full_name, role_id, office (KL|PJ|IPOH), status (invited|active|suspended), sso_provider, sso_subject, last_login_at.
roles — name, description, is_system (seeded roles cannot be deleted).
permissions — key (e.g. matter.view.all, document.finalise, admin.users.manage), description.
role_permissions — join table, editable from the admin console.
audit_events — actor_user_id, action, entity_type, entity_id, matter_id (nullable), metadata (jsonb), ip, user_agent, occurred_at. Append-only: no UPDATE or DELETE grants for the application role; enforce with a trigger that raises on update/delete.

## 4.2 Matters and clients

clients — full_name, email, phone, id_number_encrypted, notes.
matters — reference (firm format), client_id, practice_area (family_matrimonial, debt_recovery, land_property, corporate_disputes, general), office, assigned_user_id, supervising_user_id, status, opened_at, closed_at.
matter_participants — grants explicit access to users beyond the assignee.
matter_status_events — matter_id, stage, recorded_by_user_id, occurred_at, notes. Drives milestone emails.

## 4.3 Enquiries and scheduling

enquiries — source (widget|form|manual), raw_payload (jsonb), contact_name, contact_email, contact_phone, practice_area_predicted, urgency, confidence, case_brief_md, status (new|triaged|slot_proposed|booked|declined|spam), matter_id (nullable).
availability_rules — user_id, office, practice_area, weekday, start_time, end_time, slot_minutes, buffer_minutes, valid_from, valid_to.
appointment_proposals — enquiry_id, proposed_user_id, starts_at, ends_at, state (pending|accepted|rescheduled|declined|expired), expires_at, decided_at, decided_by_user_id.
appointments — matter_id or enquiry_id, user_id, starts_at, ends_at, location, ics_uid, ics_sequence, state (confirmed|cancelled|rescheduled).

## 4.4 Documents and knowledge

document_templates — name, practice_area, doc_type, storage_key, version, placeholder_schema (jsonb), is_active.
documents — matter_id, template_id, title, state (draft|in_review|final), current_version_id.
document_versions — document_id, version_no, storage_key, generated_by (ai|human), model_version, prompt_hash, created_by_user_id.
archive_files — matter_id (nullable), original_filename, storage_key, mime_type, page_count, ocr_state (pending|processing|done|failed), uploaded_by_user_id.
chunks — source_type (archive_file|document_version), source_id, matter_id, practice_area, chunk_index, text, token_count, embedding vector(N), embedding_model_version. Index: CREATE INDEX ON chunks USING hnsw (embedding vector_cosine_ops). Every retrieval query must filter by the caller's permitted matter scope before ranking.

## 4.5 Communications

message_templates — key (e.g. milestone.hearing_confirmed), subject, body_md, locale.
messages — matter_id, to_email, template_key, subject, body_rendered, resend_message_id, state (queued|sent|delivered|bounced|failed), sent_at, error.

# 5. Functional requirements

Each requirement is testable. MUST = v1 scope. SHOULD = v1 if time allows.

## 5.1 M1 — Authentication and access management (Phase 1)

FR-1.1 (MUST) Users sign in via OIDC SSO against the firm's Google Workspace or Microsoft 365 tenant. No local password store.
FR-1.2 (MUST) 2-step verification is enforced by the identity provider. Reject a session whose token lacks an MFA claim where the provider supplies one; surface a setup prompt on first login otherwise.
FR-1.3 (MUST) First login creates a user record in invited state only if the email domain is on the allow-list; otherwise access is denied and the attempt is logged.
FR-1.4 (MUST) Session lifetime 12 hours; re-authentication required on new device (device fingerprint stored, hashed).
FR-1.5 (MUST) Server-side authorisation on every request. A permission helper — can(user, 'document.finalise', matter) — is the only sanctioned access path; direct queries in route handlers without a scope filter fail code review.
FR-1.6 (MUST) Admin console: create/invite user, assign role, change office, suspend, reset 2FA (revoke sessions, force IdP re-enrolment), create/edit custom roles by toggling permissions.
FR-1.7 (MUST) Audit log viewer with filters (actor, action, matter, date range) and CSV export for the Managing Partner.
FR-1.8 (MUST) Audit events required for: login success/failure, matter open, document view/download, draft generation, document finalisation, permission change, user create/suspend, availability rule change, message send.

## 5.2 M2 — Intake widget and triage agent (Phase 1)

FR-2.1 (MUST) A single script tag embeds the widget on chambersofkoon.com.my: <script src="https://<app-domain>/widget.js" data-key="<public-key>" defer></script>. The widget mounts a launcher and chat panel in a Shadow DOM so firm site CSS cannot break it. No site rebuild required.
FR-2.2 (MUST) Widget is responsive, keyboard accessible, and renders a plain fallback form if JavaScript fails.
FR-2.3 (MUST) POST /api/public/enquiry is rate-limited per IP and session, protected by a bot check (Turnstile/hCaptcha), and restricted to the widget's origin via a CORS allow-list.
FR-2.4 (MUST) The triage agent identifies practice area, captures case facts against a per-practice-area question set, detects urgency, and captures contact details. It must not give legal advice — system-prompt guardrail plus a refusal test in the eval suite.
FR-2.5 (MUST) On completion the agent produces a case brief (facts, classification, urgency, suggested next step) and routes to the correct practice lead using practice area, office and availability.
FR-2.6 (MUST) Low-confidence classification routes to a human review queue instead of proposing a slot.
FR-2.7 (MUST) Out-of-hours enquiries are handled identically; the proposal queues for lawyer approval next working morning.
FR-2.8 (SHOULD) Duplicate and spam detection on repeated submissions from the same email within 24 hours.

## 5.3 M3 — Scheduling with lawyer approval (Phase 1)

FR-3.1 (MUST) Availability defined by rules per lawyer, office and practice area (weekday windows, slot length, buffer). Configured in the admin console, no calendar API.
FR-3.2 (MUST) The system proposes the earliest slot matching the rules with no existing appointment for that lawyer.
FR-3.3 (MUST) The proposal appears in the lawyer's dashboard and in a notification email with three actions: Accept, Reschedule (pick another slot), Decline (with reason, returns to queue).
FR-3.4 (MUST) No client-facing invitation is sent until a lawyer acts. Hard rule, covered by an automated test.
FR-3.5 (MUST) Proposals expire after a configurable window (default 12 working hours) and escalate to the practice lead.
FR-3.6 (MUST) On acceptance, email the client and lawyer an RFC 5545 .ics invitation via Resend with METHOD:REQUEST, a stable UID and incrementing SEQUENCE. Must render as an accept/decline invite in Gmail, Outlook and Apple Mail — verified on all three at UAT.
FR-3.7 (MUST) Reschedule and cancel re-issue the .ics with the same UID and SEQUENCE + 1, using METHOD:CANCEL on cancellation.
FR-3.8 (SHOULD) Token-based client reschedule link (no login) that creates a new proposal for lawyer approval.

## 5.4 M4 — Document generation (Phase 2)

FR-4.1 (MUST) Firm precedent templates uploaded as .docx with named placeholders; the platform parses and stores a placeholder schema per template.
FR-4.2 (MUST) Matter data fills deterministic placeholders; Claude generates narrative clauses only where the template marks an AI block. Deterministic fields are never model-generated.
FR-4.3 (MUST) Output is an editable .docx preserving firm styles, numbering and track-changes readiness. PDF export is secondary.
FR-4.4 (MUST) Every generation stores model_version, prompt_hash, inputs used and retrieved chunks cited, linked to the document version.
FR-4.5 (MUST) A draft stays in draft until a permitted user marks it final. Pupils cannot finalise. Finalisation is an audit event.
FR-4.6 (MUST) Version history with download of any prior version and a visible diff summary between versions.
FR-4.7 (MUST) Priority matter types for v1: divorce petition, letter of demand / debt recovery, and one conveyancing pack (SPA or loan documentation) — confirmed at discovery.
FR-4.8 (SHOULD) Lawyer edits to AI blocks captured as signal for prompt refinement (stored, not used for model training).

## 5.5 M5 — Archive ingest and OCR (Phase 2)

FR-5.1 (MUST) Upload screen accepts PDF, DOCX, JPG, PNG; single and bulk (multi-file drag-drop, minimum 200 files per batch) with a visible progress queue and per-file status.
FR-5.2 (MUST) Files stored in object storage; text extraction runs as a background job. Native-text PDFs and DOCX extract directly; scans and images go through OCR.
FR-5.3 (MUST) Failed extractions are retryable from the UI and never silently dropped.
FR-5.4 (MUST) Uploader assigns practice area and optionally matter at upload; unassigned files land in a review queue.
FR-5.5 (MUST) Extracted text is chunked (target 800–1200 tokens, 15% overlap, split on document structure where possible), embedded and written to chunks.
FR-5.6 (MUST) Re-indexing is idempotent — re-uploading the same file must not duplicate chunks (content hash check).

## 5.6 M6 — RAG precedent retrieval (Phase 2)

FR-6.1 (MUST) Natural-language query returns ranked excerpts with source document, page/section and matter reference. Citation is mandatory, never an uncited summary.
FR-6.2 (MUST) Retrieval is permission-scoped: vector search filters to matters the caller may view before ranking. A pupil's search must not surface an excerpt from a matter they cannot open.
FR-6.3 (MUST) Hybrid retrieval: vector similarity plus keyword/BM25, merged and re-ranked. Pure vector search fails on party names and citations.
FR-6.4 (MUST) Filters by practice area, date range, office and outcome where recorded.
FR-6.5 (MUST) "Insert into draft" pulls a cited excerpt into the current document with the citation retained.
FR-6.6 (MUST) Zero-result and low-confidence states say so plainly. No fabricated precedent — covered by an eval case.

## 5.7 M7 — Milestone communication (Phase 3)

FR-7.1 (MUST) Configurable procedural stages per practice area. Default family/matrimonial set: documents_signed, filing_submitted, hearing_date_confirmed, certificate_issued, matter_closed.
FR-7.2 (MUST) Milestones fire from status events recorded by firm staff. The platform does not read from or write to court systems.
FR-7.3 (MUST) On a status change, the matching client email renders from a message template and sends via Resend within 60 seconds.
FR-7.4 (MUST) Per-matter and per-stage suppression, plus a "hold all client comms" switch on sensitive matters.
FR-7.5 (MUST) Delivery state (sent/delivered/bounced) written back via Resend webhooks and shown on the matter timeline. Bounces raise a task for the clerk.
FR-7.6 (MUST) Exceptions (bounce, no status movement past an SLA threshold) escalate to the handling lawyer, not the client.
FR-7.7 (MUST) Sender identity configurable: EIAAW verified domain with firm display name and reply-to (default), or the firm's own domain once DNS records are in place.

## 5.8 M8 — Lawyer dashboard (Phases 1–3)

FR-8.1 (MUST) Home: pending slot approvals, drafts awaiting review, matters with milestones due, unread exceptions.
FR-8.2 (MUST) Matter view: client, status timeline, documents, appointments, messages, participants.
FR-8.3 (MUST) Intake queue with case briefs and one-tap approve/reschedule/decline.
FR-8.4 (MUST) Precedent search with citation and insert-to-draft.
FR-8.5 (SHOULD) Saved searches and a per-office view for practice leads.

## 5.9 M9 — Administration and configuration (Phase 1)

FR-9.1 (MUST) Manage users, roles, permissions, offices.
FR-9.2 (MUST) Manage availability rules, proposal expiry, working hours and public holidays (Malaysian federal plus Selangor and Perak).
FR-9.3 (MUST) Manage document templates and message templates with preview.
FR-9.4 (MUST) Feature toggles per role (e.g. disable AI drafting for a role without touching code).
FR-9.5 (MUST) Audit log viewer and export.

# 6. AI layer specification

## 6.1 Model routing

| TABLE |
| Task | Model class | Notes |
| Intake conversation, case brief | Sonnet-class | Streaming, tool-use for structured capture |
| Practice-area classification | Haiku-class | Cheap, high volume, structured output |
| Draft narrative clauses | Sonnet-class | Highest quality, low volume |
| OCR / scanned document reading | Vision-capable | Batched in background jobs |
| Query rewrite for retrieval | Haiku-class | Cheap |

Model IDs are configuration, not constants in code. Every stored generation records the exact model version used.

## 6.2 Prompt and safety requirements

AI-1 (MUST) Client identifiers (full name, IC/passport number, phone, email, address, account numbers) are tokenised before the prompt leaves the platform and re-hydrated in the rendered output. The tokenisation map is per-request and never persisted with the prompt.
AI-2 (MUST) System prompts are versioned in the repository and referenced by hash in document_versions.prompt_hash.
AI-3 (MUST) Structured output is validated against a schema (Zod). A malformed response retries once, then fails to a human queue — never renders a partial draft.
AI-4 (MUST) Guardrails: the intake agent must not give legal advice, quote fees or promise outcomes. The drafting layer must not invent case citations, statutory provisions or party details absent from inputs.
AI-5 (MUST) An eval suite runs in CI with at least: 20 intake transcripts across all five practice areas plus adversarial cases; 10 drafting cases with golden outputs; 15 retrieval queries with expected sources; 5 refusal cases. Merges blocked on regression.
AI-6 (MUST) Token and cost per request logged; a monthly spend ceiling triggers alerting before throttling.
AI-7 (MUST) Anthropic commercial terms apply: firm content is not used for model training. Confirm a zero-retention arrangement in writing before production data flows.

# 7. Non-functional requirements

## 7.1 Security

NFR-1.1 TLS 1.2+ everywhere; HSTS on the app domain.
NFR-1.2 Encryption at rest for database and object storage; client identifier columns additionally encrypted at the application layer.
NFR-1.3 All object storage access via short-lived presigned URLs. No public buckets.
NFR-1.4 Secrets in Railway environment variables, never in the repository. Separate keys per environment. Rotation runbook documented.
NFR-1.5 Dependency and container scanning in CI; no high-severity vulnerabilities merged.
NFR-1.6 Penetration-test-style review of the public widget endpoint before go-live (injection, enumeration, rate-limit bypass, CORS).

## 7.2 Privacy and PDPA alignment

NFR-2.1 Data resides in asia-southeast1 (Singapore), the nearest Railway region. Cross-border processing to the Anthropic API is de-identified via tokenisation and covered contractually.
NFR-2.2 Documented retention: audit events 7 years, messages 7 years, unconverted enquiries 24 months then purge.
NFR-2.3 Data subject request support: export and delete a client's personal data with a documented procedure that preserves audit integrity (tombstone, not hard delete of audit rows).
NFR-2.4 A data flow diagram and processing record maintained in the repository.

## 7.3 Availability, performance, recovery

NFR-3.1 Target availability 99.5% during Malaysian business hours (0800–2000 MYT, Mon–Fri).
NFR-3.2 Dashboard p95 page load under 2s; retrieval query p95 under 10s; draft generation p95 under 120s (async with progress, never a blocking spinner).
NFR-3.3 Backups: nightly automated PostgreSQL backup plus point-in-time recovery; object storage versioned with lifecycle rules. Backups encrypted and stored separately from the primary.
NFR-3.4 Restore: RPO 24 hours, RTO 4 hours. A full restore into a scratch environment is rehearsed at UAT and re-tested at each quarterly checkpoint, with a signed-off runbook recording elapsed time.
NFR-3.5 Health endpoint /api/health checks database, storage, queue and Claude API reachability; external uptime monitor alerts on failure.

## 7.4 Observability

NFR-4.1 Structured JSON logs with request ID and user ID (never prompt contents or client identifiers).
NFR-4.2 Error tracking with release tagging.
NFR-4.3 Operational dashboard: enquiries per day, proposals pending, drafts generated, emails sent and bounced, AI spend, job queue depth and failures.

## 7.5 Accessibility and localisation

NFR-5.1 WCAG 2.1 AA for the dashboard and the public widget.
NFR-5.2 English (Malaysia) at launch; copy externalised in a message catalogue so Bahasa Malaysia can be added without code changes.

# 8. API surface (indicative)

| TABLE |
| Method | Route | Auth | Purpose |
| POST | /api/public/enquiry | Public key + bot check | Widget submits enquiry turn |
| GET | /widget.js | Public | Embeddable widget bundle |
| POST | /api/enquiries/:id/triage | Session | Re-run triage, human override |
| POST | /api/proposals/:id/accept | Session | Lawyer accepts; sends .ics |
| POST | /api/proposals/:id/reschedule | Session | New slot, re-proposes |
| POST | /api/proposals/:id/decline | Session | Reason, returns to queue |
| POST | /api/matters/:id/documents | Session | Generate draft from template |
| GET | /api/documents/:id/versions/:v/download | Session | Presigned .docx |
| POST | /api/documents/:id/finalise | Session | State change, audited |
| POST | /api/archive/upload | Session | Bulk upload, returns job ids |
| POST | /api/search/precedent | Session | Permission-scoped hybrid retrieval |
| POST | /api/matters/:id/status | Session | Record stage, triggers email |
| POST | /api/webhooks/resend | Signature | Delivery and bounce callbacks |
| GET | /api/health | Public | Liveness and dependency check |

# 9. Delivery plan

Mapped to the proposal's three phases (approximately 14 weeks). Each phase ends with a demo to the Managing Partner and a written acceptance sign-off.

## Phase 1 — Weeks 1–4: Foundation, access, intake, scheduling

Discovery workshop; environments and CI/CD; data model and migrations; SSO, RBAC, audit log and admin console; intake widget and triage agent; availability rules, slot proposal and lawyer approval; .ics delivery via Resend; dashboard v1 (intake queue, approvals).
Exit criteria: a real enquiry submitted on a staging copy of the firm's website produces a case brief, a proposed slot, a lawyer approval and a calendar invitation accepted in Gmail, Outlook and Apple Mail. All actions appear in the audit log.

## Phase 2 — Weeks 5–10: Documents and knowledge

Template ingestion and placeholder mapping; .docx generation with AI clause blocks; version history and finalisation; bulk archive upload with OCR; chunking, embedding, hybrid retrieval with citations; insert-to-draft; dashboard v2 (matter view, precedent search).
Exit criteria: a lawyer generates a divorce petition and a letter of demand from real firm templates, edits and finalises both in Word, and retrieves a cited precedent from the firm's uploaded archive with permission scoping verified on a pupil account.

## Phase 3 — Weeks 11–14: Communication, hardening, rollout

Sender identity decision and configuration; milestone stages, templates, suppression and escalation; Resend delivery webhooks; performance and security hardening; backup and restore rehearsal; training across KL, PJ and Ipoh; go-live and feedback tuning.
Exit criteria: a status change to hearing_date_confirmed sends the client email within 60 seconds with delivery confirmed; restore rehearsal completed within RTO and signed off; all three offices trained; production go-live.

# 10. Acceptance test scenarios (abridged)

| TABLE |
| ID | Scenario | Expected |
| AT-01 | Enquiry submitted 23:00, family matrimonial | Case brief generated, slot proposed, no client email sent |
| AT-02 | Lawyer declines proposal | Client receives nothing; enquiry returns to queue with reason |
| AT-03 | Lawyer accepts proposal | Client and lawyer receive .ics; accepting in Gmail adds to calendar |
| AT-04 | Reschedule after acceptance | Same UID, SEQUENCE+1, calendars update, no duplicate event |
| AT-05 | Pupil opens precedent search | No excerpt from an unassigned matter appears; identifiers masked |
| AT-06 | Pupil attempts finalise | Blocked server-side, attempt audited |
| AT-07 | Suspended user session | Access denied on next request, not next login |
| AT-08 | Bulk upload of 200 scanned PDFs | All processed or retryable; no duplicate chunks on re-upload |
| AT-09 | Draft generation with missing intake data | Deterministic placeholders flagged, no invented values |
| AT-10 | Status set to certificate_issued | Client email within 60s; delivery state visible on timeline |
| AT-11 | Client email bounces | Clerk task raised; lawyer notified; no silent failure |
| AT-12 | Claude API outage | Draft queued and retried; user sees honest status, no data loss |
| AT-13 | Database restore rehearsal | Full restore within RTO 4h, verified row counts, signed off |

# 11. Open questions for discovery

Blocking answers are marked [B].
[B] Which identity provider does each office use — Google Workspace or Microsoft 365? Determines the OIDC integration built first.
[B] Which three matter types are the Phase 2 drafting priority, and can the firm supply clean .docx precedent templates for each?
[B] How is lawyer availability managed today, and who owns the rules per office?
[B] How much of the matter archive is already digital? Who scans the remainder, and on what timeline?
Does the firm run any existing case, document or practice management software the platform must read from or write to?
Actual matter volume per practice area and per office, to size AI spend and job throughput.
Sender identity: EIAAW verified domain with firm display name, or the firm's own domain (requires DNS records)?
Firm matter reference format, and any existing numbering to preserve.
Retention policy the firm is contractually or professionally bound to.
Named firm-side owner for UAT sign-off per phase.

# 12. Appendix

## 12.1 Environment variables

DATABASE_URL
DIRECT_URL # migrations
ANTHROPIC_API_KEY
ANTHROPIC_MODEL_DRAFTING
ANTHROPIC_MODEL_CLASSIFY
EMBEDDING_API_KEY
EMBEDDING_MODEL_VERSION
RESEND_API_KEY
RESEND_FROM_ADDRESS
RESEND_REPLY_TO
RESEND_WEBHOOK_SECRET
STORAGE_ENDPOINT
STORAGE_BUCKET
STORAGE_ACCESS_KEY_ID
STORAGE_SECRET_ACCESS_KEY
AUTH_SECRET
AUTH_GOOGLE_ID / AUTH_GOOGLE_SECRET
AUTH_MICROSOFT_ID / AUTH_MICROSOFT_SECRET / AUTH_MICROSOFT_TENANT_ID
ALLOWED_EMAIL_DOMAINS
WIDGET_PUBLIC_KEY
WIDGET_ALLOWED_ORIGINS
TURNSTILE_SECRET_KEY
SENTRY_DSN
APP_BASE_URL
NODE_ENV / APP_ENV

## 12.2 Suggested repository structure

/app # Next.js App Router
/(dashboard) # authenticated lawyer UI
/(admin) # admin console
/api # route handlers
/components
/lib
/auth # session, permission helpers <- single access path
/ai # prompts (versioned), model routing, tokenisation
/docs # docx assembly
/rag # chunking, embedding, hybrid retrieval
/email # resend client, ics builder
/db # schema, migrations, queries
/jobs # background workers
/evals # AI eval suite run in CI
/public/widget # embeddable widget bundle
/docs # this PRD, runbooks, data flow diagram

## 12.3 Definition of done (per feature)

Typed and lint-clean; unit tests on business rules; integration test on the happy path plus one failure path; permission check present and tested; audit event emitted where required; eval case added if AI-touching; documented in /docs; deployed to UAT and demoed.
Prepared by EIAAW Solutions Sdn Bhd. This PRD is the engineering contract for the Chambers of Koon proposal dated 9 August 2026. Changes to scope, stack or claims must be reflected in both this document and the client-facing deck.
