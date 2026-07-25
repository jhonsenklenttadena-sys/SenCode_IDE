/**
 * Full-file language / extension detection.
 *
 * On save of an extensionless (or clearly mis-tagged) file, the entire buffer
 * is scanned and scored against every language SenCode supports. Detection
 * ALWAYS finishes before the rename/write proceeds.
 */

/** All extensions this app understands (mirrors detectLanguage / CodeMirror). */
export const SUPPORTED_EXTENSIONS = [
  'js', 'jsx', 'mjs', 'cjs', 'ts', 'tsx',
  'py', 'pyw', 'java', 'c', 'cpp', 'cxx', 'cc', 'h', 'hpp',
  'cs', 'go', 'rs', 'rb', 'php', 'swift', 'kt', 'kts', 'dart',
  'html', 'htm', 'css', 'scss', 'sass', 'less',
  'json', 'jsonc', 'yaml', 'yml', 'xml', 'svg', 'toml',
  'md', 'mdx', 'sql', 'sh', 'bash', 'zsh', 'fish', 'ps1', 'psm1',
  'lua', 'r', 'vue', 'svelte',
  'pl', 'pm', 'hs', 'ex', 'exs', 'erl', 'hrl', 'scala', 'groovy',
  'vb', 'vbs', 'coffee', 'clj', 'cljs', 'elm', 'cr', 'jl',
  'f90', 'f95', 'pas', 'pp', 'tcl', 'v', 'sv', 'vhd', 'vhdl',
  's', 'asm', 'scm', 'ml', 'mli', 'fs', 'fsx',
  'proto', 'dockerfile', 'diff', 'patch', 'ini', 'cfg', 'txt',
] as const;

const KNOWN_EXTS = new Set<string>(SUPPORTED_EXTENSIONS);

/** True if the basename already has a real extension (e.g. app.js). */
export function hasFileExtension(filename: string): boolean {
  const base = filename.split(/[\\/]/).pop() ?? filename;
  const i = base.lastIndexOf('.');
  return i > 0 && i < base.length - 1;
}

/** True if the extension is a known code/markup type. */
export function hasKnownCodeExtension(filename: string): boolean {
  const base = filename.split(/[\\/]/).pop() ?? filename;
  const i = base.lastIndexOf('.');
  if (i <= 0 || i >= base.length - 1) return false;
  return KNOWN_EXTS.has(base.slice(i + 1).toLowerCase());
}

type Scorer = (src: string) => number;

interface LangRule {
  ext: string;
  /** Minimum score required to accept this language. */
  min: number;
  score: Scorer;
}

function countMatches(src: string, re: RegExp): number {
  const flags = re.flags.includes('g') ? re.flags : re.flags + 'g';
  const r = new RegExp(re.source, flags);
  let n = 0;
  // Variable used only in assignment within while condition
  for (let m = r.exec(src); m !== null; m = r.exec(src)) {
    n++;
    if (n > 200) break; // safety cap
  }
  return n;
}

function has(src: string, re: RegExp): boolean {
  return re.test(src);
}

/**
 * Language rules — each scorer inspects the FULL source.
 * Higher unique / structural signals weigh more than generic keywords.
 */
