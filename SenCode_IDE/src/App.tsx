/**
 * CodeForge — Personal Free AI Coding Assistant.
 * Three-pane IDE layout: file tree | editor | chat.
 */

import { useState, useEffect, useCallback, useRef } from 'react';
import {
  FolderTree, GitBranch, Sparkles, FolderOpen, FolderPlus, FilePlus,
  Code2, MessageCircle, Terminal, Package, Zap,
  Send, UploadCloud,
} from 'lucide-react';
import { TopBar } from './components/TopBar';
import { LicensePanel } from './components/License/LicensePanel';
import { ChatPanel } from './components/Chat/ChatPanel';
import { FileTree, countContextFiles } from './components/FileTree/FileTree';
import { GitPanel } from './components/GitPanel/GitPanel';
import { EditorArea } from './components/Editor/EditorArea';
import { TerminalPanel, type TerminalHandle } from './components/Terminal/TerminalPanel';
import { SettingsPanel } from './components/Settings/SettingsPanel';
import { RuntimeLibrary } from './components/RuntimeLibrary';
import { NewProjectWizard } from './components/NewProjectWizard';
import { SplashScreen } from './components/SplashScreen';
import { ProcessingOverlay } from './components/ProcessingOverlay';
import { checkConnection, autoDetectBackend, STARTUP_TIMEOUT } from './lib/aiClient';
import { loadSettings, saveSettings } from './lib/storage';
import { EMPTY_TREE, isSensitiveFile } from './lib/demoProject';
import { parseBlocks } from './lib/markdown';
import {
  isElectron,
  getInitialBackendStatus,
  subscribeBackendStatus,
  subscribeHardwareInfo,
  checkModelSuitability,
  restartBackend,
  saveWorkspace,
  loadWorkspace,
  type BackendStatus,
} from './lib/electronBridge';
import { runCleanup } from './lib/sessionBridge';
import * as fsGateway from './lib/fsGateway';
import type {
  ChatMessage, FileNode, EditorTab, GeneratedFile, Settings, ModelInfo, AppMode, HardwareInfo,
} from './lib/types';
import { detectLanguage, LANG_EXT } from './lib/types';
import {
  hasFileExtension,
  resolvePathAfterDetection,
} from './lib/detectSyntax';

const uid = () => Math.random().toString(36).slice(2, 10);

function findFirstFile(nodes: FileNode[]): FileNode | null {
  for (const n of nodes) {
    if (n.type === 'file') return n;
    if (n.children) { const f = findFirstFile(n.children); if (f) return f; }
  }
  return null;
}

type SidebarTab = 'files' | 'git' | 'runtimes';

// ── Source-file extension set used for drag-drop routing ──────────────────────
const SOURCE_EXTS = new Set([
  'js', 'jsx', 'ts', 'tsx', 'mjs', 'cjs',
  'py', 'pyw',
  'java',
  'c', 'cc', 'cpp', 'cxx', 'h', 'hpp', 'hxx',
  'cs',
  'go',
  'rs',
  'rb',
  'php',
  'swift',
  'kt', 'kts',
  'dart',
  'lua',
  'sh', 'bash', 'zsh', 'fish',
  'vue', 'svelte', 'elm',
  'ex', 'exs',
  'clj', 'cljs',
  'scala',
  'groovy',
  'pl', 'pm',
  'jl',
  'nim',
  'zig',
  'r',
]);

/**
 * Parse a ZIP file's central directory (binary) to find filenames, then check
 * whether any of them carry a source-code extension.
 * Uses the EOCD record so we only scan the directory, not the compressed data.
 */
async function hasSourceFilesInZip(file: File): Promise<boolean> {
  try {
    const buf = await file.arrayBuffer();
    const u8 = new Uint8Array(buf);
    const dv = new DataView(buf);

    // Find End-Of-Central-Directory record (signature 0x504B0506) from the end.
    // Max comment length is 65535, so we search the last 65558 bytes.
    let eocdOff = -1;
    const searchFrom = Math.max(0, u8.length - 65558);
    for (let i = u8.length - 22; i >= searchFrom; i--) {
      if (
        u8[i] === 0x50 && u8[i + 1] === 0x4b &&
        u8[i + 2] === 0x05 && u8[i + 3] === 0x06
      ) {
        eocdOff = i;
        break;
      }
    }
    if (eocdOff < 0) return false; // not a valid zip

    const cdEntries = dv.getUint16(eocdOff + 10, true);
    let cdOffset  = dv.getUint32(eocdOff + 16, true);
    const dec = new TextDecoder('utf-8', { fatal: false });

    for (let e = 0; e < cdEntries; e++) {
      if (cdOffset + 46 > u8.length) break;
      // Central directory file header signature: 0x504B0102
      if (
        u8[cdOffset] !== 0x50 || u8[cdOffset + 1] !== 0x4b ||
        u8[cdOffset + 2] !== 0x01 || u8[cdOffset + 3] !== 0x02
      ) break;

      const fnLen      = dv.getUint16(cdOffset + 28, true);
      const extraLen   = dv.getUint16(cdOffset + 30, true);
      const commentLen = dv.getUint16(cdOffset + 32, true);

      if (fnLen > 0 && cdOffset + 46 + fnLen <= u8.length) {
        const fname = dec.decode(u8.slice(cdOffset + 46, cdOffset + 46 + fnLen));
        const ext   = fname.split('.').pop()?.toLowerCase() ?? '';
        if (SOURCE_EXTS.has(ext)) return true;
      }

      cdOffset += 46 + fnLen + extraLen + commentLen;
    }
  } catch {
    // Ignore parse errors — treat as no source files
  }
  return false;
}

/** Walk a FileNode tree and return true if any file has a source-code extension. */
function treeHasSourceFiles(nodes: FileNode[]): boolean {
  for (const n of nodes) {
    if (n.type === 'file') {
      const ext = n.name.split('.').pop()?.toLowerCase() ?? '';
      if (SOURCE_EXTS.has(ext)) return true;
    }
    if (n.children && treeHasSourceFiles(n.children)) return true;
  }
  return false;
}

