import { describe, it, expect, beforeEach, afterEach } from "vitest";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import * as os from "node:os";
import { Vault } from "../src/vault/vault.js";
import {
  searchByEntity,
  searchByTag,
  searchByText,
  search,
} from "../src/vault/search.js";
import type { Note, NoteFrontmatter } from "../src/vault/note.js";
import type { MemoryzConfig } from "../src/config.js";

// ── Helpers ──────────────────────────────────────────────────────────

let tmpDir: string;

function makeConfig(vaultPath: string): MemoryzConfig {
  return {
    vaultPath,
    summarizer: { provider: "rules" },
    tiers: {
      hotMaxAge: 7_200_000,
      warmMaxAge: 604_800_000,
      coldArchiveAge: 2_592_000_000,
      hotMaxNotes: 50,
    },
    recall: { enabled: true, maxPointers: 5, maxTokens: 800 },
    capture: { enabled: true, minLength: 20, maxPerTurn: 3 },
    consolidateIntervalMs: 1_800_000,
    accessControl: false,
  };
}

function makeFrontmatter(overrides?: Partial<NoteFrontmatter>): NoteFrontmatter {
  return {
    id: "abcd1234",
    type: "fact",
    tier: "hot",
    created: "2025-01-01T00:00:00.000Z",
    last_accessed: "2025-01-01T00:00:00.000Z",
    access_count: 0,
    source_session: "test-session",
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
    body: "This is the body.",
    ...overrides,
  };
}

beforeEach(async () => {
  tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "memoryz-search-test-"));
});

afterEach(async () => {
  await fs.rm(tmpDir, { recursive: true, force: true });
});

// ── Tests ────────────────────────────────────────────────────────────

describe("searchByEntity", () => {
  it("matches via entity index and scores correctly", async () => {
    const vault = new Vault(makeConfig(tmpDir));
    await vault.init();

    await vault.createNote(
      makeNote({
        frontmatter: makeFrontmatter({
          id: "n1",
          tier: "hot",
          entities: ["server-alpha", "server-beta"],
          tags: ["network"],
        }),
        title: "Note One",
        body: "About server-alpha and server-beta",
      }),
    );
    await vault.createNote(
      makeNote({
        frontmatter: makeFrontmatter({
          id: "n2",
          tier: "warm",
          entities: ["server-alpha"],
          tags: ["deploy"],
        }),
        title: "Note Two",
        body: "About server-alpha only",
      }),
    );

    await vault.rebuildIndexes();

    // Search for both entities — Note One should score higher
    const results = await searchByEntity(vault, ["server-alpha", "server-beta"]);
    expect(results).toHaveLength(2);
    expect(results[0].note.title).toBe("Note One");
    expect(results[0].score).toBe(1); // 2/2 matched
    expect(results[0].matchType).toBe("entity");
    expect(results[1].note.title).toBe("Note Two");
    expect(results[1].score).toBe(0.5); // 1/2 matched
  });

  it("returns empty array for empty entities", async () => {
    const vault = new Vault(makeConfig(tmpDir));
    await vault.init();
    const results = await searchByEntity(vault, []);
    expect(results).toEqual([]);
  });
});

describe("searchByTag", () => {
  it("matches via tag index", async () => {
    const vault = new Vault(makeConfig(tmpDir));
    await vault.init();

    await vault.createNote(
      makeNote({
        frontmatter: makeFrontmatter({
          id: "n1",
          tier: "hot",
          tags: ["network", "setup"],
        }),
        title: "Network Setup",
        body: "Setting up network",
      }),
    );
    await vault.createNote(
      makeNote({
        frontmatter: makeFrontmatter({
          id: "n2",
          tier: "warm",
          tags: ["deploy"],
        }),
        title: "Deploy Note",
        body: "Deployment steps",
      }),
    );

    await vault.rebuildIndexes();

    const results = await searchByTag(vault, ["network", "setup"]);
    expect(results).toHaveLength(1);
    expect(results[0].note.title).toBe("Network Setup");
    expect(results[0].score).toBe(1); // 2/2 matched
    expect(results[0].matchType).toBe("tag");
  });

  it("returns empty array for empty tags", async () => {
    const vault = new Vault(makeConfig(tmpDir));
    await vault.init();
    const results = await searchByTag(vault, []);
    expect(results).toEqual([]);
  });
});

