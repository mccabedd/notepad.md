/* Find bar (bottom of the window), the Advanced pane (a Timeline-style list of lines with
 * From/To/Find/Hide filters, coloured bookmarks and a context menu) and line bookmarks.
 *
 * Loaded BEFORE renderer.js: everything here only touches renderer globals (docs, getActive,
 * editor, preview, ...) inside functions, never at load time. */

const findBar = document.getElementById('find-bar');
const findInput = document.getElementById('find-input');
const replaceInput = document.getElementById('replace-input');
const findPrevBtn = document.getElementById('find-prev');
const findNextBtn = document.getElementById('find-next');
const replaceOneBtn = document.getElementById('replace-one');
const replaceAllBtn = document.getElementById('replace-all');
const findStatus = document.getElementById('find-status');
const findCloseBtn = document.getElementById('find-close');
const advToggle = document.getElementById('find-advanced');

const advPane = document.getElementById('adv-pane');
const advSplitter = document.getElementById('adv-splitter');
const advFrom = document.getElementById('adv-from');
const advTo = document.getElementById('adv-to');
const advFind = document.getElementById('adv-find');
const advHide = document.getElementById('adv-hide');
const advCase = document.getElementById('adv-case');
const advWord = document.getElementById('adv-word');
const advRegex = document.getElementById('adv-regex');
const advWild = document.getElementById('adv-wild');
const advScope = document.getElementById('adv-scope');
const advAddBm = document.getElementById('adv-add-bm');
const advAddBmLabel = document.getElementById('adv-add-bm-label');
const advPrevBm = document.getElementById('adv-prev-bm');
const advNextBm = document.getElementById('adv-next-bm');
const advStatus = document.getElementById('adv-status');
const advClearFilters = document.getElementById('adv-clear-filters');
const advReset = document.getElementById('adv-reset');
const advMax = document.getElementById('adv-max');
const advGrid = document.getElementById('adv-grid');
const advHeader = document.getElementById('adv-header');
const advBody = document.getElementById('adv-body');
const advSpacer = document.getElementById('adv-spacer');
const advRows = document.getElementById('adv-rows');

const BOOKMARK_COLOURS = ['Green', 'Orange', 'Red'];
const ADV_ROW_HEIGHT = 22;

const findState = {
  matches: [], // [{s, e}] in the active document
  index: -1,
  rows: [], // Advanced pane rows: { doc, line (0-based), key }
  total: 0,
  selected: new Set(), // row keys
  anchor: -1,
  current: -1,
  sortKey: 'line',
  sortDir: 1,
  addBookmarks: false,
  paneHeight: 260,
  maximised: false,
  navLine: null, // { docId, line } briefly highlighted in the editor after jumping to a row
  colWidths: { line: 70, time: 170, file: 160 },
};

/* ---------- line index (per document, cached by content) ---------- */

const lineCache = new WeakMap();

function lineIndex(doc) {
  let c = lineCache.get(doc);
  if (c && c.content === doc.content) return c;
  const lines = doc.content.split('\n');
  const starts = new Array(lines.length);
  let pos = 0;
  for (let i = 0; i < lines.length; i++) {
    starts[i] = pos;
    pos += lines[i].length + 1;
  }
  c = { content: doc.content, lines, starts, times: null, stamps: null, firstDay: null };
  lineCache.set(doc, c);
  return c;
}

function lineOf(c, pos) {
  let lo = 0;
  let hi = c.starts.length - 1;
  while (lo < hi) {
    const mid = (lo + hi + 1) >> 1;
    if (c.starts[mid] <= pos) lo = mid;
    else hi = mid - 1;
  }
  return lo;
}

/* ---------- timestamps (for the Time column and time-based From/To) ---------- */

