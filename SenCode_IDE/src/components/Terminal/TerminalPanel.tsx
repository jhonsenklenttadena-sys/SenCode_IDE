/**
 * TerminalPanel — tabbed terminal system.
 * Each run opens its own tab. Tabs can be created, switched, and closed.
 * Per-tab state: lines, history, input, running processes.
 */

import { useState, useRef, useEffect, useCallback, useImperativeHandle, forwardRef } from 'react';
import {
  Terminal as TerminalIcon, AlertTriangle, Bot,
  Square, Loader2, Plus, X as XIcon,
} from 'lucide-react';
import { isElectron } from '../../lib/electronBridge';

interface TerminalLine {
  type: 'input' | 'output' | 'error' | 'system';
  text: string;
  aiSuggested?: boolean;
  pid?: number;
}

interface RunningProcess {
  pid: number;
  command: string;
}

const DESTRUCTIVE = [
  'rm -', 'rm /', 'del /f', 'del /s', 'format', 'rmdir /s',
  'git push --force', 'git reset --hard', 'git clean -fd',
  'drop table', 'drop database',
];

interface TerminalTabState {
  id: string;
  label: string;
  lines: TerminalLine[];
  history: string[];
  histIdx: number;
  inputText: string;
  isAiSuggested: boolean;
  running: RunningProcess[];
  isRunning: boolean;
}

function makeTab(id: string, label: string, welcome = true): TerminalTabState {
  return {
    id, label,
    lines: welcome ? [{ type: 'system', text: 'SenCode Terminal — click here and type to run commands' }] : [],
    history: [], histIdx: -1, inputText: '', isAiSuggested: false,
    running: [], isRunning: false,
  };
}

export interface TerminalHandle {
  execute: (cmd: string, tabId?: string) => void;
  openTabAndExecute: (label: string, cmd: string) => void;
  onProcessExit: (cb: (exitCode: number) => void) => () => void;
}

interface TerminalPanelProps {
  cwd: string;
  onPreviewUrl?: (url: string) => void;
  onMissingRuntime?: (lang: string) => void;
}

const bridge = () => (window as any).electronAPI;
const uid = () => Math.random().toString(36).slice(2, 10);

