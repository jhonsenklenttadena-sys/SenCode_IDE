/**
 * session-store.cjs
 *
 * Manages chat session persistence in the Electron main process.
 *
 * Storage layout (inside app.getPath('userData')):
 *   sessions/
 *     <id>.json        — one file per session, stored compressed (JSON, trimmed)
 *   memory.json        — persistent user profile, survives all session deletes
 *
 * Sessions are small by design:
 *   - Messages are trimmed to MAX_MSG_CHARS before saving
 *   - Only role + content + timestamp stored (no UI flags)
 *   - Pinned sessions are never auto-deleted
 *   - Expired sessions have a summary extracted into memory.json before deletion
 */

'use strict';

const path = require('path');
const fs   = require('fs');

const MAX_MSG_CHARS = 800;   // truncate individual messages when saving
const MAX_MSGS_STORED = 60;  // keep at most this many messages per session on disk

// ── Paths ──────────────────────────────────────────────────────────────────────
function getSessionsDir() {
  const { app } = require('electron');
  const dir = path.join(app.getPath('userData'), 'sessions');
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
  return dir;
}

function getMemoryPath() {
  const { app } = require('electron');
  return path.join(app.getPath('userData'), 'memory.json');
}

// ── Helpers ────────────────────────────────────────────────────────────────────
function trimMessage(msg) {
  return {
    id       : msg.id,
    role     : msg.role,
    content  : msg.content.length > MAX_MSG_CHARS
      ? msg.content.slice(0, MAX_MSG_CHARS) + '…'
      : msg.content,
    timestamp: msg.timestamp,
  };
}

function sessionFilePath(id) {
  return path.join(getSessionsDir(), `${id}.json`);
}

// ── Save session ───────────────────────────────────────────────────────────────
function saveSession(session) {
  const slim = {
    id         : session.id,
    title      : session.title || 'Untitled',
    projectPath: session.projectPath || '',
    modelId    : session.modelId || '',
    pinned     : session.pinned ?? false,
    createdAt  : session.createdAt,
    updatedAt  : Date.now(),
    messages   : session.messages
      .filter((m) => !m.streaming && !m.error)
      .slice(-MAX_MSGS_STORED)
      .map(trimMessage),
  };
  try {
    fs.writeFileSync(sessionFilePath(session.id), JSON.stringify(slim), 'utf8');
    return { ok: true };
  } catch (e) {
    console.error('[session-store] save failed:', e.message);
    return { ok: false, error: e.message };
  }
}

// ── Load all sessions (index only — no messages) ───────────────────────────────
function listSessions() {
  const dir = getSessionsDir();
  try {
    return fs.readdirSync(dir)
      .filter((f) => f.endsWith('.json'))
      .map((f) => {
        try {
          const raw = JSON.parse(fs.readFileSync(path.join(dir, f), 'utf8'));
          return {
            id         : raw.id,
            title      : raw.title,
            projectPath: raw.projectPath,
            modelId    : raw.modelId,
            pinned     : raw.pinned ?? false,
            createdAt  : raw.createdAt,
            updatedAt  : raw.updatedAt,
            messageCount: (raw.messages || []).length,
          };
        } catch { return null; }
      })
      .filter(Boolean)
      .sort((a, b) => b.updatedAt - a.updatedAt);
  } catch (e) {
    return [];
  }
}

// ── Load one full session ──────────────────────────────────────────────────────
function loadSession(id) {
  try {
    const raw = fs.readFileSync(sessionFilePath(id), 'utf8');
    return { ok: true, session: JSON.parse(raw) };
  } catch (e) {
    return { ok: false, error: e.message };
  }
}

// ── Delete one session ─────────────────────────────────────────────────────────
function deleteSession(id) {
  try {
    const filePath = sessionFilePath(id);
    // Extract memory before deleting
    if (fs.existsSync(filePath)) {
      const raw = JSON.parse(fs.readFileSync(filePath, 'utf8'));
      _extractMemoryFromSession(raw);
      fs.unlinkSync(filePath);
    }
    return { ok: true };
  } catch (e) {
    return { ok: false, error: e.message };
  }
}

// ── Pin / unpin ────────────────────────────────────────────────────────────────
function pinSession(id, pinned) {
  try {
    const filePath = sessionFilePath(id);
    if (!fs.existsSync(filePath)) return { ok: false, error: 'Session not found' };
    const raw = JSON.parse(fs.readFileSync(filePath, 'utf8'));
    raw.pinned = pinned;
    fs.writeFileSync(filePath, JSON.stringify(raw), 'utf8');
    return { ok: true };
  } catch (e) {
    return { ok: false, error: e.message };
  }
}

// ── Auto-delete expired sessions ───────────────────────────────────────────────
/**
 * Deletes sessions older than `retainDays` days, unless pinned.
 * Extracts memory from each before deleting.
 * Returns how many were deleted.
 */
function runCleanup(retainDays) {
  const days  = Math.max(1, retainDays ?? 15);
  const cutoff = Date.now() - days * 24 * 60 * 60 * 1000;
  const dir   = getSessionsDir();
  let deleted = 0;

  try {
    const files = fs.readdirSync(dir).filter((f) => f.endsWith('.json'));
    for (const f of files) {
      const filePath = path.join(dir, f);
      try {
        const raw = JSON.parse(fs.readFileSync(filePath, 'utf8'));
        if (!raw.pinned && raw.updatedAt < cutoff) {
          _extractMemoryFromSession(raw);
          fs.unlinkSync(filePath);
          deleted++;
          console.log(`[session-store] Deleted expired session: ${raw.id} (${raw.title})`);
        }
      } catch { /* skip malformed files */ }
    }
  } catch (e) {
    console.error('[session-store] cleanup error:', e.message);
  }

  if (deleted > 0) console.log(`[session-store] Cleanup: deleted ${deleted} expired sessions.`);
  return deleted;
}

