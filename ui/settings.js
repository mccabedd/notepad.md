/* Settings dialog and the view toggles it controls (word wrap, sidebar, menu bar, status bar, fonts,
 * colours, defaults for new tabs). Loaded before renderer.js; only touches renderer globals inside
 * functions. Settings are saved in session.json (ui.settings) like every other remembered state. */

const settingsEl = document.getElementById('settings');
const statusbarEl = document.querySelector('.statusbar');

const DEFAULT_SETTINGS = {
  restoreSession: true,
  menuBar: true,
  sidebar: true,
  statusBar: true,
  wordWrap: true,
  tabSize: 4,
  tabFontSize: 12.5, // tab header text, px
  outline: false, // the headings panel at the left
  autoPair: true, // auto-close brackets and quotes in the editor
  windowsAccent: true, // follow the Windows accent colour (links, selected items, buttons)
  newTabView: 'preview-only', // or 'same' = same view as the tab you are on
  newTabFormat: 'markdown', // new tabs are Markdown or Plain Text ('plaintext')
  syncScroll: true, // split view: the editor and preview follow each other
  newTabFontSize: 14, // the size that counts as 100% when a tab is zoomed (no longer shown in Settings)
  editFontSize: 14, // editor text size at 100%, px
  previewFontSize: 14, // preview text size at 100%, px
  editFont: 'Consolas',
  editStyle: 'normal',
  editColor: '', // '' = follow the theme
  editBg: '',
  caretStyle: 'line', // the text cursor: 'line', 'block' or 'underscore'
  caretColor: '', // '' = follow the theme
  selectionColor: '', // '' = follow the theme (shown see-through, so the text stays readable)
  translateTo: 'en', // right-click > Translate > "Translate to ..." (Google language code)
  previewFont: 'Segoe UI',
  previewStyle: 'normal',
  previewColor: '',
  previewBg: '',
  showHidden: false, // View > Show Hidden Characters (spaces, tabs, line endings, invisible characters)
  spellLogs: false, // spell-check log files too (Settings > Spelling); off: logs are mostly program output
  bookmarkColour: 'Green', // colour a click in the bookmark margin (and Ctrl+F2) gives a line
  settingsTab: 'general', // the Settings page shown last
  validateEnabled: true, // syntax checks for JSON, YAML, TOML, XML...
  validateAuto: true, // while editing (otherwise Search > Check Syntax Now)
  validateDelay: 600, // ms after the last key
  validateLarge: false, // also 1-5 MB files automatically
  validateMarkers: true,
  validateWarnings: true,
  validateTooltips: true,
  validateFixes: true,
};

let settings = { ...DEFAULT_SETTINGS };
let appliedMenuBar = null;
let menuPeek = false; // the menu bar is switched off but shown for now (Alt), until a command is picked

const FONT_STYLES = {
  normal: ['400', 'normal'],
  bold: ['700', 'normal'],
  italic: ['400', 'italic'],
  'bold-italic': ['700', 'italic'],
};

function loadSettings(saved) {
  settings = { ...DEFAULT_SETTINGS };
  if (saved && typeof saved === 'object') {
    for (const k of Object.keys(DEFAULT_SETTINGS)) {
      if (saved[k] !== undefined && typeof saved[k] === typeof DEFAULT_SETTINGS[k]) settings[k] = saved[k];
    }
  }
  settings.newTabFontSize = Math.min(MAX_FONT_SIZE, Math.max(MIN_FONT_SIZE, Math.round(settings.newTabFontSize)));
  // Before v1.0.9 one 'font size for new tabs' set both: carry a custom value over to the two new settings.
  if (saved && typeof saved === 'object' && saved.editFontSize === undefined && typeof saved.newTabFontSize === 'number') {
    settings.editFontSize = settings.newTabFontSize;
    settings.previewFontSize = settings.newTabFontSize;
  }
  settings.editFontSize = Math.min(MAX_FONT_SIZE, Math.max(MIN_FONT_SIZE, Math.round(settings.editFontSize)));
  settings.previewFontSize = Math.min(MAX_FONT_SIZE, Math.max(MIN_FONT_SIZE, Math.round(settings.previewFontSize)));
  if (![2, 4, 8].includes(settings.tabSize)) settings.tabSize = 4;
  if (!['Green', 'Orange', 'Red'].includes(settings.bookmarkColour)) settings.bookmarkColour = 'Green';
  if (!['line', 'block', 'underscore'].includes(settings.caretStyle)) settings.caretStyle = 'line';
  if (!/^[a-zA-Z]{2,3}(-[A-Za-z]{2,4})?$/.test(settings.translateTo)) settings.translateTo = 'en';
  if (!['markdown', 'plaintext'].includes(settings.newTabFormat)) settings.newTabFormat = 'markdown';
  if (!['general', 'filetypes', 'validation'].includes(settings.settingsTab)) settings.settingsTab = 'general';
  settings.validateDelay = Math.min(5000, Math.max(200, Math.round(settings.validateDelay)));
  settings.tabFontSize = clampTabFont(settings.tabFontSize);
}

