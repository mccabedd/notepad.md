/* Links in the preview: pasting (a pasted URL becomes a link at once; pasted HTML goes through the
 * sanitiser) and a small box on hover showing the link's full address, with Open and Copy buttons.
 * Loaded before renderer.js; only touches renderer globals inside functions. */

const LINKABLE_URL = /^(?:https?:\/\/|mailto:)[^\s<>"]+$|^www\.[^\s<>"]+\.[^\s<>"]+$/i;
const URL_IN_TEXT = /\b(?:https?:\/\/|www\.)[^\s<>"]+[^\s<>".,;:!?)\]}'"]/gi;

function linkHref(text) {
  return /^www\./i.test(text) ? 'https://' + text : text;
}

function escapeLinkHtml(s) {
  return String(s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c]);
}

/** An <a> for a URL; data-bare (as for links found in the source) keeps it a bare URL in the Markdown. */
function linkHtml(url, text) {
  const href = linkHref(url);
  const bare = text === undefined || text === url;
  return '<a href="' + escapeLinkHtml(href) + '"' + (bare ? ' data-bare=""' : '') + '>' + escapeLinkHtml(bare ? url : text) + '</a>';
}

/** Plain text with its URLs as links (null if it has none). Line breaks become <br>. */
function linkifyText(text) {
  URL_IN_TEXT.lastIndex = 0;
  if (!URL_IN_TEXT.test(text)) return null;
  URL_IN_TEXT.lastIndex = 0;
  let out = '';
  let last = 0;
  let m;
  while ((m = URL_IN_TEXT.exec(text))) {
    out += escapeLinkHtml(text.slice(last, m.index)) + linkHtml(m[0]);
    last = m.index + m[0].length;
  }
  out += escapeLinkHtml(text.slice(last));
  return out.replace(/\r?\n/g, '<br>');
}

function onPreviewPaste(e) {
  if (preview.getAttribute('contenteditable') !== 'true' || !e.clipboardData) return;
  const plain = e.clipboardData.getData('text/plain') || '';
  const html = e.clipboardData.getData('text/html') || '';
  const trimmed = plain.trim();
  const sel = window.getSelection();
  const inLink = sel && sel.anchorNode && sel.anchorNode.parentElement && sel.anchorNode.parentElement.closest('a');
  let insert = null;
  if (LINKABLE_URL.test(trimmed) && !inLink) {
    // A URL: a link straight away. With text selected, the selected text becomes the link.
    const chosen = sel && !sel.isCollapsed ? sel.toString() : '';
    insert = chosen && !/\n/.test(chosen) ? linkHtml(trimmed, chosen) : linkHtml(trimmed);
  } else if (html) {
    // Formatted text from another program: only what the preview may show (no scripts, handlers...).
    insert = sanitizeHtml(html.replace(/^[\s\S]*<!--StartFragment-->|<!--EndFragment-->[\s\S]*$/g, ''));
  } else if (!inLink) {
    insert = linkifyText(plain);
  }
  if (insert === null) return; // plain text without links: the normal paste
  e.preventDefault();
  document.execCommand('insertHTML', false, insert); // keeps undo; the input event writes it to the source
}

/* ---------- the box shown on hover ---------- */

let linkPop = null;
let linkPopTimer = 0;
let linkPopFor = null;

function hideLinkPopup() {
  clearTimeout(linkPopTimer);
  if (linkPop) linkPop.remove();
  linkPop = null;
  linkPopFor = null;
}

function showLinkPopup(a) {
  const href = a.getAttribute('href') || '';
  if (!/^(https?:|mailto:)/i.test(href)) return;
  hideLinkPopup();
  linkPopFor = a;
  const pop = document.createElement('div');
  pop.className = 'link-pop';
  pop.setAttribute('role', 'tooltip');
  pop.innerHTML =
    '<span class="lp-url"></span>' +
    '<button class="lp-btn" data-act="open" title="Open the link"><svg viewBox="0 0 16 16" width="13" height="13"><path d="M9 2h5v5M14 2L7 9M12 9.5V13a1 1 0 0 1-1 1H3a1 1 0 0 1-1-1V5a1 1 0 0 1 1-1h3.5" fill="none" stroke="currentColor" stroke-width="1.4" stroke-linecap="round" stroke-linejoin="round"/></svg></button>' +
    '<button class="lp-btn" data-act="copy" title="Copy the address"><svg viewBox="0 0 16 16" width="13" height="13"><rect x="5.5" y="5.5" width="8" height="8" rx="1.2" fill="none" stroke="currentColor" stroke-width="1.3"/><path d="M3.5 10.5h-.3a1 1 0 0 1-1-1V3.2a1 1 0 0 1 1-1h6.3a1 1 0 0 1 1 1v.3" fill="none" stroke="currentColor" stroke-width="1.3"/></svg></button>';
  pop.querySelector('.lp-url').textContent = href;
  pop.querySelector('.lp-url').title = href;
  document.body.appendChild(pop);
  const r = a.getBoundingClientRect();
  const w = pop.offsetWidth;
  const h = pop.offsetHeight;
  pop.style.left = Math.max(8, Math.min(r.left, window.innerWidth - w - 8)) + 'px';
  pop.style.top = (r.bottom + 4 + h > window.innerHeight - 8 ? Math.max(8, r.top - h - 4) : r.bottom + 4) + 'px';
  pop.addEventListener('mousedown', (e) => e.preventDefault()); // keep the caret where it is
  pop.addEventListener('click', (e) => {
    const b = e.target.closest('button[data-act]');
    if (!b) return;
    if (b.dataset.act === 'open') openUrl(href);
    else {
      clipboard.writeText(href);
      flashFindStatus('Link address copied');
    }
    hideLinkPopup();
  });
  pop.addEventListener('mouseenter', () => clearTimeout(linkPopTimer));
  pop.addEventListener('mouseleave', () => {
    linkPopTimer = setTimeout(hideLinkPopup, 300);
  });
  linkPop = pop;
}

function wirePreviewLinks() {
  preview.addEventListener('paste', onPreviewPaste);
  preview.addEventListener('mouseover', (e) => {
    const a = e.target.closest && e.target.closest('a[href]');
    if (!a || !preview.contains(a)) return;
    clearTimeout(linkPopTimer);
    if (linkPopFor === a && linkPop) return;
    linkPopTimer = setTimeout(() => showLinkPopup(a), 350);
  });
  preview.addEventListener('mouseout', (e) => {
    const a = e.target.closest && e.target.closest('a[href]');
    if (!a || (e.relatedTarget && a.contains(e.relatedTarget))) return;
    clearTimeout(linkPopTimer);
    linkPopTimer = setTimeout(() => {
      if (!linkPop || !linkPop.matches(':hover')) hideLinkPopup();
    }, 300);
  });
  preview.addEventListener('scroll', hideLinkPopup);
  preview.addEventListener('keydown', hideLinkPopup);
}
