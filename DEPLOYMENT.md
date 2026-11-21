# Production Deployment Plan (`DEPLOYMENT.md`)

Target Load:
- **100,000 registered users**, **~10,000 daily active users (DAU)**
- **Peak (Results Day)**: **~500 batches/hour** (~30,000 PDFs generated + 30,000 WhatsApp messages delivered in 1 hour, i.e., ~8.3 certs/sec sustained, ~25/sec burst)
- **Public Verification**: Thousands of lookups/day arriving in bursts

---

## 1. Production Architecture Diagram

```
                     +-------------------------+
                     |   Cloudflare / AWS WAF  |
                     |   + CDN Rate Limiting   |
                     +------------+------------+
                                  |
             +--------------------+--------------------+
             |                                         |
             v                                         v
+------------+------------+               +------------+------------+
|  S3 + CloudFront (SPA)  |               |  Application Load       |
|  React + Vite Static    |               |  Balancer (HTTPS/SSE)   |
+-------------------------+               +------------+------------+
                                                       |
                                          +------------+------------+
                                          |  ECS Fargate / K8s Pods |
                                          |  Express API (Auto-Scale|
                                          |  2 -> 10 instances)     |
                                          +--+---------+---------+--+
                                             |         |         |
                  +--------------------------+         |         +-------------------------+
                  v                                    v                                   v
     +------------+------------+          +------------+------------+         +------------+------------+
     |  Amazon RDS PostgreSQL  |          |  ElastiCache Redis      |         |  Amazon S3 (Private)    |
     |  Multi-AZ + Read Replica|          |  Cluster (Cache, BullMQ,|         |  Certificate PDFs       |
     +-------------------------+          |  Pub/Sub for SSE)       |         |  (SSE-S3 Encrypted)     |
                                          +------------+------------+         +-------------------------+
                                                       |
                                                       v
                                          +------------+------------+
                                          |  BullMQ Worker Pool     |
                                          |  (ECS Fargate: 2 -> 20) |
                                          +------------+------------+
                                                       |
                                                       v
                                          +------------+------------+
                                          |  WhatsApp Business API  |
                                          |  (Meta Cloud / BSP)     |
                                          +-------------------------+
```

---

## 2. Hosting Choices & Rationale

| Component | Hosting | Rationale |
| :--- | :--- | :--- |
| **Frontend (React + Vite)** | S3 + CloudFront | Zero server cost, global edge caching, handles verification traffic bursts effortlessly. |
| **API Servers (Express + TS)** | AWS ECS Fargate (behind ALB) | Stateless containers; ALB supports long-lived SSE connections (`idle_timeout = 3600s`). |
| **BullMQ Workers** | AWS ECS Fargate (separate service) | Isolates CPU-heavy PDFKit rendering and I/O-heavy WhatsApp calls from user-facing API latency. |
| **PostgreSQL** | Amazon RDS (Multi-AZ + 1 Read Replica) | Managed automated backups, Multi-AZ failover, and read replica offloads reporting/audit queries. |
| **Redis** | Amazon ElastiCache (Redis 7, Multi-AZ) | Sub-millisecond public verification caching, BullMQ job persistence (`appendonly yes`), and SSE Pub/Sub. |
| **Certificate PDFs** | Amazon S3 (Private Bucket) | Durable (11 9s), scales infinitely, decoupled from container ephemeral storage. |

---

## 3. Scaling Strategy & Peak Bottleneck Analysis

- **Peak Math (30,000 PDFs + 30,000 WhatsApp messages in 1 hour)** — *figures below are planning assumptions to be confirmed by a load test, not measurements*:
  - **PDF Generation**: 1 worker vCPU renders ~15–20 PDFKit certificates/sec. **4 worker tasks** (concurrency 10 each) clear 30,000 PDFs in **~6–8 minutes**.
  - **WhatsApp Delivery**: Meta Cloud API / BSP rate limits typically allow **80–250 messages/sec** per business number. At 80 msg/sec, 30,000 messages complete in **~6.25 minutes** (even with 25% retries, under 10 minutes).
  - **What Limits Throughput at Peak**:
    1. **External WhatsApp API Rate Limits (429s)**: Mitigation (planned, not yet in the code): BullMQ's built-in worker rate limiter (`limiter: { max: 80, duration: 1000 }`) plus exponential backoff.
    2. **PostgreSQL Connection Pool**: Mitigated using **PgBouncer** (or RDS Proxy) in transaction pooling mode so 20+ worker/API containers don't exhaust `max_connections`.
- **Public Verification Bursts**: Redis caches `cert:verify:<NUMBER>` for 120s. A 95%+ cache hit rate means 10,000 burst lookups hit Redis (~1ms) rather than PostgreSQL.

---

## 4. Failure Handling

