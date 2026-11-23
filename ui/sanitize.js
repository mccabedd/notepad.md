/* Cleans HTML produced from a document (Markdown can contain raw HTML) before it is shown.
 *
 * Removes anything that could run code, load another page, or change the app itself: scripts,
 * frames, objects, forms, <meta>/<base>/<link>/<style>, SVG animation tricks, event-handler
 * attributes (onclick, onerror...) and javascript:/vbscript:/data: links. Ordinary Markdown
 * output (headings, lists, tables, task-list checkboxes, code, images, links, details, inline
 * style) passes through untouched.
 *
 * In the editable preview each removed element is replaced by an invisible <wbr> that remembers
 * the original HTML, so editing the preview writes it back into the Markdown unchanged instead of
 * silently deleting it. Exports and printouts simply leave it out.
 */

const SANITIZE_DROP = new Set([
  'SCRIPT', 'IFRAME', 'FRAME', 'FRAMESET', 'OBJECT', 'EMBED', 'APPLET', 'BASE', 'META', 'LINK',
  'STYLE', 'FORM', 'BUTTON', 'TEXTAREA', 'SELECT', 'OPTION', 'NOSCRIPT', 'TEMPLATE', 'PORTAL',
  'FENCEDFRAME', 'DIALOG', 'SLOT',
  // SVG elements that can set attributes or pull in other content
  'FOREIGNOBJECT', 'ANIMATE', 'SET', 'ANIMATEMOTION', 'ANIMATETRANSFORM', 'USE', 'HANDLER', 'LISTENER',
]);

// Attributes that hold a URL; only safe schemes (or relative paths) are allowed.
const SANITIZE_URL_ATTRS = new Set(['href', 'src', 'xlink:href', 'action', 'formaction', 'background', 'poster', 'cite', 'longdesc', 'data', 'srcset', 'ping', 'lowsrc', 'dynsrc']);
// http(s), mail, phone, local files, the app's image server, C:\ or C:/ paths, #anchors, and
// relative paths (no scheme at all).
const SANITIZE_SAFE_URL = /^(?:https?:|mailto:|tel:|file:|localimg:|[a-z]:[\\/]|#|\/|[^:]*$)/i;
const SANITIZE_SAFE_IMG_DATA = /^data:image\/(?:png|gif|jpe?g|webp|bmp|avif);/i;

let sanitizeAppIds = null;

/** True when a URL in an attribute is safe to keep. */
function sanitizeUrlOk(name, value, tag) {
  // Browsers ignore control characters and spaces inside the scheme ("java\tscript:"), so do the same.
  const v = value.replace(/[\u0000- \u007f-\u009f]/g, '');
  if (name === 'srcset') return v.split(',').every((part) => sanitizeUrlOk('src', part.trim().split(/\s+/)[0] || '', tag));
  if (tag === 'IMG' && name === 'src' && SANITIZE_SAFE_IMG_DATA.test(v)) return true;
  return SANITIZE_SAFE_URL.test(v);
}

/**
 * Cleans the children of `root` in place. With keepRaw, removed elements leave a <wbr> marker that
 * remembers their HTML (see the Turndown rule in renderer.js).
 */
function sanitizeTree(root, keepRaw) {
  if (!sanitizeAppIds) {
    // ids the app's own page uses; a document must not be able to shadow them (DOM clobbering).
    sanitizeAppIds = new Set([...document.querySelectorAll('[id]')].filter((el) => !el.closest('#preview, #print-root')).map((el) => el.id));
  }
  const walker = document.createTreeWalker(root, NodeFilter.SHOW_ELEMENT | NodeFilter.SHOW_COMMENT);
  const drop = [];
  const fix = [];
  for (let n = walker.nextNode(); n; n = walker.nextNode()) {
    if (n.nodeType === Node.COMMENT_NODE) continue;
    const tag = n.nodeName.toUpperCase();
    // INPUT is allowed only as a task-list checkbox.
    if (SANITIZE_DROP.has(tag) || (tag === 'INPUT' && (n.getAttribute('type') || '').toLowerCase() !== 'checkbox')) drop.push(n);
    else if (n.attributes.length) fix.push(n);
  }
  for (const el of fix) {
    // An empty element (an <img>, <br>...) that loses an attribute keeps its original HTML for the
    // Markdown round trip, so editing elsewhere in the preview doesn't quietly rewrite it in the
    // source. (One with text inside is written back cleaned: the text may have been edited.)
    const original = keepRaw && !el.firstChild ? el.outerHTML : null;
    const before = el.attributes.length;
    for (const attr of [...el.attributes]) {
      const name = attr.name.toLowerCase();
      if (name.startsWith('on') || name === 'srcdoc' || name === 'formaction' || name === 'is' || name === 'http-equiv') {
        el.removeAttribute(attr.name);
      } else if (SANITIZE_URL_ATTRS.has(name) && !sanitizeUrlOk(name, attr.value, el.nodeName.toUpperCase())) {
        el.removeAttribute(attr.name);
      } else if ((name === 'id' || name === 'name') && sanitizeAppIds.has(attr.value)) {
        el.removeAttribute(attr.name);
      } else if (name === 'style' && /expression\s*\(|javascript:|behavior\s*:|-moz-binding/i.test(attr.value)) {
        el.removeAttribute(attr.name);
      } else if (name === 'contenteditable' || name === 'data-np-raw') {
        el.removeAttribute(attr.name);
      }
    }
    if (original && el.attributes.length < before && !/data-np-raw/i.test(original)) el.setAttribute('data-np-raw', original);
  }
  for (const el of drop) {
    if (!el.parentNode || !root.contains(el)) continue; // already gone with a dropped ancestor
    if (keepRaw) {
      const marker = document.createElement('wbr');
      marker.setAttribute('data-np-raw', el.outerHTML);
      el.replaceWith(marker);
    } else {
      el.remove();
    }
  }
  return root;
}

/** Sanitised HTML string (for exports and printing). */
function sanitizeHtml(html) {
  const tpl = document.createElement('template');
  tpl.innerHTML = html;
  sanitizeTree(tpl.content, false);
  const box = document.createElement('div');
  box.appendChild(tpl.content);
  return box.innerHTML;
}

/** Fills `el` with sanitised HTML; removed elements are remembered for the Markdown round trip. */
function setSanitizedHtml(el, html, keepRaw) {
  const tpl = document.createElement('template');
  tpl.innerHTML = html;
  sanitizeTree(tpl.content, keepRaw);
  el.replaceChildren(tpl.content);
}