function clampTabFont(v) {
  return Number.isFinite(v) ? Math.min(20, Math.max(9, Math.round(v * 2) / 2)) : 12.5;
}

function fontStack(name, mono) {
  const clean = String(name || '').replace(/["';{}<>\\]/g, '').trim();
  const fallback = mono ? 'Consolas, "Cascadia Code", Menlo, monospace' : '"Segoe UI", Tahoma, Arial, sans-serif';
  return clean ? '"' + clean + '", ' + fallback : fallback;
}

function setVar(name, value) {
  const s = document.documentElement.style;
  if (value) s.setProperty(name, value);
  else s.removeProperty(name);
}

const COLOR_RE = /^#[0-9a-f]{6}$/i;

/** Applies every setting to the page (cheap; safe to call after any change). */
/* Windows accent colour: read from Windows (again whenever the window gets focus, in case it was
 * changed in Settings > Personalisation) and used for links, selected items and buttons. */
let systemAccent = null;
let accentRequested = false;

async function loadSystemAccent() {
  try {
    systemAccent = await invoke('cmd_system_accent');
  } catch (e) {
    systemAccent = null;
  }
  applyAccent();
}

function applyAccent() {
  const on = !!(settings.windowsAccent && systemAccent && COLOR_RE.test(systemAccent.light) && COLOR_RE.test(systemAccent.dark));
  setVar('--win-accent-light', on ? systemAccent.light : '');
  setVar('--win-accent-dark', on ? systemAccent.dark : '');
  document.documentElement.classList.toggle('win-accent', on);
}

function applySettings() {
  if (typeof syncMenuChecks === "function") syncMenuChecks();
  try { stashRenderGen++; } catch (e) { /* page still starting */ }
  if (!accentRequested) {
    accentRequested = true;
    loadSystemAccent();
    window.addEventListener('focus', loadSystemAccent);
  }
  applyAccent();
  try { applyFontSize(); } catch (e) { /* page still starting */ }
  const [ew, es] = FONT_STYLES[settings.editStyle] || FONT_STYLES.normal;
  const [pw, ps] = FONT_STYLES[settings.previewStyle] || FONT_STYLES.normal;
  setVar('--edit-font-family', fontStack(settings.editFont, true));
  setVar('--edit-font-weight', ew);
  setVar('--edit-font-style', es);
  setVar('--edit-fg', COLOR_RE.test(settings.editColor) ? settings.editColor : '');
  setVar('--edit-bg', COLOR_RE.test(settings.editBg) ? settings.editBg : '');
  setVar('--preview-font-family', fontStack(settings.previewFont, false));
  setVar('--preview-font-weight', pw);
  setVar('--preview-font-style', ps);
  setVar('--preview-fg', COLOR_RE.test(settings.previewColor) ? settings.previewColor : '');
  setVar('--preview-bg', COLOR_RE.test(settings.previewBg) ? settings.previewBg : '');
  setVar('--tab-size', String(settings.tabSize));
  setVar('--tab-font-size', settings.tabFontSize + 'px');
  // The text cursor and the selection (editor and preview). Set on the page itself, so they win
  // over the light/dark theme and the Windows accent colour.
  setVar('--caret', COLOR_RE.test(settings.caretColor) ? settings.caretColor : '');
  setVar('--selection', COLOR_RE.test(settings.selectionColor) ? 'color-mix(in srgb, ' + settings.selectionColor + ' 35%, transparent)' : '');
  for (const s of ['block', 'underscore']) document.body.classList.toggle('caret-' + s, settings.caretStyle === s);

  document.body.classList.toggle('nowrap', !settings.wordWrap);
  editor.setAttribute('wrap', settings.wordWrap ? 'soft' : 'off');
  if (editor.isCodeMirror && editor.api) editor.api.setTabSize();
  sidebarEl.classList.toggle('hidden', !settings.sidebar);
  statusbarEl.classList.toggle('hidden', !settings.statusBar);
  if (typeof applyOutlineVisibility === 'function') applyOutlineVisibility();
  if (appliedMenuBar !== settings.menuBar) {
    appliedMenuBar = settings.menuBar;
    menuPeek = false;
    invoke('cmd_set_menu_visible', { visible: settings.menuBar }).catch((e) => console.error('menu bar', e));
  }
  renderEditorOverlay();
  updateLineNumbers();
  updateTabScrollButtons();
  if (typeof getActive === 'function' && getActive()) updateStatusBar(); // syntax checks follow their settings
  if (typeof scheduleGridRender === 'function') scheduleGridRender();
}

function changeSetting(key, value) {
  settings[key] = value;
  applySettings();
  scheduleSessionSave();
  if (!settingsEl.classList.contains('hidden')) syncSettingsForm();
}

function toggleWordWrap() {
  if (!debounceAction('toggle-wrap')) return;
  changeSetting('wordWrap', !settings.wordWrap);
  flashFindStatus('Word wrap ' + (settings.wordWrap ? 'on' : 'off'));
}

function toggleSidebar() {
  if (!debounceAction('toggle-sidebar')) return;
  changeSetting('sidebar', !settings.sidebar);
}

function toggleMenuBar() {
  if (!debounceAction('toggle-menubar')) return;
  changeSetting('menuBar', !settings.menuBar);
}

/** Alt on its own while the menu bar is switched off: show it until a command is picked (Alt again, a click or a key hides it). */
function peekMenuBar() {
  if (settings.menuBar) return; // shown for good; View > Menu Bar switches it off
  if (!debounceAction('toggle-menubar')) return;
  menuPeek = !menuPeek;
  invoke('cmd_set_menu_visible', { visible: menuPeek, peek: true }).catch((e) => console.error('menu bar', e));
}

function endMenuPeek() {
  if (!menuPeek) return;
  menuPeek = false;
  if (!settings.menuBar) invoke('cmd_set_menu_visible', { visible: false, peek: false }).catch((e) => console.error('menu bar', e));
}

/** View > Show Hidden Characters (Ctrl+Shift+H). */
function toggleHiddenChars() {
  if (!debounceAction('toggle-hidden')) return;
  changeSetting('showHidden', !settings.showHidden);
  syncMenuChecks(true);
  flashFindStatus(settings.showHidden ? hiddenCharSummary(getActive()) : 'Hidden characters off', settings.showHidden ? 10000 : 3000);
}

function setBookmarkColour(colour) {
  if (!['Green', 'Orange', 'Red'].includes(colour)) return;
  if (settings.bookmarkColour !== colour) changeSetting('bookmarkColour', colour);
  syncMenuChecks(true);
}

function toggleStatusBar() {
  changeSetting('statusBar', !settings.statusBar);
}

/* ---------- the dialog ---------- */

// Settings that live elsewhere in the app (they also have their own menu items / shortcuts).
const LIVE_SETTINGS = {
  theme: {
    get: () => themeOverride || 'system',
    set: (v) => {
      themeOverride = v === 'system' ? null : v;
      applyTheme();
    },
  },
  lineNumbers: { get: () => lineNumbersVisible, set: (v) => setLineNumbersVisible(v) },
  toolbar: { get: () => !toolbarEl.classList.contains('hidden'), set: (v) => setToolbarVisible(v) },
  spellEnabled: {
    get: () => spell.enabled,
    set: (v) => {
      spell.enabled = v;
      updateSpellStatus();
      refreshSpellEverywhere();
    },
  },
  spellLang: { get: () => spell.lang, set: (v) => setSpellLang(v) },
  spellLogs: {
    get: () => !!settings.spellLogs,
    set: (v) => {
      settings.spellLogs = !!v;
      refreshSpellEverywhere(); // marks appear / go at once
    },
  },
};

function readSetting(key) {
  return LIVE_SETTINGS[key] ? LIVE_SETTINGS[key].get() : settings[key];
}

function computedColor(prop, el) {
  // Shows the current theme colour in a colour box whose setting is "follow the theme".
  const c = getComputedStyle(el)[prop];
  const m = /rgba?\((\d+),\s*(\d+),\s*(\d+)/.exec(c);
  if (m) return '#' + [m[1], m[2], m[3]].map((x) => Number(x).toString(16).padStart(2, '0')).join('');
  // color-mix() results come back as color(srgb r g b / a), with 0-1 values
  const f = /color\(srgb ([\d.]+) ([\d.]+) ([\d.]+)/.exec(c);
  return f ? '#' + [f[1], f[2], f[3]].map((x) => Math.round(Math.min(1, Number(x)) * 255).toString(16).padStart(2, '0')).join('') : '#000000';
}

/** A theme colour (CSS value, e.g. var(--caret)) as #rrggbb, for a colour box (see-through is ignored). */
function themeColor(css) {
  const probe = document.createElement('span');
  probe.style.color = css;
  probe.style.display = 'none';
  document.body.appendChild(probe);
  const hex = computedColor('color', probe);
  probe.remove();
  return hex;
}

function syncSettingsForm() {
  settingsEl.querySelectorAll('[data-s]').forEach((el) => {
    const key = el.dataset.s;
    const v = readSetting(key);
    if (el.type === 'checkbox') el.checked = !!v;
    else if (el.type === 'color') {
      const custom = COLOR_RE.test(v);
      const sample = key.startsWith('edit') ? editorHighlight.parentElement : preview;
      if (key === 'caretColor' || key === 'selectionColor') el.value = custom ? v : themeColor(key === 'caretColor' ? 'var(--caret, var(--accent))' : 'var(--selection)');
      else el.value = custom ? v : computedColor(key.endsWith('Bg') ? 'backgroundColor' : 'color', sample);
      const flag = settingsEl.querySelector('[data-theme-flag="' + key + '"]');
      if (flag) flag.textContent = custom ? 'custom' : 'theme';
    } else el.value = String(v);
  });
}

function openSettings() {
  hideContextMenu();
  hideAbout();
  settingsMessage('');
  syncSettingsForm();
  refreshFileTypeStatus();
  if (typeof refreshTranslateKeyStatus === 'function') refreshTranslateKeyStatus();
  settingsEl.classList.remove('hidden');
  showSettingsTab(settings.settingsTab);
  const first = settingsEl.querySelector('.modal-body > section:not([hidden]) select, .modal-body > section:not([hidden]) input');
  if (first) first.focus();
}

function closeSettings(keepFocus) {
  if (settingsEl.classList.contains('hidden')) return;
  settingsEl.classList.add('hidden');
  if (keepFocus === true) return;
  if (layoutMode === 'preview-only') preview.focus();
  else editor.focus();
}

function resetSettings() {
  loadSettings(null);
  themeOverride = null;
  applyTheme();
  setLineNumbersVisible(false);
  setToolbarVisible(false);
  spell.enabled = true;
  setSpellLang('en_GB');
  applySettings();
  syncSettingsForm();
  scheduleSessionSave();
}

/* ---------- About & updates ---------- */

const aboutEl = document.getElementById('about');
const aboutStatus = document.getElementById('about-update-status');
const aboutUpdateBtn = document.getElementById('about-update');

async function showAbout() {
  hideContextMenu();
  closeSettings(true);
  try {
    const info = await invoke('cmd_app_info');
    document.getElementById('about-version').textContent = 'v' + info.version;
  } catch (e) {
    /* keep the built-in text */
  }
  aboutEl.classList.remove('hidden');
  aboutUpdateBtn.focus();
}

function hideAbout() {
  aboutEl.classList.add('hidden');
}

/** Check -> confirm -> download + verify -> replace the exe -> restart (tabs come back via the session). */
async function checkForUpdates() {
  aboutUpdateBtn.disabled = true;
  aboutStatus.classList.remove('error');
  aboutStatus.textContent = 'Checking GitHub for a newer version...';
  try {
    const u = await invoke('cmd_check_update');
    if (!u.newer) {
      aboutStatus.textContent = '✓ You have the latest version (v' + u.current + ').';
      return;
    }
    if (!u.asset_url) {
      aboutStatus.textContent = 'Version ' + u.latest + ' is available, but it has no Windows download attached. See ' + u.page_url;
      return;
    }
    const notes = (u.notes || '').replace(/\r/g, '').trim();
    const ok = await dialogApi.ask(
      'Version ' + u.latest + ' is available (you have ' + u.current + ').\n\n' +
        (notes ? notes.slice(0, 600) + (notes.length > 600 ? '…' : '') + '\n\n' : '') +
        'Download and install it now? notepad.md will close and reopen with your tabs.',
      { title: 'Update available', kind: 'info', okLabel: 'Update now', cancelLabel: 'Later' }
    );
    if (!ok) {
      aboutStatus.textContent = 'Update postponed. Version ' + u.latest + ' is available.';
      return;
    }
    aboutStatus.textContent = 'Downloading ' + (u.asset_name || 'the update') + (u.asset_size ? ' (' + (u.asset_size / 1048576).toFixed(1) + ' MB)' : '') + '...';
    saveDocView(getActive());
    await saveSessionNow(); // the new version reopens every tab from this
    // The Rust side looks the release up again and verifies it; it only needs to know which version was agreed to.
    await invoke('cmd_install_update', { version: u.latest });
    aboutStatus.textContent = 'Installed. Restarting...';
  } catch (e) {
    aboutStatus.textContent = String(e && e.message ? e.message : e);
    aboutStatus.classList.add('error');
  } finally {
    aboutUpdateBtn.disabled = false;
  }
}

function wireAbout() {
  aboutUpdateBtn.addEventListener('click', checkForUpdates);
  document.getElementById('about-close').addEventListener('click', hideAbout);
  document.getElementById('about-link').addEventListener('click', (e) => {
    e.preventDefault();
    invoke('cmd_open_url', { url: 'https://github.com/mccabedd/notepad.md' });
  });
  aboutEl.addEventListener('click', (e) => {
    if (e.target === aboutEl) hideAbout();
  });
  aboutEl.addEventListener('keydown', (e) => {
    if (e.key === 'Escape') {
      e.preventDefault();
      e.stopPropagation();
      hideAbout();
    }
  });
}

/* ---------- import / export ---------- */

const settingsMsg = document.getElementById('settings-msg');

function settingsMessage(text, isError) {
  settingsMsg.textContent = text;
  settingsMsg.classList.toggle('error', !!isError);
  settingsMsg.title = text;
}

function exportableSettings() {
  return {
    app: 'notepad.md',
    kind: 'settings',
    version: 1,
    settings: { ...settings },
    theme: themeOverride || 'system',
    lineNumbers: lineNumbersVisible,
    toolbar: !toolbarEl.classList.contains('hidden'),
    spell: { enabled: spell.enabled, lang: spell.lang, userWords: [...spell.userWords].sort() },
  };
}

async function exportSettings() {
  const path = await dialogApi.save({
    filters: [{ name: 'notepad.md settings', extensions: ['json'] }],
    defaultPath: 'notepad.md-settings.json',
  });
  if (!path) return;
  try {
    await invoke('cmd_write_file', { path, content: JSON.stringify(exportableSettings(), null, 2) + '\n' });
    settingsMessage('Exported to ' + basename(path));
  } catch (e) {
    settingsMessage('Export failed: ' + e, true);
  }
}

/** Applies an exported settings object; the spelling dictionary is merged, not replaced. */
function applyImportedSettings(data) {
  if (!data || data.kind !== 'settings' || typeof data.settings !== 'object') throw new Error('This is not a notepad.md settings file.');
  // Files from before the new-tab format setting existed mean Markdown new tabs (the old behaviour).
  loadSettings({ ...settings, ...data.settings, newTabFormat: data.settings.newTabFormat === undefined ? 'markdown' : data.settings.newTabFormat });
  if (['system', 'light', 'dark'].includes(data.theme)) {
    themeOverride = data.theme === 'system' ? null : data.theme;
    applyTheme();
  }
  if (typeof data.lineNumbers === 'boolean') setLineNumbersVisible(data.lineNumbers);
  if (typeof data.toolbar === 'boolean') setToolbarVisible(data.toolbar);
  if (data.spell) {
    if (Array.isArray(data.spell.userWords)) data.spell.userWords.forEach((w) => typeof w === 'string' && spell.userWords.add(w.toLowerCase()));
    if (typeof data.spell.enabled === 'boolean') spell.enabled = data.spell.enabled;
    if (SPELL_LANG_LABELS[data.spell.lang]) setSpellLang(data.spell.lang);
    if (!data.spell.enabled) spell.enabled = false;
    updateSpellStatus();
    refreshSpellEverywhere();
  }
  applySettings();
  syncSettingsForm();
  scheduleSessionSave();
}

async function importSettings() {
  const sel = await dialogApi.open({
    multiple: false,
    filters: [
      { name: 'notepad.md settings', extensions: ['json'] },
      { name: 'All Files', extensions: ['*'] },
    ],
  });
  if (!sel) return;
  const path = Array.isArray(sel) ? sel[0] : sel;
  try {
    const file = await invoke('cmd_read_file', { path });
    applyImportedSettings(JSON.parse(file.content));
    settingsMessage('Imported from ' + basename(path));
  } catch (e) {
    settingsMessage('Import failed: ' + (e && e.message ? e.message : e), true);
  }
}

/* ---------- file types ---------- */

const ftStatus = document.getElementById('ft-status');
const ftGrid = document.getElementById('ft-grid');
const ftAll = document.getElementById('ft-all');
const ftCount = document.getElementById('ft-count');

/** Every registerable extension (from the one list in renderer.js); names like Dockerfile are not extensions. */
function supportedExtensions() {
  return Object.keys(EXT_LANG).sort();
}

// Scripts Windows runs when you double-click them: registering only adds notepad.md to "Open with".
const SCRIPT_EXTS = new Set(['bat', 'cmd', 'ps1', 'psm1', 'psd1', 'py', 'pyw', 'js', 'mjs', 'cjs', 'sh', 'vbs']);

function buildFileTypeGrid() {
  const exts = supportedExtensions();
  // Filled down each column (alphabetical top to bottom, then the next column).
  ftGrid.style.setProperty('--ft-rows', String(Math.ceil(exts.length / 3)));
  ftGrid.innerHTML = exts
    .map((e) => {
      const tip = SCRIPT_EXTS.has(e) ? ' title="Adds notepad.md to Open with only. Double-clicking a .' + e + ' file still does what it did before."' : '';
      return '<label class="check ft-item"' + tip + '><input type="checkbox" data-ext="' + e + '" /> .' + e + '</label>';
    })
    .join('');
}

function ftBoxes() {
  return [...ftGrid.querySelectorAll('input[data-ext]')];
}

/** Ticks come from the registry itself, every time (also after changes made outside the app). */
async function refreshFileTypeStatus() {
  if (!ftGrid.children.length) buildFileTypeGrid();
  const exts = supportedExtensions();
  try {
    const s = await invoke('cmd_file_type_states', { exts });
    ftOwner = s;
    const reg = new Set(s.registered);
    for (const box of ftBoxes()) box.checked = reg.has(box.dataset.ext);
    ftAll.checked = reg.size === exts.length;
    ftAll.indeterminate = reg.size > 0 && reg.size < exts.length;
    ftCount.textContent = reg.size + ' of ' + exts.length + ' registered';
    ftStatus.textContent =
      s.owner === 'other'
        ? 'These open another copy of notepad.md (' + s.other_exe + '). Ticking a type points Open with at this copy instead.'
        : s.owner === 'stale'
        ? 'These were registered by a copy that has been moved or deleted (' + s.other_exe + '). Ticking a type points them at this copy; unticking cleans them up.'
        : '';
    // After replacing or moving the exe: one click points the existing registrations here.
    document.getElementById('ft-repair-row').hidden = !(s.owner === 'other' || s.owner === 'stale');
  } catch (e) {
    ftStatus.textContent = 'Could not read the registrations: ' + e;
  }
  await refreshContextMenuStatus();
}

let ftBusy = false;
let ftOwner = null; // the last registry state read: { owner, other_exe }

/** Applies a change straight away; the boxes then show what the registry really says. */
async function setFileTypes(exts, enabled) {
  if (ftBusy || !exts.length) return;
  // Another copy that still exists owns the shared Open with entry: taking it over changes what
  // every ticked type opens, so ask first (a copy that was moved or deleted is taken over quietly).
  if (enabled && ftOwner && ftOwner.owner === 'other') {
    const me = await invoke('cmd_app_info').then((i) => i.exe).catch(() => 'this copy');
    const ok = await dialogApi.ask('The file types are registered to another copy of notepad.md:\n' + ftOwner.other_exe + '\n\nUse this copy (' + me + ') instead? Every ticked file type will then open this copy.', { title: 'File Types', kind: 'warning' });
    if (!ok) {
      await refreshFileTypeStatus();
      return;
    }
  }
  ftBusy = true;
  const boxes = [...ftBoxes(), ftAll];
  boxes.forEach((b) => (b.disabled = true));
  settingsMessage((enabled ? 'Registering ' : 'Removing ') + (exts.length === 1 ? '.' + exts[0] : exts.length + ' file types') + '...');
  try {
    const r = await invoke('cmd_set_file_types', { exts, enabled, all: supportedExtensions() });
    if (r.failed.length) settingsMessage('Could not change ' + r.failed.map(([e, why]) => '.' + e + ' (' + why + ')').join(', '), true);
    else settingsMessage(exts.length === 1 ? '.' + exts[0] + (enabled ? ' now opens with notepad.md (Open with).' : ' no longer lists notepad.md.') : (enabled ? 'Registered ' : 'Removed ') + r.changed + ' file types.');
  } catch (e) {
    settingsMessage(String(e), true);
  } finally {
    boxes.forEach((b) => (b.disabled = false));
    ftBusy = false;
    await refreshFileTypeStatus();
  }
}

function wireFileTypes() {
  ftGrid.addEventListener('change', (e) => {
    const box = e.target.closest('input[data-ext]');
    if (!box) return;
    e.stopPropagation(); // registry state, not a saved setting
    const want = box.checked;
    box.checked = !want; // shown only once Windows has the change
    setFileTypes([box.dataset.ext], want);
  });
  document.getElementById('ft-repair').addEventListener('click', async () => {
    if (ftOwner && ftOwner.owner === 'other') {
      const ok = await dialogApi.ask('The file types and the Explorer menu item are registered to another copy of notepad.md:\n' + ftOwner.other_exe + '\n\nPoint them at this copy instead?', { title: 'File Types', kind: 'warning' });
      if (!ok) return;
    }
    try {
      const r = await invoke('cmd_repair_registrations', { exts: supportedExtensions() });
      settingsMessage(
        'Open with now uses this copy for ' + r.repointed + ' file type(s)' + (r.context_menu ? ', and so does the Explorer menu item' : '') + (r.removed.length ? '. Removed ' + r.removed.length + ' entry(ies) left by copies that no longer exist.' : '.')
      );
    } catch (err) {
      settingsMessage('Could not update the registrations: ' + err, true);
    }
    await refreshFileTypeStatus();
  });
  ftAll.addEventListener('change', (e) => {
    e.stopPropagation();
    const want = ftAll.checked; // from "some" (indeterminate) a click means all
    const exts = supportedExtensions().filter((x) => ftBoxes().find((b) => b.dataset.ext === x).checked !== want);
    refreshFileTypeStatus(); // keep showing the real state while working
    setFileTypes(exts, want);
  });
}

/* ---------- Settings pages (General / File Types / Syntax Validation) ---------- */

function showSettingsTab(tab, focusTab) {
  if (!['general', 'filetypes', 'validation'].includes(tab)) tab = 'general';
  for (const b of settingsEl.querySelectorAll('.settings-tabs [role="tab"]')) {
    const on = b.dataset.tab === tab;
    b.setAttribute('aria-selected', String(on));
    b.tabIndex = on ? 0 : -1;
    if (on && focusTab) b.focus();
  }
  for (const s of settingsEl.querySelectorAll('.modal-body > section')) s.hidden = (s.dataset.tab || 'general') !== tab;
  document.getElementById('settings-body').scrollTop = 0;
  if (settings.settingsTab !== tab) {
    settings.settingsTab = tab;
    scheduleSessionSave();
  }
}

function wireSettingsTabs() {
  const tabs = settingsEl.querySelector('.settings-tabs');
  tabs.addEventListener('click', (e) => {
    const b = e.target.closest('[role="tab"]');
    if (b) showSettingsTab(b.dataset.tab, true);
  });
  // Arrow keys move between the pages (Windows tab-control style).
  tabs.addEventListener('keydown', (e) => {
    if (!['ArrowLeft', 'ArrowRight', 'Home', 'End'].includes(e.key)) return;
    e.preventDefault();
    const list = [...tabs.querySelectorAll('[role="tab"]')];
    const i = list.findIndex((b) => b.getAttribute('aria-selected') === 'true');
    const j = e.key === 'Home' ? 0 : e.key === 'End' ? list.length - 1 : (i + (e.key === 'ArrowRight' ? 1 : -1) + list.length) % list.length;
    showSettingsTab(list[j].dataset.tab, true);
  });
}

/* ---------- Explorer right-click "Edit in notepad.md" ---------- */

const ctxMenuBox = document.getElementById('explorer-menu');
const ctxStatus = document.getElementById('explorer-menu-status');
const CTX_HINT = 'On Windows 11 it\'s under "Show more options" (or Shift+right-click).';

async function refreshContextMenuStatus() {
  try {
    const s = await invoke('cmd_context_menu_status');
    ctxMenuBox.checked = s === 'on';
    ctxStatus.textContent =
      s === 'other' ? 'It currently opens a different copy of the app. Tick the box to point it at this one.' : CTX_HINT;
  } catch (e) {
    ctxStatus.textContent = 'Could not check the right-click menu: ' + e;
  }
}

async function setContextMenu(enabled) {
  try {
    await invoke('cmd_set_context_menu', { enabled });
    settingsMessage(enabled ? '"Edit in notepad.md" added to the Explorer right-click menu.' : '"Edit in notepad.md" removed from the Explorer right-click menu.');
  } catch (e) {
    settingsMessage('Could not change the right-click menu: ' + e, true);
  }
  await refreshContextMenuStatus();
}

function wireSettings() {
  document.getElementById('settings-export').addEventListener('click', exportSettings);
  document.getElementById('settings-import').addEventListener('click', importSettings);
  wireFileTypes();
  wireSettingsTabs();
  ctxMenuBox.addEventListener('change', (e) => {
    e.stopPropagation(); // registry state, not a saved setting
    setContextMenu(ctxMenuBox.checked);
  });
  document.getElementById('ft-defaults').addEventListener('click', () =>
    invoke('cmd_open_default_apps').catch((e) => settingsMessage('Could not open Windows Settings: ' + e, true))
  );
  settingsEl.addEventListener('input', onSettingInput);
  settingsEl.addEventListener('change', onSettingInput);
  settingsEl.addEventListener('click', (e) => {
    const clear = e.target.closest('[data-clear]');
    if (clear) {
      changeSetting(clear.dataset.clear, '');
      syncSettingsForm();
    }
    if (e.target === settingsEl) closeSettings(); // click outside the panel
  });
  document.getElementById('settings-close').addEventListener('click', () => closeSettings());
  document.getElementById('settings-done').addEventListener('click', () => closeSettings());
  wireAbout();
  document.getElementById('settings-reset').addEventListener('click', resetSettings);
  settingsEl.addEventListener('keydown', (e) => {
    if (e.key === 'Escape') {
      e.preventDefault();
      e.stopPropagation();
      closeSettings();
    }
  });
}

function onSettingInput(e) {
  const el = e.target.closest('[data-s]');
  if (!el) return;
  const key = el.dataset.s;
  let v;
  if (el.type === 'checkbox') v = el.checked;
  else if (el.type === 'number') {
    v = parseInt(el.value, 10);
    if (isNaN(v)) return;
    if (key === 'tabFontSize') v = clampTabFont(parseFloat(el.value));
    if (key === 'newTabFontSize' || key === 'editFontSize' || key === 'previewFontSize') v = Math.min(MAX_FONT_SIZE, Math.max(MIN_FONT_SIZE, v));
    if (key === 'validateDelay') v = Math.min(5000, Math.max(200, v));
  } else if (key === 'tabSize') v = parseInt(el.value, 10);
  else v = el.value;
  if (LIVE_SETTINGS[key]) {
    LIVE_SETTINGS[key].set(v);
    scheduleSessionSave();
  } else {
    settings[key] = v;
    applySettings();
    scheduleSessionSave();
  }
  if (el.type === 'color') {
    const flag = settingsEl.querySelector('[data-theme-flag="' + key + '"]');
    if (flag) flag.textContent = 'custom';
  }
}
