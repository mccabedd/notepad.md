/* Syntax validation (Settings > Syntax Validation): checks the active tab after a pause in typing,
 * in a worker (validate-worker.js) for JSON / JSON with Comments / JSON5 / JSON Lines / YAML / TOML,
 * and with the browser's XML parser for XML. Results are kept per tab with the exact text they were
 * made for: a result for text that has changed since is thrown away, and edits move existing
 * markers along until the next check. Nothing is ever changed without a click on "Apply fix".
 *
 * Loaded before renderer.js; only touches renderer globals inside functions. */

const VALIDATE_AUTO_MAX = 1024 * 1024; // above this, only with "also check 1-5 MB files"
const VALIDATE_LARGE_MAX = 5 * 1024 * 1024; // above this, only Search > Check Syntax Now
const VALIDATION_NAMES = {
  json: 'JSON', jsonc: 'JSON with Comments', json5: 'JSON5', jsonl: 'JSON Lines', yaml: 'YAML', toml: 'TOML', xml: 'XML',
  compose: 'Docker Compose', javascript: 'JavaScript', dockerfile: 'Dockerfile', env: '.env', systemd: 'systemd', desktop: 'Desktop entry', ini: 'INI',
  // Structure checks (brackets, quotes, blocks...), not full parsers: the name says so.
  python: 'Python structure', bash: 'Shell structure', powershell: 'PowerShell structure', css: 'CSS structure', nginx: 'NGINX structure', hcl: 'HCL structure', apache: 'Apache structure',
};

let validateWorker = null;
let validateSeq = 0;
const validateWaiting = new Map(); // id -> { doc, text, mode }
let validateTimer = 0;

/** Which check applies to this tab, or null. `.config` files are only checked as XML when they look like XML. */
function validationMode(doc) {
  if (!doc || !settings.validateEnabled) return null;
  const mode = langInfo(doc).validate || null;
  if (mode === 'xml' && /\.config$/i.test(doc.path || '') && !/^\s*</.test(doc.content.slice(0, 2000))) return null;
  return mode;
}

/** Problems to show for this tab (current settings applied), sorted by position. */
function visibleDiagnostics(doc) {
  if (!doc || !doc.diag || !validationMode(doc)) return [];
  return doc.diag.list.filter((d) => settings.validateWarnings || d.severity === 'error');
}

function scheduleValidation(doc, delay) {
  if (!doc || doc.id !== activeId) return;
  clearTimeout(validateTimer);
  const mode = validationMode(doc);
  if (!mode) {
    if (doc.diag) clearDiagnostics(doc);
    return;
  }
  if (doc.diag && doc.diag.text === doc.content && doc.diag.mode === mode) return; // already checked
  const len = doc.content.length;
  if (!settings.validateAuto || len > VALIDATE_LARGE_MAX || (len > VALIDATE_AUTO_MAX && !settings.validateLarge)) {
    updateDiagStatus();
    return;
  }
  validateTimer = setTimeout(() => runValidation(doc), delay === undefined ? settings.validateDelay : delay);
}

/** Search > Check Syntax Now (any size). */
function validateNow() {
  const doc = getActive();
  const mode = validationMode(doc);
  if (!mode) {
    flashFindStatus(settings.validateEnabled ? 'Syntax checking is not available for ' + langInfo(doc).label + '.' : 'Syntax validation is switched off (Settings > Syntax Validation).', 5000);
    return;
  }
  runValidation(doc, true);
}

