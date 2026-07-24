/**
 * CodeMirrorEditor — full-featured code editor using CodeMirror 6.
 * Supports 100+ languages via dedicated packages + legacy-modes.
 * Real-time syntax checking with red zigzag underlines via @codemirror/lint.
 */

import { useEffect, useRef } from 'react';
import { EditorState, Compartment, Extension } from '@codemirror/state';
import {
  EditorView, lineNumbers, highlightActiveLineGutter,
  highlightSpecialChars, drawSelection, dropCursor,
  rectangularSelection, highlightActiveLine, keymap, ViewUpdate,
} from '@codemirror/view';
import { defaultKeymap, history, historyKeymap, indentWithTab } from '@codemirror/commands';
import { searchKeymap, highlightSelectionMatches, search } from '@codemirror/search';
import {
  indentOnInput, syntaxHighlighting, defaultHighlightStyle,
  bracketMatching, foldGutter, indentUnit, StreamLanguage,
} from '@codemirror/language';
import { autocompletion, completionKeymap, closeBrackets, closeBracketsKeymap } from '@codemirror/autocomplete';
import { linter, lintGutter, lintKeymap, Diagnostic } from '@codemirror/lint';
import { oneDark } from '@codemirror/theme-one-dark';

// Dedicated packages
import { javascript } from '@codemirror/lang-javascript';
import { html }       from '@codemirror/lang-html';
import { css }        from '@codemirror/lang-css';
import { python }     from '@codemirror/lang-python';
import { java }       from '@codemirror/lang-java';
import { cpp }        from '@codemirror/lang-cpp';
import { json }       from '@codemirror/lang-json';
import { markdown }   from '@codemirror/lang-markdown';
import { sql }        from '@codemirror/lang-sql';
import { rust }       from '@codemirror/lang-rust';
import { php }        from '@codemirror/lang-php';
import { vue }        from '@codemirror/lang-vue';
import { yaml }       from '@codemirror/lang-yaml';
import { xml }        from '@codemirror/lang-xml';

// Legacy modes
import { shell }        from '@codemirror/legacy-modes/mode/shell';
import { go }           from '@codemirror/legacy-modes/mode/go';
import { ruby }         from '@codemirror/legacy-modes/mode/ruby';
import { swift }        from '@codemirror/legacy-modes/mode/swift';
import { kotlin, scala, dart } from '@codemirror/legacy-modes/mode/clike';
import { lua }          from '@codemirror/legacy-modes/mode/lua';
import { r }            from '@codemirror/legacy-modes/mode/r';
import { perl }         from '@codemirror/legacy-modes/mode/perl';
import { haskell }      from '@codemirror/legacy-modes/mode/haskell';
import { erlang }       from '@codemirror/legacy-modes/mode/erlang';
import { toml }         from '@codemirror/legacy-modes/mode/toml';
import { dockerFile }   from '@codemirror/legacy-modes/mode/dockerfile';
import { nginx }        from '@codemirror/legacy-modes/mode/nginx';
import { diff }         from '@codemirror/legacy-modes/mode/diff';
import { groovy }       from '@codemirror/legacy-modes/mode/groovy';
import { powerShell }   from '@codemirror/legacy-modes/mode/powershell';
import { vb }           from '@codemirror/legacy-modes/mode/vb';
import { coffeeScript } from '@codemirror/legacy-modes/mode/coffeescript';
import { clojure }      from '@codemirror/legacy-modes/mode/clojure';
import { elm }          from '@codemirror/legacy-modes/mode/elm';
import { crystal }      from '@codemirror/legacy-modes/mode/crystal';
import { julia }        from '@codemirror/legacy-modes/mode/julia';
import { fortran }      from '@codemirror/legacy-modes/mode/fortran';
import { pascal }       from '@codemirror/legacy-modes/mode/pascal';
import { tcl }          from '@codemirror/legacy-modes/mode/tcl';
import { verilog }      from '@codemirror/legacy-modes/mode/verilog';
import { vhdl }         from '@codemirror/legacy-modes/mode/vhdl';
import { sparql }       from '@codemirror/legacy-modes/mode/sparql';
import { turtle }       from '@codemirror/legacy-modes/mode/turtle';
import { ntriples }     from '@codemirror/legacy-modes/mode/ntriples';
// Group 7 imports
import { stex }        from '@codemirror/legacy-modes/mode/stex';        // LaTeX
import { octave }      from '@codemirror/legacy-modes/mode/octave';      // MATLAB/Octave
import { mathematica } from '@codemirror/legacy-modes/mode/mathematica'; // Mathematica/Wolfram
import { sas }         from '@codemirror/legacy-modes/mode/sas';         // SAS
import { cobol }       from '@codemirror/legacy-modes/mode/cobol';       // COBOL
import { d }           from '@codemirror/legacy-modes/mode/d';           // D language
import { isElectron }   from '../../lib/electronBridge';

