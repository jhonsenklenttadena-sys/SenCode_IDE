/**
 * Electron main process for SenCode.
 *
 * - Creates the app window and loads the React renderer.
 * - Loads GGUF models directly via node-llama-cpp (no LM Studio / Ollama needed).
 * - Detects hardware on startup and picks the best available model.
 * - Streams LLM inference back to the renderer via IPC.
 * - Models live OUTSIDE the app bundle (sibling folder on flash drive,
 *   or resources/Models in an installed build).
 */

const { app, BrowserWindow, ipcMain, dialog } = require('electron');
const path = require('path');
const fs   = require('fs');
const { ensureLicensed, isLicensingInProgress, getLicenseInfo, deactivateDevice } = require('./license-check.cjs');

const {
  scanModels,
  streamCompletion,
  buildModelsResponse,
  unloadModel,
  modelsDirExists,
  getModelsDir,
} = require('./llama-engine.cjs');

const {
  detectHardware,
  checkModelSuitability,
  pickBestModel,
} = require('./hardware-detect.cjs');

const {
  saveSession,
  listSessions,
  loadSession,
  deleteSession,
  pinSession,
  runCleanup,
  loadMemory,
} = require('./session-store.cjs');

const { detectRuntimes, getRuntimeForLang, getSyntaxCheckerInfo } = require('./runtime-detect.cjs');

// ── Global state ──────────────────────────────────────────────────────────────
let mainWindow   = null;
let lastStatus   = { state: 'idle' };
let cachedHardware = null;   // filled once on startup

function sendStatus(status) {
  lastStatus = status;
  if (mainWindow && !mainWindow.isDestroyed()) {
    mainWindow.webContents.send('backend-status', status);
  }
}

// ── Window ────────────────────────────────────────────────────────────────────
function createWindow() {
  mainWindow = new BrowserWindow({
    width : 1440,
    height: 900,
    minWidth : 1024,
    minHeight: 700,
    backgroundColor: '#0b0e14',
    autoHideMenuBar: true,
    title: 'SenCode',
    icon: path.join(__dirname, '..', 'build', 'icon.ico'),
    webPreferences: {
      preload         : path.join(__dirname, 'preload.cjs'),
      contextIsolation: true,
      nodeIntegration : false,
      sandbox         : false,
      webviewTag      : true,
    },
  });

  const devUrl = process.env.ELECTRON_START_URL;
  if (devUrl) {
    mainWindow.loadURL(devUrl);
  } else {
    mainWindow.loadFile(path.join(app.getAppPath(), 'dist', 'index.html'));
  }

  mainWindow.on('closed', () => { mainWindow = null; });

  mainWindow.webContents.on('render-process-gone', (_e, details) => {
    console.error('[main] Renderer process gone:', details);
  });
  mainWindow.webContents.on('did-fail-load', (_e, code, desc, url) => {
    console.error('[main] Failed to load:', code, desc, url);
  });
  mainWindow.webContents.on('did-finish-load', () => {
    console.log('[main] Page loaded OK');
    if (process.env.ELECTRON_START_URL) {
      mainWindow.webContents.openDevTools();
    }
  });
}

// ── Startup ───────────────────────────────────────────────────────────────────
app.whenReady().then(async () => {
  const licensed = await ensureLicensed();
  if (!licensed) {
    app.quit();
    return;
  }

  createWindow();

  try {
    const deleted = runCleanup(15);
    if (deleted > 0) console.log(`[main] Auto-cleaned ${deleted} expired session(s) on startup.`);
  } catch (e) {
    console.warn('[main] Session cleanup error:', e.message);
  }

  try {
    cachedHardware = await detectHardware();
    if (mainWindow && !mainWindow.isDestroyed()) {
      mainWindow.webContents.send('hardware-info', cachedHardware);
    }
  } catch (e) {
    console.error('[main] Hardware detection failed:', e.message);
    cachedHardware = { tier: 'low', tierLabel: 'Unknown', maxModelSizeGB: 5, contextSize: 4096, ramGB: 0, gpus: [] };
  }

  if (!modelsDirExists()) {
    const modelsPath = getModelsDir();
    sendStatus({
      state  : 'failed',
      message: `Models folder not found.\n\nPlease create a "Models" folder next to the app and add GGUF files.\n\nExpected location: ${modelsPath}`,
    });
    return;
  }

  const models = scanModels();
  if (models.length === 0) {
    sendStatus({
      state  : 'failed',
      message: `No GGUF models found in: ${getModelsDir()}\n\nAdd one or more .gguf model files and click Retry.`,
    });
    return;
  }

  const bestId = pickBestModel(models, cachedHardware);
  console.log('[main] Auto-selected model:', bestId);

  sendStatus({
    state       : 'connected',
    backend     : 'local',
    autoSelected: bestId,
    hardware    : cachedHardware,
  });

  const modelsDir = getModelsDir();
  try {
    fs.watch(modelsDir, { recursive: true }, (eventType, filename) => {
      if (!filename) return;
      if (!filename.toLowerCase().endsWith('.gguf')) return;
      console.log(`[main] Models folder changed (${eventType}): ${filename} — refreshing model list`);
      const updatedModels = scanModels();
      const updatedBestId = pickBestModel(updatedModels, cachedHardware ?? { tier: 'low' });
      sendStatus({
        state       : 'connected',
        backend     : 'local',
        autoSelected: updatedBestId,
        hardware    : cachedHardware,
      });
    });
    console.log('[main] Watching Models folder for new .gguf files:', modelsDir);
  } catch (e) {
    console.warn('[main] Could not watch Models folder:', e.message);
  }

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });
});

app.on('window-all-closed', async () => {
  if (isLicensingInProgress()) return; // don't quit while the activation/reconnect window is up

  await unloadModel().catch(() => {});
  if (process.platform !== 'darwin') app.quit();
});

// ── IPC: backend lifecycle ────────────────────────────────────────────────────
ipcMain.handle('backend:get-status', () => lastStatus);

ipcMain.handle('backend:restart', async () => {
  if (!modelsDirExists()) {
    sendStatus({
      state  : 'failed',
      message: `Models folder not found at: ${getModelsDir()}\n\nCreate a "Models" folder next to the app and add .gguf files, then click Retry.`,
    });
    return lastStatus;
  }
  const models = scanModels();
  if (models.length === 0) {
    sendStatus({ state: 'failed', message: `No GGUF models found in: ${getModelsDir()}` });
    return lastStatus;
  }
  const bestId = pickBestModel(models, cachedHardware ?? { tier: 'low' });
  sendStatus({ state: 'connected', backend: 'local', autoSelected: bestId, hardware: cachedHardware });
  return lastStatus;
});

// ── IPC: hardware info ────────────────────────────────────────────────────────
ipcMain.handle('hardware:get-info', () => cachedHardware ?? null);

// ── IPC: model suitability check ─────────────────────────────────────────────
ipcMain.handle('hardware:check-model', (_event, modelEntry) => {
  if (!cachedHardware) return { ok: true, warning: false, blocked: false, reason: '' };
  return checkModelSuitability(modelEntry, cachedHardware);
});

// ── IPC: license & device ─────────────────────────────────────────────────────

ipcMain.handle('license:get-info', async () => {
  try {
    return await getLicenseInfo();
  } catch (err) {
    console.warn('[main] license:get-info error:', err.message);
    return null;
  }
});

ipcMain.handle('license:deactivate', async () => {
  try {
    const result = await deactivateDevice();
    return result;
  } catch (err) {
    console.warn('[main] license:deactivate error:', err.message);
    return { ok: false, error: err.message };
  }
});

ipcMain.handle('app:quit', () => {
  app.quit();
});

// ── IPC: model list ───────────────────────────────────────────────────────────
ipcMain.handle('llm:get-models', async () => {
  try {
    const body = buildModelsResponse();
    return { ok: true, status: 200, body };
  } catch (e) {
    return { ok: false, status: 500, body: '', error: e.message };
  }
});

// ── IPC: local LLM streaming chat ────────────────────────────────────────────
const activeStreams = new Map();

ipcMain.on('llm:stream-start', async (event, { requestId, body }) => {
  let cancelled = false;
  activeStreams.set(requestId, { cancel: () => { cancelled = true; } });

  const sendChunk = (chunk) => {
    if (!event.sender.isDestroyed()) {
      event.sender.send('llm:stream-chunk', requestId, chunk);
    }
  };

  try {
    const parsed  = JSON.parse(body);
    const modelId = parsed.model;

    const allModels = scanModels();
    const found = allModels.find((m) => m.id === modelId || m.name === modelId);
    if (!found) {
      const available = allModels.map((m) => m.id).join(', ') || 'none';
      sendChunk(JSON.stringify({ error: `Model not found: "${modelId}". Available: ${available}` }));
      sendChunk('[DONE]');
      return;
    }

    const suitability = cachedHardware
      ? checkModelSuitability({ ...found }, cachedHardware)
      : { ok: true };

    if (!suitability.ok) {
      sendChunk(JSON.stringify({
        error: `Model cannot be loaded on current device configuration (RAM/CPU/GPU limits).\n\n${suitability.reason}\n\nPlease choose a smaller model.`,
      }));
      sendChunk('[DONE]');
      return;
    }

    if (cancelled) { sendChunk('[DONE]'); return; }

    await streamCompletion(
      event, found.path, parsed.messages ?? [],
      { temperature: parsed.temperature ?? 0.7, maxTokens: parsed.max_tokens ?? 2048, topP: parsed.top_p ?? 0.9 },
      requestId,
      cachedHardware,
    );

  } catch (e) {
    console.error('[main] stream error:', e);
    let userMsg = e.message || 'Unknown error';
    if (userMsg.includes('unknown model architecture')) {
      const arch = userMsg.match(/unknown model architecture: '([^']+)'/)?.[1] ?? 'unknown';
      userMsg = `Model architecture "${arch}" is not supported. Try a different model.`;
    }
    if (userMsg.includes('out of memory') || userMsg.includes('CUDA out of memory') || userMsg.includes('failed to allocate')) {
      userMsg = `Model cannot be loaded on current device configuration (RAM/CPU/GPU limits). Please choose a smaller model.\n\nDetails: ${userMsg}`;
    }
    sendChunk(JSON.stringify({ error: userMsg }));
    sendChunk('[DONE]');
  } finally {
    activeStreams.delete(requestId);
  }
});

ipcMain.on('llm:stream-abort', (_event, { requestId }) => {
  const stream = activeStreams.get(requestId);
  if (stream) { stream.cancel(); activeStreams.delete(requestId); }
});