function App() {
  // ── Settings + connection ─────────────────────────────────────────────────
  const [settings, setSettings]         = useState<Settings>(() => loadSettings());
  const [settingsOpen, setSettingsOpen]     = useState(false);
  const [licenseOpen, setLicenseOpen]       = useState(false);
  const [graceDaysLeft, setGraceDaysLeft]   = useState<number | null>(null);
  // const [runtimeLibOpen, setRuntimeLibOpen] = useState(false); // Unused after merge
  const [missingRuntimeId, setMissingRuntimeId] = useState<string | null>(null);
  const [connected, setConnected]       = useState(false);
  const [models, setModels]             = useState<ModelInfo[]>([]);
  const [activeModel, setActiveModel]   = useState('');
  const activeModelRef = useRef('');
  useEffect(() => { activeModelRef.current = activeModel; }, [activeModel]);
  const [backendLaunch, setBackendLaunch] = useState<BackendStatus>({ state: 'idle' });
  const [hardwareInfo, setHardwareInfo]   = useState<HardwareInfo | null>(null);

  // ── Chat ──────────────────────────────────────────────────────────────────
  const [messages, setMessages] = useState<ChatMessage[]>([]);

  // ── Mode: launcher (pick screen) | programming (full IDE) | chat (casual) ──
  const [mode, setMode] = useState<AppMode>('launcher');
  const modeRef = useRef<AppMode>('launcher');
  useEffect(() => { modeRef.current = mode; }, [mode]);
  const autoOpenedRef = useRef<Set<string>>(new Set());

  // ── Project ───────────────────────────────────────────────────────────────
  const [projectPath, setProjectPath] = useState<string>('');
  const [fileTree, setFileTree]       = useState<FileNode[]>(EMPTY_TREE);

  // ── Editor ────────────────────────────────────────────────────────────────
  const [tabs, setTabs]             = useState<EditorTab[]>([]);
  const [activeTabId, setActiveTabId] = useState<string | null>(null);

  // ── Terminal ──────────────────────────────────────────────────────────────
  const [showTerminal, setShowTerminal]   = useState(false);
  // const [pendingCommand, setPendingCommand] = useState<string | null>(null); // Unused after merge
  const [previewUrl, setPreviewUrl]       = useState<string | null>(null);
  const terminalRef = useRef<TerminalHandle>(null);

  /** Run a command in the terminal — shows the terminal and executes immediately. */
  const runInTerminal = useCallback((cmd: string, label?: string) => {
    setShowTerminal(true);
    if (label && cmd !== '__stop__') {
      terminalRef.current?.openTabAndExecute(label, cmd);
    } else {
      terminalRef.current?.execute(cmd);
    }
  }, []);

  // ── Generated files ───────────────────────────────────────────────────────
  const [generatedFiles, setGeneratedFiles] = useState<GeneratedFile[]>([]);

  // ── Sidebar ───────────────────────────────────────────────────────────────
  const [sidebarTab, setSidebarTab] = useState<SidebarTab>('files');
  const [newFilePrompt, setNewFilePrompt] = useState(false);
  const [newFileName, setNewFileName] = useState('');
  const newFileInputRef = useRef<HTMLInputElement>(null);
  // Root-level new-folder inline prompt (mirroring newFilePrompt)
  const [newFolderPrompt, setNewFolderPrompt]     = useState(false);
  const [newFolderName, setNewFolderName]         = useState('');
  const [newFolderError, setNewFolderError]       = useState<string | null>(null);
  const [newFolderBusy, setNewFolderBusy]         = useState(false);
  const newFolderInputRef = useRef<HTMLInputElement>(null);

  // ── Pane widths ───────────────────────────────────────────────────────────
  const [sidebarWidth, setSidebarWidth] = useState(240);
  const [chatWidth, setChatWidth]       = useState(380);
  const dragRef = useRef<{ side: 'left' | 'right'; startX: number; startW: number } | null>(null);

  // ── Toast ─────────────────────────────────────────────────────────────────
  const [toast, setToast] = useState<string | null>(null);

  // ── Loading states ────────────────────────────────────────────────────────
  /** True while the app is starting up (workspace restore + backend init) */
  const [appReady, setAppReady]             = useState(false);
  const [showNewProject, setShowNewProject] = useState(false);
  /** True while a heavy foreground operation is running (save, folder open…) */
  const [processing, setProcessing]         = useState(false);
  const [processingMsg, setProcessingMsg]   = useState<string | undefined>();

  /** Stable helper — show the processing overlay with an optional message */
  const withProcessing = useCallback(async <T,>(fn: () => Promise<T>, msg?: string): Promise<T> => {
    setProcessingMsg(msg);
    setProcessing(true);
    try { return await fn(); }
    finally { setProcessing(false); setProcessingMsg(undefined); }
  }, []);

  // ── Extension install: restart prompt + countdown ────────────────────────
  const RELOAD_SECS = 10;
  const [reloadCountdown, setReloadCountdown] = useState<number | null>(null);
  const [reloadName, setReloadName]           = useState<string>('');
  const [showRestartPrompt, setShowRestartPrompt] = useState(false);
  const pendingRestartName = useRef<string>('');

  /** Called by RuntimeLibrary when installation is confirmed done.
   *  Shows a prompt — user chooses restart now (10s countdown) or later. */
  const triggerExtensionReload = useCallback((name: string) => {
    pendingRestartName.current = name;
    setShowRestartPrompt(true);
  }, []);

  const confirmRestart = useCallback(() => {
    setShowRestartPrompt(false);
    const name = pendingRestartName.current;
    setReloadName(name);
    setReloadCountdown(RELOAD_SECS);
    let remaining = RELOAD_SECS;
    const tick = setInterval(() => {
      remaining -= 1;
      setReloadCountdown(remaining);
      if (remaining <= 0) {
        clearInterval(tick);
        setReloadCountdown(null);
        setReloadName('');
        (window as any).electronAPI?.detectRuntimes?.();
      }
    }, 1000);
  }, []);

  const declineRestart = useCallback(() => {
    setShowRestartPrompt(false);
    // Refresh the runtime list silently so the installed badge updates
    (window as any).electronAPI?.detectRuntimes?.();
    setToast('Changes will be fully active on next app launch.');
    setTimeout(() => setToast(null), 3000);
  }, []);
  const showToast = useCallback((msg: string) => {
    setToast(msg);
    setTimeout(() => setToast(null), 2500);
  }, []);

  // ── Load grace-period days on startup (drives the shield indicator) ────────
  useEffect(() => {
    const api = (window as any).electronAPI;
    if (!api?.getLicenseInfo) return;
    api.getLicenseInfo().then((info: any) => {
      if (info?.isInGrace && typeof info.graceRemaining === 'number') {
        setGraceDaysLeft(info.graceRemaining);
      } else {
        setGraceDaysLeft(null);
      }
    }).catch(() => {});
  }, []);

  // ── Persist settings ──────────────────────────────────────────────────────
  useEffect(() => { saveSettings(settings); }, [settings]);

  // ── Apply theme class to <html> ───────────────────────────────────────────
  useEffect(() => {
    const html = document.documentElement;
    // Remove any existing theme class
    html.classList.forEach((cls) => { if (cls.startsWith('theme-')) html.classList.remove(cls); });
    html.classList.add(`theme-${settings.theme ?? 'midnight'}`);
  }, [settings.theme]);

  // ── Restore workspace on startup ─────────────────────────────────────────
  useEffect(() => {
    if (!isElectron()) { setAppReady(true); return; }
    loadWorkspace().then((ws) => {
      if (!ws) { setAppReady(true); return; }
      if (ws.projectPath) {
        setProjectPath(ws.projectPath);
        fsGateway.refreshFolder(ws.projectPath, []).then((res) => {
          if (res.ok) setFileTree(res.tree);
          setAppReady(true);
        });
      } else {
        setAppReady(true);
      }
      if (ws.tabs && ws.tabs.length > 0) {
        setTabs(ws.tabs as EditorTab[]);
        setActiveTabId(ws.activeTabId);
        if (ws.mode === 'programming' || ws.mode === 'chat') setMode(ws.mode as AppMode);
        else setMode('programming');
      }
    });
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // ── Save workspace whenever tabs/path/mode change ────────────────────────
  useEffect(() => {
    if (!isElectron()) return;
    // Debounce — only save 2s after last change
    const t = setTimeout(() => {
      saveWorkspace({ projectPath, tabs, activeTabId, mode });
    }, 2000);
    return () => clearTimeout(t);
  }, [projectPath, tabs, activeTabId, mode]);

  // ── Connection polling ────────────────────────────────────────────────────
  const refreshConnection = useCallback(async (autoSelectedId?: string) => {
    const result = await checkConnection(settings.backend);
    setConnected(result.connected);

    // Annotate each model with hardware suitability info
    let annotated = result.models;
    if (result.connected && result.models.length > 0 && isElectron()) {
      annotated = await Promise.all(
        result.models.map(async (m) => {
          const suit = await checkModelSuitability({ id: m.id, name: m.name, sizeBytes: m.sizeBytes });
          return { ...m, warning: suit.warning, blocked: suit.blocked, warningReason: suit.reason };
        }),
      );
    }

    // Mark the recommended model (auto-selected by hardware detection)
    const bestId = autoSelectedId ?? activeModelRef.current;
    if (bestId) {
      annotated = annotated.map((m) => ({ ...m, recommended: m.id === bestId && !m.blocked }));
    }

    setModels(annotated);
    if (result.connected && annotated.length > 0 && !activeModelRef.current) {
      setActiveModel(annotated[0].id);
    }
  }, [settings.backend]);

  useEffect(() => {
    let cancelled = false;

    const startup = async () => {
      const detected = await autoDetectBackend();
      if (cancelled) return;
      if (detected) {
        setSettings((prev) => ({ ...prev, backend: detected }));
        // Use refreshConnection so models get suitability annotations
        const result = await checkConnection(detected, STARTUP_TIMEOUT);
        if (cancelled) return;
        setConnected(result.connected);
        // Annotate with suitability on initial load too
        let annotated = result.models;
        if (result.connected && result.models.length > 0 && isElectron()) {
          annotated = await Promise.all(
            result.models.map(async (m) => {
              const suit = await checkModelSuitability({ id: m.id, name: m.name, sizeBytes: m.sizeBytes });
              return { ...m, warning: suit.warning, blocked: suit.blocked, warningReason: suit.reason };
            }),
          );
        }
        setModels(annotated);
        if (annotated.length > 0 && !activeModelRef.current) setActiveModel(annotated[0].id);
        return;
      }
      for (let i = 0; i < 10; i++) {
        if (cancelled) return;
        await new Promise((r) => setTimeout(r, 3000));
        if (cancelled) return;
        const retry = await autoDetectBackend();
        if (retry) {
          setSettings((prev) => ({ ...prev, backend: retry }));
          const result = await checkConnection(retry, STARTUP_TIMEOUT);
          if (cancelled) return;
          setConnected(result.connected);
          setModels(result.models);
          if (result.models.length > 0 && !activeModelRef.current) setActiveModel(result.models[0].id);
          break;
        }
      }
    };
    startup();
    return () => { cancelled = true; };
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []); // run once on mount

  // Polling — restart only when backend config changes
  useEffect(() => {
    const iv = setInterval(() => refreshConnection(), 15000);
    return () => clearInterval(iv);
  }, [refreshConnection]);

  // ── Electron backend status + hardware wiring ─────────────────────────────
  useEffect(() => {
    if (!isElectron()) return;
    let cancelled = false;

    getInitialBackendStatus().then((s) => {
      if (cancelled) return;
      setBackendLaunch(s);
      // If startup already connected and gave us an autoSelected model, use it
      if (s.state === 'connected' && s.autoSelected && !activeModelRef.current) {
        setActiveModel(s.autoSelected);
      }
      if (s.hardware) setHardwareInfo(s.hardware);
    });

    const unsubBackend = subscribeBackendStatus((s) => {
      if (cancelled) return;
      setBackendLaunch(s);
      if (s.state === 'connected') {
        refreshConnection(s.autoSelected).then(() => {
          // After models are loaded, honour the auto-selected recommendation
          if (s.autoSelected && !activeModelRef.current) {
            setActiveModel(s.autoSelected);
          }
        });
        if (s.hardware) setHardwareInfo(s.hardware);
      }
    });

    // Subscribe to hardware info pushed separately (arrives slightly after connected)
    const unsubHardware = subscribeHardwareInfo((info) => {
      if (cancelled) return;
      setHardwareInfo(info);
    });

    return () => {
      cancelled = true;
      unsubBackend();
      unsubHardware();
    };
  }, [refreshConnection]);

  // ── Resizable panes ───────────────────────────────────────────────────────
  useEffect(() => {
    const onMove = (e: MouseEvent) => {
      if (!dragRef.current) return;
      const { side, startX, startW } = dragRef.current;
      const delta = e.clientX - startX;
      if (side === 'left') setSidebarWidth(Math.max(160, Math.min(400, startW + delta)));
      else setChatWidth(Math.max(280, Math.min(600, startW - delta)));
    };
    const onUp = () => { dragRef.current = null; };
    document.addEventListener('mousemove', onMove);
    document.addEventListener('mouseup', onUp);
    return () => {
      document.removeEventListener('mousemove', onMove);
      document.removeEventListener('mouseup', onUp);
    };
  }, []);

  // ── Mode switch helper ────────────────────────────────────────────────────
  const openProgrammingMode = useCallback((reason?: string) => {
    setMode((prev) => {
      if (prev === 'programming') return prev;
      if (reason) showToast(reason);
      return 'programming';
    });
  }, [showToast]);

  const loadFolder = useCallback(async (folderPath: string, tree?: FileNode[]) => {
    if (tree) {
      setProjectPath(folderPath);
      setFileTree(tree);
      showToast(`Opened: ${folderPath}`);
      return;
    }
    const result = await fsGateway.refreshFolder(folderPath, fileTree);
    if (result.ok) {
      setProjectPath(folderPath);
      setFileTree(result.tree);
      showToast(`Opened: ${folderPath}`);
    } else {
      showToast(`Could not read folder: ${result.error}`);
    }
  }, [fileTree, showToast]);

  // ── Close Folder ──────────────────────────────────────────────────────────
  const closeFolder = useCallback(() => {
    setProjectPath('');
    setFileTree([]);
    setTabs([]);
    setActiveTabId(null);
    setMode('launcher');
    setShowNewProject(false);
  }, []);

  // ── New Project Created ───────────────────────────────────────────────────
  const handleNewProjectCreated = useCallback(async (newPath: string) => {
    setShowNewProject(false);
    setProcessing(true);
    setProcessingMsg('Opening project…');
    try {
      const result = await fsGateway.refreshFolder(newPath, []);
      if (result.ok) {
        setProjectPath(newPath);
        setFileTree(result.tree);
        setMode('programming');
        // Auto-open the first file
        if (result.tree.length > 0) {
          const firstFile = findFirstFile(result.tree);
          if (firstFile) {
            const readResult = await fsGateway.readFile(firstFile.path);
            if (readResult.ok) {
              const id = uid();
              const lang = firstFile.language ?? firstFile.name.split('.').pop()?.toLowerCase() ?? 'text';
              setTabs([{ id, name: firstFile.name, path: firstFile.path, language: lang, content: readResult.content ?? '', dirty: false }]);
              setActiveTabId(id);
            }
          }
        }
        showToast(`Created: ${newPath}`);
      }
    } finally {
      setProcessing(false);
      setProcessingMsg(undefined);
    }
  }, [showToast]);

  // ── Open folder (dialog) ──────────────────────────────────────────────────
  const openFolder = useCallback(async () => {
    const result = await withProcessing(() => fsGateway.openFolder(), 'Opening folder…');
    if (!result.ok) {
      if (result.error && result.error !== 'cancelled') showToast(result.error);
      return;
    }
    openProgrammingMode();
    setProjectPath(result.path);
    setFileTree(result.tree);
    showToast(`Opened: ${result.path}`);
  }, [openProgrammingMode, showToast, withProcessing]);

  // ── Create new folder (dialog) ────────────────────────────────────────────
  const createNewFolder = useCallback(async () => {
    const result = await fsGateway.createFolder();
    if (!result.ok) {
      if (result.error && result.error !== 'cancelled') showToast(result.error);
      return;
    }
    openProgrammingMode();
    setProjectPath(result.path);
    setFileTree(result.tree);
    showToast(`Created: ${result.path}`);
  }, [openProgrammingMode, showToast]);

  // ── Open a single file tab ────────────────────────────────────────────────
  const openFileTab = useCallback((
    filePath: string,
    content: string,
    dirty = false,
    opts?: { detectExtensionOnSave?: boolean },
  ) => {
    if (isSensitiveFile(filePath)) {
      showToast('Sensitive file excluded from editing for safety');
      return;
    }
    setTabs((prev) => {
      const existing = prev.find((t) => t.path === filePath);
      if (existing) {
        setActiveTabId(existing.id);
        return prev.map((t) => (t.id === existing.id ? { ...t, content, dirty } : t));
      }
      const name = filePath.split(/[\\/]/).pop() ?? filePath;
      const tab: EditorTab = {
        id: uid(),
        name,
        path: filePath,
        language: detectLanguage(name),
        content,
        dirty,
        detectExtensionOnSave: opts?.detectExtensionOnSave ?? !hasFileExtension(name),
      };
      setActiveTabId(tab.id);
      return [...prev, tab];
    });
  }, [showToast]);

  // ── Open file by path ─────────────────────────────────────────────────────
  const openFileByPath = useCallback(async (filePath: string) => {
    if (isSensitiveFile(filePath)) {
      showToast('Sensitive file excluded from editing for safety');
      return;
    }
    const existing = tabs.find((t) => t.path === filePath);
    if (existing) { setActiveTabId(existing.id); return; }

    const result = await fsGateway.readFile(filePath);
    openFileTab(
      filePath,
      result.ok ? (result.content ?? '') : `// Error reading file: ${result.error}`,
    );
  }, [tabs, openFileTab, showToast]);

  const openFile = useCallback((node: FileNode) => {
    openFileByPath(node.path);
  }, [openFileByPath]);

  const openFilesDialog = useCallback(async () => {
    const results = await fsGateway.openFiles();
    if (results.length === 0) return;
    openProgrammingMode();
    for (const r of results) {
      openFileTab(r.path, r.ok ? r.content : `// Error reading file: ${r.error}`);
    }
  }, [openFileTab, openProgrammingMode]);

  // ── Create subfolder (called from FileTree context-menu "New Folder") ───────
  /**
   * Validates and creates a subfolder at parentPath/folderName.
   * Returns ok/error so FileTree can show inline feedback.
   * Does NOT refresh the tree — FileTree calls onRefresh itself on success.
   */
  const createSubfolderInTree = useCallback(async (
    parentPath: string,
    folderName: string,
  ): Promise<{ ok: boolean; error?: string; reserved?: boolean }> => {
    const result = await fsGateway.createSubfolder(parentPath, folderName, projectPath);
    if (result.ok) {
      showToast(`Created ${folderName}`);
    }
    return result;
  }, [projectPath, showToast]);

  // ── Root-level new folder helpers ────────────────────────────────────────
  const beginNewFolder = useCallback(() => {
    if (!projectPath) {
      showToast('Open or create a folder first');
      return;
    }
    setSidebarTab('files');
    setNewFolderName('');
    setNewFolderError(null);
    setNewFolderPrompt(true);
    requestAnimationFrame(() => {
      newFolderInputRef.current?.focus();
      newFolderInputRef.current?.select();
    });
  }, [projectPath, showToast]);

  const cancelNewFolder = useCallback(() => {
    setNewFolderPrompt(false);
    setNewFolderName('');
    setNewFolderError(null);
  }, []);

  const confirmNewFolder = useCallback(async () => {
    const trimmed = newFolderName.trim();
    if (!trimmed) { cancelNewFolder(); return; }
    if (!projectPath) { showToast('Open or create a folder first'); cancelNewFolder(); return; }

    setNewFolderBusy(true);
    setNewFolderError(null);
    try {
      const result = await fsGateway.createSubfolder(projectPath, trimmed, projectPath);
      if (result.ok) {
        cancelNewFolder();
        const refreshed = await fsGateway.refreshFolder(projectPath, fileTree);
        if (refreshed.ok) setFileTree(refreshed.tree);
        showToast(`Created ${trimmed}`);
      } else {
        setNewFolderError(result.error ?? 'Could not create folder.');
        requestAnimationFrame(() => {
          newFolderInputRef.current?.focus();
          newFolderInputRef.current?.select();
        });
      }
    } finally {
      setNewFolderBusy(false);
    }
  }, [newFolderName, projectPath, cancelNewFolder, showToast, fileTree]);

  // ── Delete file or folder ─────────────────────────────────────────────────
  const deleteNode = useCallback(async (node: FileNode) => {
    const result = node.type === 'directory'
      ? await fsGateway.deleteFolder(node.path)
      : await fsGateway.deleteFile(node.path);

    if (!result.ok) {
      showToast(`Delete failed: ${result.error}`);
      return;
    }

    // Close any open tabs for this path (or any path inside this folder)
    setTabs((prev) => prev.filter((t) =>
      node.type === 'directory'
        ? !t.path.startsWith(node.path)
        : t.path !== node.path,
    ));

    // Refresh file tree
    if (projectPath) {
      const refreshed = await fsGateway.refreshFolder(projectPath, fileTree);
      if (refreshed.ok) setFileTree(refreshed.tree);
    }

    showToast(`Deleted ${node.name}`);
  }, [showToast, projectPath, fileTree]);

  // ── Save active file ──────────────────────────────────────────────────────
  const saveActiveFile = useCallback(async () => {
    const tab = tabs.find((t) => t.id === activeTabId);
    if (!tab) return;

    // 1) Full-file language scan MUST finish before any write/rename
    const resolved = tab.content.trim()
      ? await resolvePathAfterDetection(tab.path, tab.content, tab.detectExtensionOnSave === true)
      : { path: tab.path, renamed: false, extension: null as string | null };

    const savePath = resolved.path;
    const saveName = savePath.split(/[\\/]/).pop() ?? savePath;
    const saveLang = detectLanguage(saveName);

    // 2) Only after detection completes — write and (if needed) rename.
    //    For the rename case we write content into the ORIGINAL path first,
    //    then do a single atomic fs.rename so there is never a window where
    //    both the old and new names exist on disk simultaneously.
    let result: { ok: boolean; error?: string; downloaded?: boolean };
    if (resolved.renamed && savePath !== tab.path) {
      // Write content to original path, then rename atomically.
      const writeResult = await fsGateway.writeFile(tab.path, tab.content);
      if (!writeResult.ok) {
        showToast(`Save failed: ${writeResult.error}`);
        return;
      }
      const renameResult = await fsGateway.renameFile(tab.path, savePath);
      if (!renameResult.ok) {
        // Content is safely written under the old name — just keep it there.
        showToast(`Renamed failed, saved as ${tab.name}: ${renameResult.error}`);
        // Update tab to reflect the content was at least saved (dirty → false).
        setTabs((prev) => prev.map((t) =>
          t.id === tab.id ? { ...t, dirty: false } : t,
        ));
        return;
      }
      result = { ok: true };
    } else {
      // Normal save — no rename needed.
      result = await fsGateway.writeFile(savePath, tab.content);
      if (!result.ok) {
        showToast(`Save failed: ${result.error}`);
        return;
      }
    }

    setTabs((prev) => prev.map((t) =>
      t.id === tab.id
        ? {
            ...t,
            path: savePath,
            name: saveName,
            language: saveLang,
            dirty: false,
            detectExtensionOnSave: resolved.renamed ? false : t.detectExtensionOnSave,
          }
        : t,
    ));
    if (resolved.renamed && projectPath) {
      const refreshed = await fsGateway.refreshFolder(projectPath, fileTree);
      if (refreshed.ok) setFileTree(refreshed.tree);
    }
    showToast(result.downloaded
      ? `Downloaded ${saveName} (this browser session can't write it back in place)`
      : resolved.renamed
        ? `Saved as ${saveName}`
        : `Saved ${saveName}`);
  }, [tabs, activeTabId, showToast, projectPath, fileTree]);

  // ── Chat mode → Programming mode handoff ─────────────────────────────────
  const openInProgrammingMode = useCallback((content: string, language: string, filename?: string) => {
    openProgrammingMode('Opened Programming Mode');
    const path = filename ?? `untitled-${tabs.length + 1}.${LANG_EXT[language.toLowerCase()] ?? 'txt'}`;
    openFileTab(path, content, true);
  }, [openProgrammingMode, openFileTab, tabs.length]);

  // ── Tab ops (must be declared BEFORE keyboard shortcuts — deps read these) ─
  const closeTab = useCallback((id: string) => {
    setTabs((prev) => {
      const filtered = prev.filter((t) => t.id !== id);
      if (activeTabId === id)
        setActiveTabId(filtered.length > 0 ? filtered[filtered.length - 1].id : null);
      return filtered;
    });
  }, [activeTabId]);

  // ── New File (must be above keyboard useEffect — TDZ crash = black screen) ─
  const beginNewFile = useCallback(() => {
    if (!projectPath) {
      showToast('Open or create a folder first');
      return;
    }
    setSidebarTab('files');
    setNewFileName('');
    setNewFilePrompt(true);
    // Focus after paint
    requestAnimationFrame(() => newFileInputRef.current?.focus());
  }, [projectPath, showToast]);

  const cancelNewFile = useCallback(() => {
    setNewFilePrompt(false);
    setNewFileName('');
  }, []);

  const confirmNewFile = useCallback(async () => {
    const raw = newFileName.trim();
    if (!raw) {
      // No name → do not create
      cancelNewFile();
      return;
    }
    if (!projectPath) {
      showToast('Open or create a folder first');
      cancelNewFile();
      return;
    }

    // Disallow path separators / traversal
    const safe = raw.replace(/[\\/]/g, '').replace(/\.\./g, '');
    if (!safe) {
      showToast('Enter a valid file name');
      return;
    }

    // With extension → use as-is. Without → plain text file (no extension).
    const fileName = safe;
    const filePath = `${projectPath}\\${fileName}`;

    const written = await fsGateway.writeFile(filePath, '');
    if (!written.ok) {
      showToast(`Could not create file: ${written.error}`);
      return;
    }

    cancelNewFile();
    openFileTab(filePath, '', false, { detectExtensionOnSave: !hasFileExtension(fileName) });
    if (mode !== 'programming') setMode('programming');

    const refreshed = await fsGateway.refreshFolder(projectPath, fileTree);
    if (refreshed.ok) setFileTree(refreshed.tree);

    showToast(`Created ${fileName}`);
  }, [newFileName, projectPath, cancelNewFile, showToast, openFileTab, mode, fileTree]);

  // Keep alias used by keyboard shortcut
  const newFile = beginNewFile;

  // ── Keyboard shortcuts ────────────────────────────────────────────────────
  useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      const ctrl = e.ctrlKey || e.metaKey;
      if (!ctrl) return;

      switch (e.key.toLowerCase()) {
        case 'o':
          e.preventDefault();
          if (e.shiftKey) openFolder();
          else openFilesDialog();
          break;
        case 'n':
          e.preventDefault();
          newFile();
          break;
        case 's':
          e.preventDefault();
          saveActiveFile();
          break;
        case 'w':
          e.preventDefault();
          if (activeTabId) closeTab(activeTabId);
          break;
        case '`':
          e.preventDefault();
          setShowTerminal((v) => !v);
          break;
        case ',':
          e.preventDefault();
          setSettingsOpen((v) => !v);
          break;
        case 'tab':
          if (tabs.length > 1) {
            e.preventDefault();
            const idx = tabs.findIndex((t) => t.id === activeTabId);
            const next = e.shiftKey
              ? (idx - 1 + tabs.length) % tabs.length
              : (idx + 1) % tabs.length;
            setActiveTabId(tabs[next].id);
          }
          break;
      }
    };
    window.addEventListener('keydown', handler);
    return () => window.removeEventListener('keydown', handler);
  }, [openFolder, openFilesDialog, saveActiveFile, activeTabId, tabs, newFile, closeTab]);

  // ── Drag-and-drop ─────────────────────────────────────────────────────────
  useEffect(() => {
    const showOverlay = () => {
      document.getElementById('drop-overlay')?.classList.remove('hidden');
    };
    const hideOverlay = () => {
      document.getElementById('drop-overlay')?.classList.add('hidden');
    };

    let dragDepth = 0;

    const onDragEnter = (e: DragEvent) => {
      e.preventDefault();
      dragDepth++;
      showOverlay();
    };

    const onDragOver = (e: DragEvent) => {
      e.preventDefault();
      if (e.dataTransfer) e.dataTransfer.dropEffect = 'link';
    };

    const onDragLeave = (e: DragEvent) => {
      e.preventDefault();
      dragDepth--;
      if (dragDepth <= 0) { dragDepth = 0; hideOverlay(); }
    };

    const onDrop = async (e: DragEvent) => {
      e.preventDefault();
      e.stopPropagation();
      dragDepth = 0;
      hideOverlay();

      if (!e.dataTransfer || e.dataTransfer.items.length === 0) return;

      // Collect File objects synchronously before any awaits (DataTransfer is
      // only guaranteed live during the synchronous event handler).
      const droppedItems = Array.from(e.dataTransfer.items)
        .filter((i) => i.kind === 'file')
        .map((i) => ({
          file:  i.getAsFile(),
          entry: (i as unknown as { webkitGetAsEntry?: () => { isDirectory: boolean } })
                   .webkitGetAsEntry?.(),
        }));

      // ── LAUNCHER mode: scan dropped content and route accordingly ──────────
      if (modeRef.current === 'launcher') {
        let hasSource = false;

        // Check each item: zip → parse central directory; plain file → ext check
        for (const { file, entry } of droppedItems) {
          if (!file) continue;
          const lowerName = file.name.toLowerCase();

          if (lowerName.endsWith('.zip')) {
            if (await hasSourceFilesInZip(file)) { hasSource = true; break; }
          } else if (!entry?.isDirectory) {
            // Plain file — check extension directly
            const ext = lowerName.split('.').pop() ?? '';
            if (SOURCE_EXTS.has(ext)) { hasSource = true; break; }
          }
          // Directories: we'll check after loading the tree below
        }

        // Process the drop through the normal gateway to build trees / read files
        const outcomes = await fsGateway.handleDrop(e);

        // If we haven't found source files yet, check any directory trees
        if (!hasSource) {
          for (const o of outcomes) {
            if (o.kind === 'directory' && o.tree && treeHasSourceFiles(o.tree)) {
              hasSource = true;
              break;
            }
          }
        }

        if (hasSource) {
          // Source code found → Programming Mode, load the dropped content
          setMode('programming');
          for (const outcome of outcomes) {
            if (outcome.kind === 'directory') {
              await loadFolder(outcome.path, outcome.tree ?? []);
            } else {
              openFileTab(outcome.path, outcome.content ?? '');
            }
          }
        } else {
          // No source code → Casual Chat Mode (don't try to load files)
          setMode('chat');
          showToast('No source files found — opening Chat Mode');
        }
        return;
      }

      // ── Non-launcher modes: existing behavior (always go to programming) ───
      const outcomes = await fsGateway.handleDrop(e);
      if (outcomes.length === 0) {
        showToast('Could not read what was dropped — try Open Folder / Open File instead');
        return;
      }

      openProgrammingMode('Opened Programming Mode');

      for (const outcome of outcomes) {
        if (outcome.kind === 'directory') {
          await loadFolder(outcome.path, outcome.tree ?? []);
        } else {
          openFileTab(outcome.path, outcome.content ?? '');
        }
      }
    };

    document.addEventListener('dragenter', onDragEnter);
    document.addEventListener('dragover', onDragOver);
    document.addEventListener('dragleave', onDragLeave);
    document.addEventListener('drop', onDrop);
    return () => {
      document.removeEventListener('dragenter', onDragEnter);
      document.removeEventListener('dragover', onDragOver);
      document.removeEventListener('dragleave', onDragLeave);
      document.removeEventListener('drop', onDrop);
    };
  // modeRef is a ref, so we don't need it in deps. loadFolder / openFileTab /
  // openProgrammingMode / showToast are stable memoized callbacks.
  }, [loadFolder, openFileTab, openProgrammingMode, showToast]);

  // ── Auto-pop-out from chat to programming ─────────────────────────────────
  useEffect(() => {
    if (mode !== 'chat') return;
    for (const m of messages) {
      if (m.role !== 'assistant' || m.streaming) continue;
      if (autoOpenedRef.current.has(m.id)) continue;
      autoOpenedRef.current.add(m.id);

      const fileBlocks = parseBlocks(m.content).filter(
        (b): b is typeof b & { filename: string } => b.type === 'code' && !!b.filename,
      );
      if (fileBlocks.length === 0) continue;

      openProgrammingMode(
        fileBlocks.length > 1
          ? `Opened Programming Mode — created ${fileBlocks.length} files`
          : `Opened Programming Mode — created ${fileBlocks[0].filename}`,
      );
      for (const b of fileBlocks) openFileTab(b.filename, b.content, true);
    }
  }, [messages, mode, openProgrammingMode, openFileTab]);

  const updateTabContent = useCallback((id: string, content: string) => {
    setTabs((prev) => prev.map((t) => t.id === id ? { ...t, content, dirty: true } : t));
  }, []);

  // ── Context files — all files in the tree are always in context ───────────
  const contextFiles = countContextFiles(fileTree);

  // ── Code block actions ────────────────────────────────────────────────────
  const insertCode = useCallback((content: string, _lang: string) => {
    if (!activeTabId) { showToast('Open a file tab first, then use Insert'); return; }
    setTabs((prev) => prev.map((t) =>
      t.id === activeTabId ? { ...t, content: t.content + '\n\n' + content, dirty: true } : t,
    ));
    showToast('Code inserted into active tab');
  }, [activeTabId, showToast]);

  const applyDiff = useCallback((_content: string, _lang: string) => {
    showToast('Diff view would open here (Monaco DiffEditor in desktop build)');
  }, [showToast]);

  const addToProject = useCallback((content: string, language: string) => {
    const name = `generated-${generatedFiles.length + 1}.${language || 'txt'}`;
    setGeneratedFiles((prev) => [...prev, { id: uid(), name, language, content, timestamp: Date.now() }]);
    showToast(`Added "${name}" to project`);
  }, [generatedFiles.length, showToast]);

  const clearChat   = useCallback(() => setMessages([]), []);

  // ── Handle AI-written files: open in tabs + refresh tree ─────────────────
  const handleFilesWritten = useCallback(async (files: { path: string; content: string }[]) => {
    if (files.length === 0) {
      // Undo was triggered — close any tabs that were opened for these files
      return;
    }
    // Open each written file in an editor tab (auto-saves to disk already happened)
    for (const f of files) {
      openFileTab(f.path, f.content, false); // not dirty — just written to disk
    }
    // Refresh the file tree if a project is open
    if (projectPath) {
      const result = await fsGateway.refreshFolder(projectPath, fileTree);
      if (result.ok) setFileTree(result.tree);
    }
    // Switch to programming mode so tabs are visible
    if (mode !== 'programming') {
      setMode('programming');
    }
  }, [openFileTab, projectPath, fileTree, mode]);
  const handleSaveSettings = useCallback((s: Settings) => {
    setSettings(s);
    showToast('Settings saved');
    // Re-run cleanup with the (possibly updated) retainDays
    if (isElectron()) {
      runCleanup(s.retainDays ?? 15);
    }
  }, [showToast]);
  const startDrag   = (side: 'left' | 'right') => (e: React.MouseEvent) => {
    dragRef.current = { side, startX: e.clientX, startW: side === 'left' ? sidebarWidth : chatWidth };
  };

  // ── Render ────────────────────────────────────────────────────────────────

  // Splash: shown while app is starting (workspace not yet restored, or backend still init-ing)
  const splashVisible = !appReady || (isElectron() && (backendLaunch.state === 'checking' || backendLaunch.state === 'starting'));
  const splashMessage =
    backendLaunch.state === 'checking' ? 'Checking models' :
    backendLaunch.state === 'starting' ? 'Starting backend' :
    'Loading';

  return (
    <div className="flex flex-col h-screen bg-surface-0 text-ink-high overflow-hidden">

      {/* ── Startup splash (onrunloading animation) ──────────────────────── */}
      {splashVisible && <SplashScreen message={splashMessage} />}

      {/* ── Extension reload splash — shown after user confirms restart ── */}
      {reloadCountdown !== null && (
        <SplashScreen
          message={`Applying ${reloadName}`}
          countdown={reloadCountdown}
          countdownTotal={RELOAD_SECS}
          subtitle="Refreshing PATH and extension registry…"
        />
      )}

      {/* ── Restart prompt — shown when extension install completes ── */}
      {showRestartPrompt && (
        <div className="fixed inset-0 bg-black/60 flex items-center justify-center z-[9998] animate-fade-in">
          <div className="bg-surface-1 border border-surface-3 rounded-2xl p-6 max-w-sm w-full mx-4 shadow-2xl">
            <div className="flex items-start gap-4 mb-4">
              <div className="w-10 h-10 rounded-xl flex items-center justify-center flex-shrink-0 text-xl"
                style={{ background: 'color-mix(in srgb, var(--success) 15%, transparent)' }}>
                ✅
              </div>
              <div>
                <p className="text-sm font-semibold text-ink-high">
                  {pendingRestartName.current} installed
                </p>
                <p className="text-2xs text-ink-mid mt-1 leading-relaxed">
                  A quick ~10 second refresh will apply the extension and update the PATH so you can run code immediately.
                </p>
              </div>
            </div>
            <div className="bg-surface-2 rounded-lg px-3 py-2 mb-4 text-2xs text-ink-low">
              <strong className="text-ink-mid">Restart now</strong> — refreshes PATH, takes ~10 seconds, app stays open.<br />
              <strong className="text-ink-mid">Later</strong> — extension activates on next app launch.
            </div>
            <div className="flex gap-2 justify-end">
              <button
                onClick={declineRestart}
                className="px-4 py-2 text-xs text-ink-mid hover:text-ink-high rounded-lg transition-colors border border-surface-3 hover:border-surface-4"
              >
                Later
              </button>
              <button
                onClick={confirmRestart}
                className="px-4 py-2 text-xs font-medium text-white rounded-lg transition-colors"
                style={{ background: 'var(--primary)' }}
              >
                Restart now (~10s)
              </button>
            </div>
          </div>
        </div>
      )}

      {/* ── Processing overlay (loadingprocess animation) ────────────────── */}
      <ProcessingOverlay visible={processing} message={processingMsg} />

      <TopBar
        models={models}
        activeModel={activeModel}
        connected={connected}
        backendType={settings.backend.type}
        projectPath={projectPath}
        mode={mode === 'launcher' ? 'chat' : mode}
        hardwareInfo={hardwareInfo}
        onModeChange={(m) => setMode(m)}
        onModelSelect={setActiveModel}
        onRefreshModels={refreshConnection}
        onOpenSettings={() => setSettingsOpen(true)}
        onOpenLicense={() => setLicenseOpen(true)}
        onOpenFolder={openFolder}
        onOpenFile={openFilesDialog}
        onOpenRuntimeLibrary={() => { setMissingRuntimeId(null); setSidebarTab('runtimes'); setMode('programming'); }}
        onCloseFolder={closeFolder}
        onNewProject={() => setShowNewProject(true)}
        graceDaysLeft={graceDaysLeft}
      />

      {isElectron() && backendLaunch.state !== 'idle' && backendLaunch.state !== 'connected' && (
        <div className={`flex items-start justify-between gap-3 px-4 py-2 text-2xs border-b border-surface-3 ${
          backendLaunch.state === 'failed' ? 'bg-error-600/10 text-error-400' : 'bg-primary-900/40 text-primary-300'
        }`}>
          <span className="whitespace-pre-line leading-relaxed">
            {backendLaunch.state === 'checking' && 'Checking for local AI models…'}
            {backendLaunch.state === 'starting' && `Starting ${backendLaunch.backend === 'ollama' ? 'Ollama' : 'LM Studio'} server${
              backendLaunch.attempt ? ` (${backendLaunch.attempt}/${backendLaunch.maxAttempts})` : '…'}`}
            {backendLaunch.state === 'failed' && (backendLaunch.message ?? 'Could not find or load models.')}
          </span>
          {backendLaunch.state === 'failed' && (
            <button onClick={() => restartBackend()}
              className="px-2 py-0.5 rounded bg-error-600/20 hover:bg-error-600/30 text-error-400 font-medium transition-colors flex-shrink-0">
              Retry
            </button>
          )}
        </div>
      )}

      {/* Drag-and-drop overlay */}
      <div id="drop-overlay" className="hidden fixed inset-0 z-50 bg-primary-900/40 border-4 border-dashed border-primary-500 pointer-events-none flex items-center justify-center">
        <div className="flex flex-col items-center gap-2">
          <UploadCloud size={32} className="text-primary-300" />
          <span className="text-primary-300 text-lg font-semibold">Drop files or folders here</span>
          <span className="text-primary-400/70 text-sm">Zip with source code → Programming Mode · Everything else → Chat</span>
        </div>
      </div>

      {/* ── LAUNCHER: Mode picker shown on fresh run ─────────────────────────── */}
      {mode === 'launcher' && (
        <LauncherScreen
          onSelectProgramming={() => setMode('programming')}
          onSelectChat={() => setMode('chat')}
        />
      )}

      {/* ── PROGRAMMING MODE ────────────────────────────────────────────────── */}
      {mode === 'programming' && (
        <div className="flex flex-1 overflow-hidden">
          {/* Left sidebar */}
          <div className="flex flex-col bg-surface-1 border-r border-surface-3 flex-shrink-0" style={{ width: sidebarWidth }}>
            <div className="flex items-center border-b border-surface-3 flex-shrink-0">
              {(['files', 'git', 'runtimes'] as SidebarTab[]).map((tab) => (
                <button key={tab} onClick={() => setSidebarTab(tab)}
                  className={`flex-1 flex items-center justify-center gap-1 py-2 text-2xs font-medium transition-colors ${
                    sidebarTab === tab ? 'text-accent-400 border-b-2 border-accent-400 bg-surface-2' : 'text-ink-mid hover:text-ink-high'}`}>
                  {tab === 'files' ? <FolderTree size={12} /> : tab === 'git' ? <GitBranch size={12} /> : <Package size={12} />}
                  {tab === 'files' ? 'Files' : tab === 'git' ? 'Git' : 'Runtimes'}
                </button>
              ))}
            </div>

            <div className="flex-1 overflow-y-auto">
              {sidebarTab === 'files' ? (
                projectPath ? (
                  <>
                    {/* ── Sidebar toolbar: project name + New Folder + New File ── */}
                    <div className="flex items-center gap-1 px-2 py-1.5 text-2xs text-ink-low uppercase tracking-wide border-b border-surface-3">
                      <span className="truncate flex-1 min-w-0" title={projectPath}>
                        {projectPath.split(/[\\/]/).pop()}
                      </span>
                      <button
                        onClick={beginNewFolder}
                        title="New Folder at project root"
                        className="flex-shrink-0 p-1 rounded text-ink-mid hover:text-ink-high hover:bg-surface-2 transition-colors"
                        aria-label="New Folder"
                      >
                        <FolderPlus size={14} />
                      </button>
                      <button
                        onClick={beginNewFile}
                        title="New File (Ctrl+N)"
                        className="flex-shrink-0 p-1 rounded text-ink-mid hover:text-ink-high hover:bg-surface-2 transition-colors"
                        aria-label="New File"
                      >
                        <FilePlus size={14} />
                      </button>
                    </div>

                    {/* ── Root-level new folder inline input ───────────── */}
                    {newFolderPrompt && (
                      <div className="px-2 py-2 border-b border-surface-3 bg-surface-0 space-y-1.5">
                        <div className="flex items-center gap-1.5">
                          <FolderPlus size={13} className="text-primary-400 flex-shrink-0" />
                          <input
                            ref={newFolderInputRef}
                            value={newFolderName}
                            disabled={newFolderBusy}
                            onChange={(e) => { setNewFolderName(e.target.value); setNewFolderError(null); }}
                            onKeyDown={(e) => {
                              if (e.key === 'Enter')  { e.preventDefault(); confirmNewFolder(); }
                              if (e.key === 'Escape') { e.preventDefault(); cancelNewFolder(); }
                            }}
                            placeholder="Folder name"
                            className="flex-1 min-w-0 px-2 py-1.5 text-xs bg-surface-2 border border-surface-3 rounded-md text-ink-high placeholder:text-ink-low focus:outline-none focus:border-primary-500 normal-case tracking-normal disabled:opacity-50"
                            autoFocus
                            autoComplete="off"
                            spellCheck={false}
                          />
                        </div>
                        {newFolderError && (
                          <p className="text-[10px] text-error-400 leading-snug normal-case tracking-normal pl-1">
                            {newFolderError}
                          </p>
                        )}
                        <div className="flex items-center gap-1.5">
                          <button
                            onClick={confirmNewFolder}
                            disabled={newFolderBusy}
                            className="flex-1 px-2 py-1 text-2xs font-medium rounded bg-primary-600 hover:bg-primary-500 text-white transition-colors disabled:opacity-50"
                          >
                            Create
                          </button>
                          <button
                            onClick={cancelNewFolder}
                            disabled={newFolderBusy}
                            className="px-2 py-1 text-2xs font-medium rounded bg-surface-2 hover:bg-surface-3 border border-surface-3 text-ink-mid transition-colors disabled:opacity-50"
                          >
                            Cancel
                          </button>
                        </div>
                      </div>
                    )}

                    {/* ── New file inline input ─────────────────────────── */}
                    {newFilePrompt && (
                      <div className="px-2 py-2 border-b border-surface-3 bg-surface-0 space-y-1.5">
                        <input
                          ref={newFileInputRef}
                          value={newFileName}
                          onChange={(e) => setNewFileName(e.target.value)}
                          onKeyDown={(e) => {
                            if (e.key === 'Enter') { e.preventDefault(); confirmNewFile(); }
                            if (e.key === 'Escape') { e.preventDefault(); cancelNewFile(); }
                          }}
                          placeholder="File name (e.g. App.java)"
                          className="w-full px-2 py-1.5 text-xs bg-surface-2 border border-surface-3 rounded-md text-ink-high placeholder:text-ink-low focus:outline-none focus:border-primary-500 normal-case tracking-normal"
                          autoFocus
                        />
                        <div className="flex items-center gap-1.5">
                          <button
                            onClick={confirmNewFile}
                            className="flex-1 px-2 py-1 text-2xs font-medium rounded bg-primary-600 hover:bg-primary-500 text-white transition-colors"
                          >
                            Create
                          </button>
                          <button
                            onClick={cancelNewFile}
                            className="px-2 py-1 text-2xs font-medium rounded bg-surface-2 hover:bg-surface-3 border border-surface-3 text-ink-mid transition-colors"
                          >
                            Cancel
                          </button>
                        </div>
                        <p className="text-[10px] text-ink-low normal-case tracking-normal leading-snug">
                          Include an extension (.js, .html, …) or leave none for a plain text file.
                        </p>
                      </div>
                    )}

                    <FileTree
                      nodes={fileTree}
                      onOpenFile={openFile}
                      onRefresh={() => loadFolder(projectPath)}
                      onDeleteNode={deleteNode}
                      onCreateFolder={createSubfolderInTree}
                    />
                  </>
                ) : (
                  <div className="flex flex-col items-center justify-center h-full text-center px-4 py-8">
                    <div className="w-10 h-10 rounded-lg bg-surface-2 border border-surface-3 flex items-center justify-center mb-3">
                      <FolderOpen size={18} className="text-ink-low" />
                    </div>
                    <p className="text-2xs text-ink-mid mb-1">No folder open</p>
                    <p className="text-2xs text-ink-low max-w-[180px] mb-3">
                      Create a new project folder to get started, or drop files here.
                    </p>
                    <button onClick={createNewFolder}
                      className="flex items-center gap-1.5 px-3 py-1.5 bg-primary-600 hover:bg-primary-500 text-white text-2xs font-medium rounded-lg transition-colors">
                      <FolderPlus size={12} /> Create new folder
                    </button>
                  </div>
                )
              ) : sidebarTab === 'git' ? (
                <GitPanel />
              ) : (
                /* Runtimes sidebar — inline RuntimeLibrary without slide-in */
                <RuntimeLibrary
                  open={true}
                  inline={true}
                  onClose={() => setSidebarTab('files')}
                  highlightId={missingRuntimeId}
                  onInstall={(cmd, name) => {
                    showToast(`Installing ${name} via winget…`);
                    runInTerminal(cmd);
                    setShowTerminal(true);
                  }}
                  onInstallComplete={triggerExtensionReload}
                  subscribeProcessExit={(cb) => terminalRef.current?.onProcessExit(cb) ?? (() => {})}
                />
              )}
            </div>
          </div>

          <div className="w-1 bg-surface-3 hover:bg-primary-500 cursor-col-resize transition-colors flex-shrink-0" onMouseDown={startDrag('left')} />

          <div className="flex-1 flex flex-col overflow-hidden min-w-0">
            <EditorArea
              tabs={tabs} activeTabId={activeTabId}
              onSelectTab={setActiveTabId} onCloseTab={closeTab}
              onUpdateContent={updateTabContent}
              onSaveFile={saveActiveFile}
              showTerminal={showTerminal} onToggleTerminal={() => setShowTerminal((v) => !v)}
              previewUrl={previewUrl}
              onClearPreviewUrl={() => setPreviewUrl(null)}
              onRunCommand={runInTerminal}
              terminal={
                <TerminalPanel
                  ref={terminalRef}
                  cwd={projectPath || '~'}
                  onPreviewUrl={(url) => { setPreviewUrl(url); setShowTerminal(true); }}
                  onMissingRuntime={(id) => { setMissingRuntimeId(id); setSidebarTab('runtimes'); }}
                />
              }
            />
          </div>

          <div className="w-1 bg-surface-3 hover:bg-primary-500 cursor-col-resize transition-colors flex-shrink-0" onMouseDown={startDrag('right')} />

          <div className="flex-shrink-0" style={{ width: chatWidth }}>
            <ChatPanel messages={messages} setMessages={setMessages} settings={settings}
              activeModel={activeModel} models={models} contextFiles={contextFiles}
              generatedFiles={generatedFiles} mode={mode} projectPath={projectPath}
              fileTree={fileTree} openTabs={tabs}
              onInsertCode={insertCode} onApplyDiff={applyDiff}
              onAddToProject={addToProject} onClearChat={clearChat}
              onFilesWritten={handleFilesWritten}
              onRunCommand={runInTerminal} />
          </div>
        </div>
      )}

      {/* ── CHAT MODE ───────────────────────────────────────────────────────── */}
      {mode === 'chat' && (
        <div className="flex flex-1 overflow-hidden justify-center bg-surface-0">
          <div className="w-full max-w-3xl flex flex-col overflow-hidden">
            <ChatPanel messages={messages} setMessages={setMessages} settings={settings}
              activeModel={activeModel} models={models} contextFiles={contextFiles}
              generatedFiles={generatedFiles} mode={mode} projectPath={projectPath}
              fileTree={fileTree} openTabs={tabs}
              onOpenInProgramming={openInProgrammingMode} onClearChat={clearChat}
              onFilesWritten={handleFilesWritten}
              onRunCommand={runInTerminal} />
          </div>
        </div>
      )}

      <footer className="flex items-center gap-3 px-3 py-1 bg-surface-1 border-t border-surface-3 text-2xs text-ink-low flex-shrink-0 h-6">
        <span className="flex items-center gap-1.5">
          {connected ? (
            <><span className="w-1.5 h-1.5 rounded-full bg-success-500" /><span className="text-success-500">{settings.backend.type}</span></>
          ) : (
            <><span className="w-1.5 h-1.5 rounded-full bg-warning-500" /><span className="text-warning-500">Not connected</span></>
          )}
        </span>
        <div className="flex-1" />
        <span className="text-ink-low">
          {mode === 'launcher'
            ? 'Click a panel to choose your mode · Drop a zip or file to auto-detect'
            : mode === 'programming'
            ? 'Ctrl+O: file · Ctrl+Shift+O: folder · Ctrl+S: save · Ctrl+W: close · Ctrl+`: terminal'
            : 'Drop a file or folder anytime to switch to Programming Mode'}
        </span>
      </footer>

      <SettingsPanel open={settingsOpen} onClose={() => setSettingsOpen(false)} settings={settings} onSave={handleSaveSettings} />
      <LicensePanel open={licenseOpen} onClose={() => setLicenseOpen(false)} />

      {showNewProject && (
        <NewProjectWizard
          onClose={() => setShowNewProject(false)}
          onCreated={handleNewProjectCreated}
        />
      )}

      {toast && (
        <div className="fixed bottom-10 left-1/2 -translate-x-1/2 z-50 animate-slide-up">
          <div className="bg-surface-2 border border-surface-4 rounded-lg px-4 py-2 text-xs text-ink-high shadow-2xl flex items-center gap-2">
            <Sparkles size={13} className="text-accent-400" />{toast}
          </div>
        </div>
      )}
    </div>
  );
}