interface CodeMirrorEditorProps {
  tabId: string;
  content: string;
  language: string;
  onChange: (content: string) => void;
  onSave: () => void;
}

function getLangExt(lang: string): Extension | null {
  switch (lang.toLowerCase()) {
    case 'javascript': case 'js': case 'mjs': case 'cjs': case 'jsx':
      return javascript({ jsx: lang === 'jsx' });
    case 'typescript': case 'ts': case 'tsx':
      return javascript({ typescript: true, jsx: lang === 'tsx' });
    case 'html': case 'htm':
      return html();
    case 'css': case 'scss': case 'less':
      return css();
    case 'python': case 'py': case 'pyw':
      return python();
    case 'java':
      return java();
    case 'cpp': case 'cc': case 'cxx': case 'c': case 'h': case 'hpp':
      return cpp();
    case 'json':
      return json();
    case 'markdown': case 'md':
      return markdown();
    case 'sql':
      return sql();
    case 'rust': case 'rs':
      return rust();
    case 'php':
      return php();
    case 'vue':
      return vue();
    case 'yaml': case 'yml':
      return yaml();
    case 'xml': case 'svg':
      return xml();
    case 'shell': case 'sh': case 'bash': case 'zsh':
      return StreamLanguage.define(shell);
    case 'go':
      return StreamLanguage.define(go);
    case 'ruby': case 'rb':
      return StreamLanguage.define(ruby);
    case 'swift':
      return StreamLanguage.define(swift);
    case 'kotlin': case 'kt':
      return StreamLanguage.define(kotlin);
    case 'scala':
      return StreamLanguage.define(scala);
    case 'dart':
      return StreamLanguage.define(dart);
    case 'lua':
      return StreamLanguage.define(lua);
    case 'r':
      return StreamLanguage.define(r);
    case 'perl': case 'pl':
      return StreamLanguage.define(perl);
    case 'haskell': case 'hs':
      return StreamLanguage.define(haskell);
    case 'erlang': case 'erl':
      return StreamLanguage.define(erlang);
    case 'toml':
      return StreamLanguage.define(toml);
    case 'dockerfile':
      return StreamLanguage.define(dockerFile);
    case 'nginx':
      return StreamLanguage.define(nginx);
    case 'diff': case 'patch':
      return StreamLanguage.define(diff);
    case 'groovy':
      return StreamLanguage.define(groovy);
    case 'powershell': case 'ps1':
      return StreamLanguage.define(powerShell);
    case 'vb': case 'vbs':
      return StreamLanguage.define(vb);
    case 'coffeescript': case 'coffee':
      return StreamLanguage.define(coffeeScript);
    case 'clojure': case 'clj':
      return StreamLanguage.define(clojure);
    case 'elm':
      return StreamLanguage.define(elm);
    case 'crystal': case 'cr':
      return StreamLanguage.define(crystal);
    case 'julia': case 'jl':
      return StreamLanguage.define(julia);
    case 'fortran': case 'f90': case 'f95':
      return StreamLanguage.define(fortran);
    case 'pascal': case 'pas':
      return StreamLanguage.define(pascal);
    case 'tcl':
      return StreamLanguage.define(tcl);
    case 'verilog': case 'v':
      // NOTE: 'v' maps to Verilog here. V-lang files use the 'vlang' key to avoid collision.
      return StreamLanguage.define(verilog);
    case 'vhdl':
      return StreamLanguage.define(vhdl);
    case 'sparql':
      return StreamLanguage.define(sparql);
    case 'turtle': case 'ttl':
      return StreamLanguage.define(turtle);
    case 'ntriples': case 'nt':
      return StreamLanguage.define(ntriples);
    // Group 7 — LaTeX
    case 'latex': case 'tex':
      return StreamLanguage.define(stex);
    // Group 7 — MATLAB / Octave
    case 'matlab': case 'octave':
      return StreamLanguage.define(octave);
    // Group 7 — Mathematica / Wolfram
    case 'mathematica': case 'wolfram': case 'wl':
      return StreamLanguage.define(mathematica);
    // Group 7 — SAS
    case 'sas':
      return StreamLanguage.define(sas);
    // Group 7 — COBOL
    case 'cobol': case 'cob': case 'cbl':
      return StreamLanguage.define(cobol);
    // Group 7 — D language
    case 'd':
      return StreamLanguage.define(d);
    // Group 7 — V language (use 'vlang' to avoid collision with Verilog's 'v')
    case 'vlang':
      return null; // No CodeMirror legacy mode available for V language
    default:
      return null;
  }
}

