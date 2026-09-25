/**
 * Atomic visible-DOM snapshot inspired by Browser Use's MIT-licensed jev-ultrafast snapshot.js.
 * The model receives indexed, code-owned actions; it never creates selectors or coordinates.
 *
 * submit actions are yielded for <form> elements and for buttons/inputs with type=submit that
 * are not already exposed as clickable controls, so Jev can guard form submissions explicitly.
 */
export const SNAPSHOT_SCRIPT = String.raw`(() => {
  if (!document.body) return null;
  const cache = window.__jevFast ||= { ids: new WeakMap(), nodes: new Map(), next: 1 };
  const id = e => { if (!cache.ids.has(e)) cache.ids.set(e, cache.next++); const value = cache.ids.get(e); cache.nodes.set(value, e); return value; };
  const visible = e => !e.closest('[aria-hidden="true"],[inert]') && e.checkVisibility({ checkOpacity: true, checkVisibilityCSS: true });
  const label = e => e.getAttribute('aria-label') || e.innerText?.trim() || e.getAttribute('placeholder') || e.getAttribute('title') || e.value || e.tagName.toLowerCase();
  const selector = 'a[href],button,input:not([type="password"]):not([type="file"]),textarea,select,[contenteditable="true"],[role="button"],[role="link"],[role="option"],[role="textbox"],[role="combobox"]';
  const actions = [];
  const seenNodes = new Set();
  for (const e of document.querySelectorAll(selector)) {
    if (!visible(e) || e.matches(':disabled') || e.closest('[aria-disabled="true"]')) continue;
    const rect = e.getBoundingClientRect(), x = rect.x + rect.width / 2, y = rect.y + rect.height / 2;
    if (!rect.width || !rect.height || x < 0 || y < 0 || x >= innerWidth || y >= innerHeight) continue;
    const node = id(e), editable = !e.readOnly && (e.matches('input,textarea,[contenteditable="true"]') || ['textbox','combobox'].includes(e.getAttribute('role')));
    seenNodes.add(e);
    if (e.tagName === 'SELECT') {
      for (const option of e.options) {
        if (!option.disabled && !option.selected) actions.push({ node, kind: 'select', label: label(e) + ' → ' + option.label, role: 'combobox', currentValue: e.value, optionValue: option.value });
      }
    } else if ((e.tagName === 'INPUT' && e.type === 'submit') || (e.tagName === 'BUTTON' && (e.type === 'submit' || e.closest('form')))) {
      // Expose submit buttons as 'submit' kind so Jev can guard them
      actions.push({ node, kind: 'submit', label: label(e) || 'Submit', role: 'button', value: '' });
    } else {
      actions.push({ node, kind: editable ? 'fill' : 'click', label: label(e), role: e.getAttribute('role') || e.tagName.toLowerCase(), value: 'value' in e ? String(e.value) : '' });
    }
  }
  // Also expose <form> elements that have no visible submit button yet
  for (const form of document.querySelectorAll('form')) {
    if (!visible(form)) continue;
    const hasSubmit = [...form.querySelectorAll('[type="submit"],button:not([type="button"])')].some(b => seenNodes.has(b));
    if (!hasSubmit) {
      actions.push({ node: id(form), kind: 'submit', label: (form.getAttribute('aria-label') || form.id || 'Submit form'), role: 'form', value: '' });
    }
  }
  const text = document.body.innerText.slice(0, 6000), semantic = actions.map(({ node, kind, label, role, value, currentValue, optionValue }) => [node, kind, label, role, value, currentValue, optionValue]);
  // Controls, not free text: live counters and tickers must not invalidate a decision whose target is unchanged.
  const fingerprint = JSON.stringify([performance.timeOrigin, location.href, document.title, scrollX, scrollY, semantic]);
  actions.splice(250); actions.forEach((action, index) => action.id = 'e' + (index + 1));
  if (scrollY + innerHeight < document.documentElement.scrollHeight - 2) actions.push({ id: 'scroll_down', kind: 'scroll', label: 'Scroll down' });
  if (scrollY > 0) actions.push({ id: 'scroll_up', kind: 'scroll', label: 'Scroll up' });
  actions.push({ id: 'wait', kind: 'wait', label: 'Wait for page update' });
  return { url: location.href, title: document.title, visibleText: text, fingerprint, actions };
})()`;
