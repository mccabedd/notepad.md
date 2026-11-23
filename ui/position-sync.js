/* Where am I? One mapping between a place in the source text and a place in the preview, used for
 *  - split view: the preview follows the editor and the editor follows the preview (Settings >
 *    General > Synchronise Edit/Preview scrolling, on by default);
 *  - switching between Edit, Preview and split: the same part of the document stays in view, and
 *    the caret goes to the matching place (always on, whatever that setting says).
 *
 * Rendered Markdown: every top-level block of the preview (paragraph, heading, list, table, code
 * block...) is matched to the source lines it came from (from marked's own tokens), and positions
 * inside a block are interpolated. Plain Text and code previews show the source text itself, so
 * their mapping is exact. BBCode (and anything that can't be matched) falls back to proportions.
 * Loaded before renderer.js; only touches renderer globals inside functions. */

const SYNC_MAX_CHARS = 2 * 1024 * 1024; // above this, proportional only (no block map)

let blockMap = null; // { content, starts: [source offset of each block], els: [element] }
let blockMapAt = 0;

/** The block map of the preview now shown (rebuilt when the text or the preview changed). */
function previewBlocks(doc) {
  if (langInfo(doc).render !== 'markdown' || doc.content.length > SYNC_MAX_CHARS || previewPaused()) return null;
  if (blockMap && blockMap.content === doc.content && blockMap.root === preview.firstElementChild && blockMap.count === preview.childElementCount) return blockMap;
  // While typing, a slightly old map is fine for a moment (lexing on every key would cost).
  if (blockMap && blockMap.docId === doc.id && performance.now() - blockMapAt < 250 && blockMap.count === preview.childElementCount) return blockMap;
  let tokens;
  try {
    tokens = marked_.lexer(doc.content);
  } catch (e) {
    return null;
  }
  const starts = [];
  let pos = 0;
  for (const t of tokens) {
    const raw = t.raw || '';
    // Blank lines and link definitions don't make an element.
    if (t.type !== 'space' && t.type !== 'def') starts.push(pos);
    pos += raw.length;
  }
  const els = [...preview.children].filter((el) => !el.classList.contains('code-copy-btn'));
  const n = Math.min(starts.length, els.length);
  blockMap = { content: doc.content, docId: doc.id, starts: starts.slice(0, n), els: els.slice(0, n), root: preview.firstElementChild, count: preview.childElementCount };
  blockMapAt = performance.now();
  return blockMap;
}

function offsetTopIn(el, scroller) {
  return el.getBoundingClientRect().top - scroller.getBoundingClientRect().top + scroller.scrollTop;
}

/** y (in the preview's scrolled content) of a source offset. */
function previewYForOffset(doc, pos) {
  const render = langInfo(doc).render;
  if (render === 'plain' || render === 'code') {
    const root = render === 'code' ? preview.querySelector('code') || preview : preview;
    const r = rangeAtTextOffset(root, Math.min(pos, doc.content.length));
    const rect = r && (r.getClientRects()[0] || r.getBoundingClientRect());
    if (rect && (rect.top || rect.height)) return rect.top - preview.getBoundingClientRect().top + preview.scrollTop;
  }
  const map = previewBlocks(doc);
  if (map && map.starts.length) {
    let i = 0;
    while (i + 1 < map.starts.length && map.starts[i + 1] <= pos) i++;
    const el = map.els[i];
    const top = offsetTopIn(el, preview);
    const nextStart = i + 1 < map.starts.length ? map.starts[i + 1] : doc.content.length;
    const frac = nextStart > map.starts[i] ? Math.min(1, Math.max(0, (pos - map.starts[i]) / (nextStart - map.starts[i]))) : 0;
    return top + frac * el.getBoundingClientRect().height;
  }
  const ratio = doc.content.length ? pos / doc.content.length : 0;
  return ratio * Math.max(0, preview.scrollHeight - preview.clientHeight);
}

