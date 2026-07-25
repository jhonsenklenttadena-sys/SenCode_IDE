/**
 * LicensePanel — "License & Device" slide-over panel.
 * Opened from the shield icon in TopBar.
 * Shows license status, revalidation schedule, and lets the user
 * deactivate this machine or get transfer instructions.
 */

import { useState, useEffect } from 'react';
import { X, ShieldCheck, ShieldAlert, Shield, LogOut, RefreshCw, Loader2, ArrowRightLeft } from 'lucide-react';

export interface LicenseInfo {
  licenseKey: string;
  status: 'active' | 'invalid';
  revalidateBy: string;       // ISO date string
  daysUntilRevalidate: number;
  isInGrace: boolean;
  graceRemaining: number | null;
  graceDays: number;
  error?: string;
}

interface LicensePanelProps {
  open: boolean;
  onClose: () => void;
}

type DeactivateStep = 'idle' | 'confirm' | 'working' | 'done' | 'error';

function maskKey(key: string): string {
  if (!key || key.length < 8) return key;
  return key.slice(0, 8) + '-••••-••••-' + key.slice(-4);
}

function formatDate(iso: string): string {
  try {
    return new Date(iso).toLocaleDateString(undefined, {
      year: 'numeric', month: 'short', day: 'numeric',
    });
  } catch {
    return iso;
  }
}

