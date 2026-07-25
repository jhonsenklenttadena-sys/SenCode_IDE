/**
 * FileTree — sidebar file tree with right-click context menu.
 * Supports: open file, delete file/folder, create subfolder (inline, VS Code-style).
 */

import { useState, useEffect, useRef, useCallback } from 'react';
import {
  ChevronRight, ChevronDown, FileCode2, FileText, FileJson,
  Folder, FolderOpen, Trash2, FolderX, FolderPlus,
} from 'lucide-react';
import type { FileNode } from '../../lib/types';

interface FileTreeProps {
  nodes: FileNode[];
  onOpenFile: (node: FileNode) => void;
  onRefresh: () => void;
  onDeleteNode: (node: FileNode) => void;
  /**
   * Called when the user commits a new-folder name from the inline input.
   * Returns ok/error so the tree can show validation messages.
   * The tree refreshes via onRefresh after a successful creation.
   */
  onCreateFolder?: (
    parentPath: string,
    folderName: string,
  ) => Promise<{ ok: boolean; error?: string; reserved?: boolean }>;
}

/** Map file extension to a color class for the tree icon. */
function fileColorClass(name: string): string {
  const ext = name.split('.').pop()?.toLowerCase() ?? '';
  const map: Record<string, string> = {
    ts: 'text-primary-400', tsx: 'text-primary-400',
    js: 'text-warning-500', jsx: 'text-warning-500',
    py: 'text-success-500',
    json: 'text-warning-400',
    md: 'text-ink-mid',
    css: 'text-accent-400', scss: 'text-accent-400',
    html: 'text-error-400',
    sh: 'text-success-600',
    env: 'text-error-500',
  };
  return map[ext] ?? 'text-ink-mid';
}

function fileIcon(name: string) {
  const ext = name.split('.').pop()?.toLowerCase() ?? '';
  if (['json'].includes(ext)) return FileJson;
  if (['md', 'txt'].includes(ext)) return FileText;
  return FileCode2;
}

// ── Context menu state shared across the whole tree ───────────────────────────
interface CtxMenu {
  node: FileNode;
  x: number;
  y: number;
}

