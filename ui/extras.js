/* v1.0.5 additions: files changed by other programs (and Follow / tail), Recent Files, Reopen Closed
 * Tab, Save All, Print / Export as PDF / HTML, Go to Line, large files, the Outline panel, auto-closing
 * brackets and quotes, and Ctrl+B / Ctrl+I in the editor.
 * Loaded before renderer.js: renderer globals (editor, docs, settings, ...) are only used inside
 * functions, which run after everything has loaded. */

const LARGE_FILE_CHARS = 5 * 1024 * 1024; // above this a file opens in the lighter "large file" mode

/* ---------- files changed by other programs ---------- */

function setDiskStat(doc, st) {
  doc.disk = st && st.mtime != null ? { mtime: st.mtime, size: st.size } : null;
}

function sameStat(a, b) {
  return !!a && !!b && a.mtime === b.mtime && a.size === b.size;
}

let diskCheckBusy = false;

/** Compares every open file with the disk. Unchanged tabs reload quietly; tabs with unsaved edits ask. */
async function checkExternalChanges(onlyFollowed) {
  if (diskCheckBusy || !sessionReady) return;
  const list = docs.filter((d) => d.path && (!onlyFollowed || d.follow));
  if (!list.length) return;
  diskCheckBusy = true;
  try {
    let stats;
    try {
      stats = await invoke('cmd_file_stat', { paths: list.map((d) => d.path) });
    } catch (e) {
      return;
    }
    for (let i = 0; i < list.length; i++) {
      const doc = list[i];
      const st = stats[i];
      if (!docs.includes(doc) || !doc.path || doc.saving) continue; // our own save is in progress
      if (!st) {
        if (!doc.missing) {
          // Deleted or moved: keep the text, and treat it as unsaved so it is never lost.
          doc.missing = true;
          doc.conflict = null;
          doc.savedContent = null;
          markDirty(doc);
          renderTabs();
          updateDiskNotice();
        }
        continue;
      }
      if (doc.missing) {
        doc.missing = false;
        doc.disk = null; // came back: compare its content below
      }
      if (!doc.disk) {
        if (!doc.dirty || doc.savedContent === null) {
          await reloadFromDisk(doc, { quiet: true });
        } else setDiskStat(doc, st);
        updateDiskNotice();
        continue;
      }
      if (sameStat(doc.disk, st) || sameStat(doc.ignoredDisk, st)) continue;
      if (!doc.dirty) await reloadFromDisk(doc, { quiet: true });
      else {
        doc.conflict = st;
        updateDiskNotice();
      }
    }
  } finally {
    diskCheckBusy = false;
  }
}

/** Re-reads a tab's file. Keeps the caret and scroll position (or stays at the end of a followed file). */
async function reloadFromDisk(doc, opts = {}) {
  if (!doc || !doc.path) return false;
  let data;
  try {
    data = await invoke('cmd_read_file', { path: doc.path });
  } catch (err) {
    if (!opts.quiet) await dialogApi.message('Could not reload "' + tabTitle(doc) + '":\n' + err, { title: 'Reload from Disk', kind: 'error' });
    return false;
  }
  const { text, eol } = normalizeEol(data.content);
  doc.encoding = data.encoding;
  doc.eol = eol;
  setDiskStat(doc, data);
  doc.conflict = null;
  doc.missing = false;
  doc.ignoredDisk = null;
  const changed = text !== doc.content;
  doc.savedContent = text;
  if (doc.id === activeId) {
    const atEnd = editor.scrollTop + editor.clientHeight >= editor.scrollHeight - 30;
    const pAtEnd = preview.scrollTop + preview.clientHeight >= preview.scrollHeight - 30;
    const sel = [editor.selectionStart, editor.selectionEnd];
    const top = editor.scrollTop;
    const ptop = preview.scrollTop;
    if (changed) {
      doc.content = text;
      editor.value = text;
      renderPreviewIfVisible(doc);
    }
    markDirty(doc);
    if (changed) {
      renderEditorOverlay();
      updateLineNumbers();
      updateCharCount();
      const n = text.length;
      if (doc.follow) {
        editor.setSelectionRange(n, n);
        editor.scrollTop = editor.scrollHeight;
        preview.scrollTop = preview.scrollHeight;
      } else {
        editor.setSelectionRange(Math.min(sel[0], n), Math.min(sel[1], n));
        editor.scrollTop = atEnd && sel[0] >= n - 1 ? editor.scrollHeight : top;
        preview.scrollTop = pAtEnd ? preview.scrollHeight : ptop;
      }
      editorHighlight.scrollTop = editor.scrollTop;
      if (lineNumbersVisible) renderGutter();
    }
  } else {
    if (changed) {
      doc.content = text;
      if (doc.follow) doc.view = null;
    }
    markDirty(doc);
  }
  renderTabs();
  scheduleOutline();
  if (changed && !opts.silent && !doc.follow) flashFindStatus('Reloaded "' + tabTitle(doc) + '" (it was changed outside notepad.md)');
  updateDiskNotice();
  return true;
}

/** File > Reload from Disk: asks first when it would throw away unsaved edits. */
async function reloadActiveFromDisk() {
  const doc = getActive();
  if (!doc || !doc.path) {
    flashFindStatus('This tab has not been saved to a file yet.');
    return;
  }
  if (doc.dirty) {
    const ok = await dialogApi.ask('Discard your unsaved changes to "' + tabTitle(doc) + '" and reload it from disk?', {
      title: 'Reload from Disk',
      kind: 'warning',
      okLabel: 'Reload',
      cancelLabel: 'Cancel',
    });
    if (!ok) return;
  }
  await reloadFromDisk(doc, {});
}