const TS_ISO = /(\d{4})-(\d{2})-(\d{2})[ T](\d{2}):(\d{2})(?::(\d{2})(?:[.,](\d{1,6}))?)?/;
const TS_COMPACT = /\b(\d{4})(\d{2})(\d{2})T(\d{2})(\d{2})(\d{2})(?:[.,](\d{1,6}))?\b/;
const TS_TIME = /^[\s\[(]{0,3}(\d{2}):(\d{2}):(\d{2})(?:[.,](\d{1,6}))?\b/;
const DAY_MS = 86400000;

function msOf(y, mo, d, h, mi, s, frac) {
  const ms = frac ? Math.round(Number('0.' + frac) * 1000) : 0;
  return Date.UTC(+y, +mo - 1, +d, +h || 0, +mi || 0, +s || 0, ms);
}

/** Effective time per line: lines without their own timestamp inherit the previous one (log continuations). */
function lineTimes(doc) {
  const c = lineIndex(doc);
  if (c.times) return c;
  const n = c.lines.length;
  c.times = new Array(n);
  c.stamps = new Array(n);
  let last = null;
  let day = null;
  let lastTimeOnly = null;
  for (let i = 0; i < n; i++) {
    const head = c.lines[i].length > 120 ? c.lines[i].slice(0, 120) : c.lines[i];
    let m = TS_ISO.exec(head) || TS_COMPACT.exec(head);
    if (m) {
      const t = msOf(m[1], m[2], m[3], m[4], m[5], m[6], m[7]);
      if (!isNaN(t)) {
        last = t;
        day = t - (t % DAY_MS);
        lastTimeOnly = null;
        if (c.firstDay === null) c.firstDay = day;
        c.stamps[i] = m[0];
        c.times[i] = t;
        continue;
      }
    }
    m = TS_TIME.exec(head);
    if (m) {
      let base = day === null ? 0 : day;
      let t = base + ((+m[1] * 60 + +m[2]) * 60 + +m[3]) * 1000 + (m[4] ? Math.round(Number('0.' + m[4]) * 1000) : 0);
      // Time-only logs: a jump backwards of more than 12 hours means midnight passed.
      if (lastTimeOnly !== null && t < lastTimeOnly - DAY_MS / 2) {
        day = base + DAY_MS;
        t += DAY_MS;
      }
      if (day === null) day = base;
      if (c.firstDay === null) c.firstDay = day;
      lastTimeOnly = t;
      last = t;
      c.stamps[i] = m[0].trim();
      c.times[i] = t;
      continue;
    }
    c.stamps[i] = null;
    c.times[i] = last;
  }
  return c;
}

/* ---------- From / To range ---------- */

function fmtTime(t) {
  const d = new Date(t);
  const p = (n, w = 2) => String(n).padStart(w, '0');
  return d.getUTCFullYear() + '-' + p(d.getUTCMonth() + 1) + '-' + p(d.getUTCDate()) + ' ' + p(d.getUTCHours()) + ':' + p(d.getUTCMinutes()) + ':' + p(d.getUTCSeconds());
}

/** Parses one From/To value. To is inclusive to the precision typed (a minute covers the whole minute). */
function parseBound(text, isTo, c) {
  const s = (text || '').trim();
  if (!s) return null;
  let m;
  if ((m = /^#(\d+)$/.exec(s)) || (m = /^(\d{1,7})$/.exec(s))) {
    const line = Number(m[1]);
    if (line < 1) return { error: 'Line numbers start at 1.' };
    return { kind: 'line', line, label: 'line ' + line.toLocaleString('en-GB') };
  }
  let start = null;
  let unit = 0;
  let timeOnly = false;
  if ((m = /^(\d{4})(\d{2})(\d{2})$/.exec(s)) || (m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(s))) {
    start = msOf(m[1], m[2], m[3]);
    unit = DAY_MS;
  } else if ((m = /^(\d{4})(\d{2})(\d{2})T(\d{2})(\d{2})(\d{2})?$/.exec(s))) {
    start = msOf(m[1], m[2], m[3], m[4], m[5], m[6]);
    unit = m[6] ? 1000 : 60000;
  } else if ((m = /^(\d{4})-(\d{2})-(\d{2})[ T](\d{1,2}):(\d{2})(?::(\d{2})(?:[.,](\d{1,3}))?)?$/.exec(s))) {
    start = msOf(m[1], m[2], m[3], m[4], m[5], m[6], m[7]);
    unit = m[7] ? 1 : m[6] ? 1000 : 60000;
  } else if ((m = /^(\d{1,2}):(\d{2})(?::(\d{2})(?:[.,](\d{1,3}))?)?$/.exec(s))) {
    if (c.firstDay === null) return { error: 'A time on its own (' + s + ') needs timestamps in the file, and none were found.' };
    start = c.firstDay + ((+m[1] * 60 + +m[2]) * 60 + (+m[3] || 0)) * 1000 + (m[4] ? Math.round(Number('0.' + m[4]) * 1000) : 0);
    unit = m[4] ? 1 : m[3] ? 1000 : 60000;
    timeOnly = true;
  }
  if (start === null || isNaN(start)) {
    return { error: 'Could not read “' + s + '” as a line number (e.g. 120 or #120) or a time (e.g. 14:30, 2024-10-14 14:30:05, 20241014).' };
  }
  return { kind: 'time', time: isTo ? start + unit - 1 : start, timeOnly, unit, label: s };
}

function parseRange(fromText, toText, c) {
  const from = parseBound(fromText, false, c);
  const to = parseBound(toText, true, c);
  const res = { active: false, error: null, note: '', desc: '', matches: () => true };
  if (from && from.error) return { ...res, error: from.error };
  if (to && to.error) return { ...res, error: to.error };
  if (!from && !to) return res;
  // Overnight: two times of day where To is earlier than From roll To to the next day.
  if (from && to && from.kind === 'time' && to.kind === 'time' && from.timeOnly && to.timeOnly && to.time < from.time) {
    to.time += DAY_MS;
    res.note = '(To rolls over to the next day.)';
  }
  if (from && to && from.kind === to.kind) {
    const a = from.kind === 'line' ? from.line : from.time;
    const b = to.kind === 'line' ? to.line : to.time;
    if (a > b) return { ...res, error: 'From (' + from.label + ') is after To (' + to.label + ').' };
  }
  res.active = true;
  res.desc = [from ? 'From ' + from.label : '', to ? 'To ' + to.label : ''].filter(Boolean).join(' · ');
  res.matches = (lineNo, time) => {
    for (const [b, isTo] of [[from, false], [to, true]]) {
      if (!b) continue;
      if (b.kind === 'line') {
        if (isTo ? lineNo > b.line : lineNo < b.line) return false;
      } else {
        if (time === null || time === undefined) return false;
        if (isTo ? time > b.time : time < b.time) return false;
      }
    }
    return true;
  };
  return res;
}

/* ---------- matching ---------- */

function splitTerms(s) {
  return (s || '')
    .split(',')
    .map((t) => t.trim())
    .filter(Boolean);
}

function advancedOn() {
  return advToggle.checked;
}

function advancedActive() {
  return !findBar.classList.contains('hidden') && advToggle.checked;
}

let matcherCache = { key: null, value: null };

/** Wildcard term: * stands for any run of characters within a line (a * at either end changes nothing). */
function wildcardSource(term) {
  const core = term.replace(/^\*+|\*+$/g, '');
  return core ? core.split(/\*+/).map(escapeRegExp).join('.*?') : '';
}

/** Hide box terms (lower case); with Wildcard ticked, a term with * in it becomes a pattern. */
function hideMatchers() {
  const wild = advWild.checked && !advRegex.checked;
  return splitTerms(advHide.value)
    .map((t) => t.toLowerCase())
    .map((t) => (wild && t.includes('*') ? (wildcardSource(t) ? { re: new RegExp(wildcardSource(t)) } : null) : t))
    .filter(Boolean);
}

/**
 * Basic mode: the Find text literally, case-insensitive (as before).
 * Advanced mode: comma-separated terms (any of them), or a regular expression, with Match case / Whole word.
 */
function buildMatcher() {
  const adv = advancedOn();
  const o = { text: findInput.value, adv, mc: adv && advCase.checked, ww: adv && advWord.checked, re: adv && advRegex.checked, wc: adv && !advRegex.checked && advWild.checked };
  const key = JSON.stringify(o);
  if (matcherCache.key === key) return matcherCache.value;
  let value = null;
  if (o.text) {
    let source = o.re ? o.text : (adv ? splitTerms(o.text) : [o.text]).map(o.wc ? wildcardSource : escapeRegExp).filter(Boolean).join('|');
    if (source) {
      if (o.ww) source = '\\b(?:' + source + ')\\b';
      try {
        value = { re: new RegExp(source, 'gm' + (o.mc ? '' : 'i')), regexMode: o.re, error: null };
      } catch (e) {
        value = { re: null, regexMode: o.re, error: 'Invalid regular expression: ' + e.message };
      }
    }
  }
  matcherCache = { key, value };
  return value;
}

function findAllIn(text, re, limit = 50000) {
  const out = [];
  re.lastIndex = 0;
  let m;
  while ((m = re.exec(text))) {
    if (m[0].length === 0) {
      re.lastIndex++;
      continue;
    }
    out.push({ s: m.index, e: m.index + m[0].length });
    if (out.length >= limit) break;
  }
  return out;
}

/* ---------- Advanced pane rows ---------- */

function scopeDocs() {
  if (advScope.value === 'all') return docs.slice();
  const d = getActive();
  return d ? [d] : [];
}

function removedSet(doc) {
  if (!doc.removedLines) doc.removedLines = new Set();
  return doc.removedLines;
}

let lastRangeInfo = { error: null, desc: '', note: '' };

function computeRows() {
  const m = buildMatcher();
  const hide = hideMatchers();
  const rows = [];
  let total = 0;
  lastRangeInfo = { error: null, desc: '', note: '' };
  for (const doc of scopeDocs()) {
    const c = lineTimes(doc);
    total += c.lines.length;
    const range = parseRange(advFrom.value, advTo.value, c);
    if (range.error) lastRangeInfo.error = range.error;
    else if (range.active) {
      lastRangeInfo.desc = range.desc;
      if (range.note) lastRangeInfo.note = range.note;
    }
    const useRange = !range.error && range.active;
    let matchLines = null;
    if (m && m.re) {
      matchLines = new Set();
      for (const hit of findAllIn(doc.content, m.re, 200000)) matchLines.add(lineOf(c, hit.s));
    } else if (m && m.error) matchLines = new Set();
    const bms = doc.bookmarks || {};
    const removed = removedSet(doc);
    for (let i = 0; i < c.lines.length; i++) {
      if (removed.has(i)) continue;
      let ok = true;
      if (useRange && !range.matches(i + 1, c.times[i])) ok = false;
      if (ok && matchLines && !matchLines.has(i)) ok = false;
      if (ok && hide.length) {
        const low = c.lines[i].toLowerCase();
        if (hide.some((h) => (h.re ? h.re.test(low) : low.includes(h)))) ok = false;
      }
      // "Add Bookmarks" (as in the Timeline): bookmarked lines are always listed.
      if (!ok && findState.addBookmarks && bms[i]) ok = true;
      if (ok) rows.push({ doc, line: i, key: doc.id + ':' + i });
    }
  }
  sortRows(rows);
  return { rows, total, matcher: m };
}

function sortRows(rows) {
  const k = findState.sortKey;
  const d = findState.sortDir;
  const order = new Map(docs.map((x, i) => [x.id, i]));
  const byDocLine = (a, b) => order.get(a.doc.id) - order.get(b.doc.id) || a.line - b.line;
  let cmp;
  if (k === 'time') {
    cmp = (a, b) => {
      const ta = lineTimes(a.doc).times[a.line];
      const tb = lineTimes(b.doc).times[b.line];
      if (ta == null && tb == null) return byDocLine(a, b);
      if (ta == null) return 1;
      if (tb == null) return -1;
      return (ta - tb) * d || byDocLine(a, b);
    };
  } else if (k === 'file') {
    cmp = (a, b) => tabTitle(a.doc).localeCompare(tabTitle(b.doc)) * d || a.line - b.line;
  } else if (k === 'text') {
    cmp = (a, b) => lineIndex(a.doc).lines[a.line].localeCompare(lineIndex(b.doc).lines[b.line]) * d || byDocLine(a, b);
  } else {
    cmp = (a, b) => byDocLine(a, b) * d;
  }
  rows.sort(cmp);
}

function fmtCount(n) {
  return n.toLocaleString('en-GB');
}

function refreshAdvanced() {
  if (!advancedActive()) return;
  const prevCurrentKey = findState.rows[findState.current] ? findState.rows[findState.current].key : null;
  const { rows, total, matcher } = computeRows();
  findState.rows = rows;
  findState.total = total;
  const keys = new Set(rows.map((r) => r.key));
  for (const k of [...findState.selected]) if (!keys.has(k)) findState.selected.delete(k);
  findState.current = prevCurrentKey ? rows.findIndex((r) => r.key === prevCurrentKey) : -1;
  updateAdvancedStatus(matcher);
  renderGrid();
  renderHeader();
}

function updateAdvancedStatus(matcher) {
  const shown = findState.rows.length;
  const total = findState.total;
  let s;
  if (matcher && matcher.error) s = '⚠ ' + matcher.error;
  else if (lastRangeInfo.error) s = '⚠ ' + lastRangeInfo.error + '  The range is not applied; showing ' + fmtCount(shown) + ' of ' + fmtCount(total) + ' lines.';
  else
    s = 'Showing ' + fmtCount(shown) + ' of ' + fmtCount(total) + ' lines.' + (lastRangeInfo.desc ? '  ' + lastRangeInfo.desc : '') + (lastRangeInfo.note ? ' ' + lastRangeInfo.note : '');
  const removed = scopeDocs().reduce((n, d) => n + removedSet(d).size, 0);
  if (removed) s += '  ' + fmtCount(removed) + ' removed (Reset brings them back).';
  advStatus.textContent = s;
  advStatus.title = s;
}

/* ---------- grid rendering (virtualised: only visible rows exist in the DOM) ---------- */

function highlightLineHtml(text, matcher) {
  const shown = text.length > 2000 ? text.slice(0, 2000) : text;
  if (!matcher || !matcher.re) return escapeHtml(shown);
  const hits = findAllIn(shown, matcher.re, 200);
  if (!hits.length) return escapeHtml(shown);
  let out = '';
  let last = 0;
  for (const h of hits) {
    out += escapeHtml(shown.slice(last, h.s)) + '<mark>' + escapeHtml(shown.slice(h.s, h.e)) + '</mark>';
    last = h.e;
  }
  return out + escapeHtml(shown.slice(last));
}

let gridFrame = 0;
function scheduleGridRender() {
  if (gridFrame) return;
  gridFrame = requestAnimationFrame(() => {
    gridFrame = 0;
    renderGrid();
  });
}

function renderGrid() {
  if (advPane.classList.contains('hidden')) return;
  const rows = findState.rows;
  advSpacer.style.height = rows.length * ADV_ROW_HEIGHT + 'px';
  const top = advBody.scrollTop;
  const h = advBody.clientHeight || 200;
  const first = Math.max(0, Math.floor(top / ADV_ROW_HEIGHT) - 5);
  const last = Math.min(rows.length, Math.ceil((top + h) / ADV_ROW_HEIGHT) + 5);
  advRows.style.transform = 'translateY(' + first * ADV_ROW_HEIGHT + 'px)';
  const matcher = buildMatcher();
  const showFile = advScope.value === 'all';
  advGrid.classList.toggle('show-file', showFile);
  let html = '';
  for (let i = first; i < last; i++) {
    const r = rows[i];
    const c = lineTimes(r.doc);
    const bm = (r.doc.bookmarks || {})[r.line];
    const text = c.lines[r.line];
    let cls = 'adv-row' + (i % 2 ? ' alt' : '');
    if (findState.selected.has(r.key)) cls += ' selected';
    if (i === findState.current) cls += ' current';
    if (bm) cls += ' bm bm-' + bm.toLowerCase();
    html +=
      '<div class="' + cls + '" data-i="' + i + '">' +
      '<span class="c c-line">' + (r.line + 1) + '</span>' +
      '<span class="c c-time">' + escapeHtml(c.stamps[r.line] || '') + '</span>' +
      (showFile ? '<span class="c c-file">' + escapeHtml(tabTitle(r.doc)) + '</span>' : '') +
      '<span class="c c-text" title="' + escapeHtml(text.slice(0, 500)).replace(/"/g, '&quot;') + '">' + highlightLineHtml(text, matcher) + '</span>' +
      '</div>';
  }
  advRows.innerHTML = html;
  if (!rows.length) {
    advRows.innerHTML = '<div class="adv-empty">' + (findInput.value || advFrom.value || advTo.value || advHide.value ? 'No lines match the filters.' : 'This document is empty.') + '</div>';
  }
}

const COLUMNS = [
  { key: 'line', label: 'Line #', cls: 'c-line' },
  { key: 'time', label: 'Time', cls: 'c-time' },
  { key: 'file', label: 'File', cls: 'c-file' },
  { key: 'text', label: 'Text', cls: 'c-text' },
];

function renderHeader() {
  advHeader.innerHTML = COLUMNS.map((col) => {
    const arrow = findState.sortKey === col.key ? (findState.sortDir > 0 ? ' ▲' : ' ▼') : '';
    const resizer = col.key === 'text' ? '' : '<span class="col-resize" data-col="' + col.key + '"></span>';
    return '<span class="c ' + col.cls + '" data-sort="' + col.key + '">' + col.label + arrow + resizer + '</span>';
  }).join('');
  applyColumnWidths();
}

function applyColumnWidths() {
  for (const [k, w] of Object.entries(findState.colWidths)) advGrid.style.setProperty('--col-' + k, w + 'px');
}

/* ---------- selection & navigation ---------- */

function selectOnly(i) {
  findState.selected.clear();
  if (findState.rows[i]) findState.selected.add(findState.rows[i].key);
  findState.anchor = i;
  findState.current = i;
}

function selectRange(a, b, additive) {
  if (!additive) findState.selected.clear();
  const [lo, hi] = a < b ? [a, b] : [b, a];
  for (let i = lo; i <= hi; i++) if (findState.rows[i]) findState.selected.add(findState.rows[i].key);
  findState.current = b;
}

function selectedRows() {
  const rows = findState.rows.filter((r) => findState.selected.has(r.key));
  if (!rows.length && findState.rows[findState.current]) rows.push(findState.rows[findState.current]);
  return rows;
}

function scrollRowIntoView(i) {
  const top = i * ADV_ROW_HEIGHT;
  if (top < advBody.scrollTop) advBody.scrollTop = top;
  else if (top + ADV_ROW_HEIGHT > advBody.scrollTop + advBody.clientHeight) advBody.scrollTop = top + ADV_ROW_HEIGHT - advBody.clientHeight;
}

/** Shows a document position in the editor (and preview) without necessarily moving keyboard focus. */
function revealRange(doc, s, e, focusEditor) {
  if (doc.id !== activeId) setActiveTab(doc.id);
  const editorShown = layoutMode !== 'preview-only';
  if (editorShown) {
    if (focusEditor) editor.focus();
    editor.setSelectionRange(s, e);
    renderEditorOverlay();
    scrollEditorToOffset(s);
  }
  if (previewVisible()) scrollPreviewToOffset(doc, s);
}

function revealRow(i, focusEditor) {
  const r = findState.rows[i];
  if (!r) return;
  const c = lineIndex(r.doc);
  findState.navLine = { docId: r.doc.id, line: r.line };
  const s = c.starts[r.line];
  revealRange(r.doc, s, s + c.lines[r.line].length, focusEditor);
  scheduleOverlay();
}

function rangeAtTextOffset(root, pos) {
  const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
  let n;
  let base = 0;
  while ((n = walker.nextNode())) {
    const len = n.nodeValue.length;
    if (pos <= base + len) {
      const r = document.createRange();
      r.setStart(n, Math.max(0, pos - base));
      r.collapse(true);
      return r;
    }
    base += len;
  }
  return null;
}

function scrollEditorToOffset(pos) {
  let y = null;
  if (!editorHighlight.classList.contains('hidden')) {
    const r = rangeAtTextOffset(editorHighlight, pos);
    if (r) {
      const rect = r.getClientRects()[0] || r.getBoundingClientRect();
      const base = editorHighlight.getBoundingClientRect();
      y = rect.top - base.top + editorHighlight.scrollTop;
    }
  }
  // No coloured layer (a huge file): where the line is, with word-wrapped lines worked out.
  if (y === null) y = editorYForOffset(pos);
  const visibleTop = editor.scrollTop;
  if (y < visibleTop + 20 || y > visibleTop + editor.clientHeight - 40) {
    editor.scrollTop = Math.max(0, y - editor.clientHeight / 3);
  }
  editorHighlight.scrollTop = editor.scrollTop;
  if (lineNumbersVisible) renderGutter();
}

function scrollPreviewToOffset(doc, pos) {
  if (preview.classList.contains('code-view')) {
    const code = preview.querySelector('code');
    const r = code && rangeAtTextOffset(code, pos);
    if (r) {
      const rect = r.getClientRects()[0] || r.getBoundingClientRect();
      const base = preview.getBoundingClientRect();
      const y = rect.top - base.top + preview.scrollTop;
      if (y < preview.scrollTop + 20 || y > preview.scrollTop + preview.clientHeight - 40) preview.scrollTop = Math.max(0, y - preview.clientHeight / 3);
      return;
    }
  }
  // Rendered Markdown/BBCode has no exact line mapping: scroll proportionally.
  const ratio = doc.content.length ? pos / doc.content.length : 0;
  preview.scrollTop = ratio * Math.max(0, preview.scrollHeight - preview.clientHeight);
}

/* ---------- bookmarks ---------- */

function bookmarkOf(doc, line) {
  return (doc.bookmarks || {})[line] || null;
}

function setBookmarks(doc, lines, colour) {
  if (!doc.bookmarks) doc.bookmarks = {};
  for (const l of lines) {
    if (colour) doc.bookmarks[l] = colour;
    else delete doc.bookmarks[l];
  }
  bookmarksChanged();
}

function bookmarksChanged() {
  updateLineNumbers();
  scheduleOverlay();
  scheduleSessionSave();
  if (advancedActive()) {
    if (findState.addBookmarks) refreshAdvanced();
    else renderGrid();
  }
}

/** Ctrl+Shift+B in the grid: bookmark the selection (current bookmark colour), or remove if every selected row already is one. */
function toggleSelectedBookmarks() {
  const rows = selectedRows();
  if (!rows.length) return;
  const all = rows.every((r) => bookmarkOf(r.doc, r.line));
  setRowsBookmark(rows, all ? null : settings.bookmarkColour);
}

function setRowsBookmark(rows, colour) {
  const byDoc = new Map();
  for (const r of rows) {
    if (!byDoc.has(r.doc)) byDoc.set(r.doc, []);
    byDoc.get(r.doc).push(r.line);
  }
  for (const [doc, lines] of byDoc) setBookmarks(doc, lines, colour);
}

async function clearAllBookmarks(doc) {
  const n = Object.keys(doc.bookmarks || {}).length;
  if (!n) return;
  const ok = await dialogApi.ask('Remove all ' + n + ' bookmark(s) in "' + tabTitle(doc) + '"?', { title: 'Clear Bookmarks', kind: 'warning' });
  if (!ok) return;
  doc.bookmarks = {};
  bookmarksChanged();
}

function caretLine(doc) {
  return lineOf(lineIndex(doc), editor.selectionStart);
}

function toggleBookmarkAtCaret() {
  const doc = getActive();
  if (!doc) return;
  const line = caretLine(doc);
  setBookmarks(doc, [line], bookmarkOf(doc, line) ? null : settings.bookmarkColour);
}

/** Right-click in the bookmark margin: the colour picked also becomes the one a click gives. */
function showBookmarkMarginMenu(x, y, doc, line) {
  const cur = bookmarkOf(doc, line);
  const items = [{ label: 'LINE ' + fmtCount(line + 1), header: true }];
  for (const col of BOOKMARK_COLOURS) {
    items.push({
      label: col,
      dot: col.toLowerCase(),
      checked: cur === col,
      gesture: col === settings.bookmarkColour ? 'Click' : '',
      action: () => {
        setBookmarkColour(col);
        setBookmarks(doc, [line], col);
      },
    });
  }
  items.push('sep');
  items.push({ label: 'Remove bookmark', icon: '✕', disabled: !cur, action: () => setBookmarks(doc, [line], null) });
  items.push({ label: 'Clear all bookmarks in this tab…', icon: '⌫', disabled: !Object.keys(doc.bookmarks || {}).length, action: () => clearAllBookmarks(doc) });
  showContextMenu(x, y, items);
}

/**
 * Search > Bookmark: cut, copy, paste to (replace), remove, remove the others, inverse.
 * Every change to the text is one undo step; bookmarks follow their lines.
 */
async function bookmarkedLinesAction(kind) {
  const doc = getActive();
  if (!doc) return;
  const c = lineIndex(doc);
  const lines = c.lines;
  const n = lines.length;
  const bms = doc.bookmarks || {};
  if (kind === 'inverse') {
    const out = {};
    for (let i = 0; i < n; i++) if (!bms[i]) out[i] = settings.bookmarkColour;
    doc.bookmarks = out;
    bookmarksChanged();
    flashFindStatus(fmtCount(Object.keys(out).length) + ' line(s) bookmarked.');
    return;
  }
  const marked = Object.keys(bms).map(Number).filter((l) => l < n).sort((a, b) => a - b);
  if (!marked.length) {
    flashFindStatus('No bookmarks in this tab. Click in the margin beside a line number, or press Ctrl+F2, to bookmark a line.');
    return;
  }
  const isMarked = new Set(marked);
  const eol = doc.eol === 'crlf' ? '\r\n' : '\n';
  if (kind === 'copy' || kind === 'cut') {
    await clipboard.writeText(marked.map((l) => lines[l] + eol).join(''));
    if (kind === 'copy') {
      flashFindStatus('Copied ' + fmtCount(marked.length) + ' bookmarked line(s).');
      return;
    }
  }
  let clip = '';
  if (kind === 'paste') {
    try {
      clip = ((await clipboard.readText()) || '').replace(/\r\n?/g, '\n');
    } catch (e) {
      clip = '';
    }
  }
  const outLines = [];
  const outBms = {};
  for (let i = 0; i < n; i++) {
    if (kind === 'paste' && isMarked.has(i)) {
      outBms[outLines.length] = bms[i];
      outLines.push(...clip.split('\n'));
    } else if ((kind === 'cut' || kind === 'remove') && isMarked.has(i)) {
      continue;
    } else if (kind === 'remove-others' && !isMarked.has(i)) {
      continue;
    } else {
      if (bms[i]) outBms[outLines.length] = bms[i];
      outLines.push(lines[i]);
    }
  }
  const oldText = doc.content;
  const newText = outLines.join('\n');
  if (newText !== oldText) {
    // Replace only the part that changed, as one edit (one undo step).
    let p = 0;
    const min = Math.min(oldText.length, newText.length);
    while (p < min && oldText.charCodeAt(p) === newText.charCodeAt(p)) p++;
    let so = oldText.length;
    let sn = newText.length;
    while (so > p && sn > p && oldText.charCodeAt(so - 1) === newText.charCodeAt(sn - 1)) {
      so--;
      sn--;
    }
    applyEdit(doc, p, so, newText.slice(p, sn));
  }
  doc.bookmarks = outBms;
  bookmarksChanged();
  const what = { cut: 'Cut', paste: 'Replaced', remove: 'Removed', 'remove-others': 'Kept' }[kind];
  flashFindStatus(what + ' ' + fmtCount(marked.length) + ' bookmarked line(s)' + (kind === 'remove-others' ? ' and removed the rest.' : '.'));
}

/** F2 / Shift+F2 in the editor: jump to the next/previous bookmarked line (wrapping). */
function gotoBookmark(dir) {
  const doc = getActive();
  if (!doc) return;
  const lines = Object.keys(doc.bookmarks || {}).map(Number).sort((a, b) => a - b);
  if (!lines.length) {
    flashFindStatus('No bookmarks in this tab. Ctrl+F2 bookmarks the current line.');
    return;
  }
  const cur = caretLine(doc);
  let target = dir > 0 ? lines.find((l) => l > cur) : [...lines].reverse().find((l) => l < cur);
  if (target === undefined) target = dir > 0 ? lines[0] : lines[lines.length - 1];
  const c = lineIndex(doc);
  findState.navLine = { docId: doc.id, line: target };
  revealRange(doc, c.starts[target], c.starts[target], true);
  scheduleOverlay();
  flashFindStatus('Bookmark at line ' + fmtCount(target + 1) + ' (' + bookmarkOf(doc, target) + ').');
}

/** Timeline-style Previous/Next: moves between blocks of consecutive bookmarked lines that are visible in the list. */
function navigateBookmarkBlock(dir) {
  const visible = new Map(findState.rows.map((r, i) => [r.key, i]));
  const groups = [];
  for (const doc of scopeDocs()) {
    const lines = Object.keys(doc.bookmarks || {}).map(Number).sort((a, b) => a - b);
    let g = null;
    for (const l of lines) {
      if (!g || g.doc !== doc || g.lines[g.lines.length - 1] + 1 !== l) {
        g = { doc, lines: [] };
        groups.push(g);
      }
      g.lines.push(l);
    }
  }
  if (!groups.length) {
    advStatus.textContent = 'No bookmarks yet. Right-click a row (or press Ctrl+Shift+B) to bookmark it.';
    return;
  }
  const cur = findState.rows[findState.current];
  let curGroup = cur ? groups.findIndex((g) => g.doc === cur.doc && g.lines.includes(cur.line)) : -1;
  const order = [];
  if (curGroup >= 0) {
    for (let k = 1; k < groups.length; k++) order.push((((curGroup + dir * k) % groups.length) + groups.length) % groups.length);
  } else if (cur) {
    const docOrder = new Map(docs.map((x, i) => [x.id, i]));
    const pos = (g) => docOrder.get(g.doc.id) * 1e9 + g.lines[0];
    const here = docOrder.get(cur.doc.id) * 1e9 + cur.line;
    let first = dir > 0 ? groups.findIndex((g) => pos(g) > here) : groups.map(pos).map((p, i) => [p, i]).filter(([p]) => p < here).map(([, i]) => i).pop();
    if (first === undefined || first < 0) first = dir > 0 ? 0 : groups.length - 1;
    for (let k = 0; k < groups.length; k++) order.push((first + dir * k + groups.length * 2) % groups.length);
  } else {
    for (let k = 0; k < groups.length; k++) order.push(dir > 0 ? k : groups.length - 1 - k);
  }
  for (const gi of order) {
    const g = groups[gi];
    const target = g.lines.find((l) => visible.has(g.doc.id + ':' + l));
    if (target === undefined) continue;
    const i = visible.get(g.doc.id + ':' + target);
    selectOnly(i);
    scrollRowIntoView(i);
    renderGrid();
    revealRow(i, false);
    advBody.focus();
    advStatus.textContent =
      g.lines.length === 1
        ? 'Bookmark at line ' + fmtCount(target + 1) + '.'
        : 'Bookmarked block: lines ' + fmtCount(g.lines[0] + 1) + '–' + fmtCount(g.lines[g.lines.length - 1] + 1) + ' (' + g.lines.length + ' rows).';
    return;
  }
  advStatus.textContent =
    curGroup >= 0 && groups.length === 1
      ? 'Only one bookmarked block.'
      : curGroup >= 0
      ? 'No other bookmarked blocks are visible with the current filters.'
      : 'No bookmarked rows are visible with the current filters.';
}

/** Keeps bookmarks (and removed rows) on the same text when lines are inserted or deleted above them. */
/**
 * Moves find matches along with an edit (old text [from, to) replaced, length change `delta`)
 * until find runs again, so the highlights stay on their words and, in big files, only the
 * edited line is redrawn. Matches touching the edit are dropped (find re-checks them shortly).
 */
function shiftFindMatches(from, to, delta) {
  const cur = findState.matches[findState.index];
  const out = [];
  for (const m of findState.matches) {
    if (m.e <= from) out.push(m);
    else if (m.s >= to) {
      m.s += delta;
      m.e += delta;
      out.push(m);
    }
  }
  findState.matches = out;
  const i = cur ? out.indexOf(cur) : -1;
  findState.index = i >= 0 ? i : Math.min(findState.index, out.length - 1);
}

function adjustLineAnchors(doc, oldText, newText) {
  const hasBm = doc.bookmarks && Object.keys(doc.bookmarks).length;
  const hasRemoved = doc.removedLines && doc.removedLines.size;
  const hasMatches = doc.id === activeId && findState.matches.length > 0;
  const hasDiag = !!(doc.diag && doc.diag.list.length);
  if (!hasBm && !hasRemoved && !hasMatches && !hasDiag) return;
  let p = 0;
  const min = Math.min(oldText.length, newText.length);
  while (p < min && oldText.charCodeAt(p) === newText.charCodeAt(p)) p++;
  let so = oldText.length;
  let sn = newText.length;
  while (so > p && sn > p && oldText.charCodeAt(so - 1) === newText.charCodeAt(sn - 1)) {
    so--;
    sn--;
  }
  if (hasMatches) shiftFindMatches(p, so, sn - so);
  if (hasDiag) shiftDiagnostics(doc, p, so, sn - so);
  if (!hasBm && !hasRemoved) return;
  const countNl = (t, a, b) => {
    let n = 0;
    for (let i = a; i < b; i++) if (t.charCodeAt(i) === 10) n++;
    return n;
  };
  const oldNl = countNl(oldText, p, so);
  const newNl = countNl(newText, p, sn);
  const delta = newNl - oldNl;
  if (!delta) return;
  let startLine = countNl(oldText, 0, p);
  // Text inserted at the very start of a line pushes that line down rather than splitting it.
  if (p === 0 || oldText.charCodeAt(p - 1) === 10) startLine -= 1;
  const remap = (l) => (l <= startLine ? l : l > startLine + oldNl ? l + delta : l <= startLine + newNl ? l : null);
  if (hasBm) {
    const out = {};
    for (const [k, v] of Object.entries(doc.bookmarks)) {
      const nl = remap(Number(k));
      if (nl !== null && nl >= 0) out[nl] = v;
    }
    doc.bookmarks = out;
  }
  if (hasRemoved) {
    const out = new Set();
    for (const l of doc.removedLines) {
      const nl = remap(l);
      if (nl !== null && nl >= 0) out.add(nl);
    }
    doc.removedLines = out;
  }
}

/* ---------- editor decorations (consumed by renderEditorOverlay in renderer.js) ---------- */

/** Non-overlapping, sorted range lists: find hits, bookmarked lines, and the line just navigated to. */
function editorDecorations(doc) {
  const lists = [];
  if (!findBar.classList.contains('hidden') && findState.matches.length) {
    const cur = findState.matches[findState.index];
    lists.push(findState.matches.slice(0, 5000).map((h) => ({ s: h.s, e: h.e, cls: h === cur ? 'find-hit find-current' : 'find-hit' })));
  }
  const bms = doc.bookmarks || {};
  const bmLines = Object.keys(bms).map(Number).sort((a, b) => a - b);
  if (bmLines.length) {
    const c = lineIndex(doc);
    lists.push(
      bmLines
        .filter((l) => l < c.lines.length && c.lines[l].length)
        .map((l) => ({ s: c.starts[l], e: c.starts[l] + c.lines[l].length, cls: 'bm-line bm-' + bms[l].toLowerCase() }))
    );
  }
  if (findState.navLine && findState.navLine.docId === doc.id) {
    const c = lineIndex(doc);
    const l = findState.navLine.line;
    if (l < c.lines.length && c.lines[l].length) lists.push([{ s: c.starts[l], e: c.starts[l] + c.lines[l].length, cls: 'nav-line' }]);
  }
  const diags = typeof diagnosticDecorations === 'function' ? diagnosticDecorations(doc) : [];
  if (diags.length) lists.push(diags);
  return lists.filter((l) => l.length);
}

/* ---------- find bar ---------- */

let flashTimer = 0;
function flashFindStatus(text, ms = 3000) {
  if (findBar.classList.contains('hidden')) {
    statusDirty.textContent = text;
    statusDirty.title = text;
    clearTimeout(flashTimer);
    flashTimer = setTimeout(() => {
      statusDirty.title = '';
      updateStatusBar();
    }, ms);
  } else {
    findStatus.textContent = text;
  }
}

function openFindBar(advanced) {
  findBar.classList.remove('hidden');
  if (advanced !== undefined && advanced !== advToggle.checked) {
    advToggle.checked = advanced;
    applyAdvancedVisibility();
  }
  const selected = lastFocused === 'editor' ? editor.value.slice(editor.selectionStart, editor.selectionEnd) : '';
  if (selected && !selected.includes('\n')) {
    findInput.value = selected;
    advFind.value = selected;
  }
  findInput.focus();
  findInput.select();
  refreshFind(true);
  scheduleSessionSave();
}

function closeFindBar() {
  findBar.classList.add('hidden');
  applyAdvancedVisibility();
  findState.matches = [];
  findState.index = -1;
  findState.navLine = null;
  clearPreviewFindHighlights();
  scheduleOverlay();
  scheduleSessionSave();
  if (layoutMode === 'preview-only') preview.focus();
  else editor.focus();
}

function applyAdvancedVisibility() {
  const show = advancedActive();
  advPane.classList.toggle('hidden', !show);
  advSplitter.classList.toggle('hidden', !show || findState.maximised);
  document.body.classList.toggle('adv-maximised', show && findState.maximised);
  advFind.parentElement.classList.toggle('hidden', !show);
  advPane.style.height = findState.paneHeight + 'px';
  if (show) {
    renderHeader();
    refreshAdvanced();
  }
  matcherCache.key = null;
}

let findTimer = 0;
/** Debounced: recompute the Advanced rows, then the matches in the active tab. */
function scheduleFindRefresh(reveal = false, delay = 120) {
  if (findBar.classList.contains('hidden')) return;
  clearTimeout(findTimer);
  findTimer = setTimeout(() => refreshFind(reveal), delay);
}

function refreshFind(reveal) {
  clearTimeout(findTimer);
  if (advancedActive()) refreshAdvanced();
  recomputeMatches(reveal);
}

function recomputeMatches(reveal) {
  const doc = getActive();
  const m = buildMatcher();
  let list = [];
  if (doc && m && m.re && !findBar.classList.contains('hidden')) {
    list = findAllIn(doc.content, m.re, 20000);
    if (advancedActive()) {
      // In Advanced mode, Up/Down and Replace only visit lines that are listed (From/To/Hide/removed apply).
      const allowed = new Set(findState.rows.filter((r) => r.doc === doc).map((r) => r.line));
      const c = lineIndex(doc);
      list = list.filter((h) => allowed.has(lineOf(c, h.s)));
    }
  }
  findState.matches = list;
  if (reveal) {
    const caret = layoutMode === 'preview-only' ? 0 : editor.selectionStart;
    const idx = list.findIndex((h) => h.s >= caret);
    findState.index = list.length ? (idx >= 0 ? idx : 0) : -1;
  } else if (findState.index >= list.length) findState.index = list.length ? 0 : -1;
  else if (list.length && findState.index < 0) findState.index = 0;
  updateFindStatus(m);
  if (reveal) highlightCurrentMatch();
  else {
    scheduleOverlay();
    refreshPreviewFindHighlights(false);
  }
}

function updateFindStatus(m) {
  if (m && m.error) findStatus.textContent = '⚠ Invalid regex';
  else if (findState.matches.length) findStatus.textContent = findState.index + 1 + ' of ' + fmtCount(findState.matches.length);
  else findStatus.textContent = findInput.value ? 'No matches' : '';
}

function stepMatch(dir) {
  if (findBar.classList.contains('hidden')) {
    openFindBar();
    return;
  }
  if (!findState.matches.length) return;
  findState.index = (findState.index + dir + findState.matches.length) % findState.matches.length;
  updateFindStatus(buildMatcher());
  highlightCurrentMatch();
}

function highlightCurrentMatch() {
  const doc = getActive();
  const hit = findState.matches[findState.index];
  findState.navLine = null;
  if (doc && hit) {
    if (layoutMode !== 'preview-only') {
      editor.setSelectionRange(hit.s, hit.e);
      renderEditorOverlay();
      scrollEditorToOffset(hit.s);
    }
    // Keep the matching row selected in the Advanced list.
    if (advancedActive()) {
      const line = lineOf(lineIndex(doc), hit.s);
      const i = findState.rows.findIndex((r) => r.doc === doc && r.line === line);
      if (i >= 0) {
        selectOnly(i);
        scrollRowIntoView(i);
        renderGrid();
      }
    }
  } else scheduleOverlay();
  refreshPreviewFindHighlights(true);
}

function clearPreviewFindHighlights() {
  if (window.CSS && CSS.highlights) {
    CSS.highlights.delete('find');
    CSS.highlights.delete('find-current');
  }
}

/** All matches in the preview get a soft highlight, the current one a strong one (no DOM changes). */
function refreshPreviewFindHighlights(scrollToCurrent) {
  clearPreviewFindHighlights();
  if (!window.CSS || !CSS.highlights || findBar.classList.contains('hidden') || !previewVisible()) return;
  const m = buildMatcher();
  if (!m || !m.re) return;
  const ranges = [];
  const walker = document.createTreeWalker(preview, NodeFilter.SHOW_TEXT, {
    acceptNode: (n) => (n.parentElement && n.parentElement.closest('.code-copy-btn') ? NodeFilter.FILTER_REJECT : NodeFilter.FILTER_ACCEPT),
  });
  let node;
  while ((node = walker.nextNode()) && ranges.length < 5000) {
    for (const h of findAllIn(node.nodeValue, m.re, 1000)) {
      const r = document.createRange();
      r.setStart(node, h.s);
      r.setEnd(node, h.e);
      ranges.push(r);
    }
  }
  if (!ranges.length) return;
  CSS.highlights.set('find', new Highlight(...ranges));
  if (findState.index >= 0) {
    // Best effort: the n-th match in the source is usually the n-th in the rendered text.
    const cur = ranges[Math.min(findState.index, ranges.length - 1)];
    CSS.highlights.set('find-current', new Highlight(cur));
    if (scrollToCurrent && layoutMode === 'preview-only') {
      const rect = cur.getBoundingClientRect();
      const base = preview.getBoundingClientRect();
      if (rect.top < base.top || rect.bottom > base.bottom) preview.scrollTop += rect.top - base.top - preview.clientHeight / 3;
    }
  }
}

function replacementFor(matchText, m) {
  if (!m.regexMode) return replaceInput.value;
  return matchText.replace(new RegExp(m.re.source, m.re.flags.replace('g', '')), replaceInput.value);
}

/** Applies a change to a document, keeping the editor's undo history when it is the active one. */
function applyEdit(doc, start, end, text) {
  if (doc.id === activeId) {
    const keepFocus = document.activeElement;
    // Only go through execCommand (which keeps undo) when the editor can really take focus:
    // otherwise insertText would type into whatever else has focus, e.g. the Replace box.
    let done = false;
    if (layoutMode !== 'preview-only') {
      editor.focus();
      if (document.activeElement === editor) {
        editor.setSelectionRange(start, end);
        done = document.execCommand('insertText', false, text);
      }
    }
    if (!done) {
      editor.value = editor.value.slice(0, start) + text + editor.value.slice(end);
      syncFromEditor();
    }
    if (keepFocus && keepFocus !== editor && keepFocus.focus) keepFocus.focus();
  } else {
    doc.content = doc.content.slice(0, start) + text + doc.content.slice(end);
    markDirty(doc);
  }
}

function replaceCurrent() {
  const doc = getActive();
  const m = buildMatcher();
  const hit = findState.matches[findState.index];
  if (!doc || !m || !m.re || !hit) return;
  const keepIndex = findState.index;
  applyEdit(doc, hit.s, hit.e, replacementFor(doc.content.slice(hit.s, hit.e), m));
  refreshFind(false);
  findState.index = findState.matches.length ? Math.min(keepIndex, findState.matches.length - 1) : -1;
  updateFindStatus(m);
  highlightCurrentMatch();
}

/** Replace All: the whole active tab, or in Advanced mode every listed line in scope (current tab or all tabs). */
function replaceAll() {
  const m = buildMatcher();
  if (!m || !m.re) return;
  const targets = advancedActive() ? scopeDocs() : [getActive()].filter(Boolean);
  let count = 0;
  let tabs = 0;
  for (const doc of targets) {
    let hits = findAllIn(doc.content, m.re, 1000000);
    if (advancedActive()) {
      const allowed = new Set(findState.rows.filter((r) => r.doc === doc).map((r) => r.line));
      const c = lineIndex(doc);
      hits = hits.filter((h) => allowed.has(lineOf(c, h.s)));
    }
    if (!hits.length) continue;
    let out = '';
    let last = 0;
    for (const h of hits) {
      out += doc.content.slice(last, h.s) + replacementFor(doc.content.slice(h.s, h.e), m);
      last = h.e;
    }
    out += doc.content.slice(last);
    applyEdit(doc, 0, doc.content.length, out);
    count += hits.length;
    tabs++;
  }
  refreshFind(false);
  findStatus.textContent = 'Replaced ' + fmtCount(count) + (tabs > 1 ? ' in ' + tabs + ' tabs' : '');
}

/* ---------- context menu & keyboard for the Advanced list ---------- */

function appendTerm(box, value) {
  const v = value.replace(/,/g, ' ').trim();
  if (!v) return;
  box.value = box.value.trim() ? box.value.replace(/[,\s]+$/, '') + ', ' + v : v;
  box.dispatchEvent(new Event('input'));
}

function rangeValueFor(r) {
  const stamp = lineTimes(r.doc).stamps[r.line];
  return stamp || '#' + (r.line + 1);
}

function copyRows(rows, what) {
  const text = rows
    .map((r) => {
      const c = lineTimes(r.doc);
      if (what === 'numbers') return String(r.line + 1);
      if (what === 'table') return [r.line + 1, c.stamps[r.line] || '', tabTitle(r.doc), c.lines[r.line]].join('\t');
      return c.lines[r.line];
    })
    .join('\n');
  clipboard.writeText(text);
  advStatus.textContent = 'Copied ' + fmtCount(rows.length) + (what === 'numbers' ? ' line number(s).' : ' line(s).');
}

function removeRows(rows) {
  for (const r of rows) removedSet(r.doc).add(r.line);
  findState.selected.clear();
  refreshAdvanced();
  recomputeMatches(false);
}

function cellTextFor(r, col, rowEl) {
  const c = lineTimes(r.doc);
  if (col === 'line') return String(r.line + 1);
  if (col === 'time') return c.stamps[r.line] || '';
  if (col === 'file') return tabTitle(r.doc);
  const sel = window.getSelection();
  const selText = sel && rowEl && rowEl.contains(sel.anchorNode) ? sel.toString().trim() : '';
  return selText || c.lines[r.line].trim();
}

function quoteLabel(v) {
  v = v.replace(/\s+/g, ' ');
  return '“' + (v.length > 40 ? v.slice(0, 39) + '…' : v) + '”';
}

function showRowMenu(x, y, rowEl, col) {
  const rows = selectedRows();
  if (!rows.length) return;
  const many = rows.length > 1;
  const r = findState.rows[Number(rowEl.dataset.i)] || rows[0];
  const c = lineTimes(r.doc);
  const common = rows.map((x) => bookmarkOf(x.doc, x.line)).reduce((a, b) => (a === b ? a : undefined));
  const title = many
    ? fmtCount(rows.length) + ' ROWS SELECTED'
    : ['LINE ' + fmtCount(r.line + 1), c.stamps[r.line], advScope.value === 'all' ? tabTitle(r.doc) : null].filter(Boolean).join(' · ').toUpperCase();
  const cell = many ? '' : cellTextFor(r, col, rowEl);
  const rv = many ? null : rangeValueFor(r);
  const items = [{ label: title, header: true }];
  items.push({
    label: common ? 'Bookmark  ·  ' + common : 'Bookmark',
    icon: '⚑',
    submenu: [
      ...BOOKMARK_COLOURS.map((col2) => ({ label: col2, dot: col2.toLowerCase(), checked: common === col2, gesture: col2 === settings.bookmarkColour ? 'Ctrl+Shift+B' : '', action: () => { setBookmarkColour(col2); setRowsBookmark(rows, col2); } })),
      'sep',
      { label: many ? 'Remove bookmarks from selection' : 'Remove bookmark', icon: '✕', disabled: !many && !common, action: () => setRowsBookmark(rows, null) },
      { label: 'Clear all bookmarks in this file…', icon: '⌫', disabled: !Object.keys(r.doc.bookmarks || {}).length, action: () => clearAllBookmarks(r.doc) },
    ],
  });
  items.push({ label: many ? 'Remove ' + fmtCount(rows.length) + ' rows from the list' : 'Remove from the list', icon: '✕', gesture: 'Delete', action: () => removeRows(rows) });
  items.push('sep');
  if (cell) items.push({ label: 'Copy ' + quoteLabel(cell), icon: '⧉', action: () => clipboard.writeText(cell) });
  items.push({ label: many ? 'Copy ' + fmtCount(rows.length) + ' lines' : 'Copy line', icon: '⧉', gesture: 'Ctrl+C', action: () => copyRows(rows, 'text') });
  items.push({ label: many ? 'Copy line numbers' : 'Copy line number', icon: '#', gesture: 'Ctrl+Shift+C', action: () => copyRows(rows, 'numbers') });
  items.push({ label: 'Copy as table (line, time, file, text)', icon: '⧉', action: () => copyRows(rows, 'table') });
  items.push('sep');
  if (rv) {
    items.push({ label: 'Show from here   (' + rv + ')', icon: '↓', action: () => setFilterBox(advFrom, rv) });
    items.push({ label: 'Show up to here   (' + rv + ')', icon: '↑', action: () => setFilterBox(advTo, rv) });
  }
  if (cell && cell.length <= 120) {
    items.push({
      label: 'Filter by ' + quoteLabel(cell),
      icon: '⎽',
      submenu: [
        { label: 'Show only rows containing this', icon: '◉', disabled: advRegex.checked, action: () => appendTerm(advFind, cell) },
        { label: 'Hide rows containing this', icon: '◌', action: () => appendTerm(advHide, cell) },
      ],
    });
  }
  items.push('sep');
  items.push({ label: 'Go to line', icon: '↵', gesture: 'Enter', disabled: many, action: () => revealRow(Number(rowEl.dataset.i), true) });
  items.push({ label: 'Select all listed rows', icon: '☷', gesture: 'Ctrl+A', action: selectAllRows });
  showContextMenu(x, y, items);
}

function setFilterBox(box, value) {
  box.value = value;
  box.dispatchEvent(new Event('input'));
}

function selectAllRows() {
  findState.rows.forEach((r) => findState.selected.add(r.key));
  renderGrid();
}

function onGridKeyDown(e) {
  const n = findState.rows.length;
  const ctrl = e.ctrlKey || e.metaKey;
  let handled = true;
  const move = (to) => {
    to = Math.max(0, Math.min(n - 1, to));
    if (e.shiftKey) selectRange(findState.anchor < 0 ? to : findState.anchor, to, false);
    else selectOnly(to);
    scrollRowIntoView(to);
    renderGrid();
    revealRow(to, false);
  };
  const page = Math.max(1, Math.floor(advBody.clientHeight / ADV_ROW_HEIGHT) - 1);
  if (!n && !ctrl) return;
  if (e.key === 'ArrowDown') move(findState.current + 1);
  else if (e.key === 'ArrowUp') move(findState.current - 1);
  else if (e.key === 'PageDown') move(findState.current + page);
  else if (e.key === 'PageUp') move(findState.current - page);
  else if (e.key === 'Home' && ctrl) move(0);
  else if (e.key === 'End' && ctrl) move(n - 1);
  else if (e.key === 'Enter') revealRow(findState.current, true);
  else if (e.key === 'Delete' && !ctrl) removeRows(selectedRows());
  else if (ctrl && !e.shiftKey && !e.altKey && e.code === 'KeyA') selectAllRows();
  else if (ctrl && !e.altKey && e.code === 'KeyC') copyRows(selectedRows(), e.shiftKey ? 'numbers' : 'text');
  else if (ctrl && e.shiftKey && !e.altKey && e.code === 'KeyB') toggleSelectedBookmarks();
  else if (e.key === 'Escape') {
    if (layoutMode === 'preview-only') preview.focus();
    else editor.focus();
  } else handled = false;
  if (handled) {
    e.preventDefault();
    e.stopPropagation();
  }
}

/* ---------- remembered state ---------- */

function captureFindState() {
  return {
    open: !findBar.classList.contains('hidden'),
    advanced: advToggle.checked,
    find: findInput.value,
    replace: replaceInput.value,
    from: advFrom.value,
    to: advTo.value,
    hide: advHide.value,
    matchCase: advCase.checked,
    wholeWord: advWord.checked,
    regex: advRegex.checked,
    wildcard: advWild.checked,
    scope: advScope.value,
    addBookmarks: findState.addBookmarks,
    paneHeight: findState.paneHeight,
    maximised: findState.maximised,
    sortKey: findState.sortKey,
    sortDir: findState.sortDir,
    colWidths: findState.colWidths,
  };
}

function restoreFindState(s) {
  if (!s) return;
  findInput.value = advFind.value = s.find || '';
  replaceInput.value = s.replace || '';
  advFrom.value = s.from || '';
  advTo.value = s.to || '';
  advHide.value = s.hide || '';
  advCase.checked = !!s.matchCase;
  advWord.checked = !!s.wholeWord;
  advRegex.checked = !!s.regex;
  advWild.checked = !s.regex && !!s.wildcard;
  advScope.value = s.scope === 'all' ? 'all' : 'tab';
  findState.addBookmarks = !!s.addBookmarks;
  advAddBm.checked = findState.addBookmarks;
  advAddBmLabel.textContent = findState.addBookmarks ? 'Remove Bookmarks' : 'Add Bookmarks';
  if (s.paneHeight >= 100) findState.paneHeight = s.paneHeight;
  findState.maximised = !!s.maximised;
  advMax.textContent = findState.maximised ? 'Restore' : 'Maximize';
  if (s.sortKey) findState.sortKey = s.sortKey;
  if (s.sortDir) findState.sortDir = s.sortDir;
  if (s.colWidths) findState.colWidths = { ...findState.colWidths, ...s.colWidths };
  advToggle.checked = !!s.advanced;
  matcherCache.key = null;
  if (s.open) {
    findBar.classList.remove('hidden');
    applyAdvancedVisibility();
    refreshFind(false);
  } else applyAdvancedVisibility();
}

/* ---------- wiring ---------- */

function wireFind() {
  const onFindText = (src) => {
    if (src === findInput) advFind.value = findInput.value;
    else findInput.value = advFind.value;
    matcherCache.key = null;
    scheduleFindRefresh(true, 60);
    scheduleSessionSave();
  };
  findInput.addEventListener('input', () => onFindText(findInput));
  advFind.addEventListener('input', () => onFindText(advFind));
  [advFrom, advTo, advHide].forEach((el) =>
    el.addEventListener('input', () => {
      scheduleFindRefresh(false, 150);
      scheduleSessionSave();
    })
  );
  [advCase, advWord, advRegex, advWild, advScope].forEach((el) =>
    el.addEventListener('change', () => {
      // Regex and Wildcard are either/or.
      if (el === advRegex && advRegex.checked) advWild.checked = false;
      if (el === advWild && advWild.checked) advRegex.checked = false;
      matcherCache.key = null;
      advFind.placeholder = advRegex.checked ? 'regular expression' : advWild.checked ? 'term*, *term, ...' : 'term, term, ...';
      refreshFind(false);
      scheduleSessionSave();
    })
  );
  advToggle.addEventListener('change', () => {
    applyAdvancedVisibility();
    refreshFind(false);
    scheduleSessionSave();
  });
  advAddBm.addEventListener('change', () => {
    findState.addBookmarks = advAddBm.checked;
    const n = scopeDocs().reduce((k, d) => k + Object.keys(d.bookmarks || {}).length, 0);
    if (findState.addBookmarks && !n) {
      findState.addBookmarks = false;
      advAddBm.checked = false;
      advStatus.textContent = 'No bookmarks are available to add.';
      return;
    }
    advAddBmLabel.textContent = findState.addBookmarks ? 'Remove Bookmarks' : 'Add Bookmarks';
    refreshFind(false);
    if (findState.addBookmarks) advStatus.textContent += '  Bookmarked lines (' + n + ') are always listed.';
    scheduleSessionSave();
  });
  advPrevBm.addEventListener('click', () => navigateBookmarkBlock(-1));
  advNextBm.addEventListener('click', () => navigateBookmarkBlock(1));
  advClearFilters.addEventListener('click', () => {
    advFrom.value = advTo.value = advHide.value = '';
    findInput.value = advFind.value = '';
    matcherCache.key = null;
    refreshFind(false);
    scheduleSessionSave();
  });
  advReset.addEventListener('click', () => {
    advFrom.value = advTo.value = advHide.value = '';
    findInput.value = advFind.value = '';
    for (const d of docs) d.removedLines = new Set();
    findState.addBookmarks = false;
    advAddBm.checked = false;
    advAddBmLabel.textContent = 'Add Bookmarks';
    findState.selected.clear();
    matcherCache.key = null;
    refreshFind(false);
    scheduleSessionSave();
  });
  advMax.addEventListener('click', () => {
    findState.maximised = !findState.maximised;
    advMax.textContent = findState.maximised ? 'Restore' : 'Maximize';
    applyAdvancedVisibility();
    scheduleSessionSave();
  });
  // X: close the Advanced pane completely (same as unticking "Advanced"; the find bar stays).
  document.getElementById('adv-close').addEventListener('click', () => {
    advToggle.checked = false;
    applyAdvancedVisibility();
    refreshFind(false);
    findInput.focus();
    scheduleSessionSave();
  });

  findNextBtn.addEventListener('click', () => stepMatch(1));
  findPrevBtn.addEventListener('click', () => stepMatch(-1));
  replaceOneBtn.addEventListener('click', replaceCurrent);
  replaceAllBtn.addEventListener('click', replaceAll);
  findCloseBtn.addEventListener('click', closeFindBar);
  [findInput, replaceInput, advFind, advFrom, advTo, advHide].forEach((el) =>
    el.addEventListener('keydown', (e) => {
      if (e.key === 'Enter') {
        e.preventDefault();
        stepMatch(e.shiftKey ? -1 : 1);
      } else if (e.key === 'Escape') {
        closeFindBar();
      }
    })
  );
  replaceInput.addEventListener('input', () => scheduleSessionSave());

  // Grid
  advBody.addEventListener('scroll', () => {
    scheduleGridRender();
    hideContextMenu();
  });
  advBody.addEventListener('keydown', onGridKeyDown);
  advRows.addEventListener('mousedown', (e) => {
    const rowEl = e.target.closest('.adv-row');
    if (!rowEl) return;
    const i = Number(rowEl.dataset.i);
    const key = findState.rows[i] && findState.rows[i].key;
    if (e.button === 2) {
      if (!findState.selected.has(key)) selectOnly(i);
      renderGrid();
      return;
    }
    if (e.button !== 0) return;
    // The first click redraws the rows, so the browser never sends a dblclick: catch the second press here.
    if (e.detail === 2 && !e.shiftKey && !e.ctrlKey && !e.metaKey) {
      e.preventDefault(); // don't select a word
      onRowDoubleClick(e, rowEl);
      return;
    }
    if (e.shiftKey && findState.anchor >= 0) selectRange(findState.anchor, i, e.ctrlKey);
    else if (e.ctrlKey || e.metaKey) {
      if (findState.selected.has(key)) findState.selected.delete(key);
      else findState.selected.add(key);
      findState.anchor = i;
      findState.current = i;
    } else selectOnly(i);
    advBody.focus({ preventScroll: true });
    renderGrid();
    if (!e.shiftKey && !e.ctrlKey) revealRow(i, false);
  });
  // Double-click: on the Time or Text cell, copy that cell; elsewhere, go and edit there.
  const onRowDoubleClick = (e, rowEl) => {
    const i = Number(rowEl.dataset.i);
    const r = findState.rows[i];
    const cellEl = e.target.closest('.c');
    const col = cellEl ? (cellEl.className.match(/c-(line|time|file|text)/) || [])[1] : null;
    if (r && (col === 'time' || col === 'text')) {
      const c = lineTimes(r.doc);
      const value = col === 'time' ? c.stamps[r.line] || '' : c.lines[r.line];
      const sel = window.getSelection();
      if (sel) sel.removeAllRanges(); // the double-click selected a word
      if (!value) {
        advStatus.textContent = 'This line has no time to copy.';
        return;
      }
      clipboard.writeText(value);
      advStatus.textContent = 'Copied the ' + (col === 'time' ? 'time ' + value : 'text of line ' + fmtCount(r.line + 1)) + ' to the clipboard.';
      return;
    }
    revealRow(i, true);
  };
  advRows.addEventListener('contextmenu', (e) => {
    const rowEl = e.target.closest('.adv-row');
    if (!rowEl) return;
    e.preventDefault();
    const cellEl = e.target.closest('.c');
    const col = cellEl ? (cellEl.className.match(/c-(line|time|file|text)/) || [])[1] : 'text';
    showRowMenu(e.clientX, e.clientY, rowEl, col || 'text');
  });

  // Header: sort on click, resize columns by dragging the edge.
  advHeader.addEventListener('click', (e) => {
    if (e.target.closest('.col-resize')) return;
    const h = e.target.closest('[data-sort]');
    if (!h) return;
    const k = h.dataset.sort;
    if (findState.sortKey === k) findState.sortDir = -findState.sortDir;
    else {
      findState.sortKey = k;
      findState.sortDir = 1;
    }
    refreshAdvanced();
    scheduleSessionSave();
  });
  advHeader.addEventListener('mousedown', (e) => {
    const handle = e.target.closest('.col-resize');
    if (!handle) return;
    e.preventDefault();
    const col = handle.dataset.col;
    const startX = e.clientX;
    const startW = findState.colWidths[col];
    const onMove = (ev) => {
      findState.colWidths[col] = Math.max(40, Math.min(600, startW + ev.clientX - startX));
      applyColumnWidths();
    };
    const onUp = () => {
      window.removeEventListener('mousemove', onMove);
      window.removeEventListener('mouseup', onUp);
      scheduleSessionSave();
    };
    window.addEventListener('mousemove', onMove);
    window.addEventListener('mouseup', onUp);
  });

  // Splitter between the editor and the Advanced pane.
  advSplitter.addEventListener('mousedown', (e) => {
    e.preventDefault();
    advSplitter.classList.add('dragging');
    const startY = e.clientY;
    const startH = advPane.offsetHeight;
    const onMove = (ev) => {
      const max = window.innerHeight - 220;
      findState.paneHeight = Math.max(110, Math.min(max, startH + startY - ev.clientY));
      advPane.style.height = findState.paneHeight + 'px';
      scheduleGridRender();
    };
    const onUp = () => {
      advSplitter.classList.remove('dragging');
      window.removeEventListener('mousemove', onMove);
      window.removeEventListener('mouseup', onUp);
      scheduleSessionSave();
    };
    window.addEventListener('mousemove', onMove);
    window.addEventListener('mouseup', onUp);
  });
  window.addEventListener('resize', scheduleGridRender);
}
