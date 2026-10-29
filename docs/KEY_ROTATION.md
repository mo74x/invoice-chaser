# Key Rotation Runbook: ENCRYPTION_KEY & Secrets

## Overview
Invoice Chaser uses `ENCRYPTION_KEY` for:
1. AES-256-GCM encryption at rest of connected Stripe OAuth tokens (`Account.stripeTokenEnc`).
2. HMAC-SHA256 signature generation & verification of OAuth state tokens and One-Click Unsubscribe tokens.
3. Signing and verifying Magic-Link authentication JWTs.

---

## 1. Generating a New 32-Byte Key
To generate a secure 256-bit (32-byte) hex key:
```bash
node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"
```

---

## 2. Zero-Downtime Secret Rotation Process

### Step 1: Pre-requisites & Backup
1. Trigger a database backup or snapshot before rotating encryption keys:
   ```bash
   pg_dump -U postgres -d invoice_chaser > pre_rotation_backup.sql
   ```

### Step 2: Dual-Key Support (Re-encryption Migration Script)
If accounts already have `stripeTokenEnc` encrypted under the previous key:
1. Keep the previous key available as `PREVIOUS_ENCRYPTION_KEY`.
2. Set the newly generated key as `ENCRYPTION_KEY`.
3. Run a migration script to decrypt existing accounts with `PREVIOUS_ENCRYPTION_KEY` and re-encrypt with `ENCRYPTION_KEY`:
   ```ts
   // Pseudocode migration
   const accounts = await prisma.account.findMany({ where: { stripeTokenEnc: { not: null } } });
   for (const acct of accounts) {
     const plain = decrypt(acct.stripeTokenEnc, PREVIOUS_KEY);
     const reEncrypted = encrypt(plain, NEW_KEY);
     await prisma.account.update({ where: { id: acct.id }, data: { stripeTokenEnc: reEncrypted } });
   }
   ```

### Step 3: Deployment & Cleanup
1. Deploy application with the updated `ENCRYPTION_KEY`.
2. Existing magic links will expire after their 15-minute TTL; users request fresh magic links.
3. Once all `stripeTokenEnc` values have been verified under the new key, remove `PREVIOUS_ENCRYPTION_KEY` from production environment configurations.

---

## 3. Webhook Secrets Rotation (Stripe & Resend)
- **Stripe**: Rotate the webhook secret in the Stripe Dashboard under *Developers > Webhooks*. Set the new secret as `STRIPE_WEBHOOK_SECRET` in environment variables and restart.
- **Resend**: Rotate the endpoint signing secret in the Resend Webhooks settings and update `RESEND_WEBHOOK_SECRET`.