/** The bar above the editor when the active tab's file changed or vanished while it had unsaved edits. */
function updateDiskNotice() {
  const bar = document.getElementById('disk-notice');
  if (!bar) return;
  const doc = getActive();
  const text = document.getElementById('disk-notice-text');
  const btns = document.getElementById('disk-notice-btns');
  if (!doc || (!doc.conflict && !doc.missing)) {
    bar.classList.add('hidden');
    return;
  }
  const name = '"' + tabTitle(doc) + '"';
  const make = (label, fn, primary) => {
    const b = document.createElement('button');
    b.textContent = label;
    if (primary) b.className = 'primary';
    b.addEventListener('click', fn);
    return b;
  };
  btns.innerHTML = '';
  if (doc.missing) {
    text.textContent = name + ' was deleted or moved outside notepad.md. Your text is still here; Save writes it back.';
    btns.append(
      make('Save', () => saveDocGeneric(doc), true),
      make('Close Tab', () => closeTab(doc.id)),
      make('Dismiss', () => {
        doc.missing = false;
        doc.disk = null;
        updateDiskNotice();
      })
    );
  } else {
    text.textContent = name + ' was changed outside notepad.md, and you have unsaved changes.';
    btns.append(
      make('Reload (lose my changes)', () => reloadFromDisk(doc, {})),
      make('Keep my version', () => {
        doc.ignoredDisk = doc.conflict;
        doc.conflict = null;
        updateDiskNotice();
      }, true)
    );
  }
  bar.classList.remove('hidden');
}

/** Before saving over a file: was it changed by something else since we read it? */
/**
 * Returns false when the user cancels, otherwise { expect }: the file's state as just checked,
 * which the save passes along so a change made in the moment before writing is still caught.
 */
async function confirmOverwriteIfChanged(doc, path) {
  if (!doc.path || !doc.disk || !samePath(doc.path, path)) return { expect: null };
  let st = null;
  try {
    [st] = await invoke('cmd_file_stat', { paths: [path] });
  } catch (e) {
    return { expect: null };
  }
  if (!st) return { expect: null };
  if (sameStat(st, doc.disk) || sameStat(st, doc.ignoredDisk)) return { expect: st };
  return (await askOverwriteChanged(doc)) ? { expect: null } : false;
}

function askOverwriteChanged(doc) {
  return dialogApi.ask('"' + tabTitle(doc) + '" was changed outside notepad.md after you opened it.\n\nOverwrite it with your version?', {
    title: 'File Changed on Disk',
    kind: 'warning',
    okLabel: 'Overwrite',
    cancelLabel: 'Cancel',
  });
}

/* ---------- Follow (tail) ---------- */

function toggleFollow() {
  const doc = getActive();
  if (!doc) return;
  if (!doc.path) {
    flashFindStatus('Follow needs a saved file (it watches the file on disk).');
    syncMenuChecks(true);
    return;
  }
  doc.follow = !doc.follow;
  if (doc.follow) {
    const n = editor.value.length;
    editor.setSelectionRange(n, n);
    editor.scrollTop = editor.scrollHeight;
    editorHighlight.scrollTop = editor.scrollTop;
    preview.scrollTop = preview.scrollHeight;
    checkExternalChanges(true);
  }
  updateFollowStatus();
  renderTabs();
  syncMenuChecks(true);
  scheduleSessionSave();
  flashFindStatus(doc.follow ? 'Following "' + tabTitle(doc) + '": new lines appear as the file grows.' : 'Stopped following.');
}

function updateFollowStatus() {
  const el = document.getElementById('status-follow');
  if (!el) return;
  const doc = getActive();
  el.classList.toggle('hidden', !(doc && doc.follow));
}

let diskTick = 0;
function startDiskWatch() {
  window.addEventListener('focus', () => checkExternalChanges(false));
  setInterval(() => {
    diskTick++;
    if (docs.some((d) => d.follow)) checkExternalChanges(true);
    if (diskTick % 2 === 0 && document.hasFocus()) checkExternalChanges(false);
  }, 1000);
}

/* ---------- Recent Files ---------- */

let recentFiles = [];

function setRecentFiles(list) {
  recentFiles = (Array.isArray(list) ? list : []).filter((p) => typeof p === 'string' && p).slice(0, 10);
  pushRecentMenu();
}

function addRecent(path) {
  if (!path) return;
  recentFiles = [path, ...recentFiles.filter((p) => !samePath(p, path))].slice(0, 10);
  pushRecentMenu();
  scheduleSessionSave();
}

function pushRecentMenu() {
  invoke('cmd_set_recent', { paths: recentFiles }).catch((e) => console.error('recent menu', e));
}

async function openRecent(i) {
  const path = recentFiles[i];
  if (!path) return;
  let st = null;
  try {
    [st] = await invoke('cmd_file_stat', { paths: [path] });
  } catch (e) {
    /* try to open anyway */
  }
  if (!st) {
    recentFiles = recentFiles.filter((p) => p !== path);
    pushRecentMenu();
    scheduleSessionSave();
    await dialogApi.message('"' + path + '" no longer exists, so it has been removed from Recent Files.', { title: 'Recent Files', kind: 'info' });
    return;
  }
  await openPath(path);
}

function clearRecent() {
  recentFiles = [];
  clearVisitedLinks(); // links opened before show as not visited again
  pushRecentMenu();
  scheduleSessionSave();
}

/* ---------- Reopen Closed Tab ---------- */

const closedTabs = [];

function rememberClosedTab(doc) {
  if (!doc || (!doc.path && !doc.content)) return; // nothing worth bringing back
  if (doc.id === activeId) saveDocView(doc);
  closedTabs.push({
    index: docs.indexOf(doc),
    path: doc.path,
    content: doc.content,
    dirty: doc.dirty,
    lang: doc.lang,
    langOverride: doc.langOverride,
    layoutMode: doc.layoutMode,
    fontSize: doc.fontSize,
    bookmarks: { ...(doc.bookmarks || {}) },
    encoding: doc.encoding,
    eol: doc.eol,
    customTitle: doc.customTitle,
    view: doc.view,
    follow: doc.follow,
  });
  if (closedTabs.length > 25) closedTabs.shift();
  if (doc.path) addRecent(doc.path);
}

