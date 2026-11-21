# CertiFlow — Skilling Certificate Issuance Platform

Built for the **Pragati Skills Mission** hackathon problem statement. CertiFlow replaces manual email spreadsheets, WhatsApp approvals, and hand-typed Word certificates with an event-driven, auditable, and tamper-resistant platform.

---

## 1. Requirements Note & Deliberate Design Decisions

Where the programme office brief was open-ended, we made the following explicit, documented engineering decisions:

1. **District Quorum (`2` of N officers)**: A batch in `SUBMITTED_DISTRICT` requires **2 distinct District Officers** from the same district to click `APPROVE` before advancing. Concurrent approvals are serialized with PostgreSQL `SELECT ... FOR UPDATE` row locks so two officers approving at the exact same millisecond advance the batch **once, not twice**.
2. **Large Batch Scrutiny (`>= 50` candidates)**: Batches with 50 or more candidates automatically set `requiresQualityTeam = true` on upload and route to `PENDING_QUALITY` (for Neha) after District approval. Smaller batches (`< 50`) skip `PENDING_QUALITY` and go straight to `PENDING_STATE`.
3. **What Happens When a Sent-Back Batch is Fixed & Resubmitted (Moment 6)**: When any officer sends a batch back (`RETURNED_FOR_CORRECTION`), the training centre can upload a corrected spreadsheet and resubmit. Upon resubmission, **`approvalRound` increments (e.g., R1 -> R2) and all prior-round `ApprovalDecision` records are archived (`active = false`)**. Why? Because the candidate list or scores may have changed during correction, so every officer must re-verify the revised batch rather than carrying over stale approvals. Full history remains visible in the audit trail.
4. **SLA Escalation Threshold (`48` hours)**: Batches sitting untouched in `SUBMITTED_DISTRICT`, `PENDING_QUALITY`, or `PENDING_STATE` for more than `SLA_HOURS` (default `48h`) trigger an `EscalationAlert` visible to the State Office (and broadcast via SSE).
5. **Public Verification Privacy**: Anyone can verify a certificate number at `/api/public/verify/:certificateNumber` without logging in, but **only** validity status, certificate number, candidate name, course, centre, district, and issue/cancellation metadata are returned. Candidate phone numbers, emails, ID digits, and PDF download links are **never** exposed publicly.
6. **Certificate Download Access Control**: Certificate PDFs require either the candidate's secret `downloadToken` (delivered via their WhatsApp message) or an authenticated staff session authorized for that district/centre.

7. **Candidate identity inside a batch = phone number.** The "last 4 digits of the ID" are *not* unique per person (with 60 candidates there is a ~16% chance two share them), so uniqueness is enforced on `(batchId, phone)` only. Duplicate phones in a sheet are rejected with the row number.
8. **Who can see what.** Centres see only their own batches; district officers only their district; the quality team only batches flagged for quality review; the state office everything. A user's role always comes from the database, never from claims inside the token, so a tampered token cannot grant a higher role.
9. **Lost work is recovered, not assumed away.** Approving a batch commits to Postgres and then queues a job (two separate writes). A *reconciler* in the worker re-queues batches stuck in `APPROVED`/`ISSUING` and messages that never reached `DELIVERED`. Every step it re-runs is idempotent.
10. **Cancellation beats the cache.** Cancelling a certificate writes a Redis tombstone that makes the public verify endpoint ignore cached answers, so a verification racing the cancel can never leave "valid" in the cache.
11. **Demo-only surface is switchable.** `DEMO_MODE=true` (default locally) enables the persona switcher and the stand-in WhatsApp inbox. With `DEMO_MODE=false` they return 404. The event stream always requires a login.

---

## 2. System Architecture & Why Each Piece Exists

```
+-------------------+        HTTP + SSE        +-------------------------+
|  React + Vite UI  | <----------------------> |  Express + TypeScript   |
|  (Nginx / Port    |                          |  API Server (Port 4000) |
|   5173)           |                          +-----------+-------------+
+-------------------+                                      |
                                         +-----------------+-----------------+
                                         |                                   |
                                         v                                   v
                            +------------+------------+         +------------+------------+
                            |   PostgreSQL 16 (5432)  |         |     Redis 7 (6379)      |
                            |  Prisma ORM + Migrations|         | 1. Verify Cache (120s)  |
                            |  Row Locks + Sequence   |         | 2. BullMQ Job Queues    |
                            +-------------------------+         | 3. Pub/Sub -> SSE       |
                                                                +------------+------------+
                                                                             |
                                                                             v
                                                                +------------+------------+
                                                                |  BullMQ Worker Process  |
                                                                |  - PDFKit + QR Gen      |
                                                                |  - WhatsApp Retries     |
                                                                |  - SLA Cron Monitor     |
                                                                +-------------------------+
```

- **PostgreSQL + Prisma**: Enforces relational integrity, unique constraints (`(batchId, phone)`, `(batchId, officerId, stage, round)`, `(batchId, candidateId)`), `certificate_seq` sequence for collision-free certificate numbers, and `SELECT ... FOR UPDATE` row locking for concurrency safety.
- **Redis**: Serves three distinct roles:
  1. **Public verification cache** (`cert:verify:<NUMBER>`, 120s TTL) with immediate `DEL` on certificate cancellation.
  2. **BullMQ backing store** for durable background jobs (`batch-issuance`, `whatsapp-delivery`, `sla-monitor`).
  3. **Redis Pub/Sub** (`certiflow:events`) fanning out real-time updates to SSE clients across any number of API instances.