// Languages for which we can run IPC-based syntax checks.
// Groups 1–3 and 6–7 are registered here alongside the pre-existing
// JS / TS / Python / JSON entries. Each language is backed by a downloadable
// runtime whose single winget package bundles both the runtime AND its
// syntax checker (see electron/runtime-detect.cjs SYNTAX_CHECKERS).
const CHECKABLE_LANGS = new Set([
  // Pre-existing
  'javascript', 'js', 'mjs', 'cjs', 'jsx',
  'typescript', 'ts', 'tsx',
  'python', 'py', 'pyw',
  'json',
  // Group [1]
  'java',
  'c', 'h',
  'cpp', 'cc', 'cxx', 'hpp',
  'cs', 'csharp',
  'php',
  'go',
  'rust', 'rs',
  // Group 2
  'ruby', 'rb',
  'swift',
  'kotlin', 'kt', 'kts',
  'scala',
  'sql',
  'shell', 'sh', 'bash', 'zsh', 'fish',
  'powershell', 'ps1',
  'r',
  'dart',
  'lua',
  // Group 3
  'groovy',
  'perl', 'pl', 'pm',
  'haskell', 'hs',
  'elixir', 'ex', 'exs',
  'erlang', 'erl', 'hrl',
  'clojure', 'clj', 'cljs',
  'julia', 'jl',
  'crystal', 'cr',
  'fsharp', 'fs', 'fsx',
  // Group 6
  'dockerfile',
  'protobuf', 'proto',
  'ini', 'cfg', 'conf', 'properties', 'config',
  'diff', 'patch',
  'graphql', 'gql',
  'nginx',
  'apache', 'apacheconf',
  'makefile', 'make',
  'cmake',
  'gradle',
  // Group 7
  'latex', 'tex',
  'matlab', 'octave',
  'mathematica', 'wolfram', 'wl',
  'sas',
  'cobol', 'cob', 'cbl',
  'ada', 'adb', 'ads',
  'd',
  'nim',
  'zig',
  'vlang', // NOTE: 'v' is intentionally excluded — it maps to Verilog in getLangExt
]);

function makeSyntaxLinter(language: string) {
  const lang = language.toLowerCase();
  if (!CHECKABLE_LANGS.has(lang)) return linter(() => []);

  return linter(async (view) => {
    const content = view.state.doc.toString();
    if (content.trim().length < 3) return [];

    // Fast client-side JSON check (no IPC round-trip needed)
    if (lang === 'json') {
      return clientJsonCheck(content);
    }

    // IPC-based check for all other supported languages
    if (!isElectron()) return [];
    const bridge = (window as any).electronAPI;
    if (!bridge?.syntaxCheck) return [];

    try {
      const result = await bridge.syntaxCheck({ language: lang, content });
      if (!result?.ok || !result.diagnostics?.length) return [];
      return result.diagnostics as Diagnostic[];
    } catch (e) {
      return [];
    }
  }, { delay: 700 });
}

function clientJsonCheck(content: string): Diagnostic[] {
  try {
    JSON.parse(content);
    return [];
  } catch (e: any) {
    const msg: string = e.message ?? 'JSON syntax error';
    // "Unexpected token X at position N"
    const posMatch = msg.match(/position\s+(\d+)/i);
    // "Unexpected token X in JSON at position N" or "at line N col N"
    const lineColMatch = msg.match(/line\s+(\d+)\s+col(?:umn)?\s+(\d+)/i);

    let from = 0;
    let to = 1;
    if (posMatch) {
      from = parseInt(posMatch[1]);
      to = from + 1;
    } else if (lineColMatch) {
      const lineNum = parseInt(lineColMatch[1]) - 1;
      const col = parseInt(lineColMatch[2]) - 1;
      const lines = content.split('\n');
      from = lines.slice(0, lineNum).reduce((a, l) => a + l.length + 1, 0) + col;
      to = from + 1;
    }
    return [{ from: Math.min(from, content.length - 1), to: Math.min(to, content.length), severity: 'error', message: msg }];
  }
}

