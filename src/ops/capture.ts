import type { Vault } from "../vault/vault.js";
import type { MemoryzConfig } from "../config.js";
import type { Summarizer } from "../summarizer.js";
import {
  generateId,
  extractEntities,
  extractTags,
  formatTimestamp,
} from "../utils.js";
import type { Note, NoteType } from "../vault/note.js";

// ---------------------------------------------------------------------------
// Types for message extraction
// ---------------------------------------------------------------------------

type MessageLike = {
  role?: string;
  content?: string | Array<{ type?: string; text?: string }>;
};

// ---------------------------------------------------------------------------
// extractTextFromMessages
// ---------------------------------------------------------------------------

export function extractTextFromMessages(messages: unknown[]): string[] {
  const texts: string[] = [];

  for (const raw of messages) {
    const msg = raw as MessageLike;
    if (!msg || typeof msg !== "object") continue;

    // Only extract from user and assistant messages
    if (msg.role !== "user" && msg.role !== "assistant") continue;

    if (typeof msg.content === "string") {
      if (msg.content.length > 0) {
        texts.push(msg.content);
      }
    } else if (Array.isArray(msg.content)) {
      for (const block of msg.content) {
        if (
          block &&
          typeof block === "object" &&
          block.type === "text" &&
          typeof block.text === "string" &&
          block.text.length > 0
        ) {
          texts.push(block.text);
        }
      }
    }
  }

  return texts;
}

// ---------------------------------------------------------------------------
// shouldCapture
// ---------------------------------------------------------------------------

// Common prompt-injection patterns to reject
const INJECTION_PATTERNS = [
  /ignore\s+(previous|above|all)\s+(instructions?|prompts?)/i,
  /disregard\s+(previous|above|all)/i,
  /you\s+are\s+now\s+/i,
  /new\s+instructions?:/i,
  /system\s*:\s*/i,
  /\bDAN\b/,
  /do\s+anything\s+now/i,
  /jailbreak/i,
];

export function shouldCapture(text: string, config: MemoryzConfig): boolean {
  const minLength = config.capture?.minLength ?? 20;

  // Length check
  if (text.length < minLength) return false;

  // Skip self-referencing memoryz tags
  if (text.includes("<relevant-memories>") || text.includes("<memoryz>")) {
    return false;
  }

  // Skip system XML blocks (starts with < and contains closing tag)
  if (text.startsWith("<") && text.includes("</")) {
    return false;
  }

  // Skip prompt injection patterns
  for (const pattern of INJECTION_PATTERNS) {
    if (pattern.test(text)) return false;
  }

  return true;
}

// ---------------------------------------------------------------------------
// detectNoteType
// ---------------------------------------------------------------------------

const TYPE_PATTERNS: Array<{ type: NoteType; patterns: RegExp[] }> = [
  {
    type: "preference",
    patterns: [
      /\b(prefer|like|want|hate|love|dislike)\b/i,
      /좋아/,
      /싫어/,
      /원해/,
      /선호/,
    ],
  },
  {
    type: "decision",
    patterns: [
      /\b(decided|will\s+use|chose|going\s+with|switching\s+to)\b/i,
      /결정/,
      /사용하기로/,
      /선택/,
    ],
  },
  {
    type: "entity",
    patterns: [
      /@\w+/,
      /\b[A-Z][a-z]+(?:\s+[A-Z][a-z]+)+\b/, // Proper nouns (multi-word)
      /\b[a-z]+-(?:server|node|host)\d*\b/i, // Device name patterns
    ],
  },
  {
    type: "event",
    patterns: [
      /\b(did|done|completed|finished|deployed|shipped|released)\b/i,
      /했/,
      /완료/,
      /배포/,
    ],
  },
  {
    type: "insight",
    patterns: [
      /\b(because|therefore|thus|hence|so\s+that|in\s+order\s+to|turns?\s+out)\b/i,
      /그래서/,
      /왜냐하면/,
      /때문에/,
      /알게\s*됨/,
    ],
  },
];

