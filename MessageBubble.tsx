/**
 * MessageBubble — renders a single chat message (user or assistant).
 *
 * Design: Combined Option A + C + B.
 * - write-files blocks use a sequential permission pipeline:
 *   1. Ask folder creation permission → halt until confirmed → create folders
 *   2. Ask file creation permission  → halt until confirmed → write files
 */

import { Loader2, AlertTriangle, ChevronRight, Info, ExternalLink, CheckCircle2, FolderOutput, Undo2 } from 'lucide-react';
import { useState, useEffect, useMemo } from 'react';
import type { ChatMessage } from '../../lib/types';
import { parseBlocks, renderMarkdown } from '../../lib/markdown';
import { CodeBlock } from './CodeBlock';
import { writeFiles, undoWriteFiles, isElectron, createDirs } from '../../lib/electronBridge';

interface MessageBubbleProps {
  message: ChatMessage;
  onInsertCode?: (content: string, language: string) => void;
  onApplyDiff?: (content: string, language: string) => void;
  onAddToProject?: (content: string, language: string) => void;
  onOpenInProgramming?: (content: string, language: string, filename?: string) => void;
  /** Called after AI writes files — so App can open them in tabs and refresh tree */
  onFilesWritten?: (files: { path: string; content: string }[]) => void;
}

// ── Follow-up extraction ───────────────────────────────────────────────────────
function extractFollowUp(content: string): { body: string; followUp: string | null } {
  if (!content.trim()) return { body: content, followUp: null };
  const paras = content.trimEnd().split(/\n{2,}/);
  if (paras.length < 2) {
    const sentences = paras[0].split(/(?<=[.!?])\s+/);
    if (sentences.length >= 2) {
      const last = sentences[sentences.length - 1].trim();
      if (last.endsWith('?') || /^(want|would you|shall|try|let me know|feel free|need|should|do you|can you|check)/i.test(last)) {
        return { body: sentences.slice(0, -1).join(' '), followUp: last };
      }
    }
    return { body: content, followUp: null };
  }
  const lastPara = paras[paras.length - 1].trim();
  if (lastPara.length <= 120) {
    return { body: paras.slice(0, -1).join('\n\n'), followUp: lastPara };
  }
  return { body: content, followUp: null };
}

function FollowUpIcon({ text }: { text: string }) {
  if (text.endsWith('?') || /^(want|would|do you|can i)/i.test(text))
    return <Info size={12} />;
  if (/^(try|open|check|run|look)/i.test(text))
    return <ExternalLink size={12} />;
  return <ChevronRight size={12} />;
}

// ── Write-files block ──────────────────────────────────────────────────────────
type WriteStatus =
  | 'awaiting-folder-permission'
  | 'creating-folders'
  | 'awaiting-file-permission'
  | 'writing-files'
  | 'done'
  | 'error'
  | 'undoing'
  | 'undone'
  | 'denied';