function runValidation(doc, announce) {
  if (!docs.includes(doc)) return;
  const mode = validationMode(doc);
  if (!mode) return;
  const text = doc.content;
  if (mode === 'xml') {
    finishValidation(doc, text, mode, checkXml(text), announce);
    return;
  }
  if (!validateWorker) {
    validateWorker = new Worker('validate-worker.js');
    validateWorker.onmessage = (e) => {
      const w = validateWaiting.get(e.data.id);
      validateWaiting.delete(e.data.id);
      if (w) finishValidation(w.doc, w.text, w.mode, e.data.diagnostics, w.announce);
    };
    validateWorker.onerror = (e) => console.error('validation worker', e.message);
  }
  // Only the newest request per tab matters.
  for (const [id, w] of validateWaiting) if (w.doc === doc) validateWaiting.delete(id);
  const id = ++validateSeq;
  validateWaiting.set(id, { doc, text, mode, announce });
  validateWorker.postMessage({ id, mode, text, name: doc.path || '', eol: doc.eol });
}

function finishValidation(doc, text, mode, list, announce) {
  // A result for text that has changed since (or a closed tab) is never shown.
  if (!docs.includes(doc) || doc.content !== text || validationMode(doc) !== mode) return;
  doc.diag = { text, mode, list };
  diagnosticsChanged(doc);
  if (announce) {
    const n = list.length;
    flashFindStatus(n ? VALIDATION_NAMES[mode] + ': ' + diagSummary(list) + '. F8 goes to the next one.' : VALIDATION_NAMES[mode] + ': no syntax problems found.', 5000);
  }
}

function clearDiagnostics(doc) {
  doc.diag = null;
  diagnosticsChanged(doc);
}

function diagnosticsChanged(doc) {
  if (doc.id !== activeId) return;
  scheduleOverlay();
  updateLineNumbers();
  updateDiagStatus();
}

/** Edits move the markers along (and drop the ones the edit touched) until the next check. */
function shiftDiagnostics(doc, from, to, delta) {
  if (!doc.diag || !doc.diag.list.length) return;
  const out = [];
  for (const d of doc.diag.list) {
    if (d.e < from || (d.e === from && d.s < from)) out.push(d);
    else if (d.s > to || (d.s === to && to > from)) {
      const m = { ...d, s: d.s + delta, e: d.e + delta, stale: true };
      if (m.fix) m.fix = { ...m.fix, s: m.fix.s + delta, e: m.fix.e + delta };
      out.push(m);
    }
  }
  doc.diag = { ...doc.diag, list: out };
}

/* ---------- XML (on the page: the browser's own parser; no DTDs or external entities are fetched) ---------- */