export function detectNoteType(text: string): NoteType {
  for (const { type, patterns } of TYPE_PATTERNS) {
    for (const p of patterns) {
      if (p.test(text)) return type;
    }
  }
  return "fact";
}

// ---------------------------------------------------------------------------
// Duplicate detection helpers
// ---------------------------------------------------------------------------

function entitiesOverlap(a: string[], b: string[]): boolean {
  if (a.length === 0 || b.length === 0) return false;
  const setB = new Set(b.map((e) => e.toLowerCase()));
  return a.some((e) => setB.has(e.toLowerCase()));
}

function isRecentDuplicate(
  note: Note,
  entities: string[],
  nowMs: number,
): boolean {
  const FIVE_MINUTES = 5 * 60 * 1000;
  const noteCreated = new Date(note.frontmatter.created).getTime();
  if (nowMs - noteCreated > FIVE_MINUTES) return false;
  return entitiesOverlap(note.frontmatter.entities, entities);
}

// ---------------------------------------------------------------------------
// capture (main function)
// ---------------------------------------------------------------------------

export async function capture(
  vault: Vault,
  messages: unknown[],
  sessionInfo: { sessionKey?: string; agentId?: string },
  config: MemoryzConfig,
  summarizer?: Summarizer,
): Promise<number> {
  const maxPerTurn = config.capture?.maxPerTurn ?? 5;

  // 1. Extract text from messages
  const allTexts = extractTextFromMessages(messages);

  // 2. Filter with shouldCapture
  const capturable = allTexts.filter((t) => shouldCapture(t, config));

  // 3. Limit to maxPerTurn — process newest messages first (current turn)
  //    so old session history doesn't consume the budget
  const toProcess = capturable.reverse().slice(0, maxPerTurn);

  if (toProcess.length === 0) return 0;

  const now = Date.now();
  let count = 0;

  // Read existing hot notes for duplicate detection
  const hotNotes = await vault.listNotes("hot");

  for (const text of toProcess) {
    // a. Summarize
    let summary: string;
    if (summarizer) {
      try {
        const summarized = await summarizer.summarize(text);
        summary = summarized.summary;
      } catch {
        summary = text.slice(0, 200);
      }
    } else {
      summary = text.slice(0, 200);
    }

    // b. Extract entities and tags
    const entities = extractEntities(text);
    const tags = extractTags(text);
    const noteType = detectNoteType(text);

    // c. Check for recent duplicate (same entities within 5 min)
    let duplicateNote: Note | undefined;
    for (const note of hotNotes) {
      if (isRecentDuplicate(note, entities, now)) {
        duplicateNote = note;
        break;
      }
    }

    if (duplicateNote) {
      // d. Append to existing note body
      const appendText = `\n\n---\n_Updated: ${formatTimestamp(now)}_\n\n${text}`;
      duplicateNote.body += appendText;
      await vault.updateNote(duplicateNote.filePath!, duplicateNote);
    } else {
      // e. Create new hot note
      const id = generateId();
      const timestamp = formatTimestamp(now);
      let title = summary.split("\n")[0].slice(0, 100).trim();

      // Fallback: if title is empty or meaningless (e.g. "..."), generate from entities/text
      if (!title || /^\.{1,}$/.test(title) || title.length < 3) {
        if (entities.length > 0) {
          title = entities.slice(0, 3).join(" ") + " — " + text.slice(0, 80).replace(/\n/g, " ").trim();
          title = title.slice(0, 100);
        } else {
          title = text.slice(0, 100).replace(/\n/g, " ").trim();
        }
      }

      const note: Note = {
        frontmatter: {
          id,
          tier: "hot",
          created: timestamp,
          last_accessed: timestamp,
          access_count: 0,
          tags,
          entities,
          type: noteType,
          source_session: sessionInfo.agentId ?? sessionInfo.sessionKey ?? "unknown",
          access: "public",
        },
        title,
        body: text,
      };

      await vault.createNote(note);
      // Add to hotNotes so subsequent iterations can detect duplicates
      hotNotes.push(note);
    }

    count++;
  }

  // 5. Rebuild hot INDEX.md
  await vault.rebuildHotIndex();

  return count;
}
