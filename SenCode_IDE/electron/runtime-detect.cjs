/**
 * runtime-detect.cjs
 * Detects installed language runtimes / extensions.
 * Each entry carries full metadata shown in the Extension Detail panel.
 *
 * Groups 1–3 and 6–7 syntax-checker mappings are registered in SYNTAX_CHECKERS.
 */

'use strict';

const { execFile } = require('child_process');
const path = require('path');
const os   = require('os');
const fs   = require('fs');

function probe(cmd, args, timeout = 6000) {
  return new Promise((resolve) => {
    execFile(cmd, args, { timeout, windowsHide: true }, (err, stdout, stderr) => {
      if (err) { resolve(null); return; }
      resolve((stdout || stderr || '').trim());
    });
  });
}

async function probeAny(...calls) {
  for (const [cmd, args] of calls) {
    const r = await probe(cmd, args);
    if (r) return r;
  }
  return null;
}

function clean(raw) {
  if (!raw) return null;
  const m = raw.match(/(\d+\.\d+[\.\d]*)/);
  return m ? m[1] : raw.split('\n')[0].slice(0, 40);
}

const RUNTIMES = [
  // ── JavaScript / TypeScript ──────────────────────────────────────────────
  {
    id: 'nodejs',
    name: 'Node.js',
    category: 'Runtime',
    icon: '🟩',
    desc: 'JavaScript runtime built on Chrome\'s V8 engine. Required to run .js, .mjs, .cjs, .jsx files and to use npm packages.',
    detail: 'Node.js lets you run JavaScript outside the browser. It includes npm (package manager) and npx (package runner) which are used to run TypeScript via tsx, install project dependencies, and run build tools.',
    langs: ['javascript', 'typescript', 'jsx', 'tsx', 'js', 'ts', 'mjs', 'cjs'],
    fileTypes: ['.js', '.mjs', '.cjs', '.jsx'],
    includes: ['node', 'npm', 'npx', 'corepack'],
    dependencies: [],
    related: ['typescript'],
    winget: 'OpenJS.NodeJS.LTS',
    homepage: 'https://nodejs.org',
    probe: async () => clean(await probeAny(['node', ['-v']])),
  },

  // ── TypeScript (via tsx, no separate install needed beyond Node) ─────────
  {
    id: 'typescript',
    name: 'TypeScript (tsx)',
    category: 'Runtime',
    icon: '🔷',
    desc: 'TypeScript support via tsx — runs .ts and .tsx files directly without a compile step. Requires Node.js.',
    detail: 'tsx is a fast TypeScript/ESM runner that wraps esbuild. When you click Run on a .ts file, SenCode calls "npx tsx file.ts" which auto-downloads tsx on first use. No separate install is needed beyond Node.js.',
    langs: ['typescript', 'ts', 'tsx'],
    fileTypes: ['.ts', '.tsx'],
    includes: ['tsx (auto-downloaded via npx)'],
    dependencies: ['nodejs'],
    related: ['nodejs'],
    winget: 'OpenJS.NodeJS.LTS',
    homepage: 'https://tsx.is',
    probe: async () => {
      const node = clean(await probe('node', ['-v']));
      return node; // tsx needs node; report node version
    },
  },

  // ── Python ───────────────────────────────────────────────────────────────
  {
    id: 'python',
    name: 'Python 3',
    category: 'Runtime',
    icon: '🐍',
    desc: 'General-purpose scripting language. Required for .py and .pyw files.',
    detail: 'Python 3 installs the python interpreter, pip (package manager), and the Python standard library. pip lets you install third-party packages like numpy, requests, and flask.',
    langs: ['python', 'py', 'pyw'],
    fileTypes: ['.py', '.pyw'],
    includes: ['python', 'python3', 'pip', 'pip3', 'Python standard library'],
    dependencies: [],
    related: [],
    winget: 'Python.Python.3',
    homepage: 'https://python.org',
    probe: async () => clean(await probeAny(
      ['python',  ['--version']],
      ['python3', ['--version']],
      ['py',      ['-3', '--version']],
    )),
  },

  // ── Java ─────────────────────────────────────────────────────────────────
  {
    id: 'java',
    name: 'Java JDK 21',
    category: 'Runtime',
    icon: '☕',
    desc: 'Java Development Kit. Required for .java files. Includes both the runtime (java) and compiler (javac).',
    detail: 'The JDK includes javac (compiler), java (runtime), jar, javadoc, and the full Java standard library. SenCode compiles your .java file with javac then runs it with java. Note: the JRE alone is not sufficient — you need the full JDK.',
    langs: ['java'],
    fileTypes: ['.java'],
    includes: ['javac (compiler)', 'java (runtime)', 'jar', 'javadoc', 'Java standard library', 'Syntax checker (javac, bundled)'],
    dependencies: [],
    related: ['kotlin'],
    winget: 'Oracle.JDK.21',
    homepage: 'https://openjdk.org',
    probe: async () => {
      const raw = await probeAny(['javac', ['-version']], ['java', ['-version']]);
      if (!raw) return null;
      const m = raw.match(/version "([^"]+)"/);
      return m ? m[1] : clean(raw);
    },
  },

  // ── Go ───────────────────────────────────────────────────────────────────
  {
    id: 'go',
    name: 'Go',
    category: 'Runtime',
    icon: '🔵',
    desc: 'Fast compiled language from Google. Required for .go files.',
    detail: 'Go installs the go compiler and toolchain. SenCode runs .go files using "go run" which compiles and executes in one step. Go modules are used for dependency management.',
    langs: ['go'],
    fileTypes: ['.go'],
    includes: ['go (compiler + runner)', 'gofmt', 'go vet', 'go modules', 'Syntax checker (gofmt -e, bundled)'],
    dependencies: [],
    related: [],
    winget: 'GoLang.Go',
    homepage: 'https://go.dev',
    probe: async () => clean(await probe('go', ['version'])),
  },

  // ── Rust ─────────────────────────────────────────────────────────────────
  {
    id: 'rust',
    name: 'Rust (rustup)',
    category: 'Runtime',
    icon: '🦀',
    desc: 'Systems language focused on safety and performance. Required for .rs files. Also install LLVM MinGW for the linker.',
    detail: 'rustup installs and manages the Rust toolchain. It includes rustc (compiler), cargo (package manager/build tool), and rustfmt. On Windows, Rust requires a linker — install LLVM MinGW (below) if you see "linker not found" errors.',
    langs: ['rs', 'rust'],
    fileTypes: ['.rs'],
    includes: ['rustc (compiler)', 'cargo (package manager)', 'rustfmt', 'clippy', 'rustup (toolchain manager)', 'Syntax checker (rustc --error-format=json, bundled)'],
    dependencies: ['llvm-mingw'],
    related: ['llvm-mingw'],
    winget: 'Rustlang.Rustup',
    homepage: 'https://rust-lang.org',
    probe: async () => clean(await probe('rustc', ['--version'])),
  },

  // !! DO NOT MODIFY THIS ENTRY — linker resolution is working !!
  {
    id: 'llvm-mingw',
    name: 'LLVM MinGW (Rust/C linker)',
    category: 'Toolchain',
    icon: '🔗',
    desc: 'C/C++ linker required to compile Rust and C/C++ on Windows without Visual Studio.',
    detail: 'LLVM MinGW provides clang, gcc, g++, and lld — the linker tools needed to produce .exe files on Windows. Without this, rustc and gcc will fail with "linker not found". This is a zero-install alternative to the 4GB Visual Studio Build Tools.',
    langs: ['rs', 'c', 'cpp'],
    fileTypes: ['.rs', '.c', '.cpp', '.cc', '.cxx'],
    includes: ['clang (C/C++ compiler)', 'gcc', 'g++', 'lld (LLVM linker)', 'Windows system headers', 'UCRT runtime'],
    dependencies: [],
    related: ['rust', 'gcc'],
    winget: 'MartinStorsjo.LLVM-MinGW.UCRT',
    homepage: 'https://github.com/mstorsjo/llvm-mingw',
    probe: async () => clean(await probeAny(['clang', ['--version']], ['gcc', ['--version']])),
  },

  // ── C / C++ ──────────────────────────────────────────────────────────────
  {
    id: 'gcc',
    name: 'C / C++ (GCC via LLVM MinGW)',
    category: 'Runtime',
    icon: '⚙️',
    desc: 'C and C++ compiler. LLVM MinGW provides gcc and g++ — same package as the Rust linker.',
    detail: 'Install LLVM MinGW to get gcc and g++ for compiling C and C++ files. SenCode compiles .c files with gcc and .cpp/.cc/.cxx files with g++, then runs the resulting executable. The LLVM MinGW package above satisfies this requirement.',
    langs: ['c', 'cpp', 'cc', 'cxx', 'h', 'hpp'],
    fileTypes: ['.c', '.cpp', '.cc', '.cxx', '.h', '.hpp'],
    includes: ['gcc', 'g++', 'clang', 'clang++', 'C standard library', 'C++ standard library (libstdc++)', 'Syntax checker (gcc/g++ -fsyntax-only, bundled)'],
    dependencies: ['llvm-mingw'],
    related: ['llvm-mingw', 'rust'],
    winget: 'MartinStorsjo.LLVM-MinGW.UCRT',
    homepage: 'https://gcc.gnu.org',
    probe: async () => clean(await probeAny(['gcc', ['--version']], ['clang', ['--version']], ['g++', ['--version']])),
  },

  // ── C# / .NET ────────────────────────────────────────────────────────────
  {
    id: 'dotnet',
    name: '.NET SDK',
    category: 'Runtime',
    icon: '💜',
    desc: 'Microsoft .NET SDK for C#, F#, and VB.NET files.',
    detail: 'The .NET SDK includes the dotnet CLI, the C# compiler (csc/Roslyn), the .NET runtime, and NuGet package management. SenCode uses dotnet-script (auto-installed on first run) to execute single .cs files without creating a full project.',
    langs: ['cs', 'csharp', 'fs', 'fsharp', 'vb'],
    fileTypes: ['.cs', '.fs', '.vb'],
    includes: ['dotnet CLI', 'C# compiler (Roslyn)', 'F# compiler', '.NET runtime', 'NuGet', 'dotnet-script (auto-installed)', 'Syntax checker (Roslyn via dotnet build, bundled)'],
    dependencies: [],
    related: [],
    winget: 'Microsoft.DotNet.SDK.8',
    homepage: 'https://dotnet.microsoft.com',
    probe: async () => clean(await probe('dotnet', ['--version'])),
  },

  // ── Ruby ─────────────────────────────────────────────────────────────────
  {
    id: 'ruby',
    name: 'Ruby',
    category: 'Runtime',
    icon: '💎',
    desc: 'Dynamic scripting language. Required for .rb files.',
    detail: 'RubyInstaller for Windows provides the Ruby interpreter, gem (package manager), irb (interactive console), and the Ruby standard library. Gems can be installed with "gem install" in the terminal.',
    langs: ['rb', 'ruby'],
    fileTypes: ['.rb'],
    includes: ['ruby (interpreter)', 'gem (package manager)', 'irb', 'rake', 'Ruby standard library'],
    dependencies: [],
    related: [],
    winget: 'RubyInstallerTeam.Ruby.3.4',
    homepage: 'https://rubyinstaller.org',
    probe: async () => clean(await probe('ruby', ['--version'])),
  },

  // ── PHP ──────────────────────────────────────────────────────────────────
  {
    id: 'php',
    name: 'PHP',
    category: 'Runtime',
    icon: '🐘',
    desc: 'Server-side scripting language. Required for .php files.',
    detail: 'PHP installs the php CLI interpreter. SenCode runs .php files directly using "php file.php". For web server features, use "php -S localhost:8000" in the terminal.',
    langs: ['php'],
    fileTypes: ['.php'],
    includes: ['php (interpreter)', 'php-cgi', 'PHP extensions (curl, json, mbstring, etc.)', 'Syntax checker (php -l, bundled)'],
    dependencies: [],
    related: [],
    winget: 'PHP.PHP',
    homepage: 'https://php.net',
    probe: async () => clean(await probe('php', ['--version'])),
  },

  // ── Perl ─────────────────────────────────────────────────────────────────
  {
    id: 'perl',
    name: 'Perl (Strawberry)',
    category: 'Runtime',
    icon: '🐪',
    desc: 'General-purpose scripting language. Required for .pl and .pm files.',
    detail: 'Strawberry Perl is a complete Perl distribution for Windows including the perl interpreter, cpan (package manager), gcc for XS modules, and many common modules pre-installed.',
    langs: ['pl', 'pm', 'perl'],
    fileTypes: ['.pl', '.pm'],
    includes: ['perl (interpreter)', 'cpan (package manager)', 'gcc (for XS modules)', 'Core Perl modules'],
    dependencies: [],
    related: [],
    winget: 'StrawberryPerl.StrawberryPerl',
    homepage: 'https://strawberryperl.com',
    probe: async () => clean(await probe('perl', ['--version'])),
  },

  // ── Lua ──────────────────────────────────────────────────────────────────
  {
    id: 'lua',
    name: 'Lua',
    category: 'Runtime',
    icon: '🌙',
    desc: 'Lightweight embeddable scripting language. Required for .lua files.',
    detail: 'Lua is a fast and minimal scripting language often used for game scripting and configuration. SenCode runs .lua files with the lua interpreter.',
    langs: ['lua'],
    fileTypes: ['.lua'],
    includes: ['lua (interpreter)', 'Lua standard library'],
    dependencies: [],
    related: [],
    winget: 'DEVCOM.Lua',
    homepage: 'https://lua.org',
    probe: async () => clean(await probeAny(['lua', ['-v']], ['lua54', ['-v']], ['lua53', ['-v']], ['lua51', ['-v']])),
  },

  // ── Dart ─────────────────────────────────────────────────────────────────
  {
    id: 'dart',
    name: 'Dart SDK',
    category: 'Runtime',
    icon: '🎯',
    desc: 'Client-optimised language by Google. Required for .dart files.',
    detail: 'The Dart SDK includes the dart CLI, pub (package manager), and the Dart standard library. Used standalone or as the foundation for Flutter apps.',
    langs: ['dart'],
    fileTypes: ['.dart'],
    includes: ['dart (runtime)', 'pub (package manager)', 'dartanalyzer', 'Dart standard library'],
    dependencies: [],
    related: [],
    winget: 'Dart.Dart',
    homepage: 'https://dart.dev',
    probe: async () => clean(await probe('dart', ['--version'])),
  },

  // ── Kotlin ───────────────────────────────────────────────────────────────
  {
    id: 'kotlin',
    name: 'Kotlin',
    category: 'Runtime',
    icon: '🟣',
    desc: 'Modern JVM language by JetBrains. Required for .kt files. Also needs Java JDK.',
    detail: 'Kotlin compiles to JVM bytecode. SenCode compiles .kt files with kotlinc to a .jar then runs with java. The Java JDK must be installed separately.',
    langs: ['kt', 'kts', 'kotlin'],
    fileTypes: ['.kt', '.kts'],
    includes: ['kotlinc (compiler)', 'kotlin-stdlib', 'kotlin-reflect'],
    dependencies: ['java'],
    related: ['java'],
    winget: 'Kotlin.Kotlin',
    homepage: 'https://kotlinlang.org',
    probe: async () => clean(await probe('kotlinc', ['-version'])),
  },

  // ── R ────────────────────────────────────────────────────────────────────
  {
    id: 'r',
    name: 'R',
    category: 'Runtime',
    icon: '📊',
    desc: 'Statistical computing language. Required for .r files.',
    detail: 'R is the leading language for statistics, data analysis, and visualisation. SenCode runs .r files using Rscript. Packages can be installed inside R with install.packages().',
    langs: ['r'],
    fileTypes: ['.r', '.R'],
    includes: ['Rscript', 'R (interactive)', 'R standard packages (base, stats, utils, graphics)'],
    dependencies: [],
    related: [],
    winget: 'RProject.R',
    homepage: 'https://r-project.org',
    probe: async () => clean(await probeAny(['Rscript', ['--version']], ['rscript', ['--version']])),
  },

  // ── Julia ────────────────────────────────────────────────────────────────
  {
    id: 'julia',
    name: 'Julia',
    category: 'Runtime',
    icon: '🔴',
    desc: 'High-performance scientific computing language. Required for .jl files.',
    detail: 'Julia combines the ease of Python with the speed of C. It has a built-in package manager (Pkg) and is widely used in scientific computing, machine learning, and numerical analysis.',
    langs: ['jl', 'julia'],
    fileTypes: ['.jl'],
    includes: ['julia (runtime)', 'Pkg (package manager)', 'Julia standard library'],
    dependencies: [],
    related: [],
    winget: 'Julialang.Julia',
    homepage: 'https://julialang.org',
    probe: async () => clean(await probe('julia', ['--version'])),
  },

  // ── Swift ────────────────────────────────────────────────────────────────
  {
    id: 'swift',
    name: 'Swift',
    category: 'Runtime',
    icon: '🧡',
    desc: 'Apple\'s programming language. Required for .swift files. Windows support is experimental.',
    detail: 'Swift on Windows is available via the official Swift toolchain. Support is still experimental — some standard library features may be missing. Use swift file.swift to run single files.',
    langs: ['swift'],
    fileTypes: ['.swift'],
    includes: ['swift (compiler + runner)', 'swiftc', 'Swift standard library'],
    dependencies: [],
    related: [],
    winget: 'Swift.Toolchain',
    homepage: 'https://swift.org/download',
    probe: async () => clean(await probe('swift', ['--version'])),
  },

  // ── Elixir ───────────────────────────────────────────────────────────────
  {
    id: 'elixir',
    name: 'Elixir',
    category: 'Runtime',
    icon: '💧',
    desc: 'Functional language on the Erlang VM. Required for .ex and .exs files. Also needs Erlang.',
    detail: 'Elixir runs on the Erlang VM (BEAM). The Erlang runtime must be installed separately. Mix is the Elixir build tool and package manager.',
    langs: ['ex', 'exs', 'elixir'],
    fileTypes: ['.ex', '.exs'],
    includes: ['elixir (runner)', 'iex (interactive shell)', 'mix (build tool)', 'hex (package manager)'],
    dependencies: [],
    related: [],
    winget: 'Elixir.Elixir',
    homepage: 'https://elixir-lang.org',
    probe: async () => clean(await probe('elixir', ['--version'])),
  },

  // ── Scala ────────────────────────────────────────────────────────────────
  {
    id: 'scala',
    name: 'Scala',
    category: 'Runtime',
    icon: '🔴',
    desc: 'Functional/OOP JVM language. Required for .scala files. Also needs Java JDK.',
    detail: 'Scala compiles to JVM bytecode. SenCode compiles .scala files with scalac. The Java JDK must be installed separately.',
    langs: ['scala'],
    fileTypes: ['.scala'],
    includes: ['scalac (compiler)', 'scala (runner)', 'sbt (build tool)'],
    dependencies: ['java'],
    related: ['java'],
    winget: 'VirtusLab.ScalaCLI',
    homepage: 'https://scala-lang.org',
    probe: async () => clean(await probeAny(['scalac', ['-version']], ['scala', ['-version']])),
  },

  // ── Haskell (GHCup) ──────────────────────────────────────────────────────
  {
    id: 'haskell',
    name: 'Haskell (GHCup)',
    category: 'Runtime',
    icon: '🦄',
    desc: 'Pure functional language. Required for .hs files.',
    detail: 'GHCup is the recommended installer for GHC (Glasgow Haskell Compiler). SenCode compiles .hs files with ghc -fno-code for syntax checking.',
    langs: ['hs', 'haskell'],
    fileTypes: ['.hs'],
    includes: ['ghc (compiler)', 'ghci (REPL)', 'cabal (package manager)'],
    dependencies: [],
    related: [],
    winget: 'HaskellFoundation.GHCup',
    homepage: 'https://www.haskell.org/ghcup/',
    probe: async () => clean(await probeAny(['ghc', ['--version']], ['ghci', ['--version']])),
  },

  // ── Erlang ───────────────────────────────────────────────────────────────
  {
    id: 'erlang',
    name: 'Erlang OTP',
    category: 'Runtime',
    icon: '⚡',
    desc: 'Concurrent functional language. Required for .erl files.',
    detail: 'Erlang OTP includes the erlc compiler and erl runtime. Elixir also depends on this runtime.',
    langs: ['erl', 'erlang'],
    fileTypes: ['.erl', '.hrl'],
    includes: ['erl (runtime)', 'erlc (compiler)', 'rebar3 (build tool)'],
    dependencies: [],
    related: ['elixir'],
    winget: 'Erlang.OTP',
    homepage: 'https://erlang.org',
    probe: async () => clean(await probe('erl', ['-eval', 'erlang:display(erlang:system_info(otp_release)), halt().', '-noshell'])),
  },

  // ── Groovy ───────────────────────────────────────────────────────────────
  {
    id: 'groovy',
    name: 'Apache Groovy',
    category: 'Runtime',
    icon: '☀️',
    desc: 'JVM scripting language. Required for .groovy files. Also needs Java JDK.',
    detail: 'Groovy is a dynamic JVM language compatible with Java. SenCode runs .groovy scripts directly and uses the Groovy shell for syntax checking.',
    langs: ['groovy'],
    fileTypes: ['.groovy'],
    includes: ['groovy (runner)', 'groovyc (compiler)', 'groovysh (shell)'],
    dependencies: ['java'],
    related: ['java', 'gradle'],
    winget: 'Apache.Groovy',
    homepage: 'https://groovy-lang.org',
    probe: async () => clean(await probe('groovy', ['--version'])),
  },

  // ── Clojure ──────────────────────────────────────────────────────────────
  {
    id: 'clojure',
    name: 'Clojure',
    category: 'Runtime',
    icon: '💚',
    desc: 'Functional Lisp on the JVM. Required for .clj and .cljs files. Also needs Java JDK.',
    detail: 'Clojure runs on the JVM. The Clojure CLI tools (clojure / clj) manage dependencies and run code. Java must be installed separately.',
    langs: ['clj', 'cljs', 'clojure'],
    fileTypes: ['.clj', '.cljs', '.cljc'],
    includes: ['clojure (runner)', 'clj (REPL)', 'deps.edn (dependency manager)'],
    dependencies: ['java'],
    related: ['java'],
    winget: 'Clojure.Clojure',
    homepage: 'https://clojure.org',
    probe: async () => clean(await probe('clojure', ['--version'])),
  },

  // ── Crystal ──────────────────────────────────────────────────────────────
  {
    id: 'crystal',
    name: 'Crystal',
    category: 'Runtime',
    icon: '💎',
    desc: 'Compiled language with Ruby-like syntax. Required for .cr files.',
    detail: 'Crystal compiles to native code. SenCode uses crystal build --no-codegen for syntax checking without producing an executable.',
    langs: ['cr', 'crystal'],
    fileTypes: ['.cr'],
    includes: ['crystal (compiler + runner)', 'shards (package manager)'],
    dependencies: [],
    related: [],
    winget: 'CrystalLang.Crystal',
    homepage: 'https://crystal-lang.org',
    probe: async () => clean(await probe('crystal', ['--version'])),
  },

  // ══════════════════════════════════════════════════════════════════════════
  // Group 6 — Downloadable syntax-checker runtimes
  // ══════════════════════════════════════════════════════════════════════════

  // ── Dockerfile ───────────────────────────────────────────────────────────
  {
    id: 'dockerfile-tools',
    name: 'Docker Tools (hadolint)',
    category: 'Toolchain',
    icon: '🐳',
    desc: 'Dockerfile linter and syntax checker. Required to validate Dockerfile syntax.',
    detail: 'hadolint parses Dockerfiles and reports syntax errors and best-practice issues. SenCode runs "hadolint --format json" to power the red-squiggle syntax checker for Dockerfiles.',
    langs: ['dockerfile'],
    fileTypes: ['Dockerfile', '.dockerfile'],
    includes: ['hadolint (linter + syntax checker)'],
    dependencies: [],
    related: [],
    winget: 'hadolint.hadolint',
    homepage: 'https://github.com/hadolint/hadolint',
    probe: async () => clean(await probe('hadolint', ['--version'])),
  },

  // ── Protocol Buffers ─────────────────────────────────────────────────────
  {
    id: 'protobuf-tools',
    name: 'Protocol Buffers (protoc)',
    category: 'Runtime',
    icon: '📦',
    desc: 'Protocol Buffer compiler. Required for .proto files.',
    detail: 'protoc parses and compiles .proto schema files. SenCode runs "protoc --proto_path ... -o NUL" to validate syntax without generating any output.',
    langs: ['protobuf', 'proto'],
    fileTypes: ['.proto'],
    includes: ['protoc (compiler + syntax checker)'],
    dependencies: [],
    related: [],
    winget: 'Google.Protobuf',
    homepage: 'https://protobuf.dev',
    probe: async () => clean(await probe('protoc', ['--version'])),
  },

  // ── INI / Config ─────────────────────────────────────────────────────────
  {
    id: 'ini-config-tools',
    name: 'INI / Config Validator (Python)',
    category: 'Toolchain',
    icon: '🗂️',
    desc: 'Validates .ini, .cfg, and generic .conf files using Python\'s built-in configparser.',
    detail: 'SenCode runs a small script through configparser — part of the Python standard library — to validate INI-style config syntax.',
    langs: ['ini', 'cfg', 'conf', 'properties', 'config'],
    fileTypes: ['.ini', '.cfg', '.conf'],
    includes: ['python (interpreter)', 'configparser (stdlib syntax checker)'],
    dependencies: ['python'],
    related: ['python'],
    winget: 'Python.Python.3',
    homepage: 'https://docs.python.org/3/library/configparser.html',
    probe: async () => clean(await probeAny(['python', ['--version']], ['python3', ['--version']])),
  },

  // ── Diff / Patch ─────────────────────────────────────────────────────────
  {
    id: 'patch-tools',
    name: 'Patch / Diff Tools (GNU patch)',
    category: 'Toolchain',
    icon: '🩹',
    desc: 'Validates unified diff / patch file syntax. Required for .diff and .patch files.',
    detail: 'GNU patch parses patch headers and hunks before ever touching a file. SenCode runs "patch --dry-run" to catch malformed patch syntax safely.',
    langs: ['diff', 'patch'],
    fileTypes: ['.diff', '.patch'],
    includes: ['patch (GNU patch — syntax checker)'],
    dependencies: [],
    related: [],
    winget: 'GnuWin32.Patch',
    homepage: 'https://www.gnu.org/software/patch/',
    probe: async () => clean(await probe('patch', ['--version'])),
  },

  // ── GraphQL ──────────────────────────────────────────────────────────────
  {
    id: 'graphql-tools',
    name: 'GraphQL (Node.js)',
    category: 'Runtime',
    icon: '🔗',
    desc: 'GraphQL schema/query syntax checking via Node.js. Required for .graphql and .gql files.',
    detail: 'SenCode uses "npx -y -p graphql" to parse GraphQL documents and report syntax errors. Requires Node.js.',
    langs: ['graphql', 'gql'],
    fileTypes: ['.graphql', '.gql'],
    includes: ['node (runtime)', 'graphql (auto-downloaded via npx — syntax checker)'],
    dependencies: ['nodejs'],
    related: ['nodejs'],
    winget: 'OpenJS.NodeJS.LTS',
    homepage: 'https://graphql.org',
    probe: async () => clean(await probe('node', ['-v'])),
  },

  // ── Nginx ────────────────────────────────────────────────────────────────
  {
    id: 'nginx-tools',
    name: 'Nginx (config test)',
    category: 'Runtime',
    icon: '🌐',
    desc: 'Validates nginx config syntax via "nginx -t". Required for nginx config files.',
    detail: 'nginx ships with a built-in configuration tester ("nginx -t") that fully parses the config file and reports any syntax error.',
    langs: ['nginx'],
    fileTypes: ['.conf'],
    includes: ['nginx (web server + config syntax checker)'],
    dependencies: [],
    related: ['apache'],
    winget: 'nginx.nginx',
    homepage: 'https://nginx.org',
    probe: async () => clean(await probe('nginx', ['-v'])),
  },

  // ── Apache ───────────────────────────────────────────────────────────────
  {
    id: 'apache-tools',
    name: 'Apache HTTP Server (config test)',
    category: 'Runtime',
    icon: '🪶',
    desc: 'Validates Apache config syntax via "httpd -t". Required for Apache config files.',
    detail: 'The Apache HTTP Server binary includes a config syntax tester ("httpd -t") that parses the config and reports the line number of any error.',
    langs: ['apache', 'apacheconf'],
    fileTypes: ['.conf'],
    includes: ['httpd / apachectl (server + config syntax checker)'],
    dependencies: [],
    related: ['nginx'],
    winget: 'ApacheHaus.Apache24',
    homepage: 'https://httpd.apache.org',
    probe: async () => clean(await probeAny(['httpd', ['-v']], ['apachectl', ['-v']])),
  },

  // ── Makefile ─────────────────────────────────────────────────────────────
  {
    id: 'make-tools',
    name: 'GNU Make',
    category: 'Runtime',
    icon: '🛠️',
    desc: 'Validates Makefile syntax via "make -n" (dry run). Required for Makefile / .mk files.',
    detail: 'GNU make fully parses a Makefile before executing anything. SenCode runs "make -n -f <file>" to catch syntax errors without executing any recipes.',
    langs: ['makefile', 'make'],
    fileTypes: ['Makefile', '.mk'],
    includes: ['make (build tool + syntax checker)'],
    dependencies: [],
    related: ['cmake'],
    winget: 'GnuWin32.Make',
    homepage: 'https://www.gnu.org/software/make/',
    probe: async () => clean(await probe('make', ['--version'])),
  },

  // ── CMake ────────────────────────────────────────────────────────────────
  {
    id: 'cmake-tools',
    name: 'CMake',
    category: 'Runtime',
    icon: '🧱',
    desc: 'Validates CMake script syntax via "cmake -P" (script mode). Required for .cmake files.',
    detail: 'CMake\'s script mode ("cmake -P file.cmake") parses and runs a .cmake file directly, reporting the exact line of any parse error.',
    langs: ['cmake'],
    fileTypes: ['.cmake'],
    includes: ['cmake (build tool + syntax checker)'],
    dependencies: [],
    related: ['make'],
    winget: 'Kitware.CMake',
    homepage: 'https://cmake.org',
    probe: async () => clean(await probe('cmake', ['--version'])),
  },

  // ── Gradle ───────────────────────────────────────────────────────────────
  {
    id: 'gradle-tools',
    name: 'Gradle',
    category: 'Runtime',
    icon: '🏗️',
    desc: 'Validates build.gradle syntax using Gradle\'s bundled compiler. Requires Java.',
    detail: 'Gradle bundles its own Groovy compiler to evaluate build scripts. SenCode runs "gradle tasks --offline -q" against a temp project containing your build.gradle.',
    langs: ['gradle'],
    fileTypes: ['.gradle'],
    includes: ['gradle (build tool + syntax checker)'],
    dependencies: ['java'],
    related: ['java'],
    winget: 'Gradle.Gradle',
    homepage: 'https://gradle.org',
    probe: async () => clean(await probe('gradle', ['-v'])),
  },

  // ══════════════════════════════════════════════════════════════════════════
  // Group 7 — Specialty language runtimes
  // ══════════════════════════════════════════════════════════════════════════

  // ── LaTeX / MiKTeX ───────────────────────────────────────────────────────
  {
    id: 'latex',
    name: 'LaTeX (MiKTeX)',
    category: 'Runtime',
    icon: '📄',
    desc: 'LaTeX typesetting system. Required for .tex files.',
    detail: 'MiKTeX provides pdflatex, xelatex, and lualatex. SenCode runs "pdflatex -interaction=nonstopmode -draftmode" for syntax checking without producing output files. chktex is also used as a fallback.',
    langs: ['tex', 'latex'],
    fileTypes: ['.tex', '.sty', '.cls'],
    includes: ['pdflatex', 'xelatex', 'lualatex', 'bibtex', 'chktex (style checker)'],
    dependencies: [],
    related: [],
    winget: 'MiKTeX.MiKTeX',
    homepage: 'https://miktex.org',
    probe: async () => clean(await probeAny(['pdflatex', ['--version']], ['latex', ['--version']])),
  },

  // ── Octave / MATLAB ──────────────────────────────────────────────────────
  {
    id: 'octave',
    name: 'GNU Octave',
    category: 'Runtime',
    icon: '📈',
    desc: 'MATLAB-compatible numerical computing language. Required for .m files.',
    detail: 'GNU Octave is a free MATLAB-compatible environment. SenCode uses "octave --no-gui --eval" to parse .m files and report syntax errors.',
    langs: ['m', 'matlab', 'octave'],
    fileTypes: ['.m'],
    includes: ['octave (interpreter + syntax checker)'],
    dependencies: [],
    related: [],
    winget: 'GNU.Octave',
    homepage: 'https://octave.org',
    probe: async () => clean(await probe('octave', ['--version'])),
  },

  // ── Mathematica / Wolfram ─────────────────────────────────────────────────
  {
    id: 'wolfram',
    name: 'Wolfram Engine',
    category: 'Runtime',
    icon: '🧮',
    desc: 'Wolfram Language engine. Required for .wl and .m (Mathematica) files.',
    detail: 'The free Wolfram Engine provides wolframscript for running Wolfram Language notebooks and scripts. SenCode uses wolframscript to validate .wl file syntax.',
    langs: ['wl', 'mathematica', 'wolfram'],
    fileTypes: ['.wl', '.nb'],
    includes: ['wolframscript (runner + syntax checker)'],
    dependencies: [],
    related: [],
    winget: 'Wolfram.WolframEngine',
    homepage: 'https://wolfram.com/engine',
    probe: async () => clean(await probe('wolframscript', ['-version'])),
  },

  // ── SAS ──────────────────────────────────────────────────────────────────
  {
    id: 'sas',
    name: 'SAS',
    category: 'Runtime',
    icon: '📊',
    desc: 'Statistical Analysis System. Required for .sas files.',
    detail: 'SAS provides a -syntax flag that parses the program without running it. SenCode uses "sas -syntax" to check .sas files for syntax errors.',
    langs: ['sas'],
    fileTypes: ['.sas'],
    includes: ['sas (interpreter + syntax checker)'],
    dependencies: [],
    related: [],
    winget: null, // SAS requires manual install / license
    homepage: 'https://sas.com',
    probe: async () => clean(await probe('sas', ['-version'])),
  },

  // ── GnuCOBOL ─────────────────────────────────────────────────────────────
  {
    id: 'cobol',
    name: 'GnuCOBOL',
    category: 'Runtime',
    icon: '🏢',
    desc: 'Open-source COBOL compiler. Required for .cob and .cbl files.',
    detail: 'GnuCOBOL (formerly OpenCOBOL) compiles COBOL to C and then to native binaries. SenCode uses "cobc -fsyntax-only" for fast syntax checking without code generation.',
    langs: ['cob', 'cbl', 'cobol'],
    fileTypes: ['.cob', '.cbl', '.cpy'],
    includes: ['cobc (compiler + syntax checker)'],
    dependencies: [],
    related: [],
    winget: 'GnuCOBOL.GnuCOBOL',
    homepage: 'https://gnucobol.sourceforge.io',
    probe: async () => clean(await probe('cobc', ['--version'])),
  },

  // ── Ada (GNAT) ───────────────────────────────────────────────────────────
  {
    id: 'ada',
    name: 'Ada (GNAT)',
    category: 'Runtime',
    icon: '🛡️',
    desc: 'Ada compiler via GNAT. Required for .adb and .ads files.',
    detail: 'GNAT (GNU Ada) is the Ada front-end of GCC. SenCode uses "gnatmake -gnats" (syntax-only check) to validate .adb and .ads files.',
    langs: ['adb', 'ads', 'ada'],
    fileTypes: ['.adb', '.ads'],
    includes: ['gnatmake (build system)', 'gcc (with Ada front-end)', 'Syntax checker (gnatmake -gnats, bundled)'],
    dependencies: [],
    related: [],
    winget: 'AdaCore.GNAT',
    homepage: 'https://adacore.com/gnat',
    probe: async () => clean(await probeAny(['gnatmake', ['--version']], ['gnat', ['--version']])),
  },

  // ── D (DMD) ──────────────────────────────────────────────────────────────
  {
    id: 'dlang',
    name: 'D Language (DMD)',
    category: 'Runtime',
    icon: '💎',
    desc: 'D programming language compiler. Required for .d files.',
    detail: 'DMD is the reference D compiler. SenCode uses "dmd -o-" to compile D files for syntax checking without producing any output.',
    langs: ['d'],
    fileTypes: ['.d'],
    includes: ['dmd (compiler + syntax checker)', 'dub (package manager)'],
    dependencies: [],
    related: [],
    winget: 'DigitalMars.DMD',
    homepage: 'https://dlang.org',
    probe: async () => clean(await probeAny(['dmd', ['--version']], ['dub', ['--version']])),
  },

  // ── Nim ──────────────────────────────────────────────────────────────────
  {
    id: 'nim',
    name: 'Nim',
    category: 'Runtime',
    icon: '👑',
    desc: 'Compiled systems language with Python-like syntax. Required for .nim files.',
    detail: 'Nim compiles to C, C++, or JavaScript. SenCode uses "nim check --hints:off" for syntax checking without producing a binary.',
    langs: ['nim'],
    fileTypes: ['.nim'],
    includes: ['nim (compiler + syntax checker)', 'nimble (package manager)'],
    dependencies: [],
    related: [],
    winget: 'nim-lang.Nim',
    homepage: 'https://nim-lang.org',
    probe: async () => clean(await probe('nim', ['--version'])),
  },

  // ── Zig ──────────────────────────────────────────────────────────────────
  {
    id: 'zig',
    name: 'Zig',
    category: 'Runtime',
    icon: '⚡',
    desc: 'Low-level systems language. Required for .zig files.',
    detail: 'Zig is a compiled language focusing on simplicity and robustness. SenCode uses "zig ast-check" for ultra-fast syntax checking without compilation.',
    langs: ['zig'],
    fileTypes: ['.zig'],
    includes: ['zig (compiler + syntax checker)', 'zig build system'],
    dependencies: [],
    related: [],
    winget: 'zig-lang.zig',
    homepage: 'https://ziglang.org',
    probe: async () => clean(await probe('zig', ['version'])),
  },

  // ── V (vlang) ────────────────────────────────────────────────────────────
  {
    id: 'vlang',
    name: 'V Language',
    category: 'Runtime',
    icon: '🟦',
    desc: 'Simple, fast compiled language. Required for .v files (V lang, not Verilog).',
    detail: 'V is a statically typed compiled language inspired by Go. SenCode uses "v -check" to validate .v files for syntax errors.',
    langs: ['vlang'],
    fileTypes: ['.v'],
    includes: ['v (compiler + syntax checker)', 'vpm (package manager)'],
    dependencies: [],
    related: [],
    winget: 'vlang.v',
    homepage: 'https://vlang.io',
    probe: async () => clean(await probe('v', ['version'])),
  },
];

