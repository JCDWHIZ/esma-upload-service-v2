# Legacy Contract Specification & Behavior Reference

> **Version:** 1.0 (2026-09-26)  
> **Source:** Synthesized from `docs/CURRENT_ARCHITECTURE_AND_IMPLEMENTATION (1).md` §8 and `docs/REVIEW_FINDINGS_AND_DECISIONS.md`.  
> **Target:** Defines the exact external contract for the 17 legacy route entries to be supported by the Phase 3 backward-compatibility facades (`/api/tenant/upload/*`, `/api/admin/upload/*`, and system routes).  
> **Design Principle:** v2 never reproduces documented defects (F-04, F-40 through F-51). Every contract entry below specifies the **corrected, hardened** behavior.

---

## 1. Architectural Assumption Resolutions

| ID | Assumption | Resolution & Decision in v2 Contract |
| :--- | :--- | :--- |
| **A-03** | Auth composition (`validateTokenMiddleware` + `validateSchoolHeadersMiddleware`) | **Resolved:** Legacy tenant routes composed token authentication with header validation. In v2, the request is authenticated first (`AuthGuard`), and the caller's JWT claims (`schoolId`, `branchId`) are strictly verified against the `x-school-id` and optional `x-branch-id` headers (`ContextGuard`). Header spoofing is rejected with `403 Forbidden`. |
| **A-05** | Exact MIME allowlist & error messages | **Resolved:** Legacy checked client-supplied MIME strings with inconsistent error messages ("Only JPEG, PNG and GIF are allowed" while allowing docx/pdf/xlsx). In v2, filtering is strictly enforced by **magic-byte detection** (`file-type`). Allowed types: `image/jpeg`, `image/png`, `image/gif`, `application/pdf`, `application/vnd.openxmlformats-officedocument.wordprocessingml.document` (docx), and `application/vnd.openxmlformats-officedocument.spreadsheetml.sheet` (xlsx). Unrecognized or disguised executables (e.g. PE header disguised as `.pdf`) return `400 Bad Request`. |
| **A-07** | Per-field subfolders on tenant routes | **Resolved:** In legacy, tenant files were stored under `uploads/schools/${schoolId}` or `uploads/schools/${schoolId}/branches/${branchId}` with no field-specific subfolder (unlike admin multi-field which used `admin/${folder}/${fieldName}`). v2 preserves this: tenant assets reside in the school/branch folder; admin multi-field assets append the field name. |
| **A-10** | Cloudinary `folder:` search semantics | **Resolved:** Verified via diagnostic probe script (`scripts/probe-cloudinary-search.ts`). Cloudinary expressions with `folder:path/*` match nested folders, while `folder:path` matches direct files. v2 abstracts search and listing through storage driver providers. |

---

## 2. Documented Legacy Defect Corrections Matrix

| Defect ID | Legacy Behavior (Broken) | v2 Corrected Contract (Hardened) |
| :--- | :--- | :--- |
| **F-04** | `req.file.filename` referenced inside `req.files.map` on tenant multiple upload. | Each uploaded file in `req.files` is ingested, staged, and hashed independently. |
| **F-40** | Admin routes (`/api/admin/upload/*`) had no authentication middleware attached. | **Mandatory Authentication:** All admin routes require a valid JWT with role `superadmin` or `admin`. Unauthenticated calls return `401 Unauthorized`. Unauthorized roles return `403 Forbidden`. |
| **F-41** | Multer parsing executed before authentication on tenant routes (disk exhaustion vector). | **Auth-Before-Parsing:** `AuthGuard` and `ContextGuard` execute before any multipart body parsing occurs. Unauthenticated uploads are rejected without staging bytes on disk. |
| **F-42** | Tenant delete prefix check `publicId.startsWith("uploads/schools/" + schoolId)` lacked a trailing slash. | **Strict Tenant Prefix Scoping:** Check enforces `publicId.startsWith("uploads/schools/" + schoolId + "/")`. Branch tokens additionally require `publicId.startsWith("uploads/schools/" + schoolId + "/branches/" + branchId + "/")`. Cross-tenant delete attempts return `404 Not Found` (or `403 Forbidden`). |
| **F-44** | JWT verification lacked algorithm allowlist and accepted tokens without `exp`. | JWTs must use approved algorithms (`RS256` / `HS256`) and must contain a non-expired `exp` claim. |
| **F-45** | Super Admin bulk delete (`DELETE /api/admin/upload/files`) accepted unbounded arrays of public IDs. | Bulk operations are strictly bounded to a maximum of 100 items per request. Requests with $>100$ items return `400 Bad Request`. |
| **F-47** | Static `/uploads/*` directory traversal and direct container disk exposure. | Static file route is retired or restricted to securely resolved, non-executable content without directory traversal. |
| **F-51** | MIME filtering trusted client headers without magic byte inspection. | Validated strictly via magic-byte inspection on staged file content. Disguised files are rejected immediately. |