- **Worker Crash Mid-Batch**: BullMQ marks stalled jobs after `lockDuration` (30s) and re-queues them. Because `Certificate` creation uses `(batchId, candidateId)` unique constraints and `WhatsAppMessage` uses `idempotencyKey`, restarting or replacing a crashed worker **never** creates duplicate certificates or double-sends WhatsApp messages.
- **Redis Restart**: ElastiCache runs with Multi-AZ + AOF persistence and `maxmemory-policy noeviction` (BullMQ needs this; an evicting policy can silently drop jobs). While Redis is unreachable, public verification falls back to PostgreSQL and the rate limiter fails open; officer decisions still commit (the issuance job is re-queued by the reconciler afterwards). SSE clients reconnect automatically (`EventSource` retry). Jobs persisted by AOF survive; any lost in the last second are recovered by the reconciler.
- **WhatsApp Outage**: Approvals and PDF generation are unaffected (they never wait on WhatsApp). In the current code each delivery job retries 6 times with a 500 ms exponential backoff (about 15 seconds in total), which only covers blips. For an outage lasting minutes or hours, the **reconciler** (runs every 60 s in the worker) re-queues every undelivered message that has been idle for 2 minutes, up to 20 total attempts per message; messages beyond that stay `FAILED` and visible to the state office. In production the queue backoff should be raised to minutes, and a circuit breaker should pause the queue while the provider is down so retries do not burn the attempt budget.
- **Crash between "approved" and "queued"**: The approval commits to Postgres and the job is then added to Redis; these are two writes. If the API dies in between (or Redis is down at that instant) the batch would sit in `APPROVED` forever. The reconciler finds batches in `APPROVED`/`ISSUING` that have not moved for 2 minutes and re-queues them; issuance is idempotent, so a duplicate run is harmless. (Next step: a transactional outbox table.)
- **Cache/cancel race**: Cancelling a certificate writes a short-lived Redis tombstone that makes the verify endpoint ignore any cached answer, so a slow reader cannot re-cache "valid" after a cancel.
- **Slow Database**: Public verification is protected by the Redis cache and a per-IP rate limit, so a slow database does not turn a verification burst into an outage. Planned: route read-heavy endpoints (`/api/batches`, audit views) to the RDS read replica (not implemented in this prototype). `SELECT ... FOR UPDATE` only locks a single batch row for the duration of one short transaction; add a statement timeout so a stuck query cannot hold the lock. Use RDS Proxy/PgBouncer so many workers do not exhaust connections.

---

## 5. Certificate File Storage & Access Control

- PDFs are uploaded to a **private S3 bucket** (`SSE-S3` encrypted, public access blocked).
- Download endpoint (`GET /api/certificates/:id/download`) validates either the candidate's cryptographic `downloadToken` (sent via WhatsApp) or a staff JWT, then streams or redirects to a **60-second S3 pre-signed URL**.
- Cancelled certificates return `410 Gone` immediately and never issue pre-signed URLs.

---

## 6. Monitoring & Alerting

- **Metrics**: Prometheus/CloudWatch metrics for BullMQ queue depth (`waiting`, `failed`), WhatsApp delivery latency & error rate, PostgreSQL connection count, and API p95 latency.
- **Alerts**:
  - BullMQ `whatsapp-delivery` failed count > 50 -> PagerDuty/Slack alert.
  - API 5xx rate > 1% or RDS CPU > 80% for 5 mins -> Auto-scale + alert.
  - SLA Escalation alerts -> Real-time SSE push to State Office dashboard.

---

## 7. Rough Monthly Cost Estimate (AWS ap-south-1 Mumbai)

| Resource | Spec | Est. Monthly Cost (USD) |
| :--- | :--- | :--- |
| ECS Fargate (API + Workers) | 2 API (0.5 vCPU/1GB) + 2 Workers (auto-scale on peak) | ~$55 |
| RDS PostgreSQL | `db.t4g.medium` Multi-AZ (100GB gp3) | ~$110 |
| ElastiCache Redis | `cache.t4g.small` Multi-AZ | ~$45 |
| S3 + CloudFront + ALB | 50GB PDFs + static SPA + ALB | ~$35 |
| CloudWatch / Logs | Basic metrics & 14-day log retention | ~$15 |
| **Total** | | **~$260 / month** |

**Trade-offs**: Using `db.t4g.medium` Single-AZ cuts DB cost to ~$55/mo (~$205 total) at the expense of ~2-minute failover downtime during hardware maintenance. Using managed ECS Fargate avoids Kubernetes cluster management overhead (`$73/mo` EKS control plane saved) for a lean team.


---

## 8. Production hardening checklist (differences from the demo build)

- `DEMO_MODE=false`. This removes the passwordless persona switcher and the stand-in WhatsApp inbox (which exposes download links). Real login (OIDC/SSO or OTP) replaces it.
- Strong random `JWT_SECRET` from a secrets manager; never the compose default.
- Replace `prisma db push`-style startup/`AUTO_SEED`: run `prisma migrate deploy` as a one-off release task and never auto-seed.
- Put the API behind the ALB with `trust proxy` hops matching the real proxy chain (the per-IP verify rate limit depends on the correct client IP); keep a WAF rate limit in front as the primary control.
- Certificate numbers are sequential, so verification can be enumerated; the rate limit slows this down. Adding a random check suffix to the number is the next step.
- Replace the shared Docker volume with S3 (section 5) so any worker or API instance can read any PDF.
