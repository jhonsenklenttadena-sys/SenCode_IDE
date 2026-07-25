/**
 * Typed wrapper around window.electronAPI (exposed by electron/preload.cjs).
 * All functions are no-ops when running outside Electron (plain browser).
 */

import type { FileNode, HardwareInfo } from './types';

export type BackendLaunchState = 'idle' | 'checking' | 'starting' | 'connected' | 'failed';

export interface BackendStatus {
  state: BackendLaunchState;
  backend?: 'lmstudio' | 'ollama' | 'local';
  attempt?: number;
  maxAttempts?: number;
  message?: string;
  autoSelected?: string;
  hardware?: HardwareInfo;
}

export interface ModelSuitability {
  ok: boolean;
  warning: boolean;
  blocked: boolean;
  reason: string;
}

export interface ReservedFolder {
  folderName: string;
  atRelPath: string;
  projectType: string;
}

export interface WorkspaceData {
  projectPath: string;
  tabs: { id: string; name: string; path: string; language: string; content: string; dirty?: boolean }[];
  activeTabId: string | null;
  mode: string;
  sessionId?: string;
}

export interface LicenseInfo {
  licenseKey: string;
  status: 'active' | 'invalid';
  revalidateBy: string;
  daysUntilRevalidate: number;
  isInGrace: boolean;
  graceRemaining: number | null;
  graceDays: number;
  error?: string;
}

interface ElectronAPI {
  isElectron: true;
  // Backend
  getBackendStatus: () => Promise<BackendStatus>;
  restartBackend: () => Promise<void>;
  onBackendStatus: (cb: (status: BackendStatus) => void) => () => void;
  // Hardware
  getHardwareInfo: () => Promise<HardwareInfo | null>;
  onHardwareInfo: (cb: (info: HardwareInfo) => void) => () => void;
  checkModelSuitability: (model: { id: string; name?: string; sizeBytes?: number }) => Promise<ModelSuitability>;
  // LLM proxy
  getModels: (url: string, headers: Record<string, string>) => Promise<{ ok: boolean; status: number; body: string; error?: string }>;
  streamChat: (requestId: string, body: string) => void;
  streamAbort: (requestId: string) => void;
  onStreamChunk: (cb: (requestId: string, chunk: string) => void) => () => void;
  // Filesystem
  openFolderDialog: () => Promise<string | null>;
  openFileDialog: () => Promise<string[]>;
  createFolderDialog: () => Promise<string | null | { error: string }>;
  createSubfolder: (parentPath: string, folderName: string) => Promise<{ ok: boolean; path?: string; error?: string }>;
  getReservedFolders: (projectPath: string) => Promise<ReservedFolder[]>;
  readDirectory: (dirPath: string) => Promise<{ ok: boolean; tree: FileNode[]; error?: string }>;
  readFile: (filePath: string) => Promise<{ ok: boolean; content?: string; error?: string }>;
  writeFile: (filePath: string, content: string) => Promise<{ ok: boolean; error?: string }>;
  renameFile: (fromPath: string, toPath: string) => Promise<{ ok: boolean; error?: string }>;
  deleteFile: (filePath: string) => Promise<{ ok: boolean; error?: string }>;
  deleteFolder: (folderPath: string) => Promise<{ ok: boolean; error?: string }>;
  writeFileSafe: (filePath: string, content: string) => Promise<{ ok: boolean; error?: string }>;
  restoreBackup: (filePath: string) => Promise<{ ok: boolean; error?: string }>;
  statPath: (targetPath: string) => Promise<{ ok: boolean; isDirectory: boolean; isFile: boolean; error?: string }>;
  getPathForFile: (file: File) => string;
  // Terminal
  runCommand: (command: string, cwd?: string, projectPath?: string) => Promise<{ ok: boolean; stdout: string; stderr: string; exitCode?: number }>;
  // Project creation
  createProject: (opts: { name: string; language: string; projectType?: string; parentDir: string }) => Promise<{ ok: boolean; path?: string; error?: string }>;
  // Workspace
  saveWorkspace: (data: WorkspaceData) => Promise<void>;
  loadWorkspace: () => Promise<{ data: WorkspaceData } | null>;
  // License
  getLicenseInfo: () => Promise<LicenseInfo | null>;
  deactivateDevice: () => Promise<{ ok: boolean; error?: string }>;
}

