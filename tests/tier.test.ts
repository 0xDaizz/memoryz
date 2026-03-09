import { describe, it, expect } from "vitest";
import { TierManager } from "../src/tier.js";
import type { MemoryzConfig } from "../src/config.js";
import type { NoteFrontmatter } from "../src/vault/note.js";

// ── Helpers ──────────────────────────────────────────────────────────

const HOUR = 60 * 60 * 1000;
const DAY = 24 * HOUR;

function makeConfig(overrides?: Partial<MemoryzConfig["tiers"]>): MemoryzConfig {
  return {
    vaultPath: "/tmp/test",
    summarizer: { provider: "rules" },
    tiers: {
      hotMaxAge: 2 * HOUR,
      warmMaxAge: 7 * DAY,
      coldArchiveAge: 30 * DAY,
      hotMaxNotes: 20,
      ...overrides,
    },
    recall: { enabled: true, maxPointers: 5, maxTokens: 800 },
    capture: { enabled: true, minLength: 20, maxPerTurn: 3 },
    consolidateIntervalMs: 1_800_000,
    accessControl: false,
  };
}

function makeFrontmatter(overrides?: Partial<NoteFrontmatter>): NoteFrontmatter {
  return {
    id: "test1234",
    type: "fact",
    tier: "hot",
    created: new Date().toISOString(),
    last_accessed: new Date().toISOString(),
    access_count: 0,
    source_session: "test",
    entities: [],
    tags: [],
    access: "public",
    ...overrides,
  };
}

// ── shouldDemote ─────────────────────────────────────────────────────

describe("TierManager.shouldDemote", () => {
  it("demotes hot → warm after hotMaxAge", () => {
    const config = makeConfig({ hotMaxAge: 2 * HOUR });
    const mgr = new TierManager(config);
    const now = Date.now();

    const note = makeFrontmatter({
      tier: "hot",
      last_accessed: new Date(now - 3 * HOUR).toISOString(),
    });

    expect(mgr.shouldDemote(note, now)).toBe("warm");
  });

  it("does not demote hot note within hotMaxAge", () => {
    const config = makeConfig({ hotMaxAge: 2 * HOUR });
    const mgr = new TierManager(config);
    const now = Date.now();

    const note = makeFrontmatter({
      tier: "hot",
      last_accessed: new Date(now - 1 * HOUR).toISOString(),
    });

    expect(mgr.shouldDemote(note, now)).toBeNull();
  });

  it("demotes warm → cold after warmMaxAge", () => {
    const config = makeConfig({ warmMaxAge: 7 * DAY });
    const mgr = new TierManager(config);
    const now = Date.now();

    const note = makeFrontmatter({
      tier: "warm",
      last_accessed: new Date(now - 10 * DAY).toISOString(),
    });

    expect(mgr.shouldDemote(note, now)).toBe("cold");
  });

  it("does not demote warm note within warmMaxAge", () => {
    const config = makeConfig({ warmMaxAge: 7 * DAY });
    const mgr = new TierManager(config);
    const now = Date.now();

    const note = makeFrontmatter({
      tier: "warm",
      last_accessed: new Date(now - 3 * DAY).toISOString(),
    });

    expect(mgr.shouldDemote(note, now)).toBeNull();
  });

  it("returns null for cold notes (no further demotion)", () => {
    const mgr = new TierManager(makeConfig());
    const now = Date.now();

    const note = makeFrontmatter({
      tier: "cold",
      last_accessed: new Date(now - 60 * DAY).toISOString(),
    });

    expect(mgr.shouldDemote(note, now)).toBeNull();
  });
});

// ── shouldPromote ────────────────────────────────────────────────────

describe("TierManager.shouldPromote", () => {
  it("promotes cold → warm on recent access", () => {
    const config = makeConfig({ warmMaxAge: 7 * DAY });
    const mgr = new TierManager(config);
    const now = Date.now();

    const note = makeFrontmatter({
      tier: "cold",
      last_accessed: new Date(now - 2 * DAY).toISOString(),
    });

    expect(mgr.shouldPromote(note, now)).toBe("warm");
  });

  it("does not promote cold with old access", () => {
    const config = makeConfig({ warmMaxAge: 7 * DAY });
    const mgr = new TierManager(config);
    const now = Date.now();

    const note = makeFrontmatter({
      tier: "cold",
      last_accessed: new Date(now - 15 * DAY).toISOString(),
    });

    expect(mgr.shouldPromote(note, now)).toBeNull();
  });

  it("promotes warm → hot with high access count and recent access", () => {
    const config = makeConfig({ hotMaxAge: 2 * HOUR });
    const mgr = new TierManager(config);
    const now = Date.now();

    const note = makeFrontmatter({
      tier: "warm",
      last_accessed: new Date(now - 1 * HOUR).toISOString(),
      access_count: 10,
    });

    expect(mgr.shouldPromote(note, now)).toBe("hot");
  });

  it("does not promote warm → hot with low access count", () => {
    const config = makeConfig({ hotMaxAge: 2 * HOUR });
    const mgr = new TierManager(config);
    const now = Date.now();

    const note = makeFrontmatter({
      tier: "warm",
      last_accessed: new Date(now - 1 * HOUR).toISOString(),
      access_count: 2,
    });

    expect(mgr.shouldPromote(note, now)).toBeNull();
  });

  it("returns null for hot notes", () => {
    const mgr = new TierManager(makeConfig());
    const now = Date.now();

    const note = makeFrontmatter({ tier: "hot" });

    expect(mgr.shouldPromote(note, now)).toBeNull();
  });
});

