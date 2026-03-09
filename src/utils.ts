import { randomUUID } from "node:crypto";

/**
 * Generate a short unique ID (first 12 characters of a UUID v4, without hyphens).
 */
export function generateId(): string {
  return randomUUID().replace(/-/g, '').slice(0, 12);
}

// ── Entity extraction ──────────────────────────────────────────────

const KNOWN_ENTITIES = [
  "openclaw", "obsidian",
];

const KNOWN_ENTITY_SET = new Set(KNOWN_ENTITIES.map((e) => e.toLowerCase()));

/**
 * Korean subject/object particle suffixes used to detect proper nouns.
 * A word immediately preceding one of these particles is likely a noun/entity.
 */
// Use space/punctuation/start-of-string as boundary instead of \b (which doesn't work with Korean)
const KOREAN_PARTICLE_RE =
  /(?:^|[\s,;:.()\[\]{}<>\/\\|!?'"]+)([가-힣a-zA-Z0-9_-]{2,})(?:은|는|이|가|을|를|에|에서|로|으로|의|와|과|도)(?=[\s,;:.()\[\]{}<>\/\\|!?'"]+|$)/g;

const CAMEL_CASE_RE = /\b([A-Z][a-z]+(?:[A-Z][a-z]+)+)\b/g;
const AT_MENTION_RE = /@([a-zA-Z0-9_-]+)/g;
const QUOTED_STRING_RE = /[""\u201C]([^""\u201D]{2,})[""\u201D]|"([^"]{2,})"/g;
const IP_ADDRESS_RE = /\b(\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3})\b/g;
const DEVICE_NAME_RE = /\b[a-z]+-(?:server|node|host)\d+\b/gi;

/**
 * Extract potential entity names from text.
 *
 * Looks for:
 * - @mentions
 * - Quoted strings
 * - CamelCase words
 * - Korean proper nouns (words followed by particles like 은/는/이/가/을/를/에/에서/로)
 * - Known entity names from KNOWN_ENTITIES list
 */
export function extractEntities(text: string): string[] {
  const entities = new Set<string>();

  // @mentions
  for (const m of text.matchAll(AT_MENTION_RE)) {
    entities.add(m[1]);
  }

  // Quoted strings
  for (const m of text.matchAll(QUOTED_STRING_RE)) {
    const val = (m[1] ?? m[2]).trim();
    if (val.length >= 2) entities.add(val);
  }

  // CamelCase words
  for (const m of text.matchAll(CAMEL_CASE_RE)) {
    entities.add(m[1]);
  }

  // Korean particles — word before a particle is likely an entity
  for (const m of text.matchAll(KOREAN_PARTICLE_RE)) {
    const candidate = m[1];
    // Only include if it looks meaningful (not a pure Korean grammar word)
    if (candidate.length >= 2) {
      entities.add(candidate);
    }
  }

  // IP addresses
  for (const m of text.matchAll(IP_ADDRESS_RE)) {
    entities.add(m[1]);
  }

  // Device name patterns (e.g. dev-server1, prod-node2)
  for (const m of text.matchAll(DEVICE_NAME_RE)) {
    entities.add(m[0].toLowerCase());
  }

  // Known entities — scan text (case-insensitive)
  const lower = text.toLowerCase();
  for (const known of KNOWN_ENTITIES) {
    if (lower.includes(known.toLowerCase())) {
      entities.add(known);
    }
  }

  return [...entities];
}

// ── Tag extraction ─────────────────────────────────────────────────

const HASHTAG_RE = /#([a-zA-Z0-9가-힣_-]+)/g;

const TECH_KEYWORDS = new Set([
  "ssh", "docker", "network", "setup", "config", "deploy",
  "kubernetes", "k8s", "nginx", "gpu", "cuda", "mlx",
  "pytorch", "tensorflow", "vllm", "api", "benchmark",
  "performance", "debug", "error", "fix", "migration",
  "backup", "restore", "build", "ci", "cd", "pipeline",
  "vpn", "firewall", "dns", "proxy",
  "thunderbolt", "ethernet", "wifi",
  "ollama", "llm", "inference", "model", "training",
  "obsidian", "vault", "markdown", "plugin",
]);

/**
 * Extract tags from text.
 *
 * Looks for:
 * - #hashtags
 * - Common technical keywords
 */
