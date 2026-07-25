/**
 * license-check.cjs
 *
 * Node-locked licensing for SenCode.
 *
 * Flow:
 *   1. On first launch, the user is prompted for a license key.
 *   2. The app computes a hardware fingerprint (via `systeminformation`,
 *      already a project dependency) and sends {key, fingerprint} to the
 *      license server's /activate endpoint.
 *   3. The server binds that key to that fingerprint (one machine per key,
 *      by default) and returns a signed JWT ("license token").
 *   4. The token is cached in the app's userData folder. On every launch,
 *      it's verified LOCALLY (signature + fingerprint match + expiry) with
 *      no network call needed — the app works offline.
 *   5. In the background, the app periodically re-validates the token with
 *      the server so a refunded/revoked license stops working. If the
 *      device is offline, a grace period (GRACE_DAYS) keeps the app usable
 *      until it can phone home again.
 *
 * Copying the installed app folder to a second machine breaks step 4:
 * the fingerprint baked into the cached token won't match the new
 * machine's fingerprint, so the app falls back to the activation prompt
 * on the new machine — where it will fail unless that key is reactivated
 * (see /reactivate on the server, which is rate-limited).
 *
 * NOTE ON THREAT MODEL: this stops casual copying (the scenario you
 * described — installing on someone else's laptop who didn't pay). It
 * does not stop a determined reverse-engineer from patching this file
 * out of the packaged app. No local-only check can fully prevent that;
 * this raises the bar to "requires deliberately cracking the app,"
 * which is enough for the overwhelming majority of small/indie software.
 */

'use strict';

const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const { app, BrowserWindow, ipcMain } = require('electron');

// ── Configuration ───────────────────────────────────────────────────────────

// Base URL of your deployed license server (see /server in this bundle).
const LICENSE_SERVER_URL =
  process.env.SENCODE_LICENSE_SERVER_URL || 'https://server-sencode.onrender.com';

// RSA public key that matches the private key held ONLY by your server.
// Paste the contents of server/keys/public.pem here at build time.
// It's fine for this to be public — it can verify signatures, not create them.
const LICENSE_PUBLIC_KEY ='-----BEGIN PUBLIC KEY-----\nMIIBIjANBgkqhkiG9w0BAQEFAAOCAQ8AMIIBCgKCAQEAw9tNUR2vLWnQnrPKlqsV\nAwQb11bLfcKJeRUsKY8jM3pCLnils7JX9jWi+C13xrhLfG9Yjqr/Q7pviFevw/Y1\nix+Ztl2gyh39iNlpvO+R81HyuhyUqBQrFWsWPgFcvSd5ZJolhdDn9h6tVV45rlI0\nejF7L+mEaBAvAiI/kS/lv5fdU9yoUgeQO1G/iFL3k5no8Q1eMNq3A+kjM6cKwT0L\ntcLwAmp8zVFxva204rT14LycRlSsVMb+nJ1mmMEpY3jk/34ZOcF2jXcNLpZjQB0Y\npL6S6SL09UFQEtZLvl9zuWXMA0VKKfrkj0d78e7Efop56i3FNZWcVdmqElkofvmY\nuwIDAQAB\n-----END PUBLIC KEY-----\n';

// How long the app will run on a cached token without reaching the server.
const GRACE_DAYS = 15;

// How often (in addition to every startup) to try a background revalidation.
const REVALIDATE_INTERVAL_MS = 12 * 60 * 60 * 1000; // 12h

function licenseFilePath() {
  return path.join(app.getPath('userData'), 'license.json');
}

// ── Machine fingerprint ──────────────────────────────────────────────────────

let _cachedFingerprint = null;

/**
 * Derives a stable machine ID from hardware identifiers via
 * `systeminformation`, then hashes it. We never send raw hardware
 * identifiers to the server — only the hash.
 */
async function getMachineFingerprint() {
  if (_cachedFingerprint) return _cachedFingerprint;

  const si = await import('systeminformation');

  const [system, osInfo, diskLayout] = await Promise.all([
    si.system(),
    si.osInfo(),
    si.diskLayout().catch(() => []),
  ]);

  const primaryDiskSerial =
    Array.isArray(diskLayout) && diskLayout[0] ? diskLayout[0].serialNum : '';

  const raw = [
    system.uuid || '',
    system.serial || '',
    osInfo.arch || '',
    osInfo.platform || '',
    primaryDiskSerial || '',
  ].join('|');

  _cachedFingerprint = crypto.createHash('sha256').update(raw).digest('hex');
  return _cachedFingerprint;
}

