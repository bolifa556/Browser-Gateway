export const BACKGROUND_IDLE_MS = 60_000;

// visibilitychange, not blur: address bars and file dialogs must not suspend a tab.
export function installVisibilityLifecycle({
  document: doc = globalThis.document, window: win = globalThis.window,
  now = Date.now, schedule = setTimeout, cancel = clearTimeout,
  idleMs = BACKGROUND_IDLE_MS, onVisibility = () => {},
  onSuspend = () => {}, onResume = () => {},
} = {}) {
  let hiddenSince = doc.hidden ? now() : null, timer = null, suspended = false, stopped = false;
  const clear = () => { if (timer !== null) cancel(timer); timer = null; };
  const hiddenForMs = () => hiddenSince === null ? 0 : Math.max(0, now() - hiddenSince);
  const suspend = () => {
    if (stopped || suspended) return;
    clear(); suspended = true; onSuspend();
  };
  const sync = () => {
    if (stopped) return;
    clear();
    if (doc.hidden) {
      hiddenSince ??= now();
      const elapsed = hiddenForMs();
      onVisibility({ hidden: true, hiddenForMs: Math.min(idleMs, elapsed) });
      if (elapsed >= idleMs) suspend();
      else timer = schedule(suspend, idleMs - elapsed);
    } else {
      hiddenSince = null; suspended = false;
      onVisibility({ hidden: false, hiddenForMs: 0 });
      onResume();
    }
  };
  const pageHide = () => { hiddenSince ??= now(); suspend(); };
  doc.addEventListener('visibilitychange', sync);
  win.addEventListener('pagehide', pageHide);
  win.addEventListener('pageshow', sync);
  if (doc.hidden) timer = schedule(suspend, idleMs);
  return {
    sync, suspend,
    get suspended() { return suspended; },
    get hiddenForMs() { return hiddenForMs(); },
    canConnect() {
      if (doc.hidden && hiddenForMs() >= idleMs) suspend();
      return !stopped && !suspended;
    },
    stop() {
      stopped = true; clear();
      doc.removeEventListener('visibilitychange', sync);
      win.removeEventListener('pagehide', pageHide);
      win.removeEventListener('pageshow', sync);
    },
  };
}
