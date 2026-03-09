import type { Vault } from "../vault/vault.js";
import type { MemoryzConfig } from "../config.js";
import { TierManager } from "../tier.js";
import type { Note, NoteFrontmatter } from "../vault/note.js";

export type ForgetResult = {
  archived: number;
  duplicatesMerged: number;
};

/**
 * Forget/cleanup: archive stale cold notes, detect and merge duplicates
 * across warm + cold tiers.
 */
export async function forget(
  vault: Vault,
  config: MemoryzConfig,
): Promise<ForgetResult> {
  const tierMgr = new TierManager(config);
  const result: ForgetResult = {
    archived: 0,
    duplicatesMerged: 0,
  };

  // ── Step 1: Archive stale cold notes ───────────────────────────────
  // Criteria: shouldArchive() (90d+ no access, <3 access_count) AND no
  // incoming wiki-links from other notes.
  const coldNotes = await vault.listNotes("cold");

  // Pre-build a set of all wikilink targets across all tiers (one pass, O(N))
  // so that incoming-link checks are O(1) instead of O(N) per note.
  const allLinkedTitles = new Set<string>();
  for (const tier of ["hot", "warm", "cold"] as const) {
    const tierNotes = await vault.listNotes(tier);
    for (const n of tierNotes) {
      const matches = n.body.matchAll(/\[\[([^\]]+)\]\]/g);
      for (const m of matches) {
        allLinkedTitles.add(m[1]);
      }
    }
  }

  for (const note of coldNotes) {
    if (!note.filePath) continue;

    if (!tierMgr.shouldArchive(note.frontmatter)) continue;

    // Keep notes that are still referenced by other notes (O(1) lookup)
    if (allLinkedTitles.has(note.title)) continue;

    await vault.moveNote(note.filePath, "archive");
    result.archived++;
  }

  // ── Step 2: Duplicate detection across warm + cold ─────────────────
  // Duplicates are pairs where title similarity > 0.8 AND entity overlap > 70%.
  const warmNotes = await vault.listNotes("warm");
  const remainingCold = await vault.listNotes("cold");
  const allCandidates = [...warmNotes, ...remainingCold];

  // Track already-processed file paths to avoid double merges
  const processed = new Set<string>();

  for (let i = 0; i < allCandidates.length; i++) {
    const noteA = allCandidates[i];
    if (!noteA.filePath || processed.has(noteA.filePath)) continue;

    for (let j = i + 1; j < allCandidates.length; j++) {
      const noteB = allCandidates[j];
      if (!noteB.filePath || processed.has(noteB.filePath)) continue;

      // Check title similarity (Levenshtein) > 0.8
      const titleSim = levenshteinSimilarity(
        noteA.title.toLowerCase(),
        noteB.title.toLowerCase(),
      );
      if (titleSim <= 0.8) continue;

      // Check entity overlap (Jaccard) > 70%
      const entityOverlap = computeEntityOverlap(noteA, noteB);
      if (entityOverlap <= 0.7) continue;

      // Duplicate found — merge into the one with higher access_count
      const accessA = noteA.frontmatter.access_count;
      const accessB = noteB.frontmatter.access_count;

      const [primary, secondary] =
        accessA >= accessB ? [noteA, noteB] : [noteB, noteA];

      // Merge secondary into primary
      const merged = mergeForForget(primary, secondary);
      await vault.updateNote(primary.filePath!, merged);
      // Update in-memory state
      Object.assign(primary.frontmatter, merged.frontmatter);
      primary.body = merged.body;
      primary.title = merged.title;

      // Archive the secondary
      await vault.moveNote(secondary.filePath!, "archive");
      processed.add(secondary.filePath!);

      result.duplicatesMerged++;
    }
  }

  // ── Step 3: Rebuild indexes ────────────────────────────────────────
  await vault.rebuildIndexes();

  return result;
}

/**
 * Compute Levenshtein similarity between two strings.
 * Returns a value between 0 and 1, where 1 means identical.
 */
export function levenshteinSimilarity(a: string, b: string): number {
  if (a === b) return 1;
  const maxLen = Math.max(a.length, b.length);
  if (maxLen === 0) return 1;

  const distance = levenshteinDistance(a, b);
  return 1 - distance / maxLen;
}

// ── Internal helpers ───────────────────────────────────────────────────

/**
 * Wagner-Fischer algorithm for Levenshtein distance, using two-row
 * optimisation for O(min(m,n)) space.
 */
function levenshteinDistance(a: string, b: string): number {
  const m = a.length;
  const n = b.length;

  // Ensure a is the shorter string for space optimisation
  if (m > n) return levenshteinDistance(b, a);

  const prev = new Uint32Array(m + 1);
  const curr = new Uint32Array(m + 1);

  for (let i = 0; i <= m; i++) prev[i] = i;

  for (let j = 1; j <= n; j++) {
    curr[0] = j;
    for (let i = 1; i <= m; i++) {
      const cost = a[i - 1] === b[j - 1] ? 0 : 1;
      curr[i] = Math.min(
        prev[i] + 1, // deletion
        curr[i - 1] + 1, // insertion
        prev[i - 1] + cost, // substitution
      );
    }
    // Swap rows
    for (let i = 0; i <= m; i++) {
      prev[i] = curr[i];
    }
  }

  return prev[m];
}

/**
 * Compute Jaccard similarity of two notes' entity sets.
 * Returns 0–1 where 1 means identical entity sets.
 * Returns 0 when both entity sets are empty.
 */
function computeEntityOverlap(a: Note, b: Note): number {
  const entA = new Set(a.frontmatter.entities.map((e) => e.toLowerCase()));
  const entB = new Set(b.frontmatter.entities.map((e) => e.toLowerCase()));

  if (entA.size === 0 && entB.size === 0) return 0;

  let intersection = 0;
  for (const e of entA) {
    if (entB.has(e)) intersection++;
  }

  const union = new Set([...entA, ...entB]).size;
  return intersection / union;
}

/**
 * Merge two notes for the forget-duplicate flow.
 * Primary absorbs secondary: bodies concatenated, entities/tags unioned,
 * access_count summed, newer timestamps kept.
 */
function mergeForForget(primary: Note, secondary: Note): Note {
  const combinedBody = primary.body + "\n\n---\n\n" + secondary.body;

  const entitySet = new Set<string>([
    ...primary.frontmatter.entities,
    ...secondary.frontmatter.entities,
  ]);
  const tagSet = new Set<string>([
    ...primary.frontmatter.tags,
    ...secondary.frontmatter.tags,
  ]);

  const primaryLastAccessed = new Date(primary.frontmatter.last_accessed).getTime();
  const secondaryLastAccessed = new Date(secondary.frontmatter.last_accessed).getTime();
  const newerLastAccessed =
    secondaryLastAccessed > primaryLastAccessed
      ? secondary.frontmatter.last_accessed
      : primary.frontmatter.last_accessed;

  const mergedFrontmatter: NoteFrontmatter = {
    ...primary.frontmatter,
    last_accessed: newerLastAccessed,
    access_count:
      primary.frontmatter.access_count + secondary.frontmatter.access_count,
    entities: [...entitySet],
    tags: [...tagSet],
  };

  return {
    frontmatter: mergedFrontmatter,
    title: primary.title,
    body: combinedBody,
    filePath: primary.filePath,
  };
}