export function FileTree({ nodes, onOpenFile, onDeleteNode, onRefresh, onCreateFolder }: FileTreeProps) {
  const [ctxMenu, setCtxMenu]       = useState<CtxMenu | null>(null);
  const [confirmNode, setConfirmNode] = useState<FileNode | null>(null);

  // ── Inline folder creation state ──────────────────────────────────────────
  /** Path of the directory node we're creating a subfolder inside. */
  const [creatingIn, setCreatingIn]         = useState<string | null>(null);
  const [newFolderName, setNewFolderName]   = useState('');
  const [folderError, setFolderError]       = useState<string | null>(null);
  const [creatingBusy, setCreatingBusy]     = useState(false);
  const folderInputRef = useRef<HTMLInputElement>(null);

  const menuRef = useRef<HTMLDivElement>(null);

  // ── Close context menu on outside click or Escape ────────────────────────
  useEffect(() => {
    if (!ctxMenu) return;
    const onDown = (e: MouseEvent) => {
      if (menuRef.current && !menuRef.current.contains(e.target as Node)) {
        setCtxMenu(null);
      }
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') setCtxMenu(null);
    };
    document.addEventListener('mousedown', onDown);
    document.addEventListener('keydown', onKey);
    return () => {
      document.removeEventListener('mousedown', onDown);
      document.removeEventListener('keydown', onKey);
    };
  }, [ctxMenu]);

  // Auto-focus the folder name input whenever we enter creation mode
  useEffect(() => {
    if (creatingIn !== null) {
      requestAnimationFrame(() => {
        folderInputRef.current?.focus();
        folderInputRef.current?.select();
      });
    }
  }, [creatingIn]);

  const openCtxMenu = useCallback((e: React.MouseEvent, node: FileNode) => {
    e.preventDefault();
    e.stopPropagation();
    setCtxMenu({ node, x: e.clientX, y: e.clientY });
  }, []);

  const handleDeleteClick = (node: FileNode) => {
    setCtxMenu(null);
    setConfirmNode(node);
  };

  const handleNewFolderClick = (node: FileNode) => {
    setCtxMenu(null);
    setCreatingIn(node.path);
    setNewFolderName('');
    setFolderError(null);
  };

  const cancelNewFolder = useCallback(() => {
    setCreatingIn(null);
    setNewFolderName('');
    setFolderError(null);
  }, []);

  const commitNewFolder = useCallback(async () => {
    if (creatingIn === null || creatingBusy) return;

    const trimmed = newFolderName.trim();
    // Empty name → silent rejection, close input
    if (!trimmed) {
      cancelNewFolder();
      return;
    }

    if (!onCreateFolder) return;

    setCreatingBusy(true);
    setFolderError(null);
    try {
      const result = await onCreateFolder(creatingIn, trimmed);
      if (result.ok) {
        cancelNewFolder();
        onRefresh();
      } else {
        // Show inline error; keep input open so user can correct the name
        setFolderError(result.error ?? 'Could not create folder.');
        requestAnimationFrame(() => {
          folderInputRef.current?.focus();
          folderInputRef.current?.select();
        });
      }
    } finally {
      setCreatingBusy(false);
    }
  }, [creatingIn, creatingBusy, newFolderName, onCreateFolder, cancelNewFolder, onRefresh]);

  const handleConfirmDelete = () => {
    if (confirmNode) {
      onDeleteNode(confirmNode);
      setConfirmNode(null);
    }
  };

  return (
    <>
      <div className="py-1">
        {nodes.map((node) => (
          <TreeItem
            key={node.path}
            node={node}
            depth={0}
            onOpenFile={onOpenFile}
            onContextMenu={openCtxMenu}
            creatingIn={creatingIn}
            newFolderName={newFolderName}
            folderError={folderError}
            creatingBusy={creatingBusy}
            folderInputRef={folderInputRef}
            onFolderNameChange={(v) => { setNewFolderName(v); setFolderError(null); }}
            onFolderCommit={commitNewFolder}
            onFolderCancel={cancelNewFolder}
            showNewFolderButton={!!onCreateFolder}
          />
        ))}
      </div>

      {/* ── Context menu ─────────────────────────────────────────────────── */}
      {ctxMenu && (
        <div
          ref={menuRef}
          className="fixed z-[300] bg-surface-2 border border-surface-3 rounded-lg shadow-2xl py-1 min-w-[160px] animate-fade-in"
          style={{ top: ctxMenu.y, left: ctxMenu.x }}
        >
          {ctxMenu.node.type === 'file' && (
            <button
              onClick={() => { onOpenFile(ctxMenu.node); setCtxMenu(null); }}
              className="w-full flex items-center gap-2 px-3 py-2 text-xs text-ink-mid hover:text-ink-high hover:bg-surface-3 transition-colors text-left"
            >
              <FileCode2 size={13} /> Open
            </button>
          )}

          {/* New Folder — only for directory nodes */}
          {ctxMenu.node.type === 'directory' && onCreateFolder && (
            <button
              onClick={() => handleNewFolderClick(ctxMenu.node)}
              className="w-full flex items-center gap-2 px-3 py-2 text-xs text-ink-mid hover:text-ink-high hover:bg-surface-3 transition-colors text-left"
            >
              <FolderPlus size={13} /> New Folder
            </button>
          )}

          <button
            onClick={() => handleDeleteClick(ctxMenu.node)}
            className="w-full flex items-center gap-2 px-3 py-2 text-xs text-error-400 hover:text-error-300 hover:bg-surface-3 transition-colors text-left"
          >
            {ctxMenu.node.type === 'directory'
              ? <><FolderX size={13} /> Delete Folder</>
              : <><Trash2 size={13} /> Delete File</>
            }
          </button>
        </div>
      )}

      {/* ── Confirm delete dialog ─────────────────────────────────────────── */}
      {confirmNode && (
        <div className="fixed inset-0 bg-black/60 flex items-center justify-center z-[400] animate-fade-in">
          <div className="bg-surface-1 border border-surface-3 rounded-xl p-5 max-w-sm w-full mx-4 shadow-2xl">
            <div className="flex items-start gap-3 mb-4">
              <div className="w-9 h-9 rounded-lg bg-error-500/15 flex items-center justify-center flex-shrink-0">
                {confirmNode.type === 'directory'
                  ? <FolderX size={16} className="text-error-400" />
                  : <Trash2 size={16} className="text-error-400" />}
              </div>
              <div>
                <p className="text-sm font-semibold text-ink-high">
                  Delete {confirmNode.type === 'directory' ? 'folder' : 'file'}?
                </p>
                <p className="text-2xs text-ink-mid mt-1 break-all font-mono">
                  {confirmNode.name}
                </p>
                {confirmNode.type === 'directory' && (
                  <p className="text-2xs text-warning-400 mt-1">
                    This will delete all files inside it.
                  </p>
                )}
              </div>
            </div>
            <p className="text-2xs text-ink-low mb-4">This cannot be undone.</p>
            <div className="flex gap-2 justify-end">
              <button
                onClick={() => setConfirmNode(null)}
                className="px-3 py-1.5 text-xs text-ink-mid hover:text-ink-high rounded-lg transition-colors"
              >
                Cancel
              </button>
              <button
                onClick={handleConfirmDelete}
                className="px-3 py-1.5 text-xs font-medium text-white bg-error-600 hover:bg-error-500 rounded-lg transition-colors"
              >
                Delete
              </button>
            </div>
          </div>
        </div>
      )}
    </>
  );
}