function WriteFilesBlock({
  files,
  onFilesWritten,
}: {
  files: { path: string; content: string }[];
  onFilesWritten?: (files: { path: string; content: string }[]) => void;
}) {
  const [status, setStatus] = useState<WriteStatus>('awaiting-folder-permission');
  const [results, setResults] = useState<{ path: string; ok: boolean; error?: string }[]>([]);

  // Derive unique parent directories from all file paths
  const uniqueDirs = useMemo(() => {
    const dirs = new Set<string>();
    for (const f of files) {
      const normalized = f.path.replace(/\\/g, '/');
      const lastSlash = normalized.lastIndexOf('/');
      if (lastSlash > 0) dirs.add(normalized.slice(0, lastSlash));
    }
    return Array.from(dirs);
  }, [files]);

  // On mount — if no subdirectories are needed, skip straight to file permission step
  useEffect(() => {
    if (!isElectron() || files.length === 0) return;
    if (uniqueDirs.length === 0) {
      setStatus('awaiting-file-permission');
    }
    // Otherwise stay at 'awaiting-folder-permission' — user must approve first
  }, []); // eslint-disable-line react-hooks/exhaustive-deps

  // ── Step 1: User approves folder creation ─────────────────────────────────
  const handleFolderApprove = async () => {
    setStatus('creating-folders');
    await createDirs(uniqueDirs);           // execute folder creation
    setStatus('awaiting-file-permission'); // halt — wait for next approval
  };

  // ── Step 2: User approves file writing ────────────────────────────────────
  const handleFileApprove = async () => {
    setStatus('writing-files');
    const res = await writeFiles(files);   // execute file creation
    setResults(res);
    const allOk = res.every(r => r.ok);
    setStatus(allOk ? 'done' : 'error');
    if (allOk) onFilesWritten?.(files);
  };

  const handleDeny = () => setStatus('denied');

  const handleUndo = async () => {
    setStatus('undoing');
    const paths = files.map(f => f.path);
    await undoWriteFiles(paths);
    setStatus('undone');
    onFilesWritten?.([]);
  };

  if (!isElectron()) return null;

  return (
    <div
      className="rounded-lg border overflow-hidden mt-2"
      style={{ borderColor: 'var(--s4)', background: 'var(--s2)' }}
    >
      {/* Header */}
      <div
        className="flex items-center gap-2 px-3 py-2"
        style={{ borderBottom: '1px solid var(--s4)' }}
      >
        <FolderOutput size={14} style={{ color: 'var(--accent)' }} />
        <span className="text-xs font-medium flex-1" style={{ color: 'var(--ink-high)' }}>
          {status === 'awaiting-folder-permission' && 'Permission required: folder creation'}
          {status === 'creating-folders'           && 'Creating folders…'}
          {status === 'awaiting-file-permission'   && 'Permission required: file creation'}
          {status === 'writing-files'              && 'Writing files…'}
          {status === 'done'                       && 'Files saved'}
          {status === 'error'                      && 'Some files failed'}
          {status === 'undoing'                    && 'Undoing…'}
          {status === 'undone'                     && 'Changes undone'}
          {status === 'denied'                     && 'Cancelled'}
        </span>
        {(status === 'creating-folders' || status === 'writing-files' || status === 'undoing') && (
          <Loader2 size={12} className="animate-spin" style={{ color: 'var(--ink-low)' }} />
        )}
        {status === 'done' && <CheckCircle2 size={12} style={{ color: 'var(--success)' }} />}
      </div>

      {/* STEP 1 — Folder permission prompt */}
      {status === 'awaiting-folder-permission' && (
        <div className="px-3 py-2 text-xs" style={{ color: 'var(--ink-low)' }}>
          <p className="mb-2">Allow the AI to create the following folder(s)?</p>
          <ul className="mb-3 space-y-1">
            {uniqueDirs.map(d => (
              <li key={d} className="font-mono" style={{ color: 'var(--ink-high)' }}>
                {d}
              </li>
            ))}
          </ul>
          <div className="flex gap-2">
            <button
              onClick={handleFolderApprove}
              className="px-3 py-1 rounded text-xs font-medium"
              style={{ background: 'var(--accent)', color: '#fff' }}
            >
              Approve
            </button>
            <button
              onClick={handleDeny}
              className="px-3 py-1 rounded text-xs font-medium"
              style={{ background: 'var(--s4)', color: 'var(--ink-low)' }}
            >
              Deny
            </button>
          </div>
        </div>
      )}

      {/* STEP 2 — File permission prompt */}
      {status === 'awaiting-file-permission' && (
        <div className="px-3 py-2 text-xs" style={{ color: 'var(--ink-low)' }}>
          <p className="mb-2">Allow the AI to create/write the following file(s)?</p>
          <ul className="mb-3 space-y-1">
            {files.map(f => (
              <li key={f.path} className="font-mono" style={{ color: 'var(--ink-high)' }}>
                {f.path}
              </li>
            ))}
          </ul>
          <div className="flex gap-2">
            <button
              onClick={handleFileApprove}
              className="px-3 py-1 rounded text-xs font-medium"
              style={{ background: 'var(--accent)', color: '#fff' }}
            >
              Approve
            </button>
            <button
              onClick={handleDeny}
              className="px-3 py-1 rounded text-xs font-medium"
              style={{ background: 'var(--s4)', color: 'var(--ink-low)' }}
            >
              Deny
            </button>
          </div>
        </div>
      )}

      {/* File list — shown after writing completes */}
      {(status === 'done' || status === 'error' || status === 'undone') && (
        <div className="divide-y" style={{ borderColor: 'var(--s4)' }}>
          {files.map((f) => {
            const result = results.find(r => r.path === f.path);
            return (
              <div key={f.path} className="flex items-center gap-2 px-3 py-1.5 text-xs">
                <ChevronRight size={10} style={{ color: 'var(--ink-low)' }} />
                <span
                  className="flex-1 font-mono truncate"
                  style={{ color: 'var(--ink-high)' }}
                >
                  {f.path}
                </span>
                {result?.ok && status !== 'undone' && (
                  <CheckCircle2 size={12} style={{ color: 'var(--success)' }} />
                )}
                {result?.ok === false && (
                  <span style={{ color: 'var(--error)' }}>✗ {result.error}</span>
                )}
              </div>
            );
          })}
        </div>
      )}

      {/* Undo button — only shown after successful write */}
      {status === 'done' && (
        <div className="px-3 py-2" style={{ borderTop: '1px solid var(--s4)' }}>
          <button
            onClick={handleUndo}
            className="flex items-center gap-1.5 text-xs border rounded px-2 py-1"
            style={{ color: 'var(--ink-low)', borderColor: 'var(--s4)' }}
            onMouseEnter={e => {
              (e.currentTarget as HTMLElement).style.color = 'var(--warning)';
              (e.currentTarget as HTMLElement).style.borderColor = 'var(--warning)';
            }}
            onMouseLeave={e => {
              (e.currentTarget as HTMLElement).style.color = 'var(--ink-low)';
              (e.currentTarget as HTMLElement).style.borderColor = 'var(--s4)';
            }}
          >
            <Undo2 size={12} />
            Undo
          </button>
        </div>
      )}
    </div>
  );
}

