import { describe, it, expect, beforeEach, afterEach } from "vitest";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import * as os from "node:os";
import { Vault } from "../src/vault/vault.js";
import { forget } from "../src/ops/forget.js";
import type { Note, NoteFrontmatter } from "../src/vault/note.js";
import type { MemoryzConfig } from "../src/config.js";

// ── Helpers ──────────────────────────────────────────────────────────

let tmpDir: string;

const DAY = 24 * 60 * 60 * 1000;

function makeConfig(vaultPath: string): MemoryzConfig {
  return {
    vaultPath,
    summarizer: { provider: "rules" },
    tiers: {
      hotMaxAge: 7_200_000,
      warmMaxAge: 604_800_000,       // 7 days
      coldArchiveAge: 2_592_000_000, // 30 days
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
    tier: "cold",
    created: "2024-01-01T00:00:00.000Z",
    last_accessed: "2024-01-01T00:00:00.000Z",
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
  tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "memoryz-forget-test-"));
});

afterEach(async () => {
  await fs.rm(tmpDir, { recursive: true, force: true });
});

// ── Tests ────────────────────────────────────────────────────────────

describe("forget", () => {
  it("archives notes that are old + low access + no links", async () => {
    const vault = new Vault(makeConfig(tmpDir));
    await vault.init();

    // Create a cold note that is very old and has low access count
    await vault.createNote(
      makeNote({
        frontmatter: makeFrontmatter({
          id: "old1",
          tier: "cold",
          access_count: 1,
          created: "2023-01-01T00:00:00.000Z",
          last_accessed: "2023-01-01T00:00:00.000Z",
        }),
        title: "Old Stale Note",
        body: "This note is very old and rarely accessed.",
      }),
    );

    const result = await forget(vault, makeConfig(tmpDir));
    expect(result.archived).toBe(1);

    // Should be in archive now
    const archiveNotes = await vault.listNotes("archive");
    expect(archiveNotes).toHaveLength(1);

    // Should not be in cold anymore
    const coldNotes = await vault.listNotes("cold");
    expect(coldNotes).toHaveLength(0);
  });

  it("does NOT archive notes with incoming links", async () => {
    const vault = new Vault(makeConfig(tmpDir));
    await vault.init();

    // Create a cold note that would normally be archived
    await vault.createNote(
      makeNote({
        frontmatter: makeFrontmatter({
          id: "linked1",
          tier: "cold",
          access_count: 0,
          created: "2023-01-01T00:00:00.000Z",
          last_accessed: "2023-01-01T00:00:00.000Z",
        }),
        title: "Linked Note",
        body: "This note is linked from another note.",
      }),
    );

    // Create a hot note that links to the cold note
    await vault.createNote(
      makeNote({
        frontmatter: makeFrontmatter({
          id: "linker1",
          tier: "hot",
          access_count: 5,
          created: new Date().toISOString(),
          last_accessed: new Date().toISOString(),
        }),
        title: "Active Note",
        body: "Referencing [[Linked Note]] here.",
      }),
    );

    const result = await forget(vault, makeConfig(tmpDir));
    expect(result.archived).toBe(0);

    // The cold note should still be in cold
    const coldNotes = await vault.listNotes("cold");
    expect(coldNotes).toHaveLength(1);
    expect(coldNotes[0].title).toBe("Linked Note");
  });

  it("does NOT archive notes accessed recently", async () => {
    const vault = new Vault(makeConfig(tmpDir));
    await vault.init();

    // Create a cold note that was accessed recently (within coldArchiveAge)
    const recentDate = new Date(Date.now() - 10 * DAY).toISOString(); // 10 days ago
    await vault.createNote(
      makeNote({
        frontmatter: makeFrontmatter({
          id: "recent1",
          tier: "cold",
          access_count: 1,
          created: "2023-01-01T00:00:00.000Z",
          last_accessed: recentDate,
        }),
        title: "Recently Accessed",
        body: "This note was accessed recently.",
      }),
    );

    const result = await forget(vault, makeConfig(tmpDir));
    expect(result.archived).toBe(0);

    const coldNotes = await vault.listNotes("cold");
    expect(coldNotes).toHaveLength(1);
  });

  it("detects and merges duplicate notes (similar titles/entities)", async () => {
    const vault = new Vault(makeConfig(tmpDir));
    await vault.init();

    // Create two warm notes with very similar titles and overlapping entities
    await vault.createNote(
      makeNote({
        frontmatter: makeFrontmatter({
          id: "dup1",
          tier: "warm",
          access_count: 5,
          entities: ["server-alpha", "docker"],
          created: "2025-01-01T00:00:00.000Z",
          last_accessed: new Date(Date.now() - 1 * DAY).toISOString(),
        }),
        title: "Docker Setup on server-alpha",
        body: "Primary note about docker setup.",
      }),
    );
    await vault.createNote(
      makeNote({
        frontmatter: makeFrontmatter({
          id: "dup2",
          tier: "warm",
          access_count: 2,
          entities: ["server-alpha", "docker"],
          created: "2025-01-02T00:00:00.000Z",
          last_accessed: new Date(Date.now() - 2 * DAY).toISOString(),
        }),
        title: "Docker Setup on server-alpha",
        body: "Duplicate note about docker setup.",
      }),
    );

    const result = await forget(vault, makeConfig(tmpDir));
    expect(result.duplicatesMerged).toBe(1);

    // One note should remain in warm, the duplicate archived
    const warmNotes = await vault.listNotes("warm");
    expect(warmNotes).toHaveLength(1);
    // The primary (higher access_count) should be the one remaining
    expect(warmNotes[0].body).toContain("Primary note");
    expect(warmNotes[0].body).toContain("Duplicate note");

    const archiveNotes = await vault.listNotes("archive");
    expect(archiveNotes).toHaveLength(1);
  });

  it("returns correct ForgetResult counts", async () => {
    const vault = new Vault(makeConfig(tmpDir));
    await vault.init();

    // 1 archivable cold note
    await vault.createNote(
      makeNote({
        frontmatter: makeFrontmatter({
          id: "arch1",
          tier: "cold",
          access_count: 0,
          created: "2023-01-01T00:00:00.000Z",
          last_accessed: "2023-01-01T00:00:00.000Z",
        }),
        title: "Archivable Note",
        body: "Will be archived.",
      }),
    );

    // 2 warm duplicates
    await vault.createNote(
      makeNote({
        frontmatter: makeFrontmatter({
          id: "wdup1",
          tier: "warm",
          access_count: 3,
          entities: ["nginx", "server"],
          created: "2025-01-01T00:00:00.000Z",
          last_accessed: new Date(Date.now() - 1 * DAY).toISOString(),
        }),
        title: "Nginx Server Config",
        body: "Primary nginx config.",
      }),
    );
    await vault.createNote(
      makeNote({
        frontmatter: makeFrontmatter({
          id: "wdup2",
          tier: "warm",
          access_count: 1,
          entities: ["nginx", "server"],
          created: "2025-01-02T00:00:00.000Z",
          last_accessed: new Date(Date.now() - 2 * DAY).toISOString(),
        }),
        title: "Nginx Server Config",
        body: "Duplicate nginx config.",
      }),
    );

    const result = await forget(vault, makeConfig(tmpDir));
    expect(result.archived).toBe(1);
    expect(result.duplicatesMerged).toBe(1);
  });

  it("returns zero counts when nothing to forget", async () => {
    const vault = new Vault(makeConfig(tmpDir));
    await vault.init();

    const result = await forget(vault, makeConfig(tmpDir));
    expect(result.archived).toBe(0);
    expect(result.duplicatesMerged).toBe(0);
  });
});
