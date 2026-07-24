/**
 * EditorArea — tabbed code editor with terminal dock and smart Run button.
 *
 * Run behaviour by file type:
 *   html / htm / svg  → renders inline in a sandboxed <iframe> (blob URL, no server)
 *   js / mjs / cjs    → node "<path>"
 *   ts / tsx / jsx    → npx ts-node "<path>"  (or node if .jsx)
 *   py / pyw          → python "<path>"
 *   java              → java "<path>"  (Java 11+ single-file mode)
 *   c / cpp / cc / cxx→ compile then run (gcc/g++)
 *   cs                → dotnet-script or dotnet run
 *   go                → go run "<path>"
 *   rs                → cargo run  (if Cargo.toml present) else rustc + run
 *   rb                → ruby "<path>"
 *   php               → php "<path>"
 *   sh / bash / zsh   → bash "<path>"
 *   ps1               → powershell -File "<path>"
 *   lua               → lua "<path>"
 *   r / rscript       → Rscript "<path>"
 *   kt                → kotlinc + java
 *   swift             → swift "<path>"
 *   dart              → dart run "<path>"
 *   everything else   → show "no runner" tooltip, button disabled
 */

import { useEffect, useRef, useState, useCallback } from 'react';
import {
  X, Circle, FileCode2, FileText, FileJson, Sparkles,
  Terminal as TerminalIcon, Globe, Play, XCircle,
} from 'lucide-react';
import type { EditorTab } from '../../lib/types';
import { CodeMirrorEditor } from './CodeMirrorEditor';
import { isElectron } from '../../lib/electronBridge';

interface EditorAreaProps {
  tabs: EditorTab[];
  activeTabId: string | null;
  onSelectTab: (id: string) => void;
  onCloseTab: (id: string) => void;
  onUpdateContent: (id: string, content: string) => void;
  onSaveFile: () => void;
  showTerminal: boolean;
  onToggleTerminal: () => void;
  terminal: React.ReactNode;
  previewUrl?: string | null;
  onClearPreviewUrl?: () => void;
  /** Called when Preview wants to run a command in the terminal */
  onRunCommand?: (cmd: string, label?: string) => void;
}

// Extensions that render inline as HTML
// const HTML_EXTS = new Set(['html', 'htm', 'svg']); // Handled by getRunCommand

/**
 * Returns the terminal command to run a file, or null if not runnable.
 * All multi-step commands use semicolons (PowerShell doesn't support &&).
 * `dir`  = directory containing the file (for compile+run languages).
 * `stem` = filename without extension (e.g. "HelloWorld").
 */
