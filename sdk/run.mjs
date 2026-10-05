#!/usr/bin/env node
// Runs one function of a Kino plugin under Node with the same `kino` API the app provides, then
// checks the answer the way the app does and prints what the app would keep.
//   node sdk/run.mjs ./plugin.js search "metropolis"      (KINO_TYPE=movie|series|any)
//   node sdk/run.mjs ./plugin.js search '{"q":"dragnet","type":"series","year":1951}'
//   node sdk/run.mjs ./plugin.js home
//   node sdk/run.mjs ./plugin.js browse '<ref>' ['<cursor>']
//   node sdk/run.mjs --within '<browse ref>' ./plugin.js search "matrix"   (apiVersion 6, scopedSearch: search inside a "Ver más" page)
//   node sdk/run.mjs ./plugin.js episodes '<series ref>'
//   node sdk/run.mjs ./plugin.js resolve '<ref>'      (lists its copies; a lazy copy's ref resolves the same way, apiVersion 6)
//   node sdk/run.mjs ./plugin.js sign '{"url":"https://…/seg.ts","kind":"segment","ref":"<ref>","context":"<signContext>"}'   (apiVersion 6)
//     (with alternateHosts, Kino signs the URL of the host it is asking: pass "url" on each host to try its token)
//   node sdk/run.mjs ./plugin.js migrate '{"kind":"title","ref":"<old ref>"}'   (apiVersion 6)
// The settings form (apiVersion 6; not capabilities, they run even with a required setting empty):
//   node sdk/run.mjs <plugin dir> settingsStatus
//   node sdk/run.mjs <plugin dir> action <key>
//   node sdk/run.mjs <plugin dir> validateSettings '{"email":"ana@x.co"}'
// Live channels (apiVersion 3, the "channels" capability):
//   node sdk/run.mjs <plugin dir> live categories        (and downloads + groups each declared playlist)
//   node sdk/run.mjs <plugin dir> live channels <categoryId> [cursor]
//   node sdk/run.mjs <plugin dir> live guide <id,id>
//   node sdk/run.mjs <plugin dir> live search <query>     (the optional liveSearch export)
//   node sdk/run.mjs live playlist <url|file> [--epg <url|file>]   (any M3U list, no plugin needed)
// Your own section, categories and colors (apiVersion 6; no capability, the manifest decides):
//   node sdk/run.mjs <plugin dir> section [tab]     needs "section" in the manifest
//   node sdk/run.mjs <plugin dir> categories        needs apiVersion 6 and the browse capability
//   node sdk/run.mjs <plugin dir> theme             previews the five colors, contrast ratios and warnings
// Subtitles (the "subtitles" capability, or the export alone):
//   node sdk/run.mjs <plugin dir> subtitles tt0133093               (a movie by IMDb id)
//   node sdk/run.mjs <plugin dir> subtitles tmdb:1396 1 2           (an episode: the SERIES' id, season, episode)
//   node sdk/run.mjs <plugin dir> subtitles '{"imdbId":"tt0903747","kind":"series","season":1,"episode":2}'
//   (KINO_LANGS=es,en: the person's subtitle languages, in order)
// Options (before the plugin path):
//   --config key=value     a setting's value (repeatable); also read from sdk/config.json
//   --record <file>        save every kino.fetch answer to <file> (JSON)
//   --replay <file>        answer kino.fetch from <file> only: offline and repeatable
//   --raw                  print the plugin's answer as it returned it, without the app's checks
//   --epg <url|file>       live playlist only: the XMLTV guide to show what is on now
//   --retry conflict:1     resolve only: call resolve(ref, { retry: { reason: "conflict", attempt: 1 } })  (apiVersion 6);
//                          conflict:1:409 also passes the origin's HTTP status (401, 403 or 409)
//   --live                 resolve only: the ref is a live channel's (liveStreamHosts "any" applies)
//   --within <browse ref>  search only: Kino's scoped search ({ q, type: "any", within, cursor }); null = "can't search there"
// The first argument is the plugin's entry file or the folder that holds kino-plugin.json. The
// result goes to stdout as JSON; everything else (kino.log, console.*, dropped entries, errors)
// goes to stderr.
import { existsSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { checkOutput, checkSettingsOutput, contract, markSearchHits, validateManifest } from "./contract.mjs";
import { contrast, formatRatio, resolvePalette } from "./palette.mjs";
import { createKino, errorReport, signingLane } from "./kino-shim.mjs";
import { channelLines, download, guideFor, keepStart, loadPlaylist, summarisePlaylist, summaryLines } from "./live-playlist.mjs";

const FUNCTIONS = ["search", "home", "browse", "episodes", "resolve", "migrate", "section", "categories", "subtitles"];
// apiVersion 6's settings form: not capabilities, so no capability check; the app runs them even before a required setting is typed.
const SETTINGS_FUNCTIONS = ["settingsStatus", "action", "validateSettings"];
// `live <sub>` names one of the channels capability's exports.
const LIVE = { categories: "liveCategories", channels: "liveChannels", guide: "guide", search: "liveSearch" };
const USAGE = "usage: node sdk/run.mjs [--config k=v] [--record f | --replay f] [--raw] <plugin.js | plugin folder> <search|home|browse|episodes|resolve|migrate|sign> [argument] [cursor]\n"
  + "       node sdk/run.mjs [--config k=v] [--raw] <plugin folder> <section [tab] | categories | theme>\n"
  + "       node sdk/run.mjs [--config k=v] [--raw] <plugin folder> <settingsStatus | action <key> | validateSettings '<json>'>\n"
  + "       node sdk/run.mjs [--config k=v] <plugin folder> live <categories | channels <categoryId> [cursor] | guide <id,id> | search <query>>\n"
  + "       node sdk/run.mjs [--config k=v] <plugin folder> subtitles <ttID | tmdb:ID | JSON> [season episode]\n"
  + "       node sdk/run.mjs live playlist <url|file> [--epg <url|file>]";
const here = dirname(fileURLToPath(import.meta.url));

const stderr = console.error.bind(console);

/** What the app says when a `signing: "request"` Stream comes from a plugin without a sign() export. */
export const NO_SIGN_EXPORT = "El plugin pide firmar el video pero no exporta sign()";

/** The app's refusal of [value] (a checked resolve answer) from [plugin], or null. */
export function signExportProblem(value, plugin) {
  return value && value.signing && typeof plugin.sign !== "function" ? NO_SIGN_EXPORT : null;
}

/**
 * One `[18+] <title>` line per entry of a checked answer marked `adult` (apiVersion 6): rows' and pages' items,
 * category tiles, live categories and channels. Kino lists those only while the person's 18+ code is unlocked.
 */
export function adultLines(value) {
  const out = [];
  const walk = (v) => {
    if (Array.isArray(v)) return v.forEach(walk);
    if (v === null || typeof v !== "object") return;
    if (v.adult === true) out.push(`[18+] ${v.title} (Kino lo muestra solo con el código 18+ desbloqueado)`);
    for (const k of ["items", "rows", "categories"]) if (Array.isArray(v[k])) walk(v[k]);
  };
  walk(value);
  return out;
}

/**
 * A checked liveSearch [value] marked 18+ the way the app does (contract.mjs markSearchHits): it reads the plugin's
 * liveCategories (null when that fails or is not exported) only when the apiVersion has 18+ entries.
 */
export async function markLiveSearch(plugin, value, manifest, servers) {
  if (!(manifest.apiVersion >= contract.live.adultApiVersion)) return { value, unmarked: [], unreadable: false };
  let categories = null;
  try {
    if (typeof plugin.liveCategories === "function") categories = checkOutput("liveCategories", await plugin.liveCategories(null), manifest, servers).value.categories;
  } catch { categories = null; }
  return markSearchHits(value, categories, manifest);
}

/** The warning for [marked] (markLiveSearch's answer), or null when every hit is marked. */
export function unmarkedSearchNote(marked) {
  if (!marked.unmarked.length) return null;
  const names = marked.unmarked.slice(0, 5).join(", ") + (marked.unmarked.length > 5 ? "…" : "");
  return marked.unreadable
    ? `liveSearch: no se pudieron leer tus categorías (liveCategories falló): Kino trata como 18+ todo resultado sin "adult": false (${names})`
    : `liveSearch: ${marked.unmarked.length} resultado(s) sin "adult" ni un "categoryId" de tus categorías, en un plugin con categorías 18+: Kino los trata como 18+ (${names}). Márcalos con "adult" o "categoryId"`;
}

function fail(message) {
  stderr(message);
  return 2;
}

export function parseArgs(argv) {
  const opts = { config: {}, record: null, replay: null, raw: false, epg: null, live: false, retry: null, within: null };
  const rest = [];
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--config") {
      const kv = argv[++i] || "";
      const eq = kv.indexOf("=");
      if (eq <= 0) throw new Error("--config needs key=value");
      opts.config[kv.slice(0, eq)] = kv.slice(eq + 1);
    } else if (a === "--record") opts.record = argv[++i];
    else if (a === "--replay") opts.replay = argv[++i];
    else if (a === "--raw") opts.raw = true;
    else if (a === "--epg") opts.epg = argv[++i];
    else if (a === "--live") opts.live = true;
    else if (a === "--within") {
      const ref = argv[++i];
      if (ref === undefined || ref === "") throw new Error("--within needs the browse ref of a \"Ver más\" page");
      opts.within = ref;
    }
    else if (a === "--retry") {
      const [reason, attempt, status, extra] = (argv[++i] || "").split(":");
      const r = contract.output.retry;
      const n = Number(attempt);
      const s = status === undefined ? undefined : Number(status);
      if (extra !== undefined || !r.reasons.includes(reason) || !Number.isInteger(n) || n < 1 || n > r.maxAttempts || (s !== undefined && !r.statuses.includes(s))) {
        throw new Error(`--retry needs reason:attempt[:status], reason ${r.reasons.join("|")}, attempt 1..${r.maxAttempts}, status ${r.statuses.join("|")}`);
      }
      opts.retry = s === undefined ? { reason, attempt: n } : { reason, attempt: n, status: s };
    }
    else rest.push(a);
  }
  return { opts, rest };
}

