# Browser-direct upload: what the frontends call (12 Oct 2026)

Applies once the upload team ships M1 (requirements doc `upload-service-v2-requirements-2026-10-11.md`, UR-29/UR-30). Backends below are already built for it (not compiled or run; run `mvn -B verify`).

## The flow
1. **Upload.** `POST {gateway}/uploads/api/v1/files/upload`, multipart `file` (+ optional `folder`), headers `Authorization: Bearer <user token>` and `X-Namespace: <namespace>`. Response `{ data: { fileId, filename, mimetype, size, scanStatus, claimed:false, ... } }`.
2. **Wait for the scan.** Poll `GET {gateway}/uploads/api/v1/files/{fileId}/metadata` (same token) until `scanStatus` is `CLEAN`. `INFECTED`/`ERROR`: show an error, do not submit. `PENDING` may be submitted (the backend accepts it) but the content cannot be read until clean.
3. **Send the id to the backend** in the business request (JSON). The backend accepts the bare id, `file:<id>` or the file URL; send `fileId`.
4. The backend verifies (same organisation, same user, namespace, size/type, not infected) and **claims** the file. A file that is never claimed is deleted after 24 h.
5. **Reading.** Ask the owning service for a URL (`.../url`); it returns a signed URL (valid 5 min). Use it directly in `<img>`, `<a>` or `fetch`. Public branding files use their public URL.

Errors come back as the usual ESMA error envelope with an `error.storage.*` message key (for example `error.storage.not_uploader`, `error.storage.file_rejected`, `error.storage.scan_pending`, `error.storage.quota_exceeded`).

## Endpoints (JSON body `{ "file": "<fileId>" }` unless stated)
| Feature | Namespace | Upload with header | Then call | Notes |
|---|---|---|---|---|
| School support ticket attachment | `support-attachments` | `X-Namespace: support-attachments` | `POST support/my-tickets/{ticket}/attachments` (owner) or `POST support/tickets/{ticket}/attachments` (staff) | download link: `GET .../attachments/{id}/url` |
| Bulk onboarding (SIS) | `imports` | `X-Namespace: imports` | `POST onboarding/jobs` or `onboarding/sis/jobs` | `.xlsx` only; ≤ configured max MB |
| Bulk onboarding (LMS) | `imports` | same | `POST` LMS `onboarding/jobs` or `onboarding/lms/jobs` | `.xlsx` only |
| Data-job import (SIS) | `imports` | same | `POST jobs/import` with `{ "entityKey", "file", "delivery" }` | csv, xlsx, xls, ods |
| Exam case evidence | `case-evidence` | `X-Namespace: case-evidence` | `POST .../cases/{id}/evidence/upload` with `{ "file", "description" }` | pdf, png, jpeg, text |
| Organisation logo | `branding` | `X-Namespace: branding` | `POST organizations/{id}/logo` | own organisation only; ≤ 5 MB; png, jpeg, webp, svg |
| Auth-screen hero image | `branding` | same | `POST organizations/{id}/auth-hero-image` | own organisation only; ≤ 10 MB |
| Person photo | `branding` | same | `POST people/{id}/avatar` | person in the caller's organisation; ≤ 5 MB |

The multipart endpoints stay as they are (used by platform staff acting for another school, and by anything not yet moved).

## Not yet on this flow
SIS student documents and homework (need document-row changes and read grants), platform support desk (BackOffice staff upload for the school's organisation, so they keep the multipart path), LMS lesson media, session recordings, tenant exports.

## Gateway
`GET`/`HEAD /uploads/api/v1/files/{id}` is open at the gateway (signed URLs and public files carry their own proof; the upload service enforces it). Everything else needs the bearer token. The gateway exposes the headers `X-Correlation-Id, Idempotent-Replayed, Content-Disposition, Content-Range, Accept-Ranges, ETag, Retry-After, Location` to the browser.