// SenCode editor theme overrides (dark, matches the app palette)
const codeforgeTheme = EditorView.theme({
  '&': { height: '100%', background: 'var(--s0, #0b0e14)' },
  '.cm-scroller': { overflow: 'auto', fontFamily: '"Fira Code", "JetBrains Mono", "Cascadia Code", monospace', fontSize: '13px', lineHeight: '1.65' },
  '.cm-content': { caretColor: 'var(--primary, #6d5ef5)', padding: '10px 0' },
  '.cm-focused': { outline: 'none' },
  '.cm-gutters': { background: 'var(--s1, #0f1218)', border: 'none', color: 'var(--ink-low, #4a5068)' },
  '.cm-activeLineGutter': { background: 'rgba(109,94,245,0.06)' },
  '.cm-activeLine': { background: 'rgba(109,94,245,0.04)' },
  '.cm-selectionBackground, ::selection': { background: 'rgba(109,94,245,0.25) !important' },
  '.cm-cursor': { borderLeftColor: 'var(--primary, #6d5ef5)', borderLeftWidth: '2px' },
  '.cm-matchingBracket': { background: 'rgba(109,94,245,0.2)', outline: '1px solid rgba(109,94,245,0.4)' },
  // Lint / diagnostic styling
  // NOTE: '.cm-diagnostic-*' below styles the hover TOOLTIP text, not the
  // underline. The actual underlined range in the document uses
  // '.cm-lintRange-*', which @codemirror/lint renders as a background-image
  // SVG (not text-decoration) — so it must be overridden explicitly or the
  // wavy underline never appears no matter how many diagnostics come back.
  '.cm-lintRange-error': {
    backgroundImage: 'none !important',
    textDecoration: 'underline wavy #ef4444 !important',
    textUnderlineOffset: '2px',
  },
  '.cm-lintRange-warning': {
    backgroundImage: 'none !important',
    textDecoration: 'underline wavy #f59e0b !important',
    textUnderlineOffset: '2px',
  },
  '.cm-diagnostic-error': { textDecoration: 'underline wavy #ef4444', textUnderlineOffset: '2px' },
  '.cm-diagnostic-warning': { textDecoration: 'underline wavy #f59e0b', textUnderlineOffset: '2px' },
  '.cm-lint-marker-error': { content: '', display: 'inline-block', width: '6px', height: '6px', borderRadius: '50%', background: '#ef4444', marginLeft: '4px', verticalAlign: 'middle' },
  '.cm-lint-marker-warning': { content: '', display: 'inline-block', width: '6px', height: '6px', borderRadius: '50%', background: '#f59e0b', marginLeft: '4px', verticalAlign: 'middle' },
  '.cm-gutter-lint': { width: '14px' },
  '.cm-tooltip.cm-tooltip-lint': { background: 'var(--s2, #161b26)', border: '1px solid var(--s3, #2a3040)', color: 'var(--ink-high, #e8eaf2)', borderRadius: '6px', padding: '4px 8px', fontSize: '12px', maxWidth: '380px' },
});

export function CodeMirrorEditor({ tabId, content, language, onChange, onSave }: CodeMirrorEditorProps) {
  const containerRef = useRef<HTMLDivElement>(null);
  const viewRef      = useRef<EditorView | null>(null);
  const langComp     = useRef(new Compartment());
  const lintComp     = useRef(new Compartment());
  const onChangeRef  = useRef(onChange);
  const onSaveRef    = useRef(onSave);

  useEffect(() => { onChangeRef.current = onChange; }, [onChange]);
  useEffect(() => { onSaveRef.current  = onSave; }, [onSave]);

  // Build initial editor
  useEffect(() => {
    if (!containerRef.current) return;
    const langExt  = getLangExt(language);
    const lintExt  = makeSyntaxLinter(language);

    const state = EditorState.create({
      doc: content,
      extensions: [
        lineNumbers(), highlightActiveLineGutter(), foldGutter(),
        highlightSpecialChars(), highlightActiveLine(), highlightSelectionMatches(),
        drawSelection(), dropCursor(), rectangularSelection(),
        history(), indentOnInput(), indentUnit.of('  '),
        bracketMatching(), closeBrackets(), autocompletion(),
        langComp.current.of(langExt ?? []),
        lintComp.current.of(lintExt),
        lintGutter(),
        oneDark, codeforgeTheme,
        syntaxHighlighting(defaultHighlightStyle, { fallback: true }),
        search({ top: false }),
        keymap.of([
          ...closeBracketsKeymap, ...defaultKeymap, ...searchKeymap,
          ...historyKeymap, ...completionKeymap, ...lintKeymap,
          indentWithTab,
          { key: 'Mod-s', run: () => { onSaveRef.current(); return true; } },
        ]),
        EditorView.updateListener.of((u: ViewUpdate) => {
          if (u.docChanged) onChangeRef.current(u.state.doc.toString());
        }),
      ],
    });
    const view = new EditorView({ state, parent: containerRef.current });
    viewRef.current = view;
    return () => { view.destroy(); viewRef.current = null; };
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [tabId]);

  const lastContent = useRef(content);
  useEffect(() => {
    const view = viewRef.current;
    if (!view) return;
    const current = view.state.doc.toString();
    if (content !== current && content !== lastContent.current) {
      view.dispatch({ changes: { from: 0, to: current.length, insert: content } });
    }
    lastContent.current = content;
  }, [content]);

  useEffect(() => {
    const view = viewRef.current;
    if (!view) return;
    view.dispatch({ effects: [
      langComp.current.reconfigure(getLangExt(language) ?? []),
      lintComp.current.reconfigure(makeSyntaxLinter(language)),
    ]});
  }, [language]);

  return <div ref={containerRef} className="h-full w-full overflow-hidden" style={{ background: 'var(--s0)' }} />;
}
