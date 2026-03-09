import { describe, it, expect } from "vitest";
import { memoryzConfigSchema } from "../src/config.js";

// ── parseConfig ──────────────────────────────────────────────────────

describe("memoryzConfigSchema.parse", () => {
  it("parses a full config object", () => {
    const config = memoryzConfigSchema.parse({
      vaultPath: "/tmp/vault",
      summarizer: {
        provider: "openai-compatible",
        baseUrl: "http://localhost:8000",
        model: "test-model-7b",
        apiKey: "sk-test",
      },
      tiers: {
        hotMaxAge: 3_600_000,
        warmMaxAge: 86_400_000,
        coldArchiveAge: 1_000_000_000,
        hotMaxNotes: 100,
      },
      recall: {
        enabled: false,
        maxPointers: 10,
        maxTokens: 1200,
      },
      capture: {
        enabled: false,
        minLength: 50,
        maxPerTurn: 5,
      },
      consolidateIntervalMs: 600_000,
      accessControl: true,
    });

    expect(config.vaultPath).toBe("/tmp/vault");
    expect(config.summarizer.provider).toBe("openai-compatible");
    expect(config.summarizer.baseUrl).toBe("http://localhost:8000");
    expect(config.summarizer.model).toBe("test-model-7b");
    expect(config.summarizer.apiKey).toBe("sk-test");
    expect(config.tiers.hotMaxAge).toBe(3_600_000);
    expect(config.tiers.warmMaxAge).toBe(86_400_000);
    expect(config.tiers.coldArchiveAge).toBe(1_000_000_000);
    expect(config.tiers.hotMaxNotes).toBe(100);
    expect(config.recall.enabled).toBe(false);
    expect(config.recall.maxPointers).toBe(10);
    expect(config.recall.maxTokens).toBe(1200);
    expect(config.capture.enabled).toBe(false);
    expect(config.capture.minLength).toBe(50);
    expect(config.capture.maxPerTurn).toBe(5);
    expect(config.consolidateIntervalMs).toBe(600_000);
    expect(config.accessControl).toBe(true);
  });

  it("parses minimal config with only vaultPath (uses defaults)", () => {
    const config = memoryzConfigSchema.parse({
      vaultPath: "/tmp/minimal-vault",
    });

    expect(config.vaultPath).toBe("/tmp/minimal-vault");
    // All defaults should be applied
    expect(config.summarizer.provider).toBe("agent-model");
    expect(config.tiers.hotMaxAge).toBe(7_200_000);
    expect(config.tiers.warmMaxAge).toBe(604_800_000);
    expect(config.tiers.coldArchiveAge).toBe(2_592_000_000);
    expect(config.tiers.hotMaxNotes).toBe(50);
    expect(config.recall.enabled).toBe(true);
    expect(config.recall.maxPointers).toBe(5);
    expect(config.recall.maxTokens).toBe(800);
    expect(config.capture.enabled).toBe(true);
    expect(config.capture.minLength).toBe(20);
    expect(config.capture.maxPerTurn).toBe(3);
    expect(config.consolidateIntervalMs).toBe(1_800_000);
    expect(config.accessControl).toBe(false);
  });

  it("uses default values for all optional fields", () => {
    const config = memoryzConfigSchema.parse({
      vaultPath: "/tmp/test",
      summarizer: {},
      tiers: {},
      recall: {},
      capture: {},
    });

    expect(config.summarizer.provider).toBe("agent-model");
    expect(config.summarizer.baseUrl).toBeUndefined();
    expect(config.summarizer.model).toBeUndefined();
    expect(config.summarizer.apiKey).toBeUndefined();
    expect(config.tiers.hotMaxAge).toBe(7_200_000);
    expect(config.tiers.warmMaxAge).toBe(604_800_000);
    expect(config.tiers.coldArchiveAge).toBe(2_592_000_000);
    expect(config.tiers.hotMaxNotes).toBe(50);
    expect(config.recall.enabled).toBe(true);
    expect(config.recall.maxPointers).toBe(5);
    expect(config.recall.maxTokens).toBe(800);
    expect(config.capture.enabled).toBe(true);
    expect(config.capture.minLength).toBe(20);
    expect(config.capture.maxPerTurn).toBe(3);
    expect(config.consolidateIntervalMs).toBe(1_800_000);
    expect(config.accessControl).toBe(false);
  });

  it("uses default vaultPath when missing", () => {
    const config = memoryzConfigSchema.parse({});
    expect(config.vaultPath).toBe("~/.openclaw/memoryz");
  });

  it("uses all defaults when config is null or undefined", () => {
    const fromNull = memoryzConfigSchema.parse(null);
    expect(fromNull.vaultPath).toBe("~/.openclaw/memoryz");
    expect(fromNull.summarizer.provider).toBe("agent-model");

    const fromUndefined = memoryzConfigSchema.parse(undefined);
    expect(fromUndefined.vaultPath).toBe("~/.openclaw/memoryz");
  });

  it("throws for invalid summarizer provider", () => {
    expect(() =>
      memoryzConfigSchema.parse({
        vaultPath: "/tmp/test",
        summarizer: { provider: "invalid" },
      }),
    ).toThrow("summarizer.provider");
  });
});
