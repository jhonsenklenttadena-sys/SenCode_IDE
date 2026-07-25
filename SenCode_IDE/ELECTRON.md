# Electron desktop wrapper

This adds a real Electron shell around the existing Vite/React app, whose
main process auto-starts the local LLM server (LM Studio, or Ollama as a
fallback) when you launch CodeForge — so you don't have to open LM Studio
by hand every time.

## What was added

- `electron/main.cjs` — creates the app window, and on launch calls
  `ensureBackend()` to detect/start the local LLM server.
- `electron/preload.cjs` — exposes a small, safe `window.electronAPI` to the
  renderer (contextIsolation on, no direct Node access from the page).
- `electron/backend-launcher.cjs` — the actual detect-then-spawn logic
  (see "How auto-start works" below).
- `src/lib/electronBridge.ts` — typed wrapper the React app uses; it's a
  no-op when running in a plain browser, so `npm run dev` is unaffected.
- A status banner under the top bar (Electron only) showing
  "Checking…" / "Starting LM Studio server…" / a Retry button on failure.

## Running it

```bash
npm install

# Development: Vite dev server + Electron window pointed at it, with hot reload
npm run electron:dev

# Or just preview a production build in the Electron shell
npm run electron:preview

# Package an installer (AppImage / dmg / nsis depending on OS) into ./release
npm run electron:build
```

Plain `npm run dev` still works exactly as before (browser only, no auto-start).

## How auto-start works

On launch, the main process:

1. Checks `http://localhost:1234/v1/models` (LM Studio) and
   `http://localhost:11434/v1/models` (Ollama). If either already responds,
   it's done — nothing else happens.
2. If neither is up, it runs `lms server start` (LM Studio's own CLI),
   trying a few common install locations if `lms` isn't on your `PATH`.
3. It polls port 1234 for up to ~25s while the server (and model) load.
4. If LM Studio's CLI isn't found or doesn't come up, it falls back to
   `ollama serve` and polls port 11434 the same way.
5. Progress is streamed to the UI (`Checking…` → `Starting…` → connected),
   and a `Retry` button appears if nothing could be started.

The spawned process is **detached and left running** on purpose — closing
CodeForge won't kill your LM Studio/Ollama server, so the next launch is
instant instead of reloading the model from scratch. If you'd rather it be
tied to the app's lifetime, that's a one-line change in
`electron/main.cjs` (kill the child on `window-all-closed`).

## Requirements for auto-start to actually work

- LM Studio installed, with its CLI bootstrapped (LM Studio → Settings →
  "Enable CLI", or run `lms bootstrap` once) so `lms` is on your `PATH` —
  otherwise the fallback path guesses only the default install location.
- At least one model already downloaded in LM Studio (auto-start launches
  the *server*; you still pick/load a model the first time).
- If you use Ollama instead, just have `ollama` on your `PATH`.

If neither is installed at all, the banner's Retry button won't help by
itself — you'll need to install one of them first.

## What's still not wired up

This pass only covers "launch app → local server also starts." The
filesystem/terminal-PTY/git IPC bridges from the original spec (real file
open/save dialogs, a real terminal, real git operations) aren't implemented
yet — those panels still work the same way they did in the web build. Happy
to do that next if you want the full desktop feature set.
