/**
 * browserFs — filesystem support for running CodeForge as a plain web page
 * (i.e. NOT the packaged Electron app). electronBridge.ts is a total no-op
 * outside Electron, which is why "Open Folder" and drag-and-drop silently
 * did nothing when previewed in a browser. This module fills that gap with
 * two tiers, best available one wins:
 *
 *   1. File System Access API (Chrome / Edge) — real read AND write-back,
 *      via showDirectoryPicker()/showOpenFilePicker() or a Chromium drag
 *      event's item.getAsFileSystemHandle().
 *   2. webkitGetAsEntry() drag-drop traversal — works in every major
 *      browser, but is read-only. Saving falls back to a file download
 *      instead of silently failing.
 *
 * fsGateway.ts decides whether to use this module or electronBridge.ts.
 */

import type { FileNode } from './types';

/**
 * Minimal local shapes for the File System Access API. TypeScript's bundled
 * DOM lib support for this API varies by version (some ship it, some don't,
 * some ship a partial version), so we declare just what we use here instead
 * of depending on ambient globals that may or may not exist.
 */
interface FsWritable {
  write(data: string): Promise<void>;
  close(): Promise<void>;
}
interface FsFileHandleLike {
  kind: 'file';
  name: string;
  getFile(): Promise<File>;
  createWritable(): Promise<FsWritable>;
}
interface FsDirHandleLike {
  kind: 'directory';
  name: string;
  entries(): AsyncIterableIterator<[string, AnyHandle]>;
}
type AnyHandle = FsFileHandleLike | FsDirHandleLike;

// path -> live handle (write-capable, Tier 1)
const handles = new Map<string, AnyHandle>();
// path -> raw File (read-only, Tier 2 fallback)
const files = new Map<string, File>();

export function supportsFsAccess(): boolean {
  return typeof (window as unknown as { showDirectoryPicker?: unknown }).showDirectoryPicker === 'function';
}

function resetRegistry() {
  handles.clear();
  files.clear();
}

function sortNodes(nodes: FileNode[]): FileNode[] {
  return nodes.sort((a, b) =>
    a.type === b.type ? a.name.localeCompare(b.name) : a.type === 'directory' ? -1 : 1,
  );
}

// ── Tier 1: File System Access API ──────────────────────────────────────────

async function walkDirHandle(dir: FsDirHandleLike, base: string): Promise<FileNode[]> {
  const nodes: FileNode[] = [];
  for await (const [name, handle] of dir.entries()) {
    const path = `${base}/${name}`;
    handles.set(path, handle);
    if (handle.kind === 'directory') {
      nodes.push({ name, path, type: 'directory', children: await walkDirHandle(handle, path) });
    } else {
      const f = await handle.getFile();
      nodes.push({ name, path, type: 'file', size: f.size });
    }
  }
  return sortNodes(nodes);
}

export async function pickFolder(): Promise<{ ok: boolean; root?: FileNode; error?: string }> {
  if (!supportsFsAccess()) return { ok: false, error: 'not-supported' };
  try {
    const dir: FsDirHandleLike = await (window as unknown as {
      showDirectoryPicker: () => Promise<FsDirHandleLike>;
    }).showDirectoryPicker();
    resetRegistry();
    handles.set(dir.name, dir);
    const children = await walkDirHandle(dir, dir.name);
    return { ok: true, root: { name: dir.name, path: dir.name, type: 'directory', children } };
  } catch (e) {
    const err = e as Error;
    if (err.name === 'AbortError') return { ok: false, error: 'cancelled' };
    return { ok: false, error: err.message };
  }
}

export async function pickFiles(): Promise<{ path: string; content: string }[]> {
  if (!supportsFsAccess()) return [];
  try {
    const picked: FsFileHandleLike[] = await (window as unknown as {
      showOpenFilePicker: (opts: { multiple: boolean }) => Promise<FsFileHandleLike[]>;
    }).showOpenFilePicker({ multiple: true });
    const out: { path: string; content: string }[] = [];
    for (const h of picked) {
      handles.set(h.name, h);
      const f = await h.getFile();
      out.push({ path: h.name, content: await f.text() });
    }
    return out;
  } catch {
    return [];
  }
}

// ── Tier 2: webkitGetAsEntry drag-drop traversal (universal, read-only) ────

interface FsEntryLike {
  isDirectory: boolean;
  isFile: boolean;
  name: string;
  createReader?: () => { readEntries: (cb: (e: FsEntryLike[]) => void, errCb: (e: unknown) => void) => void };
  file?: (cb: (f: File) => void, errCb: (e: unknown) => void) => void;
}