// ── Memory profile ─────────────────────────────────────────────────────────────
function loadMemory() {
  try {
    const p = getMemoryPath();
    if (!fs.existsSync(p)) return _emptyMemory();
    return JSON.parse(fs.readFileSync(p, 'utf8'));
  } catch { return _emptyMemory(); }
}

function saveMemory(mem) {
  try {
    fs.writeFileSync(getMemoryPath(), JSON.stringify(mem, null, 2), 'utf8');
  } catch (e) {
    console.error('[session-store] memory save failed:', e.message);
  }
}

function _emptyMemory() {
  return {
    version      : 1,
    totalSessions: 0,
    languages    : {},   // { python: 12, javascript: 8 }
    topics       : {},   // { debugging: 5, refactoring: 3 }
    preferShort  : false,
    lastActive   : null,
    projects     : [],   // recent project folder names
    notes        : '',   // freeform summary string injected into system prompt
  };
}

/**
 * Heuristic analysis of a session — extract signals about user preferences
 * and merge them into the persistent memory profile. No LLM call needed.
 */
function _extractMemoryFromSession(session) {
  if (!session || !session.messages || session.messages.length < 2) return;

  const mem = loadMemory();
  mem.totalSessions = (mem.totalSessions || 0) + 1;
  mem.lastActive = session.updatedAt || Date.now();

  // Track project folders used
  if (session.projectPath) {
    const folderName = session.projectPath.split(/[\\/]/).pop();
    if (folderName && !mem.projects.includes(folderName)) {
      mem.projects.unshift(folderName);
      mem.projects = mem.projects.slice(0, 10); // keep last 10
    }
  }

  const userMessages = session.messages
    .filter((m) => m.role === 'user')
    .map((m) => m.content.toLowerCase());

  // Detect programming languages mentioned
  const LANG_PATTERNS = [
    ['python', /\bpython\b|\.py\b|def |import |print\(/],
    ['javascript', /\bjavascript\b|\bjs\b|\.js\b|const |let |=>|console\./],
    ['typescript', /\btypescript\b|\bts\b|\.tsx?\b|interface |type |: string/],
    ['react', /\breact\b|\.tsx\b|jsx|useState|useEffect/],
    ['html', /\bhtml\b|<div|<span|<p>/],
    ['css', /\bcss\b|\.css\b|margin:|padding:|color:/],
    ['java', /\bjava\b|\.java\b|public class|System\.out/],
    ['sql', /\bsql\b|\bselect\b|\binsert\b|\btable\b/],
    ['bash', /\bbash\b|\.sh\b|npm |git |cd |ls /],
  ];
  for (const [lang, pattern] of LANG_PATTERNS) {
    const hits = userMessages.filter((m) => pattern.test(m)).length;
    if (hits > 0) mem.languages[lang] = (mem.languages[lang] || 0) + hits;
  }

  // Detect topic patterns
  const TOPIC_PATTERNS = [
    ['debugging',    /\berror\b|\bbug\b|\bfix\b|\bdebug\b|\bcrash\b|\bfailed\b/],
    ['refactoring',  /\brefactor\b|\bclean\b|\bimprove\b|\boptimize\b/],
    ['explanation',  /\bwhat is\b|\bexplain\b|\bhow does\b|\bwhy does\b/],
    ['code_writing', /\bwrite\b|\bcreate\b|\bgenerate\b|\bbuild\b|\bmake\b/],
    ['testing',      /\btest\b|\bunit test\b|\bspec\b/],
  ];
  for (const [topic, pattern] of TOPIC_PATTERNS) {
    const hits = userMessages.filter((m) => pattern.test(m)).length;
    if (hits > 0) mem.topics[topic] = (mem.topics[topic] || 0) + hits;
  }

  // Detect if user prefers short answers (asked for brevity)
  const wantsShort = userMessages.some((m) =>
    /\bshort\b|\bbrief\b|\bconcise\b|\bquick\b|\bjust tell me\b|\bsimple\b/.test(m),
  );
  if (wantsShort) mem.preferShort = true;

  // Build a natural-language notes string from the profile
  mem.notes = _buildMemoryNotes(mem);

  saveMemory(mem);
  console.log(`[session-store] Memory updated from session "${session.title}"`);
}

function _buildMemoryNotes(mem) {
  const lines = [];

  if (mem.totalSessions > 0) {
    lines.push(`This user has had ${mem.totalSessions} past session(s) with SenCode.`);
  }

  // Top languages
  const topLangs = Object.entries(mem.languages)
    .sort((a, b) => b[1] - a[1])
    .slice(0, 3)
    .map(([l]) => l);
  if (topLangs.length > 0) {
    lines.push(`They most frequently work with: ${topLangs.join(', ')}.`);
  }

  // Top topics
  const topTopics = Object.entries(mem.topics)
    .sort((a, b) => b[1] - a[1])
    .slice(0, 2)
    .map(([t]) => t.replace('_', ' '));
  if (topTopics.length > 0) {
    lines.push(`Their most common requests are: ${topTopics.join(' and ')}.`);
  }

  if (mem.preferShort) {
    lines.push('They prefer concise, direct answers.');
  }

  if (mem.projects.length > 0) {
    lines.push(`Recent projects: ${mem.projects.slice(0, 3).join(', ')}.`);
  }

  return lines.join(' ');
}

module.exports = {
  saveSession,
  listSessions,
  loadSession,
  deleteSession,
  pinSession,
  runCleanup,
  loadMemory,
  saveMemory,
};
