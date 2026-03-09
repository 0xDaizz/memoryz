// ── Memoryz plugin config schema + parsing ──────────────────────────

export type SummarizerProvider = "openai-compatible" | "rules" | "agent-model";

export type MemoryzConfig = {
  vaultPath: string;
  summarizer: {
    provider: SummarizerProvider;
    baseUrl?: string;
    model?: string;
    apiKey?: string;
  };
  tiers: {
    hotMaxAge: number;
    warmMaxAge: number;
    coldArchiveAge: number;
    hotMaxNotes: number;
  };
  recall: {
    enabled: boolean;
    maxPointers: number;
    maxTokens: number;
  };
  capture: {
    enabled: boolean;
    minLength: number;
    maxPerTurn: number;
  };
  consolidateIntervalMs: number;
  accessControl: boolean;
};

const DEFAULTS: Omit<MemoryzConfig, "vaultPath"> = {
  summarizer: {
    provider: "agent-model",
  },
  tiers: {
    hotMaxAge: 7_200_000,        // 2 hours
    warmMaxAge: 604_800_000,     // 7 days
    coldArchiveAge: 2_592_000_000, // 30 days
    hotMaxNotes: 50,
  },
  recall: {
    enabled: true,
    maxPointers: 5,
    maxTokens: 800,
  },
  capture: {
    enabled: true,
    minLength: 20,
    maxPerTurn: 3,
  },
  consolidateIntervalMs: 1_800_000, // 30 minutes
  accessControl: false,
};

// ── Helpers ──────────────────────────────────────────────────────────

const VALID_PROVIDERS = new Set<SummarizerProvider>(["openai-compatible", "rules", "agent-model"]);

/** Whitelist of environment variables that may be resolved in config values. */
const ENV_VAR_WHITELIST = new Set(["HOME", "USER", "OPENCLAW_MEMORYZ_VAULT_PATH"]);

/**
 * Replace `${VAR}` patterns in a string with the corresponding
 * `process.env[VAR]` value.  Only whitelisted variables are resolved;
 * non-whitelisted references are left as-is.
 */
function resolveEnvVars(value: string): string {
  return value.replace(/\$\{([^}]+)\}/g, (match, varName: string) => {
    if (!ENV_VAR_WHITELIST.has(varName)) return match;
    return process.env[varName] ?? "";
  });
}

/** Recursively walk an object and resolve env vars in every string leaf. */
function resolveEnvVarsDeep<T>(obj: T): T {
  if (typeof obj === "string") {
    return resolveEnvVars(obj) as unknown as T;
  }
  if (Array.isArray(obj)) {
    return obj.map(resolveEnvVarsDeep) as unknown as T;
  }
  if (obj !== null && typeof obj === "object") {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(obj as Record<string, unknown>)) {
      out[k] = resolveEnvVarsDeep(v);
    }
    return out as T;
  }
  return obj;
}

// ── Validation helpers ──────────────────────────────────────────────

function assertString(v: unknown, path: string): asserts v is string {
  if (typeof v !== "string") {
    throw new TypeError(`memoryz config: ${path} must be a string, got ${typeof v}`);
  }
}

function assertNumber(v: unknown, path: string): asserts v is number {
  if (typeof v !== "number" || Number.isNaN(v)) {
    throw new TypeError(`memoryz config: ${path} must be a number, got ${typeof v}`);
  }
}

function assertBoolean(v: unknown, path: string): asserts v is boolean {
  if (typeof v !== "boolean") {
    throw new TypeError(`memoryz config: ${path} must be a boolean, got ${typeof v}`);
  }
}

function numOrDefault(v: unknown, fallback: number, path: string): number {
  if (v === undefined || v === null) return fallback;
  assertNumber(v, path);
  return v;
}

function boolOrDefault(v: unknown, fallback: boolean, path: string): boolean {
  if (v === undefined || v === null) return fallback;
  assertBoolean(v, path);
  return v;
}

function strOrDefault(v: unknown, fallback: string | undefined, path: string): string | undefined {
  if (v === undefined || v === null) return fallback;
  assertString(v, path);
  return v;
}

// ── Parse ───────────────────────────────────────────────────────────

