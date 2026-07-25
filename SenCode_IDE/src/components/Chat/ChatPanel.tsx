/**
 * ChatPanel — the main chat interface.
 * Features: streaming responses, slash commands, @-mentions, context-window
 * meter, generated-files panel, and empty-state onboarding (§5.3, §5.4, §5.7).
 */

import { useState, useRef, useEffect, useCallback } from 'react';
import {
  Send, Square, Sparkles, AtSign, Slash, Zap, FileCode2,
  Trash2, Download, MessageSquarePlus, Terminal, History, Pin, PinOff,
} from 'lucide-react';
import type { ChatMessage, FileNode, GeneratedFile, Settings, ModelInfo, AppMode } from '../../lib/types';
import { streamChat } from '../../lib/aiClient';
import { readFile, runCommand, isElectron } from '../../lib/electronBridge';
import { MessageBubble } from './MessageBubble';
import { HistoryPanel } from './HistoryPanel';
import { saveSession, loadSession, deriveTitle, getUserMemory } from '../../lib/sessionBridge';
import { composeSystemPrompt } from '../../lib/systemPrompt';

// ── Permission dialog type ────────────────────────────────────────────────────
interface PendingPermission {
  action: 'EDIT' | 'CREATE' | 'DELETE';
  files: { path: string; content: string }[];
  onProceed: () => void;
  onDeny: () => void;
}

interface ChatPanelProps {
  messages: ChatMessage[];
  setMessages: React.Dispatch<React.SetStateAction<ChatMessage[]>>;
  settings: Settings;
  activeModel: string;
  models: ModelInfo[];
  contextFiles: FileNode[];
  fileTree?: FileNode[];
  openTabs?: { path: string; name: string; content: string; language: string }[];
  generatedFiles: GeneratedFile[];
  projectPath?: string;
  mode: AppMode;
  onInsertCode?: (content: string, language: string) => void;
  onApplyDiff?: (content: string, language: string) => void;
  onAddToProject?: (content: string, language: string) => void;
  onOpenInProgramming?: (content: string, language: string, filename?: string) => void;
  onRunCommand?: (cmd: string) => void;
  onFilesWritten?: (files: { path: string; content: string }[]) => void;
  onFilesDeleted?: (paths: string[]) => void;
  onClearChat: () => void;
}

const SLASH_COMMANDS = [
  { cmd: '/explain', desc: 'Explain the selected code line by line', icon: Sparkles },
  { cmd: '/refactor', desc: 'Refactor for clarity and best practices', icon: Zap },
  { cmd: '/test', desc: 'Generate unit tests', icon: FileCode2 },
  { cmd: '/document', desc: 'Add docstrings and comments', icon: FileCode2 },
  { cmd: '/debug', desc: 'Diagnose an error and propose a fix', icon: Zap },
  { cmd: '/debug-project', desc: 'Read all context files and debug the whole project', icon: Zap },
  { cmd: '/optimize', desc: 'Optimize performance', icon: Zap },
  { cmd: '/convert', desc: 'Convert between languages', icon: FileCode2 },
  { cmd: '/run', desc: 'Run a terminal command and explain the output', icon: Terminal },
];

const uid = () => Math.random().toString(36).slice(2, 10);

/** Build a compact folder tree string for the AI system prompt */
function buildFolderSummary(nodes: FileNode[], indent = 0): string {
  const lines: string[] = [];
  for (const n of nodes) {
    const prefix = '  '.repeat(indent);
    if (n.type === 'directory') {
      lines.push(`${prefix}${n.name}/`);
      if (n.children) lines.push(buildFolderSummary(n.children, indent + 1));
    } else {
      lines.push(`${prefix}${n.name}`);
    }
  }
  return lines.join('\n');
}

