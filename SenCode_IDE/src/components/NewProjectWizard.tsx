import { useState, useCallback, useEffect } from 'react';
import { X, FolderPlus, ChevronRight, ChevronLeft, Folder, Loader2, AlertTriangle, CheckCircle2 } from 'lucide-react';

// ── Language definitions ──────────────────────────────────────────────────────

interface LangDef {
  id: string;
  label: string;
  icon: string;
  starter: string;
  deps: string | null;
  category: string;
  /** runtimeId that must be installed. null = always available. */
  runtimeId: string | null;
}

const LANGUAGES: LangDef[] = [
  { id: 'typescript', label: 'TypeScript', icon: '🟦', starter: 'index.ts',   deps: 'tsconfig.json',    category: 'Web',       runtimeId: 'nodejs'     },
  { id: 'javascript', label: 'JavaScript', icon: '🟨', starter: 'index.js',   deps: 'package.json',      category: 'Web',       runtimeId: 'nodejs'     },
  { id: 'html',       label: 'HTML',       icon: '🌐', starter: 'index.html', deps: null,                category: 'Web',       runtimeId: null         },
  { id: 'php',        label: 'PHP',        icon: '🐘', starter: 'index.php',  deps: null,                category: 'Web',       runtimeId: 'php'        },
  { id: 'python',     label: 'Python',     icon: '🐍', starter: 'main.py',    deps: 'requirements.txt',  category: 'Scripting', runtimeId: 'python'     },
  { id: 'bash',       label: 'Shell',      icon: '💻', starter: 'run.sh',     deps: null,                category: 'Scripting', runtimeId: 'bash'       },
  { id: 'powershell', label: 'PowerShell', icon: '🔵', starter: 'run.ps1',    deps: null,                category: 'Scripting', runtimeId: 'powershell' },
  { id: 'lua',        label: 'Lua',        icon: '🌙', starter: 'main.lua',   deps: null,                category: 'Scripting', runtimeId: 'lua'        },
  { id: 'r',          label: 'R',          icon: '📊', starter: 'main.r',     deps: null,                category: 'Scripting', runtimeId: 'r'          },
  { id: 'ruby',       label: 'Ruby',       icon: '💎', starter: 'main.rb',    deps: 'Gemfile',           category: 'Scripting', runtimeId: 'ruby'       },
  { id: 'java',       label: 'Java',       icon: '☕', starter: 'Main.java',  deps: null,                category: 'JVM',       runtimeId: 'java'       },
  { id: 'kotlin',     label: 'Kotlin',     icon: '🟣', starter: 'Main.kt',    deps: null,                category: 'JVM',       runtimeId: 'kotlin'     },
  { id: 'rust',       label: 'Rust',       icon: '🦀', starter: 'src/main.rs',deps: 'Cargo.toml',        category: 'Systems',   runtimeId: 'rust'       },
  { id: 'go',         label: 'Go',         icon: '🐹', starter: 'main.go',    deps: 'go.mod',            category: 'Systems',   runtimeId: 'go'         },
  { id: 'cpp',        label: 'C++',        icon: '⚙️', starter: 'main.cpp',   deps: null,                category: 'Systems',   runtimeId: 'gcc'        },
  { id: 'c',          label: 'C',          icon: '🔧', starter: 'main.c',     deps: null,                category: 'Systems',   runtimeId: 'gcc'        },
  { id: 'csharp',     label: 'C#',         icon: '💜', starter: 'Program.cs', deps: null,                category: 'Microsoft', runtimeId: 'dotnet'     },
  { id: 'fsharp',     label: 'F#',         icon: '🔷', starter: 'Program.fs', deps: null,                category: 'Microsoft', runtimeId: 'dotnet'     },
  { id: 'vbnet',      label: 'VB.NET',     icon: '🟪', starter: 'Program.vb', deps: null,                category: 'Microsoft', runtimeId: 'dotnet'     },
  { id: 'dart',       label: 'Dart',       icon: '🎯', starter: 'main.dart',  deps: 'pubspec.yaml',      category: 'Mobile',    runtimeId: 'dart'       },
  { id: 'swift',      label: 'Swift',      icon: '🦅', starter: 'main.swift', deps: null,                category: 'Apple',       runtimeId: 'swift'      },
  { id: 'perl',       label: 'Perl',       icon: '🐪', starter: 'main.pl',    deps: null,                category: 'Scripting',   runtimeId: 'perl'       },
  { id: 'julia',      label: 'Julia',      icon: '🔵', starter: 'main.jl',    deps: null,                category: 'Scripting',   runtimeId: 'julia'      },
  { id: 'scala',      label: 'Scala',      icon: '🔴', starter: 'Main.scala', deps: null,                category: 'JVM',         runtimeId: 'scala'      },
  { id: 'groovy',     label: 'Groovy',     icon: '🎷', starter: 'main.groovy',deps: null,                category: 'JVM',         runtimeId: 'groovy'     },
  { id: 'clojure',    label: 'Clojure',    icon: '🌀', starter: 'src/main.clj',deps: 'deps.edn',         category: 'JVM',         runtimeId: 'clojure'    },
  { id: 'haskell',    label: 'Haskell',    icon: '🎩', starter: 'Main.hs',    deps: null,                category: 'Functional',  runtimeId: 'haskell'    },
  { id: 'erlang',     label: 'Erlang',     icon: '📡', starter: 'main.erl',   deps: null,                category: 'Functional',  runtimeId: 'erlang'     },
  { id: 'elixir',     label: 'Elixir',     icon: '💧', starter: 'main.ex',    deps: null,                category: 'Functional',  runtimeId: 'elixir'     },
  { id: 'crystal',    label: 'Crystal',    icon: '🔮', starter: 'main.cr',    deps: null,                category: 'Systems',     runtimeId: 'crystal'    },
  { id: 'd',          label: 'D',          icon: '🔷', starter: 'main.d',     deps: null,                category: 'Systems',     runtimeId: 'dlang'      },
  { id: 'nim',        label: 'Nim',        icon: '👑', starter: 'main.nim',   deps: null,                category: 'Systems',     runtimeId: 'nim'        },
  { id: 'zig',        label: 'Zig',        icon: '⚡', starter: 'src/main.zig',deps: 'build.zig',        category: 'Systems',     runtimeId: 'zig'        },
  { id: 'vlang',      label: 'V',          icon: '🔹', starter: 'main.v',     deps: null,                category: 'Systems',     runtimeId: 'vlang'      },
  { id: 'ada',        label: 'Ada',        icon: '🏛',  starter: 'main.adb',   deps: null,                category: 'Systems',     runtimeId: 'ada'        },
  { id: 'cobol',      label: 'COBOL',      icon: '🗄',  starter: 'main.cbl',   deps: null,                category: 'Legacy',      runtimeId: 'cobol'      },
  { id: 'latex',      label: 'LaTeX',      icon: '📄', starter: 'main.tex',   deps: null,                category: 'Typesetting', runtimeId: 'latex'      },
  { id: 'octave',     label: 'Octave',     icon: '📐', starter: 'main.m',     deps: null,                category: 'Scientific',  runtimeId: 'octave'     },
  { id: 'wolfram',    label: 'Wolfram',    icon: '🧮', starter: 'main.wl',    deps: null,                category: 'Scientific',  runtimeId: 'wolfram'    },
  { id: 'sas',        label: 'SAS',        icon: '📈', starter: 'main.sas',   deps: null,                category: 'Scientific',  runtimeId: 'sas'        },
];

