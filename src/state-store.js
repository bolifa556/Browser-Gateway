import fs from 'node:fs';
import path from 'node:path';

export class StateStore {
  constructor(directory, logger) {
    this.directory = directory;
    this.logger = logger;
    this.file = path.join(directory, 'sessions.json');
    this.pending = null;
    fs.mkdirSync(directory, { recursive: true, mode: 0o700 });
    this.data = { version: 1, sessions: {} };
    this.load();
  }

  load() {
    try {
      const parsed = JSON.parse(fs.readFileSync(this.file, 'utf8'));
      if (parsed?.version === 1 && parsed.sessions && typeof parsed.sessions === 'object') {
        this.data = parsed;
      }
    } catch (error) {
      if (error?.code !== 'ENOENT') this.logger.warn('state_load_failed', { error });
    }
  }

  get(sessionKey) {
    return this.data.sessions[sessionKey] || null;
  }

  update(sessionKey, patch) {
    const existing = this.data.sessions[sessionKey] || {};
    this.data.sessions[sessionKey] = {
      ...existing,
      ...patch,
      updatedAt: new Date().toISOString(),
    };
    this.scheduleFlush();
  }

  remove(sessionKey) {
    delete this.data.sessions[sessionKey];
    this.scheduleFlush();
  }

  scheduleFlush() {
    if (this.pending) return;
    this.pending = setTimeout(() => {
      this.pending = null;
      this.flush();
    }, 500);
    this.pending.unref?.();
  }

  flush() {
    const temporary = `${this.file}.tmp`;
    fs.writeFileSync(temporary, `${JSON.stringify(this.data, null, 2)}\n`, {
      encoding: 'utf8',
      mode: 0o600,
    });
    fs.renameSync(temporary, this.file);
  }
}