export function ChatPanel({
  messages,
  setMessages,
  settings,
  activeModel,
  contextFiles,
  fileTree,
  openTabs,
  generatedFiles,
  projectPath,
  mode,
  onInsertCode,
  onApplyDiff,
  onAddToProject,
  onOpenInProgramming,
  onRunCommand,
  onFilesWritten,
  onFilesDeleted,
  onClearChat,
}: ChatPanelProps) {
  const [input, setInput] = useState('');
  const [isStreaming, setIsStreaming] = useState(false);
  const [showSlashMenu, setShowSlashMenu] = useState(false);
  const [showMentionMenu, setShowMentionMenu] = useState(false);
  const [showGenerated, setShowGenerated] = useState(false);
  const [showHistory, setShowHistory] = useState(false);
  const [pastedImages, setPastedImages] = useState<string[]>([]);
  const [sessionId] = useState(() => Math.random().toString(36).slice(2, 10));
  const [sessionPinned, setSessionPinned] = useState(false);

  // ── Permission dialog queue ────────────────────────────────────────────────
  // A single `pendingPermission` slot would let a second concurrent request silently
  // overwrite (and strand) the first one. Using a queue guarantees each request is
  // shown one at a time, in order, and none of them get dropped.
  const [permissionQueue, setPermissionQueue] = useState<PendingPermission[]>([]);
  const activePermission = permissionQueue[0] ?? null;

  const sessionCreatedAt = useRef(Date.now());
  const abortRef = useRef<AbortController | null>(null);
  const scrollRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLTextAreaElement>(null);
  const memoryNotesRef = useRef<string>('');

  // Auto-scroll on new content
  useEffect(() => {
    if (scrollRef.current) {
      scrollRef.current.scrollTop = scrollRef.current.scrollHeight;
    }
  }, [messages]);

  // ── Handle image paste from clipboard ────────────────────────────────────
  const handlePaste = (e: React.ClipboardEvent<HTMLTextAreaElement>) => {
    const items = Array.from(e.clipboardData.items);
    const imageItem = items.find(item => item.type.startsWith('image/'));
    if (!imageItem) return;
    e.preventDefault();
    const blob = imageItem.getAsFile();
    if (!blob) return;
    const reader = new FileReader();
    reader.onload = () => {
      if (typeof reader.result === 'string') {
        setPastedImages(prev => [...prev, reader.result as string]);
      }
    };
    reader.readAsDataURL(blob);
  };

  useEffect(() => {
    if (!isElectron()) return;
    getUserMemory().then((m) => {
      if (m?.notes) memoryNotesRef.current = m.notes;
    });
  }, []);

  // ── Auto-save session after every completed AI response ──────────────────
  useEffect(() => {
    if (!settings.autoSaveHistory || !isElectron()) return;
    if (isStreaming) return;
    const completed = messages.filter((m) => m.role === 'assistant' && !m.streaming && !m.error);
    if (completed.length === 0) return;

    const firstUser = messages.find((m) => m.role === 'user');
    const title = firstUser ? deriveTitle(firstUser.content) : 'Chat';

    saveSession({
      id         : sessionId,
      title,
      projectPath: projectPath ?? '',
      modelId    : activeModel ?? '',
      pinned     : sessionPinned,
      createdAt  : sessionCreatedAt.current,
      updatedAt  : Date.now(),
      messages,
    });
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [isStreaming, messages.length]);

  // ── Permission request handler ────────────────────────────────────────────
  // Appends to the queue rather than replacing state, so simultaneous requests
  // (e.g. multiple write-files/delete-files blocks) each get their own turn
  // instead of clobbering one another.
  const handleRequestPermission = useCallback((
    action: 'EDIT' | 'CREATE' | 'DELETE',
    files: { path: string; content: string }[],
    onProceed: () => void,
    onDeny: () => void,
  ) => {
    setPermissionQueue((prev) => [...prev, { action, files, onProceed, onDeny }]);
  }, []);

  // Resolve the currently-shown request, then advance to the next one in line
  const resolveActivePermission = useCallback((decision: 'proceed' | 'deny') => {
    setPermissionQueue((prev) => {
      const [current, ...rest] = prev;
      if (current) decision === 'proceed' ? current.onProceed() : current.onDeny();
      return rest;
    });
  }, []);

  // Derive the last user message to pass down as intent context
  const lastUserPrompt = [...messages].reverse().find(m => m.role === 'user')?.content ?? '';

  const handleSend = useCallback(async (overrideInput?: string) => {
    const text = (overrideInput ?? input).trim();
    if (!text || isStreaming) return;

    setInput('');
    setShowSlashMenu(false);
    setShowMentionMenu(false);

    // ── /run <command> — execute terminal command and feed output to AI ──
    if (text.startsWith('/run ')) {
      const cmd = text.slice(5).trim();
      if (!cmd) return;
      const userMsg: ChatMessage = { id: uid(), role: 'user', content: text, timestamp: Date.now() };
      const assistantId = uid();
      const assistantMsg: ChatMessage = { id: assistantId, role: 'assistant', content: '', timestamp: Date.now(), streaming: true };
      setMessages((prev) => [...prev, userMsg, assistantMsg]);
      setIsStreaming(true);

      let cmdResult = '(terminal not available in browser)';
      if (isElectron()) {
        const r = await runCommand(cmd, projectPath, projectPath);
        cmdResult = [
          r.stdout ? `STDOUT:\n${r.stdout}` : '',
          r.stderr ? `STDERR:\n${r.stderr}` : '',
          `Exit code: ${r.exitCode ?? (r.ok ? 0 : 1)}`,
        ].filter(Boolean).join('\n');
        onRunCommand?.(cmd);
      }

      const prompt = `The student ran this terminal command in their project:\n\`\`\`\n${cmd}\n\`\`\`\nOutput:\n\`\`\`\n${cmdResult}\n\`\`\`\nExplain what happened, whether it succeeded, and what the student should do next.`;
      const ctrl = new AbortController();
      abortRef.current = ctrl;
      try {
        const stream = streamChat(settings.backend, {
          model: activeModel || 'demo',
          messages: [
            { role: 'system', content: composeSystemPrompt(settings.basePrompt, settings.customInstructions) },
            { role: 'user', content: prompt },
          ],
          temperature: settings.temperature,
          maxTokens: settings.maxTokens,
          topP: settings.topP,
          signal: ctrl.signal,
        });
        for await (const chunk of stream) {
          if (chunk.done) break;
          setMessages((prev) => prev.map((m) => m.id === assistantId ? { ...m, content: m.content + chunk.delta } : m));
        }
      } catch (e) {
        const msg = e instanceof Error ? e.message : 'Stream failed';
        setMessages((prev) => prev.map((m) => m.id === assistantId ? { ...m, streaming: false, error: msg } : m));
      } finally {
        setMessages((prev) => prev.map((m) => m.id === assistantId ? { ...m, streaming: false } : m));
        setIsStreaming(false);
        abortRef.current = null;
      }
      return;
    }

    const userMsg: ChatMessage = {
      id: uid(),
      role: 'user',
      content: pastedImages.length > 0
        ? text + (pastedImages.length === 1 ? '\n[Image attached]' : `\n[${pastedImages.length} images attached]`)
        : text,
      images: pastedImages.length > 0 ? [...pastedImages] : undefined,
      timestamp: Date.now(),
    };
    setPastedImages([]);

    const assistantId = uid();
    const assistantMsg: ChatMessage = {
      id: assistantId,
      role: 'assistant',
      content: '',
      timestamp: Date.now(),
      streaming: true,
    };

    setMessages((prev) => [...prev, userMsg, assistantMsg]);
    setIsStreaming(true);

    let contextBlock = '';
    if (openTabs && openTabs.length > 0) {
      contextBlock = openTabs
        .filter((t) => t.content && t.content.length > 0)
        .map((t) => `--- ${t.path} (${t.language}) ---\n${t.content}`)
        .join('\n\n');
    }

    let debugBlock = '';
    if (text.startsWith('/debug-project') && projectPath && isElectron()) {
      const allPaths: string[] = [];
      const walk = (nodes: FileNode[]) => {
        for (const n of nodes) {
          if (n.type === 'file') allPaths.push(n.path);
          if (n.children) walk(n.children);
        }
      };
      walk(fileTree ?? contextFiles);

      if (allPaths.length > 0) {
        const contents = await Promise.all(
          allPaths.map(async (p) => {
            const r = await readFile(p);
            return r.ok && r.content ? `--- ${p} ---\n${r.content}` : null;
          })
        );
        debugBlock = contents.filter(Boolean).join('\n\n');
      }
    }

    const chatModeGuidance = mode === 'chat'
      ? '\n\nYou are in Chat mode (no project is open). If the person just wants to read/copy code, answer with a plain ```language fence. Only if they clearly want a real file created or edited should you annotate the fence with its path, like ```tsx:src/App.tsx — that is what opens Programming Mode automatically, so use it sparingly and only when a file is genuinely being produced.'
      : '';

    const folderSummary = (projectPath && fileTree && fileTree.length > 0)
      ? `\n\nThe student has opened this project folder: ${projectPath}\nFolder structure:\n${buildFolderSummary(fileTree)}`
      : '';

    const projectInfo = projectPath && !folderSummary
      ? `\n\nThe student's project is open at: ${projectPath}`
      : '';

    const dynamicContext = folderSummary
      + projectInfo
      + (debugBlock ? `\n\nFull project files for debugging:\n${debugBlock}` : contextBlock ? `\n\nFiles currently open in the editor:\n${contextBlock}` : '')
      + chatModeGuidance
      + (memoryNotesRef.current ? `\n\n[User profile from past sessions: ${memoryNotesRef.current}]` : '');

    const systemContent = composeSystemPrompt(settings.basePrompt, settings.customInstructions, dynamicContext);

    const chatMessages = [
      { role: 'system' as const, content: systemContent },
      ...messages
        .filter((m) => (m.role === 'user' || m.role === 'assistant') && m.content.trim().length > 0 && !m.streaming)
        .map((m) => ({ role: m.role as 'user' | 'assistant', content: m.content })),
      { role: 'user' as const, content: userMsg.content },
    ];

    const ctrl = new AbortController();
    abortRef.current = ctrl;

    try {
      const stream = streamChat(settings.backend, {
        model: activeModel || 'demo',
        messages: chatMessages,
        temperature: settings.temperature,
        maxTokens: settings.maxTokens,
        topP: settings.topP,
        signal: ctrl.signal,
      });

      for await (const chunk of stream) {
        if (chunk.done) break;
        setMessages((prev) =>
          prev.map((m) =>
            m.id === assistantId ? { ...m, content: m.content + chunk.delta } : m,
          ),
        );
      }
    } catch (e) {
      const msg = e instanceof Error ? e.message : 'Stream failed';
      setMessages((prev) =>
        prev.map((m) =>
          m.id === assistantId
            ? { ...m, streaming: false, error: msg }
            : m,
        ),
      );
    } finally {
      setMessages((prev) =>
        prev.map((m) => (m.id === assistantId ? { ...m, streaming: false } : m)),
      );
      setIsStreaming(false);
      abortRef.current = null;
    }
  }, [input, isStreaming, contextFiles, fileTree, openTabs, settings, activeModel, setMessages, mode, projectPath, onRunCommand]);

  const handleStop = () => {
    abortRef.current?.abort();
    setIsStreaming(false);
  };

  const onKeyDown = (e: React.KeyboardEvent<HTMLTextAreaElement>) => {
    if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) {
      e.preventDefault();
      handleSend();
    }
    if (e.key === '/' && input === '') {
      setShowSlashMenu(true);
    }
    if (e.key === '@') {
      setShowMentionMenu(true);
    }
    if (e.key === 'Escape') {
      setShowSlashMenu(false);
      setShowMentionMenu(false);
    }
  };

  const insertSlash = (cmd: string) => {
    setInput(cmd + ' ');
    setShowSlashMenu(false);
    inputRef.current?.focus();
  };

  const insertMention = (path: string) => {
    setInput((prev) => prev.replace(/@$/, `@${path} `));
    setShowMentionMenu(false);
    inputRef.current?.focus();
  };

  const downloadAllGenerated = () => {
    const text = generatedFiles
      .map((f) => `// === ${f.name} ===\n${f.content}`)
      .join('\n\n');
    const blob = new Blob([text], { type: 'text/plain' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = 'generated-files.txt';
    a.click();
    URL.revokeObjectURL(url);
  };

  const handleLoadSession = useCallback(async (id: string) => {
    const result = await loadSession(id);
    if (result.ok && 'session' in result && result.session) {
      setMessages(result.session.messages.filter((m: ChatMessage) => !m.streaming));
      setSessionPinned(result.session.pinned ?? false);
    }
  }, [setMessages]);

  return (
    <div className="flex flex-col h-full bg-surface-1">
      {/* Header */}
      <div className="flex items-center justify-between px-3 py-2 border-b border-surface-3 flex-shrink-0">
        <div className="flex items-center gap-2">
          <MessageSquarePlus size={15} className="text-accent-400" />
          <span className="text-xs font-medium text-ink-high">Chat</span>
          {mode === 'chat' && (
            <span className="text-2xs px-1.5 py-0.5 rounded bg-surface-3 text-ink-low">casual</span>
          )}
          {messages.length > 0 && (
            <button
              onClick={onClearChat}
              className="ml-2 p-1 text-ink-low hover:text-error-400 rounded transition-colors"
              title="Clear conversation"
            >
              <Trash2 size={13} />
            </button>
          )}
        </div>
        <div className="flex items-center gap-1">
          {settings.autoSaveHistory && isElectron() && messages.length > 0 && (
            <button
              onClick={() => setSessionPinned((v) => !v)}
              title={sessionPinned ? 'Pinned — will never be auto-deleted. Click to unpin.' : 'Not pinned — will be auto-deleted after ' + (settings.retainDays ?? 15) + ' days. Click to pin.'}
              className="p-1.5 rounded transition-colors"
              style={{ color: sessionPinned ? 'var(--accent)' : 'var(--ink-low)' }}
            >
              {sessionPinned ? <Pin size={13} /> : <PinOff size={13} />}
            </button>
          )}
          {isElectron() && (
            <button
              onClick={() => setShowHistory(true)}
              title="Chat history"
              className="p-1.5 rounded transition-colors text-ink-low hover:text-ink-high"
            >
              <History size={13} />
            </button>
          )}
          <button
            onClick={() => setShowGenerated((v) => !v)}
            className="flex items-center gap-1 px-2 py-1 text-2xs text-ink-mid hover:text-ink-high hover:bg-surface-2 rounded transition-colors"
          >
            <FileCode2 size={12} />
            Generated ({generatedFiles.length})
          </button>
        </div>
      </div>

      {/* History panel */}
      <HistoryPanel
        open={showHistory}
        onClose={() => setShowHistory(false)}
        onLoadSession={handleLoadSession}
        currentSessionId={sessionId}
      />

      {/* Generated files panel (collapsible) */}
      {showGenerated && (
        <div className="border-b border-surface-3 bg-surface-2 px-3 py-2 max-h-40 overflow-y-auto animate-slide-up">
          <div className="flex items-center justify-between mb-2">
            <span className="text-2xs font-medium text-ink-mid uppercase tracking-wide">Generated Files</span>
            {generatedFiles.length > 0 && (
              <button
                onClick={downloadAllGenerated}
                className="flex items-center gap-1 text-2xs text-primary-400 hover:text-primary-300"
              >
                <Download size={11} />
                Download all
              </button>
            )}
          </div>
          {generatedFiles.length === 0 ? (
            <p className="text-2xs text-ink-low italic">No files generated yet.</p>
          ) : (
            <div className="space-y-1">
              {generatedFiles.map((f) => (
                <div key={f.id} className="flex items-center gap-2 text-2xs text-ink-mid">
                  <FileCode2 size={11} className="text-accent-400 flex-shrink-0" />
                  <span className="font-mono truncate">{f.name}</span>
                  <span className="text-ink-low">{new Date(f.timestamp).toLocaleTimeString()}</span>
                </div>
              ))}
            </div>
          )}
        </div>
      )}

      {/* Messages */}
      <div ref={scrollRef} className="flex-1 overflow-y-auto">
        {messages.length === 0 ? (
          <EmptyState onExample={(text) => handleSend(text)} mode={mode} />
        ) : (
          <div className="py-2">
            {messages.map((m) => (
              <MessageBubble
                key={m.id}
                message={m}
                onInsertCode={mode === 'programming' ? onInsertCode : undefined}
                onApplyDiff={mode === 'programming' ? onApplyDiff : undefined}
                onAddToProject={mode === 'programming' ? onAddToProject : undefined}
                onOpenInProgramming={mode === 'chat' ? onOpenInProgramming : undefined}
                onFilesWritten={onFilesWritten}
                onFilesDeleted={onFilesDeleted}
                fileTree={fileTree}
                lastUserPrompt={lastUserPrompt}
                onRequestPermission={handleRequestPermission}
              />
            ))}
          </div>
        )}
      </div>

      {/* Slash command menu */}
      {showSlashMenu && (
        <div className="border-t border-surface-3 bg-surface-2 px-2 py-2 max-h-48 overflow-y-auto animate-slide-up">
          <div className="text-2xs text-ink-low mb-1 flex items-center gap-1 px-1">
            <Slash size={10} /> Slash commands
          </div>
          {SLASH_COMMANDS.map((sc) => (
            <button
              key={sc.cmd}
              onClick={() => insertSlash(sc.cmd)}
              className="w-full flex items-center gap-2 px-2 py-1.5 rounded hover:bg-surface-3 transition-colors text-left"
            >
              <sc.icon size={13} className="text-accent-400 flex-shrink-0" />
              <span className="text-xs font-mono text-primary-400">{sc.cmd}</span>
              <span className="text-2xs text-ink-mid truncate">{sc.desc}</span>
            </button>
          ))}
        </div>
      )}

      {/* Mention menu */}
      {showMentionMenu && (
        <div className="border-t border-surface-3 bg-surface-2 px-2 py-2 max-h-40 overflow-y-auto animate-slide-up">
          <div className="text-2xs text-ink-low mb-1 flex items-center gap-1 px-1">
            <AtSign size={10} /> Mention a file
          </div>
          {contextFiles.map((f) => (
            <button
              key={f.path}
              onClick={() => insertMention(f.path)}
              className="w-full flex items-center gap-2 px-2 py-1.5 rounded hover:bg-surface-3 transition-colors text-left"
            >
              <FileCode2 size={13} className="text-ink-mid flex-shrink-0" />
              <span className="text-xs font-mono text-ink-high">{f.path}</span>
            </button>
          ))}
        </div>
      )}

      {/* Input area */}
      <div className="p-3 border-t border-surface-3 flex-shrink-0">
        {/* Pasted image previews */}
        {pastedImages.length > 0 && (
          <div className="flex gap-2 mb-2 flex-wrap">
            {pastedImages.map((img, i) => (
              <div key={i} className="relative group">
                <img src={img} alt="pasted" className="h-16 w-16 object-cover rounded-lg border border-surface-3" />
                <button
                  onClick={() => setPastedImages(prev => prev.filter((_, j) => j !== i))}
                  className="absolute -top-1.5 -right-1.5 w-4 h-4 rounded-full bg-error-600 text-white text-[10px] flex items-center justify-center opacity-0 group-hover:opacity-100 transition-opacity"
                >
                  ×
                </button>
              </div>
            ))}
          </div>
        )}

        {/* Input wrapper — relative so the dialog can anchor to it */}
        <div className="relative">

          {/* ── Permission dialog — floats above the input box ───────────── */}
          {activePermission && (
            <div
              style={{
                position: 'absolute',
                bottom: '100%',
                left: 0,
                right: 0,
                marginBottom: '8px',
                display: 'flex',
                alignItems: 'center',
                justifyContent: 'space-between',
                padding: '8px 14px',
                background: 'var(--surface-2)',
                border: '1px solid var(--s4)',
                borderRadius: '10px',
                fontSize: '12px',
                gap: '10px',
                boxShadow: '0 2px 12px rgba(0,0,0,0.25)',
                zIndex: 50,
              }}
            >
              <span style={{ color: 'var(--ink-mid)', flex: 1 }}>
                User response is needed for this action
                {permissionQueue.length > 1 && (
                  <span style={{ color: 'var(--ink-low)' }}> · {permissionQueue.length - 1} more waiting</span>
                )}
              </span>
              <div style={{ display: 'flex', gap: '6px', flexShrink: 0 }}>
                <button
                  onClick={() => resolveActivePermission('deny')}
                  style={{
                    padding: '4px 12px',
                    borderRadius: '6px',
                    border: '1px solid var(--error-400)',
                    color: 'var(--error-400)',
                    background: 'transparent',
                    cursor: 'pointer',
                    fontSize: '12px',
                  }}
                >
                  Deny
                </button>
                <button
                  onClick={() => resolveActivePermission('proceed')}
                  style={{
                    padding: '4px 12px',
                    borderRadius: '6px',
                    border: 'none',
                    background: 'var(--primary-500)',
                    color: 'white',
                    cursor: 'pointer',
                    fontSize: '12px',
                  }}
                >
                  Proceed
                </button>
              </div>
            </div>
          )}

          {/* Textarea + send button */}
          <div className="relative bg-surface-2 border border-surface-3 rounded-lg focus-within:border-primary-500 transition-colors">
            <textarea
              ref={inputRef}
              value={input}
              onChange={(e) => setInput(e.target.value)}
              onKeyDown={onKeyDown}
              onPaste={handlePaste}
              placeholder="Ask SenCode… (Ctrl+Enter to send, / for commands, @ to mention files, paste images)"
              className="w-full bg-transparent text-[13px] text-ink-high placeholder-ink-low px-3 py-2.5 pr-12 resize-none outline-none min-h-[44px] max-h-32 leading-relaxed"
              rows={2}
            />
            {isStreaming ? (
              <button
                onClick={handleStop}
                className="absolute right-2 bottom-2 p-2 bg-error-500 hover:bg-error-600 rounded-lg transition-colors"
                title="Stop generating"
              >
                <Square size={14} className="text-white" fill="white" />
              </button>
            ) : (
              <button
                onClick={() => handleSend()}
                disabled={!input.trim()}
                className="absolute right-2 bottom-2 p-2 bg-primary-600 hover:bg-primary-500 disabled:opacity-30 disabled:cursor-not-allowed rounded-lg transition-colors"
                title="Send (Ctrl+Enter)"
              >
                <Send size={14} className="text-white" />
              </button>
            )}
          </div>
        </div>

        <div className="flex items-center justify-between mt-1.5 px-1">
          <span className="text-2xs text-ink-low">
            {activeModel || 'none'} · temp {settings.temperature}
          </span>
        </div>
      </div>
    </div>
  );
}

/** Empty-state onboarding shown when no messages exist yet. */
function EmptyState({ onExample, mode }: { onExample: (text: string) => void; mode: AppMode }) {
  const examples = [
    { label: 'Explain code', text: '/explain how this function works' },
    { label: 'Write unit tests', text: '/test write unit tests for my code' },
    { label: 'Refactor code', text: '/refactor this code to be cleaner' },
    { label: 'Debug an error', text: '/debug I am getting a TypeError, help me fix it' },
  ];

  return (
    <div className="flex flex-col items-center justify-center h-full px-6 py-8 text-center">
      <div className="w-12 h-12 rounded-xl bg-gradient-to-br from-primary-500 to-accent-500 flex items-center justify-center mb-4">
        <Sparkles size={24} className="text-white" />
      </div>
      <h2 className="text-base font-semibold text-ink-high mb-1">
        {mode === 'chat' ? 'Just here to talk it through' : 'Start chatting with SenCode'}
      </h2>
      <p className="text-xs text-ink-mid mb-6 max-w-xs">
        {mode === 'chat'
          ? 'Ask anything — code you get back is copy/paste-ready. Drop a file or folder in, or ask for a real project file, and Programming Mode opens automatically.'
          : 'Your free, local AI coding assistant. Ask about your code, generate tests, refactor, or debug.'}
      </p>
      <div className="grid grid-cols-1 gap-2 w-full max-w-xs">
        {examples.map((ex) => (
          <button
            key={ex.label}
            onClick={() => onExample(ex.text)}
            className="flex items-center gap-2 px-3 py-2 bg-surface-2 hover:bg-surface-3 border border-surface-3 hover:border-surface-4 rounded-lg text-left transition-all group"
          >
            <Zap size={13} className="text-accent-400 group-hover:scale-110 transition-transform" />
            <div className="min-w-0">
              <div className="text-xs font-medium text-ink-high">{ex.label}</div>
              <div className="text-2xs text-ink-low truncate font-mono">{ex.text}</div>
            </div>
          </button>
        ))}
      </div>
    </div>
  );
}