// ── Project type definitions ──────────────────────────────────────────────────

interface ProjectType {
  id: string;
  label: string;
  desc: string;
}

const PROJECT_TYPES: Record<string, ProjectType[]> = {
  typescript: [
    { id: 'script', label: 'Script',       desc: 'index.ts + tsconfig.json — run with npx tsx' },
    { id: 'node',   label: 'Node Project', desc: 'index.ts + package.json + tsconfig.json' },
  ],
  javascript: [
    { id: 'script', label: 'Script',       desc: 'index.js only — run with node' },
    { id: 'node',   label: 'Node Project', desc: 'index.js + package.json (type: module)' },
  ],
  python: [
    { id: 'script',  label: 'Script',  desc: 'main.py + requirements.txt' },
    { id: 'package', label: 'Package', desc: 'src/ layout + pyproject.toml (PEP 517)' },
  ],
  java: [
    { id: 'plain',  label: 'Plain',  desc: 'Main.java at project root' },
    { id: 'maven',  label: 'Maven',  desc: 'pom.xml + src/main/java/Main.java' },
    { id: 'gradle', label: 'Gradle', desc: 'build.gradle + settings.gradle + src/main/java/Main.java' },
  ],
  kotlin: [
    { id: 'plain',  label: 'Plain',  desc: 'Main.kt at project root' },
    { id: 'gradle', label: 'Gradle (Kotlin DSL)', desc: 'build.gradle.kts + settings.gradle.kts + src/main/kotlin/Main.kt' },
  ],
  rust: [
    { id: 'binary',  label: 'Binary',  desc: 'src/main.rs + Cargo.toml — builds an executable' },
    { id: 'library', label: 'Library', desc: 'src/lib.rs + Cargo.toml — builds a crate library' },
  ],
  go: [
    { id: 'module', label: 'Module', desc: 'main.go + go.mod — full Go module setup' },
    { id: 'plain',  label: 'Plain',  desc: 'main.go only — no module file' },
  ],
  cpp: [
    { id: 'plain', label: 'Plain',  desc: 'main.cpp — compile manually with g++' },
    { id: 'cmake', label: 'CMake',  desc: 'main.cpp + CMakeLists.txt' },
  ],
  c: [
    { id: 'plain', label: 'Plain',  desc: 'main.c — compile manually with gcc' },
    { id: 'cmake', label: 'CMake',  desc: 'main.c + CMakeLists.txt' },
  ],
  csharp: [
    { id: 'console', label: 'Console App',    desc: 'Single Program.cs file' },
    { id: 'dotnet',  label: '.NET Project',   desc: 'Program.cs + <name>.csproj (targets net8.0)' },
  ],
  fsharp: [
    { id: 'console', label: 'Console App',    desc: 'Single Program.fs file — run with dotnet fsi' },
    { id: 'dotnet',  label: '.NET Project',   desc: 'Program.fs + <name>.fsproj (targets net8.0)' },
  ],
  vbnet: [
    { id: 'console', label: 'Console App',    desc: 'Single Program.vb file' },
    { id: 'dotnet',  label: '.NET Project',   desc: 'Program.vb + <name>.vbproj (targets net8.0)' },
  ],
  haskell: [
    { id: 'plain',  label: 'Plain',  desc: 'Main.hs at project root — run with runghc' },
    { id: 'stack',  label: 'Stack',  desc: 'app/Main.hs + package.yaml + stack.yaml — Stack build tool' },
    { id: 'cabal',  label: 'Cabal',  desc: 'app/Main.hs + <name>.cabal — Cabal build tool' },
  ],
  elixir: [
    { id: 'plain', label: 'Plain Script', desc: 'main.ex — run with elixir' },
    { id: 'mix',   label: 'Mix Project',  desc: 'lib/<name>.ex + mix.exs — full Mix project' },
  ],
  scala: [
    { id: 'plain', label: 'Plain', desc: 'Main.scala at project root — compile with scalac' },
    { id: 'sbt',   label: 'sbt',   desc: 'src/main/scala/Main.scala + build.sbt — sbt build tool' },
  ],
  crystal: [
    { id: 'plain',  label: 'Plain',  desc: 'main.cr at project root — run with crystal' },
    { id: 'shards', label: 'Shards', desc: 'src/<name>.cr + shard.yml — Shards dependency manager' },
  ],
  nim: [
    { id: 'plain',  label: 'Plain Script',   desc: 'main.nim at project root — compile with nim c' },
    { id: 'nimble', label: 'Nimble Project', desc: 'main.nim + <name>.nimble — Nimble package manager' },
  ],
  clojure: [
    { id: 'plain', label: 'Plain',    desc: 'src/main.clj — run with clojure' },
    { id: 'deps',  label: 'deps.edn', desc: 'src/main.clj + deps.edn — Clojure CLI tools project' },
  ],
};