// ── Shared rich PATH builder (used by both terminal:run and syntax checkers) ─
function buildChildEnv() {
  const systemPath = process.env.PATH || '';
  const userPath   = (() => {
    try {
      return require('child_process').execSync(
        'powershell.exe -NonInteractive -NoProfile -Command "[System.Environment]::GetEnvironmentVariable(\'Path\',\'User\')"',
        { encoding: 'utf8', timeout: 3000 }
      ).trim();
    } catch { return ''; }
  })();

  const runtimeDirs = [];

  const tryAdd = (...segments) => {
    const p = path.join(...segments);
    try { if (fs.existsSync(p)) runtimeDirs.push(p); } catch {}
  };

  // Rust / cargo
  tryAdd(os.homedir(), '.cargo', 'bin');
  tryAdd(os.homedir(), '.rustup', 'bin');

  // Node.js
  tryAdd('C:\\Program Files\\nodejs');
  tryAdd(os.homedir(), 'AppData', 'Roaming', 'npm');

  // Python
  for (const ver of ['314','313','312','311','310','39']) {
    tryAdd(`C:\\Python${ver}`);
    tryAdd(os.homedir(), 'AppData', 'Local', 'Programs', 'Python', `Python${ver}`);
    tryAdd(os.homedir(), 'AppData', 'Local', 'Programs', 'Python', `Python${ver}`, 'Scripts');
  }

  // Java — scan all known JDK installation roots
  for (const base of [
    'C:\\Program Files\\Java',                // Oracle JDK (classic)
    'C:\\Program Files\\Eclipse Adoptium',    // Temurin (Adoptium)
    'C:\\Program Files\\Microsoft',           // Microsoft OpenJDK
    'C:\\Program Files\\BellSoft',            // Liberica JDK
    'C:\\Program Files\\Amazon Corretto',     // Amazon Corretto
    'C:\\Program Files\\Zulu',                // Azul Zulu
    'C:\\Program Files\\Semeru',              // IBM Semeru
    'C:\\Program Files\\ojdkbuild',           // ojdkbuild
    'C:\\Program Files\\SapMachine',          // SAP Machine
  ]) {
    try {
      if (!fs.existsSync(base)) continue;
      for (const d of fs.readdirSync(base)) {
        tryAdd(base, d, 'bin');
        // Some distros nest as <root>/<product>/<version>/bin
        try {
          const sub = path.join(base, d);
          for (const v of fs.readdirSync(sub)) {
            tryAdd(sub, v, 'bin');
          }
        } catch {}
      }
    } catch {}
  }
  tryAdd('C:\\Program Files\\Common Files\\Oracle\\Java\\javapath');
  // JAVA_HOME takes highest precedence when explicitly set
  if (process.env.JAVA_HOME) tryAdd(process.env.JAVA_HOME, 'bin');
  // SDKMAN (Linux/macOS)
  tryAdd(os.homedir(), '.sdkman', 'candidates', 'java', 'current', 'bin');
  // Homebrew (macOS Intel + Apple Silicon)
  for (const brew of ['/usr/local/opt', '/opt/homebrew/opt']) {
    try {
      if (!fs.existsSync(brew)) continue;
      for (const d of fs.readdirSync(brew)) {
        if (/^openjdk/.test(d)) tryAdd(brew, d, 'bin');
      }
    } catch {}
  }
  // Linux: common alternatives paths
  try {
    const altJava = '/usr/lib/jvm';
    if (fs.existsSync(altJava)) {
      for (const d of fs.readdirSync(altJava)) {
        tryAdd(altJava, d, 'bin');
      }
    }
  } catch {}

  // Go
  tryAdd('C:\\Program Files\\Go', 'bin');
  tryAdd(os.homedir(), 'go', 'bin');

  // Ruby (RubyInstaller — C:\RubyXX-x64\bin)
  try {
    for (const d of fs.readdirSync('C:\\')) {
      if (/^Ruby\d/i.test(d)) tryAdd('C:\\', d, 'bin');
    }
  } catch {}

  // PHP
  tryAdd('C:\\php');
  tryAdd('C:\\Program Files\\PHP');

  // .NET
  tryAdd('C:\\Program Files\\dotnet');

  // Perl (Strawberry)
  tryAdd('C:\\Strawberry\\perl\\bin');
  tryAdd('C:\\Strawberry\\c\\bin');
  tryAdd('C:\\Perl64\\bin');

  // Lua
  tryAdd('C:\\Program Files (x86)\\Lua\\5.1');
  tryAdd('C:\\Program Files\\Lua');

  // Dart / Flutter
  tryAdd(os.homedir(), 'AppData', 'Local', 'Pub', 'Cache', 'bin');
  tryAdd('C:\\tools\\dart-sdk\\bin');
  tryAdd('C:\\flutter\\bin');

  // Kotlin
  tryAdd('C:\\ProgramData\\chocolatey\\bin');
  tryAdd(os.homedir(), 'AppData', 'Local', 'Kotlin', 'bin');

  // Scala
  tryAdd('C:\\Program Files (x86)\\scala\\bin');
  tryAdd('C:\\Program Files\\scala\\bin');
  tryAdd(os.homedir(), 'AppData', 'Local', 'Coursier', 'data', 'bin');

  // R
  try {
    const rBase = 'C:\\Program Files\\R';
    if (fs.existsSync(rBase)) {
      for (const d of fs.readdirSync(rBase)) {
        const b64 = path.join(rBase, d, 'bin', 'x64');
        const b   = path.join(rBase, d, 'bin');
        if (fs.existsSync(b64)) runtimeDirs.push(b64);
        else if (fs.existsSync(b)) runtimeDirs.push(b);
      }
    }
  } catch {}

  // Julia
  tryAdd(os.homedir(), 'AppData', 'Local', 'Programs', 'Julia', 'bin');
  tryAdd('C:\\Program Files\\Julia', 'bin');

  // Swift / Elixir
  tryAdd(os.homedir(), 'AppData', 'Local', 'Programs', 'Swift', 'bin');
  tryAdd(os.homedir(), 'AppData', 'Local', 'Programs', 'Elixir', 'bin');

  // Group 3 — Erlang OTP
  tryAdd('C:\\Program Files\\Erlang OTP\\bin');
  try {
    const erlBase = 'C:\\Program Files';
    if (fs.existsSync(erlBase)) {
      for (const d of fs.readdirSync(erlBase)) {
        if (/^Erlang/i.test(d)) tryAdd(erlBase, d, 'bin');
      }
    }
  } catch {}

  // Group 3 — Haskell / GHCup
  tryAdd('C:\\ghcup\\bin');
  tryAdd(os.homedir(), 'AppData', 'Roaming', 'ghcup', 'bin');
  tryAdd(os.homedir(), 'AppData', 'Local', 'Programs', 'ghcup', 'bin');
  try {
    const ghcupData = path.join(os.homedir(), 'AppData', 'Roaming', 'ghcup', 'ghc');
    if (fs.existsSync(ghcupData)) {
      for (const ver of fs.readdirSync(ghcupData)) {
        tryAdd(ghcupData, ver, 'bin');
      }
    }
  } catch {}

  // Group 3 — Groovy
  tryAdd('C:\\Program Files\\Groovy\\bin');
  tryAdd('C:\\groovy\\bin');
  if (process.env.GROOVY_HOME) tryAdd(process.env.GROOVY_HOME, 'bin');

  // Group 3 — Clojure (already covered by chocolatey above, also check direct)
  tryAdd('C:\\Program Files\\Clojure');

  // Group 3 — Crystal
  tryAdd('C:\\crystal\\bin');
  tryAdd('C:\\Program Files\\crystal\\bin');

  // Generic local bin
  tryAdd(os.homedir(), '.local', 'bin');

  // !! DO NOT MODIFY — LLVM MinGW linker (Rust compilation working) !!
  tryAdd('C:\\Program Files\\LLVM-MinGW\\bin');
  tryAdd('C:\\Program Files\\LLVM-MinGW-UCRT\\bin');
  tryAdd(os.homedir(), 'AppData', 'Local', 'LLVM-MinGW', 'bin');

  // Group 7 — LaTeX / MiKTeX
  tryAdd('C:\\Program Files\\MiKTeX\\miktex\\bin\\x64');
  tryAdd('C:\\Program Files\\MiKTeX\\miktex\\bin');
  tryAdd('C:\\Program Files (x86)\\MiKTeX 2.9\\miktex\\bin');
  tryAdd(os.homedir(), 'AppData', 'Local', 'Programs', 'MiKTeX', 'miktex', 'bin', 'x64');

  // Group 7 — GNU Octave
  try {
    const octBase = 'C:\\Program Files\\GNU Octave';
    if (fs.existsSync(octBase)) {
      for (const d of fs.readdirSync(octBase)) {
        tryAdd(octBase, d, 'bin');
        tryAdd(octBase, d, 'mingw64', 'bin');
      }
    }
  } catch {}

  // Group 7 — Wolfram Engine / Mathematica
  try {
    const wolfBase = 'C:\\Program Files\\Wolfram Research';
    if (fs.existsSync(wolfBase)) {
      for (const prod of fs.readdirSync(wolfBase)) {
        const prodDir = path.join(wolfBase, prod);
        try {
          for (const ver of fs.readdirSync(prodDir)) {
            tryAdd(prodDir, ver);
          }
        } catch {}
      }
    }
  } catch {}

  // Group 7 — SAS
  try {
    const sasBase = 'C:\\Program Files\\SASHome';
    if (fs.existsSync(sasBase)) {
      for (const d of fs.readdirSync(sasBase)) {
        tryAdd(sasBase, d, 'SASFoundation', '9.4');
        tryAdd(sasBase, d, 'SASFoundation', '9.4', 'core', 'sasexe');
      }
    }
  } catch {}

  // Group 7 — GnuCOBOL
  tryAdd('C:\\gnucobol\\bin');
  tryAdd('C:\\Program Files\\GnuCOBOL\\bin');

  // Group 7 — Ada (GNAT)
  tryAdd('C:\\GNAT\\bin');
  try {
    for (const base of ['C:\\GNAT', 'C:\\Program Files\\GNAT']) {
      if (!fs.existsSync(base)) continue;
      for (const d of fs.readdirSync(base)) {
        tryAdd(base, d, 'bin');
      }
    }
  } catch {}

  // Group 7 — D (DMD)
  tryAdd('C:\\D\\dmd2\\windows\\bin');
  tryAdd('C:\\Program Files\\D\\dmd2\\windows\\bin');

  // Group 7 — Nim
  tryAdd('C:\\nim\\bin');
  tryAdd('C:\\Program Files\\Nim\\bin');
  tryAdd(os.homedir(), 'AppData', 'Local', 'Programs', 'Nim', 'bin');
  tryAdd(os.homedir(), '.nimble', 'bin');

  // Group 7 — Zig
  tryAdd('C:\\zig');
  tryAdd('C:\\Program Files\\Zig');
  tryAdd(os.homedir(), 'AppData', 'Local', 'Programs', 'Zig');

  // Group 7 — V (vlang)
  tryAdd('C:\\v');
  tryAdd('C:\\Program Files\\v');
  tryAdd(os.homedir(), 'AppData', 'Local', 'Programs', 'v');

  // Scan winget packages for relevant installs
  try {
    const wingetPkgs = path.join(os.homedir(), 'AppData', 'Local', 'Microsoft', 'WinGet', 'Packages');
    if (fs.existsSync(wingetPkgs)) {
      for (const pkg of fs.readdirSync(wingetPkgs)) {
        const lp = pkg.toLowerCase();
        const relevant = lp.includes('llvm') || lp.includes('mingw') || lp.includes('php') ||
                         lp.includes('perl') || lp.includes('lua')  || lp.includes('dart') ||
                         lp.includes('swift')|| lp.includes('elixir')|| lp.includes('julia') ||
                         lp.includes('ruby') || lp.includes('kotlin')|| lp.includes('golang') ||
                         lp.includes('rproject') || lp.includes('msys2') || lp.includes('erlang') ||
                         lp.includes('ghcup') || lp.includes('groovy') || lp.includes('crystal') ||
                         lp.includes('miktex') || lp.includes('octave') || lp.includes('wolfram') ||
                         lp.includes('gnucobol') || lp.includes('adacore') || lp.includes('nim') ||
                         lp.includes('zig') || lp.includes('vlang') || lp.includes('scala') ||
                         lp.includes('hadolint') || lp.includes('protobuf') || lp.includes('cmake') ||
                         lp.includes('gradle') || lp.includes('haskell') ||
                         // Java — all common winget JDK package names
                         lp.includes('java') || lp.includes('jdk') || lp.includes('jre') ||
                         lp.includes('openjdk') || lp.includes('temurin') || lp.includes('adoptium') ||
                         lp.includes('corretto') || lp.includes('zulu') || lp.includes('semeru') ||
                         lp.includes('sapmachine') || lp.includes('liberica') || lp.includes('bellsoft');
        if (!relevant) continue;
        const pkgDir = path.join(wingetPkgs, pkg);
        tryAdd(pkgDir, 'bin');
        try {
          for (const sub of fs.readdirSync(pkgDir)) {
            tryAdd(pkgDir, sub, 'bin');
          }
        } catch {}
      }
    }
  } catch {}

  const mergedPath = [...new Set([
    ...systemPath.split(';'),
    ...userPath.split(';'),
    ...runtimeDirs,
  ])].filter(Boolean).join(';');

  return {
    ...process.env,
    PATH      : mergedPath,
    CARGO_HOME : process.env.CARGO_HOME  || path.join(os.homedir(), '.cargo'),
    RUSTUP_HOME: process.env.RUSTUP_HOME || path.join(os.homedir(), '.rustup'),
  };
}

// ── IPC: spawn long-running process ──────────────────────────────────────────
ipcMain.handle('terminal:spawn', (_event, { command, cwd }) => {
  const safeCwd = (cwd && fs.existsSync(cwd)) ? cwd : os.homedir();
  const spawnEnv = buildChildEnv();

  const child = spawn('powershell.exe',
    ['-NonInteractive', '-NoProfile', '-ExecutionPolicy', 'Bypass', '-Command', command],
    { cwd: safeCwd, env: spawnEnv, windowsHide: true }
  );

  const pid = child.pid;
  runningProcesses.set(pid, { process: child, command });

  const send = (type, text) => {
    if (mainWindow && !mainWindow.isDestroyed()) {
      mainWindow.webContents.send('terminal:output', { pid, type, text });
    }
  };

  send('system', `$ ${command}`);

  child.stdout.on('data', (data) => send('output', data.toString()));
  child.stderr.on('data', (data) => send('error', data.toString()));
  child.on('close', (code) => {
    runningProcesses.delete(pid);
    send('system', `Process exited with code ${code}`);
  });
  child.on('error', (err) => {
    runningProcesses.delete(pid);
    send('error', `Failed to start: ${err.message}`);
  });

  return { ok: true, pid };
});

ipcMain.handle('terminal:kill', (_event, { pid }) => {
  const entry = runningProcesses.get(pid);
  if (!entry) return { ok: false, error: 'Process not found' };
  try {
    spawn('taskkill', ['/F', '/T', '/PID', String(pid)], { windowsHide: true });
    runningProcesses.delete(pid);
    return { ok: true };
  } catch (e) {
    return { ok: false, error: e.message };
  }
});

// ── Syntax check: helpers shared by every language checker ───────────────────

function makeLineIndex(content) {
  const lines = content.split('\n');
  const offsetFromLineCol = (lineNum, col = 0) => {
    const ln = Math.max(0, lineNum - 1);
    return lines.slice(0, ln).reduce((a, l) => a + l.length + 1, 0) + col;
  };
  return { lines, offsetFromLineCol };
}

// Try a list of [cmd, args] candidates in order; resolves with the first
// one that isn't ENOENT.
function execFileFallback(candidates, opts) {
  return new Promise((resolve) => {
    const tryNext = (i) => {
      if (i >= candidates.length) return resolve({ err: { code: 'ENOENT' }, stdout: '', stderr: '' });
      const [cmd, args] = candidates[i];
      execFile(cmd, args, opts, (err, stdout, stderr) => {
        if (err && err.code === 'ENOENT' && i < candidates.length - 1) return tryNext(i + 1);
        resolve({ err, stdout, stderr });
      });
    };
    tryNext(0);
  });
}

function mkScratchDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'sc_lint_'));
}

function rmScratchDir(dir) {
  try { fs.rmSync(dir, { recursive: true, force: true }); } catch {}
}

// ── Group [1]: Java ──────────────────────────────────────────────────────────
async function checkJava(content, childEnv) {
  const { lines, offsetFromLineCol } = makeLineIndex(content);
  const dir = mkScratchDir();
  const classMatch = content.match(/public\s+(?:final\s+|abstract\s+)?(?:class|interface|enum|record)\s+(\w+)/);
  const className = classMatch ? classMatch[1] : 'SyntaxCheck';
  const file = path.join(dir, `${className}.java`);
  try { fs.writeFileSync(file, content, 'utf8'); } catch { rmScratchDir(dir); return []; }

  const { err, stdout, stderr } = await execFileFallback(
    [['javac', ['-d', dir, '-Xlint:none', '-nowarn', '-encoding', 'UTF-8', file]]],
    { timeout: 12000, env: childEnv, maxBuffer: 512 * 1024, cwd: dir }
  );
  rmScratchDir(dir);

  // ── Diagnostic log (open DevTools → Console tab to see this) ──────────────
  if (err && err.code === 'ENOENT') {
    console.warn('[SenCode syntax] javac not found — Java (JDK) may not be installed, or its bin folder is not on PATH.');
    console.warn('[SenCode syntax] PATH seen by Electron:', childEnv.PATH);
    return [];
  }
  // ──────────────────────────────────────────────────────────────────────────

  if (!err) return [];

  const raw = (stderr || stdout || '').toString();
  const diagnostics = [];
  const re = /\.java:(\d+): (error|warning): (.+)/g;
  let m;
  while ((m = re.exec(raw))) {
    const lineNum = parseInt(m[1]);
    const from = offsetFromLineCol(lineNum);
    const to   = from + (lines[lineNum - 1]?.length || 1);
    diagnostics.push({ from, to, severity: m[2] === 'error' ? 'error' : 'warning', message: m[3].trim() });
  }
  return diagnostics;
}

// ── Group [1]: C / C++ ───────────────────────────────────────────────────────
async function checkCFamily(content, lang, childEnv) {
  const { lines, offsetFromLineCol } = makeLineIndex(content);
  const isCpp = lang === 'cpp' || lang === 'cc' || lang === 'cxx' || lang === 'hpp';
  const ext = isCpp ? 'cpp' : 'c';
  const tmpFile = path.join(os.tmpdir(), `sc_lint_${Date.now()}_${Math.random().toString(36).slice(2)}.${ext}`);
  try { fs.writeFileSync(tmpFile, content, 'utf8'); } catch { return []; }

  const candidates = isCpp
    ? [['g++', ['-fsyntax-only', '-Wall', tmpFile]], ['clang++', ['-fsyntax-only', '-Wall', tmpFile]]]
    : [['gcc', ['-fsyntax-only', '-Wall', tmpFile]], ['clang', ['-fsyntax-only', '-Wall', tmpFile]]];

  const { err, stdout, stderr } = await execFileFallback(
    candidates, { timeout: 10000, env: childEnv, maxBuffer: 512 * 1024 }
  );
  try { fs.unlinkSync(tmpFile); } catch {}
  if (!err) return [];

  const raw = (stderr || stdout || '').toString();
  const diagnostics = [];
  const re = /:(\d+):(\d+):\s+(error|warning):\s+(.+)/g;
  let m;
  while ((m = re.exec(raw))) {
    const lineNum = parseInt(m[1]);
    const col     = Math.max(0, parseInt(m[2]) - 1);
    const from = offsetFromLineCol(lineNum, col);
    const to   = from + Math.max(1, (lines[lineNum - 1]?.length || 1) - col);
    diagnostics.push({ from, to, severity: m[3] === 'error' ? 'error' : 'warning', message: m[4].trim() });
  }
  return diagnostics;
}

