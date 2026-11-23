/* Editing BBCode tabs: typing in the BBCode preview (its HTML is turned back into BBCode) and the
 * toolbar writing BBCode tags ([b]...[/b]) instead of Markdown in the editor.
 * Loaded after bbcode.js and before renderer.js; only touches renderer globals inside functions. */

/* ---------- the BBCode preview: HTML back to BBCode ----------
 * After each change in the preview, its HTML is turned back into BBCode with the same tags the
 * renderer understands, so the source stays BBCode (never HTML). Blocks get back the line breaks
 * the renderer drops around them. */

const BB_SIZES = { '0.63em': '1', '0.82em': '2', '1em': '3', '1.13em': '4', '1.5em': '5', '2em': '6', '3em': '7' };
const BB_BLOCKS = /^(DIV|P|H[1-6]|BLOCKQUOTE|UL|OL|TABLE|PRE|DETAILS|HR)$/;

/** rgb(1, 2, 3) (what the browser gives back) as #010203; names and #hex stay as written. */
function bbColour(c) {
  const m = /^rgba?\((\d+),\s*(\d+),\s*(\d+)/.exec(c);
  if (!m) return c;
  return '#' + [m[1], m[2], m[3]].map((v) => (+v).toString(16).padStart(2, '0')).join('');
}

function htmlToBBCode(root) {
  let out = '';
  let pendingNl = false; // a block just ended: what follows starts on a new line
  let afterPre = false; // [code] blocks keep the line break after them (it shows as a <br>)
  const flushNl = () => {
    afterPre = false;
    if (pendingNl) {
      out += '\n';
      pendingNl = false;
    }
  };
  const emit = (t) => {
    if (!t) return;
    flushNl();
    out += t;
  };
  const blockStart = () => {
    if (pendingNl) flushNl();
    else if (out && !out.endsWith('\n')) out += '\n';
  };
  const kids = (node) => node.childNodes.forEach(walk);
  const wrap = (node, open, close) => {
    emit(open);
    kids(node);
    emit(close);
  };
  const textOf = (n) => (n.textContent || '').replace(/ /g, ' ');

  function styled(node) {
    // <span style> / <font>: colour, size and font, outermost first.
    const st = node.style || {};
    const tags = [];
    const color = st.color || (node.tagName === 'FONT' && node.getAttribute('color'));
    if (color) tags.push(['color=' + bbColour(color), 'color']);
    if (st.fontSize) tags.push(['size=' + (BB_SIZES[st.fontSize] || st.fontSize.replace(/px$/, '')), 'size']);
    const face = (st.fontFamily || (node.tagName === 'FONT' && node.getAttribute('face')) || '').replace(/["']/g, '');
    if (face) tags.push(['font=' + face, 'font']);
    for (const [o] of tags) emit('[' + o + ']');
    kids(node);
    for (let k = tags.length - 1; k >= 0; k--) emit('[/' + tags[k][1] + ']');
  }

  function walk(node) {
    if (node.nodeType === 3) {
      emit(node.nodeValue.replace(/ /g, ' '));
      return;
    }
    if (node.nodeType !== 1) return;
    const tag = node.tagName;
    if (node.classList.contains('code-copy-btn') || node.classList.contains('bb-cite')) return;
    const block = BB_BLOCKS.test(tag);
    if (block) blockStart();
    switch (tag) {
      case 'BR':
        if (afterPre) {
          afterPre = false; // the line break after [/code] (kept by the renderer as this <br>)
          out += '\n';
          return;
        }
        flushNl();
        out += '\n';
        return;
      case 'B':
      case 'STRONG':
        return wrap(node, '[b]', '[/b]');
      case 'I':
      case 'EM':
        return wrap(node, '[i]', '[/i]');
      case 'U':
        return wrap(node, '[u]', '[/u]');
      case 'S':
      case 'STRIKE':
      case 'DEL':
        return wrap(node, '[s]', '[/s]');
      case 'SUB':
        return wrap(node, '[sub]', '[/sub]');
      case 'SUP':
        return wrap(node, '[sup]', '[/sup]');
      case 'A': {
        const href = node.getAttribute('href') || '';
        const text = textOf(node);
        if (/^mailto:/i.test(href)) emit('[email]' + href.slice(7) + '[/email]');
        else if (href === text) emit('[url]' + href + '[/url]');
        else wrap(node, '[url=' + href + ']', '[/url]');
        return;
      }
      case 'IMG':
        emit('[img]' + (node.getAttribute('src') || '') + '[/img]');
        return;
      case 'SPAN':
      case 'FONT':
        styled(node);
        return;
      case 'H1':
      case 'H2':
      case 'H3':
        wrap(node, '[' + tag.toLowerCase() + ']', '[/' + tag.toLowerCase() + ']');
        break;
      case 'H4':
      case 'H5':
      case 'H6':
        wrap(node, '[b]', '[/b]');
        break;
      case 'HR':
        out += '[hr]';
        break;
      case 'PRE':
        emit('[code]' + [...node.childNodes].filter((n) => !(n.classList && n.classList.contains('code-copy-btn'))).map(textOf).join('') + '[/code]');
        break;
      case 'BLOCKQUOTE': {
        const cite = node.querySelector(':scope > .bb-cite');
        const st = node.getAttribute('style') || '';
        if (!cite && /margin/.test(st) && /border:\s*none/.test(st)) wrap(node, '[indent]', '[/indent]'); // the browser's own "indent"
        else wrap(node, cite ? '[quote=' + textOf(cite).replace(/\s*wrote:\s*$/, '') + ']' : '[quote]', '[/quote]');
        break;
      }
      case 'DETAILS': {
        const sum = node.querySelector(':scope > summary');
        const title = sum ? textOf(sum) : '';
        emit(title && title !== 'Spoiler' ? '[spoiler=' + title + ']' : '[spoiler]');
        node.childNodes.forEach((n) => {
          if (n !== sum) walk(n);
        });
        emit('[/spoiler]');
        break;
      }
      case 'UL':
      case 'OL': {
        const type = tag === 'OL' ? node.getAttribute('type') || '1' : null;
        emit(type ? '[list=' + type + ']' : '[list]');
        for (const li of node.children) {
          if (li.tagName !== 'LI') continue;
          out += '\n[*]';
          pendingNl = false;
          kids(li);
        }
        flushNl();
        out += '\n[/list]';
        break;
      }
      case 'TABLE':
        emit('[table]');
        node.querySelectorAll('tr').forEach((tr) => {
          out += '[tr]';
          tr.querySelectorAll(':scope > td, :scope > th').forEach((c) => {
            const t = c.tagName.toLowerCase();
            out += '[' + t + ']';
            kids(c);
            pendingNl = false;
            out += '[/' + t + ']';
          });
          out += '[/tr]';
        });
        out += '[/table]';
        break;
      case 'DIV':
      case 'P': {
        const st = node.style || {};
        const align = st.textAlign;
        if (align && /^(center|left|right|justify)$/.test(align)) wrap(node, '[' + align + ']', '[/' + align + ']');
        else if (st.marginLeft) wrap(node, '[indent]', '[/indent]');
        else if (node.childNodes.length === 1 && node.firstChild.nodeName === 'BR') {
          /* an empty line the browser made for Enter: the block break is enough */
        } else kids(node);
        break;
      }
      default:
        kids(node);
        return;
    }
    if (block) pendingNl = true;
    if (tag === 'PRE') {
      pendingNl = false;
      afterPre = true;
    }
  }

  root.childNodes.forEach(walk);
  return out;
}

/* ---------- the toolbar for BBCode tabs ---------- */

/** Tooltips that show the BBCode each button writes. */
const BB_TOOLBAR_TITLES = {
  bold: 'Bold  [b]...[/b]',
  italic: 'Italic  [i]...[/i]',
  strike: 'Strikethrough  [s]...[/s]',
  underline: 'Underline  [u]...[/u]',
  table: 'Insert table  [table][tr][td]...',
  'code-block': 'Code block  [code]...[/code]',
  image: 'Insert image  [img]https://...[/img]',
  checklist: 'BBCode has no checklists',
  'ordered-list': 'Numbered list  [list=1][*]...[/list]',
  'bullet-list': 'Bullet list  [list][*]...[/list]',
  indent: 'Increase indent  [indent]...[/indent]',
  outdent: 'Decrease indent (takes off [indent])',
};

/** Shows the BBCode tooltips (and turns off what BBCode doesn't have) on BBCode tabs. */
function updateToolbarForLanguage(doc) {
  const render = doc ? langInfo(doc).render : 'markdown';
  const bb = render === 'bbcode';
  const plain = render === 'plain';
  const tb = document.getElementById('toolbar');
  const want = bb ? 'bbcode' : plain ? 'plain' : 'markdown';
  if (!tb || tb.dataset.syntax === want) return;
  tb.dataset.syntax = want;
  tb.querySelectorAll('button[data-cmd], button[data-heading]').forEach((b) => {
    if (b.dataset.mdTitle === undefined) b.dataset.mdTitle = b.title;
    const h = b.dataset.heading ? +b.dataset.heading : 0;
    const key = b.dataset.cmd || 'h' + h;
    const bbTitle = h ? (h <= 3 ? 'Heading ' + h + '  [h' + h + ']...[/h' + h + ']' : 'BBCode has headings 1 to 3 only') : BB_TOOLBAR_TITLES[key];
    // Plain Text has no formatting: those buttons are off (indent, copy, paste and the rest still work).
    const plainOff = plain && (h > 0 || ['bold', 'italic', 'strike', 'underline', 'table', 'code-block', 'image', 'checklist', 'ordered-list', 'bullet-list'].includes(key));
    b.title = plainOff ? 'Plain Text has no formatting' : bb && bbTitle ? bbTitle : b.dataset.mdTitle;
    const off = plainOff || (bb && (key === 'checklist' || key === 'h4'));
    b.disabled = off;
    b.classList.toggle('tb-off', off);
  });
}

/** The whole lines the selection touches: { start, end, lines }. */
function bbSelectedLines() {
  const v = editor.value;
  const s = editor.selectionStart;
  let e = editor.selectionEnd;
  if (e > s && v[e - 1] === '\n') e--; // a selection ending at the start of a line doesn't take that line
  const start = v.lastIndexOf('\n', s - 1) + 1;
  let end = v.indexOf('\n', Math.max(e, start));
  if (end === -1) end = v.length;
  return { start, end, lines: v.slice(start, end).split('\n') };
}

/** Wraps the selection in tags, or takes them off if they are already round it (one undo step). */
function bbToggleWrap(open, close, placeholder) {
  const v = editor.value;
  const s = editor.selectionStart;
  const e = editor.selectionEnd;
  if (v.slice(s - open.length, s).toLowerCase() === open && v.slice(e, e + close.length).toLowerCase() === close) {
    const inner = v.slice(s, e);
    replaceEditorRange(s - open.length, e + close.length, inner);
    editor.setSelectionRange(s - open.length, s - open.length + inner.length);
    return;
  }
  const inner = v.slice(s, e) || placeholder || '';
  replaceEditorRange(s, e, open + inner + close);
  editor.setSelectionRange(s + open.length, s + open.length + inner.length);
}

/** Toolbar buttons on a BBCode tab when typing in the editor. Returns false if not one of them. */
function bbToolbarCommand(cmd, heading) {
  if (heading) {
    if (heading > 3) return true;
    const { start, end, lines } = bbSelectedLines();
    const text = lines.join('\n').replace(/^\[h[1-3]\]([\s\S]*)\[\/h[1-3]\]$/i, '$1');
    replaceEditorRange(start, end, '[h' + heading + ']' + text + '[/h' + heading + ']');
    return true;
  }
  switch (cmd) {
    case 'bold':
      bbToggleWrap('[b]', '[/b]');
      return true;
    case 'italic':
      bbToggleWrap('[i]', '[/i]');
      return true;
    case 'strike':
      bbToggleWrap('[s]', '[/s]');
      return true;
    case 'underline':
      bbToggleWrap('[u]', '[/u]');
      return true;
    case 'code-block':
      bbToggleWrap('[code]\n', '\n[/code]', 'code');
      return true;
    case 'image':
      bbToggleWrap('[img]', '[/img]', 'https://');
      return true;
    case 'table':
      replaceEditorRange(editor.selectionStart, editor.selectionEnd, '\n[table]\n[tr][th]Column 1[/th][th]Column 2[/th][/tr]\n[tr][td]Cell 1[/td][td]Cell 2[/td][/tr]\n[/table]\n');
      return true;
    case 'checklist':
      flashFindStatus('BBCode has no checklists: use a list instead.');
      return true;
    case 'ordered-list':
    case 'bullet-list': {
      const { start, end, lines } = bbSelectedLines();
      const open = cmd === 'ordered-list' ? '[list=1]' : '[list]';
      const body = lines.filter((l) => l.trim() !== '' || lines.length === 1).map((l) => '[*]' + l.replace(/^\s*\[\*\]\s*/, ''));
      replaceEditorRange(start, end, open + '\n' + body.join('\n') + '\n[/list]');
      return true;
    }
    case 'indent': {
      const { start, end, lines } = bbSelectedLines();
      replaceEditorRange(start, end, '[indent]' + lines.join('\n') + '[/indent]');
      return true;
    }
    case 'outdent': {
      const { start, end, lines } = bbSelectedLines();
      const m = /^\[indent\]([\s\S]*)\[\/indent\]$/i.exec(lines.join('\n'));
      if (m) replaceEditorRange(start, end, m[1]);
      return true;
    }
  }
  return false;
}
