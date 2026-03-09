import { Type } from "@sinclair/typebox";
import type { MemoryzConfig } from "./config.js";
import { Vault } from "./vault/vault.js";
import { createSummarizer } from "./summarizer.js";

// ---------------------------------------------------------------------------
// Minimal type alias — resolved at runtime by the OpenClaw loader
// ---------------------------------------------------------------------------
type OpenClawPluginApi = any;

// ---------------------------------------------------------------------------
// Config schema (Typebox, for OpenClaw tool registration)
// ---------------------------------------------------------------------------

const memoryzConfigSchema = Type.Object({
  vaultPath: Type.String({ default: "~/.memoryz" }),
  summarizer: Type.Optional(
    Type.Object({
      provider: Type.Optional(Type.Union([Type.Literal("openai-compatible"), Type.Literal("rules"), Type.Literal("agent-model")])),
      baseUrl: Type.Optional(Type.String()),
      model: Type.Optional(Type.String()),
      apiKey: Type.Optional(Type.String()),
    }),
  ),
  tiers: Type.Optional(
    Type.Object({
      hotMaxAge: Type.Optional(Type.Number()),
      warmMaxAge: Type.Optional(Type.Number()),
      coldArchiveAge: Type.Optional(Type.Number()),
      hotMaxNotes: Type.Optional(Type.Number()),
    }),
  ),
  recall: Type.Optional(
    Type.Object({
      enabled: Type.Optional(Type.Boolean({ default: true })),
      maxPointers: Type.Optional(Type.Number()),
      maxTokens: Type.Optional(Type.Number()),
    }),
  ),
  capture: Type.Optional(
    Type.Object({
      enabled: Type.Optional(Type.Boolean({ default: true })),
      minLength: Type.Optional(Type.Number()),
      maxPerTurn: Type.Optional(Type.Number()),
    }),
  ),
  consolidateIntervalMs: Type.Optional(Type.Number({ default: 300_000 })),
  accessControl: Type.Optional(Type.Boolean({ default: false })),
});

// ---------------------------------------------------------------------------
// Plugin definition
// ---------------------------------------------------------------------------