function getRunCommand(ext: string, filePath: string, dir: string, stem: string): string | null {
  switch (ext) {
    // ── Web (inline preview, not terminal) ──────────────────────────────────
    case 'html': case 'htm': case 'svg':
      return '__inline__';

    // ── JavaScript ──────────────────────────────────────────────────────────
    case 'js': case 'mjs': case 'cjs': case 'jsx':
      return `node "${filePath}"`;

    // ── TypeScript ───────────────────────────────────────────────────────────
    // tsx is faster than ts-node and works out of the box with npx
    case 'ts': case 'tsx':
      return `npx --yes tsx "${filePath}"`;

    // ── Python ───────────────────────────────────────────────────────────────
    case 'py': case 'pyw':
      return (
        `$pyCmd = if (Get-Command python -ErrorAction SilentlyContinue) { "python" }` +
        ` elseif (Get-Command python3 -ErrorAction SilentlyContinue) { "python3" }` +
        ` elseif (Get-Command py -ErrorAction SilentlyContinue) { "py" }` +
        ` else { $null };` +
        `if ($pyCmd) { & $pyCmd "${filePath}" }` +
        ` else { Write-Host "Python not found. Install it from the Runtimes sidebar." -ForegroundColor Red }`
      );

    // ── Java ─────────────────────────────────────────────────────────────────
    case 'java': {
      const outDir = dir || '.';
      return (
        `if (Get-Command javac -ErrorAction SilentlyContinue) {` +
        `  Set-Location "${outDir}"; javac "${filePath}"; if ($LASTEXITCODE -eq 0) { java -cp "${outDir}" ${stem} }` +
        `} else { Write-Host "javac not found. Install Java JDK from the Runtimes sidebar." -ForegroundColor Red }`
      );
    }

    // ── C ────────────────────────────────────────────────────────────────────
    case 'c': {
      const out = `${dir}${stem}`;
      return (
        `$cc = if (Get-Command gcc -ErrorAction SilentlyContinue) { "gcc" }` +
        ` elseif (Get-Command clang -ErrorAction SilentlyContinue) { "clang" } else { $null };` +
        `if ($cc) { & $cc "${filePath}" -o "${out}"; if ($LASTEXITCODE -eq 0) { & "${out}" } }` +
        ` else { Write-Host "No C compiler found. Install LLVM MinGW from the Runtimes sidebar." -ForegroundColor Red }`
      );
    }

    // ── C++ ──────────────────────────────────────────────────────────────────
    case 'cpp': case 'cc': case 'cxx': case 'c++': {
      const out = `${dir}${stem}`;
      return (
        `$cxx = if (Get-Command g++ -ErrorAction SilentlyContinue) { "g++" }` +
        ` elseif (Get-Command clang++ -ErrorAction SilentlyContinue) { "clang++" } else { $null };` +
        `if ($cxx) { & $cxx "${filePath}" -o "${out}"; if ($LASTEXITCODE -eq 0) { & "${out}" } }` +
        ` else { Write-Host "No C++ compiler found. Install LLVM MinGW from the Runtimes sidebar." -ForegroundColor Red }`
      );
    }

    // ── C# ───────────────────────────────────────────────────────────────────
    case 'cs':
      return (
        `if (Get-Command dotnet -ErrorAction SilentlyContinue) {` +
        `  if (Get-Command dotnet-script -ErrorAction SilentlyContinue) {` +
        `    dotnet-script "${filePath}"` +
        `  } else {` +
        `    Write-Host "Installing dotnet-script (one-time)..." -ForegroundColor Cyan;` +
        `    dotnet tool install -g dotnet-script 2>&1 | Out-Null;` +
        `    dotnet-script "${filePath}"` +
        `  }` +
        `} else { Write-Host "dotnet SDK not found. Install it from the Runtimes sidebar." -ForegroundColor Red }`
      );
    // ── Go ───────────────────────────────────────────────────────────────────
    case 'go':
      return `go run "${filePath}"`;

    // ── Rust ─────────────────────────────────────────────────────────────────
    // Rust on Windows needs a linker. Priority:
    //   1. gcc/clang from LLVM-MinGW (winget install MartinStorsjo.LLVM-MinGW.UCRT)
    //   2. link.exe from Visual Studio Build Tools
    // The gnullvm target works with clang; the gnu target works with gcc.
    case 'rs': {
      const out = `${dir}${stem}`;
      return (
        `$hasClang = [bool](Get-Command clang -ErrorAction SilentlyContinue);` +
        `$hasGcc   = [bool](Get-Command gcc   -ErrorAction SilentlyContinue);` +
        `$hasMsvc  = [bool](Get-Command link.exe -ErrorAction SilentlyContinue);` +
        `if ($hasClang) {` +
        `  rustc --target x86_64-pc-windows-gnullvm "${filePath}" -o "${out}"; if ($LASTEXITCODE -eq 0) { & "${out}" }` +
        `} elseif ($hasGcc) {` +
        `  rustc --target x86_64-pc-windows-gnu "${filePath}" -o "${out}"; if ($LASTEXITCODE -eq 0) { & "${out}" }` +
        `} elseif ($hasMsvc) {` +
        `  rustc "${filePath}" -o "${out}"; if ($LASTEXITCODE -eq 0) { & "${out}" }` +
        `} else {` +
        `  Write-Host "" -ForegroundColor Red;` +
        `  Write-Host "Rust needs a linker to compile. None found on PATH." -ForegroundColor Red;` +
        `  Write-Host "Fix: Go to the Runtimes sidebar and install 'LLVM MinGW (Rust linker)'." -ForegroundColor Yellow;` +
        `  Write-Host "     Or run: winget install MartinStorsjo.LLVM-MinGW.UCRT" -ForegroundColor Yellow;` +
        `  Write-Host "     After installing, restart SenCode so the new PATH takes effect." -ForegroundColor Yellow` +
        `}`
      );
    }

    // ── Ruby ─────────────────────────────────────────────────────────────────
    case 'rb':
      return `ruby "${filePath}"`;

    // ── PHP ──────────────────────────────────────────────────────────────────
    case 'php':
      return `php "${filePath}"`;

    // ── Shell scripts ─────────────────────────────────────────────────────────
    case 'sh': case 'bash':
      return `bash "${filePath}"`;
    case 'zsh':
      return `zsh "${filePath}"`;
    case 'ps1':
      return `powershell -ExecutionPolicy Bypass -File "${filePath}"`;

    // ── Lua ──────────────────────────────────────────────────────────────────
    case 'lua':
      return `lua "${filePath}"`;

    // ── R ────────────────────────────────────────────────────────────────────
    case 'r':
      return `Rscript "${filePath}"`;

    // ── Kotlin ───────────────────────────────────────────────────────────────
    case 'kt': case 'kts': {
      const jar = `${dir}${stem}.jar`;
      return `kotlinc "${filePath}" -include-runtime -d "${jar}"; if ($LASTEXITCODE -eq 0) { java -jar "${jar}" }`;
    }

    // ── Swift ────────────────────────────────────────────────────────────────
    case 'swift':
      return `swift "${filePath}"`;

    // ── Dart ─────────────────────────────────────────────────────────────────
    case 'dart':
      return `dart run "${filePath}"`;

    // ── Perl ─────────────────────────────────────────────────────────────────
    case 'pl': case 'pm':
      return `perl "${filePath}"`;

    // ── Elixir ───────────────────────────────────────────────────────────────
    case 'ex': case 'exs':
      return `elixir "${filePath}"`;

    // ── Julia ────────────────────────────────────────────────────────────────
    case 'jl':
      return (
        `if (Get-Command julia -ErrorAction SilentlyContinue) { julia "${filePath}" }` +
        ` else { Write-Host "Julia not found. Install it from the Runtimes sidebar." -ForegroundColor Red }`
      );

    // ── Scala ────────────────────────────────────────────────────────────────
    case 'scala':
      return (
        `if (Get-Command scala -ErrorAction SilentlyContinue) { scala "${filePath}" }` +
        ` else { Write-Host "Scala not found. Install it from the Runtimes sidebar." -ForegroundColor Red }`
      );

    // ── Haskell ──────────────────────────────────────────────────────────────
    case 'hs': {
      const out = `${dir}${stem}`;
      return (
        `if (Get-Command ghc -ErrorAction SilentlyContinue) {` +
        `  ghc "${filePath}" -o "${out}" -outputdir "${dir}"; if ($LASTEXITCODE -eq 0) { & "${out}" }` +
        `} else { Write-Host "GHC not found. Install Haskell from the Runtimes sidebar." -ForegroundColor Red }`
      );
    }

    // ── Erlang ───────────────────────────────────────────────────────────────
    case 'erl': {
      return (
        `if (Get-Command erlc -ErrorAction SilentlyContinue) {` +
        `  erlc -o "${dir}" "${filePath}"; if ($LASTEXITCODE -eq 0) { erl -noshell -s ${stem} start -s init stop }` +
        `} else { Write-Host "Erlang not found. Install it from the Runtimes sidebar." -ForegroundColor Red }`
      );
    }

    // ── Groovy ───────────────────────────────────────────────────────────────
    case 'groovy':
      return (
        `if (Get-Command groovy -ErrorAction SilentlyContinue) { groovy "${filePath}" }` +
        ` else { Write-Host "Groovy not found. Install it from the Runtimes sidebar." -ForegroundColor Red }`
      );

    // ── Clojure ──────────────────────────────────────────────────────────────
    case 'clj': case 'cljs': case 'cljc':
      return (
        `if (Get-Command clojure -ErrorAction SilentlyContinue) { clojure "${filePath}" }` +
        ` else { Write-Host "Clojure not found. Install it from the Runtimes sidebar." -ForegroundColor Red }`
      );

    // ── Crystal ──────────────────────────────────────────────────────────────
    case 'cr': {
      const out = `${dir}${stem}`;
      return (
        `if (Get-Command crystal -ErrorAction SilentlyContinue) {` +
        `  crystal build "${filePath}" -o "${out}"; if ($LASTEXITCODE -eq 0) { & "${out}" }` +
        `} else { Write-Host "Crystal not found. Install it from the Runtimes sidebar." -ForegroundColor Red }`
      );
    }

    // ── D ────────────────────────────────────────────────────────────────────
    case 'd': {
      const out = `${dir}${stem}`;
      return (
        `$dc = if (Get-Command dmd -ErrorAction SilentlyContinue) { "dmd" }` +
        ` elseif (Get-Command ldc2 -ErrorAction SilentlyContinue) { "ldc2" } else { $null };` +
        `if ($dc) { & $dc "${filePath}" -of="${out}"; if ($LASTEXITCODE -eq 0) { & "${out}" } }` +
        ` else { Write-Host "D compiler not found. Install D from the Runtimes sidebar." -ForegroundColor Red }`
      );
    }

    // ── Nim ──────────────────────────────────────────────────────────────────
    case 'nim': {
      const out = `${dir}${stem}`;
      return (
        `if (Get-Command nim -ErrorAction SilentlyContinue) {` +
        `  nim c -o:"${out}" "${filePath}"; if ($LASTEXITCODE -eq 0) { & "${out}" }` +
        `} else { Write-Host "Nim not found. Install it from the Runtimes sidebar." -ForegroundColor Red }`
      );
    }

    // ── Zig ──────────────────────────────────────────────────────────────────
    case 'zig':
      return (
        `if (Get-Command zig -ErrorAction SilentlyContinue) { zig run "${filePath}" }` +
        ` else { Write-Host "Zig not found. Install it from the Runtimes sidebar." -ForegroundColor Red }`
      );

    // ── V (vlang) ────────────────────────────────────────────────────────────
    case 'v': {
      const out = `${dir}${stem}`;
      return (
        `if (Get-Command v -ErrorAction SilentlyContinue) {` +
        `  v -o "${out}" "${filePath}"; if ($LASTEXITCODE -eq 0) { & "${out}" }` +
        `} else { Write-Host "V not found. Install it from the Runtimes sidebar." -ForegroundColor Red }`
      );
    }

    // ── Ada ──────────────────────────────────────────────────────────────────
    case 'adb': case 'ads': {
      const out = `${dir}${stem}`;
      return (
        `if (Get-Command gnatmake -ErrorAction SilentlyContinue) {` +
        `  Set-Location "${dir}"; gnatmake "${filePath}" -o "${out}"; if ($LASTEXITCODE -eq 0) { & "${out}" }` +
        `} else { Write-Host "GNAT (Ada) not found. Install it from the Runtimes sidebar." -ForegroundColor Red }`
      );
    }

    // ── COBOL ────────────────────────────────────────────────────────────────
    case 'cbl': case 'cob': {
      const out = `${dir}${stem}`;
      return (
        `if (Get-Command cobc -ErrorAction SilentlyContinue) {` +
        `  cobc -x -o "${out}" "${filePath}"; if ($LASTEXITCODE -eq 0) { & "${out}" }` +
        `} else { Write-Host "GnuCOBOL not found. Install it from the Runtimes sidebar." -ForegroundColor Red }`
      );
    }

    // ── LaTeX ────────────────────────────────────────────────────────────────
    case 'tex': {
      return (
        `$latex = if (Get-Command pdflatex -ErrorAction SilentlyContinue) { "pdflatex" }` +
        ` elseif (Get-Command xelatex -ErrorAction SilentlyContinue) { "xelatex" } else { $null };` +
        `if ($latex) { Set-Location "${dir}"; & $latex -interaction=nonstopmode "${filePath}"; if ($LASTEXITCODE -eq 0) { Write-Host "PDF compiled: ${stem}.pdf" -ForegroundColor Green } }` +
        ` else { Write-Host "LaTeX not found. Install MiKTeX from the Runtimes sidebar." -ForegroundColor Red }`
      );
    }

    // ── Octave ───────────────────────────────────────────────────────────────
    case 'm':
      return (
        `if (Get-Command octave -ErrorAction SilentlyContinue) { octave --no-gui "${filePath}" }` +
        ` else { Write-Host "GNU Octave not found. Install it from the Runtimes sidebar." -ForegroundColor Red }`
      );

    // ── Wolfram ──────────────────────────────────────────────────────────────
    case 'wl': case 'nb':
      return (
        `if (Get-Command wolframscript -ErrorAction SilentlyContinue) { wolframscript -file "${filePath}" }` +
        ` else { Write-Host "Wolfram Engine not found. Install it from the Runtimes sidebar." -ForegroundColor Red }`
      );

    // ── SAS ──────────────────────────────────────────────────────────────────
    case 'sas':
      return (
        `if (Get-Command sas -ErrorAction SilentlyContinue) { sas "${filePath}" }` +
        ` else { Write-Host "SAS not found. Install it from the Runtimes sidebar." -ForegroundColor Red }`
      );

    // ── F# ──────────────────────────────────────────────────────────────────
    case 'fs': case 'fsx':
      return (
        `if (Get-Command dotnet -ErrorAction SilentlyContinue) { dotnet fsi --nologo "${filePath}" }` +
        ` else { Write-Host "dotnet SDK not found. Install it from the Runtimes sidebar." -ForegroundColor Red }`
      );

    // ── VB.NET ───────────────────────────────────────────────────────────────
    // VB.NET has no single-file script runner; must be inside a dotnet project.
    case 'vb':
      return (
        `if (Get-Command dotnet -ErrorAction SilentlyContinue) {` +
        `  $proj = Get-ChildItem -Path "${dir}" -Filter "*.vbproj" -Recurse -ErrorAction SilentlyContinue | Select-Object -First 1;` +
        `  if ($proj) { Set-Location $proj.DirectoryName; dotnet run }` +
        `  else { Write-Host "No .vbproj found in the project directory. Create a VB.NET project via File > New Project to run VB.NET files." -ForegroundColor Yellow }` +
        `} else { Write-Host "dotnet SDK not found. Install it from the Runtimes sidebar." -ForegroundColor Red }`
      );

    default:
      return null;
  }
}

