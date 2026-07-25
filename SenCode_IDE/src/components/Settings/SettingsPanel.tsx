/**
 * SettingsPanel — slide-over settings drawer (§9).
 * Backend config, model defaults, temperature/maxTokens/topP sliders,
 * system prompt editor with presets, theme, font size.
 */

import { useState } from 'react';
import {
  X, SlidersHorizontal as SettingsIcon, Server, Sliders, FileText, Palette,
  Save, RotateCcw, Download, Lock,
} from 'lucide-react';
import type { Settings, BackendType } from '../../lib/types';
import { BASE_SYSTEM_PROMPT } from '../../lib/systemPrompt';

interface SettingsPanelProps {
  open: boolean;
  onClose: () => void;
  settings: Settings;
  onSave: (s: Settings) => void;
}

export function SettingsPanel({ open, onClose, settings, onSave }: SettingsPanelProps) {
  const [draft, setDraft] = useState<Settings>(settings);
  const [saved, setSaved] = useState(false);

  const update = <K extends keyof Settings>(key: K, value: Settings[K]) => {
    setDraft((prev) => ({ ...prev, [key]: value }));
    setSaved(false);
  };

  const updateBackend = (key: keyof Settings['backend'], value: string) => {
    setDraft((prev) => ({ ...prev, backend: { ...prev.backend, [key]: value } }));
    setSaved(false);
  };

  const handleSave = () => {
    onSave(draft);
    setSaved(true);
    setTimeout(() => setSaved(false), 1500);
  };

  const handleReset = () => {
    setDraft(settings);
  };

  const exportSettings = () => {
    const blob = new Blob([JSON.stringify(draft, null, 2)], { type: 'application/json' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = 'SenCode-settings.json';
    a.click();
    URL.revokeObjectURL(url);
  };

  if (!open) return null;

  return (
    <div className="fixed inset-0 z-50 flex justify-end animate-fade-in">
      <div className="absolute inset-0 bg-black/50" onClick={onClose} />
      <div className="relative w-full max-w-md bg-surface-1 border-l border-surface-3 h-full overflow-y-auto shadow-2xl">
        {/* Header */}
        <div className="sticky top-0 bg-surface-1 border-b border-surface-3 px-4 py-3 flex items-center justify-between z-10">
          <div className="flex items-center gap-2">
            <SettingsIcon size={16} className="text-ink-mid" />
            <h2 className="text-sm font-semibold text-ink-high">Preferences</h2>
          </div>
          <div className="flex items-center gap-1">
            <button
              onClick={exportSettings}
              className="p-1.5 text-ink-low hover:text-ink-high hover:bg-surface-3 rounded transition-colors"
              title="Export settings"
            >
              <Download size={14} />
            </button>
            <button
              onClick={onClose}
              className="p-1.5 text-ink-low hover:text-ink-high hover:bg-surface-3 rounded transition-colors"
            >
              <X size={16} />
            </button>
          </div>
        </div>

        <div className="p-4 space-y-6">
          {/* Backend */}
          <Section icon={Server} title="AI Provider">
            <Label>Backend</Label>
            <select
              value={draft.backend.type}
              onChange={(e) => updateBackend('type', e.target.value as BackendType)}
              className="w-full bg-surface-2 border border-surface-3 rounded-lg px-3 py-2 text-xs text-ink-high outline-none focus:border-primary-500"
            >
              <option value="local">Local GGUF (built-in)</option>
              <option value="lmstudio">LM Studio</option>
              <option value="ollama">Ollama</option>
              <option value="custom">Custom OpenAI-compatible</option>
            </select>

            <Label>API URL</Label>
            <input
              value={draft.backend.baseUrl}
              onChange={(e) => updateBackend('baseUrl', e.target.value)}
              placeholder="http://localhost:1234/v1"
              className="w-full bg-surface-2 border border-surface-3 rounded-lg px-3 py-2 text-xs font-mono text-ink-high placeholder-ink-low outline-none focus:border-primary-500"
            />
            <p className="text-2xs text-ink-low mt-1">
              LM Studio: <code className="text-ink-mid">localhost:1234/v1</code> · Ollama: <code className="text-ink-mid">localhost:11434/v1</code>
            </p>

            <Label>API Key (optional)</Label>
            <input
              value={draft.backend.apiKey ?? ''}
              onChange={(e) => updateBackend('apiKey', e.target.value)}
              type="password"
              placeholder="Usually empty for local backends"
              className="w-full bg-surface-2 border border-surface-3 rounded-lg px-3 py-2 text-xs font-mono text-ink-high placeholder-ink-low outline-none focus:border-primary-500"
            />
          </Section>

          {/* Generation params */}
          <Section icon={Sliders} title="Generation">
            <Slider
              label="Temperature"
              value={draft.temperature}
              min={0}
              max={2}
              step={0.1}
              onChange={(v) => update('temperature', v)}
            />
            <Slider
              label="Max Tokens"
              value={draft.maxTokens}
              min={256}
              max={8192}
              step={256}
              onChange={(v) => update('maxTokens', v)}
            />
            <Slider
              label="Top P"
              value={draft.topP}
              min={0}
              max={1}
              step={0.05}
              onChange={(v) => update('topP', v)}
            />
          </Section>

          {/* System prompt */}
          <Section icon={FileText} title="System Prompt">
            <div className="flex items-center justify-between mb-1">
              <div className="flex items-center gap-1.5">
                <Lock size={11} className="text-ink-low" />
                <Label>Base Prompt ("Default Assistant")</Label>
              </div>
              <button
                onClick={() => update('basePrompt', BASE_SYSTEM_PROMPT)}
                className="text-2xs text-ink-low hover:text-ink-high transition-colors underline decoration-dotted"
                title="Reset to the shipped default"
              >
                Reset to default
              </button>
            </div>
            <textarea
              value={draft.basePrompt}
              onChange={(e) => update('basePrompt', e.target.value)}
              rows={8}
              className="w-full bg-surface-2 border border-surface-3 rounded-lg px-3 py-2 text-2xs font-mono text-ink-high outline-none focus:border-primary-500 resize-y"
            />
            <p className="text-2xs text-ink-low mt-1">
              🔒 Planned for deploy: this field will become locked and non-copyable in production builds, so end users can't view or edit it. Editable here for now during development.
            </p>

            <Label>Custom Instructions</Label>
            <textarea
              value={draft.customInstructions}
              onChange={(e) => update('customInstructions', e.target.value)}
              rows={5}
              placeholder="Optional — add your own preferences (e.g. coding style, preferred libraries, tone). These are appended after the base prompt and are the one field meant to stay editable for end users after deploy."
              className="w-full bg-surface-2 border border-surface-3 rounded-lg px-3 py-2 text-xs text-ink-high placeholder-ink-low outline-none focus:border-primary-500 resize-y"
            />
          </Section>

          {/* Appearance */}
          <Section icon={Palette} title="Appearance">
            <Label>Theme</Label>
            <div className="grid grid-cols-1 gap-1.5">
              {([
                { id: 'midnight', label: 'Midnight',  dot: '#7a5af8', desc: 'Deep purple — default' },
                { id: 'ocean',    label: 'Ocean',     dot: '#3b82f6', desc: 'Cool dark blue' },
                { id: 'forest',   label: 'Forest',    dot: '#22c55e', desc: 'Dark green' },
                { id: 'ember',    label: 'Ember',     dot: '#f97316', desc: 'Warm dark orange' },
                { id: 'arctic',   label: 'Arctic',    dot: '#4a6cf7', desc: 'Light / bright' },
              ] as const).map((t) => (
                <button
                  key={t.id}
                  onClick={() => update('theme', t.id)}
                  className="flex items-center gap-3 px-3 py-2 rounded-lg border transition-all text-left"
                  style={
                    draft.theme === t.id
                      ? { background: 'var(--primary-dim)', borderColor: 'var(--primary)', color: 'var(--accent)' }
                      : { background: 'var(--s2)', borderColor: 'var(--s3)', color: 'var(--ink-mid)' }
                  }
                >
                  <span
                    className="w-3 h-3 rounded-full flex-shrink-0"
                    style={{ background: t.dot, boxShadow: draft.theme === t.id ? `0 0 6px ${t.dot}` : 'none' }}
                  />
                  <span className="text-xs font-medium" style={{ color: draft.theme === t.id ? 'var(--accent)' : 'var(--ink-high)' }}>
                    {t.label}
                  </span>
                  <span className="text-2xs ml-auto" style={{ color: 'var(--ink-low)' }}>{t.desc}</span>
                </button>
              ))}
            </div>

            <Slider
              label="Editor Font Size"
              value={draft.fontSize}
              min={11}
              max={20}
              step={1}
              onChange={(v) => update('fontSize', v)}
            />
          </Section>

          {/* History */}
          <Section icon={Save} title="History">
            <label className="flex items-center gap-2 cursor-pointer">
              <input
                type="checkbox"
                checked={draft.autoSaveHistory}
                onChange={(e) => update('autoSaveHistory', e.target.checked)}
                className="w-4 h-4 rounded accent-accent-500"
              />
              <span className="text-xs text-ink-high">Auto-save chat history</span>
            </label>
            {draft.autoSaveHistory && (
              <>
                <Slider
                  label="Auto-delete after (days)"
                  value={draft.retainDays ?? 15}
                  min={1}
                  max={90}
                  step={1}
                  onChange={(v) => update('retainDays', v)}
                />
                <p className="text-2xs mt-1" style={{ color: 'var(--ink-low)' }}>
                  Unpinned sessions older than {draft.retainDays ?? 15} days are deleted automatically.
                  Pinned sessions are kept forever. A memory profile is extracted before deletion.
                </p>
              </>
            )}
          </Section>
        </div>

        {/* Footer */}
        <div className="sticky bottom-0 bg-surface-1 border-t border-surface-3 px-4 py-3 flex items-center gap-2">
          <button
            onClick={handleReset}
            className="flex items-center gap-1.5 px-3 py-2 text-2xs text-ink-mid hover:text-ink-high rounded-lg transition-colors"
          >
            <RotateCcw size={13} />
            Reset
          </button>
          <div className="flex-1" />
          <button
            onClick={handleSave}
            className={`flex items-center gap-1.5 px-4 py-2 text-2xs font-medium rounded-lg transition-colors ${
              saved ? 'bg-success-600 text-white' : 'bg-primary-600 hover:bg-primary-500 text-white'
            }`}
          >
            {saved ? (
              <>
                <Save size={13} /> Saved
              </>
            ) : (
              <>
                <Save size={13} /> Save
              </>
            )}
          </button>
        </div>
      </div>
    </div>
  );
}

function Section({ icon: Icon, title, children }: { icon: any; title: string; children: React.ReactNode }) {
  return (
    <div>
      <div className="flex items-center gap-2 mb-3">
        <Icon size={14} className="text-ink-low" />
        <h3 className="text-xs font-semibold text-ink-high uppercase tracking-wide">{title}</h3>
      </div>
      <div className="space-y-2 pl-1">
        {children}
      </div>
    </div>
  );
}

function Label({ children }: { children: React.ReactNode }) {
  return <label className="block text-2xs text-ink-mid mb-1 mt-2 first:mt-0">{children}</label>;
}

function Slider({
  label, value, min, max, step, onChange,
}: {
  label: string; value: number; min: number; max: number; step: number;
  onChange: (v: number) => void;
}) {
  return (
    <div className="mt-2">
      <div className="flex items-center justify-between mb-1">
        <span className="text-2xs text-ink-mid">{label}</span>
        <span className="text-2xs font-mono text-ink-high">{value}</span>
      </div>
      <input
        type="range"
        value={value}
        min={min}
        max={max}
        step={step}
        onChange={(e) => onChange(parseFloat(e.target.value))}
        className="w-full accent-primary-500"
      />
    </div>
  );
}
