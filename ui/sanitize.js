/* Cleans HTML produced from a document (Markdown can contain raw HTML) before it is shown.
 *
 * The cleaning itself is done by DOMPurify (ui/vendor/purify.min.js), a maintained allow-list
 * sanitiser: only known-safe elements and attributes survive, and it guards against the parser
 * tricks ("mutation XSS") a hand-written filter can miss. On top of its defaults this file:
 *   - forbids a few more elements (forms, buttons, <style>, dialogs...) with their contents;
 *   - allows only safe link schemes: http(s), mailto, tel, file, the app's localimg: images,
 *     C:\ paths, #anchors and relative paths;
 *   - removes CSS tricks in style attributes, and ids/names that would shadow the app's own
 *     elements (DOM clobbering).
 * The app's Content Security Policy (no inline scripts) is a second, independent barrier.
 *
 * In the editable preview each removed element is replaced by an invisible <wbr> that remembers
 * the original HTML, and an empty element (an <img>...) that loses attributes remembers its
 * original too, so editing the preview writes them back into the Markdown unchanged instead of
 * silently deleting them. Exports and printouts simply leave them out.
 */

// Elements removed together with everything inside them (in the editable preview each one leaves
// a marker). DOMPurify already removes most of these; listing them makes sure they never return.
const SANITIZE_DROP = [
  'script', 'iframe', 'frame', 'frameset', 'object', 'embed', 'applet', 'base', 'meta', 'link',
  'style', 'form', 'button', 'textarea', 'select', 'option', 'noscript', 'template', 'portal',
  'fencedframe', 'dialog', 'slot',
  // SVG elements that can set attributes or pull in other content
  'foreignobject', 'animate', 'set', 'animatemotion', 'animatetransform', 'use', 'handler', 'listener',
];
const SANITIZE_DROP_SET = new Set(SANITIZE_DROP);