async function reopenClosedTab() {
  let s;
  // Skip files that are already open again.
  while ((s = closedTabs.pop()) && s.path && docs.some((d) => d.path && samePath(d.path, s.path))) {
    /* keep looking */
  }
  if (!s) {
    flashFindStatus('No closed tabs to reopen.');
    return;
  }
  const opts = {
    lang: s.lang,
    langOverride: s.langOverride,
    layoutMode: s.layoutMode,
    fontSize: s.fontSize,
    bookmarks: s.bookmarks,
    encoding: s.encoding,
    eol: s.eol,
    customTitle: s.customTitle,
  };
  let doc;
  if (s.path) {
    let disk = null;
    try {
      disk = await invoke('cmd_read_file', { path: s.path });
    } catch (e) {
      /* gone: bring the text back as unsaved */
    }
    const fromDisk = disk ? normalizeEol(disk.content) : null;
    if (s.dirty || !fromDisk) doc = makeDoc(s.path, s.content, { ...opts, savedContent: fromDisk ? fromDisk.text : null });
    else doc = makeDoc(s.path, fromDisk.text, { ...opts, encoding: disk.encoding, eol: fromDisk.eol });
    if (disk) setDiskStat(doc, disk);
  } else {
    doc = makeDoc(null, s.content, opts);
  }
  doc.view = s.view;
  doc.follow = !!(s.follow && doc.path);
  saveDocView(getActive());
  // Replace a blank starter tab, otherwise put it back where it was.
  const active = getActive();
  if (active && !active.path && !active.dirty && active.content === '' && !active.pinned && docs.length === 1) docs = [];
  docs.splice(Math.max(0, Math.min(s.index, docs.length)), 0, doc);
  sortPinnedFirst();
  activeId = doc.id;
  renderTabs();
  loadActiveDocIntoPanes();
  scheduleFindRefresh(false);
  scheduleSessionSave();
  flashFindStatus('Reopened "' + tabTitle(doc) + '"');
}

/* ---------- Save All ---------- */

async function saveAll() {
  const dirty = docs.filter((d) => d.dirty);
  if (!dirty.length) {
    flashFindStatus('Nothing to save: every tab is saved.');
    return true;
  }
  let n = 0;
  for (const d of dirty) {
    if (!docs.includes(d)) continue;
    if (!d.path) setActiveTab(d.id); // show which tab the Save As dialog is for
    if (!(await saveDocGeneric(d))) {
      flashFindStatus('Save All stopped: "' + tabTitle(d) + '" was not saved.');
      return false;
    }
    n++;
  }
  flashFindStatus('Saved ' + n + ' file' + (n === 1 ? '' : 's') + '.');
  return true;
}

/* ---------- Go to Line ---------- */

function openGotoLine() {
  const doc = getActive();
  const dlg = document.getElementById('goto');
  if (!doc || !dlg) return;
  hideContextMenu();
  const c = lineIndex(doc);
  const input = document.getElementById('goto-input');
  document.getElementById('goto-label').textContent = 'Line number (1 – ' + fmtCount(c.lines.length) + ')';
  input.max = String(c.lines.length);
  input.value = String(lineOf(c, editor.selectionStart) + 1);
  document.getElementById('goto-msg').textContent = '';
  dlg.classList.remove('hidden');
  input.focus();
  input.select();
}

function closeGotoLine(refocus) {
  const dlg = document.getElementById('goto');
  if (!dlg || dlg.classList.contains('hidden')) return;
  dlg.classList.add('hidden');
  if (refocus) (layoutMode === 'preview-only' ? preview : editor).focus();
}

function goToLine(n) {
  const doc = getActive();
  if (!doc) return false;
  const c = lineIndex(doc);
  if (!Number.isFinite(n) || n < 1) return false;
  const line = Math.min(Math.floor(n), c.lines.length) - 1;
  const s = c.starts[line];
  findState.navLine = { docId: doc.id, line };
  revealRange(doc, s, s, true);
  scheduleOverlay();
  scheduleOutlineActive();
  flashFindStatus('Line ' + fmtCount(line + 1) + ' of ' + fmtCount(c.lines.length));
  return true;
}

