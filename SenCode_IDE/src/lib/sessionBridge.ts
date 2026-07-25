/**
 * sessionBridge.ts
 * Typed renderer-side wrapper for session history IPC.
 * All functions are safe no-ops when running outside Electron.
 */

import type { ChatSession, SessionIndex, UserMemory } from './types';

interface ElectronAPI {
  saveSession:   (session: ChatSession)          => Promise<{ ok: boolean; error?: string }>;
  listSessions:  ()                              => Promise<SessionIndex[]>;
  loadSession:   (id: string)                    => Promise<{ ok: boolean; session?: ChatSession; error?: string }>;
  deleteSession: (id: string)                    => Promise<{ ok: boolean; error?: string }>;
  pinSession:    (id: string, pinned: boolean)   => Promise<{ ok: boolean; error?: string }>;
  runCleanup:    (retainDays: number)            => Promise<number>;
  getMemory:     ()                              => Promise<UserMemory | null>;
}

function getBridge(): ElectronAPI | null {
  return (window as unknown as { electronAPI?: ElectronAPI }).electronAPI ?? null;
}

export async function saveSession(session: ChatSession) {
  return getBridge()?.saveSession(session) ?? { ok: false };
}

export async function listSessions(): Promise<SessionIndex[]> {
  return getBridge()?.listSessions() ?? [];
}

export async function loadSession(id: string) {
  return getBridge()?.loadSession(id) ?? { ok: false, error: 'Not in Electron' };
}

export async function deleteSession(id: string) {
  return getBridge()?.deleteSession(id) ?? { ok: false };
}

export async function pinSession(id: string, pinned: boolean) {
  return getBridge()?.pinSession(id, pinned) ?? { ok: false };
}

export async function runCleanup(retainDays: number) {
  return getBridge()?.runCleanup(retainDays) ?? 0;
}

export async function getUserMemory(): Promise<UserMemory | null> {
  return getBridge()?.getMemory() ?? null;
}

/** Generate a short title from the first user message of a session. */
export function deriveTitle(firstUserMessage: string): string {
  const clean = firstUserMessage.replace(/^\/\w+\s*/, '').trim();
  return clean.length > 60 ? clean.slice(0, 60) + '…' : clean || 'New Chat';
}
