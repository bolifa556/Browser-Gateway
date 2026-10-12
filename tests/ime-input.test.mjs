import { test } from 'node:test';
import assert from 'node:assert/strict';
import { installImeInput } from '../public/ime-input.js';
function fixture(coarse = true, field = { multiline: true, enterKeyHint: 'enter' }) {
  const handlers = {}, messages = [];let at = 1000;
  const ime = { value: '', addEventListener: (name, fn) => handlers[name] = fn, setSelectionRange() {} };
  const input = installImeInput(ime, { send: m => messages.push(m), coarse: () => coarse, field: () => field, now: () => at });
  return { ime, input, messages, fire: (name, values = {}) => handlers[name]({ preventDefault() {}, ...values }), advance: ms => at += ms };
}
test('software keyboard insert/delete/newline work without keydown', () => {
  const f = fixture();f.input.prepare();assert.equal(f.ime.value, '\u200b');
  f.fire('beforeinput', { inputType: 'insertText', data: '手机' });
  f.fire('beforeinput', { inputType: 'deleteContentBackward' });
  f.fire('beforeinput', { inputType: 'insertLineBreak' });
  assert.equal(f.messages[0].text, '手机');assert.deepEqual(f.messages.slice(1).map(m => [m.key, m.eventType, m.modifiers]),
    [['Backspace', 'keyDown', 0], ['Backspace', 'keyUp', 0], ['Enter', 'keyDown', 8], ['Enter', 'keyUp', 8]]);
});
test('send/done keyboard hints do not insert a multiline break', () => {
  const f = fixture(true, { multiline: true, enterKeyHint: 'send' });f.fire('beforeinput', { inputType: 'insertParagraph' });
  assert.equal(f.messages[0].modifiers, 0);
});
test('Chinese composition commits once and ignores the trailing beforeinput duplicate', () => {
  const f = fixture();f.fire('compositionstart');f.fire('compositionupdate', { data: '中文' });
  f.fire('compositionend', { data: '中文' });f.fire('beforeinput', { inputType: 'insertText', data: '中文' });
  assert.deepEqual(f.messages.map(m => [m.type, m.text]), [['composition', '中文'], ['composition', ''], ['text', '中文']]);
  f.advance(101);f.fire('beforeinput', { inputType: 'insertText', data: '中文' });assert.equal(f.messages.at(-1).text, '中文');
});
test('desktop delete/enter stay with the pre-existing hardware keyboard path', () => {
  const f = fixture(false);f.fire('beforeinput', { inputType: 'deleteContentBackward' });f.fire('beforeinput', { inputType: 'insertParagraph' });
  assert.equal(f.messages.length, 0);f.fire('beforeinput', { inputType: 'insertText', data: 'desktop' });assert.equal(f.messages.length, 1);assert.equal(f.ime.value, '');
});