function submitGotoLine() {
  const v = document.getElementById('goto-input').value.trim().replace(/^#/, '');
  const n = Number(v);
  if (!/^\d+$/.test(v) || n < 1) {
    document.getElementById('goto-msg').textContent = 'Type a line number, e.g. 120.';
    return;
  }
  closeGotoLine(false);
  goToLine(n);
}

/* ---------- Print / Export as PDF / Export as HTML ---------- */

// Light styles for printed / exported documents (also embedded in exported HTML files).
const EXPORT_CSS = `
.np-doc { font-family: "Segoe UI", Tahoma, Arial, sans-serif; font-size: 11pt; line-height: 1.55; color: #1f2328; background: #fff; overflow-wrap: break-word; }
body.np-doc { max-width: 880px; margin: 32px auto; padding: 0 24px; }
.np-doc h1, .np-doc h2, .np-doc h3, .np-doc h4, .np-doc h5, .np-doc h6 { margin: 1.2em 0 0.5em; line-height: 1.25; font-weight: 600; break-after: avoid; }
.np-doc h1 { font-size: 1.9em; border-bottom: 1px solid #d0d7de; padding-bottom: 0.25em; }
.np-doc h2 { font-size: 1.45em; border-bottom: 1px solid #d0d7de; padding-bottom: 0.2em; }
.np-doc h3 { font-size: 1.2em; } .np-doc h4 { font-size: 1.05em; } .np-doc h5, .np-doc h6 { font-size: 0.95em; }
.np-doc p, .np-doc ul, .np-doc ol, .np-doc blockquote, .np-doc table, .np-doc pre { margin: 0 0 0.9em; }
.np-doc a { color: #0969da; text-decoration: underline; }
.np-doc code { font-family: Consolas, "Cascadia Mono", monospace; font-size: 0.9em; background: #f3f4f6; border-radius: 4px; padding: 0.1em 0.35em; }
.np-doc pre { font-family: Consolas, "Cascadia Mono", monospace; font-size: 9.5pt; background: #f6f8fa; border: 1px solid #e1e4e8; border-radius: 6px; padding: 10px 12px; white-space: pre-wrap; word-break: break-word; }
.np-doc pre code { background: none; padding: 0; font-size: inherit; }
.np-doc blockquote { border-left: 4px solid #d0d7de; color: #57606a; padding: 0 1em; margin-left: 0; }
.np-doc table { border-collapse: collapse; }
.np-doc th, .np-doc td { border: 1px solid #d0d7de; padding: 5px 10px; }
.np-doc th { background: #f6f8fa; }
.np-doc tr { break-inside: avoid; }
.np-doc img { max-width: 100%; }
.np-doc hr { border: 0; border-top: 1px solid #d0d7de; margin: 1.4em 0; }
.np-doc li > input[type="checkbox"] { margin-right: 0.4em; }
.np-doc .hljs-comment, .np-doc .hljs-quote { color: #6e7781; font-style: italic; }
.np-doc .hljs-keyword, .np-doc .hljs-selector-tag, .np-doc .hljs-type, .np-doc .hljs-meta .hljs-keyword { color: #cf222e; }
.np-doc .hljs-string, .np-doc .hljs-regexp, .np-doc .hljs-addition { color: #0a3069; }
.np-doc .hljs-number, .np-doc .hljs-literal, .np-doc .hljs-variable, .np-doc .hljs-template-variable { color: #0550ae; }
.np-doc .hljs-title, .np-doc .hljs-section, .np-doc .hljs-name, .np-doc .hljs-selector-id, .np-doc .hljs-selector-class { color: #8250df; }
.np-doc .hljs-attr, .np-doc .hljs-attribute, .np-doc .hljs-built_in, .np-doc .hljs-symbol { color: #953800; }
.np-doc .hljs-tag, .np-doc .hljs-meta { color: #116329; }
.np-doc .hljs-deletion { color: #82071e; }
.np-doc .hljs-logerror { color: #c42b1c; } .np-doc .hljs-logwarn { color: #a35a00; } .np-doc .hljs-loginfo { color: #0a66cc; }
.np-doc .hljs-logdebug { color: #7a7a7a; } .np-doc .hljs-logok { color: #2b7a0b; } .np-doc .hljs-logtime { color: #6f42c1; } .np-doc .hljs-logpath { color: #116329; }
.np-doc .hljs-emphasis { font-style: italic; } .np-doc .hljs-strong { font-weight: bold; }
.np-doc .bb-spoiler, .np-doc details { border: 1px solid #d0d7de; border-radius: 6px; padding: 6px 10px; margin-bottom: 0.9em; }
`;

/** The document as HTML: rendered Markdown / BBCode, or coloured source for code files. */
function renderDocHtml(doc, forFile) {
  const render = langInfo(doc).render;
  const box = document.createElement('div');
  if (render === 'markdown') box.innerHTML = sanitizeHtml(marked_.parse(doc.content));
  else if (render === 'bbcode') box.innerHTML = sanitizeHtml(renderBBCode(doc.content));
  else if (render === 'plain') {
    // Plain Text: the text exactly as written (no Markdown).
    const pre = document.createElement('pre');
    pre.className = 'plain-text';
    pre.textContent = doc.content;
    box.appendChild(pre);
  } else box.innerHTML = '<pre><code class="hljs">' + highlightCode(doc.content, langInfo(doc).hljs) + '</code></pre>';
  if (render !== 'code' && window.hljs) {
    box.querySelectorAll('pre > code').forEach((code) => {
      const m = /language-([\w-]+)/.exec(code.className);
      if (!m) return;
      const key = EXT_LANG[m[1].toLowerCase()] ? LANGS[EXT_LANG[m[1].toLowerCase()]].hljs : m[1];
      if (!key || !hljs.getLanguage(key)) return;
      code.innerHTML = highlightCode(code.textContent, key);
      code.classList.add('hljs');
    });
  }
  box.querySelectorAll('.code-copy-btn').forEach((b) => b.remove());
  box.querySelectorAll('input[type="checkbox"]').forEach((c) => {
    c.setAttribute('disabled', '');
    if (c.checked) c.setAttribute('checked', '');
  });
  // Local pictures: the app serves them itself; an exported file keeps the path as written.
  for (const img of box.querySelectorAll('img')) {
    const src = img.getAttribute('src');
    const abs = resolveImagePath(src, doc);
    if (!abs) continue;
    if (forFile) {
      if (/^[a-z]:\//i.test(abs) && !/^(\.|[^:]+\/)/.test(src)) img.setAttribute('src', 'file:///' + abs);
    } else img.setAttribute('src', localImageUrl(abs));
  }
  return box.innerHTML;
}

function docBaseName(doc) {
  return tabTitle(doc).replace(/\.[A-Za-z0-9]{1,8}$/, '') || 'document';
}

function exportDefaultPath(doc, ext) {
  const name = docBaseName(doc) + '.' + ext;
  return doc.path ? dirOf(doc.path).replace(/\//g, '\\') + '\\' + name : name;
}

function preparePrintRoot(doc) {
  let root = document.getElementById('print-root');
  if (!root) {
    root = document.createElement('div');
    root.id = 'print-root';
    root.className = 'np-doc';
    document.body.appendChild(root);
  }
  root.innerHTML = renderDocHtml(doc, false);
  document.body.classList.add('printing');
  return root;
}

function clearPrintRoot() {
  document.body.classList.remove('printing');
  const root = document.getElementById('print-root');
  if (root) root.innerHTML = '';
}

async function imagesLoaded(root, ms = 3000) {
  const imgs = [...root.querySelectorAll('img')].filter((i) => !i.complete);
  if (!imgs.length) return;
  await Promise.race([
    Promise.all(
      imgs.map(
        (i) =>
          new Promise((r) => {
            i.addEventListener('load', r, { once: true });
            i.addEventListener('error', r, { once: true });
          })
      )
    ),
    new Promise((r) => setTimeout(r, ms)),
  ]);
}

async function printActive() {
  const doc = getActive();
  if (!doc) return;
  hideContextMenu();
  await imagesLoaded(preparePrintRoot(doc));
  try {
    window.print();
  } finally {
    // window.print() returns once the print dialog is closed (afterprint also clears it).
    setTimeout(clearPrintRoot, 500);
  }
}

async function exportPdf() {
  const doc = getActive();
  if (!doc) return;
  const path = await invoke('cmd_save_dialog', { filters: [{ name: 'PDF document', extensions: ['pdf'] }], defaultPath: exportDefaultPath(doc, 'pdf') });
  if (!path) return;
  await imagesLoaded(preparePrintRoot(doc));
  try {
    await invoke('cmd_print_to_pdf', { path });
    flashFindStatus('Exported "' + basename(path) + '"');
  } catch (err) {
    await dialogApi.message('Could not export the PDF:\n' + err, { title: 'Export as PDF', kind: 'error' });
  } finally {
    clearPrintRoot();
  }
}

const EXPORT_CSP = "default-src 'none'; script-src 'none'; object-src 'none'; frame-src 'none'; base-uri 'none'; form-action 'none'; style-src 'unsafe-inline'; img-src http: https: data: file:; font-src data:";

function buildExportHtml(doc) {
  return (
    '<!DOCTYPE html>\n<html lang="en">\n<head>\n<meta charset="UTF-8" />\n' +
    // Opened in a browser, the page has none of the app's protection: no scripts at all, ever.
    '<meta http-equiv="Content-Security-Policy" content="' + EXPORT_CSP + '" />\n' +
    '<meta name="viewport" content="width=device-width, initial-scale=1" />\n<title>' +
    escapeHtml(docBaseName(doc)) +
    '</title>\n<style>' +
    EXPORT_CSS +
    '</style>\n</head>\n<body class="np-doc">\n' +
    renderDocHtml(doc, true) +
    '\n</body>\n</html>\n'
  );
}

async function exportHtml() {
  const doc = getActive();
  if (!doc) return;
  const path = await invoke('cmd_save_dialog', { filters: [{ name: 'Web page', extensions: ['html', 'htm'] }], defaultPath: exportDefaultPath(doc, 'html') });
  if (!path) return;
  try {
    await invoke('cmd_write_file', { path, content: buildExportHtml(doc), encoding: 'utf8' });
    flashFindStatus('Exported "' + basename(path) + '"');
  } catch (err) {
    await dialogApi.message('Could not export the HTML file:\n' + err, { title: 'Export as HTML', kind: 'error' });
  }
}

/* ---------- Outline (headings of a Markdown document) ---------- */

function stripInlineMd(s) {
  return s
    .replace(/!?\[([^\]]*)\]\([^)]*\)/g, '$1')
    .replace(/(\*\*|__|\*|_|~~|`)/g, '')
    .replace(/<[^>]+>/g, '')
    .trim();
}

/** ATX (# Title) and Setext (Title / ===) headings, ignoring fenced code blocks. */
function headingsOf(text) {
  const out = [];
  const lines = text.split('\n');
  let fence = null;
  for (let i = 0; i < lines.length && out.length < 2000; i++) {
    const l = lines[i];
    const f = /^\s{0,3}(`{3,}|~{3,})/.exec(l);
    if (f) {
      if (!fence) fence = f[1];
      else if (f[1][0] === fence[0] && f[1].length >= fence.length) fence = null;
      continue;
    }
    if (fence) continue;
    const m = /^\s{0,3}(#{1,6})\s+(.*?)(?:\s+#+)?\s*$/.exec(l);
    if (m) {
      if (m[2]) out.push({ level: m[1].length, text: stripInlineMd(m[2]), line: i });
      continue;
    }
    const prev = i > 0 ? lines[i - 1] : '';
    if (/^\s{0,3}(=+|-+)\s*$/.test(l) && prev.trim() && !/^\s{0,3}(#|[-*+]\s|>|\d+[.)]\s|```|~~~|\|)/.test(prev)) {
      // "Text" followed by === or --- (a --- after a blank line is a rule, not a heading)
      out.push({ level: l.trim()[0] === '=' ? 1 : 2, text: stripInlineMd(prev), line: i - 1 });
    }
  }
  return out;
}

let outlineTimer = 0;
let outlineHeadings = [];

function scheduleOutline() {
  if (!settings.outline) return;
  clearTimeout(outlineTimer);
  outlineTimer = setTimeout(renderOutline, 250);
}

function renderOutline() {
  const list = document.getElementById('outline-list');
  if (!list || !settings.outline) return;
  const doc = getActive();
  list.innerHTML = '';
  if (!doc || langInfo(doc).render !== 'markdown') {
    outlineHeadings = [];
    list.innerHTML = '<div class="outline-empty">Headings are listed here for Markdown documents.</div>';
    return;
  }
  outlineHeadings = headingsOf(doc.content);
  if (!outlineHeadings.length) {
    list.innerHTML = '<div class="outline-empty">No headings yet. Start a line with # for a heading.</div>';
    return;
  }
  const frag = document.createDocumentFragment();
  outlineHeadings.forEach((h, i) => {
    const b = document.createElement('button');
    b.className = 'outline-item lvl-' + h.level;
    b.textContent = h.text || '(untitled)';
    b.title = h.text + '  (line ' + (h.line + 1) + ')';
    b.dataset.i = String(i);
    frag.appendChild(b);
  });
  list.appendChild(frag);
  updateOutlineActive();
}

/** Jumps to a heading: the line in the editor, and the heading itself in the preview. */
function gotoHeading(i) {
  const doc = getActive();
  const h = outlineHeadings[i];
  if (!doc || !h) return;
  const c = lineIndex(doc);
  const s = c.starts[Math.min(h.line, c.starts.length - 1)];
  if (layoutMode !== 'preview-only') {
    editor.focus();
    editor.setSelectionRange(s, s);
    // Put the heading near the top of the editor.
    let y;
    if (editor.isCodeMirror) y = editor.api.yForOffset(s);
    else y = h.line * (parseFloat(getComputedStyle(editor).lineHeight) || 21);
    if (!editor.isCodeMirror && !editorHighlight.classList.contains('hidden')) {
      const r = rangeAtTextOffset(editorHighlight, s);
      const rect = r && (r.getClientRects()[0] || r.getBoundingClientRect());
      if (rect) y = rect.top - editorHighlight.getBoundingClientRect().top + editorHighlight.scrollTop;
    }
    editor.scrollTop = Math.max(0, y - 8);
    editorHighlight.scrollTop = editor.scrollTop;
    if (lineNumbersVisible) renderGutter();
  }
  if (previewVisible()) {
    const el = preview.querySelectorAll('h1, h2, h3, h4, h5, h6')[i];
    if (el) preview.scrollTop += el.getBoundingClientRect().top - preview.getBoundingClientRect().top - 8;
    if (layoutMode === 'preview-only' && el) {
      const sel = window.getSelection();
      const r = document.createRange();
      r.selectNodeContents(el);
      r.collapse(true);
      sel.removeAllRanges();
      sel.addRange(r);
    }
  }
  setOutlineActive(i);
  outlineHoldUntil = Date.now() + 500;
}

function setOutlineActive(i) {
  const list = document.getElementById('outline-list');
  if (!list) return;
  list.querySelectorAll('.outline-item.active').forEach((b) => b.classList.remove('active'));
  const b = list.querySelector('.outline-item[data-i="' + i + '"]');
  if (b) {
    b.classList.add('active');
    const top = b.offsetTop - list.offsetTop;
    if (top < list.scrollTop || top > list.scrollTop + list.clientHeight - 24) list.scrollTop = Math.max(0, top - 40);
  }
}

let outlineActiveTimer = 0;
function scheduleOutlineActive() {
  if (!settings.outline) return;
  clearTimeout(outlineActiveTimer);
  outlineActiveTimer = setTimeout(updateOutlineActive, 120);
}

let outlineHoldUntil = 0; // right after a click, keep the clicked heading highlighted

/** Highlights the heading the caret (or, in Preview Only, the top of the preview) is under. */
function updateOutlineActive() {
  if (!settings.outline || !outlineHeadings.length || Date.now() < outlineHoldUntil) return;
  let idx = -1;
  if (layoutMode === 'preview-only') {
    const box = preview.getBoundingClientRect();
    // Scrolled to the very end: the last heading on screen counts (it can't reach the top).
    const atEnd = preview.scrollTop + preview.clientHeight >= preview.scrollHeight - 2;
    const line = atEnd ? box.bottom - 20 : box.top + 30;
    preview.querySelectorAll('h1, h2, h3, h4, h5, h6').forEach((el, i) => {
      if (el.getBoundingClientRect().top <= line) idx = i;
    });
  } else {
    const doc = getActive();
    if (!doc) return;
    const line = lineOf(lineIndex(doc), editor.selectionStart);
    outlineHeadings.forEach((h, i) => {
      if (h.line <= line) idx = i;
    });
  }
  setOutlineActive(idx);
}

function applyOutlineVisibility() {
  const el = document.getElementById('outline');
  if (!el) return;
  el.classList.toggle('hidden', !settings.outline);
  if (settings.outline) renderOutline();
}

function toggleOutline() {
  if (!debounceAction('toggle-outline')) return;
  changeSetting('outline', !settings.outline);
}

/* ---------- auto-closing brackets and quotes (editor) ---------- */

const PAIRS = { '(': ')', '[': ']', '{': '}', '"': '"', "'": "'", '`': '`' };
const CLOSE_CHARS = new Set([')', ']', '}', '"', "'", '`']);
// Closers we typed for the user, stored as distance from the end of the text (stays right while
// typing in front of them).
let autoClosers = [];

function autoCloserAt(pos, ch) {
  const len = editor.value.length;
  return autoClosers.findIndex((a) => len - a.fromEnd === pos && a.ch === ch && editor.value[pos] === ch);
}

function insertPair(s, e, open, close) {
  const sel = editor.value.slice(s, e);
  replaceEditorRange(s, e, open + sel + close);
  if (sel) editor.setSelectionRange(s + open.length, s + open.length + sel.length);
  else {
    editor.setSelectionRange(s + open.length, s + open.length);
    autoClosers.push({ fromEnd: editor.value.length - (s + open.length), ch: close });
    if (autoClosers.length > 50) autoClosers.shift();
  }
}

/** Returns true when it handled the key. */
function handleAutoPairKey(e) {
  if (!settings.autoPair || e.ctrlKey || e.altKey || e.metaKey || e.isComposing) return false;
  const v = editor.value;
  const s = editor.selectionStart;
  const end = editor.selectionEnd;
  const k = e.key;
  if (k === 'Backspace') {
    if (s !== end || s === 0) return false;
    const open = v[s - 1];
    if (!PAIRS[open] || v[s] !== PAIRS[open]) return false;
    const i = autoCloserAt(s, PAIRS[open]);
    if (i === -1) return false;
    autoClosers.splice(i, 1);
    replaceEditorRange(s - 1, s + 1, '');
    return true;
  }
  if (k.length !== 1) return false;
  // Typing a closer we added: just step over it.
  if (CLOSE_CHARS.has(k) && s === end) {
    const i = autoCloserAt(s, k);
    if (i !== -1) {
      autoClosers.splice(i, 1);
      editor.setSelectionRange(s + 1, s + 1);
      return true;
    }
  }
  const prose = langInfo(getActive()).render !== 'code';
  if (s !== end) {
    // Wrap the selection: (), [], {}, quotes; and *, _, ~ in Markdown.
    if (PAIRS[k]) {
      insertPair(s, end, k, PAIRS[k]);
      return true;
    }
    if (prose && langInfo(getActive()).render === 'markdown' && (k === '*' || k === '_' || k === '~')) {
      insertPair(s, end, k, k);
      return true;
    }
    return false;
  }
  if (!PAIRS[k]) return false;
  const prev = s > 0 ? v[s - 1] : '';
  const next = v[s] || '';
  const word = /[\p{L}\p{N}_]/u;
  if (k === '"' || k === "'" || k === '`') {
    // An apostrophe (don't) or a quote right after/before a word is not an opening quote.
    if (word.test(prev) || word.test(next) || prev === k) return false;
    if (next && !/[\s)\]},.;:!?]/.test(next)) return false;
  } else if (next && !/[\s)\]},.;:!?"'`]/.test(next)) return false;
  insertPair(s, s, k, PAIRS[k]);
  return true;
}

