import { describe, it, expect } from "vitest";
import {
  extractEntities,
  extractTags,
  extractKeywords,
  formatTimestamp,
  truncateTokens,
  generateId,
} from "../src/utils.js";

// ── extractEntities ──────────────────────────────────────────────────

describe("extractEntities", () => {
  it("finds @mentions", () => {
    const result = extractEntities("Talked to @alice and @bob about the plan");
    expect(result).toContain("alice");
    expect(result).toContain("bob");
  });

  it("finds known device name patterns", () => {
    const result = extractEntities("Deployed to dev-server1 and prod-node2");
    expect(result).toContain("dev-server1");
    expect(result).toContain("prod-node2");
  });

  it("finds CamelCase proper nouns", () => {
    const result = extractEntities("Using MacStudio for inference");
    expect(result).toContain("MacStudio");
  });

  it("finds quoted strings", () => {
    const result = extractEntities('Set the variable "MY_VAR" to something');
    expect(result).toContain("MY_VAR");
  });

  it("extracts Korean nouns followed by particles", () => {
    const result = extractEntities("서버에서 작업을 시작했다");
    expect(result).toContain("서버");
    expect(result).toContain("작업");
  });

  it("extracts IP addresses", () => {
    const result = extractEntities("서버 IP는 192.168.1.100 입니다");
    expect(result).toContain("192.168.1.100");
  });

  it("extracts device name patterns", () => {
    const result = extractEntities("dev-server4에서 배포했습니다");
    expect(result).toContain("dev-server4");
  });

  it("returns empty array for empty text", () => {
    expect(extractEntities("")).toEqual([]);
  });

  it("deduplicates entities", () => {
    const result = extractEntities("@alice met @alice on dev-server1 dev-server1");
    const aliceCount = result.filter((e) => e === "alice").length;
    expect(aliceCount).toBe(1);
  });
});

// ── extractTags ──────────────────────────────────────────────────────

describe("extractTags", () => {
  it("finds #hashtags", () => {
    const result = extractTags("Working on #deploy and #network issues");
    expect(result).toContain("deploy");
    expect(result).toContain("network");
  });

  it("finds tech keywords present in text", () => {
    const result = extractTags("Set up docker and nginx for the project");
    expect(result).toContain("docker");
    expect(result).toContain("nginx");
  });

  it("lowercases hashtags", () => {
    const result = extractTags("Check #Docker setup");
    expect(result).toContain("docker");
  });

  it("returns empty array for text with no tags or keywords", () => {
    const result = extractTags("Just a plain sentence with no special words");
    expect(result).toEqual([]);
  });
});

// ── extractKeywords ──────────────────────────────────────────────────

describe("extractKeywords", () => {
  it("extracts meaningful words (>2 chars, not stop words)", () => {
    const result = extractKeywords("The quick brown fox jumps over");
    expect(result).toContain("quick");
    expect(result).toContain("brown");
    expect(result).toContain("fox");
    expect(result).toContain("jumps");
    // Stop words should not be present
    expect(result).not.toContain("the");
    expect(result).not.toContain("over");
  });

  it("filters out short words (<=2 chars)", () => {
    const result = extractKeywords("I am ok no go");
    // all <= 2 chars or stop words
    expect(result).toEqual([]);
  });

  it("returns unique keywords", () => {
    const result = extractKeywords("test test test again");
    const testCount = result.filter((k) => k === "test").length;
    expect(testCount).toBe(1);
  });

  it("strips punctuation and splits correctly", () => {
    const result = extractKeywords("hello-world, foo.bar! baz");
    expect(result).toContain("hello-world");
    expect(result).toContain("foo");
    expect(result).toContain("bar");
    expect(result).toContain("baz");
  });
});

// ── formatTimestamp ──────────────────────────────────────────────────

describe("formatTimestamp", () => {
  it("formats a Date object as ISO string", () => {
    const date = new Date("2025-06-15T10:30:00.000Z");
    expect(formatTimestamp(date)).toBe("2025-06-15T10:30:00.000Z");
  });

  it("formats a number (epoch ms) as ISO string", () => {
    const epoch = new Date("2025-01-01T00:00:00.000Z").getTime();
    expect(formatTimestamp(epoch)).toBe("2025-01-01T00:00:00.000Z");
  });

  it("returns current time ISO string when called with undefined", () => {
    const before = Date.now();
    const result = formatTimestamp();
    const after = Date.now();
    const resultMs = new Date(result).getTime();
    expect(resultMs).toBeGreaterThanOrEqual(before);
    expect(resultMs).toBeLessThanOrEqual(after);
  });
});

// ── truncateTokens ───────────────────────────────────────────────────

describe("truncateTokens", () => {
  it("preserves short text within token budget", () => {
    const text = "Hello world";
    expect(truncateTokens(text, 100)).toBe(text);
  });

  it("truncates long English text", () => {
    // 1 English char ~ 0.25 tokens, so 100 tokens ~ 400 chars
    const text = "a".repeat(1000);
    const result = truncateTokens(text, 100);
    expect(result.length).toBeLessThan(1000);
    // Should be approximately 400 chars (100 tokens * 4 chars/token)
    expect(result.length).toBeGreaterThanOrEqual(399);
    expect(result.length).toBeLessThanOrEqual(401);
  });

  it("truncates Korean/CJK text at correct boundary", () => {
    // 1 Korean char ~ 0.5 tokens, so 100 tokens ~ 200 chars
    const text = "\uD55C".repeat(500); // 500 Korean chars
    const result = truncateTokens(text, 100);
    expect(result.length).toBeLessThan(500);
    expect(result.length).toBeGreaterThanOrEqual(199);
    expect(result.length).toBeLessThanOrEqual(201);
  });
});

// ── generateId ───────────────────────────────────────────────────────

describe("generateId", () => {
  it("returns a 12-character hex string", () => {
    const id = generateId();
    expect(id).toHaveLength(12);
    expect(id).toMatch(/^[0-9a-f]{12}$/);
  });

  it("returns unique IDs on successive calls", () => {
    const ids = new Set(Array.from({ length: 10 }, () => generateId()));
    expect(ids.size).toBe(10);
  });
});