// ── TreeItem ─────────────────────────────────────────────────────────────────

interface TreeItemProps {
  node: FileNode;
  depth: number;
  onOpenFile: (node: FileNode) => void;
  onContextMenu: (e: React.MouseEvent, node: FileNode) => void;
  // Inline folder creation — passed down so any depth can render the input
  creatingIn: string | null;
  newFolderName: string;
  folderError: string | null;
  creatingBusy: boolean;
  folderInputRef: React.RefObject<HTMLInputElement>;
  onFolderNameChange: (v: string) => void;
  onFolderCommit: () => void;
  onFolderCancel: () => void;
  showNewFolderButton: boolean;
}

function TreeItem({
  node, depth, onOpenFile, onContextMenu,
  creatingIn, newFolderName, folderError, creatingBusy,
  folderInputRef, onFolderNameChange, onFolderCommit, onFolderCancel,
  showNewFolderButton,
}: TreeItemProps) {
  const isDir = node.type === 'directory';
  const Icon  = isDir ? (/* expanded below */ Folder) : fileIcon(node.name);
  const colorCls = isDir ? 'text-primary-400' : fileColorClass(node.name);

  // Auto-expand when we're about to create a subfolder inside this node
  const [expanded, setExpanded] = useState(true);
  useEffect(() => {
    if (creatingIn === node.path) setExpanded(true);
  }, [creatingIn, node.path]);

  const ExpandedIcon = isDir ? (expanded ? FolderOpen : Folder) : Icon;

  return (
    <div>
      <div
        className="flex items-center gap-1 px-1.5 py-0.5 hover:bg-surface-2 cursor-default text-xs group"
        style={{ paddingLeft: `${depth * 12 + 6}px` }}
        onContextMenu={(e) => onContextMenu(e, node)}
      >
        {/* Expand/caret */}
        {isDir ? (
          <button
            onClick={() => setExpanded((v) => !v)}
            className="p-0.5 text-ink-low hover:text-ink-high"
          >
            {expanded ? <ChevronDown size={12} /> : <ChevronRight size={12} />}
          </button>
        ) : (
          <span className="w-[18px] flex-shrink-0" />
        )}

        {/* File/dir icon */}
        <ExpandedIcon size={14} className={`${colorCls} flex-shrink-0`} />

        {/* Name */}
        {isDir ? (
          <button
            onClick={() => setExpanded((v) => !v)}
            className="text-ink-high truncate flex-1 text-left"
          >
            {node.name}
          </button>
        ) : (
          <button
            onClick={() => onOpenFile(node)}
            className="text-ink-high hover:text-primary-400 truncate flex-1 text-left transition-colors"
          >
            {node.name}
          </button>
        )}

        {/* Inline delete button — visible on row hover */}
        <button
          onClick={(e) => { e.stopPropagation(); onContextMenu(e, node); }}
          title={`Delete ${isDir ? 'folder' : 'file'}`}
          className="opacity-0 group-hover:opacity-100 p-0.5 ml-1 rounded text-ink-low hover:text-error-400 transition-all flex-shrink-0"
        >
          <Trash2 size={11} />
        </button>
      </div>

      {/* Children (and inline creation input when this is the target node) */}
      {isDir && expanded && (
        <div>
          {/* ── Inline "New Folder" input — rendered as first child ─────── */}
          {creatingIn === node.path && (
            <InlineFolderInput
              depth={depth + 1}
              value={newFolderName}
              error={folderError}
              busy={creatingBusy}
              inputRef={folderInputRef}
              onChange={onFolderNameChange}
              onCommit={onFolderCommit}
              onCancel={onFolderCancel}
            />
          )}

          {node.children?.map((child) => (
            <TreeItem
              key={child.path}
              node={child}
              depth={depth + 1}
              onOpenFile={onOpenFile}
              onContextMenu={onContextMenu}
              creatingIn={creatingIn}
              newFolderName={newFolderName}
              folderError={folderError}
              creatingBusy={creatingBusy}
              folderInputRef={folderInputRef}
              onFolderNameChange={onFolderNameChange}
              onFolderCommit={onFolderCommit}
              onFolderCancel={onFolderCancel}
              showNewFolderButton={showNewFolderButton}
            />
          ))}
        </div>
      )}
    </div>
  );
}