/* ---------- Ctrl+B / Ctrl+I ---------- */

/** Bold / italic: Markdown ** and _, BBCode [b] and [i]; pressing it again removes them. */
function toggleInlineFormat(kind) {
  const doc = getActive();
  if (!doc) return false;
  const render = langInfo(doc).render;
  if (lastFocused === 'preview' && layoutMode !== 'edit-only' && isEditablePreview(doc) && document.activeElement === preview) {
    previewExec(kind);
    return true;
  }
  if (layoutMode === 'preview-only') return false;
  let open;
  let close;
  if (render === 'bbcode') {
    open = kind === 'bold' ? '[b]' : '[i]';
    close = kind === 'bold' ? '[/b]' : '[/i]';
  } else if (render === 'markdown') {
    open = close = kind === 'bold' ? '**' : '_';
  } else return false;
  const v = editor.value;
  const s = editor.selectionStart;
  const e = editor.selectionEnd;
  const sel = v.slice(s, e);
  if (v.slice(s - open.length, s) === open && v.slice(e, e + close.length) === close) {
    replaceEditorRange(s - open.length, e + close.length, sel);
    editor.setSelectionRange(s - open.length, e - open.length);
  } else if (sel.length >= open.length + close.length && sel.startsWith(open) && sel.endsWith(close)) {
    const inner = sel.slice(open.length, sel.length - close.length);
    replaceEditorRange(s, e, inner);
    editor.setSelectionRange(s, s + inner.length);
  } else {
    replaceEditorRange(s, e, open + sel + close);
    editor.setSelectionRange(s + open.length, s + open.length + sel.length);
  }
  return true;
}

