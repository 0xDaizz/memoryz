import { describe, it, expect } from "vitest";
import { createSummarizer } from "../src/summarizer.js";
import type { MemoryzConfig } from "../src/config.js";

function makeConfig(
  provider: "rules" | "openai-compatible" | "agent-model" = "rules",
): MemoryzConfig {
  return {
    vaultPath: "/tmp/test-vault",
    summarizer: { provider },
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

describe("RulesSummarizer", () => {
  it("extracts summary from first sentence", async () => {
    const summarizer = createSummarizer(makeConfig("rules"));
    const result = await summarizer.summarize(
      "Docker was installed on dev-server1. The setup took about 30 minutes. Everything works now.",
    );
    // Summary should contain the first 1-2 sentences
    expect(result.summary).toContain("Docker was installed on dev-server1");
  });

  it("extracts entities from text", async () => {
    const summarizer = createSummarizer(makeConfig("rules"));
    const result = await summarizer.summarize(
      "Deployed the app to dev-server1 and @alice reviewed the PR",
    );
    expect(result.entities).toContain("dev-server1");
    expect(result.entities).toContain("alice");
  });

  it("extracts tags from text", async () => {
    const summarizer = createSummarizer(makeConfig("rules"));
    const result = await summarizer.summarize(
      "Set up docker and nginx on the server #deploy",
    );
    expect(result.tags).toContain("docker");
    expect(result.tags).toContain("nginx");
    expect(result.tags).toContain("deploy");
  });

  it("handles empty text gracefully", async () => {
    const summarizer = createSummarizer(makeConfig("rules"));
    const result = await summarizer.summarize("");
    expect(result.summary).toBe("");
    expect(result.entities).toEqual([]);
    expect(result.tags).toEqual([]);
  });
});

describe("createSummarizer", () => {
  it("returns rules summarizer when provider is 'rules'", () => {
    const summarizer = createSummarizer(makeConfig("rules"));
    expect(summarizer).toBeDefined();
    expect(typeof summarizer.summarize).toBe("function");
  });

  it("returns rules summarizer for 'agent-model' provider (default fallback)", () => {
    const summarizer = createSummarizer(makeConfig("agent-model"));
    // agent-model falls through to the default case which creates RulesSummarizer
    expect(summarizer).toBeDefined();
    expect(typeof summarizer.summarize).toBe("function");
  });

  it("returns rules summarizer when no provider specified", () => {
    const config = makeConfig("rules");
    // @ts-expect-error -- testing runtime fallback when provider is missing
    config.summarizer = {};
    const summarizer = createSummarizer(config);
    expect(summarizer).toBeDefined();
    expect(typeof summarizer.summarize).toBe("function");
  });
});
