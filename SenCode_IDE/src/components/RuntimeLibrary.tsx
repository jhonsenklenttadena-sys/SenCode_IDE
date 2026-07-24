/**
 * RuntimeLibrary (Extensions panel)
 *
 * Sidebar list — compact rows, click to open detail panel.
 * Detail panel — opens as a centered overlay showing:
 *   • full description, what's included, file types, dependencies
 *   • Install (if missing) or Uninstall + version (if installed)
 * After install: triggers the reload-splash countdown in App.
 */

import { useEffect, useState, useCallback } from 'react';
import {
  X, Package, CheckCircle2, AlertCircle,
  RefreshCw, Terminal, ExternalLink,
  ChevronRight, Info, FileCode2, Link, Puzzle,
} from 'lucide-react';
import { ProcessingOverlay } from './ProcessingOverlay';

export interface RuntimeInfo {
  id: string;
  name: string;
  category: string;
  icon: string;
  desc: string;
  detail: string;
  langs: string[];
  fileTypes: string[];
  includes: string[];
  dependencies: string[];
  related: string[];
  winget: string;
  homepage: string;
  version: string | null;
  installed: boolean;
}

interface RuntimeLibraryProps {
  open: boolean;
  inline?: boolean;
  onClose: () => void;
  onInstall: (cmd: string, runtimeName: string) => void;
  highlightId?: string | null;
  onInstallComplete?: (runtimeName: string) => void;
  /** Subscribe to terminal process-exit events so we can stop overlay immediately */
  subscribeProcessExit?: (cb: (code: number) => void) => (() => void);
}

