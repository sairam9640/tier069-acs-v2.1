# Changelog

All notable changes to the **Tier-069 TR-069 ACS Engine** (`ciniplay` Router Management Platform) are documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.0.0/), and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [v2.1.7] - 2026-08-21

### 🛡️ Device Onboarding Validation & Quarantine Protection
- **First-Time Device Quarantine:** All newly discovered devices informing for the first time without pre-provisioned records are quarantined with `status: 'UNVERIFIED'`, `isVerified: false`, and `quarantined: true`, preventing unapproved phantom entries in live subscriber lists.
- **Serial Plausibility & Format Validation:** Rejects and drops malformed or implausible serial numbers (non-alphanumeric, length < 4 or > 64) with `HTTP 204` without touching MongoDB.
- **Operator Verification Endpoint:** Implemented `POST /api/devices/:id/verify` for authorized operators to approve unverified devices into active fleet monitoring.
- **Test Artifact Cleanup:** Purged phantom test record `TP-Link_LIVE_TEST_SN_999` from MongoDB.

---

## [v2.1.5] - 2026-08-21

### 🛡️ Comprehensive Security Hardening & Audit Remediations
- **Nginx HTTP → HTTPS 301 Redirect:** Configured port 80 in Nginx to return `301 Moved Permanently` to `https://ciniplay.in/` for all web and API routes, while preserving proxying for non-TLS TR-069 CPEs.
- **Command Injection Prevention:** Replaced `exec` shell execution in ping diagnostics with `execFile` parameter arrays and strict IPv4 octet regex validation. Removed unused `child_process` imports across OLT collectors.
- **Dual-Scope Rate Limiting:** Enforced both per-IP and per-account rate limiters to block distributed multi-IP brute-force attacks against operator and superadmin accounts.
- **Expanded Tenant Isolation:** Verified 100% tenant isolation across all mutation operations (Wi-Fi SSID/password push, WAN deletion/edit, remote reboot, and factory reset RPCs).
- **DOM XSS Sanitization:** Audited and verified `escapeHtml()` across all subscriber name, SSID, and device identifier rendering paths in `public/app.js`.

---

## [v2.1.2] - 2026-08-21

### 🔒 Strict Production Loopback Refusal & Payload Identifier Fix
- **Production Loopback Blocking:** If `BILLING_WEBHOOK_URL` resolves to `127.0.0.1`, `localhost`, or RFC1918 private subnets, sync requests are refused with status `BLOCKED_LOOPBACK_IN_PRODUCTION` and `billingSynced: false`. Loopback delivery is only permitted when explicitly authorized via `ALLOW_LOOPBACK_BILLING=true` in `.env` for development/testing.
- **Payload Customer Identifier Fix:** Guaranteed subscriber identifier resolution across all WAN sync and dry-run health-check payloads (`username: 'admin_health_check'` / subscriber PPPoE ID), eliminating `undefined` references in billing response messages.

---

## [v2.1.1] - 2026-08-21

### 🛡️ Billing & Radius Sync Production Hardening
- **Zero Fallback Defaults & Loud Failure:** Removed hardcoded URLs and secrets. The service now fails loudly with `FATAL CONFIG` warnings if `BILLING_WEBHOOK_URL` or `BILLING_WEBHOOK_SECRET` are missing in `.env`.
- **Loopback Detection:** Warns operators when `BILLING_WEBHOOK_URL` points to `127.0.0.1`, `localhost`, or private RFC1918 subnets.
- **Queue Sweeper & Drain Job:** `drainBillingSyncQueue` runs every 3 minutes, re-attempting pending/failed syncs and escalating items that exceed 8 retries or 24 hours to `NEEDS_MANUAL_REVIEW`.
- **Dry-Run Connection Validator:** Added `/api/billing/test-connection` admin endpoint for live ping and HMAC latency tests.
- **Strict Success Verification:** `billingSynced: true` is strictly reserved for verified external 2xx HTTP delivery.
- **Authentication Documentation:** Added formal HMAC-SHA256 protocol specification and multi-provider adaptation guidelines (Bearer/OAuth2/Basic Auth/API Key) at the top of `billing-sync-service.js`.

