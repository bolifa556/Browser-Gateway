// Forward only protected drag metadata before drop, never file contents. The
// remote website supplies its own drop-zone UI rather than a gateway overlay.
export function installFileDrag(target, {
  send, point, ready, onDrop, unavailable = () => {},
  makeId = () => globalThis.crypto?.randomUUID?.() || `drag-${Date.now()}-${Math.random().toString(16).slice(2)}`,
  schedule = fn => setTimeout(fn, 16), cancel = clearTimeout,
}) {
  let active = null, depth = 0, pending = null;
  const isFile = event => Array.from(event.dataTransfer?.types || []).includes('Files') ||
    Array.from(event.dataTransfer?.items || []).some(item => item.kind === 'file');
  const clear = () => { if (pending !== null) cancel(pending);pending = null; };
  const message = eventType => ({ type: 'file-drag', eventType, id: active.id, ...active.point, files: active.files });
  function release() {
    clear();if (active) send(message('cancel'));active = null;depth = 0;
  }
  function begin(event) {
    if (active) return;
    const items = Array.from(event.dataTransfer?.items || []).filter(item => item.kind === 'file').slice(0, 10);
    active = { id: makeId(), point: point(event), files: items.length ? items.map(item => ({ type: String(item.type || '').slice(0, 128) })) : [{ type: '' }] };
    send(message('enter'));
  }
  target.addEventListener('dragenter', event => {
    if (!isFile(event)) return;event.preventDefault();if (!ready()) return;
    depth++;begin(event);
  }, true);
  target.addEventListener('dragover', event => {
    if (!isFile(event)) return;event.preventDefault();event.dataTransfer.dropEffect = ready() ? 'copy' : 'none';
    if (!ready()) return;begin(event);active.point = point(event);
    if (pending === null) pending = schedule(() => { pending = null;if (active) send(message('over')); });
  }, true);
  target.addEventListener('dragleave', event => {
    if (!active) return;event.preventDefault();depth = Math.max(0, depth - 1);
    if (!depth) release();
  }, true);
  target.addEventListener('drop', event => {
    if (!isFile(event)) return;event.preventDefault();
    const id = active?.id || makeId(), position = point(event), files = Array.from(event.dataTransfer.files || []);
    release();if (!ready()) { unavailable();return; }
    if (files.length) void onDrop(files, position, id);
  }, true);
  target.addEventListener('dragend', release, true);
  return { release, reset() { clear();active = null;depth = 0; } };
}
