# Enterprise Security Architecture & Threat Model (STRIDE)

**Document Reference:** P6-09, ARCH §2.0, ARCH §4.4, ADR-16  
**Service:** `esma-upload-service-v2`  
**Standard:** OWASP Application Security Verification Standard (ASVS) Level 2  
**Status:** Approved  

---

## 1. System Overview and Trust Boundaries

`esma-upload-service-v2` is an enterprise multi-tenant object ingestion, metadata management, and asynchronous storage replication platform.

```mermaid
flowchart TD
    Client["Untrusted Clients / Browsers"] -->|HTTPS (TLS 1.3)| Edge["Reverse Proxy / Ingress (Nginx / ALB)"]
    Edge -->|HTTP/1.1 (Keep-Alive 65s)| Nest["ESMA Web API (Express Adapter)"]
    
    subgraph Trust Boundary: Ingestion & Auth
        Nest --> AuthGuard["AuthGuard (Auth Before Parsing - F-41)"]
        AuthGuard --> IngestPipe["IngestValidationPipe & Sniffer (ADR-16)"]
        IngestPipe --> StagingDisk["Staging Dir (/tmp/gus-staging)"]
    end

    subgraph Trust Boundary: Persistence & Storage
        Nest --> Postgres[("PostgreSQL 16 (Row-Level / Multi-Tenant Isolation)")]
        Nest --> SeaweedFS["SeaweedFS Private Master / Volume"]
        Nest --> OutboxRelay["Transactional Outbox Relay"]
    end

    subgraph External / Third-Party Boundary
        Nest -.->|Strictly Public-Only Assets (F-25/F-26)| Cloudinary["Cloudinary CDN (Public Store)"]
        OutboxRelay --> Broker["Kafka / Pulsar Cluster"]
    end
```

---

## 2. STRIDE Threat Analysis

