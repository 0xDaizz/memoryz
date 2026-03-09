# Memoryz -- Persistent Memory Plugin for OpenClaw

AI agents are stateless by default. Every time a session ends, the context is gone. Memoryz solves this by giving your OpenClaw agent a persistent, human-readable memory system -- an Obsidian-style markdown vault with automatic capture, recall, and tiered lifecycle management. Memories are organized across Hot, Warm, and Cold tiers so the agent always has fast access to recent context while older knowledge gracefully ages into long-term storage.

## Getting Started

### Prerequisites

- [OpenClaw](https://github.com/openclaw/openclaw) installed and running
- Node.js 18+

### 1. Clone the repository

```bash
git clone https://github.com/nicepkg/memoryz.git
cd memoryz
```

### 2. Install dependencies and build

```bash
npm install
npm run build
```

### 3. Install the plugin

```bash
openclaw plugins install ./memoryz
```

For development (symlink mode -- reflects source changes immediately):

```bash
openclaw plugins install --link ./memoryz
```

### 4. Configure the plugin

Add the following to `plugins.entries.memoryz.config` in your `~/.openclaw/openclaw.json`:

```json
{
  "vaultPath": "~/.openclaw/memoryz",
  "summarizer": {
    "provider": "rules"
  },
  "tiers": {
    "hotMaxAge": 7200000,
    "warmMaxAge": 604800000,
    "coldArchiveAge": 2592000000,
    "hotMaxNotes": 50
  },
  "recall": {
    "enabled": true,
    "maxPointers": 5,
    "maxTokens": 800
  },
  "capture": {
    "enabled": true,
    "minLength": 20,
    "maxPerTurn": 3
  },
  "consolidateIntervalMs": 1800000
}
```

### 5. Restart the gateway and verify

```bash
openclaw restart
openclaw plugins info memoryz
openclaw memoryz status
```

If everything is working, you should see per-tier note counts in JSON format.

---

## How It Works

### 4 Core Operations

| Operation | Trigger | Description |
|-----------|---------|-------------|
| **CAPTURE** | After each turn (`agent_end`) | Extracts important info from conversation and saves as `hot/` notes |
| **RECALL** | Before each turn (`before_prompt_build`) | Searches relevant memories and injects them into system context |
| **CONSOLIDATE** | Periodic (`agent_end`, throttled) | Moves notes across Hot > Warm > Cold tiers, merges duplicates, adds wikilinks |
| **FORGET** | Manual or CLI | Archives notes with 30+ days of no access and no links |

### Vault Structure

```
<vault-path>/
├── hot/          # Recent memories (accessed within 2 hours)
│   └── INDEX.md  # Auto-generated, injected into recall context each turn
├── warm/         # Medium-term memories (2 hours - 7 days)
├── cold/         # Long-term memories (7 - 30 days)
├── archive/      # Archived (30+ days, forget target)
└── _index/
    ├── entities.json     # Entity index
    ├── tags.json         # Tag index
    └── access-log.jsonl  # Access log
```

### Note Format

Each note is composed of YAML frontmatter and a Markdown body.

```markdown
---
id: a1b2c3d4e5f6
type: fact
tier: hot
created: 2026-03-09T12:00:00.000Z
last_accessed: 2026-03-09T12:00:00.000Z
access_count: 1
source_session: explicit
entities: [OpenClaw, Memoryz]
tags: [plugin, memory]
access: public
---

# Memoryz is a persistent memory plugin for OpenClaw

Uses an Obsidian-style markdown vault with
hot/warm/cold tiers for automatic memory management.
```

**Frontmatter Fields:**

| Field | Type | Description |
|-------|------|-------------|
| `id` | string | 12-character UUID-based unique ID |
| `type` | enum | `event`, `fact`, `preference`, `decision`, `entity`, `insight` |
| `tier` | enum | `hot`, `warm`, `cold` |
| `created` | ISO 8601 | Creation timestamp |
| `last_accessed` | ISO 8601 | Last access timestamp |
| `access_count` | number | Access count |
| `source_session` | string | Session key that created this note (or `"explicit"`) |
| `entities` | string[] | Related entities |
| `tags` | string[] | Tags |
| `access` | enum | `public` or `owner-only` |

---

## Agent Tools

Once the plugin is registered, the agent has access to these tools:

| Tool | Description |
|------|-------------|
| `memoryz_search` | Search the vault (weighted entity/tag/fulltext). Params: `query`, `tier?`, `limit?` |
| `memoryz_read` | Read a specific note in full. Params: `path` |
| `memoryz_remember` | Explicitly store a memory ("remember this"). Params: `text`, `entities?`, `tags?`, `access?` |
| `memoryz_forget` | Delete a memory note. Params: `path` |
| `memoryz_status` | Vault statistics (note counts per tier, recent access log) |

---

## CLI Commands

```bash
openclaw memoryz search <query>            # Search the vault
openclaw memoryz search <query> --limit 20 # Limit results
openclaw memoryz status                    # Per-tier stats (JSON)
openclaw memoryz consolidate               # Manual consolidation
openclaw memoryz forget --stale            # Archive stale notes
```

---

## Configuration

All settings live under `plugins.entries.memoryz.config` in your `openclaw.json`.

### Top-Level

| Key | Type | Default | Description |
|-----|------|---------|-------------|
| `vaultPath` | string | **required** | Path to the vault directory |
| `consolidateIntervalMs` | number | `1800000` (30 min) | Minimum interval between consolidations (ms) |
| `accessControl` | boolean | `false` | Enable `owner-only` access filtering |

### `summarizer` -- Summary Engine

| Key | Type | Default | Description |
|-----|------|---------|-------------|
| `provider` | enum | `"agent-model"` | `"rules"`, `"openai-compatible"`, or `"agent-model"` |
| `baseUrl` | string | -- | OpenAI-compatible API URL (required for `"openai-compatible"`) |
| `model` | string | -- | Model name (required for `"openai-compatible"`) |
| `apiKey` | string | -- | API key (required for `"openai-compatible"`) |

**Provider Comparison:**

| Provider | Description | Cost | Latency |
|----------|-------------|------|---------|
| `rules` | Rule-based extraction, no LLM needed | 0 | <10ms |
| `openai-compatible` | Any OpenAI-compatible API (vLLM, Ollama, OpenAI, etc.) | varies | ~1s |
| `agent-model` | Auto-detects API keys (Anthropic, OpenAI) and uses the cheapest available model | low | ~1s |

### `tiers` -- Tier Management

| Key | Type | Default | Description |
|-----|------|---------|-------------|
| `hotMaxAge` | number | `7200000` (2h) | Notes accessed within this window stay in hot |
| `warmMaxAge` | number | `604800000` (7d) | Notes accessed within this window stay in warm |
| `coldArchiveAge` | number | `2592000000` (30d) | Notes older than this become archive candidates |
| `hotMaxNotes` | number | `50` | Maximum notes in hot tier |

### `recall` -- Automatic Recall

| Key | Type | Default | Description |
|-----|------|---------|-------------|
| `enabled` | boolean | `true` | Enable automatic recall |
| `maxPointers` | number | `5` | Max note pointers returned per recall |
| `maxTokens` | number | `800` | Token budget for recall context injection |

### `capture` -- Automatic Capture

| Key | Type | Default | Description |
|-----|------|---------|-------------|
| `enabled` | boolean | `true` | Enable automatic capture |
| `minLength` | number | `20` | Minimum text length to capture (chars) |
| `maxPerTurn` | number | `3` | Max notes captured per turn |

### Environment Variable Substitution

Config string values support `${VAR}` patterns resolved from environment variables.
Allowed variables: `HOME`, `USER`, `OPENCLAW_MEMORYZ_VAULT_PATH`.

```json
{
  "vaultPath": "${HOME}/.openclaw/memoryz"
}
```

---

## Multi-Node Deployment

To run Memoryz across multiple machines, install the plugin on each node individually.

```bash
# 1. Copy the source to each node
for host in <node1> <node2> <node3>; do
  scp -r ./memoryz user@${host}:~/memoryz
done

# 2. Install on each node
for host in <node1> <node2> <node3>; do
  ssh user@${host} 'openclaw plugins install ~/memoryz && openclaw restart'
done
```

Replace `<node1>`, `<node2>`, `<node3>` with your target hostnames or IP addresses, and `user` with the appropriate SSH user.

**Notes:**
- Each node maintains its own **local vault** (vaults are not shared via NFS or network mounts).
- Cross-node memory sharing is handled via inter-agent communication (A2A).

---

## Development

```bash
npm install        # Install dependencies (including devDependencies)
npm run build      # TypeScript build
npm test           # Run tests (vitest)
npm run test:watch # Watch mode
```

### Dependencies

- **Runtime**: `@sinclair/typebox` 0.34.48, `openai` ^6.27.0
- **Dev**: `typescript` ^5.8.0, `vitest` ^3.0.0, `@types/node` ^22.0.0

---

## Architecture

```
 ┌─────────────────────────────────────────────────────────┐
 │                    OpenClaw Agent                       │
 │                                                        │
 │  before_prompt_build ──┐      ┌── agent_end            │
 └────────────────────────┼──────┼────────────────────────┘
                          │      │
                    ┌─────▼──────▼─────┐
                    │     Memoryz      │
                    │                  │
                    │  ┌────────────┐  │
                    │  │  RECALL    │◄─┼── context injection
                    │  └────────────┘  │
                    │  ┌────────────┐  │
                    │  │  CAPTURE   │──┼── memory storage
                    │  └────────────┘  │
                    │  ┌────────────┐  │
                    │  │ CONSOLIDATE│──┼── tier migration/merge
                    │  └────────────┘  │
                    │  ┌────────────┐  │
                    │  │  FORGET    │──┼── archive
                    │  └────────────┘  │
                    └────────┬─────────┘
                             │
                    ┌────────▼─────────┐
                    │   Markdown Vault │
                    │                  │
                    │  hot/  warm/     │
                    │  cold/ archive/  │
                    │  _index/         │
                    └──────────────────┘
                             │
                    ┌────────▼─────────┐
                    │   Summarizer     │
                    │  (rules / openai-compatible)  │
                    └──────────────────┘
```

---

## Relationship with memory-core / memory-lancedb

Memoryz does **not** replace existing memory plugins. It registers with `kind: null` and can coexist with them.

| Plugin | Approach | Characteristics |
|--------|----------|-----------------|
| `memory-core` | File-based search | Built-in to OpenClaw |
| `memory-lancedb` | Vector DB semantic search | Requires embeddings |
| **memoryz** | Markdown vault | Human-readable, structured, tiered memory |

---

## License

MIT