/** The source offset shown at y in the preview's scrolled content. */
function offsetForPreviewY(doc, y) {
  const render = langInfo(doc).render;
  if (render === 'plain' || render === 'code') {
    const base = preview.getBoundingClientRect();
    const x = base.left + 20;
    const cy = base.top + (y - preview.scrollTop);
    const root = render === 'code' ? preview.querySelector('code') || preview : preview;
    const r = document.caretRangeFromPoint ? document.caretRangeFromPoint(x, Math.max(base.top + 1, Math.min(base.bottom - 1, cy))) : null;
    if (r && root.contains(r.startContainer)) return textOffsetOf(root, r.startContainer, r.startOffset);
  }
  const map = previewBlocks(doc);
  if (map && map.starts.length) {
    let lo = 0;
    let hi = map.els.length - 1;
    while (lo < hi) {
      const mid = (lo + hi + 1) >> 1;
      if (offsetTopIn(map.els[mid], preview) <= y) lo = mid;
      else hi = mid - 1;
    }
    const el = map.els[lo];
    const top = offsetTopIn(el, preview);
    const h = el.getBoundingClientRect().height || 1;
    const frac = Math.min(1, Math.max(0, (y - top) / h));
    const nextStart = lo + 1 < map.starts.length ? map.starts[lo + 1] : doc.content.length;
    return Math.round(map.starts[lo] + frac * (nextStart - map.starts[lo]));
  }
  const max = Math.max(1, preview.scrollHeight - preview.clientHeight);
  return Math.round((y / max) * doc.content.length);
}

/** Character offset of (node, offset) within root's text. */
function textOffsetOf(root, node, offset) {
  const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
  let n;
  let base = 0;
  while ((n = walker.nextNode())) {
    if (n === node) return base + offset;
    base += n.nodeValue.length;
  }
  return base;
}

/** y (in the editor's scrolled content) of a source offset. */
function editorYForOffset(pos) {
  const v = editor.value;
  let line = 0;
  for (let i = v.indexOf('\n'); i !== -1 && i < pos; i = v.indexOf('\n', i + 1)) line++;
  const kids = editorHighlight.children;
  if (!editorHighlight.classList.contains('hidden') && kids[line] && kids[line].classList.contains('ovl')) {
    return kids[line].getBoundingClientRect().top - editorHighlight.getBoundingClientRect().top + editorHighlight.scrollTop;
  }
  const cs = getComputedStyle(editor);
  return (parseFloat(cs.paddingTop) || 0) + line * (parseFloat(cs.lineHeight) || 21);
}

/** The source offset of the line shown at y in the editor's scrolled content. */
function offsetForEditorY(y) {
  const v = editor.value;
  const kids = editorHighlight.children;
  let line = 0;
  const layered = !editorHighlight.classList.contains('hidden') && kids.length && kids[0].classList.contains('ovl');
  if (layered) {
    const base = editorHighlight.getBoundingClientRect().top - editorHighlight.scrollTop;
    let lo = 0;
    let hi = kids.length - 1;
    while (lo < hi) {
      const mid = (lo + hi + 1) >> 1;
      if (kids[mid].getBoundingClientRect().top - base <= y) lo = mid;
      else hi = mid - 1;
    }
    line = lo;
  } else {
    const cs = getComputedStyle(editor);
    line = Math.max(0, Math.floor((y - (parseFloat(cs.paddingTop) || 0)) / (parseFloat(cs.lineHeight) || 21)));
  }
  let pos = 0;
  for (let k = 0; k < line; k++) {
    const nl = v.indexOf('\n', pos);
    if (nl === -1) break;
    pos = nl + 1;
  }
  return pos;
}

/* ---------- split view: each pane follows the other ---------- */

let syncLead = null; // the pane the user is moving: 'editor' or 'preview'
let syncLeadAt = 0;
let syncFrame = 0;
let ignoreScroll = { editor: 0, preview: 0 }; // time until which a pane's scroll events are ours

function isSplit() {
  return layoutMode === 'split-ep' || layoutMode === 'split-pe';
}

function syncActive() {
  return settings.syncScroll && isSplit() && !previewPaused();
}

function previewPaused() {
  return typeof previewStale !== 'undefined' && previewStale;
}

function setScrollQuietly(el, which, top) {
  const t = Math.max(0, Math.round(top));
  if (Math.abs(el.scrollTop - t) < 2) return;
  ignoreScroll[which] = performance.now() + 120;
  el.scrollTop = t;
}

/** The other pane, aligned with the first line shown in the pane that moved. */
function followScroll(from) {
  const doc = getActive();
  if (!doc || !syncActive()) return;
  if (from === 'editor') {
    const pos = offsetForEditorY(editor.scrollTop + 4);
    const lineOff = editorYForOffset(pos) - editor.scrollTop; // the line's own position in view
    setScrollQuietly(preview, 'preview', previewYForOffset(doc, pos) - Math.max(0, lineOff));
  } else {
    const pos = offsetForPreviewY(doc, preview.scrollTop + 4);
    setScrollQuietly(editor, 'editor', editorYForOffset(pos));
    editorHighlight.scrollTop = editor.scrollTop;
    if (lineNumbersVisible) renderGutter();
  }
}

