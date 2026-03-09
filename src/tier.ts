import type { MemoryzConfig } from "./config.js";
import type { NoteFrontmatter, NoteTier } from "./vault/note.js";

const HOUR = 60 * 60 * 1000;
const DAY = 24 * HOUR;

/** Default tier thresholds */
const DEFAULTS = {
  hotMaxAge: 1 * DAY,       // notes created within 24h are hot
  warmMaxAge: 7 * DAY,      // notes accessed within 7 days are warm
  coldArchiveAge: 90 * DAY, // notes not accessed for 90 days are archive candidates
  hotMaxNotes: 20,           // max notes in hot tier
} as const;

export class TierManager {
  private hotMaxAge: number;
  private warmMaxAge: number;
  private coldArchiveAge: number;
  private hotMaxNotes: number;

  constructor(private config: MemoryzConfig) {
    this.hotMaxAge = config.tiers?.hotMaxAge ?? DEFAULTS.hotMaxAge;
    this.warmMaxAge = config.tiers?.warmMaxAge ?? DEFAULTS.warmMaxAge;
    this.coldArchiveAge = config.tiers?.coldArchiveAge ?? DEFAULTS.coldArchiveAge;
    this.hotMaxNotes = config.tiers?.hotMaxNotes ?? DEFAULTS.hotMaxNotes;
  }

  /**
   * Determine what tier a note should be in based on current config.
   *
   * Rules (evaluated in order):
   * 1. If note.access_count >= 3 AND last_accessed within warmMaxAge → at least warm
   * 2. If created within hotMaxAge → hot
   * 3. If last_accessed within warmMaxAge → warm
   * 4. If last_accessed within coldArchiveAge → cold
   * 5. Else → archive (but only if access_count < 3)
   */
  recommendTier(note: NoteFrontmatter, now?: number): NoteTier | "archive" {
    const ts = now ?? Date.now();
    const created = new Date(note.created).getTime();
    const lastAccessed = new Date(note.last_accessed).getTime();
    const createdAge = ts - created;
    const accessAge = ts - lastAccessed;

    // Rule 1: frequently accessed and recently touched → at least warm
    if (note.access_count >= 3 && accessAge <= this.warmMaxAge) {
      // Could be hot if also recently created
      if (createdAge <= this.hotMaxAge) {
        return "hot";
      }
      return "warm";
    }

    // Rule 2: very recently created → hot
    if (createdAge <= this.hotMaxAge) {
      return "hot";
    }

    // Rule 3: recently accessed → warm
    if (accessAge <= this.warmMaxAge) {
      return "warm";
    }

    // Rule 4: accessed within cold archive threshold → cold
    if (accessAge <= this.coldArchiveAge) {
      return "cold";
    }

    // Rule 5: archive only if rarely accessed
    if (note.access_count < 3) {
      return "archive";
    }

    // Frequently accessed notes stay cold even if old
    return "cold";
  }

  /**
   * Check if note should be promoted (cold→warm or warm→hot).
   *
   * - If currently cold but accessed recently (within warmMaxAge) → promote to warm
   * - If currently warm but accessed very recently (within hotMaxAge) and access_count >= 5 → promote to hot
   *
   * @returns target tier or null if no promotion needed
   */
  shouldPromote(note: NoteFrontmatter, now?: number): NoteTier | null {
    const ts = now ?? Date.now();
    const lastAccessed = new Date(note.last_accessed).getTime();
    const accessAge = ts - lastAccessed;

    if (note.tier === "cold" && accessAge <= this.warmMaxAge) {
      return "warm";
    }

    if (note.tier === "warm" && accessAge <= this.hotMaxAge && note.access_count >= 5) {
      return "hot";
    }

    return null;
  }

  /**
   * Check if note should be demoted (hot→warm or warm→cold).
   *
   * - If currently hot and older than hotMaxAge → demote to warm
   * - If currently warm and last_accessed older than warmMaxAge → demote to cold
   *
   * @returns target tier or null if no demotion needed
   */
  shouldDemote(note: NoteFrontmatter, now?: number): NoteTier | null {
    const ts = now ?? Date.now();
    const lastAccessed = new Date(note.last_accessed).getTime();
    const accessAge = ts - lastAccessed;

    if (note.tier === "hot" && accessAge > this.hotMaxAge) {
      return "warm";
    }

    if (note.tier === "warm" && accessAge > this.warmMaxAge) {
      return "cold";
    }

    return null;
  }

  /**
   * Check if note should be archived.
   * A note is archive-worthy if last_accessed is older than coldArchiveAge
   * AND access_count < 3.
   */
  shouldArchive(note: NoteFrontmatter, now?: number): boolean {
    const ts = now ?? Date.now();
    const lastAccessed = new Date(note.last_accessed).getTime();
    const accessAge = ts - lastAccessed;

    return accessAge > this.coldArchiveAge && note.access_count < 3;
  }

  /** Check if hot tier is full */
  isHotFull(hotCount: number): boolean {
    return hotCount >= this.hotMaxNotes;
  }
}