/* ---------- colouring big files in the editor ---------- */

// Above HIGHLIGHT_MAX_CHARS the editor can't recolour on every keystroke (a 3 MB log takes ~1.5 s).
// Instead it shows plain text while you type and colours the whole file once you pause, in a
// background worker. The result is kept per tab, so switching back is instant. Find hits and
// bookmarks are drawn on top (only lines that change are redrawn).
const LAZY_HIGHLIGHT_MAX = 4 * 1024 * 1024; // drawing more takes the browser several seconds
const LAZY_DELAY = 500;
let lazyTimer = 0;
let lazyReq = 0;
let lazyShown = null; // { docId, text, lang } currently drawn in the overlay

function hideOverlay() {
  editor.classList.remove('hl-active');
  editorHighlight.classList.add('hidden');
  editorHighlight.innerHTML = '';
  resetOverlayLines();
  lazyShown = null;
}

function showLargeOverlay(doc, text, lang, html) {
  editorHighlight.innerHTML = html + (text.endsWith('\n') ? ' ' : '');
  resetOverlayLines();
  editorHighlight.classList.remove('hidden');
  editor.classList.add('hl-active');
  editorHighlight.scrollTop = editor.scrollTop;
  editorHighlight.scrollLeft = editor.scrollLeft;
  lazyShown = { docId: doc.id, text, lang };
}

