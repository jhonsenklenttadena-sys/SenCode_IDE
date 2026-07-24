/**
 * deploy-asar.cjs
 *
 * Two-part deploy:
 *
 * 1. app.asar  (virtual, fast)
 *      dist/ + electron/ + package.json
 *      No node_modules — Electron resolves them via app.asar.unpacked.
 *
 * 2. app.asar.unpacked/  (real files, for native modules + their JS deps)
 *      Copied from release/win-unpacked which electron-builder already built.
 *      We also add the JS dependencies of node-llama-cpp so dynamic
 *      import() calls from within app.asar.unpacked can resolve them
 *      without going through the asar virtual filesystem.
 *
 * Run via:  npm run deploy
 */

const { execSync } = require('child_process');
const path = require('path');
const fs   = require('fs');
const os   = require('os');

const ROOT    = path.resolve(__dirname, '..');
const STAGE   = path.join(os.tmpdir(), 'codeforge-asar-stage-' + Date.now());
const OUT     = path.join(os.tmpdir(), 'app.asar');

const DEPLOY_TARGETS = [
  {
    asar    : path.join(ROOT, '..', 'CodeForge', 'resources', 'app.asar'),
    unpacked: path.join(ROOT, '..', 'CodeForge', 'resources', 'app.asar.unpacked'),
  },
  {
    asar    : path.join(ROOT, 'release', 'win-unpacked', 'resources', 'app.asar'),
    unpacked: path.join(ROOT, 'release', 'win-unpacked', 'resources', 'app.asar.unpacked'),
  },
];

// Source for unpacked natives — try release first, fall back to CodeForge folder
let UNPACKED_SRC = path.join(ROOT, 'release', 'win-unpacked', 'resources', 'app.asar.unpacked');
if (!fs.existsSync(UNPACKED_SRC)) {
  const fallback = path.join(ROOT, '..', 'CodeForge', 'resources', 'app.asar.unpacked');
  if (fs.existsSync(fallback)) {
    console.log('Using CodeForge\\resources\\app.asar.unpacked as native source.');
    UNPACKED_SRC = fallback;
  }
}

// node-llama-cpp's runtime JS dependencies that must be on the real filesystem
// because node-llama-cpp loads them via dynamic import() from inside app.asar.unpacked.
const LLAMA_DEPS = [
  '@huggingface/jinja', 'async-retry', 'bytes', 'chalk', 'chmodrp',
  'cross-spawn', 'env-var', 'filenamify', 'fs-extra', 'ignore', 'ipull',
  'is-unicode-supported', 'lifecycle-utils', 'log-symbols', 'nanoid',
  'node-addon-api', 'ora', 'pretty-ms', 'proper-lockfile', 'semver',
  'slice-ansi', 'stdout-update', 'strip-ansi', 'validate-npm-package-name',
  'which', 'yargs',
  // transitive deps commonly needed
  'jsonfile', 'universalify', 'graceful-fs', 'retry', 'ansi-styles',
  'supports-color', 'has-flag', 'cli-cursor', 'cli-spinners',
  'is-fullwidth-code-point', 'restore-cursor', 'onetime', 'mimic-fn',
  'is-interactive', 'isexe', 'yargs-parser', 'require-directory',
  'string-width', 'wrap-ansi', 'get-east-asian-width', 'eastasianwidth',
  'emoji-regex', 'cliui',
];

function copyDir(src, dest) {
  if (!fs.existsSync(src)) return;
  fs.mkdirSync(dest, { recursive: true });
  for (const entry of fs.readdirSync(src, { withFileTypes: true })) {
    const s = path.join(src, entry.name);
    const d = path.join(dest, entry.name);
    if (entry.isDirectory()) copyDir(s, d);
    else fs.copyFileSync(s, d);
  }
}

// ─────────────────────────────────────────────────────────────────────────────

// 1) Stage: only dist + electron + package.json (no node_modules in asar)
console.log('Staging asar contents (dist + electron only)...');
fs.mkdirSync(STAGE, { recursive: true });
copyDir(path.join(ROOT, 'dist'),     path.join(STAGE, 'dist'));
copyDir(path.join(ROOT, 'electron'), path.join(STAGE, 'electron'));
fs.copyFileSync(path.join(ROOT, 'package.json'), path.join(STAGE, 'package.json'));

// 2) Pack
console.log('Packing asar...');
execSync(`npx asar pack "${STAGE}" "${OUT}"`, { stdio: 'inherit', cwd: ROOT });
const asarMB = (fs.statSync(OUT).size / 1024 / 1024).toFixed(1);
console.log(`Packed: ${asarMB} MB`);

// 3) Build the unpacked folder with natives + llama JS deps
console.log('Building app.asar.unpacked...');
const UNPACKED_BUILD = path.join(os.tmpdir(), 'codeforge-unpacked-' + Date.now());

if (!fs.existsSync(UNPACKED_SRC)) {
  console.error('ERROR: release/win-unpacked/resources/app.asar.unpacked not found.');
  console.error('Run "npm run electron:build:nosign" once to generate native binaries, then re-run deploy.');
  process.exit(1);
}

// Copy natives from electron-builder output
copyDir(UNPACKED_SRC, UNPACKED_BUILD);

// Copy node-llama-cpp's nested node_modules (1 MB of JS helpers)
const llamaNestedSrc  = path.join(ROOT, 'node_modules', 'node-llama-cpp', 'node_modules');
const llamaNestedDest = path.join(UNPACKED_BUILD, 'node_modules', 'node-llama-cpp', 'node_modules');
if (fs.existsSync(llamaNestedSrc)) {
  console.log('  Adding node-llama-cpp nested deps...');
  copyDir(llamaNestedSrc, llamaNestedDest);
}

// Copy top-level JS deps that node-llama-cpp imports dynamically
const topNm = path.join(ROOT, 'node_modules');
const destNm = path.join(UNPACKED_BUILD, 'node_modules');
let copied = 0;
for (const dep of LLAMA_DEPS) {
  const src = path.join(topNm, dep);
  if (fs.existsSync(src)) {
    copyDir(src, path.join(destNm, dep));
    copied++;
  }
}
console.log(`  Added ${copied}/${LLAMA_DEPS.length} top-level deps.`);

// 4) Deploy to all targets
for (const target of DEPLOY_TARGETS) {
  const dir = path.dirname(target.asar);
  if (!fs.existsSync(dir)) {
    console.log(`Skipping (not found): ${dir}`);
    continue;
  }
  fs.copyFileSync(OUT, target.asar);
  console.log(`Deployed asar    → ${target.asar}`);

  if (fs.existsSync(target.unpacked)) fs.rmSync(target.unpacked, { recursive: true, force: true });
  copyDir(UNPACKED_BUILD, target.unpacked);
  console.log(`Synced unpacked  → ${target.unpacked}`);
}

// 5) Cleanup
fs.rmSync(STAGE,          { recursive: true, force: true });
fs.rmSync(UNPACKED_BUILD, { recursive: true, force: true });
fs.rmSync(OUT,            { force: true });

console.log('\nDone. Restart SenCode.exe to pick up the changes.');
