# Changelog

All notable changes to the **Tier-069 TR-069 ACS Engine** (`ciniplay` Router Management Platform) are documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.0.0/), and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

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