function onPaneScroll(which) {
  if (performance.now() < ignoreScroll[which]) return; // our own move
  if (!syncActive()) return;
  syncLead = which;
  syncLeadAt = performance.now();
  if (syncFrame) return;
  syncFrame = requestAnimationFrame(() => {
    syncFrame = 0;
    followScroll(syncLead);
  });
}

/** Brings source offset pos into view in the preview if it isn't (typing, moving the caret). */
function revealInPreview(doc, pos) {
  const y = previewYForOffset(doc, pos);
  if (y < preview.scrollTop + 10 || y > preview.scrollTop + preview.clientHeight - 30) setScrollQuietly(preview, 'preview', y - preview.clientHeight / 3);
}

function revealInEditor(pos) {
  const y = editorYForOffset(pos);
  if (y < editor.scrollTop + 10 || y > editor.scrollTop + editor.clientHeight - 30) {
    setScrollQuietly(editor, 'editor', y - editor.clientHeight / 3);
    editorHighlight.scrollTop = editor.scrollTop;
    if (lineNumbersVisible) renderGutter();
  }
}

let caretFrame = 0;
function onEditorCaret() {
  lastNav = { pane: 'editor', kind: 'caret' };
  if (!syncActive() || caretFrame) return;
  caretFrame = requestAnimationFrame(() => {
    caretFrame = 0;
    const doc = getActive();
    if (doc && document.activeElement === editor) revealInPreview(doc, editor.selectionStart);
  });
}

function previewCaretOffset(doc) {
  const sel = window.getSelection();
  if (!sel || !sel.rangeCount || !preview.contains(sel.anchorNode)) return null;
  const render = langInfo(doc).render;
  if (render === 'plain' || render === 'code') {
    const root = render === 'code' ? preview.querySelector('code') || preview : preview;
    return root.contains(sel.anchorNode) ? textOffsetOf(root, sel.anchorNode, sel.anchorOffset) : null;
  }
  const map = previewBlocks(doc);
  if (!map) return null;
  const node = sel.anchorNode.nodeType === 1 ? sel.anchorNode : sel.anchorNode.parentElement;
  const i = map.els.findIndex((el) => el === node || el.contains(node));
  if (i < 0) return null;
  return sourceOffsetInBlock(doc, map, i, sel.anchorNode, sel.anchorOffset);
}

/**
 * The source offset of a caret inside a rendered block: the text just before the caret is looked
 * for in that block's source (Markdown markup in between is skipped by the search); if it can't
 * be found, the block's start.
 */
function sourceOffsetInBlock(doc, map, i, node, offset) {
  const start = map.starts[i];
  const end = i + 1 < map.starts.length ? map.starts[i + 1] : doc.content.length;
  const src = doc.content.slice(start, end);
  const blockText = map.els[i].textContent;
  const at = node.nodeType === 3 ? textOffsetOf(map.els[i], node, offset) : 0;
  for (let len = Math.min(24, at); len >= 3; len -= 7) {
    const needle = blockText.slice(at - len, at);
    const k = src.indexOf(needle);
    if (k >= 0 && src.indexOf(needle, k + 1) < 0) return start + k + needle.length;
  }
  return start;
}

