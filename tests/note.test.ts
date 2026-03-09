import { describe, it, expect } from "vitest";
import {
  parseFrontmatter,
  parseNote,
  serializeNote,
  serializeFrontmatter,
  generateNoteId,
  slugify,
  type NoteFrontmatter,
  type Note,
} from "../src/vault/note.js";

// ── Helper: minimal valid frontmatter ────────────────────────────────

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

// ── parseFrontmatter ─────────────────────────────────────────────────

describe("parseFrontmatter", () => {
  it("parses valid YAML frontmatter", () => {
    const raw = [
      "id: abc12345",
      "type: fact",
      "tier: hot",
      "created: 2025-01-01T00:00:00.000Z",
      "last_accessed: 2025-01-02T00:00:00.000Z",
      "access_count: 5",
      "source_session: sess-001",
      "entities: [server-alpha, server-beta]",
      "tags: [network, setup]",
      "access: public",
    ].join("\n");

    const fm = parseFrontmatter(raw);

    expect(fm.id).toBe("abc12345");
    expect(fm.type).toBe("fact");
    expect(fm.tier).toBe("hot");
    expect(fm.created).toBe("2025-01-01T00:00:00.000Z");
    expect(fm.last_accessed).toBe("2025-01-02T00:00:00.000Z");
    expect(fm.access_count).toBe(5);
    expect(fm.source_session).toBe("sess-001");
    expect(fm.entities).toEqual(["server-alpha", "server-beta"]);
    expect(fm.tags).toEqual(["network", "setup"]);
    expect(fm.access).toBe("public");
  });

  it("parses empty arrays correctly", () => {
    const raw = [
      "id: abc12345",
      "type: event",
      "tier: warm",
      "created: 2025-01-01T00:00:00.000Z",
      "last_accessed: 2025-01-01T00:00:00.000Z",
      "access_count: 0",
      "source_session: s1",
      "entities: []",
      "tags: []",
      "access: public",
    ].join("\n");

    const fm = parseFrontmatter(raw);
    expect(fm.entities).toEqual([]);
    expect(fm.tags).toEqual([]);
  });

  it("handles quoted string values", () => {
    const raw = [
      'id: "abc12345"',
      "type: insight",
      "tier: cold",
      "created: 2025-01-01T00:00:00.000Z",
      "last_accessed: 2025-01-01T00:00:00.000Z",
      "access_count: 1",
      'source_session: "my session"',
      "entities: []",
      "tags: []",
      "access: owner-only",
    ].join("\n");

    const fm = parseFrontmatter(raw);
    expect(fm.id).toBe("abc12345");
    expect(fm.source_session).toBe("my session");
    expect(fm.access).toBe("owner-only");
  });

  it("throws on invalid note type", () => {
    const raw = [
      "id: abc",
      "type: invalid",
      "tier: hot",
      "created: 2025-01-01T00:00:00.000Z",
      "last_accessed: 2025-01-01T00:00:00.000Z",
      "access_count: 0",
      "source_session: s",
      "entities: []",
      "tags: []",
    ].join("\n");

    expect(() => parseFrontmatter(raw)).toThrow(/Invalid note type/);
  });

  it("throws on missing required field", () => {
    const raw = [
      "id: abc",
      "type: fact",
      // missing tier
      "created: 2025-01-01T00:00:00.000Z",
      "last_accessed: 2025-01-01T00:00:00.000Z",
      "access_count: 0",
      "source_session: s",
      "entities: []",
      "tags: []",
    ].join("\n");

    expect(() => parseFrontmatter(raw)).toThrow(/Missing frontmatter field: tier/);
  });

  it("parses entities with quoted items", () => {
    const raw = [
      "id: abc12345",
      "type: entity",
      "tier: hot",
      "created: 2025-01-01T00:00:00.000Z",
      "last_accessed: 2025-01-01T00:00:00.000Z",
      "access_count: 0",
      "source_session: s",
      'entities: ["hello world", simple]',
      "tags: []",
    ].join("\n");

    const fm = parseFrontmatter(raw);
    expect(fm.entities).toEqual(["hello world", "simple"]);
  });

  it("defaults access to public when not provided", () => {
    const raw = [
      "id: abc12345",
      "type: fact",
      "tier: hot",
      "created: 2025-01-01T00:00:00.000Z",
      "last_accessed: 2025-01-01T00:00:00.000Z",
      "access_count: 0",
      "source_session: s",
      "entities: []",
      "tags: []",
    ].join("\n");

    const fm = parseFrontmatter(raw);
    expect(fm.access).toBe("public");
  });
});

