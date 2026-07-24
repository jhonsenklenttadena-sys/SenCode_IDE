/**
 * CodeBlock — renders a fenced code block from an AI response with inline
 * action buttons: Copy, Download, Insert into editor, Apply as diff.
 * (§5.4 — Flexible Output Handling)
 */

import { useState } from 'react';
import { Copy, Check, Download, ClipboardPaste, FilePlus, ChevronDown, SquareCode } from 'lucide-react';
import { LANG_EXT } from '../../lib/types';

interface CodeBlockProps {
  language: string;
  content: string;
  filename?: string;
  onInsert?: (content: string, language: string) => void;
  onApplyDiff?: (content: string, language: string) => void;
  onAddToProject?: (content: string, language: string) => void;
  /** Shown only in Chat mode — switches to Programming mode with this snippet opened as a file tab. */
  onOpenInProgramming?: (content: string, language: string, filename?: string) => void;
}

export function CodeBlock({
  language,
  content,
  filename,
  onInsert,
  onApplyDiff,
  onAddToProject,
  onOpenInProgramming,
}: CodeBlockProps) {
  const [copied, setCopied] = useState(false);
  const [menuOpen, setMenuOpen] = useState(false);

  const copy = async () => {
    await navigator.clipboard.writeText(content);
    setCopied(true);
    setTimeout(() => setCopied(false), 1500);
  };

  const download = () => {
    const ext = LANG_EXT[language.toLowerCase()] ?? 'txt';
    const name = filename ?? `snippet.${ext}`;
    const blob = new Blob([content], { type: 'text/plain' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = name;
    a.click();
    URL.revokeObjectURL(url);
  };

  return (
    <div className="my-3 rounded-lg overflow-hidden border border-surface-3 bg-surface-1 group">
      {/* Header bar */}
      <div className="flex items-center justify-between px-3 py-1.5 bg-surface-2 border-b border-surface-3">
        <div className="flex items-center gap-2 min-w-0">
          <span className="text-2xs font-mono uppercase tracking-wide text-ink-low flex-shrink-0">
            {language}
          </span>
          {filename && (
            <span className="text-2xs font-mono text-accent-400 truncate" title={filename}>
              {filename}
            </span>
          )}
        </div>
        <div className="flex items-center gap-1">
          <button
            onClick={copy}
            className="flex items-center gap-1 px-2 py-1 text-2xs text-ink-mid hover:text-ink-high hover:bg-surface-3 rounded transition-colors"
            title="Copy to clipboard"
          >
            {copied ? <Check size={12} className="text-success-500" /> : <Copy size={12} />}
            {copied ? 'Copied' : 'Copy'}
          </button>
          <button
            onClick={download}
            className="flex items-center gap-1 px-2 py-1 text-2xs text-ink-mid hover:text-ink-high hover:bg-surface-3 rounded transition-colors"
            title="Download as file"
          >
            <Download size={12} />
            Download
          </button>
          {onOpenInProgramming && (
            <button
              onClick={() => onOpenInProgramming(content, language, filename)}
              className="flex items-center gap-1 px-2 py-1 text-2xs text-primary-400 hover:text-primary-300 hover:bg-surface-3 rounded transition-colors"
              title="Open this in Programming Mode's editor"
            >
              <SquareCode size={12} />
              Open in Programming Mode
            </button>
          )}
          {onInsert && (
            <button
              onClick={() => onInsert(content, language)}
              className="flex items-center gap-1 px-2 py-1 text-2xs text-ink-mid hover:text-ink-high hover:bg-surface-3 rounded transition-colors"
              title="Insert into open editor tab"
            >
              <ClipboardPaste size={12} />
              Insert
            </button>
          )}
          {onAddToProject && (
            <div className="relative">
              <button
                onClick={() => setMenuOpen((v) => !v)}
                className="flex items-center gap-1 px-2 py-1 text-2xs text-ink-mid hover:text-ink-high hover:bg-surface-3 rounded transition-colors"
                title="More actions"
              >
                <ChevronDown size={12} />
              </button>
              {menuOpen && (
                <div className="absolute right-0 top-full mt-1 w-48 bg-surface-2 border border-surface-3 rounded-lg shadow-xl z-10 py-1 animate-fade-in">
                  {onApplyDiff && (
                    <button
                      onClick={() => { onApplyDiff(content, language); setMenuOpen(false); }}
                      className="w-full flex items-center gap-2 px-3 py-1.5 text-2xs text-ink-mid hover:text-ink-high hover:bg-surface-3 transition-colors"
                    >
                      <ClipboardPaste size={12} />
                      Apply as diff
                    </button>
                  )}
                  {onAddToProject && (
                    <button
                      onClick={() => { onAddToProject(content, language); setMenuOpen(false); }}
                      className="w-full flex items-center gap-2 px-3 py-1.5 text-2xs text-ink-mid hover:text-ink-high hover:bg-surface-3 transition-colors"
                    >
                      <FilePlus size={12} />
                      Add to project
                    </button>
                  )}
                </div>
              )}
            </div>
          )}
        </div>
      </div>
      {/* Code body */}
      <pre className="p-3 overflow-x-auto text-[12.5px] leading-[1.6] font-mono text-ink-high">
        <code>{content}</code>
      </pre>
    </div>
  );
}