async function main() {
  // Inside Kino, console.* goes to the log. Keep stdout clean so the JSON result can be piped.
  for (const level of ["log", "info", "warn", "error"]) {
    console[level] = (...args) => stderr(`[console.${level}]`, ...args);
  }
  let parsed;
  try { parsed = parseArgs(process.argv.slice(2)); } catch (e) { return fail(e.message); }
  const { opts, rest: args } = parsed;
  if (args[0] === "live" && args[1] === "playlist") {
    if (!args[2]) return fail(USAGE);
    return livePlaylist(args[2], opts.epg);
  }
  let [targetArg, fn, ...rest] = args;
  if (fn === "live") {
    fn = LIVE[rest[0]];
    rest = rest.slice(1);
  }
  if (!targetArg || !(FUNCTIONS.includes(fn) || SETTINGS_FUNCTIONS.includes(fn) || fn === "sign" || fn === "theme" || Object.values(LIVE).includes(fn))) return fail(USAGE);
  if (opts.record && opts.replay) return fail("--record and --replay can't be used together");
  const target = resolve(targetArg);
  let stat;
  try { stat = statSync(target); } catch { return fail(`not found: ${targetArg}`); }
  const dir = stat.isDirectory() ? target : dirname(target);
  let manifestText;
  try { manifestText = readFileSync(join(dir, "kino-plugin.json"), "utf8"); } catch (e) { return fail(`cannot read kino-plugin.json in ${dir}: ${e.message}`); }
  const checked = validateManifest(manifestText);
  if (!checked.ok) return fail(`kino-plugin.json: ${checked.field}: ${checked.message}`);
  const manifest = checked.manifest;
  const entryPath = resolve(dir, manifest.entry);
  if (!stat.isDirectory() && target !== entryPath) return fail(`${targetArg} is not the manifest's entry (${manifest.entry})`);
  if (fn === "theme") {
    const declared = manifest.theme || {};
    const p = resolvePalette(declared);
    const lines = contract.manifest.theme.tokens.map((k) => `${k.padEnd(11)}${(declared[k] || "-").padEnd(9)}${declared[k] && p.kept.includes(k) ? "se usa" : "Kino"}`.padEnd(11 + 9 + 6) + `  ${p[k]}`);
    lines.push(`onAccent sobre accent: ${formatRatio(contrast(p.onAccent, p.accent))}:1`, `accent sobre background: ${formatRatio(contrast(p.accent, p.background))}:1`, `highlight sobre background: ${formatRatio(contrast(p.highlight, p.background))}:1`);
    for (const w of p.warnings) lines.push(`aviso: ${w}`);
    process.stdout.write(lines.join("\n") + "\n");
    return 0;
  }
  if (fn === "section" && !manifest.section) return fail('the manifest does not declare "section"');
  if (fn === "categories" && !(manifest.apiVersion >= contract.output.categories.apiVersion && manifest.capabilities.includes("browse"))) return fail("categories needs apiVersion 6 and the browse capability");
  const capability = Object.values(LIVE).includes(fn) ? "channels" : fn === "sign" ? "resolve" : fn;
  // `subtitles` may be exported by any plugin without the capability (Kino asks whoever exports it).
  const anyPlugin = contract.capabilities.anyPluginExports.includes(fn);
  if (!anyPlugin && !SETTINGS_FUNCTIONS.includes(fn) && fn !== "section" && fn !== "categories" && !manifest.capabilities.includes(capability)) return fail(`the manifest does not declare "${capability}" in capabilities`);

  const configFile = join(here, "config.json");
  const config = { ...(existsSync(configFile) ? JSON.parse(readFileSync(configFile, "utf8")) : {}), ...opts.config };
  const { kino, servers, resetBudget, saveTape } = createKino(manifest, {
    storageFile: join(dir, ".kino-storage.json"),
    cookiesFile: join(dir, ".kino-cookies.json"),
    secretsFile: join(dir, ".kino-secrets.json"),
    config,
    record: opts.record && resolve(opts.record),
    replay: opts.replay && resolve(opts.replay),
  });
  const missing = (manifest.settings || []).filter((s) => s.required && (kino.config.get(s.key) === undefined || kino.config.get(s.key) === ""));
  if (missing.length && !SETTINGS_FUNCTIONS.includes(fn)) {
    // The app doesn't run a plugin with a required setting empty: it fails with auth_required.
    return fail(`auth_required: set ${missing.map((s) => s.key).join(", ")} with --config key=value or sdk/config.json`);
  }
  if ((fn === "sign" || opts.retry) && !(manifest.apiVersion >= contract.output.signing.apiVersion)) {
    return fail(`${fn === "sign" ? "sign" : "--retry"} needs apiVersion ${contract.output.signing.apiVersion} in kino-plugin.json`);
  }
  if (opts.retry && fn !== "resolve") return fail("--retry only applies to resolve");
  if (opts.within !== null && fn !== "search") return fail("--within only applies to search");
  const scoped = contract.search.scoped;
  if (opts.within !== null && !manifest.capabilities.includes(scoped.capability)) return fail(`--within needs "${scoped.capability}" in capabilities (apiVersion ${scoped.apiVersion})`);
  // sign() runs in its own lane inside the app: no network, storage, cookies or sleep.
  globalThis.kino = fn === "sign" ? signingLane(kino) : kino;

  // Kino loads the entry as an ES module. Node decides that from the extension and the nearest
  // package.json (Node 18 and 20 treat a plain .js file as CommonJS), so load a copy named .mjs.
  // Stack traces name that copy; its line numbers are the entry's.
  const scratch = mkdtempSync(join(tmpdir(), "kino-plugin-"));
  try {
    const copy = join(scratch, "plugin.mjs");
    writeFileSync(copy, readFileSync(entryPath));
    const plugin = await import(pathToFileURL(copy).href);
    if (typeof plugin[fn] !== "function") return fail(`${manifest.entry} does not export ${fn}()`);
    resetBudget();
    const out = await call(plugin, fn, rest, opts);
    saveTape();
    if (SETTINGS_FUNCTIONS.includes(fn) && !opts.raw) {
      // What the app keeps of the answer (status lines, the action's line, the save's verdict).
      process.stdout.write(JSON.stringify(checkSettingsOutput(fn, out, manifest, undefined, (d) => stderr(`[dropped by Kino] ${d}`)), null, 2) + "\n");
      return 0;
    }
    // A scoped search's null: "I can't search inside this page", and Kino filters the page's titles itself.
    if (opts.within !== null && out === null) {
      process.stdout.write("null\n");
      stderr("null: Kino filtra él mismo los títulos ya cargados de esa página (nivel 1)");
      return 0;
    }
    if (opts.raw) {
      process.stdout.write(JSON.stringify(out === undefined ? null : out, null, 2) + "\n");
      return 0;
    }
    let checked;
    try {
      checked = checkOutput(fn, out, manifest, servers, { liveChannel: fn === "resolve" && opts.live, migrateInput: fn === "migrate" ? JSON.parse(rest[0] || "null") : null });
    } catch (e) {
      // Refused only by host, and a live channel's ref would pass: say how to check it as one.
      if (fn === "resolve" && !opts.live && manifest.liveStreamHostsAny) {
        try { checkOutput(fn, out, manifest, servers, { liveChannel: true }); stderr("si este ref es de un canal en vivo, prueba con --live"); } catch { /* refused either way */ }
      }
      throw e;
    }
    let { value, drops } = checked;
    drops.forEach((d) => stderr(`[dropped by Kino] ${d}`));
    // A search hit names no listing: Kino decides its 18+ mark from its own marks and your categories.
    if (fn === "liveSearch") {
      const marked = await markLiveSearch(plugin, value, manifest, servers);
      value = marked.value;
      const note = unmarkedSearchNote(marked);
      if (note) stderr(`aviso: ${note}`);
    }
    adultLines(value).forEach((l) => stderr(l));
    const noSign = fn === "resolve" ? signExportProblem(value, plugin) : null;
    if (noSign) { stderr(`✗ ${noSign}`); return 1; }
    process.stdout.write(JSON.stringify(value, null, 2) + "\n");
    if (fn === "resolve") copyLines(value).forEach((l) => stderr(l));
    // Playing a listed channel: its ref goes to resolve() as a live channel's.
    if (fn === "liveChannels" || fn === "liveSearch") {
      const r = await resolveFirstLiveRef(plugin, value, manifest, servers);
      if (r) stderr(r.error ? `resolve(${r.ref}) ✗ ${r.error}` : `resolve(${r.ref}) → ${r.url}`);
      if (r && r.error) return 1;
    }
    // The app downloads each declared playlist itself: do the same, and say what it would show.
    let failed = false;
    for (const p of fn === "liveCategories" ? value.playlists : []) {
      try {
        const s = await loadPlaylist(p, { manifest, servers });
        stderr(`playlist ${p.url}:`);
        summaryLines(s).forEach((l) => stderr(`  ${l}`));
        s.categories.forEach((c) => stderr(`  categoría ${c.title} (${c.count})`));
        if (s.channels === 0) { failed = true; stderr("  ✗ 0 canales: Kino would show nothing from this list"); }
      } catch (e) {
        failed = true;
        stderr(`playlist ${p.url}: ✗ not downloaded: ${e.message}`);
      }
    }
    return failed ? 1 : 0;
  } catch (e) {
    saveTape();
    stderr(e && e.code ? errorReport(e, manifest.name) : e && e.stack ? e.stack : String(e));
    return 1;
  } finally {
    rmSync(scratch, { recursive: true, force: true });
  }
}

