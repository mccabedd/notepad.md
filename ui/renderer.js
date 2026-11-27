const { invoke } = window.__TAURI__.core;
const { listen } = window.__TAURI__.event;
const dialogApi = window.__TAURI__.dialog;
const clipboard = window.__TAURI__.clipboardManager;

const tabbarEl = document.getElementById('tabbar');
const tabScrollEl = document.getElementById('tab-scroll');
const toolbarEl = document.getElementById('toolbar');
const workspace = document.getElementById('workspace');
const editorPane = document.getElementById('editor-pane');
const lineNumbersEl = document.getElementById('line-numbers');
// The text editor: CodeMirror behind a textarea-like stand-in, or the textarea itself (editor-facade.js).
const editor = window.npEditor;
const editorHighlight = document.getElementById('editor-highlight');
const resizer = document.getElementById('resizer');
const previewPane = document.getElementById('preview-pane');
const lineNumbersPreviewEl = document.getElementById('line-numbers-preview');
const preview = document.getElementById('preview');
const sidebarEl = document.getElementById('sidebar');
const statusFile = document.getElementById('status-file');
const statusDirty = document.getElementById('status-dirty');
const statusLang = document.getElementById('status-lang');
const statusSpell = document.getElementById('status-spell');
const statusLayout = document.getElementById('status-layout');
const statusTheme = document.getElementById('status-theme');
const statusZoom = document.getElementById('status-zoom');
const statusCount = document.getElementById('status-count');
const ctxMenu = document.getElementById('ctx-menu');
const dropOverlay = document.getElementById('drop-overlay');

let marked_ = window.marked;
let turndownService;

let docs = [];
let activeId = null;
let docCounter = 0;
let layoutMode = 'preview-only'; // mirrors the active document's own layoutMode
let lineNumbersVisible = false;
let splitRatio = 0.5;
let themeOverride = null;
let lastFocused = 'preview';
let previewStale = false; // preview not re-rendered while hidden (edit-only mode)
let sessionReady = false; // no session writes until the previous session has been restored
let windowState = null; // { x, y, w, h, maximized } in physical pixels

const MIN_FONT_SIZE = 8;
const MAX_FONT_SIZE = 40;

/* ---------- languages ---------- */

// render: how the preview shows it ('markdown' = editable rendering, 'bbcode' = read-only rendering,
//         'code' = read-only coloured source).
// prose:  spellchecked, and opens in Preview Only by default.
// hljs:   highlight.js grammar used to colour the editor.
/* Every language a tab can be shown as. `group` sorts View > Language and the status-bar menu,
 * `validate` names the syntax check (Settings > Syntax Validation) and `exts` the Save As types.
 * The ids must match the lang_* items of View > Language in src-tauri/src/main.rs. */
const LANGS = {
  markdown: { label: 'Markdown', hljs: 'markdown', prose: true, render: 'markdown', exts: ['md', 'markdown'], group: 'text' },
  plaintext: { label: 'Plain Text', hljs: null, prose: true, render: 'plain', exts: ['txt'], group: 'text' },
  bbcode: { label: 'BBCode', hljs: 'bbcode', prose: true, render: 'bbcode', exts: ['bbcode', 'bb'], group: 'text' },
  log: { label: 'Log File', hljs: 'logfile', render: 'code', exts: ['log', 'txt'], group: 'text' }, // colours levels, times, ids
  xml: { label: 'XML', hljs: 'xml', render: 'code', exts: ['xml'], group: 'data', validate: 'xml' },
  html: { label: 'HTML', hljs: 'xml', render: 'code', exts: ['html', 'htm'], group: 'data' },
  css: { label: 'CSS', hljs: 'css', render: 'code', exts: ['css'], group: 'data', validate: 'css' },
  json: { label: 'JSON', hljs: 'json', render: 'code', exts: ['json'], group: 'data', validate: 'json' },
  jsonc: { label: 'JSON with Comments', hljs: 'json', render: 'code', exts: ['jsonc'], group: 'data', validate: 'jsonc' },
  json5: { label: 'JSON5', hljs: 'json', render: 'code', exts: ['json5'], group: 'data', validate: 'json5' },
  jsonl: { label: 'JSON Lines', hljs: 'json', render: 'code', exts: ['jsonl', 'ndjson'], group: 'data', validate: 'jsonl' },
  yaml: { label: 'YAML', hljs: 'yaml', render: 'code', exts: ['yml', 'yaml'], group: 'data', validate: 'yaml' },
  toml: { label: 'TOML', hljs: 'ini', render: 'code', exts: ['toml'], group: 'data', validate: 'toml' },
  sql: { label: 'SQL', hljs: 'sql', render: 'code', exts: ['sql'], group: 'data' },
  diff: { label: 'Diff / Patch', hljs: 'diff', render: 'code', exts: ['diff', 'patch'], group: 'data' },
  bash: { label: 'Shell / Bash', hljs: 'bash', render: 'code', exts: ['sh', 'bash'], group: 'scripts', validate: 'bash' },
  powershell: { label: 'PowerShell', hljs: 'powershell', render: 'code', exts: ['ps1'], group: 'scripts', validate: 'powershell' },
  dos: { label: 'MS-DOS Batch', hljs: 'dos', render: 'code', exts: ['bat', 'cmd'], group: 'scripts' },
  python: { label: 'Python', hljs: 'python', render: 'code', exts: ['py'], group: 'scripts', validate: 'python' },
  javascript: { label: 'JavaScript', hljs: 'javascript', render: 'code', exts: ['js'], group: 'scripts', validate: 'javascript' },
  php: { label: 'PHP', hljs: 'php', render: 'code', exts: ['php'], group: 'scripts' },
  perl: { label: 'Perl', hljs: 'perl', render: 'code', exts: ['pl', 'pm'], group: 'scripts' },
  ruby: { label: 'Ruby', hljs: 'ruby', render: 'code', exts: ['rb'], group: 'scripts' },
  awk: { label: 'AWK (no colouring)', hljs: null, render: 'code', exts: ['awk'], group: 'scripts' },
  sed: { label: 'sed (no colouring)', hljs: null, render: 'code', exts: ['sed'], group: 'scripts' },
  ini: { label: 'INI', hljs: 'ini', render: 'code', exts: ['ini'], group: 'config', validate: 'ini' },
  env: { label: 'Environment (.env)', hljs: 'dotenv', render: 'code', exts: ['env'], group: 'config', validate: 'env' },
  systemd: { label: 'systemd Unit', hljs: 'ini', render: 'code', exts: ['service'], group: 'config', validate: 'systemd' },
  desktop: { label: 'Desktop Entry', hljs: 'ini', render: 'code', exts: ['desktop'], group: 'config', validate: 'desktop' },
  compose: { label: 'Docker Compose', hljs: 'yaml', render: 'code', exts: ['yaml', 'yml'], group: 'config', validate: 'compose' },
  dockerfile: { label: 'Dockerfile', hljs: 'dockerfile', render: 'code', exts: ['dockerfile'], group: 'config', validate: 'dockerfile' },
  makefile: { label: 'Makefile', hljs: 'makefile', render: 'code', exts: ['mk', 'mak'], group: 'config' },
  nginx: { label: 'NGINX', hljs: 'nginx', render: 'code', exts: ['conf'], group: 'config', validate: 'nginx' },
  apache: { label: 'Apache (.htaccess)', hljs: 'apache', render: 'code', exts: ['htaccess', 'conf'], group: 'config', validate: 'apache' },
  hcl: { label: 'HCL / Terraform', hljs: 'hcl', render: 'code', exts: ['tf', 'hcl', 'tfvars'], group: 'config', validate: 'hcl' },
  ignore: { label: 'Ignore File (.gitignore)', hljs: 'ignorefile', render: 'code', exts: ['gitignore'], group: 'config' },
  requirements: { label: 'pip Requirements', hljs: null, render: 'code', exts: ['txt'], group: 'config' },
  cmake: { label: 'CMake (no colouring)', hljs: null, render: 'code', exts: ['cmake'], group: 'config' },
  htpasswd: { label: 'Password File (.htpasswd)', hljs: null, render: 'code', exts: ['htpasswd'], group: 'config' },
  pem: { label: 'Certificate / Key (PEM)', hljs: 'pem', render: 'code', exts: ['pem', 'crt', 'cer', 'csr', 'pub', 'asc'], group: 'security' },
  java: { label: 'Java', hljs: 'java', render: 'code', exts: ['java'], group: 'code' },
  groovy: { label: 'Groovy / Jenkinsfile', hljs: 'java', render: 'code', exts: ['groovy'], group: 'code' },
  c: { label: 'C', hljs: 'c', render: 'code', exts: ['c', 'h'], group: 'code' },
  cpp: { label: 'C++', hljs: 'cpp', render: 'code', exts: ['cpp', 'hpp'], group: 'code' },
  csharp: { label: 'C#', hljs: 'csharp', render: 'code', exts: ['cs'], group: 'code' },
};

const LANG_GROUPS = [
  ['text', 'Text'],
  ['data', 'Web and Data'],
  ['scripts', 'Scripts'],
  ['config', 'Configuration'],
  ['code', 'Programming'],
  ['security', 'Certificates and Keys'],
];

/* The single list of file extensions: language detection, File > Open filters and the
 * Settings > File Types registration list all come from here. */
const EXT_LANG = {
  md: 'markdown', markdown: 'markdown', mdown: 'markdown', mkd: 'markdown',
  txt: 'plaintext', text: 'plaintext', log: 'log',
  bbcode: 'bbcode', bb: 'bbcode',
  xml: 'xml', xsd: 'xml', xsl: 'xml', xslt: 'xml', xhtml: 'xml', svg: 'xml', config: 'xml', csproj: 'xml', resx: 'xml', plist: 'xml',
  html: 'html', htm: 'html',
  yml: 'yaml', yaml: 'yaml',
  json: 'json', jsonc: 'jsonc', json5: 'json5', jsonl: 'jsonl', ndjson: 'jsonl',
  ini: 'ini', cfg: 'ini', conf: 'ini', inf: 'ini', properties: 'ini', editorconfig: 'ini',
  toml: 'toml',
  sql: 'sql',
  diff: 'diff', patch: 'diff',
  sh: 'bash', bash: 'bash', zsh: 'bash', ksh: 'bash', fish: 'bash',
  py: 'python', pyw: 'python',
  js: 'javascript', mjs: 'javascript', cjs: 'javascript',
  ps1: 'powershell', psm1: 'powershell', psd1: 'powershell',
  bat: 'dos', cmd: 'dos',
  php: 'php', phtml: 'php',
  pl: 'perl', pm: 'perl',
  rb: 'ruby',
  awk: 'awk',
  sed: 'sed',
  env: 'env',
  service: 'systemd', timer: 'systemd', socket: 'systemd', mount: 'systemd', target: 'systemd', network: 'systemd', netdev: 'systemd', link: 'systemd',
  desktop: 'desktop',
  dockerfile: 'dockerfile',
  mk: 'makefile', mak: 'makefile',
  hcl: 'hcl', tf: 'hcl', tfvars: 'hcl',
  pem: 'pem', crt: 'pem', cer: 'pem', csr: 'pem', pub: 'pem', asc: 'pem',
  java: 'java',
  groovy: 'groovy',
  css: 'css',
  c: 'c', h: 'c',
  cs: 'csharp', csx: 'csharp',
  cpp: 'cpp', cc: 'cpp', cxx: 'cpp', hpp: 'cpp', hh: 'cpp', hxx: 'cpp', inl: 'cpp', ino: 'cpp',
};

/* Files recognised by their whole name (lower case). These win over the extension, and are never
 * registered with Windows (they aren't extensions). */
const FILENAME_LANG = {
  dockerfile: 'dockerfile', containerfile: 'dockerfile',
  makefile: 'makefile', gnumakefile: 'makefile',
  jenkinsfile: 'groovy',
  vagrantfile: 'ruby', gemfile: 'ruby', rakefile: 'ruby',
  pipfile: 'toml',
  '.env': 'env',
  '.bashrc': 'bash', '.bash_profile': 'bash', '.bash_aliases': 'bash', '.bash_logout': 'bash', '.profile': 'bash', '.zshrc': 'bash', '.zprofile': 'bash', '.zshenv': 'bash',
  '.gitignore': 'ignore', '.dockerignore': 'ignore', '.gitattributes': 'ignore', '.npmignore': 'ignore',
  '.gitmodules': 'ini', '.gitconfig': 'ini', '.editorconfig': 'ini',
  '.htaccess': 'apache', 'httpd.conf': 'apache', 'apache2.conf': 'apache',
  '.htpasswd': 'htpasswd',
  'nginx.conf': 'nginx',
  'requirements.txt': 'requirements',
  'cmakelists.txt': 'cmake',
  'compose.yaml': 'compose', 'compose.yml': 'compose', 'docker-compose.yaml': 'compose', 'docker-compose.yml': 'compose',
  'log.txt': 'log',
};

/* Name patterns, checked after the exact names and before the extension. */
const FILENAME_PATTERNS = [
  [/^(?:dockerfile|containerfile)\..+$/, 'dockerfile'],
  [/^\.env\..+$/, 'env'],
  [/^(?:docker-)?compose\..+\.ya?ml$/, 'compose'],
  [/^requirements[-_.].*\.txt$/, 'requirements'],
];

function langForPath(p) {
  if (!p) return 'markdown';
  const parts = p.split(/[\\/]/);
  const name = parts[parts.length - 1].toLowerCase();
  if (FILENAME_LANG[name]) return FILENAME_LANG[name];
  for (const [re, lang] of FILENAME_PATTERNS) if (re.test(name)) return lang;
  // NGINX keeps its sites and snippets in an nginx folder: *.conf there (or no extension in sites-*).
  const dirs = parts.slice(0, -1).map((d) => d.toLowerCase());
  if (dirs.includes('nginx') && (/\.conf$/.test(name) || /^sites-(?:available|enabled)$/.test(dirs[dirs.length - 1] || ''))) return 'nginx';
  const m = /\.([^.\\/]+)$/.exec(name);
  return (m && EXT_LANG[m[1]]) || 'plaintext';
}

function langInfo(doc) {
  return LANGS[doc && doc.lang] || LANGS.plaintext;
}

function isProse(doc) {
  return !!langInfo(doc).prose;
}

/** Whether the editor spell-checks this tab: prose, and log files when Settings > Spelling >
 *  Spell-check log files is on (off by default: logs are mostly program output). */
function editorSpellChecks(doc) {
  return !!doc && (isProse(doc) || (doc.lang === 'log' && !!settings.spellLogs));
}

/** Only Markdown-rendered documents have an editable preview that writes back to the source. */
function isMarkdownPreview(doc) {
  return langInfo(doc).render === 'markdown';
}

/** Previews you can type into: Markdown, and BBCode (turned back into BBCode as you type). */
function isEditablePreview(doc) {
  const r = langInfo(doc).render;
  return r === 'markdown' || r === 'bbcode' || r === 'plain';
}

/** The preview's contenteditable value: rich for Markdown and BBCode, plain text for Plain Text. */
function previewEditableFor(mode) {
  return mode === 'markdown' || mode === 'bbcode' ? 'true' : mode === 'plain' ? 'plaintext-only' : 'false';
}

function defaultLayoutFor(lang) {
  return (LANGS[lang] || LANGS.plaintext).prose ? 'preview-only' : 'edit-only';
}

/* ---------- markdown engine ---------- */

