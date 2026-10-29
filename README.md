# Invoice Chaser

**Autonomous, AI-personalized invoice recovery and dunning engine for B2B SaaS.**

Invoice Chaser connects to Stripe accounts via OAuth, listens to real-time invoice lifecycle webhooks, and orchestrates multi-stage overdue payment reminders (`STAGE_1` at Day 3, `STAGE_2` at Day 7, `STAGE_3` at Day 14, or custom per-account schedules). Instead of sending robotic templates, it learns each founder's writing voice from sample emails using Claude and generates context-aware, hallucination-checked follow-ups—backed by strict idempotency, distributed rate limiting, multi-tenant JWT authentication, and dead-letter queue recovery.

---

## System Architecture

```mermaid
flowchart TB
    subgraph External["External Providers & Clients"]
        Stripe["Stripe API & Webhooks"]
        Claude["Anthropic Claude API"]
        Resend["Resend Email & Svix Webhooks"]
        Founder["Founder / Dashboard Client"]
        K6["k6 Load Generator"]
    end

    subgraph Security["Security & Edge Layer"]
        Throttle["Rate Limiter (@nestjs/throttler)"]
        AuthGuard["JWT AuthGuard & @CurrentUser()"]
        MetricsGuard["MetricsGuard (Internal / Bearer Token)"]
        ValPipe["Global ValidationPipe (Whitelist)"]
    end

    subgraph API["NestJS Ingestion & Control Plane"]
        AuthCtrl["AuthController (/auth/magic-link, /auth/verify)"]
        StripeCtrl["StripeController (/webhooks/stripe)"]
        MailCtrl["MailController (/webhooks/resend, /webhooks/inbound-email, /unsubscribe)"]
        RemCtrl["RemindersController (Approval Queue, Draft Edit, Pause/Resume)"]
        ToneCtrl["ToneController & SettingsController"]
        DashCtrl["DashboardController (/dashboard/overview, /dashboard/funnel)"]
        ObsCtrl["ObservabilityController & HealthController (/metrics, /health)"]
    end

    subgraph Storage["Persistence & Queue Layer"]
        PG[("PostgreSQL 16 (Prisma 7 + @prisma/adapter-pg)")]
        Redis[("Redis 7 (BullMQ + Rate Limits + Locks)")]
        MainQ[["BullMQ: reminders queue"]]
        DLQ[["BullMQ: reminders-dlq"]]
    end

    subgraph Worker["BullMQ Worker Pipeline (RemindersProcessor)"]
        Gate1["1. Suppression & Unsubscribe Check"]
        Gate2["2. Live Stripe Invoice Status Check"]
        Gate3["3. Timezone Business-Hours Send Window"]
        Gate4["4. AI Draft Generation & Hallucination Validator"]
        Gate5["5. Approval Mode & Daily Send Cap Gate"]
        Dispatch["6. Resend Email Dispatch & Audit Log"]
    end

    Founder -->|"Magic Link Login & Bearer JWT"| Throttle
    Throttle --> AuthGuard
    AuthGuard --> ValPipe
    ValPipe --> AuthCtrl
    ValPipe --> RemCtrl
    ValPipe --> ToneCtrl
    ValPipe --> DashCtrl

    Stripe -->|"Signed Webhook (stripe-signature)"| StripeCtrl
    K6 -->|"Burst Webhooks (10k scale)"| StripeCtrl
    Resend -->|"Delivery & Inbound Reply Webhooks (Svix)"| MailCtrl

    StripeCtrl -->|"Idempotent Upsert (WebhookEvent)"| PG
    StripeCtrl -->|"Schedule Delayed Jobs"| MainQ
    MainQ --- Redis
    DLQ --- Redis

    MainQ -->|"Concurrency: 10"| Gate1
    Gate1 --> Gate2
    Gate2 -->|"Live Fetch / Synthetic Mock"| Stripe
    Gate2 --> Gate3
    Gate3 --> Gate4
    Gate4 -->|"Tone Profile + Prompt"| Claude
    Gate4 --> Gate5
    Gate5 --> Dispatch
    Dispatch -->|"Send Email + Unsubscribe Headers"| Resend
    Dispatch -->|"Write ReminderAudit"| PG
    Dispatch -.->|"Exhausted Retries"| DLQ

    MailCtrl -->|"Bounce / Complaint / Reply Auto-Pause"| PG
    ObsCtrl --- MetricsGuard
    ObsCtrl -->|"Prometheus & DLQ Replay"| PG
    ObsCtrl -->|"Queue Depth & Health"| Redis
```