---

## 3. Complete API Endpoint Catalog (17 Route Entries)

### 3.1 Tenant Routes (`/api/tenant/upload`)

#### Route 1: Single Upload
- **Method / Path:** `POST /api/tenant/upload/single`
- **Authentication:** Bearer token (School Admin or Branch Admin)
- **Required Headers:**
  - `Authorization: Bearer <token>`
  - `x-school-id: <schoolId>`
  - `x-branch-id: <branchId>` (mandatory if token is branch-scoped)
- **Request Body:** `multipart/form-data` with field `file`.
- **Success Response (200 / 201):**
  ```json
  {
    "message": "File uploaded successfully",
    "data": {
      "public_id": "uploads/schools/<schoolId>/branches/<branchId>/<ID>",
      "secure_url": "https://storage.example.com/uploads/schools/<schoolId>/branches/<branchId>/<ID>.png",
      "tenant": {
        "schoolId": "<schoolId>",
        "branchId": "<branchId>",
        "schoolName": "<schoolName>"
      }
    }
  }
  ```
- **Error Responses:**
  - `401 Unauthorized`: Missing or expired Bearer token.
  - `403 Forbidden`: `x-school-id` does not match token claim.
  - `400 Bad Request`: Missing `file` field or disallowed MIME type.
  - `413 Payload Too Large`: File exceeds policy size limit (e.g. 20 MiB).

#### Route 2: Multiple Upload
- **Method / Path:** `POST /api/tenant/upload/multiple`
- **Authentication:** Bearer token (School Admin or Branch Admin)
- **Required Headers:** `Authorization`, `x-school-id`, optional `x-branch-id`
- **Request Body:** `multipart/form-data` with `files` (array, up to 10 files).
- **Success Response (200 / 201):**
  ```json
  {
    "message": "Files uploaded successfully",
    "files": [
      {
        "public_id": "uploads/schools/<schoolId>/branches/<branchId>/<ID-1>",
        "secure_url": "https://storage.example.com/.../<ID-1>.png"
      }
    ],
    "tenant": {
      "schoolId": "<schoolId>",
      "branchId": "<branchId>",
      "schoolName": "<schoolName>"
    }
  }
  ```
- **Quirk:** Response property is `files` (array of objects with `public_id` and `secure_url`).

#### Route 3: Multiple Fields Upload
- **Method / Path:** `POST /api/tenant/upload/multiple-fields`
- **Authentication:** Bearer token (School Admin or Branch Admin)
- **Required Headers:** `Authorization`, `x-school-id`, optional `x-branch-id`
- **Request Body:** `multipart/form-data` with fields:
  - `avatar`: max 1 file
  - `gallery`: max 5 files
  - `documents`: max 10 files
- **Success Response (200 / 201):**
  ```json
  {
    "message": "Files uploaded successfully",
    "files": {
      "avatar": [ { "public_id": "<ID>", "secure_url": "<URL>" } ],
      "gallery": [ { "public_id": "<ID>", "secure_url": "<URL>" } ],
      "documents": [ { "public_id": "<ID>", "secure_url": "<URL>" } ]
    },
    "tenant": {
      "schoolId": "<schoolId>",
      "branchId": "<branchId>",
      "schoolName": "<schoolName>"
    }
  }
  ```
- **Quirk:** Path is `/multiple-fields` (plural) whereas admin route is `/fields`.

