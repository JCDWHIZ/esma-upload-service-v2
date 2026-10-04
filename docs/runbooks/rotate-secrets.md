# Secret Rotation Runbook (v2)

> **Document Version:** 1.0  
> **Target Service:** `esma-upload-service-v2`  
> **Relevant Tasks & References:** P1-02, P1-09, ARCH §10, F-40

---

## 1. Overview & Principles

In `esma-upload-service-v2`, secrets are strictly injected at runtime via environment variables or secret managers (e.g., HashiCorp Vault, AWS Secrets Manager, Doppler, or encrypted Docker Compose secrets). No secrets are stored in code, fixtures, git history, or documentation.

Key operational rules:
1. **Never commit secrets:** CI and pre-commit hooks run secret scanning (`npm run secret:scan` / `gitleaks`) on every commit and PR.
2. **Fresh credentials only:** Credentials documented in legacy designs or previous drafts (e.g., F-40) are permanently retired and must never be reused.
3. **Secret Isolation:** `JWT_SECRET` and `SIGNED_URL_SECRET` must always be distinct secrets.

---

## 2. Rotation Procedures

### 2.1 JWT Signing Secret (`JWT_SECRET`)

The JWT secret signs and verifies authentication tokens.

1. **Generate a new secure secret:**
   ```bash
   openssl rand -base64 48
   ```
2. **Key Ring Transition Window (P1-09):**
   - For zero-downtime rotation, add the new secret as the primary signing secret.
   - Configure the previous secret in the secondary verification list so in-flight client tokens remain valid until expiration.
3. **Update Environment & Restart:**
   - Update `JWT_SECRET` in deployment configuration.
   - Perform a rolling restart of the `api` service.
4. **Retire Old Secret:**
   - After the token expiration window (e.g. 24 hours), remove the old secret from the verification keyring.

---

### 2.2 Signed URL Secret (`SIGNED_URL_SECRET`)

Used for HMAC verification of temporary, time-limited direct download or upload URLs.

1. **Generate a new secure secret:**
   ```bash
   openssl rand -base64 48
   ```
   *Note: In production, `SIGNED_URL_SECRET` must differ from `JWT_SECRET` and be at least 32 characters long.*
2. **Update Environment & Restart:**
   - Update `SIGNED_URL_SECRET` in environment.
   - Restart `api` service.
3. **Expiry Window:**
   - Pre-existing signed URLs expire naturally within `SIGNED_URL_MAX_TTL_SECONDS` (default 900 seconds / 15 minutes). Clients requesting new URLs will receive links signed with the updated key.

---

### 2.3 PostgreSQL Database Credentials (`DATABASE_URL`)

1. **Create Alternate User in PostgreSQL:**
   ```sql
   CREATE USER gus_app_v2 WITH PASSWORD '<NEW_STRONG_PASSWORD>';
   GRANT gus_app_role TO gus_app_v2;
   ```
2. **Update Service Configuration:**
   - Set `DATABASE_URL=postgres://gus_app_v2:<NEW_STRONG_PASSWORD>@<host>:5432/gus` in secrets store.
   - Deploy/restart `api` and `worker` instances.
3. **Decommission Old User:**
   - Check active connections:
     ```sql
     SELECT usename, client_addr, state FROM pg_stat_activity WHERE usename = 'old_user';
     ```
   - Once all old connections drain, drop or disable the old user:
     ```sql
     DROP USER old_user;
     ```

---

### 2.4 SeaweedFS S3 Credentials (`SEAWEEDFS_ACCESS_KEY`, `SEAWEEDFS_SECRET_KEY`)

1. **Create New Credentials in SeaweedFS:**
   - Configure a new access key and secret key in SeaweedFS `s3_config.json` or admin API.
   - Reload SeaweedFS S3 service.
2. **Update Application Environment:**
   - Update `SEAWEEDFS_ACCESS_KEY` and `SEAWEEDFS_SECRET_KEY`.
   - Rolling restart `api` and `worker` containers.
3. **Revoke Old Access Key:**
   - Remove previous key entry from SeaweedFS configuration and reload.

---

### 2.5 Cloudinary Credentials (`CLOUDINARY_API_KEY`, `CLOUDINARY_API_SECRET`)

1. **Generate New API Key in Cloudinary:**
   - Navigate to **Cloudinary Console > Settings > Access Keys**.
   - Generate a new secondary API Key and Secret.
2. **Update Application Environment:**
   - Set `CLOUDINARY_API_KEY` and `CLOUDINARY_API_SECRET` to the new values.
   - Restart `api` and `worker` instances.
3. **Revoke Old API Key:**
   - In Cloudinary Console, disable and subsequently delete the retired API Key.

---

### 2.6 Redis Cache & Message Broker Tokens

* **Redis (`REDIS_URL`):** Update `requirepass` in Redis or create a new ACL user. Update `REDIS_URL` in environment and restart services.
* **Pulsar Auth Token (`PULSAR_AUTH_TOKEN`):** Generate a new asymmetric or JWT-based Pulsar token via Pulsar admin CLI, update environment, and revoke previous token.

---

## 3. Emergency Compromise Protocol

If any secret is detected in logs, committed to git, or suspected of being compromised:
1. **Immediate Revocation:** Rotate and invalidate the compromised credential immediately.
2. **Audit Exposure:** Check access logs and metrics (`gus_upload_failures_total`, Cloudinary / S3 audit trails) for unauthorized actions.
3. **Invalidate Sessions:** For JWT compromise, invalidate active refresh tokens or rotate the signing key immediately, requiring re-authentication.
4. **Git Cleanup:** If committed to git, do not simply delete the line in a new commit. Run `git filter-repo` or BFG to expunge the secret from repository history, force push, and immediately rotate the credential in all environments.
