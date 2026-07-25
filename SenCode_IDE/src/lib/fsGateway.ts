/**
 * fsGateway — single entry point the UI calls for every filesystem
 * operation (open folder/file, read, write, drag-and-drop). It picks the
 * right backend so the rest of the app doesn't need to know or care
 * whether it's running inside the packaged Electron app or a plain browser
 * tab:
 *
 *   - Electron  → electronBridge.ts (real IPC to Node's fs)
 *   - Browser   → browserFs.ts (File System Access API, or read-only
 *                 drag-drop entries as a last resort)
 *
 * This is what actually fixes "drag and drop won't open" for people running
 * the web preview instead of the installed desktop app — electronBridge's
 * functions are no-ops outside Electron, so nothing happened before.
 */

import type { FileNode } from './types';
import * as electron from './electronBridge';
import * as browser from './browserFs';

export const isElectron = electron.isElectron;

/** True if this environment can open/browse files at all (always true — drag/drop entries work everywhere). */
export function canOpenFiles(): boolean {
  return true;
}

/** True if saved edits will actually persist to disk (vs. triggering a download). */
export function canWriteInPlace(path: string): boolean {
  if (electron.isElectron()) return true;
  return browser.isWritable(path);
}

export interface OpenFolderResult {
  ok: boolean;
  path: string;
  tree: FileNode[];
  error?: string;
}

/** Create a new folder via native dialog, then load it as the project tree. */
export async function createFolder(): Promise<OpenFolderResult> {
  if (electron.isElectron()) {
    const result = await electron.createFolderDialog();
    if (!result) return { ok: false, path: '', tree: [], error: 'cancelled' };
    if (typeof result === 'object' && 'error' in result) {
      return { ok: false, path: '', tree: [], error: result.error };
    }
    const chosen = result as string;
    const dir = await electron.readDirectory(chosen);
    return { ok: dir.ok, path: chosen, tree: dir.tree, error: dir.error };
  }

  return {
    ok: false,
    path: '',
    tree: [],
    error: 'Create Folder is only available in the desktop app.',
  };
}

/** Open the folder picker and fully load the resulting tree. */
export async function openFolder(): Promise<OpenFolderResult> {
  if (electron.isElectron()) {
    const chosen = await electron.openFolderDialog();
    if (!chosen) return { ok: false, path: '', tree: [], error: 'cancelled' };
    const result = await electron.readDirectory(chosen);
    return { ok: result.ok, path: chosen, tree: result.tree, error: result.error };
  }

  if (browser.supportsFsAccess()) {
    const result = await browser.pickFolder();
    if (!result.ok || !result.root) return { ok: false, path: '', tree: [], error: result.error };
    return { ok: true, path: result.root.name, tree: result.root.children ?? [] };
  }

  return {
    ok: false,
    path: '',
    tree: [],
    error: 'This browser can\u2019t open folders directly \u2014 try Chrome/Edge, drag a folder in instead, or use the desktop app.',
  };
}

/** Re-read a folder already loaded (Electron: fresh disk read; browser: no-op, tree is already live). */
export async function refreshFolder(path: string, currentTree: FileNode[]): Promise<OpenFolderResult> {
  if (electron.isElectron()) {
    const result = await electron.readDirectory(path);
    return { ok: result.ok, path, tree: result.tree, error: result.error };
  }
  // Browser handles are live — nothing to re-fetch, just hand the existing tree back.
  return { ok: true, path, tree: currentTree };
}

export interface OpenFileResult {
  path: string;
  name: string;
  content: string;
  ok: boolean;
  error?: string;
}

/** Open the native/browser file picker and read every chosen file's content. */
export async function openFiles(): Promise<OpenFileResult[]> {
  if (electron.isElectron()) {
    const paths = await electron.openFileDialog();
    const out: OpenFileResult[] = [];
    for (const p of paths) {
      const r = await electron.readFile(p);
      out.push({ path: p, name: p.split(/[\\/]/).pop() ?? p, content: r.content ?? '', ok: r.ok, error: r.error });
    }
    return out;
  }

  if (browser.supportsFsAccess()) {
    const picked = await browser.pickFiles();
    return picked.map((f) => ({ path: f.path, name: f.path.split('/').pop() ?? f.path, content: f.content, ok: true }));
  }

  return [];
}

export async function readFile(path: string): Promise<{ ok: boolean; content?: string; error?: string }> {
  return electron.isElectron() ? electron.readFile(path) : browser.readFile(path);
}

export async function writeFile(path: string, content: string): Promise<{ ok: boolean; error?: string; downloaded?: boolean }> {
  return electron.isElectron() ? electron.writeFile(path, content) : browser.writeFile(path, content);
}