#### Route 4: List School Files
- **Method / Path:** `GET /api/tenant/upload/files/:schoolId`
- **Authentication:** Bearer token (matching `schoolId`)
- **Required Headers:** `Authorization`, `x-school-id: <schoolId>`
- **Path Parameters:** `schoolId`
- **Success Response (200):**
  ```json
  {
    "message": "Files retrieved successfully",
    "files": [
      {
        "public_id": "uploads/schools/<schoolId>/<ID>",
        "secure_url": "https://storage.example.com/.../<ID>.png",
        "created_at": "<TS>"
      }
    ],
    "tenant": {
      "schoolId": "<schoolId>",
      "schoolName": "<schoolName>"
    },
    "total": 1
  }
  ```
- **Error Responses:** `403 Forbidden` if path `schoolId` does not match token claim.

#### Route 5: List Branch Files
- **Method / Path:** `GET /api/tenant/upload/files/:schoolId/:branchId`
- **Authentication:** Bearer token (matching `schoolId` and `branchId`)
- **Required Headers:** `Authorization`, `x-school-id`, `x-branch-id`
- **Path Parameters:** `schoolId`, `branchId`
- **Success Response (200):**
  ```json
  {
    "message": "Files retrieved successfully",
    "files": [
      {
        "public_id": "uploads/schools/<schoolId>/branches/<branchId>/<ID>",
        "secure_url": "https://storage.example.com/.../<ID>.png",
        "created_at": "<TS>"
      }
    ],
    "tenant": {
      "schoolId": "<schoolId>",
      "branchId": "<branchId>",
      "schoolName": "<schoolName>"
    },
    "total": 1
  }
  ```

#### Route 6: Delete Tenant File
- **Method / Path:** `DELETE /api/tenant/upload/files/:publicId`
- **Authentication:** Bearer token (matching tenant scope)
- **Path Parameters:** `publicId` (URL-encoded)
- **Success Response (200):**
  ```json
  {
    "message": "File deleted successfully",
    "result": {
      "result": "ok"
    },
    "tenant": {
      "schoolId": "<schoolId>",
      "schoolName": "<schoolName>"
    }
  }
  ```
- **Error Responses:**
  - `404 Not Found` (or `403 Forbidden`): Attempting to delete a file outside the caller's school/branch scope.

---

### 3.2 Super Admin Routes (`/api/admin/upload`)

#### Route 7: Admin Single Upload
- **Method / Path:** `POST /api/admin/upload/single`
- **Authentication:** Bearer token (Role: `superadmin` or `admin`)
- **Query Parameters:** `folder` (optional, default `general`)
- **Request Body:** `multipart/form-data` with field `file`.
- **Success Response (200 / 201):**
  ```json
  {
    "message": "File uploaded successfully",
    "data": {
      "public_id": "admin/<folder>/<ID>",
      "secure_url": "https://storage.example.com/admin/<folder>/<ID>.png"
    },
    "folder": "admin/<folder>"
  }
  ```
- **Quirk:** Returns top-level `folder` attribute alongside `data`.

#### Route 8: Admin Multiple Upload
- **Method / Path:** `POST /api/admin/upload/multiple`
- **Authentication:** Bearer token (Admin role)
- **Query Parameters:** `folder` (optional)
- **Request Body:** `multipart/form-data` with `files` (array, up to 10 files).
- **Success Response (200 / 201):**
  ```json
  {
    "message": "Files uploaded successfully",
    "files": [
      {
        "public_id": "admin/<folder>/<ID>",
        "secure_url": "https://storage.example.com/admin/<folder>/<ID>.png"
      }
    ],
    "folder": "admin/<folder>",
    "total": 1
  }
  ```

#### Route 9: Admin Fields Upload
- **Method / Path:** `POST /api/admin/upload/fields`
- **Authentication:** Bearer token (Admin role)
- **Query Parameters:** `folder` (optional)
- **Request Body:** `multipart/form-data` with fields:
  - `profile_image`: max 1 file
  - `gallery_images`: max 5 files
  - `documents`: max 3 files
