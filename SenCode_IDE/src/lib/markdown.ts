/**
 * Markdown rendering with sanitization.
 * AI output is untrusted input rendered as HTML, so DOMPurify is
 * non-negotiable (§4). We also extract fenced code blocks so the React layer
 * can attach Copy/Download/Insert action buttons to each one.
 */

import { marked } from 'marked';
import DOMPurify from 'dompurify';

export interface ParsedBlock {
  type: 'code' | 'markdown' | 'write-files' | 'write-files-error';
  content: string;
  language?: string;
  filename?: string;
  /** Populated when type === 'write-files' */
  files?: { path: string; content: string }[];
  /** Populated when type === 'write-files-error' — human-readable reason */
  error?: string;
}

/**
 * True if a parsed JSON value has the *shape* of a file-write payload
 * (single object or array of objects with a "content" string field),
 * regardless of whether it's correctly labeled/complete. Used to catch
 * cases where the model emits write-intent JSON under the wrong fence
 * language (e.g. ```html) or without a "path" — so it's never silently
 * treated as literal insertable/saveable file content.
 */
function looksLikeFileWriteShape(value: unknown): boolean {
  const isCandidate = (o: unknown): boolean =>
    typeof o === 'object' && o !== null && !Array.isArray(o) && typeof (o as Record<string, unknown>).content === 'string';
  if (Array.isArray(value)) return value.length > 0 && value.every(isCandidate);
  return isCandidate(value);
}

/** Validates a file-write shape has everything needed to actually write; returns missing-field errors. */
function validateFileWriteItems(value: unknown): { files: { path: string; content: string }[] } | { error: string } {
  const items = Array.isArray(value) ? value : [value];
  const missing: string[] = [];
  const files: { path: string; content: string }[] = [];
  items.forEach((item, i) => {
    const o = item as Record<string, unknown>;
    const hasPath = typeof o.path === 'string' && o.path.trim().length > 0;
    const hasContent = typeof o.content === 'string';
    if (!hasPath) missing.push(`item ${i + 1}: missing "path"`);
    if (!hasContent) missing.push(`item ${i + 1}: missing "content"`);
    if (hasPath && hasContent) files.push({ path: o.path as string, content: o.content as string });
  });
  if (missing.length > 0) {
    return { error: `The AI attempted to write file(s) but the block was incomplete (${missing.join(', ')}). Nothing was saved — ask it to resend the file.` };
  }
  return { files };
}

/**
 * Parse a message into alternating markdown / code blocks.
 * Fences may optionally carry a filename after the language, e.g.
 * ```tsx:src/App.tsx — this is how the assistant marks "this is a real
 * project file to create/edit" vs. a plain read-only snippet. The system
 * prompt in Chat mode instructs the model to use this convention.
 */
export function parseBlocks(md: string): ParsedBlock[] {
  const blocks: ParsedBlock[] = [];
  const fence = /```([\w+-]*)(?::([^\s`\n]+))?\n([\s\S]*?)```/g;
  let last = 0;
  let m: RegExpExecArray | null;

  while ((m = fence.exec(md)) !== null) {
    if (m.index > last) {
      blocks.push({ type: 'markdown', content: md.slice(last, m.index) });
    }

    const lang = m[1] || 'plaintext';
    const content = m[3];

    // Special write-files block — auto-executed by MessageBubble
    if (lang === 'write-files') {
      try {
        const parsed = JSON.parse(content);
        const result = validateFileWriteItems(parsed);
        if ('error' in result) {
          blocks.push({ type: 'write-files-error', content, error: result.error });
        } else {
          blocks.push({ type: 'write-files', content, files: result.files });
        }
      } catch {
        blocks.push({ type: 'write-files-error', content, error: 'The AI attempted to write file(s) but the block was not valid JSON. Nothing was saved — ask it to resend the file.' });
      }
    } else if ((content.trimStart().startsWith('{') || content.trimStart().startsWith('[')) && (() => {
      try { return looksLikeFileWriteShape(JSON.parse(content)); } catch { return false; }
    })()) {
      // Caught a write-intent JSON payload under the wrong fence language
      // (e.g. the model used ```html instead of ```write-files) — never
      // let this fall through to a plain/insertable code block.
      const parsed = JSON.parse(content);
      const result = validateFileWriteItems(parsed);
      if ('error' in result) {
        blocks.push({ type: 'write-files-error', content, error: result.error });
      } else {
        blocks.push({ type: 'write-files', content, files: result.files });
      }
    } else {
      blocks.push({
        type: 'code',
        language: lang,
        filename: m[2] || undefined,
        content,
      });
    }

    last = m.index + m[0].length;
  }
  if (last < md.length) {
    blocks.push({ type: 'markdown', content: md.slice(last) });
  }
  return blocks;
}

/** Render a markdown fragment to sanitized HTML. */
export function renderMarkdown(md: string): string {
  const raw = marked.parse(md, { breaks: true, gfm: true }) as string;
  return DOMPurify.sanitize(raw, {
    ALLOWED_TAGS: [
      'p', 'br', 'strong', 'em', 'code', 'pre', 'ul', 'ol', 'li',
      'h1', 'h2', 'h3', 'h4', 'h5', 'h6', 'blockquote', 'a',
      'table', 'thead', 'tbody', 'tr', 'th', 'td', 'hr', 'span',
      'del', 'ins', 'sub', 'sup',
    ],
    ALLOWED_ATTR: ['href', 'title', 'class'],
  });
}