---

## Core Features

### 1. Security & Multi-Tenancy
* **Zero-Trust Tenant Isolation**: Every protected controller derives `accountId` exclusively from the verified JWT payload (`@CurrentUser()`) enforced by a global `AuthGuard`. No endpoint trusts `accountId` from query parameters or request bodies.
* **Magic-Link JWT Authentication**: Passwordless authentication flow via `POST /auth/magic-link` and `POST /auth/verify` issuing signed Bearer tokens.
* **Protected Operational Endpoints**: `/metrics` and `/observability/*` are guarded by `MetricsGuard` (requiring `METRICS_TOKEN` or internal loopback access) so Prometheus metrics and DLQ replay triggers are never publicly exposed.
* **Edge Rate Limiting & Strict DTO Validation**: Global `@nestjs/throttler` protection on public auth and unsubscribe routes, paired with a global `ValidationPipe` (`whitelist: true`, `forbidNonWhitelisted: true`, `transform: true`).
* **AES-256-GCM Credential Encryption**: Connected Stripe OAuth tokens are encrypted at rest in PostgreSQL with an authenticated IV and auth tag, accompanied by a production key rotation runbook ([`docs/KEY_ROTATION.md`](docs/KEY_ROTATION.md)).

### 2. AI Voice Cloning & Hallucination Guardrails
* **Tone Profile Extraction**: Analyzes 3 to 5 sample emails from a founder via Claude to extract structured voice traits (formality, warmth, directness, sign-off style, and signature phrases).
* **Stage-Aware Generation**: Dynamically shifts tone from a friendly check-in (`STAGE_1`), to a direct reminder (`STAGE_2`), to a firm final notice (`STAGE_3`).
* **Strict Output Validation**: `ReminderOutputValidator` verifies that the AI output contains the exact formatted invoice amount, valid JSON structure, and zero fabricated URLs or payment links. If validation fails after retry, the worker automatically falls back to a deterministic template so reminders never stall.