function parse(value: unknown): MemoryzConfig {
  // Allow empty/missing config — use all defaults
  if (value === null || value === undefined) {
    value = {};
  }
  if (typeof value !== "object") {
    throw new TypeError("memoryz config: expected an object");
  }

  const raw = resolveEnvVarsDeep(value as Record<string, unknown>);

  // --- vaultPath (defaults to ~/.openclaw/memoryz) ---
  const vaultPathRaw = (raw as Record<string, unknown>).vaultPath;
  const vaultPath = vaultPathRaw !== undefined && vaultPathRaw !== null
    ? (assertString(vaultPathRaw, "vaultPath"), vaultPathRaw)
    : "~/.openclaw/memoryz";

  // --- summarizer ---
  const rawSum = ((raw as Record<string, unknown>).summarizer ?? {}) as Record<string, unknown>;
  const provider = (rawSum.provider ?? DEFAULTS.summarizer.provider) as string;
  if (!VALID_PROVIDERS.has(provider as SummarizerProvider)) {
    throw new TypeError(
      `memoryz config: summarizer.provider must be one of ${[...VALID_PROVIDERS].join(", ")}, got "${provider}"`,
    );
  }
  const summarizer: MemoryzConfig["summarizer"] = {
    provider: provider as SummarizerProvider,
    baseUrl: strOrDefault(rawSum.baseUrl, DEFAULTS.summarizer.baseUrl, "summarizer.baseUrl"),
    model: strOrDefault(rawSum.model, DEFAULTS.summarizer.model, "summarizer.model"),
    apiKey: strOrDefault(rawSum.apiKey, DEFAULTS.summarizer.apiKey, "summarizer.apiKey"),
  };

  // --- tiers ---
  const rawTiers = ((raw as Record<string, unknown>).tiers ?? {}) as Record<string, unknown>;
  const tiers: MemoryzConfig["tiers"] = {
    hotMaxAge: numOrDefault(rawTiers.hotMaxAge, DEFAULTS.tiers.hotMaxAge, "tiers.hotMaxAge"),
    warmMaxAge: numOrDefault(rawTiers.warmMaxAge, DEFAULTS.tiers.warmMaxAge, "tiers.warmMaxAge"),
    coldArchiveAge: numOrDefault(rawTiers.coldArchiveAge, DEFAULTS.tiers.coldArchiveAge, "tiers.coldArchiveAge"),
    hotMaxNotes: numOrDefault(rawTiers.hotMaxNotes, DEFAULTS.tiers.hotMaxNotes, "tiers.hotMaxNotes"),
  };

  // --- recall ---
  const rawRecall = ((raw as Record<string, unknown>).recall ?? {}) as Record<string, unknown>;
  const recall: MemoryzConfig["recall"] = {
    enabled: boolOrDefault(rawRecall.enabled, DEFAULTS.recall.enabled, "recall.enabled"),
    maxPointers: numOrDefault(rawRecall.maxPointers, DEFAULTS.recall.maxPointers, "recall.maxPointers"),
    maxTokens: numOrDefault(rawRecall.maxTokens, DEFAULTS.recall.maxTokens, "recall.maxTokens"),
  };

  // --- capture ---
  const rawCapture = ((raw as Record<string, unknown>).capture ?? {}) as Record<string, unknown>;
  const capture: MemoryzConfig["capture"] = {
    enabled: boolOrDefault(rawCapture.enabled, DEFAULTS.capture.enabled, "capture.enabled"),
    minLength: numOrDefault(rawCapture.minLength, DEFAULTS.capture.minLength, "capture.minLength"),
    maxPerTurn: numOrDefault(rawCapture.maxPerTurn, DEFAULTS.capture.maxPerTurn, "capture.maxPerTurn"),
  };

  // --- top-level scalars ---
  const consolidateIntervalMs = numOrDefault(
    (raw as Record<string, unknown>).consolidateIntervalMs,
    DEFAULTS.consolidateIntervalMs,
    "consolidateIntervalMs",
  );
  const accessControl = boolOrDefault(
    (raw as Record<string, unknown>).accessControl,
    DEFAULTS.accessControl,
    "accessControl",
  );

  return {
    vaultPath,
    summarizer,
    tiers,
    recall,
    capture,
    consolidateIntervalMs,
    accessControl,
  };
}

// ── Exported schema object ──────────────────────────────────────────

export const memoryzConfigSchema = {
  parse,

  uiHints: {
    vaultPath: {
      label: "Vault path",
      description: "Absolute path to the Obsidian-style vault directory",
      required: true,
    },
    "summarizer.provider": {
      label: "Summarizer provider",
      description: "Which backend produces note summaries",
      enum: ["openai-compatible", "rules", "agent-model"],
      default: DEFAULTS.summarizer.provider,
    },
    "summarizer.baseUrl": {
      label: "Summarizer base URL",
      description: "Base URL for the OpenAI-compatible summarizer (only for openai-compatible provider)",
    },
    "summarizer.model": {
      label: "Summarizer model",
      description: "Model name to use with the summarizer provider",
    },
    "tiers.hotMaxAge": {
      label: "Hot tier max age (ms)",
      description: "Notes accessed within this window stay in the hot tier",
      default: DEFAULTS.tiers.hotMaxAge,
    },
    "tiers.warmMaxAge": {
      label: "Warm tier max age (ms)",
      description: "Notes accessed within this window stay in the warm tier",
      default: DEFAULTS.tiers.warmMaxAge,
    },
    "tiers.coldArchiveAge": {
      label: "Cold archive age (ms)",
      description: "Notes older than this are archived to cold storage",
      default: DEFAULTS.tiers.coldArchiveAge,
    },
    "tiers.hotMaxNotes": {
      label: "Hot tier max notes",
      description: "Maximum number of notes kept in the hot tier",
      default: DEFAULTS.tiers.hotMaxNotes,
    },
    "recall.enabled": {
      label: "Recall enabled",
      description: "Whether automatic recall is active",
      default: DEFAULTS.recall.enabled,
    },
    "recall.maxPointers": {
      label: "Max recall pointers",
      description: "Maximum number of note pointers returned per recall",
      default: DEFAULTS.recall.maxPointers,
    },
    "recall.maxTokens": {
      label: "Max recall tokens",
      description: "Token budget for recall context injection",
      default: DEFAULTS.recall.maxTokens,
    },
    "capture.enabled": {
      label: "Capture enabled",
      description: "Whether automatic capture of new notes is active",
      default: DEFAULTS.capture.enabled,
    },
    "capture.minLength": {
      label: "Capture min length",
      description: "Minimum character length for a captured note body",
      default: DEFAULTS.capture.minLength,
    },
    "capture.maxPerTurn": {
      label: "Max captures per turn",
      description: "Maximum number of notes captured in a single conversation turn",
      default: DEFAULTS.capture.maxPerTurn,
    },
    consolidateIntervalMs: {
      label: "Consolidate interval (ms)",
      description: "How often the background consolidation job runs",
      default: DEFAULTS.consolidateIntervalMs,
    },
    accessControl: {
      label: "Access control",
      description: "Enable owner-only access filtering on notes",
      default: DEFAULTS.accessControl,
    },
  },
} as const;
