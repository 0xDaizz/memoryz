import { describe, it, expect, beforeEach, afterEach } from "vitest";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import * as os from "node:os";
import { Vault } from "../src/vault/vault.js";
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
  tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "memoryz-vault-test-"));
});

afterEach(async () => {
  await fs.rm(tmpDir, { recursive: true, force: true });
});

// ── Tests ────────────────────────────────────────────────────────────

describe("Vault", () => {
  describe("init()", () => {
    it("creates tier directories and _index", async () => {
      const vault = new Vault(makeConfig(tmpDir));
      await vault.init();

      for (const tier of ["hot", "warm", "cold", "archive"]) {
        const stat = await fs.stat(path.join(tmpDir, tier));
        expect(stat.isDirectory()).toBe(true);
      }
      const indexStat = await fs.stat(path.join(tmpDir, "_index"));
      expect(indexStat.isDirectory()).toBe(true);
    });
  });

  describe("createNote() + readNote() roundtrip", () => {
    it("creates and reads back a note", async () => {
      const vault = new Vault(makeConfig(tmpDir));
      await vault.init();

      const note = makeNote({
        frontmatter: makeFrontmatter({
          entities: ["server-alpha"],
          tags: ["network"],
        }),
        title: "Network Setup",
        body: "Setting up the network.",
      });

      const filePath = await vault.createNote(note);
      expect(filePath).toContain("hot");
      expect(filePath).toContain("network-setup.md");

      const read = await vault.readNote(filePath);
      expect(read.title).toBe("Network Setup");
      expect(read.body.trim()).toBe("Setting up the network.");
      expect(read.frontmatter.entities).toEqual(["server-alpha"]);
    });
  });

  describe("updateNote()", () => {
    it("modifies content of an existing note", async () => {
      const vault = new Vault(makeConfig(tmpDir));
      await vault.init();

      const note = makeNote({ title: "Original Title", body: "Original body." });
      const filePath = await vault.createNote(note);

      const readNote = await vault.readNote(filePath);
      readNote.body = "Updated body content.";
      await vault.updateNote(filePath, readNote);

      const updated = await vault.readNote(filePath);
      expect(updated.body.trim()).toBe("Updated body content.");
    });
  });

  describe("deleteNote()", () => {
    it("removes a note file", async () => {
      const vault = new Vault(makeConfig(tmpDir));
      await vault.init();

      const note = makeNote();
      const filePath = await vault.createNote(note);

      await vault.deleteNote(filePath);

      await expect(fs.access(filePath)).rejects.toThrow();
    });
  });

  describe("moveNote()", () => {
    it("moves a note from hot to warm", async () => {
      const vault = new Vault(makeConfig(tmpDir));
      await vault.init();

      const note = makeNote({
        frontmatter: makeFrontmatter({ tier: "hot" }),
        title: "Move Me",
      });
      const hotPath = await vault.createNote(note);

      const warmPath = await vault.moveNote(hotPath, "warm");
      expect(warmPath).toContain("warm");

      // Old file should be gone
      await expect(fs.access(hotPath)).rejects.toThrow();

      // New file should exist with updated tier
      const moved = await vault.readNote(warmPath);
      expect(moved.frontmatter.tier).toBe("warm");
    });

    it("moves a note to archive", async () => {
      const vault = new Vault(makeConfig(tmpDir));
      await vault.init();

      const note = makeNote({
        frontmatter: makeFrontmatter({ tier: "cold" }),
        title: "Archive Me",
      });
      const coldPath = await vault.createNote(note);
      const archivePath = await vault.moveNote(coldPath, "archive");
      expect(archivePath).toContain("archive");

      await expect(fs.access(coldPath)).rejects.toThrow();
    });
  });

  describe("listNotes()", () => {
    it("returns correct notes per tier", async () => {
      const vault = new Vault(makeConfig(tmpDir));
      await vault.init();

      // Create 2 hot notes and 1 warm note
      await vault.createNote(
        makeNote({
          frontmatter: makeFrontmatter({ id: "h1", tier: "hot" }),
          title: "Hot One",
        }),
      );
      await vault.createNote(
        makeNote({
          frontmatter: makeFrontmatter({ id: "h2", tier: "hot" }),
          title: "Hot Two",
        }),
      );
      await vault.createNote(
        makeNote({
          frontmatter: makeFrontmatter({ id: "w1", tier: "warm" }),
          title: "Warm One",
        }),
      );

      const hotNotes = await vault.listNotes("hot");
      expect(hotNotes).toHaveLength(2);

      const warmNotes = await vault.listNotes("warm");
      expect(warmNotes).toHaveLength(1);

      const coldNotes = await vault.listNotes("cold");
      expect(coldNotes).toHaveLength(0);
    });

    it("skips INDEX.md files", async () => {
      const vault = new Vault(makeConfig(tmpDir));
      await vault.init();

      // Write an INDEX.md manually
      await fs.writeFile(path.join(tmpDir, "hot", "INDEX.md"), "index content");

      await vault.createNote(
        makeNote({ frontmatter: makeFrontmatter({ tier: "hot" }), title: "Real Note" }),
      );

      const notes = await vault.listNotes("hot");
      expect(notes).toHaveLength(1);
      expect(notes[0].title).toBe("Real Note");
    });
  });

  describe("rebuildHotIndex()", () => {
    it("generates correct INDEX.md content", async () => {
      const vault = new Vault(makeConfig(tmpDir));
      await vault.init();

      await vault.createNote(
        makeNote({
          frontmatter: makeFrontmatter({
            tier: "hot",
            created: "2025-06-15T14:30:00.000Z",
          }),
          title: "Afternoon Note",
        }),
      );
      await vault.createNote(
        makeNote({
          frontmatter: makeFrontmatter({
            id: "id2",
            tier: "hot",
            created: "2025-06-15T09:15:00.000Z",
          }),
          title: "Morning Note",
        }),
      );

      await vault.rebuildHotIndex();
      const indexContent = await vault.readHotIndex();

      // Should be sorted by created descending (afternoon first)
      expect(indexContent).toContain("Afternoon Note");
      expect(indexContent).toContain("Morning Note");
      const afternoonIdx = indexContent.indexOf("Afternoon Note");
      const morningIdx = indexContent.indexOf("Morning Note");
      expect(afternoonIdx).toBeLessThan(morningIdx);
    });

    it("generates empty content for no notes", async () => {
      const vault = new Vault(makeConfig(tmpDir));
      await vault.init();

      await vault.rebuildHotIndex();
      const indexContent = await vault.readHotIndex();
      expect(indexContent).toBe("");
    });
  });

  describe("rebuildIndexes()", () => {
    it("builds entities.json and tags.json", async () => {
      const vault = new Vault(makeConfig(tmpDir));
      await vault.init();

      await vault.createNote(
        makeNote({
          frontmatter: makeFrontmatter({
            id: "n1",
            tier: "hot",
            entities: ["server-alpha", "server-beta"],
            tags: ["network", "setup"],
          }),
          title: "Note One",
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
        }),
      );

      await vault.rebuildIndexes();

      const entityIndex = await vault.readEntityIndex();
      expect(entityIndex["server-alpha"]).toHaveLength(2);
      expect(entityIndex["server-beta"]).toHaveLength(1);

      const tagIndex = await vault.readTagIndex();
      expect(tagIndex["network"]).toHaveLength(1);
      expect(tagIndex["setup"]).toHaveLength(1);
      expect(tagIndex["deploy"]).toHaveLength(1);
    });
  });

  describe("logAccess() + getAccessLog()", () => {
    it("logs and retrieves access entries", async () => {
      const vault = new Vault(makeConfig(tmpDir));
      await vault.init();

      await vault.logAccess("/path/note1.md", "sess-1");
      await vault.logAccess("/path/note2.md", "sess-2");

      const log = await vault.getAccessLog();
      expect(log).toHaveLength(2);
      // Newest first
      expect(log[0].file).toBe("/path/note2.md");
      expect(log[0].session).toBe("sess-2");
      expect(log[1].file).toBe("/path/note1.md");
    });

    it("respects limit parameter", async () => {
      const vault = new Vault(makeConfig(tmpDir));
      await vault.init();

      await vault.logAccess("/a.md");
      await vault.logAccess("/b.md");
      await vault.logAccess("/c.md");

      const log = await vault.getAccessLog(2);
      expect(log).toHaveLength(2);
      expect(log[0].file).toBe("/c.md");
    });

    it("returns empty array when no log exists", async () => {
      const vault = new Vault(makeConfig(tmpDir));
      await vault.init();

      const log = await vault.getAccessLog();
      expect(log).toEqual([]);
    });
  });

  describe("stats()", () => {
    it("returns correct counts", async () => {
      const vault = new Vault(makeConfig(tmpDir));
      await vault.init();

      await vault.createNote(
        makeNote({ frontmatter: makeFrontmatter({ id: "a", tier: "hot" }), title: "A" }),
      );
      await vault.createNote(
        makeNote({ frontmatter: makeFrontmatter({ id: "b", tier: "hot" }), title: "B" }),
      );
      await vault.createNote(
        makeNote({ frontmatter: makeFrontmatter({ id: "c", tier: "warm" }), title: "C" }),
      );

      const s = await vault.stats();
      expect(s.hot).toBe(2);
      expect(s.warm).toBe(1);
      expect(s.cold).toBe(0);
      expect(s.archive).toBe(0);
      expect(s.total).toBe(3);
    });
  });
});
