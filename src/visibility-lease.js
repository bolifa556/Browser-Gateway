export const BACKGROUND_IDLE_MS = 60_000;
export const BACKGROUND_CLOSE_CODE = 4001;

// Browser timers can stop when a phone is locked. Enforce the deadline here too.
export function installVisibilityLease(socket, {
  now = Date.now, schedule = setTimeout, cancel = clearTimeout,
  idleMs = BACKGROUND_IDLE_MS,
} = {}) {
  let timer = null, deadline = null;
  const clear = () => { if (timer !== null) cancel(timer); timer = null; deadline = null; };
  const update = (hidden, hiddenForMs = 0) => {
    if (hidden === false) { clear(); return; }
    if (hidden !== true) return;
    const elapsed = Math.max(0, Math.min(idleMs, Number(hiddenForMs) || 0));
    const next = now() + idleMs - elapsed;
    if (deadline !== null && deadline <= next) return;
    clear(); deadline = next;
    timer = schedule(() => {
      clear();
      if (socket.readyState !== 1) return;
      // Detach immediately; don't wait for a frozen client to acknowledge close.
      socket.emit('background-idle');
      socket.close(BACKGROUND_CLOSE_CODE, 'Background idle');
    }, Math.max(0, next - now()));
    timer?.unref?.();
  };
  const message = (raw, binary) => {
    if (binary) return;
    let value; try { value = JSON.parse(String(raw)); } catch { return; }
    if (value.type === 'visibility') update(value.hidden, value.hiddenForMs);
  };
  socket.on('message', message);
  socket.on('close', clear);
  socket.on('error', clear);
  return { update, clear };
}