async function detectRuntimes() {
  const results = await Promise.all(
    RUNTIMES.map(async (rt) => {
      const version = await rt.probe();
      return {
        id          : rt.id,
        name        : rt.name,
        category    : rt.category,
        icon        : rt.icon,
        desc        : rt.desc,
        detail      : rt.detail,
        langs       : rt.langs,
        fileTypes   : rt.fileTypes,
        includes    : rt.includes,
        dependencies: rt.dependencies,
        related     : rt.related,
        winget      : rt.winget,
        homepage    : rt.homepage,
        version     : version || null,
        installed   : !!version,
      };
    })
  );
  return results;
}

function getRuntimeForLang(lang) {
  const l = (lang || '').toLowerCase();
  for (const rt of RUNTIMES) {
    if (rt.langs.includes(l)) return rt.id;
  }
  return null;
}

// ── Syntax-checker registry ─────────────────────────────────────────────────
// One entry per supported language. `runtimeId` points at the RUNTIMES entry
// whose winget download already contains the checker tool — there is never a
// separate "syntax checker" package to install.
const SYNTAX_CHECKERS = {
  // Already implemented (Node.js runtime)
  javascript: { runtimeId: 'nodejs',     tool: 'node --check' },
  js:         { runtimeId: 'nodejs',     tool: 'node --check' },
  mjs:        { runtimeId: 'nodejs',     tool: 'node --check' },
  cjs:        { runtimeId: 'nodejs',     tool: 'node --check' },
  // Already implemented (tsx / Node.js runtime)
  typescript: { runtimeId: 'typescript', tool: 'node --check (via esbuild strip)' },
  ts:         { runtimeId: 'typescript', tool: 'node --check (via esbuild strip)' },
  tsx:        { runtimeId: 'typescript', tool: 'node --check (via esbuild strip)' },
  // Already implemented (Python runtime)
  python:     { runtimeId: 'python',     tool: 'python -m py_compile' },
  py:         { runtimeId: 'python',     tool: 'python -m py_compile' },
  pyw:        { runtimeId: 'python',     tool: 'python -m py_compile' },

  // Group [1] — Java (JVM runtime)
  java:       { runtimeId: 'java',   tool: 'javac -d <tmp> (compile-only, discarded)' },

  // Group [1] — C / C++ (GCC / Clang via LLVM MinGW runtime)
  c:          { runtimeId: 'gcc',    tool: 'gcc -fsyntax-only' },
  h:          { runtimeId: 'gcc',    tool: 'gcc -fsyntax-only' },
  cpp:        { runtimeId: 'gcc',    tool: 'g++ -fsyntax-only' },
  cc:         { runtimeId: 'gcc',    tool: 'g++ -fsyntax-only' },
  cxx:        { runtimeId: 'gcc',    tool: 'g++ -fsyntax-only' },
  hpp:        { runtimeId: 'gcc',    tool: 'g++ -fsyntax-only' },

  // Group [1] — C# (.NET SDK runtime)
  cs:         { runtimeId: 'dotnet', tool: 'Roslyn (dotnet build, temp project)' },
  csharp:     { runtimeId: 'dotnet', tool: 'Roslyn (dotnet build, temp project)' },

  // Group [1] — PHP (PHP runtime)
  php:        { runtimeId: 'php',    tool: 'php -l' },

  // Group [1] — Go (Go runtime)
  go:         { runtimeId: 'go',     tool: 'gofmt -e' },

  // Group [1] — Rust (rustup runtime)
  rust:       { runtimeId: 'rust',   tool: 'rustc --error-format=json --emit=metadata' },
  rs:         { runtimeId: 'rust',   tool: 'rustc --error-format=json --emit=metadata' },

  // Group 2 — Ruby
  ruby:       { runtimeId: 'ruby',       tool: 'ruby -c' },
  rb:         { runtimeId: 'ruby',       tool: 'ruby -c' },
  // Group 2 — Swift
  swift:      { runtimeId: 'swift',      tool: 'swiftc -parse' },
  // Group 2 — Kotlin
  kotlin:     { runtimeId: 'kotlin',     tool: 'kotlinc -script' },
  kt:         { runtimeId: 'kotlin',     tool: 'kotlinc -script' },
  kts:        { runtimeId: 'kotlin',     tool: 'kotlinc -script' },
  // Group 2 — Scala
  scala:      { runtimeId: 'scala',      tool: 'scalac -Ystop-after:parser' },
  // Group 2 — SQL (client-side only)
  sql:        { runtimeId: null,         tool: 'client-side only' },
  // Group 2 — Shell / Bash
  shell:      { runtimeId: 'bash',       tool: 'bash -n' },
  sh:         { runtimeId: 'bash',       tool: 'bash -n' },
  bash:       { runtimeId: 'bash',       tool: 'bash -n' },
  zsh:        { runtimeId: 'zsh',        tool: 'bash -n (fallback)' },
  fish:       { runtimeId: 'fish',       tool: 'fish --no-execute' },
  // Group 2 — PowerShell
  powershell: { runtimeId: 'powershell', tool: 'Parser::ParseFile' },
  ps1:        { runtimeId: 'powershell', tool: 'Parser::ParseFile' },
  // Group 2 — R
  r:          { runtimeId: 'r',          tool: 'Rscript --vanilla' },
  // Group 2 — Dart
  dart:       { runtimeId: 'dart',       tool: 'dart analyze' },
  // Group 2 — Lua
  lua:        { runtimeId: 'lua',        tool: 'luac -p' },

  // Group 3 — Groovy
  groovy:     { runtimeId: 'groovy',     tool: 'groovy -e parse' },
  // Group 3 — Perl
  perl:       { runtimeId: 'perl',       tool: 'perl -c' },
  pl:         { runtimeId: 'perl',       tool: 'perl -c' },
  pm:         { runtimeId: 'perl',       tool: 'perl -c' },
  // Group 3 — Haskell
  haskell:    { runtimeId: 'haskell',    tool: 'ghc -fno-code' },
  hs:         { runtimeId: 'haskell',    tool: 'ghc -fno-code' },
  // Group 3 — Elixir
  elixir:     { runtimeId: 'elixir',     tool: 'elixir --no-halt' },
  ex:         { runtimeId: 'elixir',     tool: 'elixir --no-halt' },
  exs:        { runtimeId: 'elixir',     tool: 'elixir --no-halt' },
  // Group 3 — Erlang
  erlang:     { runtimeId: 'erlang',     tool: 'erlc -W0' },
  erl:        { runtimeId: 'erlang',     tool: 'erlc -W0' },
  // Group 3 — Clojure
  clojure:    { runtimeId: 'clojure',    tool: 'clojure -e load-file' },
  clj:        { runtimeId: 'clojure',    tool: 'clojure -e load-file' },
  cljs:       { runtimeId: 'clojure',    tool: 'clojure -e load-file' },
  // Group 3 — Julia
  julia:      { runtimeId: 'julia',      tool: 'julia --compile=min' },
  jl:         { runtimeId: 'julia',      tool: 'julia --compile=min' },
  // Group 3 — Crystal
  crystal:    { runtimeId: 'crystal',    tool: 'crystal build --no-codegen' },
  cr:         { runtimeId: 'crystal',    tool: 'crystal build --no-codegen' },
  // Group 3 — F#
  fsharp:     { runtimeId: 'dotnet',     tool: 'dotnet fsi' },
  fs:         { runtimeId: 'dotnet',     tool: 'dotnet fsi' },
  fsx:        { runtimeId: 'dotnet',     tool: 'dotnet fsi' },

  // Group 6 — Dockerfile
  dockerfile: { runtimeId: 'dockerfile-tools', tool: 'hadolint --format json' },
  // Group 6 — Protobuf
  protobuf:   { runtimeId: 'protobuf-tools',   tool: 'protoc --proto_path' },
  proto:      { runtimeId: 'protobuf-tools',   tool: 'protoc --proto_path' },
  // Group 6 — INI/Config
  ini:        { runtimeId: 'python',            tool: 'python configparser' },
  cfg:        { runtimeId: 'python',            tool: 'python configparser' },
  conf:       { runtimeId: 'python',            tool: 'python configparser' },
  properties: { runtimeId: 'python',            tool: 'python configparser' },
  config:     { runtimeId: 'python',            tool: 'python configparser' },
  // Group 6 — Diff/Patch
  diff:       { runtimeId: 'patch-tools',       tool: 'patch --dry-run' },
  patch:      { runtimeId: 'patch-tools',       tool: 'patch --dry-run' },
  // Group 6 — GraphQL (client-side via npx)
  graphql:    { runtimeId: 'graphql-tools',     tool: 'npx graphql parse' },
  gql:        { runtimeId: 'graphql-tools',     tool: 'npx graphql parse' },
  // Group 6 — Nginx
  nginx:      { runtimeId: 'nginx-tools',       tool: 'nginx -t' },
  // Group 6 — Apache
  apache:     { runtimeId: 'apache-tools',      tool: 'httpd -t' },
  apacheconf: { runtimeId: 'apache-tools',      tool: 'httpd -t' },
  // Group 6 — Makefile
  makefile:   { runtimeId: 'make-tools',        tool: 'make -n' },
  make:       { runtimeId: 'make-tools',        tool: 'make -n' },
  // Group 6 — CMake
  cmake:      { runtimeId: 'cmake-tools',       tool: 'cmake -P' },
  // Group 6 — Gradle
  gradle:     { runtimeId: 'gradle-tools',      tool: 'gradle tasks --offline' },

  // Group 7 — LaTeX
  latex:      { runtimeId: 'latex',   tool: 'pdflatex -draftmode' },
  tex:        { runtimeId: 'latex',   tool: 'pdflatex -draftmode' },
  // Group 7 — MATLAB/Octave
  matlab:     { runtimeId: 'octave',  tool: 'octave --no-gui' },
  octave:     { runtimeId: 'octave',  tool: 'octave --no-gui' },
  // Group 7 — Mathematica/Wolfram
  mathematica:{ runtimeId: 'wolfram', tool: 'wolframscript -file' },
  wolfram:    { runtimeId: 'wolfram', tool: 'wolframscript -file' },
  wl:         { runtimeId: 'wolfram', tool: 'wolframscript -file' },
  // Group 7 — SAS
  sas:        { runtimeId: 'sas',     tool: 'sas -syntax' },
  // Group 7 — COBOL
  cobol:      { runtimeId: 'cobol',   tool: 'cobc -fsyntax-only' },
  cob:        { runtimeId: 'cobol',   tool: 'cobc -fsyntax-only' },
  cbl:        { runtimeId: 'cobol',   tool: 'cobc -fsyntax-only' },
  // Group 7 — Ada
  ada:        { runtimeId: 'ada',     tool: 'gnatmake -gnats' },
  adb:        { runtimeId: 'ada',     tool: 'gnatmake -gnats' },
  ads:        { runtimeId: 'ada',     tool: 'gnatmake -gnats' },
  // Group 7 — D
  d:          { runtimeId: 'dlang',   tool: 'dmd -o-' },
  // Group 7 — Nim
  nim:        { runtimeId: 'nim',     tool: 'nim check --hints:off' },
  // Group 7 — Zig
  zig:        { runtimeId: 'zig',     tool: 'zig ast-check' },
  // Group 7 — V (use 'vlang' key; 'v' key is reserved for Verilog in getLangExt)
  vlang:      { runtimeId: 'vlang',   tool: 'v -check' },
};

function getSyntaxCheckerInfo(lang) {
  return SYNTAX_CHECKERS[(lang || '').toLowerCase()] || null;
}

module.exports = {
  detectRuntimes,
  getRuntimeForLang,
  getSyntaxCheckerInfo,
  SYNTAX_CHECKERS,
  RUNTIMES,
};
