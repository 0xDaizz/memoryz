import type { Vault } from "../vault/vault.js";
import type { MemoryzConfig } from "../config.js";
import { TierManager } from "../tier.js";
import type { Note, NoteFrontmatter } from "../vault/note.js";
import { serializeNote } from "../vault/note.js";
import { VaultLock } from "../lock.js";

export type ConsolidateResult = {
  movedHotToWarm: number;
  movedWarmToCold: number;
  promotedColdToWarm: number;
  merged: number;
  linksAdded: number;
};

/**
 * Run full consolidation cycle: tier movement, merging, wiki-link insertion,
 * index rebuild, and hot INDEX.md regeneration.
 */
export async function consolidate(
  vault: Vault,
  config: MemoryzConfig,
): Promise<ConsolidateResult> {
  const lock = new VaultLock(vault.basePath);
  await lock.init();

  return lock.withLock("consolidate", async () => {
    const tierMgr = new TierManager(config);
    const result: ConsolidateResult = {
      movedHotToWarm: 0,
      movedWarmToCold: 0,
      promotedColdToWarm: 0,
      merged: 0,
      linksAdded: 0,
    };

    // ── Step 1: Hot → Warm ─────────────────────────────────────────────
    const hotNotes = await vault.listNotes("hot");
    const warmNotes = await vault.listNotes("warm");

    for (const note of hotNotes) {
      const target = tierMgr.shouldDemote(note.frontmatter);
      if (target !== "warm") continue;

      // Check if warm/ already has a note with overlapping entities (>50%)
      const mergeTarget = findOverlappingNote(note, warmNotes, 0.5);

      if (mergeTarget && mergeTarget.filePath) {
        // Merge into existing warm note
        const merged = mergeNotes(mergeTarget, note);
        await vault.updateNote(mergeTarget.filePath, merged);
        // Delete the hot note
        if (note.filePath) await vault.deleteNote(note.filePath);
        // Update in-memory state so subsequent iterations see latest data
        Object.assign(mergeTarget.frontmatter, merged.frontmatter);
        mergeTarget.body = merged.body;
        mergeTarget.title = merged.title;
        result.merged++;
      } else {
        // Move note to warm/ atomically via vault.moveNote()
        if (note.filePath) {
          const newPath = await vault.moveNote(note.filePath, "warm");
          note.filePath = newPath;
          note.frontmatter.tier = "warm";
          warmNotes.push(note);
        }
      }
      result.movedHotToWarm++;
    }

    // ── Step 2: Warm → Cold ────────────────────────────────────────────
    // Re-read warm notes since step 1 may have changed them
    const currentWarm = await vault.listNotes("warm");

    for (const note of currentWarm) {
      const target = tierMgr.shouldDemote(note.frontmatter);
      if (target !== "cold") continue;

      if (note.filePath) {
        await vault.moveNote(note.filePath, "cold");
        result.movedWarmToCold++;
      }
    }

    // ── Step 3: Cold → Warm promotion (recent accesses in last 1 hour) ─
    const ONE_HOUR = 60 * 60 * 1000;
    const now = Date.now();
    const accessLog = await vault.getAccessLog();
    const recentAccesses = accessLog.filter((entry) => now - entry.at < ONE_HOUR);

    // Deduplicate by file path
    const recentColdFiles = new Set<string>();
    for (const entry of recentAccesses) {
      recentColdFiles.add(entry.file);
    }

    const coldNotes = await vault.listNotes("cold");
    for (const note of coldNotes) {
      if (!note.filePath) continue;
      if (!recentColdFiles.has(note.filePath)) continue;

      await vault.moveNote(note.filePath, "warm");
      result.promotedColdToWarm++;
    }

    // ── Step 4: Rebuild indexes ────────────────────────────────────────
    await vault.rebuildIndexes();

    // ── Step 5: Insert wiki-links across warm notes ────────────────────
    result.linksAdded = await insertWikiLinks(vault);

    // ── Step 6: Rebuild hot/INDEX.md ───────────────────────────────────
    await vault.rebuildHotIndex();

    return result;
  });
}

/**
 * Merge two notes: primary absorbs secondary.
 *
 * - Bodies are concatenated with a horizontal rule separator
 * - Entities and tags are unioned
 * - Primary keeps its id; newer created/last_accessed values win
 * - access_count values are summed
 * - Primary's tier is preserved
 */
