import * as fs from "node:fs/promises";
import * as path from "node:path";

export class VaultLock {
  private lockDir: string;

  constructor(vaultBasePath: string) {
    this.lockDir = path.join(vaultBasePath, "_locks");
  }

  async init(): Promise<void> {
    await fs.mkdir(this.lockDir, { recursive: true });
  }

  /**
   * Acquire a named lock using mkdir atomicity.
   * mkdir is atomic on POSIX — if the dir already exists, it fails.
   * Returns a release function.
   * Retries with backoff up to maxWaitMs (default 5000ms).
   */
  async acquire(name: string, maxWaitMs = 5000): Promise<() => Promise<void>> {
    const lockPath = path.join(this.lockDir, `${name}.lock`);
    const start = Date.now();
    const staleMs = 30000; // Consider locks older than 30s as stale

    while (true) {
      try {
        // mkdir is atomic - use as lock primitive
        await fs.mkdir(lockPath);
        // Write PID and timestamp for stale lock detection
        await fs.writeFile(
          path.join(lockPath, "info"),
          JSON.stringify({ pid: process.pid, at: Date.now(), host: process.env.HOSTNAME || "unknown" }),
        );
        // Return release function
        return async () => {
          try {
            await fs.rm(lockPath, { recursive: true });
          } catch {
            // Already released
          }
        };
      } catch (err: unknown) {
        if (err instanceof Error && (err as NodeJS.ErrnoException).code !== "EEXIST") throw err;

        // Check for stale lock
        try {
          const infoPath = path.join(lockPath, "info");
          const raw = await fs.readFile(infoPath, "utf-8");
          const info = JSON.parse(raw) as { pid: number; at: number; host: string };
          if (Date.now() - info.at > staleMs) {
            // Stale lock — force remove and retry
            await fs.rm(lockPath, { recursive: true }).catch(() => {});
            continue;
          }
        } catch {
          // Can't read lock info — try to remove if it looks stale
          try {
            const stat = await fs.stat(lockPath);
            if (Date.now() - stat.mtimeMs > staleMs) {
              await fs.rm(lockPath, { recursive: true }).catch(() => {});
              continue;
            }
          } catch { /* ignore */ }
        }

        // Check timeout
        if (Date.now() - start >= maxWaitMs) {
          throw new Error(`Failed to acquire lock "${name}" after ${maxWaitMs}ms`);
        }

        // Backoff: 50-200ms jitter
        await new Promise((r) => setTimeout(r, 50 + Math.random() * 150));
      }
    }
  }

  /**
   * Execute a function while holding a lock.
   */
  async withLock<T>(name: string, fn: () => Promise<T>, maxWaitMs?: number): Promise<T> {
    const release = await this.acquire(name, maxWaitMs);
    try {
      return await fn();
    } finally {
      await release();
    }
  }
}
