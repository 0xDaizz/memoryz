import type { MemoryzConfig } from "./config.js";
import { extractEntities, extractTags } from "./utils.js";

export type SummaryResult = {
  summary: string;
  entities: string[];
  tags: string[];
};

export interface Summarizer {
  summarize(text: string): Promise<SummaryResult>;
}

// ---------------------------------------------------------------------------
// OpenAICompatibleSummarizer — uses any OpenAI-compatible API (vLLM, Ollama, OpenAI, etc.)
// ---------------------------------------------------------------------------

const SUMMARIZE_PROMPT = `Summarize this interaction in 1-2 sentences. Extract entities (proper nouns, device names, people) and tags (topics, technologies). Respond in JSON: {"summary": "...", "entities": ["..."], "tags": ["..."]}`;

class OpenAICompatibleSummarizer implements Summarizer {
  private baseUrl: string;
  private model: string;
  private apiKey?: string;

  constructor(baseUrl: string, model: string, apiKey?: string) {
    if (!baseUrl) {
      throw new Error("OpenAICompatibleSummarizer requires a baseUrl but received a falsy value");
    }
    if (!model) {
      throw new Error("OpenAICompatibleSummarizer requires a model but received a falsy value");
    }
    this.baseUrl = baseUrl;
    this.model = model;
    this.apiKey = apiKey;
  }

  async summarize(text: string): Promise<SummaryResult> {
    const { default: OpenAI } = await import("openai");

    const client = new OpenAI({
      baseURL: this.baseUrl,
      apiKey: this.apiKey ?? "no-key",
    });

    const response = await client.chat.completions.create({
      model: this.model,
      messages: [
        { role: "system", content: SUMMARIZE_PROMPT },
        { role: "user", content: text.slice(0, 4000) },
      ],
      temperature: 0.3,
      max_tokens: 512,
    });

    const raw = response.choices?.[0]?.message?.content ?? "";

    try {
      // Try to extract JSON from the response (handle markdown code blocks)
      const jsonMatch = raw.match(/\{[\s\S]*\}/);
      if (!jsonMatch) {
        throw new Error("No JSON found in response");
      }
      const parsed = JSON.parse(jsonMatch[0]) as Record<string, unknown>;

      return {
        summary: typeof parsed.summary === "string" ? parsed.summary : text.slice(0, 200),
        entities: Array.isArray(parsed.entities)
          ? parsed.entities.filter((e): e is string => typeof e === "string")
          : [],
        tags: Array.isArray(parsed.tags)
          ? parsed.tags.filter((t): t is string => typeof t === "string")
          : [],
      };
    } catch {
      // Graceful fallback: use the raw response as summary, extract with rules
      return {
        summary: raw.slice(0, 200) || text.slice(0, 200),
        entities: extractEntities(text),
        tags: extractTags(text),
      };
    }
  }
}

// ---------------------------------------------------------------------------
// RulesSummarizer — no LLM, pure regex/heuristic extraction
// ---------------------------------------------------------------------------

class RulesSummarizer implements Summarizer {
  async summarize(text: string): Promise<SummaryResult> {
    // Strip system/XML tags before summarizing
    let cleaned = text.replace(/<[^>]+>/g, "").trim();

    let summary: string;

    if (cleaned.length <= 200) {
      // Short text — use directly as summary
      summary = cleaned;
    } else {
      // Split by sentence-ending punctuation (English . ! ? and Korean 다. 요. 니다.)
      const sentences = cleaned
        .split(/(?<=[.!?。])\s+|(?<=다[.])\s*|(?<=요[.])\s*|(?<=니다[.])\s*/)
        .filter((s) => s.trim().length > 0);

      if (sentences.length > 0) {
        // Take first 2 meaningful sentences
        summary = sentences.slice(0, 2).join(" ").slice(0, 200);
      } else {
        // No sentence boundaries found — use first 200 chars
        summary = cleaned.slice(0, 200);
      }
    }

    // Ensure summary is never empty or just punctuation
    if (!summary || /^[.\s…]+$/.test(summary)) {
      summary = cleaned.slice(0, 200) || text.slice(0, 200);
    }

    return {
      summary,
      entities: extractEntities(text),
      tags: extractTags(text),
    };
  }
}

