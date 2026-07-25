/**
 * ModelSelector — dropdown to pick the active local model.
 *
 * Features added:
 * - Hardware tier badge (Low / Mid / High / Ultra) next to the selector
 * - Each model row shows size, a ✓ recommended badge, or a ⚠ / ✗ warning
 * - Blocked models show a confirm dialog before loading (user can override)
 * - Live rescan on refresh button click
 * - Download suggestions shown when no models are found
 */

import { useState, useRef, useEffect } from 'react';
import {
  ChevronDown, Cpu, Check, RefreshCw, Wifi, WifiOff,
  AlertTriangle, XCircle, Sparkles, Download, Info,
} from 'lucide-react';
import type { ModelInfo, HardwareInfo } from '../../lib/types';

interface ModelSelectorProps {
  models: ModelInfo[];
  activeModel: string;
  connected: boolean;
  hardwareInfo: HardwareInfo | null;
  onSelect: (id: string) => void;
  onRefresh: () => void;
  /** Optional: open the Runtimes sidebar panel from the hardware badge */
  onOpenRuntimes?: () => void;
}

// Tier colours
const TIER_STYLES: Record<string, { bg: string; text: string; label: string }> = {
  low  : { bg: 'bg-warning-500/15', text: 'text-warning-400', label: 'Low-end'  },
  mid  : { bg: 'bg-primary-500/15', text: 'text-primary-400', label: 'Mid-range' },
  high : { bg: 'bg-success-500/15', text: 'text-success-400', label: 'High-end'  },
  ultra: { bg: 'bg-accent-500/15',  text: 'text-accent-400',  label: 'Ultra'     },
};