async function readAllEntries(reader: NonNullable<FsEntryLike['createReader']> extends () => infer R ? R : never): Promise<FsEntryLike[]> {
  const all: FsEntryLike[] = [];
  // readEntries must be called repeatedly until it returns an empty batch
  for (;;) {
    const batch: FsEntryLike[] = await new Promise((res, rej) => reader.readEntries(res, rej));
    if (batch.length === 0) break;
    all.push(...batch);
  }
  return all;
}

async function walkDirEntry(entry: FsEntryLike, base: string): Promise<FileNode[]> {
  const reader = entry.createReader!();
  const entries = await readAllEntries(reader);
  const nodes: FileNode[] = [];
  for (const e of entries) {
    const path = `${base}/${e.name}`;
    if (e.isDirectory) {
      nodes.push({ name: e.name, path, type: 'directory', children: await walkDirEntry(e, path) });
    } else {
      const file: File = await new Promise((res, rej) => e.file!(res, rej));
      files.set(path, file);
      nodes.push({ name: e.name, path, type: 'file', size: file.size });
    }
  }
  return sortNodes(nodes);
}

// ── Unified drop handler ─────────────────────────────────────────────────────

export interface DropOutcome {
  kind: 'file' | 'directory';
  path: string;
  root?: FileNode;          // set when kind === 'directory'
  content?: string;         // set when kind === 'file'
}

/**
 * Handles a browser DragEvent's dataTransfer, trying the writable File
 * System Access handle first and falling back to the read-only entry API.
 * Returns one outcome per top-level dropped item.
 */
export async function handleDrop(dataTransfer: DataTransfer): Promise<DropOutcome[]> {
  const results: DropOutcome[] = [];
  const items = Array.from(dataTransfer.items).filter((i) => i.kind === 'file');

  for (const item of items) {
    const getHandle = (item as unknown as { getAsFileSystemHandle?: () => Promise<AnyHandle> }).getAsFileSystemHandle;

    if (supportsFsAccess() && getHandle) {
      try {
        const handle = await getHandle.call(item);
        if (handle.kind === 'directory') {
          resetRegistry();
          handles.set(handle.name, handle);
          const children = await walkDirHandle(handle, handle.name);
          results.push({ kind: 'directory', path: handle.name, root: { name: handle.name, path: handle.name, type: 'directory', children } });
        } else {
          handles.set(handle.name, handle);
          const f = await handle.getFile();
          results.push({ kind: 'file', path: handle.name, content: await f.text() });
        }
        continue;
      } catch {
        // fall through to Tier 2 below
      }
    }

    const entry = item.webkitGetAsEntry?.() as FsEntryLike | null;
    if (!entry) continue;
    if (entry.isDirectory) {
      const children = await walkDirEntry(entry, entry.name);
      results.push({ kind: 'directory', path: entry.name, root: { name: entry.name, path: entry.name, type: 'directory', children } });
    } else {
      const file: File = await new Promise((res, rej) => entry.file!(res, rej));
      files.set(entry.name, file);
      results.push({ kind: 'file', path: entry.name, content: await file.text() });
    }
  }
  return results;
}

// ── Read / write / stat against whichever registry has the path ────────────

export async function readFile(path: string): Promise<{ ok: boolean; content?: string; error?: string }> {
  const h = handles.get(path);
  if (h && h.kind === 'file') {
    const f = await h.getFile();
    return { ok: true, content: await f.text() };
  }
  const f = files.get(path);
  if (f) return { ok: true, content: await f.text() };
  return { ok: false, error: 'File not available in this browser session' };
}

export async function writeFile(path: string, content: string): Promise<{ ok: boolean; error?: string; downloaded?: boolean }> {
  const h = handles.get(path);
  if (h && h.kind === 'file') {
    try {
      const writable = await h.createWritable();
      await writable.write(content);
      await writable.close();
      return { ok: true };
    } catch (e) {
      return { ok: false, error: (e as Error).message };
    }
  }
  // Read-only fallback (Tier 2 files, or nothing registered): download instead
  // of pretending the save worked.
  const blob = new Blob([content], { type: 'text/plain' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = path.split('/').pop() ?? 'file.txt';
  a.click();
  URL.revokeObjectURL(url);
  return { ok: true, downloaded: true };
}

export function isWritable(path: string): boolean {
  return handles.get(path)?.kind === 'file';
}