### 2.1 Spoofing (Identity Impersonation)
- **Threat Vector 1: JWT Signature Forgery & Algorithm Confusion (`alg: none`)**
  - *Risk:* An attacker submits an unverified token with `alg: "none"` or signed with a foreign key to impersonate an organization or admin.
  - *Mitigation:* `JwtVerifierService` strictly rejects `alg: "none"` or unlisted algorithms before verification. Key ring stores HMAC/RSA keys in protected memory.
  - *Verification:* [tests/security/abuse.spec.ts](file:///c:/Users/PC/Documents/React%20and%20js/esma-upload-services/esma-upload-service-v2/tests/security/abuse.spec.ts).
- **Threat Vector 2: API Key Brute Forcing**
  - *Risk:* Automated guessing of 256-bit API key secrets.
  - *Mitigation:* Fast syntax pre-validation via regex prevents DB query flooding. SHA-256 key hashing with timing-safe comparison prevents side-channel analysis. IP-level failure tracking locks out suspicious sources.

### 2.2 Tampering (Data Manipulation & Injection)
- **Threat Vector 1: Signed URL Parameter Modification**
  - *Risk:* An unauthorized user alters `exp` timestamp or fileId in a signed URL to gain perpetual access to another tenant's files.
  - *Mitigation:* `SignedUrlService` computes an HMAC-SHA256 signature binding `v1|{fileId}|{exp}|{disposition}` with secret salt. `timingSafeEqual` prevents timing attacks.
  - *Verification:* [tests/security/abuse.spec.ts](file:///c:/Users/PC/Documents/React%20and%20js/esma-upload-services/esma-upload-service-v2/tests/security/abuse.spec.ts).
- **Threat Vector 2: Filename Header Injection & Path Traversal**
  - *Risk:* Attacker supplies filenames containing `../../` or CRLF (`\r\n`) to overwrite arbitrary server files or execute HTTP response splitting.
  - *Mitigation:* `sanitizeFilename` strips all directory separators (both POSIX `/` and Windows `\`), removes control characters (`[\x00-\x1F\x7F]`), trims leading dots, and enforces a 255-byte UTF-8 cap.
  - *Verification:* [tests/security/abuse.spec.ts](file:///c:/Users/PC/Documents/React%20and%20js/esma-upload-services/esma-upload-service-v2/tests/security/abuse.spec.ts).
- **Threat Vector 3: MIME Spoofing & Polyglot Executables**
  - *Risk:* Renaming a Windows PE `.exe` or Linux ELF binary to `.pdf` or `.png` to bypass extension allowlists.
  - *Mitigation:* Magic byte inspection (`sniffMagicBytes`) verifies file signatures against declared content-type headers. Contradictions trigger `MimeMismatchError` immediately.

### 2.3 Repudiation (Denial of Action)
- **Threat Vector: Unaudited Administrative Or File Operations**
  - *Risk:* A malicious administrator or compromised credential purges data or modifies tenant quotas without an audit trail.
  - *Mitigation:* `AuditService` logs every file upload, read, signed URL generation, quota adjustment, and deletion to an append-only PostgreSQL `audit_logs` table with actor ID, IP address, timestamp, and correlation ID. Sensitive credentials (tokens, passwords, keys) are recursively redacted (`[REDACTED]`).
  - *Verification:* [tests/security/http-hardening.spec.ts](file:///c:/Users/PC/Documents/React%20and%20js/esma-upload-services/esma-upload-service-v2/tests/security/http-hardening.spec.ts).

### 2.4 Information Disclosure (Data Leakage)
- **Threat Vector 1: Private Files Leaked to Public CDN (F-25, F-26)**
  - *Risk:* Internal tenant documents (e.g. exams, passports, contracts) uploaded to public Cloudinary buckets.
  - *Mitigation:* `StoragePlacementService` enforces a strict architectural invariant: `file.visibility !== 'public'` strictly excludes Cloudinary from primary candidates and secondary replication targets.
  - *Verification:* [tests/security/public-store-leak.spec.ts](file:///c:/Users/PC/Documents/React%20and%20js/esma-upload-services/esma-upload-service-v2/tests/security/public-store-leak.spec.ts).
- **Threat Vector 2: Stack Traces & SQL Leaks in Error Bodies**
  - *Risk:* Database query failures returning table schemas or SQL syntax details to external callers.
  - *Mitigation:* `ProblemJsonErrorFilter` maps all unexpected errors to RFC 7807 `application/problem+json` with static message `"An unexpected internal error occurred"`.

### 2.5 Denial of Service (Resource Starvation)
- **Threat Vector 1: Unauthenticated Body Parsing (F-41)**
  - *Risk:* Attackers upload gigabytes of data to unauthenticated endpoints, exhausting disk space before credentials are evaluated.
  - *Mitigation:* NestJS guard order guarantees `AuthGuard` executes before multipart streaming begins. The automated route audit ([tests/security/route-audit.spec.ts](file:///c:/Users/PC/Documents/React%20and%20js/esma-upload-services/esma-upload-service-v2/tests/security/route-audit.spec.ts)) mechanically fails CI if any non-public route lacks authentication.
- **Threat Vector 2: Staging Disk Exhaustion (ENOSPC)**
  - *Risk:* Interrupted or failed uploads leave orphaned temporary files filling the staging directory.
  - *Mitigation:* `StagingCleanupInterceptor` and `tmp-dir` ensure staging files are unlinked in `finally` blocks, even under crash or connection termination.

### 2.6 Elevation of Privilege
- **Threat Vector: Cross-Tenant Resource Access & Role Bypass**
  - *Risk:* A valid user from Tenant A accessing or modifying files belonging to Tenant B.
  - *Mitigation:* `AuthorizationGuard` checks `ctx.tenantId` against database row ownership. Queries are scoped by `(namespace, tenant_id)`. Cross-tenant requests return 404/403.

---

## 3. OWASP ASVS Level 2 Verification Checklist

| ASVS Section | Verification Requirement | Implementation Mechanism | Status |
| :--- | :--- | :--- | :--- |
| **V2.1.1** | Verify authentication on all non-public pages and APIs | `route-audit.spec.ts` introspects 100% of controller routes | **VERIFIED** |
| **V3.5.2** | Verify anti-replay mechanisms on signed/token URLs | `SignedUrlService` validates HMAC signature + expiration | **VERIFIED** |
| **V4.1.1** | Verify multi-tenant isolation and access control enforcement | `ContextGuard` & `AuthorizationGuard` assert tenant ownership | **VERIFIED** |
| **V5.1.3** | Verify input validation on untrusted filenames | `sanitizeFilename` strips path traversal, CRLF, and null bytes | **VERIFIED** |
| **V8.3.4** | Verify sensitive data is not written to audit logs | `AuditService.sanitizeDetails` redacts tokens, secrets, keys | **VERIFIED** |
| **V12.1.1** | Verify uploaded files cannot be executed on the server | Staging outside webroot; magic byte sniffing for PE/ELF binaries | **VERIFIED** |
| **V12.2.1** | Verify files are stored with randomly generated keys | UUIDv7 canonical storage keys (`storage-key.service.ts`) | **VERIFIED** |
| **V14.4.1** | Verify security headers (`nosniff`, CSP `sandbox`) | Helmet middleware configured in `main.ts` | **VERIFIED** |
