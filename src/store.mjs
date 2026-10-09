import {
  mkdir,
  readFile,
  writeFile,
  rename,
  open,
  unlink,
  stat,
} from "node:fs/promises";
import { dirname } from "node:path";
import { randomUUID } from "node:crypto";
export const emptyState = () => ({ version: 1, observations: {}, blocks: {} });
export class StateStore {
  constructor(path) {
    this.path = path;
    this.queue = Promise.resolve();
  }
  async read() {
    try {
      const x = JSON.parse(await readFile(this.path, "utf8"));
      if (x.version !== 1 || !x.observations || !x.blocks)
        throw new Error("Unsupported quota state");
      return x;
    } catch (e) {
      if (e.code === "ENOENT") return emptyState();
      throw e;
    }
  }
  update(mutator) {
    const job = this.queue.then(async () => {
      await mkdir(dirname(this.path), { recursive: true, mode: 0o700 });
      const lock = this.path + ".lock";
      let handle;
      const deadline = Date.now() + 5000;
      while (!handle) {
        try {
          handle = await open(lock, "wx", 0o600);
        } catch (e) {
          if (e.code !== "EEXIST") throw e;
          // Reclaim only an old lock whose owner has gone away.
          try {
            const owner = Number(await readFile(lock, "utf8"));
            let alive = true;
            try {
              process.kill(owner, 0);
            } catch (error) {
              if (error.code === "ESRCH") alive = false;
            }
            if (!alive && Date.now() - (await stat(lock)).mtimeMs > 30000)
              await unlink(lock);
          } catch {}
          if (Date.now() >= deadline) throw new Error("Quota state lock busy");
          await new Promise((r) => setTimeout(r, 25));
        }
      }
      await handle.writeFile(String(process.pid));
      const temp = this.path + "." + randomUUID() + ".tmp";
      try {
        const state = await this.read();
        await mutator(state);
        await writeFile(temp, JSON.stringify(state, null, 2) + "\n", {
          mode: 0o600,
          flag: "wx",
        });
        await rename(temp, this.path);
        return state;
      } finally {
        await unlink(temp).catch(() => {});
        await handle.close();
        await unlink(lock).catch(() => {});
      }
    });
    this.queue = job.catch(() => {});
    return job;
  }
}