function checkXml(text) {
  if (!text.trim()) return [];
  const loc = (() => {
    const starts = [0];
    for (let i = text.indexOf('\n'); i !== -1; i = text.indexOf('\n', i + 1)) starts.push(i + 1);
    return starts;
  })();
  let doc;
  try {
    doc = new DOMParser().parseFromString(text, 'application/xml');
  } catch (e) {
    return [];
  }
  const err = doc.getElementsByTagName('parsererror')[0];
  if (!err) return [];
  const msg = err.textContent || '';
  const m = /error on line (\d+) at column (\d+):\s*([^\n]*)/.exec(msg);
  const line = m ? Math.max(0, Math.min(loc.length - 1, +m[1] - 1)) : 0;
  const col = m ? Math.max(0, +m[2] - 1) : 0;
  const lineEnd = line + 1 < loc.length ? loc[line + 1] - 1 : text.length;
  let s = Math.min(loc[line] + col, lineEnd);
  // The parser reports the column just after the problem: underline the character before it.
  if (s > loc[line]) s -= 1;
  let reason = m ? m[3].replace(/Below is a rendering of the page.*$/, '').trim() : 'The XML is not well-formed.';
  let hint = null;
  let r;
  // What is around the reported spot (the wording of the parser's messages varies between versions).
  const near = text.slice(Math.max(loc[line], s - 3), Math.min(lineEnd, s + 3));
  const inTag = (() => {
    const lt = text.lastIndexOf('<', s);
    return lt !== -1 && text.lastIndexOf('>', s - 1) < lt;
  })();
  if (/Unexpected token/.test(reason) && inTag && /=\s*[^"'\s>]/.test(near + text.slice(s, s + 2))) {
    reason = 'AttValue: " or \' expected';
  } else if (/entity/i.test(reason) && /&/.test(text.slice(Math.max(loc[line], s - 30), s + 1)) && !/Entity '/.test(reason)) {
    reason = "EntityRef: expecting ';'";
  }
  let e = Math.min(s + 1, text.length);
  const lineOfPos = (p) => {
    let l = 0;
    while (l + 1 < loc.length && loc[l + 1] <= p) l++;
    return l + 1;
  };
  // The parser in newer WebView2 versions says "Unexpected closing tag: x != y"; older ones "Opening and ending tag mismatch".
  const newMismatch = /Unexpected closing tag: (\S+) != (\S+)/.exec(reason);
  if (newMismatch) {
    const close = text.lastIndexOf('</', s);
    const open = text.lastIndexOf('<' + newMismatch[2], close === -1 ? s : close);
    if (close !== -1 && close >= loc[line]) {
      e = Math.min(lineEnd, Math.max(s + 1, text.indexOf('>', close) + 1 || s + 1));
      s = close;
    }
    reason = 'Opening and ending tag mismatch: ' + newMismatch[2] + ' line ' + (open !== -1 ? lineOfPos(open) : 0) + ' and ' + newMismatch[1];
  }
  if ((r = /Opening and ending tag mismatch: (\S+) line (\d+) and (\S+)/.exec(reason))) {
    reason = 'The closing tag </' + r[3] + '> does not match the open <' + r[1] + '>' + (+r[2] > 0 ? ' on line ' + r[2] : '') + '.';
    hint = 'Close <' + r[1] + '> first, or check the spelling of the tag names.';
  } else if (/Unexpected end of stream: still inside the root element/.test(reason)) {
    reason = 'The file ends before the root element is closed: a closing tag is missing.';
  } else if (/^Unexpected end of stream$/.test(reason)) {
    reason = 'The file ends in the middle of a tag or attribute (a quote or > is missing?).';
  } else if (/Unexpected token: <$/.test(reason) && !inTag) {
    reason = 'Unexpected tag here: an XML document has exactly one root element, or a tag before this one is not finished.';
  } else if ((r = /Unexpected entity: (\S+)/.exec(reason))) {
    reason = "Entity '" + r[1] + "' not defined";
  } else if (/Invalid processing instruction: <\?xml/.test(reason)) {
    reason = 'XML declaration allowed only at the start of the document';
  } else if ((r = /Attribute '([^']+)' is redefined/.exec(reason))) {
    reason = 'The attribute ' + r[1] + ' appears twice in this tag.';
  } else if (/Unexpected token inside qualified name/.test(reason)) {
    reason = 'StartTag: invalid element name';
  }
  if ((r = /Opening and ending tag mismatch: (\S+) line (\d+) and (\S+)/.exec(reason))) {
    // (handled above)
  } else if ((r = /Premature end of data in tag (\S+) line (\d+)/.exec(reason))) {
    reason = 'The <' + r[1] + '> opened on line ' + r[2] + ' is never closed.';
  } else if (/AttValue: " or ' expected/.test(reason)) {
    reason = 'Attribute values must be in quotes, e.g. name="value".';
  } else if (/attributes construct error|Couldn't find end of Start Tag/.test(reason)) {
    reason = 'This tag is not written correctly (check its attributes: name="value", separated by spaces).';
  } else if ((r = /Entity '([^']+)' not defined/.exec(reason))) {
    reason = 'Unknown entity &' + r[1] + '; — XML only knows &amp; &lt; &gt; &quot; &apos; unless it is declared.';
  } else if (/EntityRef: expecting ';'|xmlParseEntityRef: no name/.test(reason)) {
    reason = 'A bare & must be written as &amp; in XML.';
  } else if (/Extra content at the end of the document/.test(reason)) {
    reason = 'Content after the root element: an XML document has exactly one root element.';
  } else if (/XML declaration allowed only at the start of the document/.test(reason)) {
    reason = 'The <?xml ...?> declaration must be the very first thing in the file.';
  } else if (/StartTag: invalid element name/.test(reason)) {
    reason = 'Invalid tag name (a < that is not a tag must be written as &lt;).';
  } else if (!/^The (closing tag|file ends|attribute)|^Unexpected tag here/.test(reason)) {
    reason = reason.charAt(0).toUpperCase() + reason.slice(1);
    if (!/[.!?]$/.test(reason)) reason += '.';
  }
  return [{ s, e: Math.max(e, s + 1), line, col: s - loc[line], severity: 'error', title: 'XML well-formedness error', message: reason, hint }];
}

