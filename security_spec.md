# BirrLedger Firestore Security Specification (Phase 0)

## 1. Data Invariants & Master Source of Truth

1. **Identity & Privilege Escalation Invariant**: Users authenticate via Firebase Auth (Google Sign-In with verified email). Client payloads can never self-assign `role: 'admin'` or `role: 'accountant'`. Only the bootstrapped administrator (`zekimuluken@gmail.com` with `email_verified == true`) or an existing administrator recorded in `/admins/{uid}` can elevate roles or register admin records.
2. **PII Isolation Invariant**: `/users/{userId}` holds zero PII (no `email`, no `phone`). Email and phone reside strictly in `/users/{userId}/private/info`, gated by both `get(/databases/$(database)/documents/users/$(userId))` (Master Gate) and `isOwner(userId) || isAdmin()`.
3. **Subcollection Master Gate & Atomicity**: `/users/{userId}/private/{docId}` and `/users/{userId}/preferences/{prefId}` require parent `/users/$(userId)` to exist (`existsAfter` on create, `get()` on read/update).
4. **Path Variable Hardening & Boundary Limits**: Every single-document operation (`get`, `create`, `update`, `delete`) enforces `isValidId(docId)` (`^[a-zA-Z0-9_\-]+$`, length `<= 128`). Every string field checks `.size()`.
5. **Terminal State Locking**: `registration_applications` and `payment_submissions` lock once status becomes `APPROVED` or `REJECTED` unless overridden by `isAdmin()`.
6. **Immutable Ownership & Temporal Integrity**: `uid`, `ownerUid`, `submittedByUid`, `actorUid`, and `createdAt` are immutable after creation; `createdAt == request.time` on create and `updatedAt == request.time` on update.
7. **Zero Client Query Trust**: Every `allow list` rule restricts rows via `resource.data` against `request.auth.uid` or `isBootstrappedAdmin()` with zero `get()`/`exists()` calls inside `allow list`.
8. **Immutable Audit Trail**: `/audit_logs/{logId}` rejects all updates and deletes unconditionally.

## 2. The "Dirty Dozen" Adversarial Payloads

1. **Unauthenticated Read/Write**: `request.auth == null` attempting `get /users/u1` -> `PERMISSION_DENIED`.
2. **Unverified Email Token Spoof**: `request.auth.token.email == 'zekimuluken@gmail.com'` with `email_verified == false` attempting `create /admins/u_spoof` -> `PERMISSION_DENIED`.
3. **Self-Assigned Admin Role on Signup**: Non-admin user creating `/users/{uid}` with `role: 'admin'` -> `PERMISSION_DENIED`.
4. **Shadow Field Injection ("Ghost Field")**: Valid user updating `/users/{uid}/preferences/workspace` with extra key `isAdminOverride: true` -> `PERMISSION_DENIED`.
5. **Cross-User PII Snooping**: Authenticated non-admin user `u2` reading `/users/u1/private/info` -> `PERMISSION_DENIED`.
6. **Blanket List Query Scraping**: Non-admin user issuing `list /students` without owner filter -> `PERMISSION_DENIED`.
7. **Terminal State Bypass**: Submitter attempting to revert an `APPROVED` `/payment_submissions/{id}` back to `PENDING` -> `PERMISSION_DENIED`.
8. **ID Poisoning / Path Traversal**: Attempting `create /courses/..%2Fbad_id_longer_than_128...` -> `PERMISSION_DENIED`.
9. **Client Timestamp Forgery**: Creating `/users/{uid}` with backdated `createdAt` (`!= request.time`) -> `PERMISSION_DENIED`.
10. **Owner Immutability Hijack**: Updating `/registration_applications/{id}` to reassign `submittedByUid` to another user -> `PERMISSION_DENIED`.
11. **Value Poisoning (Type/Size Overflow)**: Updating `savedNote` in `/users/{uid}/preferences/workspace` with a 10,000-character string (`> 500`) -> `PERMISSION_DENIED`.
12. **Audit Log Tampering**: Even an administrator attempting `update` or `delete` on `/audit_logs/{logId}` -> `PERMISSION_DENIED`.
