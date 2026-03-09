// ── Note types + frontmatter parsing/serialization ──────────────────

import { randomUUID } from "node:crypto";

// ── Type definitions ────────────────────────────────────────────────

export type NoteType = "event" | "fact" | "preference" | "decision" | "entity" | "insight";
export type NoteTier = "hot" | "warm" | "cold";
export type NoteAccess = "public" | "owner-only";

export type NoteFrontmatter = {
  id: string;
  type: NoteType;
  tier: NoteTier;
  created: string;         // ISO 8601
  last_accessed: string;   // ISO 8601
  access_count: number;
  source_session: string;
  entities: string[];
  tags: string[];
  access: NoteAccess;
};

export type Note = {
  frontmatter: NoteFrontmatter;
  title: string;    // first # heading
  body: string;     // rest of content
  filePath?: string;
};

// ── Valid value sets ────────────────────────────────────────────────

const VALID_NOTE_TYPES = new Set<NoteType>(["event", "fact", "preference", "decision", "entity", "insight"]);
const VALID_TIERS = new Set<NoteTier>(["hot", "warm", "cold"]);
const VALID_ACCESS = new Set<NoteAccess>(["public", "owner-only"]);

// ── Minimal YAML helpers (no external deps) ─────────────────────────

/**
 * Parse a YAML inline array like `[item1, item2, "item 3"]` into a
 * string[].  Also handles the empty array `[]`.
 */
function parseYamlArray(raw: string): string[] {
  const trimmed = raw.trim();
  if (trimmed === "[]") return [];
  if (trimmed.startsWith("[") && trimmed.endsWith("]")) {
    const inner = trimmed.slice(1, -1);
    if (inner.trim() === "") return [];
    return inner.split(",").map((s) => {
      let v = s.trim();
      // strip surrounding quotes
      if ((v.startsWith('"') && v.endsWith('"')) || (v.startsWith("'") && v.endsWith("'"))) {
        v = v.slice(1, -1);
      }
      return v;
    });
  }
  // Single bare value (not wrapped in brackets)
  return [trimmed];
}

/**
 * Parse a single YAML scalar value — handles numbers, booleans, and
 * quoted / bare strings.
 */
function parseYamlScalar(raw: string): string | number | boolean {
  const trimmed = raw.trim();
  // Quoted string
  if (
    (trimmed.startsWith('"') && trimmed.endsWith('"')) ||
    (trimmed.startsWith("'") && trimmed.endsWith("'"))
  ) {
    return trimmed.slice(1, -1);
  }
  // Boolean
  if (trimmed === "true") return true;
  if (trimmed === "false") return false;
  // Number
  if (/^-?\d+(\.\d+)?$/.test(trimmed)) return Number(trimmed);
  // Bare string
  return trimmed;
}

/**
 * Serialize a value suitable for inline YAML.
 * Arrays become `[a, b, c]`, strings that need quoting get double-quoted.
 */
function serializeYamlValue(value: unknown): string {
  if (Array.isArray(value)) {
    if (value.length === 0) return "[]";
    return `[${value.map((v) => serializeYamlScalar(v)).join(", ")}]`;
  }
  return String(value);
}