---

## [v2.1.0] - 2026-08-21

### 🚀 Major Improvements & New Features

#### 1. Versioned Locking & Conflict Resolution (Issue 1 & Gap 3)
- **120-Second Protection Window:** Implemented `LOCK_WINDOW_MS = 120,000` to prevent stale periodic informs (`2 PERIODIC`) from overwriting operator-pushed Wi-Fi SSIDs, passphrases, and WAN credentials.
- **Event-Aware Branching:** The normalizer inspects TR-069 `informEvents`. If an incoming inform carries `4 VALUE CHANGE`, it is recognized as a legitimate customer-side modification and accepted into the database with a `CUSTOMER_LOCAL_CHANGE` audit log.
- **Config Versioning:** Increments `configVersion` and updates `lastConfigModified` on all manual pushes.

#### 2. CGNAT & Connection Request Backoff with Task Expiry (Issue 2 & Gap 4)
- **Connection Request Retry Loop:** Added 3-attempt dispatch with exponential backoff (initial timeout 2000ms + 500ms backoff per retry) in `lib/cwmp/connection-request.js`.
- **Automated Task Expiry Sweeper:** Background interval runs every 2 minutes (`setInterval`) in `lib/cwmp/cwmp-server.js` calling `db.expireStaleDeviceTasks(10 * 60 * 1000)` to mark unreached NAT tasks as `EXPIRED`.
- **UI Status Indicators:** Clear alerts on the device view for `PENDING`, `EXPIRED`, `FAILED`, and `COMPLETED` tasks.

#### 3. Read-Back Verification Pipeline & 1-Time Auto-Retry (Issue 3 & Gap 5)
- **Read-Back Comparison:** In `cwmp-server.js`, `handleGetParameterValuesResponse` compares returned parameter values against `session.verifyingTask.expectedValue`.
- **Automatic 1-Time Retry:** If a mismatch occurs, the ACS re-queues the task for an immediate second attempt before marking it as failed.
- **Explicit Failure State:** If read-back fails after retry, the task is marked `FAILED`, `dev.wifi.lastApplyFailed = true` is set, and the UI displays a red failure banner showing the reverted hardware value.

#### 4. Cryptographic Billing/Radius Webhook Reliability (Issue 4 & Gap 6)
- **HMAC-SHA256 Security:** Requests to the external Billing/Radius webhook are authenticated via `X-Billing-Signature: sha256=<hmac>` computed from timestamp + body payload.
- **Zero Plaintext Secrets on Wire:** Removed redundant `Authorization: Bearer` and `X-Webhook-Secret` plaintext headers so secrets are never transmitted across the network.
- **Retry with Exponential Backoff:** 3-attempt dispatch with backoff on network failures.
- **Local Fallback Persistence:** Failed syncs are persisted in MongoDB `billing_sync_queue` with idempotency keys (`sync_${deviceId}_v${configVersion}_${timestamp}`) and tracked via `billingSynced: true/false`.

#### 5. Band-Specific Parameter Path Consistency (Issue 5)
- **Dynamic Multi-Vendor Resolution:** Explicitly maps `WLANConfiguration.1` for 2.4 GHz (channels 1–14) and `WLANConfiguration.5` / `6` for 5.0 GHz (channels 36+) across TP-Link (XC220, Archer C6), Syrotech Realtek, and Genexis Platinum ONTs.
- **Multi-Key Bundling:** Simultaneously sets `KeyPassphrase`, `X_TP_PreSharedKey`, and `PreSharedKey.1.KeyPassphrase` to ensure compatibility across vendor firmware variants.

---

*Tier-069 TR-069 ACS Engine - Maintained by Ciniplay NOC Systems Engineering.*