- **BullMQ + Separate `worker` Container**: Decouples slow PDF generation and unreliable WhatsApp HTTP calls from the API request cycle. `jobId` deduplication + WhatsApp `idempotencyKey` (`wa-<certificateId>`) together with the reconciler give every candidate **exactly one** certificate message even across worker crashes and lost acknowledgements.
- **Stand-in WhatsApp Provider**: Simulates 25% outright failures (`WHATSAPP_FAILURE_RATE`) and 10% *ambiguous* timeouts (`WHATSAPP_AMBIGUOUS_RATE`): the message **was** delivered but the acknowledgement was lost. That second case is what makes exactly-once hard; the idempotency key stops the retry from sending again.
- **Reconciler**: runs on the 60-second worker tick alongside the SLA check (`src/services/reconcile.ts`).

---

## 3. Demo Personas (Seeded Automatically)

| Name | Role | District / Scope |
| :--- | :--- | :--- |
| **Anika Sharma** | Training Centre (`TRAINING_CENTRE`) | Pune — Pragati Tech Academy |
| **Dev Kulkarni** | District Officer (`DISTRICT_OFFICER`) | Pune |
| **Meera Deshmukh** | District Officer (`DISTRICT_OFFICER`) | Pune |
| **Kabir Joshi** | District Officer (`DISTRICT_OFFICER`) | Pune |
| **Neha Verma** | Quality Team (`QUALITY_TEAM`) | Statewide (batches >= 50) |
| **Farah Siddiqui** | State Office (`STATE_OFFICE`) | Statewide (Final approval, SLA, Cancel) |

---

## 4. Tests: what they prove

`npm run test:unit` needs nothing running; `npm test` also runs the end-to-end suite against real Postgres + Redis (see `SETUP.md`). The E2E suite replaces only the BullMQ *queue module* with spies, so a running worker cannot interfere and we can assert the API hands work to the queue; the issuance, WhatsApp, reconciler and database code all run for real.

| Brief | Test |
| :--- | :--- |
| Moment 1: bad rows, nothing half-saved | Row-level errors returned; an earlier good upload is not wiped or partially replaced |
| Moment 2: simultaneous approvals | 3 officers approve at once: exactly 2 count, the batch advances once (checked in the audit log), the 3rd is refused; the same officer cannot vote twice |
| Moment 3: 60 candidates, flaky WhatsApp | 40% failures + 20% lost acks: 60 certificates, 60 distinct numbers, 60 messages `DELIVERED`, and the provider delivered exactly 60 times |
| Moment 4: cancel then verify | Invalid immediately, even when a stale "valid" is written back into the cache; no download, no re-send |
| Moment 5: stuck batch | One open escalation alert (idempotent), visible to the state office only |
| Moment 6: send back and resubmit | Round 2, prior approvals voided, fresh quorum needed |
| Never: wrong step / someone else | Wrong role, other district, forged token, token that *claims* a higher role |
| Never: duplicate certificate | Issuing twice yields 60 certificates; the database rejects a second certificate for a candidate |
| Never: stranger sees someone's data | No download without the token, no PII in verification, other centres blocked, demo endpoints off in production mode, event stream needs a login |
| Never: untraceable decision | Officer, role, stage, round and timestamp in both the decisions table and the audit log |
| Failure handling | Reconciler re-queues stuck batches and undelivered messages; verify is rate limited |

**Not tested:** the React UI (no automated UI tests), and load/performance (the numbers in `DEPLOYMENT.md` are planning assumptions).

---

## 5. AI Usage & How the Output Was Checked

AI tools scaffolded the first version (routes, Prisma schema, React components, documents). It was then reviewed line by line against the brief, and the review found real defects in the generated code, which were fixed:

- The seed data contained certificate `PSM-2026-PUNE-10001` while the number sequence started at 10001, so the first real Pune certificate would have collided and issuance would have failed.
- The CSV rule "last 4 ID digits must be unique" rejects valid batches (birthday-paradox collisions).
- The worker's retry logic never actually retried (errors were swallowed); the WhatsApp job stopped after ~15 s of retries with no recovery; approval and enqueue were two unprotected writes.
- The live-event stream and the WhatsApp inbox (which contains download links) were readable without logging in.
- A verification racing a cancellation could re-cache "valid".
- The original E2E tests were skipped by default and did not cover Moment 3.
- `npm run build` failed (a source file imported from outside `rootDir`), and the Dockerfiles used `npm ci` without lock files.

---

## 6. Known Limitations & Next Steps

1. **Local PDF storage** on a shared Docker volume; production uses S3 with short-lived signed URLs (`DEPLOYMENT.md`).
2. **Demo auth**: the persona switcher issues tokens without a password. It is for evaluation only and is disabled by `DEMO_MODE=false`; production needs OIDC/SSO or OTP.
3. **Dual write**: reconciler-based recovery (up to ~2 minutes of delay) instead of a transactional outbox.
4. **Certificate numbers are sequential**, so verification can be enumerated; mitigated by a per-IP rate limit, not eliminated.
5. **One candidate in two batches** (same phone, same course) can receive two certificates; there is no cross-batch duplicate check.
6. **WhatsApp backoff is short** (about 15 s per delivery job); long outages rely on the reconciler, capped at 20 attempts per message.
7. **SSE broadcasts every event to every logged-in user**; the UI refetches role-scoped lists, but the event payload itself is not filtered per role.
8. **Spreadsheets are parsed in memory** (5 MB limit).
9. No automated UI tests.
