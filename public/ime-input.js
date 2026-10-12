const SENTINEL = '\u200b';

// Software keyboards often emit beforeinput without usable keydown events.
// Desktop key handling stays in app.js; this supplies only the missing edits.
export function installImeInput(ime, {
  send, ready = () => true, coarse = () => false,
  field = () => ({}), now = () => performance.now(),
} = {}) {
  let composing = false, lastComposition = { text: '', at: -Infinity };
  const prepare = () => {
    if (composing) return;
    ime.value = coarse() ? SENTINEL : '';
    if (coarse()) ime.setSelectionRange?.(1, 1);
  };
  const key = (name, code, keyCode, modifiers = 0) => {
    for (const eventType of ['keyDown', 'keyUp']) send({ type: 'key', eventType, key: name, code, keyCode, modifiers,
      text: name === 'Enter' && eventType === 'keyDown' ? '\r' : '' });
  };
  ime.addEventListener('compositionstart', () => { composing = true; });
  ime.addEventListener('compositionupdate', e => { if (ready()) send({ type: 'composition', text: e.data || '' }); });
  ime.addEventListener('compositionend', e => {
    composing = false;
    if (ready()) {
      send({ type: 'composition', text: '' });
      if (e.data) { send({ type: 'text', text: e.data }); lastComposition = { text: e.data, at: now() }; }
    }
    prepare();
  });
  ime.addEventListener('beforeinput', e => {
    if (!ready() || composing || e.isComposing) return;
    const type = e.inputType;
    if (['insertText', 'insertReplacementText', 'insertFromComposition'].includes(type) && e.data) {
      e.preventDefault();
      if (e.data !== lastComposition.text || now() - lastComposition.at > 100) send({ type: 'text', text: e.data });
    } else if (coarse() && /^delete(Content|Word)(Backward|Forward)$/.test(type)) {
      e.preventDefault();
      const backward = type.endsWith('Backward');
      key(backward ? 'Backspace' : 'Delete', backward ? 'Backspace' : 'Delete', backward ? 8 : 46, type.startsWith('deleteWord') ? 2 : 0);
    } else if (coarse() && ['insertLineBreak', 'insertParagraph'].includes(type)) {
      e.preventDefault();
      const current = field();
      key('Enter', 'Enter', 13, current.multiline && !['send', 'go', 'done', 'search'].includes(current.enterKeyHint) ? 8 : 0);
    } else if (coarse() && ['historyUndo', 'historyRedo'].includes(type)) {
      e.preventDefault(); key('z', 'KeyZ', 90, type === 'historyRedo' ? 10 : 2);
    } else return;
    prepare();
  });
  ime.addEventListener('input', () => { if (!composing) prepare(); });
  return { prepare, get composing() { return composing; }, reset() { composing = false; lastComposition = { text: '', at: -Infinity }; prepare(); } };
}