/** Puts the preview caret at source offset pos (exact for plain/code, the matching text or block start for Markdown). */
function placePreviewCaret(doc, pos) {
  const render = langInfo(doc).render;
  let range = null;
  if (render === 'plain') range = rangeAtTextOffset(preview, pos);
  else if (render === 'markdown') {
    const map = previewBlocks(doc);
    if (map && map.starts.length) {
      let i = 0;
      while (i + 1 < map.starts.length && map.starts[i + 1] <= pos) i++;
      const el = map.els[i];
      const nextStart = i + 1 < map.starts.length ? map.starts[i + 1] : doc.content.length;
      // The words right after the caret, as they appear in the rendered text.
      const after = doc.content.slice(pos, Math.min(nextStart, pos + 40)).replace(/[*_`~#>[\]()|\\]/g, '');
      const word = (/^\s*([^\s]{3,20})/.exec(after) || [])[1];
      const text = el.textContent;
      const k = word ? text.indexOf(word) : -1;
      range = rangeAtTextOffset(el, k >= 0 && text.indexOf(word, k + 1) < 0 ? k : 0);
    }
  }
  if (!range) return false;
  const sel = window.getSelection();
  sel.removeAllRanges();
  sel.addRange(range);
  return true;
}

let previewCaretFrame = 0;
function onPreviewCaret() {
  lastNav = { pane: 'preview', kind: 'caret' };
  if (!syncActive() || previewCaretFrame) return;
  previewCaretFrame = requestAnimationFrame(() => {
    previewCaretFrame = 0;
    const doc = getActive();
    const pos = doc && previewCaretOffset(doc);
    if (pos !== null && pos !== undefined) revealInEditor(pos);
  });
}

/* ---------- switching view: keep the place ---------- */

// The last thing the user did to move around: in which pane, and by caret or by scrolling. Scrolling
// without moving the caret means "what I'm looking at", not "where the caret is".
let lastNav = { pane: 'editor', kind: 'caret' };

/** Where the user is, as a source offset, before the view changes. */
function captureAnchor(doc, mode) {
  const editorShown = mode !== 'preview-only';
  const previewShown = mode !== 'edit-only';
  let pane = lastNav.pane;
  if (pane === 'editor' && !editorShown) pane = 'preview';
  if (pane === 'preview' && !previewShown) pane = 'editor';
  // A preview that doesn't show the current text yet (hidden while the text changed) can't say where
  // anything is: the editor's caret is the place then.
  if (pane === 'preview' && previewPaused()) return { pos: editor.selectionStart, caret: false, from: 'editor' };
  if (pane === 'editor') {
    if (lastNav.kind === 'caret' && lastNav.pane === 'editor') return { pos: editor.selectionStart, caret: true, from: 'editor' };
    return { pos: offsetForEditorY(editor.scrollTop + 4), caret: false, from: 'editor' };
  }
  if (lastNav.kind === 'caret' && lastNav.pane === 'preview') {
    const p = previewCaretOffset(doc);
    if (p !== null && p !== undefined) return { pos: p, caret: true, from: 'preview' };
  }
  return { pos: offsetForPreviewY(doc, preview.scrollTop + 4), caret: false, from: 'preview' };
}

let pendingPreviewCaret = null; // source offset for the preview caret when the preview gets the focus next

/** After the view changed: show the anchor in each visible pane (and carry the caret over). */
function applyAnchor(doc, a, mode) {
  if (!a) return;
  const editorShown = mode !== 'preview-only';
  const previewShown = mode !== 'edit-only';
  if (editorShown) {
    if (a.from === 'preview' && a.caret) {
      // From a caret in the preview: the editor caret goes to the matching place (no text changes).
      editor.setSelectionRange(a.pos, a.pos);
    }
    const y = editorYForOffset(a.pos);
    if (y < editor.scrollTop || y > editor.scrollTop + editor.clientHeight - 30) setScrollQuietly(editor, 'editor', y - editor.clientHeight / 3);
    editorHighlight.scrollTop = editor.scrollTop;
    if (lineNumbersVisible) renderGutter();
  }
  if (previewShown) {
    const y = previewYForOffset(doc, a.pos);
    setScrollQuietly(preview, 'preview', y - (editorShown ? editorYForOffset(a.pos) - editor.scrollTop : preview.clientHeight / 3));
    pendingPreviewCaret = { docId: doc.id, pos: a.pos };
  }
}

/** Wraps a view change (Edit / Preview / split) so the same part of the document stays in view. */
function changeViewKeepingPlace(mode, change) {
  const doc = getActive();
  const from = layoutMode;
  if (!doc || from === mode) return change();
  const a = captureAnchor(doc, from);
  change();
  applyAnchor(doc, a, mode);
  // A preview that renders a moment later (big files) or images that load: align once more.
  setTimeout(() => {
    if (getActive() === doc && layoutMode === mode) applyAnchor(doc, { ...a, caret: false }, mode);
  }, 120);
}

/** focusForTyping() asks this first: put the preview caret where the editor caret was. */
function takePendingPreviewCaret(doc) {
  const p = pendingPreviewCaret;
  pendingPreviewCaret = null;
  if (!p || !doc || p.docId !== doc.id) return false;
  return placePreviewCaret(doc, p.pos);
}

function wirePositionSync() {
  editor.addEventListener('scroll', () => {
    if (performance.now() >= ignoreScroll.editor) lastNav = { pane: 'editor', kind: 'scroll' };
    onPaneScroll('editor');
  });
  preview.addEventListener('scroll', () => {
    if (performance.now() >= ignoreScroll.preview) lastNav = { pane: 'preview', kind: 'scroll' };
    onPaneScroll('preview');
  });
  ['keyup', 'mouseup', 'input'].forEach((ev) => editor.addEventListener(ev, onEditorCaret));
  ['keyup', 'mouseup', 'input'].forEach((ev) => preview.addEventListener(ev, onPreviewCaret));
  editor.addEventListener('focus', () => (lastNav = { pane: 'editor', kind: 'caret' }));
}
