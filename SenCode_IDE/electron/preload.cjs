/**
 * Preload script — runs in an isolated context with Node access, and
 * exposes only a minimal, safe API to the renderer via contextBridge.
 * The renderer never gets direct Node/ipcRenderer access.
 */

const { contextBridge, ipcRenderer, webUtils } = require('electron');

contextBridge.exposeInMainWorld('electronAPI', {
  isElectron: true,
createDirs: (dirs) => ipcRenderer.invoke('fs:mkdir-dirs', dirs),
  // ── Backend lifecycle ─────────────────────────────────────────────────────
  getBackendStatus : () => ipcRenderer.invoke('backend:get-status'),
  restartBackend   : () => ipcRenderer.invoke('backend:restart'),
  onBackendStatus  : (callback) => {
    const listener = (_event, status) => callback(status);
    ipcRenderer.on('backend-status', listener);
    return () => ipcRenderer.removeListener('backend-status', listener);
  },

  // ── Hardware detection ────────────────────────────────────────────────────
  /** Returns the cached hardware snapshot detected on startup. */
  getHardwareInfo: () => ipcRenderer.invoke('hardware:get-info'),

  /** Subscribe to hardware info pushed at startup. Returns unsub fn. */
  onHardwareInfo: (callback) => {
    const listener = (_event, info) => callback(info);
    ipcRenderer.on('hardware-info', listener);
    return () => ipcRenderer.removeListener('hardware-info', listener);
  },

  /**
   * Check if a model is suitable for the detected hardware.
   * modelEntry: { id, name, sizeBytes }
   * Returns { ok, warning, blocked, reason }
   */
  checkModelSuitability: (modelEntry) =>
    ipcRenderer.invoke('hardware:check-model', modelEntry),

  // ── LLM proxy ─────────────────────────────────────────────────────────────
  getModels: (url, headers) =>
    ipcRenderer.invoke('llm:get-models', { url, headers }),

  streamChat: (requestId, body) => {
    ipcRenderer.send('llm:stream-start', { requestId, body });
  },

  streamAbort: (requestId) => {
    ipcRenderer.send('llm:stream-abort', { requestId });
  },

  onStreamChunk: (callback) => {
    const listener = (_event, requestId, chunk) => callback(requestId, chunk);
    ipcRenderer.on('llm:stream-chunk', listener);
    return () => ipcRenderer.removeListener('llm:stream-chunk', listener);
  },

  // ── Filesystem ────────────────────────────────────────────────────────────
  openFolderDialog : () => ipcRenderer.invoke('fs:open-folder-dialog'),
  openFileDialog   : () => ipcRenderer.invoke('fs:open-file-dialog'),
  createFolderDialog: () => ipcRenderer.invoke('fs:create-folder-dialog'),
  readDirectory    : (dirPath)           => ipcRenderer.invoke('fs:read-directory', dirPath),
  readFile         : (filePath)          => ipcRenderer.invoke('fs:read-file', filePath),
  writeFile        : (filePath, content) => ipcRenderer.invoke('fs:write-file', filePath, content),
  renameFile       : (fromPath, toPath)  => ipcRenderer.invoke('fs:rename-file', fromPath, toPath),
  deleteFile       : (filePath)          => ipcRenderer.invoke('fs:delete-file', filePath),
  deleteFolder     : (folderPath)        => ipcRenderer.invoke('fs:delete-folder', folderPath),
  writeFiles       : (files)             => ipcRenderer.invoke('fs:write-files', files),
  undoWriteFiles   : (filePaths)         => ipcRenderer.invoke('fs:undo-write-files', filePaths),
  statPath         : (targetPath)        => ipcRenderer.invoke('fs:stat-path', targetPath),
  writeFileSafe    : (filePath, content) => ipcRenderer.invoke('fs:write-file-safe', filePath, content),
  restoreBackup    : (filePath)          => ipcRenderer.invoke('fs:restore-backup', filePath),
  getPathForFile   : (file)              => webUtils.getPathForFile(file),

  // ── Terminal ──────────────────────────────────────────────────────────────
  runCommand: (command, cwd, projectPath) =>
    ipcRenderer.invoke('terminal:run', { command, cwd, projectPath }),

  // Spawn a long-running process (npm start, python app.py, etc.)
  spawnProcess: (command, cwd) =>
    ipcRenderer.invoke('terminal:spawn', { command, cwd }),

  // Kill a running process by its pid
  killProcess: (pid) =>
    ipcRenderer.invoke('terminal:kill', { pid }),

  // Subscribe to live output from a spawned process
  onProcessOutput: (callback) => {
    const listener = (_event, data) => callback(data);
    ipcRenderer.on('terminal:output', listener);
    return () => ipcRenderer.removeListener('terminal:output', listener);
  },

  // ── Subfolder creation (no dialog — inline tree creation) ────────────────
  createSubfolder    : (parentPath, folderName) =>
    ipcRenderer.invoke('fs:create-subfolder', parentPath, folderName),
  getReservedFolders : (projectPath) =>
    ipcRenderer.invoke('project:reserved-folders', projectPath),

  // ── Project creation ──────────────────────────────────────────────────────
  createProject: (opts) => ipcRenderer.invoke('project:create', opts),

  // ── Syntax checking ───────────────────────────────────────────────────────
  syntaxCheck: (opts) => ipcRenderer.invoke('syntax:check', opts),

  // ── Workspace persistence ─────────────────────────────────────────────────
  saveWorkspace : (data)  => ipcRenderer.invoke('workspace:save', data),
  loadWorkspace : ()      => ipcRenderer.invoke('workspace:load'),

  // ── Preview window ────────────────────────────────────────────────────────
  openPreviewWindow: (url) => ipcRenderer.invoke('preview:open', url),

  // ── Runtime library ───────────────────────────────────────────────────────
  detectRuntimes : ()       => ipcRenderer.invoke('runtime:detect'),
  runtimeForLang : (lang)   => ipcRenderer.invoke('runtime:for-lang', lang),
  saveSession   : (session)        => ipcRenderer.invoke('session:save',    session),
  listSessions  : ()               => ipcRenderer.invoke('session:list'),
  loadSession   : (id)             => ipcRenderer.invoke('session:load',    id),
  deleteSession : (id)             => ipcRenderer.invoke('session:delete',  id),
  pinSession    : (id, pinned)     => ipcRenderer.invoke('session:pin',     id, pinned),
  runCleanup    : (retainDays)     => ipcRenderer.invoke('session:cleanup', retainDays),
  getMemory     : ()               => ipcRenderer.invoke('session:memory'),

  // ── License & Device ──────────────────────────────────────────────────────
  /**
   * Returns the current license state for the UI panel.
   * See getLicenseInfo() in license-check.cjs for the shape.
   */
  getLicenseInfo: () => ipcRenderer.invoke('license:get-info'),

  /**
   * Deactivates this device: notifies the license server (best-effort)
   * then wipes the local license file. The app should be closed after this.
   */
  deactivateDevice: () => ipcRenderer.invoke('license:deactivate'),

  /**
   * Quit the app cleanly — used by the deactivation success screen.
   */
  quitApp: () => ipcRenderer.invoke('app:quit'),
});