// ---------------------------------------------------------------------------
// AgentModelSummarizer — auto-detects API keys and uses the cheapest model
// ---------------------------------------------------------------------------

class AgentModelSummarizer implements Summarizer {
  private fallback = new RulesSummarizer();

  async summarize(text: string): Promise<SummaryResult> {
    // Try Anthropic first (most common for OpenClaw deployments)
    const anthropicKey = process.env.ANTHROPIC_API_KEY;
    if (anthropicKey) {
      return this.summarizeWithAnthropic(text, anthropicKey);
    }

    // Try OpenAI
    const openaiKey = process.env.OPENAI_API_KEY;
    if (openaiKey) {
      return this.summarizeWithOpenAI(text, openaiKey);
    }

    // No API key available — fall back to rules
    return this.fallback.summarize(text);
  }

  private async summarizeWithAnthropic(text: string, apiKey: string): Promise<SummaryResult> {
    try {
      const response = await fetch("https://api.anthropic.com/v1/messages", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "x-api-key": apiKey,
          "anthropic-version": "2023-06-01",
        },
        body: JSON.stringify({
          model: "claude-haiku-4-5-20251001",
          max_tokens: 512,
          messages: [
            {
              role: "user",
              content: `${SUMMARIZE_PROMPT}\n\n${text.slice(0, 4000)}`,
            },
          ],
        }),
      });

      if (!response.ok) {
        throw new Error(`Anthropic API error: ${response.status}`);
      }

      const data = await response.json() as any;
      const raw = data.content?.[0]?.text ?? "";
      return this.parseJsonResponse(raw, text);
    } catch {
      return this.fallback.summarize(text);
    }
  }

  private async summarizeWithOpenAI(text: string, apiKey: string): Promise<SummaryResult> {
    try {
      const { default: OpenAI } = await import("openai");
      const client = new OpenAI({ apiKey });
      const response = await client.chat.completions.create({
        model: "gpt-4o-mini",
        messages: [
          { role: "system", content: SUMMARIZE_PROMPT },
          { role: "user", content: text.slice(0, 4000) },
        ],
        temperature: 0.3,
        max_tokens: 512,
      });
      const raw = response.choices?.[0]?.message?.content ?? "";
      return this.parseJsonResponse(raw, text);
    } catch {
      return this.fallback.summarize(text);
    }
  }

  private parseJsonResponse(raw: string, originalText: string): SummaryResult {
    try {
      const jsonMatch = raw.match(/\{[\s\S]*\}/);
      if (!jsonMatch) throw new Error("No JSON");
      const parsed = JSON.parse(jsonMatch[0]) as Record<string, unknown>;
      return {
        summary: typeof parsed.summary === "string" ? parsed.summary : originalText.slice(0, 200),
        entities: Array.isArray(parsed.entities)
          ? parsed.entities.filter((e): e is string => typeof e === "string")
          : extractEntities(originalText),
        tags: Array.isArray(parsed.tags)
          ? parsed.tags.filter((t): t is string => typeof t === "string")
          : extractTags(originalText),
      };
    } catch {
      return {
        summary: raw.slice(0, 200) || originalText.slice(0, 200),
        entities: extractEntities(originalText),
        tags: extractTags(originalText),
      };
    }
  }
}

// ---------------------------------------------------------------------------
// Factory
// ---------------------------------------------------------------------------

export function createSummarizer(config: MemoryzConfig): Summarizer {
  const provider = config.summarizer?.provider ?? "rules";

  switch (provider) {
    case "openai-compatible": {
      const baseUrl = config.summarizer?.baseUrl;
      const model = config.summarizer?.model;
      if (!baseUrl || !model) {
        console.warn(
          `memoryz: openai-compatible summarizer requires baseUrl and model but got baseUrl=${baseUrl}, model=${model}. Falling back to rules-based summarizer.`,
        );
        return new RulesSummarizer();
      }
      return new OpenAICompatibleSummarizer(baseUrl, model, config.summarizer?.apiKey);
    }
    case "agent-model":
      return new AgentModelSummarizer();
    case "rules":
    default:
      return new RulesSummarizer();
  }
}