const RULES: LangRule[] = [
  // ── Documents / markup ───────────────────────────────────────────────────
  {
    ext: 'html',
    min: 8,
    score: (s) => {
      let sc = 0;
      // Use multiline flag so ^ matches start-of-line, not just start-of-string.
      // Handles files with a leading BOM, whitespace, or newline before the doctype.
      if (has(s, /^<!DOCTYPE\s+html/im)) sc += 20;
      if (has(s, /^<html[\s>]/im)) sc += 15;
      sc += countMatches(s, /<\/?(html|head|body|div|span|section|article|nav|header|footer|main|button|input|form|table|tr|td|ul|ol|li|p|h[1-6]|img|a|script|style|link|meta)\b/gi) * 2;
      if (has(s, /<script[\s>]/i) && has(s, /<\/script>/i)) sc += 4;
      if (has(s, /<style[\s>]/i) && has(s, /<\/style>/i)) sc += 4;
      // Extra signal: HTML attributes are a strong marker
      if (has(s, /\s(lang|charset|href|src|class|id|type|rel|name|content)=/i)) sc += 6;
      return sc;
    },
  },
  {
    ext: 'xml',
    min: 8,
    score: (s) => {
      let sc = 0;
      if (has(s, /^<\?xml[\s>]/i)) sc += 20;
      if (has(s, /xmlns[:=]/)) sc += 8;
      sc += countMatches(s, /<\/?[A-Za-z_][\w:.-]*(\s[^>]*)?>/g) * 1;
      // Prefer HTML if HTML-ish tags dominate
      if (has(s, /<\/?(html|body|div)\b/i)) sc -= 10;
      return sc;
    },
  },
  {
    ext: 'vue',
    min: 10,
    score: (s) => {
      let sc = 0;
      if (has(s, /<template[\s>]/i) && has(s, /<\/template>/i)) sc += 15;
      if (has(s, /<script[\s>]/i) && has(s, /<style[\s>]/i)) sc += 10;
      if (has(s, /\bdefineComponent\b|\bsetup\s*\(/)) sc += 6;
      return sc;
    },
  },
  {
    ext: 'php',
    min: 8,
    score: (s) => {
      let sc = 0;
      if (has(s, /^<\?php/i) || has(s, /<\?=/)) sc += 25;
      sc += countMatches(s, /\$\w+/g);
      if (has(s, /\b(echo|namespace|use|function)\b/)) sc += 3;
      return sc;
    },
  },

  // ── JVM / .NET ───────────────────────────────────────────────────────────
  {
    ext: 'java',
    min: 15,  // raised — Java has very specific structural signals, low score = wrong language
    score: (s) => {
      let sc = 0;
      if (has(s, /^\s*package\s+[\w.]+;/m)) sc += 10;
      sc += countMatches(s, /\bpublic\s+class\s+\w+/g) * 15;
      sc += countMatches(s, /\bclass\s+\w+/g) * 6;
      if (has(s, /\bpublic\s+static\s+void\s+main\s*\(/)) sc += 15;
      sc += countMatches(s, /\bSystem\.out\.(println|print|printf)\s*\(/g) * 10;
      if (has(s, /\b(import\s+java\.|extends\s+\w+|implements\s+\w+)/)) sc += 8;
      if (has(s, /\bnew\s+\w+\s*\(/)) sc += 2;
      // Strong Java-only signals
      if (has(s, /\bString\[\]\s*args\b/)) sc += 10;
      if (has(s, /\bvoid\s+\w+\s*\(.*\)\s*\{/m)) sc += 5;
      // Hard penalty: HTML, Python-style print without class context
      if (has(s, /<!DOCTYPE\s+html/i) || has(s, /<html[\s>]/i)) sc -= 40;
      // print() alone with no class is NOT Java
      if (!has(s, /\bclass\s+\w+/) && has(s, /\bprint\s*\(/) && !has(s, /System\.out/)) sc -= 20;
      return sc;
    },
  },
  {
    ext: 'kt',
    min: 8,
    score: (s) => {
      let sc = 0;
      if (has(s, /\bfun\s+\w+\s*\(/)) sc += 12;
      if (has(s, /\b(val|var)\s+\w+/)) sc += 4;
      if (has(s, /\bdata\s+class\b|\bcompanion\s+object\b|\bsuspend\s+fun\b/)) sc += 10;
      if (has(s, /\bpackage\s+[\w.]+/)) sc += 3;
      if (has(s, /<!DOCTYPE\s+html/i) || has(s, /<html[\s>]/i)) sc -= 30;
      return sc;
    },
  },
  {
    ext: 'scala',
    min: 8,
    score: (s) => {
      let sc = 0;
      if (has(s, /\bobject\s+\w+/)) sc += 10;
      if (has(s, /\bdef\s+\w+\s*[\([=]/)) sc += 8;
      if (has(s, /\bcase\s+class\b|\btrait\s+\w+/)) sc += 10;
      if (has(s, /\bval\s+\w+/)) sc += 3;
      if (has(s, /<!DOCTYPE\s+html/i) || has(s, /<html[\s>]/i)) sc -= 30;
      return sc;
    },
  },
  {
    ext: 'groovy',
    min: 12,  // raised — println alone is too weak
    score: (s) => {
      let sc = 0;
      if (has(s, /\bdef\s+\w+\s*=/)) sc += 6;
      if (has(s, /\bprintln\s+/)) sc += 4;
      if (has(s, /\b(task|dependencies|plugins)\s*\{/)) sc += 12;
      if (has(s, /<!DOCTYPE\s+html/i) || has(s, /<html[\s>]/i)) sc -= 30;
      return sc;
    },
  },
  {
    ext: 'cs',
    min: 8,
    score: (s) => {
      let sc = 0;
      if (has(s, /^\s*using\s+System\b/m)) sc += 15;
      if (has(s, /\bnamespace\s+[\w.]+/)) sc += 8;
      if (has(s, /\bConsole\.(WriteLine|Write)\s*\(/)) sc += 12;
      if (has(s, /\b(public|private)\s+(partial\s+)?class\s+\w+/)) sc += 6;
      if (has(s, /\basync\s+Task\b|\bIEnumerable</)) sc += 5;
      if (has(s, /<!DOCTYPE\s+html/i) || has(s, /<html[\s>]/i)) sc -= 30;
      return sc;
    },
  },
  {
    ext: 'fs',
    min: 8,
    score: (s) => {
      let sc = 0;
      if (has(s, /\blet\s+\w+\s*=/)) sc += 3;
      if (has(s, /\bprintfn\b|\bmodule\s+\w+/)) sc += 10;
      if (has(s, /\btype\s+\w+\s*=/)) sc += 5;
      if (has(s, /\|-\>/) || has(s, /<-/)) sc += 4;
      return sc;
    },
  },
  {
    ext: 'vb',
    min: 8,
    score: (s) => {
      let sc = 0;
      if (has(s, /^\s*(Public|Private|Dim|Sub|Function|End\s+Sub|End\s+Function)\b/im)) sc += 10;
      sc += countMatches(s, /\b(Dim|Sub|Function|Module|Namespace)\b/gi) * 3;
      if (has(s, /\bConsole\.WriteLine\b/i)) sc += 8;
      return sc;
    },
  },

  // ── Systems ──────────────────────────────────────────────────────────────
  {
    ext: 'c',
    min: 8,
    score: (s) => {
      let sc = 0;
      sc += countMatches(s, /^#include\s*[<"]/gm) * 8;
      if (has(s, /\bint\s+main\s*\(/)) sc += 10;
      if (has(s, /\bprintf\s*\(|\bscanf\s*\(/)) sc += 8;
      if (has(s, /\b(malloc|free|sizeof)\s*\(/)) sc += 6;
      // Penalize C++ signals
      if (has(s, /\bstd::|^\s*using\s+namespace\b|^\s*class\s+\w+/m)) sc -= 15;
      return sc;
    },
  },
  {
    ext: 'cpp',
    min: 8,
    score: (s) => {
      let sc = 0;
      sc += countMatches(s, /^#include\s*[<"]/gm) * 5;
      if (has(s, /\bstd::/)) sc += 12;
      if (has(s, /\bcout\s*<<|cin\s*>>/)) sc += 12;
      if (has(s, /\btemplate\s*</)) sc += 8;
      if (has(s, /\bclass\s+\w+/)) sc += 4;
      if (has(s, /\bnamespace\s+\w+/)) sc += 5;
      if (has(s, /<!DOCTYPE\s+html/i) || has(s, /<html[\s>]/i)) sc -= 30;
      return sc;
    },
  },
  {
    ext: 'rs',
    min: 8,
    score: (s) => {
      let sc = 0;
      sc += countMatches(s, /\bfn\s+\w+/g) * 8;
      if (has(s, /\blet\s+mut\b/)) sc += 10;
      if (has(s, /^\s*use\s+[\w:]+;/m)) sc += 8;
      if (has(s, /\bprintln!\s*!?\s*\(|\bimpl\s+\w+/)) sc += 8;
      if (has(s, /\bpub\s+(fn|struct|enum|mod)\b/)) sc += 6;
      return sc;
    },
  },
  {
    ext: 'go',
    min: 8,
    score: (s) => {
      let sc = 0;
      if (has(s, /^\s*package\s+\w+/m)) sc += 8;
      sc += countMatches(s, /\bfunc\s+(\(\w+\s+\*?\w+\)\s+)?\w+\s*\(/g) * 8;
      if (has(s, /\bfmt\./)) sc += 10;
      if (has(s, /\b:=\s/)) sc += 6;
      if (has(s, /\bgo\s+func\b|\bdefer\b|\bchan\b/)) sc += 8;
      // Java also has package — require Go-ish signals
      if (has(s, /\bpublic\s+class\b|\bSystem\.out\b/)) sc -= 20;
      return sc;
    },
  },
  {
    ext: 'swift',
    min: 8,
    score: (s) => {
      let sc = 0;
      if (has(s, /\bfunc\s+\w+\s*\(/)) sc += 6;
      if (has(s, /\b(let|var)\s+\w+/)) sc += 3;
      if (has(s, /\bimport\s+(Foundation|UIKit|SwiftUI)\b/)) sc += 15;
      if (has(s, /\b(struct|class|enum)\s+\w+/)) sc += 4;
      if (has(s, /\bprint\s*\(/)) sc += 2;
      if (has(s, /->\s*\w+/)) sc += 3;
      return sc;
    },
  },
  {
    ext: 'dart',
    min: 8,
    score: (s) => {
      let sc = 0;
      if (has(s, /\bvoid\s+main\s*\(/)) sc += 8;
      if (has(s, /\b(Widget|StatelessWidget|StatefulWidget)\b/)) sc += 15;
      if (has(s, /\bimport\s+['"]package:flutter\//)) sc += 20;
      if (has(s, /\bprint\s*\(/)) sc += 2;
      return sc;
    },
  },

  // ── Scripting ────────────────────────────────────────────────────────────
  {
    ext: 'py',
    min: 12,  // raised — single print() is 3 pts, not enough; need real Python structure
    score: (s) => {
      let sc = 0;
      if (has(s, /^#!/)) sc += 2;
      sc += countMatches(s, /^\s*def\s+\w+\s*\(/gm) * 8;
      sc += countMatches(s, /^\s*class\s+\w+/gm) * 6;
      sc += countMatches(s, /^\s*from\s+[\w.]+\s+import\b/gm) * 6;
      sc += countMatches(s, /^\s*import\s+[\w.]+/gm) * 4;
      if (has(s, /\bif\s+__name__\s*==\s*['"']__main__['"']/)) sc += 15;
      if (has(s, /\bprint\s*\(/)) sc += 3;
      if (has(s, /\bself\./)) sc += 6;
      // Python indentation as signal: colon at end of control line
      sc += countMatches(s, /^\s*(if|for|while|with|try|except|elif|else)\b.*:\s*$/gm) * 3;
      // Avoid JS
      if (has(s, /\b(function|const|let|var)\b/) && has(s, /[{};]/)) sc -= 10;
      return sc;
    },
  },
  {
    ext: 'rb',
    min: 12,  // raised — `end` alone is not enough
    score: (s) => {
      let sc = 0;
      if (has(s, /\bdef\s+\w+/)) sc += 6;
      if (has(s, /\bend\b/)) sc += 4;
      if (has(s, /\b(puts|require|attr_accessor)\b/)) sc += 8;
      if (has(s, /\bclass\s+\w+/)) sc += 4;
      if (has(s, /do\s*\|/)) sc += 6;
      return sc;
    },
  },
  {
    ext: 'lua',
    min: 12,  // raised — `end` alone is not enough
    score: (s) => {
      let sc = 0;
      if (has(s, /\blocal\s+function\b|\bfunction\s+\w+/)) sc += 8;
      if (has(s, /\bend\b/)) sc += 3;
      if (has(s, /\brequire\s*\(/)) sc += 5;
      if (has(s, /\bthen\b/) && has(s, /\bif\b/)) sc += 4;
      return sc;
    },
  },
  {
    ext: 'pl',
    min: 8,
    score: (s) => {
      let sc = 0;
      if (has(s, /^#!/) && has(s, /perl/i)) sc += 20;
      sc += countMatches(s, /\$\w+|@\w+|%\w+/g);
      if (has(s, /\b(use\s+strict|my\s+\$|print\s+)/)) sc += 8;
      return sc;
    },
  },
  {
    ext: 'r',
    min: 8,
    score: (s) => {
      let sc = 0;
      if (has(s, /<-/)) sc += 8;
      if (has(s, /\b(library|require)\s*\(/)) sc += 10;
      if (has(s, /\bfunction\s*\(/)) sc += 4;
      if (has(s, /\b(data\.frame|ggplot|tidyverse)\b/)) sc += 12;
      return sc;
    },
  },
  {
    ext: 'jl',
    min: 8,
    score: (s) => {
      let sc = 0;
      if (has(s, /\bfunction\s+\w+/)) sc += 5;
      if (has(s, /\bend\b/)) sc += 3;
      if (has(s, /\b(using|module)\s+\w+/)) sc += 10;
      if (has(s, /::/)) sc += 2;
      return sc;
    },
  },
  {
    ext: 'cr',
    min: 8,
    score: (s) => {
      let sc = 0;
      if (has(s, /\bdef\s+\w+/)) sc += 5;
      if (has(s, /\bend\b/)) sc += 3;
      if (has(s, /\bputs\b|\brequire\b/)) sc += 6;
      if (has(s, /\bclass\s+\w+/)) sc += 3;
      return sc;
    },
  },
  {
    ext: 'ex',
    min: 8,
    score: (s) => {
      let sc = 0;
      if (has(s, /\bdefmodule\s+\w+/)) sc += 15;
      if (has(s, /\bdef\s+\w+/)) sc += 5;
      if (has(s, /\bdo\b/) && has(s, /\bend\b/)) sc += 4;
      if (has(s, /\bIO\.puts\b/)) sc += 8;
      return sc;
    },
  },
  {
    ext: 'erl',
    min: 8,
    score: (s) => {
      let sc = 0;
      if (has(s, /^-module\(/m)) sc += 20;
      if (has(s, /^-export\(/m)) sc += 15;
      if (has(s, /\bspawn\b|\breceive\b/)) sc += 8;
      return sc;
    },
  },
  {
    ext: 'hs',
    min: 8,
    score: (s) => {
      let sc = 0;
      if (has(s, /^\s*module\s+\w+/m)) sc += 10;
      if (has(s, /^\s*import\s+(qualified\s+)?\w+/m)) sc += 6;
      if (has(s, /::/)) sc += 5;
      if (has(s, /\bwhere\b|\bdata\s+\w+\s*=/)) sc += 8;
      return sc;
    },
  },
  {
    ext: 'ml',
    min: 8,
    score: (s) => {
      let sc = 0;
      if (has(s, /\blet\s+rec\b|\blet\s+\w+\s*=/)) sc += 6;
      if (has(s, /\bmodule\s+\w+\s*=/)) sc += 8;
      if (has(s, /\bin\b/) && has(s, /\blet\b/)) sc += 3;
      return sc;
    },
  },
  {
    ext: 'clj',
    min: 8,
    score: (s) => {
      let sc = 0;
      if (has(s, /\(ns\s+[\w.-]+/)) sc += 15;
      sc += countMatches(s, /\((defn|def|let|if|fn)\s+/g) * 5;
      return sc;
    },
  },
  {
    ext: 'scm',
    min: 8,
    score: (s) => {
      let sc = 0;
      sc += countMatches(s, /\((define|lambda|let|if|cond)\s+/g) * 6;
      if (has(s, /#t|#f/)) sc += 5;
      return sc;
    },
  },
  {
    ext: 'elm',
    min: 8,
    score: (s) => {
      let sc = 0;
      if (has(s, /^\s*module\s+\w+/m)) sc += 10;
      if (has(s, /\bexposing\s*\(/)) sc += 10;
      if (has(s, /\btype\s+alias\b|\bHtml\./)) sc += 8;
      return sc;
    },
  },
  {
    ext: 'coffee',
    min: 8,
    score: (s) => {
      let sc = 0;
      if (has(s, /->/) || has(s, /=>/)) sc += 4;
      if (has(s, /\bconsole\.log\b/)) sc += 3;
      if (has(s, /^\s*\w+\s*=\s*\(.*\)\s*->/m)) sc += 10;
      return sc;
    },
  },

  // ── JS / TS family ───────────────────────────────────────────────────────
  {
    ext: 'tsx',
    min: 10,
    score: (s) => {
      let sc = 0;
      const looksTs = has(s, /:\s*(string|number|boolean|any|void|React\.\w+)/) || has(s, /\binterface\s+\w+/) || has(s, /\btype\s+\w+\s*=/);
      const looksJsx = has(s, /<[A-Z][A-Za-z0-9]*[\s/>]/) || has(s, /\bReact\b/);
      if (looksTs && looksJsx) sc += 20;
      if (has(s, /\bfrom\s+['"]react['"]/)) sc += 8;
      return sc;
    },
  },
  {
    ext: 'jsx',
    min: 10,
    score: (s) => {
      let sc = 0;
      if (has(s, /<[A-Z][A-Za-z0-9]*[\s/>]/)) sc += 12;
      if (has(s, /\bfrom\s+['"]react['"]|\bReact\./)) sc += 8;
      if (has(s, /\b(useState|useEffect)\b/)) sc += 8;
      // Prefer tsx if types present
      if (has(s, /:\s*(string|number|boolean|any|void)\b/) || has(s, /\binterface\s+\w+/)) sc -= 15;
      return sc;
    },
  },
  {
    ext: 'ts',
    min: 8,
    score: (s) => {
      let sc = 0;
      if (has(s, /\binterface\s+\w+/)) sc += 10;
      if (has(s, /\btype\s+\w+\s*=/)) sc += 8;
      sc += countMatches(s, /:\s*(string|number|boolean|any|void|unknown|never)\b/g) * 3;
      if (has(s, /\b(export|import)\b/)) sc += 2;
      if (has(s, /<[A-Z][A-Za-z0-9]*[\s/>]/)) sc -= 12; // prefer tsx
      return sc;
    },
  },
  {
    ext: 'js',
    min: 8,
    score: (s) => {
      let sc = 0;
      sc += countMatches(s, /\b(function|const|let|var)\b/g) * 2;
      if (has(s, /=>/)) sc += 3;
      if (has(s, /\b(export\s+default|module\.exports|require\s*\()/)) sc += 8;
      if (has(s, /\bconsole\.(log|error|warn)\s*\(/)) sc += 6;
      if (has(s, /\bdocument\.|window\./)) sc += 4;
      // Prefer more specific dialects
      if (has(s, /\binterface\s+\w+|:\s*(string|number|boolean)\b/)) sc -= 12;
      if (has(s, /<[A-Z][A-Za-z0-9]*[\s/>]/)) sc -= 12;
      return sc;
    },
  },

  // ── Shell / PowerShell ───────────────────────────────────────────────────
  {
    ext: 'ps1',
    min: 8,
    score: (s) => {
      let sc = 0;
      if (has(s, /\b(Write-Host|Get-\w+|Set-\w+|Param\s*\()/i)) sc += 12;
      sc += countMatches(s, /\$\w+/g);
      if (has(s, /\bfunction\s+\w+/i)) sc += 3;
      return sc;
    },
  },
  {
    ext: 'sh',
    min: 8,
    score: (s) => {
      let sc = 0;
      if (has(s, /^#!.*\b(bash|sh|zsh|fish)\b/m)) sc += 20;
      if (has(s, /^\s*(if|then|fi|elif|case|esac|for|do|done)\b/m)) sc += 6;
      if (has(s, /\$\{?\w+\}?/)) sc += 3;
      if (has(s, /\becho\s+/)) sc += 3;
      if (has(s, /\bWrite-Host\b/i)) sc -= 15;
      return sc;
    },
  },

  // ── Data / config ────────────────────────────────────────────────────────
  {
    ext: 'json',
    min: 10,
    score: (s) => {
      const t = s.trim();
      if ((t[0] !== '{' && t[0] !== '[')) return 0;
      try {
        JSON.parse(t);
        return 25;
      } catch {
        return 0;
      }
    },
  },
  {
    ext: 'yaml',
    min: 8,
    score: (s) => {
      let sc = 0;
      if (has(s, /^---/m)) sc += 8;
      sc += countMatches(s, /^\s*[\w.-]+\s*:\s*.+$/gm);
      if (has(s, /^\s*-\s+\w+/m)) sc += 4;
      if (has(s, /[{};]/) && has(s, /\b(function|class|public)\b/)) sc -= 15;
      return sc;
    },
  },
  {
    ext: 'toml',
    min: 8,
    score: (s) => {
      let sc = 0;
      sc += countMatches(s, /^\s*\[[\w.-]+\]\s*$/gm) * 8;
      sc += countMatches(s, /^\s*[\w.-]+\s*=\s*.+$/gm) * 2;
      return sc;
    },
  },
  {
    ext: 'ini',
    min: 8,
    score: (s) => {
      let sc = 0;
      sc += countMatches(s, /^\s*\[[^\]]+\]\s*$/gm) * 6;
      sc += countMatches(s, /^\s*[\w.-]+\s*=\s*.+$/gm) * 2;
      if (has(s, /^\s*\[[\w.-]+\]\s*$/m) && !has(s, /^\s*\[[\w.-]+\.[^\]]+\]/m)) sc += 2;
      return sc;
    },
  },
  {
    ext: 'proto',
    min: 8,
    score: (s) => {
      let sc = 0;
      if (has(s, /\bsyntax\s*=\s*["']proto/)) sc += 20;
      if (has(s, /\bmessage\s+\w+\s*\{/)) sc += 12;
      if (has(s, /\brpc\s+\w+/)) sc += 10;
      return sc;
    },
  },

  // ── Styles ───────────────────────────────────────────────────────────────
  {
    ext: 'css',
    min: 10,
    score: (s) => {
      // Hard block 1: HTML documents — CSS lives inside HTML but the file IS html.
      if (has(s, /<!DOCTYPE\s+html/i) || has(s, /<html[\s>]/i)) return 0;
      // Hard block 2: programming constructs that CSS must never claim.
      if (has(s, /\b(public|private|protected|package|System\.out|console\.|function|const|let|var|def|fn|func|class\s+\w+\s*\{)/)) {
        // `class Foo {` is Java/C#/etc — not CSS. `.class` or `class=` is fine.
        if (has(s, /\b(public|private|protected)\s+class\b/) || has(s, /\bpackage\s+[\w.]+;/) || has(s, /\bSystem\.out\b/) || has(s, /\bfunction\b|\bconst\b|\blet\b/)) {
          return 0;
        }
      }
      let sc = 0;
      if (has(s, /@(media|keyframes|import|font-face|charset|supports)\b/i)) sc += 15;
      sc += countMatches(s, /(?:^|[{\s;])([a-z-]+)\s*:\s*[^;{}\n]+;/gim) * 3;
      if (has(s, /[.#][a-zA-Z][\w-]*\s*\{/)) sc += 6;
      return sc;
    },
  },
  {
    ext: 'scss',
    min: 10,
    score: (s) => {
      // Hard block: HTML documents.
      if (has(s, /<!DOCTYPE\s+html/i) || has(s, /<html[\s>]/i)) return 0;
      let sc = 0;
      if (has(s, /\$[\w-]+\s*:/)) sc += 10;
      if (has(s, /@(mixin|include|extend|use|forward)\b/)) sc += 12;
      sc += countMatches(s, /(?:^|[{\s;])([a-z-]+)\s*:\s*[^;{}\n]+;/gim) * 2;
      if (has(s, /\b(public\s+class|System\.out|function\b|const\b)/)) return 0;
      return sc;
    },
  },

  // ── Query / docs / misc ──────────────────────────────────────────────────
  {
    ext: 'sql',
    min: 8,
    score: (s) => {
      let sc = 0;
      sc += countMatches(s, /^\s*(SELECT|INSERT|UPDATE|DELETE|CREATE|ALTER|DROP|WITH)\b/gim) * 8;
      if (has(s, /\bFROM\b/i) && has(s, /\bWHERE\b/i)) sc += 6;
      if (has(s, /\bJOIN\b/i)) sc += 4;
      return sc;
    },
  },
  {
    ext: 'md',
    min: 8,
    score: (s) => {
      let sc = 0;
      sc += countMatches(s, /^#{1,6}\s+\S+/gm) * 5;
      sc += countMatches(s, /^\s*[-*+]\s+\S+/gm) * 2;
      if (has(s, /\[.+\]\(.+\)/)) sc += 6;
      if (has(s, /```/)) sc += 6;
      if (has(s, /[{};]/) && has(s, /\b(function|class|public)\b/)) sc -= 20;
      return sc;
    },
  },
  {
    ext: 'dockerfile',
    min: 8,
    score: (s) => {
      let sc = 0;
      if (has(s, /^\s*FROM\s+\S+/im)) sc += 15;
      sc += countMatches(s, /^\s*(RUN|CMD|COPY|ADD|ENV|WORKDIR|EXPOSE|ENTRYPOINT)\b/gim) * 5;
      return sc;
    },
  },
  {
    ext: 'diff',
    min: 8,
    score: (s) => {
      let sc = 0;
      if (has(s, /^diff --git /m) || has(s, /^---\s/m) && has(s, /^\+\+\+\s/m)) sc += 15;
      sc += countMatches(s, /^[+-](?![+-])/gm);
      return sc;
    },
  },
  {
    ext: 'pas',
    min: 8,
    score: (s) => {
      let sc = 0;
      if (has(s, /\bprogram\s+\w+/i)) sc += 12;
      if (has(s, /\bbegin\b/i) && has(s, /\bend\./i)) sc += 10;
      if (has(s, /\b(procedure|function)\s+\w+/i)) sc += 6;
      return sc;
    },
  },
  {
    ext: 'f90',
    min: 8,
    score: (s) => {
      let sc = 0;
      if (has(s, /^\s*program\s+\w+/im)) sc += 12;
      if (has(s, /^\s*(subroutine|function)\s+\w+/im)) sc += 8;
      if (has(s, /^\s*end\s+(program|subroutine|function)\b/im)) sc += 8;
      return sc;
    },
  },
  {
    ext: 'tcl',
    min: 8,
    score: (s) => {
      let sc = 0;
      if (has(s, /\bproc\s+\w+/)) sc += 10;
      if (has(s, /\b(set|puts|expr)\s+/)) sc += 5;
      return sc;
    },
  },
  {
    ext: 'v',
    min: 8,
    score: (s) => {
      let sc = 0;
      if (has(s, /\bmodule\s+\w+/)) sc += 10;
      if (has(s, /\b(always|posedge|negedge|wire|reg)\b/)) sc += 8;
      if (has(s, /\bendmodule\b/)) sc += 10;
      return sc;
    },
  },
  {
    ext: 'vhd',
    min: 8,
    score: (s) => {
      let sc = 0;
      if (has(s, /\bentity\s+\w+/i)) sc += 12;
      if (has(s, /\barchitecture\s+\w+/i)) sc += 12;
      if (has(s, /\bsignal\s+\w+/i)) sc += 6;
      return sc;
    },
  },
  {
    ext: 'asm',
    min: 8,
    score: (s) => {
      let sc = 0;
      if (has(s, /^\s*\.(section|global|data|text)\b/im)) sc += 12;
      sc += countMatches(s, /^\s*(mov|lda|sta|jmp|call|ret|push|pop|add|sub)\b/gim) * 3;
      return sc;
    },
  },
];

export interface DetectionResult {
  /** Winning extension, or null if nothing confident enough. */
  extension: string | null;
  /** Score of the winner. */
  score: number;
  /** All candidates above threshold, sorted desc — useful for debugging. */
  candidates: { ext: string; score: number }[];
}

/**
 * Scan the ENTIRE source and pick the best-matching language extension.
 * This is synchronous and must complete before any rename/save continues.
 */
export function detectExtensionFromContent(content: string): string | null {
  return analyzeSource(content).extension;
}

/** Full analysis of the entire buffer against every supported language. */
export function analyzeSource(content: string): DetectionResult {
  const src = content.replace(/^\uFEFF/, ''); // strip BOM
  if (!src.trim()) {
    return { extension: null, score: 0, candidates: [] };
  }

  // ── Minimum content guard ──────────────────────────────────────────────────
  // Don't rename files that are too short to be confident about.
  // Count non-empty, non-comment, non-whitespace lines.
  const meaningfulLines = src.split('\n').filter(l => {
    const t = l.trim();
    return t.length > 0 && !t.startsWith('//') && !t.startsWith('#') && !t.startsWith('*');
  }).length;

  // Fewer than 3 meaningful lines → not enough signal, never rename.
  if (meaningfulLines < 3) {
    return { extension: null, score: 0, candidates: [] };
  }

  const candidates: { ext: string; score: number }[] = [];

  for (const rule of RULES) {
    const score = rule.score(src);
    if (score >= rule.min) {
      candidates.push({ ext: rule.ext, score });
    }
  }

  candidates.sort((a, b) => b.score - a.score);

  if (candidates.length === 0) {
    return { extension: null, score: 0, candidates };
  }

  // ── Winner must be confident ────────────────────────────────────────────────
  const [best, second] = candidates;

  // Single candidate — still require a minimum absolute score.
  if (!second && best.score < 12) {
    return { extension: null, score: best.score, candidates };
  }

  // Two+ candidates — require clear separation AND a minimum score.
  if (second) {
    // Winner must beat second by at least 4 points (was 2 — too loose).
    if (best.score < second.score + 4) {
      return { extension: null, score: best.score, candidates };
    }
    // Winner must also clear an absolute floor of 12.
    if (best.score < 12) {
      return { extension: null, score: best.score, candidates };
    }
  }

  return { extension: best.ext, score: best.score, candidates };
}

/**
 * Resolve the path that should be written after a full-content language scan.
 * Returns null when the current path should be kept as-is.
 */
export function withDetectedExtension(filePath: string, content: string, analysis?: DetectionResult): string | null {
  const result = analysis ?? analyzeSource(content);
  const ext = result.extension;
  if (!ext) return null;

  const base = filePath.split(/[\\/]/).pop() ?? filePath;
  const dot = base.lastIndexOf('.');
  const currentExt = dot > 0 ? base.slice(dot + 1).toLowerCase() : '';

  if (currentExt === ext) return null;

  if (!needsExtensionDetection(filePath) && !(STRONG_EXTS.has(ext) && WEAK_OR_STYLE_EXTS.has(currentExt))) {
    return null;
  }

  const canOverride =
    !currentExt ||
    currentExt === 'txt' ||
    (STRONG_EXTS.has(ext) && WEAK_OR_STYLE_EXTS.has(currentExt));

  if (!canOverride) return null;

  const stem = currentExt ? base.slice(0, dot) : base;
  if (!stem) return null;

  const dir = filePath.slice(0, filePath.length - base.length);
  return `${dir}${stem}.${ext}`;
}

/** True when save should run full-file extension detection for this path. */
export function needsExtensionDetection(filePath: string): boolean {
  const base = filePath.split(/[\\/]/).pop() ?? filePath;
  const dot = base.lastIndexOf('.');
  const currentExt = dot > 0 ? base.slice(dot + 1).toLowerCase() : '';
  return !currentExt || currentExt === 'txt';
}

/**
 * Async wrapper — full scan completes before caller writes/renames.
 * Detection runs only when the path needs it (no extension / .txt / clear mismatch).
 */
export async function resolvePathAfterDetection(
  filePath: string,
  content: string,
  force = false,
): Promise<{ path: string; renamed: boolean; extension: string | null; analysis: DetectionResult }> {
  const base = filePath.split(/[\\/]/).pop() ?? filePath;
  const dot = base.lastIndexOf('.');
  const currentExt = dot > 0 ? base.slice(dot + 1).toLowerCase() : '';
  const shouldScan = force || needsExtensionDetection(filePath) ||
    (currentExt && WEAK_OR_STYLE_EXTS.has(currentExt));

  if (!shouldScan || !content.trim()) {
    return {
      path: filePath,
      renamed: false,
      extension: null,
      analysis: { extension: null, score: 0, candidates: [] },
    };
  }

  const analysis = analyzeSource(content);
  const renamedPath = withDetectedExtension(filePath, content, analysis);
  if (renamedPath && renamedPath !== filePath) {
    return { path: renamedPath, renamed: true, extension: analysis.extension, analysis };
  }
  return { path: filePath, renamed: false, extension: analysis.extension, analysis };
}

const STRONG_EXTS = new Set([
  'java', 'kt', 'scala', 'groovy', 'cs', 'fs', 'vb',
  'py', 'rb', 'lua', 'pl', 'r', 'jl', 'cr', 'ex', 'erl', 'hs', 'ml', 'clj', 'scm', 'elm', 'coffee',
  'c', 'cpp', 'rs', 'go', 'swift', 'dart',
  'js', 'jsx', 'ts', 'tsx', 'php', 'vue',
  'ps1', 'sh', 'sql', 'pas', 'f90', 'tcl', 'v', 'vhd', 'asm', 'proto', 'dockerfile',
  'html', 'htm',  // HTML is a definitive container format — must override css/scss/txt misdetections
]);

const WEAK_OR_STYLE_EXTS = new Set([
  'css', 'scss', 'sass', 'less', 'txt', 'md', 'xml', 'yaml', 'yml', 'ini', 'cfg',
  // html/htm removed — HTML is strong enough to override weak-ext files, not the other way round
]);