// Languages that have a Step 3 (project type selection)
function hasProjectTypes(langId: string): boolean {
  return langId in PROJECT_TYPES;
}

// ── Step types ────────────────────────────────────────────────────────────────

type Step = 'lang' | 'name' | 'type' | 'folder' | 'creating';

// ── Component ────────────────────────────────────────────────────────────────

interface NewProjectWizardProps {
  onClose: () => void;
  onCreated: (projectPath: string) => void;
}

export function NewProjectWizard({ onClose, onCreated }: NewProjectWizardProps) {
  const [step, setStep]               = useState<Step>('lang');
  const [lang, setLang]               = useState<LangDef | null>(null);
  const [projectName, setProjectName] = useState('');
  const [projectType, setProjectType] = useState<string>('');
  const [parentDir, setParentDir]     = useState<string>('');
  const [error, setError]             = useState('');
  const [creating, setCreating]       = useState(false);

  // Runtime detection for the language picker
  const [detectedRuntimes, setDetectedRuntimes] = useState<Set<string>>(new Set());
  const [runtimesLoading, setRuntimesLoading]   = useState(true);

  useEffect(() => {
    const bridge = (window as any).electronAPI;
    if (!bridge?.detectRuntimes) { setRuntimesLoading(false); return; }
    bridge.detectRuntimes()
      .then((rts: { id: string; installed: boolean }[]) => {
        const installed = new Set(rts.filter(r => r.installed).map(r => r.id));
        // PowerShell is always available on Windows
        installed.add('powershell');
        // bash is available if Git for Windows is installed (covered by PATH probe)
        setDetectedRuntimes(installed);
      })
      .catch(() => { /* silent — treat all as unavailable */ })
      .finally(() => setRuntimesLoading(false));
  }, []);

  const isLangAvailable = useCallback((l: LangDef): boolean => {
    if (runtimesLoading) return false;
    if (l.runtimeId === null) return true;               // always available (HTML, etc.)
    if (l.runtimeId === 'powershell') return true;       // always on Windows
    return detectedRuntimes.has(l.runtimeId);
  }, [detectedRuntimes, runtimesLoading]);

  // Derived: sanitized project name
  const sanitizedName = projectName.trim()
    .replace(/[^a-zA-Z0-9_\- .]/g, '')
    .replace(/\s+/g, '-')
    .replace(/^[-. ]+|[-. ]+$/g, '') || '';

  // Derived: preview path
  const previewPath = parentDir && sanitizedName
    ? `${parentDir}\\${sanitizedName}`
    : '';

  // ── Navigation helpers ───────────────────────────────────────────────────

  const selectLang = useCallback((l: LangDef) => {
    setLang(l);
    setProjectName(`my-${l.id}-project`);
    // Reset downstream choices when language changes
    const types = PROJECT_TYPES[l.id];
    setProjectType(types ? types[0].id : '');
    setError('');
    setStep('name');
  }, []);

  const advanceFromName = useCallback(() => {
    if (!sanitizedName) { setError('Enter a valid project name'); return; }
    setError('');
    if (lang && hasProjectTypes(lang.id)) {
      setStep('type');
    } else {
      setStep('folder');
    }
  }, [sanitizedName, lang]);

  const advanceFromType = useCallback(() => {
    setError('');
    setStep('folder');
  }, []);

  const browseFolder = useCallback(async () => {
    const bridge = (window as any).electronAPI;
    if (!bridge?.openFolderDialog) return;
    const chosen: string | null = await bridge.openFolderDialog();
    if (chosen) { setParentDir(chosen); setError(''); }
  }, []);

  const create = useCallback(async () => {
    if (!sanitizedName || !lang || !parentDir) return;
    setCreating(true);
    setStep('creating');
    setError('');
    try {
      const bridge = (window as any).electronAPI;
      const result = await bridge?.createProject?.({
        name       : sanitizedName,
        language   : lang.id,
        projectType: projectType || undefined,
        parentDir,
      });
      if (result?.ok && result.path) {
        onCreated(result.path);
      } else {
        setError(result?.error ?? 'Failed to create project.');
        setStep('folder');
        setCreating(false);
      }
    } catch (e: any) {
      setError(e?.message ?? 'Unknown error');
      setStep('folder');
      setCreating(false);
    }
  }, [sanitizedName, lang, projectType, parentDir, onCreated]);

  // ── Step labels for the header ───────────────────────────────────────────

  const stepLabel: Record<Step, string> = {
    lang:     'Choose a language',
    name:     'Name your project',
    type:     'Choose project type',
    folder:   'Choose parent folder',
    creating: 'Setting up files…',
  };

  // ── Step indicator ───────────────────────────────────────────────────────

  const STEPS: Step[] = lang && hasProjectTypes(lang.id)
    ? ['lang', 'name', 'type', 'folder', 'creating']
    : ['lang', 'name', 'folder', 'creating'];

  const stepIndex = STEPS.indexOf(step);

  const categories = [...new Set(LANGUAGES.map(l => l.category))];

  // Check if a folder with the project name already exists at the chosen parent
  const targetExists = Boolean(parentDir && sanitizedName); // evaluated at runtime via IPC not available here; show warning based on user input pattern only

  // ── Render ───────────────────────────────────────────────────────────────

  return (
    <div className="fixed inset-0 bg-black/60 flex items-center justify-center z-[9990] animate-fade-in">
      <div className="bg-surface-1 border border-surface-3 rounded-2xl shadow-2xl w-full max-w-lg mx-4 overflow-hidden flex flex-col max-h-[90vh]">

        {/* ── Header ─────────────────────────────────────────────────────── */}
        <div className="flex items-center justify-between px-5 py-4 border-b border-surface-3 flex-shrink-0">
          <div className="flex items-center gap-2.5">
            <div className="w-8 h-8 rounded-lg bg-primary-600/20 flex items-center justify-center">
              <FolderPlus size={16} className="text-primary-400" />
            </div>
            <div>
              <h2 className="text-sm font-semibold text-ink-high">New Project</h2>
              <p className="text-2xs text-ink-low">{stepLabel[step]}</p>
            </div>
          </div>
          {step !== 'creating' && (
            <button onClick={onClose} className="p-1.5 rounded-lg text-ink-low hover:text-ink-high hover:bg-surface-2 transition-colors">
              <X size={14} />
            </button>
          )}
        </div>

        {/* ── Step indicator dots ─────────────────────────────────────────── */}
        {step !== 'creating' && (
          <div className="flex items-center justify-center gap-1.5 pt-3 pb-0 flex-shrink-0">
            {STEPS.filter(s => s !== 'creating').map((s, i) => (
              <div
                key={s}
                className={`h-1.5 rounded-full transition-all ${
                  i === stepIndex ? 'w-6 bg-primary-400' : i < stepIndex ? 'w-1.5 bg-primary-600/50' : 'w-1.5 bg-surface-3'
                }`}
              />
            ))}
          </div>
        )}

        {/* ── Step 1: Language picker ──────────────────────────────────────── */}
        {step === 'lang' && (
          <div className="p-4 overflow-y-auto flex-1 space-y-4">
            {runtimesLoading && (
              <div className="flex items-center gap-2 text-2xs text-ink-low px-0.5 pb-1">
                <Loader2 size={11} className="animate-spin" />
                Detecting installed runtimes…
              </div>
            )}
            {categories.map(cat => (
              <div key={cat}>
                <p className="text-2xs font-bold text-ink-low uppercase tracking-widest mb-2 px-0.5">{cat}</p>
                <div className="grid grid-cols-3 gap-1.5">
                  {LANGUAGES.filter(l => l.category === cat).map(l => {
                    const available = isLangAvailable(l);
                    return (
                      <button
                        key={l.id}
                        onClick={() => available && selectLang(l)}
                        disabled={!available}
                        title={!available && l.runtimeId ? `Runtime not installed (${l.runtimeId})` : undefined}
                        className={`flex items-center gap-2 px-3 py-2.5 rounded-lg border text-left transition-all relative group
                          ${available
                            ? 'bg-surface-2 border-surface-3 hover:border-primary-500/50 hover:bg-surface-3 cursor-pointer'
                            : 'bg-surface-1 border-surface-2 opacity-50 cursor-not-allowed'
                          }`}
                      >
                        <span className="text-base flex-shrink-0">{l.icon}</span>
                        <div className="flex flex-col min-w-0">
                          <span className={`text-xs font-medium truncate ${available ? 'text-ink-mid group-hover:text-ink-high' : 'text-ink-low'}`}>
                            {l.label}
                          </span>
                          {!available && l.runtimeId && (
                            <span className="text-2xs text-amber-500/80 leading-tight truncate">Not installed</span>
                          )}
                        </div>
                      </button>
                    );
                  })}
                </div>
              </div>
            ))}
          </div>
        )}

        {/* ── Step 2: Project Name ─────────────────────────────────────────── */}
        {step === 'name' && lang && (
          <div className="p-5 flex-1 overflow-y-auto">
            {/* Language badge */}
            <div className="flex items-center gap-3 mb-5 p-3 rounded-xl bg-surface-2 border border-surface-3">
              <span className="text-2xl flex-shrink-0">{lang.icon}</span>
              <div className="flex-1 min-w-0">
                <p className="text-sm font-semibold text-ink-high">{lang.label} Project</p>
                <p className="text-2xs text-ink-low truncate">
                  Starter: <code className="text-accent-400">{lang.starter}</code>
                  {lang.deps && <> · Also: <code className="text-accent-400">{lang.deps}</code></>}
                </p>
              </div>
              <button onClick={() => setStep('lang')}
                className="text-2xs text-primary-400 hover:text-primary-300 transition-colors flex-shrink-0">
                Change
              </button>
            </div>

            <label className="block text-xs font-medium text-ink-mid mb-1.5">Project name</label>
            <input
              autoFocus
              value={projectName}
              onChange={e => { setProjectName(e.target.value); setError(''); }}
              onKeyDown={e => { if (e.key === 'Enter') advanceFromName(); if (e.key === 'Escape') onClose(); }}
              placeholder="my-project"
              className="w-full px-3 py-2.5 bg-surface-2 border border-surface-3 rounded-xl text-sm text-ink-high placeholder:text-ink-low focus:outline-none focus:border-primary-500 transition-colors"
            />
            {sanitizedName && sanitizedName !== projectName.trim() && (
              <p className="mt-1 text-2xs text-ink-low">
                Your folder will be named: <code className="text-accent-400">{sanitizedName}</code>
              </p>
            )}
            {sanitizedName && sanitizedName === projectName.trim() && (
              <p className="mt-1 text-2xs text-ink-low">
                Your folder will be named: <code className="text-accent-400">{sanitizedName}</code>
              </p>
            )}
            {error && <p className="mt-1.5 text-2xs text-error-400">{error}</p>}

            <div className="flex gap-2 justify-between mt-5">
              <button onClick={() => setStep('lang')}
                className="px-3 py-2 text-xs text-ink-mid hover:text-ink-high rounded-lg border border-surface-3 hover:border-surface-4 transition-colors flex items-center gap-1">
                <ChevronLeft size={12} /> Back
              </button>
              <button onClick={advanceFromName} disabled={!projectName.trim()}
                className="px-4 py-2 text-xs font-medium text-white rounded-lg transition-colors flex items-center gap-1.5 disabled:opacity-50"
                style={{ background: 'var(--primary)' }}>
                Next <ChevronRight size={12} />
              </button>
            </div>
          </div>
        )}

        {/* ── Step 3: Project Type ─────────────────────────────────────────── */}
        {step === 'type' && lang && (
          <div className="p-5 flex-1 overflow-y-auto">
            <p className="text-xs text-ink-mid mb-3">
              How should your <strong className="text-ink-high">{lang.label}</strong> project be structured?
            </p>
            <div className="grid grid-cols-1 gap-2">
              {(PROJECT_TYPES[lang.id] ?? []).map(pt => (
                <button
                  key={pt.id}
                  onClick={() => { setProjectType(pt.id); }}
                  className={`flex flex-col gap-0.5 px-4 py-3 rounded-xl border text-left transition-all ${
                    projectType === pt.id
                      ? 'border-primary-500 bg-primary-600/10'
                      : 'border-surface-3 bg-surface-2 hover:border-primary-500/40 hover:bg-surface-3'
                  }`}
                >
                  <span className="text-sm font-semibold text-ink-high flex items-center gap-2">
                    {projectType === pt.id && <CheckCircle2 size={13} className="text-primary-400 flex-shrink-0" />}
                    {pt.label}
                  </span>
                  <span className="text-2xs text-ink-low">{pt.desc}</span>
                </button>
              ))}
            </div>

            <div className="flex gap-2 justify-between mt-5">
              <button onClick={() => setStep('name')}
                className="px-3 py-2 text-xs text-ink-mid hover:text-ink-high rounded-lg border border-surface-3 hover:border-surface-4 transition-colors flex items-center gap-1">
                <ChevronLeft size={12} /> Back
              </button>
              <button onClick={advanceFromType} disabled={!projectType}
                className="px-4 py-2 text-xs font-medium text-white rounded-lg transition-colors flex items-center gap-1.5 disabled:opacity-50"
                style={{ background: 'var(--primary)' }}>
                Next <ChevronRight size={12} />
              </button>
            </div>
          </div>
        )}

        {/* ── Step 4: Choose Parent Folder ─────────────────────────────────── */}
        {step === 'folder' && lang && (
          <div className="p-5 flex-1 overflow-y-auto">
            <p className="text-xs text-ink-mid mb-3">
              Where should the project folder be created?
            </p>

            <div className="flex gap-2 mb-3">
              <div className="flex-1 px-3 py-2.5 bg-surface-2 border border-surface-3 rounded-xl text-sm text-ink-low overflow-hidden">
                {parentDir
                  ? <span className="text-ink-high truncate block">{parentDir}</span>
                  : <span className="text-ink-low italic">No folder selected…</span>
                }
              </div>
              <button
                onClick={browseFolder}
                className="flex items-center gap-1.5 px-3 py-2 text-xs font-medium text-ink-mid bg-surface-2 border border-surface-3 rounded-xl hover:border-primary-500/40 hover:text-ink-high transition-colors flex-shrink-0"
              >
                <Folder size={13} />
                Browse…
              </button>
            </div>

            {previewPath && (
              <div className="mb-3 p-3 rounded-xl bg-surface-2 border border-surface-3">
                <p className="text-2xs text-ink-low mb-0.5">Project will be created at:</p>
                <code className="text-2xs text-accent-400 break-all">{previewPath}</code>
              </div>
            )}

            {/* Folder-already-exists warning — shown when the user has typed a name that might conflict */}
            {targetExists && previewPath && (
              <div className="flex items-start gap-2 p-2.5 rounded-lg bg-amber-500/10 border border-amber-500/30 mb-3">
                <AlertTriangle size={13} className="text-amber-400 flex-shrink-0 mt-0.5" />
                <p className="text-2xs text-amber-300">
                  If a folder named <strong>{sanitizedName}</strong> already exists here, its files may be overwritten.
                </p>
              </div>
            )}

            {error && <p className="mt-1.5 text-2xs text-error-400">{error}</p>}

            <div className="flex gap-2 justify-between mt-5">
              <button onClick={() => setStep(lang && hasProjectTypes(lang.id) ? 'type' : 'name')}
                className="px-3 py-2 text-xs text-ink-mid hover:text-ink-high rounded-lg border border-surface-3 hover:border-surface-4 transition-colors flex items-center gap-1">
                <ChevronLeft size={12} /> Back
              </button>
              <button
                onClick={create}
                disabled={!parentDir || !sanitizedName || creating}
                className="px-4 py-2 text-xs font-medium text-white rounded-lg transition-colors flex items-center gap-1.5 disabled:opacity-50"
                style={{ background: 'var(--primary)' }}
              >
                Create Project <ChevronRight size={12} />
              </button>
            </div>
          </div>
        )}

        {/* ── Step 5: Creating ─────────────────────────────────────────────── */}
        {step === 'creating' && lang && (
          <div className="p-10 flex flex-col items-center gap-3 flex-1">
            <Loader2 size={28} className="text-primary-400 animate-spin" />
            <p className="text-sm font-medium text-ink-high">Creating project…</p>
            <p className="text-2xs text-ink-low text-center">
              Setting up{projectType ? ` ${projectType}` : ''} {lang.label} project
            </p>
            {sanitizedName && (
              <code className="text-2xs text-accent-400 mt-1">{sanitizedName}</code>
            )}
          </div>
        )}
      </div>
    </div>
  );
}