export async function renameFile(fromPath: string, toPath: string): Promise<{ ok: boolean; error?: string }> {
  if (electron.isElectron()) return electron.renameFile(fromPath, toPath);
  return { ok: false, error: 'Rename is only available in the desktop app.' };
}

export async function deleteFile(filePath: string): Promise<{ ok: boolean; error?: string }> {
  if (electron.isElectron()) return electron.deleteFile(filePath);
  return { ok: false, error: 'Delete is only available in the desktop app.' };
}

export async function deleteFolder(folderPath: string): Promise<{ ok: boolean; error?: string }> {
  if (electron.isElectron()) return electron.deleteFolder(folderPath);
  return { ok: false, error: 'Delete is only available in the desktop app.' };
}

export interface CreateSubfolderResult {
  ok: boolean;
  path?: string;
  error?: string;
  /** True when the name was blocked by reserved-folder rules (not a disk error). */
  reserved?: boolean;
}

/**
 * Create a new subfolder at parentPath/folderName.
 *
 * If projectPath is provided the function first checks whether folderName
 * would collide with a scaffold-reserved directory at the exact tree level
 * where the language's project generator placed it.  Collisions deeper in
 * the tree (not at the scaffold-generated level) are allowed.
 *
 * Rules enforced here (not in the IPC handler so they apply in browser too):
 *   • Empty folderName → silently rejected (ok: false, no disk write)
 *   • Path-separator chars and ".." in folderName → rejected
 *   • Reserved-name collision at the exact scaffold level → rejected with a
 *     descriptive message and reserved: true
 */
export async function createSubfolder(
  parentPath: string,
  folderName: string,
  projectPath?: string,
): Promise<CreateSubfolderResult> {
  // ── Silent rejection on empty name ──────────────────────────────────────
  if (!folderName.trim()) return { ok: false, error: '' };

  // ── Reject path-traversal attempts ──────────────────────────────────────
  const safe = folderName.replace(/[\\/]/g, '').replace(/\.\./g, '').trim();
  if (!safe) return { ok: false, error: 'Invalid folder name.' };
  if (safe !== folderName.trim()) return { ok: false, error: 'Folder name must not contain path separators or "..".' };

  // ── Reserved-name check ──────────────────────────────────────────────────
  if (electron.isElectron() && projectPath) {
    const reserved = await electron.getReservedFolders(projectPath);
    if (reserved.length > 0) {
      // Compute the relative path of parentPath from projectPath, normalised to
      // forward slashes so it matches the atRelPath values stored in the list.
      const projNorm   = projectPath.replace(/\\/g, '/').replace(/\/$/, '');
      const parentNorm = parentPath.replace(/\\/g, '/').replace(/\/$/, '');
      const rel = parentNorm.startsWith(projNorm)
        ? parentNorm.slice(projNorm.length).replace(/^\/+/, '')
        : null;

      if (rel !== null) {
        const conflict = reserved.find(
          (r) => r.atRelPath === rel && r.folderName === folderName.trim(),
        );
        if (conflict) {
          return {
            ok: false,
            reserved: true,
            error: `"${folderName}" is a system folder used by the ${conflict.projectType} scaffold at this location. Choose a different name, or create it elsewhere in the tree.`,
          };
        }
      }
    }
  }

  // ── Disk write ────────────────────────────────────────────────────────────
  if (electron.isElectron()) {
    return electron.createSubfolder(parentPath, folderName.trim());
  }
  return { ok: false, error: 'Folder creation is only available in the desktop app.' };
}

export interface DropOutcome {
  kind: 'file' | 'directory';
  path: string;
  tree?: FileNode[];   // directories
  content?: string;    // files
}

/** Handle a window-level drop event, resolving real paths/handles for whatever was dropped. */
export async function handleDrop(e: DragEvent): Promise<DropOutcome[]> {
  if (electron.isElectron()) {
    const items = e.dataTransfer?.items;
    if (!items) return [];
    const out: DropOutcome[] = [];
    for (const item of Array.from(items)) {
      if (item.kind !== 'file') continue;
      const file = item.getAsFile();
      if (!file) continue;
      const fsPath = electron.getPathForFile(file);
      if (!fsPath) continue;
      const stat = await electron.statPath(fsPath);
      if (stat.isDirectory) {
        const dir = await electron.readDirectory(fsPath);
        out.push({ kind: 'directory', path: fsPath, tree: dir.tree });
      } else {
        const f = await electron.readFile(fsPath);
        out.push({ kind: 'file', path: fsPath, content: f.content ?? '' });
      }
    }
    return out;
  }

  if (!e.dataTransfer) return [];
  const dropped = await browser.handleDrop(e.dataTransfer);
  return dropped.map((d) => ({
    kind: d.kind,
    path: d.path,
    tree: d.root?.children,
    content: d.content,
  }));
}