export function LicensePanel({ open, onClose }: LicensePanelProps) {
  const [info, setInfo]         = useState<LicenseInfo | null>(null);
  const [loading, setLoading]   = useState(false);
  const [step, setStep]         = useState<DeactivateStep>('idle');
  const [deactivateError, setDeactivateError] = useState<string | null>(null);
  const [showTransfer, setShowTransfer] = useState(false);

  // ── Fetch license info whenever the panel opens ───────────────────────────
  useEffect(() => {
    if (!open) {
      // Reset state when closed so next open starts fresh
      setStep('idle');
      setDeactivateError(null);
      setShowTransfer(false);
      return;
    }
    setLoading(true);
    const api = (window as any).electronAPI;
    if (!api?.getLicenseInfo) {
      setInfo(null);
      setLoading(false);
      return;
    }
    api.getLicenseInfo()
      .then((result: LicenseInfo | null) => setInfo(result))
      .catch(() => setInfo(null))
      .finally(() => setLoading(false));
  }, [open]);

  // ── Deactivate flow ───────────────────────────────────────────────────────
  const handleDeactivate = async () => {
    setStep('working');
    setDeactivateError(null);
    try {
      const api = (window as any).electronAPI;
      const result = await api.deactivateDevice();
      if (result?.ok) {
        setStep('done');
      } else {
        throw new Error(result?.error || 'Deactivation failed.');
      }
    } catch (err: any) {
      setDeactivateError(err.message || 'An unexpected error occurred.');
      setStep('error');
    }
  };

  if (!open) return null;

  // ── Render ────────────────────────────────────────────────────────────────
  const graceWarning = info && info.isInGrace && info.graceRemaining !== null;
  const approachingRevalidate = info && !info.isInGrace && info.daysUntilRevalidate <= 5 && info.daysUntilRevalidate >= 0;

  return (
    <div className="fixed inset-0 z-50 flex justify-end animate-fade-in">
      <div className="absolute inset-0 bg-black/50" onClick={onClose} />
      <div className="relative w-full max-w-md bg-surface-1 border-l border-surface-3 h-full overflow-y-auto shadow-2xl">

        {/* Header */}
        <div className="sticky top-0 bg-surface-1 border-b border-surface-3 px-4 py-3 flex items-center justify-between z-10">
          <div className="flex items-center gap-2">
            <Shield size={16} className="text-ink-mid" />
            <h2 className="text-sm font-semibold text-ink-high">License &amp; Device</h2>
          </div>
          <button
            onClick={onClose}
            className="p-1.5 text-ink-low hover:text-ink-high hover:bg-surface-3 rounded transition-colors"
          >
            <X size={16} />
          </button>
        </div>

        <div className="p-4 space-y-5">

          {/* Loading */}
          {loading && (
            <div className="flex items-center justify-center py-12">
              <Loader2 size={20} className="animate-spin text-ink-low" />
            </div>
          )}

          {/* No license / not in Electron */}
          {!loading && !info && (
            <div className="flex flex-col items-center justify-center py-12 text-center gap-3">
              <ShieldAlert size={32} className="text-warning-400" />
              <p className="text-sm text-ink-mid">No active license found on this device.</p>
              <p className="text-2xs text-ink-low">Restart SenCode to activate your license.</p>
            </div>
          )}

          {/* Invalid / error license */}
          {!loading && info && info.status === 'invalid' && (
            <div className="rounded-lg bg-error-600/10 border border-error-600/30 px-4 py-3">
              <p className="text-xs font-medium text-error-400">License is invalid</p>
              {info.error && <p className="text-2xs text-error-300 mt-1">{info.error}</p>}
            </div>
          )}

          {/* Active license */}
          {!loading && info && info.status === 'active' && (
            <>
              {/* Status card */}
              <div className="rounded-lg bg-surface-2 border border-surface-3 p-4 space-y-3">
                <div className="flex items-center gap-2">
                  <ShieldCheck size={15} className="text-success-500 flex-shrink-0" />
                  <span className="text-xs font-semibold text-success-400">Active</span>
                </div>

                <div className="space-y-1.5">
                  <Row label="License key">
                    <code className="text-xs font-mono text-ink-high tracking-wider">
                      {maskKey(info.licenseKey)}
                    </code>
                  </Row>
                  <Row label="Next online check">
                    <span className="text-xs text-ink-high">{formatDate(info.revalidateBy)}</span>
                    {!info.isInGrace && (
                      <span className={`ml-2 text-2xs ${
                        info.daysUntilRevalidate <= 3
                          ? 'text-warning-400'
                          : 'text-ink-low'
                      }`}>
                        ({info.daysUntilRevalidate > 0
                          ? `in ${info.daysUntilRevalidate}d`
                          : 'due today'})
                      </span>
                    )}
                  </Row>
                  <Row label="Offline grace">
                    <span className="text-xs text-ink-mid">{info.graceDays} days after check date</span>
                  </Row>
                </div>
              </div>

              {/* Grace period warning */}
              {graceWarning && (
                <div className="rounded-lg bg-warning-500/10 border border-warning-500/30 px-4 py-3 flex gap-3">
                  <ShieldAlert size={15} className="text-warning-400 flex-shrink-0 mt-0.5" />
                  <div className="space-y-1">
                    <p className="text-xs font-medium text-warning-300">
                      Offline grace period — {info.graceRemaining}d left
                    </p>
                    <p className="text-2xs text-warning-400/80">
                      SenCode couldn't reach the license server on the scheduled date.
                      Please connect to the internet within {info.graceRemaining} day{info.graceRemaining !== 1 ? 's' : ''} to keep using the app.
                    </p>
                  </div>
                </div>
              )}

              {/* Approaching revalidation soft nudge */}
              {approachingRevalidate && !graceWarning && (
                <div className="rounded-lg bg-primary-600/10 border border-primary-500/20 px-4 py-3 flex gap-3">
                  <RefreshCw size={14} className="text-primary-400 flex-shrink-0 mt-0.5" />
                  <p className="text-2xs text-primary-300">
                    An online check is due in {info.daysUntilRevalidate} day{info.daysUntilRevalidate !== 1 ? 's' : ''}.
                    Make sure SenCode can reach the internet around that date.
                  </p>
                </div>
              )}

              {/* Deactivate section */}
              <Section
                icon={LogOut}
                title="Deactivate this device"
                description="Removes SenCode's license binding from this machine. After deactivating, the app will stop working here and the key can be activated on a different device."
              >
                {step === 'idle' && (
                  <button
                    onClick={() => setStep('confirm')}
                    className="mt-3 w-full px-4 py-2.5 text-xs font-medium text-error-400 bg-error-600/10 hover:bg-error-600/20 border border-error-600/30 hover:border-error-500/50 rounded-lg transition-colors"
                  >
                    Deactivate this device
                  </button>
                )}

                {step === 'confirm' && (
                  <div className="mt-3 rounded-lg bg-error-600/10 border border-error-600/30 p-4 space-y-3">
                    <p className="text-xs text-error-300 font-medium">
                      Are you sure? This will immediately lock SenCode on this machine.
                    </p>
                    <p className="text-2xs text-error-400/80">
                      Save any open work before continuing. The app will close after deactivation.
                    </p>
                    <div className="flex gap-2 pt-1">
                      <button
                        onClick={() => setStep('idle')}
                        className="flex-1 px-3 py-2 text-xs text-ink-mid hover:text-ink-high bg-surface-3 hover:bg-surface-4 rounded-lg transition-colors"
                      >
                        Cancel
                      </button>
                      <button
                        onClick={handleDeactivate}
                        className="flex-1 px-3 py-2 text-xs font-medium text-white bg-error-600 hover:bg-error-500 rounded-lg transition-colors"
                      >
                        Yes, deactivate
                      </button>
                    </div>
                  </div>
                )}

                {step === 'working' && (
                  <div className="mt-3 flex items-center gap-2 px-4 py-3 bg-surface-2 border border-surface-3 rounded-lg">
                    <Loader2 size={14} className="animate-spin text-ink-low" />
                    <span className="text-xs text-ink-mid">Contacting license server…</span>
                  </div>
                )}

                {step === 'done' && (
                  <div className="mt-3 rounded-lg bg-success-600/10 border border-success-600/30 px-4 py-3 space-y-2">
                    <p className="text-xs font-medium text-success-400">
                      Device deactivated successfully.
                    </p>
                    <p className="text-2xs text-success-500/80">
                      Your license key is now free to use on another machine. SenCode will close now.
                    </p>
                    <button
                      onClick={() => (window as any).electronAPI?.quitApp?.()}
                      className="mt-2 w-full px-3 py-2 text-xs font-medium text-white bg-success-600 hover:bg-success-500 rounded-lg transition-colors"
                    >
                      Close SenCode
                    </button>
                  </div>
                )}

                {step === 'error' && (
                  <div className="mt-3 rounded-lg bg-error-600/10 border border-error-600/30 px-4 py-3 space-y-2">
                    <p className="text-xs font-medium text-error-400">Deactivation failed</p>
                    <p className="text-2xs text-error-300/80">{deactivateError}</p>
                    <div className="flex gap-2 pt-1">
                      <button
                        onClick={() => setStep('idle')}
                        className="flex-1 px-3 py-2 text-xs text-ink-mid hover:text-ink-high bg-surface-3 rounded-lg transition-colors"
                      >
                        Cancel
                      </button>
                      <button
                        onClick={handleDeactivate}
                        className="flex-1 px-3 py-2 text-xs font-medium text-white bg-error-600 hover:bg-error-500 rounded-lg transition-colors"
                      >
                        Retry
                      </button>
                    </div>
                  </div>
                )}
              </Section>

              {/* Transfer section */}
              <Section
                icon={ArrowRightLeft}
                title="Moving to a new machine?"
                description="Your license is tied to this device's hardware. To use it on a new machine, deactivate here first, then activate on the new machine."
              >
                <button
                  onClick={() => setShowTransfer((v) => !v)}
                  className="mt-3 w-full flex items-center justify-between px-4 py-2.5 text-xs text-ink-mid hover:text-ink-high bg-surface-2 hover:bg-surface-3 border border-surface-3 rounded-lg transition-colors"
                >
                  <span>How to transfer</span>
                  <span className="text-ink-low">{showTransfer ? '▲' : '▼'}</span>
                </button>

                {showTransfer && (
                  <ol className="mt-3 space-y-2.5 pl-1">
                    {[
                      'Save your work and click "Deactivate this device" above.',
                      'Install SenCode on your new machine.',
                      'Launch SenCode — the activation screen will appear.',
                      'Enter your license key. It will bind to the new machine.',
                    ].map((step, i) => (
                      <li key={i} className="flex gap-3">
                        <span className="flex-shrink-0 w-5 h-5 rounded-full bg-primary-600/20 border border-primary-500/30 text-primary-400 text-2xs font-semibold flex items-center justify-center">
                          {i + 1}
                        </span>
                        <span className="text-2xs text-ink-mid leading-relaxed pt-0.5">{step}</span>
                      </li>
                    ))}
                    <li className="flex gap-3 pt-1">
                      <span className="flex-shrink-0 w-5 h-5 rounded-full bg-surface-3 text-ink-low text-2xs flex items-center justify-center">i</span>
                      <span className="text-2xs text-ink-low leading-relaxed pt-0.5">
                        Re-transfers have a 7-day cooldown after each move.
                        If you lose access to the old machine, contact support with your key.
                      </span>
                    </li>
                  </ol>
                )}
              </Section>
            </>
          )}
        </div>
      </div>
    </div>
  );
}

// ── Sub-components ────────────────────────────────────────────────────────────

function Row({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="flex items-baseline gap-2">
      <span className="text-2xs text-ink-low w-28 flex-shrink-0">{label}</span>
      <span className="flex items-center gap-1 flex-wrap">{children}</span>
    </div>
  );
}

function Section({
  icon: Icon,
  title,
  description,
  children,
}: {
  icon: any;
  title: string;
  description: string;
  children: React.ReactNode;
}) {
  return (
    <div className="rounded-lg bg-surface-2 border border-surface-3 p-4">
      <div className="flex items-center gap-2 mb-1">
        <Icon size={13} className="text-ink-low flex-shrink-0" />
        <h3 className="text-xs font-semibold text-ink-high">{title}</h3>
      </div>
      <p className="text-2xs text-ink-low leading-relaxed mb-1 pl-5">{description}</p>
      {children}
    </div>
  );
}
