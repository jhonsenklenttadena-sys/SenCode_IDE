/**
 * Settings persistence — saves to localStorage in the web renderer.
 * In the Electron build this maps to a JSON file in the user data dir.
 */

import type { Settings } from './types';
import { BASE_SYSTEM_PROMPT } from './systemPrompt';

const STORAGE_KEY = 'SenCode:settings';

/**
 * DEFAULT_SETTINGS.basePrompt is seeded from BASE_SYSTEM_PROMPT (the
 * shipped default). It's editable via Settings for now — see
 * TODO(deploy-lock) in types.ts for the planned future lock.
 */
export const DEFAULT_SETTINGS: Settings = {
  backend: {
    type: 'local',
    baseUrl: 'local://models',
    apiKey: '',
  },
  defaultModelId: '',
  temperature: 0.7,
  maxTokens: 4096,
  topP: 0.9,
  basePrompt: BASE_SYSTEM_PROMPT,
  customInstructions: '',
  theme: 'midnight',
  fontSize: 14,
  fontFamily: 'JetBrains Mono',
  autoSaveHistory: true,
  retainDays: 15,
};

export function loadSettings(): Settings {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return { ...DEFAULT_SETTINGS };
    const parsed = JSON.parse(raw);

    // Migration: an earlier build (briefly) shipped a locked-base-prompt
    // model with an `activePresetId` preset picker. That's gone — presets
    // were removed in favor of a single "Default Assistant" base prompt.
    // Drop the stale key if present; also drop any very old `systemPrompt`
    // key from before the basePrompt/customInstructions split existed.
    delete parsed.systemPrompt;
    delete parsed.activePresetId;

    return { ...DEFAULT_SETTINGS, ...parsed, backend: { ...DEFAULT_SETTINGS.backend, ...parsed.backend } };
  } catch {
    return { ...DEFAULT_SETTINGS };
  }
}

export function saveSettings(s: Settings): void {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(s));
  } catch {
    // ignore quota errors
  }
}