- **Success Response (200 / 201):**
  ```json
  {
    "message": "Files uploaded successfully",
    "files": {
      "profile_image": [ { "public_id": "admin/<folder>/profile_image/<ID>", "secure_url": "<URL>" } ],
      "gallery_images": [ { "public_id": "admin/<folder>/gallery_images/<ID>", "secure_url": "<URL>" } ],
      "documents": [ { "public_id": "admin/<folder>/documents/<ID>", "secure_url": "<URL>" } ]
    },
    "folder": "admin/<folder>"
  }
  ```
- **Quirk:** Endpoint path is `/fields` (not `/multiple-fields`), and subfolder appends field name: `admin/${folder}/${fieldName}`.

#### Route 10: Admin List Files
- **Method / Path:** `GET /api/admin/upload/files`
- **Authentication:** Bearer token (Admin role)
- **Query Parameters:** `folder` (optional), `limit` (default 100), `nextCursor` (optional)
- **Success Response (200):**
  ```json
  {
    "message": "Files retrieved successfully",
    "files": [
      {
        "public_id": "admin/<folder>/<ID>",
        "secure_url": "https://storage.example.com/admin/<folder>/<ID>.png",
        "format": "png",
        "created_at": "<TS>"
      }
    ],
    "total": 1,
    "next_cursor": null,
    "rate_limit_allowed": 500
  }
  ```
- **Quirk:** Returns legacy Cloudinary metadata fields like `rate_limit_allowed` and `next_cursor`.

#### Route 11: Admin Inspect File Details
- **Method / Path:** `GET /api/admin/upload/file/:publicId`
- **Authentication:** Bearer token (Admin role)
- **Path Parameters:** `publicId` (URL-encoded)
- **Success Response (200):**
  ```json
  {
    "message": "File retrieved successfully",
    "file": {
      "public_id": "admin/<folder>/<ID>",
      "format": "png",
      "bytes": 67,
      "secure_url": "https://storage.example.com/admin/<folder>/<ID>.png",
      "created_at": "<TS>"
    }
  }
  ```
- **Quirk:** Singular `/file/:publicId` (whereas tenant list is `/files/:schoolId`).

#### Route 12: Admin Delete Single File
- **Method / Path:** `DELETE /api/admin/upload/file/:publicId`
- **Authentication:** Bearer token (Admin role)
- **Path Parameters:** `publicId` (URL-encoded)
- **Success Response (200):**
  ```json
  {
    "message": "File deleted successfully",
    "result": {
      "result": "ok"
    },
    "publicId": "admin/<folder>/<ID>"
  }
  ```
- **Quirk:** Singular `/file/:publicId` in path, and returns camelCase `publicId` property in response body.

#### Route 13: Admin Bulk Delete Files
- **Method / Path:** `DELETE /api/admin/upload/files`
- **Authentication:** Bearer token (Admin role)
- **Request Body:** `application/json`
  ```json
  {
    "publicIds": ["admin/banners/banner1", "admin/banners/banner2"]
  }
  ```
- **Success Response (200):**
  ```json
  {
    "message": "Bulk delete completed",
    "successful": ["admin/banners/banner1"],
    "failed": [],
    "total": 1
  }
  ```
- **Hardened Constraint (F-45):** Body array `publicIds` cannot exceed 100 items. Requests with $>100$ items return `400 Bad Request`.

---

### 3.3 System & Documentation Endpoints

#### Route 14: System Test Healthcheck
- **Method / Path:** `GET /api/test`
- **Authentication:** None (Public)
- **Success Response (200):**
  ```json
  {
    "message": "Hello World"
  }
  ```

#### Route 15: OpenAPI JSON Specification
- **Method / Path:** `GET /docs.json`
- **Authentication:** None (Public)
- **Success Response (200):**
  - `Content-Type: application/json`
  - Valid OpenAPI JSON payload with `openapi: "3.1.0"` (or `"3.0.0"`).

#### Route 16: Interactive API Documentation (Swagger UI)
- **Method / Path:** `GET /`
- **Authentication:** None (Public in development)
- **Success Response (200):**
  - `Content-Type: text/html`
  - Serves Swagger UI HTML representation.

#### Route 17: Static Uploads Endpoint
- **Method / Path:** `GET /uploads/*`
- **Authentication:** None (Public in legacy, hardened in v2)
- **Behavior in v2 (F-47):** Unsafe local disk folder traversal is prohibited. Requesting unknown static paths returns `404 Not Found`.
