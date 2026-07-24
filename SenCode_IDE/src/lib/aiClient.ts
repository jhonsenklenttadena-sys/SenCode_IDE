/**
 * AI client service — the single place that talks to the local LLM backend.
 *
 * When running inside Electron, all HTTP requests are proxied through the
 * main process via IPC to avoid CORS / CSP issues in the renderer.
 * When running in a plain browser (vite dev without Electron), fetch() is
 * used directly.
 */

import type { BackendConfig, ModelInfo, StreamChunk } from './types';

export const STARTUP_TIMEOUT = 20000;
const DEFAULT_TIMEOUT = 10000;

// ── Electron IPC bridge (typed subset of what preload exposes) ──────────────
interface ElectronAPI {
  isElectron: true;
  getModels: (url: string, headers: Record<string, string>) => Promise<{ ok: boolean; status: number; body: string; error?: string }>;
  streamChat: (requestId: string, body: string) => void;
  streamAbort: (requestId: string) => void;
  onStreamChunk: (cb: (requestId: string, chunk: string) => void) => () => void;
}

function getElectron(): ElectronAPI | null {
  return (window as unknown as { electronAPI?: ElectronAPI }).electronAPI ?? null;
}

// ── URL helpers ─────────────────────────────────────────────────────────────
function modelsUrl(cfg: BackendConfig): string {
  return cfg.baseUrl.replace(/\/$/, '') + '/models';
}

function chatUrl(cfg: BackendConfig): string {
  return cfg.baseUrl.replace(/\/$/, '') + '/chat/completions';
}

function makeHeaders(cfg: BackendConfig): Record<string, string> {
  const h: Record<string, string> = { 'Content-Type': 'application/json' };
  if (cfg.apiKey) h['Authorization'] = `Bearer ${cfg.apiKey}`;
  return h;
}

// ── Model list parsing ───────────────────────────────────────────────────────
function parseModels(data: unknown, _backend: BackendConfig['type']): ModelInfo[] {
  const d = data as Record<string, unknown>;
  if (Array.isArray(d?.data)) {
    return (d.data as Record<string, unknown>[]).map((m) => ({
      id       : String(m.id),
      name     : String(m.id),
      size     : m.size ? String(m.size) : undefined,
      sizeBytes: m.sizeBytes ? Number(m.sizeBytes) : undefined,
    }));
  }
  if (Array.isArray(d?.models)) {
    return (d.models as Record<string, unknown>[]).map((m) => ({
      id       : String(m.name ?? m.model),
      name     : String(m.name ?? m.model),
      size     : m.size ? `${(Number(m.size) / 1e9).toFixed(1)}B` : undefined,
      sizeBytes: m.size ? Number(m.size) : undefined,
    }));
  }
  if (Array.isArray(data)) {
    return (data as string[]).map((id) => ({ id, name: id }));
  }
  return [];
}

// ── checkConnection ──────────────────────────────────────────────────────────
/** Check whether the local backend is reachable and return available models. */
export async function checkConnection(
  cfg: BackendConfig,
  timeout = DEFAULT_TIMEOUT,
): Promise<{ connected: boolean; models: ModelInfo[]; error?: string }> {
  const electron = getElectron();

  // ── Local GGUF mode (Electron, no external server) ──────────────────────
  if (cfg.type === 'local' || (electron && cfg.type !== 'lmstudio' && cfg.type !== 'ollama' && cfg.type !== 'custom')) {
    try {
      // Pass dummy url/headers — main.cjs ignores them for local mode
      const res = await electron!.getModels('local://models', {});
      if (!res.ok) return { connected: false, models: [], error: res.error ?? `Error ${res.status}` };
      const data = JSON.parse(res.body);
      const models = parseModels(data, 'local' as BackendConfig['type']);
      return { connected: models.length > 0, models };
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      return { connected: false, models: [], error: msg };
    }
  }

  const url = modelsUrl(cfg);
  const headers = makeHeaders(cfg);

  try {
    let bodyText: string;

    if (electron) {
      // Use IPC proxy — avoids CORS/CSP in Electron renderer
      const res = await electron.getModels(url, headers);
      if (!res.ok) {
        return { connected: false, models: [], error: res.error ?? `HTTP ${res.status}` };
      }
      bodyText = res.body;
    } else {
      // Plain browser — direct fetch
      const ctrl = new AbortController();
      const t = setTimeout(() => ctrl.abort(), timeout);
      try {
        const res = await fetch(url, { headers, signal: ctrl.signal });
        if (!res.ok) return { connected: false, models: [], error: `HTTP ${res.status}` };
        bodyText = await res.text();
      } finally {
        clearTimeout(t);
      }
    }

    const data = JSON.parse(bodyText);
    const models = parseModels(data, cfg.type);
    return { connected: true, models };
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    return { connected: false, models: [], error: msg };
  }
}

// ── autoDetectBackend ────────────────────────────────────────────────────────
/**
 * Auto-detect which backend to use.
 * In Electron, always prefers local GGUF mode first.
 * Falls back to LM Studio / Ollama HTTP servers if present.
 */