export function ModelSelector({
  models,
  activeModel,
  connected,
  hardwareInfo,
  onSelect,
  onRefresh,
  onOpenRuntimes,
}: ModelSelectorProps) {
  const [open, setOpen]               = useState(false);
  const [confirmModel, setConfirmModel] = useState<ModelInfo | null>(null);
  const [showHwInfo, setShowHwInfo]   = useState(false);
  const ref     = useRef<HTMLDivElement>(null);
  const badgeRef = useRef<HTMLButtonElement>(null);
  // Track badge position so the fixed panel aligns under it
  const [panelPos, setPanelPos] = useState<{ top: number; right: number } | null>(null);

  // Close dropdown on outside click
  useEffect(() => {
    const handler = (e: MouseEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) {
        setOpen(false);
        setShowHwInfo(false);
        setPanelPos(null);
      }
    };
    document.addEventListener('mousedown', handler);
    return () => document.removeEventListener('mousedown', handler);
  }, []);

  const active    = models.find((m) => m.id === activeModel);
  const label     = activeModel ? (active?.name ?? activeModel) : 'demo mode';
  const tierStyle = hardwareInfo ? (TIER_STYLES[hardwareInfo.tier] ?? TIER_STYLES.low) : null;

  const handleSelect = (model: ModelInfo) => {
    // Blocked model → show confirm dialog, don't select immediately
    if (model.blocked) {
      setConfirmModel(model);
      return;
    }
    onSelect(model.id);
    setOpen(false);
  };

  return (
    <div ref={ref} className="relative flex items-center gap-1.5">

      {/* Hardware tier badge */}
      {hardwareInfo && tierStyle && (
        <button
          ref={badgeRef}
          onClick={() => {
            if (showHwInfo) {
              setShowHwInfo(false);
              setPanelPos(null);
            } else {
              const r = badgeRef.current?.getBoundingClientRect();
              if (r) setPanelPos({ top: r.bottom + 6, right: window.innerWidth - r.right });
              setShowHwInfo(true);
              setOpen(false);
            }
          }}
          title={`Hardware tier: ${hardwareInfo.tierLabel}`}
          className={`flex items-center gap-1 px-2 py-1 rounded-md text-2xs font-medium border border-transparent transition-colors ${tierStyle.bg} ${tierStyle.text} hover:border-current`}
        >
          <Info size={11} />
          {tierStyle.label}
        </button>
      )}

      {/* Model selector button */}
      <button
        onClick={() => { setOpen((v) => !v); setShowHwInfo(false); }}
        className="flex items-center gap-1.5 px-2.5 py-1 bg-surface-2 hover:bg-surface-3 border border-surface-3 rounded-md text-xs text-ink-high transition-colors"
      >
        <Cpu size={13} className={connected ? 'text-accent-400' : 'text-ink-low'} />
        <span className="max-w-[140px] truncate">{label}</span>
        {active?.warning && !active?.blocked && (
          <AlertTriangle size={11} className="text-warning-400 flex-shrink-0" />
        )}
        {active?.blocked && (
          <XCircle size={11} className="text-error-400 flex-shrink-0" />
        )}
        <ChevronDown size={12} className="text-ink-low" />
      </button>

      {/* ── Hardware info panel — fixed so it never clips under the header ── */}
      {showHwInfo && hardwareInfo && panelPos && (
        <div
          className="fixed w-80 bg-surface-2 border border-surface-3 rounded-lg shadow-2xl z-[200] p-3 animate-fade-in text-2xs"
          style={{ top: panelPos.top, right: panelPos.right }}
        >
          <div className="font-semibold text-ink-high mb-2 flex items-center gap-1.5">
            <Cpu size={13} className="text-accent-400" />
            Your Hardware
          </div>
          <div className="space-y-1 text-ink-mid mb-3">
            <div className="flex justify-between"><span>RAM</span><span className="text-ink-high font-mono">{hardwareInfo.ramGB} GB</span></div>
            <div className="flex justify-between"><span>CPU</span><span className="text-ink-high font-mono truncate max-w-[180px]">{hardwareInfo.cpuModel}</span></div>
            {hardwareInfo.gpus.map((g, i) => (
              <div key={i} className="flex justify-between">
                <span>GPU {i} {g.isNvidia ? '(NVIDIA)' : g.isAmd ? '(AMD)' : '(Intel)'}</span>
                <span className="text-ink-high font-mono truncate max-w-[140px]">{g.model} {g.vramGB > 0 ? `· ${g.vramGB}GB` : ''}</span>
              </div>
            ))}
            <div className="flex justify-between pt-1 border-t border-surface-3">
              <span>Tier</span>
              <span className={`font-semibold ${tierStyle?.text}`}>{hardwareInfo.tierLabel}</span>
            </div>
            <div className="flex justify-between">
              <span>Max model size</span>
              <span className="text-ink-high font-mono">{hardwareInfo.maxModelSizeGB} GB</span>
            </div>
          </div>
          {hardwareInfo.recommendedSuggestion && (
            <p className="text-ink-low italic leading-relaxed border-t border-surface-3 pt-2">
              {hardwareInfo.recommendedSuggestion}
            </p>
          )}
          {hardwareInfo.downloadSuggestions.length > 0 && (
            <div className="mt-2 border-t border-surface-3 pt-2">
              <div className="text-ink-mid mb-1 font-medium flex items-center gap-1">
                <Download size={10} /> Suggested models for your device
              </div>
              {hardwareInfo.downloadSuggestions.map((s) => (
                <div key={s} className="font-mono text-ink-low truncate py-0.5">{s}</div>
              ))}
            </div>
          )}
          {onOpenRuntimes && (
            <button
              onClick={() => { setShowHwInfo(false); setPanelPos(null); onOpenRuntimes(); }}
              className="mt-2 w-full text-left border-t border-surface-3 pt-2 text-accent-400 hover:text-accent-300 transition-colors flex items-center gap-1"
            >
              <Download size={10} /> View Runtime Library →
            </button>
          )}
        </div>
      )}

      {/* ── Model dropdown ───────────────────────────────────────────────── */}
      {open && (
        <div className="absolute top-full left-0 mt-1 w-80 bg-surface-2 border border-surface-3 rounded-lg shadow-2xl z-50 py-1 animate-fade-in">

          {/* Connection status + refresh */}
          <div className="flex items-center gap-2 px-3 py-2 border-b border-surface-3">
            {connected ? (
              <>
                <Wifi size={13} className="text-success-500" />
                <span className="text-2xs text-success-500 font-medium">Connected</span>
              </>
            ) : (
              <>
                <WifiOff size={13} className="text-warning-500" />
                <span className="text-2xs text-warning-500 font-medium">Offline — demo mode</span>
              </>
            )}
            <button
              onClick={onRefresh}
              className="ml-auto p-1 text-ink-low hover:text-ink-high rounded transition-colors"
              title="Rescan Models folder for new .gguf files"
            >
              <RefreshCw size={12} />
            </button>
          </div>

          {/* Model list */}
          {models.length === 0 ? (
            <div className="px-3 py-4 text-center">
              <p className="text-2xs text-ink-mid mb-2">No models found in the Models folder.</p>
              <p className="text-2xs text-ink-low leading-relaxed">
                Add <code className="text-accent-400">.gguf</code> files to the{' '}
                <code className="text-accent-400">Models/</code> folder next to the app, then click refresh.
              </p>
              {hardwareInfo?.downloadSuggestions.length ? (
                <div className="mt-3 text-left border-t border-surface-3 pt-2">
                  <div className="text-2xs text-ink-mid mb-1.5 flex items-center gap-1">
                    <Download size={10} className="text-accent-400" />
                    Recommended for your device ({hardwareInfo.tierLabel}):
                  </div>
                  {hardwareInfo.downloadSuggestions.map((s) => (
                    <div key={s} className="font-mono text-2xs text-ink-low truncate py-0.5">{s}</div>
                  ))}
                </div>
              ) : null}
            </div>
          ) : (
            <div className="max-h-72 overflow-y-auto">
              {models.map((m) => (
                <ModelRow
                  key={m.id}
                  model={m}
                  isActive={m.id === activeModel}
                  onSelect={handleSelect}
                />
              ))}
            </div>
          )}

          {/* Demo mode entry */}
          <div className="border-t border-surface-3 px-3 py-2">
            <button
              onClick={() => { onSelect(''); setOpen(false); }}
              className="w-full flex items-center gap-2 text-left"
            >
              <div className="flex-1">
                <div className="text-xs text-ink-mid font-mono">demo mode</div>
                <div className="text-2xs text-ink-low">No model needed — UI preview only</div>
              </div>
              {!activeModel && <Check size={14} className="text-accent-400" />}
            </button>
          </div>
        </div>
      )}

      {/* ── Blocked model confirmation dialog ───────────────────────────── */}
      {confirmModel && (
        <BlockedModelDialog
          model={confirmModel}
          onCancel={() => setConfirmModel(null)}
          onOverride={() => {
            onSelect(confirmModel.id);
            setConfirmModel(null);
            setOpen(false);
          }}
        />
      )}
    </div>
  );
}