// ── Local token storage ───────────────────────────────────────────────────────

function readLocalLicense() {
  try {
    const raw = fs.readFileSync(licenseFilePath(), 'utf8');
    return JSON.parse(raw);
  } catch {
    return null;
  }
}

function writeLocalLicense(data) {
  fs.mkdirSync(path.dirname(licenseFilePath()), { recursive: true });
  fs.writeFileSync(licenseFilePath(), JSON.stringify(data, null, 2), 'utf8');
}

function clearLocalLicense() {
  try {
    fs.unlinkSync(licenseFilePath());
  } catch {
    /* not present, fine */
  }
}

// ── JWT verify (no external dependency — small manual RS256 check) ──────────
// We avoid pulling in the `jsonwebtoken` package for the app bundle (keeps
// asar smaller) and instead do the minimal RS256 verification by hand.
// If you'd rather not hand-roll this, `npm install jsonwebtoken` and swap
// this for `jwt.verify(token, LICENSE_PUBLIC_KEY, { algorithms: ['RS256'] })`.

function base64UrlDecode(input) {
  input = input.replace(/-/g, '+').replace(/_/g, '/');
  while (input.length % 4) input += '=';
  return Buffer.from(input, 'base64');
}

function verifyAndDecodeToken(token) {
  const parts = token.split('.');
  if (parts.length !== 3) throw new Error('Malformed token');
  const [headerB64, payloadB64, sigB64] = parts;

  const header = JSON.parse(base64UrlDecode(headerB64).toString('utf8'));
  if (header.alg !== 'RS256') throw new Error('Unexpected token algorithm');

  const verifier = crypto.createVerify('RSA-SHA256');
  verifier.update(`${headerB64}.${payloadB64}`);
  verifier.end();

  const signatureValid = verifier.verify(
    LICENSE_PUBLIC_KEY,
    base64UrlDecode(sigB64)
  );
  if (!signatureValid) throw new Error('Invalid token signature');

  const payload = JSON.parse(base64UrlDecode(payloadB64).toString('utf8'));
  return payload; // { sub: licenseKey, fp, revalidateBy, iat, ... }
}

// ── Server calls ──────────────────────────────────────────────────────────────

/**
 * Thrown when we genuinely couldn't reach the server (offline, DNS failure,
 * timeout, server down). Distinct from the server actively responding with
 * a rejection (bad key, revoked, wrong machine) — callers treat these very
 * differently: a network failure should never force re-activation.
 */
class NetworkUnavailableError extends Error {}

