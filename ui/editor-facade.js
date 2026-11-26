/* Which text editor the page uses, decided before any other script runs.
 *
 * The editor is CodeMirror 6 (ui/editor-codemirror.js), which only lays
 * out and draws the lines in view, so big files stay quick. To compare with the old editor, set
 * localStorage 'notepadmd.editor' to 'textarea' and restart.
 *
 * The rest of the app was written against a <textarea>. In CodeMirror mode `window.npEditor` is a
 * stand-in with the same members the app uses (value, selectionStart/End, setSelectionRange,
 * scrollTop, focus, classList, events...), backed by CodeMirror once ui/editor-codemirror.js has
 * loaded. init() waits for window.npEditorReady before wiring anything to it.
 */
const NP_EDITOR_MODE = (() => {
  // NOTEPADMD_EDITOR (set by the app from the environment, for the tests) wins over localStorage.
  if (window.__NP_EDITOR_MODE === 'textarea' || window.__NP_EDITOR_MODE === 'codemirror') return window.__NP_EDITOR_MODE;
  try {
    return localStorage.getItem('notepadmd.editor') === 'textarea' ? 'textarea' : 'codemirror';
  } catch (e) {
    return 'codemirror';
  }
})();

(function () {
  const textarea = document.getElementById('editor');
  if (NP_EDITOR_MODE === 'textarea') {
    window.npEditor = textarea;
    window.npEditorReady = Promise.resolve();
    return;
  }
  document.body.classList.add('cm-mode');
  // The CodeMirror editor goes in a host element where the textarea was (same size and place).
  const host = document.createElement('div');
  host.id = 'cm-editor';
  host.className = 'cm-editor-host';
  textarea.parentNode.insertBefore(host, textarea);
  // The textarea stays in the page (hidden), so anything that looks it up by id still finds it.
  textarea.hidden = true;
  textarea.tabIndex = -1;
  textarea.setAttribute('aria-hidden', 'true');

  let resolveReady;
  const ready = new Promise((r) => (resolveReady = r));
  // Before CodeMirror is there: what the app set, applied when it arrives.
  let pending = { text: '', sel: [0, 0], wrap: true, placeholder: '' };
  let api = null; // set by ui/editor-codemirror.js: { view, loadText, setText, ... }
  const inputListeners = new Set();
  const scrollListeners = new Set();

  // Events the app listens for on the editor, and where they come from in CodeMirror.
  const DOM_EVENT = { focus: 'focusin', blur: 'focusout' };
  // The app's key handlers (Tab, auto-closing brackets...) ran on the textarea itself, before the
  // browser acted on the key. In CodeMirror they listen while the key travels down to its content,
  // so they still come first, and CodeMirror leaves a key alone once they've handled it.
  const captureFor = (type, opts) =>
    type === 'keydown' || type === 'keypress' ? (opts && typeof opts === 'object' ? { ...opts, capture: true } : true) : opts;

  const facade = {
    isCodeMirror: true,
    host,
    classList: host.classList,
    dataset: host.dataset,
    style: host.style,

    get value() {
      return api ? api.text() : pending.text;
    },
    /** Replaces the text as one edit (undo keeps working); no 'input' event, like a textarea. */
    set value(v) {
      v = String(v == null ? '' : v);
      if (api) api.setText(v);
      else pending = { ...pending, text: v, sel: [0, 0] };
    },
    get selectionStart() {
      return api ? api.selection()[0] : Math.min(pending.sel[0], pending.text.length);
    },
    get selectionEnd() {
      return api ? api.selection()[1] : Math.min(pending.sel[1], pending.text.length);
    },
    set selectionStart(n) {
      this.setSelectionRange(n, Math.max(n, this.selectionEnd));
    },
    set selectionEnd(n) {
      this.setSelectionRange(Math.min(this.selectionStart, n), n);
    },
    get selectionDirection() {
      return api ? api.selectionDirection() : 'none';
    },
    setSelectionRange(start, end, direction) {
      if (api) api.setSelection(start, end === undefined ? start : end, direction);
      else pending = { ...pending, sel: [start, end === undefined ? start : end] };
    },
    select() {
      this.setSelectionRange(0, this.value.length);
    },
    focus() {
      if (api) api.view.focus();
    },
    blur() {
      if (api) api.view.contentDOM.blur();
    },
    hasFocus() {
      return !!api && api.view.hasFocus;
    },

    get scrollTop() {
      return api ? api.view.scrollDOM.scrollTop : 0;
    },
    set scrollTop(v) {
      if (api) api.setScrollTop(v);
    },
    get scrollLeft() {
      return api ? api.view.scrollDOM.scrollLeft : 0;
    },
    set scrollLeft(v) {
      if (api) api.view.scrollDOM.scrollLeft = v;
    },
    get scrollHeight() {
      return api ? api.view.scrollDOM.scrollHeight : host.clientHeight;
    },
    get clientHeight() {
      return api ? api.view.scrollDOM.clientHeight : host.clientHeight;
    },
    get clientWidth() {
      return api ? api.view.scrollDOM.clientWidth : host.clientWidth;
    },
    get scrollWidth() {
      return api ? api.view.scrollDOM.scrollWidth : host.clientWidth;
    },
    get id() {
      return 'editor';
    },
    getBoundingClientRect() {
      return host.getBoundingClientRect();
    },
    contains(node) {
      return host.contains(node);
    },

    get title() {
      return host.title;
    },
    set title(v) {
      host.title = v;
    },
    get placeholder() {
      return pending.placeholder;
    },
    set placeholder(v) {
      pending.placeholder = v;
      if (api) api.setPlaceholder(v);
    },
    setAttribute(name, v) {
      if (name === 'wrap') {
        pending.wrap = v !== 'off';
        if (api) api.setWrap(pending.wrap);
      } else host.setAttribute(name, v);
    },
    getAttribute(name) {
      return name === 'wrap' ? (pending.wrap ? 'soft' : 'off') : host.getAttribute(name);
    },

    addEventListener(type, fn, opts) {
      if (type === 'input') inputListeners.add(fn);
      else if (type === 'scroll') scrollListeners.add(fn);
      else host.addEventListener(DOM_EVENT[type] || type, fn, captureFor(type, opts));
    },
    removeEventListener(type, fn, opts) {
      if (type === 'input') inputListeners.delete(fn);
      else if (type === 'scroll') scrollListeners.delete(fn);
      else host.removeEventListener(DOM_EVENT[type] || type, fn, captureFor(type, opts));
    },
    dispatchEvent(ev) {
      if (ev.type === 'input') {
        for (const fn of [...inputListeners]) fn.call(facade, ev);
        return true;
      }
      if (ev.type === 'scroll') {
        for (const fn of [...scrollListeners]) fn.call(facade, ev);
        return true;
      }
      return host.dispatchEvent(ev);
    },

    /** Loads another document's text: a fresh undo history, caret at the start. */
    loadText(text) {
      if (api) api.loadText(String(text || ''));
      else pending = { ...pending, text: String(text || ''), sel: [0, 0] };
    },
    /** Types text at the selection, as the user would (on the undo stack, fires 'input'). */
    insertText(text) {
      if (!api) return false;
      api.insertText(text);
      return true;
    },
    undo() {
      return !!api && api.undo();
    },
    redo() {
      return !!api && api.redo();
    },

    // Called by ui/editor-codemirror.js once the view exists.
    _attach(a) {
      api = a;
      a.view.scrollDOM.addEventListener('scroll', (e) => {
        for (const fn of [...scrollListeners]) fn.call(facade, e);
      });
      a.onUserInput = () => {
        const ev = new Event('input');
        for (const fn of [...inputListeners]) fn.call(facade, ev);
      };
      a.loadText(pending.text);
      a.setWrap(pending.wrap);
      a.setPlaceholder(pending.placeholder);
      if (pending.sel[0] || pending.sel[1]) a.setSelection(pending.sel[0], pending.sel[1]);
      resolveReady();
    },
    get api() {
      return api;
    },
  };
  window.npEditor = facade;
  window.npEditorReady = ready;
})();

/** True when the editor has the keyboard focus (a textarea, or CodeMirror's content). */
function editorHasFocus() {
  return window.npEditor.isCodeMirror ? window.npEditor.hasFocus() : document.activeElement === window.npEditor;
}

/** Types text at the editor's selection, keeping it on the undo stack. */
function editorInsertText(text) {
  if (window.npEditor.isCodeMirror) return window.npEditor.insertText(text);
  return document.execCommand('insertText', false, text);
}