const memoryzPlugin = {
  id: "memoryz",
  name: "Memoryz",
  description:
    "Persistent memory plugin — Obsidian-style markdown vault with hot/warm/cold tiers",
  kind: null as null,
  configSchema: memoryzConfigSchema,

  // IMPORTANT: register() must be synchronous — OpenClaw ignores async register.
  // Async initialization (vault.init) is done lazily on first use.
  register(api: OpenClawPluginApi) {
    // Per-instance throttle state for consolidation
    let lastConsolidateAt = 0;

    // pluginConfig may be undefined during `openclaw plugins install` validation.
    const rawConfig = (api.pluginConfig ?? {}) as Record<string, unknown>;
    if (!rawConfig.vaultPath) {
      rawConfig.vaultPath = "~/.openclaw/memoryz";
    }
    const cfg = rawConfig as MemoryzConfig;
    const vault = new Vault(cfg);
    const summarizer = createSummarizer(cfg);

    // Lazy async initialization — runs once on first vault access
    let initPromise: Promise<void> | null = null;
    const ensureInit = (): Promise<void> => {
      if (!initPromise) {
        initPromise = vault.init().catch((err) => {
          initPromise = null; // allow retry
          throw err;
        });
      }
      return initPromise;
    };

    // Fire init eagerly but don't block register()
    ensureInit().catch((err) => {
      api.logger.warn(`memoryz: init failed: ${String(err)}`);
    });

    api.logger.info(`memoryz: initialized (vault: ${cfg.vaultPath})`);

    // ====================================================================
    // TOOLS
    // ====================================================================

    // 1. memoryz_search — Search through memory vault
    api.registerTool(
      {
        name: "memoryz_search",
        label: "Memoryz Search",
        description:
          "Search through long-term memory vault. Returns note paths and summaries.",
        parameters: Type.Object({
          query: Type.String({ description: "Search query" }),
          tier: Type.Optional(
            Type.String({ description: "Filter by tier: hot, warm, cold" }),
          ),
          limit: Type.Optional(
            Type.Number({ description: "Max results (default: 10)" }),
          ),
        }),
        async execute(_toolCallId: string, params: any) {
          await ensureInit();
          const { query, tier, limit = 10 } = params;
          const { search } = await import("./vault/search.js");
          const { extractEntities, extractTags } = await import("./utils.js");
          const results = await search(vault, query, {
            entities: extractEntities(query),
            tags: extractTags(query),
            tiers: tier ? [tier] : undefined,
            limit,
          });
          if (results.length === 0) {
            return {
              content: [
                { type: "text", text: "관련 기억을 찾을 수 없습니다." },
              ],
            };
          }
          const text = results
            .map(
              (r, i) =>
                `${i + 1}. [${r.note.frontmatter.tier}] ${r.note.title} (${r.matchType}, ${(r.score * 100).toFixed(0)}%)\n   ${r.note.filePath}`,
            )
            .join("\n");
          return {
            content: [{ type: "text", text }],
            details: { count: results.length },
          };
        },
      },
      { name: "memoryz_search" },
    );

    // 2. memoryz_read — Read a specific note
    api.registerTool(
      {
        name: "memoryz_read",
        label: "Memoryz Read",
        description: "Read full content of a specific memory note.",
        parameters: Type.Object({
          path: Type.String({ description: "Path to the note file" }),
        }),
        async execute(_toolCallId: string, params: any) {
          await ensureInit();
          const { path } = params;
          const note = await vault.readNote(path);
          const { serializeNote } = await import("./vault/note.js");
          const content = serializeNote(note);
          await vault.logAccess(path);
          return { content: [{ type: "text", text: content }] };
        },
      },
      { name: "memoryz_read" },
    );

    // 3. memoryz_remember — Explicitly store a memory
    api.registerTool(
      {
        name: "memoryz_remember",
        label: "Memoryz Remember",
        description:
          "Explicitly store something in memory. Use when user says 'remember this'.",
        parameters: Type.Object({
          text: Type.String({ description: "What to remember" }),
          entities: Type.Optional(
            Type.Array(Type.String(), { description: "Related entities" }),
          ),
          tags: Type.Optional(
            Type.Array(Type.String(), { description: "Tags" }),
          ),
          access: Type.Optional(
            Type.String({
              description: "Access level: public or owner-only",
            }),
          ),
        }),
        async execute(_toolCallId: string, params: any) {
          await ensureInit();
          const { text, entities = [], tags = [], access = "public" } = params;
          const result = await summarizer.summarize(text);
          const { generateNoteId } = await import("./vault/note.js");
          const { formatTimestamp } = await import("./utils.js");
          const now = formatTimestamp();
          const note = {
            frontmatter: {
              id: generateNoteId(),
              type: "fact" as const,
              tier: "hot" as const,
              created: now,
              last_accessed: now,
              access_count: 1,
              source_session: "explicit",
              entities: [...new Set([...entities, ...result.entities])],
              tags: [...new Set([...tags, ...result.tags])],
              access: access as any,
            },
            title: result.summary.slice(0, 80),
            body: text,
          };
          const filePath = await vault.createNote(note);
          await vault.rebuildHotIndex();
          return {
            content: [
              {
                type: "text",
                text: `기억 저장 완료: ${note.title}`,
              },
            ],
            details: { path: filePath },
          };
        },
      },
      { name: "memoryz_remember" },
    );

    // 4. memoryz_forget — Delete a memory
    api.registerTool(
      {
        name: "memoryz_forget",
        label: "Memoryz Forget",
        description: "Delete a memory note.",
        parameters: Type.Object({
          path: Type.String({ description: "Path to the note to delete" }),
        }),
        async execute(_toolCallId: string, params: any) {
          await ensureInit();
          const { path } = params;
          await vault.deleteNote(path);
          await vault.rebuildIndexes();
          return {
            content: [{ type: "text", text: `기억 삭제 완료: ${path}` }],
          };
        },
      },
      { name: "memoryz_forget" },
    );

    // 5. memoryz_status — Vault statistics
    api.registerTool(
      {
        name: "memoryz_status",
        label: "Memoryz Status",
        description:
          "Show vault statistics (note counts per tier, recent activity).",
        parameters: Type.Object({}),
        async execute() {
          await ensureInit();
          const s = await vault.stats();
          const recentAccess = await vault.getAccessLog(5);
          const recentText = recentAccess
            .map((a) => `  ${new Date(a.at).toISOString()} — ${a.file}`)
            .join("\n");
          const text = `Memoryz Vault 상태:\n  Hot: ${s.hot}\n  Warm: ${s.warm}\n  Cold: ${s.cold}\n  Archive: ${s.archive}\n  Total: ${s.total}\n\n최근 접근:\n${recentText || "  (없음)"}`;
          return { content: [{ type: "text", text }], details: s };
        },
      },
      { name: "memoryz_status" },
    );

    // ====================================================================
    // HOOKS
    // ====================================================================

    // RECALL: before_prompt_build
    if (cfg.recall?.enabled !== false) {
      api.on("before_prompt_build", async (event: any) => {
        if (!event.prompt || event.prompt.length < 5) return;
        try {
          await ensureInit();
          const hotIndex = await vault.readHotIndex();
          const { recall, formatMemoryzContext } = await import(
            "./ops/recall.js"
          );
          const pointers = await recall(vault, event.prompt, cfg);
          const context = formatMemoryzContext(hotIndex, pointers, cfg);
          return { appendSystemContext: context };
        } catch (err) {
          api.logger.warn(`memoryz: recall failed: ${String(err)}`);
        }
      });
    }

    // CAPTURE: agent_end
    if (cfg.capture?.enabled !== false) {
      api.on("agent_end", async (event: any, ctx: any) => {
        if (!event.success || !event.messages?.length) return;
        try {
          await ensureInit();
          const { capture } = await import("./ops/capture.js");
          const count = await capture(
            vault,
            event.messages,
            { sessionKey: ctx.sessionKey, agentId: ctx.agentId },
            cfg,
            summarizer,
          );
          if (count > 0)
            api.logger.info(`memoryz: captured ${count} memories`);
        } catch (err) {
          api.logger.warn(`memoryz: capture failed: ${String(err)}`);
        }
      });
    }

    // CONSOLIDATE: agent_end (throttled)
    api.on("agent_end", async () => {
      const now = Date.now();
      const interval = cfg.consolidateIntervalMs ?? 300_000;
      if (now - lastConsolidateAt < interval) return;
      try {
        await ensureInit();
        const { consolidate } = await import("./ops/consolidate.js");
        const result = await consolidate(vault, cfg);
        lastConsolidateAt = now;
        api.logger.info(
          `memoryz: consolidated — moved ${result.movedHotToWarm} hot→warm, ${result.movedWarmToCold} warm→cold, ${result.promotedColdToWarm} cold→warm, ${result.merged} merged, ${result.linksAdded} links`,
        );
      } catch (err) {
        api.logger.warn(`memoryz: consolidate failed: ${String(err)}`);
      }
    });

    // ====================================================================
    // CLI
    // ====================================================================

    api.registerCli(
      ({ program }: any) => {
        const mem = program
          .command("memoryz")
          .description("Memoryz vault commands");

        mem
          .command("search")
          .description("Search vault")
          .argument("<query>")
          .option("--limit <n>", "Max results", "10")
          .action(async (query: string, opts: any) => {
            await ensureInit();
            const { search } = await import("./vault/search.js");
            const results = await search(vault, query, {
              limit: parseInt(opts.limit),
            });
            console.log(
              JSON.stringify(
                results.map((r) => ({
                  path: r.note.filePath,
                  title: r.note.title,
                  tier: r.note.frontmatter.tier,
                  score: r.score,
                  matchType: r.matchType,
                })),
                null,
                2,
              ),
            );
          });

        mem
          .command("status")
          .description("Vault statistics")
          .action(async () => {
            await ensureInit();
            const s = await vault.stats();
            console.log(JSON.stringify(s, null, 2));
          });

        mem
          .command("consolidate")
          .description("Run manual consolidation")
          .action(async () => {
            await ensureInit();
            const { consolidate } = await import("./ops/consolidate.js");
            const result = await consolidate(vault, cfg);
            console.log(JSON.stringify(result, null, 2));
          });

        mem
          .command("forget")
          .description("Cleanup stale notes")
          .option("--stale", "Archive stale notes")
          .action(async () => {
            await ensureInit();
            const { forget } = await import("./ops/forget.js");
            const result = await forget(vault, cfg);
            console.log(JSON.stringify(result, null, 2));
          });
      },
      { commands: ["memoryz"] },
    );

    // ====================================================================
    // SERVICE
    // ====================================================================

    api.registerService({
      id: "memoryz",
      start: () => {
        api.logger.info(`memoryz: service started (vault: ${cfg.vaultPath})`);
      },
      stop: () => {
        api.logger.info("memoryz: service stopped");
      },
    });
  },
};

export default memoryzPlugin;
