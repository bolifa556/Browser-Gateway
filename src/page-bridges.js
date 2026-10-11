export const CLIPBOARD_BRIDGE = String.raw`
(() => {
  if (globalThis.__gptWebClipboardBridgeInstalled) return;
  globalThis.__gptWebClipboardBridgeInstalled = true;

  const send = (kind, text, html = '', image = undefined) => {
    try {
      if (typeof globalThis.__gptWebClipboard === 'function') {
        void globalThis.__gptWebClipboard({
          kind,
          text: String(text || '').slice(0, 4_000_000),
          html: String(html || '').slice(0, 4_000_000),
          image,
        });
      }
    } catch {}
  };

  const installClipboardHooks = () => {
    try {
      const clipboard = navigator.clipboard;
      if (!clipboard) return;
      const proto = Object.getPrototypeOf(clipboard);
      if (proto && typeof proto.writeText === 'function' && !proto.__gptWebWriteText) {
        const originalWriteText = proto.writeText;
        Object.defineProperty(proto, '__gptWebWriteText', { value: originalWriteText });
        proto.writeText = function (text) {
          send('write', text);
          return originalWriteText.call(this, text).catch(() => undefined);
        };
      }
      if (proto && typeof proto.write === 'function' && !proto.__gptWebWrite) {
        const originalWrite = proto.write;
        Object.defineProperty(proto, '__gptWebWrite', { value: originalWrite });
        proto.write = async function (items) {
          try {
            let text = '', html = '', image;
            for (const item of items || []) {
              if (item.types?.includes('text/plain')) {
                const blob = await item.getType('text/plain');
                text = await blob.text();
              }
              if (item.types?.includes('text/html')) html = await (await item.getType('text/html')).text();
              if (!image && item.types?.includes('image/png')) {
                const blob = await item.getType('image/png');
                if (blob.size <= 30_000_000) {
                  const bytes = new Uint8Array(await blob.arrayBuffer());let binary = '';
                  for (let offset = 0; offset < bytes.length; offset += 32768) binary += String.fromCharCode(...bytes.subarray(offset, offset + 32768));
                  image = {type:'image/png',data:btoa(binary)};
                }
              }
            }
            send('write', text, html, image);
          } catch {}
          return originalWrite.call(this, items).catch(() => undefined);
        };
      }
    } catch {}
  };

  installClipboardHooks();
  document.addEventListener('copy', (event) => {
    queueMicrotask(() => {
      let text = '';
      let html = '';
      try {
        text = event.clipboardData?.getData('text/plain') || String(getSelection()?.toString() || '');
        html = event.clipboardData?.getData('text/html') || '';
      } catch {}
      if (text || html) send('write', text, html);
    });
  }, true);

  let cursorFrame = 0;
  let pointer = null;
  const resolveCursor = ({x, y, target}) => {
    const element = document.elementFromPoint(x, y) || target;
    if (!(element instanceof Element)) return 'default';
    const style = getComputedStyle(element);
    // CSS auto asks the native browser to hit-test text. Forwarding "auto" to
    // a canvas loses that native decision and always produces an arrow.
    if (style.cursor && style.cursor !== 'auto') return style.cursor;
    if (element.matches(':disabled')) return 'default';
    // Editable controls still use the native I-beam when their UI framework
    // applies user-select:none (including ChatGPT's empty editor/placeholder).
    if (element.isContentEditable || element instanceof HTMLTextAreaElement) return 'text';
    if (element instanceof HTMLInputElement && !['button','checkbox','color','file','hidden','image','radio','range','reset','submit'].includes(element.type)) return 'text';
    if (style.userSelect === 'none') return 'default';
    const position = document.caretPositionFromPoint?.(x, y);
    const caret = position ? null : document.caretRangeFromPoint?.(x, y);
    const node = position?.offsetNode || caret?.startContainer;
    const offset = position?.offset ?? caret?.startOffset;
    if (node?.nodeType !== Node.TEXT_NODE || !node.parentElement || getComputedStyle(node.parentElement).userSelect === 'none') return 'default';
    // The caret API returns the nearest text even over empty page space. Only
    // use I-beam when the pointer hits an actual adjacent character box.
    for (const start of [offset - 1, offset]) {
      if (start < 0 || start >= node.length) continue;
      const range = document.createRange();range.setStart(node, start);range.setEnd(node, start + 1);
      if ([...range.getClientRects()].some(r => x >= r.left && x <= r.right && y >= r.top && y <= r.bottom)) return 'text';
    }
    return 'default';
  };
  document.addEventListener('pointermove', (event) => {
    pointer = {x:event.clientX, y:event.clientY, target:event.target};
    if (cursorFrame) return;
    cursorFrame = requestAnimationFrame(() => {
      cursorFrame = 0;
      try {
        if (pointer && typeof globalThis.__gptWebCursor === 'function') void globalThis.__gptWebCursor(resolveCursor(pointer));
      } catch {}
    });
  }, true);

})();
`;

