// The kit's mirror of Kino's native live-channel readers: M3uParser.kt and XmltvParser.kt (and the
// grouping of PlaylistGroups.kt). Both sides are pinned to the same shared fixtures,
// docs/plugins/fixtures/live/*.m3u|*.xml with an .expected.json next to each: the app's JVM tests
// and this kit's node tests read the SAME files, so the two can't drift. This file exists so a
// plugin author sees, before installing anything, exactly what Kino will keep from a list and a guide.
// It is not the authority: when the two disagree, the app wins and this file is the bug.
import { constants as zlibConstants, gunzipSync } from "node:zlib";
import { contract, liveStreamUrlAllowed, playlistUrlAllowed } from "./contract.mjs";

const live = () => contract.live;

// ---------- M3U ----------

/** `name="value"`, `name='value'` or a bare `name=value` (up to the next whitespace). */
const ATTR = /([A-Za-z0-9_-]+)=(?:"([^"]*)"|'([^']*)'|(\S+))/g;
const attrValue = (m) => m[2] ?? m[3] ?? m[4] ?? "";
/** How many guides a list's header may name. */
const MAX_LIST_EPGS = 3;
/** How many request headers a Widevine license key may carry. */
const MAX_LICENSE_HEADERS = 16;
const HEADER_NAME = /^[A-Za-z0-9!#$%&'*+.^_`|~-]{1,64}$/;
const UNSENDABLE_LICENSE_HEADERS = ["host", "content-length", "transfer-encoding", "connection", "keep-alive", "upgrade", "te", "trailer"];
const HEX_16 = /^[0-9a-fA-F]{32}$/;
// A license URL with Java's Character.isWhitespace or isISOControl anywhere is refused.
const URL_BLANK = /[\u0000-\u0020\u007f-\u009f\u1680\u2000-\u2006\u2008-\u200a\u2028\u2029\u205f\u3000]/;
const KEPT_HEADERS = { "user-agent": "User-Agent", referer: "Referer", referrer: "Referer", origin: "Origin", cookie: "Cookie" };
// Kotlin's String.trim(): Java whitespace plus space separators, never U+FEFF (which JS trims).
const WS = "\\t\\n\\v\\f\\r\\u001C-\\u001F \\u00A0\\u1680\\u2000-\\u200A\\u2028\\u2029\\u202F\\u205F\\u3000";
const TRIM = new RegExp(`^[${WS}]+|[${WS}]+$`, "g");
const ktTrim = (s) => s.replace(TRIM, "");
const isBlank = (s) => ktTrim(s) === "";
const after = (s, ch, missing = s) => { const i = s.indexOf(ch); return i < 0 ? missing : s.slice(i + ch.length); };
const before = (s, ch, missing = s) => { const i = s.indexOf(ch); return i < 0 ? missing : s.slice(0, i); };
const startsWithIgnoreCase = (s, prefix) => s.slice(0, prefix.length).toUpperCase() === prefix.toUpperCase();

/**
 * UTF-16 LE/BE and its BOM's length in bytes (0 without one), or null for an 8-bit list: a BOM
 * (`FF FE` / `FE FF`), or none but the head's two ASCII characters each paired with a zero byte
 * (`#E` of `#EXTM3U` as `23 00 45 00` or `00 23 00 45`), which no real UTF-8 or Latin-1 list starts with.
 */
function utf16Of(b) {
  if (b.length >= 2 && b[0] === 0xff && b[1] === 0xfe) return ["utf-16le", 2];
  if (b.length >= 2 && b[0] === 0xfe && b[1] === 0xff) return ["utf-16be", 2];
  if (b.length < 4) return null;
  const ascii = (x) => x >= 1 && x <= 0x7f;
  if (ascii(b[0]) && b[1] === 0 && ascii(b[2]) && b[3] === 0) return ["utf-16le", 0];
  if (b[0] === 0 && ascii(b[1]) && b[2] === 0 && ascii(b[3])) return ["utf-16be", 0];
  return null;
}

/**
 * UTF-16 first (by its BOM or its zero-byte head, see utf16Of). Otherwise a UTF-8 BOM is dropped and
 * strict UTF-8 is tried; on malformed input the whole file is read as ISO-8859-1.
 */
export function decodeM3u(bytes) {
  const b = Buffer.isBuffer(bytes) ? bytes : Buffer.from(bytes);
  const utf16 = utf16Of(b);
  if (utf16) return new TextDecoder(utf16[0], { ignoreBOM: true }).decode(b.subarray(utf16[1]));
  const body = b.length >= 3 && b[0] === 0xef && b[1] === 0xbb && b[2] === 0xbf ? b.subarray(3) : b;
  try {
    return new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(body);
  } catch {
    return body.toString("latin1");
  }
}

// java.net.URLDecoder.decode(s, "UTF-8"): runs of %XX become bytes decoded as UTF-8 (bad bytes as
// U+FFFD); a bad or short escape throws, which the caller turns into "no value".
function urlDecode(s) {
  let out = "";
  for (let i = 0; i < s.length;) {
    if (s[i] !== "%") { out += s[i++]; continue; }
    const bytes = [];
    while (i < s.length && s[i] === "%") {
      const hex = s.slice(i + 1, i + 3);
      if (hex.length < 2 || !/^(?:[0-9a-fA-F]{2}|\+[0-9a-fA-F])$/.test(hex)) throw new Error("bad escape");
      bytes.push(parseInt(hex, 16));
      i += 3;
    }
    out += new TextDecoder("utf-8").decode(Uint8Array.from(bytes));
  }
  return out;
}

// A header value with a control character (a smuggled CR/LF) or past 1024 chars is dropped, never sent.
// Character.isISOControl: U+0000-U+001F and U+007F-U+009F.
const sendable = (value) => value.length <= 1024 && !/[\u0000-\u001f\u007f-\u009f]/.test(value);
function put(into, name, value) {
  if (sendable(value)) into[name] = value;
}

function pairs(s, into) {
  for (const pair of s.split("&")) {
    const name = KEPT_HEADERS[ktTrim(before(pair, "=")).toLowerCase()];
    if (!name) continue;
    let value = null;
    try { value = urlDecode(ktTrim(after(pair, "=", "")).replaceAll("+", "%2B")); } catch { value = null; }
    if (value) put(into, name, value);
  }
}

function vlcOpt(v, into) {
  const key = ktTrim(before(v, "=")).toLowerCase();
  const name = key === "http-user-agent" ? "User-Agent" : key === "http-referrer" || key === "http-referer" ? "Referer" : key === "http-origin" ? "Origin" : null;
  if (!name) return;
  const value = ktTrim(after(v, "=", ""));
  if (value) put(into, name, value);
}

// #EXTHTTP:{"User-Agent":"…","Referer":"…"} (OTT Navigator, TiviMate): string values of the kept headers only.
function extHttp(v, into) {
  let json;
  try { json = JSON.parse(ktTrim(v)); } catch { return; }
  if (!json || typeof json !== "object" || Array.isArray(json)) return;
  for (const [key, raw] of Object.entries(json)) {
    const name = KEPT_HEADERS[ktTrim(key).toLowerCase()];
    if (!name || typeof raw !== "string") continue;
    const value = ktTrim(raw);
    if (value) put(into, name, value);
  }
}

/**
 * Headers go straight into `into`; a license line is returned instead as `[type, key]`, either one
 * null when the line doesn't set it. `drm_legacy=<type>|<key>` sets both at once.
 */
function kodiProp(v, into) {
  const key = ktTrim(before(v, "=")).toLowerCase();
  const value = after(v, "=", "");
  switch (key) {
    case "inputstream.adaptive.stream_headers":
    case "inputstream.adaptive.common_headers": pairs(value, into); return null;
    case "inputstream.adaptive.license_type": return [ktTrim(value).toLowerCase(), null];
    case "inputstream.adaptive.license_key": return [null, ktTrim(value)];
    case "inputstream.adaptive.drm_legacy": return [ktTrim(before(value, "|")).toLowerCase(), ktTrim(after(value, "|", ""))];
    default: return null;
  }
}

// java.util.Base64's URL decoder: the URL alphabet only, no impossible length. Hex of exactly 16 bytes, else null.
function b64urlHex(s) {
  const t = ktTrim(s).replace(/=+$/, "");
  if (!/^[A-Za-z0-9_-]*$/.test(t) || t.length % 4 === 1) return null;
  const bytes = Buffer.from(t, "base64url");
  return bytes.length === 16 ? bytes.toString("hex") : null;
}

/** `kid:key` in hex, or the ClearKey JSON `{"keys":[{"kid":"<b64url>","k":"<b64url>"}]}` (its first key). Null unless both are 16 bytes. */
function clearKeyPair(raw) {
  const text = ktTrim(raw);
  if (text.startsWith("{")) {
    let key;
    try { key = JSON.parse(text).keys[0]; } catch { return null; }
    if (!key || typeof key !== "object" || Array.isArray(key)) return null;
    // org.json's optString: absent or null is "", any other value its text.
    const opt = (v) => (v === undefined || v === null ? "" : String(v));
    const kid = b64urlHex(opt(key.kid));
    const k = kid && b64urlHex(opt(key.k));
    return kid && k ? [kid, k] : null;
  }
  const colon = text.indexOf(":");
  if (colon < 0) return null;
  const [kid, k] = [ktTrim(text.slice(0, colon)), ktTrim(text.slice(colon + 1))];
  return HEX_16.test(kid) && HEX_16.test(k) ? [kid.toLowerCase(), k.toLowerCase()] : null;
}

/**
 * inputstream.adaptive's Widevine `license_key`: `<url>[|Header=Value&...[|post data|response]]`.
 * The URL (http(s), no whitespace) and its headers (values URL-decoded, at most
 * MAX_LICENSE_HEADERS, hop-by-hop ones dropped); null without a usable URL.
 */
function widevineLicense(raw) {
  const parts = ktTrim(raw).split("|");
  const url = ktTrim(parts[0]);
  const scheme = before(url, "://", "").toLowerCase();
  if ((scheme !== "http" && scheme !== "https") || url.length <= scheme.length + 3 || URL_BLANK.test(url)) return null;
  const headers = new Map();
  for (const pair of parts.length > 1 ? parts[1].split("&") : []) {
    const name = ktTrim(before(pair, "="));
    if (headers.size >= MAX_LICENSE_HEADERS || !HEADER_NAME.test(name) || UNSENDABLE_LICENSE_HEADERS.includes(name.toLowerCase())) continue;
    let value = null;
    try { value = urlDecode(ktTrim(after(pair, "=", "")).replaceAll("+", "%2B")); } catch { value = null; }
    if (value && sendable(value)) headers.set(name, value);
  }
  return [url, Object.fromEntries(headers)];
}

/** `tvg-shift` hours (decimal, optional sign, comma or dot) to minutes; anything else, or past a day either way, is 0. */
function shiftMinutes(raw) {
  if (raw === undefined) return 0;
  const t = ktTrim(raw).replaceAll(",", ".").replace(/^\+/, "");
  // Kotlin's toDoubleOrNull: a decimal with optional sign and exponent (hex and Infinity refused below).
  if (!/^[+-]?(\d+\.?\d*|\.\d+)([eE][+-]?\d+)?[fFdD]?$/.test(t)) return 0;
  const h = parseFloat(t);
  if (!Number.isFinite(h)) return 0;
  // Math.round: half up, as Java's.
  const min = Math.floor(h * 60 + 0.5);
  return min >= -1440 && min <= 1440 ? min : 0;
}

function extinf(line) {
  const body = after(line, ":", "");
  // A comma inside a quoted value is not the title's. A single quote only opens a value right
  // after `=`, so an apostrophe anywhere else (a bare `tvg-name=O'Brien`) never swallows the title.
  let quote = null;
  let comma = -1;
  for (let i = 0; i < body.length; i++) {
    const c = body[i];
    if (quote !== null) { if (c === quote) quote = null; }
    else if (c === '"') quote = '"';
    else if (c === "'" && i > 0 && body[i - 1] === "=") quote = "'";
    else if (c === ",") { comma = i; break; }
  }
  const head = comma >= 0 ? body.slice(0, comma) : body;
  const attrs = new Map();
  for (const m of head.matchAll(ATTR)) attrs.set(m[1].toLowerCase(), ktTrim(attrValue(m)));
  return { attrs, title: comma >= 0 ? ktTrim(body.slice(comma + 1)) : "" };
}

/** The `#EXTM3U` header's `url-tvg` / `x-tvg-url` (comma-separated): http(s) only, deduplicated, at most MAX_LIST_EPGS. */
function headerEpgs(line) {
  const attrs = new Map();
  for (const m of after(line, " ", "").matchAll(ATTR)) attrs.set(m[1].toLowerCase(), attrValue(m));
  const urls = ["url-tvg", "x-tvg-url"].flatMap((k) => (attrs.get(k) ?? "").split(",")).map(ktTrim)
    .filter((u) => { const scheme = before(u, "://", "").toLowerCase(); return scheme === "http" || scheme === "https"; });
  return [...new Set(urls)].slice(0, MAX_LIST_EPGS);
}

function channelNumber(v) {
  if (v === undefined || !/^[+-]?\d+$/.test(v)) return 0;
  const n = Number(v);
  return Number.isInteger(n) && n >= 1 && n <= live().maxChannelNumber ? n : 0;
}

function entryOf(info, urlLine, extgrp, pending, licenseType = "", licenseKey = "") {
  const pipe = urlLine.indexOf("|");
  const url = ktTrim(pipe >= 0 ? urlLine.slice(0, pipe) : urlLine);
  const scheme = before(url, "://", "").toLowerCase();
  if (scheme !== "http" && scheme !== "https") return null;
  const get = (k) => info.attrs.get(k) ?? "";
  const tvgName = get("tvg-name");
  const name = (isBlank(info.title) ? tvgName : info.title).slice(0, 200);
  if (isBlank(name)) return null;
  const headers = { ...pending };
  if (pipe >= 0) pairs(urlLine.slice(pipe + 1), headers);
  const group = get("group-title");
  // ClearKey and Widevine only: any other license type (PlayReady...) is left out entirely rather
  // than half-carried as an unusable DRM hint. Parsed only: whoever plays the entry decides.
  const clearKey = licenseType === "clearkey" || licenseType === "org.w3.clearkey" ? clearKeyPair(licenseKey) : null;
  const widevine = licenseType === "com.widevine.alpha" || licenseType === "widevine" ? widevineLicense(licenseKey) : null;
  return {
    name, url, tvgId: get("tvg-id"), tvgName, logo: get("tvg-logo"), number: channelNumber(info.attrs.get("tvg-chno")),
    group: isBlank(group) ? extgrp : group, language: get("tvg-language"), country: get("tvg-country"), headers,
    drmKeyId: clearKey?.[0] ?? "", drmKey: clearKey?.[1] ?? "",
    drmLicenseUrl: widevine?.[0] ?? "", drmLicenseHeaders: widevine?.[1] ?? {},
    tvgShiftMin: shiftMinutes(info.attrs.get("tvg-shift")),
  };
}

/**
 * An M3U/M3U8 list, parsed by the app's rules: `{ entries, total, skipped, epgUrls }` (plus `hidden`
 * and `refused` when a `hide` or `allow` filter is given). `epgUrls` are the guides the `#EXTM3U`
 * header names (only a header ahead of every entry counts). `total` = valid entries seen, `entries` the
 * first `maxEntries` of them, `skipped` = broken ones. An entry `hide` matches, or whose URL `allow`
 * refuses, is counted apart and never spends `maxEntries`. Bytes are decoded as the app does; a
 * string is read as given.
 */
export function parseM3u(input, { maxEntries = live().maxChannelsPerProvider, hide = null, allow = null } = {}) {
  const text = typeof input === "string" ? input : decodeM3u(input);
  const out = [];
  let total = 0, skipped = 0, hidden = 0, refused = 0;
  let info = null;
  let extgrp = "";
  let headers = {};
  let licenseType = "";
  let licenseKey = "";
  let epgUrls = [];
  let seenContent = false;
  for (const raw of text.split(/\r\n|\n|\r/)) {
    const line = ktTrim(raw);
    if (line === "") continue;
    if (startsWithIgnoreCase(line, "#EXTM3U")) { if (!seenContent) epgUrls = headerEpgs(line); }
    else if (startsWithIgnoreCase(line, "#EXTINF")) {
      seenContent = true;
      if (info) skipped++;
      info = extinf(line);
    } else if (startsWithIgnoreCase(line, "#EXTGRP:")) extgrp = ktTrim(after(line, ":"));
    else if (startsWithIgnoreCase(line, "#EXTVLCOPT:")) vlcOpt(after(line, ":"), headers);
    else if (startsWithIgnoreCase(line, "#EXTHTTP:")) extHttp(after(line, ":"), headers);
    else if (startsWithIgnoreCase(line, "#KODIPROP:")) {
      const license = kodiProp(after(line, ":"), headers);
      if (license) { if (license[0] !== null) licenseType = license[0]; if (license[1] !== null) licenseKey = license[1]; }
    } else if (line.startsWith("#")) continue;
    else {
      seenContent = true;
      const entry = info ? entryOf(info, line, extgrp, headers, licenseType, licenseKey) : null;
      info = null;
      extgrp = "";
      headers = {};
      licenseType = "";
      licenseKey = "";
      if (!entry) skipped++;
      else if (hide && hide(entry)) hidden++;
      else if (allow && !allow(entry.url)) refused++;
      else { total++; if (out.length < maxEntries) out.push(entry); }
    }
  }
  if (info) skipped++;
  const result = { entries: out, total, skipped, epgUrls };
  if (hide || allow) Object.assign(result, { hidden, refused });
  return result;
}

// ---------- grouping, as PlaylistGroups.kt ----------

/** Group titles hidden in every playlist (lowercased, trimmed), on top of the playlist's own `hideGroups`. */
export const ADULT_GROUPS = ["adultos", "adulto", "adult", "adults", "xxx", "18+", "+18", "for adults", "porn", "porno"];
const NO_GROUP = "Sin categoría";
const ID = new RegExp(contract.output.itemIdPattern);

export function isHiddenGroup(group, hideGroups = []) {
  const g = (ktTrim(group) || NO_GROUP).toLowerCase();
  return ADULT_GROUPS.includes(g) || hideGroups.includes(g);
}

/**
 * A playlist as Kino shows it: parsed with the adult and `hideGroups` groups hidden and `allow`'s
 * refusals counted, then grouped into categories. `channels` kept, `total` valid and visible,
 * `skipped` (broken lines, refused hosts and the very same url+name twice), `hidden`. A tvg-id used
 * by more than one entry is listed in `duplicateTvgIds`: only its first entry keeps the tvg-id as
 * its code, the later ones get a code from their URL and name (their favourites and recents follow
 * the URL, and a copy inserted BEFORE the first one takes the tvg-id code over).
 */
export function summarisePlaylist(input, { hideGroups = [], allow = null, maxChannels = live().maxChannelsPerProvider, maxCategories = live().maxCategoriesPerProvider } = {}) {
  const r = parseM3u(input, { maxEntries: maxChannels, hide: (e) => isHiddenGroup(e.group, hideGroups), allow });
  const tvgCount = new Map();
  const firstWithTvg = new Map();
  r.entries.forEach((e, i) => {
    tvgCount.set(e.tvgId, (tvgCount.get(e.tvgId) || 0) + 1);
    if (!firstWithTvg.has(e.tvgId)) firstWithTvg.set(e.tvgId, i);
  });
  const categories = new Map();
  const seen = new Set();
  const channels = [];
  let skipped = r.skipped + r.refused;
  let dropped = 0;
  for (const [i, e] of r.entries.entries()) {
    if (channels.length >= maxChannels || maxCategories <= 0) continue;
    // The app's channel code: the tvg-id when it is a valid id and this is the list's first entry
    // with it, else the url and name; the very same code twice is one channel, the copy counted as skipped.
    const key = ID.test(e.tvgId) && firstWithTvg.get(e.tvgId) === i ? `id:${e.tvgId}` : `h:${e.url}|${e.name}`;
    if (seen.has(key)) { skipped++; dropped++; continue; }
    seen.add(key);
    const group = ktTrim(e.group) || NO_GROUP;
    let cat = categories.get(group);
    if (!cat) {
      if (categories.size < maxCategories - 1) categories.set(group, cat = { title: group, count: 0 });
      else { cat = categories.get("\u0000otros") || { title: "Otros", count: 0 }; categories.set("\u0000otros", cat); }
    }
    cat.count++;
    channels.push({ ...e, category: cat.title });
  }
  const duplicateTvgIds = [...tvgCount].filter(([id, n]) => id && n > 1).map(([id]) => id);
  return {
    channels: channels.length, total: r.total - dropped, skipped, hidden: r.hidden,
    categories: [...categories.values()], entries: channels, duplicateTvgIds,
  };
}

// ---------- XMLTV ----------

const TIME = /^(\d{14}|\d{12})\s*([+-]\d{4})?/;
const ENCODING_DECL = /encoding\s*=\s*["']([^"'?>]+)["']/i;
const NATIVE_LATIN1 = ["iso-8859-1", "iso8859-1", "latin1", "us-ascii", "ascii"];
const HEAD_SCAN_BYTES = 8192;
const MAX_TEXT_CHARS = 2000;
const MAX_TITLE_CHARS = 200;
const MAX_DESC_CHARS = 2000;
/** How long a programme with no `stop` and no later programme on its channel is taken to last: one hour. */
export const OPEN_END_MS = 60 * 60 * 1000;

/** NFD, strip combining marks, lowercase, keep only `[a-z0-9]`: accents and case never split a match. */
export function normaliseName(s) {
  return String(s).normalize("NFD").replace(/\p{Mn}+/gu, "").toLowerCase().replace(/[^a-z0-9]/g, "");
}

const daysIn = (y, m) => new Date(Date.UTC(y, m, 0)).getUTCDate();

/** `yyyyMMddHHmm[ss] [±HHMM]` to epoch ms; no offset means UTC. Null on anything else. */
export function parseXmltvTime(value) {
  const m = TIME.exec(ktTrim(String(value)));
  if (!m) return null;
  const d = m[1].padEnd(14, "0");
  const [y, mo, day, h, mi, s] = [d.slice(0, 4), d.slice(4, 6), d.slice(6, 8), d.slice(8, 10), d.slice(10, 12), d.slice(12, 14)].map(Number);
  if (mo < 1 || mo > 12 || day < 1 || day > 31 || mi > 59 || s > 59 || h > 24 || (h === 24 && (mi || s))) return null;
  // java.time's SMART resolver: day 31 of a 30-day month is its last day, 24:00 the next midnight.
  const local = Date.UTC(y, mo - 1, Math.min(day, daysIn(y, mo)), h, mi, s);
  const off = m[2] || "+0000";
  const oh = Number(off.slice(1, 3));
  const om = Number(off.slice(3, 5));
  if (oh > 18 || om > 59 || (oh === 18 && om > 0)) return null;
  return local - (off[0] === "-" ? -1 : 1) * (oh * 60 + om) * 60000;
}

const ENTITIES = { lt: "<", gt: ">", amp: "&", quot: '"', apos: "'" };
function decodeEntities(s) {
  return s.replace(/&(#x[0-9a-fA-F]+|#\d+|lt|gt|amp|quot|apos);/g, (all, e) => {
    if (e[0] !== "#") return ENTITIES[e];
    const cp = e[1] === "x" ? parseInt(e.slice(2), 16) : parseInt(e.slice(1), 10);
    return cp <= 0x10ffff ? String.fromCodePoint(cp) : all;
  });
}

/** An element's character data as SAX hands it over: child tags dropped, CDATA literal, entities decoded. */
function textOf(inner) {
  let out = "";
  for (const m of inner.matchAll(/<!\[CDATA\[([\s\S]*?)\]\]>|<!--[\s\S]*?-->|<[^>]*>|[^<]+/g)) {
    if (m[1] !== undefined) out += m[1];
    else if (m[0][0] !== "<") out += decodeEntities(m[0]);
    if (out.length >= MAX_TEXT_CHARS) break;
  }
  return ktTrim(out.slice(0, MAX_TEXT_CHARS));
}

function attrsOf(s) {
  const out = new Map();
  for (const m of s.matchAll(/([\w:.-]+)\s*=\s*(?:"([^"]*)"|'([^']*)')/g)) if (!out.has(m[1])) out.set(m[1], decodeEntities(m[2] ?? m[3]));
  return out;
}

const tooLarge = (e) => e && (e.code === "ERR_BUFFER_TOO_LARGE" || e instanceof RangeError);

/** Gunzip under the byte cap. Past it, or on a cut or corrupt stream, what inflates is kept and `truncated` set. */
function gunzipCapped(buf, maxBytes) {
  try {
    return { bytes: gunzipSync(buf, { maxOutputLength: maxBytes }), truncated: false };
  } catch (e) {
    if (!tooLarge(e)) {
      try { return { bytes: gunzipSync(buf, { finishFlush: zlibConstants.Z_SYNC_FLUSH, maxOutputLength: maxBytes }), truncated: true }; }
      catch (e2) { if (!tooLarge(e2)) return { bytes: Buffer.alloc(0), truncated: true }; }
    }
    // Over the cap: inflate shorter and shorter prefixes until one fits.
    for (let len = buf.length >> 1; len > 18; len >>= 1) {
      try { return { bytes: gunzipSync(buf.subarray(0, len), { finishFlush: zlibConstants.Z_SYNC_FLUSH, maxOutputLength: maxBytes }), truncated: true }; }
      catch (e3) { if (!tooLarge(e3)) break; }
    }
    return { bytes: Buffer.alloc(0), truncated: true };
  }
}

/** The document as text: BOM first, else the declared encoding (anything unknown read as ISO-8859-1). */
function decodeXml(b, maxBytes) {
  if (b.length >= 3 && b[0] === 0xef && b[1] === 0xbb && b[2] === 0xbf) return utf8(b.subarray(3));
  if (b.length >= 2 && b[0] === 0xfe && b[1] === 0xff) return { text: new TextDecoder("utf-16be").decode(b.subarray(2)), truncated: false };
  if (b.length >= 2 && b[0] === 0xff && b[1] === 0xfe) return { text: new TextDecoder("utf-16le").decode(b.subarray(2)), truncated: false };
  const declared = ENCODING_DECL.exec(b.subarray(0, HEAD_SCAN_BYTES).toString("latin1"))?.[1]?.toLowerCase();
  if (!declared || declared === "utf-8" || declared === "utf8") return utf8(b);
  if (NATIVE_LATIN1.includes(declared)) return { text: b.toString("latin1"), truncated: false };
  if (declared.startsWith("utf-16")) return { text: new TextDecoder(declared === "utf-16be" ? "utf-16be" : "utf-16le").decode(b), truncated: false };
  // Decoded, as the app does for what Expat can't read: the byte cap applies to the text counted as UTF-8 too.
  let text;
  try { text = new TextDecoder(declared).decode(b); } catch { text = b.toString("latin1"); }
  const encoded = Buffer.from(text, "utf8");
  return encoded.length > maxBytes ? { text: encoded.subarray(0, maxBytes).toString("utf8"), truncated: true } : { text, truncated: false };
}

function utf8(b) {
  try { return { text: new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(b), truncated: false }; }
  catch { return { text: new TextDecoder("utf-8", { ignoreBOM: true }).decode(b), truncated: true }; }
}

const WALK = /<(channel|programme)\b([^>]*?)(?:\/>|>([\s\S]*?)<\/\1\s*>)/g;
const CHILD = Object.fromEntries(["title", "desc"].map((tag) => [tag, new RegExp(`<${tag}\\b[^>]*?(?:\\/>|>([\\s\\S]*?)<\\/${tag}\\s*>)`)]));
/** The first `<title>`/`<desc>` child's text (the app keeps the first one, even if blank), or null. */
const firstChild = (inner, tag) => {
  const m = CHILD[tag].exec(inner);
  return m ? textOf(m[1] ?? "") : null;
};

/**
 * An XMLTV guide (plain or gzip), read by the app's rules: `{ displayNames, programmes, truncated }`,
 * plus `refused: true` when it was turned down for declaring a DOCTYPE.
 * Only the wanted channels (`wantedIds`, or any display name whose `normaliseName` is in
 * `wantedNames`; `wantedIds` null wants every channel, at most 5000) inside `[from, to)`, each list
 * sorted by start, one per start time, the earliest `maxPerChannel` kept. A document with any
 * DOCTYPE is refused: empty, not truncated. A byte cap, a cut download or a broken tail keeps what
 * was read and sets `truncated`. Programmes are `{ title, start, end, description }`, times in epoch ms.
 * A programme with no `stop` (optional in XMLTV) ends where the next programme of its channel starts,
 * or OPEN_END_MS after its own start when none follows.
 */
export function parseXmltv(buffer, { from, to, wantedIds = null, wantedNames = new Set(), maxPerChannel = live().maxGuideEntriesPerChannel, maxBytes = live().maxEpgBytes } = {}) {
  let bytes = Buffer.isBuffer(buffer) ? buffer : Buffer.from(buffer);
  let truncated = false;
  if (bytes.length >= 2 && bytes[0] === 0x1f && bytes[1] === 0x8b) {
    const g = gunzipCapped(bytes, maxBytes);
    bytes = g.bytes;
    truncated = g.truncated;
  } else if (bytes.length > maxBytes) {
    bytes = bytes.subarray(0, maxBytes);
    truncated = true;
  }
  const decoded = decodeXml(bytes, maxBytes);
  const text = decoded.text;
  truncated = truncated || decoded.truncated;
  // `refused` marks a guide turned down on purpose (the app returns the same empty guide, silently).
  const refused = { displayNames: {}, programmes: {}, truncated: false, refused: true };
  // The app's fast path scans the raw head for `<!ENTITY`, comments included: so does this.
  if (text.slice(0, HEAD_SCAN_BYTES).includes("<!ENTITY")) return refused;
  // The app refuses a real DOCTYPE structurally; a "<!DOCTYPE" inside a comment or CDATA is text.
  if (/<!DOCTYPE/i.test(text.replace(/<!--[\s\S]*?(?:-->|$)|<!\[CDATA\[[\s\S]*?(?:\]\]>|$)/g, ""))) return refused;

  const names = new Map();
  const wanted = new Map();
  const progs = new Map();
  const known = new Set();
  const admit = (id) => {
    if (known.has(id)) return true;
    if (known.size >= live().maxChannelsPerProvider) return false;
    known.add(id);
    return true;
  };
  const keep = (p) => {
    if (!(p.end > p.start) || !(p.end > from) || !(p.start < to)) return;
    let perChannel = progs.get(p.channel);
    if (!perChannel) progs.set(p.channel, perChannel = new Map());
    if (perChannel.has(p.start)) return;
    const entry = { title: p.title, start: p.start, end: p.end, description: p.description };
    if (perChannel.size < maxPerChannel) perChannel.set(p.start, entry);
    else {
      const latest = Math.max(...perChannel.keys());
      if (p.start < latest) { perChannel.delete(latest); perChannel.set(p.start, entry); }
    }
  };
  // A programme with no `stop`, per channel, waiting for the next one of its channel to start. At most
  // one per channel: in a guide listed in time order, the very next programme of the channel ends it.
  const open = new Map();
  // An open programme ends at `nextStart`, or at the next kept start of its channel when that comes
  // sooner (a guide out of time order), else OPEN_END_MS after its start.
  const close = (p, nextStart) => {
    const later = [...(progs.get(p.channel)?.keys() ?? [])].filter((k) => k > p.start);
    const ends = [nextStart, later.length ? Math.min(...later) : null].filter((v) => v !== null);
    keep({ ...p, end: ends.length ? Math.min(...ends) : p.start + OPEN_END_MS });
  };
  for (const m of text.matchAll(WALK)) {
    const attrs = attrsOf(m[2]);
    const inner = m[3] ?? "";
    if (m[1] === "channel") {
      const id = attrs.get("id");
      if (id === undefined) continue;
      const displayNames = [...inner.matchAll(/<display-name\b[^>]*?(?:\/>|>([\s\S]*?)<\/display-name\s*>)/g)].map((d) => textOf(d[1] ?? ""));
      if (wantedIds === null && !admit(id)) continue;
      const ok = wantedIds === null || wantedIds.has(id) || displayNames.some((n) => wantedNames.has(normaliseName(n)));
      wanted.set(id, ok);
      if (ok) names.set(id, displayNames);
      continue;
    }
    const start = attrs.has("start") ? parseXmltvTime(attrs.get("start")) : null;
    const end = attrs.has("stop") ? parseXmltvTime(attrs.get("stop")) : null;
    const channel = attrs.get("channel") ?? "";
    const title = firstChild(inner, "title");
    const ok = wanted.has(channel) ? wanted.get(channel) : wantedIds !== null ? wantedIds.has(channel) : admit(channel);
    if (!ok || start === null) continue;
    // Any programme of the channel with a start, titled or not, in the window or not, is where an open
    // one before it ends. One starting at or before the open one (out of order) leaves it open; an open
    // one of its own then ends there.
    let stop = end;
    const prev = open.get(channel);
    if (prev) {
      if (start > prev.start) { open.delete(channel); close(prev, start); }
      else if (stop === null && start < prev.start) stop = prev.start;
    }
    if (title === null || isBlank(title)) continue;
    const entry = { channel, title: title.slice(0, MAX_TITLE_CHARS), start, end: stop ?? start, description: (firstChild(inner, "desc") ?? "").slice(0, MAX_DESC_CHARS) };
    if (stop !== null) keep(entry);
    else if (!open.has(channel)) open.set(channel, entry);
  }
  // The end of the document (or of what was read of it): nothing follows the open ones.
  for (const p of open.values()) close(p, null);
  // Well-formed ends with its root closed; anything else is a cut download or a broken tail.
  if (!/<\/tv\s*>\s*(?:<!--[\s\S]*?-->\s*)*$/.test(text)) truncated = true;
  return {
    displayNames: Object.fromEntries(names),
    programmes: Object.fromEntries([...progs].filter(([, m]) => m.size).map(([id, m]) => [id, [...m.values()].sort((a, b) => a.start - b.start)])),
    truncated,
  };
}

// ---------- downloads, as the app makes them ----------

/**
 * The first `maxBytes` of `bytes`, ending at their last line break (none: left as they are), as the
 * app keeps a list or guide over its cap (PluginPlaylistFetcher.fetchTo with `cut`, then
 * trimToLastLine). `{ bytes, cut }`, `cut` true when anything was left out.
 */
export function keepStart(bytes, maxBytes) {
  if (bytes.length <= maxBytes) return { bytes, cut: false };
  const start = bytes.subarray(0, maxBytes);
  const nl = start.lastIndexOf(0x0a);
  return { bytes: nl >= 0 ? start.subarray(0, nl + 1) : start, cut: true };
}

/**
 * Downloads a playlist or guide the way the app does: `headers` sent, redirects followed by hand
 * (at most 5) with every hop checked by `allow` (null = any http(s) URL), at most `maxBytes`.
 * Past `maxBytes` it throws, unless `cut`: then, as the app does for a declared playlist or guide,
 * only the start is kept (see keepStart) and the rest is never read; `onCut` is called when that happens.
 * Throws an Error with a readable message on anything else.
 */
export async function download(url, { headers = {}, maxBytes, allow = null, fetchImpl = globalThis.fetch, cut = false, onCut = () => {} } = {}) {
  let current = String(url);
  for (let hop = 0; hop <= 5; hop++) {
    let u;
    try { u = new URL(current); } catch { throw new Error(`dirección inválida: ${current.slice(0, 100)}`); }
    if (u.protocol !== "http:" && u.protocol !== "https:") throw new Error(`solo http(s): ${current.slice(0, 100)}`);
    if (allow && !allow(current)) throw new Error(`${u.hostname} no es un host declarado ni un servidor escrito`);
    const r = await fetchImpl(current, { headers, redirect: "manual" });
    if (r.status >= 300 && r.status < 400 && r.headers.get("location")) {
      current = new URL(r.headers.get("location"), current).toString();
      continue;
    }
    if (!r.ok) throw new Error(`respondió ${r.status}`);
    const chunks = [];
    let size = 0;
    for await (const chunk of r.body ?? []) {
      size += chunk.length;
      chunks.push(Buffer.from(chunk));
      if (size > maxBytes) {
        if (!cut) throw new Error(`pasa de ${Math.round(maxBytes / (1024 * 1024))} MB`);
        onCut();
        return keepStart(Buffer.concat(chunks), maxBytes).bytes;
      }
    }
    return Buffer.concat(chunks);
  }
  throw new Error("demasiadas redirecciones");
}

// ---------- what the kit prints ----------

/** "N canales en M categorías; K entradas descartadas; L ocultas (adultos)", plus the cut notices when there are any. */
export function summaryLines(s) {
  const lines = [`${s.channels} canales en ${s.categories.length} categorías; ${s.skipped} entradas descartadas; ${s.hidden} ocultas (adultos)`];
  if (s.cut) lines.push(`Lista de más de ${Math.round(live().maxPlaylistBytes / (1024 * 1024))} MB: Kino lee solo su comienzo`);
  if (s.total > s.channels) lines.push(`Lista recortada: ${s.channels} de ${s.total} canales`);
  if (s.duplicateTvgIds.length) {
    lines.push(`note: ${s.duplicateTvgIds.length} tvg-id used more than once (${s.duplicateTvgIds.slice(0, 5).join(", ")}${s.duplicateTvgIds.length > 5 ? ", …" : ""}): after the first, those channels get a code from their URL and name, which changes if the URL does; keep tvg-ids unique and stable`);
  }
  return lines;
}

/** The first `max` channels as `group › name  url`, each followed by what is on now when a guide is given. */
export function channelLines(s, { guide = null, now = Date.now(), max = 20 } = {}) {
  const nameToId = new Map();
  if (guide) for (const [id, list] of Object.entries(guide.displayNames)) for (const n of list) if (!nameToId.has(normaliseName(n))) nameToId.set(normaliseName(n), id);
  const lines = [];
  for (const e of s.entries.slice(0, max)) {
    lines.push(`${e.category} › ${e.name}  ${e.url}`);
    if (!guide) continue;
    const list = (e.tvgId && guide.programmes[e.tvgId]) || guide.programmes[nameToId.get(normaliseName(e.name))] || [];
    const onAir = list.find((p) => p.start <= now && now < p.end);
    lines.push(onAir ? `    ahora: ${onAir.title}` : "    sin guía");
  }
  return lines;
}

/** Parses a guide for the first `max` channels of a summary, over a window around `now`. */
export function guideFor(s, bytes, { now = Date.now(), max = 20 } = {}) {
  const shown = s.entries.slice(0, max);
  return parseXmltv(bytes, {
    from: now, to: now + 1,
    wantedIds: new Set(shown.map((e) => e.tvgId).filter(Boolean)),
    wantedNames: new Set(shown.map((e) => normaliseName(e.name)).filter(Boolean)),
  });
}

/**
 * One `{ playlist }` declaration as checked by checkOutput, downloaded and grouped as the app does:
 * the download under the strict host rule (declared hosts or a typed server, every redirect too),
 * the entries under the channel stream rule (`liveStreamHosts: "any"` included). A list over the cap
 * gives its start, as in the app, and the summary says `cut: true`.
 */
export async function loadPlaylist(p, { manifest, servers = [], fetchImpl = globalThis.fetch }) {
  let cut = false;
  const bytes = await download(p.url, { headers: p.headers || {}, maxBytes: live().maxPlaylistBytes, allow: playlistUrlAllowed(manifest, servers), fetchImpl, cut: true, onCut: () => { cut = true; } });
  const s = summarisePlaylist(bytes, { hideGroups: p.hideGroups || [], allow: liveStreamUrlAllowed(manifest, servers) });
  return cut ? { ...s, cut } : s;
}