export function RuntimeLibrary({
  open, inline, onClose, onInstall, highlightId, onInstallComplete, subscribeProcessExit,
}: RuntimeLibraryProps) {
  const [runtimes, setRuntimes]       = useState<RuntimeInfo[]>([]);
  const [loading, setLoading]         = useState(false);
  const [installing, setInstalling]   = useState<string | null>(null);
  const [uninstalling, setUninstalling] = useState<string | null>(null);
  const [selected, setSelected]       = useState<RuntimeInfo | null>(null);
  const [confirmUninstall, setConfirmUninstall] = useState<RuntimeInfo | null>(null);

  const detect = useCallback(async () => {
    setLoading(true);
    try {
      const bridge = (window as any).electronAPI;
      const result = await bridge?.detectRuntimes?.();
      if (result) {
        setRuntimes(result);
        // Keep selected in sync with fresh data
        if (selected) {
          const fresh = (result as RuntimeInfo[]).find(r => r.id === selected.id);
          if (fresh) setSelected(fresh);
        }
      }
    } finally {
      setLoading(false);
    }
  }, [selected]);

  useEffect(() => {
    if (open && runtimes.length === 0) detect();
  }, [open, runtimes.length, detect]);

  useEffect(() => {
    if (inline && runtimes.length === 0) detect();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [inline]);

  useEffect(() => {
    if (highlightId) {
      setTimeout(() => {
        document.getElementById(`rt-${highlightId}`)?.scrollIntoView({ behavior: 'smooth', block: 'center' });
        const rt = runtimes.find(r => r.id === highlightId);
        if (rt) setSelected(rt);
      }, 200);
    }
  }, [highlightId, open, runtimes]);

  const handleInstall = (rt: RuntimeInfo) => {
    setInstalling(rt.id);
    const cmd = `winget install --id ${rt.winget} -e --accept-package-agreements --accept-source-agreements`;
    onInstall(cmd, rt.name);

    // Subscribe to terminal process exit — stops overlay immediately when winget finishes
    let unsub: (() => void) | undefined;
    let pollInterval: ReturnType<typeof setInterval> | undefined;
    let safetyTimeout: ReturnType<typeof setTimeout> | undefined;

    const finish = async (_exitCode?: number) => {
      unsub?.();
      if (pollInterval) clearInterval(pollInterval);
      if (safetyTimeout) clearTimeout(safetyTimeout);

      const bridge = (window as any).electronAPI;
      const result = await bridge?.detectRuntimes?.();
      setInstalling(null);

      if (result) {
        const updated = (result as RuntimeInfo[]).find(r => r.id === rt.id);
        setRuntimes(result);
        if (updated) setSelected(updated);

        if (updated?.installed) {
          // Success — parent shows restart prompt
          onInstallComplete?.(rt.name);
        }
        // On failure, the terminal already shows winget's error output.
        // The overlay clears immediately so the user can try again or read the logs.
      } else {
        setInstalling(null);
      }
    };

    if (subscribeProcessExit) {
      unsub = subscribeProcessExit((code) => finish(code));
    }

    // Fallback: poll every 10 s in case process-exit event is missed
    let attempts = 0;
    pollInterval = setInterval(async () => {
      attempts++;
      const bridge = (window as any).electronAPI;
      const result = await bridge?.detectRuntimes?.();
      if (result) {
        const updated = (result as RuntimeInfo[]).find(r => r.id === rt.id);
        if (updated?.installed) {
          finish(0);
        } else if (attempts >= 18) {
          unsub?.();
          clearInterval(pollInterval);
          clearTimeout(safetyTimeout);
          setInstalling(null);
          setRuntimes(result);
          if (updated) setSelected(updated);
        }
      }
    }, 10000);

    // Hard safety cap: 3 minutes
    safetyTimeout = setTimeout(() => {
      unsub?.();
      clearInterval(pollInterval);
      setInstalling(prev => prev === rt.id ? null : prev);
    }, 180000);
  };

  const handleUninstall = (rt: RuntimeInfo) => {
    setConfirmUninstall(null);
    setUninstalling(rt.id);
    const cmd = `winget uninstall --id ${rt.winget} -e --accept-source-agreements`;
    onInstall(cmd, `Uninstalling ${rt.name}`);

    let unsub: (() => void) | undefined;
    let pollInterval: ReturnType<typeof setInterval> | undefined;

    const finish = async () => {
      unsub?.();
      if (pollInterval) clearInterval(pollInterval);
      const bridge = (window as any).electronAPI;
      const result = await bridge?.detectRuntimes?.();
      setUninstalling(null);
      if (result) {
        setRuntimes(result);
        const updated = (result as RuntimeInfo[]).find(r => r.id === rt.id);
        if (updated) setSelected(updated);
      }
    };

    if (subscribeProcessExit) {
      unsub = subscribeProcessExit((_code) => finish());
    }

    let attempts = 0;
    pollInterval = setInterval(async () => {
      attempts++;
      const bridge = (window as any).electronAPI;
      const result = await bridge?.detectRuntimes?.();
      if (result) {
        const updated = (result as RuntimeInfo[]).find(r => r.id === rt.id);
        if (!updated?.installed || attempts >= 8) finish();
      } else {
        finish();
      }
    }, 8000);

    setTimeout(() => {
      unsub?.();
      clearInterval(pollInterval);
      setUninstalling(prev => prev === rt.id ? null : prev);
    }, 120000);
  };

  if (!open) return null;

  const installed = runtimes.filter(r => r.installed);
  const missing   = runtimes.filter(r => !r.installed);

  // ── Row component ────────────────────────────────────────────────────────
  const Row = ({ rt }: { rt: RuntimeInfo }) => {
    const isSelected = selected?.id === rt.id;
    const isHighlighted = rt.id === highlightId;
    return (
      <button
        id={`rt-${rt.id}`}
        onClick={() => setSelected(rt)}
        className="w-full flex items-center gap-2 px-2 py-2 rounded-lg text-left transition-all"
        style={{
          background: isSelected
            ? 'color-mix(in srgb, var(--primary) 18%, transparent)'
            : isHighlighted
              ? 'color-mix(in srgb, var(--error) 10%, transparent)'
              : 'transparent',
          border: `1px solid ${isSelected ? 'var(--primary)' : isHighlighted ? 'var(--error)' : 'transparent'}`,
        }}
      >
        {/* Status dot */}
        <div className="flex-shrink-0">
          {rt.installed
            ? <CheckCircle2 size={13} style={{ color: 'var(--success)' }} />
            : <AlertCircle  size={13} style={{ color: isHighlighted ? 'var(--error)' : 'var(--ink-low)' }} />}
        </div>
        {/* Emoji icon */}
        <span style={{ fontSize: 13, lineHeight: 1, flexShrink: 0 }}>{rt.icon}</span>
        {/* Name */}
        <span className="flex-1 text-xs truncate" style={{
          color: isSelected ? 'var(--accent)' : 'var(--ink-high)',
          fontWeight: isSelected ? 600 : 400,
        }}>
          {rt.name}
        </span>
        {/* Version badge */}
        {rt.installed && rt.version && (
          <span className="text-[9px] font-mono px-1 rounded flex-shrink-0"
            style={{ background: 'color-mix(in srgb, var(--success) 12%, transparent)', color: 'var(--success)' }}>
            v{rt.version}
          </span>
        )}
        {installing === rt.id && (
          <span className="w-2 h-2 rounded-full flex-shrink-0 animate-pulse"
            style={{ background: 'var(--accent)' }} />
        )}
        <ChevronRight size={10} style={{ color: 'var(--ink-low)', flexShrink: 0 }} />
      </button>
    );
  };

  // ── Sidebar list ─────────────────────────────────────────────────────────
  const sidebar = (
    <div className="flex flex-col h-full" style={{ background: 'var(--s1)' }}>
      {/* Header */}
      <div className="flex items-center justify-between px-3 py-2 flex-shrink-0"
        style={{ borderBottom: '1px solid var(--s3)' }}>
        <div className="flex items-center gap-2">
          <Package size={13} style={{ color: 'var(--primary)' }} />
          <span className="text-xs font-semibold" style={{ color: 'var(--ink-high)' }}>Extensions</span>
        </div>
        <button onClick={detect} title="Refresh"
          className="p-1 rounded transition-colors"
          style={{ color: loading ? 'var(--accent)' : 'var(--ink-low)' }}>
          <RefreshCw size={12} style={{ animation: loading ? 'spin 1s linear infinite' : 'none' }} />
        </button>
      </div>

      {/* Info strip */}
      <div className="px-3 py-1.5 text-[10px] leading-relaxed flex-shrink-0"
        style={{ color: 'var(--ink-low)', borderBottom: '1px solid var(--s3)', background: 'var(--s2)' }}>
        Click an extension to see details, install, or remove.
      </div>

      <div className="flex-1 overflow-y-auto px-1.5 py-1.5 space-y-0.5">
        {loading && runtimes.length === 0 && (
          <div className="flex items-center justify-center py-8 text-xs"
            style={{ color: 'var(--ink-low)' }}>
            <span className="inline-block w-2 h-2 rounded-full mr-2 animate-pulse"
              style={{ background: 'var(--accent)' }} />
            Detecting…
          </div>
        )}

        {installed.length > 0 && (
          <>
            <div className="text-[9px] font-bold tracking-widest uppercase px-2 pt-2 pb-1"
              style={{ color: 'var(--ink-low)' }}>Installed ({installed.length})</div>
            {installed.map(rt => <Row key={rt.id} rt={rt} />)}
          </>
        )}
        {missing.length > 0 && (
          <>
            <div className="text-[9px] font-bold tracking-widest uppercase px-2 pt-3 pb-1"
              style={{ color: 'var(--ink-low)' }}>Not Installed ({missing.length})</div>
            {missing.map(rt => <Row key={rt.id} rt={rt} />)}
          </>
        )}
      </div>

      <div className="px-3 py-2 text-[10px] flex-shrink-0"
        style={{ borderTop: '1px solid var(--s3)', color: 'var(--ink-low)' }}>
        <Terminal size={10} className="inline mr-1" style={{ color: 'var(--accent)' }} />
        Installs run in the terminal below.
      </div>
    </div>
  );

  if (inline) return (
    <>
      {sidebar}
      {/* Detail panel — rendered as a fixed overlay over the editor area */}
      {selected && (
        <DetailPanel
          rt={selected}
          allRuntimes={runtimes}
          installing={installing === selected.id}
          uninstalling={uninstalling === selected.id}
          onInstall={handleInstall}
          onUninstall={(rt) => setConfirmUninstall(rt)}
          onClose={() => setSelected(null)}
          onSelectRelated={(id) => {
            const r = runtimes.find(x => x.id === id);
            if (r) setSelected(r);
          }}
        />
      )}
      {/* Uninstall confirm */}
      {confirmUninstall && (
        <UninstallConfirm
          rt={confirmUninstall}
          onCancel={() => setConfirmUninstall(null)}
          onConfirm={() => handleUninstall(confirmUninstall)}
        />
      )}
    </>
  );

  // Overlay mode
  return (
    <div className="fixed inset-0 z-50 flex animate-fade-in" onClick={onClose}>
      <div className="absolute inset-0 bg-black/50" />
      <div className="relative ml-auto h-full w-full max-w-sm shadow-2xl flex flex-col overflow-hidden"
        style={{ background: 'var(--s1)', borderLeft: '1px solid var(--s3)' }}
        onClick={e => e.stopPropagation()}>
        {sidebar}
      </div>
      {selected && (
        <DetailPanel
          rt={selected}
          allRuntimes={runtimes}
          installing={installing === selected.id}
          uninstalling={uninstalling === selected.id}
          onInstall={handleInstall}
          onUninstall={(rt) => setConfirmUninstall(rt)}
          onClose={() => setSelected(null)}
          onSelectRelated={(id) => {
            const r = runtimes.find(x => x.id === id);
            if (r) setSelected(r);
          }}
        />
      )}
      {confirmUninstall && (
        <UninstallConfirm
          rt={confirmUninstall}
          onCancel={() => setConfirmUninstall(null)}
          onConfirm={() => handleUninstall(confirmUninstall)}
        />
      )}
    </div>
  );
}

// ── Detail Panel ─────────────────────────────────────────────────────────────

function DetailPanel({
  rt, allRuntimes, installing, uninstalling,
  onInstall, onUninstall, onClose, onSelectRelated,
}: {
  rt: RuntimeInfo;
  allRuntimes: RuntimeInfo[];
  installing: boolean;
  uninstalling: boolean;
  onInstall: (rt: RuntimeInfo) => void;
  onUninstall: (rt: RuntimeInfo) => void;
  onClose: () => void;
  onSelectRelated: (id: string) => void;
}) {
  const deps    = allRuntimes.filter(r => rt.dependencies.includes(r.id));
  const related = allRuntimes.filter(r => rt.related.includes(r.id) && !rt.dependencies.includes(r.id));
  const busy = installing || uninstalling;

  return (
    <div
      className="fixed z-[500] animate-fade-in"
      style={{
        top: '50%', left: '50%',
        transform: 'translate(-50%, -50%)',
        width: 'min(560px, calc(100vw - 320px))',
        maxHeight: 'calc(100vh - 120px)',
        background: 'var(--s1)',
        border: '1px solid var(--s3)',
        borderRadius: 14,
        boxShadow: '0 24px 64px rgba(0,0,0,0.6)',
        display: 'flex',
        flexDirection: 'column',
        overflow: 'hidden',
        position: 'fixed',
      }}
      onClick={e => e.stopPropagation()}
    >
      {/* ── ProcessingOverlay covers the whole panel while busy ── */}
      {busy && (
        <div style={{
          position: 'absolute', inset: 0, zIndex: 10,
          borderRadius: 14, overflow: 'hidden',
        }}>
          <ProcessingOverlay
            visible={true}
            inline={true}
            message={installing ? `Installing ${rt.name}…` : `Uninstalling ${rt.name}…`}
          />
        </div>
      )}
      {/* ── Header ── */}
      <div className="flex items-start justify-between px-5 pt-5 pb-4 flex-shrink-0"
        style={{ borderBottom: '1px solid var(--s3)' }}>
        <div className="flex items-center gap-3">
          <div className="w-10 h-10 rounded-xl flex items-center justify-center text-xl flex-shrink-0"
            style={{ background: 'color-mix(in srgb, var(--primary) 15%, transparent)' }}>
            {rt.icon}
          </div>
          <div>
            <div className="flex items-center gap-2 flex-wrap">
              <h2 className="text-sm font-semibold" style={{ color: 'var(--ink-high)' }}>{rt.name}</h2>
              {rt.installed && rt.version && (
                <span className="text-[10px] px-1.5 py-0.5 rounded font-mono"
                  style={{ background: 'color-mix(in srgb, var(--success) 15%, transparent)', color: 'var(--success)' }}>
                  v{rt.version} — installed
                </span>
              )}
              {!rt.installed && (
                <span className="text-[10px] px-1.5 py-0.5 rounded"
                  style={{ background: 'color-mix(in srgb, var(--ink-low) 10%, transparent)', color: 'var(--ink-low)' }}>
                  not installed
                </span>
              )}
              <span className="text-[10px] px-1.5 py-0.5 rounded"
                style={{ background: 'color-mix(in srgb, var(--accent) 10%, transparent)', color: 'var(--accent)' }}>
                {rt.category}
              </span>
            </div>
            <p className="text-[11px] mt-0.5 leading-relaxed" style={{ color: 'var(--ink-mid)' }}>{rt.desc}</p>
          </div>
        </div>
        <button onClick={onClose} className="p-1 rounded transition-colors flex-shrink-0 ml-2"
          style={{ color: 'var(--ink-low)' }}>
          <X size={15} />
        </button>
      </div>

      {/* ── Scrollable body ── */}
      <div className="flex-1 overflow-y-auto px-5 py-4 space-y-5">

        {/* About */}
        <section>
          <SectionTitle icon={<Info size={12} />} label="About" />
          <p className="text-[12px] leading-relaxed mt-1.5" style={{ color: 'var(--ink-mid)' }}>
            {rt.detail}
          </p>
        </section>

        {/* File types */}
        {rt.fileTypes.length > 0 && (
          <section>
            <SectionTitle icon={<FileCode2 size={12} />} label="Supported file types" />
            <div className="flex flex-wrap gap-1.5 mt-1.5">
              {rt.fileTypes.map(ft => (
                <span key={ft} className="px-2 py-0.5 rounded text-[11px] font-mono"
                  style={{ background: 'var(--s2)', color: 'var(--accent)', border: '1px solid var(--s3)' }}>
                  {ft}
                </span>
              ))}
            </div>
          </section>
        )}

        {/* What's included */}
        {rt.includes.length > 0 && (
          <section>
            <SectionTitle icon={<Package size={12} />} label="What's included in this install" />
            <ul className="mt-1.5 space-y-1">
              {rt.includes.map((item, i) => (
                <li key={i} className="flex items-start gap-2 text-[11px]" style={{ color: 'var(--ink-mid)' }}>
                  <span style={{ color: 'var(--success)', marginTop: 1, flexShrink: 0 }}>✓</span>
                  {item}
                </li>
              ))}
            </ul>
          </section>
        )}

        {/* Dependencies */}
        {deps.length > 0 && (
          <section>
            <SectionTitle icon={<Puzzle size={12} />} label="Dependencies (also required)" />
            <div className="mt-1.5 space-y-1.5">
              {deps.map(dep => (
                <button
                  key={dep.id}
                  onClick={() => onSelectRelated(dep.id)}
                  className="w-full flex items-center gap-2.5 px-3 py-2 rounded-lg text-left transition-all"
                  style={{
                    background: 'var(--s2)',
                    border: `1px solid ${dep.installed ? 'color-mix(in srgb, var(--success) 30%, transparent)' : 'color-mix(in srgb, var(--error) 30%, transparent)'}`,
                  }}
                >
                  <span style={{ fontSize: 14 }}>{dep.icon}</span>
                  <div className="flex-1 min-w-0">
                    <div className="text-[11px] font-medium" style={{ color: 'var(--ink-high)' }}>{dep.name}</div>
                    <div className="text-[10px]" style={{ color: 'var(--ink-low)' }}>{dep.desc}</div>
                  </div>
                  {dep.installed
                    ? <CheckCircle2 size={12} style={{ color: 'var(--success)', flexShrink: 0 }} />
                    : <AlertCircle  size={12} style={{ color: 'var(--error)',   flexShrink: 0 }} />}
                  <ChevronRight size={10} style={{ color: 'var(--ink-low)', flexShrink: 0 }} />
                </button>
              ))}
            </div>
          </section>
        )}

        {/* Related */}
        {related.length > 0 && (
          <section>
            <SectionTitle icon={<Link size={12} />} label="Related extensions" />
            <div className="mt-1.5 flex flex-wrap gap-1.5">
              {related.map(rel => (
                <button
                  key={rel.id}
                  onClick={() => onSelectRelated(rel.id)}
                  className="flex items-center gap-1.5 px-2.5 py-1.5 rounded-lg text-[11px] transition-all"
                  style={{
                    background: 'var(--s2)',
                    border: '1px solid var(--s3)',
                    color: 'var(--ink-mid)',
                  }}
                >
                  <span>{rel.icon}</span>
                  {rel.name}
                  {rel.installed
                    ? <CheckCircle2 size={10} style={{ color: 'var(--success)' }} />
                    : <AlertCircle  size={10} style={{ color: 'var(--ink-low)' }} />}
                </button>
              ))}
            </div>
          </section>
        )}

        {/* Package info */}
        <section>
          <SectionTitle icon={<ExternalLink size={12} />} label="Package info" />
          <div className="mt-1.5 space-y-1 text-[11px]" style={{ color: 'var(--ink-mid)' }}>
            <div className="flex items-center gap-2">
              <span style={{ color: 'var(--ink-low)', minWidth: 80 }}>winget ID</span>
              <span className="font-mono text-[10px] px-1.5 py-0.5 rounded"
                style={{ background: 'var(--s2)', color: 'var(--ink-high)' }}>{rt.winget}</span>
            </div>
            <div className="flex items-center gap-2">
              <span style={{ color: 'var(--ink-low)', minWidth: 80 }}>Homepage</span>
              <span style={{ color: 'var(--accent)' }}>{rt.homepage}</span>
            </div>
          </div>
        </section>
      </div>

      {/* ── Action bar ── */}
      <div className="flex items-center justify-between gap-3 px-5 py-4 flex-shrink-0"
        style={{ borderTop: '1px solid var(--s3)', background: 'var(--s2)' }}>

        {rt.installed ? (
          <>
            <div className="flex items-center gap-1.5 text-[11px]" style={{ color: 'var(--success)' }}>
              <CheckCircle2 size={13} />
              Installed {rt.version ? `— v${rt.version}` : ''}
            </div>
            <button
              onClick={() => onUninstall(rt)}
              disabled={busy}
              className="flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-[11px] font-medium transition-all disabled:opacity-40"
              style={{
                background: 'color-mix(in srgb, var(--error) 12%, transparent)',
                border: '1px solid color-mix(in srgb, var(--error) 35%, transparent)',
                color: 'var(--error)',
              }}
            >
              {uninstalling ? 'Uninstalling…' : 'Uninstall'}
            </button>
          </>
        ) : (
          <>
            <p className="text-[11px]" style={{ color: 'var(--ink-low)' }}>
              App will refresh automatically after install.
            </p>
            <button
              onClick={() => onInstall(rt)}
              disabled={busy}
              className="flex items-center gap-1.5 px-4 py-1.5 rounded-lg text-[11px] font-medium transition-all disabled:opacity-40"
              style={{
                background: 'var(--primary)',
                color: '#fff',
              }}
            >
              {installing ? 'Installing…' : `Install ${rt.name}`}
            </button>
          </>
        )}
      </div>
    </div>
  );
}

// ── Uninstall confirm dialog ──────────────────────────────────────────────────

function UninstallConfirm({
  rt, onCancel, onConfirm,
}: {
  rt: RuntimeInfo;
  onCancel: () => void;
  onConfirm: () => void;
}) {
  return (
    <div className="fixed inset-0 bg-black/60 flex items-center justify-center z-[600] animate-fade-in">
      <div className="bg-surface-1 border border-surface-3 rounded-xl p-5 max-w-sm w-full mx-4 shadow-2xl"
        onClick={e => e.stopPropagation()}>
        <div className="flex items-start gap-3 mb-4">
          <div className="w-9 h-9 rounded-lg flex items-center justify-center flex-shrink-0 text-lg"
            style={{ background: 'color-mix(in srgb, var(--error) 12%, transparent)' }}>
            {rt.icon}
          </div>
          <div>
            <p className="text-sm font-semibold text-ink-high">Uninstall {rt.name}?</p>
            <p className="text-2xs text-ink-mid mt-1">
              This runs <code className="text-accent-400">winget uninstall</code>. Any code that depends on this extension will stop running.
            </p>
          </div>
        </div>
        <div className="flex gap-2 justify-end">
          <button onClick={onCancel}
            className="px-3 py-1.5 text-2xs text-ink-mid hover:text-ink-high rounded-lg transition-colors">
            Cancel
          </button>
          <button onClick={onConfirm}
            className="px-3 py-1.5 text-2xs font-medium text-white rounded-lg transition-colors"
            style={{ background: 'var(--error)' }}>
            Uninstall
          </button>
        </div>
      </div>
    </div>
  );
}

// ── Helper ───────────────────────────────────────────────────────────────────

function SectionTitle({ icon, label }: { icon: React.ReactNode; label: string }) {
  return (
    <div className="flex items-center gap-1.5" style={{ color: 'var(--ink-low)' }}>
      {icon}
      <span className="text-[10px] font-bold tracking-widest uppercase">{label}</span>
    </div>
  );
}