function getExt(name: string): string {
  return name.split('.').pop()?.toLowerCase() ?? '';
}

export function EditorArea({
  tabs, activeTabId, onSelectTab, onCloseTab,
  onUpdateContent, onSaveFile,
  showTerminal, onToggleTerminal, terminal,
  previewUrl, onClearPreviewUrl,
  onRunCommand,
}: EditorAreaProps) {
  const activeTab = tabs.find((t) => t.id === activeTabId);
  const [lastPreviewUrl, setLastPreviewUrl] = useState('http://localhost:3000');

  // Inline preview state
  const [inlinePreview, setInlinePreview]   = useState(false);
  const [previewBlobUrl, setPreviewBlobUrl] = useState<string | null>(null);
  const prevBlobRef = useRef<string | null>(null);

  // Revoke old blob URLs to avoid memory leaks
  const setBlobUrl = useCallback((url: string | null) => {
    if (prevBlobRef.current) URL.revokeObjectURL(prevBlobRef.current);
    prevBlobRef.current = url;
    setPreviewBlobUrl(url);
  }, []);

  // Close inline preview when active tab changes
  useEffect(() => {
    setInlinePreview(false);
    setBlobUrl(null);
  }, [activeTabId, setBlobUrl]);

  // Auto-open floating preview when terminal emits a localhost URL
  useEffect(() => {
    if (previewUrl && previewUrl !== lastPreviewUrl) {
      setLastPreviewUrl(previewUrl);
      onClearPreviewUrl?.();
      openFloatingPreview(previewUrl);
    }
  }, [previewUrl, lastPreviewUrl, onClearPreviewUrl]);

  const openFloatingPreview = (url?: string) => {
    const target = url || lastPreviewUrl || 'http://localhost:3000';
    if (isElectron()) {
      (window as any).electronAPI?.openPreviewWindow?.(target);
    } else {
      window.open(target, '_blank');
    }
  };

  const handlePreview = useCallback(() => {
    if (!activeTab) return;
    const ext = getExt(activeTab.name);
    const filePath = activeTab.path || activeTab.name;
    // Build dir and stem for compile+run languages
    const parts = filePath.split(/[\\/]/);
    const fileName = parts[parts.length - 1];
    const dir = filePath.slice(0, filePath.length - fileName.length);
    const stem = fileName.includes('.') ? fileName.slice(0, fileName.lastIndexOf('.')) : fileName;

    const cmd = getRunCommand(ext, filePath, dir, stem);

    if (cmd === '__inline__') {
      // HTML — render inline
      const blob = new Blob([activeTab.content], { type: 'text/html' });
      setBlobUrl(URL.createObjectURL(blob));
      setInlinePreview(true);
      return;
    }

    if (cmd) {
      // All runnable languages — send to terminal
      // onRunCommand already calls setShowTerminal(true) — do NOT call onToggleTerminal here
      if (!activeTab.path) {
        onRunCommand?.(`echo "Save the file first before running."`);
      } else {
        onRunCommand?.(cmd, activeTab.name);
      }
      return;
    }

    // No runner for this type — open floating preview as fallback
    openFloatingPreview();
  }, [activeTab, onRunCommand, showTerminal, onToggleTerminal, setBlobUrl]);

  const closeInlinePreview = useCallback(() => {
    setInlinePreview(false);
    setBlobUrl(null);
  }, [setBlobUrl]);

  // Refresh the inline preview with current content (live reload)
  const refreshInlinePreview = useCallback(() => {
    if (!activeTab) return;
    const blob = new Blob([activeTab.content], { type: 'text/html' });
    setBlobUrl(URL.createObjectURL(blob));
  }, [activeTab, setBlobUrl]);

  const ext = activeTab ? getExt(activeTab.name) : '';
  const runCmd = activeTab
    ? getRunCommand(ext, activeTab.path || activeTab.name,
        (() => { const p = activeTab.path || ''; const sep = p.includes('\\') ? '\\' : '/'; return p.slice(0, p.lastIndexOf(sep) + 1); })(),
        (() => { const n = activeTab.name; return n.includes('.') ? n.slice(0, n.lastIndexOf('.')) : n; })())
    : null;
  const isHtmlFile  = runCmd === '__inline__';
  const isRunnable  = runCmd !== null;

  return (
    <div className="flex flex-col h-full bg-surface-0">
      {/* Tab bar */}
      <div className="flex items-center bg-surface-1 border-b border-surface-3 flex-shrink-0">
        <div className="flex items-stretch overflow-x-auto flex-1">
          {tabs.length === 0 && (
            <div className="px-4 py-2 text-2xs text-ink-low italic">No files open</div>
          )}
          {tabs.map((tab) => (
            <button
              key={tab.id}
              onClick={() => onSelectTab(tab.id)}
              className={`flex items-center gap-1.5 px-3 py-2 border-r border-surface-3 text-xs whitespace-nowrap transition-colors group ${
                tab.id === activeTabId
                  ? 'bg-surface-0 text-ink-high'
                  : 'bg-surface-1 text-ink-mid hover:bg-surface-2'
              }`}
            >
              <TabIcon name={tab.name} />
              <span className={tab.dirty ? 'italic' : ''}>{tab.name}</span>
              {tab.dirty && <Circle size={6} className="text-primary-400 fill-primary-400" />}
              <span
                onClick={(e) => { e.stopPropagation(); onCloseTab(tab.id); }}
                className="ml-1 p-0.5 rounded hover:bg-surface-3 opacity-0 group-hover:opacity-100 transition-opacity"
              >
                <X size={12} />
              </span>
            </button>
          ))}
        </div>

        {/* ▶ Run button — always present, label/icon adapts, disabled if no runner */}
        {activeTab && (
          <button
            onClick={handlePreview}
            disabled={!isRunnable}
            title={
              !isRunnable      ? `No runner for .${ext} files`
              : isHtmlFile     ? 'Preview HTML inline'
              : `Run: ${runCmd}`
            }
            className={`flex items-center gap-1.5 px-3 py-2 text-2xs border-l border-surface-3 transition-colors ${
              inlinePreview
                ? 'text-accent-400 bg-surface-2'
                : isRunnable
                  ? 'text-ink-mid hover:text-ink-high'
                  : 'text-ink-low opacity-40 cursor-not-allowed'
            }`}
          >
            <Play size={12} className={isRunnable ? '' : 'opacity-50'} />
            Run
          </button>
        )}

        {/* Terminal toggle */}
        <button
          onClick={onToggleTerminal}
          className={`flex items-center gap-1.5 px-3 py-2 text-2xs border-l border-surface-3 transition-colors ${
            showTerminal ? 'text-accent-400 bg-surface-2' : 'text-ink-mid hover:text-ink-high'
          }`}
        >
          <TerminalIcon size={13} />
          Terminal
        </button>
      </div>

      {/* Main content area — editor + optional inline preview side by side */}
      <div className="flex-1 overflow-hidden flex">

        {/* Editor */}
        <div className={`flex flex-col overflow-hidden ${inlinePreview ? 'w-1/2' : 'flex-1'}`}>
          {activeTab ? (
            <div className="flex flex-col h-full overflow-hidden">
              <div className="px-3 py-1.5 bg-surface-1 border-b border-surface-3 flex items-center gap-1 text-2xs text-ink-low flex-shrink-0">
                <span className="font-mono truncate">{activeTab.path}</span>
                <span className="ml-auto text-ink-low">{activeTab.language}</span>
              </div>
              <div className="flex-1 overflow-hidden">
                <CodeMirrorEditor
                  key={activeTab.id}
                  tabId={activeTab.id}
                  content={activeTab.content}
                  language={activeTab.language}
                  onChange={(c) => onUpdateContent(activeTab.id, c)}
                  onSave={onSaveFile}
                />
              </div>
            </div>
          ) : (
            <EmptyEditor />
          )}
        </div>

        {/* Inline HTML preview panel */}
        {inlinePreview && previewBlobUrl && (
          <div className="w-1/2 flex flex-col border-l border-surface-3 bg-white">
            {/* Preview toolbar */}
            <div className="flex items-center gap-1 px-2 py-1 bg-surface-1 border-b border-surface-3 flex-shrink-0">
              <Globe size={12} className="text-accent-400" />
              <span className="text-2xs text-ink-mid flex-1">Preview — {activeTab?.name}</span>
              <button
                onClick={refreshInlinePreview}
                title="Refresh preview with current content"
                className="px-2 py-0.5 text-2xs text-ink-mid hover:text-ink-high hover:bg-surface-2 rounded transition-colors"
              >
                ↺ Refresh
              </button>
              <button
                onClick={closeInlinePreview}
                title="Close preview"
                className="p-0.5 text-ink-low hover:text-error-400 rounded transition-colors"
              >
                <XCircle size={13} />
              </button>
            </div>
            <iframe
              src={previewBlobUrl}
              className="flex-1 w-full"
              sandbox="allow-scripts allow-same-origin"
              title="HTML Preview"
            />
          </div>
        )}
      </div>

      {/* Terminal dock — always mounted so terminalRef is always valid; no transition so it appears instantly */}
      <div
        className="border-t border-surface-3 flex-shrink-0 overflow-hidden"
        style={{ height: showTerminal ? 208 : 0, borderTopWidth: showTerminal ? 1 : 0 }}
      >
        {terminal}
      </div>
    </div>
  );
}

function EmptyEditor() {
  return (
    <div className="flex flex-col items-center justify-center h-full text-center px-8">
      <div className="w-14 h-14 rounded-xl bg-surface-2 border border-surface-3 flex items-center justify-center mb-4">
        <FileCode2 size={26} className="text-ink-low" />
      </div>
      <h3 className="text-sm font-medium text-ink-mid mb-1">No file open</h3>
      <p className="text-2xs text-ink-low max-w-xs">
        Select a file from the tree to start editing. AI-generated code can be inserted here with the
        <span className="inline-flex items-center mx-1 text-accent-400"><Sparkles size={10} /> Insert</span>
        button on any code block.
      </p>
    </div>
  );
}

function TabIcon({ name }: { name: string }) {
  const ext = name.split('.').pop()?.toLowerCase() ?? '';
  const cls = 'flex-shrink-0';
  if (['json'].includes(ext)) return <FileJson size={13} className={`${cls} text-warning-400`} />;
  if (['md', 'txt'].includes(ext)) return <FileText size={13} className={`${cls} text-ink-mid`} />;
  return <FileCode2 size={13} className={`${cls} text-primary-400`} />;
}