export function extractTags(text: string): string[] {
  const tags = new Set<string>();

  // #hashtags
  for (const m of text.matchAll(HASHTAG_RE)) {
    tags.add(m[1].toLowerCase());
  }

  // Technical keywords present in the text
  const lower = text.toLowerCase();
  const words = lower.split(/[\s,;:.()\[\]{}<>\/\\|!?'"]+/);
  for (const w of words) {
    if (TECH_KEYWORDS.has(w)) {
      tags.add(w);
    }
  }

  return [...tags];
}

// ── Keyword extraction ─────────────────────────────────────────────

const STOP_WORDS = new Set([
  // Korean
  "이", "그", "저", "것", "수", "및", "등", "를", "을", "의", "에",
  "가", "는", "은", "로", "와", "과", "도", "만", "에서", "까지",
  "부터", "보다", "처럼", "같이", "대로", "밖에", "하고", "이나",
  "거나", "든지", "라도", "라서", "지만", "면서", "으로", "에게",
  "한테", "더", "안", "못", "잘", "다", "고", "게", "지",
  // English
  "a", "an", "the", "is", "are", "was", "were", "be", "been", "being",
  "have", "has", "had", "do", "does", "did", "will", "would", "could",
  "should", "may", "might", "can", "shall", "must", "need",
  "i", "you", "he", "she", "it", "we", "they", "me", "him", "her",
  "us", "them", "my", "your", "his", "its", "our", "their",
  "this", "that", "these", "those", "what", "which", "who", "whom",
  "how", "when", "where", "why",
  "in", "on", "at", "to", "for", "with", "by", "from", "of", "about",
  "into", "through", "during", "before", "after", "above", "below",
  "between", "under", "over",
  "and", "or", "but", "not", "no", "nor", "so", "if", "then", "than",
  "too", "very", "just", "also", "only",
]);

/**
 * Split text into meaningful keywords (>2 chars, not stop words).
 * Returns unique keywords.
 */
export function extractKeywords(text: string): string[] {
  const keywords = new Set<string>();
  // Split on whitespace and common punctuation
  const tokens = text.toLowerCase().split(/[\s,;:.()\[\]{}<>\/\\|!?'"#@`~=+*&^%$]+/);

  for (const token of tokens) {
    const cleaned = token.replace(/^[-_]+|[-_]+$/g, "");
    if (cleaned.length > 2 && !STOP_WORDS.has(cleaned)) {
      keywords.add(cleaned);
    }
  }

  return [...keywords];
}

// ── Timestamp utilities ────────────────────────────────────────────

/**
 * Format a date as ISO 8601 with timezone offset.
 * If no date provided, uses current time.
 */
export function formatTimestamp(date?: Date | number): string {
  const d = date === undefined
    ? new Date()
    : typeof date === "number"
      ? new Date(date)
      : date;
  return d.toISOString();
}

/**
 * Parse an ISO 8601 timestamp string into a Date object.
 */
export function parseTimestamp(iso: string): Date {
  return new Date(iso);
}

// ── Token truncation ───────────────────────────────────────────────

/**
 * Detect if a character is a CJK (Chinese/Japanese/Korean) character.
 */
function isCJK(char: string): boolean {
  const code = char.codePointAt(0);
  if (code === undefined) return false;
  // CJK Unified Ideographs, Hangul Syllables, Katakana, Hiragana, etc.
  return (
    (code >= 0x3000 && code <= 0x9fff) ||
    (code >= 0xac00 && code <= 0xd7af) || // Hangul Syllables
    (code >= 0xf900 && code <= 0xfaff) ||
    (code >= 0x1100 && code <= 0x11ff) || // Hangul Jamo
    (code >= 0x3130 && code <= 0x318f)    // Hangul Compatibility Jamo
  );
}

/**
 * Rough token estimation and truncation.
 *
 * Heuristic: 1 token ≈ 4 chars for English, ≈ 2 chars for Korean/CJK.
 * Truncates text to fit within maxTokens.
 */
export function truncateTokens(text: string, maxTokens: number): string {
  // Estimate tokens consumed so far as we walk the string
  let tokens = 0;
  let cutIndex = text.length;

  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (isCJK(ch)) {
      tokens += 0.5; // 1 char ≈ 0.5 tokens → 2 chars per token
    } else {
      tokens += 0.25; // 1 char ≈ 0.25 tokens → 4 chars per token
    }

    if (tokens >= maxTokens) {
      cutIndex = i + 1;
      break;
    }
  }

  if (cutIndex < text.length) {
    return text.slice(0, cutIndex);
  }

  return text;
}
