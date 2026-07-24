/**
 * GitPanel — sidebar git status panel (§5.6).
 * Shows modified/staged/untracked files, stage/unstage, commit, push/pull,
 * branch switcher, and commit log. All operations require explicit confirmation.
 * v1 scope: status / stage / commit / push / pull / branch-switch / log.
 *
 * In the desktop build, git state comes from simple-git. Here the panel
 * starts empty and shows a "no repo" state until a project with a git repo
 * is opened.
 */

import { useState } from 'react';
import {
  GitBranch, GitCommit, Plus, Minus,
  ArrowUp, ArrowDown, Check, FileEdit, FilePlus2,
  History, FolderGit2,
} from 'lucide-react';

interface GitFile {
  path: string;
  status: 'modified' | 'staged' | 'untracked' | 'deleted';
}

export function GitPanel() {
  const [files] = useState<GitFile[]>([]);
  const [branch] = useState('');
  const [commitMsg, setCommitMsg] = useState('');
  const [showLog, setShowLog] = useState(false);
  const [confirm, setConfirm] = useState<string | null>(null);
  const [log] = useState<{ hash: string; message: string; date: string }[]>([]);

  const modified = files.filter((f) => f.status === 'modified');
  const staged = files.filter((f) => f.status === 'staged');
  const untracked = files.filter((f) => f.status === 'untracked');

  const statusIcon = (s: GitFile['status']) => {
    switch (s) {
      case 'modified': return <FileEdit size={12} className="text-warning-500" />;
      case 'staged': return <Check size={12} className="text-success-500" />;
      case 'untracked': return <FilePlus2 size={12} className="text-ink-low" />;
      case 'deleted': return <Minus size={12} className="text-error-500" />;
    }
  };

  // No repo / no project open
  if (!branch) {
    return (
      <div className="flex flex-col items-center justify-center h-full text-center px-4 py-8">
        <div className="w-10 h-10 rounded-lg bg-surface-2 border border-surface-3 flex items-center justify-center mb-3">
          <FolderGit2 size={18} className="text-ink-low" />
        </div>
        <p className="text-2xs text-ink-mid mb-1">No repository open</p>
        <p className="text-2xs text-ink-low max-w-[180px]">
          Open a project folder with a git repository to see branch status, staged files, and commit history.
        </p>
      </div>
    );
  }

  return (
    <div className="flex flex-col h-full text-xs">
      {/* Branch + actions */}
      <div className="flex items-center gap-2 px-2 py-2 border-b border-surface-3">
        <GitBranch size={13} className="text-primary-400" />
        <span className="font-mono text-ink-high">{branch}</span>
        <div className="ml-auto flex items-center gap-1">
          <button
            onClick={() => setConfirm('pull')}
            className="p-1 text-ink-low hover:text-ink-high hover:bg-surface-3 rounded transition-colors"
            title="Pull"
          >
            <ArrowDown size={13} />
          </button>
          <button
            onClick={() => setConfirm('push')}
            className="p-1 text-ink-low hover:text-ink-high hover:bg-surface-3 rounded transition-colors"
            title="Push"
          >
            <ArrowUp size={13} />
          </button>
          <button
            onClick={() => setShowLog((v) => !v)}
            className={`p-1 rounded transition-colors ${showLog ? 'text-accent-400 bg-surface-3' : 'text-ink-low hover:text-ink-high hover:bg-surface-3'}`}
            title="Commit log"
          >
            <History size={13} />
          </button>
        </div>
      </div>

      {showLog ? (
        /* Commit log */
        <div className="flex-1 overflow-y-auto py-1">
          {log.length === 0 ? (
            <div className="px-3 py-6 text-center text-2xs text-ink-low">
              No commits yet.
            </div>
          ) : (
            log.map((entry) => (
              <div key={entry.hash} className="flex items-start gap-2 px-2 py-1.5 hover:bg-surface-2">
                <GitCommit size={12} className="text-ink-low mt-0.5 flex-shrink-0" />
                <div className="min-w-0 flex-1">
                  <div className="text-ink-high truncate">{entry.message}</div>
                  <div className="text-2xs text-ink-low flex items-center gap-1.5">
                    <span className="font-mono">{entry.hash}</span>
                    <span>·</span>
                    <span>{entry.date}</span>
                  </div>
                </div>
              </div>
            ))
          )}
        </div>
      ) : (
        <>
          {/* File lists */}
          <div className="flex-1 overflow-y-auto">
            {staged.length > 0 && (
              <GitSection title="Staged" files={staged} statusIcon={statusIcon} actionIcon="unstage" />
            )}
            {modified.length > 0 && (
              <GitSection title="Modified" files={modified} statusIcon={statusIcon} actionIcon="stage" />
            )}
            {untracked.length > 0 && (
              <GitSection title="Untracked" files={untracked} statusIcon={statusIcon} actionIcon="stage" />
            )}
            {files.length === 0 && (
              <div className="px-3 py-6 text-center text-2xs text-ink-low">
                Working tree clean. No changes to commit.
              </div>
            )}
          </div>

          {/* Commit area */}
          <div className="border-t border-surface-3 p-2">
            <input
              value={commitMsg}
              onChange={(e) => setCommitMsg(e.target.value)}
              placeholder="Commit message…"
              className="w-full bg-surface-2 border border-surface-3 rounded px-2 py-1.5 text-xs text-ink-high placeholder-ink-low outline-none focus:border-primary-500 mb-2"
            />
            <button
              onClick={() => setConfirm('commit')}
              disabled={!commitMsg.trim() || staged.length === 0}
              className="w-full flex items-center justify-center gap-1.5 py-1.5 bg-primary-600 hover:bg-primary-500 disabled:opacity-30 disabled:cursor-not-allowed rounded text-2xs font-medium text-white transition-colors"
            >
              <GitCommit size={12} />
              Commit ({staged.length} staged)
            </button>
          </div>
        </>
      )}

      {/* Confirmation dialog for destructive ops */}
      {confirm && (
        <ConfirmDialog
          action={confirm}
          onCancel={() => setConfirm(null)}
          onConfirm={() => {
            setConfirm(null);
            setCommitMsg('');
          }}
        />
      )}
    </div>
  );
}