export const NATIVE_SELECT_BRIDGE = String.raw`
(() => {
  if (globalThis.__gptWebNativeSelectBridgeInstalled) return;
  globalThis.__gptWebNativeSelectBridgeInstalled = true;

  const BRIDGE_ATTRIBUTE = 'data-gpt-web-native-select';
  const MAX_MENU_HEIGHT = 360;
  let activeSelect = null;
  let menu = null;
  let highlightedIndex = -1;
  let suppressSelectClick = null;

  const isUsableSelect = (element) => (
    element instanceof HTMLSelectElement
    && !element.disabled
    && !element.multiple
    && Number(element.size || 0) <= 1
  );

  const selectFromTarget = (target) => {
    if (!(target instanceof Element)) return null;
    if (target instanceof HTMLSelectElement) return target;
    const closest = target.closest?.('select');
    return closest instanceof HTMLSelectElement ? closest : null;
  };

  const parseColor = (value) => {
    const match = String(value || '').match(/rgba?\((\d+)[, ]+(\d+)[, ]+(\d+)(?:[, /]+([\d.]+))?\)/i);
    if (!match || Number(match[4] ?? 1) === 0) return null;
    return [Number(match[1]), Number(match[2]), Number(match[3])];
  };

  const pageIsDark = (select) => {
    for (let element = select; element; element = element.parentElement) {
      const color = parseColor(getComputedStyle(element).backgroundColor);
      if (color) return (color[0] * 299 + color[1] * 587 + color[2] * 114) / 1000 < 128;
    }
    return matchMedia('(prefers-color-scheme: dark)').matches;
  };

  const refocus = (select) => {
    try {
      select?.focus({ preventScroll: true });
    } catch {
      select?.focus();
    }
  };

  const closeMenu = ({ restoreFocus = true } = {}) => {
    const select = activeSelect;
    menu?.remove();
    menu = null;
    activeSelect = null;
    highlightedIndex = -1;
    if (restoreFocus && select?.isConnected) refocus(select);
  };

  const updateHighlight = (index, { scroll = true } = {}) => {
    if (!menu || !activeSelect) return;
    const options = [...activeSelect.options];
    if (!options.length) return;
    let next = Math.max(0, Math.min(options.length - 1, Number(index) || 0));
    const direction = next >= highlightedIndex ? 1 : -1;
    while (options[next]?.disabled) {
      const candidate = next + direction;
      if (candidate < 0 || candidate >= options.length) break;
      next = candidate;
    }
    highlightedIndex = next;
    for (const item of menu.querySelectorAll('[data-gpt-web-option-index]')) {
      const itemIndex = Number(item.getAttribute('data-gpt-web-option-index'));
      const highlighted = itemIndex === highlightedIndex;
      item.style.setProperty(
        'background',
        highlighted
          ? menu.__gptWebPalette.highlight
          : (itemIndex === activeSelect.selectedIndex ? menu.__gptWebPalette.selected : 'transparent'),
        'important',
      );
      item.setAttribute('aria-selected', String(itemIndex === activeSelect.selectedIndex));
      if (highlighted && scroll) item.scrollIntoView({ block: 'nearest' });
    }
  };

  const commitSelection = (index) => {
    const select = activeSelect;
    const option = select?.options?.[index];
    if (!select || !option || option.disabled) return;
    const previousIndex = select.selectedIndex;
    const nativeValueSetter = Object.getOwnPropertyDescriptor(HTMLSelectElement.prototype, 'value')?.set;
    try {
      if (nativeValueSetter) nativeValueSetter.call(select, option.value);
      else select.value = option.value;
    } catch {
      select.selectedIndex = index;
    }
    closeMenu({ restoreFocus: true });
    if (previousIndex !== select.selectedIndex) {
      select.dispatchEvent(new Event('input', { bubbles: true, composed: true }));
      select.dispatchEvent(new Event('change', { bubbles: true }));
    }
  };

  const positionMenu = () => {
    if (!menu || !activeSelect?.isConnected) {
      closeMenu({ restoreFocus: false });
      return;
    }
    const rectangle = activeSelect.getBoundingClientRect();
    const margin = 8;
    const width = Math.min(
      Math.max(rectangle.width, 240),
      Math.max(160, innerWidth - margin * 2),
    );
    const desiredHeight = Math.min(MAX_MENU_HEIGHT, (menu.scrollHeight || MAX_MENU_HEIGHT) + 4);
    const below = innerHeight - rectangle.bottom - margin;
    const above = rectangle.top - margin;
    const openBelow = below >= Math.min(180, desiredHeight) || below >= above;
    const available = Math.max(96, openBelow ? below : above);
    const height = Math.min(desiredHeight, available);
    const left = Math.max(
      margin,
      Math.min(innerWidth - width - margin, rectangle.right - width),
    );
    const top = openBelow
      ? Math.min(innerHeight - height - margin, rectangle.bottom + 4)
      : Math.max(margin, rectangle.top - height - 4);
    menu.style.setProperty('left', Math.round(left) + 'px', 'important');
    menu.style.setProperty('top', Math.round(top) + 'px', 'important');
    menu.style.setProperty('width', Math.round(width) + 'px', 'important');
    menu.style.setProperty('max-height', Math.round(height) + 'px', 'important');
  };

  const openMenu = (select) => {
    if (!isUsableSelect(select) || !select.options.length) return;
    if (activeSelect === select && menu?.isConnected) return;
    closeMenu({ restoreFocus: false });
    activeSelect = select;
    refocus(select);

    const dark = pageIsDark(select);
    const palette = dark
      ? { background: '#2f2f2f', foreground: '#f5f5f5', border: '#565656', highlight: '#4b4b4b', selected: '#3b3b3b' }
      : { background: '#ffffff', foreground: '#171717', border: '#d0d0d0', highlight: '#ececec', selected: '#f4f4f4' };
    const root = document.createElement('div');
    root.setAttribute(BRIDGE_ATTRIBUTE, 'menu');
    root.setAttribute('role', 'listbox');
    root.tabIndex = -1;
    root.__gptWebPalette = palette;
    root.style.cssText = [
      'all:initial!important',
      'box-sizing:border-box!important',
      'position:fixed!important',
      'display:block!important',
      'overflow-x:hidden!important',
      'overflow-y:auto!important',
      'padding:6px!important',
      'margin:0!important',
      'border:1px solid ' + palette.border + '!important',
      'border-radius:12px!important',
      'background:' + palette.background + '!important',
      'color:' + palette.foreground + '!important',
      'box-shadow:0 12px 36px rgba(0,0,0,.24)!important',
      'font:14px/1.35 system-ui,-apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif!important',
      'z-index:2147483647!important',
      'pointer-events:auto!important',
      'overscroll-behavior:contain!important',
    ].join(';');

    [...select.options].forEach((option, index) => {
      const item = document.createElement('div');
      item.setAttribute(BRIDGE_ATTRIBUTE, 'option');
      item.setAttribute('data-gpt-web-option-index', String(index));
      item.setAttribute('role', 'option');
      item.setAttribute('aria-disabled', String(Boolean(option.disabled)));
      item.setAttribute('aria-selected', String(index === select.selectedIndex));
      item.style.cssText = [
        'all:unset!important',
        'box-sizing:border-box!important',
        'display:flex!important',
        'align-items:center!important',
        'gap:8px!important',
        'width:100%!important',
        'min-height:34px!important',
        'padding:7px 10px!important',
        'border-radius:8px!important',
        'color:' + palette.foreground + '!important',
        'font:inherit!important',
        'white-space:normal!important',
        'cursor:' + (option.disabled ? 'not-allowed' : 'pointer') + '!important',
        'opacity:' + (option.disabled ? '.45' : '1') + '!important',
      ].join(';');
      const mark = document.createElement('span');
      mark.textContent = index === select.selectedIndex ? '✓' : '';
      mark.setAttribute('aria-hidden', 'true');
      mark.style.cssText = 'all:unset!important;display:inline-block!important;width:16px!important;flex:0 0 16px!important;text-align:center!important;color:inherit!important;font:inherit!important';
      const label = document.createElement('span');
      label.textContent = option.label || option.textContent || option.value;
      label.style.cssText = 'all:unset!important;display:block!important;min-width:0!important;flex:1 1 auto!important;color:inherit!important;font:inherit!important';
      item.append(mark, label);
      item.addEventListener('pointerenter', () => {
        if (!option.disabled) updateHighlight(index, { scroll: false });
      });
      item.addEventListener('click', (event) => {
        event.preventDefault();
        event.stopImmediatePropagation();
        commitSelection(index);
      });
      root.append(item);
    });

    const host = select.closest('dialog, [popover]') || document.body || document.documentElement;
    host.append(root);
    menu = root;
    positionMenu();
    const selectedIndex = select.selectedIndex >= 0
      ? select.selectedIndex
      : [...select.options].findIndex((option) => !option.disabled);
    updateHighlight(Math.max(0, selectedIndex));
  };

  const safelyOpenMenu = (select) => {
    try {
      openMenu(select);
    } catch {}
  };

  const interceptSelectPointer = (event) => {
    const select = selectFromTarget(event.target);
    if (!isUsableSelect(select)) return;
    event.preventDefault();
    event.stopImmediatePropagation();
    suppressSelectClick = select;
    safelyOpenMenu(select);
  };

  document.addEventListener('pointerdown', interceptSelectPointer, true);
  document.addEventListener('mousedown', interceptSelectPointer, true);
  document.addEventListener('click', (event) => {
    const select = selectFromTarget(event.target);
    if (isUsableSelect(select)) {
      event.preventDefault();
      event.stopImmediatePropagation();
      if (select !== suppressSelectClick) safelyOpenMenu(select);
      suppressSelectClick = null;
      return;
    }
    suppressSelectClick = null;
    if (menu && !menu.contains(event.target)) closeMenu({ restoreFocus: false });
  }, true);

  document.addEventListener('keydown', (event) => {
    const select = activeSelect || (document.activeElement instanceof HTMLSelectElement
      ? document.activeElement
      : null);
    if (!isUsableSelect(select)) return;

    if (!menu) {
      if (
        event.key === 'Enter'
        || event.key === ' '
        || event.key === 'ArrowDown'
        || event.key === 'ArrowUp'
      ) {
        event.preventDefault();
        event.stopImmediatePropagation();
        safelyOpenMenu(select);
      }
      return;
    }

    if (event.key === 'Escape') {
      event.preventDefault();
      event.stopImmediatePropagation();
      closeMenu({ restoreFocus: true });
      return;
    }
    if (event.key === 'Tab') {
      closeMenu({ restoreFocus: false });
      return;
    }
    if (event.key === 'Enter' || event.key === ' ') {
      event.preventDefault();
      event.stopImmediatePropagation();
      commitSelection(highlightedIndex);
      return;
    }
    if (event.key === 'ArrowDown' || event.key === 'ArrowUp' || event.key === 'Home' || event.key === 'End') {
      event.preventDefault();
      event.stopImmediatePropagation();
      const last = Math.max(0, select.options.length - 1);
      if (event.key === 'Home') updateHighlight(0);
      else if (event.key === 'End') updateHighlight(last);
      else updateHighlight(highlightedIndex + (event.key === 'ArrowDown' ? 1 : -1));
    }
  }, true);

  window.addEventListener('resize', () => positionMenu(), true);
  document.addEventListener('scroll', (event) => {
    if (menu && !menu.contains(event.target)) positionMenu();
  }, true);
  new MutationObserver(() => {
    if (activeSelect && !activeSelect.isConnected) closeMenu({ restoreFocus: false });
  }).observe(document, { subtree: true, childList: true });
})();
`;
