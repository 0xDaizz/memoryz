import type { Vault } from "../vault/vault.js";
import type { MemoryzConfig } from "../config.js";
import {
  extractEntities,
  extractKeywords,
  extractTags,
  truncateTokens,
} from "../utils.js";
import { search } from "../vault/search.js";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type RecallPointer = {
  tier: string;
  path: string;
  title: string;
  summary: string;
  date: string;
};

// ---------------------------------------------------------------------------
// Tier emoji mapping
// ---------------------------------------------------------------------------

const TIER_EMOJI: Record<string, string> = {
  hot: "🔥",
  warm: "🌡️",
  cold: "❄️",
};

// ---------------------------------------------------------------------------
// recall
// ---------------------------------------------------------------------------

export async function recall(
  vault: Vault,
  prompt: string,
  config: MemoryzConfig,
): Promise<RecallPointer[]> {
  const maxPointers = config.recall?.maxPointers ?? 10;

  // 1. Extract entities, tags, keywords from prompt
  const entities = extractEntities(prompt);
  const tags = extractTags(prompt);
  const keywords = extractKeywords(prompt);

  // 2. Build combined query from all extracted terms
  const queryParts = [...entities, ...tags, ...keywords];

  // Deduplicate (case-insensitive)
  const seen = new Set<string>();
  const deduped: string[] = [];
  for (const part of queryParts) {
    const lower = part.toLowerCase();
    if (!seen.has(lower)) {
      seen.add(lower);
      deduped.push(part);
    }
  }

  if (deduped.length === 0) {
    // Fallback: use the prompt itself as query (trimmed)
    const trimmed = prompt.trim().slice(0, 200);
    if (trimmed.length === 0) return [];
    deduped.push(trimmed);
  }

  const query = deduped.join(" ");

  // 2. Search vault with combined query
  const results = await search(vault, query);

  // 3. Take top maxPointers results
  const top = results.slice(0, maxPointers);

  // 4. Log access for each result
  const pointers: RecallPointer[] = [];
  for (const result of top) {
    await vault.logAccess(result.note.filePath!);

    pointers.push({
      tier: result.note.frontmatter.tier,
      path: result.note.filePath!,
      title: result.note.title,
      summary: result.note.body.slice(0, 100),
      date: result.note.frontmatter.created,
    });
  }

  return pointers;
}

// ---------------------------------------------------------------------------
// formatMemoryzContext
// ---------------------------------------------------------------------------

export function formatMemoryzContext(
  hotIndex: string,
  pointers: RecallPointer[],
  config: MemoryzConfig,
): string {
  const maxTokens = config.recall?.maxTokens ?? 2000;

  const lines: string[] = [];
  lines.push("<memoryz>");
  lines.push("## 현재 상태 (hot)");

  if (hotIndex.trim().length > 0) {
    lines.push(hotIndex);
  } else {
    lines.push("_(비어 있음)_");
  }

  lines.push("");

  if (pointers.length > 0) {
    lines.push("## 관련 기억");

    for (const p of pointers) {
      const emoji = TIER_EMOJI[p.tier] ?? "📝";
      const dateStr = p.date ? ` (${p.date})` : "";
      lines.push(`${emoji} ${p.path} — ${p.title}${dateStr}`);
      if (p.summary) {
        lines.push(`  ${p.summary}`);
      }
    }

    lines.push("");
  }

  lines.push("memoryz_read 도구로 상세 내용을 읽을 수 있습니다.");
  lines.push("</memoryz>");

  const raw = lines.join("\n");

  // Truncate to maxTokens (approximate: 1 token ≈ 4 chars)
  return truncateTokens(raw, maxTokens);
}
