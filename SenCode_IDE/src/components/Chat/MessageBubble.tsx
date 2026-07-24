/**
 * MessageBubble — renders a single chat message (user or assistant).
 *
 * Design: Combined Option A + C + B.
 * - write-files blocks are auto-executed when the message finishes streaming.
 */

import { Loader2, AlertTriangle, ChevronRight, Info, ExternalLink, CheckCircle2, FolderOutput, Undo2 } from 'lucide-react';
import { useState, useEffect } from 'react';
import type { ChatMessage } from '../../lib/types';
import { parseBlocks, renderMarkdown } from '../../lib/markdown';
import { CodeBlock } from './CodeBlock';
import { writeFiles, undoWriteFiles, isElectron } from '../../lib/electronBridge';

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
    return <Info size={12} style={{ color: 'var(--followup-text)', opacity: 0.7, flexShrink: 0 }} />;
  if (/^(try|open|check|run|look)/i.test(text))
    return <ExternalLink size={12} style={{ color: 'var(--followup-text)', opacity: 0.7, flexShrink: 0 }} />;
  return <ChevronRight size={12} style={{ color: 'var(--followup-text)', opacity: 0.7, flexShrink: 0 }} />;
}

// ── Write-files block ──────────────────────────────────────────────────────────
function WriteFilesBlock({
  files,
  onFilesWritten,
}: {
  files: { path: string; content: string }[];
  onFilesWritten?: (files: { path: string; content: string }[]) => void;
}) {
  const [status, setStatus] = useState<'idle' | 'writing' | 'done' | 'error' | 'undoing' | 'undone'>('idle');
  const [results, setResults] = useState<{ path: string; ok: boolean; error?: string }[]>([]);

  // Auto-execute on mount
  useEffect(() => {
    if (!isElectron() || files.length === 0) return;
    setStatus('writing');
    writeFiles(files).then((res) => {
      setResults(res);
      const allOk = res.every(r => r.ok);
      setStatus(allOk ? 'done' : 'error');
      if (allOk) onFilesWritten?.(files);
    });
  }, []); // eslint-disable-line react-hooks/exhaustive-deps

  const handleUndo = async () => {
    setStatus('undoing');
    const paths = files.map(f => f.path);
    await undoWriteFiles(paths);
    setStatus('undone');
    // Notify parent that files were undone so it can close those tabs
    onFilesWritten?.([]);
  };

  const isDone   = status === 'done';
  const isUndone = status === 'undone';

  return (
    <div className="rounded-lg my-2 overflow-hidden text-[12px]"
      style={{ border: '1px solid var(--s3)', background: 'var(--s2)' }}>

      {/* Header */}
      <div className="flex items-center gap-2 px-3 py-2"
        style={{ borderBottom: '1px solid var(--s3)', color: 'var(--ink-mid)' }}>
        <FolderOutput size={13} style={{ color: 'var(--accent)', flexShrink: 0 }} />
        <span className="font-medium" style={{ color: 'var(--ink-high)' }}>
          {status === 'writing'  ? 'Writing files…'
          : status === 'done'   ? 'Files saved'
          : status === 'error'  ? 'Some files failed'
          : status === 'undoing'? 'Undoing…'
          : status === 'undone' ? 'Changes undone'
          : 'Files to create'}
        </span>
        {status === 'writing' || status === 'undoing'
          ? <Loader2 size={11} className="animate-spin ml-auto" style={{ color: 'var(--accent)' }} />
          : isDone
          ? <CheckCircle2 size={13} className="ml-auto" style={{ color: 'var(--success)' }} />
          : null}
      </div>

      {/* File list */}
      <div className="px-3 py-2 space-y-1">
        {files.map((f, i) => {
          const result = results.find(r => r.path === f.path);
          return (
            <div key={i} className="flex items-center gap-2">
              <span className="font-mono truncate flex-1"
                style={{ color: result?.ok === false ? 'var(--error)' : result?.ok ? 'var(--success)' : 'var(--ink-mid)' }}>
                {f.path}
              </span>
              {result?.ok && !isUndone && <CheckCircle2 size={11} style={{ color: 'var(--success)', flexShrink: 0 }} />}
              {result?.ok === false && <span style={{ color: 'var(--error)', flexShrink: 0 }}>✗ {result.error}</span>}
            </div>
          );
        })}
      </div>

      {/* Undo button — only shown after successful write */}
      {isDone && (
        <div className="px-3 pb-2">
          <button
            onClick={handleUndo}
            className="flex items-center gap-1.5 text-[11px] px-2.5 py-1 rounded-lg transition-all"
            style={{ border: '1px solid var(--s4)', color: 'var(--ink-low)', background: 'transparent' }}
            onMouseEnter={e => { (e.currentTarget as HTMLElement).style.color = 'var(--warning)'; (e.currentTarget as HTMLElement).style.borderColor = 'var(--warning)'; }}
            onMouseLeave={e => { (e.currentTarget as HTMLElement).style.color = 'var(--ink-low)'; (e.currentTarget as HTMLElement).style.borderColor = 'var(--s4)'; }}
          >
            <Undo2 size={11} /> Undo
          </button>
        </div>
      )}
    </div>
  );
}