/* ---------- what the editor draws ---------- */

/** Underline ranges for the coloured layer (one list, sorted, not overlapping). */
function diagnosticDecorations(doc) {
  if (!settings.validateMarkers) return [];
  const text = doc.content;
  const out = [];
  let last = -1;
  visibleDiagnostics(doc).forEach((d) => {
    let s = d.s;
    let e = d.e;
    if (e <= s) {
      // A point (e.g. a missing comma): underline the character before it, or the one after.
      if (s > 0 && text[s - 1] !== '\n') s -= 1;
      else e = s + 1;
      e = Math.max(e, s + 1);
    }
    // Never across line ends (the layer is one block per line).
    const nl = text.indexOf('\n', s);
    if (nl !== -1 && nl < e) e = nl > s ? nl : s + 1;
    if (s < last) s = last;
    if (e <= s || s >= text.length) return;
    out.push({ s, e, cls: 'diag-' + d.severity });
    last = e;
  });
  return out;
}

/** Worst problem per line (for the gutter): Map(line -> 'error' | 'warning' | 'info'). */
function diagnosticLines(doc) {
  const map = new Map();
  if (!settings.validateMarkers) return map;
  const list = visibleDiagnostics(doc);
  if (!list.length) return map;
  const c = lineIndex(doc);
  const rank = { error: 3, warning: 2, info: 1 };
  for (const d of list) {
    const l = lineOf(c, Math.min(d.s, doc.content.length));
    const cur = map.get(l);
    if (!cur || rank[d.severity] > rank[cur]) map.set(l, d.severity);
  }
  return map;
}

/** True when this tab's language is checked (the gutter keeps room for markers, so nothing shifts while typing). */
function gutterHasDiagColumn(doc) {
  return !!(settings.validateMarkers && validationMode(doc));
}

function diagSummary(list) {
  const e = list.filter((d) => d.severity === 'error').length;
  const w = list.filter((d) => d.severity === 'warning').length;
  const parts = [];
  if (e) parts.push(e + ' error' + (e === 1 ? '' : 's'));
  if (w) parts.push(w + ' warning' + (w === 1 ? '' : 's'));
  const i = list.length - e - w;
  if (i) parts.push(i + ' note' + (i === 1 ? '' : 's'));
  return parts.join(', ');
}

/** Updates the status-bar item, touching the page only when something changed: on a 1 MB file a
 * rewrite on every key makes the browser lay the whole page out again. */
function updateDiagStatus() {
  const real = document.getElementById('status-diag');
  if (!real) return;
  const st = { hidden: real.classList.contains('hidden'), error: real.classList.contains('error'), warning: real.classList.contains('warning'), text: real.textContent, title: real.title };
  const set = (c, on) => (st[c] = !!on);
  const el = {
    classList: { toggle: set, add: (...cs) => cs.forEach((c) => set(c, true)), remove: (...cs) => cs.forEach((c) => set(c, false)) },
    set textContent(v) {
      st.text = v;
    },
    set title(v) {
      st.title = v;
    },
  };
  computeDiagStatus(el);
  for (const c of ['hidden', 'error', 'warning']) if (real.classList.contains(c) !== st[c]) real.classList.toggle(c, st[c]);
  if (real.textContent !== st.text) real.textContent = st.text;
  if (real.title !== st.title) real.title = st.title;
}

