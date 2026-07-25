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
import type { ChatMessage, FileNode } from '../../lib/types';
import { parseBlocks, renderMarkdown } from '../../lib/markdown';
import { CodeBlock } from './CodeBlock';
import { writeFiles, undoWriteFiles, isElectron, createDirs, deleteFile } from '../../lib/electronBridge';

interface MessageBubbleProps {
  message: ChatMessage;
  onInsertCode?: (content: string, language: string) => void;
  onApplyDiff?: (content: string, language: string) => void;
  onAddToProject?: (content: string, language: string) => void;
  onOpenInProgramming?: (content: string, language: string, filename?: string) => void;
  /** Called after AI writes files — so App can open them in tabs and refresh tree */
  onFilesWritten?: (files: { path: string; content: string }[]) => void;
  /** Called after AI deletes files — so App can close their tabs and refresh tree */
  onFilesDeleted?: (paths: string[]) => void;
  /** Current project file tree — used to tell EDIT (file already exists) apart from CREATE (new file) */
  fileTree?: FileNode[];
  /** The user's most recent message — used to judge whether an action was explicitly requested */
  lastUserPrompt?: string;
  /** Forwarded to WriteFilesBlock/DeleteFilesBlock — delegates the Deny/Proceed dialog to ChatPanel */
  onRequestPermission?: (
    action: 'EDIT' | 'CREATE' | 'DELETE',
    files: { path: string; content: string }[],
    onProceed: () => void,
    onDeny: () => void,
  ) => void;
}

// ── Permission heuristics ────────────────────────────────────────────────────────
/** Walks the file tree to check whether a path already exists (→ this write is an EDIT, not a CREATE) */
function fileExistsInTree(path: string, nodes: FileNode[]): boolean {
  for (const n of nodes) {
    if (n.type === 'file' && n.path === path) return true;
    if (n.children && fileExistsInTree(path, n.children)) return true;
  }
  return false;
}

/**
 * EDIT only needs confirmation when it looks like an inferred, large-scale refactor —
 * i.e. more than a couple files, or the user's prompt didn't clearly ask to change these files.
 */
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

/**
 * CREATE only needs confirmation when the user didn't clearly ask for a new file/folder —
 * i.e. more than one new file at once, or the prompt didn't name what's being created.
 */
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