export function mergeNotes(primary: Note, secondary: Note): Note {
  const combinedBody = primary.body + "\n\n---\n\n" + secondary.body;

  const entitySet = new Set<string>([
    ...primary.frontmatter.entities,
    ...secondary.frontmatter.entities,
  ]);
  const tagSet = new Set<string>([
    ...primary.frontmatter.tags,
    ...secondary.frontmatter.tags,
  ]);

  // Pick older (earlier) created timestamp to preserve the earliest creation time
  const primaryCreated = new Date(primary.frontmatter.created).getTime();
  const secondaryCreated = new Date(secondary.frontmatter.created).getTime();
  const olderCreated =
    secondaryCreated < primaryCreated
      ? secondary.frontmatter.created
      : primary.frontmatter.created;

  const primaryLastAccessed = new Date(primary.frontmatter.last_accessed).getTime();
  const secondaryLastAccessed = new Date(secondary.frontmatter.last_accessed).getTime();
  const newerLastAccessed =
    secondaryLastAccessed > primaryLastAccessed
      ? secondary.frontmatter.last_accessed
      : primary.frontmatter.last_accessed;

  const mergedFrontmatter: NoteFrontmatter = {
    ...primary.frontmatter,
    created: olderCreated,
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

/**
 * Insert wiki-links between warm notes that share 2+ entities.
 *
 * For each pair of warm notes sharing 2 or more entities, ensures
 * a [[title]] link exists in both notes' bodies.
 *
 * @returns total number of new links added
 */
export async function insertWikiLinks(vault: Vault): Promise<number> {
  const entityIndex = await vault.readEntityIndex();
  let linksAdded = 0;

  // Build reverse map: filePath → set of lowercased entities
  const fileEntities = new Map<string, Set<string>>();
  for (const [entity, files] of Object.entries(entityIndex)) {
    for (const file of files) {
      if (!fileEntities.has(file)) fileEntities.set(file, new Set());
      fileEntities.get(file)!.add(entity);
    }
  }

  // Read all warm notes
  const warmNotes = await vault.listNotes("warm");

  // For each pair sharing 2+ entities, ensure cross-links exist
  for (let i = 0; i < warmNotes.length; i++) {
    const noteA = warmNotes[i];
    if (!noteA.filePath) continue;
    const entitiesA = fileEntities.get(noteA.filePath);
    if (!entitiesA) continue;

    for (let j = i + 1; j < warmNotes.length; j++) {
      const noteB = warmNotes[j];
      if (!noteB.filePath) continue;
      const entitiesB = fileEntities.get(noteB.filePath);
      if (!entitiesB) continue;

      // Count shared entities
      let shared = 0;
      for (const e of entitiesA) {
        if (entitiesB.has(e)) shared++;
      }
      if (shared < 2) continue;

      // Add link A→B if missing
      const linkToB = `[[${noteB.title}]]`;
      if (!noteA.body.includes(linkToB)) {
        noteA.body = noteA.body.trimEnd() + `\n\n${linkToB}\n`;
        await vault.updateNote(noteA.filePath, noteA);
        linksAdded++;
      }

      // Add link B→A if missing
      const linkToA = `[[${noteA.title}]]`;
      if (!noteB.body.includes(linkToA)) {
        noteB.body = noteB.body.trimEnd() + `\n\n${linkToA}\n`;
        await vault.updateNote(noteB.filePath, noteB);
        linksAdded++;
      }
    }
  }

  return linksAdded;
}

// ── Helpers ────────────────────────────────────────────────────────────

/**
 * Find the first note in `candidates` whose entities overlap with `note`
 * by more than `threshold` (Jaccard similarity).
 */
function findOverlappingNote(
  note: Note,
  candidates: Note[],
  threshold: number,
): Note | null {
  const noteEntities = new Set(
    note.frontmatter.entities.map((e) => e.toLowerCase()),
  );
  if (noteEntities.size === 0) return null;

  for (const candidate of candidates) {
    const candEntities = new Set(
      candidate.frontmatter.entities.map((e) => e.toLowerCase()),
    );
    if (candEntities.size === 0) continue;

    let intersection = 0;
    for (const e of noteEntities) {
      if (candEntities.has(e)) intersection++;
    }

    const union = new Set([...noteEntities, ...candEntities]).size;
    const overlap = intersection / union;

    if (overlap > threshold) {
      return candidate;
    }
  }

  return null;
}
