/**
 * backend-launcher.cjs
 *
 * Runs in the Electron main process. On app launch it checks whether a local
 * LLM backend (LM Studio or Ollama) is already serving on its default port,
 * and if not, tries to start one automatically so the user never has to
 * manually open LM Studio and click "Start Server" before using the app.
 *
 * Strategy per backend:
 *   1. Is it already up?              -> GET /v1/models
 *   2. If not, spawn the CLI command  -> `lms server start` / `ollama serve`
 *      (detached + unref'd so it keeps running independently of this app,
 *      and survives if the user quits CodeForge — same as starting it by
 *      hand)
 *   3. Poll the port for a while (backend + model load can take a few
 *      seconds) and report status back to the renderer via the callback.
 *
 * Nothing here touches user files or runs arbitrary/user-supplied commands —
 * only the two fixed, well-known local-server commands below.
 */

const { spawn } = require('child_process');
const http = require('http');
const os = require('os');
const path = require('path');
const fs = require('fs');

const LMSTUDIO_PORT = 1234;
const OLLAMA_PORT = 11434;

const POLL_INTERVAL_MS = 1500;
const POLL_MAX_TRIES = 17; // ~25s, matches the renderer's own retry window

/** Resolve GET http://localhost:PORT/v1/models with a short timeout. */
function checkPort(port, timeoutMs = 1200) {
  return new Promise((resolve) => {
    const req = http.get(
      { host: '127.0.0.1', port, path: '/v1/models', timeout: timeoutMs },
      (res) => {
        res.resume();
        resolve(res.statusCode != null && res.statusCode < 500);
      },
    );
    req.on('timeout', () => req.destroy());
    req.on('error', () => resolve(false));
  });
}

async function pollPort(port, sendStatus, state, backend) {
  for (let i = 0; i < POLL_MAX_TRIES; i++) {
    if (await checkPort(port)) return true;
    sendStatus({ state, backend, attempt: i + 1, maxAttempts: POLL_MAX_TRIES });
    await new Promise((r) => setTimeout(r, POLL_INTERVAL_MS));
  }
  return false;
}

/** Candidate executables for a command, in priority order. First existing/spawnable one wins. */
function candidatesFor(cmd) {
  const home = os.homedir();
  if (cmd === 'lms') {
    if (process.platform === 'win32') {
      const localAppData = process.env.LOCALAPPDATA || '';
      const appData = process.env.APPDATA || '';
      return [
        'lms',
        path.join(home, '.lmstudio', 'bin', 'lms.exe'),
        // Common LM Studio install locations on Windows
        path.join(localAppData, 'Programs', 'LM Studio', 'resources', 'app', 'bin', 'lms.exe'),
        path.join(localAppData, 'LM Studio', 'bin', 'lms.exe'),
        path.join(localAppData, 'lm-studio', 'bin', 'lms.exe'),
        path.join(appData, 'LM Studio', 'bin', 'lms.exe'),
        path.join('C:', 'Program Files', 'LM Studio', 'resources', 'app', 'bin', 'lms.exe'),
        path.join('C:', 'Program Files (x86)', 'LM Studio', 'resources', 'app', 'bin', 'lms.exe'),
      ];
    }
    return [
      'lms',
      path.join(home, '.lmstudio', 'bin', 'lms'),
      path.join(home, '.cache', 'lm-studio', 'bin', 'lms'),
      '/usr/local/bin/lms',
    ];
  }
  if (cmd === 'ollama') {
    return process.platform === 'win32'
      ? [
          'ollama',
          path.join(process.env.LOCALAPPDATA || '', 'Programs', 'Ollama', 'ollama.exe'),
          path.join('C:', 'Program Files', 'Ollama', 'ollama.exe'),
        ]
      : ['ollama', '/usr/local/bin/ollama', '/opt/homebrew/bin/ollama'];
  }
  return [cmd];
}

/**
 * Try each candidate binary for `cmd args...` until one actually spawns.
 * Detached + unref'd: the process keeps running after CodeForge exits,
 * exactly like starting it manually.
 */