describe("searchByText", () => {
  it("finds notes containing query words and scores by word overlap", async () => {
    const vault = new Vault(makeConfig(tmpDir));
    await vault.init();

    await vault.createNote(
      makeNote({
        frontmatter: makeFrontmatter({ id: "n1", tier: "hot" }),
        title: "Docker Setup Guide",
        body: "Install docker and configure nginx proxy",
      }),
    );
    await vault.createNote(
      makeNote({
        frontmatter: makeFrontmatter({ id: "n2", tier: "warm" }),
        title: "Random Note",
        body: "Nothing related here",
      }),
    );

    const results = await searchByText(vault, "docker nginx");
    expect(results).toHaveLength(1);
    expect(results[0].note.title).toBe("Docker Setup Guide");
    expect(results[0].score).toBe(1); // 2/2 words matched
    expect(results[0].matchType).toBe("fulltext");
  });

  it("returns empty array for empty query", async () => {
    const vault = new Vault(makeConfig(tmpDir));
    await vault.init();
    const results = await searchByText(vault, "");
    expect(results).toEqual([]);
  });

  it("returns empty array when no notes match", async () => {
    const vault = new Vault(makeConfig(tmpDir));
    await vault.init();

    await vault.createNote(
      makeNote({
        frontmatter: makeFrontmatter({ id: "n1", tier: "hot" }),
        title: "Some Note",
        body: "Completely unrelated content",
      }),
    );

    const results = await searchByText(vault, "xyz123nonexistent");
    expect(results).toEqual([]);
  });
});

describe("search (combined)", () => {
  it("merges results with weights, deduplicates, and respects limit", async () => {
    const vault = new Vault(makeConfig(tmpDir));
    await vault.init();

    await vault.createNote(
      makeNote({
        frontmatter: makeFrontmatter({
          id: "n1",
          tier: "hot",
          entities: ["server-alpha"],
          tags: ["docker"],
        }),
        title: "Docker on server-alpha",
        body: "Installed docker on server-alpha machine",
      }),
    );
    await vault.createNote(
      makeNote({
        frontmatter: makeFrontmatter({
          id: "n2",
          tier: "warm",
          entities: [],
          tags: ["network"],
        }),
        title: "Network Config",
        body: "Network configuration guide",
      }),
    );

    await vault.rebuildIndexes();

    const results = await search(vault, "docker", {
      entities: ["server-alpha"],
      tags: ["docker"],
      limit: 5,
    });

    // Note 1 should appear (matches entity + tag + text)
    expect(results.length).toBeGreaterThanOrEqual(1);
    expect(results[0].note.title).toBe("Docker on server-alpha");
    // Score should combine entity (1.0), tag (0.7), and text (0.5) weights
    expect(results[0].score).toBeGreaterThan(1.0);
  });

  it("respects limit parameter", async () => {
    const vault = new Vault(makeConfig(tmpDir));
    await vault.init();

    for (let i = 0; i < 5; i++) {
      await vault.createNote(
        makeNote({
          frontmatter: makeFrontmatter({
            id: `n${i}`,
            tier: "hot",
            tags: ["common"],
          }),
          title: `Note ${i}`,
          body: `Content about common topic ${i}`,
        }),
      );
    }

    await vault.rebuildIndexes();

    const results = await search(vault, "common", {
      tags: ["common"],
      limit: 2,
    });
    expect(results).toHaveLength(2);
  });

  it("returns empty array for empty query with no entities/tags", async () => {
    const vault = new Vault(makeConfig(tmpDir));
    await vault.init();
    const results = await search(vault, "");
    expect(results).toEqual([]);
  });
});
