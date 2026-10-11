import fs from 'node:fs';
import path from 'node:path';

function serializableError(error) {
  if (!(error instanceof Error)) return String(error);
  return {
    name: error.name,
    message: error.message,
    stack: error.stack,
  };
}

export class Logger {
  constructor(directory, retentionDays) {
    this.directory = directory;
    this.retentionDays = retentionDays;
    fs.mkdirSync(directory, { recursive: true, mode: 0o700 });
    this.prune();
  }

  write(level, event, fields = {}) {
    const now = new Date();
    const file = path.join(this.directory, `gpt-web-${now.toISOString().slice(0, 10)}.log`);
    const cleanFields = {};
    for (const [key, value] of Object.entries(fields)) {
      cleanFields[key] = value instanceof Error ? serializableError(value) : value;
    }
    const line = JSON.stringify({
      timestamp: now.toISOString(),
      level,
      event,
      ...cleanFields,
    });
    fs.appendFileSync(file, `${line}\n`, { encoding: 'utf8', mode: 0o600 });
  }

  info(event, fields) {
    this.write('info', event, fields);
  }

  warn(event, fields) {
    this.write('warn', event, fields);
  }

  error(event, fields) {
    this.write('error', event, fields);
  }

  prune() {
    const cutoff = Date.now() - this.retentionDays * 86_400_000;
    for (const entry of fs.readdirSync(this.directory, { withFileTypes: true })) {
      if (!entry.isFile() || !/^gpt-web-\d{4}-\d{2}-\d{2}\.log$/.test(entry.name)) continue;
      const file = path.join(this.directory, entry.name);
      try {
        if (fs.statSync(file).mtimeMs < cutoff) fs.unlinkSync(file);
      } catch {
        // A concurrently rotated file can disappear safely.
      }
    }
  }
}
