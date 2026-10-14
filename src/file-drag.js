import fs from 'node:fs/promises';
import path from 'node:path';
import crypto from 'node:crypto';

const extensions = new Map(Object.entries({
  'text/plain': 'txt', 'text/csv': 'csv', 'text/markdown': 'md', 'application/pdf': 'pdf',
  'application/zip': 'zip', 'application/x-zip-compressed': 'zip',
  'image/png': 'png', 'image/jpeg': 'jpg', 'image/webp': 'webp', 'image/gif': 'gif',
  'application/json': 'json', 'application/msword': 'doc',
  'application/vnd.openxmlformats-officedocument.wordprocessingml.document': 'docx',
  'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet': 'xlsx',
  'application/vnd.openxmlformats-officedocument.presentationml.presentation': 'pptx',
}));
const validId = id => typeof id === 'string' && /^[a-z0-9-]{8,80}$/i.test(id);

// CDP needs actual file entries to expose native DataTransfer.items of kind
// "file". Zero-byte placeholders are used only for protected drag previews;
// they are never dropped. Real files still use the existing upload endpoint.
export class RemoteFileDrag {
  constructor({ cdp, directory, geometry, onError = () => {}, idleMs = 15000 }) {
    Object.assign(this, { cdp, directory, geometry, onError, idleMs });
    this.queue = Promise.resolve();this.retired = new Map();this.active = null;
  }
  enqueue(work) {
    const next = this.queue.catch(() => {}).then(work);this.queue = next;return next;
  }
  retire(id) {
    if (validId(id)) this.retired.set(id, Date.now());
    for (const [key, at] of this.retired) if (Date.now() - at > 120000 || this.retired.size > 64) this.retired.delete(key);
  }
  position(message) {
    const { width, height } = this.geometry();
    // CDP drag events use CSS pixels, independently of the capture's DPR.
    return { x: Math.max(0, Math.min(width - 1, Number(message.x) || 0)),
      y: Math.max(0, Math.min(height - 1, Number(message.y) || 0)) };
  }
  async cancelNow() {
    clearTimeout(this.timer);const active = this.active;this.active = null;
    if (!active) return;
    try {
      // Chromium's dragCancel alone can leave the renderer's drop target
      // hovered. Crossing its boundary first produces the real dragleave.
      await this.cdp.send('Input.dispatchDragEvent', { type: 'dragOver', x: -1, y: -1, data: active.data });
      await this.cdp.send('Input.dispatchDragEvent', { type: 'dragCancel', x: -1, y: -1, data: active.data });
    } finally {
      await this.cdp.send('Input.cancelDragging').catch(() => {});
      await fs.rm(active.directory, { recursive: true, force: true });
    }
  }
  cancel(id) {
    // Retire immediately: an HTTP drop can beat its earlier WebSocket preview.
    this.retire(validId(id) ? id : this.active?.id);
    return this.enqueue(() => this.cancelNow());
  }
  handle(message) {
    if (this.closed || !validId(message.id) || !['enter', 'over', 'cancel'].includes(message.eventType)) return Promise.resolve();
    if (message.eventType === 'cancel') {
      this.retire(message.id);
      return this.enqueue(async () => { if (this.active?.id === message.id) await this.cancelNow(); });
    }
    return this.enqueue(async () => {
      if (this.retired.has(message.id)) return;
      if (this.active?.id !== message.id) {
        await this.cancelNow();
        const directory = path.join(this.directory, crypto.randomUUID());
        await fs.mkdir(directory, { recursive: true, mode: 0o700 });
        this.active = { id: message.id, directory, point: this.position(message), data: { items: [], files: [], dragOperationsMask: 1 } };
        try {
          const files = Array.isArray(message.files) && message.files.length ? message.files.slice(0, 10) : [{}];
          for (const [index, file] of files.entries()) {
            const name = `drag-${index + 1}.${extensions.get(file?.type) || 'bin'}`, destination = path.join(directory, name);
            await fs.writeFile(destination, '', { flag: 'wx', mode: 0o600 });this.active.data.files.push(destination);
          }
          await this.cdp.send('Input.dispatchDragEvent', { type: 'dragEnter', ...this.active.point, data: this.active.data });
        } catch (error) { await this.cancelNow().catch(() => {});throw error; }
      }
      this.active.point = this.position(message);
      await this.cdp.send('Input.dispatchDragEvent', { type: 'dragOver', ...this.active.point, data: this.active.data });
      clearTimeout(this.timer);this.timer = setTimeout(() => { void this.cancel().catch(this.onError); }, this.idleMs);this.timer.unref?.();
    });
  }
  async close() { this.closed = true;if (this.active) this.retire(this.active.id);await this.cancel(); }
}
