/* Translate: right-click in the editor > Translate > "Translate to <default>" or "Choose Language...".
 * The selection is translated, or the whole document when nothing is selected, and replaced in
 * place as one change (Ctrl+Z undoes it). The work is done in Rust (src-tauri/src/translate.rs) by
 * Google Translate's free endpoint or by Google Cloud Translation with the user's own API key, which
 * Rust also keeps: this page can save or remove it, never read it. The same items are in the
 * spelling menu (right-click on a misspelt word). Loaded before renderer.js; uses its globals in functions. */

// Languages Google Cloud Translation offers (code: name), as listed in its documentation.
const TRANSLATE_LANGS = {
  af: 'Afrikaans', sq: 'Albanian', am: 'Amharic', ar: 'Arabic', hy: 'Armenian', as: 'Assamese', ay: 'Aymara', az: 'Azerbaijani',
  bm: 'Bambara', eu: 'Basque', be: 'Belarusian', bn: 'Bengali', bho: 'Bhojpuri', bs: 'Bosnian', bg: 'Bulgarian', ca: 'Catalan',
  ceb: 'Cebuano', ny: 'Chichewa', 'zh-CN': 'Chinese (Simplified)', 'zh-TW': 'Chinese (Traditional)', co: 'Corsican', hr: 'Croatian',
  cs: 'Czech', da: 'Danish', dv: 'Dhivehi', doi: 'Dogri', nl: 'Dutch', en: 'English', eo: 'Esperanto', et: 'Estonian', ee: 'Ewe',
  fil: 'Filipino', fi: 'Finnish', fr: 'French', fy: 'Frisian', gl: 'Galician', ka: 'Georgian', de: 'German', el: 'Greek',
  gn: 'Guarani', gu: 'Gujarati', ht: 'Haitian Creole', ha: 'Hausa', haw: 'Hawaiian', he: 'Hebrew', hi: 'Hindi', hmn: 'Hmong',
  hu: 'Hungarian', is: 'Icelandic', ig: 'Igbo', ilo: 'Ilocano', id: 'Indonesian', ga: 'Irish', it: 'Italian', ja: 'Japanese',
  jv: 'Javanese', kn: 'Kannada', kk: 'Kazakh', km: 'Khmer', rw: 'Kinyarwanda', gom: 'Konkani', ko: 'Korean', kri: 'Krio',
  ku: 'Kurdish (Kurmanji)', ckb: 'Kurdish (Sorani)', ky: 'Kyrgyz', lo: 'Lao', la: 'Latin', lv: 'Latvian', ln: 'Lingala',
  lt: 'Lithuanian', lg: 'Luganda', lb: 'Luxembourgish', mk: 'Macedonian', mai: 'Maithili', mg: 'Malagasy', ms: 'Malay',
  ml: 'Malayalam', mt: 'Maltese', mi: 'Maori', mr: 'Marathi', 'mni-Mtei': 'Meiteilon (Manipuri)', lus: 'Mizo', mn: 'Mongolian',
  my: 'Myanmar (Burmese)', ne: 'Nepali', no: 'Norwegian', or: 'Odia (Oriya)', om: 'Oromo', ps: 'Pashto', fa: 'Persian',
  pl: 'Polish', pt: 'Portuguese', pa: 'Punjabi', qu: 'Quechua', ro: 'Romanian', ru: 'Russian', sm: 'Samoan', sa: 'Sanskrit',
  gd: 'Scots Gaelic', nso: 'Sepedi', sr: 'Serbian', st: 'Sesotho', sn: 'Shona', sd: 'Sindhi', si: 'Sinhala', sk: 'Slovak',
  sl: 'Slovenian', so: 'Somali', es: 'Spanish', su: 'Sundanese', sw: 'Swahili', sv: 'Swedish', tg: 'Tajik', ta: 'Tamil',
  tt: 'Tatar', te: 'Telugu', th: 'Thai', ti: 'Tigrinya', ts: 'Tsonga', tr: 'Turkish', tk: 'Turkmen', ak: 'Twi', uk: 'Ukrainian',
  ur: 'Urdu', ug: 'Uyghur', uz: 'Uzbek', vi: 'Vietnamese', cy: 'Welsh', xh: 'Xhosa', yi: 'Yiddish', yo: 'Yoruba', zu: 'Zulu',
};

/** Asked before sending more than this many characters (Google charges per character). */
const TRANSLATE_CONFIRM_CHARS = 20000;

let translateBusy = false;
let translateLastChoice = '';

function translateLangName(code) {
  return TRANSLATE_LANGS[code] || code;
}

function translateLangList() {
  return Object.entries(TRANSLATE_LANGS).sort((a, b) => a[1].localeCompare(b[1]));
}

/**
 * Translates the editor's selection (or the whole text when nothing is selected) into `target`.
 * Resolves to a short description of what happened (also shown in the status bar).
 */
