# Memoryz Operations Runbook

> **Note:** This runbook assumes default configuration. Adjust paths and values to match your `openclaw.json` settings. All examples use `$VAULT_PATH` to represent the configured vault directory (default: `~/.openclaw/memoryz`).

---

## Daily Operations

### Check Vault Status

```bash
openclaw memoryz status
```

### Check Logs

```bash
# Recent access log
cat $VAULT_PATH/_index/access-log.jsonl | tail -20 | jq .

# Hot notes list
cat $VAULT_PATH/hot/INDEX.md
```

### Manual Consolidation

```bash
openclaw memoryz consolidate
```

Consolidation normally runs automatically via the `agent_end` hook at the interval defined by `consolidateIntervalMs` (default: 30 min). Manual execution performs hot-to-warm migration, warm-to-cold migration, cold-to-warm promotion, note merging, and wikilink generation in a single pass.

### Stale Note Cleanup

```bash
openclaw memoryz forget --stale
```

Moves notes with no access for `coldArchiveAge` (default: 30 days) and `access_count < 3` to the archive.

---

## Troubleshooting

### Capture Not Working

1. Verify the plugin is enabled: check `capture.enabled: true` in `openclaw.json`.
2. Search gateway logs for `memoryz: capture failed`.
3. If using the `openai-compatible` provider, verify the API endpoint is accessible.
4. Check whether messages are too short: `capture.minLength` (default: 20 chars).
5. Check whether the per-turn limit has been reached: `capture.maxPerTurn` (default: 3).

### Recall Not Working

1. Verify `recall.enabled: true` in your configuration.
2. If `hot/INDEX.md` is empty, capture needs to run first.
3. Verify `_index/entities.json` and `_index/tags.json` exist under `$VAULT_PATH`.
4. Test with a manual search: `openclaw memoryz search "test query"`.
5. Check `recall.maxPointers` (default: 5) and `recall.maxTokens` (default: 800).

### Hot Notes Not Moving to Warm

1. Check `consolidateIntervalMs` (default: 1,800,000 ms / 30 min).
2. Check `tiers.hotMaxAge` (default: 7,200,000 ms / 2 h) -- notes accessed within this window remain in the hot tier.
3. Run consolidation manually: `openclaw memoryz consolidate`.
4. Check for stale locks: `ls $VAULT_PATH/_locks/`.

### Lock Not Releasing

Locks use directory-based locking via `mkdir` atomicity. Any lock held for more than 30 seconds is considered stale.

```bash
# Check lock status
ls -la $VAULT_PATH/_locks/
cat $VAULT_PATH/_locks/*.lock/info 2>/dev/null | jq .

# Remove stale locks (older than 1 minute)
find $VAULT_PATH/_locks -name "*.lock" -mmin +1 -exec rm -rf {} +
```

The runtime automatically detects and removes stale locks (>30 s) during `acquire()`. Manual removal should only be necessary after abnormal process termination.

### Vault Data Recovery

```bash
# Restore a note from archive to warm
mv $VAULT_PATH/archive/target-note.md $VAULT_PATH/warm/

# Rebuild indexes (always run after manual note moves)
openclaw memoryz consolidate
```

---

## Monitoring

### Key Metrics

| Metric | Normal Range | How to Check |
|--------|-------------|--------------|
| Hot note count | <= 50 (`tiers.hotMaxNotes`) | `openclaw memoryz status` |
| access-log.jsonl size | <= 1 MB | `ls -la $VAULT_PATH/_index/access-log.jsonl` |
| Stale locks in `_locks/` | None | `ls $VAULT_PATH/_locks/` |
| `_index/entities.json` | Must exist | `ls $VAULT_PATH/_index/` |
| `_index/tags.json` | Must exist | `ls $VAULT_PATH/_index/` |

### Alert Conditions

- **Hot notes > 100**: Consolidation is not running. Check `consolidateIntervalMs` and lock status.
- **access-log.jsonl > 5 MB**: Auto-rotation has failed. The log is designed to retain only the most recent 1,000 lines when it exceeds 1 MB, but lock contention can cause rotation to be skipped.
- **Locks older than 1 minute in `_locks/`**: A process crash left an unreleased lock. Manual removal is required.

---

## Backup

```bash
tar czf memoryz-backup-$(date +%Y%m%d).tar.gz -C $(dirname $VAULT_PATH) $(basename $VAULT_PATH)
```

Backups include the `_index/` and `_locks/` directories. When restoring, delete the contents of `_locks/` and run `openclaw memoryz consolidate` to rebuild indexes.

---

## Updates

```bash
# Update the plugin from source
openclaw plugins install <path-to-memoryz-source>

# Restart the gateway
openclaw restart
```

Always back up the vault before updating. For rolling updates across multiple nodes, update one node at a time and verify health before proceeding.

---

## Configuration Changes

Configuration location: `openclaw.json` at `plugins.entries.memoryz.config`.

### Changing the Summarizer Endpoint

Update `summarizer.baseUrl` in your configuration and restart the gateway:

```bash
cat <openclaw-config-path>/openclaw.json | jq '.plugins.entries.memoryz.config.summarizer'
# Edit the config file, then:
openclaw restart
```

### Tier Threshold Changes

| Key | Default | Description |
|-----|---------|-------------|
| `tiers.hotMaxAge` | 7,200,000 (2 h) | Hot tier retention time |
| `tiers.warmMaxAge` | 604,800,000 (7 d) | Warm tier retention time |
| `tiers.coldArchiveAge` | 2,592,000,000 (30 d) | Cold-to-archive threshold |
| `tiers.hotMaxNotes` | 50 | Maximum notes in hot tier |
| `consolidateIntervalMs` | 1,800,000 (30 min) | Auto-consolidation interval |

All values are in milliseconds. A gateway restart is required after changes.

### Disabling Capture or Recall

For emergencies, individual features can be disabled in `openclaw.json`:

```json
{
  "capture": { "enabled": false },
  "recall": { "enabled": false }
}
```

Restart the gateway after making changes.

---

## Vault Directory Reference

```
$VAULT_PATH/
  hot/            # Recently created or accessed notes (INDEX.md is auto-generated)
  warm/           # Medium-frequency access notes
  cold/           # Older, lower-frequency notes
  archive/        # Long-term inactive notes (access_count < 3)
  _index/         # Index files
    entities.json       # Entity-to-note-path mapping
    tags.json           # Tag-to-note-path mapping
    access-log.jsonl    # Access log (auto-rotated at 1 MB)
  _locks/         # Directory-based lock files
```
