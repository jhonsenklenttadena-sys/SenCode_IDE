/**
 * llama-engine.cjs
 *
 * Runs in the Electron main process. Loads GGUF model files directly using
 * node-llama-cpp v3 — no LM Studio, no Ollama, no external server needed.
 *
 * Models folder resolution order (first existing path wins):
 *
 *  1. Sibling folder on flash drive / portable layout:
 *       <parent of app dir>/Models/
 *     e.g.  FlashDrive/CodeForge/CodeForge.exe  →  FlashDrive/Models/
 *
 *  2. Packaged app resources (installed / NSIS build):
 *       <resources>/Models/
 *
 *  3. Dev fallback:
 *       <project root>/Models/
 *
 * This means students on flash drives just place their .gguf files in a
 * Models folder next to the CodeForge app folder — no config needed.
 */

'use strict';

const path = require('path');
const fs   = require('fs');

// ── node-llama-cpp lazy loader ────────────────────────────────────────────────
let _moduleCache = null;
async function getModule() {
  if (!_moduleCache) {
    try {
      _moduleCache = await import('node-llama-cpp');
    } catch (e) {
      console.error('[llama-engine] Cannot load node-llama-cpp:', e.message);
      throw new Error('node-llama-cpp failed to load: ' + e.message);
    }
  }
  return _moduleCache;
}

// ── Models folder resolution ───────────────────────────────────────────────────
/**
 * Returns { dir, source } where source describes which path was chosen.
 *
 * Resolution order:
 *  1. Portable build: PORTABLE_EXECUTABLE_DIR env var (set by electron-builder
 *     portable wrapper) points to the folder containing the .exe on the flash
 *     drive. Models/ sits next to the .exe there.
 *  2. Installed / NSIS build: <resources>/Models/
 *  3. Dev build: <project root>/Models/
 */
function resolveModelsDir() {
  const { app } = require('electron');

  const candidates = [];

  if (app.isPackaged) {
    // 1a. Portable: PORTABLE_EXECUTABLE_DIR is the folder containing the .exe
    //     e.g.  FlashDrive/CodeForge_App/CodeForge.exe
    //     Models/ sits NEXT TO that folder:  FlashDrive/Models/
    const portableDir = process.env.PORTABLE_EXECUTABLE_DIR;
    if (portableDir) {
      // Sibling of the exe's folder  →  FlashDrive/Models/  ✓
      candidates.push({
        dir   : path.join(portableDir, '..', 'Models'),
        source: 'portable sibling (PORTABLE_EXECUTABLE_DIR/..)',
      });
      // Also try Models/ inside the same folder, in case the user placed
      // the exe directly on the root of the drive with Models/ beside it.
      candidates.push({
        dir   : path.join(portableDir, 'Models'),
        source: 'portable same-dir (PORTABLE_EXECUTABLE_DIR)',
      });
    }

    // 2. win-unpacked layout: Models/ beside the exe itself
    const exeDir = path.dirname(process.execPath);
    candidates.push({
      dir   : path.join(exeDir, 'Models'),
      source: 'sibling of exe',
    });
    // Also one level up from exe dir
    candidates.push({
      dir   : path.join(exeDir, '..', 'Models'),
      source: 'parent of exe dir',
    });

    // 3. Packaged resources (standard install)
    candidates.push({
      dir   : path.join(process.resourcesPath, 'Models'),
      source: 'resources (installed)',
    });
  } else {
    // Dev build — project root
    candidates.push({
      dir   : path.join(__dirname, '..', 'Models'),
      source: 'dev (project root)',
    });
  }

  for (const c of candidates) {
    if (fs.existsSync(c.dir)) {
      console.log(`[llama-engine] Models dir → ${c.dir}  [${c.source}]`);
      return c;
    }
  }

  console.warn('[llama-engine] No Models folder found. Searched:', candidates.map((c) => c.dir).join(', '));
  return { dir: candidates[0]?.dir ?? '', source: 'missing' };
}

/** Public accessor used by main.cjs */
function getModelsDir() {
  return resolveModelsDir().dir;
}

/** Returns true if the Models folder exists at all. */
function modelsDirExists() {
  return resolveModelsDir().source !== 'missing';
}

// ── Model scanner ──────────────────────────────────────────────────────────────
/**
 * Recursively find all .gguf files under the resolved Models directory.
 * Returns [{ id, name, path, size, sizeBytes }]
 * Always re-scans from disk so new models added while the app is running
 * are picked up immediately without a restart.
 */
function scanModels() {
  const { dir, source } = resolveModelsDir();
  console.log('[llama-engine] Scanning models in:', dir, `(${source})`);

  if (!fs.existsSync(dir)) {
    console.warn('[llama-engine] Models directory not found:', dir);
    return [];
  }

  const results = [];

  function walk(folder) {
    let entries;
    try { entries = fs.readdirSync(folder, { withFileTypes: true }); }
    catch (e) { console.warn('[llama-engine] Cannot read dir:', folder, e.message); return; }

    for (const entry of entries) {
      const full = path.join(folder, entry.name);
      if (entry.isDirectory()) {
        walk(full);
      } else if (entry.isFile() && entry.name.toLowerCase().endsWith('.gguf')) {
        // Skip multimodal projector files — not standalone chat models
        if (entry.name.toLowerCase().startsWith('mmproj-')) continue;

        let sizeBytes = 0;
        try { sizeBytes = fs.statSync(full).size; } catch {}

        const id = path.relative(dir, full).replace(/\\/g, '/');
        results.push({
          id,
          name      : entry.name.replace(/\.gguf$/i, ''),
          path      : full,
          sizeBytes,
          size      : sizeBytes > 0 ? `${(sizeBytes / 1e9).toFixed(1)} GB` : undefined,
        });
        console.log('[llama-engine] Found model:', id, sizeBytes > 0 ? `(${(sizeBytes / 1e9).toFixed(1)} GB)` : '');
      }
    }
  }

  walk(dir);
  console.log(`[llama-engine] Total models found: ${results.length}`);
  return results;
}

