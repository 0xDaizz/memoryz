import * as fs from "node:fs/promises";
import * as path from "node:path";
import { homedir } from "node:os";
import { Note, NoteTier, parseNote, serializeNote, slugify } from "./note.js";
import type { MemoryzConfig } from "../config.js";
import { VaultLock } from "../lock.js";

const TIERS: readonly (NoteTier | "archive")[] = ["hot", "warm", "cold", "archive"] as const;

function resolveTilde(p: string): string {
  return p.startsWith("~") ? path.join(homedir(), p.slice(1)) : p;
}

export class Vault {
  private lock: VaultLock;

  constructor(private config: MemoryzConfig) {
    this.lock = new VaultLock(this.basePath);
  }

  // ── Directory management ──────────────────────────────────────────

  get basePath(): string {
    return path.resolve(resolveTilde(this.config.vaultPath));
  }

  tierPath(tier: NoteTier | "archive"): string {
    return path.join(this.basePath, tier);
  }

  indexPath(): string {
    return path.join(this.basePath, "_index");
  }

  // ── Path safety ─────────────────────────────────────────────────

  private assertWithinVault(filePath: string): string {
    const absolutePath = path.resolve(
      path.isAbsolute(filePath) ? filePath : path.join(this.basePath, filePath),
    );
    if (!absolutePath.startsWith(this.basePath)) {
      throw new Error(`Path traversal detected: ${filePath}`);
    }
    return absolutePath;
  }

  // ── Init ──────────────────────────────────────────────────────────

  async init(): Promise<void> {
    for (const tier of TIERS) {
      await fs.mkdir(this.tierPath(tier), { recursive: true });
    }
    await fs.mkdir(this.indexPath(), { recursive: true });
    await this.lock.init();
  }

  // ── CRUD ──────────────────────────────────────────────────────────

  async createNote(note: Note): Promise<string> {
    const tier = note.frontmatter.tier;
    const dir = this.tierPath(tier);
    const baseSlug = slugify(note.title || note.frontmatter.id);

    let slug = baseSlug;
    let filePath = path.join(dir, `${slug}.md`);

    note.filePath = filePath;
    const content = serializeNote(note);

    for (let attempt = 1; attempt <= 100; attempt++) {
      try {
        await fs.writeFile(filePath, content, { flag: 'wx' });
        return filePath;
      } catch (err: any) {
        if (err?.code !== 'EEXIST') throw err;
        // File exists — try next slug
        slug = `${baseSlug}-${attempt + 1}`;
        filePath = path.join(dir, `${slug}.md`);
        note.filePath = filePath;
      }
    }
    throw new Error(`Too many filename collisions for slug "${baseSlug}"`);
  }

  async readNote(filePath: string): Promise<Note> {
    const absolutePath = this.assertWithinVault(filePath);
    const raw = await fs.readFile(absolutePath, "utf-8");
    return parseNote(raw, absolutePath);
  }

  async updateNote(filePath: string, note: Note): Promise<void> {
    const absolutePath = this.assertWithinVault(filePath);
    note.frontmatter.last_accessed = new Date().toISOString();
    const content = serializeNote(note);
    await fs.writeFile(absolutePath, content, "utf-8");
  }

  async deleteNote(filePath: string): Promise<void> {
    const absolutePath = this.assertWithinVault(filePath);
    await fs.unlink(absolutePath);
  }