// ── Group [1]: C# ────────────────────────────────────────────────────────────
async function checkCSharp(content, childEnv) {
  const { lines, offsetFromLineCol } = makeLineIndex(content);
  const dir = mkScratchDir();
  try {
    fs.writeFileSync(path.join(dir, 'Program.cs'), content, 'utf8');
    fs.writeFileSync(path.join(dir, 'SyntaxCheck.csproj'), `<Project Sdk="Microsoft.NET.Sdk">
  <PropertyGroup>
    <OutputType>Exe</OutputType>
    <TargetFramework>net8.0</TargetFramework>
    <ImplicitUsings>enable</ImplicitUsings>
    <Nullable>disable</Nullable>
    <EnableDefaultCompileItems>true</EnableDefaultCompileItems>
  </PropertyGroup>
</Project>
`, 'utf8');
  } catch { rmScratchDir(dir); return []; }

  const { err, stdout, stderr } = await execFileFallback(
    [['dotnet', ['build', '--nologo', '-v:q', '/clp:ErrorsOnly', dir]]],
    { timeout: 25000, env: childEnv, maxBuffer: 1024 * 1024, cwd: dir }
  );
  rmScratchDir(dir);
  if (!err) return [];

  const raw = (stdout || stderr || '').toString();
  const diagnostics = [];
  const re = /Program\.cs\((\d+),(\d+)\): error (CS\d+): (.+?) \[/g;
  let m;
  while ((m = re.exec(raw))) {
    const lineNum = parseInt(m[1]);
    const col     = Math.max(0, parseInt(m[2]) - 1);
    const from = offsetFromLineCol(lineNum, col);
    const to   = from + Math.max(1, (lines[lineNum - 1]?.length || 1) - col);
    diagnostics.push({ from, to, severity: 'error', message: `${m[3]}: ${m[4].trim()}` });
  }
  return diagnostics;
}

// ── Group [1]: PHP ───────────────────────────────────────────────────────────
async function checkPhp(content, childEnv) {
  const { lines, offsetFromLineCol } = makeLineIndex(content);
  const tmpFile = path.join(os.tmpdir(), `sc_lint_${Date.now()}_${Math.random().toString(36).slice(2)}.php`);
  try { fs.writeFileSync(tmpFile, content, 'utf8'); } catch { return []; }

  const { err, stdout, stderr } = await execFileFallback(
    [['php', ['-l', tmpFile]]], { timeout: 8000, env: childEnv, maxBuffer: 512 * 1024 }
  );
  try { fs.unlinkSync(tmpFile); } catch {}
  if (!err) return [];

  const raw = (stdout || stderr || '').toString();
  const diagnostics = [];
  const lineMatch = raw.match(/on line (\d+)/);
  const msgMatch  = raw.match(/PHP Parse error:\s*(.+?)\s+in\s/) || raw.match(/Parse error:\s*(.+?)\s+in\s/);
  if (lineMatch) {
    const lineNum = parseInt(lineMatch[1]);
    const from = offsetFromLineCol(lineNum);
    const to   = from + (lines[lineNum - 1]?.length || 1);
    diagnostics.push({ from, to, severity: 'error', message: (msgMatch?.[1] || 'Syntax error').trim() });
  }
  return diagnostics;
}

// ── Group [1]: Go ────────────────────────────────────────────────────────────
async function checkGo(content, childEnv) {
  const { lines, offsetFromLineCol } = makeLineIndex(content);
  const tmpFile = path.join(os.tmpdir(), `sc_lint_${Date.now()}_${Math.random().toString(36).slice(2)}.go`);
  try { fs.writeFileSync(tmpFile, content, 'utf8'); } catch { return []; }

  const { err, stdout, stderr } = await execFileFallback(
    [['gofmt', ['-e', tmpFile]]], { timeout: 8000, env: childEnv, maxBuffer: 512 * 1024 }
  );
  try { fs.unlinkSync(tmpFile); } catch {}
  if (!err) return [];

  const raw = (stderr || stdout || '').toString();
  const diagnostics = [];
  const re = /:(\d+):(\d+):\s*(.+)/g;
  let m;
  while ((m = re.exec(raw))) {
    const lineNum = parseInt(m[1]);
    const col     = Math.max(0, parseInt(m[2]) - 1);
    const from = offsetFromLineCol(lineNum, col);
    const to   = from + Math.max(1, (lines[lineNum - 1]?.length || 1) - col);
    diagnostics.push({ from, to, severity: 'error', message: m[3].trim() });
  }
  return diagnostics;
}

// ── Group [1]: Rust ──────────────────────────────────────────────────────────
async function checkRust(content, childEnv) {
  const { lines, offsetFromLineCol } = makeLineIndex(content);
  const dir = mkScratchDir();
  const tmpFile = path.join(dir, 'syntax_check.rs');
  const outFile = path.join(dir, 'out.rmeta');
  try { fs.writeFileSync(tmpFile, content, 'utf8'); } catch { rmScratchDir(dir); return []; }

  const { err, stdout, stderr } = await execFileFallback(
    [['rustc', ['--edition', '2021', '--crate-type', 'lib', '--error-format=json',
                '--emit=metadata', '-o', outFile, tmpFile]]],
    { timeout: 15000, env: childEnv, maxBuffer: 1024 * 1024, cwd: dir }
  );
  rmScratchDir(dir);
  if (!err && !stderr) return [];

  const raw = (stderr || stdout || '').toString();
  const diagnostics = [];
  for (const line of raw.split('\n')) {
    const trimmed = line.trim();
    if (!trimmed.startsWith('{')) continue;
    let obj;
    try { obj = JSON.parse(trimmed); } catch { continue; }
    if (!obj || (obj.level !== 'error' && obj.level !== 'warning')) continue;
    const span = (obj.spans || []).find((s) => s.is_primary) || obj.spans?.[0];
    if (!span) continue;
    const from = offsetFromLineCol(span.line_start, Math.max(0, span.column_start - 1));
    const to   = span.line_end === span.line_start
      ? offsetFromLineCol(span.line_end, Math.max(0, span.column_end - 1))
      : from + 1;
    diagnostics.push({
      from, to: Math.max(to, from + 1),
      severity: obj.level === 'error' ? 'error' : 'warning',
      message: (obj.message || 'Syntax error').trim(),
    });
  }
  return diagnostics;
}

// ── Group 2: Ruby ────────────────────────────────────────────────────────────
// ruby -c <file> → stderr: "<file>:N: <message>"
async function checkRuby(content, childEnv) {
  const { lines, offsetFromLineCol } = makeLineIndex(content);
  const tmpFile = path.join(os.tmpdir(), `sc_lint_${Date.now()}_${Math.random().toString(36).slice(2)}.rb`);
  try { fs.writeFileSync(tmpFile, content, 'utf8'); } catch { return []; }

  const { err, stdout, stderr } = await execFileFallback(
    [['ruby', ['-c', tmpFile]]], { timeout: 8000, env: childEnv, maxBuffer: 512 * 1024 }
  );
  try { fs.unlinkSync(tmpFile); } catch {}
  if (!err) return [];

  const raw = (stderr || stdout || '').toString();
  const diagnostics = [];
  const re = /:(\d+):\s*(.+)/g;
  let m;
  while ((m = re.exec(raw))) {
    const lineNum = parseInt(m[1]);
    if (isNaN(lineNum)) continue;
    const from = offsetFromLineCol(lineNum);
    const to   = from + (lines[lineNum - 1]?.length || 1);
    diagnostics.push({ from, to, severity: 'error', message: m[2].trim() });
  }
  return diagnostics;
}

// ── Group 2: Swift ───────────────────────────────────────────────────────────
// swiftc -parse <file> → stderr: "<file>:N:C: error: <message>"
async function checkSwift(content, childEnv) {
  const { lines, offsetFromLineCol } = makeLineIndex(content);
  const tmpFile = path.join(os.tmpdir(), `sc_lint_${Date.now()}_${Math.random().toString(36).slice(2)}.swift`);
  try { fs.writeFileSync(tmpFile, content, 'utf8'); } catch { return []; }

  const { err, stdout, stderr } = await execFileFallback(
    [['swiftc', ['-parse', tmpFile]]], { timeout: 15000, env: childEnv, maxBuffer: 512 * 1024 }
  );
  try { fs.unlinkSync(tmpFile); } catch {}
  if (!err) return [];

  const raw = (stderr || stdout || '').toString();
  const diagnostics = [];
  const re = /:(\d+):(\d+): (error|warning): (.+)/g;
  let m;
  while ((m = re.exec(raw))) {
    const lineNum = parseInt(m[1]);
    const col     = Math.max(0, parseInt(m[2]) - 1);
    const from = offsetFromLineCol(lineNum, col);
    const to   = from + Math.max(1, (lines[lineNum - 1]?.length || 1) - col);
    diagnostics.push({ from, to, severity: m[3] === 'error' ? 'error' : 'warning', message: m[4].trim() });
  }
  return diagnostics;
}

// ── Group 2: Kotlin ──────────────────────────────────────────────────────────
// kotlinc -script <file> → stderr: "<file>:N:C: error: <message>"
async function checkKotlin(content, childEnv) {
  const { lines, offsetFromLineCol } = makeLineIndex(content);
  const tmpFile = path.join(os.tmpdir(), `sc_lint_${Date.now()}_${Math.random().toString(36).slice(2)}.kts`);
  try { fs.writeFileSync(tmpFile, content, 'utf8'); } catch { return []; }

  const { err, stdout, stderr } = await execFileFallback(
    [['kotlinc', ['-script', tmpFile]]],
    { timeout: 60000, env: childEnv, maxBuffer: 1024 * 1024 }
  );
  try { fs.unlinkSync(tmpFile); } catch {}
  if (!err) return [];

  const raw = (stderr || stdout || '').toString();
  const diagnostics = [];
  const re = /:(\d+):(\d+): (error|warning): (.+)/g;
  let m;
  while ((m = re.exec(raw))) {
    const lineNum = parseInt(m[1]);
    const col     = Math.max(0, parseInt(m[2]) - 1);
    const from = offsetFromLineCol(lineNum, col);
    const to   = from + Math.max(1, (lines[lineNum - 1]?.length || 1) - col);
    diagnostics.push({ from, to, severity: m[3] === 'error' ? 'error' : 'warning', message: m[4].trim() });
  }
  return diagnostics;
}

// ── Group 2: Scala ───────────────────────────────────────────────────────────
// scalac -Ystop-after:parser <file> → stderr: "<file>:N: error: <message>"
async function checkScala(content, childEnv) {
  const { lines, offsetFromLineCol } = makeLineIndex(content);
  const tmpFile = path.join(os.tmpdir(), `sc_lint_${Date.now()}_${Math.random().toString(36).slice(2)}.scala`);
  try { fs.writeFileSync(tmpFile, content, 'utf8'); } catch { return []; }

  const { err, stdout, stderr } = await execFileFallback(
    [['scalac', ['-Ystop-after:parser', tmpFile]]],
    { timeout: 30000, env: childEnv, maxBuffer: 512 * 1024 }
  );
  try { fs.unlinkSync(tmpFile); } catch {}
  if (!err) return [];

  const raw = (stderr || stdout || '').toString();
  const diagnostics = [];
  const re = /:(\d+): (error|warning): (.+)/g;
  let m;
  while ((m = re.exec(raw))) {
    const lineNum = parseInt(m[1]);
    const from = offsetFromLineCol(lineNum);
    const to   = from + (lines[lineNum - 1]?.length || 1);
    diagnostics.push({ from, to, severity: m[2] === 'error' ? 'error' : 'warning', message: m[3].trim() });
  }
  return diagnostics;
}

// ── Group 2: SQL ─────────────────────────────────────────────────────────────
// Client-side: scan for unmatched quotes, unbalanced parens, and common errors
function checkSql(content) {
  const lines = content.split('\n');
  const diagnostics = [];
  let singleQuotes = 0, doubleQuotes = 0, parenDepth = 0;
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    let inSingle = false, inDouble = false;
    for (let ci = 0; ci < line.length; ci++) {
      const ch = line[ci];
      if (ch === "'" && !inDouble) { inSingle = !inSingle; singleQuotes += inSingle ? 1 : -1; }
      else if (ch === '"' && !inSingle) { inDouble = !inDouble; doubleQuotes += inDouble ? 1 : -1; }
      else if (ch === '(' && !inSingle && !inDouble) parenDepth++;
      else if (ch === ')' && !inSingle && !inDouble) {
        parenDepth--;
        if (parenDepth < 0) {
          const from = lines.slice(0, i).reduce((a, l) => a + l.length + 1, 0) + ci;
          diagnostics.push({ from, to: from + 1, severity: 'error', message: 'Unexpected closing parenthesis' });
          parenDepth = 0;
        }
      }
    }
  }
  if (singleQuotes % 2 !== 0) {
    diagnostics.push({ from: content.length - 1, to: content.length, severity: 'error', message: 'Unmatched single quote' });
  }
  if (parenDepth > 0) {
    diagnostics.push({ from: content.length - 1, to: content.length, severity: 'error', message: 'Unmatched opening parenthesis' });
  }
  return diagnostics;
}

// ── Group 2: Shell / Bash ─────────────────────────────────────────────────────
// bash -n <file> → stderr: "<file>: line N: <message>"
async function checkShell(content, childEnv) {
  const { lines, offsetFromLineCol } = makeLineIndex(content);
  const tmpFile = path.join(os.tmpdir(), `sc_lint_${Date.now()}_${Math.random().toString(36).slice(2)}.sh`);
  try { fs.writeFileSync(tmpFile, content, 'utf8'); } catch { return []; }

  const { err, stdout, stderr } = await execFileFallback(
    [['bash', ['-n', tmpFile]]], { timeout: 8000, env: childEnv, maxBuffer: 512 * 1024 }
  );
  try { fs.unlinkSync(tmpFile); } catch {}
  if (!err) return [];

  const raw = (stderr || stdout || '').toString();
  const diagnostics = [];
  const re = /line (\d+):\s*(.+)/g;
  let m;
  while ((m = re.exec(raw))) {
    const lineNum = parseInt(m[1]);
    const from = offsetFromLineCol(lineNum);
    const to   = from + (lines[lineNum - 1]?.length || 1);
    diagnostics.push({ from, to, severity: 'error', message: m[2].trim() });
  }
  return diagnostics;
}

// ── Group 2: PowerShell ──────────────────────────────────────────────────────
// Uses PowerShell's built-in AST parser — available on all Windows machines.
async function checkPowerShell(content, childEnv) {
  const { lines, offsetFromLineCol } = makeLineIndex(content);
  const tmpFile = path.join(os.tmpdir(), `sc_lint_${Date.now()}_${Math.random().toString(36).slice(2)}.ps1`);
  try { fs.writeFileSync(tmpFile, content, 'utf8'); } catch { return []; }

  const psCmd = `$errors = $null; $null = [System.Management.Automation.Language.Parser]::ParseFile('${tmpFile.replace(/'/g, "''")}', [ref]$null, [ref]$errors); $errors | ForEach-Object { Write-Output "$($_.Extent.StartLineNumber):$($_.Extent.StartColumnNumber): $($_.Message)" }`;

  const { err, stdout, stderr } = await execFileFallback(
    [['powershell.exe', ['-NonInteractive', '-NoProfile', '-Command', psCmd]]],
    { timeout: 10000, env: childEnv, maxBuffer: 512 * 1024 }
  );
  try { fs.unlinkSync(tmpFile); } catch {}

  const raw = (stdout || stderr || '').toString().trim();
  if (!raw) return [];

  const diagnostics = [];
  for (const line of raw.split('\n')) {
    const m = line.trim().match(/^(\d+):(\d+):\s*(.+)/);
    if (!m) continue;
    const lineNum = parseInt(m[1]);
    const col     = Math.max(0, parseInt(m[2]) - 1);
    const from = offsetFromLineCol(lineNum, col);
    const to   = from + Math.max(1, (lines[lineNum - 1]?.length || 1) - col);
    diagnostics.push({ from, to, severity: 'error', message: m[3].trim() });
  }
  return diagnostics;
}

// ── Group 2: R ───────────────────────────────────────────────────────────────
// Rscript --vanilla -e "parse(file='<file>')" → stderr: "<text>:N:C: unexpected <token>"
async function checkR(content, childEnv) {
  const { lines, offsetFromLineCol } = makeLineIndex(content);
  const tmpFile = path.join(os.tmpdir(), `sc_lint_${Date.now()}_${Math.random().toString(36).slice(2)}.r`);
  try { fs.writeFileSync(tmpFile, content, 'utf8'); } catch { return []; }

  const { err, stdout, stderr } = await execFileFallback(
    [['Rscript', ['--vanilla', '-e', `parse(file='${tmpFile.replace(/\\/g, '\\\\')}')`]]],
    { timeout: 10000, env: childEnv, maxBuffer: 512 * 1024 }
  );
  try { fs.unlinkSync(tmpFile); } catch {}
  if (!err) return [];

  const raw = (stderr || stdout || '').toString();
  const diagnostics = [];
  const re = /:(\d+):(\d+):\s*(.+)/g;
  let m;
  while ((m = re.exec(raw))) {
    const lineNum = parseInt(m[1]);
    const col     = Math.max(0, parseInt(m[2]) - 1);
    const from = offsetFromLineCol(lineNum, col);
    const to   = from + Math.max(1, (lines[lineNum - 1]?.length || 1) - col);
    diagnostics.push({ from, to, severity: 'error', message: m[3].trim() });
  }
  return diagnostics;
}

// ── Group 2: Dart ────────────────────────────────────────────────────────────
// dart analyze <file> → stdout: "  <file>:N:C • <message> • <code>"
async function checkDart(content, childEnv) {
  const { lines, offsetFromLineCol } = makeLineIndex(content);
  const tmpFile = path.join(os.tmpdir(), `sc_lint_${Date.now()}_${Math.random().toString(36).slice(2)}.dart`);
  try { fs.writeFileSync(tmpFile, content, 'utf8'); } catch { return []; }

  const { err, stdout, stderr } = await execFileFallback(
    [['dart', ['analyze', tmpFile]]],
    { timeout: 15000, env: childEnv, maxBuffer: 512 * 1024 }
  );
  try { fs.unlinkSync(tmpFile); } catch {}

  const raw = (stdout || stderr || '').toString();
  if (!raw || /No issues found/i.test(raw)) return [];

  // parseDartMachine — dart analyze output: "  path:N:C • message • code"
  const diagnostics = [];
  const re = /(\d+):(\d+)\s*[•·]\s*(.+?)\s*[•·]/g;
  let m;
  while ((m = re.exec(raw))) {
    const lineNum = parseInt(m[1]);
    const col     = Math.max(0, parseInt(m[2]) - 1);
    const from = offsetFromLineCol(lineNum, col);
    const to   = from + Math.max(1, (lines[lineNum - 1]?.length || 1) - col);
    const msg = m[3].trim();
    const sev = /error|Error/.test(raw.slice(Math.max(0, m.index - 30), m.index)) ? 'error' : 'warning';
    diagnostics.push({ from, to, severity: sev, message: msg });
  }
  return diagnostics;
}

// ── Group 2: Lua ─────────────────────────────────────────────────────────────
// luac -p <file> → stderr: "luac: <file>:N: <message>"
async function checkLua(content, childEnv) {
  const { lines, offsetFromLineCol } = makeLineIndex(content);
  const tmpFile = path.join(os.tmpdir(), `sc_lint_${Date.now()}_${Math.random().toString(36).slice(2)}.lua`);
  try { fs.writeFileSync(tmpFile, content, 'utf8'); } catch { return []; }

  const { err, stdout, stderr } = await execFileFallback(
    [
      ['luac', ['-p', tmpFile]],
      ['luac54', ['-p', tmpFile]],
      ['luac53', ['-p', tmpFile]],
      ['luac51', ['-p', tmpFile]],
    ],
    { timeout: 8000, env: childEnv, maxBuffer: 512 * 1024 }
  );
  try { fs.unlinkSync(tmpFile); } catch {}
  if (!err) return [];

  const raw = (stderr || stdout || '').toString();
  const diagnostics = [];
  // Format: "luac: <file>:N: <message>"
  const re = /:(\d+):\s*(.+)/g;
  let m;
  while ((m = re.exec(raw))) {
    const lineNum = parseInt(m[1]);
    if (isNaN(lineNum)) continue;
    const from = offsetFromLineCol(lineNum);
    const to   = from + (lines[lineNum - 1]?.length || 1);
    diagnostics.push({ from, to, severity: 'error', message: m[2].trim() });
  }
  return diagnostics;
}

