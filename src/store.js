import { mkdir, readFile, writeFile, rename, unlink, open } from 'node:fs/promises';
import path from 'node:path';
import { randomUUID, createHash } from 'node:crypto';
import { DEFAULT_PREFERENCES } from './preferences.js';

export class Store {
  constructor(directory) {
    this.directory = directory;
    this.file = path.join(directory, 'records.json');
    this.queue = Promise.resolve();
    this.closed = false;
  }

  async init() {
    await mkdir(this.directory, { recursive: true });
    this.lockPath = path.join(this.directory, 'store.lock');
    this.lock = await open(this.lockPath, 'wx').catch(error => {
      if (error.code === 'EEXIST') throw new Error(`Data store already locked: ${this.lockPath}. Close the other server; investigate a stale lock before removing it.`);
      throw error;
    });
    try {
      await this.lock.writeFile(String(process.pid));
      try {
        const raw = await readFile(this.file, 'utf8');
        const parsed = JSON.parse(raw);
        if (parsed.version !== 1 || !Array.isArray(parsed.boards) || !Array.isArray(parsed.records) || !parsed.preferences || typeof parsed.preferences !== 'object') {
          throw new Error('Unsupported or malformed data store');
        }
        this.data = parsed;
      } catch (error) {
        if (error.code !== 'ENOENT') throw error;
        this.data = { version: 1, preferences: structuredClone(DEFAULT_PREFERENCES), boards: [], records: [] };
      }
      return this;
    } catch (error) {
      await this.close();
      throw error;
    }
  }

  snapshot() {
    return structuredClone(this.data);
  }

  mutate(operation) {
    if (this.closed) return Promise.reject(new Error('Store is closed'));
    const run = this.queue.then(async () => {
      const next = structuredClone(this.data);
      const result = operation(next);
      const temp = path.join(this.directory, `records-${randomUUID()}.tmp`);
      try {
        await writeFile(temp, JSON.stringify(next, null, 2), { flag: 'wx', mode: 0o600 });
        await rename(temp, this.file);
      } catch (error) {
        await unlink(temp).catch(() => {});
        throw error;
      }
      this.data = next;
      return structuredClone(result);
    });
    this.queue = run.catch(() => {});
    return run;
  }

  upsert(record) {
    const url = new URL(record.url);
    url.hash = '';
    for (const key of [...url.searchParams.keys()]) {
      if (/^utm_|^(trk|trackingId|refId)$/i.test(key)) url.searchParams.delete(key);
    }
    const id = createHash('sha256').update(`${record.kind}:${url.href}`).digest('hex').slice(0, 24);
    return this.mutate(data => {
      const saved = { ...record, id, url: url.href };
      const index = data.records.findIndex(item => item.id === id);
      if (index < 0) data.records.push(saved);
      else data.records[index] = saved;
      return saved;
    });
  }

  async close() {
    if (this.closed) return;
    this.closed = true;
    await this.queue;
    if (this.lock) {
      await this.lock.close();
      await unlink(this.lockPath);
      this.lock = null;
    }
  }
}