function computeDiagStatus(el) {
  const doc = getActive();
  const mode = validationMode(doc);
  if (!mode) {
    // Code without a checker says so (instead of looking checked).
    const code = !!doc && settings.validateEnabled && langInfo(doc).render === 'code' && !(/\.config$/i.test(doc.path || '') && langInfo(doc).validate);
    el.classList.toggle('hidden', !code);
    el.classList.remove('error', 'warning');
    if (code) {
      el.textContent = 'No syntax check';
      el.title = 'Syntax checking is not available for ' + langInfo(doc).label + ': it is coloured only.';
    }
    return;
  }
  el.classList.remove('hidden', 'error', 'warning');
  const len = doc.content.length;
  const auto = settings.validateAuto && (len <= VALIDATE_AUTO_MAX || (settings.validateLarge && len <= VALIDATE_LARGE_MAX));
  if (!doc.diag || doc.diag.mode !== mode) {
    el.textContent = auto ? VALIDATION_NAMES[mode] + ': checking...' : VALIDATION_NAMES[mode] + ': not checked';
    el.title = auto ? '' : 'Not checked automatically (' + (settings.validateAuto ? 'large file' : 'automatic checking is off') + '). Search > Check Syntax Now checks it.';
    return;
  }
  const list = visibleDiagnostics(doc);
  const e = list.filter((d) => d.severity === 'error').length;
  if (!list.length) {
    el.textContent = '✓ ' + VALIDATION_NAMES[mode];
    el.title = 'No syntax problems found' + (doc.diag.text !== doc.content ? ' (checking the latest changes...)' : '');
  } else {
    el.textContent = (e ? '✕ ' : '⚠ ') + diagSummary(list);
    el.classList.add(e ? 'error' : 'warning');
    el.title = VALIDATION_NAMES[mode] + ': ' + diagSummary(list) + '. Click (or F8) to go to the next one.';
  }
}

/* ---------- F8 / Shift+F8 ---------- */

function gotoDiagnostic(dir) {
  const doc = getActive();
  if (!doc) return;
  const list = visibleDiagnostics(doc);
  if (!validationMode(doc)) {
    flashFindStatus('Syntax checking is not available for ' + langInfo(doc).label + '.', 4000);
    return;
  }
  if (!list.length) {
    flashFindStatus(doc.diag ? 'No syntax problems in this tab.' : 'Not checked yet: Search > Check Syntax Now checks it.', 4000);
    return;
  }
  const caret = editor.selectionStart;
  let d = dir > 0 ? list.find((x) => x.s > caret) : [...list].reverse().find((x) => x.s < caret);
  if (!d) d = dir > 0 ? list[0] : list[list.length - 1];
  revealRange(doc, d.s, d.s, true);
  setTimeout(() => showDiagnosticPopup([d], null), 80);
}

/* ---------- the explanation popup (hover on a marker or an underline, or after F8) ---------- */

let diagPop = null;
let diagHoverTimer = 0;

function hideDiagnosticPopup() {
  clearTimeout(diagHoverTimer);
  if (diagPop) {
    diagPop.remove();
    diagPop = null;
  }
}

function diagRect(d) {
  // Where the problem is on screen: its underline, else its line's gutter row, else the editor.
  const doc = getActive();
  if (editor.isCodeMirror) return editor.api.rectAt(d.s) || editor.getBoundingClientRect();
  const lineEl = (() => {
    const c = lineIndex(doc);
    const l = lineOf(c, d.s);
    return lineNumbersEl.querySelector('.ln-row[data-l="' + l + '"]');
  })();
  const spans = [...editorHighlight.querySelectorAll('.diag-' + d.severity)];
  const c = lineIndex(doc);
  const l = lineOf(c, d.s);
  const kids = editorHighlight.children;
  if (kids[l] && kids[l].classList.contains('ovl')) {
    const own = spans.find((s) => s.closest('.ovl') === kids[l]);
    if (own) return own.getBoundingClientRect();
    return kids[l].getBoundingClientRect();
  }
  if (lineEl) return lineEl.getBoundingClientRect();
  return editor.getBoundingClientRect();
}