/**
 * The copies of a checked `resolve` answer as the player's "Servidor" menu lists them (label, or "Opción N"), each with
 * its host or, for a lazy one, the command that resolves it. Nothing for a Stream with one copy.
 */
export function copyLines(stream) {
  const alts = (stream && Array.isArray(stream.alternatives)) ? stream.alternatives : [];
  if (!alts.length) return [];
  const name = (c, i) => (c.label || `Opción ${i + 1}`);
  const host = (u) => { try { return new URL(u).hostname; } catch { return "?"; } };
  const lines = [`copias (${alts.length + 1}), como las muestra el menú Servidor:`];
  lines.push(`  1. ${name(stream, 0)} — ${host(stream.url)}`);
  alts.forEach((a, i) => lines.push(a.ref !== undefined
    ? `  ${i + 2}. ${name(a, i + 1)} — se resuelve al elegirla: resolve ${JSON.stringify(a.ref)}`
    : `  ${i + 2}. ${name(a, i + 1)} — ${host(a.url)}`));
  return lines;
}

/**
 * The first listed channel that plays through a ref (no inline stream), resolved and checked the way
 * the app plays a channel: `{ ref, url }`, `{ ref, error }`, or null when there is none to try.
 */
export async function resolveFirstLiveRef(plugin, page, manifest, servers) {
  const c = (page.items || []).find((x) => x.ref && !x.stream);
  if (!c || typeof plugin.resolve !== "function") return null;
  try {
    const { value } = checkOutput("resolve", await plugin.resolve(c.ref), manifest, servers, { liveChannel: true });
    return { ref: c.ref, url: value.url };
  } catch (e) {
    return { ref: c.ref, error: e && e.code ? `[${e.code}] ${e.message}` : String(e && e.message ? e.message : e) };
  }
}