function getBridge(): ElectronAPI | null {
  return (window as unknown as { electronAPI?: ElectronAPI }).electronAPI ?? null;
}

export const isElectron = (): boolean => getBridge() !== null;

// ── Backend ────────────────────────────────────────────────────────────────
export async function getInitialBackendStatus(): Promise<BackendStatus> {
  try { return await getBridge()?.getBackendStatus() ?? { state: 'idle' }; }
  catch { return { state: 'idle' }; }
}
export function subscribeBackendStatus(cb: (s: BackendStatus) => void): () => void {
  return getBridge()?.onBackendStatus(cb) ?? (() => {});
}
export async function restartBackend(): Promise<void> {
  await getBridge()?.restartBackend();
}

// ── Hardware ────────────────────────────────────────────────────────────────
export async function getHardwareInfo(): Promise<HardwareInfo | null> {
  try { return await getBridge()?.getHardwareInfo() ?? null; }
  catch { return null; }
}
export function subscribeHardwareInfo(cb: (info: HardwareInfo) => void): () => void {
  return getBridge()?.onHardwareInfo(cb) ?? (() => {});
}
export async function checkModelSuitability(model: { id: string; name?: string; sizeBytes?: number }): Promise<ModelSuitability> {
  try {
    return await getBridge()?.checkModelSuitability(model)
      ?? { ok: true, warning: false, blocked: false, reason: '' };
  } catch {
    return { ok: true, warning: false, blocked: false, reason: '' };
  }
}

// ── Filesystem ──────────────────────────────────────────────────────────────
export async function openFolderDialog(): Promise<string | null> {
  return getBridge()?.openFolderDialog() ?? null;
}
export async function openFileDialog(): Promise<string[]> {
  return getBridge()?.openFileDialog() ?? [];
}
export async function createFolderDialog(): Promise<string | null | { error: string }> {
  return getBridge()?.createFolderDialog() ?? null;
}
export async function createSubfolder(parentPath: string, folderName: string): Promise<{ ok: boolean; path?: string; error?: string }> {
  return getBridge()?.createSubfolder(parentPath, folderName) ?? { ok: false, error: 'Not in Electron' };
}
export async function getReservedFolders(projectPath: string): Promise<ReservedFolder[]> {
  return getBridge()?.getReservedFolders(projectPath) ?? [];
}
export async function readDirectory(dirPath: string): Promise<{ ok: boolean; tree: FileNode[]; error?: string }> {
  return getBridge()?.readDirectory(dirPath) ?? { ok: false, tree: [], error: 'Not in Electron' };
}
export async function readFile(filePath: string): Promise<{ ok: boolean; content?: string; error?: string }> {
  return getBridge()?.readFile(filePath) ?? { ok: false, error: 'Not in Electron' };
}
export async function writeFile(filePath: string, content: string): Promise<{ ok: boolean; error?: string }> {
  return getBridge()?.writeFile(filePath, content) ?? { ok: false, error: 'Not in Electron' };
}
export async function renameFile(fromPath: string, toPath: string): Promise<{ ok: boolean; error?: string }> {
  return getBridge()?.renameFile(fromPath, toPath) ?? { ok: false, error: 'Not in Electron' };
}
export async function deleteFile(filePath: string): Promise<{ ok: boolean; error?: string }> {
  return getBridge()?.deleteFile(filePath) ?? { ok: false, error: 'Not in Electron' };
}
export async function deleteFolder(folderPath: string): Promise<{ ok: boolean; error?: string }> {
  return getBridge()?.deleteFolder(folderPath) ?? { ok: false, error: 'Not in Electron' };
}

/** Write a file with automatic .bak backup of the original. */
export async function writeFileSafe(filePath: string, content: string): Promise<{ ok: boolean; error?: string }> {
  return getBridge()?.writeFileSafe(filePath, content) ?? { ok: false, error: 'Not in Electron' };
}

