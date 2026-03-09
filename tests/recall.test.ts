import { describe, it, expect, beforeEach, afterEach } from "vitest";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import * as os from "node:os";
import { Vault } from "../src/vault/vault.js";
import type { MemoryzConfig } from "../src/config.js";
import type { NoteFrontmatter, Note } from "../src/vault/note.js";
import { recall, formatMemoryzContext, type RecallPointer } from "../src/ops/recall.js";

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
  tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "memoryz-recall-test-"));
});

afterEach(async () => {
  await fs.rm(tmpDir, { recursive: true, force: true });
});

// ── recall() ─────────────────────────────────────────────────────────

describe("recall", () => {
  it("returns pointers for matching content via fulltext", async () => {
    const config = makeConfig(tmpDir);
    const vault = new Vault(config);
    await vault.init();

    await vault.createNote(
      makeNote({
        frontmatter: makeFrontmatter({
          id: "n1",
          tier: "hot",
          entities: ["server-alpha"],
          tags: ["network"],
        }),
        title: "Network Setup on server-alpha",
        body: "Configured wireguard on server-alpha for VPN access.",
      }),
    );

    // Rebuild indexes so search can find entity/tag matches
    await vault.rebuildIndexes();

    const pointers = await recall(vault, "server-alpha network setup", config);
    expect(pointers.length).toBeGreaterThan(0);
    expect(pointers[0].title).toBe("Network Setup on server-alpha");
  });

  it("returns empty array for unmatched query", async () => {
    const config = makeConfig(tmpDir);
    const vault = new Vault(config);
    await vault.init();

    await vault.createNote(
      makeNote({
        frontmatter: makeFrontmatter({ id: "n1", tier: "hot" }),
        title: "Unrelated Note",
        body: "Something completely unrelated.",
      }),
    );

    await vault.rebuildIndexes();

    const pointers = await recall(vault, "xyzzy nonexistent topic qqq", config);
    expect(pointers).toHaveLength(0);
  });

  it("returns empty array for empty prompt", async () => {
    const config = makeConfig(tmpDir);
    const vault = new Vault(config);
    await vault.init();

    const pointers = await recall(vault, "", config);
    expect(pointers).toHaveLength(0);
  });

  it("respects maxPointers limit", async () => {
    const config = makeConfig(tmpDir);
    config.recall.maxPointers = 2;
    const vault = new Vault(config);
    await vault.init();

    // Create 5 notes all matching the same keyword
    for (let i = 0; i < 5; i++) {
      await vault.createNote(
        makeNote({
          frontmatter: makeFrontmatter({
            id: `n${i}`,
            tier: "hot",
            tags: ["docker"],
          }),
          title: `Docker Note ${i}`,
          body: `Docker container setup number ${i}.`,
        }),
      );
    }

    await vault.rebuildIndexes();

    const pointers = await recall(vault, "docker container", config);
    expect(pointers.length).toBeLessThanOrEqual(2);
  });

  it("logs access for recalled notes", async () => {
    const config = makeConfig(tmpDir);
    const vault = new Vault(config);
    await vault.init();

    await vault.createNote(
      makeNote({
        frontmatter: makeFrontmatter({
          id: "n1",
          tier: "hot",
          tags: ["gpu"],
        }),
        title: "GPU Benchmark",
        body: "Running GPU benchmark on gpu-server.",
      }),
    );

    await vault.rebuildIndexes();

    await recall(vault, "gpu benchmark", config);

    const log = await vault.getAccessLog();
    expect(log.length).toBeGreaterThan(0);
  });
});

// ── formatMemoryzContext ─────────────────────────────────────────────

describe("formatMemoryzContext", () => {
  it("generates correct format with hot index and pointers", () => {
    const config = makeConfig(tmpDir);
    const hotIndex = "- [14:30] Afternoon Note\n- [09:15] Morning Note\n";
    const pointers: RecallPointer[] = [
      {
        tier: "hot",
        path: "/vault/hot/note1.md",
        title: "Note One",
        summary: "Summary of note one",
        date: "2025-01-01T00:00:00.000Z",
      },
      {
        tier: "warm",
        path: "/vault/warm/note2.md",
        title: "Note Two",
        summary: "Summary of note two",
        date: "2025-01-02T00:00:00.000Z",
      },
    ];

    const result = formatMemoryzContext(hotIndex, pointers, config);

    expect(result).toContain("<memoryz>");
    expect(result).toContain("</memoryz>");
    expect(result).toContain("현재 상태 (hot)");
    expect(result).toContain("Afternoon Note");
    expect(result).toContain("관련 기억");
    expect(result).toContain("Note One");
    expect(result).toContain("Note Two");
    expect(result).toContain("memoryz_read");
  });

  it("shows empty message when hot index is empty", () => {
    const config = makeConfig(tmpDir);
    const result = formatMemoryzContext("", [], config);

    expect(result).toContain("_(비어 있음)_");
  });

  it("omits related memories section when no pointers", () => {
    const config = makeConfig(tmpDir);
    const result = formatMemoryzContext("- [10:00] Some Note\n", [], config);

    expect(result).not.toContain("관련 기억");
  });
});