/** Reads a local file, or downloads an http(s) URL; past `maxBytes` only the start is kept, as the app does. `{ bytes, cut }`. */
async function readSource(src, maxBytes) {
  if (!/^https?:\/\//i.test(src)) return keepStart(readFileSync(src), maxBytes);
  let cut = false;
  const bytes = await download(src, { maxBytes, cut: true, onCut: () => { cut = true; } });
  return { bytes, cut };
}

/** `live playlist`: any M3U list (and, with --epg, its guide) read exactly as Kino would. */
async function livePlaylist(src, epg) {
  try {
    const list = await readSource(src, contract.live.maxPlaylistBytes);
    const s = { ...summarisePlaylist(list.bytes), cut: list.cut };
    const guide = epg ? guideFor(s, (await readSource(epg, contract.live.maxEpgBytes)).bytes) : null;
    if (guide && guide.truncated) stderr("[guide] cut short (byte cap, a cut download or a broken tail): what was read is kept");
    const refusal = guide && guide.refused ? ["La guía declara un DOCTYPE; Kino la rechaza por seguridad"] : [];
    process.stdout.write([...summaryLines(s), ...refusal, ...s.categories.map((c) => `categoría ${c.title} (${c.count})`), "", ...channelLines(s, { guide })].join("\n") + "\n");
    return s.channels ? 0 : 1;
  } catch (e) {
    return fail(`${src}: ${e.message}`);
  }
}

/**
 * `subtitles()`'s argument as the app's PluginSubtitleSource builds it: `{ imdbId?, tmdbId?, kind, season?, episode?, title?,
 * year?, languages }`. [rest]: `tt…` or `tmdb:<id>` (then season and episode for an episode), or the whole object as JSON.
 */
export function subtitlesArg(rest) {
  const arg = String(rest[0] === undefined ? "" : rest[0]).trim();
  const languages = (process.env.KINO_LANGS || "es,en").split(",").map((l) => l.trim().toLowerCase()).filter(Boolean);
  if (arg.startsWith("{")) {
    try { return { languages, ...JSON.parse(arg) }; }
    catch (e) { throw new Error(`the subtitles argument starts with { but is not valid JSON: ${e.message}`); }
  }
  const season = Number(rest[1]), episode = Number(rest[2]);
  const out = { kind: season > 0 && episode > 0 ? "series" : "movie", languages };
  if (/^tt\d{5,10}$/.test(arg)) out.imdbId = arg;
  else if (/^tmdb:\d+$/.test(arg)) out.tmdbId = Number(arg.slice(5));
  else throw new Error("subtitles needs an IMDb id (tt…), tmdb:<id> or a JSON object");
  if (out.kind === "series") { out.season = season; out.episode = episode; }
  return out;
}

/** The argument each function gets, exactly as the app builds it. */
export async function call(plugin, fn, rest, opts = {}) {
  const arg = rest[0] === undefined ? "" : rest[0];
  if (fn === "sign") return plugin.sign(JSON.parse(arg));
  if (fn === "resolve" && opts.retry) return plugin.resolve(arg, { retry: opts.retry });
  if (fn === "section") return plugin.section({ tab: arg === "" ? null : arg });
  if (fn === "categories") return plugin.categories(null);
  if (fn === "home") return plugin.home(null);
  if (fn === "browse") return plugin.browse(arg, rest[1] === undefined ? null : rest[1]);
  // apiVersion 3's channels: the same arguments the app's PluginLiveProvider sends.
  if (fn === "liveCategories") return plugin.liveCategories(null);
  if (fn === "liveChannels") return plugin.liveChannels({ categoryId: arg, cursor: rest[1] === undefined ? null : rest[1] });
  if (fn === "liveSearch") return plugin.liveSearch({ query: arg.trim() });
  if (fn === "subtitles") return plugin.subtitles(subtitlesArg(rest));
  if (fn === "guide") {
    const from = Date.now() - 2 * 3600 * 1000;
    return plugin.guide({ channelIds: arg ? arg.split(",") : [], from, to: from + contract.live.maxGuideWindowMs });
  }
  if (fn === "migrate") return plugin.migrate(JSON.parse(arg || "null"));
  if (fn === "settingsStatus") return plugin.settingsStatus(null);
  if (fn === "action") return plugin.action(arg);
  if (fn === "validateSettings") {
    try { return plugin.validateSettings(arg ? JSON.parse(arg) : {}); }
    catch (e) { throw new Error(`the validateSettings argument must be a JSON object of setting values: ${e.message}`); }
  }
  if (fn !== "search") return plugin[fn](arg);
  const query = { q: "", type: process.env.KINO_TYPE || "any", season: 0, episode: 0, tmdbId: 0, year: 0, originalTitle: "", altTitles: [], cursor: null };
  // Kino's scoped search (apiVersion 6): always type "any", the "Ver más" page's ref as `within`.
  if (opts.within) Object.assign(query, { type: "any", [contract.search.scoped.field]: opts.within });
  if (arg.trimStart().startsWith("{")) {
    try { Object.assign(query, JSON.parse(arg)); }
    catch (e) { throw new Error(`the search argument starts with { but is not valid JSON: ${e.message}`); }
  } else {
    query.q = arg;
  }
  return plugin.search(query);
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  process.exitCode = await main();
}