// ── Malformed write-files payload ──────────────────────────────────────────────
function WriteFilesErrorBlock({ error }: { error: string }) {
  return (
    <div
      className="rounded-lg border px-3 py-2 mt-2 flex items-start gap-2 text-xs"
      style={{ borderColor: 'var(--error)', background: 'var(--s2)', color: 'var(--error)' }}
    >
      <AlertTriangle size={13} className="mt-0.5 shrink-0" />
      <span>{error}</span>
    </div>
  );
}

// ── Main component ─────────────────────────────────────────────────────────────
export function MessageBubble({
  message,
  onInsertCode,
  onApplyDiff,
  onAddToProject,
  onOpenInProgramming,
  onFilesWritten,
}: MessageBubbleProps) {
  const isUser = message.role === 'user';

  if (isUser) {
    return (
      <div className="flex justify-end mb-3">
        <div
          className="rounded-2xl rounded-tr-sm px-4 py-2.5 max-w-[80%]"
          style={{ background: 'var(--user-bubble)', color: 'var(--user-bubble-text)' }}
        >
          <div className="text-xs font-semibold mb-1 opacity-60">You</div>
          {/* Attached images */}
          {message.images && message.images.length > 0 && (
            <div className="flex flex-wrap gap-2 mb-2">
              {message.images.map((img, i) => (
                <img
                  key={i}
                  src={img}
                  alt="pasted"
                  className="max-h-48 rounded-lg object-contain border"
                  style={{ borderColor: 'var(--s4)' }}
                />
              ))}
            </div>
          )}
          <div className="text-sm whitespace-pre-wrap break-words">{message.content}</div>
        </div>
      </div>
    );
  }

  // ── Assistant ──────────────────────────────────────────────────────────────
  const fullText = message.content;
  const { body, followUp } = message.streaming
    ? { body: fullText, followUp: null }
    : extractFollowUp(fullText);

  const bodyBlocks = parseBlocks(message.streaming ? fullText : body);
  const timeLabel = new Date(message.timestamp).toLocaleTimeString([], {
    hour: '2-digit',
    minute: '2-digit',
  });

  return (
    <div className="mb-4">
      <div
        className="rounded-2xl rounded-tl-sm px-4 py-3 max-w-[92%]"
        style={{ background: 'var(--assistant-bubble)', color: 'var(--ink-high)' }}
      >
        {/* Header */}
        <div className="flex items-center gap-2 mb-2">
          <span className="text-xs font-semibold" style={{ color: 'var(--accent)' }}>
            SenCode
          </span>
          {message.streaming && (
            <span
              className="text-xs flex items-center gap-1"
              style={{ color: 'var(--ink-low)' }}
            >
              <Loader2 size={10} className="animate-spin" />
              typing
            </span>
          )}
          <span className="text-xs ml-auto" style={{ color: 'var(--ink-low)' }}>
            {timeLabel}
          </span>
        </div>

        {/* Body */}
        <div className="text-sm">
          {message.error ? (
            <div
              className="flex items-start gap-2 text-xs"
              style={{ color: 'var(--error)' }}
            >
              <AlertTriangle size={13} className="mt-0.5 shrink-0" />
              <span>{message.error}</span>
            </div>
          ) : (
            <div>
              {bodyBlocks.map((block, i) => {
                if (block.type === 'write-files' && !message.streaming) {
                  return (
                    <WriteFilesBlock
                      key={i}
                      files={block.files!}
                      onFilesWritten={onFilesWritten}
                    />
                  );
                }
                if (block.type === 'write-files-error' && !message.streaming) {
                  return <WriteFilesErrorBlock key={i} error={block.error!} />;
                }
                if (block.type === 'code') {
                  return (
                    <CodeBlock
                      key={i}
                      language={block.language ?? 'plaintext'}
                      filename={block.filename}
                      content={block.content}
                      onInsertCode={onInsertCode}
                      onApplyDiff={onApplyDiff}
                      onAddToProject={onAddToProject}
                      onOpenInProgramming={onOpenInProgramming}
                    />
                  );
                }
                return (
                  <div
                    key={i}
                    className="prose prose-invert prose-sm max-w-none"
                    dangerouslySetInnerHTML={{ __html: renderMarkdown(block.content) }}
                  />
                );
              })}
              {message.streaming && (
                <span
                  className="inline-block w-1.5 h-3.5 ml-0.5 align-middle animate-pulse rounded-sm"
                  style={{ background: 'var(--accent)' }}
                />
              )}
            </div>
          )}
        </div>
      </div>

      {/* Follow-up button */}
      {!message.streaming && !message.error && followUp && (
        <div className="mt-1.5 ml-1">
          <button
            className="flex items-center gap-1.5 text-xs px-3 py-1.5 rounded-full border transition-colors"
            style={{
              background: 'transparent',
              borderColor: 'var(--followup-border)',
              color: 'var(--followup-text)',
            }}
            onMouseEnter={(e) => {
              const el = e.currentTarget;
              el.style.background = 'var(--followup-hover-bg)';
              el.style.borderColor = 'var(--followup-hover-border)';
              el.style.color = 'var(--followup-hover-text)';
            }}
            onMouseLeave={(e) => {
              const el = e.currentTarget;
              el.style.background = 'transparent';
              el.style.borderColor = 'var(--followup-border)';
              el.style.color = 'var(--followup-text)';
            }}
          >
            <FollowUpIcon text={followUp} />
            {followUp}
          </button>
        </div>
      )}
    </div>
  );
}