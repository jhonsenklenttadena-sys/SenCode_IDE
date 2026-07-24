/**
 * HistoryPanel — slide-in panel listing past chat sessions.
 * Supports: load, pin/unpin, delete, and shows the user memory profile.
 */

import { useEffect, useState } from 'react';
import { X, Pin, PinOff, Trash2, MessageSquare, FolderOpen, Clock, Brain } from 'lucide-react';
import type { SessionIndex, UserMemory } from '../../lib/types';
import { listSessions, deleteSession, pinSession, getUserMemory } from '../../lib/sessionBridge';

interface HistoryPanelProps {
  open: boolean;
  onClose: () => void;
  onLoadSession: (id: string) => void;
  currentSessionId: string | null;
}

function formatAge(ts: number): string {
  const diff = Date.now() - ts;
  const mins  = Math.floor(diff / 60000);
  const hours = Math.floor(diff / 3600000);
  const days  = Math.floor(diff / 86400000);
  if (mins < 1)   return 'just now';
  if (mins < 60)  return `${mins}m ago`;
  if (hours < 24) return `${hours}h ago`;
  return `${days}d ago`;
}

export function HistoryPanel({ open, onClose, onLoadSession, currentSessionId }: HistoryPanelProps) {
  const [sessions, setSessions]   = useState<SessionIndex[]>([]);
  const [memory, setMemory]       = useState<UserMemory | null>(null);
  const [showMemory, setShowMemory] = useState(false);
  const [loading, setLoading]     = useState(false);

  useEffect(() => {
    if (!open) return;
    setLoading(true);
    Promise.all([listSessions(), getUserMemory()]).then(([s, m]) => {
      setSessions(s);
      setMemory(m);
      setLoading(false);
    });
  }, [open]);

  const handlePin = async (e: React.MouseEvent, id: string, pinned: boolean) => {
    e.stopPropagation();
    await pinSession(id, !pinned);
    setSessions((prev) => prev.map((s) => s.id === id ? { ...s, pinned: !pinned } : s));
  };

  const handleDelete = async (e: React.MouseEvent, id: string) => {
    e.stopPropagation();
    if (!confirm('Delete this session? Its contents will be added to your memory profile before deletion.')) return;
    await deleteSession(id);
    setSessions((prev) => prev.filter((s) => s.id !== id));
  };

  if (!open) return null;

  const pinned   = sessions.filter((s) => s.pinned);
  const unpinned = sessions.filter((s) => !s.pinned);

  return (
    <div className="fixed inset-0 z-50 flex animate-fade-in" onClick={onClose}>
      {/* Backdrop */}
      <div className="absolute inset-0 bg-black/50" />

      {/* Panel */}
      <div
        className="relative ml-auto h-full w-full max-w-sm overflow-y-auto shadow-2xl flex flex-col"
        style={{ background: 'var(--s1)', borderLeft: '1px solid var(--s3)' }}
        onClick={(e) => e.stopPropagation()}
      >
        {/* Header */}
        <div
          className="sticky top-0 z-10 flex items-center justify-between px-4 py-3"
          style={{ background: 'var(--s1)', borderBottom: '1px solid var(--s3)' }}
        >
          <div className="flex items-center gap-2">
            <MessageSquare size={15} style={{ color: 'var(--primary)' }} />
            <span className="text-sm font-semibold" style={{ color: 'var(--ink-high)' }}>
              Chat History
            </span>
            <span
              className="text-[10px] px-1.5 py-0.5 rounded-full font-medium"
              style={{ background: 'var(--primary-dim)', color: 'var(--accent)' }}
            >
              {sessions.length}
            </span>
          </div>
          <div className="flex items-center gap-1">
            <button
              onClick={() => setShowMemory((v) => !v)}
              title="User memory profile"
              className="p-1.5 rounded transition-colors"
              style={{ color: showMemory ? 'var(--accent)' : 'var(--ink-low)' }}
            >
              <Brain size={15} />
            </button>
            <button
              onClick={onClose}
              className="p-1.5 rounded transition-colors"
              style={{ color: 'var(--ink-low)' }}
            >
              <X size={16} />
            </button>
          </div>
        </div>

        {/* Memory profile */}
        {showMemory && memory && (
          <div
            className="mx-3 mt-3 rounded-xl p-3 text-xs"
            style={{ background: 'var(--s2)', border: '1px solid var(--s3)' }}
          >
            <div className="flex items-center gap-2 mb-2 font-semibold" style={{ color: 'var(--ink-high)' }}>
              <Brain size={13} style={{ color: 'var(--primary)' }} />
              What SenCode remembers about you
            </div>
            {memory.notes ? (
              <p className="leading-relaxed" style={{ color: 'var(--ink-mid)' }}>{memory.notes}</p>
            ) : (
              <p className="italic" style={{ color: 'var(--ink-low)' }}>
                No profile built yet — it grows as you use the app and sessions expire.
              </p>
            )}
            {memory.totalSessions > 0 && (
              <div className="mt-2 pt-2 flex gap-4 text-[10px]" style={{ borderTop: '1px solid var(--s3)', color: 'var(--ink-low)' }}>
                <span>{memory.totalSessions} sessions total</span>
                {memory.lastActive && <span>Last active {formatAge(memory.lastActive)}</span>}
              </div>
            )}
          </div>
        )}

        {/* Session list */}
        <div className="flex-1 px-3 py-3 space-y-1">
          {loading && (
            <p className="text-xs text-center py-8" style={{ color: 'var(--ink-low)' }}>Loading…</p>
          )}

          {!loading && sessions.length === 0 && (
            <div className="flex flex-col items-center justify-center py-12 text-center">
              <MessageSquare size={28} style={{ color: 'var(--s3)', marginBottom: 8 }} />
              <p className="text-xs" style={{ color: 'var(--ink-mid)' }}>No saved sessions yet.</p>
              <p className="text-[11px] mt-1" style={{ color: 'var(--ink-low)' }}>
                Sessions are saved automatically after your first message.
              </p>
            </div>
          )}

          {/* Pinned */}
          {pinned.length > 0 && (
            <>
              <div className="text-[10px] font-bold tracking-widest uppercase px-1 pb-1 pt-1"
                style={{ color: 'var(--ink-low)' }}>
                Pinned
              </div>
              {pinned.map((s) => (
                <SessionRow
                  key={s.id} session={s}
                  isCurrent={s.id === currentSessionId}
                  onLoad={() => { onLoadSession(s.id); onClose(); }}
                  onPin={(e) => handlePin(e, s.id, s.pinned)}
                  onDelete={(e) => handleDelete(e, s.id)}
                />
              ))}
              {unpinned.length > 0 && (
                <div className="text-[10px] font-bold tracking-widest uppercase px-1 pb-1 pt-3"
                  style={{ color: 'var(--ink-low)' }}>
                  Recent
                </div>
              )}
            </>
          )}

          {/* Unpinned */}
          {unpinned.map((s) => (
            <SessionRow
              key={s.id} session={s}
              isCurrent={s.id === currentSessionId}
              onLoad={() => { onLoadSession(s.id); onClose(); }}
              onPin={(e) => handlePin(e, s.id, s.pinned)}
              onDelete={(e) => handleDelete(e, s.id)}
            />
          ))}
        </div>
      </div>
    </div>
  );
}

