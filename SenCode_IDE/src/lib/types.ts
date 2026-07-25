/**
 * Core type definitions for CodeForge.
 * These mirror the data shapes that cross the Electron IPC bridge in the
 * desktop build. In this web renderer we use them directly in the service layer.
 */

export type Role = 'system' | 'user' | 'assistant';

/**
 * launcher  — the initial pick screen shown on fresh run. Two clickable panels
 *             let the user choose a mode, or a file/folder drop auto-routes.
 * programming — the full IDE (file tree | editor | chat) — original interface.
 * chat       — plain conversational view; auto-pops to programming when real
 *              file/folder access is needed.
 */
export type AppMode = 'launcher' | 'programming' | 'chat';

export interface ChatMessage {
  id: string;
  role: Role;
  content: string;
  timestamp: number;
  /** Base64 data URLs of images pasted with this message. */
  images?: string[];
  /** True while an assistant message is still streaming. */
  streaming?: boolean;
  /** Non-null when this message carries an error instead of content. */
  error?: string | null;
}

export interface ModelInfo {
  id: string;
  /** Human-friendly label shown in the dropdown. */
  name?: string;
  /** Human-readable size string e.g. "4.3 GB". */
  size?: string;
  /** Raw size in bytes — used for hardware suitability checks. */
  sizeBytes?: number;
  /** True when hardware detection flagged this model as risky for this device. */
  warning?: boolean;
  /** True when hardware detection blocked this model entirely for this device. */
  blocked?: boolean;
  /** Human-readable reason for warning/block. */
  warningReason?: string;
  /** True when hardware detection selected this as the best model for this device. */
  recommended?: boolean;
}

export type AppTheme = 'midnight' | 'ocean' | 'forest' | 'ember' | 'arctic';

export type HardwareTier = 'low' | 'mid' | 'high' | 'ultra';

export interface GpuInfo {
  model: string;
  vramGB: number;
  vendor: string;
  isNvidia: boolean;
  isAmd: boolean;
  isIntel: boolean;
}

export interface HardwareInfo {
  ramGB: number;
  cpuModel: string;
  cpuCores: number;
  gpus: GpuInfo[];
  discreteGpu: GpuInfo | null;
  tier: HardwareTier;
  tierLabel: string;
  maxModelSizeGB: number;
  contextSize: number;
  recommendedSuggestion: string;
  downloadSuggestions: string[];
}

export type BackendType = 'lmstudio' | 'ollama' | 'custom' | 'local';

export interface BackendConfig {
  type: BackendType;
  baseUrl: string;
  apiKey?: string;
}

export interface ConnectionStatus {
  connected: boolean;
  backend: BackendType;
  baseUrl: string;
  models: ModelInfo[];
  error?: string;
}

export interface FileNode {
  name: string;
  path: string;
  type: 'file' | 'directory';
  children?: FileNode[];
  /** True when the file is selected into the active chat context. */
  inContext?: boolean;
  /** File size in bytes (files only). */
  size?: number;
  language?: string;
}

export interface EditorTab {
  id: string;
  name: string;
  path: string;
  language: string;
  content: string;
  dirty?: boolean;
  /** When true, save runs a full-file language scan and may add/fix the extension. */
  detectExtensionOnSave?: boolean;
}

export interface GeneratedFile {
  id: string;
  name: string;
  language: string;
  content: string;
  path?: string;
  timestamp: number;
}

export interface ChatSession {
  id: string;
  projectPath: string;
  title: string;
  messages: ChatMessage[];
  createdAt: number;
  updatedAt: number;
  modelId?: string;
  pinned?: boolean;
}

export interface SessionIndex {
  id: string;
  title: string;
  projectPath: string;
  modelId: string;
  pinned: boolean;
  createdAt: number;
  updatedAt: number;
  messageCount: number;
}

export interface UserMemory {
  version: number;
  totalSessions: number;
  languages: Record<string, number>;
  topics: Record<string, number>;
  preferShort: boolean;
  lastActive: number | null;
  projects: string[];
  notes: string;
}

