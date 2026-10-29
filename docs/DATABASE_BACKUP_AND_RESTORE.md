# Database Backup & Disaster Recovery Runbook

This runbook outlines automated backup schedules, manual snapshot generation, point-in-time recovery, and restore verification for Invoice Chaser's PostgreSQL database.

---

## 1. Automated Backup Strategy

### Production Hosting Recommendations:
1. **Managed PostgreSQL (Neon / Supabase / AWS RDS / Fly Postgres)**:
   - Automated daily snapshots retained for at least 30 days.
   - Point-In-Time-Recovery (PITR) enabled with 7-day write-ahead log (WAL) retention.
2. **Containerized / VPS Self-Hosted**:
   - Automated cron container running `pg_dump` encrypted with GPG and uploaded to S3/Cloudflare R2:
   ```bash
   0 2 * * * /scripts/backup-db.sh > /var/log/backup.log 2>&1
   ```

---

## 2. Manual Backup Creation

To create a full binary archive or plaintext SQL dump:

### Custom Archive Format (Recommended for fast selective restores):
```bash
pg_dump -h localhost -p 5432 -U postgres -d invoice_chaser -F c -b -v -f invoice_chaser_backup_$(date +%Y%m%d_%H%M%S).dump
```

### Compressed SQL Dump:
```bash
pg_dump -h localhost -p 5432 -U postgres -d invoice_chaser | gzip > invoice_chaser_backup_$(date +%Y%m%d_%H%M%S).sql.gz
```

---

## 3. Disaster Recovery & Database Restoration

### Step 1: Drain Queues & Temporarily Halt BullMQ Workers
To prevent race conditions during restore, pause active ingestion workers:
```bash
# If using Docker
docker stop invoice_chaser_app
```

### Step 2: Terminate Existing Connections & Recreate Database
```sql
-- Connect via psql
SELECT pg_terminate_backend(pg_stat_activity.pid)
FROM pg_stat_activity
WHERE pg_stat_activity.datname = 'invoice_chaser'
  AND pid <> pg_backend_pid();

DROP DATABASE invoice_chaser;
CREATE DATABASE invoice_chaser;
```

### Step 3: Restore Database from Dump
```bash
# From Custom Archive format
pg_restore -h localhost -p 5432 -U postgres -d invoice_chaser -v invoice_chaser_backup_<timestamp>.dump

# From Compressed SQL dump
gunzip -c invoice_chaser_backup_<timestamp>.sql.gz | psql -h localhost -p 5432 -U postgres -d invoice_chaser
```

### Step 4: Verify Restoration & Run Migrations
```bash
pnpm prisma db push
pnpm exec ts-node test/load/verify-invariants.ts
```

### Step 5: Resume Application Services
```bash
docker start invoice_chaser_app
```

