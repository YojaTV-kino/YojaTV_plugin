#!/usr/bin/env node
// Checks a plugin the way Kino does, without installing it:
//   node sdk/validate.mjs <plugin folder>
//     the manifest (every rule in contract.json, the app's own Spanish messages), the entry file,
//     and that every declared capability is an exported function (the app refuses the install
//     otherwise).
//   node sdk/validate.mjs <plugin folder> --run <function> [argument] [cursor] [--config k=v] [--replay file]
//   A signed plugin (apiVersion 5's signature): the signature is checked against the entry file for
//   `--repo owner/repo[/path]`, by default the folder's GitHub origin; an author key (*.pem) tracked
//   by git is refused.
//     also runs one function and reports every entry the app would drop, and why. With
//     `--run liveCategories`, each declared playlist is downloaded and parsed as the app would.
// It also prints the consent sheet's extra lines, the red ones marked, as the person will read them.
// Exit code 0 = Kino would accept it; 1 = it wouldn't (the reasons are on stderr).
import { spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { checkOutput, contract, kb, requiredExports, validateManifest } from "./contract.mjs";
import { resolvePalette } from "./palette.mjs";
import { decodeCipherKey } from "./seal.mjs";
import { createKino, signingLane } from "./kino-shim.mjs";
import { call, markLiveSearch, parseArgs, resolveFirstLiveRef, signExportProblem, unmarkedSearchNote } from "./run.mjs";
import { loadPlaylist } from "./live-playlist.mjs";
import { fingerprint, normalizeBinding, verifyEntry } from "./seal.mjs";

// Every return carries { ok, problems, drops, output, consent, notes } — even the early ones, before
// a `kino` even exists — so a caller (this file's own CLI included) never has to guess which fields
// are present.
const refused = (problems) => ({ ok: false, problems, drops: [], output: null, consent: [], notes: [] });

/** The note for a plugin that declares scopedSearch while its entry never reads `query.within`. */
/** A plugin that uses apiVersion 6's key pairs but declares an older apiVersion: an older Kino installs it and the call fails there. */
export const KEY_PAIRS_OLD_API = `Usa kino.crypto.generateKeyPair/sign/verify/importKey/deriveSharedSecret, que llegaron con apiVersion ${contract.crypto.keyPairs.apiVersion}: declara "apiVersion": ${contract.crypto.keyPairs.apiVersion} para que un Kino anterior no lo instale y falle al llamarlas`;
export const SCOPED_IGNORED = 'Declara "scopedSearch" pero search() no lee query.within: Kino le pide buscar dentro de una página "Ver más" y recibiría la búsqueda completa (responde null si no puede buscar en esa página)';

/**
 * The consent sheet's lines beyond the host list, as the app's PluginConsent.extraLines builds them
 * for a first install. `danger` lines are drawn in red.
 */
export function consentLines(m, { authorFingerprint = null } = {}) {
  const out = [];
  const line = (text, danger = false) => out.push({ text, danger });
  (m.permissions || []).forEach((p) => line(`Permiso: ${p}`));
  if ((m.settings || []).some((s) => s.type === "password")) line("Este plugin usa tu usuario y contraseña");
  if ((m.settings || []).some((s) => s.type === "url")) line("Se conectará a los servidores que escribas en su configuración");
  if (m.capabilities.includes("download")) line("Puede descargar videos para verlos sin conexión");
  if (m.capabilities.includes("drm")) line("Reproduce video protegido (DRM)");
  if (m.capabilities.includes("channels")) line("Agrega canales en vivo a la pestaña En vivo");
  if (m.capabilities.includes("migrate")) line("Revisar lo que tienes guardado (biblioteca, historial, favoritos) para pasarlo a este plugin");
  if (m.capabilities.includes("subtitles")) line("Agrega subtítulos a tus películas y series");
  if (m.secrets && Object.keys(m.secrets).length) line("Usa datos sellados por su autor");
  if (m.telemetry) line(m.telemetry === contract.manifest.telemetry.verbose.value ? contract.manifest.telemetry.verbose.consentLine : contract.manifest.telemetry.consentLine);
  if (authorFingerprint) line(contract.manifest.signature.consentLine);
  (m.insecureHosts || []).forEach((h) => line(`Conexión sin cifrar con ${h}`, true));
  if (m.liveStreamHostsAny) line("Puede reproducir canales desde cualquier servidor que indique su lista", true);
  // apiVersion 6 "browser": true (kino.browser.capture): the same red line as the app's PluginConsent.BROWSER_LINE;
  // "browser": "pages" also reads pages (kino.browser.page): PluginConsent.BROWSER_PAGE_LINE (manifest.browser.pageConsentLine).
  if (m.browser) line(m.browserPages ? contract.manifest.browser.pageConsentLine : contract.manifest.browser.consentLine, true);
  if (m.streamHostsAny) {
    const onlySubtitles = m.capabilities.length === 1 && m.capabilities[0] === "subtitles";
    line(onlySubtitles ? "Puede traer subtítulos desde cualquier servidor que indique"
      : m.capabilities.includes("subtitles") ? "Puede reproducir video y traer subtítulos desde cualquier servidor que indique"
      : "Puede reproducir video desde cualquier servidor que indique", true);
  }
  return out;
}

/** Files of [dir]'s git repository, among [paths], that git tracks (none when [dir] is not in a repository). */
function trackedByGit(dir, paths) {
  const r = spawnSync("git", ["ls-files", "--", ...paths], { cwd: dir, encoding: "utf8" });
  return r.status === 0 ? r.stdout.split("\n").filter(Boolean) : [];
}

/** `owner/repo[/folder]` from [dir]'s git origin on GitHub, or null. */
export function bindingFromGit(dir) {
  const git = (...a) => spawnSync("git", a, { cwd: dir, encoding: "utf8" });
  const origin = git("remote", "get-url", "origin");
  if (origin.status !== 0) return null;
  const match = origin.stdout.trim().match(/github\.com[/:]([^/]+)\/([^/]+?)(\.git)?\/?$/i);
  if (!match) return null;
  const prefix = git("rev-parse", "--show-prefix");
  const folder = prefix.status === 0 ? prefix.stdout.trim().replace(/\/+$/, "") : "";
  try {
    return normalizeBinding([match[1], match[2], folder].filter(Boolean).join("/"));
  } catch {
    return null;
  }
}

export async function validate(dirArg, { run = null, args = [], config = {}, replay = null, fetchImpl = globalThis.fetch, repo = null } = {}) {
  const problems = [];
  const dir = resolve(dirArg);
  const manifestFile = join(dir, "kino-plugin.json");
  if (!existsSync(manifestFile)) return refused([`no kino-plugin.json in ${dir}`]);
  const manifestText = readFileSync(manifestFile, "utf8");
  const checked = validateManifest(manifestText);
  if (!checked.ok) return refused([`kino-plugin.json: ${checked.field}: ${checked.message}`]);
  const m = checked.manifest;
  const notes = [];
  let authorFingerprint = null;
  if (!m.discoverable) notes.push("No aparecerá en la búsqueda de Kino");
  if (m.debug) notes.push('Modo debug activo ("debug": true): úsalo mientras desarrollas y quítalo antes de publicar el plugin');
  if (m.theme && Object.keys(m.theme).length) for (const w of resolvePalette(m.theme).warnings) notes.push(w);
  // Accepted from Kino 0.9.45 on; older apps still refuse the install, so the author is told. They
  // counted the raw entries (duplicates too), so this does as well.
  const legacy = contract.manifest.legacyMaxHosts;
  if (JSON.parse(manifestText).hosts.length > legacy.value) {
    notes.push(`Más de ${legacy.value} hosts: Kino ${legacy.refusedUpToApp} o anterior rechaza este plugin; necesita Kino ${legacy.noLimitFromApp} o superior`);
  }
  // The app honors fetchHosts only on a plugin it converted from a Nuvio scraper (never on one written by hand).
  if (m.browser) {
    notes.push(m.browserPages
      ? "kino.browser.capture y kino.browser.page solo funcionan en la app (un WebView oculto); aquí responden browser_unavailable, así que prueba en un aparato. Kino nunca resuelve captchas: una página que pide confirmar que eres humano responde blocked"
      : "kino.browser.capture solo funciona en la app (un WebView oculto); aquí responde browser_unavailable, así que prueba resolve en un aparato. Para leer páginas con kino.browser.page declara \"browser\": \"pages\"");
  }
  if (m.fetchHostsAny) notes.push("fetchHosts solo tiene efecto en plugins convertidos desde Nuvio; en tu plugin se ignora");
  if (m.secrets && Object.keys(m.secrets).length) {
    notes.push("No se puede comprobar aquí para qué repositorio se sellaron los secretos: Kino lo comprueba al instalar. Además, solo se abren si la persona instala el plugin desde su rama principal, sin @rama. Y desde una URL del manifest (kino-plugin.json fuera de GitHub) Kino rechaza el plugin: los sellos son de un repositorio.");
  }
  const sg = contract.manifest.signature;
  if (m.apiVersion === sg.apiVersion) {
    notes.push(`apiVersion ${m.apiVersion}: requiere Kino ${sg.fromApp} o superior; las versiones anteriores lo rechazan con «Este plugin necesita una versión más nueva de Kino»`);
  } else if (m.apiVersion > sg.apiVersion) {
    // Above the signed entry's version: the Kino release each one first ships in (contract.json apiVersionFromApp).
    const fromApp = contract.apiVersionFromApp[String(m.apiVersion)];
    notes.push(`apiVersion ${m.apiVersion}: requiere Kino ${fromApp} o superior; las versiones anteriores lo rechazan con «Este plugin necesita una versión más nueva de Kino»`);
  }
  const entry = join(dir, m.entry);
  if (!existsSync(entry)) return { ...refused([`entry ${m.entry} not found`]), consent: consentLines(m), notes };
  // scopedSearch (apiVersion 6): Kino calls search() with `within`, the "Ver más" page's browse ref. An entry that never
  // names `within` answers the whole catalog's search there. A warning only: a plugin may read it some other way.
  if (m.capabilities.includes(contract.search.scoped.capability) && !new RegExp(`\\b${contract.search.scoped.field}\\b`).test(readFileSync(entry, "utf8"))) {
    notes.push(SCOPED_IGNORED);
  }
  if (m.apiVersion < contract.crypto.keyPairs.apiVersion && /\b(generateKeyPair|importKey|deriveSharedSecret)\b|crypto\s*\.\s*(sign|verify)\b/.test(readFileSync(entry, "utf8"))) {
    notes.push(KEY_PAIRS_OLD_API);
  }
  if (statSync(entry).size > contract.manifest.entryMaxBytes) problems.push(`${m.entry} is bigger than ${kb(contract.manifest.entryMaxBytes)}: Kino refuses it`);
  if (m.signature) {
    authorFingerprint = fingerprint(Buffer.from(m.signature.authorKey, "hex"));
    notes.push(`${sg.authorKeyLabel}: ${authorFingerprint} (Kino la muestra en los detalles del plugin, no en la ventana de instalación)`);
    // The signature is bound to owner/repo: a plugin installed from its kino-plugin.json URL elsewhere is unsigned.
    notes.push("La firma solo vale si se instala desde el repositorio de GitHub: desde una URL del manifest (kino-plugin.json fuera de GitHub) el plugin se instala sin firma.");
    // The author key committed by mistake: anyone could then sign "updates" Kino accepts.
    trackedByGit(dir, ["*.pem"]).forEach((f) => problems.push(`${f} is tracked by git: anyone can read your author key on GitHub. Remove it (git rm --cached ${f}), add it to .gitignore, and since it leaked, make a new key (everyone must reinstall)`));
    let binding = null;
    try { binding = repo ? normalizeBinding(repo) : bindingFromGit(dir); } catch (e) { problems.push(e.message); }
    if (!binding) {
      notes.push("No sé desde qué repositorio se instalará (usa --repo owner/repo[/carpeta]): la firma no se comprobó aquí; Kino la comprueba al instalar.");
    } else if (!verifyEntry(m.signature, readFileSync(entry), binding, m.id, m.version)) {
      problems.push(`signature: ${sg.badSignatureMessage} (for ${binding}). Sign again: node sdk/seal.mjs --sign --repo ${binding}`);
    }
  }
  const consent = consentLines(m, { authorFingerprint });
  if (m.icon && existsSync(join(dir, m.icon)) && statSync(join(dir, m.icon)).size > contract.manifest.iconMaxBytes) problems.push(`${m.icon} is bigger than ${kb(contract.manifest.iconMaxBytes)}: Kino skips it`);
  // A typed cipher key's local stand-in must be a real key: the app refuses the install otherwise.
  const secretsFile = join(dir, ".kino-secrets.json");
  if (Object.keys(m.secretKeyEncodings || {}).length && existsSync(secretsFile)) {
    let local = {};
    try { local = JSON.parse(readFileSync(secretsFile, "utf8")) || {}; } catch { /* run.mjs reports an unreadable stand-in */ }
    for (const [n, enc] of Object.entries(m.secretKeyEncodings)) {
      if (Object.prototype.hasOwnProperty.call(local, n) && !decodeCipherKey(String(local[n]), enc)) {
        problems.push(`secret "${n}" in .kino-secrets.json is not a 16, 24 or 32-byte key in ${enc}`);
      }
    }
  }
  const scratch = mkdtempSync(join(tmpdir(), "kino-validate-"));
  const drops = [];
  let output = null;
  try {
    // Inside the try too: an invalid --replay path (or any other setup failure) must become a
    // problem, not an uncaught rejection.
    // The same local stand-in run.mjs reads: a plugin with `secrets` gets its plain values from it.
    const { kino, servers } = createKino(m, { config, replay: replay && resolve(replay), fetchImpl, secretsFile: join(dir, ".kino-secrets.json") });
    // sign() runs in the signing lane, as in run.mjs and the app: no network, storage, cookies or sleep.
    globalThis.kino = run === "sign" ? signingLane(kino) : kino;
    const copy = join(scratch, "plugin.mjs");
    writeFileSync(copy, readFileSync(entry));
    const plugin = await import(pathToFileURL(copy).href);
    // download/drm export nothing; channels exports liveCategories + liveChannels (guide optional).
    const missing = requiredExports(m.capabilities, m.settings, m).filter((f) => typeof plugin[f] !== "function");
    if (missing.length) problems.push(`the plugin doesn't export ${missing.join(", ")}: Kino refuses the install ("le falta ${missing.sort().join(", ")}")`);
    if (run && !problems.length) {
      // A capability's exports are runnable too: channels runs liveCategories, liveChannels and guide.
      // Any plugin may export `subtitles` without the capability (contract.capabilities.anyPluginExports).
      const runnable = new Set([...m.capabilities, ...contract.capabilities.anyPluginExports, ...m.capabilities.flatMap((c) => [...(contract.capabilities.exports[c] || []), ...(contract.capabilities.optionalExports[c] || [])])]);
      if (!runnable.has(run)) problems.push(`"${run}" isn't in the manifest's capabilities`);
      else {
        const checkedOut = checkOutput(run, await call(plugin, run, args), m, servers, { migrateInput: run === "migrate" ? JSON.parse(args[0] || "null") : null });
        output = checkedOut.value;
        drops.push(...checkedOut.drops);
        const noSign = run === "resolve" ? signExportProblem(output, plugin) : null;
        if (noSign) problems.push(noSign);
        // A search hit is 18+ by its own marks and the plugin's categories (as in the app): unmarked ones get a warning.
        if (run === "liveSearch") {
          const marked = await markLiveSearch(plugin, output, m, servers);
          output = marked.value;
          const note = unmarkedSearchNote(marked);
          if (note) notes.push(note);
        }
        // A lazy copy's ref goes to resolve() when the person or the fallback needs it: follow the first, as the app would.
        const lazy = run === "resolve" && Array.isArray(output.alternatives) ? output.alternatives.find((a) => a.ref !== undefined) : undefined;
        if (lazy) {
          try {
            const copy = checkOutput("resolve", await call(plugin, "resolve", [lazy.ref]), m, servers);
            if (copy.value.alternatives) notes.push(`resolve(${JSON.stringify(lazy.ref)}): its own alternatives are ignored for a lazy copy (no recursion)`);
          } catch (e) {
            problems.push(`resolve(${JSON.stringify(lazy.ref)}) (a lazy copy): ${e.message}`);
          }
        }
        // Playing a listed channel sends its ref to resolve() as a live channel's: follow the first.
        if (run === "liveChannels") {
          const r = await resolveFirstLiveRef(plugin, output, m, servers);
          if (r && r.error) problems.push(`resolve(${r.ref}) ${r.error}`);
        }
        // The app downloads and parses each declared playlist itself: one that fails or comes out
        // empty would show nothing.
        for (const p of run === "liveCategories" ? output.playlists : []) {
          try {
            const s = await loadPlaylist(p, { manifest: m, servers, fetchImpl });
            if (s.channels === 0) problems.push(`playlist ${p.url}: 0 canales (${s.skipped} entradas descartadas, ${s.hidden} ocultas)`);
            if (s.skipped) drops.push(`playlist ${p.url}: ${s.skipped} entradas descartadas`);
            if (s.cut) drops.push(`playlist ${p.url}: pasa de ${Math.round(contract.live.maxPlaylistBytes / (1024 * 1024))} MB, Kino lee solo su comienzo`);
          } catch (e) {
            problems.push(`playlist ${p.url}: not downloaded: ${e.message}`);
          }
        }
      }
    }
  } catch (e) {
    problems.push(e && e.code ? `[${e.code}] ${e.message}` : String(e && e.message ? e.message : e));
  } finally {
    rmSync(scratch, { recursive: true, force: true });
  }
  return { ok: problems.length === 0, problems, drops, output, consent, notes };
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  // --repo is validate's own (run.mjs's parser doesn't know it): taken out before the rest is read.
  const argv = process.argv.slice(2);
  const repoAt = argv.indexOf("--repo");
  const repo = repoAt === -1 ? null : argv.splice(repoAt, 2)[1];
  const { opts, rest } = parseArgs(argv);
  const runAt = rest.indexOf("--run");
  const dir = rest[0];
  if (!dir) {
    console.error("usage: node sdk/validate.mjs <plugin folder> [--run <function> [argument] [cursor]] [--config k=v] [--replay file] [--repo owner/repo[/path]]");
    process.exitCode = 2;
  } else {
    const result = await validate(dir, {
      run: runAt === -1 ? null : rest[runAt + 1],
      args: runAt === -1 ? [] : rest.slice(runAt + 2),
      config: opts.config,
      replay: opts.replay,
      repo,
    });
    if (result.consent.length) {
      // Red on a terminal, as on the consent sheet; "(en rojo)" either way so a log keeps it.
      const red = process.stderr.isTTY ? (t) => `\x1b[31m${t}\x1b[0m` : (t) => t;
      console.error("Consent sheet:");
      result.consent.forEach((c) => console.error(c.danger ? red(`  ! ${c.text} (en rojo)`) : `  · ${c.text}`));
    }
    result.drops.forEach((d) => console.error(`[dropped by Kino] ${d}`));
    result.problems.forEach((p) => console.error(`✗ ${p}`));
    result.notes.forEach((n) => console.error(`· ${n}`));
    if (result.ok) console.error("✓ Kino would accept this plugin" + (result.drops.length ? ` (${result.drops.length} entries dropped, see above)` : ""));
    process.exitCode = result.ok ? 0 : 1;
  }
}