// ── Group 3: Groovy ──────────────────────────────────────────────────────────
// groovy -e "new GroovyShell().parse(new File('<file>'))" → stderr: ": N: <message>"
async function checkGroovy(content, childEnv) {
  const { lines, offsetFromLineCol } = makeLineIndex(content);
  const tmpFile = path.join(os.tmpdir(), `sc_lint_${Date.now()}_${Math.random().toString(36).slice(2)}.groovy`);
  try { fs.writeFileSync(tmpFile, content, 'utf8'); } catch { return []; }

  const escPath = tmpFile.replace(/\\/g, '\\\\').replace(/'/g, "\\'");
  const { err, stdout, stderr } = await execFileFallback(
    [['groovy', ['-e', `new GroovyShell().parse(new File('${escPath}'))`]]],
    { timeout: 15000, env: childEnv, maxBuffer: 512 * 1024 }
  );
  try { fs.unlinkSync(tmpFile); } catch {}
  if (!err) return [];

  const raw = (stderr || stdout || '').toString();
  const diagnostics = [];
  const re = /@\s*line\s+(\d+)|: (\d+): (.+)/g;
  let m;
  // Try "@ line N" format
  const lineM = raw.match(/@\s*line\s+(\d+)/);
  const msgM  = raw.match(/org\.codehaus\.groovy\.control\.MultipleCompilationErrorsException:\s*startup failed:\n[^\n]*: (\d+): (.+)/s);
  if (msgM) {
    const lineNum = parseInt(msgM[1]);
    const from = offsetFromLineCol(lineNum);
    diagnostics.push({ from, to: from + (lines[lineNum - 1]?.length || 1), severity: 'error', message: msgM[2].trim() });
  } else if (lineM) {
    const lineNum = parseInt(lineM[1]);
    const from = offsetFromLineCol(lineNum);
    const msg = raw.match(/^(.+)$/m)?.[1] || 'Groovy syntax error';
    diagnostics.push({ from, to: from + (lines[lineNum - 1]?.length || 1), severity: 'error', message: msg.trim() });
  }
  return diagnostics;
}

// ── Group 3: Perl ────────────────────────────────────────────────────────────
// perl -c <file> → stderr: "<message> at <file> line N"
async function checkPerl(content, childEnv) {
  const { lines, offsetFromLineCol } = makeLineIndex(content);
  const tmpFile = path.join(os.tmpdir(), `sc_lint_${Date.now()}_${Math.random().toString(36).slice(2)}.pl`);
  try { fs.writeFileSync(tmpFile, content, 'utf8'); } catch { return []; }

  const { err, stdout, stderr } = await execFileFallback(
    [['perl', ['-c', tmpFile]]], { timeout: 8000, env: childEnv, maxBuffer: 512 * 1024 }
  );
  try { fs.unlinkSync(tmpFile); } catch {}
  if (!err) return [];

  const raw = (stderr || stdout || '').toString();
  const diagnostics = [];
  const re = /(.+?) at .+ line (\d+)/g;
  let m;
  while ((m = re.exec(raw))) {
    const lineNum = parseInt(m[2]);
    if (isNaN(lineNum)) continue;
    const from = offsetFromLineCol(lineNum);
    const to   = from + (lines[lineNum - 1]?.length || 1);
    diagnostics.push({ from, to, severity: 'error', message: m[1].trim() });
  }
  return diagnostics;
}

// ── Group 3: Haskell ─────────────────────────────────────────────────────────
// ghc -fno-code -fno-warn-missing-signatures <file>
// stderr: "<file>:N:C: error: <message>"
async function checkHaskell(content, childEnv) {
  const { lines, offsetFromLineCol } = makeLineIndex(content);
  const dir = mkScratchDir();
  const tmpFile = path.join(dir, `SyntaxCheck_${Date.now()}.hs`);
  try { fs.writeFileSync(tmpFile, content, 'utf8'); } catch { rmScratchDir(dir); return []; }

  const { err, stdout, stderr } = await execFileFallback(
    [['ghc', ['-fno-code', '-fno-warn-missing-signatures', tmpFile]]],
    { timeout: 20000, env: childEnv, maxBuffer: 512 * 1024, cwd: dir }
  );
  rmScratchDir(dir);
  if (!err) return [];

  const raw = (stderr || stdout || '').toString();
  const diagnostics = [];
  const re = /:(\d+):(\d+): (error|warning)(?:\[.+?\])?:\s*(.+?)(?=\n\s*\d+\s*\||\n[^\s]|$)/gs;
  let m;
  while ((m = re.exec(raw))) {
    const lineNum = parseInt(m[1]);
    const col     = Math.max(0, parseInt(m[2]) - 1);
    const from = offsetFromLineCol(lineNum, col);
    const to   = from + Math.max(1, (lines[lineNum - 1]?.length || 1) - col);
    diagnostics.push({ from, to, severity: m[3] === 'error' ? 'error' : 'warning', message: m[4].replace(/\s+/g, ' ').trim() });
  }
  return diagnostics;
}

// ── Group 3: Elixir ──────────────────────────────────────────────────────────
// elixir --no-halt -e "Code.compile_file('<file>')"
// stderr: "(SyntaxError) <file>:N:C: <message>"
async function checkElixir(content, childEnv) {
  const { lines, offsetFromLineCol } = makeLineIndex(content);
  const tmpFile = path.join(os.tmpdir(), `sc_lint_${Date.now()}_${Math.random().toString(36).slice(2)}.ex`);
  try { fs.writeFileSync(tmpFile, content, 'utf8'); } catch { return []; }

  const escPath = tmpFile.replace(/\\/g, '/');
  const { err, stdout, stderr } = await execFileFallback(
    [['elixir', ['--no-halt', '-e', `Code.compile_file('${escPath}')`]]],
    { timeout: 20000, env: childEnv, maxBuffer: 512 * 1024 }
  );
  try { fs.unlinkSync(tmpFile); } catch {}
  if (!err) return [];

  const raw = (stderr || stdout || '').toString();
  const diagnostics = [];
  // "(SyntaxError) <file>:N:C: <message>"
  const re = /\((?:SyntaxError|TokenMissingError|MismatchedDelimiterError)\) [^:]+:(\d+):(\d+):\s*(.+)/g;
  let m;
  while ((m = re.exec(raw))) {
    const lineNum = parseInt(m[1]);
    const col     = Math.max(0, parseInt(m[2]) - 1);
    const from = offsetFromLineCol(lineNum, col);
    const to   = from + Math.max(1, (lines[lineNum - 1]?.length || 1) - col);
    diagnostics.push({ from, to, severity: 'error', message: m[3].trim() });
  }
  // Fallback: simpler pattern
  if (!diagnostics.length) {
    const m2 = raw.match(/\(SyntaxError\)[^\n]*:(\d+):\s*(.+)/);
    if (m2) {
      const lineNum = parseInt(m2[1]);
      const from = offsetFromLineCol(lineNum);
      diagnostics.push({ from, to: from + (lines[lineNum - 1]?.length || 1), severity: 'error', message: m2[2].trim() });
    }
  }
  return diagnostics;
}

// ── Group 3: Erlang ──────────────────────────────────────────────────────────
// erlc -W0 +warn_unused_vars -o <tmpdir> <file>
// stderr: "<file>:N: (Warning|Error): <message>"
async function checkErlang(content, childEnv) {
  const { lines, offsetFromLineCol } = makeLineIndex(content);
  const dir = mkScratchDir();
  const tmpFile = path.join(dir, `sc_check_${Date.now()}.erl`);
  try { fs.writeFileSync(tmpFile, content, 'utf8'); } catch { rmScratchDir(dir); return []; }

  const { err, stdout, stderr } = await execFileFallback(
    [['erlc', ['-W0', '+warn_unused_vars', '-o', dir, tmpFile]]],
    { timeout: 15000, env: childEnv, maxBuffer: 512 * 1024, cwd: dir }
  );
  rmScratchDir(dir);
  // erlc exits 0 even on warnings, non-zero on errors
  const raw = (stderr || stdout || '').toString();
  if (!raw.trim()) return [];

  const diagnostics = [];
  const re = /:(\d+):\s*(?:Warning|Error|warning|error):\s*(.+)/g;
  let m;
  while ((m = re.exec(raw))) {
    const lineNum = parseInt(m[1]);
    const from = offsetFromLineCol(lineNum);
    const to   = from + (lines[lineNum - 1]?.length || 1);
    const isErr = /[Ee]rror/.test(raw.slice(Math.max(0, m.index - 5), m.index + 10));
    diagnostics.push({ from, to, severity: isErr ? 'error' : 'warning', message: m[2].trim() });
  }
  return diagnostics;
}

// ── Group 3: Clojure ─────────────────────────────────────────────────────────
// clojure -e "(load-file \"<file>\")"
// stderr: "clojure.lang.Compiler$CompilerException: ... <file>:N"
async function checkClojure(content, childEnv) {
  const { lines, offsetFromLineCol } = makeLineIndex(content);
  const tmpFile = path.join(os.tmpdir(), `sc_lint_${Date.now()}_${Math.random().toString(36).slice(2)}.clj`);
  try { fs.writeFileSync(tmpFile, content, 'utf8'); } catch { return []; }

  const escPath = tmpFile.replace(/\\/g, '\\\\');
  const { err, stdout, stderr } = await execFileFallback(
    [['clojure', ['-e', `(load-file "${escPath}")`]]],
    { timeout: 30000, env: childEnv, maxBuffer: 512 * 1024 }
  );
  try { fs.unlinkSync(tmpFile); } catch {}
  if (!err) return [];

  const raw = (stderr || stdout || '').toString();
  const diagnostics = [];
  // "CompilerException: ... at (file.clj:N:C)"
  const re = /\((.+?):(\d+):(\d+)\)/g;
  let m;
  while ((m = re.exec(raw))) {
    const lineNum = parseInt(m[2]);
    const col     = Math.max(0, parseInt(m[3]) - 1);
    const from = offsetFromLineCol(lineNum, col);
    const msg = raw.match(/CompilerException [^:]+: ([^\n,]+)/)?.[1] || 'Clojure syntax error';
    diagnostics.push({ from, to: from + Math.max(1, (lines[lineNum - 1]?.length || 1) - col), severity: 'error', message: msg.trim() });
    break; // report first error only (load-file stops at first)
  }
  // Fallback: look for a plain line number
  if (!diagnostics.length) {
    const m2 = raw.match(/:(\d+)\s*\).*?(?:syntax|unexpected|EOF)/s);
    if (m2) {
      const lineNum = parseInt(m2[1]);
      const from = offsetFromLineCol(lineNum);
      diagnostics.push({ from, to: from + (lines[lineNum - 1]?.length || 1), severity: 'error', message: 'Clojure syntax error' });
    }
  }
  return diagnostics;
}

// ── Group 3: Julia ───────────────────────────────────────────────────────────
// julia --startup-file=no --compile=min -e "include(\"<file>\")"
// stderr: "LoadError: ... at <file>:N"
async function checkJulia(content, childEnv) {
  const { lines, offsetFromLineCol } = makeLineIndex(content);
  const tmpFile = path.join(os.tmpdir(), `sc_lint_${Date.now()}_${Math.random().toString(36).slice(2)}.jl`);
  try { fs.writeFileSync(tmpFile, content, 'utf8'); } catch { return []; }

  const escPath = tmpFile.replace(/\\/g, '\\\\');
  const { err, stdout, stderr } = await execFileFallback(
    [['julia', ['--startup-file=no', '--compile=min', '-e', `include("${escPath}")`]]],
    { timeout: 20000, env: childEnv, maxBuffer: 512 * 1024 }
  );
  try { fs.unlinkSync(tmpFile); } catch {}
  if (!err) return [];

  const raw = (stderr || stdout || '').toString();
  const diagnostics = [];
  // "ERROR: LoadError: ... around <file>:N"
  const lineM = raw.match(/around\s+\S+:(\d+)/);
  const msgM  = raw.match(/(?:LoadError|ParseError):\s*(.+)/);
  if (lineM) {
    const lineNum = parseInt(lineM[1]);
    const from = offsetFromLineCol(lineNum);
    diagnostics.push({ from, to: from + (lines[lineNum - 1]?.length || 1), severity: 'error', message: (msgM?.[1] || 'Julia syntax error').trim() });
  }
  return diagnostics;
}

// ── Group 3: Crystal ─────────────────────────────────────────────────────────
// crystal build --no-codegen <file>
// stderr: "<file>:N:C: error: <message>"
async function checkCrystal(content, childEnv) {
  const { lines, offsetFromLineCol } = makeLineIndex(content);
  const tmpFile = path.join(os.tmpdir(), `sc_lint_${Date.now()}_${Math.random().toString(36).slice(2)}.cr`);
  try { fs.writeFileSync(tmpFile, content, 'utf8'); } catch { return []; }

  const { err, stdout, stderr } = await execFileFallback(
    [['crystal', ['build', '--no-codegen', tmpFile]]],
    { timeout: 30000, env: childEnv, maxBuffer: 512 * 1024 }
  );
  try { fs.unlinkSync(tmpFile); } catch {}
  if (!err) return [];

  const raw = (stderr || stdout || '').toString();
  const diagnostics = [];
  const re = /:(\d+):(\d+): (error|warning): (.+)/g;
  let m;
  while ((m = re.exec(raw))) {
    const lineNum = parseInt(m[1]);
    const col     = Math.max(0, parseInt(m[2]) - 1);
    const from = offsetFromLineCol(lineNum, col);
    const to   = from + Math.max(1, (lines[lineNum - 1]?.length || 1) - col);
    diagnostics.push({ from, to, severity: m[3] === 'error' ? 'error' : 'warning', message: m[4].trim() });
  }
  return diagnostics;
}

// ── Group 3: F# ──────────────────────────────────────────────────────────────
// dotnet fsi --nologo <file>
// stderr: "<file>(N,C): error FS<code>: <message>"
async function checkFSharp(content, childEnv) {
  const { lines, offsetFromLineCol } = makeLineIndex(content);
  const tmpFile = path.join(os.tmpdir(), `sc_lint_${Date.now()}_${Math.random().toString(36).slice(2)}.fsx`);
  try { fs.writeFileSync(tmpFile, content, 'utf8'); } catch { return []; }

  const { err, stdout, stderr } = await execFileFallback(
    [['dotnet', ['fsi', '--nologo', tmpFile]]],
    { timeout: 25000, env: childEnv, maxBuffer: 512 * 1024 }
  );
  try { fs.unlinkSync(tmpFile); } catch {}
  if (!err) return [];

  const raw = (stdout || stderr || '').toString();
  const diagnostics = [];
  // Pattern: "file.fsx(N,C): error FS0001: message"
  const re = /\((\d+),(\d+)\): (error|warning) (FS\d+): (.+)/g;
  let m;
  while ((m = re.exec(raw))) {
    const lineNum = parseInt(m[1]);
    const col     = Math.max(0, parseInt(m[2]) - 1);
    const from = offsetFromLineCol(lineNum, col);
    const to   = from + Math.max(1, (lines[lineNum - 1]?.length || 1) - col);
    diagnostics.push({ from, to, severity: m[3] === 'error' ? 'error' : 'warning', message: `${m[4]}: ${m[5].trim()}` });
  }
  return diagnostics;
}

// ── Group 6: External syntax-checker runner ───────────────────────────────────
// Each checker entry describes how to invoke a tool and parse its output.
// This block is internal to main.cjs only — it is NOT exported via runtime-detect.cjs.

function offsetFromLineColG6(lines, lineNum, col) {
  const ln = Math.max(0, lineNum - 1);
  return lines.slice(0, ln).reduce((a, l) => a + l.length + 1, 0) + Math.max(0, col || 0);
}

function lineLenG6(lines, lineNum) {
  return (lines[Math.max(0, lineNum - 1)] || '').length || 1;
}

