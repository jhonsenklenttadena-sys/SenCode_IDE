/**
 * MessageBubble — renders a single chat message (user or assistant).
 *
 * Design: Combined Option A + C + B.
 * - write-files blocks are auto-executed when the message finishes streaming.
 */

import { Loader2, AlertTriangle, ChevronRight, Info, ExternalLink, CheckCircle2, FolderOutput, Undo2 } from 'lucide-react';
import { useState, useEffect } from 'react';
import type { ChatMessage, FileNode } from '../../lib/types';
import { parseBlocks, renderMarkdown } from '../../lib/markdown';
import { CodeBlock } from './CodeBlock';
import { writeFiles, undoWriteFiles, isElectron } from '../../lib/electronBridge';

interface MessageBubbleProps {
  message: ChatMessage;
  onInsertCode?: (content: string, language: string) => void;
  onApplyDiff?: (content: string, language: string) => void;
  onAddToProject?: (content: string, language: string) => void;
  onOpenInProgramming?: (content: string, language: string, filename?: string) => void;
  onFilesWritten?: (files: { path: string; content: string }[]) => void;
  fileTree?: FileNode[];
  lastUserPrompt?: string;
  onRequestPermission?: (
    action: 'EDIT' | 'CREATE',
    files: { path: string; content: string }[],
    onProceed: () => void,
    onDeny: () => void,
  ) => void;
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

// ── Permission helpers ─────────────────────────────────────────────────────────
function fileExistsInTree(path: string, nodes: FileNode[]): boolean {
  for (const n of nodes) {
    if (n.type === 'file' && n.path === path) return true;
    if (n.children && fileExistsInTree(path, n.children)) return true;
  }
  return false;
}

function needsPermissionForEdit(filePaths: string[], prompt: string): boolean {
  const p = prompt.toLowerCase();
  const hasEditIntent = /\b(change|fix|update|edit|modify|refactor|replace|rewrite|correct|adjust|tweak)\b/.test(p);
  const allMentioned = filePaths.every(fp => {
    const name = (fp.split(/[\\/]/).pop() ?? fp).toLowerCase();
    return p.includes(name);
  });
  if (filePaths.length > 2) return true; // multi-file = big refactor, always ask
  return !(hasEditIntent && allMentioned);
}

function needsPermissionForCreate(filePaths: string[], prompt: string): boolean {
  const p = prompt.toLowerCase();
  const hasCreateIntent = /\b(create|make|add|new|generate|write|build)\b/.test(p);
  const allMentioned = filePaths.every(fp => {
    const name = (fp.split(/[\\/]/).pop() ?? fp).toLowerCase();
    return p.includes(name);
  });
  if (filePaths.length > 1) return true; // multiple new files = ask
  return !(hasCreateIntent && allMentioned);
}

function WriteFilesBlock({
  files,
  onFilesWritten,
  fileTree,
  lastUserPrompt,
  onRequestPermission,
}: {
  files: { path: string; content: string }[];
  onFilesWritten?: (files: { path: string; content: string }[]) => void;
  fileTree?: FileNode[];
  lastUserPrompt?: string;
  onRequestPermission?: (
    action: 'EDIT' | 'CREATE',
    files: { path: string; content: string }[],
    onProceed: () => void,
    onDeny: () => void,
  ) => void;
}) {
  const [status, setStatus] = useState<'idle' | 'writing' | 'done' | 'error' | 'undoing' | 'undone' | 'denied'>('idle');
  const [results, setResults] = useState<{ path: string; ok: boolean; error?: string }[]>([]);

  useEffect(() => {
    if (!isElectron() || files.length === 0) return;

    const doWrite = () => {
      setStatus('writing');
      writeFiles(files).then((res) => {
        setResults(res);
        const allOk = res.every(r => r.ok);
        setStatus(allOk ? 'done' : 'error');
        if (allOk) onFilesWritten?.(files);
      });
    };

    const tree = fileTree ?? [];
    const prompt = lastUserPrompt ?? '';
    const editFiles = files.filter(f => fileExistsInTree(f.path, tree));
    const createFiles = files.filter(f => !fileExistsInTree(f.path, tree));

    const editNeeds = editFiles.length > 0 && needsPermissionForEdit(editFiles.map(f => f.path), prompt);
    const createNeeds = createFiles.length > 0 && needsPermissionForCreate(createFiles.map(f => f.path), prompt);

    if ((editNeeds || createNeeds) && onRequestPermission) {
      const action = editNeeds ? 'EDIT' : 'CREATE';
      onRequestPermission(action, files, doWrite, () => setStatus('denied'));
    } else {
      doWrite();
    }
  }, []); // eslint-disable-line react-hooks/exhaustive-deps

  const handleUndo = async () => {
    setStatus('undoing');
    const paths = files.map(f => f.path);
    await undoWriteFiles(paths);
    setStatus('undone');
    onFilesWritten?.([]);
  };

  const isDone = status === 'done';
  const isUndone = status === 'undone';

  return (
    <div style={{ border: '1px solid var(--s4)', borderRadius: '8px', overflow: 'hidden', marginBottom: '8px' }}>
      {/* Header */}
      <div style={{ display: 'flex', alignItems: 'center', gap: '6px', padding: '8px 12px', background: 'var(--surface-2)', borderBottom: '1px solid var(--s4)' }}>
        <FolderOutput size={14} style={{ color: 'var(--primary-400)', flexShrink: 0 }} />
        <span style={{ fontSize: '12px', fontWeight: 500, color: 'var(--ink-high)', flex: 1 }}>
          {status === 'idle'    ? 'Waiting for permission…'
          : status === 'writing' ? 'Writing files…'
          : status === 'done'    ? 'Files saved'
          : status === 'error'   ? 'Some files failed'
          : status === 'denied'  ? 'Action cancelled'
          : status === 'undoing' ? 'Undoing…'
          : status === 'undone'  ? 'Changes undone'
          : 'Files to create'}
        </span>
        {(status === 'writing' || status === 'undoing')
          ? <Loader2 size={14} style={{ color: 'var(--primary-400)', animation: 'spin 1s linear infinite' }} />
          : isDone
          ? <CheckCircle2 size={14} style={{ color: 'var(--success-500)' }} />
          : null}
      </div>

      {/* File list */}
      <div style={{ padding: '6px 12px', display: 'flex', flexDirection: 'column', gap: '4px' }}>
        {files.map((f, i) => {
          const result = results.find(r => r.path === f.path);
          return (
            <div key={i} style={{ display: 'flex', alignItems: 'center', gap: '6px', fontSize: '12px' }}>
              <ChevronRight size={12} style={{ color: 'var(--ink-low)', flexShrink: 0 }} />
              <span style={{ color: 'var(--ink-mid)', flex: 1, fontFamily: 'monospace' }}>{f.path}</span>
              {result?.ok && !isUndone && <CheckCircle2 size={12} style={{ color: 'var(--success-500)' }} />}
              {result?.ok === false && <span style={{ color: 'var(--error-400)', fontSize: '11px' }}>✗ {result.error}</span>}
            </div>
          );
        })}
      </div>

      {/* Undo button */}
      {isDone && (
        <div style={{ padding: '6px 12px', borderTop: '1px solid var(--s4)' }}>
          <button
            onClick={handleUndo}
            style={{ display: 'flex', alignItems: 'center', gap: '4px', fontSize: '11px', color: 'var(--ink-low)', border: '1px solid var(--s4)', borderRadius: '6px', padding: '3px 8px', background: 'transparent', cursor: 'pointer' }}
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
  fileTree,
  lastUserPrompt,
  onRequestPermission,
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
  return (
    <WriteFilesBlock
      key={i}
      files={block.files!}
      onFilesWritten={onFilesWritten}
      fileTree={fileTree}
      lastUserPrompt={lastUserPrompt}
      onRequestPermission={onRequestPermission}
    />
  );
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
