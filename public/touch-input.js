// Preserve the browser's own gesture recognizer instead of turning swipes into
// mouse drags. Mouse and pen input remain in pointer-input.js.
export function installTouchInput(canvas, {
  send, point, onStart = () => {}, onTap = () => {}, onSelect = () => {}, native = true,
  schedule = fn => setTimeout(fn, 8), cancel = clearTimeout,
  hold = fn => setTimeout(fn, 500), cancelHold = clearTimeout,
} = {}) {
  const fingers = new Map();
  let frame = null, moving = false, remoteDown = false, blocked = false, origin = null;
  let fallbackDrag = false, selecting = false, longPress = null;
  const points = () => [...fingers.values()].map(f => ({ id: f.id, ...f.position }));
  const dispatch = type => send({ type: 'touch', eventType: type, points: type === 'touchEnd' || type === 'touchCancel' ? [] : points() });
  const clearMove = () => { if (frame !== null) cancel(frame); frame = null; moving = false; };
  const flush = () => { if (moving && native && remoteDown && !blocked) dispatch('touchMove'); clearMove(); };
  const clearPress = () => { if (longPress !== null) cancelHold(longPress); longPress = null; };
  const mouse = (type, p, buttons = 0, clickCount = 1) => send({ type: 'mouse', eventType: type, ...p, button: 'left', buttons, clickCount, modifiers: 0 });
  const release = () => {
    flush(); clearPress();
    if (native && remoteDown) dispatch('touchCancel');
    if ((fallbackDrag || selecting) && origin) mouse('mouseReleased', origin.last);
    const captured = [...fingers.keys()];fingers.clear();origin = null;
    remoteDown = fallbackDrag = selecting = blocked = false;
    for (const id of captured) { try { if (canvas.hasPointerCapture(id)) canvas.releasePointerCapture(id); } catch {} }
  };
  canvas.addEventListener('pointerdown', e => {
    if (e.pointerType !== 'touch') return;
    e.preventDefault(); flush();
    if (fingers.size >= 10) return;
    const p = point(e), id = Array.from({ length: 10 }, (_, i) => i).find(i => ![...fingers.values()].some(f => f.id === i));
    fingers.set(e.pointerId, { id, position: p });
    try { canvas.setPointerCapture(e.pointerId); } catch {}
    if (blocked) return;
    if (fingers.size === 1) { origin = { ...p, last: p, moved: false }; onStart(p, e); }
    else clearPress();
    if (native) {
      if (selecting) { mouse('mouseReleased', origin.last);selecting = false;blocked = true;return; }
      remoteDown = true; dispatch('touchStart');
      if (fingers.size === 1) longPress = hold(() => {
        longPress = null;
        if (!origin?.moved && !blocked && fingers.size === 1) {
          dispatch('touchCancel');remoteDown = false;selecting = true;
          onSelect(origin);send({type:'touch-select',x:origin.x,y:origin.y});
        }
      });
    }
    else if (fingers.size === 1) {
      longPress = hold(() => {
        longPress = null;
        if (!origin?.moved && !blocked) { fallbackDrag = true; mouse('mousePressed', origin, 1, 2); }
      });
    } else {
      if (fallbackDrag && origin) mouse('mouseReleased', origin.last);
      fallbackDrag = false;blocked = true;
    }
  });
  canvas.addEventListener('pointermove', e => {
    if (e.pointerType !== 'touch' || !fingers.has(e.pointerId)) return;
    e.preventDefault(); const p = point(e); fingers.get(e.pointerId).position = p;
    if (blocked) return;
    if (origin && Math.hypot(p.x - origin.x, p.y - origin.y) > 8) { origin.moved = true; clearPress(); }
    if (selecting) mouse('mouseMoved', p, 1, 2);
    else if (native) {
      moving = true;
      if (frame === null) frame = schedule(() => { frame = null; if (moving && remoteDown && !blocked) dispatch('touchMove'); moving = false; });
    } else if (origin) {
      if (fallbackDrag) mouse('mouseMoved', p, 1, 2);
      else if (origin.moved) send({ type: 'wheel', ...origin, deltaX: origin.last.x - p.x, deltaY: origin.last.y - p.y, modifiers: 0 });
    }
    if (origin) origin.last = p;
  });
  const end = (e, cancelled = false) => {
    if (e.pointerType !== 'touch' || !fingers.has(e.pointerId)) return;
    e.preventDefault(); flush(); clearPress();
    if (!blocked) {
      if (selecting) mouse('mouseReleased', point(e), 0, 2);
      else if (native) { if (remoteDown) dispatch(cancelled ? 'touchCancel' : 'touchEnd'); }
      else if (fallbackDrag) mouse('mouseReleased', point(e), 0, 2);
      else if (!cancelled && fingers.size === 1 && !origin?.moved) {
        mouse('mousePressed', point(e), 1); mouse('mouseReleased', point(e));
      }
      if (!cancelled && fingers.size === 1 && !origin?.moved) onTap(point(e), e);
    }
    remoteDown = fallbackDrag = selecting = false;
    fingers.delete(e.pointerId); blocked = Boolean(fingers.size);
    if (!fingers.size) { origin = null; blocked = false; }
    try { if (canvas.hasPointerCapture(e.pointerId)) canvas.releasePointerCapture(e.pointerId); } catch {}
  };
  canvas.addEventListener('pointerup', e => end(e));
  canvas.addEventListener('pointercancel', e => end(e, true));
  canvas.addEventListener('lostpointercapture', e => end(e, true));
  return {
    release,
    reset() { clearMove(); clearPress(); fingers.clear(); remoteDown = blocked = fallbackDrag = selecting = false; origin = null; },
  };
}
