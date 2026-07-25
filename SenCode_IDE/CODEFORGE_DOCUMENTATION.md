# SenCode — Developer Documentation

> Covers every source file in `electron/` and `src/`. Last updated: July 2026.

---

## Table of Contents

1. [Application Overview](#1-application-overview)
2. [Architecture Overview](#2-architecture-overview)
3. [Electron Main Process](#3-electron-main-process)
4. [React Renderer](#4-react-renderer)
5. [Library Layer](#5-library-layer-srclib)
6. [Components](#6-components)
7. [End-to-End Workflows](#7-end-to-end-workflows)
8. [Theme System](#8-theme-system)
9. [IPC Channel Reference](#9-ipc-channel-reference)
10. [Deploy Workflow](#10-deploy-workflow)

---

## 1. Application Overview

**SenCode** is a fully offline, local-first AI coding assistant packaged as an Electron desktop app. It provides an integrated IDE experience with a built-in AI chat panel, all running without internet or cloud subscriptions.

### Purpose
- Full IDE: file tree, multi-tab editor, real terminal, git panel, HTML preview
- Run local LLM inference entirely on-device via GGUF model files and `node-llama-cpp`
- Detect hardware tier at startup and auto-select the best model
- Persist and recall conversation history; build a lightweight user memory profile
- One-click extension (runtime) install via `winget`

### Tech Stack

| Layer | Technology |
|---|---|
| Desktop shell | Electron (main + preload + renderer) |
| UI framework | React 18 + TypeScript |
| Build tool | Vite |
| Styling | Tailwind CSS + CSS custom-property themes |
| Code editor | CodeMirror 6 (100+ languages) |
| LLM inference | node-llama-cpp v3 (GGUF via llama.cpp) |
| Hardware detection | systeminformation |
| Markdown | marked + DOMPurify |
| Icons | lucide-react |

---

## 2. Architecture Overview

```
┌─────────────────────────────────────────────┐
│  Electron Main Process  (Node.js)            │
│  main.cjs                                    │
│   ├── llama-engine.cjs  (GGUF inference)    │
│   ├── hardware-detect.cjs                   │
│   ├── session-store.cjs                     │
│   ├── runtime-detect.cjs                    │
│   └── backend-launcher.cjs (legacy)         │
└──────────────────┬──────────────────────────┘
                   │ IPC (contextBridge)
┌──────────────────▼──────────────────────────┐
│  preload.cjs  →  window.electronAPI         │
└──────────────────┬──────────────────────────┘
                   │ window.electronAPI.*
┌──────────────────▼──────────────────────────┐
│  Renderer (React / Vite / TypeScript)        │
│  App.tsx (root state + layout)               │
│   ├── TopBar                                 │
│   ├── FileTree (sidebar: files/git/exts)     │
│   ├── EditorArea → CodeMirrorEditor          │
│   ├── TerminalPanel (always mounted)         │
│   ├── RuntimeLibrary (Extensions panel)      │
│   ├── SplashScreen / ProcessingOverlay       │
│   └── ChatPanel → MessageBubble, CodeBlock   │
└─────────────────────────────────────────────┘
```

---

## 3. Electron Main Process

### 3.1 `electron/main.cjs`

Entry point. Creates the BrowserWindow, wires all IPC handlers, performs startup hardware detection and model scanning.

#### Key Global State

| Variable | Description |
|---|---|
| `mainWindow` | The single BrowserWindow instance |
| `lastStatus` | Cached backend status; returned to late subscribers |
| `cachedHardware` | Hardware snapshot from `detectHardware()`, filled once at startup |
| `activeStreams` | Map of in-flight LLM streams by `requestId` |
| `runningProcesses` | Map of spawned long-running terminal processes by PID |

#### `buildChildEnv()` — Rich PATH injection

Every terminal command runs through PowerShell with `-NonInteractive -NoProfile`, which skips the user's shell profile. `buildChildEnv()` builds a merged environment that includes:
- System PATH + User PATH (read from Windows registry at command time)
- `~/.cargo/bin` (Rust/rustup)
- `C:\Program Files\nodejs`, `AppData\Roaming\npm` (Node.js)
- All Python version dirs (`AppData\Local\Programs\Python\PythonXXX`)
- Java JDK dirs scanned from `C:\Program Files\Java`, Eclipse Adoptium, etc.
- `C:\Program Files\Go\bin`, Ruby `C:\RubyXX-x64\bin`, PHP, Perl, Lua, Dart, Kotlin, R, Julia, Swift, Elixir
- LLVM MinGW dirs (scanned under `AppData\Local\Microsoft\WinGet\Packages`)
- `CARGO_HOME` and `RUSTUP_HOME` env vars set explicitly

This is applied to both `terminal:run` (one-shot) and `terminal:spawn` (long-running) so every installed runtime is always visible.

#### Startup Sequence

1. `createWindow()` — opens 1440×900 BrowserWindow
2. `runCleanup(15)` — auto-delete sessions older than 15 days
3. `detectHardware()` — async; pushes `hardware-info` event when done
4. `scanModels()` — if no `.gguf` files, sends `failed` status
5. `pickBestModel()` — selects best model for hardware tier
6. `sendStatus({ state: 'connected', backend: 'local', autoSelected, hardware })`
7. `fs.watch(modelsDir)` — hot-reload when new `.gguf` files appear

#### New IPC Handlers (added since initial release)

| Channel | Description |
|---|---|
| `fs:rename-file` | Atomic rename via `fs.renameSync` (used by extension auto-detect on save) |
| `fs:delete-file` | Delete a single file via `fs.unlinkSync` |
| `fs:delete-folder` | Recursive folder delete via `fs.rmSync({ recursive: true })` |
| `preview:open` | Opens a floating BrowserWindow at a given URL (dev server preview) |

#### `terminal:run` — One-shot command execution

Writes the command to a temp `.ps1` file, executes via `powershell.exe -File`, captures stdout+stderr. Key behaviours:
- Uses `buildChildEnv()` so all runtimes are on PATH
- Timeout: **30s** for regular commands, **120s** for compiled languages (`javac`, `rustc`, `gcc`, `g++`, `kotlinc`, `dotnet`, `swift`)
- Blocked commands: `format`, `mkfs`, `dd`, `shutdown`, `reboot`, `reg`, `regedit`, `regsvr32`

#### `terminal:spawn` — Long-running processes

Spawns a persistent PowerShell process. Streams stdout/stderr/close back to the renderer via `terminal:output` push events. Uses `buildChildEnv()`. Long-running detection regex:
```
npm start/run, node, yarn start/dev, vite, webpack --watch,
live-server, http-server, serve, php -S, winget install
```

---

### 3.2 `electron/preload.cjs`

Exposes `window.electronAPI` via `contextBridge`. New methods added since initial release:

| Method | Description |
|---|---|
| `renameFile(from, to)` | Atomic file rename |
| `deleteFile(path)` | Delete a file |
| `deleteFolder(path)` | Delete a folder recursively |
| `openPreviewWindow(url)` | Open floating preview BrowserWindow |
| `detectRuntimes()` | Probe all language runtimes |
| `createFolderDialog()` | Native "create folder" dialog |

---

### 3.3 `electron/runtime-detect.cjs`

Detects installed language runtimes by running version-check commands. Each entry now includes rich metadata for the Extensions detail panel.

#### Runtime Entry Structure

```ts
{
  id: string;           // e.g. 'nodejs', 'rust', 'llvm-mingw'
  name: string;         // display name
  category: string;     // 'Runtime' | 'Toolchain'
  icon: string;         // emoji icon
  desc: string;         // one-line description
  detail: string;       // full paragraph for the detail panel
  langs: string[];      // file extensions this runtime handles
  fileTypes: string[];  // e.g. ['.rs', '.toml']
  includes: string[];   // tools included in the install
  dependencies: string[]; // IDs of required other runtimes
  related: string[];    // IDs of related optional runtimes
  winget: string;       // winget package ID
  homepage: string;     // official homepage URL
  version: string|null; // detected version, null if not installed
  installed: boolean;
}
```

#### Supported Runtimes (current)

| ID | Name | Winget ID |
|---|---|---|
| `nodejs` | Node.js | `OpenJS.NodeJS.LTS` |
| `typescript` | TypeScript (tsx) | (uses Node.js) |
| `python` | Python 3 | `Python.Python.3` |
| `java` | Java JDK 21 | `Oracle.JDK.21` |
| `go` | Go | `GoLang.Go` |
| `rust` | Rust (rustup) | `Rustlang.Rustup` |
| `llvm-mingw` | LLVM MinGW (Rust/C linker) ⚠ DO NOT MODIFY | `MartinStorsjo.LLVM-MinGW.UCRT` |
| `gcc` | C/C++ (LLVM MinGW) | `MartinStorsjo.LLVM-MinGW.UCRT` |
| `dotnet` | .NET SDK | `Microsoft.DotNet.SDK.8` |
| `ruby` | Ruby | `RubyInstallerTeam.Ruby.3.4` |
| `php` | PHP | `PHP.PHP` |
| `perl` | Perl (Strawberry) | `StrawberryPerl.StrawberryPerl` |
| `lua` | Lua | `DEVCOM.Lua` |
| `dart` | Dart SDK | `Dart.Dart` |
| `kotlin` | Kotlin | `Kotlin.Kotlin` |
| `r` | R | `RProject.R` |
| `julia` | Julia | `Julialang.Julia` |
| `swift` | Swift | `Swift.Toolchain` |
| `elixir` | Elixir | `Elixir.Elixir` |

**Critical:** The `llvm-mingw` entry enables Rust compilation on Windows without Visual Studio. Do not change its winget ID or detection logic.

---

## 4. React Renderer

### 4.1 `src/App.tsx`

Root component. Owns all top-level state and orchestrates the three-pane IDE layout.

#### State (new additions since initial release)

| Variable | Type | Description |
|---|---|---|
| `terminalRef` | `Ref<TerminalHandle>` | Ref to the always-mounted TerminalPanel; used to call `execute()` directly |
| `appReady` | `boolean` | False until workspace is restored; shows SplashScreen while false |
| `processing` | `boolean` | Shows ProcessingOverlay during heavy operations (folder open, etc.) |
| `reloadCountdown` | `number\|null` | Drives the post-extension-install countdown SplashScreen |
| `showRestartPrompt` | `boolean` | Shows the "Restart now or later?" dialog after extension install |
| `pendingRestartName` | `Ref<string>` | Name of the just-installed extension (for the restart dialog title) |

#### `runInTerminal(cmd)` — The canonical run helper

```ts
const runInTerminal = (cmd: string) => {
  setShowTerminal(true);         // show the terminal dock
  terminalRef.current?.execute(cmd);  // execute immediately (terminal always mounted)
};
```

The terminal is **always mounted** (never conditionally unmounted). The dock is hidden/shown via CSS height (`0` or `208px`). This means `terminalRef.current` is always non-null, so `execute()` fires synchronously with no polling or delay.

#### Extension install flow

1. User clicks Install in RuntimeLibrary
2. `runInTerminal(winget install ...)` — sends to terminal immediately
3. RuntimeLibrary subscribes to `terminalRef.current.onProcessExit()` — overlay stops the moment winget exits
4. RuntimeLibrary calls `onInstallComplete(name)` → `triggerExtensionReload(name)`
5. `showRestartPrompt = true` — dialog appears asking "Restart now (~10s) or Later?"
6. **Restart now**: 10-second countdown SplashScreen, then re-probes runtimes
7. **Later**: silently re-probes, shows toast "Changes active on next launch"

#### Auto-detect file extension on save (`detectSyntax.ts` integration)

When a file is created without an extension, `detectExtensionOnSave: true` is set on the tab. On every Ctrl+S:
1. `resolvePathAfterDetection(path, content, force=true)` runs the full language scanner
2. If a confident language is detected, the file is **renamed atomically**:
   - `writeFile(originalPath, content)` — write content to original first
   - `renameFile(originalPath, newPath)` — atomic OS rename (no orphan files)
3. Tab updates with new path, name, language; `detectExtensionOnSave` cleared

---

## 5. Library Layer (`src/lib/`)

### 5.1 `src/lib/detectSyntax.ts` ← NEW

**Purpose:** Full-file language detection. Scans the entire buffer and scores it against 50+ language rule sets to determine the correct file extension.

#### Key Functions

**`analyzeSource(content) → DetectionResult`**
Runs all language rules in parallel scoring. Returns:
```ts
{ extension: string|null, score: number, candidates: {ext, score}[] }
```
Guards:
- Files with fewer than **3 meaningful lines** → always returns `null` (no rename)
- Winner must clear an **absolute score of 12** and beat second place by **4+ points**

**`resolvePathAfterDetection(filePath, content, force?) → Promise<{path, renamed, extension, analysis}>`**
Async wrapper. Runs detection only when needed (extensionless file, `.txt`, or `force=true`). Returns the new path if renaming is warranted, or the original path if not.

**`needsExtensionDetection(filePath) → boolean`**
True when the file has no extension or has `.txt`.

#### Language Support
50+ scorers including: HTML, CSS, SCSS, JS, TS, TSX, JSX, Python, Java, Kotlin, Scala, C#, F#, VB, C, C++, Rust, Go, Swift, Dart, Ruby, Lua, PHP, Perl, R, Julia, Elixir, Erlang, Haskell, OCaml, Clojure, Scheme, Elm, CoffeeScript, Shell, PowerShell, SQL, JSON, YAML, TOML, Markdown, Dockerfile, Protobuf, and more.

#### Critical HTML guards
HTML gets +20 for `<!DOCTYPE html>` and +15 for `<html>` (using `/im` multiline flag). All JVM/.NET/systems language scorers apply a **-30 penalty** when HTML is detected, preventing misclassification of HTML files as Java, Kotlin, C#, etc. CSS and SCSS return 0 immediately when HTML is present.

---

### 5.2 `src/lib/fsGateway.ts` (additions)

New functions:

**`renameFile(from, to)`** — Atomic rename. Electron: `fs.renameSync`. Browser: not supported.

**`deleteFile(path)`** — Delete a file. Electron only.

**`deleteFolder(path)`** — Recursive folder delete. Electron only.

---

## 6. Components

### 6.1 `src/components/TopBar.tsx`

App header. Logo loaded via Vite module import (`import iconUrl from '../assets/icon.png'`) so it works correctly in the packaged asar. Contains: logo, mode switcher (Programming/Chat), combined Open Folder/File dropdown, ModelSelector (with hardware tier badge), connection status dot, Settings button.

**Prop changes:** `backendType` is retained in the interface but not rendered. `onOpenRuntimeLibrary` is wired through to `ModelSelector` as `onOpenRuntimes`.

---

### 6.2 `src/components/RuntimeLibrary.tsx` — Extensions Panel (fully redesigned)

The panel is now a **two-pane experience**: a compact sidebar list on the left and a floating detail panel that opens when any extension row is clicked.

#### Sidebar List

- Compact rows: status icon (✓/⚠), emoji, name, version badge, animated pulse dot while installing, chevron
- Grouped: **Installed** section and **Not Installed** section
- "Detecting…" pulse dot while probing (no spinning circle)

#### Detail Panel

Floats as a **fixed-position centered overlay** (560px wide, `z-index: 500`) over the editor area. Sections:

| Section | Content |
|---|---|
| Header | Emoji icon, name, version/status badge, category tag, short description |
| About | Full paragraph explaining purpose and use cases |
| Supported file types | Monospace badges for each file extension |
| What's included | Bulleted list of every tool installed (e.g. `rustc`, `cargo`, `rustfmt`, `clippy`) |
| Dependencies | Clickable cards for required other extensions (✓/⚠ status, navigates to that extension) |
| Related | Clickable chips for optional companion extensions |
| Package info | winget ID + homepage URL |

#### Action Bar

- **Not installed:** "Install [name]" button → starts winget, shows `ProcessingOverlay` on the detail panel body (not the header — minimize button stays accessible), stops overlay immediately when process exits via `subscribeProcessExit`
- **Installed:** Shows version + "Uninstall" button (with confirm dialog before `winget uninstall`)

#### Install Flow

```
Install clicked
  → winget install runs in terminal (streaming)
  → subscribeProcessExit fires when winget exits
  → detectRuntimes() re-probes immediately
  → overlay stops
  → if installed: onInstallComplete(name) → restart prompt in App
```

#### Props

| Prop | Type | Description |
|---|---|---|
| `open` | `boolean` | Panel visibility |
| `inline` | `boolean` | Render inside sidebar (no overlay) |
| `onClose` | `() => void` | Close handler |
| `onInstall` | `(cmd, name) => void` | Route winget command to terminal |
| `highlightId` | `string\|null` | Extension to highlight (from missing-runtime detection) |
| `onInstallComplete` | `(name) => void` | Called when install confirmed — triggers restart prompt |
| `subscribeProcessExit` | `(cb) => unsub` | Subscribe to terminal process-exit for immediate overlay stop |

---

### 6.3 `src/components/SplashScreen.tsx` ← NEW

Full-screen loading animation shown during:
- App startup (while workspace restores and backend initializes)
- Post-extension-install restart (10-second countdown with progress bar)

Based on the "onrunloading" HTML animation: large icon (220px) with breathing brackets, radar-ping rings, crosshair, sheen sweep, and bouncing dots label.

**Props:**
- `message` — text shown under the icon
- `countdown` — when set, shows a progress bar counting down
- `countdownTotal` — total seconds (used for bar width calculation)
- `subtitle` — secondary text shown during countdown

---

### 6.4 `src/components/ProcessingOverlay.tsx` ← NEW

Semi-transparent fullscreen (or inline) overlay shown during heavy operations. Based on the "loadingprocess" HTML animation: smaller icon (150px) with spinning center square, breathing brackets, cycling label text ("Processing", "Loading", "Please wait").

Used for:
- Saving/opening folders
- Extension install/uninstall (overlays the detail panel body only)

**Props:**
- `visible` — show/hide
- `message` — optional fixed message (overrides cycling text)
- `inline` — renders `position: absolute` instead of `fixed` (for detail panel use)

---

### 6.5 `src/components/Editor/EditorArea.tsx` (updated)

#### ▶ Run Button

Replaces the old "Preview" button. Always present when a tab is open. Behaviour by file extension:

| Extension | Action |
|---|---|
| `.html`, `.htm`, `.svg` | Renders inline in a sandboxed `<iframe>` (blob URL, no server needed). Side-by-side 50/50 split with editor. |
| `.js`, `.mjs`, `.cjs`, `.jsx` | `node "file.js"` |
| `.ts`, `.tsx` | `npx --yes tsx "file.ts"` (auto-downloads tsx) |
| `.py`, `.pyw` | Tries `python` → `python3` → `py` launcher |
| `.java` | `javac "file.java"` then `java -cp dir ClassName` |
| `.c` | `gcc "file.c" -o stem` then run (detects gcc or clang) |
| `.cpp`, `.cc`, `.cxx` | `g++` or `clang++` |
| `.cs` | `dotnet-script` (auto-installs via `dotnet tool install -g`) |
| `.go` | `go run "file.go"` |
| `.rs` | Detects clang → gcc → link.exe, picks right rustc target |
| `.rb` | `ruby "file.rb"` |
| `.php` | `php "file.php"` |
| `.sh`, `.bash` | `bash "file.sh"` |
| `.ps1` | `powershell -ExecutionPolicy Bypass -File "file.ps1"` |
| `.lua` | `lua "file.lua"` |
| `.r` | `Rscript "file.r"` |
| `.kt` | `kotlinc` → jar → `java -jar` |
| `.swift` | `swift "file.swift"` |
| `.dart` | `dart run "file.dart"` |
| `.pl`, `.pm` | `perl "file.pl"` |
| `.ex`, `.exs` | `elixir "file.ex"` |
| Others | Button disabled, tooltip shows "No runner for .xyz files" |

All multi-step commands use PowerShell `;` and `if ($LASTEXITCODE -eq 0)` (not `&&` which doesn't work in PS5).

**Important:** `onRunCommand` is the sole way to show the terminal. The Run button does NOT call `onToggleTerminal` — calling both caused a state conflict where the terminal immediately closed itself.

#### Terminal Dock

Always mounted (never conditionally unmounted). CSS height toggles between `0` and `208px` with no transition. This ensures `terminalRef` is always available and `execute()` fires instantly.

#### HTML Inline Preview

When a `.html` file is run, the editor shrinks to 50% width and a preview pane opens alongside it showing the rendered HTML in a sandboxed `<iframe>` (via `blob:` URL). The preview toolbar has a Refresh button (re-creates the blob from current unsaved content) and a close button.

---

### 6.6 `src/components/Terminal/TerminalPanel.tsx` (updated)

The terminal was completely redesigned. The separate input bar at the bottom is **gone**.

#### Design

- The entire scrollable output area IS the terminal — click anywhere to focus, then type
- Current input renders inline at the bottom of the output with a blinking cursor
- Keyboard: character keys append to input, Backspace deletes, Enter submits, Escape clears, ↑↓ history navigation
- **Ctrl+V paste:** handled via `onPaste` event. Single-line paste → appends to current input. **Multi-line paste** → auto-runs all lines except the last; the last line lands in the input for review before Enter (exactly like a real terminal)
- Color coding: input lines = `text-ink-high`, output = `text-success-300`, errors = `text-error-400`, system = `text-ink-low italic`

#### `TerminalHandle` ref interface

```ts
interface TerminalHandle {
  execute: (cmd: string) => void;
  onProcessExit: (cb: (exitCode: number) => void) => () => void;
}
```

`onProcessExit` fires when a long-running process emits "Process exited" AND when one-shot commands complete. Used by RuntimeLibrary to stop the install overlay immediately.

#### Removed

- `pendingCommand` / `onClearPending` props — removed. Use `terminalRef.current.execute()` directly.
- Bottom input bar — removed.

---

### 6.7 `src/components/FileTree/FileTree.tsx` (updated)

Now supports **right-click context menu**, **inline delete button** (trash icon on hover), and a **confirm dialog** before deleting.

#### New Props

| Prop | Type | Description |
|---|---|---|
| `onDeleteNode` | `(node: FileNode) => void` | Called after user confirms delete |

#### Delete Flow

1. Hover over a row → trash icon appears (opacity 0 → 1)
2. Right-click → context menu with "Open" (files only) and "Delete File/Folder"
3. Either path shows the confirm dialog
4. Confirm → `onDeleteNode(node)` → `App.deleteNode()`:
   - Files: `fsGateway.deleteFile(path)`
   - Folders: `fsGateway.deleteFolder(path)` (recursive)
   - Closes any open editor tabs for the deleted path
   - Refreshes the file tree

---

### 6.8 `src/components/Chat/ModelSelector.tsx` (updated)

#### Hardware Tier Badge

The badge now renders the hardware info panel using **fixed positioning** (measured from `getBoundingClientRect()` at click time). Previously used `absolute` which caused the panel to clip behind the TopBar.

`onOpenRuntimes` prop added — clicking "View Runtime Library →" at the bottom of the hardware panel navigates to the Runtimes sidebar tab.

---

## 7. End-to-End Workflows

### 7.1 Run Button → Terminal Execution

```
User clicks ▶ Run on active tab
  │
  ├─ EditorArea.handlePreview()
  │   ├─ HTML file → create blob URL → setInlinePreview(true)
  │   └─ All other runnable → onRunCommand(cmd)
  │                                    │
  │                           App.runInTerminal(cmd)
  │                             ├─ setShowTerminal(true)   ← shows dock instantly
  │                             └─ terminalRef.current.execute(cmd)
  │                                  │
  │                          TerminalPanel.doExecute(cmd)
  │                             ├─ long-running? → spawnProcess IPC
  │                             └─ one-shot?     → runCommand IPC (buildChildEnv)
  │
  └─ Output appears in terminal immediately
```

### 7.2 Extension Install Flow

```
User opens Extensions sidebar → clicks extension → detail panel opens
User clicks Install
  │
  ├─ handleInstall(rt)
  │   ├─ setInstalling(rt.id) → ProcessingOverlay covers detail panel body
  │   ├─ onInstall(cmd, name) → runInTerminal("winget install ...")
  │   ├─ subscribeProcessExit(cb) → fires when winget exits
  │   └─ fallback poll every 10s (in case exit not detected)
  │
  ├─ winget exits → cb fires → finish()
  │   ├─ detectRuntimes() → fresh probe
  │   ├─ setInstalling(null) → overlay disappears
  │   └─ if installed: onInstallComplete(name)
  │                          │
  │                   App.triggerExtensionReload(name)
  │                     └─ setShowRestartPrompt(true)
  │
  ├─ Restart prompt dialog appears
  │   ├─ "Restart now (~10s)" → confirmRestart()
  │   │     ├─ 10-second SplashScreen countdown
  │   │     └─ re-probe runtimes when countdown hits 0
  │   └─ "Later" → declineRestart()
  │         ├─ silently re-probe (badge updates to ✓)
  │         └─ toast: "Changes active on next launch"
```

### 7.3 File Extension Auto-Detection on Save

```
User creates file "myclass" (no extension)
  → confirmNewFile() → openFileTab(..., { detectExtensionOnSave: true })

User types Java code, presses Ctrl+S
  → saveActiveFile()
  → resolvePathAfterDetection("myclass", content, force=true)
      → analyzeSource(content)
          → runs 50+ language scorers
          → Java wins (score 35, minimum 15, beat 2nd by 4+)
          → extension: "java"
      → withDetectedExtension: returns "myclass.java"
  → writeFile("myclass", content)     ← content into original first
  → renameFile("myclass", "myclass.java")  ← atomic OS rename
  → tab updates: name="myclass.java", language="java", detectExtensionOnSave=false
  → toast: "Saved as myclass.java"
```

---

## 8. Theme System

Same CSS custom-property token system as before. Active themes: `midnight` (default purple), `ocean` (blue), `forest` (green), `ember` (orange), `arctic` (light indigo).

Theme switching in `App.tsx` removes all `theme-*` classes from `<html>` then adds the new one. No re-renders needed — all components read CSS variables directly.

---

## 9. IPC Channel Reference

### New channels since initial release

| Channel | Direction | Description |
|---|---|---|
| `fs:rename-file` | invoke | Atomic rename: `(fromPath, toPath) → { ok }` |
| `fs:delete-file` | invoke | Delete a file: `(filePath) → { ok }` |
| `fs:delete-folder` | invoke | Recursive delete: `(folderPath) → { ok }` |
| `fs:create-folder-dialog` | invoke | Native "create folder" dialog |
| `preview:open` | invoke | Open floating BrowserWindow at URL |
| `runtime:detect` | invoke | Probe all runtimes → `RuntimeInfo[]` |
| `runtime:for-lang` | invoke | Get runtime ID for a language |

All other IPC channels remain unchanged from the initial release (see original documentation for the full list).

---

## 10. Deploy Workflow

SenCode is deployed as a packaged Electron app. The source code is compiled by Vite into `dist/`, then packed with the Electron main process into `app.asar`.

### Deploy command

```bash
npm run deploy
# Runs: npm run build && node scripts/deploy-asar.cjs
```

### What `deploy-asar.cjs` does

1. **Stage** — copies `dist/`, `electron/`, `package.json` into a temp directory
2. **Pack** — `npx asar pack <stage> app.asar` (~2 MB)
3. **Build `app.asar.unpacked`** — copies native modules from `release/win-unpacked/resources/app.asar.unpacked` and adds `node-llama-cpp`'s JS dependencies (needed because `import()` calls from inside `app.asar.unpacked` can't go through the asar virtual filesystem)
4. **Deploy** to both:
   - `d:\New folder\CodeForge\resources\` (the app you launch)
   - `CodeForge_src\release\win-unpacked\resources\`

### Why `node_modules` is NOT in the asar

Native `.node` binaries cannot be inside an asar. `node-llama-cpp` also uses dynamic `import()` for its JS dependencies (`filenamify`, `lifecycle-utils`, `ora`, etc.) from within `app.asar.unpacked` — these imports can't resolve through the asar virtual filesystem. So all of `node-llama-cpp`'s deps are copied into `app.asar.unpacked/node_modules/` alongside the native binaries.

### Regenerate the zip for code review

```bash
powershell -File scripts/make-zip.ps1
# Output: d:\New folder\CodeForge_src_for_review.zip
```

The zip contains all source files (`src/`, `electron/`, `scripts/`, config files, docs) but excludes `node_modules/`, `dist/`, `release/`, and `build/`.

---

*End of SenCode Developer Documentation — July 2026*