async function translateInEditor(target) {
  const doc = getActive();
  if (!doc || translateBusy) return 'busy';
  if (!target || !TRANSLATE_LANGS[target]) target = settings.translateTo || 'en';
  const hasKey = await translateKeySaved();
  const provider = translateProvider(hasKey);
  if (provider === 'cloud' && !hasKey) {
    await dialogApi.message(
      'To translate with Google Cloud Translation, add your API key in Settings > Translate, or choose Google Translate (free, no key) there.',
      { title: 'Translate', kind: 'info' }
    );
    return 'no key';
  }
  const all = editor.value;
  let start = editor.selectionStart;
  let end = editor.selectionEnd;
  const whole = start === end;
  if (whole) {
    start = 0;
    end = all.length;
  }
  const text = all.slice(start, end);
  if (!text.trim()) {
    flashFindStatus('Nothing to translate.');
    return 'empty';
  }
  const chars = text.replace(/\s+/g, '').length;
  if (provider === 'cloud' && chars > TRANSLATE_CONFIRM_CHARS) {
    const ok = await dialogApi.ask(
      'Translate ' + (whole ? 'the whole document' : 'the selection') + ' (' + fmtCount(chars) + ' characters) into ' + translateLangName(target) + '?\n\n' +
        'It is sent to Google Cloud Translation, which charges per character after the first 500,000 each month.',
      { title: 'Translate', kind: 'warning' }
    );
    if (!ok) return 'cancelled';
  }
  translateBusy = true;
  flashFindStatus('Translating into ' + translateLangName(target) + '...', 120000);
  let result;
  try {
    result = await invoke('cmd_translate', { text, target, provider });
  } catch (e) {
    flashFindStatus('');
    updateStatusBar();
    await dialogApi.message(String(e), { title: 'Translate', kind: 'error' });
    return 'error';
  } finally {
    translateBusy = false;
  }
  // The text may have been edited, or the tab changed, while Google was working: then nothing is replaced.
  if (getActive() !== doc || editor.value.slice(start, end) !== text || editor.value.length !== all.length) {
    flashFindStatus('The text changed while it was being translated, so it was left as it is.', 6000);
    return 'changed';
  }
  if (result.text === text) {
    flashFindStatus('Already in ' + translateLangName(target) + ': nothing changed.', 5000);
    return 'unchanged';
  }
  replaceEditorRange(start, end, result.text);
  editor.setSelectionRange(start, start + result.text.length);
  const from = result.detected && TRANSLATE_LANGS[result.detected] ? ' from ' + translateLangName(result.detected) : '';
  const msg = 'Translated' + from + ' into ' + translateLangName(target) + ' (' + fmtCount(result.chars) + ' characters). Ctrl+Z undoes it.';
  flashFindStatus(msg, 6000);
  return msg;
}

async function translateKeySaved() {
  try {
    return !!(await invoke('cmd_translate_key_status'));
  } catch (e) {
    return false;
  }
}

/** 'free' or 'cloud'. Before v2.0.3 Cloud was the only provider: whoever saved a key keeps it. */
function translateProvider(hasKey) {
  if (translateProviderUnset && hasKey) {
    settings.translateProvider = 'cloud';
    translateProviderUnset = false;
    scheduleSessionSave();
  }
  return settings.translateProvider === 'cloud' ? 'cloud' : 'free';
}

/** The Translate items for the editor's own right-click menus (the spelling menu). */
function translateMenuItems() {
  return [
    {
      label: 'Translate',
      icon: '文',
      submenu: [
        { label: 'Translate to ' + translateLangName(settings.translateTo || 'en'), action: () => translateInEditor(settings.translateTo || 'en') },
        { label: 'Choose Language...', action: openTranslateChooser },
      ],
    },
  ];
}

/* ---------- "Choose Language..." ---------- */

function openTranslateChooser() {
  const dlg = document.getElementById('translate-dlg');
  const filter = document.getElementById('translate-filter');
  const list = document.getElementById('translate-list');
  if (!dlg || translateBusy) return;
  hideContextMenu();
  filter.value = '';
  fillTranslateList('');
  const pick = translateLastChoice || settings.translateTo || 'en';
  list.value = TRANSLATE_LANGS[pick] ? pick : 'en';
  document.getElementById('translate-dlg-msg').textContent = editor.selectionStart === editor.selectionEnd ? 'The whole document will be translated.' : 'The selected text will be translated.';
  dlg.classList.remove('hidden');
  filter.focus();
}

function fillTranslateList(q) {
  const list = document.getElementById('translate-list');
  const keep = list.value;
  const needle = q.trim().toLowerCase();
  list.replaceChildren();
  for (const [code, name] of translateLangList()) {
    if (needle && !name.toLowerCase().includes(needle) && code.toLowerCase() !== needle) continue;
    const o = document.createElement('option');
    o.value = code;
    o.textContent = name;
    list.appendChild(o);
  }
  if ([...list.options].some((o) => o.value === keep)) list.value = keep;
  else if (list.options.length) list.selectedIndex = 0;
}