// ── Launcher Screen ────────────────────────────────────────────────────────────

interface LauncherScreenProps {
  onSelectProgramming: () => void;
  onSelectChat: () => void;
}

function LauncherScreen({ onSelectProgramming, onSelectChat }: LauncherScreenProps) {
  return (
    <div className="flex flex-1 overflow-hidden animate-fade-in">

      {/* ── LEFT PANEL — Programming Mode ──────────────────────────────────── */}
      <button
        onClick={onSelectProgramming}
        className="
          relative flex-1 flex flex-col items-center justify-center
          bg-surface-1 border-r border-surface-3
          group cursor-pointer text-left
          transition-all duration-200
          hover:bg-[#0d1220]
          focus:outline-none
        "
        aria-label="Open Programming Mode"
      >
        {/* Top accent bar */}
        <div className="absolute top-0 left-0 right-0 h-0.5 bg-primary-600 opacity-0 group-hover:opacity-100 transition-opacity" />

        {/* Content */}
        <div className="flex flex-col items-center text-center px-10 max-w-md">

          {/* Icon cluster */}
          <div className="relative mb-6">
            <div className="w-16 h-16 rounded-2xl bg-primary-900/60 border border-primary-700/40 flex items-center justify-center group-hover:border-primary-500/60 group-hover:bg-primary-900/80 transition-all">
              <Code2 size={32} className="text-primary-400 group-hover:text-primary-300 transition-colors" />
            </div>
            <div className="absolute -bottom-1 -right-1 w-6 h-6 rounded-md bg-surface-3 border border-surface-4 flex items-center justify-center">
              <Terminal size={12} className="text-accent-400" />
            </div>
            <div className="absolute -bottom-1 -left-1 w-6 h-6 rounded-md bg-surface-3 border border-surface-4 flex items-center justify-center">
              <Package size={12} className="text-primary-400" />
            </div>
          </div>

          <h2 className="text-xl font-semibold text-ink-high mb-2 group-hover:text-white transition-colors">
            Programming Mode
          </h2>
          <p className="text-sm text-ink-mid mb-8 leading-relaxed">
            Full IDE environment — file tree, code editor, terminal, and AI chat with project context.
          </p>

          {/* Feature pills */}
          <div className="flex flex-wrap gap-2 justify-center mb-8">
            {['File Tree', 'Code Editor', 'Terminal', 'Git', 'AI Chat'].map((f) => (
              <span key={f} className="px-2.5 py-1 rounded-full text-2xs font-medium bg-primary-900/50 text-primary-300 border border-primary-700/30 group-hover:border-primary-600/50 transition-colors">
                {f}
              </span>
            ))}
          </div>

          {/* Mock chat box */}
          <div className="w-full rounded-xl border border-surface-3 group-hover:border-primary-700/50 bg-surface-0 overflow-hidden transition-all">
            {/* Mock editor area header */}
            <div className="flex items-center gap-1.5 px-3 py-2 bg-surface-2 border-b border-surface-3">
              <div className="w-2 h-2 rounded-full bg-error-500/60" />
              <div className="w-2 h-2 rounded-full bg-warning-500/60" />
              <div className="w-2 h-2 rounded-full bg-success-500/60" />
              <span className="ml-2 text-2xs font-mono text-ink-low">App.tsx</span>
            </div>
            {/* Mock code lines */}
            <div className="px-4 py-3 font-mono text-2xs space-y-1 border-b border-surface-3 bg-surface-0/50">
              <div><span className="text-primary-400">function</span> <span className="text-accent-400">App</span><span className="text-ink-mid">() {'{'}</span></div>
              <div className="pl-4"><span className="text-primary-400">return</span> <span className="text-ink-mid">{'<'}</span><span className="text-error-400/80">div</span><span className="text-ink-mid">{'>'}</span><span className="text-ink-low">…</span><span className="text-ink-mid">{'</'}div{'>'}</span></div>
              <div><span className="text-ink-mid">{'}'}</span></div>
            </div>
            {/* Mock input */}
            <div className="flex items-center gap-2 px-3 py-2.5 bg-surface-1">
              <span className="flex-1 text-2xs text-ink-low font-mono">Ask about your code…</span>
              <div className="w-6 h-6 rounded bg-primary-600/60 flex items-center justify-center">
                <Send size={10} className="text-white/60" />
              </div>
            </div>
          </div>
        </div>

        {/* Click hint */}
        <div className="absolute bottom-6 left-0 right-0 flex justify-center">
          <span className="text-2xs text-ink-low group-hover:text-primary-400 transition-colors flex items-center gap-1">
            <Zap size={11} /> Click to enter Programming Mode
          </span>
        </div>
      </button>

      {/* ── RIGHT PANEL — Casual Chat Mode ─────────────────────────────────── */}
      <button
        onClick={onSelectChat}
        className="
          relative flex-1 flex flex-col items-center justify-center
          bg-surface-0 
          group cursor-pointer text-left
          transition-all duration-200
          hover:bg-[#0e1218]
          focus:outline-none
        "
        aria-label="Open Chat Mode"
      >
        {/* Top accent bar */}
        <div className="absolute top-0 left-0 right-0 h-0.5 bg-accent-500 opacity-0 group-hover:opacity-100 transition-opacity" />

        {/* Content */}
        <div className="flex flex-col items-center text-center px-10 max-w-md">

          {/* Icon cluster */}
          <div className="relative mb-6">
            <div className="w-16 h-16 rounded-2xl bg-accent-600/10 border border-accent-600/30 flex items-center justify-center group-hover:border-accent-500/60 group-hover:bg-accent-600/15 transition-all">
              <MessageCircle size={32} className="text-accent-400 group-hover:text-accent-400 transition-colors" />
            </div>
            <div className="absolute -bottom-1 -right-1 w-6 h-6 rounded-md bg-surface-2 border border-surface-3 flex items-center justify-center">
              <Sparkles size={12} className="text-accent-400" />
            </div>
          </div>

          <h2 className="text-xl font-semibold text-ink-high mb-2 group-hover:text-white transition-colors">
            Casual Chat
          </h2>
          <p className="text-sm text-ink-mid mb-8 leading-relaxed">
            Just talk — ask questions, brainstorm ideas, or get code snippets without opening a project.
          </p>

          {/* Feature pills */}
          <div className="flex flex-wrap gap-2 justify-center mb-8">
            {['Q&A', 'Code Snippets', 'Brainstorm', 'Explain Code', 'Quick Help'].map((f) => (
              <span key={f} className="px-2.5 py-1 rounded-full text-2xs font-medium bg-accent-600/10 text-accent-400 border border-accent-600/25 group-hover:border-accent-500/40 transition-colors">
                {f}
              </span>
            ))}
          </div>

          {/* Mock chat box */}
          <div className="w-full rounded-xl border border-surface-3 group-hover:border-accent-700/50 bg-surface-1 overflow-hidden transition-all">
            {/* Mock messages */}
            <div className="px-4 py-3 space-y-2.5 border-b border-surface-3">
              {/* User bubble */}
              <div className="flex justify-end">
                <div className="max-w-[75%] px-3 py-1.5 rounded-xl bg-primary-700/40 text-2xs text-primary-200">
                  How do I debounce in JS?
                </div>
              </div>
              {/* Assistant bubble */}
              <div className="flex justify-start">
                <div className="max-w-[80%] px-3 py-1.5 rounded-xl bg-surface-2 text-2xs text-ink-mid leading-relaxed">
                  Use <span className="font-mono text-accent-400">setTimeout</span> + <span className="font-mono text-accent-400">clearTimeout</span> — I'll show you…
                </div>
              </div>
            </div>
            {/* Mock input */}
            <div className="flex items-center gap-2 px-3 py-2.5 bg-surface-0/60">
              <span className="flex-1 text-2xs text-ink-low">Ask anything…</span>
              <div className="w-6 h-6 rounded bg-accent-600/60 flex items-center justify-center">
                <Send size={10} className="text-white/60" />
              </div>
            </div>
          </div>
        </div>

        {/* Click hint */}
        <div className="absolute bottom-6 left-0 right-0 flex justify-center">
          <span className="text-2xs text-ink-low group-hover:text-accent-400 transition-colors flex items-center gap-1">
            <Sparkles size={11} /> Click to enter Chat Mode
          </span>
        </div>
      </button>

    </div>
  );
}

export default App;