// ── InlineFolderInput ─────────────────────────────────────────────────────────

interface InlineFolderInputProps {
  depth: number;
  value: string;
  error: string | null;
  busy: boolean;
  inputRef: React.RefObject<HTMLInputElement>;
  onChange: (v: string) => void;
  onCommit: () => void;
  onCancel: () => void;
}

function InlineFolderInput({ depth, value, error, busy, inputRef, onChange, onCommit, onCancel }: InlineFolderInputProps) {
  return (
    <div style={{ paddingLeft: `${depth * 12 + 6}px` }} className="pr-2 py-1 space-y-1">
      <div className="flex items-center gap-1">
        {/* Indent spacer matching a file row */}
        <span className="w-[18px] flex-shrink-0" />
        <FolderPlus size={14} className="text-primary-400 flex-shrink-0" />
        <input
          ref={inputRef}
          value={value}
          disabled={busy}
          onChange={(e) => onChange(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter')  { e.preventDefault(); onCommit(); }
            if (e.key === 'Escape') { e.preventDefault(); onCancel(); }
          }}
          onBlur={() => {
            // Commit on blur (VS Code behaviour): empty → silent cancel
            onCommit();
          }}
          placeholder="Folder name"
          className="flex-1 min-w-0 px-1.5 py-0.5 text-xs bg-surface-2 border border-primary-500 rounded text-ink-high placeholder:text-ink-low focus:outline-none disabled:opacity-50"
          autoComplete="off"
          spellCheck={false}
        />
      </div>
      {/* Validation error shown inline */}
      {error && (
        <p className="text-[10px] text-error-400 leading-snug pl-[33px] pr-1 normal-case tracking-normal">
          {error}
        </p>
      )}
    </div>
  );
}

/**
 * Returns all non-sensitive files from a tree.
 * Since there are no checkboxes, every file is always in context.
 */
export function countContextFiles(nodes: FileNode[]): FileNode[] {
  const result: FileNode[] = [];
  const walk = (list: FileNode[]) => {
    for (const n of list) {
      if (n.type === 'file') result.push(n);
      if (n.children) walk(n.children);
    }
  };
  walk(nodes);
  return result;
}
