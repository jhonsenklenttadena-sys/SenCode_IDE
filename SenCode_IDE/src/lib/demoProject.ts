/**
 * Project helpers — sensitive file detection and file-node utilities.
 * In the Electron build, the real project indexer fills the file tree from
 * the filesystem. Here we keep only the safety utilities (no demo data).
 */

import type { FileNode } from './types';

/** Files that CodeForge auto-excludes from AI context (§7 safety). */
export const SENSITIVE_PATTERNS = [
  /\.env$/,
  /\.pem$/,
  /secret/i,
  /password/i,
  /credential/i,
  /\.key$/,
];

export function isSensitiveFile(path: string): boolean {
  return SENSITIVE_PATTERNS.some((p) => p.test(path));
}

/** Empty file tree — no project loaded. */
export const EMPTY_TREE: FileNode[] = [];