// ── Model row ──────────────────────────────────────────────────────────────────

function ModelRow({
  model,
  isActive,
  onSelect,
}: {
  model: ModelInfo;
  isActive: boolean;
  onSelect: (m: ModelInfo) => void;
}) {
  return (
    <button
      onClick={() => onSelect(model)}
      className={`w-full flex items-start gap-2 px-3 py-2 hover:bg-surface-3 transition-colors text-left ${
        model.blocked ? 'opacity-60' : ''
      }`}
      title={model.warningReason ?? undefined}
    >
      {/* Status icon */}
      <div className="flex-shrink-0 mt-0.5">
        {model.recommended && !model.warning ? (
          <Sparkles size={13} className="text-accent-400" aria-label="Recommended for your device" />
        ) : model.blocked ? (
          <XCircle size={13} className="text-error-400" />
        ) : model.warning ? (
          <AlertTriangle size={13} className="text-warning-400" />
        ) : (
          <div className="w-[13px]" />
        )}
      </div>

      {/* Name + size + badges */}
      <div className="flex-1 min-w-0">
        <div className="flex items-center gap-1.5 flex-wrap">
          <span className="text-xs text-ink-high truncate font-mono">{model.name ?? model.id}</span>
          {model.recommended && (
            <span className="px-1 py-0.5 text-2xs rounded bg-accent-600/20 text-accent-400 flex-shrink-0">
              ★ Best
            </span>
          )}
          {model.blocked && (
            <span className="px-1 py-0.5 text-2xs rounded bg-error-600/20 text-error-400 flex-shrink-0">
              Too heavy
            </span>
          )}
          {model.warning && !model.blocked && (
            <span className="px-1 py-0.5 text-2xs rounded bg-warning-600/20 text-warning-400 flex-shrink-0">
              Caution
            </span>
          )}
        </div>
        {model.size && (
          <div className="text-2xs text-ink-low mt-0.5">{model.size}</div>
        )}
        {model.warningReason && (
          <div className="text-2xs text-ink-low mt-0.5 leading-relaxed line-clamp-2">
            {model.warningReason}
          </div>
        )}
      </div>

      {/* Active check */}
      {isActive && <Check size={14} className="text-accent-400 flex-shrink-0 mt-0.5" />}
    </button>
  );
}

// ── Blocked model confirm dialog ───────────────────────────────────────────────

function BlockedModelDialog({
  model,
  onCancel,
  onOverride,
}: {
  model: ModelInfo;
  onCancel: () => void;
  onOverride: () => void;
}) {
  return (
    <div className="fixed inset-0 bg-black/60 flex items-center justify-center z-[100] animate-fade-in">
      <div className="bg-surface-1 border border-error-500/40 rounded-xl p-5 max-w-sm w-full mx-4 shadow-2xl">
        <div className="flex items-start gap-3 mb-4">
          <div className="w-10 h-10 rounded-lg bg-error-500/15 flex items-center justify-center flex-shrink-0">
            <AlertTriangle size={18} className="text-error-400" />
          </div>
          <div>
            <h3 className="text-sm font-semibold text-ink-high mb-1">
              Model may not run on this device
            </h3>
            <p className="text-2xs text-ink-mid leading-relaxed">
              {model.warningReason ?? 'This model exceeds the recommended specs for your hardware.'}
            </p>
          </div>
        </div>
        <div className="bg-surface-2 rounded-lg px-3 py-2 mb-4">
          <div className="text-2xs font-mono text-ink-high truncate">{model.name ?? model.id}</div>
          {model.size && <div className="text-2xs text-ink-low">{model.size}</div>}
        </div>
        <p className="text-2xs text-ink-low mb-4">
          Loading this model may cause the app to crash, freeze, or run extremely slowly.
          You can still try — if it fails, choose a smaller model.
        </p>
        <div className="flex gap-2 justify-end">
          <button
            onClick={onCancel}
            className="px-3 py-1.5 text-2xs text-ink-mid hover:text-ink-high rounded-lg transition-colors"
          >
            Cancel
          </button>
          <button
            onClick={onOverride}
            className="px-3 py-1.5 text-2xs font-medium text-white bg-error-600 hover:bg-error-500 rounded-lg transition-colors"
          >
            Load anyway
          </button>
        </div>
      </div>
    </div>
  );
}
