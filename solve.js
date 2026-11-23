// A faster drop-in for makefun-site 1.0.0, written from its README and the
// behaviour its code shows: run(input) returns exactly the output tree
// makefun-site 1.0.0's build returns for the same input, byte for byte.
//
// Where the speed comes from:
// - Markdown is the bulk of the work, and the reference renders it one
//   character at a time, escaping each character with its own regex replace.
//   This one scans for the next character that matters (a mark, or one the
//   escape table names) and takes the plain text between in whole slices.
//   Blocks are told apart by their first character, not by a row of regexes.
// - Templates are compiled once per build into plain JavaScript functions
//   instead of walked as trees on every render, and a render whose inputs are
//   the same objects as last time (a header, a card) is reused, not redone.
// - Slugs are cached within a build: tag names and titles repeat.
// - Nothing is kept from one case to the next: every cache is made inside
//   run() and dropped with it.

/** Code-unit order (never the locale's). */
const byCodeUnits = (a, b) => (a < b ? -1 : a > b ? 1 : 0);

/** The top-level directories the generator writes itself. */
const RESERVED = ['posts', 'tags', 'page'];

const dirOf = (path) => {
  const i = path.lastIndexOf('/');
  return i === -1 ? '' : path.slice(0, i);
};

// ---------------------------------------------------------------- text