function setupMarkdownEngine() {
  // breaks: every new line in the source is a new line in the preview, so a
  // list of links or log lines isn't run together into one paragraph. A <br> written back from
  // the preview becomes a plain new line again (br: '').
  marked_.setOptions({ gfm: true, breaks: true });
  turndownService = new TurndownService({
    headingStyle: 'atx',
    hr: '---',
    bulletListMarker: '-',
    codeBlockStyle: 'fenced',
    br: '',
  });
  turndownService.use(turndownPluginGfm.gfm);
  // "- item" / "1. item" with one space (Turndown's own rule writes "-   item", which made list
  // indents grow every time the preview was edited). Nested lists are indented to the text.
  turndownService.addRule('compactListItem', {
    filter: 'li',
    replacement: (content, node) => {
      let prefix = '- ';
      const parent = node.parentNode;
      if (parent.nodeName === 'OL') {
        const start = parent.getAttribute('start');
        const index = Array.prototype.indexOf.call(parent.children, node);
        prefix = (start ? Number(start) + index : index + 1) + '. ';
      }
      const isParagraph = /\n$/.test(content);
      content = content.replace(/^\n+/, '').replace(/\n+$/, '') + (isParagraph ? '\n' : '');
      content = content.replace(/\n/gm, '\n' + ' '.repeat(prefix.length));
      return prefix + content + (node.nextSibling ? '\n' : '');
    },
  });
  turndownService.addRule('underline', {
    filter: ['u'],
    replacement: (content) => '<u>' + content + '</u>',
  });
  // Pictures shown through the local image server keep the path written in the Markdown.
  turndownService.addRule('localImage', {
    filter: (node) => node.nodeName === 'IMG' && node.hasAttribute('data-md-src'),
    replacement: (content, node) => {
      const alt = (node.getAttribute('alt') || '').replace(/[[\]]/g, '');
      const title = node.getAttribute('title');
      return '![' + alt + '](' + node.getAttribute('data-md-src') + (title ? ' "' + title.replace(/"/g, '\\"') + '"' : '') + ')';
    },
  });
  // A bare link in the source (https://... on its own) stays bare, instead of becoming
  // [https://...](https://...) whenever the preview is edited. If its text was edited in the
  // preview, the edited text is the link.
  turndownService.addRule('bareLink', {
    filter: (node) => node.nodeName === 'A' && node.hasAttribute('data-bare'),
    replacement: (content, node) => {
      const t = node.textContent.trim();
      return /^(https?:\/\/|www\.)\S+$/i.test(t) || /^[^\s@]+@[^\s@]+$/.test(t) ? t : content;
    },
  });
  // HTML the preview refused to show (scripts, frames...) goes back into the Markdown unchanged.
  turndownService.addRule('keptRawHtml', {
    // (also an empty element the sanitiser had to clean, e.g. an <img> that lost an onerror)
    filter: (node) => node.hasAttribute && node.hasAttribute('data-np-raw') && (node.nodeName === 'WBR' || !node.firstChild),
    // (SVG and MathML blocks, see previewHtmlForMarkdown(), get blank lines round them)
    replacement: (content, node) => {
      const raw = npRawDecode(node.getAttribute('data-np-raw'));
      return node.hasAttribute('data-np-block') ? '\n\n' + raw + '\n\n' : raw;
    },
  });
  turndownService.addRule('codeCopyButton', {
    filter: (node) => node.nodeName === 'BUTTON' && node.classList.contains('code-copy-btn'),
    replacement: () => '',
  });
}

/* ---------- helpers ---------- */

function escapeHtml(s) {
  return s.replace(/[&<>]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;' }[c]));
}

function escapeRegExp(s) {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function basename(p) {
  return p.replace(/\\/g, '/').split('/').pop();
}

function samePath(a, b) {
  return a.replace(/\//g, '\\').toLowerCase() === b.replace(/\//g, '\\').toLowerCase();
}

function normalizeEol(text) {
  const eol = /\r\n/.test(text) ? 'crlf' : 'lf';
  return { text: text.replace(/\r\n?/g, '\n'), eol };
}

function tabTitle(doc) {
  if (doc.path) return basename(doc.path);
  if (doc.customTitle) return doc.customTitle;
  return 'Untitled' + (doc.untitledNum > 1 ? ' ' + doc.untitledNum : '');
}

function getActive() {
  return docs.find((d) => d.id === activeId);
}

/**
 * savedContent is what's on disk (or '' for a new document); dirty = content differs from it,
 * so undoing back to the saved text clears the unsaved marker again.
 */
function makeDoc(path, content, opts = {}) {
  docCounter++;
  const lang = opts.lang || langForPath(path);
  // Settings > New tabs > Default view applies to new tabs and to Markdown/text/BBCode files;
  // code and config files always open in Edit Only.
  if (!opts.layoutMode && (LANGS[lang] || LANGS.plaintext).prose && settings.newTabView !== 'same') opts.layoutMode = settings.newTabView;
  const doc = {
    id: 'doc' + docCounter,
    path: path || null,
    content: content || '',
    savedContent: opts.savedContent !== undefined ? opts.savedContent : path ? content || '' : '',
    dirty: false,
    pinned: !!opts.pinned,
    lang,
    // true when the user picked the language/preview mode instead of it coming from the extension
    langOverride: !!opts.langOverride,
    layoutMode: opts.layoutMode || defaultLayoutFor(lang),
    fontSize: opts.fontSize || settings.newTabFontSize,
    bookmarks: opts.bookmarks || {},
    encoding: opts.encoding || 'utf8',
    eol: opts.eol || 'lf',
    view: null, // remembered scroll/selection when switching tabs
    customTitle: opts.customTitle || null, // an untitled tab the user renamed
  };
  doc.lastContent = doc.content;
  if (!doc.path) {
    // A new document takes the lowest number no open tab is using.
    doc.untitledNum = opts.untitledNum || lowestFreeUntitledNum(docs);
  }
  doc.dirty = doc.content !== doc.savedContent;
  return doc;
}

function lowestFreeUntitledNum(list) {
  const used = new Set(list.filter((d) => !d.path).map((d) => d.untitledNum));
  let n = 1;
  while (used.has(n)) n++;
  return n;
}

/** A new empty tab, with the caret in it ready to type (+ tab, Ctrl+N, File > New, double-click). */
function openNewTab() {
  addDocAndActivate(newUntitledDoc());
  focusForTyping();
}

/**
 * Puts the keyboard focus where typing goes for the active tab: the editor, or the preview in
 * Preview Only (Markdown previews are editable). Done again a moment later because a menu or
 * button can take the focus back as it closes.
 */
function focusForTyping() {
  const go = () => {
    const doc = getActive();
    if (!doc) return;
    if (layoutMode === 'preview-only' && preview.getAttribute('contenteditable') !== 'false') {
      if (document.activeElement !== preview) {
        const keepTop = preview.scrollTop;
        preview.focus({ preventScroll: true });
        // After a view switch: the caret where the editor caret was. Otherwise (a new, empty tab): the end.
        if (!takePendingPreviewCaret(doc)) {
          const sel = window.getSelection();
          const range = document.createRange();
          range.selectNodeContents(preview);
          range.collapse(false);
          sel.removeAllRanges();
          sel.addRange(range);
        }
        if (doc.content) preview.scrollTop = keepTop; // placing the caret must not move the view
      }
    } else if (layoutMode !== 'preview-only' && !editorHasFocus()) {
      editor.focus();
    }
  };
  go();
  setTimeout(go, 60);
}

function newUntitledDoc() {
  const active = getActive();
  let layout = settings.newTabView;
  if (layout === 'same') layout = active ? active.layoutMode : 'preview-only';
  // Settings > Default new tab format; the tab keeps it (saved with the session) whatever the setting says later.
  return makeDoc(null, '', { layoutMode: layout, lang: settings.newTabFormat === 'plaintext' ? 'plaintext' : 'markdown' });
}

/* ---------- theme ---------- */

function applyTheme() {
  syncMenuChecks();
  const mode = themeOverride || (window.matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light');
  document.documentElement.setAttribute('data-theme', mode);
  statusTheme.textContent = mode === 'dark' ? 'Dark' : 'Light';
}

const lastActionAt = {};
function debounceAction(key, ms = 250) {
  const now = Date.now();
  if (lastActionAt[key] && now - lastActionAt[key] < ms) return false;
  lastActionAt[key] = now;
  return true;
}

function toggleTheme() {
  if (!debounceAction('toggle-theme')) return;
  const current = document.documentElement.getAttribute('data-theme');
  themeOverride = current === 'dark' ? 'light' : 'dark';
  applyTheme();
  scheduleSessionSave();
}

/* ---------- font size (per tab) ---------- */

function applyFontSize() {
  const doc = getActive();
  // A tab's zoom is its size relative to the 100% size; the editor and preview each scale their
  // own default size (Settings > Editor / Preview > Font size) by it.
  const zoom = (doc ? doc.fontSize : settings.newTabFontSize) / settings.newTabFontSize;
  const px = (n) => Math.round(n * zoom * 10) / 10;
  const edit = px(settings.editFontSize);
  const prev = px(settings.previewFontSize);
  document.documentElement.style.setProperty('--content-font-size', edit + 'px');
  document.documentElement.style.setProperty('--preview-font-size', prev + 'px');
  if (editor.isCodeMirror && editor.api) editor.api.view.requestMeasure(); // line heights changed
  statusZoom.textContent = Math.round(zoom * 100) + '%';
  statusZoom.title = 'Editor ' + edit + 'px, preview ' + prev + 'px · Ctrl+wheel or Ctrl++ / Ctrl+- to zoom this tab, Ctrl+0 (or click) to reset';
}

/** Zooms the active tab only; every tab keeps its own size. */
function changeFontSize(delta) {
  const doc = getActive();
  if (!doc) return;
  doc.fontSize = Math.min(MAX_FONT_SIZE, Math.max(MIN_FONT_SIZE, doc.fontSize + delta));
  applyFontSize();
  updateLineNumbers();
  scheduleOverlay();
  scheduleSessionSave();
}

function resetFontSize() {
  const doc = getActive();
  if (!doc) return;
  changeFontSize(settings.newTabFontSize - doc.fontSize);
}

/* ---------- layout modes (per tab) ---------- */

const layoutLabels = {
  'preview-only': 'Preview Only',
  'edit-only': 'Edit Only',
  'split-pe': 'Preview Left / Edit Right',
  'split-ep': 'Edit Left / Preview Right',
};

function previewVisible() {
  return layoutMode !== 'edit-only';
}

function applyLayout(mode) {
  syncMenuChecks();
  layoutMode = mode;
  editorPane.style.flexBasis = '';
  previewPane.style.flexBasis = '';
  workspace.className = 'workspace mode-' + mode;
  if (mode === 'split-pe' || mode === 'split-ep') applySplit();
  statusLayout.textContent = layoutLabels[mode];
  sidebarEl.querySelectorAll('button[data-layout]').forEach((b) => b.classList.toggle('active', b.dataset.layout === mode));
  if (previewStale && previewVisible()) {
    const doc = getActive();
    if (doc) renderPreview(doc);
  }
  editorHighlight.scrollTop = editor.scrollTop;
}

/** Changes the layout of the active tab only; other tabs keep their own. */
function setLayoutMode(mode) {
  // Switching view keeps the same part of the document in view (position-sync.js).
  changeViewKeepingPlace(mode, () => {
    const doc = getActive();
    if (doc) doc.layoutMode = mode;
    applyLayout(mode);
    if (typeof refreshPreviewFindHighlights === 'function') refreshPreviewFindHighlights(false);
    scheduleSessionSave();
  });
}

function applySplit() {
  const leftPercent = splitRatio * 100;
  const rightPercent = 100 - leftPercent;
  if (layoutMode === 'split-pe') {
    previewPane.style.flexBasis = leftPercent + '%';
    editorPane.style.flexBasis = rightPercent + '%';
  } else if (layoutMode === 'split-ep') {
    editorPane.style.flexBasis = leftPercent + '%';
    previewPane.style.flexBasis = rightPercent + '%';
  }
}

function setupResizer() {
  let dragging = false;
  resizer.addEventListener('mousedown', (e) => {
    dragging = true;
    resizer.classList.add('dragging');
    e.preventDefault();
  });
  window.addEventListener('mousemove', (e) => {
    if (!dragging) return;
    const rect = workspace.getBoundingClientRect();
    let ratio = (e.clientX - rect.left) / rect.width;
    ratio = Math.min(0.85, Math.max(0.15, ratio));
    splitRatio = ratio;
    applySplit();
  });
  window.addEventListener('mouseup', () => {
    if (dragging) {
      dragging = false;
      resizer.classList.remove('dragging');
      scheduleSessionSave();
    }
  });
}

/* ---------- toolbar / line numbers ---------- */

function setToolbarVisible(visible) {
  syncMenuChecks();
  toolbarEl.classList.toggle('hidden', !visible);
}

function toggleToolbar() {
  if (!debounceAction('toggle-toolbar')) return;
  setToolbarVisible(toolbarEl.classList.contains('hidden'));
  scheduleSessionSave();
}

function setLineNumbersVisible(visible) {
  syncMenuChecks();
  lineNumbersVisible = visible;
  lineNumbersPreviewEl.classList.add('hidden'); // line numbers belong to the editor only, not the preview
  if (editor.isCodeMirror) {
    editor.api.setLineNumbers(visible); // CodeMirror's own gutter
    return;
  }
  lineNumbersEl.classList.toggle('hidden', !visible);
  updateLineNumbers();
  scheduleOverlay(); // with word wrap, the gutter follows the coloured layer's line blocks
}

function toggleLineNumbers() {
  if (!debounceAction('toggle-line-numbers')) return;
  setLineNumbersVisible(!lineNumbersVisible);
  scheduleSessionSave();
}

/* ---------- the gutter: line numbers and the bookmark margin ----------
 * Only the rows in view are drawn, each placed at its line's real position. With word wrap on,
 * the positions come from the coloured layer (one block per line), so a wrapped line's number
 * stays beside it. The margin to the right of the numbers shows bookmarks in their colour: a click
 * there adds one in the current bookmark colour (or removes it), a right-click picks the colour. */

let gutterCount = 1;

/** The coloured layer must hold one block per line: the gutter follows wrapped lines with it, and hidden characters are drawn in it. */
function overlayNeedsLines() {
  return !!settings.showHidden || (lineNumbersVisible && !!settings.wordWrap);
}

/** After the text changed: recount the lines and redraw the rows in view. */
function updateLineNumbers() {
  if (!lineNumbersVisible || editor.isCodeMirror) return;
  wrapTextVersion++;
  let count = 1;
  const v = editor.value;
  for (let i = v.indexOf('\n'); i !== -1; i = v.indexOf('\n', i + 1)) count++;
  gutterCount = count;
  // Exactly as wide as the biggest number: no empty space in short files, and 5- and 6-digit numbers aren't cut off.
  const digits = String(count).length;
  if (lineNumbersEl.dataset.digits !== String(digits)) {
    lineNumbersEl.dataset.digits = String(digits);
    lineNumbersEl.style.width = 'calc(' + digits + 'ch + 12px + var(--bm-margin) + var(--diag-margin, 0px))';
  }
  renderGutter();
}

let gutterFrame = 0;
function scheduleGutter() {
  if (!lineNumbersVisible || gutterFrame || editor.isCodeMirror) return;
  gutterFrame = requestAnimationFrame(() => {
    gutterFrame = 0;
    renderGutter();
  });
}

/** Top and height (relative to the gutter) of each line in view: [{ line, top, height }]. */
function gutterRowsInView() {
  const box = lineNumbersEl.getBoundingClientRect();
  const height = box.height || editor.clientHeight;
  const out = [];
  const kids = editorHighlight.children;
  const layered = settings.wordWrap && !editorHighlight.classList.contains('hidden') && kids.length === gutterCount && kids[0] && kids[0].classList.contains('ovl');
  if (layered) {
    // Wrapped lines have different heights: find the first line in view, then walk down.
    let lo = 0;
    let hi = gutterCount - 1;
    while (lo < hi) {
      const mid = (lo + hi) >> 1;
      if (kids[mid].getBoundingClientRect().bottom - box.top <= 0) lo = mid + 1;
      else hi = mid;
    }
    for (let i = lo; i < gutterCount; i++) {
      const r = kids[i].getBoundingClientRect();
      const top = r.top - box.top;
      if (top > height) break;
      out.push({ line: i, top, height: r.height });
    }
    return out;
  }
  const cs = getComputedStyle(editor);
  const lh = parseFloat(cs.lineHeight) || 21;
  const pad = parseFloat(cs.paddingTop) || 0;
  const shift = editor.getBoundingClientRect().top - box.top + pad - editor.scrollTop;
  const wrap = settings.wordWrap ? wrapLayout() : null;
  if (wrap) {
    // A file too big for the coloured layer, with word wrap on: where each line starts comes from
    // working out how the editor wraps it (wrapLayout), so a wrapped line still gets one number.
    const first = wrap.lineAtRow(Math.max(0, -shift / lh));
    for (let i = first; i < gutterCount; i++) {
      const top = shift + wrap.rowOf(i) * lh;
      if (top > height) break;
      out.push({ line: i, top, height: (wrap.rowOf(i + 1) - wrap.rowOf(i)) * lh });
    }
    return out;
  }
  const first = Math.max(0, Math.floor(-shift / lh));
  for (let i = first; i < gutterCount; i++) {
    const top = shift + i * lh;
    if (top > height) break;
    out.push({ line: i, top, height: lh });
  }
  return out;
}

/* ---------- where wrapped lines start, without the coloured layer (very big files) ----------
 * The editor's textarea doesn't tell where its lines wrap. For files the coloured layer can't
 * hold, each line's rows are worked out the way the textarea wraps (pre-wrap: at spaces, and
 * inside a word only when the word alone is wider than the line), with the monospace character
 * width measured from the editor's font. The total is checked against the textarea's real height
 * and any small difference (a character drawn wider than the rest) is spread evenly, so the
 * numbers can't drift away from their lines. Worked out again when the text, width or font change;
 * while typing in a huge file, at most a few times a second. */

let wrapCache = null; // { key, version, at, rows: Float64Array (row where each line starts, then the total) }
let wrapTextVersion = 0; // bumped by updateLineNumbers() when the text changes
let wrapCanvas = null;

function lineRowsFor(text, cols, tab) {
  if (text.length <= cols && text.indexOf('\t') < 0) return 1;
  let rows = 1;
  let col = 0;
  let i = 0;
  const n = text.length;
  while (i < n) {
    const c = text[i];
    if (c === ' ' || c === '\t') {
      // Spaces (and tabs) can run past the edge without wrapping; the next word then starts a new row.
      if (c === '\t') col = (Math.floor(col / tab) + 1) * tab;
      else col++;
      i++;
      continue;
    }
    let j = i;
    while (j < n && text[j] !== ' ' && text[j] !== '\t') j++;
    let w = j - i;
    if (col > 0 && col + w > cols) {
      rows++;
      col = 0;
    }
    while (col + w > cols) {
      // A word longer than the line is broken where the line ends.
      w -= cols - col;
      rows++;
      col = 0;
    }
    col += w;
    i = j;
  }
  return rows;
}

function wrapLayout() {
  const v = editor.value;
  const cs = getComputedStyle(editor);
  const width = editor.clientWidth - (parseFloat(cs.paddingLeft) || 0) - (parseFloat(cs.paddingRight) || 0);
  if (width <= 0) return null;
  const geom = width + '|' + cs.font + '|' + cs.tabSize;
  const now = performance.now();
  if (wrapCache && wrapCache.geom === geom) {
    if (wrapCache.version === wrapTextVersion) return wrapCache;
    // Typing in a huge file: keep the layout from a moment ago, redo it shortly.
    if (now - wrapCache.at < 400) {
      clearTimeout(wrapLayout.timer);
      wrapLayout.timer = setTimeout(scheduleGutter, 420);
      return wrapCache;
    }
  }
  if (!wrapCanvas) wrapCanvas = document.createElement('canvas').getContext('2d');
  wrapCanvas.font = cs.font;
  const charW = wrapCanvas.measureText('0123456789'.repeat(10)).width / 100 || 8;
  const cols = Math.max(1, Math.floor((width + 0.5) / charW));
  const tab = parseInt(cs.tabSize, 10) || 4;
  const lines = v.split('\n');
  const rows = new Float64Array(lines.length + 1);
  let total = 0;
  for (let k = 0; k < lines.length; k++) {
    rows[k] = total;
    total += lineRowsFor(lines[k], cols, tab);
  }
  rows[lines.length] = total;
  // Spread any difference with the textarea's real height evenly (it can't drift then).
  const lh = parseFloat(cs.lineHeight) || 21;
  const real = (editor.scrollHeight - (parseFloat(cs.paddingTop) || 0) - (parseFloat(cs.paddingBottom) || 0)) / lh;
  const scale = total > 0 && real > 0 && Math.abs(real - total) / total < 0.2 ? real / total : 1;
  if (scale !== 1) for (let k = 0; k <= lines.length; k++) rows[k] *= scale;
  wrapCache = {
    geom,
    version: wrapTextVersion,
    at: now,
    rows,
    rowOf: (line) => rows[Math.max(0, Math.min(line, rows.length - 1))],
    lineAtRow: (row) => {
      let lo = 0;
      let hi = rows.length - 2;
      while (lo < hi) {
        const mid = (lo + hi + 1) >> 1;
        if (rows[mid] <= row) lo = mid;
        else hi = mid - 1;
      }
      return Math.max(0, lo);
    },
  };
  return wrapCache;
}

function renderGutter() {
  if (!lineNumbersVisible || editor.isCodeMirror) return;
  const doc = getActive();
  const bms = (doc && doc.bookmarks) || {};
  // Syntax problems get a marker left of the number (room kept for checked languages, so nothing shifts).
  const diagCol = !!doc && gutterHasDiagColumn(doc);
  const dm = diagCol ? '15px' : '0px';
  if (lineNumbersEl.style.getPropertyValue('--diag-margin') !== dm) lineNumbersEl.style.setProperty('--diag-margin', dm);
  const diags = diagCol ? diagnosticLines(doc) : new Map();
  const html = [];
  for (const r of gutterRowsInView()) {
    const bm = bms[r.line];
    const cls = bm ? ' bm-' + bm.toLowerCase() : '';
    const d = diags.get(r.line);
    html.push(
      '<div class="ln-row' + (bm ? ' ln-bm' + cls : '') + '" data-l="' + r.line + '" style="top:' + r.top.toFixed(1) + 'px;height:' + r.height.toFixed(1) + 'px">' +
        (d ? '<span class="ln-d ' + d + '" aria-label="' + d + '"></span>' : '') +
        '<span class="ln-n">' + (r.line + 1) + '</span><span class="ln-m' + cls + '"></span></div>'
    );
  }
  lineNumbersEl.innerHTML = html.join('');
  const colour = (settings.bookmarkColour || 'Green').toLowerCase();
  if (lineNumbersEl.dataset.colour !== colour) lineNumbersEl.dataset.colour = colour;
}

/** The line a mouse event in the gutter points at (null below the last line). */
function gutterLineAt(e) {
  const row = e.target.closest && e.target.closest('.ln-row');
  if (row) return Number(row.dataset.l);
  for (const r of gutterRowsInView()) {
    const y = e.clientY - lineNumbersEl.getBoundingClientRect().top;
    if (y >= r.top && y < r.top + r.height) return r.line;
  }
  return null;
}

// The last plain click in the bookmark margin (a Shift+click then applies the same to a range).
let gutterAnchor = null;

/** A click in the bookmark margin beside `line` (0-based). Shift+click: every line from the last
 *  click to this one gets what that click did (bookmarked in its colour, or bookmark removed). */
function bookmarkMarginClick(doc, line, shift) {
  if (shift && gutterAnchor && gutterAnchor.docId === doc.id) {
    const lo = Math.min(gutterAnchor.line, line);
    const hi = Math.max(gutterAnchor.line, line);
    const lines = [];
    for (let l = lo; l <= hi; l++) lines.push(l);
    setBookmarks(doc, lines, gutterAnchor.colour);
    flashFindStatus((gutterAnchor.colour ? 'Bookmarked' : 'Removed bookmarks from') + ' lines ' + (lo + 1) + '–' + (hi + 1) + '.');
    return;
  }
  const colour = bookmarkOf(doc, line) ? null : settings.bookmarkColour;
  setBookmarks(doc, [line], colour);
  gutterAnchor = { docId: doc.id, line, colour };
}

/* The elements that show the editor's text, colours and line numbers, in either editor (the
   textarea + coloured layer + gutter, or CodeMirror). Used by checks and the tests. */
function edTextEl() {
  return editor.isCodeMirror ? editor.api.view.contentDOM : editor;
}
function edLayer() {
  return editor.isCodeMirror ? editor.api.view.contentDOM : editorHighlight;
}
function edGutterEl() {
  return editor.isCodeMirror ? editor.api.view.dom.querySelector('.cm-gutters') : lineNumbersEl;
}
/** The gutter elements of `line` (0-based) in view: { number, margin, diag } (or null). */
function edGutterRow(line) {
  if (!editor.isCodeMirror) {
    renderGutter();
    const row = lineNumbersEl.querySelector('.ln-row[data-l="' + line + '"]');
    return row && { number: row.querySelector('.ln-n'), margin: row.querySelector('.ln-m'), diag: row.querySelector('.ln-d') };
  }
  const v = editor.api.view;
  if (line >= v.state.doc.lines) return null;
  const top = v.documentTop + v.lineBlockAt(v.state.doc.line(line + 1).from).top;
  const pick = (gutter) =>
    [...v.dom.querySelectorAll(gutter + ' .cm-gutterElement')].find((el) => el.offsetHeight > 0 && Math.abs(el.getBoundingClientRect().top - top) < 2) || null;
  const number = pick('.cm-lineNumbers');
  if (!number) return null;
  const margin = pick('.cm-np-bookmarks');
  const diag = pick('.cm-np-diag');
  return { number, margin: margin && (margin.querySelector('.cm-np-bm') || margin), diag: diag && diag.querySelector('.np-d') };
}
/** Screen point at the middle of a line's number ('number') or bookmark margin ('margin'). */
function edGutterPoint(line, part) {
  const r = edGutterRow(line);
  const el = r && (part === 'margin' ? r.margin : r.number);
  if (!el) return null;
  const b = el.getBoundingClientRect();
  return { x: Math.round(b.left + b.width / 2), y: Math.round(b.top + Math.min(b.height, 20) / 2) };
}

/* What the CodeMirror editor asks the app for (editor-codemirror.js). */

/** The marks to draw (find hits, bookmarked lines, Go to Line, problems), or null while the
 *  app's copy of the text is behind the editor's (they are moved with the edit until then). */
function npAppDecorations() {
  const d = getActive();
  if (!d || editor.value !== d.content) return null;
  return editorDecorations(d);
}
/** Which per-line marks to draw: links, indent guides, hidden characters, spelling. */
function npTextMarks() {
  const d = getActive();
  if (!d) return null;
  const info = langInfo(d);
  return {
    links: true,
    indent: true,
    hidden: settings.showHidden ? { eol: d.eol, bom: /bom|utf16/.test(d.encoding || '') } : null,
    // Only the lines in view are checked, so any size can be (the old editor stopped at 150 KB).
    spell: !!(spell.enabled && editorSpellChecks(d)),
  };
}
/** Map(line -> 'error' | 'warning' | 'info') for the problem margin, or null when it has no column. */
function npDiagLines() {
  const d = getActive();
  return d && gutterHasDiagColumn(d) ? diagnosticLines(d) : null;
}
/** [[line (0-based), colour], ...] of the active tab's bookmarks. */
function npBookmarkLines() {
  const d = getActive();
  return d && d.bookmarks ? Object.entries(d.bookmarks).map(([l, c]) => [Number(l), c]) : [];
}
function npGutterBookmarkClick(line, shift) {
  const d = getActive();
  if (d) bookmarkMarginClick(d, line, shift);
}
function npGutterNumberClick(line) {
  const d = getActive();
  if (d) lineNumberClick(d, line);
}
function npGutterMenu(line, x, y) {
  const d = getActive();
  if (d) showBookmarkMarginMenu(x, y, d, line);
}

/** A click on a line number: selects the whole line. */
function lineNumberClick(doc, line) {
  const c = lineIndex(doc);
  if (line >= c.starts.length) return;
  const end = line + 1 < c.starts.length ? c.starts[line + 1] : doc.content.length;
  editor.focus();
  editor.setSelectionRange(c.starts[line], end);
  updateStatusBar();
}

function wireGutter() {
  lineNumbersEl.addEventListener('mousedown', (e) => {
    if (e.button !== 0) return;
    e.preventDefault(); // keep the caret where it is
    const line = gutterLineAt(e);
    const doc = getActive();
    if (line === null || !doc) return;
    if (e.target.closest('.ln-m') || e.clientX >= lineNumbersEl.getBoundingClientRect().right - 20) bookmarkMarginClick(doc, line, e.shiftKey);
    else lineNumberClick(doc, line);
  });
  lineNumbersEl.addEventListener('contextmenu', (e) => {
    e.preventDefault();
    const line = gutterLineAt(e);
    const doc = getActive();
    if (line === null || !doc) return;
    showBookmarkMarginMenu(e.clientX, e.clientY, doc, line);
  });
  lineNumbersEl.addEventListener('wheel', (e) => {
    editor.scrollTop += e.deltaY;
  }, { passive: true });
  if (window.ResizeObserver) new ResizeObserver(() => scheduleGutter()).observe(editor.host || editor);
}

/* ---------- syntax highlighting ---------- */

const HIGHLIGHT_MAX_CHARS = 300000; // above this the editor falls back to plain text
const SPELL_MAX_CHARS = 150000;

function highlightCode(text, grammar) {
  if (grammar && window.hljs && hljs.getLanguage(grammar)) {
    try {
      return hljs.highlight(text, { language: grammar, ignoreIllegals: true }).value;
    } catch (e) {
      /* fall through */
    }
  }
  return escapeHtml(text);
}

let overlayFrame = 0;
function scheduleOverlay() {
  if (overlayFrame) return;
  overlayFrame = requestAnimationFrame(() => {
    overlayFrame = 0;
    renderEditorOverlay();
  });
}

/**
 * The editor is a transparent-text <textarea> over a <pre> that shows the same text coloured
 * (syntax), underlined (spelling) and marked (find hits, bookmarks). Both use identical
 * font/padding/wrapping so they line up exactly.
 */
function renderEditorOverlay() {
  if (overlayFrame) {
    cancelAnimationFrame(overlayFrame);
    overlayFrame = 0;
  }
  // CodeMirror draws its own text: colours and marks are its decorations (editor-codemirror.js).
  if (editor.isCodeMirror) {
    const d = getActive();
    if (editor.api && d) {
      // The problem margin keeps its room for checked languages, so nothing shifts while typing.
      editor.host.classList.toggle('np-diagcol', gutterHasDiagColumn(d));
      editor.api.setLanguage(langInfo(d).hljs || null);
      editor.api.refreshMarks();
    }
    return;
  }
  const doc = getActive();
  const text = editor.value;
  if (text.length > HIGHLIGHT_MAX_CHARS) {
    // Big file: coloured in the background once typing pauses (extras.js). Decided before
    // scanning the whole text on every keystroke.
    renderLargeOverlay(doc, text, langInfo(doc));
    return;
  }
  lazyShown = null;
  clearTimeout(lazyTimer);
  const info = langInfo(doc);
  const wantSpell = spell.enabled && editorSpellChecks(doc) && text.length <= SPELL_MAX_CHARS;
  const decos = doc && text === doc.content ? editorDecorations(doc) : [];
  const hasIndent = /(^|\n)[ \t]/.test(text);
  const hasUrl = URL_RE_TEST.test(text);
  const useOverlay = !!doc && text.length <= HIGHLIGHT_MAX_CHARS && (!!info.hljs || wantSpell || decos.length > 0 || hasIndent || hasUrl || overlayNeedsLines());
  editor.classList.toggle('hl-active', useOverlay);
  editorHighlight.classList.toggle('hidden', !useOverlay);
  if (!useOverlay) {
    editorHighlight.innerHTML = '';
    resetOverlayLines();
    return;
  }
  const html = info.hljs ? highlightCode(text, info.hljs) : escapeHtml(text);
  const urls = hasUrl ? urlRanges(text) : [];
  const lists = urls.length ? [...decos, urls] : decos;
  const kept = doc.overlayStash;
  if (kept) {
    // Back on this tab: start from the layer kept for it (only changed lines are redone).
    doc.overlayStash = null;
    if (kept.text === text) {
      editorHighlight.replaceChildren(kept.frag);
      overlayState = kept.state;
    }
  }
  patchOverlayLines(doc, text, splitHtmlLines(html), lists, urls, wantSpell, hasIndent);
  editorHighlight.scrollTop = editor.scrollTop;
}

/* ---------- the colour layer, line by line ----------
 * The coloured layer is one <span class="ovl"> per line. Each keystroke still colours the whole
 * text (the grammar needs it), but only lines whose result changed are decorated (spelling, links,
 * find hits, indent guides) and replaced in the page, so a 100 KB file no longer rebuilds
 * thousands of elements on every key. The text and layout are exactly what they were before. */

let overlayState = null; // { gen, keys, unchecked, spellGen }
let overlaySpellGen = 0; // bumps when spelling answers arrive (lines with unchecked words redo)
let overlayUnknownWords = 0; // counts words looked up that the spellchecker has not answered yet

function resetOverlayLines() {
  overlayState = null;
  scheduleGutter();
}

/** Splits highlighted HTML into one balanced HTML string per line (spans closed and reopened at line ends). */
function splitHtmlLines(html) {
  const lines = [];
  const open = [];
  let start = 0;
  let prefix = '';
  const re = /<span[^>]*>|<\/span>|\n/g;
  let m;
  while ((m = re.exec(html))) {
    if (m[0] === '\n') {
      lines.push(prefix + html.slice(start, m.index) + '</span>'.repeat(open.length));
      prefix = open.join('');
      start = m.index + 1;
    } else if (m[0] === '</span>') open.pop();
    else open.push(m[0]);
  }
  lines.push(prefix + html.slice(start) + '</span>'.repeat(open.length));
  return lines;
}

function patchOverlayLines(doc, text, lines, lists, urls, wantSpell, hasIndent) {
  const n = lines.length;
  // Decorations (find hits, bookmarks, links...) that fall on each line, relative to its start.
  const ptr = lists.map(() => 0);
  const urlIdx = lists.indexOf(urls);
  const keys = new Array(n);
  const locals = new Array(n);
  let lineStart = 0;
  for (let i = 0; i < n; i++) {
    const nl = text.indexOf('\n', lineStart);
    const lineEnd = nl === -1 ? text.length : nl;
    let local = null;
    for (let li = 0; li < lists.length; li++) {
      const list = lists[li];
      while (ptr[li] < list.length && list[ptr[li]].e <= lineStart) ptr[li]++;
      for (let k = ptr[li]; k < list.length && list[k].s < lineEnd; k++) {
        const d = list[k];
        const s = Math.max(d.s, lineStart) - lineStart;
        const e = Math.min(d.e, lineEnd) - lineStart;
        if (e <= s) continue;
        if (!local) local = lists.map(() => []);
        local[li].push({ s, e, cls: d.cls, url: d.url });
      }
    }
    locals[i] = local;
    keys[i] = local ? lines[i] + '\u0001' + JSON.stringify(local) : lines[i];
    lineStart = lineEnd + 1;
  }
  // Hidden characters: the last line has no line ending to show, so it is redrawn when it stops being the last.
  const hidden = !!settings.showHidden;
  if (hidden && n) keys[n - 1] += '\u0002';

  // Anything that changes every line's decoration starts the layer afresh.
  const gen = [doc.id, wantSpell, spell.lang, spell.userWords.size, spell.ignored.size, hasIndent && (settings.tabSize || 4), hidden && 'hidden:' + doc.eol + ':' + doc.encoding].join('|');
  const kids = editorHighlight.children;
  const prev = overlayState && overlayState.gen === gen && kids.length === overlayState.keys.length ? overlayState : null;
  const oldKeys = prev ? prev.keys : [];
  const m = oldKeys.length;
  // A kept line is one with the same text and decorations, unless it had words still being checked.
  const keep = (i, j) => oldKeys[j] === keys[i] && !(prev.unchecked[j] && prev.spellGen !== overlaySpellGen);
  let p = 0;
  let s = 0;
  if (prev) {
    const max = Math.min(n, m);
    while (p < max && keep(p, p)) p++;
    while (s < max - p && keep(n - 1 - s, m - 1 - s)) s++;
  }

  const unchecked = new Array(n);
  const html = [];
  for (let i = p; i < n - s; i++) {
    let h = lines[i];
    const hits = overlayUnknownWords;
    if (wantSpell || locals[i]) {
      const loc = locals[i] ? locals[i].filter((l) => l.length) : [];
      h = decorateOverlay(h, loc, wantSpell, locals[i] && urlIdx >= 0 ? locals[i][urlIdx] : []);
    }
    unchecked[i] = overlayUnknownWords !== hits;
    if (hasIndent) h = addIndentGuides(h);
    if (hidden) h = markHiddenChars(h, i < n - 1 ? doc.eol : null, i === 0 && /bom|utf16/.test(doc.encoding || ''));
    html.push('<span class="ovl">' + h + '</span>');
  }
  const tpl = document.createElement('template');
  tpl.innerHTML = html.join('');
  // Each line ends with its own "\n" text node (the last line: " " after a trailing newline, like before).
  for (const el of tpl.content.children) el.appendChild(overlayLineEnd('\n'));
  if (prev) {
    for (let i = 0; i < p; i++) unchecked[i] = prev.unchecked[i];
    for (let k = 1; k <= s; k++) unchecked[n - k] = prev.unchecked[m - k];
    for (let k = m - s - p; k > 0; k--) kids[p].remove();
    editorHighlight.insertBefore(tpl.content, kids[p] || null);
  } else {
    editorHighlight.replaceChildren(tpl.content);
  }
  // Only a kept line that used to be the last one, and the new last line, can have the wrong
  // ending after lines were added or removed.
  if (p > 0 && p - 1 < n - 1) setOverlayLineEnd(kids[p - 1], '\n');
  if (kids.length >= 2) setOverlayLineEnd(kids[kids.length - 2], '\n');
  if (kids.length) setOverlayLineEnd(kids[kids.length - 1], text.endsWith('\n') ? ' ' : '');
  overlayState = { gen, keys, unchecked, spellGen: overlaySpellGen };
  scheduleGutter(); // wrapped lines may have changed height
}

function overlayLineEnd(t) {
  const node = document.createTextNode(t);
  node.__eol = true;
  return node;
}

function setOverlayLineEnd(el, want) {
  const tail = el.lastChild;
  const cur = tail && tail.__eol ? tail : null;
  if (cur && cur.nodeValue === want) return;
  if (cur) cur.remove();
  if (want) el.appendChild(overlayLineEnd(want));
}

/** Absolute text offset of a spelling span in the coloured layer (its data-o is relative to its line). */
function overlayOffsetOf(span) {
  if (editor.isCodeMirror) return editor.api.posAtDOM(span); // CodeMirror knows where its text is
  const line = span.closest('.ovl');
  const doc = getActive();
  if (!line || !doc) return Number(span.dataset.o);
  const idx = Array.prototype.indexOf.call(editorHighlight.children, line);
  return lineIndex(doc).starts[idx] + Number(span.dataset.o);
}

/* ---------- hidden characters (View > Show Hidden Characters, Ctrl+Shift+H) ----------
 * Drawn in the coloured layer without changing the width of anything, so the text still lines up:
 * spaces get a dot, tabs an arrow, spaces and tabs at the end of a line a red tint, each line its
 * ending (CRLF or LF), and characters you can't normally see (zero-width spaces, byte order marks,
 * control characters) a red bar with their code. Look-alike spaces (no-break space...) get an orange dot. */

const HC_ODD_SPACE = '   -   　';
const HC_INVISIBLE = '​-‏  ‪-‮⁠-⁤⁦-⁩﻿­᠎';
const HC_CONTROL = '\x00-\x08\x0B\x0C\x0E-\x1F\x7F-\x9F';
const HC_RE = new RegExp('( +)|(\\t)|([' + HC_ODD_SPACE + '])|([' + HC_INVISIBLE + HC_CONTROL + '])', 'g');
const HC_NAMES = {
  '200B': 'zero-width space',
  '200C': 'zero-width non-joiner',
  '200D': 'zero-width joiner',
  '200E': 'left-to-right mark',
  '200F': 'right-to-left mark',
  '2060': 'word joiner',
  FEFF: 'zero-width no-break space (BOM)',
  '00A0': 'no-break space',
  '00AD': 'soft hyphen',
  '202F': 'narrow no-break space',
};

function hcCode(ch) {
  return ch.charCodeAt(0).toString(16).toUpperCase().padStart(4, '0');
}

function markHiddenChars(html, eol, bom) {
  let out = html.replace(/<[^>]*>|[^<]+/g, (t) =>
    t[0] === '<'
      ? t
      : t.replace(/&nbsp;/g, ' ').replace(HC_RE, (m, sp, tab, odd) =>
          sp ? '<span class="hc-sp">' + sp + '</span>' : tab ? '<span class="hc-tab">\t</span>' : '<span class="' + (odd ? 'hc-nb' : 'hc-zw') + '" data-c="' + hcCode(m) + '">' + m + '</span>'
        )
  );
  // Spaces and tabs at the end of the line (inside any colouring spans that close there).
  out = out.replace(/((?:<span class="hc-(?:sp|tab)">[^<]*<\/span>)+)((?:<\/span>)*)$/, '<span class="hc-trail">$1</span>$2');
  if (bom) out = '<span class="hc-bom"></span>' + out;
  if (eol) out += '<span class="hc-eol" data-e="' + (eol === 'crlf' ? 'CRLF' : 'LF') + '"></span>';
  return out;
}

/** One-line report for the status bar when hidden characters are switched on. */
function hiddenCharSummary(doc) {
  if (!doc) return 'Hidden characters on';
  const text = doc.content;
  const parts = [(doc.eol === 'crlf' ? 'CRLF' : 'LF') + ' line endings'];
  if (/bom|utf16/.test(doc.encoding || '')) parts.push('byte order mark (BOM) at the start');
  const lines = text.split('\n');
  let trailing = 0;
  let firstTrailing = -1;
  const odd = new Map(); // code -> { n, line }
  const re = new RegExp('[' + HC_ODD_SPACE + HC_INVISIBLE + HC_CONTROL + ']', 'g');
  for (let i = 0; i < lines.length; i++) {
    const l = lines[i];
    if (/[ \t]$/.test(l)) {
      trailing++;
      if (firstTrailing < 0) firstTrailing = i;
    }
    re.lastIndex = 0;
    let m;
    while ((m = re.exec(l))) {
      const code = hcCode(m[0]);
      const e = odd.get(code) || { n: 0, line: i };
      e.n++;
      odd.set(code, e);
    }
  }
  if (trailing) parts.push(fmtCount(trailing) + ' line(s) end in spaces or tabs (first: line ' + fmtCount(firstTrailing + 1) + ')');
  for (const [code, e] of [...odd.entries()].slice(0, 3)) {
    parts.push(fmtCount(e.n) + ' × ' + (HC_NAMES[code] || 'U+' + code) + ' (U+' + code + ', first: line ' + fmtCount(e.line + 1) + ')');
  }
  if (odd.size > 3) parts.push('and ' + (odd.size - 3) + ' other kind(s)');
  if (!trailing && !odd.size) parts.push('no trailing spaces or invisible characters');
  const tooBig = text.length > LAZY_HIGHLIGHT_MAX ? ' (too large to draw them in the editor)' : '';
  return 'Hidden characters on' + tooBig + ': ' + parts.join(' · ');
}

/* ---------- indent guides and links in the editor ---------- */

const URL_RE_TEST = /https?:\/\/[^\s<>"]/;
const URL_RE = /https?:\/\/[^\s<>"'`]+/g;

/** Trailing punctuation is usually the sentence, not the link: "see https://x.com/a." */
function trimUrl(u) {
  const strip = (s) => s.replace(/[.,;:!?*_\]}>]+$/, '');
  let s = strip(u);
  // a ")" closes the link only if it has a matching "(" inside it (Wikipedia-style links)
  while (s.endsWith(')') && (s.match(/\(/g) || []).length < (s.match(/\)/g) || []).length) s = strip(s.slice(0, -1));
  return s;
}

/** Links in the text as decoration ranges (underlined in the coloured layer, never spell-checked). */
function urlRanges(text) {
  const out = [];
  URL_RE.lastIndex = 0;
  let m;
  while ((m = URL_RE.exec(text)) && out.length < 5000) {
    const url = trimUrl(m[0]);
    out.push({ s: m.index, e: m.index + url.length, cls: 'ov-url', url });
  }
  return out;
}

/** Faint vertical guides at each indent step of a line's leading spaces/tabs. */
function addIndentGuides(html) {
  const tw = settings.tabSize || 4;
  // the indent may sit just inside a colouring <span> that starts the line
  return html.replace(/(^|\n)((?:<span[^>]*>)*)([ \t]+)/g, (m, nl, tags, ws) => {
    let out = '';
    let unit = '';
    let col = 0;
    for (const ch of ws) {
      unit += ch;
      col = ch === '\t' ? (Math.floor(col / tw) + 1) * tw : col + 1;
      if (col % tw === 0) {
        out += '<span class="ig">' + unit + '</span>';
        unit = '';
      }
    }
    return nl + tags + out + unit;
  });
}

/** The link (if any) around character offset `pos` of the editor text. */
function urlAtOffset(text, pos) {
  const lineStart = text.lastIndexOf('\n', pos - 1) + 1;
  let lineEnd = text.indexOf('\n', pos);
  if (lineEnd === -1) lineEnd = text.length;
  const line = text.slice(lineStart, lineEnd);
  URL_RE.lastIndex = 0;
  let m;
  while ((m = URL_RE.exec(line))) {
    const url = trimUrl(m[0]);
    const s = lineStart + m.index;
    if (pos >= s && pos <= s + url.length) return url;
  }
  return null;
}

function openUrl(url) {
  noteVisitedLink(url);
  invoke('cmd_open_url', { url }).catch((e) => flashFindStatus('Could not open the link: ' + e));
}

/** "Save link as" for a link in the editor: pick a file, then download the link into it. */
async function saveLinkAs(url) {
  let name = 'download';
  try {
    const u = new URL(url);
    name = decodeURIComponent(u.pathname.split('/').filter(Boolean).pop() || u.hostname) || name;
  } catch (e) {
    /* keep the default */
  }
  name = name.replace(/[\\/:*?"<>|]/g, '_');
  if (!/\.[A-Za-z0-9]{1,8}$/.test(name)) name += '.html';
  const path = await dialogApi.save({ defaultPath: name, filters: [{ name: 'All Files', extensions: ['*'] }] });
  if (!path) return;
  flashFindStatus('Downloading ' + basename(path) + '...');
  try {
    const bytes = await invoke('cmd_download_url', { url, path });
    flashFindStatus('Saved ' + basename(path) + ' (' + (bytes >= 1048576 ? (bytes / 1048576).toFixed(1) + ' MB' : Math.max(1, Math.round(bytes / 1024)) + ' KB') + ')');
  } catch (e) {
    await dialogApi.message('Could not save the link:\n' + e, { title: 'Save Link As', kind: 'error' });
  }
}

/* ---------- Tab key ---------- */

/** Tab inserts a tab; with several lines selected, Tab / Shift+Tab indent / outdent them. */
function editorTabKey(outdent) {
  const value = editor.value;
  const start = editor.selectionStart;
  const end = editor.selectionEnd;
  const multi = value.slice(start, end).includes('\n');
  if (!multi && !outdent) {
    replaceEditorRange(start, end, '\t');
    return;
  }
  const lineStart = value.lastIndexOf('\n', start - 1) + 1;
  // a selection ending at the very start of a line doesn't include that line
  let blockEnd = end > start && value[end - 1] === '\n' ? end - 1 : end;
  let lineEnd = value.indexOf('\n', blockEnd);
  if (lineEnd === -1) lineEnd = value.length;
  const tw = settings.tabSize || 4;
  const lines = value.slice(lineStart, lineEnd).split('\n');
  const outdentRe = new RegExp('^(\\t| {1,' + tw + '})');
  const changed = lines.map((l) => (outdent ? l.replace(outdentRe, '') : l === '' ? l : '\t' + l)).join('\n');
  if (changed === lines.join('\n')) return;
  replaceEditorRange(lineStart, lineEnd, changed);
  if (multi) editor.setSelectionRange(lineStart, lineStart + changed.length);
  else {
    const caret = Math.max(lineStart, start - (lines[0].length - changed.split('\n')[0].length));
    editor.setSelectionRange(caret, caret);
  }
}

function selectionNode() {
  const sel = window.getSelection();
  if (!sel || !sel.rangeCount) return null;
  const n = sel.anchorNode;
  return n && n.nodeType === 1 ? n : n && n.parentElement;
}

function placeCaret(node, offset) {
  const sel = window.getSelection();
  const r = document.createRange();
  r.setStart(node, offset);
  r.collapse(true);
  sel.removeAllRanges();
  sel.addRange(r);
}

/** Moves a list item into / out of a nested list, keeping the caret where it was. */
function nestListItem(li, outdent) {
  const sel = window.getSelection();
  const saved = sel.rangeCount ? sel.getRangeAt(0).cloneRange() : null;
  const list = li.parentElement;
  if (!outdent) {
    const prev = li.previousElementSibling;
    if (!prev) return false;
    let sub = prev.lastElementChild;
    if (!sub || sub.nodeName !== list.nodeName) {
      sub = document.createElement(list.nodeName);
      prev.appendChild(sub);
    }
    sub.appendChild(li);
  } else {
    const parentLi = list.parentElement;
    if (!parentLi || parentLi.nodeName !== 'LI') return false;
    // items after this one become its children, so the order of the text doesn't change
    const after = [];
    for (let n = li.nextElementSibling; n; n = n.nextElementSibling) after.push(n);
    if (after.length) {
      const sub = document.createElement(list.nodeName);
      after.forEach((n) => sub.appendChild(n));
      li.appendChild(sub);
    }
    parentLi.parentElement.insertBefore(li, parentLi.nextSibling);
    if (!list.children.length) list.remove();
  }
  if (saved) {
    sel.removeAllRanges();
    sel.addRange(saved);
  }
  return true;
}

function previewTabKey(outdent) {
  const node = selectionNode();
  if (!node || !preview.contains(node)) return;
  const li = node.closest('li');
  if (li && preview.contains(li)) {
    if (nestListItem(li, outdent)) syncFromPreview();
    return;
  }
  if (!outdent) document.execCommand('insertText', false, '\t');
}

/* ---------- getting out of a code block in the preview ---------- */

/** Text of a <pre> before and after the caret. */
function preCaretSplit(pre) {
  const code = pre.querySelector('code') || pre;
  const sel = window.getSelection();
  const r = document.createRange();
  r.selectNodeContents(code);
  const full = r.toString();
  try {
    r.setEnd(sel.anchorNode, sel.anchorOffset);
  } catch (e) {
    return { before: full, after: '' };
  }
  const before = r.toString();
  return { before, after: full.slice(before.length) };
}

function paragraphBeside(block, before) {
  const p = document.createElement('p');
  p.appendChild(document.createElement('br'));
  block.parentNode.insertBefore(p, before ? block : block.nextSibling);
  placeCaret(p, 0);
  return p;
}

/** Links that were written as plain URLs / addresses (their text is the address). */
function markBareLinks() {
  preview.querySelectorAll('a[href]').forEach((a) => {
    const href = a.getAttribute('href');
    const t = a.textContent;
    if (t === href || 'mailto:' + t === href || 'http://' + t === href) a.setAttribute('data-bare', '');
  });
}

/** Blocks the caret can get stuck in when nothing editable follows them. */
function ensureTrailingParagraph() {
  const last = preview.lastElementChild;
  if (last && (last.nodeName === 'PRE' || last.nodeName === 'TABLE' || last.nodeName === 'BLOCKQUOTE')) {
    const p = document.createElement('p');
    p.appendChild(document.createElement('br'));
    preview.appendChild(p);
  }
}

/**
 * Arrow Down / Right at the end of a code block (or Up / Left at its start) leaves it, adding an
 * empty paragraph when nothing follows; Enter on an empty last line, or Ctrl+Enter, also leaves it.
 */
function handleCodeBlockKey(e) {
  if (e.altKey || e.metaKey || e.shiftKey) return false;
  const node = selectionNode();
  const pre = node && node.closest('pre');
  if (!pre || !preview.contains(pre)) return false;
  const sel = window.getSelection();
  if (!sel.isCollapsed) return false;
  const { before, after } = preCaretSplit(pre);
  const atEnd = after.replace(/\n$/, '') === '';
  const onLastLine = !after.replace(/\n$/, '').includes('\n');
  const atStart = before === '';
  const onFirstLine = !before.includes('\n');
  if (e.key === 'Enter' && (e.ctrlKey || (atEnd && /\n$/.test(before)))) {
    e.preventDefault();
    if (!e.ctrlKey) {
      // drop the empty line the first Enter added
      const code = pre.querySelector('code') || pre;
      code.textContent = before.replace(/\n$/, '');
      addCodeCopyButtons();
    }
    const next = pre.nextElementSibling;
    if (next && next.nodeName === 'P' && !next.textContent.trim()) placeCaret(next, 0);
    else paragraphBeside(pre, false);
    syncFromPreview();
    return true;
  }
  if (e.ctrlKey) return false;
  if ((e.key === 'ArrowDown' && onLastLine) || (e.key === 'ArrowRight' && atEnd)) {
    if (pre.nextElementSibling) return false; // the browser moves into it
    e.preventDefault();
    paragraphBeside(pre, false);
    return true;
  }
  if ((e.key === 'ArrowUp' && onFirstLine) || (e.key === 'ArrowLeft' && atStart)) {
    if (pre.previousElementSibling) return false;
    e.preventDefault();
    paragraphBeside(pre, true);
    return true;
  }
  return false;
}

function highlightPreviewCodeBlocks() {
  if (!window.hljs) return;
  preview.querySelectorAll('pre > code').forEach((code) => {
    const m = /language-([\w-]+)/.exec(code.className);
    if (!m) return;
    const key = EXT_LANG[m[1].toLowerCase()] ? LANGS[EXT_LANG[m[1].toLowerCase()]].hljs : m[1];
    if (!key || !hljs.getLanguage(key)) return;
    code.innerHTML = highlightCode(code.textContent, key);
    code.classList.add('hljs');
  });
}

/* ---------- spellcheck ---------- */

const WORD_RE = /[A-Za-zÀ-ɏ]+(?:['’][A-Za-zÀ-ɏ]+)*/g;
const URLISH_RE = /(?:https?:\/\/|www\.)\S+|[\w.+-]+@[\w-]+\.[\w.-]+|\S+\.(?:md|txt|js|py|json|html?|exe|dll|com|org|net|io)\b/gi;

const spell = {
  enabled: true,
  lang: 'en_GB',
  worker: null,
  cache: new Map(), // word -> true (ok) / false (misspelled), for the current language
  pending: new Set(),
  inflight: new Set(),
  userWords: new Set(), // persisted, lower-case
  ignored: new Set(), // this session only, lower-case
  timer: 0,
  reqId: 0,
  suggestWaiters: new Map(),
  previewRanges: [],
};

const SPELL_LANG_LABELS = { en_GB: 'English (UK)', en_US: 'English (US)' };

function initSpell() {
  try {
    spell.worker = new Worker('spell-worker.js');
    spell.worker.onmessage = onSpellMessage;
    spell.worker.postMessage({ type: 'load', lang: spell.lang });
  } catch (e) {
    console.error('Spellcheck unavailable', e);
    spell.worker = null;
  }
  updateSpellStatus();
}

function updateSpellStatus() {
  syncMenuChecks();
  statusSpell.textContent = spell.enabled ? SPELL_LANG_LABELS[spell.lang] : 'Spelling off';
  statusSpell.classList.toggle('off', !spell.enabled);
}

function refreshSpellEverywhere() {
  scheduleOverlay();
  schedulePreviewSpell(0);
}

function setSpellLang(lang) {
  if (!SPELL_LANG_LABELS[lang]) return;
  spell.enabled = true;
  if (lang !== spell.lang) {
    spell.lang = lang;
    spell.cache.clear();
    spell.pending.clear();
    spell.inflight.clear();
    if (spell.worker) spell.worker.postMessage({ type: 'load', lang });
  }
  updateSpellStatus();
  refreshSpellEverywhere();
  scheduleSessionSave();
}

function toggleSpell() {
  if (!debounceAction('toggle-spell')) return;
  spell.enabled = !spell.enabled;
  updateSpellStatus();
  refreshSpellEverywhere();
  scheduleSessionSave();
}

function onSpellMessage(e) {
  const m = e.data;
  if (m.type === 'suggestions') {
    const cb = spell.suggestWaiters.get(m.id);
    spell.suggestWaiters.delete(m.id);
    if (cb) cb(m.list || []);
    return;
  }
  if (m.lang !== spell.lang) return;
  if (m.type === 'checked') {
    for (const [w, ok] of Object.entries(m.results)) {
      spell.cache.set(w, ok);
      spell.inflight.delete(w);
    }
    overlaySpellGen++;
    refreshSpellEverywhere();
  } else if (m.type === 'error') {
    console.error('Spellcheck error:', m.message);
    const cb = spell.suggestWaiters.get(m.id);
    if (cb) {
      spell.suggestWaiters.delete(m.id);
      cb([]);
    }
  }
}

function scheduleSpellRequest() {
  if (spell.timer || !spell.worker) return;
  spell.timer = setTimeout(() => {
    spell.timer = 0;
    const words = [...spell.pending].filter((w) => !spell.inflight.has(w) && !spell.cache.has(w));
    spell.pending.clear();
    if (!words.length) return;
    words.forEach((w) => spell.inflight.add(w));
    spell.worker.postMessage({ type: 'check', id: ++spell.reqId, lang: spell.lang, words });
  }, 50);
}

function shouldCheckWord(w) {
  if (w.length < 2) return false;
  if (/^[A-ZÀ-Þ'’]+$/.test(w)) return false; // ACRONYMS
  if (/[a-z][A-Z]/.test(w)) return false; // camelCase / code identifiers
  return true;
}

function isMisspelled(raw) {
  const w = raw.replace(/’/g, "'");
  if (!shouldCheckWord(w)) return false;
  const lower = w.toLowerCase();
  if (spell.userWords.has(lower) || spell.ignored.has(lower)) return false;
  const known = spell.cache.get(w);
  if (known === undefined) {
    overlayUnknownWords++;
    spell.pending.add(w);
    scheduleSpellRequest();
    return false;
  }
  return !known;
}

/** Calls fn(match) for every checkable word in `text`, skipping URLs, e-mail addresses and file names. */
function forEachWord(text, fn) {
  const skip = [];
  URLISH_RE.lastIndex = 0;
  let u;
  while ((u = URLISH_RE.exec(text))) skip.push([u.index, u.index + u[0].length]);
  WORD_RE.lastIndex = 0;
  let m;
  while ((m = WORD_RE.exec(text))) {
    const start = m.index;
    if (skip.some(([a, b]) => start >= a && start < b)) continue;
    // Words glued to digits or underscores (e.g. abc123, my_var) are identifiers, not prose.
    const before = text[start - 1];
    const after = text[start + m[0].length];
    if ((before && /[\d_]/.test(before)) || (after && /[\d_]/.test(after))) continue;
    fn(m);
  }
}

// Code, URLs and markup tags (Markdown inline HTML, BBCode tags) are never spellchecked.
const SPELL_SKIP_EDITOR = /\bhljs-(code|link|symbol|meta|tag|name)\b/;

/**
 * Splits the highlighted editor HTML at the edges of spelling errors and of the decoration ranges
 * (find hits, bookmarked lines, ...), wrapping each piece in spans with the matching classes.
 * Spelling spans carry data-o (word offset) and data-w (word) for the right-click menu.
 */
function decorateOverlay(html, decoLists, wantSpell, noSpell = []) {
  const tpl = document.createElement('template');
  tpl.innerHTML = html;
  const walker = document.createTreeWalker(tpl.content, NodeFilter.SHOW_TEXT);
  const nodes = [];
  let n;
  while ((n = walker.nextNode())) nodes.push(n);
  const ptr = decoLists.map(() => 0);
  let offset = 0;
  for (const node of nodes) {
    const text = node.nodeValue;
    const base = offset;
    const end = base + text.length;
    offset = end;
    const local = [];
    decoLists.forEach((list, li) => {
      while (ptr[li] < list.length && list[ptr[li]].e <= base) ptr[li]++;
      for (let k = ptr[li]; k < list.length && list[k].s < end; k++) {
        const d = list[k];
        local.push({ s: Math.max(d.s, base) - base, e: Math.min(d.e, end) - base, cls: d.cls, url: d.url });
      }
    });
    if (wantSpell) {
      let skip = false;
      for (let el = node.parentElement; el; el = el.parentElement) {
        if (SPELL_SKIP_EDITOR.test(el.className)) {
          skip = true;
          break;
        }
      }
      if (!skip) {
        forEachWord(text, (m) => {
          if (isMisspelled(m[0]) && !noSpell.some((r) => base + m.index < r.e && base + m.index + m[0].length > r.s)) local.push({ s: m.index, e: m.index + m[0].length, cls: 'spell-err', o: base + m.index, w: m[0] });
        });
      }
    }
    if (!local.length) continue;
    const cuts = new Set([0, text.length]);
    for (const d of local) {
      cuts.add(d.s);
      cuts.add(d.e);
    }
    const points = [...cuts].sort((a, b) => a - b);
    const frag = document.createDocumentFragment();
    for (let i = 0; i < points.length - 1; i++) {
      const a = points[i];
      const b = points[i + 1];
      if (a === b) continue;
      const piece = text.slice(a, b);
      const covering = local.filter((d) => d.s <= a && d.e >= b);
      if (!covering.length) {
        frag.appendChild(document.createTextNode(piece));
        continue;
      }
      const span = document.createElement('span');
      span.className = covering.map((d) => d.cls).join(' ');
      const link = covering.find((d) => d.url);
      if (link) span.dataset.url = link.url;
      const sp = covering.find((d) => d.w);
      if (sp) {
        span.dataset.o = String(sp.o);
        span.dataset.w = sp.w;
      }
      span.textContent = piece;
      frag.appendChild(span);
    }
    node.parentNode.replaceChild(frag, node);
  }
  return tpl.innerHTML;
}

let previewSpellTimer = 0;
function schedulePreviewSpell(delay = 250) {
  clearTimeout(previewSpellTimer);
  previewSpellTimer = setTimeout(refreshPreviewSpell, delay);
}

/** Underlines misspelled words in the preview using the CSS Custom Highlight API (no DOM changes). */
function refreshPreviewSpell() {
  if (!window.CSS || !CSS.highlights) return;
  const doc = getActive();
  spell.previewRanges = [];
  if (!spell.enabled || !doc || !isProse(doc) || !previewVisible() || doc.content.length > SPELL_MAX_CHARS) {
    CSS.highlights.delete('spell');
    return;
  }
  const walker = document.createTreeWalker(preview, NodeFilter.SHOW_TEXT, {
    acceptNode: (node) =>
      node.parentElement && node.parentElement.closest('code, pre, kbd, .code-copy-btn')
        ? NodeFilter.FILTER_REJECT
        : NodeFilter.FILTER_ACCEPT,
  });
  let node;
  while ((node = walker.nextNode())) {
    const text = node.nodeValue;
    forEachWord(text, (m) => {
      if (!isMisspelled(m[0])) return;
      const r = document.createRange();
      r.setStart(node, m.index);
      r.setEnd(node, m.index + m[0].length);
      spell.previewRanges.push(r);
    });
  }
  CSS.highlights.set('spell', new Highlight(...spell.previewRanges));
}

function requestSuggestions(word) {
  return new Promise((resolve) => {
    if (!spell.worker) return resolve([]);
    const id = ++spell.reqId;
    spell.suggestWaiters.set(id, resolve);
    spell.worker.postMessage({ type: 'suggest', id, lang: spell.lang, word: word.replace(/’/g, "'") });
    setTimeout(() => {
      if (spell.suggestWaiters.has(id)) {
        spell.suggestWaiters.delete(id);
        resolve([]);
      }
    }, 4000);
  });
}

function addUserWord(word) {
  spell.userWords.add(word.replace(/’/g, "'").toLowerCase());
  refreshSpellEverywhere();
  scheduleSessionSave();
}

function ignoreWord(word) {
  spell.ignored.add(word.replace(/’/g, "'").toLowerCase());
  refreshSpellEverywhere();
}

function pointInRects(x, y, rects) {
  for (const r of rects) if (x >= r.left && x <= r.right && y >= r.top && y <= r.bottom) return true;
  return false;
}

function replaceEditorRange(start, end, text) {
  editor.focus();
  editor.setSelectionRange(start, end);
  // Typed in (execCommand / a CodeMirror input): stays on the undo stack.
  if (!editorInsertText(text)) {
    editor.value = editor.value.slice(0, start) + text + editor.value.slice(end);
    syncFromEditor();
  }
}

function replacePreviewRange(range, text) {
  preview.focus();
  const sel = window.getSelection();
  sel.removeAllRanges();
  sel.addRange(range);
  document.execCommand('insertText', false, text);
}

/* ---------- context menu (spelling, tabs, Advanced find rows) ---------- */

let subMenuEl = null;

function hideContextMenu() {
  ctxMenu.classList.add('hidden');
  ctxMenu.innerHTML = '';
  if (subMenuEl) {
    subMenuEl.remove();
    subMenuEl = null;
  }
}

/**
 * items: 'sep' or { label, action, disabled, bold, header, icon, gesture, checked, dot, submenu: [...] }
 */
function buildMenu(el, items, isSub) {
  el.innerHTML = '';
  for (const item of items) {
    if (item === 'sep') {
      const sep = document.createElement('div');
      sep.className = 'ctx-sep';
      el.appendChild(sep);
      continue;
    }
    if (item.header) {
      const h = document.createElement('div');
      h.className = 'ctx-header';
      h.textContent = item.label;
      el.appendChild(h);
      continue;
    }
    const b = document.createElement('button');
    const icon = document.createElement('span');
    icon.className = 'ctx-icon';
    if (item.dot) icon.innerHTML = '<span class="ctx-dot bm-' + item.dot + '"></span>';
    else icon.textContent = item.icon || '';
    const label = document.createElement('span');
    label.className = 'ctx-label';
    label.textContent = item.label;
    const right = document.createElement('span');
    right.className = 'ctx-gesture';
    right.textContent = item.submenu ? '›' : (item.checked ? '✓  ' : '') + (item.gesture || '');
    b.append(icon, label, right);
    if (item.bold) b.classList.add('bold');
    if (item.disabled) b.disabled = true;
    b.addEventListener('mousedown', (e) => e.preventDefault());
    if (item.submenu) {
      const open = () => openSubMenu(b, item.submenu);
      b.addEventListener('mouseenter', open);
      b.addEventListener('click', open);
    } else {
      if (!isSub) b.addEventListener('mouseenter', closeSubMenu);
      b.addEventListener('click', () => {
        hideContextMenu();
        if (item.action) item.action();
      });
    }
    el.appendChild(b);
  }
}

function closeSubMenu() {
  if (subMenuEl) {
    subMenuEl.remove();
    subMenuEl = null;
  }
}

function openSubMenu(anchor, items) {
  closeSubMenu();
  subMenuEl = document.createElement('div');
  subMenuEl.className = 'ctx-menu';
  document.body.appendChild(subMenuEl);
  buildMenu(subMenuEl, items, true);
  const r = anchor.getBoundingClientRect();
  const w = subMenuEl.offsetWidth;
  const h = subMenuEl.offsetHeight;
  let x = r.right - 2;
  if (x + w > window.innerWidth - 4) x = r.left - w + 2;
  subMenuEl.style.left = Math.max(4, x) + 'px';
  subMenuEl.style.top = Math.max(4, Math.min(r.top - 4, window.innerHeight - h - 4)) + 'px';
}

function showContextMenu(x, y, items) {
  hideContextMenu();
  buildMenu(ctxMenu, items, false);
  ctxMenu.classList.remove('hidden');
  const w = ctxMenu.offsetWidth;
  const h = ctxMenu.offsetHeight;
  ctxMenu.style.left = Math.max(4, Math.min(x, window.innerWidth - w - 4)) + 'px';
  ctxMenu.style.top = Math.max(4, Math.min(y, window.innerHeight - h - 4)) + 'px';
}

function contextMenuContains(target) {
  return ctxMenu.contains(target) || (subMenuEl && subMenuEl.contains(target));
}

async function showSpellMenu(x, y, word, replace) {
  const tail = ['sep', { label: 'Add "' + word + '" to dictionary', icon: '+', action: () => addUserWord(word) }, { label: 'Ignore', icon: '∅', action: () => ignoreWord(word) }];
  showContextMenu(x, y, [{ label: 'Looking up suggestions...', disabled: true }, ...tail]);
  const list = await requestSuggestions(word);
  if (ctxMenu.classList.contains('hidden')) return;
  const items = list.length
    ? list.map((s) => ({ label: s, bold: true, disabled: !replace, action: () => replace && replace(s) }))
    : [{ label: 'No suggestions', disabled: true }];
  if (!replace && list.length) items.push({ label: '(edit the text in the editor pane to correct it)', disabled: true });
  showContextMenu(x, y, [...items, ...tail]);
}

/* ---------- document <-> panes sync ---------- */

function enableCheckboxes() {
  preview.querySelectorAll('input[type="checkbox"]').forEach((cb) => cb.removeAttribute('disabled'));
}

function addCodeCopyButtons() {
  preview.querySelectorAll('pre').forEach((pre) => {
    if (pre.querySelector(':scope > .code-copy-btn')) return;
    const btn = document.createElement('button');
    btn.className = 'code-copy-btn';
    btn.title = 'Copy code';
    btn.setAttribute('contenteditable', 'false');
    btn.innerHTML =
      '<svg viewBox="0 0 20 20" width="13" height="13"><rect x="7" y="7" width="9" height="9" rx="1.3" fill="none" stroke="currentColor" stroke-width="1.4"/><rect x="4" y="4" width="9" height="9" rx="1.3" fill="none" stroke="currentColor" stroke-width="1.4"/></svg>';
    pre.appendChild(btn);
  });
}

async function copyCodeBlock(pre) {
  const clone = pre.cloneNode(true);
  const btn = clone.querySelector('.code-copy-btn');
  if (btn) btn.remove();
  await clipboard.writeText(clone.textContent);
}

function updateCharCount() {
  const doc = getActive();
  statusCount.textContent = (doc ? doc.content.length : 0).toLocaleString('en-GB') + ' characters';
}

/** Markdown: editable rendering. BBCode: read-only rendering. Code: read-only coloured view. */
function renderPreview(doc) {
  previewStale = false;
  const mode = langInfo(doc).render;
  preview.classList.toggle('code-view', mode === 'code');
  preview.classList.toggle('bb-view', mode === 'bbcode');
  preview.classList.toggle('plain-view', mode === 'plain');
  // Back on a tab whose text hasn't changed since it was shown: reuse the preview kept for it.
  const kept = doc.previewStash;
  doc.previewStash = null;
  if (kept && kept.content === doc.content && kept.path === doc.path && kept.render === mode && kept.gen === stashRenderGen) {
    preview.setAttribute('contenteditable', previewEditableFor(mode));
    preview.replaceChildren(kept.frag);
    schedulePreviewSpell(0);
    if (typeof refreshPreviewFindHighlights === 'function') refreshPreviewFindHighlights(false);
    return;
  }
  // A very big document: the preview shows its first part only (read-only, so editing the preview
  // can never write a shortened text back), with a note saying so. The editor has the whole file.
  const src = previewSource(doc);
  delete preview.dataset.cut;
  if (src.cut) {
    preview.dataset.cut = '1';
    preview.setAttribute('contenteditable', 'false');
    const note = () => {
      const n = document.createElement('div');
      n.className = 'preview-cut-note';
      n.textContent =
        'The preview shows the first ' + fmtMB(src.text.length) + ' of this ' + fmtMB(doc.content.length) + ' file, read-only. The editor has the whole file: edit it there.';
      preview.prepend(n);
    };
    if (mode === 'markdown' || mode === 'bbcode') {
      let html;
      try {
        html = mode === 'markdown' ? marked_.parse(src.text) : renderBBCode(src.text);
      } catch (e) {
        html = '';
      }
      setSanitizedHtml(preview, html, false);
      markVisitedLinks();
    } else if (mode === 'plain') {
      preview.textContent = src.text;
    } else {
      preview.innerHTML = '<pre><code class="hljs">' + highlightCode(src.text, langInfo(doc).hljs) + '</code></pre>';
    }
    note();
    return;
  }
  if (mode === 'markdown') {
    preview.setAttribute('contenteditable', 'true');
    let html;
    try {
      html = marked_.parse(doc.content);
    } catch (e) {
      // The Markdown converter gave up on this text: say so instead of leaving the old preview.
      preview.setAttribute('contenteditable', 'false');
      preview.dataset.cut = '1';
      preview.replaceChildren();
      const n = document.createElement('div');
      n.className = 'preview-cut-note';
      n.textContent = 'This text could not be shown as Markdown (' + String((e && e.message) || e).split('\n')[0] + '). The editor has the whole file.';
      preview.appendChild(n);
      return;
    }
    setSanitizedHtml(preview, html, true);
    markBareLinks();
    markVisitedLinks();
    fixPreviewImages(doc);
    enableCheckboxes();
    highlightPreviewCodeBlocks();
    addCodeCopyButtons();
    ensureTrailingParagraph();
  } else if (mode === 'bbcode') {
    preview.setAttribute('contenteditable', 'true'); // typing here writes BBCode back to the source
    setSanitizedHtml(preview, renderBBCode(doc.content), false); // safe by construction; cleaned anyway
    markVisitedLinks();
    addCodeCopyButtons();
  } else if (mode === 'plain') {
    // Plain Text: the text exactly as written (no Markdown), and typed into as plain text.
    preview.setAttribute('contenteditable', 'plaintext-only');
    preview.textContent = doc.content;
  } else {
    preview.setAttribute('contenteditable', 'false');
    preview.innerHTML = '<pre><code class="hljs">' + highlightCode(doc.content, langInfo(doc).hljs) + '</code></pre>';
  }
  schedulePreviewSpell(0);
  if (typeof refreshPreviewFindHighlights === 'function') refreshPreviewFindHighlights(false);
}

/* The preview of a very big document shows its first PREVIEW_MAX_CHARS (cut at a line end):
 * rendering 25 MB of text as Markdown takes the converter half a minute and can crash it, and the
 * window is frozen meanwhile. Up to 4 MB it takes about a second at most. */
const PREVIEW_MAX_CHARS = 4 * 1024 * 1024;
function previewSource(doc) {
  const t = doc.content;
  if (t.length <= PREVIEW_MAX_CHARS) return { text: t, cut: false };
  const end = t.lastIndexOf('\n', PREVIEW_MAX_CHARS);
  return { text: t.slice(0, end > 0 ? end : PREVIEW_MAX_CHARS), cut: true };
}
function fmtMB(chars) {
  return (chars / 1048576).toFixed(1) + ' MB';
}

let largePreviewTimer = 0;
function renderPreviewIfVisible(doc, typing) {
  clearTimeout(largePreviewTimer);
  if (!previewVisible()) {
    previewStale = true;
    return;
  }
  // A bigger file's preview takes a while to build: while typing, wait for a short pause
  // (a second or more for big files) instead of rebuilding it on every key.
  if (typing && doc.content.length > PREVIEW_PAUSE_CHARS) {
    largePreviewTimer = setTimeout(() => {
      if (doc.id === activeId && previewVisible()) renderPreview(doc);
    }, doc.content.length > HIGHLIGHT_MAX_CHARS ? 700 : 250);
    return;
  }
  renderPreview(doc);
}

const PREVIEW_PAUSE_CHARS = 50000;

/* Tab switching: the preview and coloured editor layer of a tab you leave are kept (for the last
 * few bigger tabs) and put back when you return, if the text hasn't changed, instead of being
 * rebuilt from scratch. */
const STASH_MIN_CHARS = 20000;
const STASH_MAX_TABS = 3;
const STASH_MAX_CHARS = 1500000; // a bigger tab's preview takes too much memory to keep
const STASH_MAX_TOTAL = 2000000;
let stashRenderGen = 0; // bumped when settings change how previews look: kept previews are dropped
const stashOrder = [];

function stashPanes(doc) {
  if (!doc) return;
  doc.previewStash = null;
  doc.overlayStash = null;
  const i = stashOrder.indexOf(doc);
  if (i >= 0) stashOrder.splice(i, 1);
  if (doc.content.length < STASH_MIN_CHARS || doc.content.length > STASH_MAX_CHARS || !docs.includes(doc)) return;
  if (!previewStale && previewVisible() && preview.firstChild) {
    const frag = document.createDocumentFragment();
    while (preview.firstChild) frag.appendChild(preview.firstChild);
    doc.previewStash = { content: doc.content, path: doc.path, render: langInfo(doc).render, gen: stashRenderGen, frag };
  }
  if (overlayState && editor.value === doc.content && editorHighlight.firstChild && editor.classList.contains('hl-active')) {
    const frag = document.createDocumentFragment();
    while (editorHighlight.firstChild) frag.appendChild(editorHighlight.firstChild);
    doc.overlayStash = { text: doc.content, state: overlayState, frag };
    overlayState = null;
  }
  if (!doc.previewStash && !doc.overlayStash) return;
  stashOrder.push(doc);
  // Keep memory in check: at most a few tabs, and not too much text in total.
  const total = () => stashOrder.reduce((n, d) => n + d.content.length, 0);
  while (stashOrder.length > STASH_MAX_TABS || (stashOrder.length > 1 && total() > STASH_MAX_TOTAL)) {
    const old = stashOrder.shift();
    old.previewStash = null;
    old.overlayStash = null;
  }
}

function syncFromEditor() {
  const doc = getActive();
  if (!doc) return;
  doc.content = editor.value;
  renderPreviewIfVisible(doc, true);
  markDirty(doc);
  renderEditorOverlay();
  updateLineNumbers();
  updateCharCount();
  scheduleOutline();
}

/**
 * The preview's HTML for turning back into Markdown. SVG and MathML have no Markdown form and the
 * converter can't walk into MathML, so each one is handed over as a placeholder carrying its
 * original HTML, which goes back into the source unchanged.
 */
function previewHtmlForMarkdown() {
  if (!preview.querySelector('svg, math')) return preview.innerHTML;
  const box = preview.cloneNode(true);
  box.querySelectorAll('svg, math').forEach((el) => {
    if (!box.contains(el)) return; // inside one already replaced
    const w = document.createElement('wbr');
    w.setAttribute('data-np-raw', el.outerHTML);
    w.setAttribute('data-np-block', '');
    el.replaceWith(w);
  });
  return box.innerHTML;
}

/** The text of a Plain Text preview (typed into as plain text), with Windows line breaks made \n. */
function plainPreviewText() {
  return preview.innerText.replace(/\r\n?/g, '\n');
}

function syncFromPreview() {
  const doc = getActive();
  if (!doc || !isEditablePreview(doc)) return;
  // A preview showing only part of the document never writes back (it would cut the document short).
  if (preview.dataset.cut) return;
  const render = langInfo(doc).render;
  let text;
  try {
    text = render === 'markdown' ? turndownService.turndown(previewHtmlForMarkdown()) : render === 'plain' ? plainPreviewText() : htmlToBBCode(preview);
  } catch (e) {
    // Never lose the source to a conversion that failed: it stays as it was.
    console.error('preview to source', e);
    flashFindStatus('This part of the preview could not be written back to the source: please make this change in the editor.', 6000);
    return;
  }
  doc.content = text;
  editor.value = doc.content;
  addCodeCopyButtons();
  markDirty(doc);
  scheduleOverlay();
  updateLineNumbers();
  updateCharCount();
  schedulePreviewSpell();
  scheduleOutline();
}

/** For the editor's colour cache: is tab `id` still open, with exactly this text? */
function npColourCacheValid(id, text) {
  const d = docs.find((x) => x.id === id);
  return !!d && d.content === text;
}

function loadActiveDocIntoPanes() {
  const doc = getActive();
  if (!doc) return;
  if (editor.isCodeMirror) {
    if (editor.api) editor.api.setLanguage(langInfo(doc).hljs || null, true); // before loading: coloured once
    editor.loadText(doc.content, doc.id); // its own document and undo history
  }
  else editor.value = doc.content;
  editor.placeholder = isProse(doc) ? 'Start typing...' : 'Start typing ' + langInfo(doc).label + '...';
  applyFontSize();
  applyLayout(doc.layoutMode);
  renderPreviewIfVisible(doc);
  renderEditorOverlay();
  updateLineNumbers();
  updateStatusBar();
  updatePreviewModeButton();
  restoreDocView(doc);
  updateDiskNotice();
  updateFollowStatus();
  syncMenuChecks();
  if (settings.outline) renderOutline();
}

/* ---------- per-tab language / preview mode ---------- */

const previewModeBtn = document.getElementById('preview-mode-btn');

/** Sets the active tab's language (colouring + preview); null = back to auto-detect from the extension. */
function setDocLanguage(lang) {
  const doc = getActive();
  if (!doc) return;
  const auto = langForPath(doc.path);
  if (!lang || !LANGS[lang]) lang = auto;
  doc.lang = lang;
  doc.langOverride = !!doc.path && lang !== auto;
  // Code is edited in the editor (its preview is read-only), so don't leave the editor hidden.
  if (LANGS[lang].render === 'code' && doc.layoutMode === 'preview-only') doc.layoutMode = 'edit-only';
  saveDocView(doc);
  loadActiveDocIntoPanes();
  scheduleFindRefresh(false);
  scheduleSessionSave();
}

/** Preview the active tab as Markdown or as BBCode (sidebar button, Ctrl+Alt+M / Ctrl+Alt+B). */
function setPreviewMode(mode) {
  setDocLanguage(mode === 'bbcode' ? 'bbcode' : 'markdown');
}

function togglePreviewMode() {
  const doc = getActive();
  if (!doc) return;
  const render = langInfo(doc).render;
  if (render === 'code') return showLanguageMenu(previewModeBtn);
  setPreviewMode(render === 'bbcode' ? 'markdown' : 'bbcode');
}

function updatePreviewModeButton() {
  syncMenuChecks();
  const doc = getActive();
  const render = langInfo(doc).render;
  previewModeBtn.textContent = render === 'bbcode' ? 'BB' : render === 'code' ? '{ }' : render === 'plain' ? 'TXT' : 'MD';
  previewModeBtn.classList.toggle('overridden', !!(doc && doc.langOverride));
  previewModeBtn.title =
    render === 'code'
      ? langInfo(doc).label + ' file - click to choose how this tab is shown'
      : render === 'plain'
      ? 'Plain Text: shown exactly as written - click to preview as Markdown (Ctrl+Alt+M). Right-click for every language.'
      : 'Preview: ' + (render === 'bbcode' ? 'BBCode' : 'Markdown') + ' - click to preview as ' + (render === 'bbcode' ? 'Markdown (Ctrl+Alt+M)' : 'BBCode (Ctrl+Alt+B)') + '. Right-click for every language.';
}

/** Menu of every language for the active tab (status bar language, View > Language..., right-click on the sidebar button). */
function showLanguageMenu(anchor) {
  const doc = getActive();
  if (!doc) return;
  const auto = langForPath(doc.path);
  let x = window.innerWidth / 2 - 100;
  let y = 80;
  if (anchor && anchor.offsetParent) {
    const r = anchor.getBoundingClientRect();
    x = r.left;
    y = r.top;
  }
  const items = [
    { label: 'LANGUAGE / PREVIEW FOR THIS TAB', header: true },
    { label: 'Auto-detect from file extension (' + LANGS[auto].label + ')', checked: !doc.langOverride && doc.lang === auto, action: () => setDocLanguage(null) },
    'sep',
  ];
  const entry = (key, info) => ({ label: info.label + (info.render === 'markdown' ? '  (Markdown preview)' : info.render === 'bbcode' ? '  (BBCode preview)' : ''), checked: doc.lang === key, action: () => setDocLanguage(key) });
  // Text formats at the top level; the rest in one submenu per group.
  for (const [g, title] of LANG_GROUPS) {
    const list = Object.entries(LANGS).filter(([, info]) => info.group === g);
    if (g === 'text') for (const [key, info] of list) items.push(entry(key, info));
    else items.push({ label: title + (list.some(([key]) => key === doc.lang) ? '  ·  ' + LANGS[doc.lang].label : ''), checked: list.some(([key]) => key === doc.lang), submenu: list.map(([key, info]) => entry(key, info)) });
  }
  showContextMenu(x, y, items);
  // Open upwards from the status bar.
  if (anchor === statusLang) ctxMenu.style.top = Math.max(4, y - ctxMenu.offsetHeight - 4) + 'px';
}

function saveDocView(doc) {
  if (!doc) return;
  doc.view = {
    editorTop: editor.scrollTop,
    previewTop: preview.scrollTop,
    selStart: editor.selectionStart,
    selEnd: editor.selectionEnd,
  };
}

function restoreDocView(doc) {
  const v = doc.view;
  // A tab opened for the first time starts with the caret at the top (otherwise the textarea can
  // keep the previous tab's selection offsets, and Find would pre-fill with that stale "selection").
  try {
    if (v) editor.setSelectionRange(v.selStart, v.selEnd);
    else editor.setSelectionRange(0, 0);
  } catch (e) {
    /* ignore */
  }
  editor.scrollTop = v ? v.editorTop : 0;
  preview.scrollTop = v ? v.previewTop : 0;
  editorHighlight.scrollTop = editor.scrollTop;
  if (lineNumbersVisible) {
    renderGutter();
    lineNumbersPreviewEl.scrollTop = preview.scrollTop;
  }
}

/** Called after every content change: unsaved state, bookmark positions, find results, session. */
function markDirty(doc) {
  if (doc.lastContent !== doc.content) {
    adjustLineAnchors(doc, doc.lastContent, doc.content);
    doc.lastContent = doc.content;
    scheduleFindRefresh(false, 200);
  }
  const was = doc.dirty;
  doc.dirty = doc.content !== doc.savedContent;
  if (was !== doc.dirty) renderTabs();
  updateStatusBar();
  scheduleSessionSave();
}

function updateStatusBar() {
  const doc = getActive();
  if (!doc) return;
  statusFile.textContent = doc.path || tabTitle(doc);
  statusDirty.textContent = doc.dirty ? '• Modified' : '';
  scheduleValidation(doc); // after a pause; nothing to do if this text was already checked
  updateToolbarForLanguage(doc);
  updateDiagStatus();
  statusLayout.textContent = layoutLabels[layoutMode];
  const enc = { utf8: 'UTF-8', utf8bom: 'UTF-8 BOM', utf16le: 'UTF-16 LE', utf16be: 'UTF-16 BE', latin1: 'ANSI' }[doc.encoding] || 'UTF-8';
  statusLang.textContent = langInfo(doc).label;
  statusLang.title =
    enc + ' · ' + (doc.eol === 'crlf' ? 'CRLF (Windows)' : 'LF (Unix)') + ' line endings' +
    (doc.langOverride ? ' · chosen for this tab' : ' · from the file extension') + '\nClick to change the language / preview mode';
  updateCharCount();
  updateWindowTitle();
}

let lastWindowTitle = '';
function updateWindowTitle() {
  const doc = getActive();
  if (!doc) return;
  const title = (doc.dirty ? '*' : '') + tabTitle(doc) + ' - notepad.md';
  if (title === lastWindowTitle) return;
  lastWindowTitle = title;
  try {
    window.__TAURI__.window.getCurrentWindow().setTitle(title);
  } catch (e) {
    /* title is cosmetic */
  }
}

/* ---------- tabs ---------- */

const PIN_SVG =
  '<svg viewBox="0 0 16 16" width="13" height="13"><path d="M9.6 1.8l4.6 4.6-1.4.5-2.6 2.6.2 3-1.1 1.1-2.6-2.6-3.4 3.4-.7-.7 3.4-3.4L3.4 7.7l1.1-1.1 3 .2 2.6-2.6z" fill="var(--pin-fill)" stroke="currentColor" stroke-width="1.1" stroke-linejoin="round"/></svg>';

/** Keeps pinned tabs grouped at the left, preserving relative order. */
function sortPinnedFirst() {
  docs = [...docs.filter((d) => d.pinned), ...docs.filter((d) => !d.pinned)];
}

function renderTabs() {
  tabbarEl.innerHTML = '';
  docs.forEach((doc) => {
    const tab = document.createElement('div');
    tab.className = 'tab' + (doc.id === activeId ? ' active' : '') + (doc.pinned ? ' pinned' : '') + (doc.dirty ? ' dirty' : '');
    tab.dataset.id = doc.id;
    tab.title =
      (doc.path || tabTitle(doc)) + (doc.dirty ? '\nUnsaved changes' : '') + (doc.pinned ? '\nPinned' : '') +
      (doc.follow ? '\nFollowing: new lines appear as the file grows' : '') + (doc.missing ? '\nDeleted or moved on disk' : '');

    const dirty = document.createElement('span');
    dirty.className = 'tab-dirty';
    dirty.textContent = doc.dirty ? '*' : '';

    const title = document.createElement('span');
    title.className = 'tab-title';
    title.textContent = tabTitle(doc);

    const pin = document.createElement('button');
    pin.className = 'tab-pin';
    pin.title = doc.pinned ? 'Unpin tab' : 'Pin tab';
    pin.innerHTML = PIN_SVG;
    pin.addEventListener('mousedown', (e) => e.stopPropagation());
    pin.addEventListener('click', (e) => {
      e.stopPropagation();
      togglePin(doc.id);
    });

    const close = document.createElement('button');
    close.className = 'tab-close';
    close.textContent = '✕';
    close.title = 'Close';
    close.addEventListener('mousedown', (e) => e.stopPropagation());
    close.addEventListener('click', (e) => {
      e.stopPropagation();
      closeTab(doc.id);
    });

    tab.appendChild(dirty);
    tab.appendChild(title);
    tab.appendChild(pin);
    tab.appendChild(close);
    title.addEventListener('dblclick', (e) => {
      e.stopPropagation();
      startTabRename(doc, title);
    });
    tab.addEventListener('click', () => setActiveTab(doc.id));
    tab.addEventListener('mousedown', (e) => {
      if (e.button === 1) e.preventDefault(); // stop middle-click autoscroll
      startTabDrag(e, doc);
    });
    tab.addEventListener('auxclick', (e) => {
      if (e.button === 1) closeTab(doc.id);
    });
    tab.addEventListener('contextmenu', (e) => {
      e.preventDefault();
      showTabMenu(e.clientX, e.clientY, doc);
    });
    tabbarEl.appendChild(tab);
  });
  const activeTab = tabbarEl.querySelector('.tab.active');
  if (activeTab) activeTab.scrollIntoView({ block: 'nearest', inline: 'nearest' });
  updateTabScrollButtons();
  updateWindowTitle();
}


/* ---------- rename a tab (double-click its name) ---------- */

// Untitled tabs just get a new name; a saved file is renamed on disk (same folder).
function startTabRename(doc, titleEl) {
  if (!titleEl.isConnected) return;
  const input = document.createElement('input');
  input.className = 'tab-rename';
  input.value = tabTitle(doc);
  input.spellcheck = false;
  titleEl.replaceWith(input);
  input.focus();
  const dot = input.value.lastIndexOf('.');
  input.setSelectionRange(0, dot > 0 ? dot : input.value.length);
  let done = false;
  const finish = async (commit) => {
    if (done) return;
    done = true;
    const name = input.value.trim();
    if (commit && name && name !== tabTitle(doc)) await renameDoc(doc, name);
    renderTabs();
    if (doc.id === activeId) updateStatusBar();
  };
  input.addEventListener('keydown', (e) => {
    e.stopPropagation();
    if (e.key === 'Enter') {
      e.preventDefault();
      finish(true);
    } else if (e.key === 'Escape') {
      e.preventDefault();
      finish(false);
    }
  });
  input.addEventListener('blur', () => finish(true));
  for (const t of ['mousedown', 'click', 'dblclick', 'auxclick']) input.addEventListener(t, (e) => e.stopPropagation());
}

async function renameDoc(doc, name) {
  if (/[\\/:*?"<>|]/.test(name) || /^\.+$/.test(name)) {
    await dialogApi.message('A name can\'t contain any of these characters:  \\ / : * ? " < > |', { title: 'Rename', kind: 'warning' });
    return;
  }
  if (!doc.path) {
    doc.customTitle = name;
    scheduleSessionSave();
    return;
  }
  const target = dirOf(doc.path).replace(/\//g, '\\').replace(/\\?$/, '\\') + name;
  try {
    await invoke('cmd_rename_file', { from: doc.path, to: target });
  } catch (e) {
    await dialogApi.message('Could not rename "' + basename(doc.path) + '":\n' + e, { title: 'Rename', kind: 'error' });
    return;
  }
  doc.path = target;
  // A new extension can mean a new language (unless the user picked one for this tab).
  const lang = langForPath(target);
  if (!doc.langOverride && lang !== doc.lang) {
    doc.lang = lang;
    if (doc.id === activeId) {
      saveDocView(doc);
      loadActiveDocIntoPanes();
    }
  }
  scheduleSessionSave();
}

/* ---------- drag tabs to reorder ---------- */

// Mouse events rather than HTML5 drag & drop: the window's file drop handling swallows HTML5
// drag events. Pinned tabs can only move among pinned tabs, unpinned among unpinned.
let tabDrag = null;

function startTabDrag(e, doc) {
  if (e.button !== 0 || e.target.closest('button')) return;
  tabDrag = { id: doc.id, x: e.clientX, active: false, target: -1 };
}

function tabDropIndex(clientX) {
  const doc = docs.find((d) => d.id === tabDrag.id);
  const tabs = [...tabbarEl.querySelectorAll('.tab')];
  let idx = tabs.length;
  for (let i = 0; i < tabs.length; i++) {
    const r = tabs[i].getBoundingClientRect();
    if (clientX < r.left + r.width / 2) {
      idx = i;
      break;
    }
  }
  const pinnedCount = docs.filter((d) => d.pinned).length;
  return doc.pinned ? Math.min(idx, pinnedCount) : Math.max(idx, pinnedCount);
}

function showTabDropMarker(idx) {
  const tabs = [...tabbarEl.querySelectorAll('.tab')];
  tabs.forEach((t) => t.classList.remove('drop-before', 'drop-after'));
  if (idx < tabs.length) tabs[idx].classList.add('drop-before');
  else if (tabs.length) tabs[tabs.length - 1].classList.add('drop-after');
}

document.addEventListener('mousemove', (e) => {
  if (!tabDrag) return;
  if (!tabDrag.active) {
    if (Math.abs(e.clientX - tabDrag.x) < 6) return;
    tabDrag.active = true;
    document.body.classList.add('tab-dragging');
    const el = tabbarEl.querySelector('.tab[data-id="' + tabDrag.id + '"]');
    if (el) el.classList.add('dragging');
  }
  // Scroll the tab strip when dragging past its ends.
  const r = tabbarEl.getBoundingClientRect();
  if (e.clientX < r.left + 20) tabbarEl.scrollLeft -= 12;
  else if (e.clientX > r.right - 20) tabbarEl.scrollLeft += 12;
  tabDrag.target = tabDropIndex(e.clientX);
  showTabDropMarker(tabDrag.target);
});

document.addEventListener('mouseup', () => {
  if (!tabDrag) return;
  const drag = tabDrag;
  tabDrag = null;
  if (!drag.active) return;
  document.body.classList.remove('tab-dragging');
  // The click that follows the drag must not count as a tab click.
  const eat = (ev) => ev.stopPropagation();
  window.addEventListener('click', eat, true);
  setTimeout(() => window.removeEventListener('click', eat, true), 0);
  moveTab(drag.id, drag.target);
});

/** Move a tab so it ends up before the tab currently at position `to` (docs.length = end). */
function moveTab(id, to) {
  const from = docs.findIndex((d) => d.id === id);
  if (from < 0 || to < 0) {
    renderTabs();
    return;
  }
  const [doc] = docs.splice(from, 1);
  docs.splice(to > from ? to - 1 : to, 0, doc);
  renderTabs();
  scheduleSessionSave();
}
function updateTabScrollButtons() {
  const overflow = tabbarEl.scrollWidth > tabbarEl.clientWidth + 1;
  tabScrollEl.classList.toggle('hidden', !overflow);
  if (!overflow) return;
  const [left, right] = tabScrollEl.querySelectorAll('button');
  left.disabled = tabbarEl.scrollLeft <= 0;
  right.disabled = tabbarEl.scrollLeft + tabbarEl.clientWidth >= tabbarEl.scrollWidth - 1;
}

/** Same step as the ‹ › buttons. */
function scrollTabs(dir) {
  tabbarEl.scrollBy({ left: dir * 200, behavior: 'smooth' });
}

function showTabMenu(x, y, doc) {
  const others = docs.filter((d) => d.id !== doc.id && !d.pinned);
  const unpinned = docs.filter((d) => !d.pinned);
  showContextMenu(x, y, [
    { label: 'Save', icon: '\u{1F5AB}', gesture: doc.id === activeId ? 'Ctrl+S' : '', action: () => saveDocGeneric(doc) },
    { label: 'Save As...', icon: '\u{1F5AB}', gesture: doc.id === activeId ? 'Ctrl+Shift+S' : '', action: () => saveDocGeneric(doc, true) },
    { label: 'Save All', gesture: 'Ctrl+Alt+S', disabled: !docs.some((d) => d.dirty), action: () => saveAll() },
    { label: 'Reload from Disk', icon: '⟳', disabled: !doc.path, action: () => (doc.id === activeId ? reloadActiveFromDisk() : (setActiveTab(doc.id), reloadActiveFromDisk())) },
    'sep',
    { label: doc.pinned ? 'Unpin Tab' : 'Pin Tab', icon: '\u{1F4CC}', action: () => togglePin(doc.id) },
    'sep',
    { label: 'Close', icon: '✕', gesture: doc.id === activeId ? 'Ctrl+W' : '', action: () => closeTab(doc.id) },
    { label: 'Close Others (keeps pinned)', disabled: !others.length, action: () => closeMany(others) },
    { label: 'Close All (keeps pinned)', disabled: !unpinned.length, action: () => closeMany(unpinned) },
    { label: 'Reopen Closed Tab', gesture: 'Ctrl+Shift+T', disabled: !closedTabs.length, action: () => reopenClosedTab() },
    'sep',
    { label: 'Copy Full Path', icon: '⧉', disabled: !doc.path, action: () => clipboard.writeText(doc.path) },
  ]);
}

async function closeMany(list) {
  for (const d of list) {
    if (!docs.includes(d)) continue;
    const before = docs.length;
    await closeTab(d.id);
    if (docs.length === before && docs.includes(d)) break; // user cancelled a save dialog
  }
}

function togglePin(id) {
  const doc = docs.find((d) => d.id === id);
  if (!doc) return;
  doc.pinned = !doc.pinned;
  // Newly pinned tabs go to the end of the pinned group; unpinned ones to the start of the rest.
  docs = docs.filter((d) => d !== doc);
  const firstUnpinned = docs.findIndex((d) => !d.pinned);
  const at = firstUnpinned === -1 ? docs.length : firstUnpinned;
  docs.splice(at, 0, doc);
  renderTabs();
  scheduleSessionSave();
}

function setActiveTab(id) {
  if (id === activeId) return;
  saveDocView(getActive());
  stashPanes(getActive());
  activeId = id;
  findState.navLine = null;
  hideDiagnosticPopup();
  renderTabs();
  loadActiveDocIntoPanes();
  if (!findBar.classList.contains('hidden')) {
    if (advScope.value === 'tab') refreshFind(false);
    else recomputeMatches(false);
  }
  scheduleSessionSave();
}

function cycleTab(dir) {
  if (docs.length < 2) return;
  const idx = docs.findIndex((d) => d.id === activeId);
  const next = (idx + dir + docs.length) % docs.length;
  setActiveTab(docs[next].id);
}

function addDocAndActivate(doc) {
  saveDocView(getActive());
  stashPanes(getActive());
  docs.push(doc);
  sortPinnedFirst();
  activeId = doc.id;
  renderTabs();
  loadActiveDocIntoPanes();
  scheduleFindRefresh(false);
  scheduleSessionSave();
}

function removeDoc(id) {
  const idx = docs.findIndex((d) => d.id === id);
  if (idx === -1) return;
  docs.splice(idx, 1);
  if (docs.length === 0) {
    const doc = newUntitledDoc(); // the last tab was closed: a blank one, like any new tab
    docs.push(doc);
    activeId = doc.id;
  } else if (id === activeId) {
    const nextIdx = Math.min(idx, docs.length - 1);
    activeId = docs[nextIdx].id;
  }
  renderTabs();
  loadActiveDocIntoPanes();
  scheduleFindRefresh(false);
  scheduleSessionSave();
}

/**
 * "Save changes?" with Yes, No and Cancel: resolves 'yes', 'no' or 'cancel'. Shown in the window
 * (like Settings and Go to Line), so it follows the light / dark theme and the app always knows
 * which answer was given. Enter = Yes, Esc = Cancel, Y / N also work.
 */
function askSaveYesNoCancel(text) {
  return showAppDialog({
    title: 'Save',
    text,
    kind: 'question',
    buttons: [
      { answer: 'yes', label: 'Yes', key: 'y', primary: true },
      { answer: 'no', label: 'No', key: 'n' },
      { answer: 'cancel', label: 'Cancel' },
    ],
    escape: 'cancel',
  });
}

/**
 * Every question and message box in the app uses this one in-window dialog (#save-ask), so they all
 * look the same and follow the light / dark theme. Native Windows boxes are not used: they ignore the
 * theme, and the window can't tell which answer was given if it is closed while one is up.
 *   buttons: [{ answer, label, key?, primary? }]. `key` is underlined and works as a shortcut.
 *   Enter = the primary button (unless a button has focus), Esc = `escape`.
 * Resolves to the chosen button's `answer`. Only one is shown at a time: a new one answers the old
 * one with its `escape` answer.
 */
let appDialogPending = null;
const APP_DIALOG_ICONS = { question: '?', info: 'i', warning: '!', error: '✕' };
function showAppDialog({ title, text, kind = 'info', buttons, escape }) {
  const box = document.getElementById('save-ask');
  if (appDialogPending) appDialogPending(null);
  hideContextMenu();
  document.getElementById('save-ask-title').textContent = title || 'notepad.md';
  document.getElementById('save-ask-text').textContent = text;
  const icon = box.querySelector('.save-ask-icon');
  icon.textContent = APP_DIALOG_ICONS[kind] || 'i';
  icon.dataset.kind = APP_DIALOG_ICONS[kind] ? kind : 'info';
  const foot = box.querySelector('.modal-foot');
  foot.innerHTML = '<span class="spacer"></span>';
  let primary = null;
  for (const b of buttons) {
    const el = document.createElement('button');
    el.id = 'save-ask-' + b.answer;
    el.dataset.answer = b.answer;
    if (b.primary) {
      el.className = 'primary';
      primary = el;
    }
    const i = b.key ? b.label.toLowerCase().indexOf(b.key) : -1;
    if (i >= 0) {
      el.append(b.label.slice(0, i));
      const u = document.createElement('u');
      u.textContent = b.label[i];
      el.append(u, b.label.slice(i + 1));
    } else el.textContent = b.label;
    foot.appendChild(el);
  }
  const back = document.activeElement;
  box.classList.remove('hidden');
  return new Promise((resolve) => {
    const done = (answer) => {
      if (answer === null) answer = escape;
      box.classList.add('hidden');
      box.removeEventListener('click', onClick);
      box.removeEventListener('keydown', onKey, true);
      appDialogPending = null;
      // Back to where the user was, unless the answer has already moved focus somewhere else.
      if (back && back.focus && box.contains(document.activeElement)) back.focus();
      if (box.contains(document.activeElement)) document.activeElement.blur(); // never leave focus in the hidden box
      resolve(answer);
    };
    const onClick = (e) => {
      const b = e.target.closest('button[data-answer]');
      if (b) done(b.dataset.answer);
    };
    const onKey = (e) => {
      const k = e.key.toLowerCase();
      const byKey = !e.ctrlKey && !e.altKey && buttons.find((b) => b.key === k);
      if (e.key === 'Escape') done(escape);
      else if (byKey) done(byKey.answer);
      else if (e.key === 'Enter' && !e.target.closest('button') && primary) done(primary.dataset.answer);
      else if (e.key === 'Tab') {
        // Keep Tab inside the dialog.
        const all = [...foot.querySelectorAll('button')];
        const at = all.indexOf(document.activeElement);
        all[(at + (e.shiftKey ? -1 : 1) + all.length) % all.length].focus();
      } else return;
      e.preventDefault();
      e.stopPropagation();
    };
    box.addEventListener('click', onClick);
    box.addEventListener('keydown', onKey, true);
    appDialogPending = done;
    (primary || foot.querySelector('button')).focus();
  });
}

/** Stand-in for the dialog plugin's ask(): Yes / No (or okLabel / cancelLabel), resolves true / false. */
async function appAsk(text, opts = {}) {
  if (typeof opts === 'string') opts = { title: opts };
  const ok = opts.okLabel || 'Yes';
  const cancel = opts.cancelLabel || 'No';
  const answer = await showAppDialog({
    title: opts.title,
    text,
    kind: opts.kind === 'warning' || opts.kind === 'error' ? opts.kind : 'question',
    buttons: [
      { answer: 'yes', label: ok, key: ok === 'Yes' ? 'y' : undefined, primary: true },
      { answer: 'no', label: cancel, key: cancel === 'No' ? 'n' : undefined },
    ],
    escape: 'no',
  });
  return answer === 'yes';
}

/** Stand-in for the dialog plugin's message(): one OK button. */
async function appMessage(text, opts = {}) {
  if (typeof opts === 'string') opts = { title: opts };
  await showAppDialog({ title: opts.title, text, kind: opts.kind || 'info', buttons: [{ answer: 'ok', label: 'OK', primary: true }], escape: 'ok' });
}
// Every existing dialogApi.ask / dialogApi.message call (and the tests that replace them) goes
// through the in-window dialog. File pickers (open / save) stay the Windows ones.
dialogApi.ask = appAsk;
dialogApi.confirm = appAsk;
dialogApi.message = appMessage;

async function closeTab(id) {
  const doc = docs.find((d) => d.id === id);
  if (!doc) return;
  if (doc.dirty) {
    // Yes saves, No closes without saving, Cancel (or Esc) keeps the tab open.
    const answer = await askSaveYesNoCancel('Save changes to "' + tabTitle(doc) + '" before closing?');
    if (answer === 'cancel') return;
    if (answer === 'yes') {
      const ok = await saveDocGeneric(doc);
      if (!ok) return;
    }
  }
  rememberClosedTab(doc); // Ctrl+Shift+T brings it back (with any unsaved text)
  removeDoc(id);
}

/* ---------- session: tabs + remembered UI state ---------- */

// Everything that must survive a restart lives in session.json (written by Rust before the window
// closes). Browser storage is NOT used for this: the window is destroyed straight after the final
// save, and WebView2 can lose localStorage writes that haven't been flushed yet.

let sessionTimer = 0;
function scheduleSessionSave() {
  if (!sessionReady) return;
  clearTimeout(sessionTimer);
  sessionTimer = setTimeout(saveSessionNow, 800);
}

function captureUi() {
  return {
    theme: themeOverride,
    splitRatio,
    lineNumbers: lineNumbersVisible,
    toolbar: !toolbarEl.classList.contains('hidden'),
    spell: { enabled: spell.enabled, lang: spell.lang, userWords: [...spell.userWords] },
    window: windowState,
    find: captureFindState(),
    settings,
    recent: recentFiles,
    visitedLinks: [...visitedLinks],
  };
}

function buildSession() {
  return JSON.stringify({
    version: 2,
    activeIndex: docs.findIndex((d) => d.id === activeId),
    ui: captureUi(),
    docs: docs.map((d) => ({
      path: d.path,
      untitledNum: d.untitledNum || null,
      customTitle: d.customTitle || undefined,
      lang: d.lang,
      langOverride: d.langOverride || undefined,
      pinned: d.pinned,
      layoutMode: d.layoutMode,
      fontSize: d.fontSize,
      bookmarks: d.bookmarks && Object.keys(d.bookmarks).length ? d.bookmarks : undefined,
      encoding: d.encoding,
      eol: d.eol,
      dirty: d.dirty,
      follow: d.follow || undefined,
      // Saved files are re-read from disk on restore; only unsaved text needs storing.
      content: d.dirty || !d.path ? d.content : null,
    })),
  });
}

async function saveSessionNow() {
  clearTimeout(sessionTimer);
  sessionTimer = 0;
  if (!sessionReady) return;
  // Saves run one after another (each writes off the UI thread), so an older session can never
  // land after a newer one.
  const json = buildSession();
  const run = sessionSaveChain.then(() => invoke('cmd_session_save', { json })).catch((e) => console.error('Session save failed', e));
  sessionSaveChain = run;
  return run;
}
let sessionSaveChain = Promise.resolve();

async function loadSessionFile() {
  try {
    const raw = await invoke('cmd_session_load');
    return raw ? JSON.parse(raw) : null;
  } catch (e) {
    return null;
  }
}

/** UI preferences; falls back to the old localStorage keys for sessions written by earlier versions. */
function applyUi(ui) {
  const ls = (k) => {
    try {
      return localStorage.getItem(k);
    } catch (e) {
      return null;
    }
  };
  ui = ui || {};
  loadSettings(ui.settings);
  themeOverride =ui.theme !== undefined ? ui.theme : ls('theme-override');
  const ratio = ui.splitRatio !== undefined ? ui.splitRatio : parseFloat(ls('split-ratio'));
  if (typeof ratio === 'number' && !isNaN(ratio)) splitRatio = Math.min(0.85, Math.max(0.15, ratio));
  setLineNumbersVisible(ui.lineNumbers !== undefined ? !!ui.lineNumbers : ls('line-numbers-visible') === 'true');
  setToolbarVisible(!!ui.toolbar);
  const sp = ui.spell || {};
  const lang = sp.lang || ls('spell-lang');
  if (SPELL_LANG_LABELS[lang]) spell.lang = lang;
  spell.enabled = sp.enabled !== undefined ? !!sp.enabled : ls('spell-enabled') !== 'false';
  let words = sp.userWords;
  if (!words) {
    try {
      words = JSON.parse(ls('spell-user-words') || '[]');
    } catch (e) {
      words = [];
    }
  }
  words.forEach((w) => spell.userWords.add(w));
  windowState = ui.window || null;
  recentFiles = Array.isArray(ui.recent) ? ui.recent.filter((p) => typeof p === 'string').slice(0, 10) : [];
  setVisitedLinks(ui.visitedLinks);
}

async function restoreDocs(s) {
  if (!s) return { docs: [], active: null };
  const restored = [];
  let active = null;
  const list = Array.isArray(s.docs) ? s.docs : [];
  for (let i = 0; i < list.length; i++) {
    const d = list[i];
    const opts = {
      pinned: d.pinned,
      layoutMode: layoutLabels[d.layoutMode] ? d.layoutMode : undefined,
      fontSize: d.fontSize >= MIN_FONT_SIZE && d.fontSize <= MAX_FONT_SIZE ? d.fontSize : undefined,
      bookmarks: d.bookmarks && typeof d.bookmarks === 'object' ? d.bookmarks : undefined,
    };
    let doc = null;
    if (d.path && d.langOverride && LANGS[d.lang]) {
      opts.lang = d.lang;
      opts.langOverride = true;
    }
    if (d.path) {
      let disk = null;
      try {
        disk = await invoke('cmd_read_file', { path: d.path });
      } catch (e) {
        /* file moved or deleted */
      }
      const fromDisk = disk ? normalizeEol(disk.content) : null;
      opts.encoding = disk ? disk.encoding : d.encoding;
      opts.eol = fromDisk ? fromDisk.eol : d.eol;
      if (d.dirty && typeof d.content === 'string') {
        // Unsaved edits win; if the file is gone the tab simply stays unsaved.
        doc = makeDoc(d.path, d.content, { ...opts, savedContent: fromDisk ? fromDisk.text : null });
      } else if (fromDisk) {
        doc = makeDoc(d.path, fromDisk.text, opts);
      }
      if (doc && disk) setDiskStat(doc, disk);
      if (doc) doc.follow = !!d.follow;
    } else {
      // Untitled tabs come back even when empty, so a restart never removes a tab.
      let num = d.untitledNum;
      if (!num || restored.some((r) => !r.path && r.untitledNum === num)) num = lowestFreeUntitledNum(restored);
      doc = makeDoc(null, typeof d.content === 'string' ? d.content : '', { ...opts, untitledNum: num, customTitle: typeof d.customTitle === 'string' ? d.customTitle : null, lang: LANGS[d.lang] ? d.lang : 'markdown' });
    }
    if (doc) {
      restored.push(doc);
      if (i === s.activeIndex) active = doc.id;
    }
  }
  return { docs: restored, active };
}

/* ---------- window size & position ---------- */

async function restoreWindow() {
  const tw = window.__TAURI__.window;
  const dpi = window.__TAURI__.dpi || tw;
  const w = tw.getCurrentWindow();
  const g = windowState;
  try {
    if (g && g.w >= 300 && g.h >= 200) {
      let onScreen = true;
      try {
        const mons = await tw.availableMonitors();
        onScreen = mons.some(
          (m) =>
            g.x < m.position.x + m.size.width - 80 &&
            g.x + g.w > m.position.x + 80 &&
            g.y >= m.position.y - 10 &&
            g.y < m.position.y + m.size.height - 80
        );
      } catch (e) {
        /* assume visible */
      }
      await w.setSize(new dpi.PhysicalSize(g.w, g.h));
      if (onScreen) await w.setPosition(new dpi.PhysicalPosition(g.x, g.y));
      else await w.center();
      if (g.maximized) await w.maximize();
    }
  } catch (e) {
    console.error('Could not restore window size/position', e);
  }
  try {
    await w.show();
    await w.setFocus();
  } catch (e) {
    /* the Rust side shows the window anyway after a few seconds */
  }
  trackWindow(w);
}

function trackWindow(w) {
  let timer = 0;
  const update = async () => {
    try {
      if (await w.isMinimized()) return;
      if (await w.isMaximized()) {
        windowState = { ...(windowState || {}), maximized: true };
      } else {
        // Position is the outer (frame) corner; size is the inner size, because setSize() sets inner size.
        const p = await w.outerPosition();
        const s = await w.innerSize();
        windowState = { x: p.x, y: p.y, w: s.width, h: s.height, maximized: false };
      }
      scheduleSessionSave();
    } catch (e) {
      /* ignore */
    }
  };
  const later = () => {
    clearTimeout(timer);
    timer = setTimeout(update, 400);
  };
  w.onResized(later);
  w.onMoved(later);
  update();
}

async function handleCloseRequested() {
  // Tell Rust the page is handling the close, so its safety-net timer won't kill a save prompt.
  try {
    await invoke('cmd_close_ack');
  } catch (e) {
    /* older backend */
  }
  saveDocView(getActive());
  // With session restore on there is no prompt - every tab, including unsaved
  // edits, comes back on next launch. With it off, unsaved changes are offered for saving.
  if (!settings.restoreSession) {
    const dirty = docs.filter((d) => d.dirty);
    if (dirty.length) {
      const answer = await askSaveYesNoCancel(
        'Save changes to ' + dirty.map(tabTitle).join(', ') + ' before closing?\n\n(Session restore is off in Settings, so unsaved changes will be lost otherwise.)'
      );
      if (answer === 'cancel') {
        await invoke('cmd_close_cancelled'); // the app stays open
        return;
      }
      if (answer === 'yes') {
        for (const d of dirty) {
          if (!(await saveDocGeneric(d))) {
            await invoke('cmd_close_cancelled');
            return;
          }
        }
      }
    }
  }
  await saveSessionNow();
  await invoke('cmd_force_close');
}

/* ---------- file operations ---------- */

function saveFilters(doc) {
  const info = langInfo(doc);
  return [
    { name: info.label, extensions: info.exts },
    { name: 'All Files', extensions: ['*'] },
  ];
}

async function saveDocGeneric(doc, forcePrompt) {
  let path = doc.path;
  if (!path || forcePrompt) {
    path = await invoke('cmd_save_dialog', {
      filters: saveFilters(doc),
      defaultPath: doc.path || (/\.[A-Za-z0-9]{1,8}$/.test(tabTitle(doc)) ? tabTitle(doc) : tabTitle(doc) + '.' + langInfo(doc).exts[0]),
    });
    if (!path) return false;
  }
  // Changed by another program since it was opened? Ask before overwriting it.
  const check = await confirmOverwriteIfChanged(doc, path);
  if (!check) return false;
  const out = doc.eol === 'crlf' ? doc.content.replace(/\n/g, '\r\n') : doc.content;
  let st = null;
  doc.saving = true; // the disk watcher must not mistake our own write for someone else's
  try {
    try {
      st = await invoke('cmd_write_file', { path, content: out, encoding: doc.encoding, expect: check.expect });
    } catch (err) {
      // Another program changed the file in the moment between our check and the write.
      if (String(err) !== 'CHANGED_ON_DISK') throw err;
      if (!(await askOverwriteChanged(doc))) {
        doc.saving = false;
        return false;
      }
      st = await invoke('cmd_write_file', { path, content: out, encoding: doc.encoding, expect: null });
    }
  } catch (err) {
    doc.saving = false;
    await dialogApi.message('Could not save "' + basename(path) + '":\n' + err + '\n\nThe file on disk was not changed.', { title: 'Save', kind: 'error' });
    return false;
  }
  doc.saving = false;
  // ANSI can't hold some characters now in the text, so it was saved as UTF-8 instead.
  const switchedToUtf8 = !!(st && st.encoding && st.encoding !== doc.encoding && doc.encoding === 'latin1');
  if (st && st.encoding) doc.encoding = st.encoding;
  const langChanged = doc.path !== path && !doc.langOverride && langForPath(path) !== doc.lang;
  const newPath = !doc.path || !samePath(doc.path, path);
  doc.path = path;
  doc.savedContent = doc.content;
  doc.dirty = false;
  setDiskStat(doc, st);
  doc.conflict = null;
  doc.missing = false;
  doc.ignoredDisk = null;
  if (langChanged) doc.lang = langForPath(path);
  if (newPath) addRecent(path);
  updateDiskNotice();
  renderTabs();
  if (langChanged && doc.id === activeId) loadActiveDocIntoPanes();
  updateStatusBar();
  if (switchedToUtf8 && doc.id === activeId) flashFindStatus('Saved as UTF-8: the text has characters that ANSI (Windows-1252) cannot store.');
  scheduleSessionSave();
  return true;
}

function saveActive() {
  return saveDocGeneric(getActive());
}

function saveActiveAs() {
  return saveDocGeneric(getActive(), true);
}

/** Opens a file in a new tab (or switches to it if it is already open). */
async function openPath(path, { quiet = false } = {}) {
  const existing = docs.find((d) => d.path && samePath(d.path, path));
  if (existing) {
    setActiveTab(existing.id);
    addRecent(existing.path);
    return existing;
  }
  let data;
  try {
    data = await invoke('cmd_read_file', { path });
  } catch (err) {
    if (!quiet) await dialogApi.message('Could not open "' + basename(path) + '":\n' + err, { title: 'Open File', kind: 'error' });
    return null;
  }
  const { text, eol } = normalizeEol(data.content);
  // Big files (logs) open in Edit Only; colouring, spelling and indent guides switch off by themselves.
  const large = text.length > LARGE_FILE_CHARS;
  const doc = makeDoc(data.path, text, { encoding: data.encoding, eol, layoutMode: large ? 'edit-only' : undefined });
  setDiskStat(doc, data);
  addRecent(data.path);
  if (large)
    setTimeout(
      () =>
        flashFindStatus(
          'Large file (' + (data.size / 1048576).toFixed(1) + ' MB): opened in Edit Only' +
            (editor.isCodeMirror ? '. Its preview shows the first 4 MB.' : ', without spell checking. Colours appear when you pause typing.')
        ),
      50
    );
  const active = getActive();
  const idx = active ? docs.indexOf(active) : -1;
  if (active && !active.path && !active.dirty && active.content === '' && !active.pinned) {
    // Replace the blank starter tab instead of leaving an empty "Untitled" behind.
    docs[idx] = doc;
    activeId = doc.id;
    renderTabs();
    loadActiveDocIntoPanes();
    scheduleFindRefresh(false);
    scheduleSessionSave();
  } else {
    addDocAndActivate(doc);
  }
  return doc;
}

async function openFile() {
  const allExts = Object.keys(EXT_LANG);
  const selected = await dialogApi.open({
    multiple: true,
    filters: [
      { name: 'All Supported', extensions: allExts },
      { name: 'Markdown', extensions: ['md', 'markdown'] },
      { name: 'Text', extensions: ['txt', 'log'] },
      { name: 'BBCode', extensions: ['bbcode', 'bb'] },
      { name: 'Code / Config', extensions: allExts.filter((e) => !['md', 'markdown', 'mdown', 'mkd', 'txt', 'text', 'log', 'bbcode', 'bb'].includes(e)) },
      { name: 'All Files', extensions: ['*'] },
    ],
  });
  if (!selected) return;
  const paths = Array.isArray(selected) ? selected : [selected];
  for (const p of paths) await openPath(p);
}

async function deleteActiveFile() {
  const doc = getActive();
  if (!doc) return;
  if (!doc.path) {
    await dialogApi.message('This file has not been saved yet.', { title: 'Delete File', kind: 'info' });
    return;
  }
  const ok = await dialogApi.ask('Permanently delete "' + basename(doc.path) + '" from disk? This cannot be undone.', {
    title: 'Delete File',
    kind: 'warning',
  });
  if (!ok) return;
  try {
    await invoke('cmd_delete_file', { path: doc.path });
  } catch (err) {
    await dialogApi.message('Could not delete file: ' + err, { title: 'Error', kind: 'error' });
    return;
  }
  removeDoc(doc.id);
}

/* ---------- drag & drop ---------- */

function wireDragDrop() {
  listen('tauri://drag-enter', () => dropOverlay.classList.remove('hidden'));
  listen('tauri://drag-leave', () => dropOverlay.classList.add('hidden'));
  listen('tauri://drag-drop', async (event) => {
    dropOverlay.classList.add('hidden');
    const paths = (event.payload && event.payload.paths) || [];
    for (const p of paths) await openPath(p);
  });
}

/* ---------- editor-mode text transforms ---------- */

function wrapEditorSelection(before, after) {
  const start = editor.selectionStart;
  const end = editor.selectionEnd;
  const value = editor.value;
  const selected = value.slice(start, end);
  editor.value = value.slice(0, start) + before + selected + after + value.slice(end);
  editor.selectionStart = start + before.length;
  editor.selectionEnd = start + before.length + selected.length;
  editor.focus();
  syncFromEditor();
}

function insertAtCursorEditor(text) {
  const start = editor.selectionStart;
  const end = editor.selectionEnd;
  const value = editor.value;
  editor.value = value.slice(0, start) + text + value.slice(end);
  const cursor = start + text.length;
  editor.selectionStart = editor.selectionEnd = cursor;
  editor.focus();
  syncFromEditor();
}

function transformEditorLines(transform) {
  const start = editor.selectionStart;
  const end = editor.selectionEnd;
  const value = editor.value;
  const lineStart = value.lastIndexOf('\n', start - 1) + 1;
  let lineEnd = value.indexOf('\n', end);
  if (lineEnd === -1) lineEnd = value.length;
  const block = value.slice(lineStart, lineEnd);
  const newBlock = block.split('\n').map(transform).join('\n');
  editor.value = value.slice(0, lineStart) + newBlock + value.slice(lineEnd);
  editor.selectionStart = lineStart;
  editor.selectionEnd = lineStart + newBlock.length;
  editor.focus();
  syncFromEditor();
}

function codeBlockEditor() {
  const start = editor.selectionStart;
  const end = editor.selectionEnd;
  const value = editor.value;
  const selected = value.slice(start, end) || 'code';
  const snippet = '```\n' + selected + '\n```';
  editor.value = value.slice(0, start) + snippet + value.slice(end);
  editor.selectionStart = start + 4;
  editor.selectionEnd = start + 4 + selected.length;
  editor.focus();
  syncFromEditor();
}

/* ---------- preview-mode commands ---------- */

function previewExec(cmd, value) {
  preview.focus();
  document.execCommand(cmd, false, value);
  syncFromPreview();
}

function codeBlockPreview() {
  const sel = window.getSelection();
  const text = sel && sel.toString() ? sel.toString() : 'code';
  preview.focus();
  document.execCommand('insertHTML', false, '<pre><code>' + escapeHtml(text) + '</code></pre>');
  ensureTrailingParagraph();
  syncFromPreview();
}

function tablePreview() {
  preview.focus();
  document.execCommand(
    'insertHTML',
    false,
    '<table><thead><tr><th>Column 1</th><th>Column 2</th></tr></thead><tbody><tr><td>Cell 1</td><td>Cell 2</td></tr></tbody></table><p></p>'
  );
  syncFromPreview();
}

function checklistPreview() {
  preview.focus();
  document.execCommand('insertHTML', false, '<ul><li><input type="checkbox"> New task</li></ul>');
  enableCheckboxes();
  syncFromPreview();
}

/** Toolbar commands act on the preview only when it is the editable Markdown preview. */
function previewTarget() {
  return lastFocused === 'preview' && isEditablePreview(getActive());
}

function applyHeading(level) {
  const bb = langInfo(getActive()).render === 'bbcode';
  if (bb && level > 3) return; // BBCode has [h1] to [h3]
  if (bb && !previewTarget()) {
    bbToolbarCommand(null, level);
  } else if (previewTarget()) {
    previewExec('formatBlock', '<h' + level + '>');
  } else {
    transformEditorLines((l) => '#'.repeat(level) + ' ' + l.replace(/^#{1,6}\s*/, ''));
  }
}

/* ---------- clipboard ---------- */

function getSelectedText() {
  if (lastFocused === 'editor') return editor.value.slice(editor.selectionStart, editor.selectionEnd);
  const sel = window.getSelection();
  return sel ? sel.toString() : '';
}

async function doCopy() {
  const text = getSelectedText();
  if (!text) return;
  await clipboard.writeText(text);
}

async function doCut() {
  const text = getSelectedText();
  if (!text) return;
  await clipboard.writeText(text);
  if (lastFocused === 'editor') {
    const start = editor.selectionStart;
    const end = editor.selectionEnd;
    editor.value = editor.value.slice(0, start) + editor.value.slice(end);
    editor.selectionStart = editor.selectionEnd = start;
    editor.focus();
    syncFromEditor();
  } else if (previewTarget()) {
    preview.focus();
    window.getSelection().deleteFromDocument();
    syncFromPreview();
  }
}

async function doPaste() {
  const text = await clipboard.readText();
  if (text == null) return;
  if (lastFocused === 'editor' || !previewTarget()) {
    insertAtCursorEditor(text);
  } else {
    preview.focus();
    document.execCommand('insertText', false, text);
    syncFromPreview();
  }
}


/* ---------- images ---------- */

// Local pictures are served by the Rust side (custom "localimg" protocol), because the WebView
// can't load file paths directly. The preview keeps the path as written in the Markdown in
// data-md-src, so editing in the preview writes the original path back, not the served URL.

const IMAGE_EXTS = ['png', 'jpg', 'jpeg', 'gif', 'webp', 'bmp', 'svg', 'ico', 'avif', 'jfif'];

function dirOf(p) {
  const s = p.replace(/\\/g, '/');
  return s.slice(0, s.lastIndexOf('/'));
}

/** Absolute local path for an image reference in a document, or null for web/data images. */
function resolveImagePath(src, doc) {
  if (!src || /^(https?:|data:|blob:)/i.test(src)) return null;
  let s = src;
  try {
    s = decodeURI(src);
  } catch (e) {
    /* keep as written */
  }
  s = s.replace(/^file:\/\/\/?/i, '').replace(/\\/g, '/');
  if (/^[a-z]:\//i.test(s) || s.startsWith('//')) return s;
  if (!doc || !doc.path) return null;
  const parts = dirOf(doc.path).split('/');
  for (const seg of s.split('/')) {
    if (seg === '..') parts.length > 1 && parts.pop();
    else if (seg !== '.' && seg !== '') parts.push(seg);
  }
  return parts.join('/');
}

function localImageUrl(abs) {
  return 'http://localimg.localhost/' + encodeURIComponent(abs);
}

function fixPreviewImages(doc) {
  for (const img of preview.querySelectorAll('img')) {
    const src = img.getAttribute('src');
    const abs = resolveImagePath(src, doc);
    if (!abs) continue;
    img.setAttribute('data-md-src', src);
    img.src = localImageUrl(abs);
  }
}

/** Path to write into the Markdown: relative to the document when it is saved, else absolute. */
function imageRefFor(file, doc) {
  const target = file.replace(/\\/g, '/');
  let ref = target;
  if (doc && doc.path) {
    const from = dirOf(doc.path).split('/');
    const to = target.split('/');
    if (from[0].toLowerCase() === to[0].toLowerCase()) {
      let i = 0;
      while (i < from.length && i < to.length - 1 && from[i].toLowerCase() === to[i].toLowerCase()) i++;
      // Sharing only the drive (C:/) isn't worth a long ../../.. chain: keep it absolute.
      if (i > 1) ref = [...Array(from.length - i).fill('..'), ...to.slice(i)].join('/');
    }
  }
  // Spaces and brackets would end the link early.
  return ref.replace(/[ ()<>]/g, (c) => encodeURIComponent(c));
}

async function insertImage() {
  const doc = getActive();
  if (!doc) return;
  const pv = previewTarget();
  const sel = window.getSelection();
  const range = pv && sel.rangeCount ? sel.getRangeAt(0).cloneRange() : null;
  const file = await dialogApi.open({
    multiple: false,
    title: 'Insert Image',
    defaultPath: doc.path ? dirOf(doc.path).replace(/\//g, '\\') : undefined,
    filters: [{ name: 'Images', extensions: IMAGE_EXTS }, { name: 'All Files', extensions: ['*'] }],
  });
  if (!file) return;
  const path = typeof file === 'string' ? file : file.path;
  const alt = basename(path).replace(/\.[^.]+$/, '').replace(/[\[\]]/g, '');
  const ref = imageRefFor(path, doc);
  if (pv && isMarkdownPreview(doc)) {
    preview.focus();
    if (range) {
      sel.removeAllRanges();
      sel.addRange(range);
    }
    const html =
      '<img alt="' + escapeHtml(alt).replace(/"/g, '&quot;') + '" data-md-src="' + escapeHtml(ref).replace(/"/g, '&quot;') +
      '" src="' + localImageUrl(path.replace(/\\/g, '/')) + '">';
    document.execCommand('insertHTML', false, html);
    syncFromPreview();
  } else {
    insertAtCursorEditor('![' + alt + '](' + ref + ')');
  }
}
/* ---------- toolbar dispatch ---------- */

function runToolbarCommand(cmd) {
  const pv = previewTarget();
  // BBCode tabs: the editor gets BBCode tags; in the preview, only what BBCode has.
  if (langInfo(getActive()).render === 'bbcode') {
    if (!pv && bbToolbarCommand(cmd)) return;
    if (pv && cmd === 'checklist') return flashFindStatus('BBCode has no checklists: use a list instead.');
    if (pv && cmd === 'image') {
      previewExec('insertText', '[img]https://[/img]');
      return;
    }
  }
  switch (cmd) {
    // execCommand undoes in whatever has the focus; CodeMirror keeps its own history, so it gets
    // the command unless the preview is the one with the focus.
    case 'undo':
      if (editor.isCodeMirror && !preview.contains(document.activeElement)) editor.undo();
      else document.execCommand('undo');
      break;
    case 'redo':
      if (editor.isCodeMirror && !preview.contains(document.activeElement)) editor.redo();
      else document.execCommand('redo');
      break;
    case 'toggle-line-numbers':
      toggleLineNumbers();
      break;
    case 'bold':
      pv ? previewExec('bold') : toggleInlineFormat('bold') || wrapEditorSelection('**', '**');
      break;
    case 'italic':
      pv ? previewExec('italic') : toggleInlineFormat('italic') || wrapEditorSelection('_', '_');
      break;
    case 'strike':
      pv ? previewExec('strikeThrough') : wrapEditorSelection('~~', '~~');
      break;
    case 'underline':
      pv ? previewExec('underline') : wrapEditorSelection('<u>', '</u>');
      break;
    case 'copy':
      doCopy();
      break;
    case 'cut':
      doCut();
      break;
    case 'paste':
      doPaste();
      break;
    case 'table':
      pv ? tablePreview() : insertAtCursorEditor('\n| Column 1 | Column 2 |\n| --- | --- |\n| Cell 1 | Cell 2 |\n');
      break;
    case 'code-block':
      pv ? codeBlockPreview() : codeBlockEditor();
      break;
    case 'image':
      insertImage();
      break;
    case 'checklist':
      pv
        ? checklistPreview()
        : transformEditorLines((l) =>
            /^\s*-\s\[[ xX]\]\s/.test(l)
              ? l.replace(/^(\s*)-\s\[[ xX]\]\s/, '$1')
              : l.trim() === ''
              ? l
              : '- [ ] ' + l.replace(/^[-*]\s/, '')
          );
      break;
    case 'ordered-list':
      pv
        ? previewExec('insertOrderedList')
        : transformEditorLines((l, i) => (l.trim() === '' ? l : i + 1 + '. ' + l.replace(/^\s*\d+\.\s/, '')));
      break;
    case 'bullet-list':
      pv
        ? previewExec('insertUnorderedList')
        : transformEditorLines((l) =>
            l.trim() === '' ? l : /^\s*-\s/.test(l) ? l : '- ' + l.replace(/^[-*]\s/, '')
          );
      break;
    case 'outdent':
      pv ? previewExec('outdent') : transformEditorLines((l) => l.replace(/^(\s{1,2}|\t)/, ''));
      break;
    case 'indent':
      pv ? previewExec('indent') : transformEditorLines((l) => '  ' + l);
      break;
    case 'font-dec':
      changeFontSize(-1);
      break;
    case 'font-inc':
      changeFontSize(1);
      break;
    case 'find-replace':
      openFindBar();
      break;
    case 'delete-file':
      deleteActiveFile();
      break;
  }
}

/* ---------- wiring ---------- */

function wireDomEvents() {
  editor.addEventListener('input', syncFromEditor);
  editor.addEventListener('scroll', () => {
    editorHighlight.scrollTop = editor.scrollTop;
    editorHighlight.scrollLeft = editor.scrollLeft;
    if (lineNumbersVisible) renderGutter();
  });
  editor.addEventListener('focus', () => (lastFocused = 'editor'));
  editor.addEventListener('mousedown', () => {
    if (findState.navLine) {
      findState.navLine = null;
      scheduleOverlay();
    }
  });
  editor.addEventListener('contextmenu', (e) => {
    // On a link, WebView2's own menu opens with the link items added at the top (linkmenu.rs).
    let span;
    let start;
    if (editor.isCodeMirror) {
      // CodeMirror draws the text itself: the click lands on the spelling mark.
      span = e.target.closest && e.target.closest('.spell-err');
      if (span) start = editor.api.posAtDOM(span);
    } else {
      if (!editor.classList.contains('hl-active')) return;
      span = [...editorHighlight.querySelectorAll('.spell-err')].find((s) => pointInRects(e.clientX, e.clientY, s.getClientRects()));
      if (span) start = overlayOffsetOf(span);
    }
    if (!span) return;
    e.preventDefault();
    const word = span.dataset.w;
    showSpellMenu(e.clientX, e.clientY, word, (s) => replaceEditorRange(start, start + word.length, s));
  });
  preview.addEventListener('scroll', () => {
    if (lineNumbersVisible) lineNumbersPreviewEl.scrollTop = preview.scrollTop;
  });
  preview.addEventListener('input', syncFromPreview);
  preview.addEventListener('focus', () => (lastFocused = 'preview'));
  preview.addEventListener('keydown', (e) => {
    if (handleTableKey(e)) {
      e.stopPropagation();
      return;
    }
    if (preview.getAttribute('contenteditable') !== 'true') return;
    if (handleCodeBlockKey(e)) return;
    if (e.key === 'Tab' && !e.ctrlKey && !e.altKey && !e.metaKey) {
      e.preventDefault();
      previewTabKey(e.shiftKey);
    }
  });
  editor.addEventListener('keydown', (e) => {
    if (e.key === 'Tab' && !e.ctrlKey && !e.altKey && !e.metaKey) {
      e.preventDefault();
      editorTabKey(e.shiftKey);
    }
  });
  // Links in the editor: underlined, Ctrl+click opens them (a plain click places the caret).
  const overUrl = (e) => {
    if (editor.isCodeMirror) return !!(e.target.closest && e.target.closest('.ov-url'));
    if (!editor.classList.contains('hl-active')) return false;
    return [...editorHighlight.querySelectorAll('.ov-url')].some((s) => pointInRects(e.clientX, e.clientY, s.getClientRects()));
  };
  // Tell the backend which link is under the mouse, so the right-click menu can offer it.
  let hoverLinkSent = null;
  const setHoverLink = (url) => {
    if (url === hoverLinkSent) return;
    hoverLinkSent = url;
    invoke('cmd_set_hover_link', { url }).catch(() => {});
  };
  const linkAt = (e) => {
    if (editor.isCodeMirror) {
      const el = e.target.closest && e.target.closest('.ov-url');
      return (el && el.dataset.url) || null;
    }
    if (!editor.classList.contains('hl-active')) return null;
    const s = [...editorHighlight.querySelectorAll('.ov-url')].find((x) => pointInRects(e.clientX, e.clientY, x.getClientRects()));
    return (s && s.dataset.url) || null;
  };
  editor.addEventListener('mousedown', (e) => {
    if (e.button === 2) setHoverLink(linkAt(e));
  });
  editor.addEventListener('mouseleave', () => setHoverLink(null));
  editor.addEventListener('mousemove', (e) => {
    setHoverLink(linkAt(e));
    const over = overUrl(e);
    editor.classList.toggle('over-url', over);
    document.body.classList.toggle('ctrl-down', e.ctrlKey);
    editor.title = over ? 'Double-click (or Ctrl+click) to open the link; right-click for more' : '';
  });
  editor.addEventListener('mouseleave', () => editor.classList.remove('over-url'));
  // Double-click a link to open it (the browser's word selection is undone first).
  editor.addEventListener('dblclick', (e) => {
    if (e.ctrlKey || e.shiftKey || e.altKey || !overUrl(e)) return;
    const url = urlAtOffset(editor.value, editor.selectionStart);
    if (!url) return;
    e.preventDefault();
    editor.setSelectionRange(editor.selectionStart, editor.selectionStart);
    openUrl(url);
  });
  editor.addEventListener('click', (e) => {
    if (!e.ctrlKey || e.shiftKey || e.altKey) return;
    if (editor.selectionStart !== editor.selectionEnd) return;
    const url = urlAtOffset(editor.value, editor.selectionStart);
    if (url) {
      e.preventDefault();
      openUrl(url);
    }
  });
  const trackCtrl = (e) => document.body.classList.toggle('ctrl-down', e.ctrlKey);
  window.addEventListener('keydown', trackCtrl, true);
  window.addEventListener('keyup', trackCtrl, true);
  window.addEventListener('blur', () => document.body.classList.remove('ctrl-down'));
  preview.addEventListener('contextmenu', (e) => {
    const range = spell.previewRanges.find((r) => pointInRects(e.clientX, e.clientY, r.getClientRects()));
    if (!range) {
      // Right-click in a table of the editable Markdown preview: row/column commands.
      const cell = preview.getAttribute('contenteditable') === 'true' ? previewCellAt(e.target) : null;
      if (cell) {
        e.preventDefault();
        showTableMenu(e.clientX, e.clientY, cell);
      }
      return;
    }
    e.preventDefault();
    const word = range.toString();
    const editable = preview.getAttribute('contenteditable') === 'true';
    showSpellMenu(e.clientX, e.clientY, word, editable ? (s) => replacePreviewRange(range, s) : null);
  });
  preview.addEventListener('click', (e) => {
    const link = e.target.closest('a');
    if (link && link.href && /^https?:\/\//i.test(link.href)) {
      e.preventDefault();
      e.stopPropagation();
      noteVisitedLink(link.href);
      invoke('cmd_open_url', { url: link.href });
      return;
    }
    const copyBtn = e.target.closest('.code-copy-btn');
    if (copyBtn) {
      e.preventDefault();
      e.stopPropagation();
      const pre = copyBtn.closest('pre');
      if (pre) copyCodeBlock(pre);
      return;
    }
    if (e.target && e.target.matches && e.target.matches('input[type="checkbox"]')) syncFromPreview();
  });

  setupResizer();

  sidebarEl.addEventListener('mousedown', (e) => {
    if (e.target.closest('button')) e.preventDefault(); // keep focus/caret where it was
  });
  sidebarEl.addEventListener('click', (e) => {
    const btn = e.target.closest('button[data-layout]');
    if (btn) {
      setLayoutMode(btn.dataset.layout);
      focusForTyping(); // ready to type in the view just chosen
    }
  });

  // Mouse wheel over the tabs steps exactly like the ‹ › buttons (touchpads scroll smoothly).
  tabbarEl.addEventListener(
    'wheel',
    (e) => {
      if (e.ctrlKey) return; // Ctrl+wheel is zoom
      const delta = Math.abs(e.deltaX) > Math.abs(e.deltaY) ? e.deltaX : e.deltaY;
      if (!delta || tabbarEl.scrollWidth <= tabbarEl.clientWidth) return;
      e.preventDefault();
      if (e.deltaMode === 0 && Math.abs(delta) < 50) tabbarEl.scrollLeft += delta;
      else scrollTabs(Math.sign(delta));
    },
    { passive: false }
  );
  tabbarEl.addEventListener('scroll', updateTabScrollButtons);
  window.addEventListener('resize', updateTabScrollButtons);
  tabScrollEl.addEventListener('mousedown', (e) => e.preventDefault());
  tabScrollEl.addEventListener('click', (e) => {
    const btn = e.target.closest('button[data-dir]');
    if (btn) scrollTabs(Number(btn.dataset.dir));
  });
  tabbarEl.addEventListener('dblclick', (e) => {
    if (e.target === tabbarEl) openNewTab();
  });
  // [+] after the tabs, and double-click on the empty part of the tab bar: a new tab.
  const tabNewBtn = document.getElementById('tab-new');
  tabNewBtn.addEventListener('mousedown', (e) => e.preventDefault()); // keep focus in the editor
  tabNewBtn.addEventListener('click', openNewTab); // scrolls the new tab into view
  tabbarEl.parentElement.addEventListener('dblclick', (e) => {
    if (e.target === tabbarEl.parentElement) openNewTab();
  });

  // Ctrl+mouse wheel zooms the active tab (and stops WebView2's own page zoom).
  let zoomAccum = 0;
  window.addEventListener(
    'wheel',
    (e) => {
      if (!e.ctrlKey) return;
      e.preventDefault();
      if (e.deltaMode !== 0 || Math.abs(e.deltaY) >= 50) {
        zoomAccum = 0;
        changeFontSize(e.deltaY < 0 ? 1 : -1);
      } else {
        zoomAccum += e.deltaY;
        if (Math.abs(zoomAccum) >= 50) {
          changeFontSize(zoomAccum < 0 ? 1 : -1);
          zoomAccum = 0;
        }
      }
    },
    { passive: false }
  );

  statusSpell.addEventListener('click', () => {
    if (!spell.enabled) setSpellLang(spell.lang);
    else setSpellLang(spell.lang === 'en_GB' ? 'en_US' : 'en_GB');
  });
  statusZoom.addEventListener('click', resetFontSize);
  statusLang.addEventListener('click', () => showLanguageMenu(statusLang));
  previewModeBtn.addEventListener('mousedown', (e) => e.preventDefault());
  previewModeBtn.addEventListener('click', togglePreviewMode);
  previewModeBtn.addEventListener('contextmenu', (e) => {
    e.preventDefault();
    showLanguageMenu(previewModeBtn);
  });

  document.addEventListener('mousedown', (e) => {
    if (!ctxMenu.classList.contains('hidden') && !contextMenuContains(e.target)) hideContextMenu();
  });
  window.addEventListener('blur', hideContextMenu);
  window.addEventListener('resize', hideContextMenu);
  editor.addEventListener('scroll', hideContextMenu);
  preview.addEventListener('scroll', hideContextMenu);

  toolbarEl.addEventListener('mousedown', (e) => {
    if (e.target.closest('button')) e.preventDefault();
  });
  toolbarEl.addEventListener('click', (e) => {
    const headingBtn = e.target.closest('button[data-heading]');
    if (headingBtn) {
      applyHeading(Number(headingBtn.dataset.heading));
      return;
    }
    const btn = e.target.closest('button[data-cmd]');
    if (!btn) return;
    runToolbarCommand(btn.dataset.cmd);
  });

  wireFind();
  wireGutter();
  wireDiagnostics();
  wirePreviewLinks();
  wirePositionSync();

  // Alt pressed and released on its own (nothing else in between), while the menu bar is switched
  // off, shows it until a command is picked from it; Alt again, a click or another key hides it.
  let altAlone = false;
  document.addEventListener(
    'keydown',
    (e) => {
      altAlone = e.key === 'Alt' && !e.repeat && !e.ctrlKey && !e.shiftKey && !e.metaKey ? true : e.key === 'Alt' && e.repeat ? altAlone : false;
      if (e.key !== 'Alt') endMenuPeek();
    },
    true
  );
  document.addEventListener(
    'keyup',
    (e) => {
      if (e.key === 'Alt' && altAlone) {
        e.preventDefault();
        altAlone = false;
        peekMenuBar();
      }
    },
    true
  );
  document.addEventListener(
    'mousedown',
    () => {
      altAlone = false;
      endMenuPeek();
    },
    true
  );
  window.addEventListener('blur', () => (altAlone = false));

  // Single source of truth for every keyboard shortcut (native menu accelerators are display-only).
  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape' && !ctxMenu.classList.contains('hidden')) {
      hideContextMenu();
      return;
    }
    if (e.altKey && !e.ctrlKey && !e.metaKey && !e.shiftKey && e.code === 'KeyZ') {
      e.preventDefault();
      toggleWordWrap();
      return;
    }
    const noMods = !e.ctrlKey && !e.altKey && !e.metaKey;
    if (e.key === 'F7' && noMods && !e.shiftKey) {
      e.preventDefault();
      toggleSpell();
      return;
    }
    if (e.key === 'F3' && noMods) {
      e.preventDefault();
      stepMatch(e.shiftKey ? -1 : 1);
      return;
    }
    if (e.key === 'F8' && noMods) {
      e.preventDefault();
      gotoDiagnostic(e.shiftKey ? -1 : 1);
      return;
    }
    if (e.key === 'F2' && !e.altKey && !e.metaKey) {
      e.preventDefault();
      if (e.ctrlKey && !e.shiftKey) toggleBookmarkAtCaret();
      else if (!e.ctrlKey) gotoBookmark(e.shiftKey ? -1 : 1);
      return;
    }

    const mod = e.ctrlKey || e.metaKey;
    if (!mod) return;

    // Layout modes: match the physical key (e.code), not e.key. On Windows, Ctrl+Alt is
    // treated as AltGr, so e.key depends on the keyboard layout (e.g. Ctrl+Alt+4 gives "€"
    // on a UK keyboard) and would otherwise miss the shortcut and type the character.
    if (e.altKey) {
      // Order: Edit, Preview, Edit/Preview, Preview/Edit (same as the sidebar and View menu).
      const layoutByCode = {
        Digit1: 'edit-only', Numpad1: 'edit-only',
        Digit2: 'preview-only', Numpad2: 'preview-only',
        Digit3: 'split-ep', Numpad3: 'split-ep',
        Digit4: 'split-pe', Numpad4: 'split-pe',
      };
      const mode = layoutByCode[e.code];
      if (mode) {
        e.preventDefault();
        setLayoutMode(mode);
        focusForTyping();
      } else if (e.code === 'KeyS' && !e.shiftKey) {
        e.preventDefault();
        saveAll();
      } else if (e.code === 'KeyM' || e.code === 'KeyB') {
        e.preventDefault();
        setPreviewMode(e.code === 'KeyM' ? 'markdown' : 'bbcode');
      }
      return;
    }

    const key = e.key.toLowerCase();
    if (e.code === 'Comma' && !e.shiftKey) {
      e.preventDefault();
      openSettings();
    } else if (e.code === 'KeyE' && e.shiftKey) {
      e.preventDefault();
      toggleSidebar();
    } else if (e.code === 'KeyT' && e.shiftKey) {
      e.preventDefault();
      reopenClosedTab();
    } else if (e.code === 'KeyO' && e.shiftKey) {
      e.preventDefault();
      toggleOutline();
    } else if (e.code === 'KeyG' && !e.shiftKey) {
      e.preventDefault();
      openGotoLine();
    } else if (e.code === 'KeyP' && !e.shiftKey) {
      e.preventDefault();
      printActive();
    } else if ((e.code === 'KeyB' || e.code === 'KeyI') && !e.shiftKey) {
      // Bold / italic. In the editable preview the browser's own Ctrl+B / Ctrl+I already does it.
      if (e.target === editor || (editor.isCodeMirror && editor.contains(e.target))) {
        e.preventDefault();
        toggleInlineFormat(e.code === 'KeyB' ? 'bold' : 'italic');
      } else if (e.target !== preview && !preview.contains(e.target)) e.preventDefault();
    } else if (key === 't') {
      e.preventDefault();
      toggleToolbar();
    } else if (key === 'n') {
      e.preventDefault();
      openNewTab();
    } else if (key === 'o') {
      e.preventDefault();
      openFile();
    } else if (key === 's' && e.shiftKey) {
      e.preventDefault();
      saveActiveAs();
    } else if (key === 's') {
      e.preventDefault();
      saveActive();
    } else if (key === 'l' && e.shiftKey) {
      e.preventDefault();
      toggleLineNumbers();
    } else if (e.code === 'KeyH' && e.shiftKey) {
      e.preventDefault();
      toggleHiddenChars();
    } else if (key === 'f') {
      e.preventDefault();
      openFindBar(e.shiftKey ? true : undefined);
    } else if (key === 'd' && e.shiftKey) {
      e.preventDefault();
      toggleTheme();
    } else if (e.key === '=' || e.key === '+') {
      e.preventDefault();
      changeFontSize(1);
    } else if (e.key === '-') {
      e.preventDefault();
      changeFontSize(-1);
    } else if (e.code === 'Digit0' || e.code === 'Numpad0') {
      e.preventDefault();
      resetFontSize();
    } else if (e.key === 'Tab') {
      e.preventDefault();
      cycleTab(e.shiftKey ? -1 : 1);
    } else if (key === 'w') {
      e.preventDefault();
      closeTab(activeId);
    }
  });
}

/* ---------- ticks in the View menu ---------- */

let lastMenuChecks = '';
let menuCheckTimer = 0;

function currentMenuChecks() {
  const doc = getActive();
  const render = langInfo(doc).render;
  return {
    toolbar: !toolbarEl.classList.contains('hidden'),
    sidebar: !!settings.sidebar,
    menu_bar: !!settings.menuBar,
    status_bar: !!settings.statusBar,
    word_wrap: !!settings.wordWrap,
    toggle_line_numbers: !!lineNumbersVisible,
    show_hidden: !!settings.showHidden,
    bookmark_colour_green: settings.bookmarkColour === 'Green',
    bookmark_colour_orange: settings.bookmarkColour === 'Orange',
    bookmark_colour_red: settings.bookmarkColour === 'Red',
    layout_edit_only: layoutMode === 'edit-only',
    layout_preview_only: layoutMode === 'preview-only',
    layout_edit_left: layoutMode === 'split-ep',
    layout_preview_left: layoutMode === 'split-pe',
    preview_markdown: render === 'markdown',
    preview_bbcode: render === 'bbcode',
    spell_toggle: !!spell.enabled,
    spell_en_gb: spell.enabled && spell.lang === 'en_GB',
    spell_en_us: spell.enabled && spell.lang === 'en_US',
    toggle_theme: document.documentElement.getAttribute('data-theme') === 'dark',
    outline: !!settings.outline,
    follow_file: !!(doc && doc.follow),
    lang_auto: !!doc && !doc.langOverride && doc.lang === langForPath(doc.path),
    ...Object.fromEntries(Object.keys(LANGS).map((k) => ['lang_' + k, !!doc && doc.lang === k])),
  };
}

/** Sends the ticks to the native menu when they changed (force: a click may have flipped one). */
function syncMenuChecks(force) {
  if (force) lastMenuChecks = '';
  clearTimeout(menuCheckTimer);
  menuCheckTimer = setTimeout(() => {
    let checks;
    try {
      checks = currentMenuChecks();
    } catch (e) {
      return; // still starting up
    }
    const key = JSON.stringify(checks);
    if (key === lastMenuChecks) return;
    lastMenuChecks = key;
    invoke('cmd_set_menu_checks', { checks }).catch((e) => console.error('menu ticks', e));
  }, 30);
}

function wireMenuListeners() {
  // Clicking a ticked menu item flips its tick natively; re-send the real state afterwards.
  const listen = (name, fn) =>
    window.__TAURI__.event.listen(name, (e) => {
      fn(e);
      if (name.startsWith('menu-')) syncMenuChecks(true);
    });
  listen('menu-new', openNewTab);
  // Another launch (double-clicked file, "Open with") handed its files to this window.
  listen('open-files', async (e) => {
    while (!sessionReady) await new Promise((r) => setTimeout(r, 100));
    for (const p of e.payload || []) await openPath(p);
  });
  // "Open link in new window" / "Save link as" / "Copy link" chosen in the editor's right-click menu.
  listen('link-menu', (e) => {
    const [action, url] = e.payload || [];
    if (!url) return;
    if (action === 'open') openUrl(url);
    else if (action === 'save') saveLinkAs(url);
    else if (action === 'copy') clipboard.writeText(url).then(() => flashFindStatus('Link copied'));
  });
  listen('menu-open', () => openFile());
  listen('menu-save', () => saveActive());
  listen('menu-save-as', () => saveActiveAs());
  listen('menu-save-all', () => saveAll());
  listen('menu-reopen-closed', () => reopenClosedTab());
  listen('menu-reload-file', () => reloadActiveFromDisk());
  listen('menu-print', () => printActive());
  listen('menu-export-pdf', () => exportPdf());
  listen('menu-export-html', () => exportHtml());
  listen('menu-goto-line', () => openGotoLine());
  listen('menu-fmt-bold', () => toggleInlineFormat('bold'));
  listen('menu-fmt-italic', () => toggleInlineFormat('italic'));
  listen('menu-outline', () => toggleOutline());
  listen('menu-follow-file', () => toggleFollow());
  listen('menu-recent-clear', () => clearRecent());
  for (let i = 0; i < 10; i++) listen('menu-recent-' + i, () => openRecent(i));
  // View > Language > ...
  listen('menu-lang-auto', () => setDocLanguage(null));
  for (const k of Object.keys(LANGS)) listen('menu-lang-' + k, () => setDocLanguage(k));
  listen('menu-close-tab', () => closeTab(activeId));
  listen('menu-delete-file', () => deleteActiveFile());
  listen('menu-toolbar', () => toggleToolbar());
  listen('menu-sidebar', () => toggleSidebar());
  listen('menu-menu-bar', () => toggleMenuBar());
  listen('menu-status-bar', () => toggleStatusBar());
  listen('menu-word-wrap', () => toggleWordWrap());
  listen('menu-settings', () => openSettings());
  listen('menu-about', () => showAbout());
  listen('menu-preview-markdown', () => setPreviewMode('markdown'));
  listen('menu-preview-bbcode', () => setPreviewMode('bbcode'));
  listen('menu-language-menu', () => showLanguageMenu(settings.statusBar ? statusLang : null));
  for (const [ev, mode] of [['preview-only', 'preview-only'], ['edit-only', 'edit-only'], ['preview-left', 'split-pe'], ['edit-left', 'split-ep']]) {
    listen('menu-layout-' + ev, () => {
      setLayoutMode(mode);
      focusForTyping();
    });
  }
  listen('menu-toggle-line-numbers', () => toggleLineNumbers());
  listen('menu-find-replace', () => openFindBar());
  listen('menu-find-advanced', () => openFindBar(true));
  listen('menu-find-next', () => stepMatch(1));
  listen('menu-find-prev', () => stepMatch(-1));
  listen('menu-bookmark-toggle', () => toggleBookmarkAtCaret());
  listen('menu-bookmark-next', () => gotoBookmark(1));
  listen('menu-bookmark-prev', () => gotoBookmark(-1));
  listen('menu-bookmark-clear', () => {
    const d = getActive();
    if (d) clearAllBookmarks(d);
  });
  for (const c of ['Green', 'Orange', 'Red']) listen('menu-bookmark-colour-' + c.toLowerCase(), () => setBookmarkColour(c));
  listen('menu-bookmark-cut', () => bookmarkedLinesAction('cut'));
  listen('menu-bookmark-copy', () => bookmarkedLinesAction('copy'));
  listen('menu-bookmark-paste', () => bookmarkedLinesAction('paste'));
  listen('menu-bookmark-remove', () => bookmarkedLinesAction('remove'));
  listen('menu-bookmark-remove-others', () => bookmarkedLinesAction('remove-others'));
  listen('menu-bookmark-inverse', () => bookmarkedLinesAction('inverse'));
  listen('menu-show-hidden', () => toggleHiddenChars());
  listen('menu-diag-next', () => gotoDiagnostic(1));
  listen('menu-diag-prev', () => gotoDiagnostic(-1));
  listen('menu-diag-check', () => validateNow());
  listen('menu-peek-ended', () => (menuPeek = false));
  listen('menu-spell-toggle', () => toggleSpell());
  listen('menu-spell-en-gb', () => setSpellLang('en_GB'));
  listen('menu-spell-en-us', () => setSpellLang('en_US'));
  listen('menu-font-increase', () => changeFontSize(1));
  listen('menu-font-decrease', () => changeFontSize(-1));
  listen('menu-font-reset', () => resetFontSize());
  listen('menu-toggle-theme', () => toggleTheme());
  listen('close-requested', () => handleCloseRequested());
}

async function init() {
  setupMarkdownEngine();
  registerLogLanguage();
  registerConfigLanguages();
  const session = await loadSessionFile();
  await window.npEditorReady; // CodeMirror (a module) is in place before anything is wired to it
  applyUi(session && session.ui);
  wireDomEvents();
  wireMenuListeners();
  wireDragDrop();
  wireSettings();
  initExtras();
  setRecentFiles(recentFiles);
  applyTheme();
  applySettings();
  initSpell();
  window.matchMedia('(prefers-color-scheme: dark)').addEventListener('change', () => {
    if (!themeOverride) applyTheme();
  });
  // Show the window at its remembered size/position before the (possibly slower) file reads.
  await restoreWindow();

  const restored = settings.restoreSession ? await restoreDocs(session) : { docs: [], active: null };
  docs = restored.docs;
  sortPinnedFirst();
  activeId = restored.active || (docs[0] && docs[0].id) || null;

  // Files passed on the command line (e.g. "Open with") open on top of the restored session.
  let initialPaths = [];
  try {
    initialPaths = await invoke('cmd_get_initial_files');
  } catch (e) {
    /* none */
  }
  if (!docs.length) {
    const blank = newUntitledDoc();
    docs = [blank];
    activeId = blank.id;
  }
  renderTabs();
  loadActiveDocIntoPanes();
  for (const p of initialPaths) await openPath(p);
  restoreFindState(session && session.ui && session.ui.find);

  sessionReady = true;
  scheduleSessionSave();
}

init().catch((e) => {
  // Kept where the tests (and DevTools) can see it: a start-up failure must never be silent.
  window.__initError = String((e && e.stack) || e);
  console.error('notepad.md failed to start', e);
});