/** renderEditorOverlay() for text over HIGHLIGHT_MAX_CHARS. */
function renderLargeOverlay(doc, text, info) {
  // Find hits and bookmarks are drawn too (on the colours if this text is already coloured,
  // otherwise on plain text). Only changed lines are redrawn, so this stays quick.
  const decos = doc && text === doc.content && text.length <= LAZY_HIGHLIGHT_MAX ? editorDecorations(doc) : [];
  if (decos.length || (doc && overlayNeedsLines() && text.length <= LAZY_HIGHLIGHT_MAX)) {
    clearTimeout(lazyTimer);
    if (lazyShown) {
      editorHighlight.replaceChildren();
      resetOverlayLines();
      lazyShown = null;
    }
    editor.classList.add('hl-active');
    editorHighlight.classList.remove('hidden');
    const { lines, exact } = largeOverlayLines(doc, text, info);
    patchOverlayLines(doc, text, lines, decos, [], false, false);
    editorHighlight.scrollTop = editor.scrollTop;
    editorHighlight.scrollLeft = editor.scrollLeft;
    if (!exact && info.hljs) lazyTimer = setTimeout(() => colourLargeDoc(doc), LAZY_DELAY);
    return;
  }
  if (!doc || !info.hljs || text.length > LAZY_HIGHLIGHT_MAX) {
    clearTimeout(lazyTimer);
    if (editor.classList.contains('hl-active') || lazyShown) hideOverlay();
    return;
  }
  if (lazyShown && lazyShown.docId === doc.id && lazyShown.lang === info.hljs && lazyShown.text === text) return; // already coloured
  const cached = doc.hlCache;
  if (cached && cached.lang === info.hljs && cached.text === text) {
    // Already coloured before (e.g. switching back to this tab): let the tab appear first.
    if (editor.classList.contains('hl-active') || lazyShown) hideOverlay();
    clearTimeout(lazyTimer);
    lazyTimer = setTimeout(() => {
      if (doc.id === activeId && editor.value === text && langInfo(doc).hljs === info.hljs) showLargeOverlay(doc, text, info.hljs, cached.html);
    }, 150);
    return;
  }
  if (editor.classList.contains('hl-active') || lazyShown) hideOverlay(); // plain text while typing
  clearTimeout(lazyTimer);
  lazyTimer = setTimeout(() => colourLargeDoc(doc), LAZY_DELAY);
}