export async function autoDetectBackend(): Promise<BackendConfig | null> {
  const electron = getElectron();

  // In Electron, try local GGUF mode first
  if (electron) {
    const localCfg: BackendConfig = { type: 'local', baseUrl: 'local://models', apiKey: '' };
    const result = await checkConnection(localCfg);
    if (result.connected) return localCfg;
  }

  // Fall back to external HTTP servers (Ollama, LM Studio)
  const candidates: BackendConfig[] = [
    { type: 'lmstudio', baseUrl: 'http://localhost:1234/v1', apiKey: '' },
    { type: 'ollama',   baseUrl: 'http://localhost:11434/v1', apiKey: '' },
  ];
  for (const cfg of candidates) {
    const result = await checkConnection(cfg);
    if (result.connected) return cfg;
  }
  return null;
}

// ── streamChat ───────────────────────────────────────────────────────────────
export interface ChatRequest {
  model: string;
  messages: { role: string; content: string }[];
  temperature: number;
  maxTokens: number;
  topP: number;
  signal?: AbortSignal;
}

/**
 * Stream a chat completion. Yields StreamChunk objects as tokens arrive.
 * Throws an Error if the backend is unreachable or returns a non-OK response.
 */
export async function* streamChat(
  cfg: BackendConfig,
  req: ChatRequest,
): AsyncGenerator<StreamChunk> {
  if (!req.model) {
    throw new Error('No model selected. Start LM Studio or Ollama and select a model.');
  }

  const url = chatUrl(cfg);
  const headers = makeHeaders(cfg);
  const bodyStr = JSON.stringify({
    model: req.model,
    messages: req.messages,
    temperature: req.temperature,
    max_tokens: req.maxTokens,
    top_p: req.topP,
    stream: true,
  });

  const electron = getElectron();

  if (electron) {
    // ── Electron path: send/on streaming (non-blocking) ──────────────────
    // Using send instead of invoke keeps the renderer JS thread free to
    // receive chunk events in real time.
    const requestId = Math.random().toString(36).slice(2, 10);
    const queue: string[] = [];
    let done = false;
    let error: string | null = null;
    let notify: (() => void) | null = null;

    const unsubscribe = electron.onStreamChunk((incomingId, chunk) => {
      if (incomingId !== requestId) return; // ignore other requests
      queue.push(chunk);
      notify?.();
      notify = null;
    });

    // Fire-and-forget: start the stream. Chunks come back via onStreamChunk.
    electron.streamChat(requestId, bodyStr);

    // Watch for abort signal to cancel
    req.signal?.addEventListener('abort', () => {
      electron.streamAbort(requestId);
      done = true;
      notify?.();
      notify = null;
    });

    try {
      while (true) {
        // Wait for next chunk if queue is empty and not done
        if (queue.length === 0 && !done) {
          await new Promise<void>((r) => { notify = r; });
        }

        // Drain entire queue
        while (queue.length > 0) {
          const payload = queue.shift()!;
          if (payload === '[DONE]') {
            yield { delta: '', done: true };
            return;
          }
          try {
            const json = JSON.parse(payload);
            // Surface errors from the main process as thrown errors
            if (json.error) throw new Error(json.error);
            const delta = (json.choices?.[0]?.delta?.content as string) ?? '';
            if (delta) yield { delta, done: false };
          } catch (e) {
            if (e instanceof Error) throw e;
          }
        }

        if (done && queue.length === 0) {
          if (error) throw new Error(error);
          break;
        }
      }
    } finally {
      unsubscribe();
    }

    yield { delta: '', done: true };
    return;
  }

  // ── Browser/plain fetch path ─────────────────────────────────────────────
  let res: Response;
  try {
    res = await fetch(url, {
      method: 'POST',
      headers,
      body: bodyStr,
      signal: req.signal,
    });
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    throw new Error(
      `Cannot reach backend at ${cfg.baseUrl}. Is LM Studio or Ollama running? (${msg})`,
    );
  }

  if (!res.ok) {
    const errText = await res.text().catch(() => '');
    throw new Error(`Backend returned HTTP ${res.status}. ${errText}`);
  }

  if (!res.body) throw new Error('Backend returned no response body.');

  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';

  try {
    while (true) {
      const { done: streamDone, value } = await reader.read();
      if (streamDone) break;
      buffer += decoder.decode(value, { stream: true });
      const lines = buffer.split('\n');
      buffer = lines.pop() ?? '';
      for (const line of lines) {
        const trimmed = line.trim();
        if (!trimmed.startsWith('data:')) continue;
        const payload = trimmed.slice(5).trim();
        if (payload === '[DONE]') { yield { delta: '', done: true }; return; }
        try {
          const json = JSON.parse(payload);
          const delta = (json.choices?.[0]?.delta?.content as string) ?? '';
          if (delta) yield { delta, done: false };
        } catch { /* ignore */ }
      }
    }
  } finally {
    reader.releaseLock();
  }

  yield { delta: '', done: true };
}

/** Recommended models for the onboarding wizard, sized by hardware tier. */
export const RECOMMENDED_MODELS = [
  { name: 'Qwen2.5-Coder-7B-Instruct',        ram: '8GB+', tag: 'Best overall for coding' },
  { name: 'DeepSeek-Coder-V2-Lite-Instruct',  ram: '8GB+', tag: 'Strong multi-language' },
  { name: 'CodeLlama-7B-Instruct',             ram: '8GB+', tag: 'Meta, reliable' },
  { name: 'Qwen2.5-Coder-1.5B-Instruct',      ram: '4GB+', tag: 'Lowest RAM, fast' },
  { name: 'Phi-3.1-mini-128k-Instruct',        ram: '6GB+', tag: 'Long context, compact' },
];
