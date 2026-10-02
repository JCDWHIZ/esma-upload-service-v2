# Runbook: PostgreSQL Roles and Audit Log Privileges

## 1. Overview
In accordance with ARCH §5.1 and task P1-05, the `audit_log` table is append-only for the application runtime.
The application role (`DB_APP_ROLE`) must be granted `INSERT` and `SELECT` only on `audit_log`, while `UPDATE`, `DELETE`, and `TRUNCATE` are strictly revoked to prevent tampering or accidental data erasure.

---

## 2. Role Provisioning

### 2.1 Staging and Production Setup
In production and staging environments, the database administrator creates two distinct roles:
1. **Migration / Admin Role (`gus_admin` or `postgres`)**:
   - Owns schemas and tables.
   - Executes migrations (`npm run db:migrate`).
   - Has DDL privileges.

2. **Application Runtime Role (`gus_app`)**:
   - Used by the running NestJS application instances (`DATABASE_URL`).
   - Has DML privileges on operational tables (`files`, `file_replicas`, `outbox_events`, `processed_events`, `api_clients`, `tenant_usage`).
   - Restricted to `INSERT, SELECT` on `audit_log`.

### 2.2 Provisioning SQL Script
Run the following commands as a PostgreSQL superuser (`postgres`):

```sql
-- 1. Create the application role if it doesn't already exist
DO $$
BEGIN
  IF NOT EXISTS (SELECT FROM pg_roles WHERE rolname = 'gus_app') THEN
    CREATE ROLE gus_app WITH LOGIN PASSWORD 'CHANGE_ME_SECURE_PASSWORD';
  END IF;
END
$$;

-- 2. Grant connection and schema usage
GRANT CONNECT ON DATABASE "gus" TO gus_app;
GRANT USAGE ON SCHEMA public TO gus_app;

-- 3. Grant standard read/write on domain tables
GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE
  files,
  file_replicas,
  outbox_events,
  processed_events,
  api_clients,
  tenant_usage
TO gus_app;

-- 4. Audit Log Immutability Enforcement
-- Revoke destructive permissions
REVOKE UPDATE, DELETE, TRUNCATE ON TABLE audit_log FROM gus_app;
-- Grant append and read only
GRANT INSERT, SELECT ON TABLE audit_log TO gus_app;
```

---

## 3. Migration Runner Configuration
When running schema migrations (`004_audit_log.ts`), configure `DB_APP_ROLE` in the environment of the migration runner:

```bash
DB_APP_ROLE=gus_app npm run db:migrate
```

The migration runner will automatically enforce:
```sql
REVOKE UPDATE, DELETE, TRUNCATE ON audit_log FROM "gus_app";
GRANT INSERT, SELECT ON audit_log TO "gus_app";
```

---

## 4. Verification Drill
To verify the role permissions:
```sql
SET ROLE gus_app;

-- Allowed:
INSERT INTO audit_log (id, action, outcome, actor_id, actor_type, namespace, correlation_id)
VALUES (gen_random_uuid(), 'TEST', 'SUCCESS', 'tester', 'SYSTEM', 'esma-tenant', 'corr-123');

SELECT * FROM audit_log WHERE correlation_id = 'corr-123';

-- Forbidden (must fail with permission denied):
UPDATE audit_log SET action = 'ALTERED' WHERE correlation_id = 'corr-123';
-- ERROR: permission denied for table audit_log

DELETE FROM audit_log WHERE correlation_id = 'corr-123';
-- ERROR: permission denied for table audit_log

TRUNCATE audit_log;
-- ERROR: permission denied for table audit_log

RESET ROLE;
```