async function postJson(path, payload) {
  let res;
  try {
    res = await fetch(`${LICENSE_SERVER_URL}${path}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
      // 60s, not the usual few seconds — Render's free tier can take 50+
      // seconds to wake a sleeping instance on the first request after
      // idling. A short timeout here misreads "still waking up" as "can't
      // reach the server at all."
      signal: AbortSignal.timeout(60_000),
    });
  } catch (err) {
    // fetch() throws for DNS/connection/timeout failures — i.e. "offline."
    throw new NetworkUnavailableError(err.message);
  }

  const body = await res.json().catch(() => ({}));

  // 5xx = server-side problem, not a rejection of this license. Treat like
  // "couldn't reach it" so the user isn't forced through re-activation
  // because your server had a bad moment.
  if (res.status >= 500) {
    throw new NetworkUnavailableError(body.error || `Server error (HTTP ${res.status})`);
  }

  if (!res.ok) {
    throw new Error(body.error || `Request failed (HTTP ${res.status})`);
  }

  return body;
}

async function activateWithServer(licenseKey, fingerprint) {
  const body = await postJson('/activate', { licenseKey, fingerprint });
  return body.token; // signed JWT
}

async function revalidateWithServer(licenseKey, fingerprint, token) {
  const body = await postJson('/validate', { licenseKey, fingerprint, token });
  return body.token; // refreshed JWT
}

// ── Prompt window ─────────────────────────────────────────────────────────────

function showActivationWindow(prefillError) {
  return new Promise((resolve) => {
    const win = new BrowserWindow({
      width: 460,
      height: 320,
      resizable: false,
      title: 'Activate SenCode',
      autoHideMenuBar: true,
      webPreferences: {
        preload: path.join(__dirname, 'license-window-preload.cjs'),
        contextIsolation: true,
        nodeIntegration: false,
      },
    });

    win.loadFile(path.join(__dirname, 'license-window.html'));

    win.webContents.on('did-finish-load', () => {
      if (prefillError) {
        win.webContents.send('license:prefill-error', prefillError);
      }
    });

    const submitHandler = (_event, licenseKey) => {
      ipcMain.removeListener('license:submit', submitHandler);
      ipcMain.removeListener('license:cancel', cancelHandler);
      if (!win.isDestroyed()) win.close();
      resolve(licenseKey);
    };
    const cancelHandler = () => {
      ipcMain.removeListener('license:submit', submitHandler);
      ipcMain.removeListener('license:cancel', cancelHandler);
      if (!win.isDestroyed()) win.close();
      resolve(null);
    };

    ipcMain.once('license:submit', submitHandler);
    ipcMain.once('license:cancel', cancelHandler);

    win.on('closed', () => resolve(null));
  });
}

function showReconnectWindow() {
  return new Promise((resolve) => {
    const win = new BrowserWindow({
      width: 420,
      height: 240,
      resizable: false,
      title: 'SenCode — Reconnect required',
      autoHideMenuBar: true,
      webPreferences: {
        preload: path.join(__dirname, 'license-window-preload.cjs'),
        contextIsolation: true,
        nodeIntegration: false,
      },
    });

    win.loadFile(path.join(__dirname, 'reconnect-window.html'));

    const retryHandler = () => {
      ipcMain.removeListener('license:retry', retryHandler);
      ipcMain.removeListener('license:cancel', cancelHandler);
      if (!win.isDestroyed()) win.close();
      resolve(true);
    };
    const cancelHandler = () => {
      ipcMain.removeListener('license:retry', retryHandler);
      ipcMain.removeListener('license:cancel', cancelHandler);
      if (!win.isDestroyed()) win.close();
      resolve(false);
    };

    ipcMain.once('license:retry', retryHandler);
    ipcMain.once('license:cancel', cancelHandler);
    win.on('closed', () => resolve(false));
  });
}

// ── Public entry point ────────────────────────────────────────────────────────

/**
 * Call this BEFORE createWindow() in your app.whenReady() handler.
 * Resolves `true` if the app is licensed and should continue starting.
 * Resolves `false` if the user cancelled activation — caller should quit.
 */
let _licensingInProgress = false;

/**
 * True while an activation or reconnect window is being shown/processed.
 * main.cjs checks this in its window-all-closed handler so that closing
 * the (temporary) licensing window doesn't trigger app.quit() before the
 * real app window has had a chance to open.
 */
function isLicensingInProgress() {
  return _licensingInProgress;
}

async function ensureLicensed() {
  _licensingInProgress = true;
  try {
    return await ensureLicensedInner();
  } finally {
    _licensingInProgress = false;
  }
}

async function ensureLicensedInner() {
  const fingerprint = await getMachineFingerprint();
  let cached = readLocalLicense();

  // Try to verify whatever we have cached, locally, first.
  if (cached && cached.token) {
    try {
      const payload = verifyAndDecodeToken(cached.token);
      if (payload.fp !== fingerprint) {
        throw new Error('Token was issued for a different machine');
      }

      const revalidateBy = payload.revalidateBy * 1000;
      const graceDeadline = revalidateBy + GRACE_DAYS * 24 * 60 * 60 * 1000;

      if (Date.now() > graceDeadline) {
        // Grace period used up — we MUST reach the server before continuing.
        // Keep retrying against a "please reconnect" screen for as long as
        // the problem is network-shaped; only fall through to a forced
        // re-activation if the server itself rejects the license.
        for (;;) {
          try {
            const refreshed = await revalidateWithServer(
              cached.licenseKey,
              fingerprint,
              cached.token
            );
            writeLocalLicense({ licenseKey: cached.licenseKey, token: refreshed });
            scheduleBackgroundRevalidation(cached.licenseKey, fingerprint);
            return true;
          } catch (err) {
            if (err instanceof NetworkUnavailableError) {
              const shouldRetry = await showReconnectWindow();
              if (!shouldRetry) return false; // user chose to quit
              continue; // user chose to retry
            }
            // Server actively rejected it (revoked / bound elsewhere) —
            // this is a real problem, not just "offline." Force re-activation.
            throw err;
          }
        }
      }

      // Valid (possibly within grace period). Let the app start now, and
      // fire off a background revalidation to refresh the token quietly.
      scheduleBackgroundRevalidation(cached.licenseKey, fingerprint);
      backgroundRevalidateOnce(cached.licenseKey, fingerprint).catch(() => {});
      return true;
    } catch (err) {
      console.warn('[license] Cached token invalid:', err.message);
      clearLocalLicense();
      cached = null;
    }
  }

  // No valid cached license — prompt for a key and activate.
  let lastError = null;
  for (;;) {
    const licenseKey = await showActivationWindow(lastError);
    if (!licenseKey) return false; // user cancelled

    try {
      const token = await activateWithServer(licenseKey.trim(), fingerprint);
      writeLocalLicense({ licenseKey: licenseKey.trim(), token });
      scheduleBackgroundRevalidation(licenseKey.trim(), fingerprint);
      return true;
    } catch (err) {
      lastError =
        err instanceof NetworkUnavailableError
          ? "Couldn't reach the license server. Check your internet connection and try again."
          : err.message;
      console.warn('[license] Activation failed:', err.message, err.cause || '');
      // loop back to the prompt with the error shown
    }
  }
}

async function backgroundRevalidateOnce(licenseKey, fingerprint) {
  const cached = readLocalLicense();
  if (!cached) return;
  try {
    const refreshed = await revalidateWithServer(licenseKey, fingerprint, cached.token);
    writeLocalLicense({ licenseKey, token: refreshed });
    console.log('[license] Background revalidation OK.');
  } catch (err) {
    // Offline or server unreachable — fine, grace period covers this.
    console.warn('[license] Background revalidation failed (will retry later):', err.message);
  }
}

let _revalidateTimer = null;
function scheduleBackgroundRevalidation(licenseKey, fingerprint) {
  if (_revalidateTimer) return; // already scheduled for this session
  _revalidateTimer = setInterval(() => {
    backgroundRevalidateOnce(licenseKey, fingerprint).catch(() => {});
  }, REVALIDATE_INTERVAL_MS);
  _revalidateTimer.unref?.();
}

// ── License info (for the UI panel) ──────────────────────────────────────────

/**
 * Returns a snapshot of the current license state for display in the
 * "License & Device" panel. Never throws — returns null if no license is stored.
 */
async function getLicenseInfo() {
  const cached = readLocalLicense();
  if (!cached || !cached.token) return null;

  try {
    const payload = verifyAndDecodeToken(cached.token);
    const now = Date.now();
    const revalidateBy = payload.revalidateBy * 1000;
    const graceDeadline = revalidateBy + GRACE_DAYS * 24 * 60 * 60 * 1000;

    const msUntilRevalidate = revalidateBy - now;
    const daysUntilRevalidate = Math.ceil(msUntilRevalidate / (24 * 60 * 60 * 1000));

    const isInGrace = now > revalidateBy && now <= graceDeadline;
    const msGraceRemaining = graceDeadline - now;
    const graceRemaining = isInGrace
      ? Math.max(0, Math.ceil(msGraceRemaining / (24 * 60 * 60 * 1000)))
      : null;

    return {
      licenseKey: cached.licenseKey,
      status: 'active',
      revalidateBy: new Date(revalidateBy).toISOString(),
      daysUntilRevalidate,
      isInGrace,
      graceRemaining,
      graceDays: GRACE_DAYS,
    };
  } catch (err) {
    return { status: 'invalid', error: err.message };
  }
}

// ── Deactivate this device ─────────────────────────────────────────────────────

/**
 * Tells the license server to unbind this machine's fingerprint from the key,
 * then wipes the local license so the app will require activation on next launch.
 *
 * If the server call fails (offline, server down), we still wipe locally —
 * the server endpoint will detect a fingerprint mismatch on the next activation
 * attempt from another device and handle it gracefully via /reactivate.
 */
async function deactivateDevice() {
  const cached = readLocalLicense();
  const fingerprint = await getMachineFingerprint();

  if (cached && cached.licenseKey) {
    try {
      await postJson('/deactivate', { licenseKey: cached.licenseKey, fingerprint });
      console.log('[license] Server-side deactivation confirmed.');
    } catch (err) {
      // Network or server error — clear locally anyway so the key can be
      // used elsewhere. The server's /reactivate cooldown handles abuse.
      console.warn('[license] Server deactivation call failed (clearing locally anyway):', err.message);
    }
  }

  clearLocalLicense();
  return { ok: true };
}

module.exports = {
  ensureLicensed,
  isLicensingInProgress,
  getMachineFingerprint,
  clearLocalLicense,   // handy for a "deactivate this machine" menu item
  getLicenseInfo,      // for the License & Device panel
  deactivateDevice,    // full deactivation flow (server + local clear)
};