function serializeYamlScalar(value: unknown): string {
  if (typeof value === "string") {
    // Quote if the string contains characters that could break YAML
    if (/[,\[\]{}:#'"|\n]/.test(value) || value.trim() !== value) {
      return `"${value.replace(/\\/g, "\\\\").replace(/"/g, '\\"')}"`;
    }
    return value;
  }
  return String(value);
}

// ── Frontmatter parsing ─────────────────────────────────────────────

/**
 * Parse YAML frontmatter from the raw text between `---` delimiters.
 * Expects the raw content of the frontmatter block (without the `---` lines).
 */
export function parseFrontmatter(raw: string): NoteFrontmatter {
  const kvMap = new Map<string, string>();
  const lines = raw.split("\n");

  for (const line of lines) {
    // Skip empty / comment lines
    if (line.trim() === "" || line.trim().startsWith("#")) continue;
    const colonIdx = line.indexOf(":");
    if (colonIdx === -1) continue;
    const key = line.slice(0, colonIdx).trim();
    const value = line.slice(colonIdx + 1).trim();
    kvMap.set(key, value);
  }

  const get = (key: string): string => {
    const v = kvMap.get(key);
    if (v === undefined) throw new Error(`Missing frontmatter field: ${key}`);
    return v;
  };

  const getStr = (key: string): string => {
    const rawVal = get(key);
    const parsed = parseYamlScalar(rawVal);
    return String(parsed);
  };

  const type = getStr("type") as NoteType;
  if (!VALID_NOTE_TYPES.has(type)) {
    throw new Error(`Invalid note type: "${type}". Expected one of: ${[...VALID_NOTE_TYPES].join(", ")}`);
  }

  const tier = getStr("tier") as NoteTier;
  if (!VALID_TIERS.has(tier)) {
    throw new Error(`Invalid note tier: "${tier}". Expected one of: ${[...VALID_TIERS].join(", ")}`);
  }

  const accessRaw = kvMap.get("access");
  const access = (accessRaw ? String(parseYamlScalar(accessRaw)) : "public") as NoteAccess;
  if (!VALID_ACCESS.has(access)) {
    throw new Error(`Invalid note access: "${access}". Expected one of: ${[...VALID_ACCESS].join(", ")}`);
  }

  const accessCountRaw = parseYamlScalar(get("access_count"));
  const accessCount = typeof accessCountRaw === "number" ? accessCountRaw : Number(accessCountRaw);
  if (Number.isNaN(accessCount)) {
    throw new Error(`Invalid access_count: "${kvMap.get("access_count")}"`);
  }

  return {
    id: getStr("id"),
    type,
    tier,
    created: getStr("created"),
    last_accessed: getStr("last_accessed"),
    access_count: accessCount,
    source_session: getStr("source_session"),
    entities: parseYamlArray(get("entities")),
    tags: parseYamlArray(get("tags")),
    access,
  };
}

// ── Frontmatter serialization ───────────────────────────────────────

export function serializeFrontmatter(fm: NoteFrontmatter): string {
  const lines: string[] = [
    `id: ${fm.id}`,
    `type: ${fm.type}`,
    `tier: ${fm.tier}`,
    `created: ${fm.created}`,
    `last_accessed: ${fm.last_accessed}`,
    `access_count: ${fm.access_count}`,
    `source_session: ${fm.source_session}`,
    `entities: ${serializeYamlValue(fm.entities)}`,
    `tags: ${serializeYamlValue(fm.tags)}`,
    `access: ${fm.access}`,
  ];
  return lines.join("\n");
}

// ── Full note parsing ───────────────────────────────────────────────

/**
 * Parse a complete note file:
 * ```
 * ---
 * frontmatter...
 * ---
 * # Title
 *
 * Body content...
 * ```
 */
export function parseNote(content: string, filePath?: string): Note {
  const fmRegex = /^---\r?\n([\s\S]*?)\r?\n---/;
  const match = content.match(fmRegex);
  if (!match) {
    throw new Error(`No frontmatter found${filePath ? ` in ${filePath}` : ""}`);
  }

  const fmRaw = match[1];
  const frontmatter = parseFrontmatter(fmRaw);

  // Everything after the closing ---
  const afterFm = content.slice(match[0].length).replace(/^\r?\n/, "");

  // Extract title from the first # heading
  let title = "";
  let body = afterFm;

  const headingRegex = /^#\s+(.+)/m;
  const headingMatch = afterFm.match(headingRegex);
  if (headingMatch) {
    title = headingMatch[1].trim();
    // Body is everything after the heading line
    const headingEnd = afterFm.indexOf(headingMatch[0]) + headingMatch[0].length;
    body = afterFm.slice(headingEnd).replace(/^\r?\n/, "");
  }

  return { frontmatter, title, body, filePath };
}

// ── Full note serialization ─────────────────────────────────────────

export function serializeNote(note: Note): string {
  const parts: string[] = [
    "---",
    serializeFrontmatter(note.frontmatter),
    "---",
    "",
  ];

  if (note.title) {
    parts.push(`# ${note.title}`);
    parts.push("");
  }

  parts.push(note.body);

  return parts.join("\n");
}

// ── ID generation ───────────────────────────────────────────────────

/** Generate a short note ID (first 12 characters of a UUID v4, without hyphens). */
export function generateNoteId(): string {
  return randomUUID().replace(/-/g, '').slice(0, 12);
}

// ── Slug generation ─────────────────────────────────────────────────

/**
 * Create a filename-safe slug from a title.
 *
 * - Keeps Hangul, Latin letters, digits, hyphens
 * - Replaces whitespace runs with a single hyphen
 * - Strips leading/trailing hyphens
 * - Lowercases Latin characters
 */
export function slugify(title: string): string {
  const result = title
    .trim()
    .replace(/\s+/g, "-")
    .replace(/[^\p{L}\p{N}\-]/gu, "")
    .replace(/-{2,}/g, "-")
    .replace(/^-+|-+$/g, "")
    .toLowerCase();
  return result || "untitled";
}