function escapeDiagHtml(s) {
  return String(s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c]);
}

/** Shows the explanation for one or more problems; anchor = a DOMRect, or null to place it at the first problem. */
function showDiagnosticPopup(list, anchor) {
  hideDiagnosticPopup();
  if (!list.length || !settings.validateTooltips) return;
  const doc = getActive();
  const pop = document.createElement('div');
  pop.className = 'diag-pop';
  pop.setAttribute('role', 'tooltip');
  pop.innerHTML = list
    .slice(0, 5)
    .map((d, k) => {
      const where = 'Line ' + (d.line + 1) + ', Column ' + (d.col + 1);
      const fix =
        settings.validateFixes && d.fix
          ? '<div class="dp-fix"><span>Suggested fix: ' + escapeDiagHtml(d.fix.label) + '</span><button data-k="' + k + '" data-act="apply" class="primary">Apply fix</button><button data-act="dismiss">Dismiss</button></div>'
          : '';
      return (
        '<div class="dp-item"><div class="dp-title ' + d.severity + '">' + where + ' — ' + escapeDiagHtml(d.title) + '</div><div>' + escapeDiagHtml(d.message) + '</div>' +
        (d.hint ? '<div class="note">' + escapeDiagHtml(d.hint) + '</div>' : '') +
        fix +
        '</div>'
      );
    })
    .join('');
  document.body.appendChild(pop);
  const r = anchor || diagRect(list[0]);
  const w = pop.offsetWidth;
  const h = pop.offsetHeight;
  let x = Math.max(8, Math.min(r.left, window.innerWidth - w - 8));
  let y = r.bottom + 6;
  if (y + h > window.innerHeight - 8) y = Math.max(8, r.top - h - 6);
  pop.style.left = x + 'px';
  pop.style.top = y + 'px';
  pop.addEventListener('mousedown', (e) => e.preventDefault()); // keep the caret in the editor
  pop.addEventListener('click', (e) => {
    const b = e.target.closest('button[data-act]');
    if (!b) return;
    if (b.dataset.act === 'apply') applyDiagnosticFix(doc, list[Number(b.dataset.k)]);
    hideDiagnosticPopup();
  });
  pop.addEventListener('mouseleave', () => {
    diagHoverTimer = setTimeout(hideDiagnosticPopup, 300);
  });
  pop.addEventListener('mouseenter', () => clearTimeout(diagHoverTimer));
  diagPop = pop;
}

/** Applies a suggested fix: only to the text it was made for, as one undo step, then checks again. */
function applyDiagnosticFix(doc, d) {
  if (!d || !d.fix || !docs.includes(doc)) return;
  const f = d.fix;
  if (!doc.diag || doc.diag.text !== doc.content || d.stale) {
    flashFindStatus('The text has changed since this was checked: try again in a moment.', 4000);
    runValidation(doc);
    return;
  }
  if (doc.content.slice(f.s, f.e) !== f.expect) {
    flashFindStatus('The fix no longer matches the text, so nothing was changed.', 4000);
    return;
  }
  applyEdit(doc, f.s, f.e, f.text);
  if (doc.id === activeId && layoutMode !== 'preview-only') {
    editor.focus();
    editor.setSelectionRange(f.s + f.text.length, f.s + f.text.length);
  }
  runValidation(doc);
}