export interface Settings {
  backend: BackendConfig;
  defaultModelId: string;
  temperature: number;
  maxTokens: number;
  topP: number;
  /**
   * The sole system prompt for SenCode ("Default Assistant"). Editable
   * here for now during development/testing.
   *
   * TODO(deploy-lock): at deploy time this should become non-editable and
   * non-copyable in the shipped build (e.g. gated behind an
   * `IS_DEPLOY_BUILD` flag that disables this field and, ideally, keeps
   * the prompt text out of the renderer entirely — composed in the
   * Electron main process instead — so it can't be read via devtools
   * either). Not implemented yet; flagging for a follow-up pass.
   */
  basePrompt: string;
  /**
   * User-facing customization field. Appended after basePrompt — this is
   * the one field end users are meant to edit post-deploy-lock.
   */
  customInstructions: string;
  theme: AppTheme;
  fontSize: number;
  fontFamily: string;
  autoSaveHistory: boolean;
  retainDays: number;        // auto-delete sessions older than this (default 15)
}

/** A single token-chunk arriving from the streaming endpoint. */
export interface StreamChunk {
  delta: string;
  done: boolean;
}

/** Language tag -> file extension map for download buttons. */
export const LANG_EXT: Record<string, string> = {
  javascript: 'js', js: 'js', jsx: 'jsx',
  typescript: 'ts', ts: 'ts', tsx: 'tsx',
  python: 'py', py: 'py',
  java: 'java',
  c: 'c', cpp: 'cpp', csharp: 'cs', cs: 'cs',
  go: 'go',
  rust: 'rs', rs: 'rs',
  html: 'html', css: 'css', scss: 'scss',
  json: 'json', yaml: 'yaml', yml: 'yml',
  markdown: 'md', md: 'md',
  sql: 'sql', bash: 'sh', sh: 'sh', shell: 'sh',
  xml: 'xml', toml: 'toml',
  php: 'php', ruby: 'rb', rb: 'rb',
  kotlin: 'kt', swift: 'swift',
  dart: 'dart', lua: 'lua', r: 'r',
  plaintext: 'txt', text: 'txt',
};

/** Detect a language label from a filename. */
export function detectLanguage(filename: string): string {
  const ext = filename.split('.').pop()?.toLowerCase() ?? '';
  const map: Record<string, string> = {
    js: 'javascript', jsx: 'jsx', mjs: 'javascript', cjs: 'javascript',
    ts: 'typescript', tsx: 'tsx',
    py: 'python', pyw: 'python',
    java: 'java',
    c: 'c', cpp: 'cpp', cxx: 'cpp', cc: 'cpp', h: 'c', hpp: 'cpp',
    cs: 'csharp',
    go: 'go',
    rs: 'rust',
    rb: 'ruby',
    html: 'html', htm: 'html', xhtml: 'xhtml',
    css: 'css', scss: 'scss', sass: 'sass',
    json: 'json', jsonc: 'jsonc',
    yaml: 'yaml', yml: 'yaml',
    md: 'markdown', mdx: 'markdown',
    sql: 'sql',
    sh: 'bash', bash: 'bash', zsh: 'bash', fish: 'bash',
    xml: 'xml', svg: 'xml', xsl: 'xml',
    toml: 'toml',
    php: 'php',
    kt: 'kotlin', kts: 'kotlin',
    swift: 'swift',
    dart: 'dart',
    lua: 'lua',
    r: 'r',
    pl: 'perl', pm: 'perl',
    hs: 'haskell', lhs: 'haskell',
    ex: 'elixir', exs: 'elixir',
    erl: 'erlang', hrl: 'erlang',
    scala: 'scala', sc: 'scala',
    groovy: 'groovy', gradle: 'groovy',
    ps1: 'powershell', psm1: 'powershell', psd1: 'powershell',
    vb: 'vb', vbs: 'vb',
    coffee: 'coffeescript',
    clj: 'clojure', cljs: 'clojure', cljc: 'clojure',
    elm: 'elm',
    cr: 'crystal',
    jl: 'julia',
    f90: 'fortran', f95: 'fortran', f: 'fortran', for: 'fortran',
    pas: 'pascal', pp: 'pascal',
    tcl: 'tcl',
    v: 'verilog', sv: 'verilog', svh: 'verilog',
    vhd: 'vhdl', vhdl: 'vhdl',
    s: 'asm', asm: 'asm',
    scm: 'scheme',
    ml: 'ocaml', mli: 'ocaml',
    fs: 'fsharp', fsx: 'fsharp', fsi: 'fsharp',
    proto: 'protobuf',
    dockerfile: 'dockerfile',
    diff: 'diff', patch: 'diff',
    vue: 'vue',
    ini: 'properties', cfg: 'properties',
    txt: 'plaintext', text: 'plaintext',
  };
  return map[ext] ?? 'plaintext';
}