  async moveNote(
    filePath: string,
    targetTier: NoteTier | "archive",
  ): Promise<string> {
    return this.lock.withLock("move", async () => {
      const absolutePath = this.assertWithinVault(filePath);

      const note = await this.readNote(absolutePath);

      // Update tier in frontmatter (archive maps to "cold" in the enum since
      // NoteTier doesn't include "archive" — we store it as the directory name
      // but keep the frontmatter tier as the closest semantic match).
      // If targetTier is a valid NoteTier, set it directly.
      if (targetTier === "hot" || targetTier === "warm" || targetTier === "cold") {
        note.frontmatter.tier = targetTier;
      }
      note.frontmatter.last_accessed = new Date().toISOString();

      const filename = path.basename(absolutePath);
      const targetDir = this.tierPath(targetTier);

      // Handle filename collisions at target
      const baseSlug = filename.replace(/\.md$/, "");
      let finalFilename = filename;
      let newPath = path.join(targetDir, finalFilename);
      let counter = 2;
      while (counter <= 100) {
        try {
          await fs.access(newPath);
          finalFilename = `${baseSlug}-${counter}.md`;
          newPath = path.join(targetDir, finalFilename);
          counter++;
        } catch {
          break;
        }
      }
      if (counter > 100) {
        throw new Error(`Too many filename collisions for "${filename}" in ${targetTier}`);
      }

      note.filePath = newPath;
      const content = serializeNote(note);

      // Atomic write: write to temp file, then rename
      const tmpPath = path.join(targetDir, `.tmp-${finalFilename}`);
      await fs.writeFile(tmpPath, content, "utf-8");
      try {
        await fs.rename(tmpPath, newPath);
      } catch (err) {
        // Clean up temp file on failure
        try {
          await fs.unlink(tmpPath);
        } catch {
          // ignore cleanup failure
        }
        throw err;
      }
      await fs.unlink(absolutePath);

      return newPath;
    });
  }

  // ── Listing ───────────────────────────────────────────────────────

  async listNotes(tier: NoteTier | "archive"): Promise<Note[]> {
    const dir = this.tierPath(tier);
    let entries: string[];
    try {
      entries = await fs.readdir(dir);
    } catch {
      return [];
    }

    const notes: Note[] = [];
    for (const entry of entries) {
      if (!entry.endsWith(".md") || entry === "INDEX.md") continue;
      const fp = path.join(dir, entry);
      try {
        const raw = await fs.readFile(fp, "utf-8");
        notes.push(parseNote(raw, fp));
      } catch {
        // skip unreadable / unparsable files
      }
    }
    return notes;
  }

  async listAllNotes(): Promise<Note[]> {
    const results: Note[] = [];
    for (const tier of TIERS) {
      const notes = await this.listNotes(tier);
      results.push(...notes);
    }
    return results;
  }

  // ── Hot INDEX.md ──────────────────────────────────────────────────

  async readHotIndex(): Promise<string> {
    const indexFile = path.join(this.tierPath("hot"), "INDEX.md");
    try {
      return await fs.readFile(indexFile, "utf-8");
    } catch {
      return "";
    }
  }

  async rebuildHotIndex(): Promise<void> {
    await this.lock.withLock("hot-index", async () => {
      const notes = await this.listNotes("hot");

      // Sort by created descending
      notes.sort((a, b) => {
        const da = new Date(a.frontmatter.created).getTime();
        const db = new Date(b.frontmatter.created).getTime();
        return db - da;
      });

      // Intentionally using local timezone for display — all nodes in this
      // cluster share the same timezone, so local time is consistent.
      const lines = notes.map((n) => {
        const d = new Date(n.frontmatter.created);
        const hh = String(d.getHours()).padStart(2, "0");
        const mm = String(d.getMinutes()).padStart(2, "0");
        return `- [${hh}:${mm}] ${n.title}`;
      });

      const content = lines.length > 0 ? lines.join("\n") + "\n" : "";
      const indexFile = path.join(this.tierPath("hot"), "INDEX.md");
      await fs.writeFile(indexFile, content, "utf-8");
    });
  }

  // ── _index management ─────────────────────────────────────────────

  async rebuildEntityIndex(notes?: Note[]): Promise<void> {
    await this.lock.withLock("entity-index", async () => {
      const allNotes = notes ?? await this.listAllNotes();
      const entityMap: Record<string, string[]> = {};

      for (const note of allNotes) {
        const fp = note.filePath;
        if (!fp || note.frontmatter.entities.length === 0) continue;
        for (const entity of note.frontmatter.entities) {
          const key = entity.toLowerCase();
          if (!entityMap[key]) entityMap[key] = [];
          if (!entityMap[key].includes(fp)) {
            entityMap[key].push(fp);
          }
        }
      }

      const outPath = path.join(this.indexPath(), "entities.json");
      await fs.writeFile(outPath, JSON.stringify(entityMap, null, 2), "utf-8");
    });
  }