/** Restore a .bak backup for a file. */
export async function restoreBackup(filePath: string): Promise<{ ok: boolean; error?: string }> {
  return getBridge()?.restoreBackup(filePath) ?? { ok: false, error: 'Not in Electron' };
}

/** Stat a path to determine if it is a file or directory. */
export async function statPath(targetPath: string): Promise<{ ok: boolean; isDirectory: boolean; isFile: boolean; error?: string }> {
  return getBridge()?.statPath(targetPath) ?? { ok: false, isDirectory: false, isFile: false, error: 'Not in Electron' };
}

/**
 * Resolve the real filesystem path for a File object dropped onto the
 * window. Electron 32+ removed the legacy `File.path` property — this is
 * now the only supported way to do this. Returns null outside Electron or if resolution fails.
 */
export function getPathForFile(file: File): string | null {
  try {
    const path = getBridge()?.getPathForFile(file);
    return path && path.length > 0 ? path : null;
  } catch {
    return null;
  }
}

/** Write multiple files to disk at once. Auto-creates parent directories. Backs up existing files. */
export async function writeFiles(files: { path: string; content: string }[]): Promise<{ path: string; ok: boolean; error?: string }[]> {
  const bridge = getBridge() as any;
  return bridge?.writeFiles?.(files) 
    ?? files.map(f => ({ path: f.path, ok: false, error: 'Not in Electron' }));
}

/** Undo a write-files operation — restores .bak files or deletes newly created files. */
export async function undoWriteFiles(filePaths: string[]): Promise<{ path: string; ok: boolean; action?: string; error?: string }[]> {
  const bridge = getBridge() as any;
  return bridge?.undoWriteFiles?.(filePaths) 
    ?? filePaths.map(p => ({ path: p, ok: false, error: 'Not in Electron' }));
}


/** Create directories (recursively) without writing any files. */
export async function createDirs(
  dirs: string[],
): Promise<{ path: string; ok: boolean; error?: string }[]> {
  const bridge = getBridge() as any;
  return bridge?.createDirs?.(dirs) 
    ?? dirs.map(d => ({ path: d, ok: false, error: 'Not in Electron' }));
}


// ── Terminal ──────────────────────────────────────────────────────────────────
export async function runCommand(
  command: string,
  cwd?: string,
  projectPath?: string,
): Promise<{ ok: boolean; stdout: string; stderr: string; exitCode?: number }> {
  return getBridge()?.runCommand(command, cwd, projectPath)
    ?? { ok: false, stdout: '', stderr: 'Not in Electron' };
}

// ── Project creation ──────────────────────────────────────────────────────────
export async function createProject(opts: {
  name: string;
  language: string;
  projectType?: string;
  parentDir: string;
}): Promise<{ ok: boolean; path?: string; error?: string }> {
  return getBridge()?.createProject(opts)
    ?? { ok: false, error: 'Not in Electron' };
}

// ── Workspace persistence ─────────────────────────────────────────────────────
export async function saveWorkspace(data: WorkspaceData): Promise<void> {
  try { await (getBridge() as any)?.saveWorkspace?.(data); } catch {}
}

export async function loadWorkspace(): Promise<WorkspaceData | null> {
  try {
    const res = await (getBridge() as any)?.loadWorkspace?.();
    return res?.data ?? null;
  } catch { return null; }
}

// ── License & Device ──────────────────────────────────────────────────────────
export async function getLicenseInfo(): Promise<LicenseInfo | null> {
  try {
    return await (getBridge() as any)?.getLicenseInfo?.() ?? null;
  } catch {
    return null;
  }
}

export async function deactivateDevice(): Promise<{ ok: boolean; error?: string }> {
  try {
    return await (getBridge() as any)?.deactivateDevice?.()
      ?? { ok: false, error: 'Not in Electron' };
  } catch (e: any) {
    return { ok: false, error: e?.message ?? 'Unknown error' };
  }
}