function closeTranslateChooser() {
  const dlg = document.getElementById('translate-dlg');
  if (!dlg || dlg.classList.contains('hidden')) return;
  dlg.classList.add('hidden');
  editor.focus();
}

function translateChosen() {
  const list = document.getElementById('translate-list');
  const code = list.value;
  if (!code) return;
  translateLastChoice = code;
  closeTranslateChooser();
  translateInEditor(code);
}

/* ---------- Settings > Translate ---------- */

async function refreshTranslateKeyStatus() {
  const el = document.getElementById('translate-key-status');
  if (!el) return;
  const has = await translateKeySaved();
  translateProvider(has);
  el.textContent = has ? 'A key is saved.' : 'No key saved yet.';
  document.getElementById('translate-key-remove').disabled = !has;
  syncTranslateProviderUi();
}

/** Settings > Translate: the key fields only matter for Google Cloud. */
function syncTranslateProviderUi() {
  const sel = document.getElementById('translate-provider');
  if (sel) sel.value = settings.translateProvider === 'cloud' ? 'cloud' : 'free';
  const cloud = settings.translateProvider === 'cloud';
  document.getElementById('translate-cloud').classList.toggle('hidden', !cloud);
  document.getElementById('translate-free-note').classList.toggle('hidden', cloud);
}

async function saveTranslateKey(key) {
  try {
    await invoke('cmd_translate_key_set', { key });
    if (key) {
      // Saving a key means: use it.
      settings.translateProvider = 'cloud';
      translateProviderUnset = false;
      scheduleSessionSave();
    }
    document.getElementById('translate-key').value = '';
    await refreshTranslateKeyStatus();
    return true;
  } catch (e) {
    document.getElementById('translate-key-status').textContent = String(e);
    return false;
  }
}

function initTranslate() {
  const to = document.getElementById('translate-to');
  if (to) {
    for (const [code, name] of translateLangList()) {
      const o = document.createElement('option');
      o.value = code;
      o.textContent = name;
      to.appendChild(o);
    }
  }
  // The Translate submenu belongs to the editor only: tell the backend where this right-click is.
  const label = () => translateLangName(settings.translateTo || 'en');
  editor.addEventListener('mousedown', (e) => {
    if (e.button === 2) invoke('cmd_set_translate_menu', { label: label() }).catch(() => {});
  });
  preview.addEventListener('mousedown', (e) => {
    if (e.button === 2) invoke('cmd_set_translate_menu', { label: null }).catch(() => {});
  });
  window.__TAURI__.event.listen('translate-menu', (e) => {
    if (e.payload === 'choose') openTranslateChooser();
    else translateInEditor(settings.translateTo || 'en');
  });

  const filter = document.getElementById('translate-filter');
  const list = document.getElementById('translate-list');
  filter.addEventListener('input', () => fillTranslateList(filter.value));
  filter.addEventListener('keydown', (e) => {
    if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
      e.preventDefault();
      const i = Math.max(0, Math.min(list.options.length - 1, list.selectedIndex + (e.key === 'ArrowDown' ? 1 : -1)));
      list.selectedIndex = i;
    }
  });
  list.addEventListener('dblclick', translateChosen);
  document.getElementById('translate-go').addEventListener('click', translateChosen);
  document.getElementById('translate-cancel').addEventListener('click', closeTranslateChooser);
  document.getElementById('translate-dlg').addEventListener('keydown', (e) => {
    if (e.key === 'Escape') {
      e.preventDefault();
      e.stopPropagation();
      closeTranslateChooser();
    } else if (e.key === 'Enter') {
      e.preventDefault();
      e.stopPropagation();
      translateChosen();
    }
  });

  document.getElementById('translate-key-save').addEventListener('click', () => {
    const v = document.getElementById('translate-key').value.trim();
    if (v) saveTranslateKey(v);
  });
  document.getElementById('translate-key').addEventListener('keydown', (e) => {
    if (e.key === 'Enter') {
      e.preventDefault();
      e.stopPropagation();
      const v = e.target.value.trim();
      if (v) saveTranslateKey(v);
    }
  });
  document.getElementById('translate-key-remove').addEventListener('click', () => saveTranslateKey(''));
  document.getElementById('translate-provider').addEventListener('change', () => setTimeout(syncTranslateProviderUi, 0));
  document.getElementById('translate-help').addEventListener('click', (e) => {
    e.preventDefault();
    invoke('cmd_open_url', { url: 'https://cloud.google.com/translate/docs/setup' }).catch(() => {});
  });
  document.getElementById('settings').addEventListener('click', (e) => {
    if (e.target.closest('[data-tab]')) refreshTranslateKeyStatus();
  });
  refreshTranslateKeyStatus();
}