// ── shouldArchive ────────────────────────────────────────────────────

describe("TierManager.shouldArchive", () => {
  it("archives old notes with low access count", () => {
    const config = makeConfig({ coldArchiveAge: 30 * DAY });
    const mgr = new TierManager(config);
    const now = Date.now();

    const note = makeFrontmatter({
      tier: "cold",
      last_accessed: new Date(now - 60 * DAY).toISOString(),
      access_count: 1,
    });

    expect(mgr.shouldArchive(note, now)).toBe(true);
  });

  it("does not archive notes with high access count", () => {
    const config = makeConfig({ coldArchiveAge: 30 * DAY });
    const mgr = new TierManager(config);
    const now = Date.now();

    const note = makeFrontmatter({
      tier: "cold",
      last_accessed: new Date(now - 60 * DAY).toISOString(),
      access_count: 5,
    });

    expect(mgr.shouldArchive(note, now)).toBe(false);
  });

  it("does not archive recently accessed notes", () => {
    const config = makeConfig({ coldArchiveAge: 30 * DAY });
    const mgr = new TierManager(config);
    const now = Date.now();

    const note = makeFrontmatter({
      tier: "cold",
      last_accessed: new Date(now - 10 * DAY).toISOString(),
      access_count: 1,
    });

    expect(mgr.shouldArchive(note, now)).toBe(false);
  });
});

// ── isHotFull ────────────────────────────────────────────────────────

describe("TierManager.isHotFull", () => {
  it("returns true when count >= hotMaxNotes", () => {
    const mgr = new TierManager(makeConfig({ hotMaxNotes: 20 }));
    expect(mgr.isHotFull(20)).toBe(true);
    expect(mgr.isHotFull(25)).toBe(true);
  });

  it("returns false when count < hotMaxNotes", () => {
    const mgr = new TierManager(makeConfig({ hotMaxNotes: 20 }));
    expect(mgr.isHotFull(10)).toBe(false);
    expect(mgr.isHotFull(19)).toBe(false);
  });
});

// ── recommendTier ────────────────────────────────────────────────────

describe("TierManager.recommendTier", () => {
  it("recommends hot for recently created note", () => {
    const config = makeConfig({ hotMaxAge: 2 * HOUR });
    const mgr = new TierManager(config);
    const now = Date.now();

    const note = makeFrontmatter({
      created: new Date(now - 1 * HOUR).toISOString(),
      last_accessed: new Date(now - 1 * HOUR).toISOString(),
    });

    expect(mgr.recommendTier(note, now)).toBe("hot");
  });

  it("recommends warm for recently accessed but not recently created", () => {
    const config = makeConfig({ hotMaxAge: 2 * HOUR, warmMaxAge: 7 * DAY });
    const mgr = new TierManager(config);
    const now = Date.now();

    const note = makeFrontmatter({
      created: new Date(now - 5 * DAY).toISOString(),
      last_accessed: new Date(now - 2 * DAY).toISOString(),
    });

    expect(mgr.recommendTier(note, now)).toBe("warm");
  });

  it("recommends cold for old notes within coldArchiveAge", () => {
    const config = makeConfig({
      hotMaxAge: 2 * HOUR,
      warmMaxAge: 7 * DAY,
      coldArchiveAge: 30 * DAY,
    });
    const mgr = new TierManager(config);
    const now = Date.now();

    const note = makeFrontmatter({
      created: new Date(now - 20 * DAY).toISOString(),
      last_accessed: new Date(now - 15 * DAY).toISOString(),
    });

    expect(mgr.recommendTier(note, now)).toBe("cold");
  });

  it("recommends archive for very old notes with low access count", () => {
    const config = makeConfig({ coldArchiveAge: 30 * DAY });
    const mgr = new TierManager(config);
    const now = Date.now();

    const note = makeFrontmatter({
      created: new Date(now - 60 * DAY).toISOString(),
      last_accessed: new Date(now - 60 * DAY).toISOString(),
      access_count: 1,
    });

    expect(mgr.recommendTier(note, now)).toBe("archive");
  });

  it("keeps frequently accessed old notes as cold (not archive)", () => {
    const config = makeConfig({ coldArchiveAge: 30 * DAY });
    const mgr = new TierManager(config);
    const now = Date.now();

    const note = makeFrontmatter({
      created: new Date(now - 60 * DAY).toISOString(),
      last_accessed: new Date(now - 60 * DAY).toISOString(),
      access_count: 5,
    });

    expect(mgr.recommendTier(note, now)).toBe("cold");
  });
});