function trySpawn(cmd, args) {
  return new Promise((resolve) => {
    const candidates = candidatesFor(cmd);
    let i = 0;

    const attemptNext = () => {
      if (i >= candidates.length) {
        resolve({ ok: false });
        return;
      }
      const bin = candidates[i++];

      // Skip absolute-path candidates that don't exist — avoids a noisy
      // ENOENT round-trip for every guessed install location.
      if (bin.includes(path.sep) && !fs.existsSync(bin)) {
        attemptNext();
        return;
      }

      let settled = false;
      let child;
      try {
        child = spawn(bin, args, { detached: true, stdio: 'ignore' });
      } catch {
        attemptNext();
        return;
      }

      child.once('error', () => {
        if (settled) return;
        settled = true;
        attemptNext();
      });

      // No synchronous error means the OS accepted the spawn — treat as
      // success and let polling confirm the server actually comes up.
      setImmediate(() => {
        if (settled) return;
        settled = true;
        child.unref();
        resolve({ ok: true, bin });
      });
    };

    attemptNext();
  });
}

/**
 * Main entry point. Checks both backends, starts whichever is missing (LM
 * Studio first, then Ollama as a fallback), and streams progress via
 * sendStatus(). Safe to call again later (e.g. a "Retry" button).
 */
async function ensureBackend(sendStatus) {
  sendStatus({ state: 'checking' });

  if (await checkPort(LMSTUDIO_PORT)) {
    sendStatus({ state: 'connected', backend: 'lmstudio' });
    return;
  }
  if (await checkPort(OLLAMA_PORT)) {
    sendStatus({ state: 'connected', backend: 'ollama' });
    return;
  }

  // Nothing running yet — try to launch LM Studio's server first, since
  // it's this app's primary/documented backend.
  sendStatus({ state: 'starting', backend: 'lmstudio' });

  // Try the lms CLI first (starts the server headlessly)
  const lmAttempt = await trySpawn('lms', ['server', 'start']);

  if (lmAttempt.ok) {
    const up = await pollPort(LMSTUDIO_PORT, sendStatus, 'starting', 'lmstudio');
    if (up) {
      sendStatus({ state: 'connected', backend: 'lmstudio' });
      return;
    }
  }

  // lms CLI not found — try launching the LM Studio GUI app itself on Windows,
  // which auto-starts its local server when it opens.
  if (process.platform === 'win32') {
    const lmGuiAttempt = await trySpawnLmStudioGui();
    if (lmGuiAttempt.ok) {
      // GUI takes longer to come up — give it more time
      const up = await pollPort(LMSTUDIO_PORT, sendStatus, 'starting', 'lmstudio');
      if (up) {
        sendStatus({ state: 'connected', backend: 'lmstudio' });
        return;
      }
    }
  }

  // LM Studio's CLI wasn't found or didn't come up in time — fall back to Ollama.
  sendStatus({ state: 'starting', backend: 'ollama' });
  const ollamaAttempt = await trySpawn('ollama', ['serve']);

  if (ollamaAttempt.ok) {
    const up = await pollPort(OLLAMA_PORT, sendStatus, 'starting', 'ollama');
    if (up) {
      sendStatus({ state: 'connected', backend: 'ollama' });
      return;
    }
  }

  sendStatus({
    state: 'failed',
    message: lmAttempt.ok
      ? "LM Studio's server didn't respond in time. Open LM Studio, load a model, and enable the server, then hit Retry."
      : "Couldn't auto-start LM Studio or Ollama. Open LM Studio (or Ollama), start the server, then hit Retry.",
  });
}

/**
 * Try to launch the LM Studio GUI application directly on Windows.
 * LM Studio's GUI will auto-start its local API server on port 1234.
 */
function trySpawnLmStudioGui() {
  return new Promise((resolve) => {
    const localAppData = process.env.LOCALAPPDATA || '';
    const candidates = [
      path.join(localAppData, 'Programs', 'LM Studio', 'LM Studio.exe'),
      path.join(localAppData, 'LM Studio', 'LM Studio.exe'),
      path.join('C:', 'Program Files', 'LM Studio', 'LM Studio.exe'),
      path.join('C:', 'Program Files (x86)', 'LM Studio', 'LM Studio.exe'),
    ].filter((p) => fs.existsSync(p));

    if (candidates.length === 0) {
      resolve({ ok: false });
      return;
    }

    let settled = false;
    let child;
    try {
      child = spawn(candidates[0], [], { detached: true, stdio: 'ignore' });
    } catch {
      resolve({ ok: false });
      return;
    }

    child.once('error', () => {
      if (settled) return;
      settled = true;
      resolve({ ok: false });
    });

    setImmediate(() => {
      if (settled) return;
      settled = true;
      child.unref();
      resolve({ ok: true, bin: candidates[0] });
    });
  });
}

module.exports = { ensureBackend, checkPort, LMSTUDIO_PORT, OLLAMA_PORT };