const GROUP6_CHECKERS = {
  // Dockerfile — hadolint
  dockerfile: {
    filename: () => 'Dockerfile',
    command: (tmpFile) => ({ cmd: 'hadolint', args: ['--no-color', '--format', 'json', tmpFile] }),
    parse: (raw, _tmpFile, lines) => {
      let items;
      try { items = JSON.parse(raw); } catch { return []; }
      if (!Array.isArray(items)) return [];
      return items.map((it) => {
        const from = offsetFromLineColG6(lines, it.line || 1, Math.max(0, (it.column || 1) - 1));
        const to = from + lineLenG6(lines, it.line || 1);
        const severity = it.level === 'error' ? 'error' : it.level === 'warning' ? 'warning' : 'info';
        return { from, to, severity, message: `${it.code || ''} ${it.message || ''}`.trim() };
      });
    },
  },

  // Protobuf — protoc
  protobuf: {
    filename: () => 'schema.proto',
    command: (tmpFile, tmpDir) => ({
      cmd: 'protoc',
      args: ['--proto_path', tmpDir, '-o', os.devNull || 'NUL', path.basename(tmpFile)],
      cwd: tmpDir,
    }),
    parse: (raw, _tmpFile, lines) => {
      const diags = [];
      const re = /:(\d+):(\d+):\s*(.+)/g;
      let m;
      while ((m = re.exec(raw))) {
        const lineNum = parseInt(m[1], 10);
        const from = offsetFromLineColG6(lines, lineNum, Math.max(0, parseInt(m[2], 10) - 1));
        diags.push({ from, to: from + lineLenG6(lines, lineNum), severity: 'error', message: m[3].trim() });
      }
      return diags;
    },
  },

  // INI / Config — Python configparser
  ini: {
    filename: (lang) => `config.${lang === 'properties' ? 'ini' : (lang || 'ini')}`,
    command: (tmpFile) => ({
      cmd: 'python',
      args: ['-c',
        'import sys,configparser\n' +
        'p=configparser.ConfigParser(strict=False)\n' +
        'try:\n  p.read(sys.argv[1])\n' +
        'except configparser.Error as e:\n  print(str(e)); sys.exit(1)\n',
        tmpFile],
    }),
    parse: (raw, _tmpFile, lines) => {
      if (!raw) return [];
      const m = raw.match(/line:?\s*(\d+)/i);
      const message = raw.split('\n')[0] || 'Invalid INI/config syntax';
      if (!m) return [];
      const lineNum = parseInt(m[1], 10);
      const from = offsetFromLineColG6(lines, lineNum, 0);
      return [{ from, to: from + lineLenG6(lines, lineNum), severity: 'error', message }];
    },
  },

  // Diff / Patch — GNU patch --dry-run
  diff: {
    filename: () => 'change.patch',
    command: (tmpFile, tmpDir) => ({ cmd: 'patch', args: ['--dry-run', '-p1', '-i', tmpFile], cwd: tmpDir }),
    parse: (raw, _tmpFile, lines) => {
      const diags = [];
      const re = /malformed patch at line (\d+)/gi;
      let m;
      while ((m = re.exec(raw))) {
        const lineNum = parseInt(m[1], 10);
        const from = offsetFromLineColG6(lines, lineNum, 0);
        diags.push({ from, to: from + lineLenG6(lines, lineNum), severity: 'error', message: 'Malformed patch/diff syntax' });
      }
      if (!diags.length && /unexpected end of file/i.test(raw)) {
        const from = offsetFromLineColG6(lines, lines.length, 0);
        diags.push({ from, to: from + 1, severity: 'error', message: 'Unexpected end of file in patch' });
      }
      return diags;
    },
  },

  // GraphQL — Node.js + graphql via npx
  graphql: {
    filename: () => 'schema.graphql',
    prepExtra: (tmpDir) => {
      const helper = path.join(tmpDir, 'gql_check.cjs');
      fs.writeFileSync(helper,
        "const {parse}=require('graphql');const fs=require('fs');" +
        "try{parse(fs.readFileSync(process.argv[2],'utf8'));}" +
        "catch(e){console.log(JSON.stringify({line:e.locations&&e.locations[0]&&e.locations[0].line," +
        "column:e.locations&&e.locations[0]&&e.locations[0].column,message:e.message}));process.exit(1);}",
        'utf8');
      return helper;
    },
    command: (tmpFile, tmpDir, helper) => ({
      cmd: 'npx', args: ['-y', '-p', 'graphql', 'node', helper, tmpFile], cwd: tmpDir,
    }),
    parse: (raw, _tmpFile, lines) => {
      const jsonMatch = raw.match(/\{[\s\S]*\}/);
      if (!jsonMatch) return [];
      try {
        const info = JSON.parse(jsonMatch[0]);
        const lineNum = info.line || 1;
        const from = offsetFromLineColG6(lines, lineNum, Math.max(0, (info.column || 1) - 1));
        return [{ from, to: from + lineLenG6(lines, lineNum), severity: 'error', message: info.message || 'GraphQL syntax error' }];
      } catch { return []; }
    },
  },

  // Nginx — nginx -t
  nginx: {
    filename: () => 'nginx.conf',
    command: (tmpFile) => ({ cmd: 'nginx', args: ['-t', '-c', tmpFile] }),
    parse: (raw, _tmpFile, lines) => {
      const diags = [];
      const re = /\[(emerg|error|warn)\]\s*(.+?)\s+in\s+.*?:(\d+)/g;
      let m;
      while ((m = re.exec(raw))) {
        const lineNum = parseInt(m[3], 10);
        const from = offsetFromLineColG6(lines, lineNum, 0);
        diags.push({ from, to: from + lineLenG6(lines, lineNum), severity: m[1] === 'warn' ? 'warning' : 'error', message: m[2].trim() });
      }
      return diags;
    },
  },

  // Apache — httpd -t
  apache: {
    filename: () => 'httpd.conf',
    command: (tmpFile) => ({ cmd: 'httpd', args: ['-t', '-f', tmpFile] }),
    parse: (raw, _tmpFile, lines) => {
      const diags = [];
      const re = /[Ss]yntax error on line (\d+) of .+?:\s*(.+)/g;
      let m;
      while ((m = re.exec(raw))) {
        const lineNum = parseInt(m[1], 10);
        const from = offsetFromLineColG6(lines, lineNum, 0);
        diags.push({ from, to: from + lineLenG6(lines, lineNum), severity: 'error', message: m[2].trim() });
      }
      return diags;
    },
  },

  // Makefile — make -n
  makefile: {
    filename: () => 'Makefile',
    command: (tmpFile, tmpDir) => ({ cmd: 'make', args: ['-n', '-f', tmpFile], cwd: tmpDir }),
    parse: (raw, _tmpFile, lines) => {
      const diags = [];
      const re = /:(\d+):\s*\*\*\*\s*(.+?)\.\s*Stop\./g;
      let m;
      while ((m = re.exec(raw))) {
        const lineNum = parseInt(m[1], 10);
        const from = offsetFromLineColG6(lines, lineNum, 0);
        diags.push({ from, to: from + lineLenG6(lines, lineNum), severity: 'error', message: m[2].trim() });
      }
      return diags;
    },
  },

  // CMake — cmake -P (script mode)
  cmake: {
    filename: () => 'check.cmake',
    command: (tmpFile) => ({ cmd: 'cmake', args: ['-P', tmpFile] }),
    parse: (raw, _tmpFile, lines) => {
      const diags = [];
      const re = /CMake (Error|Warning)[^\n:]*:(\d+)[^\n]*\n\s*(.+)/g;
      let m;
      while ((m = re.exec(raw))) {
        const lineNum = parseInt(m[2], 10);
        const from = offsetFromLineColG6(lines, lineNum, 0);
        diags.push({ from, to: from + lineLenG6(lines, lineNum), severity: m[1] === 'Warning' ? 'warning' : 'error', message: m[3].trim() });
      }
      return diags;
    },
  },

  // Gradle — gradle tasks --offline -q
  gradle: {
    filename: () => 'build.gradle',
    command: (_tmpFile, tmpDir) => ({ cmd: 'gradle', args: ['tasks', '--offline', '-q'], cwd: tmpDir }),
    parse: (raw, _tmpFile, lines) => {
      const lineM = raw.match(/line:\s*(\d+)/);
      if (!lineM) return [];
      const msgM = raw.match(/What went wrong:\s*\n(.+)/);
      const lineNum = parseInt(lineM[1], 10);
      const from = offsetFromLineColG6(lines, lineNum, 0);
      return [{ from, to: from + lineLenG6(lines, lineNum), severity: 'error', message: (msgM?.[1] || 'Gradle build script syntax error').trim() }];
    },
  },
};

// Aliases
GROUP6_CHECKERS.proto      = GROUP6_CHECKERS.protobuf;
GROUP6_CHECKERS.cfg        = GROUP6_CHECKERS.ini;
GROUP6_CHECKERS.conf       = GROUP6_CHECKERS.ini;
GROUP6_CHECKERS.properties = GROUP6_CHECKERS.ini;
GROUP6_CHECKERS.config     = GROUP6_CHECKERS.ini;
GROUP6_CHECKERS.patch      = GROUP6_CHECKERS.diff;
GROUP6_CHECKERS.gql        = GROUP6_CHECKERS.graphql;
GROUP6_CHECKERS.apacheconf = GROUP6_CHECKERS.apache;
GROUP6_CHECKERS.make       = GROUP6_CHECKERS.makefile;

// Generic runner for Group 6 external-tool checkers
async function runGroup6ExternalChecker(checker, lang, content, childEnv) {
  let tmpDir;
  try {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'sc_check_'));
  } catch {
    return { ok: true, diagnostics: [] };
  }
  const cleanup = () => { try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch {} };

  const fname = typeof checker.filename === 'function' ? checker.filename(lang) : 'check.txt';
  const tmpFile = path.join(tmpDir, fname);
  try { fs.writeFileSync(tmpFile, content, 'utf8'); } catch { cleanup(); return { ok: true, diagnostics: [] }; }

  let helperArg;
  try { if (typeof checker.prepExtra === 'function') helperArg = checker.prepExtra(tmpDir); } catch { /* non-fatal */ }

  let cmd, args, cwd;
  try {
    ({ cmd, args, cwd } = checker.command(tmpFile, tmpDir, helperArg));
  } catch {
    cleanup();
    return { ok: true, diagnostics: [] };
  }

  const lines = content.split('\n');

  return new Promise((resolve) => {
    execFile(cmd, args, { timeout: 12000, env: childEnv, cwd: cwd || tmpDir, maxBuffer: 1024 * 1024 },
      (err, stdout, stderr) => {
        cleanup();
        if (err && err.code === 'ENOENT') return resolve({ ok: true, diagnostics: [] });

        const raw = `${stdout || ''}\n${stderr || ''}`.trim();
        if (!raw) return resolve({ ok: true, diagnostics: [] });

        let diagnostics = [];
        try { diagnostics = checker.parse(raw, tmpFile, lines) || []; } catch { diagnostics = []; }
        resolve({ ok: true, diagnostics });
      }
    );
  });
}

// ── Group 7: Generic GCC-style diagnostic parser ──────────────────────────────
// Handles formats: "file:N:C: error: msg" (used by Zig, V, COBOL, Ada, Crystal).
function parseGccStyleDiagnostics(raw, lines, offsetFromLineCol) {
  const diagnostics = [];
  // Pattern 1: "file:N:C: error: message" (colon-based)
  const re1 = /:(\d+):(\d+):\s*(error|warning|note):\s*(.+)/g;
  let m;
  while ((m = re1.exec(raw))) {
    const lineNum = parseInt(m[1]);
    const col     = Math.max(0, parseInt(m[2]) - 1);
    const from = offsetFromLineCol(lineNum, col);
    const to   = from + Math.max(1, (lines[lineNum - 1]?.length || 1) - col);
    if (m[3] !== 'note') {
      diagnostics.push({ from, to, severity: m[3] === 'warning' ? 'warning' : 'error', message: m[4].trim() });
    }
  }
  if (diagnostics.length) return diagnostics;

  // Pattern 2: "file(N): Error: message" (DMD / D style)
  const re2 = /\((\d+)\):\s*(?:Error|Warning):\s*(.+)/g;
  while ((m = re2.exec(raw))) {
    const lineNum = parseInt(m[1]);
    const from = offsetFromLineCol(lineNum);
    diagnostics.push({ from, to: from + (lines[lineNum - 1]?.length || 1), severity: 'error', message: m[2].trim() });
  }
  if (diagnostics.length) return diagnostics;

  // Pattern 3: "file(N, C) Error: message" (Nim style)
  const re3 = /\((\d+),\s*(\d+)\)\s*(?:Error|Warning):\s*(.+)/g;
  while ((m = re3.exec(raw))) {
    const lineNum = parseInt(m[1]);
    const col     = Math.max(0, parseInt(m[2]) - 1);
    const from = offsetFromLineCol(lineNum, col);
    diagnostics.push({ from, to: from + Math.max(1, (lines[lineNum - 1]?.length || 1) - col), severity: 'error', message: m[3].trim() });
  }
  return diagnostics;
}

// ── Group 7: Checkers ─────────────────────────────────────────────────────────