// Attributes that hold a URL; only safe schemes (or relative paths) are allowed.
const SANITIZE_URL_ATTRS = new Set(['href', 'src', 'xlink:href', 'action', 'formaction', 'background', 'poster', 'cite', 'longdesc', 'data', 'srcset', 'ping', 'lowsrc', 'dynsrc']);
// http(s), mail, phone, local files, the app's image server, C:\ or C:/ paths, #anchors, and
// relative paths (no scheme at all).
const SANITIZE_SAFE_URL = /^(?:https?:|mailto:|tel:|file:|localimg:|[a-z]:[\\/]|#|\/|[^:]*$)/i;
const SANITIZE_SAFE_IMG_DATA = /^data:image\/(?:png|gif|jpe?g|webp|bmp|avif);/i;

const PURIFY_CONFIG = {
  // DOMPurify's own URL check, with the schemes above (data: images are handled by DOMPurify).
  ALLOWED_URI_REGEXP: /^(?:(?:https?|mailto|tel|file|localimg):|[a-z]:[\\/]|#|\/|[^a-z]|[a-z+.-]+(?:[^a-z+.:-]|$))/i,
  FORBID_TAGS: SANITIZE_DROP,
  ADD_FORBID_CONTENTS: SANITIZE_DROP,
  FORBID_ATTR: ['contenteditable', 'is', 'srcdoc', 'formaction', 'http-equiv'],
  RETURN_DOM_FRAGMENT: true,
};

let sanitizeAppIds = null;
let sanitizeKeepRaw = false; // set while cleaning for the editable preview
let sanitizeOriginals = null; // element -> its HTML before its attributes were cleaned

/** True when a URL in an attribute is safe to keep. */
function sanitizeUrlOk(name, value, tag) {
  // Browsers ignore control characters and spaces inside the scheme ("java\tscript:"), so do the same.
  const v = value.replace(/[\u0000- \u007f-\u009f]/g, '');
  if (name === 'srcset') return v.split(',').every((part) => sanitizeUrlOk('src', part.trim().split(/\s+/)[0] || '', tag));
  if (tag === 'IMG' && name === 'src' && SANITIZE_SAFE_IMG_DATA.test(v)) return true;
  return SANITIZE_SAFE_URL.test(v);
}

/*
 * The removed HTML kept in a marker is stored encoded ("u:" + percent-encoding): as plain HTML,
 * DOMPurify would rightly drop an attribute containing "</style" or "-->", losing it.
 */
function npRawEncode(html) {
  return 'u:' + encodeURIComponent(html);
}
function npRawDecode(value) {
  if (!value || !value.startsWith('u:')) return value || '';
  try {
    return decodeURIComponent(value.slice(2));
  } catch (e) {
    return '';
  }
}

if (window.DOMPurify && DOMPurify.isSupported) {
  // An element about to be removed: leave a marker remembering it (editable preview only). The
  // marker goes in front of the element, where DOMPurify's walk has already passed.
  DOMPurify.addHook('uponSanitizeElement', (node, data) => {
    if (node.nodeType !== 1 || !node.parentNode) return;
    const tag = (data.tagName || '').toLowerCase();
    // INPUT is allowed only as a task-list checkbox.
    const strayInput = tag === 'input' && (node.getAttribute('type') || '').toLowerCase() !== 'checkbox';
    if (!SANITIZE_DROP_SET.has(tag) && !strayInput) return;
    if (sanitizeKeepRaw) {
      const marker = node.ownerDocument.createElement('wbr');
      marker.setAttribute('data-np-raw', npRawEncode(node.outerHTML));
      node.parentNode.insertBefore(marker, node);
    }
    if (strayInput) node.remove(); // DOMPurify allows inputs in general: remove this one here
  });
  // Remember an empty element's HTML before its attributes are cleaned (see afterSanitizeAttributes).
  DOMPurify.addHook('beforeSanitizeAttributes', (node) => {
    if (!sanitizeKeepRaw || node.nodeType !== 1 || node.firstChild || !node.attributes || !node.attributes.length || node.nodeName === 'WBR') return;
    const html = node.outerHTML;
    if (!/data-np-raw/i.test(html)) sanitizeOriginals.set(node, html);
  });
  DOMPurify.addHook('uponSanitizeAttribute', (node, data) => {
    const name = data.attrName;
    const value = data.attrValue || '';
    if (
      name.startsWith('on') ||
      name === 'data-np-raw' || // only the app adds these, never a document
      (SANITIZE_URL_ATTRS.has(name) && !sanitizeUrlOk(name, value, node.nodeName.toUpperCase())) ||
      ((name === 'id' || name === 'name') && sanitizeAppIds.has(value)) ||
      (name === 'style' && /expression\s*\(|javascript:|behavior\s*:|-moz-binding/i.test(value))
    ) {
      data.keepAttr = false;
    }
  });
  // An empty element that lost attributes keeps its original HTML for the Markdown round trip, so
  // editing elsewhere in the preview doesn't quietly rewrite it in the source. (One with text
  // inside is written back cleaned: the text may have been edited.)
  DOMPurify.addHook('afterSanitizeAttributes', (node) => {
    if (!sanitizeKeepRaw || !sanitizeOriginals) return;
    const original = sanitizeOriginals.get(node);
    if (original && node.outerHTML !== original) node.setAttribute('data-np-raw', npRawEncode(original));
  });
}

/** A DocumentFragment of `html`, cleaned. With keepRaw, removed parts leave markers (see above). */
function sanitizeToFragment(html, keepRaw) {
  if (!sanitizeAppIds) {
    // ids the app's own page uses; a document must not be able to shadow them (DOM clobbering).
    // (Only what is inside the preview or printout comes from documents; those two boxes are the app's.)
    sanitizeAppIds = new Set([...document.querySelectorAll('[id]')].filter((el) => !(el.parentElement && el.parentElement.closest('#preview, #print-root'))).map((el) => el.id));
  }
  if (!window.DOMPurify || !DOMPurify.isSupported) {
    // Never show unsanitised HTML: without the sanitiser, only the text is shown.
    const frag = document.createDocumentFragment();
    const pre = document.createElement('pre');
    pre.textContent = html;
    frag.appendChild(pre);
    return frag;
  }
  sanitizeKeepRaw = !!keepRaw;
  sanitizeOriginals = keepRaw ? new WeakMap() : null;
  try {
    return DOMPurify.sanitize(html, PURIFY_CONFIG);
  } finally {
    sanitizeKeepRaw = false;
    sanitizeOriginals = null;
  }
}

/** Sanitised HTML string (for exports and printing). */
function sanitizeHtml(html) {
  const box = document.createElement('div');
  box.appendChild(sanitizeToFragment(html, false));
  return box.innerHTML;
}

/** Fills `el` with sanitised HTML; removed elements are remembered for the Markdown round trip. */
function setSanitizedHtml(el, html, keepRaw) {
  el.replaceChildren(sanitizeToFragment(html, keepRaw));
}