export const TerminalPanel = forwardRef<TerminalHandle, TerminalPanelProps>(
  function TerminalPanel({ cwd, onPreviewUrl, onMissingRuntime }, ref) {

  const [tabs, setTabs]           = useState<TerminalTabState[]>(() => [makeTab(uid(), 'Terminal 1')]);
  const [activeTabId, setActiveTabId] = useState<string>(() => {
    const id = uid();
    return id;
  });
  const [confirm, setConfirm]     = useState<{ cmd: string; ai: boolean; tabId: string } | null>(null);
  const [focused, setFocused]     = useState(false);
  const [cursorOn, setCursorOn]   = useState(true);

  const scrollRefs  = useRef<Record<string, HTMLDivElement | null>>({});
  const containerRef = useRef<HTMLDivElement>(null);
  const processExitListeners = useRef<((code: number) => void)[]>([]);
  const pidToTabId = useRef<Map<number, string>>(new Map());

  useEffect(() => {
    const iv = setInterval(() => setCursorOn(v => !v), 530);
    return () => clearInterval(iv);
  }, []);

  const activeTab = tabs.find(t => t.id === activeTabId) ?? tabs[0];

  useEffect(() => {
    const el = scrollRefs.current[activeTabId];
    if (el) el.scrollTop = el.scrollHeight;
  }, [activeTab?.lines, activeTab?.inputText, activeTabId]);

  const updateTab = useCallback((tabId: string, updater: (t: TerminalTabState) => TerminalTabState) => {
    setTabs(prev => prev.map(t => t.id === tabId ? updater(t) : t));
  }, []);

  const addLineToTab = useCallback((tabId: string, line: TerminalLine) => {
    updateTab(tabId, t => ({ ...t, lines: [...t.lines, line] }));
  }, [updateTab]);

  useEffect(() => {
    if (!isElectron()) return;
    const unsub = bridge().onProcessOutput((data: { pid: number; type: string; text: string }) => {
      const tabId = pidToTabId.current.get(data.pid) ?? activeTabId;
      updateTab(tabId, t => ({
        ...t,
        lines: [...t.lines, { type: data.type as TerminalLine['type'], text: data.text.trimEnd(), pid: data.pid }],
      }));
      const urlMatch = data.text.match(/https?:\/\/localhost:\d+/);
      if (urlMatch && onPreviewUrl) onPreviewUrl(urlMatch[0]);
      if (data.type === 'system' && data.text.includes('Process exited')) {
        pidToTabId.current.delete(data.pid);
        updateTab(tabId, t => ({
          ...t,
          running: t.running.filter(p => p.pid !== data.pid),
          isRunning: t.running.filter(p => p.pid !== data.pid).length > 0,
        }));
        const match = data.text.match(/code\s+(-?\d+)/);
        const code = match ? parseInt(match[1], 10) : 0;
        processExitListeners.current.forEach(cb => cb(code));
      }
    });
    return () => unsub();
  }, [onPreviewUrl, activeTabId, updateTab]);

  const doExecute = useCallback(async (cmd: string, tabId: string, aiSuggested = false) => {
    if (!cmd.trim()) return;
    addLineToTab(tabId, { type: 'input', text: `${cwd} $ ${cmd}`, aiSuggested });
    updateTab(tabId, t => ({
      ...t,
      history: [...t.history, cmd],
      histIdx: -1,
      inputText: '',
      isAiSuggested: false,
    }));

    if (!isElectron()) {
      addLineToTab(tabId, { type: 'system', text: '[Terminal not available in browser]' });
      return;
    }

    const lower = cmd.toLowerCase();
    if (lower === 'clear' || lower === 'cls') {
      updateTab(tabId, t => ({ ...t, lines: [] }));
      return;
    }

    const isDestructive = DESTRUCTIVE.some(p => lower.includes(p));
    if (isDestructive) {
      setConfirm({ cmd, ai: aiSuggested, tabId });
      return;
    }

    updateTab(tabId, t => ({ ...t, isRunning: true }));

    try {
      const result = await bridge().spawnProcess(cmd, cwd);
      if (result?.ok && result.pid) {
        pidToTabId.current.set(result.pid, tabId);
        updateTab(tabId, t => ({
          ...t,
          running: [...t.running, { pid: result.pid, command: cmd }],
        }));
      } else {
        addLineToTab(tabId, { type: 'error', text: result?.stderr || 'Failed to start process' });
        updateTab(tabId, t => ({ ...t, isRunning: false }));

        const missingMatch = (result?.stderr || '').match(/is not recognized|not found|command not found|'(.+)' is not/i);
        if (missingMatch && onMissingRuntime) {
          const raw = cmd.trim().split(/\s+/)[0].toLowerCase();
          const lang =
            raw.includes('python') || raw.includes('py') ? 'python' :
            raw.includes('node') ? 'nodejs' :
            raw.includes('java') ? 'java' :
            raw.includes('rustc') || raw.includes('cargo') ? 'rust' :
            raw.includes('go') ? 'golang' :
            raw.includes('dart') ? 'dart' :
            null;
          if (lang) onMissingRuntime(lang);
        }
      }
    } catch (e: any) {
      addLineToTab(tabId, { type: 'error', text: e.message ?? 'Execution error' });
      updateTab(tabId, t => ({ ...t, isRunning: false }));
    }
  }, [cwd, addLineToTab, updateTab, onMissingRuntime]);

  const killActiveProcesses = useCallback((tabId: string) => {
    const tab = tabs.find(t => t.id === tabId);
    if (!tab || !isElectron()) return;
    tab.running.forEach(p => bridge().killProcess(p.pid));
    updateTab(tabId, t => ({ ...t, running: [], isRunning: false }));
  }, [tabs, updateTab]);

  useImperativeHandle(ref, () => ({
    execute: (cmd: string, tabId?: string) => {
      const targetId = tabId ?? activeTabId;
      doExecute(cmd, targetId);
    },
    openTabAndExecute: (label: string, cmd: string) => {
      const id = uid();
      setTabs(prev => [...prev, makeTab(id, label, false)]);
      setActiveTabId(id);
      setTimeout(() => doExecute(cmd, id), 50);
    },
    onProcessExit: (cb) => {
      processExitListeners.current.push(cb);
      return () => {
        processExitListeners.current = processExitListeners.current.filter(l => l !== cb);
      };
    },
  }), [activeTabId, doExecute]);

  const handleKey = useCallback((e: React.KeyboardEvent) => {
    const tab = tabs.find(t => t.id === activeTabId);
    if (!tab) return;

    if (e.key === 'Enter') {
      e.preventDefault();
      doExecute(tab.inputText, activeTabId, tab.isAiSuggested);
      return;
    }
    if (e.key === 'ArrowUp') {
      e.preventDefault();
      const nextIdx = tab.histIdx < tab.history.length - 1 ? tab.histIdx + 1 : tab.histIdx;
      updateTab(activeTabId, t => ({
        ...t, histIdx: nextIdx,
        inputText: nextIdx >= 0 ? t.history[t.history.length - 1 - nextIdx] : '',
      }));
      return;
    }
    if (e.key === 'ArrowDown') {
      e.preventDefault();
      const nextIdx = tab.histIdx > 0 ? tab.histIdx - 1 : -1;
      updateTab(activeTabId, t => ({
        ...t, histIdx: nextIdx,
        inputText: nextIdx >= 0 ? t.history[t.history.length - 1 - nextIdx] : '',
      }));
      return;
    }
    if (e.key === 'c' && (e.ctrlKey || e.metaKey)) {
      e.preventDefault();
      killActiveProcesses(activeTabId);
      addLineToTab(activeTabId, { type: 'system', text: '^C' });
      return;
    }
    if (e.key === 'l' && (e.ctrlKey || e.metaKey)) {
      e.preventDefault();
      updateTab(activeTabId, t => ({ ...t, lines: [] }));
      return;
    }
  }, [tabs, activeTabId, doExecute, updateTab, killActiveProcesses, addLineToTab]);

  const handleInput = useCallback((e: React.FormEvent<HTMLDivElement>) => {
    updateTab(activeTabId, t => ({ ...t, inputText: (e.target as HTMLDivElement).innerText }));
  }, [activeTabId, updateTab]);

  const addTab = useCallback(() => {
    const id = uid();
    const label = `Terminal ${tabs.length + 1}`;
    setTabs(prev => [...prev, makeTab(id, label)]);
    setActiveTabId(id);
  }, [tabs.length]);

  const closeTab = useCallback((id: string, e: React.MouseEvent) => {
    e.stopPropagation();
    setTabs(prev => {
      const filtered = prev.filter(t => t.id !== id);
      if (filtered.length === 0) {
        const newId = uid();
        setActiveTabId(newId);
        return [makeTab(newId, 'Terminal 1')];
      }
      if (activeTabId === id) {
        setActiveTabId(filtered[filtered.length - 1].id);
      }
      return filtered;
    });
  }, [activeTabId]);

  const tab = activeTab;

  return (
    <div className="flex flex-col h-full bg-surface-0 text-xs font-mono" ref={containerRef}>

      {/* Tab bar */}
      <div className="flex items-center gap-0 bg-surface-1 border-b border-surface-3 flex-shrink-0 overflow-x-auto" style={{ scrollbarWidth: 'none' }}>
        {tabs.map(t => (
          <button key={t.id} onClick={() => setActiveTabId(t.id)}
            className={`flex items-center gap-1.5 px-3 py-1.5 text-2xs border-r border-surface-3 transition-colors flex-shrink-0 group ${
              t.id === activeTabId
                ? 'bg-surface-0 text-ink-high border-b border-b-primary-500'
                : 'text-ink-low hover:text-ink-mid hover:bg-surface-2'
            }`}>
            <TerminalIcon size={10} className={t.id === activeTabId ? 'text-primary-400' : 'text-ink-low'} />
            <span className="max-w-[120px] truncate">{t.label}</span>
            {t.isRunning && <Loader2 size={8} className="animate-spin text-primary-400 flex-shrink-0" />}
            {tabs.length > 1 && (
              <span onClick={(e) => closeTab(t.id, e)}
                className="opacity-0 group-hover:opacity-100 hover:text-error-400 transition-all flex-shrink-0 ml-0.5 p-0.5 rounded">
                <XIcon size={9} />
              </span>
            )}
          </button>
        ))}
        <button onClick={addTab} title="New terminal tab"
          className="px-2 py-1.5 text-ink-low hover:text-ink-high hover:bg-surface-2 transition-colors flex-shrink-0">
          <Plus size={11} />
        </button>
        <div className="flex-1" />
        {tab?.isRunning && (
          <button onClick={() => killActiveProcesses(activeTabId)}
            title="Kill process (Ctrl+C)"
            className="flex items-center gap-1 px-2 py-1 mr-1 text-2xs text-error-400 hover:bg-error-600/10 rounded transition-colors flex-shrink-0">
            <Square size={9} /> Kill
          </button>
        )}
      </div>

      {/* Output area */}
      <div
        ref={el => { scrollRefs.current[activeTabId] = el; }}
        className="flex-1 overflow-y-auto px-3 py-2 space-y-0.5 cursor-text"
        onClick={() => containerRef.current?.focus()}
        tabIndex={0}
        onFocus={() => setFocused(true)}
        onBlur={() => setFocused(false)}
        onKeyDown={handleKey}
      >
        {tab?.lines.map((line, i) => (
          <div key={i} className={`leading-relaxed whitespace-pre-wrap break-all ${
            line.type === 'input'  ? 'text-primary-300' :
            line.type === 'error'  ? 'text-error-400' :
            line.type === 'system' ? 'text-ink-low italic' :
            'text-ink-mid'
          }`}>
            {line.aiSuggested && (
              <span className="inline-flex items-center gap-0.5 mr-1.5 px-1.5 py-0.5 bg-accent-600 text-white rounded text-2xs font-medium flex-shrink-0">
                <Bot size={9} /> AI
              </span>
            )}
            {line.text}
          </div>
        ))}

        {/* Input line */}
        <div className="flex items-center gap-1 leading-relaxed text-success-400">
          <span className="text-success-500 mr-1.5 flex-shrink-0">$</span>
          <div
            contentEditable
            suppressContentEditableWarning
            onInput={handleInput}
            onKeyDown={handleKey}
            onFocus={() => setFocused(true)}
            onBlur={() => setFocused(false)}
            className="flex-1 outline-none break-all"
            style={{ minWidth: 0 }}
          />
          <span
            className="inline-block w-[7px] h-[13px] ml-px flex-shrink-0 align-middle"
            style={{
              background: focused ? (cursorOn ? 'var(--accent)' : 'transparent') : 'transparent',
              border: focused ? 'none' : '1px solid var(--ink-low)',
              opacity: focused ? 1 : 0.3,
            }}
          />
        </div>
      </div>

      {confirm && (
        <div className="fixed inset-0 bg-black/50 flex items-center justify-center z-50 animate-fade-in">
          <div className="bg-surface-1 border border-error-500/40 rounded-xl p-5 max-w-sm w-full mx-4 shadow-2xl">
            <div className="flex items-start gap-3 mb-4">
              <div className="w-9 h-9 rounded-lg bg-error-500/15 flex items-center justify-center flex-shrink-0">
                <AlertTriangle size={16} className="text-error-400" />
              </div>
              <div>
                <h3 className="text-sm font-semibold text-ink-high mb-1">Destructive command</h3>
                <p className="text-2xs text-ink-mid mb-2">This can permanently delete files or data.</p>
                <code className="block bg-surface-2 border border-surface-3 rounded px-2 py-1.5 text-xs font-mono text-error-400 break-all">{confirm.cmd}</code>
              </div>
            </div>
            <div className="flex gap-2 justify-end">
              <button onClick={() => setConfirm(null)}
                className="px-3 py-1.5 text-2xs text-ink-mid hover:text-ink-high rounded transition-colors">
                Cancel
              </button>
              <button onClick={() => { doExecute(confirm.cmd, confirm.tabId, confirm.ai); setConfirm(null); }}
                className="px-3 py-1.5 text-2xs font-medium text-white bg-error-600 hover:bg-error-500 rounded transition-colors">
                Run anyway
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
});