### 3. Approval Queue, Pause Controls & Reply Detection
* **Human-in-the-Loop Approval Mode**: Accounts with `requireApproval: true` hold generated drafts in `PENDING_APPROVAL` status. Founders can list pending drafts, edit subject/body (`PUT /reminders/:id/draft`), approve for immediate dispatch (`POST /reminders/:id/approve`), reject (`POST /reminders/:id/reject`), or skip individual stages (`POST /reminders/:id/skip`).
* **Configurable Escalation Stages & Send Windows**: Supports custom stage day offsets per account (`settings.stageDays`) and timezone-aware business-hours delivery windows (`sendWindowStart` to `sendWindowEnd` in the account's IANA timezone). Jobs triggered outside business hours are automatically delayed to the next valid window.
* **Granular Pause / Resume & Inbound Reply Auto-Pause**: Pause or resume reminders per individual invoice (`POST /reminders/invoices/:invoiceId/pause`) or across an entire customer email (`POST /reminders/customers/:email/pause`). Inbound customer replies received at `POST /webhooks/inbound-email` automatically pause all remaining scheduled reminders for that invoice.

### 4. High-Throughput Ingestion & Six-Gate Worker Pipeline
* **Fast Webhook Ingestion**: Raw-body signature verification, database-backed `WebhookEvent` idempotency, and asynchronous BullMQ scheduling designed for burst invoice storms.
* **Pre-Send Verification Gates**:
  1. **Suppression Check**: Drops reminders if the customer is suppressed (`UNSUBSCRIBED`, `BOUNCED`, `COMPLAINED`, or `MANUAL`).
  2. **Live Stripe Status Check**: Queries Stripe immediately before sending to confirm the invoice is still unpaid; if paid, marks the invoice `PAID` and cancels downstream stages.
  3. **Business-Hours Send Window**: Re-queues the job if the current time falls outside the account's configured local send window.
  4. **AI Generation + Validation**: Generates and validates the personalized email draft.
  5. **Approval & Daily Cap Gate**: Enforces per-account daily send limits (`dailySendCap`) in Redis and respects `requireApproval`.
  6. **Transactional Dispatch & Audit**: Sends via Resend with `List-Unsubscribe` headers (RFC 8058) and writes an immutable `ReminderAudit` record.

### 5. Observability, Health Checks & Dead-Letter Queue (DLQ)
* **Prometheus Metrics (`/metrics`)**: Tracks `reminders_sent_total`, `reminders_failed_total`, `ai_fallback_used_total`, `webhook_processing_duration_seconds`, and live BullMQ queue depth gauges (`queue_waiting_jobs`, `queue_active_jobs`, `queue_dlq_jobs`).
* **Readiness Probe (`/health`)**: Powered by `@nestjs/terminus` and `PrismaHealthIndicator` for container orchestration and zero-downtime deployments.
* **DLQ Inspection & Replay**: Exhausted jobs route to `reminders-dlq` with full failure context and can be inspected (`GET /observability/dlq`) or replayed (`POST /observability/dlq/:jobId/replay`).
* **Revenue Recovery Funnel**: `/dashboard/overview` and `/dashboard/funnel` track open vs. paid invoices, conversion attribution from sent reminders, and engagement rates (sent, delivered, opened, bounced).

---

## Project Structure

```text
invoice-chaser2/
├── .github/workflows/
│   └── ci.yml                       # GitHub Actions CI (Postgres 16, Redis 7, Prisma, TSC, Lint, Jest)
├── docs/
│   ├── ALERTING_AND_DASHBOARDS.md   # Prometheus alert rules & Grafana dashboard guide
│   ├── DATABASE_BACKUP_AND_RESTORE.md # PostgreSQL backup, WAL PITR & disaster recovery runbook
│   └── KEY_ROTATION.md              # AES-256-GCM encryption key rotation runbook
├── prisma/
│   ├── schema.prisma                # Multi-tenant schema (Account, Invoice, Reminder, ReminderAudit, etc.)
│   └── migrations/                  # SQL migrations
├── src/
│   ├── ai/                          # Claude integration, prompt builder & output hallucination validator
│   ├── auth/                        # Magic-link JWT auth, AuthGuard, MetricsGuard & @CurrentUser()
│   ├── common/                      # AES-256-GCM encryption utility & global exception filters
│   ├── config/                      # Fail-fast environment variable validation
│   ├── dashboard/                   # Revenue recovery metrics & delivery funnel endpoints
│   ├── health/                      # @nestjs/terminus database readiness probe (/health)
│   ├── mail/                        # Resend email dispatcher, Svix webhook handler & inbound reply auto-pause
│   ├── observability/               # Prometheus metrics, immutable audit logger, alerts & DLQ replay
│   ├── prisma/                      # Prisma 7 service with @prisma/adapter-pg connection pool
│   ├── reminders/                   # BullMQ scheduler, 6-gate worker processor & approval/pause API
│   ├── settings/                    # Per-account send windows, stage offsets, approval & cap configuration
│   ├── stripe/                      # Stripe OAuth, webhook signature verification & live invoice fetcher
│   └── tone/                        # Founder writing sample analysis & tone profile management
├── test/
│   └── load/                        # k6 10k-invoice storm script (k6-storm.js) & invariant verifier
├── Dockerfile                       # Multi-stage Node 22 Alpine production container with HEALTHCHECK
├── docker-compose.yml               # Local Postgres 16, Redis 7 & API stack
├── prisma7.config.ts                # Prisma 7 configuration file
└── .env.example                     # Complete environment variable template
```

---

## Tech Stack

| Layer | Technology |
| :--- | :--- |
| **Framework** | NestJS 11 (TypeScript 5.9, Node.js 22) |
| **Database & ORM** | PostgreSQL 16 + Prisma ORM 7 (`@prisma/client` + `@prisma/adapter-pg`) |
| **Queue & Distributed State** | Redis 7 + BullMQ (`@nestjs/bullmq`, `ioredis`) |
| **AI Engine** | Anthropic Claude (`@anthropic-ai/sdk`, default `claude-3-5-sonnet-latest`) |
| **Payments & Webhooks** | Stripe SDK (`stripe` v22) + OAuth 2.0 + Webhook Signing |
| **Email & Delivery Tracking** | Resend (`resend`) + Svix Webhook Verification (`svix`) |
| **Security & Auth** | `@nestjs/jwt`, `@nestjs/throttler`, AES-256-GCM (`crypto`) |
| **Observability & Health** | `prom-client` (Prometheus) + `@nestjs/terminus` (`/health`) |
| **Testing & Load Verification** | Jest 30, Supertest, Oxlint, k6 (`test/load/k6-storm.js`) |

---

## Quick Start

### Prerequisites
* **Node.js** 22+ and **pnpm** 10+
* **PostgreSQL** 16+ and **Redis** 7+ (via Docker Compose or local services such as DBngin)

### 1. Clone and Install Dependencies
```bash
git clone <repository-url>
cd invoice-chaser2
pnpm install
```

### 2. Configure Environment Variables
Copy the example environment file and adjust values as needed:
```bash
cp .env.example .env
```

The default `.env.example` is pre-configured with safe mock credentials (`sk_test_mock`, `re_mock`, `sk-ant-mock`) so you can boot and test the full pipeline locally without paid third-party API keys:

| Variable | Description |
| :--- | :--- |
| `DATABASE_URL` | PostgreSQL connection string (`postgresql://postgres:postgres@localhost:5432/invoice_chaser?schema=public`) |
| `REDIS_URL` | Redis connection string (`redis://localhost:6379`) |
| `JWT_SECRET` | Secret key for signing JWT access and magic-link tokens |
| `ENCRYPTION_KEY` | 64-character hex string (32 bytes) for AES-256-GCM token encryption |
| `STRIPE_SECRET_KEY` | Stripe secret key (use `sk_test_mock` for local mock mode) |
| `STRIPE_WEBHOOK_SECRET` | Stripe webhook signing secret (`whsec_...`) |
| `RESEND_API_KEY` | Resend API key (use `re_mock` for local mock mode) |
| `RESEND_WEBHOOK_SECRET` | Svix signing secret for Resend delivery/inbound webhooks |
| `ANTHROPIC_API_KEY` | Anthropic API key (use `sk-ant-mock` for deterministic local mock mode) |
| `ANTHROPIC_MODEL` | Claude model identifier (defaults to `claude-3-5-sonnet-latest`) |
| `METRICS_TOKEN` | Bearer token required to access `/metrics` and `/observability/*` from external networks |
| `ALERT_WEBHOOK_URL` | Optional Slack/PagerDuty webhook URL for critical DLQ and bounce alerts |

### 3. Generate Prisma Client & Run Migrations
```bash
pnpm prisma generate
pnpm prisma migrate dev
```

### 4. Start the Application
```bash
# Development mode with hot reload
pnpm start:dev

# Production build and start
pnpm build
pnpm start:prod
```

Or run the entire stack (PostgreSQL 16, Redis 7, and API container) with Docker Compose:
```bash
docker compose up --build
```

---

## API & Operational Endpoints

All tenant-scoped endpoints require an `Authorization: Bearer <jwt>` header obtained from `/auth/verify` and automatically scope queries to the authenticated account.

### Authentication & Health (`@Public()`)
| Method | Endpoint | Description |
| :--- | :--- | :--- |
| `POST` | `/auth/magic-link` | Request a passwordless login token for an email address |
| `POST` | `/auth/verify` | Exchange a magic-link token for a session Bearer JWT |
| `GET` | `/health` | Database readiness probe (`@nestjs/terminus`) |

### Stripe & Email Webhooks (`@Public()`, Signature Verified)
| Method | Endpoint | Description |
| :--- | :--- | :--- |
| `GET` | `/stripe/connect` | Initiate Stripe OAuth connection (requires Bearer JWT) |
| `GET` | `/stripe/oauth/callback` | Complete Stripe OAuth flow and store AES-256-GCM encrypted credentials |
| `POST` | `/webhooks/stripe` | Ingest signed Stripe invoice events (`invoice.payment_failed`, `invoice.paid`, etc.) |
| `POST` | `/webhooks/resend` | Ingest Svix-signed Resend delivery events (`delivered`, `opened`, `bounced`, `complained`) |
| `POST` | `/webhooks/inbound-email` | Ingest inbound customer email replies and auto-pause active invoice reminders |
| `GET/POST` | `/unsubscribe` | One-click RFC 8058 customer unsubscribe endpoint with HMAC token validation |

### Reminders, Approval Queue & Pause Controls (Bearer JWT Required)
| Method | Endpoint | Description |
| :--- | :--- | :--- |
| `GET` | `/reminders` | List reminders for the authenticated account (filterable by `status`) |
| `GET` | `/reminders/pending` | List drafts waiting in `PENDING_APPROVAL` |
| `PUT` | `/reminders/:id/draft` | Edit the subject or body of a pending reminder draft |
| `POST` | `/reminders/:id/approve` | Approve a draft and enqueue it for immediate delivery |
| `POST` | `/reminders/:id/reject` | Reject and cancel a pending draft |
| `POST` | `/reminders/:id/skip` | Skip a scheduled reminder stage |
| `POST` | `/reminders/invoices/:invoiceId/pause` | Pause or resume all reminders for a specific invoice |
| `POST` | `/reminders/customers/:email/pause` | Suppress or unsuppress reminders for a customer email address |

### Tone Profile, Settings & Analytics (Bearer JWT Required)
| Method | Endpoint | Description |
| :--- | :--- | :--- |
| `POST` | `/tone/analyze` | Analyze 3–5 founder sample emails with Claude and save tone profile |
| `GET` | `/tone` | Retrieve current tone profile for the account |
| `GET` | `/settings` | Retrieve account escalation stages, send window, timezone, and daily cap |
| `PUT` | `/settings` | Update account reminder settings |
| `GET` | `/dashboard/overview` | High-level KPIs (open vs. recovered revenue, active sequences, suppression counts) |
| `GET` | `/dashboard/funnel` | Stage-by-stage email delivery and conversion funnel |

### Observability & DLQ Management (`MetricsGuard` Protected)
| Method | Endpoint | Description |
| :--- | :--- | :--- |
| `GET` | `/metrics` | Prometheus metrics exposition (`text/plain; version=0.0.4`) |
| `GET` | `/observability/dlq` | Inspect failed jobs sitting in the Dead-Letter Queue (`reminders-dlq`) |
| `POST` | `/observability/dlq/:jobId/replay` | Replay a dead-lettered job back into the main `reminders` queue |
| `GET` | `/observability/audit` | Query immutable `ReminderAudit` logs (requires Bearer JWT) |

---

## Testing & Verification

### Unit Tests, Type Check & Linting
The test suite covers Stripe OAuth/webhook verification, Mail unsubscribe/Svix/suppression cascades, the 6-gate `RemindersProcessor` worker, `AiService` retry/fallback resilience, and `ReminderOutputValidator` hallucination checks:

```bash
# Run TypeScript compiler verification
pnpm exec tsc --noEmit

# Run Oxlint static analysis
pnpm lint

# Run Jest unit test suites
pnpm test
```

### Load Testing & Invariant Verification (k6)
The repository includes a synthetic load generator ([`test/load/k6-storm.js`](test/load/k6-storm.js)) and an automated invariant checker ([`test/load/verify-invariants.ts`](test/load/verify-invariants.ts)) designed to simulate a 10,000-invoice burst (including duplicate deliveries, pre-paid invoices, and suppressed recipients) in mock mode:

```bash
# 1. Start the server in mock mode (STRIPE_SECRET_KEY=sk_test_mock, RESEND_API_KEY=re_mock, ANTHROPIC_API_KEY=sk-ant-mock)
pnpm start:dev

# 2. Run the k6 webhook storm
k6 run test/load/k6-storm.js

# 3. Verify zero duplicate sends, zero paid-invoice sends, and 100% audit trail coverage
npx ts-node test/load/verify-invariants.ts
```

---

## Operational Runbooks

* **Encryption Key Rotation**: [`docs/KEY_ROTATION.md`](docs/KEY_ROTATION.md) — Step-by-step guide for rotating `ENCRYPTION_KEY` without downtime.
* **Database Backups & PITR Restore**: [`docs/DATABASE_BACKUP_AND_RESTORE.md`](docs/DATABASE_BACKUP_AND_RESTORE.md) — Daily `pg_dump` automation, WAL Point-in-Time Recovery, and quarterly restore drills.
* **Alerting & Grafana Dashboards**: [`docs/ALERTING_AND_DASHBOARDS.md`](docs/ALERTING_AND_DASHBOARDS.md) — Prometheus alert rules and Grafana panel queries for queue depth, DLQ spikes, and AI fallbacks.