function GitSection({
  title,
  files,
  statusIcon,
  actionIcon,
}: {
  title: string;
  files: GitFile[];
  statusIcon: (s: GitFile['status']) => React.ReactNode;
  actionIcon: 'stage' | 'unstage';
}) {
  return (
    <div className="mb-1">
      <div className="px-2 py-1 text-2xs font-medium text-ink-low uppercase tracking-wide">
        {title} ({files.length})
      </div>
      {files.map((f) => (
        <div
          key={f.path}
          className="flex items-center gap-1.5 px-2 py-1 hover:bg-surface-2 group"
        >
          {statusIcon(f.status)}
          <span className="font-mono text-2xs text-ink-high truncate flex-1">{f.path}</span>
          <button
            className="p-0.5 text-ink-low hover:text-ink-high opacity-0 group-hover:opacity-100 transition-opacity"
            title={actionIcon === 'stage' ? 'Stage' : 'Unstage'}
          >
            {actionIcon === 'stage' ? <Plus size={11} /> : <Minus size={11} />}
          </button>
        </div>
      ))}
    </div>
  );
}

function ConfirmDialog({
  action,
  onCancel,
  onConfirm,
}: {
  action: string;
  onCancel: () => void;
  onConfirm: () => void;
}) {
  const messages: Record<string, string> = {
    push: 'Push commits to remote? This makes your changes visible to collaborators.',
    pull: 'Pull from remote? This merges remote changes into your local branch.',
    commit: 'Create a new commit with the staged changes?',
  };
  const isDestructive = action === 'push';

  return (
    <div className="fixed inset-0 bg-black/50 flex items-center justify-center z-50 animate-fade-in">
      <div className="bg-surface-1 border border-surface-3 rounded-xl p-5 max-w-sm w-full mx-4 shadow-2xl">
        <div className="flex items-start gap-3 mb-4">
          <div className={`w-9 h-9 rounded-lg flex items-center justify-center flex-shrink-0 ${
            isDestructive ? 'bg-error-500/15' : 'bg-primary-500/15'
          }`}>
            {isDestructive ? <ArrowUp size={16} className="text-error-400" /> : <Check size={16} className="text-primary-400" />}
          </div>
          <div>
            <h3 className="text-sm font-semibold text-ink-high capitalize mb-1">
              Confirm {action}
            </h3>
            <p className="text-2xs text-ink-mid">{messages[action]}</p>
          </div>
        </div>
        <div className="flex gap-2 justify-end">
          <button
            onClick={onCancel}
            className="px-3 py-1.5 text-2xs text-ink-mid hover:text-ink-high rounded transition-colors"
          >
            Cancel
          </button>
          <button
            onClick={onConfirm}
            className={`px-3 py-1.5 text-2xs font-medium text-white rounded transition-colors ${
              isDestructive ? 'bg-error-600 hover:bg-error-500' : 'bg-primary-600 hover:bg-primary-500'
            }`}
          >
            Confirm
          </button>
        </div>
      </div>
    </div>
  );
}