// ── parseNote + serializeNote roundtrip ──────────────────────────────

describe("parseNote + serializeNote roundtrip", () => {
  it("roundtrips a complete note", () => {
    const note = makeNote({
      frontmatter: makeFrontmatter({
        entities: ["server-alpha", "server-beta"],
        tags: ["network", "setup"],
      }),
      title: "My Test Note",
      body: "Some body content here.\n\nWith multiple paragraphs.",
    });

    const serialized = serializeNote(note);
    const parsed = parseNote(serialized);

    expect(parsed.frontmatter.id).toBe(note.frontmatter.id);
    expect(parsed.frontmatter.type).toBe(note.frontmatter.type);
    expect(parsed.frontmatter.tier).toBe(note.frontmatter.tier);
    expect(parsed.frontmatter.entities).toEqual(note.frontmatter.entities);
    expect(parsed.frontmatter.tags).toEqual(note.frontmatter.tags);
    expect(parsed.title).toBe(note.title);
    expect(parsed.body.trim()).toBe(note.body.trim());
  });

  it("roundtrips a note with no title", () => {
    const note = makeNote({ title: "", body: "Just body content." });
    const serialized = serializeNote(note);
    const parsed = parseNote(serialized);

    expect(parsed.title).toBe("");
    expect(parsed.body.trim()).toBe("Just body content.");
  });

  it("throws when no frontmatter present", () => {
    expect(() => parseNote("# Just a heading\n\nNo frontmatter.")).toThrow(
      /No frontmatter found/,
    );
  });

  it("preserves filePath if provided to parseNote", () => {
    const note = makeNote();
    const serialized = serializeNote(note);
    const parsed = parseNote(serialized, "/some/path.md");
    expect(parsed.filePath).toBe("/some/path.md");
  });
});

// ── generateNoteId ───────────────────────────────────────────────────

describe("generateNoteId", () => {
  it("returns 12 characters", () => {
    const id = generateNoteId();
    expect(id).toHaveLength(12);
  });

  it("returns unique values on subsequent calls", () => {
    const ids = new Set(Array.from({ length: 20 }, () => generateNoteId()));
    expect(ids.size).toBe(20);
  });

  it("contains only hex characters", () => {
    const id = generateNoteId();
    expect(id).toMatch(/^[0-9a-f]+$/);
  });
});

// ── slugify ──────────────────────────────────────────────────────────

describe("slugify", () => {
  it("lowercases and replaces spaces with hyphens", () => {
    expect(slugify("Hello World")).toBe("hello-world");
  });

  it("handles Korean characters", () => {
    const slug = slugify("한국어 테스트");
    expect(slug).toBe("한국어-테스트");
  });

  it("handles mixed Korean and English", () => {
    const slug = slugify("MLX 분산 추론 테스트");
    expect(slug).toBe("mlx-분산-추론-테스트");
  });

  it("strips special characters", () => {
    expect(slugify("Hello! @World #2024")).toBe("hello-world-2024");
  });

  it("collapses multiple hyphens", () => {
    expect(slugify("a   b---c")).toBe("a-b-c");
  });

  it("strips leading and trailing hyphens", () => {
    expect(slugify("--hello--")).toBe("hello");
  });

  it("handles empty string", () => {
    expect(slugify("")).toBe("untitled");
  });
});
