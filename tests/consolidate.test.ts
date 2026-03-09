import { describe, it, expect, beforeEach, afterEach } from "vitest";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import * as os from "node:os";
import { Vault } from "../src/vault/vault.js";
import type { MemoryzConfig } from "../src/config.js";
import type { NoteFrontmatter, Note } from "../src/vault/note.js";
import { consolidate, mergeNotes } from "../src/ops/consolidate.js";

// ── Helpers ──────────────────────────────────────────────────────────

const HOUR = 60 * 60 * 1000;
const DAY = 24 * HOUR;

let tmpDir: string;

function makeConfig(
  vaultPath: string,
  tierOverrides?: Partial<MemoryzConfig["tiers"]>,
): MemoryzConfig {
  return {
    vaultPath,
    summarizer: { provider: "rules" },
    tiers: {
      hotMaxAge: 2 * HOUR,
      warmMaxAge: 7 * DAY,
      coldArchiveAge: 30 * DAY,
      hotMaxNotes: 50,
      ...tierOverrides,
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

function makeNote(overrides?: Partial<Note>): Note {
  return {
    frontmatter: makeFrontmatter(),
    title: "Test Note",
    body: "Test body content.",
    ...overrides,
  };
}

beforeEach(async () => {
  tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "memoryz-consolidate-test-"));
});

afterEach(async () => {
  await fs.rm(tmpDir, { recursive: true, force: true });
});

// ── mergeNotes (unit) ────────────────────────────────────────────────

describe("mergeNotes", () => {
  it("concatenates bodies with separator", () => {
    const primary = makeNote({
      frontmatter: makeFrontmatter({ id: "p1" }),
      title: "Primary",
      body: "Primary body.",
    });
    const secondary = makeNote({
      frontmatter: makeFrontmatter({ id: "s1" }),
      title: "Secondary",
      body: "Secondary body.",
    });

    const merged = mergeNotes(primary, secondary);
    expect(merged.body).toContain("Primary body.");
    expect(merged.body).toContain("---");
    expect(merged.body).toContain("Secondary body.");
  });

  it("unions entities and tags", () => {
    const primary = makeNote({
      frontmatter: makeFrontmatter({
        entities: ["A", "B"],
        tags: ["x", "y"],
      }),
    });
    const secondary = makeNote({
      frontmatter: makeFrontmatter({
        entities: ["B", "C"],
        tags: ["y", "z"],
      }),
    });

    const merged = mergeNotes(primary, secondary);
    expect(merged.frontmatter.entities).toEqual(
      expect.arrayContaining(["A", "B", "C"]),
    );
    expect(merged.frontmatter.tags).toEqual(
      expect.arrayContaining(["x", "y", "z"]),
    );
  });

  it("sums access_count", () => {
    const primary = makeNote({
      frontmatter: makeFrontmatter({ access_count: 3 }),
    });
    const secondary = makeNote({
      frontmatter: makeFrontmatter({ access_count: 5 }),
    });

    const merged = mergeNotes(primary, secondary);
    expect(merged.frontmatter.access_count).toBe(8);
  });

  it("keeps newer timestamps", () => {
    const primary = makeNote({
      frontmatter: makeFrontmatter({
        created: "2025-01-01T00:00:00.000Z",
        last_accessed: "2025-01-05T00:00:00.000Z",
      }),
    });
    const secondary = makeNote({
      frontmatter: makeFrontmatter({
        created: "2025-01-03T00:00:00.000Z",
        last_accessed: "2025-01-02T00:00:00.000Z",
      }),
    });

    const merged = mergeNotes(primary, secondary);
    expect(merged.frontmatter.created).toBe("2025-01-01T00:00:00.000Z");
    expect(merged.frontmatter.last_accessed).toBe("2025-01-05T00:00:00.000Z");
  });

  it("preserves primary title and filePath", () => {
    const primary = makeNote({
      title: "Primary Title",
      filePath: "/vault/warm/primary.md",
    });
    const secondary = makeNote({ title: "Secondary Title" });

    const merged = mergeNotes(primary, secondary);
    expect(merged.title).toBe("Primary Title");
    expect(merged.filePath).toBe("/vault/warm/primary.md");
  });
});

// ── consolidate() integration ────────────────────────────────────────

describe("consolidate() integration", () => {
  it("moves hot notes to warm after hotMaxAge", async () => {
    const now = Date.now();
    const config = makeConfig(tmpDir, { hotMaxAge: 2 * HOUR });
    const vault = new Vault(config);
    await vault.init();

    // Create a hot note with old last_accessed (3 hours ago)
    await vault.createNote(
      makeNote({
        frontmatter: makeFrontmatter({
          id: "old-hot",
          tier: "hot",
          created: new Date(now - 3 * HOUR).toISOString(),
          last_accessed: new Date(now - 3 * HOUR).toISOString(),
        }),
        title: "Old Hot Note",
        body: "This note should move to warm.",
      }),
    );

    // Create a hot note that should stay (1 hour ago)
    await vault.createNote(
      makeNote({
        frontmatter: makeFrontmatter({
          id: "new-hot",
          tier: "hot",
          created: new Date(now - 1 * HOUR).toISOString(),
          last_accessed: new Date(now - 1 * HOUR).toISOString(),
        }),
        title: "Recent Hot Note",
        body: "This note should remain in hot.",
      }),
    );

    const result = await consolidate(vault, config);

    expect(result.movedHotToWarm).toBe(1);

    const hotNotes = await vault.listNotes("hot");
    expect(hotNotes).toHaveLength(1);
    expect(hotNotes[0].title).toBe("Recent Hot Note");

    const warmNotes = await vault.listNotes("warm");
    expect(warmNotes).toHaveLength(1);
    expect(warmNotes[0].title).toBe("Old Hot Note");
  });

  it("merges duplicate warm notes with overlapping entities", async () => {
    const now = Date.now();
    const config = makeConfig(tmpDir, { hotMaxAge: 2 * HOUR });
    const vault = new Vault(config);
    await vault.init();

    // Create an existing warm note
    await vault.createNote(
      makeNote({
        frontmatter: makeFrontmatter({
          id: "warm1",
          tier: "warm",
          entities: ["server-alpha", "wireguard"],
          tags: ["network"],
        }),
        title: "Network Config",
        body: "Existing warm note about network.",
      }),
    );

    // Create a hot note with overlapping entities (should merge into warm on demote)
    await vault.createNote(
      makeNote({
        frontmatter: makeFrontmatter({
          id: "hot-dup",
          tier: "hot",
          created: new Date(now - 3 * HOUR).toISOString(),
          last_accessed: new Date(now - 3 * HOUR).toISOString(),
          entities: ["server-alpha", "wireguard"],
          tags: ["vpn"],
        }),
        title: "Tailscale Update",
        body: "Updated wireguard config.",
      }),
    );

    const result = await consolidate(vault, config);

    expect(result.movedHotToWarm).toBe(1);
    expect(result.merged).toBe(1);

    const warmNotes = await vault.listNotes("warm");
    expect(warmNotes).toHaveLength(1);
    // Merged note should have combined entities
    const mergedEntities = warmNotes[0].frontmatter.entities;
    expect(mergedEntities).toEqual(expect.arrayContaining(["server-alpha", "wireguard"]));
  });

  it("promotes cold notes to warm on recent access", async () => {
    const now = Date.now();
    const config = makeConfig(tmpDir);
    const vault = new Vault(config);
    await vault.init();

    // Create a cold note
    const coldNotePath = await vault.createNote(
      makeNote({
        frontmatter: makeFrontmatter({
          id: "cold1",
          tier: "cold",
          created: new Date(now - 20 * DAY).toISOString(),
          last_accessed: new Date(now - 20 * DAY).toISOString(),
        }),
        title: "Cold Note",
        body: "This cold note was recently accessed.",
      }),
    );

    // Log a recent access (within 1 hour, per consolidate logic)
    await vault.logAccess(coldNotePath);

    const result = await consolidate(vault, config);

    expect(result.promotedColdToWarm).toBe(1);

    const coldNotes = await vault.listNotes("cold");
    expect(coldNotes).toHaveLength(0);

    const warmNotes = await vault.listNotes("warm");
    expect(warmNotes).toHaveLength(1);
    expect(warmNotes[0].title).toBe("Cold Note");
  });

  it("rebuilds indexes after consolidation", async () => {
    const config = makeConfig(tmpDir);
    const vault = new Vault(config);
    await vault.init();

    await vault.createNote(
      makeNote({
        frontmatter: makeFrontmatter({
          id: "n1",
          tier: "warm",
          entities: ["server-alpha"],
          tags: ["setup"],
        }),
        title: "Setup Note",
        body: "Body of setup note.",
      }),
    );

    await consolidate(vault, config);

    const entityIndex = await vault.readEntityIndex();
    expect(entityIndex["server-alpha"]).toBeDefined();

    const tagIndex = await vault.readTagIndex();
    expect(tagIndex["setup"]).toBeDefined();
  });

  it("returns zero counts when no work needed", async () => {
    const config = makeConfig(tmpDir);
    const vault = new Vault(config);
    await vault.init();

    const result = await consolidate(vault, config);

    expect(result.movedHotToWarm).toBe(0);
    expect(result.movedWarmToCold).toBe(0);
    expect(result.promotedColdToWarm).toBe(0);
    expect(result.merged).toBe(0);
  });
});
