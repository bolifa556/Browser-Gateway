// Only editable geometry and keyboard hints cross this bridge, never field values.
// Publishing ahead of the tap allows synchronous focus on iOS/Android.
export const TOUCH_INPUT_BRIDGE = String.raw`
(() => {
  if (globalThis.__gptWebTouchBridgeInstalled) return;
  globalThis.__gptWebTouchBridgeInstalled = true;
  let timer = 0, signature = '', enabled = false;
  const report = () => {
    timer = 0;
    if (!enabled) return;
    const active = document.activeElement, fields = [];
    for (const element of document.querySelectorAll('textarea,input,[contenteditable]')) {
      if (fields.length >= 64) break;
      if (element.disabled || element.readOnly) continue;
      const multiline = element instanceof HTMLTextAreaElement || element.isContentEditable;
      const textInput = element instanceof HTMLInputElement && ['text','search','email','url','tel','number','password'].includes(element.type);
      if (!multiline && !textInput) continue;
      if (element.isContentEditable && element.parentElement?.isContentEditable) continue;
      const rect = element.getBoundingClientRect(), style = getComputedStyle(element);
      if (!rect.width || !rect.height || style.visibility !== 'visible' || style.display === 'none') continue;
      if (rect.right <= 0 || rect.bottom <= 0 || rect.left >= innerWidth || rect.top >= innerHeight) continue;
      const inputMode = element.inputMode || (textInput && ['email','url','tel'].includes(element.type) ? element.type : textInput && element.type === 'number' ? 'decimal' : 'text');
      fields.push({ x: rect.left, y: rect.top, width: rect.width, height: rect.height,
        multiline, inputMode, enterKeyHint: element.enterKeyHint || (multiline ? 'enter' : 'done'),
        focused: element === active || element.contains(active) });
    }
    const value = { fields }, next = JSON.stringify(value);
    if (next !== signature) {
      signature = next;
      try { if (typeof globalThis.__gptWebInputState === 'function') void globalThis.__gptWebInputState(value); } catch {}
    }
  };
  const schedule = () => { if (enabled && !timer) timer = setTimeout(report, 16); };
  globalThis.__gptWebSetTouchInput = value => {
    enabled = value === true;signature = '';
    if (enabled) schedule();else { clearTimeout(timer);timer = 0; }
  };
  for (const name of ['focusin','focusout','scroll','input','transitionend']) document.addEventListener(name, schedule, true);
  window.addEventListener('resize', schedule);
  document.addEventListener('DOMContentLoaded', schedule);
  new MutationObserver(schedule).observe(document, { childList: true, subtree: true, attributes: true,
    attributeFilter: ['contenteditable','disabled','readonly','type','class','style','hidden','inputmode','enterkeyhint'] });
  try { void globalThis.__gptWebInputState?.({ initialized: true }).then(value => globalThis.__gptWebSetTouchInput(value)); } catch {}
  schedule();
})();
`;
