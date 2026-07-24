# CodeForge

**A free, offline-first, personal AI coding assistant for student developers.**

CodeForge connects to a locally-hosted LLM (LM Studio, Ollama, or any OpenAI-compatible server) so you get unlimited AI coding help with zero API costs, no token limits, and no internet dependency once a model is downloaded. It works like a lightweight Cursor/Kiro clone — open a project folder, chat with the AI about your codebase, run terminal commands, and get code back as copy-paste snippets or downloadable files.

---

## Quick Start

### 1. Install Node.js

You need Node.js 18 or later. Download it from [nodejs.org](https://nodejs.org/) if you don't have it.

Check your version:
```bash
node --version   # should be v18 or higher
```

### 2. Install & Start LM Studio (or Ollama)

CodeForge needs a local LLM backend running. It auto-detects either of these on startup:

**Option A: LM Studio (recommended for beginners)**

1. Download from [lmstudio.ai](https://lmstudio.ai/)
2. Open LM Studio, go to the **Search** tab, and download a model (see recommendations below)
3. Go to the **Local Server** tab (the `↗` icon on the left sidebar)
4. Load your model and click **Start Server**
5. LM Studio will serve at `http://localhost:1234/v1`

**Option B: Ollama**

1. Download from [ollama.com](https://ollama.com/)
2. In a terminal, pull a model:
   ```bash
   ollama pull qwen2.5-coder:7b
   ```
3. Start the Ollama server (it usually auto-starts):
   ```bash
   ollama serve
   ```
4. Ollama serves at `http://localhost:11434/v1`

### 3. Run CodeForge

```bash
# Install dependencies
npm install

# Start the dev server
npm run dev
```

Then open the URL shown in your terminal (usually `http://localhost:5173`).

**CodeForge will automatically:**
- Detect whether LM Studio or Ollama is running
- Connect to the first available backend
- Select the first loaded model
- Fall back to demo mode (with simulated responses) if no backend is found

You don't need to manually configure anything — just start LM Studio or Ollama before opening CodeForge, and it will auto-connect.

---

## Recommended Models by Hardware

| Model | RAM Needed | Best For |
|-------|-----------|----------|
| Qwen2.5-Coder-7B-Instruct | 8GB+ | Best overall for coding tasks |
| DeepSeek-Coder-V2-Lite-Instruct | 8GB+ | Strong multi-language support |
| CodeLlama-7B-Instruct | 8GB+ | Reliable, well-tested |
| Phi-3.1-mini-128k-Instruct | 6GB+ | Long context, compact size |
| Qwen2.5-Coder-1.5B-Instruct | 4GB+ | Lowest RAM, fastest inference |

**For an 8GB RAM laptop:** Start with Qwen2.5-Coder-7B (Q4_K_M quantization). If it's too slow, drop to the 1.5B variant.

---

## Features

- **Streaming chat** with markdown rendering and syntax-highlighted code blocks
- **Model selector** — switch models mid-session without losing chat history
- **File tree sidebar** with context-selection checkboxes (choose which files the AI sees)
- **Tabbed code editor** with syntax highlighting
- **Integrated terminal** with AI-suggested command styling and safety confirmations
- **Git panel** — status, stage/unstage, commit, push/pull, branch switcher, commit log
- **Slash commands** — `/explain`, `/refactor`, `/test`, `/document`, `/debug`, `/optimize`, `/convert`
- **Code block actions** — Copy, Download, Insert into editor, Apply as diff, Add to project
- **Context-window meter** — see how much of the model's context you've used
- **Sensitive file protection** — `.env`, `*.pem`, credential files are auto-excluded from AI context
- **Settings panel** — backend config, temperature/maxTokens/topP, system prompt presets, theme
- **Demo mode** — full UI exploration without a running backend

---

## Safety Design

CodeForge never silently executes anything:

- AI-suggested terminal commands appear with a **"Suggested by AI" badge** and are never auto-run
- Destructive commands (`rm`, `del`, `format`, `git push --force`, etc.) require confirmation
- Sensitive files are auto-excluded from AI context
- All data stays local — no telemetry, no analytics, no cloud sync

---

## Building for Distribution

```bash
# Build the production bundle
npm run build

# Preview the production build locally
npm run preview
```

The built files will be in the `dist/` directory.

> **Note:** This is the web renderer layer. The full desktop app wraps this in Electron with filesystem, terminal (node-pty), and git (simple-git) access. See the architecture docs in `src/lib/` for the IPC abstraction layer.

---

## Tech Stack

- **React + TypeScript + Vite** — UI framework
- **Tailwind CSS** — styling
- **Lucide React** — icons
- **marked + DOMPurify** — safe markdown rendering
- **LM Studio / Ollama** — local LLM backend (OpenAI-compatible API)

---

## Troubleshooting

**"Demo mode" shows in the status bar**
- Make sure LM Studio's server is running (Local Server tab → Start Server)
- Or make sure Ollama is running (`ollama serve`)
- CodeForge auto-retries for 30 seconds on startup; if you start the backend after opening the app, it will connect on the next poll cycle (within 15 seconds)
- You can also click the refresh icon in the model selector dropdown

**No models appear in the dropdown**
- In LM Studio: make sure a model is loaded in the Local Server tab
- In Ollama: make sure you've pulled a model (`ollama pull <model-name>`)

**Chat responses are simulated / say "Demo mode"**
- This means no backend was detected. The simulated responses let you explore the UI. Start LM Studio or Ollama to get real AI responses.

**Connection works but responses are slow**
- Try a smaller model (see the hardware table above)
- Lower the "Max Tokens" setting in the Settings panel