/** DELETE always requires confirmation — no heuristic bypass, deletions are irreversible. */
function needsPermissionForDelete(_filePaths: string[], _prompt: string): boolean {
  return true;
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
  onRequestPermission,
  fileTree,
  lastUserPrompt,
}: {
  files: { path: string; content: string }[];
  onFilesWritten?: (files: { path: string; content: string }[]) => void;
  /** Delegates the actual Deny/Proceed prompt up to ChatPanel, which renders it above the input box */
  onRequestPermission?: (
    action: 'EDIT' | 'CREATE' | 'DELETE',
    files: { path: string; content: string }[],
    onProceed: () => void,
    onDeny: () => void,
  ) => void;
  fileTree?: FileNode[];
  lastUserPrompt?: string;
}) {
  const [status, setStatus] = useState<WriteStatus>('awaiting-folder-permission');
  const [results, setResults] = useState<{ path: string; ok: boolean; error?: string }[]>([]);

  const tree = fileTree ?? [];
  const prompt = lastUserPrompt ?? '';

  // Split files into ones that already exist (EDIT) vs brand-new ones (CREATE)
  const editFiles = useMemo(() => files.filter(f => fileExistsInTree(f.path, tree)), [files, tree]);
  const createFiles = useMemo(() => files.filter(f => !fileExistsInTree(f.path, tree)), [files, tree]);

  // Only new files can require new parent directories
  const uniqueDirs = useMemo(() => {
    const dirs = new Set<string>();
    for (const f of createFiles) {
      const normalized = f.path.replace(/\\/g, '/');
      const lastSlash = normalized.lastIndexOf('/');
      if (lastSlash > 0) dirs.add(normalized.slice(0, lastSlash));
    }
    return Array.from(dirs);
  }, [createFiles]);

  const editNeeds = editFiles.length > 0 && needsPermissionForEdit(editFiles.map(f => f.path), prompt);
  const createNeeds = createFiles.length > 0 && needsPermissionForCreate(createFiles.map(f => f.path), prompt);

  // ── Step 1: folder creation (only relevant when new files land in new folders) ──
  const handleFolderApprove = async () => {
    setStatus('creating-folders');
    await createDirs(uniqueDirs);           // execute folder creation
    askFilePermission();                    // halt — wait for next approval
  };

  // ── Step 2: writing/editing the files themselves ─────────────────────────────
  const handleFileApprove = async () => {
    setStatus('writing-files');
    const res = await writeFiles(files);    // execute file creation/edit
    setResults(res);
    const allOk = res.every(r => r.ok);
    setStatus(allOk ? 'done' : 'error');
    if (allOk) onFilesWritten?.(files);
  };

  const handleDeny = () => setStatus('denied');

  // Ask ChatPanel to show its Deny/Proceed dialog for the write step, skipping it
  // entirely when the edit/create was clearly expected from the user's own prompt.
  const askFilePermission = () => {
    if ((editNeeds || createNeeds) && onRequestPermission) {
      setStatus('awaiting-file-permission');
      const action: 'EDIT' | 'CREATE' = editNeeds ? 'EDIT' : 'CREATE';
      onRequestPermission(action, files, handleFileApprove, handleDeny);
    } else {
      handleFileApprove(); // expected action, or no dialog wired up — proceed directly
    }
  };

  // Ask ChatPanel to show its Deny/Proceed dialog for the folder step, skipping it
  // when the new file(s)/folder were clearly asked for.
  const askFolderPermission = () => {
    if (createNeeds && onRequestPermission) {
      setStatus('awaiting-folder-permission');
      onRequestPermission('CREATE', files, handleFolderApprove, handleDeny);
    } else {
      handleFolderApprove(); // expected creation — skip the folder prompt
    }
  };

  // On mount — route straight past whichever step doesn't apply
  useEffect(() => {
    if (!isElectron() || files.length === 0) return;
    if (uniqueDirs.length > 0) {
      askFolderPermission();
    } else {
      askFilePermission();
    }
  }, []); // eslint-disable-line react-hooks/exhaustive-deps

  const handleUndo = async () => {
    setStatus('undoing');
    const paths = files.map(f => f.path);
    await undoWriteFiles(paths);
    setStatus('undone');
    // Notify parent that files were undone so it can close those tabs
    onFilesWritten?.([]);
  };

  if (!isElectron()) return null;

  const isDone   = status === 'done';
  const isUndone = status === 'undone';
  const isBusy   = status === 'creating-folders' || status === 'writing-files' || status === 'undoing';

  return (
    <div className="rounded-lg my-2 overflow-hidden text-[12px]"
      style={{ border: '1px solid var(--s3)', background: 'var(--s2)' }}>

      {/* Header */}
      <div className="flex items-center gap-2 px-3 py-2"
        style={{ borderBottom: '1px solid var(--s3)', color: 'var(--ink-mid)' }}>
        <FolderOutput size={13} style={{ color: 'var(--accent)', flexShrink: 0 }} />
        <span className="font-medium" style={{ color: 'var(--ink-high)' }}>
          {status === 'awaiting-folder-permission' ? 'Permission required: folder creation'
          : status === 'creating-folders'          ? 'Creating folders…'
          : status === 'awaiting-file-permission'   ? 'Permission required: file creation'
          : status === 'writing-files'              ? 'Writing files…'
          : status === 'done'                       ? 'Files saved'
          : status === 'error'                      ? 'Some files failed'
          : status === 'undoing'                    ? 'Undoing…'
          : status === 'undone'                      ? 'Changes undone'
          : status === 'denied'                      ? 'Cancelled'
          : 'Files to create'}
        </span>
        {isBusy
          ? <Loader2 size={11} className="animate-spin ml-auto" style={{ color: 'var(--accent)' }} />
          : isDone
          ? <CheckCircle2 size={13} className="ml-auto" style={{ color: 'var(--success)' }} />
          : null}
      </div>

      {/* STEP 1 — awaiting folder permission (dialog itself renders in ChatPanel, above the input) */}
      {status === 'awaiting-folder-permission' && (
        <div className="px-3 py-2" style={{ color: 'var(--ink-mid)' }}>
          <p className="mb-2">Respond to the permission request above to create:</p>
          <div className="space-y-1">
            {uniqueDirs.map(d => (
              <div key={d} className="font-mono truncate" style={{ color: 'var(--ink-high)' }}>{d}</div>
            ))}
          </div>
        </div>
      )}

      {/* STEP 2 — awaiting file permission (dialog itself renders in ChatPanel, above the input) */}
      {status === 'awaiting-file-permission' && (
        <div className="px-3 py-2" style={{ color: 'var(--ink-mid)' }}>
          <p className="mb-2">Respond to the permission request above to write:</p>
          <div className="space-y-1">
            {files.map(f => (
              <div key={f.path} className="font-mono truncate" style={{ color: 'var(--ink-high)' }}>{f.path}</div>
            ))}
          </div>
        </div>
      )}

      {/* File list — shown after writing completes */}
      {(status === 'done' || status === 'error' || status === 'undone') && (
        <div className="px-3 py-2 space-y-1">
          {files.map((f) => {
            const result = results.find(r => r.path === f.path);
            return (
              <div key={f.path} className="flex items-center gap-2">
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
      )}

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

// ── Delete-files block ───────────────────────────────────────────────────────────
type DeleteStatus = 'awaiting-permission' | 'deleting' | 'done' | 'error' | 'denied';

function DeleteFilesBlock({
  paths,
  onFilesDeleted,
  onRequestPermission,
  lastUserPrompt,
}: {
  paths: string[];
  onFilesDeleted?: (paths: string[]) => void;
  onRequestPermission?: (
    action: 'EDIT' | 'CREATE' | 'DELETE',
    files: { path: string; content: string }[],
    onProceed: () => void,
    onDeny: () => void,
  ) => void;
  lastUserPrompt?: string;
}) {
  const [status, setStatus] = useState<DeleteStatus>('awaiting-permission');
  const [results, setResults] = useState<{ path: string; ok: boolean; error?: string }[]>([]);

  const handleApprove = async () => {
    setStatus('deleting');
    const res = await Promise.all(paths.map(async (p) => {
      const r = await deleteFile(p);
      return { path: p, ok: r.ok, error: r.error };
    }));
    setResults(res);
    const allOk = res.every(r => r.ok);
    setStatus(allOk ? 'done' : 'error');
    if (allOk) onFilesDeleted?.(paths);
  };

  const handleDeny = () => setStatus('denied');

  // Deletions are irreversible — always confirm, no heuristic bypass.
  useEffect(() => {
    if (!isElectron() || paths.length === 0) return;
    if (needsPermissionForDelete(paths, lastUserPrompt ?? '') && onRequestPermission) {
      // DeleteFilesBlock reuses the same {path, content} shape for the dialog's file list
      onRequestPermission('DELETE', paths.map(p => ({ path: p, content: '' })), handleApprove, handleDeny);
    } else {
      handleApprove();
    }
  }, []); // eslint-disable-line react-hooks/exhaustive-deps

  if (!isElectron()) return null;

  const isBusy = status === 'deleting';

  return (
    <div className="rounded-lg my-2 overflow-hidden text-[12px]"
      style={{ border: '1px solid var(--s3)', background: 'var(--s2)' }}>
      <div className="flex items-center gap-2 px-3 py-2"
        style={{ borderBottom: '1px solid var(--s3)', color: 'var(--ink-mid)' }}>
        <Undo2 size={13} style={{ color: 'var(--error)', flexShrink: 0, transform: 'scaleX(-1)' }} />
        <span className="font-medium" style={{ color: 'var(--ink-high)' }}>
          {status === 'awaiting-permission' ? 'Permission required: delete files'
          : status === 'deleting'           ? 'Deleting…'
          : status === 'done'               ? 'Files deleted'
          : status === 'error'              ? 'Some deletions failed'
          : 'Cancelled'}
        </span>
        {isBusy && <Loader2 size={11} className="animate-spin ml-auto" style={{ color: 'var(--accent)' }} />}
        {status === 'done' && <CheckCircle2 size={13} className="ml-auto" style={{ color: 'var(--success)' }} />}
      </div>

      {status === 'awaiting-permission' && (
        <div className="px-3 py-2" style={{ color: 'var(--ink-mid)' }}>
          <p className="mb-2">Respond to the permission request above to delete:</p>
          <div className="space-y-1">
            {paths.map(p => (
              <div key={p} className="font-mono truncate" style={{ color: 'var(--error)' }}>{p}</div>
            ))}
          </div>
        </div>
      )}

      {(status === 'done' || status === 'error') && (
        <div className="px-3 py-2 space-y-1">
          {paths.map((p) => {
            const result = results.find(r => r.path === p);
            return (
              <div key={p} className="flex items-center gap-2">
                <span className="font-mono truncate flex-1"
                  style={{ color: result?.ok === false ? 'var(--error)' : 'var(--ink-mid)' }}>{p}</span>
                {result?.ok && <CheckCircle2 size={11} style={{ color: 'var(--success)', flexShrink: 0 }} />}
                {result?.ok === false && <span style={{ color: 'var(--error)', flexShrink: 0 }}>✗ {result.error}</span>}
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}

// ── Malformed write-files payload ──────────────────────────────────────────────
function WriteFilesErrorBlock({ error }: { error: string }) {
  return (
    <div className="flex items-start gap-2 text-[13px] rounded-lg px-3 py-2 my-2"
      style={{ color: 'var(--error)', background: 'color-mix(in srgb, var(--error) 10%, transparent)', border: '1px solid color-mix(in srgb, var(--error) 30%, transparent)' }}>
      <AlertTriangle size={14} className="mt-0.5 flex-shrink-0" />
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
  onFilesDeleted,
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
                      files={block.files ?? []}
                      onFilesWritten={onFilesWritten}
                      onRequestPermission={onRequestPermission}
                      fileTree={fileTree}
                      lastUserPrompt={lastUserPrompt}
                    />
                  );
                }
                if (block.type === 'delete-files' && !message.streaming) {
                  return (
                    <DeleteFilesBlock
                      key={i}
                      paths={block.paths ?? []}
                      onFilesDeleted={onFilesDeleted}
                      onRequestPermission={onRequestPermission}
                      lastUserPrompt={lastUserPrompt}
                    />
                  );
                }
                if (block.type === 'write-files-error' && !message.streaming) {
                  return <WriteFilesErrorBlock key={i} error={block.error!} />;
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