/** The HTML escape table, in this order: & < > " ' */
const ESCAPES = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' };
const ESC_RE = /[&<>"']/g;

/** `text` with & < > " and ' escaped. */
function escapeHtml(text) {
  return text.replace(ESC_RE, (c) => ESCAPES[c]);
}

/** Whether charCode `c` is whitespace in JavaScript's \s sense. */
function isWs(c) {
  return (
    c === 32 ||
    (c >= 9 && c <= 13) ||
    c === 0xa0 ||
    c === 0x1680 ||
    (c >= 0x2000 && c <= 0x200a) ||
    c === 0x2028 ||
    c === 0x2029 ||
    c === 0x202f ||
    c === 0x205f ||
    c === 0x3000 ||
    c === 0xfeff
  );
}

/** The words of a body: its runs of characters other than whitespace. */
function wordsOf(text) {
  let n = 0;
  let inWord = false;
  for (let i = 0; i < text.length; i++) {
    const c = text.charCodeAt(i);
    if (c === 32 || (c >= 9 && c <= 13)) {
      inWord = false;
      continue;
    }
    if (c >= 0x80 && isWs(c)) {
      inWord = false;
      continue;
    }
    if (!inWord) {
      n++;
      inWord = true;
    }
  }
  return n;
}

const MARK_RE = /\p{M}/gu;
const NON_ALNUM_RUN = /[^a-z0-9]+/g;

/**
 * The slug of `text`: NFKD, combining marks dropped, A-Z lowered, every run
 * of characters other than a-z and 0-9 one "-", none at either end, at most
 * 64 characters (a "-" left at the cut dropped), and "untitled" when nothing
 * is left. The ASCII fast path is exact: NFKD and the mark drop are no-ops
 * on ASCII, and a run of other characters collapses to one "-" either way.
 */
function slugifyRaw(text) {
  let t = text;
  let ascii = true;
  for (let i = 0; i < t.length; i++) {
    if (t.charCodeAt(i) > 127) {
      ascii = false;
      break;
    }
  }
  if (!ascii) t = t.normalize('NFKD').replace(MARK_RE, '');
  t = t.toLowerCase().replace(NON_ALNUM_RUN, '-');
  if (t.charCodeAt(0) === 45) t = t.slice(1);
  if (t.length > 64) t = t.slice(0, 64);
  if (t.charCodeAt(t.length - 1) === 45) t = t.slice(0, -1);
  return t === '' ? 'untitled' : t;
}

/** The slug of `text`, cached within this build. */
function slugify(ctx, text) {
  const c = ctx.slugCache;
  let s = c.get(text);
  if (s === undefined) {
    s = slugifyRaw(text);
    c.set(text, s);
  }
  return s;
}

/** `slug` made unique against `taken` (and added to it). */
function uniqueSlug(slug, taken) {
  let out = slug;
  for (let n = 2; taken.has(out); n++) out = `${slug}-${n}`;
  taken.add(out);
  return out;
}

const MONTHS = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'];

/** A YYYY-MM-DD date in words, from the string alone. */
function longDate(date) {
  return `${Number(date.slice(8, 10))} ${MONTHS[Number(date.slice(5, 7)) - 1]} ${date.slice(0, 4)}`;
}

// ---------------------------------------------------------------- front matter

const FM_KEYS = new Set(['title', 'date', 'tags', 'draft', 'layout', 'slug', 'summary']);
const FM_BLANK = /^[ \t]*$/;
const FM_TAG = /^[^"[\]]+$/;
const FM_NAME = /^[a-z0-9-]+$/;
const FM_SLUG = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;
const DATE_ERROR = 'key "date": not a date from 1970-01-01 to 2099-12-31 (YYYY-MM-DD)';

/** The days of month `m` (1-12) of year `y`, by the Gregorian rule. */
function daysIn(y, m) {
  if (m === 2) return (y % 4 === 0 && y % 100 !== 0) || y % 400 === 0 ? 29 : 28;
  return m === 4 || m === 6 || m === 9 || m === 11 ? 30 : 31;
}

/** Two digits at `at`, or -1 when they are not digits. */
function digits2(s, at) {
  const a = s.charCodeAt(at) - 48;
  const b = s.charCodeAt(at + 1) - 48;
  if (a < 0 || a > 9 || b < 0 || b > 9) return -1;
  return a * 10 + b;
}

/** Four digits at `at`, or -1 when they are not digits. */
function digits4(s, at) {
  const a = digits2(s, at);
  const b = digits2(s, at + 2);
  return a === -1 || b === -1 ? -1 : a * 100 + b;
}

/** A string value: "..." with \" and \\ its only escapes, or bare. */
function stringOf(raw) {
  if (raw.charCodeAt(0) === 34) {
    if (raw.length < 2 || raw.charCodeAt(raw.length - 1) !== 34) return { error: 'a quoted string is not closed' };
    let out = '';
    for (let i = 1; i < raw.length - 1; i++) {
      const c = raw[i];
      if (c === '\\') {
        const n = raw[i + 1];
        if ((n !== '"' && n !== '\\') || i + 1 === raw.length - 1) return { error: 'a quoted string holds an escape other than \\" or \\\\' };
        out += n;
        i++;
      } else if (c === '"') return { error: 'a quoted string holds a stray quote' };
      else out += c;
    }
    return { value: out };
  }
  if (raw.charCodeAt(0) === 91) return { error: 'a bare string opens on [' };
  return { value: raw };
}

/** One key's value, or why it is refused. */
function valueOf(key, raw) {
  switch (key) {
    case 'title':
    case 'summary': {
      const s = stringOf(raw);
      return 'error' in s ? { error: `key "${key}": ${s.error}` } : s;
    }
    case 'date': {
      const y = raw.length === 10 && raw.charCodeAt(4) === 45 && raw.charCodeAt(7) === 45 ? digits4(raw, 0) : -1;
      const mo = y === -1 ? -1 : digits2(raw, 5);
      const d = y === -1 ? -1 : digits2(raw, 8);
      if (y === -1 || mo === -1 || d === -1 || y < 1970 || y > 2099 || mo < 1 || mo > 12 || d < 1 || d > daysIn(y, mo)) return { error: DATE_ERROR };
      return { value: raw };
    }
    case 'tags': {
      if (raw.charCodeAt(0) !== 91 || raw.charCodeAt(raw.length - 1) !== 93) return { error: 'key "tags": not a list [a, b]' };
      const inner = raw.slice(1, -1);
      if (inner.trim() === '') return { value: [] };
      const tags = inner.split(',').map((t) => t.trim());
      if (tags.some((t) => t === '' || !FM_TAG.test(t))) return { error: 'key "tags": an empty tag, or one holding " [ or ]' };
      return { value: tags };
    }
    case 'draft':
      return raw === 'true' ? { value: true } : raw === 'false' ? { value: false } : { error: 'key "draft": true or false' };
    case 'layout':
      return FM_NAME.test(raw) ? { value: raw } : { error: 'key "layout": not a template name' };
    case 'slug':
      return FM_SLUG.test(raw) && raw.length <= 64 ? { value: raw } : { error: 'key "slug": not a slug' };
    default:
      return { error: `unknown key "${key}"` };
  }
}

/**
 * A source's front matter and body: { data, body }, or { error } with the
 * first reason it is refused. The front matter is found by scanning for the
 * closing line, so the body is never split into lines here.
 */
function parseFrontMatter(text) {
  if (text.length < 3 || text.charCodeAt(0) !== 45 || text.charCodeAt(1) !== 45 || text.charCodeAt(2) !== 45) return { error: 'no front matter' };
  const nl = text.indexOf('\n');
  if (nl === -1) {
    if (text !== '---') return { error: 'no front matter' };
    return { error: 'the front matter is not closed' };
  }
  if (nl !== 3) return { error: 'no front matter' };
  // The closing line: the first line after the opening that is exactly '---'.
  let closeStart = -1;
  let closeEnd = -1;
  let p = text.indexOf('\n---', 3);
  while (p !== -1) {
    const after = p + 4;
    if (after === text.length || text.charCodeAt(after) === 10) {
      closeStart = p + 1;
      closeEnd = after === text.length ? text.length : after + 1;
      break;
    }
    p = text.indexOf('\n---', p + 1);
  }
  if (closeStart === -1) return { error: 'the front matter is not closed' };
  const data = {};
  const region = closeStart === 4 ? '' : text.slice(4, closeStart - 1);
  if (region !== '') {
    const lines = region.split('\n');
    for (let k = 0; k < lines.length; k++) {
      const line = lines[k];
      const n = k + 2;
      if (FM_BLANK.test(line) || line.charCodeAt(0) === 35) continue;
      const colon = line.indexOf(':');
      if (colon <= 0) return { error: `line ${n} is not "key: value"` };
      const key = line.slice(0, colon);
      let keyOk = true;
      for (let j = 0; j < key.length; j++) {
        const c = key.charCodeAt(j);
        if (!((c >= 97 && c <= 122) || c === 95)) {
          keyOk = false;
          break;
        }
      }
      if (!keyOk) return { error: `line ${n} is not "key: value"` };
      let raw;
      if (colon === line.length - 1) raw = '';
      else if (line.charCodeAt(colon + 1) === 32) raw = line.slice(colon + 2);
      else return { error: `line ${n} is not "key: value"` };
      raw = raw.replace(/[ \t]+$/, '');
      if (!FM_KEYS.has(key)) return { error: `unknown key "${key}"` };
      if (Object.hasOwn(data, key)) return { error: `key "${key}" is given twice` };
      if (raw === '') return { error: `key "${key}" has no value` };
      const v = valueOf(key, raw);
      if ('error' in v) return v;
      data[key] = v.value;
    }
  }
  if (!Object.hasOwn(data, 'title')) return { error: 'no title' };
  return { data, body: text.slice(closeEnd) };
}

// ---------------------------------------------------------------- markdown
//
// The block reader works on spans of the body (start and end indices), never
// splitting it into lines: a paragraph whose lines need no trimming is one
// slice of the body, and a fence's body is one slice too.

/** Whether the span `src[s, e)` holds spaces and tabs only. */
function isBlankSpan(src, s, e) {
  for (let i = s; i < e; i++) {
    const c = src.charCodeAt(i);
    if (c !== 32 && c !== 9) return false;
  }
  return true;
}

/** The span `src[s, e)` with its spaces and tabs at either end dropped. */
function trimSlice(src, s, e) {
  while (s < e) {
    const c = src.charCodeAt(s);
    if (c !== 32 && c !== 9) break;
    s++;
  }
  while (e > s) {
    const c = src.charCodeAt(e - 1);
    if (c !== 32 && c !== 9) break;
    e--;
  }
  return src.slice(s, e);
}

/** Whether the span `src[s, e)` would change under trimming. */
function needsTrimSpan(src, s, e) {
  if (s >= e) return false;
  const a = src.charCodeAt(s);
  if (a === 32 || a === 9) return true;
  const b = src.charCodeAt(e - 1);
  return b === 32 || b === 9;
}

/** Whether `c` is a fence language character: A-Z a-z 0-9 _ + - */
function isLangChar(c) {
  return (c >= 65 && c <= 90) || (c >= 97 && c <= 122) || (c >= 48 && c <= 57) || c === 95 || c === 43 || c === 45;
}

/**
 * A fence's language when the span opens one (three backticks, an optional
 * language, then spaces or tabs only), else null.
 */
function fenceLangSpan(src, s, e) {
  if (src.charCodeAt(s) !== 96 || src.charCodeAt(s + 1) !== 96 || src.charCodeAt(s + 2) !== 96) return null;
  let i = s + 3;
  while (i < e && isLangChar(src.charCodeAt(i))) i++;
  const lang = src.slice(s + 3, i);
  while (i < e) {
    const c = src.charCodeAt(i);
    if (c !== 32 && c !== 9) return null;
    i++;
  }
  return lang;
}

/** Whether the span closes a fence: three backticks, then spaces or tabs only. */
function isFenceCloseSpan(src, s, e) {
  if (src.charCodeAt(s) !== 96 || src.charCodeAt(s + 1) !== 96 || src.charCodeAt(s + 2) !== 96) return false;
  for (let i = s + 3; i < e; i++) {
    const c = src.charCodeAt(i);
    if (c !== 32 && c !== 9) return false;
  }
  return true;
}

/** A heading span's level and text span, or null (a heading's text is never empty). */
function headingSpan(src, s, e) {
  let d = 0;
  while (s + d < e && src.charCodeAt(s + d) === 35) d++;
  if (d === 0 || d > 6 || s + d === e) return null;
  const c = src.charCodeAt(s + d);
  if (c !== 32 && c !== 9) return null;
  let t = s + d;
  while (t < e) {
    const ch = src.charCodeAt(t);
    if (ch !== 32 && ch !== 9) break;
    t++;
  }
  let u = e;
  while (u > t) {
    const ch = src.charCodeAt(u - 1);
    if (ch !== 32 && ch !== 9) break;
    u--;
  }
  if (u === t) return null;
  return { depth: d, textStart: t, textEnd: u };
}

/** Whether the span is a thematic break: --- or ***, then spaces or tabs only. */
function isHrSpan(src, s, e) {
  const a = src.charCodeAt(s);
  if (a !== 45 && a !== 42) return false;
  if (src.charCodeAt(s + 1) !== a || src.charCodeAt(s + 2) !== a) return false;
  for (let i = s + 3; i < e; i++) {
    const c = src.charCodeAt(i);
    if (c !== 32 && c !== 9) return false;
  }
  return true;
}

/** Where a bullet item's text starts when the span opens one (`- ` or `* `), else -1. */
function bulletSpan(src, s, e) {
  const a = src.charCodeAt(s);
  if ((a !== 45 && a !== 42) || src.charCodeAt(s + 1) !== 32) return -1;
  return s + 2;
}

/** Where an ordered item's text starts when the span opens one (1 to 9 digits, then ". "), else -1. */
function orderedSpan(src, s, e) {
  let d = 0;
  while (s + d < e) {
    const c = src.charCodeAt(s + d);
    if (c < 48 || c > 57) break;
    d++;
  }
  if (d === 0 || d > 9) return -1;
  if (src.charCodeAt(s + d) !== 46 || src.charCodeAt(s + d + 1) !== 32) return -1;
  return s + d + 2;
}

/** Whether the span continues a list item: two or more spaces, then a non-space. */
function isContinuedSpan(src, s, e) {
  if (src.charCodeAt(s) !== 32 || src.charCodeAt(s + 1) !== 32) return false;
  for (let j = s + 2; j < e; j++) {
    const c = src.charCodeAt(j);
    if (c === 32) continue;
    return !isWs(c);
  }
  return false;
}

/** Whether the span ends a paragraph: a blank line, a fence, a heading or a break. */
function endsParagraphSpan(src, s, e) {
  if (s === e) return true;
  const c = src.charCodeAt(s);
  if (c === 32 || c === 9) return isBlankSpan(src, s, e);
  if (c === 96) return fenceLangSpan(src, s, e) !== null;
  if (c === 35) return headingSpan(src, s, e) !== null;
  if (c === 45 || c === 42) return isHrSpan(src, s, e);
  return false;
}

// --- inline rendering -------------------------------------------------------

/** The characters a backslash escapes, as a lookup table over char codes. */
const ESCAPABLE = new Uint8Array(128);
for (const ch of '\\`*_[]()#+-.!>') ESCAPABLE[ch.charCodeAt(0)] = 1;

/**
 * The characters the inline scan stops at: the four that open a construct
 * (\ ` * [) and the five the escape table names (& < > " '). Anything else
 * is plain text, taken in whole slices.
 */
const SPECIAL = new Uint8Array(128);
// \ ` * [ & < > " '
for (const c of [92, 96, 42, 91, 38, 60, 62, 34, 39]) SPECIAL[c] = 1;

/**
 * Whether the character at `j` is escaped by a backslash run: escapes pair
 * up left to right from `from`, so a run of backslashes immediately before
 * `j` escapes it exactly when the run is odd. (The run can only start at
 * or after `from`, where the scan begins.)
 */
function isEscaped(s, j, from) {
  let odd = false;
  for (let k = j - 1; k >= from && s.charCodeAt(k) === 92; k--) odd = !odd;
  return odd;
}

/**
 * The first index from `from` where `s` holds `what` outside an escape, or
 * -1. The search itself is the native indexOf; only a candidate with a
 * backslash before it needs the parity check.
 */
function findUnescaped(s, what, from) {
  let j = s.indexOf(what, from);
  while (j !== -1 && isEscaped(s, j, from)) j = s.indexOf(what, j + 1);
  return j;
}

/**
 * The first single * from `from` (one whose run is not **), outside an
 * escape, or -1. Pairs are consumed as one, as in the scan this replaces.
 */
function findSingleStar(s, from) {
  let j = s.indexOf('*', from);
  while (j !== -1) {
    if (isEscaped(s, j, from)) {
      j = s.indexOf('*', j + 1);
      continue;
    }
    if (s.charCodeAt(j + 1) === 42) {
      j = s.indexOf('*', j + 2);
      continue;
    }
    return j;
  }
  return -1;
}

const WS_RE = /\s/;

/**
 * `s` rendered inline; `link(target)` is a link's href. The scan stops only
 * at a character that matters, so the plain text between is copied whole
 * and never re-examined for escaping.
 */
function inlineMd(ctx, s, dir, path, link) {
  const n = s.length;
  let out = '';
  let i = 0;
  let chunk = 0;
  while (i < n) {
    const c = s.charCodeAt(i);
    if (c >= 128 || SPECIAL[c] === 0) {
      i++;
      continue;
    }
    if (i > chunk) out += s.slice(chunk, i);
    if (c === 38) {
      out += '&amp;';
      i++;
      chunk = i;
      continue;
    }
    if (c === 60) {
      out += '&lt;';
      i++;
      chunk = i;
      continue;
    }
    if (c === 62) {
      out += '&gt;';
      i++;
      chunk = i;
      continue;
    }
    if (c === 34) {
      out += '&quot;';
      i++;
      chunk = i;
      continue;
    }
    if (c === 39) {
      out += '&#39;';
      i++;
      chunk = i;
      continue;
    }
    if (c === 92) {
      if (i + 1 < n) {
        const e = s.charCodeAt(i + 1);
        if (e < 128 && ESCAPABLE[e]) {
          out += e === 62 ? '&gt;' : s[i + 1];
          i += 2;
          chunk = i;
          continue;
        }
      }
      out += '\\';
      i++;
      chunk = i;
      continue;
    }
    if (c === 96) {
      const j = s.indexOf('`', i + 1);
      if (j > i + 1) {
        out += `<code>${escapeHtml(s.slice(i + 1, j))}</code>`;
        i = j + 1;
      } else {
        out += '`';
        i++;
      }
      chunk = i;
      continue;
    }
    if (c === 42) {
      if (s.charCodeAt(i + 1) === 42) {
        const j = findUnescaped(s, '**', i + 2);
        if (j > i + 2) {
          out += `<strong>${inlineMd(ctx, s.slice(i + 2, j), dir, path, link)}</strong>`;
          i = j + 2;
        } else {
          out += '**';
          i += 2;
        }
      } else {
        const j = findSingleStar(s, i + 1);
        if (j > i + 1) {
          out += `<em>${inlineMd(ctx, s.slice(i + 1, j), dir, path, link)}</em>`;
          i = j + 1;
        } else {
          out += '*';
          i++;
        }
      }
      chunk = i;
      continue;
    }
    // c === 91, '[': a link, or itself.
    const k = findUnescaped(s, ']', i + 1);
    const m = k !== -1 && s.charCodeAt(k + 1) === 40 ? s.indexOf(')', k + 2) : -1;
    const target = m === -1 ? '' : s.slice(k + 2, m);
    if (target !== '' && !WS_RE.test(target)) {
      out += `<a href="${escapeHtml(link(target))}">${inlineMd(ctx, s.slice(i + 1, k), dir, path, link)}</a>`;
      i = m + 1;
    } else {
      out += '[';
      i++;
    }
    chunk = i;
  }
  if (n > chunk) out += s.slice(chunk, n);
  return out;
}

// --- links ------------------------------------------------------------------

/** Whether `target` opens on a scheme (`https:`, `mailto:` ...). */
function hasScheme(target) {
  const c0 = target.charCodeAt(0);
  if (!((c0 >= 65 && c0 <= 90) || (c0 >= 97 && c0 <= 122))) return false;
  for (let i = 1; i < target.length; i++) {
    const c = target.charCodeAt(i);
    if (c === 58) return true;
    if (!((c >= 65 && c <= 90) || (c >= 97 && c <= 122) || (c >= 48 && c <= 57) || c === 43 || c === 45 || c === 46)) return false;
  }
  return false;
}

/** `rel` (a link's path) from the directory `dir`, or null when it climbs out of the root. */
function resolvePath(dir, rel) {
  const parts = dir === '' ? [] : dir.split('/');
  for (const seg of rel.split('/')) {
    if (seg === '' || seg === '.') continue;
    if (seg === '..') {
      if (parts.length === 0) return null;
      parts.pop();
    } else parts.push(seg);
  }
  return parts.join('/');
}

/** A link's href for the source at `path` in directory `dir`. */
function resolveLink(ctx, dir, path, target) {
  if (hasScheme(target) || target.charCodeAt(0) === 47 || target.charCodeAt(0) === 35) return target;
  const hash = target.indexOf('#');
  const rel = hash === -1 ? target : target.slice(0, hash);
  const frag = hash === -1 ? '' : target.slice(hash);
  let resolved = null;
  if (rel !== '') {
    let byDir = ctx.pathCache.get(dir);
    if (byDir === undefined) {
      byDir = new Map();
      ctx.pathCache.set(dir, byDir);
    }
    if (byDir.has(rel)) resolved = byDir.get(rel);
    else {
      resolved = resolvePath(dir, rel);
      byDir.set(rel, resolved);
    }
  }
  if (resolved !== null) {
    const page = ctx.bySource.get(resolved);
    if (page !== undefined) return `${page.url}${frag}`;
    if (ctx.staticPaths.has(resolved)) return `${ctx.base}/${resolved}${frag}`;
  }
  ctx.broken.add(`broken-link ${path} -> ${target}`);
  return target;
}

// --- blocks -----------------------------------------------------------------

/**
 * `src` rendered: its HTML (each block on its own lines, a "\n" after the
 * last), its table of contents (every level 2 and 3 heading) and its excerpt
 * (the first paragraph's inline HTML, or "").
 */
function renderMarkdown(ctx, src, dir, path) {
  const link = (target) => resolveLink(ctx, dir, path, target);
  const n = src.length;
  let html = '';
  const toc = [];
  const ids = new Set();
  let excerpt = null;
  let pos = 0;
  while (pos < n) {
    let eol = src.indexOf('\n', pos);
    if (eol === -1) eol = n;
    if (eol === pos) {
      pos = eol + 1;
      continue;
    }
    const c0 = src.charCodeAt(pos);
    if (c0 === 32 || c0 === 9) {
      if (isBlankSpan(src, pos, eol)) {
        pos = eol + 1;
        continue;
      }
      // A line opening on spaces that is not blank is paragraph text.
    } else if (c0 === 96) {
      const lang = fenceLangSpan(src, pos, eol);
      if (lang !== null) {
        const bodyStart = eol + 1;
        let p = bodyStart;
        let closeStart = -1;
        let closeEnd = n;
        while (p < n) {
          let e2 = src.indexOf('\n', p);
          if (e2 === -1) e2 = n;
          if (isFenceCloseSpan(src, p, e2)) {
            closeStart = p;
            closeEnd = e2;
            break;
          }
          p = e2 + 1;
        }
        const bodyEnd = closeStart === -1 ? n : closeStart - 1;
        const body = bodyEnd <= bodyStart ? '' : src.slice(bodyStart, bodyEnd);
        const cls = lang === '' ? '' : ` class="language-${lang}"`;
        html += `<pre><code${cls}>${body === '' ? '' : `${escapeHtml(body)}\n`}</code></pre>\n`;
        pos = closeStart === -1 ? n : closeEnd + 1;
        continue;
      }
    } else if (c0 === 35) {
      const h = headingSpan(src, pos, eol);
      if (h !== null) {
        const text = src.slice(h.textStart, h.textEnd);
        const id = uniqueSlug(slugify(ctx, text), ids);
        const hHtml = inlineMd(ctx, text, dir, path, link);
        html += `<h${h.depth} id="${id}">${hHtml}</h${h.depth}>\n`;
        if (h.depth === 2 || h.depth === 3) toc.push({ level: h.depth, id, html: hHtml });
        pos = eol + 1;
        continue;
      }
    } else if (c0 === 45 || c0 === 42) {
      if (isHrSpan(src, pos, eol)) {
        html += '<hr>\n';
        pos = eol + 1;
        continue;
      }
      if (bulletSpan(src, pos, eol) !== -1) {
        const items = [];
        let p = pos;
        while (p < n) {
          let e2 = src.indexOf('\n', p);
          if (e2 === -1) e2 = n;
          const ts = bulletSpan(src, p, e2);
          if (ts !== -1) {
            items.push([trimSlice(src, ts, e2)]);
            p = e2 + 1;
          } else if (isContinuedSpan(src, p, e2)) {
            items[items.length - 1].push(trimSlice(src, p, e2));
            p = e2 + 1;
          } else break;
        }
        pos = p;
        html += '<ul>\n';
        for (const parts of items) html += `<li>${inlineMd(ctx, parts.join('\n'), dir, path, link)}</li>\n`;
        html += '</ul>\n';
        continue;
      }
    } else if (c0 === 62) {
      const parts = [];
      let p = pos;
      while (p < n) {
        let e2 = src.indexOf('\n', p);
        if (e2 === -1) e2 = n;
        if (src.charCodeAt(p) !== 62) break;
        let s = p + 1;
        if (src.charCodeAt(s) === 32) s++;
        const t = trimSlice(src, s, e2);
        if (t !== '') parts.push(t);
        p = e2 + 1;
      }
      pos = p;
      html += parts.length === 0 ? '<blockquote>\n</blockquote>\n' : `<blockquote>\n<p>${inlineMd(ctx, parts.join('\n'), dir, path, link)}</p>\n</blockquote>\n`;
      continue;
    } else if (c0 >= 48 && c0 <= 57) {
      const firstText = orderedSpan(src, pos, eol);
      if (firstText !== -1) {
        const start = Number(src.slice(pos, firstText - 2));
        const items = [];
        let p = pos;
        while (p < n) {
          let e2 = src.indexOf('\n', p);
          if (e2 === -1) e2 = n;
          const ts = orderedSpan(src, p, e2);
          if (ts !== -1) {
            items.push([trimSlice(src, ts, e2)]);
            p = e2 + 1;
          } else if (isContinuedSpan(src, p, e2)) {
            items[items.length - 1].push(trimSlice(src, p, e2));
            p = e2 + 1;
          } else break;
        }
        pos = p;
        html += start !== 1 ? `<ol start="${start}">\n` : '<ol>\n';
        for (const parts of items) html += `<li>${inlineMd(ctx, parts.join('\n'), dir, path, link)}</li>\n`;
        html += '</ol>\n';
        continue;
      }
    }
    // A paragraph: this line and the lines after it up to a blank line, a
    // fence, a heading or a thematic break. Lines that need no trimming make
    // the paragraph one slice of the body.
    const pStart = pos;
    let pEnd = eol;
    let needsTrim = needsTrimSpan(src, pos, eol);
    pos = eol + 1;
    while (pos < n) {
      let e2 = src.indexOf('\n', pos);
      if (e2 === -1) e2 = n;
      if (endsParagraphSpan(src, pos, e2)) break;
      if (!needsTrim && needsTrimSpan(src, pos, e2)) needsTrim = true;
      pEnd = e2;
      pos = e2 + 1;
    }
    let text;
    if (!needsTrim) {
      text = src.slice(pStart, pEnd);
    } else {
      const parts = [];
      let p = pStart;
      while (p <= pEnd) {
        let e2 = src.indexOf('\n', p);
        if (e2 === -1 || e2 > pEnd) e2 = pEnd;
        parts.push(trimSlice(src, p, e2));
        p = e2 + 1;
      }
      text = parts.join('\n');
    }
    const pHtml = inlineMd(ctx, text, dir, path, link);
    if (excerpt === null) excerpt = pHtml;
    html += `<p>${pHtml}</p>\n`;
  }
  return { html, toc, excerpt: excerpt ?? '' };
}

// ---------------------------------------------------------------- templates

/** A template that does not parse: its name and why. */
class TemplateError extends Error {}

const TPL_PATH = /^[A-Za-z_][A-Za-z0-9_]*(?:\.[A-Za-z_][A-Za-z0-9_]*)*$/;
const TPL_FOR = /^for ([A-Za-z_][A-Za-z0-9_]*) in (\S+)$/;
const TPL_IF = /^if (not )?(\S+)$/;
const TPL_INCLUDE = /^include "([a-z0-9-]+)"$/;
const TPL_BLANK = /^[ \t]*$/;

/** The path `text` names, split at its dots, or a TemplateError. */
function pathOf(name, text) {
  if (!TPL_PATH.test(text)) throw new TemplateError(`template "${name}": ${JSON.stringify(text)} is not a path`);
  return text.split('.');
}

/** `src`'s tokens: text, {{ }}, {{{ }}} and {% %}, a standalone tag's line taken with it. */
function tokenize(name, src) {
  const tokens = [];
  let text = '';
  let i = 0;
  while (i < src.length) {
    const open = src.indexOf('{', i);
    if (open === -1 || open === src.length - 1) {
      text += src.slice(i);
      break;
    }
    const next = src[open + 1];
    if (next !== '{' && next !== '%') {
      text += src.slice(i, open + 1);
      i = open + 1;
      continue;
    }
    text += src.slice(i, open);
    if (next === '{') {
      const raw = src[open + 2] === '{';
      const close = src.indexOf(raw ? '}}}' : '}}', open + (raw ? 3 : 2));
      if (close === -1) throw new TemplateError(`template "${name}": a ${raw ? '{{{' : '{{'} is not closed`);
      if (text !== '') tokens.push({ t: 'text', text });
      text = '';
      tokens.push({ t: raw ? 'raw' : 'var', path: pathOf(name, src.slice(open + (raw ? 3 : 2), close).trim()) });
      i = close + (raw ? 3 : 2);
      continue;
    }
    const close = src.indexOf('%}', open + 2);
    if (close === -1) throw new TemplateError(`template "${name}": a {% is not closed`);
    const end = close + 2;
    const lineStart = src.lastIndexOf('\n', open - 1) + 1;
    const nl = src.indexOf('\n', end);
    const lineEnd = nl === -1 ? src.length : nl;
    const standalone = TPL_BLANK.test(src.slice(lineStart, open)) && TPL_BLANK.test(src.slice(end, lineEnd));
    if (standalone) text = text.slice(0, text.length - (open - lineStart));
    if (text !== '') tokens.push({ t: 'text', text });
    text = '';
    tokens.push({ t: 'tag', tag: src.slice(open + 2, close).trim() });
    i = standalone ? (nl === -1 ? src.length : nl + 1) : end;
  }
  if (text !== '') tokens.push({ t: 'text', text });
  return tokens;
}

/** `src` parsed into its tree of nodes (a TemplateError when it does not parse). */
function parseTemplate(name, src) {
  const root = { kind: 'root', body: [] };
  const stack = [root];
  let body = root.body;
  for (const tok of tokenize(name, src)) {
    if (tok.t === 'text') body.push({ kind: 'text', text: tok.text });
    else if (tok.t === 'var' || tok.t === 'raw') body.push({ kind: tok.t, path: tok.path });
    else {
      const tag = tok.tag;
      const top = stack[stack.length - 1];
      let m;
      if ((m = TPL_FOR.exec(tag)) !== null) {
        const node = { kind: 'for', name: m[1], path: pathOf(name, m[2]), body: [] };
        body.push(node);
        stack.push(node);
        body = node.body;
      } else if ((m = TPL_IF.exec(tag)) !== null) {
        const node = { kind: 'if', not: m[1] !== undefined, path: pathOf(name, m[2]), then: [], else: null };
        body.push(node);
        stack.push(node);
        body = node.then;
      } else if (tag === 'else') {
        if (top.kind !== 'if' || top.else !== null) throw new TemplateError(`template "${name}": an else outside an if`);
        top.else = [];
        body = top.else;
      } else if (tag === 'endfor' || tag === 'endif') {
        if (top.kind !== (tag === 'endfor' ? 'for' : 'if')) throw new TemplateError(`template "${name}": an ${tag} with no open ${tag.slice(3)}`);
        stack.pop();
        const parent = stack[stack.length - 1];
        body = parent.kind === 'root' ? parent.body : parent.kind === 'for' ? parent.body : parent.else ?? parent.then;
      } else if ((m = TPL_INCLUDE.exec(tag)) !== null) body.push({ kind: 'include', name: m[1] });
      else throw new TemplateError(`template "${name}": {% ${tag} %} is not a tag`);
    }
  }
  if (stack.length > 1) throw new TemplateError(`template "${name}": a ${stack[stack.length - 1].kind} is not closed`);
  return root.body;
}

// --- what a template reads --------------------------------------------------

/** The root values that never change within a build. */
const BUILD_CONSTANTS = new Set(['site', 'tags', 'recent']);

/**
 * The first names `nodes` reads that no enclosing `for` of its own binds,
 * through its includes, under the names `bound` already binds. `memo` keeps
 * the answer per (template, bound set); `seen` guards against a cycle.
 */
function freeVarsOf(nodes, bound, asts, memo, seen, state) {
  const free = new Set();
  for (const node of nodes) {
    if (node.kind === 'var' || node.kind === 'raw' || node.kind === 'if') {
      if (!bound.has(node.path[0])) free.add(node.path[0]);
      if (node.kind === 'if') {
        for (const v of freeVarsOf(node.then, bound, asts, memo, seen, state)) free.add(v);
        if (node.else !== null) for (const v of freeVarsOf(node.else, bound, asts, memo, seen, state)) free.add(v);
      }
    } else if (node.kind === 'for') {
      if (!bound.has(node.path[0])) free.add(node.path[0]);
      const b2 = new Set(bound);
      b2.add(node.name);
      b2.add('loop');
      for (const v of freeVarsOf(node.body, b2, asts, memo, seen, state)) free.add(v);
    } else if (node.kind === 'include') {
      const sub = asts.get(node.name);
      if (sub === undefined) continue;
      if (seen.has(node.name)) {
        state.cyclic = true;
        continue;
      }
      const key = `${node.name}|${[...bound].sort().join(',')}`;
      let subFree = memo.get(key);
      if (subFree === undefined) {
        seen.add(node.name);
        subFree = freeVarsOf(sub, bound, asts, memo, seen, state);
        seen.delete(node.name);
        memo.set(key, subFree);
      }
      for (const v of subFree) free.add(v);
    }
  }
  return free;
}

/**
 * How a template may be reused: tier 1 when it reads only build constants
 * (one render per build), tier 2 when it reads those and exactly one other
 * value (one render per that value), null otherwise. A template reading
 * `loop` is never reused: the loop record is one object, changed each pass.
 */
function tierOf(free) {
  if (free.has('loop')) return null;
  const nonConst = [...free].filter((v) => !BUILD_CONSTANTS.has(v));
  if (nonConst.length === 0) return { tier: 1, key: null, free: [...free] };
  if (nonConst.length === 1) return { tier: 2, key: nonConst[0], free: [...free] };
  return null;
}

// --- compiled rendering -----------------------------------------------------

/** A value as text: a string itself, a number in JavaScript's digits, true or false, an array's items joined by ", ", else "". */
function txt(v) {
  if (typeof v === 'string') return v;
  if (typeof v === 'number') return String(v);
  if (v === true) return 'true';
  if (v === false) return 'false';
  if (Array.isArray(v)) return v.map(txt).join(', ');
  return '';
}

/** Whether a value counts as true in an if: not undefined, null, false, "", 0 or an empty array. */
function tru(v) {
  if (Array.isArray(v)) return v.length > 0;
  return v !== undefined && v !== null && v !== false && v !== '' && v !== 0;
}

/** `v`'s own property `key`, or undefined when it has none (or is no object). */
function get(v, key) {
  return v !== null && typeof v === 'object' && Object.hasOwn(v, key) ? v[key] : undefined;
}

/** The values `free` names, read from the loop scope `S` then the root `V`. */
function resolveVals(free, V, S) {
  const vals = new Array(free.length);
  for (let i = 0; i < free.length; i++) {
    const f = free[i];
    vals[i] = Object.hasOwn(S, f) ? S[f] : V[f];
  }
  return vals;
}

/** Whether the values `free` names still are `vals`. */
function sameVals(vals, free, V, S) {
  for (let i = 0; i < free.length; i++) {
    const f = free[i];
    if ((Object.hasOwn(S, f) ? S[f] : V[f]) !== vals[i]) return false;
  }
  return true;
}

/**
 * `{% include "name" %}` at depth `D`: nothing for a missing template, or
 * one nested more than 8 deep; otherwise the template rendered in this
 * scope, reused when its inputs are the same objects as last time.
 */
function inc(name, V, S, T, C, D) {
  const fn = T.get(name);
  if (fn === undefined || D >= 8) return '';
  const info = C.info.get(name);
  const d1 = D + 1;
  if (info === null || info === undefined) return fn(V, S, T, C, d1, escapeHtml, txt, tru, get, inc);
  if (info.tier === 1) {
    const e = C.t1[name];
    if (e !== undefined && e.d === d1 && sameVals(e.v, info.free, V, S)) return e.o;
    const vals = resolveVals(info.free, V, S);
    const o = fn(V, S, T, C, d1, escapeHtml, txt, tru, get, inc);
    C.t1[name] = { d: d1, v: vals, o };
    return o;
  }
  const keyVal = Object.hasOwn(S, info.key) ? S[info.key] : V[info.key];
  let m = C.t2[name];
  if (m === undefined) {
    m = new Map();
    C.t2[name] = m;
  }
  const e = m.get(keyVal);
  if (e !== undefined && e.d === d1 && sameVals(e.v, info.free, V, S)) return e.o;
  const vals = resolveVals(info.free, V, S);
  const o = fn(V, S, T, C, d1, escapeHtml, txt, tru, get, inc);
  m.set(keyVal, { d: d1, v: vals, o });
  return o;
}

/** The JavaScript expression for `path` in the compiled scope (V, S). */
function pathExpr(path) {
  let e = `(Object.hasOwn(S,${JSON.stringify(path[0])})?S[${JSON.stringify(path[0])}]:V[${JSON.stringify(path[0])}])`;
  for (let k = 1; k < path.length; k++) e = `get(${e},${JSON.stringify(path[k])})`;
  return e;
}

/**
 * `nodes` compiled into a function (V, S, T, C, D, esc, txt, tru, get, inc):
 * V the root values, S the loop scope (one flat object, each for saving and
 * restoring the names it binds), T the compiled templates, C this build's
 * reuse cache, D the include depth.
 */
function compileTemplate(nodes) {
  const parts = ['let o="";'];
  let uid = 0;
  const gen = (ns) => {
    for (const node of ns) {
      if (node.kind === 'text') parts.push(`o+=${JSON.stringify(node.text)};`);
      else if (node.kind === 'var') parts.push(`o+=esc(txt(${pathExpr(node.path)}));`);
      else if (node.kind === 'raw') parts.push(`o+=txt(${pathExpr(node.path)});`);
      else if (node.kind === 'if') {
        parts.push(`if(${node.not ? '!' : ''}tru(${pathExpr(node.path)})){`);
        gen(node.then);
        if (node.else !== null) {
          parts.push('}else{');
          gen(node.else);
        }
        parts.push('}');
      } else if (node.kind === 'for') {
        const u = uid++;
        const nm = JSON.stringify(node.name);
        parts.push(
          `{const _x${u}=${pathExpr(node.path)};if(Array.isArray(_x${u})){const _l${u}=_x${u}.length;const _o${u}={index:0,first:false,last:false,length:_l${u}};const _h${u}=Object.hasOwn(S,${nm});const _p${u}=S[${nm}];const _g${u}=Object.hasOwn(S,"loop");const _q${u}=S.loop;for(let _k${u}=0;_k${u}<_l${u};_k${u}++){_o${u}.index=_k${u}+1;_o${u}.first=_k${u}===0;_o${u}.last=_k${u}===_l${u}-1;S[${nm}]=_x${u}[_k${u}];S.loop=_o${u};`,
        );
        gen(node.body);
        parts.push(`}if(_h${u})S[${nm}]=_p${u};else delete S[${nm}];if(_g${u})S.loop=_q${u};else delete S.loop;}}`);
      } else if (node.kind === 'include') {
        parts.push(`o+=inc(${JSON.stringify(node.name)},V,S,T,C,D);`);
      }
    }
  };
  gen(nodes);
  parts.push('return o;');
  return new Function('V', 'S', 'T', 'C', 'D', 'esc', 'txt', 'tru', 'get', 'inc', parts.join(''));
}

// ---------------------------------------------------------------- the build

/** A post's card, as lists show it. A tag's view is shared: one tag's name, slug and url are the same wherever it is listed. */
function cardOf(ctx, s) {
  return {
    title: s.data.title,
    url: s.url,
    date: s.data.date ?? '',
    date_long: s.data.date === undefined ? '' : longDate(s.data.date),
    summary: s.data.summary ?? '',
    excerpt: s.excerpt,
    reading_minutes: Math.max(1, Math.ceil(wordsOf(s.body) / 200)),
    tags: s.tagRefs.map((t) => t.view),
  };
}

/** A page as its layout reads it (a post reuses the card the lists use). */
function pageOf(ctx, s, cards) {
  const card = s.post ? cards.get(s) : cardOf(ctx, s);
  return {
    ...card,
    slug: s.slug,
    content: s.html,
    toc: s.toc,
    newer: s.newer ? s.newer.link : null,
    older: s.older ? s.older.link : null,
    is_post: s.post,
  };
}

/** One site's output tree: path -> text. */
export function run(input) {
  const ctx = {
    base: input.site.base_url.replace(/\/+$/, ''),
    slugCache: new Map(),
    pathCache: new Map(),
    report: [],
    broken: new Set(),
    bySource: new Map(),
    staticPaths: new Set(),
  };

  // Templates, parsed in code-unit order of their name; one that does not
  // parse is reported and left out, as if it were not there.
  const asts = new Map();
  for (const name of Object.keys(input.templates).sort(byCodeUnits)) {
    try {
      asts.set(name, parseTemplate(name, input.templates[name]));
    } catch (err) {
      if (!(err instanceof TemplateError)) throw err;
      ctx.report.push(err.message);
    }
  }
  // How each template may be reused; a cyclic include set is never reused.
  const memo = new Map();
  const state = { cyclic: false };
  const info = new Map();
  for (const [name, ast] of asts) {
    const free = freeVarsOf(ast, new Set(), asts, memo, new Set([name]), state);
    info.set(name, tierOf(free));
  }
  if (state.cyclic) for (const name of info.keys()) info.set(name, null);
  const templates = new Map();
  for (const [name, ast] of asts) templates.set(name, compileTemplate(ast));
  const C = { info, t1: Object.create(null), t2: Object.create(null) };
  const S0 = Object.create(null);
  const V = { site: null, tags: null, recent: null, page: undefined, posts: undefined, pager: undefined, tag: undefined };
  const render = (name) => {
    const fn = templates.get(name);
    return fn === undefined ? null : fn(V, S0, templates, C, 0, escapeHtml, txt, tru, get, inc);
  };

  // Sources, in code-unit order of their paths; a file that is not .md is static.
  const files = [...input.files].sort((x, y) => byCodeUnits(x.path, y.path));
  const sources = [];
  const statics = [];
  for (const f of files) {
    if (f.path.endsWith('.md')) {
      const content = f.content;
      sources.push({ path: f.path, text: content.indexOf('\r') === -1 ? content : content.replace(/\r\n?/g, '\n') });
    } else statics.push({ path: f.path, content: f.content });
  }

  // Front matter: a refused source is reported and dropped, and so is a draft.
  const kept = [];
  for (const s of sources) {
    const fm = parseFrontMatter(s.text);
    if ('error' in fm) {
      ctx.report.push(`refused ${s.path}: ${fm.error}`);
      continue;
    }
    s.data = fm.data;
    s.body = fm.body;
    s.post = s.path.startsWith('posts/');
    const own = s.path.startsWith('tags/') ? 'tags' : s.path.startsWith('page/') ? 'page' : undefined;
    if (own !== undefined) {
      ctx.report.push(`refused ${s.path}: ${own}/ is the generator's own`);
      continue;
    }
    if (s.post && !Object.hasOwn(s.data, 'date')) {
      ctx.report.push(`refused ${s.path}: a post needs a date`);
      continue;
    }
    const layout = s.data.layout ?? (s.post ? 'post' : 'page');
    if (!templates.has(layout)) {
      ctx.report.push(`refused ${s.path}: layout "${layout}" is no template that parses`);
      continue;
    }
    s.layout = layout;
    if (s.data.draft === true) {
      ctx.report.push(`draft ${s.path}`);
      continue;
    }
    kept.push(s);
  }

  // Permalinks: each page's slug, made unique in its directory, in source order.
  const taken = new Map();
  for (const s of kept) {
    const dir = s.post ? 'posts' : dirOf(s.path);
    let set = taken.get(dir);
    if (set === undefined) {
      set = new Set(dir === '' ? RESERVED : []);
      taken.set(dir, set);
    }
    const slug = uniqueSlug(s.data.slug ?? slugify(ctx, s.data.title), set);
    s.slug = slug;
    s.outDir = dir === '' ? slug : `${dir}/${slug}`;
    s.url = `${ctx.base}/${s.outDir}/`;
    ctx.bySource.set(s.path, s);
  }

  // Markdown: each body's HTML, its links resolved.
  for (const f of statics) ctx.staticPaths.add(f.path);
  for (const s of kept) {
    const md = renderMarkdown(ctx, s.body, dirOf(s.path), s.path);
    s.html = md.html;
    s.toc = md.toc;
    s.excerpt = md.excerpt;
  }

  // Collections: the posts, newest first and then by slug, with neighbours.
  const posts = kept.filter((s) => s.post);
  posts.sort((x, y) => byCodeUnits(y.data.date, x.data.date) || byCodeUnits(x.slug, y.slug));
  posts.forEach((p, k) => {
    p.newer = k === 0 ? null : posts[k - 1];
    p.older = k === posts.length - 1 ? null : posts[k + 1];
  });

  // Tags: grouped by their slug, each named as first met in the posts' order.
  const bySlug = new Map();
  const ownTags = (s) => {
    const seen = new Set();
    const out = [];
    for (const name of s.data.tags ?? []) {
      const slug = slugify(ctx, name);
      if (!seen.has(slug)) {
        seen.add(slug);
        out.push(name);
      }
    }
    return out;
  };
  for (const p of posts) {
    p.tagRefs = [];
    for (const name of ownTags(p)) {
      const slug = slugify(ctx, name);
      let tag = bySlug.get(slug);
      if (tag === undefined) {
        tag = { name, slug, url: `${ctx.base}/tags/${slug}/`, posts: [] };
        tag.view = { name, slug, url: tag.url };
        bySlug.set(slug, tag);
      }
      tag.posts.push(p);
      p.tagRefs.push(tag);
    }
  }
  for (const s of kept) {
    if (!s.post) {
      s.tagRefs = ownTags(s).map((name) => {
        const slug = slugify(ctx, name);
        const tag = bySlug.get(slug);
        if (tag !== undefined) return tag;
        const dummy = { name, slug, url: '', posts: [] };
        dummy.view = { name, slug, url: '' };
        return dummy;
      });
    }
  }
  const tags = [...bySlug.values()].sort((x, y) => y.posts.length - x.posts.length || byCodeUnits(x.slug, y.slug));

  // Layouts: every page through its layout, the index and tag pages through theirs.
  // A post's link record is made once: it is the same as a neighbour wherever it is read.
  for (const p of posts) {
    p.link = { title: p.data.title, url: p.url, date: p.data.date ?? '', date_long: p.data.date === undefined ? '' : longDate(p.data.date) };
  }
  const cards = new Map();
  for (const p of posts) cards.set(p, cardOf(ctx, p));
  const site = { title: input.site.title, base_url: ctx.base };
  const allTags = tags.map((t) => ({ name: t.name, slug: t.slug, url: t.url, count: t.posts.length }));
  const recent = posts.slice(0, input.site.recent).map((p) => cards.get(p));
  V.site = site;
  V.tags = allTags;
  V.recent = recent;
  const output = {};
  for (const s of kept) {
    V.page = pageOf(ctx, s, cards);
    V.posts = undefined;
    V.pager = undefined;
    V.tag = undefined;
    output[`${s.outDir}/index.html`] = render(s.layout);
  }
  const per = input.site.per_page;
  const pages = Math.max(1, Math.ceil(posts.length / per));
  const indexUrl = (k) => (k === 1 ? `${ctx.base}/` : `${ctx.base}/page/${k}/`);
  for (let k = 1; k <= pages; k++) {
    V.page = undefined;
    V.posts = posts.slice((k - 1) * per, k * per).map((p) => cards.get(p));
    V.pager = { number: k, total: pages, url: indexUrl(k), newer_url: k === 1 ? '' : indexUrl(k - 1), older_url: k === pages ? '' : indexUrl(k + 1) };
    V.tag = undefined;
    const html = render('index');
    if (html !== null) output[k === 1 ? 'index.html' : `page/${k}/index.html`] = html;
  }
  for (const t of tags) {
    V.page = undefined;
    V.posts = undefined;
    V.pager = undefined;
    V.tag = { name: t.name, slug: t.slug, url: t.url, count: t.posts.length, posts: t.posts.map((p) => cards.get(p)) };
    const html = render('tag');
    if (html !== null) output[`tags/${t.slug}/index.html`] = html;
  }
  V.page = undefined;
  V.posts = undefined;
  V.pager = undefined;
  V.tag = undefined;
  const tagsHtml = render('tags');
  if (tagsHtml !== null) output['tags/index.html'] = tagsHtml;
  for (const f of statics) {
    if (Object.hasOwn(output, f.path)) ctx.report.push(`shadowed ${f.path}: a built page has its path`);
    else output[f.path] = f.content;
  }

  // The report: every refusal, draft, broken link and template that did not
  // parse, sorted, then the counts.
  const lines = [...ctx.report, ...ctx.broken].sort(byCodeUnits);
  const pageCount = kept.filter((s) => !s.post).length;
  lines.push(`built ${pageCount} pages, ${posts.length} posts, ${tags.length} tags and ${statics.length} static files`);
  output['build-report.txt'] = `${lines.join('\n')}\n`;
  return output;
}