/**
 * Lines of the big file's layer: the background colouring where the text still matches it, and
 * plain text for lines edited since (they're recoloured after a pause). `exact` = fully coloured.
 */
function largeOverlayLines(doc, text, info) {
  const c = doc.hlCache;
  if (!info.hljs || !c || c.lang !== info.hljs) return { lines: splitHtmlLines(escapeHtml(text)), exact: false };
  if (!c.lines) c.lines = splitHtmlLines(c.html);
  if (c.text === text) return { lines: c.lines, exact: true };
  if (!c.textLines) c.textLines = c.text.split('\n');
  const oldT = c.textLines;
  const newT = text.split('\n');
  const max = Math.min(oldT.length, newT.length);
  let p = 0;
  while (p < max && oldT[p] === newT[p]) p++;
  let s = 0;
  while (s < max - p && oldT[oldT.length - 1 - s] === newT[newT.length - 1 - s]) s++;
  const mid = newT.slice(p, newT.length - s).map(escapeHtml);
  return { lines: c.lines.slice(0, p).concat(mid, c.lines.slice(c.lines.length - s)), exact: false };
}

async function colourLargeDoc(doc) {
  if (!docs.includes(doc) || doc.id !== activeId) return;
  const text = editor.value;
  const info = langInfo(doc);
  if (text.length <= HIGHLIGHT_MAX_CHARS || text.length > LAZY_HIGHLIGHT_MAX || !info.hljs) return;
  const id = ++lazyReq;
  let html = null;
  try {
    html = await highlightInWorker(text, info.hljs);
  } catch (e) {
    html = null;
  }
  if (id !== lazyReq || doc.id !== activeId || editor.value !== text || langInfo(doc).hljs !== info.hljs) return; // changed meanwhile
  if (html === null) html = highlightCode(text, info.hljs); // a language only the page knows (BBCode)
  if (/(^|\n)[ \t]/.test(text)) html = addIndentGuides(html);
  doc.hlCache = { text, lang: info.hljs, html };
  if (editorDecorations(doc).length || overlayNeedsLines()) renderEditorOverlay(); // keep find hits / bookmarks / line blocks
  else showLargeOverlay(doc, text, info.hljs, html);
}

let hlWorker = null;
let hlSeq = 0;
const hlWaiters = new Map();

function highlightInWorker(text, lang, asSpans) {
  if (!hlWorker) {
    hlWorker = new Worker('highlight-worker.js');
    hlWorker.onmessage = (e) => {
      const w = hlWaiters.get(e.data.id);
      if (w) {
        hlWaiters.delete(e.data.id);
        w.resolve('spans' in e.data ? e.data.spans : e.data.html);
      }
    };
    hlWorker.onerror = (err) => {
      for (const w of hlWaiters.values()) w.reject(err);
      hlWaiters.clear();
      hlWorker = null;
    };
  }
  const id = ++hlSeq;
  return new Promise((resolve, reject) => {
    hlWaiters.set(id, { resolve, reject });
    hlWorker.postMessage({ id, text, lang, spans: !!asSpans });
  });
}

/**
 * Coloured ranges of `text` for the CodeMirror editor (see hl-spans.js), or null when there is
 * nothing to colour. Worked out in the worker; a language only the page knows (BBCode) is
 * coloured here, for files small enough not to hold up typing.
 */
/** The same, worked out right now on the main thread (small files); undefined if it can't be. */
function npHighlightSpansNow(text, lang) {
  if (!lang) return null;
  try {
    return hlHtmlToSpans(highlightCode(text, lang));
  } catch (e) {
    return undefined;
  }
}

async function npHighlightSpans(text, lang) {
  if (!lang) return null;
  let spans = null;
  try {
    spans = await highlightInWorker(text, lang, true);
  } catch (e) {
    spans = null;
  }
  if (spans === null && text.length <= HIGHLIGHT_MAX_CHARS) {
    try {
      spans = hlHtmlToSpans(highlightCode(text, lang));
    } catch (e) {
      spans = null;
    }
  }
  return spans;
}

/* ---------- wiring ---------- */

function initExtras() {
  startDiskWatch();
  editor.addEventListener('keydown', (e) => {
    if (handleAutoPairKey(e)) e.preventDefault();
  });
  editor.addEventListener('mousedown', () => (autoClosers = []));
  ['keyup', 'click'].forEach((t) => editor.addEventListener(t, scheduleOutlineActive));
  preview.addEventListener('scroll', () => {
    if (layoutMode === 'preview-only') scheduleOutlineActive();
  });
  const list = document.getElementById('outline-list');
  list.addEventListener('mousedown', (e) => {
    if (e.target.closest('.outline-item')) e.preventDefault();
  });
  list.addEventListener('click', (e) => {
    const b = e.target.closest('.outline-item');
    if (b) gotoHeading(Number(b.dataset.i));
  });
  document.getElementById('outline-close').addEventListener('click', () => changeSetting('outline', false));
  const goto = document.getElementById('goto');
  document.getElementById('goto-go').addEventListener('click', submitGotoLine);
  document.getElementById('goto-cancel').addEventListener('click', () => closeGotoLine(true));
  goto.addEventListener('mousedown', (e) => {
    if (e.target === goto) closeGotoLine(true);
  });
  document.getElementById('goto-input').addEventListener('keydown', (e) => {
    if (e.key === 'Enter') {
      e.preventDefault();
      submitGotoLine();
    } else if (e.key === 'Escape') {
      e.preventDefault();
      e.stopPropagation();
      closeGotoLine(true);
    }
    e.stopPropagation();
  });
  document.getElementById('status-follow').addEventListener('click', toggleFollow);
  window.addEventListener('afterprint', () => setTimeout(clearPrintRoot, 100));
  const style = document.createElement('style');
  style.textContent = EXPORT_CSS;
  document.head.appendChild(style);
}
