import { Vault } from "./vault.js";
import { Note, NoteTier } from "./note.js";

export type SearchResult = {
  note: Note;
  score: number; // 0–1 relevance score
  matchType: "entity" | "tag" | "fulltext";
};

/**
 * Search by entity names using the entities.json index.
 * Score = (matched entity count / queried entity count), capped at 1.
 */
export async function searchByEntity(
  vault: Vault,
  entities: string[],
): Promise<SearchResult[]> {
  if (entities.length === 0) return [];

  const entityIndex = await vault.readEntityIndex();
  const normalised = entities.map((e) => e.toLowerCase());

  // Collect file paths and count how many query entities they match
  const pathScores = new Map<string, number>();
  for (const entity of normalised) {
    const paths = entityIndex[entity];
    if (!paths) continue;
    for (const p of paths) {
      pathScores.set(p, (pathScores.get(p) ?? 0) + 1);
    }
  }

  const results: SearchResult[] = [];
  for (const [fp, count] of pathScores) {
    try {
      const note = await vault.readNote(fp);
      results.push({
        note,
        score: Math.min(count / normalised.length, 1),
        matchType: "entity",
      });
    } catch {
      // file may have been deleted since index was built — skip
    }
  }

  results.sort((a, b) => b.score - a.score);
  return results;
}

/**
 * Search by tags using the tags.json index.
 * Score = (matched tag count / queried tag count), capped at 1.
 */
export async function searchByTag(
  vault: Vault,
  tags: string[],
): Promise<SearchResult[]> {
  if (tags.length === 0) return [];

  const tagIndex = await vault.readTagIndex();
  const normalised = tags.map((t) => t.toLowerCase());

  const pathScores = new Map<string, number>();
  for (const tag of normalised) {
    const paths = tagIndex[tag];
    if (!paths) continue;
    for (const p of paths) {
      pathScores.set(p, (pathScores.get(p) ?? 0) + 1);
    }
  }

  const results: SearchResult[] = [];
  for (const [fp, count] of pathScores) {
    try {
      const note = await vault.readNote(fp);
      results.push({
        note,
        score: Math.min(count / normalised.length, 1),
        matchType: "tag",
      });
    } catch {
      // skip missing
    }
  }

  results.sort((a, b) => b.score - a.score);
  return results;
}

/**
 * Fulltext search across vault note files.
 * Splits query into words, reads each note, counts how many unique query
 * words appear in the note text. Score = (matched words / total words).
 */
export async function searchByText(
  vault: Vault,
  query: string,
  tiers?: NoteTier[],
): Promise<SearchResult[]> {
  const words = query
    .toLowerCase()
    .split(/\s+/)
    .filter((w) => w.length > 0);
  if (words.length === 0) return [];

  const tiersToSearch: (NoteTier | "archive")[] = tiers ?? ["hot", "warm", "cold"];
  const results: SearchResult[] = [];

  for (const tier of tiersToSearch) {
    const notes = await vault.listNotes(tier);
    for (const note of notes) {
      const haystack = [
        note.title,
        note.body,
        note.frontmatter.tags.join(" "),
        note.frontmatter.entities.join(" "),
      ]
        .join(" ")
        .toLowerCase();

      let matchCount = 0;
      for (const word of words) {
        if (haystack.includes(word)) {
          matchCount++;
        }
      }
      if (matchCount > 0) {
        results.push({
          note,
          score: Math.min(matchCount / words.length, 1),
          matchType: "fulltext",
        });
      }
    }
  }

  results.sort((a, b) => b.score - a.score);
  return results;
}

/**
 * Combined search: entity matches (weight 1.0) + tag matches (weight 0.7)
 * + fulltext (weight 0.5).
 *
 * Deduplicates by filePath, sums weighted scores, sorts descending,
 * applies limit (default 10).
 */
// TODO: Filter by access level when accessControl is enabled
export async function search(
  vault: Vault,
  query: string,
  opts?: {
    entities?: string[];
    tags?: string[];
    tiers?: NoteTier[];
    limit?: number;
  },
): Promise<SearchResult[]> {
  const limit = opts?.limit ?? 10;

  // Run all three search strategies in parallel
  const [entityResults, tagResults, textResults] = await Promise.all([
    opts?.entities?.length
      ? searchByEntity(vault, opts.entities)
      : Promise.resolve([]),
    opts?.tags?.length
      ? searchByTag(vault, opts.tags)
      : Promise.resolve([]),
    query.trim().length > 0
      ? searchByText(vault, query, opts?.tiers)
      : Promise.resolve([]),
  ]);

  // Weighted merge — key by filePath (or title as fallback)
  const merged = new Map<
    string,
    { note: Note; score: number; matchType: SearchResult["matchType"] }
  >();

  const addResults = (
    results: SearchResult[],
    weight: number,
    type: SearchResult["matchType"],
  ) => {
    for (const r of results) {
      const key = r.note.filePath ?? r.note.title;
      const existing = merged.get(key);
      if (existing) {
        existing.score += r.score * weight;
        // Promote matchType to highest-weight source
        if (weight > 0.7) existing.matchType = type;
      } else {
        merged.set(key, {
          note: r.note,
          score: r.score * weight,
          matchType: type,
        });
      }
    }
  };

  addResults(entityResults, 1.0, "entity");
  addResults(tagResults, 0.7, "tag");
  addResults(textResults, 0.5, "fulltext");

  return Array.from(merged.values())
    .sort((a, b) => b.score - a.score)
    .slice(0, limit);
}