function wireDiagnostics() {
  // The margin markers: in the old gutter (.ln-d in a row) or CodeMirror's problem margin (.np-d).
  const gutterEl = editor.isCodeMirror ? editor.host : lineNumbersEl;
  const MARKER = editor.isCodeMirror ? '.np-d' : '.ln-d';
  const markerLine = (m, e) => (editor.isCodeMirror ? editor.api.lineAtClientY(e.clientY) : Number(m.closest('.ln-row').dataset.l));
  const problemsOn = (doc, line) => {
    const c = lineIndex(doc);
    return visibleDiagnostics(doc).filter((d) => lineOf(c, Math.min(d.s, doc.content.length)) === line);
  };
  // A click on a marker explains it straight away (instead of selecting the line).
  gutterEl.addEventListener(
    'mousedown',
    (e) => {
      const m = e.target.closest(MARKER);
      if (!m || e.button !== 0) return;
      e.preventDefault();
      e.stopPropagation();
      const doc = getActive();
      showDiagnosticPopup(problemsOn(doc, markerLine(m, e)), m.getBoundingClientRect());
    },
    true
  );
  // Hover on a gutter marker.
  gutterEl.addEventListener('mouseover', (e) => {
    const m = e.target.closest(MARKER);
    if (!m) return;
    clearTimeout(diagHoverTimer);
    const list = problemsOn(getActive(), markerLine(m, e));
    diagHoverTimer = setTimeout(() => showDiagnosticPopup(list, m.getBoundingClientRect()), 250);
  });
  gutterEl.addEventListener('mouseout', (e) => {
    if (e.target.closest(MARKER)) {
      clearTimeout(diagHoverTimer);
      diagHoverTimer = setTimeout(() => {
        if (diagPop && !diagPop.matches(':hover')) hideDiagnosticPopup();
      }, 300);
    }
  });
  // Hover on an underline in the editor (the coloured layer itself doesn't take the mouse).
  editor.addEventListener('mousemove', (e) => {
    if (!settings.validateTooltips) return;
    if (editor.isCodeMirror) {
      // CodeMirror draws the text: the mouse is over the underline itself.
      const hit = e.target.closest && e.target.closest('.diag-error, .diag-warning, .diag-info');
      clearTimeout(diagHoverTimer);
      if (!hit) {
        if (diagPop && !diagPop.matches(':hover')) diagHoverTimer = setTimeout(hideDiagnosticPopup, 300);
        return;
      }
      const list = problemsOn(getActive(), editor.api.lineAtClientY(e.clientY));
      const r = hit.getBoundingClientRect();
      diagHoverTimer = setTimeout(() => showDiagnosticPopup(list, r), 400);
      return;
    }
    const spans = editorHighlight.querySelectorAll('.diag-error, .diag-warning, .diag-info');
    if (!spans.length) return;
    const hit = [...spans].find((s) => pointInRects(e.clientX, e.clientY, s.getClientRects()));
    clearTimeout(diagHoverTimer);
    if (!hit) {
      if (diagPop && !diagPop.matches(':hover')) diagHoverTimer = setTimeout(hideDiagnosticPopup, 300);
      return;
    }
    const doc = getActive();
    const ovl = hit.closest('.ovl');
    const line = Array.prototype.indexOf.call(editorHighlight.children, ovl);
    const c = lineIndex(doc);
    const list = visibleDiagnostics(doc).filter((d) => lineOf(c, Math.min(d.s, doc.content.length)) === line);
    const r = hit.getBoundingClientRect();
    diagHoverTimer = setTimeout(() => showDiagnosticPopup(list, r), 400);
  });
  editor.addEventListener('mouseleave', () => {
    clearTimeout(diagHoverTimer);
    diagHoverTimer = setTimeout(() => {
      if (diagPop && !diagPop.matches(':hover')) hideDiagnosticPopup();
    }, 300);
  });
  editor.addEventListener('keydown', (e) => {
    if (e.key === 'Escape' && diagPop) hideDiagnosticPopup();
  });
  editor.addEventListener('scroll', hideDiagnosticPopup);
  const st = document.getElementById('status-diag');
  if (st) st.addEventListener('click', () => gotoDiagnostic(1));
}