async function checkLatex(content, childEnv) {
  const { lines, offsetFromLineCol } = makeLineIndex(content);
  const dir = mkScratchDir();
  const tmpFile = path.join(dir, 'check.tex');
  try { fs.writeFileSync(tmpFile, content, 'utf8'); } catch { rmScratchDir(dir); return []; }

  const { err, stdout, stderr } = await execFileFallback(
    [
      ['pdflatex', ['-interaction=nonstopmode', '-draftmode', '-output-directory', dir, tmpFile]],
      ['chktex', ['-q', '-v0', tmpFile]],
    ],
    { timeout: 30000, env: childEnv, maxBuffer: 1024 * 1024, cwd: dir }
  );
  rmScratchDir(dir);

  const raw = (stdout || stderr || '').toString();
  const diagnostics = [];

  // pdflatex format: "! LaTeX Error: ...\nl.N"
  const errBlocks = raw.match(/!\s*(?:LaTeX|Package|Class|Undefined|Missing|Extra).*?(?=\n!|\n\s*\(|$)/gs) || [];
  for (const block of errBlocks) {
    const lineM = block.match(/l\.(\d+)/);
    const msg   = block.split('\n')[0].replace(/^!\s*/, '').trim();
    if (lineM) {
      const lineNum = parseInt(lineM[1]);
      const from = offsetFromLineCol(lineNum);
      diagnostics.push({ from, to: from + (lines[lineNum - 1]?.length || 1), severity: 'error', message: msg });
    }
  }

  // chktex format: "file:N:C: Warning N in ... : message"
  if (!diagnostics.length) {
    const re = /:(\d+):(\d+):\s*(Warning|Error)\s+\d+[^:]*:\s*(.+)/g;
    let m;
    while ((m = re.exec(raw))) {
      const lineNum = parseInt(m[1]);
      const col     = Math.max(0, parseInt(m[2]) - 1);
      const from = offsetFromLineCol(lineNum, col);
      diagnostics.push({ from, to: from + (lines[lineNum - 1]?.length || 1), severity: m[3] === 'Error' ? 'error' : 'warning', message: m[4].trim() });
    }
  }
  return diagnostics;
}

async function checkOctave(content, childEnv) {
  const { lines, offsetFromLineCol } = makeLineIndex(content);
  const tmpFile = path.join(os.tmpdir(), `sc_lint_${Date.now()}_${Math.random().toString(36).slice(2)}.m`);
  try { fs.writeFileSync(tmpFile, content, 'utf8'); } catch { return []; }

  const escPath = tmpFile.replace(/\\/g, '\\\\').replace(/'/g, "\\'");
  const { err, stdout, stderr } = await execFileFallback(
    [['octave', ['--no-gui', '--eval', `source('${escPath}')`]]],
    { timeout: 15000, env: childEnv, maxBuffer: 512 * 1024 }
  );
  try { fs.unlinkSync(tmpFile); } catch {}
  if (!err) return [];

  const raw = (stderr || stdout || '').toString();
  const diagnostics = [];
  // "file:N: parse error: message" or "error: ... near line N column C"
  const re = /:(\d+):\s*(?:parse error|error):\s*(.+)/gi;
  let m;
  while ((m = re.exec(raw))) {
    const lineNum = parseInt(m[1]);
    const from = offsetFromLineCol(lineNum);
    diagnostics.push({ from, to: from + (lines[lineNum - 1]?.length || 1), severity: 'error', message: m[2].trim() });
  }
  return diagnostics;
}

async function checkWolfram(content, childEnv) {
  const { lines, offsetFromLineCol } = makeLineIndex(content);
  const tmpFile = path.join(os.tmpdir(), `sc_lint_${Date.now()}_${Math.random().toString(36).slice(2)}.wl`);
  try { fs.writeFileSync(tmpFile, content, 'utf8'); } catch { return []; }

  const { err, stdout, stderr } = await execFileFallback(
    [['wolframscript', ['-file', tmpFile]]],
    { timeout: 20000, env: childEnv, maxBuffer: 512 * 1024 }
  );
  try { fs.unlinkSync(tmpFile); } catch {}
  if (!err) return [];

  const raw = (stderr || stdout || '').toString();
  const diagnostics = [];
  // Wolfram syntax errors often include line info in the message
  const re = /\(line (\d+)\)|at position (\d+)/gi;
  let m;
  while ((m = re.exec(raw))) {
    const lineNum = parseInt(m[1] || '1');
    const from = offsetFromLineCol(lineNum);
    diagnostics.push({ from, to: from + (lines[lineNum - 1]?.length || 1), severity: 'error', message: raw.split('\n')[0].trim() || 'Wolfram syntax error' });
    break;
  }
  if (!diagnostics.length && err) {
    diagnostics.push({ from: 0, to: 1, severity: 'error', message: raw.split('\n')[0].trim() || 'Wolfram syntax error' });
  }
  return diagnostics;
}

async function checkSas(content, childEnv) {
  const { lines, offsetFromLineCol } = makeLineIndex(content);
  const dir = mkScratchDir();
  const tmpFile = path.join(dir, `check_${Date.now()}.sas`);
  try { fs.writeFileSync(tmpFile, content, 'utf8'); } catch { rmScratchDir(dir); return []; }

  const { err, stdout, stderr } = await execFileFallback(
    [['sas', ['-syntax', tmpFile]]],
    { timeout: 20000, env: childEnv, maxBuffer: 1024 * 1024, cwd: dir }
  );

  // SAS writes to a .log file
  const logFile = tmpFile.replace(/\.sas$/, '.log');
  let logContent = '';
  try { logContent = fs.readFileSync(logFile, 'utf8'); } catch {}
  rmScratchDir(dir);

  const raw = logContent || (stdout || stderr || '').toString();
  const diagnostics = [];
  // SAS log format: "ERROR N-N: message" or "ERROR: message at line N"
  const re = /^ERROR(?:\s+\d+-\d+)?:\s*(.+)/gm;
  let m;
  while ((m = re.exec(raw))) {
    // Try to find line number from context
    const lineCtx = raw.slice(Math.max(0, m.index - 200), m.index);
    const lineM = lineCtx.match(/line (\d+)/i);
    const lineNum = lineM ? parseInt(lineM[1]) : 1;
    const from = offsetFromLineCol(lineNum);
    diagnostics.push({ from, to: from + (lines[lineNum - 1]?.length || 1), severity: 'error', message: m[1].trim() });
  }
  return diagnostics;
}

async function checkCobol(content, childEnv) {
  const { lines, offsetFromLineCol } = makeLineIndex(content);
  const tmpFile = path.join(os.tmpdir(), `sc_lint_${Date.now()}_${Math.random().toString(36).slice(2)}.cob`);
  try { fs.writeFileSync(tmpFile, content, 'utf8'); } catch { return []; }

  const { err, stdout, stderr } = await execFileFallback(
    [['cobc', ['-fsyntax-only', tmpFile]]],
    { timeout: 15000, env: childEnv, maxBuffer: 512 * 1024 }
  );
  try { fs.unlinkSync(tmpFile); } catch {}
  if (!err) return [];

  const raw = (stderr || stdout || '').toString();
  return parseGccStyleDiagnostics(raw, lines, offsetFromLineCol);
}

async function checkAda(content, childEnv) {
  const { lines, offsetFromLineCol } = makeLineIndex(content);
  const dir = mkScratchDir();
  const tmpFile = path.join(dir, `check_${Date.now()}.adb`);
  try { fs.writeFileSync(tmpFile, content, 'utf8'); } catch { rmScratchDir(dir); return []; }

  const { err, stdout, stderr } = await execFileFallback(
    [['gnatmake', ['-gnats', tmpFile]]],
    { timeout: 20000, env: childEnv, maxBuffer: 512 * 1024, cwd: dir }
  );
  rmScratchDir(dir);
  if (!err) return [];

  const raw = (stderr || stdout || '').toString();
  return parseGccStyleDiagnostics(raw, lines, offsetFromLineCol);
}

async function checkD(content, childEnv) {
  const { lines, offsetFromLineCol } = makeLineIndex(content);
  const tmpFile = path.join(os.tmpdir(), `sc_lint_${Date.now()}_${Math.random().toString(36).slice(2)}.d`);
  try { fs.writeFileSync(tmpFile, content, 'utf8'); } catch { return []; }

  const { err, stdout, stderr } = await execFileFallback(
    [['dmd', ['-o-', tmpFile]]],
    { timeout: 15000, env: childEnv, maxBuffer: 512 * 1024 }
  );
  try { fs.unlinkSync(tmpFile); } catch {}
  if (!err) return [];

  const raw = (stderr || stdout || '').toString();
  return parseGccStyleDiagnostics(raw, lines, offsetFromLineCol);
}

async function checkNim(content, childEnv) {
  const { lines, offsetFromLineCol } = makeLineIndex(content);
  const tmpFile = path.join(os.tmpdir(), `sc_lint_${Date.now()}_${Math.random().toString(36).slice(2)}.nim`);
  try { fs.writeFileSync(tmpFile, content, 'utf8'); } catch { return []; }

  const { err, stdout, stderr } = await execFileFallback(
    [['nim', ['check', '--hints:off', tmpFile]]],
    { timeout: 15000, env: childEnv, maxBuffer: 512 * 1024 }
  );
  try { fs.unlinkSync(tmpFile); } catch {}

  // nim check outputs errors to stdout even on failure
  const raw = (stdout || stderr || '').toString();
  if (!err && !/Error:/i.test(raw)) return [];
  return parseGccStyleDiagnostics(raw, lines, offsetFromLineCol);
}

async function checkZig(content, childEnv) {
  const { lines, offsetFromLineCol } = makeLineIndex(content);
  const tmpFile = path.join(os.tmpdir(), `sc_lint_${Date.now()}_${Math.random().toString(36).slice(2)}.zig`);
  try { fs.writeFileSync(tmpFile, content, 'utf8'); } catch { return []; }

  const { err, stdout, stderr } = await execFileFallback(
    [['zig', ['ast-check', tmpFile]]],
    { timeout: 10000, env: childEnv, maxBuffer: 512 * 1024 }
  );
  try { fs.unlinkSync(tmpFile); } catch {}
  if (!err) return [];

  const raw = (stderr || stdout || '').toString();
  return parseGccStyleDiagnostics(raw, lines, offsetFromLineCol);
}

async function checkVlang(content, childEnv) {
  const { lines, offsetFromLineCol } = makeLineIndex(content);
  const tmpFile = path.join(os.tmpdir(), `sc_lint_${Date.now()}_${Math.random().toString(36).slice(2)}.v`);
  try { fs.writeFileSync(tmpFile, content, 'utf8'); } catch { return []; }

  const { err, stdout, stderr } = await execFileFallback(
    [['v', ['-check', tmpFile]]],
    { timeout: 15000, env: childEnv, maxBuffer: 512 * 1024 }
  );
  try { fs.unlinkSync(tmpFile); } catch {}
  if (!err) return [];

  const raw = (stderr || stdout || '').toString();
  return parseGccStyleDiagnostics(raw, lines, offsetFromLineCol);
}

// ── IPC: Syntax check ─────────────────────────────────────────────────────────
ipcMain.handle('syntax:check', async (_event, { language, content }) => {
  if (!content || content.trim().length < 3) return { ok: true, diagnostics: [] };

  const lang = (language || '').toLowerCase();
  const childEnv = buildChildEnv();

  // JSON — handled entirely client-side (JSON.parse)
  if (lang === 'json') return { ok: true, diagnostics: [] };

  // SQL — client-side scan (no subprocess needed)
  if (lang === 'sql') return { ok: true, diagnostics: checkSql(content) };

  // Gate: only languages registered in SYNTAX_CHECKERS are checkable
  if (!getSyntaxCheckerInfo(lang)) return { ok: true, diagnostics: [] };

  try {
    // ── Group [1] ────────────────────────────────────────────────────────────
    if (lang === 'java') {
      return { ok: true, diagnostics: await checkJava(content, childEnv) };
    }
    if (lang === 'c' || lang === 'h' || lang === 'cpp' || lang === 'cc' || lang === 'cxx' || lang === 'hpp') {
      return { ok: true, diagnostics: await checkCFamily(content, lang, childEnv) };
    }
    if (lang === 'cs' || lang === 'csharp') {
      return { ok: true, diagnostics: await checkCSharp(content, childEnv) };
    }
    if (lang === 'php') {
      return { ok: true, diagnostics: await checkPhp(content, childEnv) };
    }
    if (lang === 'go') {
      return { ok: true, diagnostics: await checkGo(content, childEnv) };
    }
    if (lang === 'rust' || lang === 'rs') {
      return { ok: true, diagnostics: await checkRust(content, childEnv) };
    }

    // ── Group 2 ──────────────────────────────────────────────────────────────
    if (lang === 'ruby' || lang === 'rb') {
      return { ok: true, diagnostics: await checkRuby(content, childEnv) };
    }
    if (lang === 'swift') {
      return { ok: true, diagnostics: await checkSwift(content, childEnv) };
    }
    if (lang === 'kotlin' || lang === 'kt' || lang === 'kts') {
      return { ok: true, diagnostics: await checkKotlin(content, childEnv) };
    }
    if (lang === 'scala') {
      return { ok: true, diagnostics: await checkScala(content, childEnv) };
    }
    if (lang === 'shell' || lang === 'sh' || lang === 'bash' || lang === 'zsh' || lang === 'fish') {
      return { ok: true, diagnostics: await checkShell(content, childEnv) };
    }
    if (lang === 'powershell' || lang === 'ps1') {
      return { ok: true, diagnostics: await checkPowerShell(content, childEnv) };
    }
    if (lang === 'r') {
      return { ok: true, diagnostics: await checkR(content, childEnv) };
    }
    if (lang === 'dart') {
      return { ok: true, diagnostics: await checkDart(content, childEnv) };
    }
    if (lang === 'lua') {
      return { ok: true, diagnostics: await checkLua(content, childEnv) };
    }

    // ── Group 3 ──────────────────────────────────────────────────────────────
    if (lang === 'groovy') {
      return { ok: true, diagnostics: await checkGroovy(content, childEnv) };
    }
    if (lang === 'perl' || lang === 'pl' || lang === 'pm') {
      return { ok: true, diagnostics: await checkPerl(content, childEnv) };
    }
    if (lang === 'haskell' || lang === 'hs') {
      return { ok: true, diagnostics: await checkHaskell(content, childEnv) };
    }
    if (lang === 'elixir' || lang === 'ex' || lang === 'exs') {
      return { ok: true, diagnostics: await checkElixir(content, childEnv) };
    }
    if (lang === 'erlang' || lang === 'erl' || lang === 'hrl') {
      return { ok: true, diagnostics: await checkErlang(content, childEnv) };
    }
    if (lang === 'clojure' || lang === 'clj' || lang === 'cljs') {
      return { ok: true, diagnostics: await checkClojure(content, childEnv) };
    }
    if (lang === 'julia' || lang === 'jl') {
      return { ok: true, diagnostics: await checkJulia(content, childEnv) };
    }
    if (lang === 'crystal' || lang === 'cr') {
      return { ok: true, diagnostics: await checkCrystal(content, childEnv) };
    }
    if (lang === 'fsharp' || lang === 'fs' || lang === 'fsx') {
      return { ok: true, diagnostics: await checkFSharp(content, childEnv) };
    }

    // ── Group 6 — external tool checkers ─────────────────────────────────────
    const g6checker = GROUP6_CHECKERS[lang];
    if (g6checker) {
      return runGroup6ExternalChecker(g6checker, lang, content, childEnv);
    }

    // ── Group 7 ──────────────────────────────────────────────────────────────
    if (lang === 'latex' || lang === 'tex') {
      return { ok: true, diagnostics: await checkLatex(content, childEnv) };
    }
    if (lang === 'matlab' || lang === 'octave') {
      return { ok: true, diagnostics: await checkOctave(content, childEnv) };
    }
    if (lang === 'mathematica' || lang === 'wolfram' || lang === 'wl') {
      return { ok: true, diagnostics: await checkWolfram(content, childEnv) };
    }
    if (lang === 'sas') {
      return { ok: true, diagnostics: await checkSas(content, childEnv) };
    }
    if (lang === 'cobol' || lang === 'cob' || lang === 'cbl') {
      return { ok: true, diagnostics: await checkCobol(content, childEnv) };
    }
    if (lang === 'ada' || lang === 'adb' || lang === 'ads') {
      return { ok: true, diagnostics: await checkAda(content, childEnv) };
    }
    if (lang === 'd') {
      return { ok: true, diagnostics: await checkD(content, childEnv) };
    }
    if (lang === 'nim') {
      return { ok: true, diagnostics: await checkNim(content, childEnv) };
    }
    if (lang === 'zig') {
      return { ok: true, diagnostics: await checkZig(content, childEnv) };
    }
    if (lang === 'vlang') {
      return { ok: true, diagnostics: await checkVlang(content, childEnv) };
    }

    // ── JS / TS / Python ─────────────────────────────────────────────────────
    const extMap = {
      javascript: 'js', js: 'js', mjs: 'mjs', cjs: 'cjs', jsx: 'jsx',
      typescript: 'ts', ts: 'ts', tsx: 'tsx',
      python: 'py', py: 'py', pyw: 'py',
    };
    const ext = extMap[lang];
    if (!ext) return { ok: true, diagnostics: [] };

    const tmpFile = path.join(os.tmpdir(), `sc_lint_${Date.now()}_${Math.random().toString(36).slice(2)}.${ext}`);
    try { fs.writeFileSync(tmpFile, content, 'utf8'); } catch { return { ok: true, diagnostics: [] }; }

    const cleanup = () => { try { fs.unlinkSync(tmpFile); } catch {} };
    const { lines, offsetFromLineCol } = makeLineIndex(content);

    return new Promise((resolve) => {
      let cmd, args;
      if (lang === 'python' || lang === 'py' || lang === 'pyw') {
        cmd = 'python';
        args = ['-m', 'py_compile', tmpFile];
      } else {
        // JS / TS — use node --check for fast syntax-only validation
        cmd = 'node';
        args = ['--check', tmpFile];
      }

      execFile(cmd, args, { timeout: 8000, env: childEnv, maxBuffer: 512 * 1024 },
        (err, stdout, stderr) => {
          cleanup();
          if (!err) return resolve({ ok: true, diagnostics: [] });

          const raw = (stderr || stdout || err.message || '').toString();
          const diagnostics = [];

          const nodeLineMatch = raw.match(new RegExp(tmpFile.replace(/[\\]/g, '\\\\').replace(/\./g, '\\.') + ':(\\d+)'));
          if (nodeLineMatch) {
            const lineNum = parseInt(nodeLineMatch[1]);
            const from = offsetFromLineCol(lineNum);
            const to   = from + (lines[lineNum - 1]?.length || 1);
            const msgLine = raw.match(/^(SyntaxError:.+)/m);
            diagnostics.push({ from, to, severity: 'error', message: (msgLine?.[1] || 'Syntax error').trim() });
          }

          const pyLineMatch = raw.match(/line (\d+)/);
          if (pyLineMatch && (lang === 'python' || lang === 'py' || lang === 'pyw')) {
            const lineNum = parseInt(pyLineMatch[1]);
            const from = offsetFromLineCol(lineNum);
            const to   = from + (lines[lineNum - 1]?.length || 1);
            const msgLine = raw.match(/\n((?:SyntaxError|IndentationError|TabError|NameError).+)/);
            diagnostics.push({ from, to, severity: 'error', message: (msgLine?.[1] || 'Syntax error').trim() });
          }

          resolve({ ok: true, diagnostics });
        }
      );
    });
  } catch {
    return { ok: true, diagnostics: [] };
  }
});

// Kill all running processes on app quit
app.on('before-quit', () => {
  for (const [pid] of runningProcesses) {
    try { spawn('taskkill', ['/F', '/T', '/PID', String(pid)], { windowsHide: true }); } catch {}
  }
  runningProcesses.clear();
});

// ── IPC: workspace persistence ────────────────────────────────────────────────
const workspaceFile = () => {
  const { app } = require('electron');
  return path.join(app.getPath('userData'), 'workspace.json');
};

ipcMain.handle('workspace:save', (_event, data) => {
  try {
    fs.writeFileSync(workspaceFile(), JSON.stringify(data, null, 2), 'utf8');
    return { ok: true };
  } catch (e) { return { ok: false, error: e.message }; }
});

ipcMain.handle('workspace:load', () => {
  try {
    const p = workspaceFile();
    if (!fs.existsSync(p)) return { ok: true, data: null };
    return { ok: true, data: JSON.parse(fs.readFileSync(p, 'utf8')) };
  } catch (e) { return { ok: true, data: null }; }
});

// ── IPC: open preview in floating window ──────────────────────────────────────
ipcMain.handle('preview:open', (_event, url) => {
  const win = new BrowserWindow({
    width: 1100, height: 750,
    title: `Preview — ${url}`,
    autoHideMenuBar: true,
    backgroundColor: '#0b0e14',
    webPreferences: { contextIsolation: true, nodeIntegration: false },
  });
  win.loadURL(url);
  return { ok: true };
});

// ── IPC: session history ──────────────────────────────────────────────────────
ipcMain.handle('session:save',   (_e, session)         => saveSession(session));
ipcMain.handle('session:list',   ()                    => listSessions());
ipcMain.handle('session:load',   (_e, id)              => loadSession(id));
ipcMain.handle('session:delete', (_e, id)              => deleteSession(id));
ipcMain.handle('session:pin',    (_e, id, pinned)      => pinSession(id, pinned));
ipcMain.handle('session:cleanup',(_e, retainDays)      => runCleanup(retainDays));
ipcMain.handle('session:memory', ()                    => loadMemory());

// ── IPC: runtime library ──────────────────────────────────────────────────────
ipcMain.handle('runtime:detect', () => detectRuntimes());
ipcMain.handle('runtime:for-lang', (_e, lang) => getRuntimeForLang(lang));

// ── IPC: filesystem ───────────────────────────────────────────────────────────

ipcMain.handle('fs:open-folder-dialog', async () => {
  const result = await dialog.showOpenDialog(mainWindow, {
    properties: ['openDirectory'],
    title     : 'Open Project Folder',
  });
  if (result.canceled || result.filePaths.length === 0) return null;
  return result.filePaths[0];
});

ipcMain.handle('fs:open-file-dialog', async () => {
  const result = await dialog.showOpenDialog(mainWindow, {
    properties: ['openFile', 'multiSelections'],
    title     : 'Open File(s)',
  });
  if (result.canceled) return [];
  return result.filePaths;
});

ipcMain.handle('fs:create-folder-dialog', async () => {
  const result = await dialog.showSaveDialog(mainWindow, {
    title          : 'Create New Folder',
    defaultPath    : path.join(require('os').homedir(), 'New Folder'),
    buttonLabel    : 'Create',
    nameFieldLabel : 'Folder name:',
  });
  if (result.canceled || !result.filePath) return null;
  try {
    fs.mkdirSync(result.filePath, { recursive: true });
    return result.filePath;
  } catch (e) {
    return { error: e.message };
  }
});

/**
 * Create a subfolder directly at parentPath/folderName — no dialog.
 * Used by the in-tree "New Folder" inline creation flow.
 */
ipcMain.handle('fs:create-subfolder', async (_event, parentPath, folderName) => {
  if (!parentPath || !folderName) return { ok: false, error: 'parentPath and folderName are required' };
  const targetPath = path.join(parentPath, folderName);
  try {
    fs.mkdirSync(targetPath); // non-recursive: intentionally fails if already exists
    return { ok: true, path: targetPath };
  } catch (e) {
    return { ok: false, error: e.message };
  }
});

/**
 * Detect the project type from files present at projectPath, then return the
 * list of scaffold-generated folder names and the relative path (from the
 * project root) where each one lives.  The UI uses this to block a user from
 * accidentally shadowing a system folder at the exact location the scaffold
 * placed it, while allowing the same name anywhere else in the tree.
 *
 * atRelPath is '' for project-root level, 'src' for inside src/, etc.
 * All separators are forward slashes regardless of platform.
 */
(function () {
  // Derive which folders each scaffold generates, keyed by project-type string.
  const SCAFFOLD_RESERVED = {
    'java-maven':    [
      { folderName: 'src',   atRelPath: '' },
      { folderName: 'main',  atRelPath: 'src' },
      { folderName: 'java',  atRelPath: 'src/main' },
    ],
    'java-gradle':   [
      { folderName: 'src',   atRelPath: '' },
      { folderName: 'main',  atRelPath: 'src' },
      { folderName: 'java',  atRelPath: 'src/main' },
    ],
    'kotlin-gradle': [
      { folderName: 'src',    atRelPath: '' },
      { folderName: 'main',   atRelPath: 'src' },
      { folderName: 'kotlin', atRelPath: 'src/main' },
    ],
    'rust':          [{ folderName: 'src', atRelPath: '' }],
    'elixir-mix':    [{ folderName: 'lib', atRelPath: '' }],
    'scala-sbt':     [
      { folderName: 'src',   atRelPath: '' },
      { folderName: 'main',  atRelPath: 'src' },
      { folderName: 'scala', atRelPath: 'src/main' },
    ],
    'haskell-stack': [{ folderName: 'app', atRelPath: '' }],
    'haskell-cabal': [{ folderName: 'app', atRelPath: '' }],
    'python-package':[{ folderName: 'src', atRelPath: '' }],
  };

  /** Detect project type by probing for well-known marker files. */
  function detectProjectType(projectPath) {
    const exists = (rel) => {
      try { fs.statSync(path.join(projectPath, rel)); return true; } catch { return false; }
    };
    const hasExt = (ext) => {
      try { return fs.readdirSync(projectPath).some((f) => f.endsWith(ext)); }
      catch { return false; }
    };
    if (exists('pom.xml'))                                    return 'java-maven';
    if (exists('build.gradle.kts') || exists('settings.gradle.kts')) return 'kotlin-gradle';
    if (exists('build.gradle')     || exists('settings.gradle'))      return 'java-gradle';
    if (exists('Cargo.toml'))                                 return 'rust';
    if (exists('mix.exs'))                                    return 'elixir-mix';
    if (exists('build.sbt'))                                  return 'scala-sbt';
    if (exists('stack.yaml') || exists('package.yaml'))       return 'haskell-stack';
    if (hasExt('.cabal'))                                     return 'haskell-cabal';
    if (exists('pyproject.toml'))                             return 'python-package';
    return null;
  }

  ipcMain.handle('project:reserved-folders', async (_event, projectPath) => {
    if (!projectPath) return [];
    const type = detectProjectType(projectPath);
    if (!type) return [];
    return (SCAFFOLD_RESERVED[type] || []).map((r) => ({ ...r, projectType: type }));
  });
})();

function indexDirectory(dirPath, maxDepth = 6, depth = 0) {
  if (depth > maxDepth) return [];
  let entries;
  try { entries = fs.readdirSync(dirPath, { withFileTypes: true }); }
  catch { return []; }

  const IGNORED = new Set([
    'node_modules', '.git', 'dist', 'build', 'out', '.next',
    '.cache', '__pycache__', '.venv', 'venv', '.idea', '.vs',
    'coverage', '.nyc_output', 'release', 'Models',
  ]);

  const nodes = [];
  for (const entry of entries) {
    if (entry.name.startsWith('.') && entry.name !== '.env') continue;
    if (IGNORED.has(entry.name)) continue;
    const fullPath = path.join(dirPath, entry.name);
    if (entry.isDirectory()) {
      nodes.push({ name: entry.name, path: fullPath, type: 'directory', children: indexDirectory(fullPath, maxDepth, depth + 1) });
    } else if (entry.isFile()) {
      let size = 0;
      try { size = fs.statSync(fullPath).size; } catch {}
      nodes.push({ name: entry.name, path: fullPath, type: 'file', size, language: getLanguage(entry.name) });
    }
  }
  nodes.sort((a, b) => {
    if (a.type !== b.type) return a.type === 'directory' ? -1 : 1;
    return a.name.localeCompare(b.name);
  });
  return nodes;
}

function getLanguage(filename) {
  const ext = (filename.split('.').pop() || '').toLowerCase();
  const map = {
    js: 'javascript', jsx: 'jsx', mjs: 'javascript',
    ts: 'typescript', tsx: 'tsx',
    py: 'python', java: 'java',
    c: 'c', cpp: 'cpp', cs: 'csharp',
    go: 'go', rs: 'rust', rb: 'ruby',
    html: 'html', css: 'css', scss: 'scss',
    json: 'json', yaml: 'yaml', yml: 'yaml',
    md: 'markdown', sql: 'sql',
    sh: 'bash', bash: 'bash',
    xml: 'xml', toml: 'toml', php: 'php',
    kt: 'kotlin', swift: 'swift', dart: 'dart',
    lua: 'lua', r: 'r', txt: 'plaintext',
    pl: 'perl', pm: 'perl', hs: 'haskell',
    ex: 'elixir', exs: 'elixir', erl: 'erlang',
    clj: 'clojure', jl: 'julia', cr: 'crystal',
    fs: 'fsharp', fsx: 'fsharp', vb: 'vbnet',
    tex: 'latex', wl: 'wolfram', sas: 'sas',
    cob: 'cobol', cbl: 'cobol', adb: 'ada', ads: 'ada',
    nim: 'nim', zig: 'zig', d: 'd',
    proto: 'protobuf', graphql: 'graphql', gql: 'graphql',
    ini: 'ini', cfg: 'cfg', conf: 'nginx',
    diff: 'diff', patch: 'patch',
    groovy: 'groovy', scala: 'scala', ps1: 'powershell',
    gradle: 'gradle', cmake: 'cmake',
    kts: 'kotlin', swift: 'swift',
  };
  return map[ext] || 'plaintext';
}

ipcMain.handle('fs:read-directory', (_event, dirPath) => {
  try { return { ok: true, tree: indexDirectory(dirPath) }; }
  catch (e) { return { ok: false, error: e.message, tree: [] }; }
});

ipcMain.handle('fs:read-file', (_event, filePath) => {
  try {
    const stat = fs.statSync(filePath);
    if (stat.size > 2 * 1024 * 1024) return { ok: false, error: 'File too large (> 2 MB)' };
    return { ok: true, content: fs.readFileSync(filePath, 'utf8') };
  } catch (e) { return { ok: false, error: e.message }; }
});

ipcMain.handle('fs:write-file', (_event, filePath, content) => {
  try { fs.writeFileSync(filePath, content, 'utf8'); return { ok: true }; }
  catch (e) { return { ok: false, error: e.message }; }
});

ipcMain.handle('fs:rename-file', (_event, fromPath, toPath) => {
  try {
    if (!fs.existsSync(fromPath)) return { ok: false, error: 'Source file not found' };
    const dir = path.dirname(toPath);
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
    if (fs.existsSync(toPath) && path.resolve(fromPath) !== path.resolve(toPath)) {
      return { ok: false, error: 'A file with that name already exists' };
    }
    fs.renameSync(fromPath, toPath);
    return { ok: true };
  } catch (e) { return { ok: false, error: e.message }; }
});

ipcMain.handle('fs:delete-file', (_event, filePath) => {
  try {
    if (fs.existsSync(filePath)) fs.unlinkSync(filePath);
    return { ok: true };
  } catch (e) { return { ok: false, error: e.message }; }
});

ipcMain.handle('fs:delete-folder', (_event, folderPath) => {
  try {
    if (fs.existsSync(folderPath)) fs.rmSync(folderPath, { recursive: true, force: true });
    return { ok: true };
  } catch (e) { return { ok: false, error: e.message }; }
});

// ── IPC: write multiple files at once ─────────────────────────────────────────
ipcMain.handle('fs:write-files', (_event, files) => {
  const results = [];
  for (const { path: filePath, content } of files) {
    try {
      const dir = path.dirname(filePath);
      if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
      if (fs.existsSync(filePath)) {
        fs.copyFileSync(filePath, filePath + '.bak');
      }
      fs.writeFileSync(filePath, content, 'utf8');
      results.push({ path: filePath, ok: true, hadBackup: fs.existsSync(filePath + '.bak') });
      console.log('[main] Wrote file:', filePath);
    } catch (e) {
      results.push({ path: filePath, ok: false, error: e.message });
      console.error('[main] Failed to write file:', filePath, e.message);
    }
  }
  return results;
});

// ── IPC: undo a write-files operation ─────────────────────────────────────────
ipcMain.handle('fs:undo-write-files', (_event, filePaths) => {
  const results = [];
  for (const filePath of filePaths) {
    const bakPath = filePath + '.bak';
    try {
      if (!fs.existsSync(bakPath)) {
        if (fs.existsSync(filePath)) fs.unlinkSync(filePath);
        results.push({ path: filePath, ok: true, action: 'deleted' });
      } else {
        fs.copyFileSync(bakPath, filePath);
        fs.unlinkSync(bakPath);
        results.push({ path: filePath, ok: true, action: 'restored' });
      }
      console.log('[main] Undid write for:', filePath);
    } catch (e) {
      results.push({ path: filePath, ok: false, error: e.message });
    }
  }
  return results;
});

ipcMain.handle('fs:stat-path', (_event, targetPath) => {
  try {
    const stat = fs.statSync(targetPath);
    return { ok: true, isDirectory: stat.isDirectory(), isFile: stat.isFile() };
  } catch (e) { return { ok: false, error: e.message, isDirectory: false, isFile: false }; }
});

ipcMain.handle('fs:write-file-safe', (_event, filePath, content) => {
  try {
    if (fs.existsSync(filePath)) fs.copyFileSync(filePath, filePath + '.bak');
    fs.writeFileSync(filePath, content, 'utf8');
    return { ok: true };
  } catch (e) { return { ok: false, error: e.message }; }
});

ipcMain.handle('fs:restore-backup', (_event, filePath) => {
  const bakPath = filePath + '.bak';
  try {
    if (!fs.existsSync(bakPath)) return { ok: false, error: 'No backup found' };
    fs.copyFileSync(bakPath, filePath);
    return { ok: true };
  } catch (e) { return { ok: false, error: e.message }; }
});

// ── IPC: Create new project ───────────────────────────────────────────────────
// The wizard now passes parentDir and projectType — no dialog is opened here.
ipcMain.handle('project:create', async (_event, { name, language, projectType, parentDir }) => {
  if (!parentDir) return { ok: false, error: 'No parent directory provided' };

  const sanitized = (name || 'my-project')
    .replace(/[^\w\-. ]/g, '')
    .replace(/\s+/g, '-')
    .replace(/^[-. ]+|[-. ]+$/g, '')
    .trim() || 'my-project';

  const projectDir = path.join(parentDir, sanitized);

  try {
    fs.mkdirSync(projectDir, { recursive: true });
  } catch (e) {
    return { ok: false, error: `Could not create folder: ${e.message}` };
  }

  const write = (relPath, content) => {
    const fullPath = path.join(projectDir, relPath);
    const dir = path.dirname(fullPath);
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(fullPath, content, 'utf8');
  };

  const pkgName = sanitized.replace(/[^a-z0-9_-]/gi, '-').toLowerCase();

  try {
    const lang = (language || '').toLowerCase();
    const ptype = (projectType || '').toLowerCase();

    // ── TypeScript ─────────────────────────────────────────────────────────
    if (lang === 'typescript') {
      const tsConfig = JSON.stringify({
        compilerOptions: {
          target: 'ES2020', module: 'commonjs', strict: true,
          esModuleInterop: true, outDir: 'dist', rootDir: '.',
        }, include: ['*.ts'],
      }, null, 2);
      write('index.ts', `const greeting: string = 'Hello from SenCode!';\nconsole.log(greeting);\n`);
      write('tsconfig.json', tsConfig);
      if (ptype === 'node') {
        write('package.json', JSON.stringify({
          name: pkgName, version: '1.0.0',
          scripts: { start: 'npx tsx index.ts', build: 'tsc' },
          devDependencies: { typescript: '^5.0.0', tsx: '^4.0.0' },
        }, null, 2));
      }
    }

    // ── JavaScript ─────────────────────────────────────────────────────────
    else if (lang === 'javascript') {
      write('index.js', `const greeting = 'Hello from SenCode!';\nconsole.log(greeting);\n`);
      if (ptype === 'node') {
        write('package.json', JSON.stringify({
          name: pkgName, version: '1.0.0', type: 'module',
          scripts: { start: 'node index.js' },
        }, null, 2));
      }
    }

    // ── HTML ───────────────────────────────────────────────────────────────
    else if (lang === 'html') {
      write('index.html', `<!DOCTYPE html>\n<html lang="en">\n<head>\n  <meta charset="UTF-8" />\n  <meta name="viewport" content="width=device-width, initial-scale=1.0" />\n  <title>${sanitized}</title>\n  <style>\n    body { font-family: sans-serif; display: flex; align-items: center; justify-content: center; height: 100vh; margin: 0; background: #0b0e14; color: #e8eaf2; }\n    h1 { font-size: 2rem; }\n  </style>\n</head>\n<body>\n  <h1>Hello from ${sanitized}!</h1>\n</body>\n</html>\n`);
    }

    // ── Python ─────────────────────────────────────────────────────────────
    else if (lang === 'python') {
      if (ptype === 'package') {
        const modName = pkgName.replace(/-/g, '_');
        write(`src/${modName}/__init__.py`, `"""${sanitized} package."""\n`);
        write(`src/${modName}/main.py`, `def main():\n    print("Hello from SenCode!")\n\nif __name__ == "__main__":\n    main()\n`);
        write('pyproject.toml', `[build-system]\nrequires = ["setuptools>=68"]\nbuild-backend = "setuptools.backends.legacy:build"\n\n[project]\nname = "${pkgName}"\nversion = "0.1.0"\ndescription = "A new Python package"\nrequires-python = ">=3.9"\n`);
        write('README.md', `# ${sanitized}\n\nA new Python package.\n`);
      } else {
        // script (default)
        write('main.py', `def main():\n    print("Hello from SenCode!")\n\nif __name__ == "__main__":\n    main()\n`);
        write('requirements.txt', '# Add your dependencies here\n# e.g. requests==2.31.0\n');
      }
    }

    // ── Java ───────────────────────────────────────────────────────────────
    else if (lang === 'java') {
      const mainContent = `public class Main {\n    public static void main(String[] args) {\n        System.out.println("Hello from SenCode!");\n    }\n}\n`;
      if (ptype === 'maven') {
        write('pom.xml', `<?xml version="1.0" encoding="UTF-8"?>\n<project xmlns="http://maven.apache.org/POM/4.0.0"\n         xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance"\n         xsi:schemaLocation="http://maven.apache.org/POM/4.0.0 http://maven.apache.org/xsd/maven-4.0.0.xsd">\n  <modelVersion>4.0.0</modelVersion>\n  <groupId>com.example</groupId>\n  <artifactId>${pkgName}</artifactId>\n  <version>1.0.0</version>\n  <properties>\n    <maven.compiler.source>21</maven.compiler.source>\n    <maven.compiler.target>21</maven.compiler.target>\n  </properties>\n</project>\n`);
        write('src/main/java/Main.java', mainContent);
      } else if (ptype === 'gradle') {
        write('build.gradle', `plugins {\n    id 'java'\n    id 'application'\n}\n\napplication {\n    mainClass = 'Main'\n}\n\nrepositories { mavenCentral() }\n`);
        write('settings.gradle', `rootProject.name = '${pkgName}'\n`);
        write('src/main/java/Main.java', mainContent);
      } else {
        // plain
        write('Main.java', mainContent);
      }
    }

    // ── Kotlin ─────────────────────────────────────────────────────────────
    else if (lang === 'kotlin') {
      const mainContent = `fun main() {\n    println("Hello from SenCode!")\n}\n`;
      if (ptype === 'gradle') {
        write('build.gradle.kts', `plugins {\n    kotlin("jvm") version "1.9.0"\n    application\n}\n\napplication {\n    mainClass.set("MainKt")\n}\n\nrepositories { mavenCentral() }\n\ndependencies {\n    implementation(kotlin("stdlib"))\n}\n`);
        write('settings.gradle.kts', `rootProject.name = "${pkgName}"\n`);
        write('src/main/kotlin/Main.kt', mainContent);
      } else {
        write('Main.kt', mainContent);
      }
    }

    // ── Rust ───────────────────────────────────────────────────────────────
    else if (lang === 'rust') {
      const cargoName = pkgName.replace(/[^a-z0-9_-]/g, '-');
      if (ptype === 'library') {
        write('src/lib.rs', `/// Hello from SenCode!\npub fn greet() -> &'static str {\n    "Hello from SenCode!"\n}\n\n#[cfg(test)]\nmod tests {\n    use super::*;\n    #[test]\n    fn it_works() {\n        assert_eq!(greet(), "Hello from SenCode!");\n    }\n}\n`);
        write('Cargo.toml', `[package]\nname = "${cargoName}"\nversion = "0.1.0"\nedition = "2021"\n\n[lib]\nname = "${cargoName.replace(/-/g, '_')}"\n\n[dependencies]\n`);
      } else {
        // binary (default)
        write('src/main.rs', `fn main() {\n    println!("Hello from SenCode!");\n}\n`);
        write('Cargo.toml', `[package]\nname = "${cargoName}"\nversion = "0.1.0"\nedition = "2021"\n\n[dependencies]\n`);
      }
    }

    // ── Go ─────────────────────────────────────────────────────────────────
    else if (lang === 'go') {
      write('main.go', `package main\n\nimport "fmt"\n\nfunc main() {\n\tfmt.Println("Hello from SenCode!")\n}\n`);
      if (ptype !== 'plain') {
        // module (default)
        write('go.mod', `module ${pkgName}\n\ngo 1.21\n`);
      }
    }

    // ── C++ ────────────────────────────────────────────────────────────────
    else if (lang === 'cpp') {
      write('main.cpp', `#include <iostream>\n\nint main() {\n    std::cout << "Hello from SenCode!" << std::endl;\n    return 0;\n}\n`);
      if (ptype === 'cmake') {
        write('CMakeLists.txt', `cmake_minimum_required(VERSION 3.16)\nproject(${pkgName})\n\nset(CMAKE_CXX_STANDARD 17)\n\nadd_executable(${pkgName} main.cpp)\n`);
      }
    }

    // ── C ──────────────────────────────────────────────────────────────────
    else if (lang === 'c') {
      write('main.c', `#include <stdio.h>\n\nint main() {\n    printf("Hello from SenCode!\\n");\n    return 0;\n}\n`);
      if (ptype === 'cmake') {
        write('CMakeLists.txt', `cmake_minimum_required(VERSION 3.16)\nproject(${pkgName})\n\nset(CMAKE_C_STANDARD 11)\n\nadd_executable(${pkgName} main.c)\n`);
      }
    }

    // ── C# ─────────────────────────────────────────────────────────────────
    else if (lang === 'csharp') {
      write('Program.cs', `using System;\n\nclass Program {\n    static void Main(string[] args) {\n        Console.WriteLine("Hello from SenCode!");\n    }\n}\n`);
      if (ptype === 'dotnet') {
        write(`${sanitized}.csproj`, `<Project Sdk="Microsoft.NET.Sdk">\n  <PropertyGroup>\n    <OutputType>Exe</OutputType>\n    <TargetFramework>net8.0</TargetFramework>\n    <Nullable>enable</Nullable>\n    <ImplicitUsings>enable</ImplicitUsings>\n  </PropertyGroup>\n</Project>\n`);
      }
    }

    // ── F# ─────────────────────────────────────────────────────────────────
    else if (lang === 'fsharp') {
      write('Program.fs', `printfn "Hello from SenCode!"\n`);
      if (ptype === 'dotnet') {
        write(`${sanitized}.fsproj`, `<Project Sdk="Microsoft.NET.Sdk">\n  <PropertyGroup>\n    <OutputType>Exe</OutputType>\n    <TargetFramework>net8.0</TargetFramework>\n  </PropertyGroup>\n  <ItemGroup>\n    <Compile Include="Program.fs" />\n  </ItemGroup>\n</Project>\n`);
      }
    }

    // ── VB.NET ─────────────────────────────────────────────────────────────
    else if (lang === 'vbnet') {
      write('Program.vb', `Module Program\n    Sub Main()\n        Console.WriteLine("Hello from SenCode!")\n    End Sub\nEnd Module\n`);
      if (ptype === 'dotnet') {
        write(`${sanitized}.vbproj`, `<Project Sdk="Microsoft.NET.Sdk">\n  <PropertyGroup>\n    <OutputType>Exe</OutputType>\n    <TargetFramework>net8.0</TargetFramework>\n    <RootNamespace>${sanitized}</RootNamespace>\n  </PropertyGroup>\n</Project>\n`);
      }
    }

    // ── Ruby ───────────────────────────────────────────────────────────────
    else if (lang === 'ruby') {
      write('main.rb', `puts "Hello from SenCode!"\n`);
      write('Gemfile', `source 'https://rubygems.org'\n\n# Add gems here\n`);
    }

    // ── PHP ────────────────────────────────────────────────────────────────
    else if (lang === 'php') {
      write('index.php', `<?php\necho "Hello from SenCode!\\n";\n`);
    }

    // ── Dart ───────────────────────────────────────────────────────────────
    else if (lang === 'dart') {
      write('main.dart', `void main() {\n  print('Hello from SenCode!');\n}\n`);
      write('pubspec.yaml', `name: ${pkgName.replace(/-/g, '_')}\ndescription: A new Dart project.\nversion: 1.0.0\nenvironment:\n  sdk: '>=3.0.0 <4.0.0'\n`);
    }

    // ── Swift ──────────────────────────────────────────────────────────────
    else if (lang === 'swift') {
      write('main.swift', `print("Hello from SenCode!")\n`);
    }

    // ── Lua ────────────────────────────────────────────────────────────────
    else if (lang === 'lua') {
      write('main.lua', `print("Hello from SenCode!")\n`);
    }

    // ── R ──────────────────────────────────────────────────────────────────
    else if (lang === 'r') {
      write('main.r', `cat("Hello from SenCode!\\n")\n`);
    }

    // ── Shell ──────────────────────────────────────────────────────────────
    else if (lang === 'bash' || lang === 'shell') {
      write('run.sh', `#!/usr/bin/env bash\necho "Hello from SenCode!"\n`);
    }

    // ── PowerShell ─────────────────────────────────────────────────────────
    else if (lang === 'powershell') {
      write('run.ps1', `Write-Host "Hello from SenCode!"\n`);
    }

    // ── Perl ───────────────────────────────────────────────────────────────
    else if (lang === 'perl') {
      write('main.pl', `#!/usr/bin/env perl\nuse strict;\nuse warnings;\n\nprint "Hello from SenCode!\\n";\n`);
    }

    // ── Julia ──────────────────────────────────────────────────────────────
    else if (lang === 'julia') {
      write('main.jl', `println("Hello from SenCode!")\n`);
    }

    // ── Elixir ─────────────────────────────────────────────────────────────
    else if (lang === 'elixir') {
      const elixirMod = pkgName.split('-').map(w => w.charAt(0).toUpperCase() + w.slice(1)).join('');
      const elixirApp = pkgName.replace(/-/g, '_');
      if (ptype === 'mix') {
        write('mix.exs', `defmodule ${elixirMod}.MixProject do\n  use Mix.Project\n\n  def project do\n    [\n      app: :${elixirApp},\n      version: "0.1.0",\n      elixir: "~> 1.14",\n      start_permanent: Mix.env() == :prod,\n      deps: deps()\n    ]\n  end\n\n  defp deps do\n    []\n  end\nend\n`);
        write(`lib/${elixirApp}.ex`, `defmodule ${elixirMod} do\n  def hello do\n    IO.puts("Hello from SenCode!")\n  end\nend\n`);
      } else {
        write('main.ex', `IO.puts("Hello from SenCode!")\n`);
      }
    }

    // ── Scala ──────────────────────────────────────────────────────────────
    else if (lang === 'scala') {
      const scalaMain = `object Main extends App {\n  println("Hello from SenCode!")\n}\n`;
      if (ptype === 'sbt') {
        write('src/main/scala/Main.scala', scalaMain);
        write('build.sbt', `val root = project\n  .in(file("."))\n  .settings(\n    name := "${pkgName}",\n    version := "0.1.0",\n    scalaVersion := "3.3.1"\n  )\n`);
      } else {
        write('Main.scala', scalaMain);
      }
    }

    // ── Haskell ────────────────────────────────────────────────────────────
    else if (lang === 'haskell') {
      const hsMain = `module Main where\n\nmain :: IO ()\nmain = putStrLn "Hello from SenCode!"\n`;
      if (ptype === 'stack') {
        write('app/Main.hs', hsMain);
        write('package.yaml', `name: ${pkgName}\nversion: 0.1.0.0\nexecutables:\n  ${pkgName}:\n    main: Main.hs\n    source-dirs: app\n    ghc-options: -threaded\n`);
        write('stack.yaml', `resolver: lts-21.25\npackages:\n  - .\n`);
      } else if (ptype === 'cabal') {
        write('app/Main.hs', hsMain);
        write(`${pkgName}.cabal`, `cabal-version: 3.0\nname: ${pkgName}\nversion: 0.1.0.0\nexecutable ${pkgName}\n  main-is: Main.hs\n  hs-source-dirs: app\n  build-depends: base ^>=4.17\n  default-language: Haskell2010\n`);
      } else {
        write('Main.hs', hsMain);
      }
    }

    // ── Erlang ─────────────────────────────────────────────────────────────
    else if (lang === 'erlang') {
      write('main.erl', `-module(main).\n-export([start/0]).\n\nstart() ->\n    io:format("Hello from SenCode!~n").\n`);
    }

    // ── Groovy ─────────────────────────────────────────────────────────────
    else if (lang === 'groovy') {
      write('main.groovy', `println 'Hello from SenCode!'\n`);
    }

    // ── Clojure ────────────────────────────────────────────────────────────
    else if (lang === 'clojure') {
      write('src/main.clj', `(ns main)\n\n(defn -main [& args]\n  (println "Hello from SenCode!"))\n`);
      if (ptype === 'deps') {
        write('deps.edn', `{:paths ["src"]\n :deps {}\n :aliases\n  {:run {:main-opts ["-m" "main"]}}}\n`);
      }
    }

    // ── Crystal ────────────────────────────────────────────────────────────
    else if (lang === 'crystal') {
      const crName = pkgName.replace(/-/g, '_');
      if (ptype === 'shards') {
        write(`src/${crName}.cr`, `puts "Hello from SenCode!"\n`);
        write('shard.yml', `name: ${pkgName}\nversion: 0.1.0\n\nauthors:\n  - Your Name <you@example.com>\n\ncrystal: ">= 1.0.0"\n\nlicense: MIT\n`);
      } else {
        write('main.cr', `puts "Hello from SenCode!"\n`);
      }
    }

    // ── D ──────────────────────────────────────────────────────────────────
    else if (lang === 'd') {
      write('main.d', `import std.stdio;\n\nvoid main() {\n    writeln("Hello from SenCode!");\n}\n`);
    }

    // ── Nim ────────────────────────────────────────────────────────────────
    else if (lang === 'nim') {
      write('main.nim', `echo "Hello from SenCode!"\n`);
      if (ptype === 'nimble') {
        write(`${pkgName}.nimble`, `# Package\nversion = "0.1.0"\nauthor = "Your Name"\ndescription = "A new Nim project"\nlicense = "MIT"\n\n# Dependencies\nrequires "nim >= 1.6.0"\n\ntask run, "Build and run":\n  exec "nim c -r main.nim"\n`);
      }
    }

    // ── Zig ────────────────────────────────────────────────────────────────
    else if (lang === 'zig') {
      write('src/main.zig', `const std = @import("std");\n\npub fn main() !void {\n    const stdout = std.io.getStdOut().writer();\n    try stdout.print("Hello from SenCode!\\n", .{});\n}\n`);
      write('build.zig', `const std = @import("std");\n\npub fn build(b: *std.Build) void {\n    const target = b.standardTargetOptions(.{});\n    const optimize = b.standardOptimizeOption(.{});\n    const exe = b.addExecutable(.{\n        .name = "${pkgName}",\n        .root_source_file = b.path("src/main.zig"),\n        .target = target,\n        .optimize = optimize,\n    });\n    b.installArtifact(exe);\n    const run_cmd = b.addRunArtifact(exe);\n    run_cmd.step.dependOn(b.getInstallStep());\n    const run_step = b.step("run", "Run the app");\n    run_step.dependOn(&run_cmd.step);\n}\n`);
    }

    // ── V (vlang) ──────────────────────────────────────────────────────────
    else if (lang === 'vlang') {
      write('main.v', `fn main() {\n    println('Hello from SenCode!')\n}\n`);
    }

    // ── Ada ────────────────────────────────────────────────────────────────
    else if (lang === 'ada') {
      write('main.adb', `with Ada.Text_IO; use Ada.Text_IO;\n\nprocedure Main is\nbegin\n   Put_Line ("Hello from SenCode!");\nend Main;\n`);
    }

    // ── COBOL ──────────────────────────────────────────────────────────────
    else if (lang === 'cobol') {
      write('main.cbl', `       IDENTIFICATION DIVISION.\n       PROGRAM-ID. HELLO.\n       PROCEDURE DIVISION.\n           DISPLAY "Hello from SenCode!".\n           STOP RUN.\n`);
    }

    // ── LaTeX ──────────────────────────────────────────────────────────────
    else if (lang === 'latex') {
      write('main.tex', `\\documentclass{article}\n\\title{${sanitized}}\n\\author{}\n\\date{}\n\n\\begin{document}\n\\maketitle\n\nHello from SenCode!\n\n\\end{document}\n`);
    }

    // ── Octave ─────────────────────────────────────────────────────────────
    else if (lang === 'octave') {
      write('main.m', `fprintf('Hello from SenCode!\\n');\n`);
    }

    // ── Wolfram ────────────────────────────────────────────────────────────
    else if (lang === 'wolfram') {
      write('main.wl', `Print["Hello from SenCode!"]\n`);
    }

    // ── SAS ────────────────────────────────────────────────────────────────
    else if (lang === 'sas') {
      write('main.sas', `data _null_;\n  put "Hello from SenCode!";\nrun;\n`);
    }

    // ── Fallback ───────────────────────────────────────────────────────────
    else {
      write(`main.txt`, `# ${sanitized}\n`);
    }

    return { ok: true, path: projectDir };
  } catch (e) {
    return { ok: false, error: `Could not write starter files: ${e.message}` };
  }
});

// ── IPC: terminal ─────────────────────────────────────────────────────────────
const { execFile, spawn } = require('child_process');
const os = require('os');

// ── Running processes registry ─────────────────────────────────────────────────
const runningProcesses = new Map(); // pid → { process, command }

// Commands that are always blocked regardless of context
const BLOCKED_COMMANDS = new Set([
  'format', 'mkfs', 'dd',
  'shutdown', 'reboot', 'halt', 'poweroff',
  'reg', 'regedit', 'regsvr32',
]);

ipcMain.handle('terminal:run', async (_event, { command, cwd, projectPath }) => {
  if (!command || !command.trim()) {
    return { ok: false, stdout: '', stderr: 'Empty command.' };
  }

  const firstWord = command.trim().split(/\s+/)[0].toLowerCase().replace(/\.exe$/i, '');
  if (BLOCKED_COMMANDS.has(firstWord)) {
    return { ok: false, stdout: '', stderr: `Command "${firstWord}" is not allowed for safety reasons.` };
  }

  const safeCwd = (cwd && fs.existsSync(cwd)) ? cwd
    : (projectPath && fs.existsSync(projectPath)) ? projectPath
    : os.homedir();

  const childEnv = buildChildEnv();

  const tmpFile = path.join(os.tmpdir(), `cf_cmd_${Date.now()}.ps1`);
  try {
    fs.writeFileSync(tmpFile, command, 'utf8');
  } catch (e) {
    return { ok: false, stdout: '', stderr: `Failed to write temp script: ${e.message}` };
  }

  const isCompiled = /^\s*(javac|java |kotlinc|rustc|gcc|g\+\+|dotnet|swift)/i.test(command.trim());
  const timeoutMs  = isCompiled ? 120000 : 30000;

  return new Promise((resolve) => {
    execFile('powershell.exe',
      ['-NonInteractive', '-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', tmpFile],
      { cwd: safeCwd, env: childEnv, timeout: timeoutMs, maxBuffer: 4 * 1024 * 1024, windowsHide: true },
      (err, stdout, stderr) => {
        try { fs.unlinkSync(tmpFile); } catch {}
        resolve({
          ok      : !err || err.code === 0,
          stdout  : stdout || '',
          stderr  : stderr || (err && err.code !== 0 ? err.message : ''),
          exitCode: err?.code ?? 0,
        });
      }
    );
  });
});
