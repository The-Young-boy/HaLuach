// Building blocks for inner menus (web/DESIGN.md "Inner menus"): one row per setting, saved on change.
// Every helper returns an element; `on` is called with the new value right away (the card saves with ctx.set).
import { h } from './core.js';

/** A setting row: the label (and an optional grey hint under it) on the right, the control at the end. */
export function row(label, control, hint) {
  return h('div', { class: 'srow' }, h('span', {}, label, hint ? h('span', { class: 'hint' }, hint) : ''), control || '');
}

/** An on/off switch row. `deps`: rows shown only while it is on (indented under it). Returns [row, ...deps]. */
export function toggle(label, value, on, hint, deps = []) {
  const cb = h('input', { type: 'checkbox', checked: !!value });
  const wrap = deps.map(d => { d.classList.add('dep'); d.hidden = !value; return d; });
  cb.addEventListener('change', () => { wrap.forEach(d => { d.hidden = !cb.checked; }); on(cb.checked); });
  // The label and its hint in one block, so the hint sits under the label (.check is a row).
  return [h('label', { class: 'check' }, cb, h('span', {}, label, hint ? h('span', { class: 'hint' }, hint) : '')), ...wrap];
}

/** A number with its unit after it ("15 דק׳"). Saves on change, within min..max. */
export function number(value, unit, on, { min = 0, max = 999, step = 1 } = {}) {
  const i = h('input', { type: 'number', class: 'n', min, max, step, value: value ?? '' });
  i.addEventListener('change', () => { const v = Math.min(max, Math.max(min, +i.value || 0)); i.value = v; on(v); });
  return h('span', { class: 'unit' }, i, unit || '');
}

/** A short list of numbers ("30, 10"): reminders before a time. Empty = none. */
export function numbers(list, unit, on, { min = 0, max = 600 } = {}) {
  const i = h('input', { type: 'text', class: 'n', inputmode: 'numeric', value: (list || []).join(', '), placeholder: 'בלי' });
  i.style.width = '76px';
  i.addEventListener('change', () => on([...new Set(i.value.split(/[,\s]+/).map(Number).filter(x => x >= min && x <= max && String(x) !== 'NaN'))]));
  return h('span', { class: 'unit' }, i, unit || '');
}

/** A choice of 2-4 short options as chips (one is on). options: [[value, label], ...]. */
export function choice(options, value, on) {
  const box = h('span', { class: 'chips' });
  const draw = v => box.replaceChildren(...options.map(([val, label]) => h('button', { type: 'button', class: 'chip' + (val === v ? ' on' : ''), onclick: () => { draw(val); on(val); } }, label)));
  draw(value);
  return box;
}

/** A longer choice: a select. options: [[value, label], ...]. */
export function select(options, value, on) {
  const s = h('select', {}, ...options.map(([val, label]) => h('option', { value: val, selected: String(val) === String(value) }, label)));
  s.addEventListener('change', () => on(s.value));
  return s;
}

/** A section title inside a menu. */
export const section = title => h('h3', {}, title);

/** Rare settings, folded under one "עוד הגדרות" at the end. */
export function more(...kids) {
  return h('details', { class: 'more-set' }, h('summary', {}, 'עוד הגדרות'), h('div', { class: 'form' }, ...kids.flat()));
}

/** Debounce for text fields that save as you type. */
export function debounce(fn, ms = 600) { let t = 0; return (...a) => { clearTimeout(t); t = setTimeout(() => fn(...a), ms); }; }