// ── Active model state ─────────────────────────────────────────────────────────
let activeModelPath = null;
let llamaInstance   = null;   // the getLlama() result
let loadedModel     = null;   // LlamaModel

async function ensureLlama() {
  if (llamaInstance) return;
  const { getLlama } = await getModule();
  // Request GPU explicitly. node-llama-cpp falls back to CPU automatically
  // if no compatible GPU is detected — safe on all machines.
  llamaInstance = await getLlama({ gpu: 'auto' });
  console.log('[llama-engine] llama backend initialised (gpu: auto)');
}

async function unloadModel() {
  try { if (loadedModel) { await loadedModel.dispose(); } } catch {}
  loadedModel     = null;
  activeModelPath = null;
}

async function loadModel(modelPath) {
  if (activeModelPath === modelPath && loadedModel) return; // already loaded

  await unloadModel();
  await ensureLlama();

  console.log('[llama-engine] Loading model:', path.basename(modelPath));
  try {
    loadedModel = await llamaInstance.loadModel({ modelPath });
  } catch (e) {
    console.warn('[llama-engine] GPU load failed, retrying CPU-only:', e.message);
    loadedModel = await llamaInstance.loadModel({ modelPath, gpuLayers: 0 });
    console.log('[llama-engine] Loaded on CPU');
  }
  activeModelPath = modelPath;
  console.log('[llama-engine] Model ready:', path.basename(modelPath));
}

/**
 * Create a context for this completion.
 *
 * FIX: The old code used `loadedModel.trainContextSize` as the context window,
 * which could be 32k or 128k on modern models — allocating all that RAM/VRAM
 * per request is extremely slow. We now cap at MAX_CTX (8192) by default,
 * which covers any realistic conversation length while keeping inference fast.
 * Users on high-end machines or with hardware tiers that specify a larger
 * contextSize will still get it via the `hardware` parameter.
 */
const MAX_CTX = 8192;

async function createContext(hardware) {
  const tierCtx  = hardware?.contextSize ?? null;
  const modelCtx = loadedModel.trainContextSize ?? MAX_CTX;
  // Cap: use the smallest of tier override, model training context, and MAX_CTX
  const contextSize = tierCtx
    ? Math.min(tierCtx, modelCtx)
    : Math.min(modelCtx, MAX_CTX);
  console.log(`[llama-engine] Context size: ${contextSize}`);
  return loadedModel.createContext({ contextSize });
}

// ── Chat streaming ─────────────────────────────────────────────────────────────
async function streamCompletion(event, modelPath, messages, params, requestId, hardware) {
  const { LlamaChatSession } = await getModule();

  await loadModel(modelPath);

  const systemMsg  = messages.find((m) => m.role === 'system');
  const systemText = systemMsg ? systemMsg.content : '';

  // All user/assistant turns from the conversation history
  const turns = messages.filter((m) => m.role === 'user' || m.role === 'assistant');

  // The last message must be from the user — that's what we prompt with.
  // Everything before it is prior conversation history.
  const lastTurn  = turns[turns.length - 1];
  const userText  = lastTurn?.role === 'user' ? lastTurn.content : '';
  const priorTurns = turns.slice(0, -1);

  if (!userText) {
    if (!event.sender.isDestroyed()) event.sender.send('llm:stream-chunk', requestId, '[DONE]');
    return;
  }

  const ctx      = await createContext(hardware);
  const sequence = ctx.getSequence();

  // FIX: Build chatHistory from prior turns so the model has full conversation
  // context without re-encoding from scratch on every message.
  // node-llama-cpp v3 format: user → { type:'user', text }
  //                           assistant → { type:'model', response: [text] }
  const chatHistory = [];
  for (const turn of priorTurns) {
    if (turn.role === 'user') {
      chatHistory.push({ type: 'user', text: turn.content });
    } else if (turn.role === 'assistant') {
      chatHistory.push({ type: 'model', response: [turn.content] });
    }
  }

  const session = new LlamaChatSession({
    contextSequence: sequence,
    systemPrompt   : systemText || undefined,
    ...(chatHistory.length > 0 ? { chatHistory } : {}),
  });

  try {
    await session.prompt(userText, {
      temperature : params.temperature ?? 0.7,
      maxTokens   : params.maxTokens   ?? 2048,
      topP        : params.topP        ?? 0.9,
      onTextChunk(text) {
        if (event.sender.isDestroyed()) return;
        const chunk = JSON.stringify({ choices: [{ delta: { content: text } }] });
        event.sender.send('llm:stream-chunk', requestId, chunk);
      },
    });
  } finally {
    await ctx.dispose().catch(() => {});
  }

  if (!event.sender.isDestroyed()) event.sender.send('llm:stream-chunk', requestId, '[DONE]');
}

// ── OpenAI-compatible models list ──────────────────────────────────────────────
function buildModelsResponse() {
  const models = scanModels();
  return JSON.stringify({
    object: 'list',
    data: models.map((m) => ({
      id       : m.id,
      object   : 'model',
      created  : 0,
      owned_by : 'local',
      size     : m.size,
      sizeBytes: m.sizeBytes,
    })),
  });
}

module.exports = {
  scanModels,
  loadModel,
  unloadModel,
  streamCompletion,
  buildModelsResponse,
  getModelsDir,
  modelsDirExists,
};