// ── Malformed write-files payload — shown instead of silently exposing raw JSON as insertable code ──
function WriteFilesErrorBlock({ error }: { error: string }) {
  return (
    <div className="flex items-start gap-2 text-[12px] rounded-lg px-3 py-2 my-2"
      style={{ color: 'var(--warning)', background: 'color-mix(in srgb, var(--warning) 10%, transparent)', border: '1px solid color-mix(in srgb, var(--warning) 30%, transparent)' }}>
      <AlertTriangle size={13} className="mt-0.5 flex-shrink-0" />
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
      <div className="flex justify-end px-4 py-2 animate-slide-up">
        <div className="max-w-[75%] rounded-xl rounded-tr-sm px-4 py-3"
          style={{ background: 'var(--user-bg)', border: '1px solid var(--user-border)' }}>
          <div className="text-[10px] font-bold tracking-widest uppercase mb-1.5"
            style={{ color: 'var(--user-label)' }}>You</div>
          {/* Attached images */}
          {message.images && message.images.length > 0 && (
            <div className="flex gap-2 flex-wrap mb-2">
              {message.images.map((img, i) => (
                <img key={i} src={img} alt="attached"
                  className="max-h-40 max-w-full rounded-lg object-contain"
                  style={{ border: '1px solid var(--user-border)' }}
                />
              ))}
            </div>
          )}
          <div className="text-[13.5px] leading-relaxed whitespace-pre-wrap"
            style={{ color: 'var(--user-text)' }}>{message.content}</div>
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
  const timeLabel = new Date(message.timestamp).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });

  return (
    <div className="px-4 py-2 animate-slide-up">
      <div className="rounded-xl overflow-hidden"
        style={{ background: 'var(--ai-bg)', border: '1px solid var(--ai-border)' }}>

        {/* Header */}
        <div className="flex items-center gap-2 px-4 py-2"
          style={{ background: 'var(--ai-header-bg)', borderBottom: '1px solid var(--ai-header-border)' }}>
          <div className="w-2 h-2 rounded-full flex-shrink-0"
            style={{
              background: message.streaming ? 'var(--warning)' : 'var(--ai-dot)',
              boxShadow: `0 0 7px ${message.streaming ? 'var(--warning)' : 'var(--ai-dot-glow)'}`,
            }} />
          <span className="text-[10.5px] font-bold tracking-widest uppercase"
            style={{ color: 'var(--ai-name)' }}>SenCode</span>
          {message.streaming && (
            <span className="flex items-center gap-1 text-[10px]" style={{ color: 'var(--warning)' }}>
              <Loader2 size={10} className="animate-spin" /> typing
            </span>
          )}
          <span className="ml-auto text-[10px]" style={{ color: 'var(--ai-time)' }}>{timeLabel}</span>
        </div>

        {/* Body */}
        <div className="px-4 py-3">
          {message.error ? (
            <div className="flex items-start gap-2 text-[13px] rounded-lg px-3 py-2"
              style={{ color: 'var(--error)', background: 'color-mix(in srgb, var(--error) 10%, transparent)', border: '1px solid color-mix(in srgb, var(--error) 30%, transparent)' }}>
              <AlertTriangle size={14} className="mt-0.5 flex-shrink-0" />
              <span>{message.error}</span>
            </div>
          ) : (
            <div className="md-content">
              {bodyBlocks.map((block, i) => {
                if (block.type === 'write-files' && !message.streaming) {
                  return <WriteFilesBlock key={i} files={block.files ?? []} onFilesWritten={onFilesWritten} />;
                }
                if (block.type === 'write-files-error' && !message.streaming) {
                  return <WriteFilesErrorBlock key={i} error={block.error ?? 'The AI attempted a file write that could not be completed.'} />;
                }
                if (block.type === 'code') {
                  return (
                    <CodeBlock key={i}
                      language={block.language ?? 'plaintext'}
                      content={block.content}
                      filename={block.filename}
                      onInsert={onInsertCode}
                      onApplyDiff={onApplyDiff}
                      onAddToProject={onAddToProject}
                      onOpenInProgramming={onOpenInProgramming}
                    />
                  );
                }
                return <div key={i} dangerouslySetInnerHTML={{ __html: renderMarkdown(block.content) }} />;
              })}
              {message.streaming && (
                <span className="inline-block w-2 h-4 align-middle animate-blink ml-0.5"
                  style={{ background: 'var(--accent)' }} />
              )}
            </div>
          )}
        </div>

        {/* Follow-up button */}
        {!message.streaming && !message.error && followUp && (
          <div className="px-4 pb-3">
            <button
              className="inline-flex items-center gap-2 px-3 py-2 rounded-lg text-[12px] transition-all text-left"
              style={{ border: '1px solid var(--followup-border)', color: 'var(--followup-text)', background: 'transparent' }}
              onMouseEnter={(e) => { const el = e.currentTarget; el.style.background = 'var(--followup-hover-bg)'; el.style.borderColor = 'var(--followup-hover-border)'; el.style.color = 'var(--followup-hover-text)'; }}
              onMouseLeave={(e) => { const el = e.currentTarget; el.style.background = 'transparent'; el.style.borderColor = 'var(--followup-border)'; el.style.color = 'var(--followup-text)'; }}
            >
              <FollowUpIcon text={followUp} />
              {followUp}
            </button>
          </div>
        )}
      </div>
    </div>
  );
}