  async rebuildTagIndex(notes?: Note[]): Promise<void> {
    await this.lock.withLock("tag-index", async () => {
      const allNotes = notes ?? await this.listAllNotes();
      const tagMap: Record<string, string[]> = {};

      for (const note of allNotes) {
        const fp = note.filePath;
        if (!fp || note.frontmatter.tags.length === 0) continue;
        for (const tag of note.frontmatter.tags) {
          const key = tag.toLowerCase();
          if (!tagMap[key]) tagMap[key] = [];
          if (!tagMap[key].includes(fp)) {
            tagMap[key].push(fp);
          }
        }
      }

      const outPath = path.join(this.indexPath(), "tags.json");
      await fs.writeFile(outPath, JSON.stringify(tagMap, null, 2), "utf-8");
    });
  }

  async rebuildIndexes(): Promise<void> {
    const allNotes = await this.listAllNotes();
    await Promise.all([this.rebuildEntityIndex(allNotes), this.rebuildTagIndex(allNotes)]);
  }

  async readEntityIndex(): Promise<Record<string, string[]>> {
    const fp = path.join(this.indexPath(), "entities.json");
    try {
      const raw = await fs.readFile(fp, "utf-8");
      return JSON.parse(raw) as Record<string, string[]>;
    } catch {
      return {};
    }
  }

  async readTagIndex(): Promise<Record<string, string[]>> {
    const fp = path.join(this.indexPath(), "tags.json");
    try {
      const raw = await fs.readFile(fp, "utf-8");
      return JSON.parse(raw) as Record<string, string[]>;
    } catch {
      return {};
    }
  }

  // ── Access log ────────────────────────────────────────────────────

  async logAccess(filePath: string, sessionKey?: string): Promise<void> {
    const entry = {
      file: filePath,
      at: Date.now(),
      ...(sessionKey ? { session: sessionKey } : {}),
    };
    const logFile = path.join(this.indexPath(), "access-log.jsonl");
    await fs.appendFile(logFile, JSON.stringify(entry) + "\n", "utf-8");

    // Simple rotation: if log exceeds 1 MB, keep only the last 1000 lines
    try {
      const stat = await fs.stat(logFile);
      if (stat.size > 1_048_576) {
        await this.lock.withLock("access-log-rotation", async () => {
          const raw = await fs.readFile(logFile, "utf-8");
          const lines = raw.trim().split("\n");
          const trimmed = lines.slice(-1000).join("\n") + "\n";
          await fs.writeFile(logFile, trimmed, "utf-8");
        });
      }
    } catch {
      // ignore stat/rotation errors
    }
  }

  async getAccessLog(
    limit?: number,
  ): Promise<Array<{ file: string; at: number; session?: string }>> {
    const logFile = path.join(this.indexPath(), "access-log.jsonl");
    let raw: string;
    try {
      raw = await fs.readFile(logFile, "utf-8");
    } catch {
      return [];
    }

    const lines = raw.trim().split("\n").filter(Boolean);
    const entries: Array<{ file: string; at: number; session?: string }> = [];
    for (const line of lines) {
      try {
        entries.push(JSON.parse(line) as { file: string; at: number; session?: string });
      } catch {
        // skip corrupted lines
      }
    }

    // Newest first
    entries.reverse();

    if (limit !== undefined && limit > 0) {
      return entries.slice(0, limit);
    }
    return entries;
  }

  // ── Stats ─────────────────────────────────────────────────────────

  async stats(): Promise<{
    hot: number;
    warm: number;
    cold: number;
    archive: number;
    total: number;
  }> {
    const counts = { hot: 0, warm: 0, cold: 0, archive: 0, total: 0 };
    for (const tier of TIERS) {
      try {
        const entries = await fs.readdir(this.tierPath(tier));
        const mdCount = entries.filter(
          (e) => e.endsWith(".md") && e !== "INDEX.md",
        ).length;
        counts[tier] = mdCount;
        counts.total += mdCount;
      } catch {
        // directory may not exist yet
      }
    }
    return counts;
  }
}