function SessionRow({
  session, isCurrent, onLoad, onPin, onDelete,
}: {
  session: SessionIndex;
  isCurrent: boolean;
  onLoad: () => void;
  onPin: (e: React.MouseEvent) => void;
  onDelete: (e: React.MouseEvent) => void;
}) {
  return (
    <button
      onClick={onLoad}
      className="w-full flex items-start gap-2 px-3 py-2.5 rounded-xl text-left transition-all group"
      style={{
        background: isCurrent ? 'var(--primary-dim)' : 'transparent',
        border: `1px solid ${isCurrent ? 'var(--primary)' : 'transparent'}`,
      }}
      onMouseEnter={(e) => {
        if (!isCurrent) (e.currentTarget as HTMLElement).style.background = 'var(--s2)';
      }}
      onMouseLeave={(e) => {
        if (!isCurrent) (e.currentTarget as HTMLElement).style.background = 'transparent';
      }}
    >
      {/* Icon */}
      <div className="flex-shrink-0 mt-0.5">
        <MessageSquare size={13} style={{ color: isCurrent ? 'var(--accent)' : 'var(--ink-low)' }} />
      </div>

      {/* Content */}
      <div className="flex-1 min-w-0">
        <div className="flex items-center gap-1.5">
          <span
            className="text-xs font-medium truncate"
            style={{ color: isCurrent ? 'var(--ink-high)' : 'var(--ink-high)', maxWidth: '160px' }}
          >
            {session.title}
          </span>
          {session.pinned && <Pin size={10} style={{ color: 'var(--accent)', flexShrink: 0 }} />}
        </div>
        <div className="flex items-center gap-2 mt-0.5">
          {session.projectPath && (
            <span className="flex items-center gap-0.5 text-[10px] truncate max-w-[120px]"
              style={{ color: 'var(--ink-low)' }}>
              <FolderOpen size={9} />
              {session.projectPath.split(/[\\/]/).pop()}
            </span>
          )}
          <span className="flex items-center gap-0.5 text-[10px]" style={{ color: 'var(--ink-low)' }}>
            <Clock size={9} />
            {formatAge(session.updatedAt)}
          </span>
          <span className="text-[10px]" style={{ color: 'var(--ink-low)' }}>
            {session.messageCount} msg{session.messageCount !== 1 ? 's' : ''}
          </span>
        </div>
      </div>

      {/* Actions — shown on hover */}
      <div className="flex items-center gap-0.5 opacity-0 group-hover:opacity-100 transition-opacity flex-shrink-0">
        <button
          onClick={onPin}
          className="p-1 rounded transition-colors"
          title={session.pinned ? 'Unpin (allow auto-delete)' : 'Pin (never auto-delete)'}
          style={{ color: 'var(--ink-low)' }}
          onMouseEnter={(e) => (e.currentTarget as HTMLElement).style.color = 'var(--accent)'}
          onMouseLeave={(e) => (e.currentTarget as HTMLElement).style.color = 'var(--ink-low)'}
        >
          {session.pinned ? <PinOff size={12} /> : <Pin size={12} />}
        </button>
        <button
          onClick={onDelete}
          className="p-1 rounded transition-colors"
          title="Delete session"
          style={{ color: 'var(--ink-low)' }}
          onMouseEnter={(e) => (e.currentTarget as HTMLElement).style.color = 'var(--error)'}
          onMouseLeave={(e) => (e.currentTarget as HTMLElement).style.color = 'var(--ink-low)'}
        >
          <Trash2 size={12} />
        </button>
      </div>
    </button>
  );
}
