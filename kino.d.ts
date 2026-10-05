// TypeScript declarations for Kino plugins (apiVersion 1 to 6; apiVersion 5 only adds the manifest's signature, 6 the plain-plugin SDK: typed and larger secrets, migrate, signed streams, the settings form, debug, telemetry, section, categories, theme and scopedSearch). Reference them from plugin.js
// with `/// <reference path="./kino.d.ts" />` for editor help; Kino itself runs plain JavaScript.
// The numbers in the comments come from contract.json, which is authoritative. The app checks that
// every `kino` member declared here exists in its runtime and nothing else does (KinoDtsTest).

// ---------- what your functions receive and return ----------

/** `search(query)`: `type` is a hint, never a filter. `cursor` is null on the first page. */
interface KinoSearchQuery {
  q: string;
  type: "movie" | "series" | "any";
  year: number;
  season: number;
  episode: number;
  tmdbId: number;
  /** TMDB's original title when it differs from `q`, else "". */
  originalTitle: string;
  /** Other known titles, at most 5, each at most 200 characters. */
  altTitles: string[];
  cursor: string | null;
  /**
   * apiVersion 6, capability "scopedSearch": the browse `ref` of the "Ver más" page the person searches inside (a Home
   * row, a section row, a category), exactly as you gave it; absent on a plain search. Return null when you cannot
   * search there: Kino then filters the page's loaded titles itself.
   */
  within?: string;
}

interface KinoItem {
  /** ^[A-Za-z0-9._~-]{1,128}$, stable: the library keys the title by it. */
  id: string;
  /** Your own opaque reference, at most 4096 characters. */
  ref: string;
  title: string;
  /**
   * `"live"` needs `"apiVersion": 2` (a v1 plugin's live item is dropped): a live channel, whose
   * `ref` goes to `resolve` and plays as live straight from its card, with an "EN VIVO" badge; it
   * has no `runtimeMinutes` (ignored) and no episodes, is never saved to the library, never resumed
   * and never downloaded.
   */
  kind: "movie" | "series" | "live";
  year?: string | number;
  /** https, at most 2048 characters; never an IP or a local name (except the person's own server). */
  poster?: string;
  backdrop?: string;
  overview?: string;
  originalTitle?: string;
  /** At most 5, each at most 30 characters. */
  genres?: string[];
  /** 0..10 */
  rating?: number;
  /** 1..1000; ignored on a `live` item. */
  runtimeMinutes?: number;
  ids?: { tmdb?: number; /** ^tt\d{5,10}$ */ imdb?: string };
  lang?: string;
  quality?: string;
  /** At most 3, each at most 20 characters; shown as chips. */
  badges?: string[];
  /** apiVersion 6: true = an 18+ entry, shown only while the person's 18+ code is unlocked on that device (Ajustes ▸ Adultos). Below apiVersion 6 it is dropped. */
  adult?: boolean;
}

/** A Home row. `ref` needs the `browse` capability: the row gets "Ver más", which calls browse(ref, null). */
type KinoGenre =
  | "peliculas" | "series" | "anime" | "infantil" | "documentales"
  | "deportes" | "noticias" | "musica" | "entretenimiento" | "otros";

interface KinoRow {
  id: string;
  title: string;
  /**
   * Items of kind "live" (channels) stay in a Home row from apiVersion 6, as channel cards with the "En vivo" badge
   * that open like a channel from En vivo (a 18+ one only while the person's code is unlocked); below 6 they are
   * dropped from Home. A row left with nothing to show is not shown.
   */
  items: KinoItem[];
  ref?: string;
  /**
   * What the row (or category, or list) is about, from Kino's closed vocabulary: "peliculas", "series", "anime",
   * "infantil", "documentales", "deportes", "noticias", "musica", "entretenimiento" or "otros". Kino groups Categorías
   * by it and filters En vivo by it across plugins. Optional: without it Kino guesses from the title; a value outside
   * the list is ignored. Kino versions before this field ignore it.
   */
  genre?: KinoGenre;
}

/** `next` (at most 2048 characters, opaque) needs the `browse` capability; the app passes it back as the cursor. */
interface KinoPage {
  items: KinoItem[];
  next?: string;
}

interface KinoEpisode {
  /** 1..999, default 1. */
  season?: number;
  /** 1..99999 */
  number: number;
  ref: string;
  title?: string;
  still?: string;
  overview?: string;
  /** YYYY-MM-DD */
  airDate?: string;
  runtimeMinutes?: number;
}

interface KinoSeriesInfo {
  title?: string;
  poster?: string;
  backdrop?: string;
  overview?: string;
  ids?: { tmdb?: number; imdb?: string };
  genres?: string[];
  year?: string | number;
}

/**
 * One season of a series, for a source that keeps each season as its own `series` item: that item's
 * `id` and `ref` (`episodes(ref)` lists it). `title` is what the season selector shows ("Temporada 2");
 * `current` marks the season whose episodes came in the same answer (Kino also recognizes it by `id`).
 */
interface KinoSeason {
  /** The season's own item id, same pattern as an item id. */
  id: string;
  /** The season's own series ref, at most 4096 characters. */
  ref: string;
  title: string;
  /** 1..999; leave it out when the source has no numbering. */
  number?: number;
  current?: boolean;
}

interface KinoEpisodes {
  series?: KinoSeriesInfo;
  episodes: KinoEpisode[];
  /**
   * Only when each season is a separate item: every season of the show, this one included, at most
   * 50. Leave it out when `episodes` already holds every season (Kino reads the seasons from them).
   */
  seasons?: KinoSeason[];
}

interface KinoStream {
  /**
   * https on a declared host (http only on one declared `insecureHttp`), or the person's own server exactly as typed.
   * A live channel's stream of a plugin approved for `"liveStreamHosts": "any"` may be on any public host, http or https.
   */
  url: string;
  mime?: string;
  /**
   * Sent with every request the player makes for this stream (and, for a plugin that declares the
   * `download` capability, with the request that saves it to the device). At most 20.
   */
  headers?: Record<string, string>;
  subtitles?: { lang: string; url: string; format?: "vtt" | "srt" }[];
  /**
   * Separately-hosted audio tracks (a dub, an alternate mix), at most 8: Kino plays your video with
   * each merged in as its own track, offered and auto-picked by the person's audio-language
   * preference exactly like the container's own. `lang` is a short code like `subtitles`' (up to 16
   * characters; blank becomes `"und"`); `label`, if given (up to 40 characters), is shown verbatim
   * instead of a name guessed from `lang`. Checked the same way as `subtitles`: https on a declared
   * host, or the person's own server exactly as typed; a bad entry is dropped and the rest survive,
   * and so is a `url` already listed (the first entry wins). Ignored for a `live` item's stream: a
   * channel's other languages go inside its manifest.
   */
  audioTracks?: { lang: string; url: string; label?: string }[];
  /** Ignored for a `live` item's stream: a channel has no length. */
  durationMs?: number;
  /** 30..86400: after that long, a failed playback calls resolve() once more. */
  expiresInSeconds?: number;
  /**
   * apiVersion 2, and only with the `drm` capability declared: the stream is Widevine-protected and
   * Kino fetches its license from `licenseUrl` (checked exactly like `url`: https on a declared host, http only on one declared `insecureHttp`)
   * sending `licenseHeaders` (filtered like `headers`, at most 20) with the license request only.
   * Without the capability any DRM-shaped key refuses the stream. A protected title never downloads.
   * Kino negotiates Widevine at security level L3 (software), and only when the device confirms L3:
   * the license server must allow it. `audioTracks` next to `drm` are played clear (no license for
   * them): plain, unencrypted files only.
   */
  drm?: { type: "widevine"; licenseUrl: string; licenseHeaders?: Record<string, string> };
  /**
   * apiVersion 6: `"request"` makes Kino sign every playlist and segment request of this stream with your
   * `sign()` export, right before sending it, through a local proxy. HLS only (an HLS `mime` or a `.m3u8`
   * path); never with `drm` or `audioTracks`; not on an inline `liveChannels` stream (use `resolve()`).
   */
  signing?: "request";
  /**
   * apiVersion 6, with `signing`: up to 4096 characters `sign()` gets back as `context` (it can't read kino.storage).
   * Never a `kino.secret()` marker (refused): a marker only works in the runtime that made it, so call
   * `kino.secret()` inside `sign()` itself.
   */
  signContext?: string;
  /**
   * apiVersion 6, with `signing`: other hosts serving this same stream at the same path and scheme, up
   * to 6, each `"host"` or `"host:port"` (no scheme, no path, no IPv6). Kino tries the playlist on each
   * (3 rounds, the one that served last first) and moves a segment, key or map to another one when its
   * own fails 3 times. `sign()` always gets the URL of the host being asked, so pick that host's token
   * from `context`. Each entry meets the same host rule as `url` (declared hosts, or any public host
   * under `liveStreamHosts: "any"`); one that fails it, repeats `url`'s host or another entry, or comes
   * after the sixth is dropped. Not an array of strings: the stream is refused. Ignored without `signing`.
   */
  alternateHosts?: string[];
  /**
   * apiVersion 6: this copy's short name, e.g. "Latino · Streamwish", shown in the player's "Servidor" menu (phone and
   * TV) and in logs. Trimmed; at most 48 characters, no control characters, or it is dropped (the copy still plays).
   * Ignored below apiVersion 6.
   */
  label?: string;
  /**
   * Other copies of the same video, best first, at most 8: when `url` cannot play on the device (a codec it lacks, a broken
   * file) or is gone, Kino moves on to the next one by itself, at the same spot, before showing any error. Each is checked
   * exactly like `url`, `mime` and `headers`; a bad entry is dropped. They share this stream's subtitles and audio tracks.
   * Ignored next to `drm`, with `signing` (use `alternateHosts`) and for a live channel.
   *
   * apiVersion 6: each may carry a `label` (same rules as the Stream's), and may be `{ label, ref }` instead of a URL: a
   * lazy copy. `ref` (a non-blank string of at most 512 characters) goes to your `resolve(ref)` ONLY when that copy is
   * needed -- the person picks it in the "Servidor" menu, the automatic fallback reaches it, or a download's copy choice
   * probes it within its 30 s budget. That call is a normal `resolve` (same time limit, same checks,
   * `kino.browser.capture` allowed); only its `url`, `headers`, `mime`, `subtitles`, `expiresInSeconds` and `skip` are
   * used, never its own `alternatives`. Its `skip` applies while that copy plays and is never saved (the Stream's `skip`
   * stays the episode's). A failure moves on to the next copy. Below apiVersion 6 a ref-only entry has no `url` and is
   * dropped.
   */
  alternatives?: KinoStreamAlternative[];
  /**
   * Where THIS file's opening and ending are, in ms from its start: Kino's "Saltar intro" shows from
   * `openingStartMs` (0 when left out or null) to `openingEndMs`, "Saltar outro" from `endingStartMs`. Each a
   * finite number in 0..`durationMs` (0..86 400 000 without `durationMs`); the opening needs its end,
   * after its start; the ending not before the opening's end. A bad part is dropped, never the stream.
   * A person's hand correction wins over it; it wins over AniSkip. Ignored for a live channel.
   */
  skip?: { openingStartMs?: number; openingEndMs?: number; endingStartMs?: number };
}

/** One of a Stream's `alternatives`: a URL (labelled from apiVersion 6), or (apiVersion 6) a lazy `{ label, ref }`. */
type KinoStreamAlternative =
  | { url: string; mime?: string; headers?: Record<string, string>; label?: string }
  | { ref: string; label?: string };

/** apiVersion 3, capability "channels": a section of the En vivo tab. */
interface KinoLiveCategory {
  id: string;
  title: string;
  /** ISO 3166 alpha-2, e.g. "CO". Informational. */
  country?: string;
  /**
   * What the row (or category, or list) is about, from Kino's closed vocabulary: "peliculas", "series", "anime",
   * "infantil", "documentales", "deportes", "noticias", "musica", "entretenimiento" or "otros". Kino groups Categorías
   * by it and filters En vivo by it across plugins. Optional: without it Kino guesses from the title; a value outside
   * the list is ignored. Kino versions before this field ignore it.
   */
  genre?: KinoGenre;
  /** apiVersion 6: true = an 18+ entry, shown only while the person's 18+ code is unlocked on that device (Ajustes ▸ Adultos). Below apiVersion 6 it is dropped. Every channel listed in it is 18+ too. */
  adult?: boolean;
}

/**
 * apiVersion 3: an M3U playlist Kino downloads itself (from a declared host only, never under
 * `liveStreamHosts: "any"`), with an optional XMLTV guide. Put it next to your categories in the
 * `liveCategories()` answer, or return it alone. At most 10 per answer. `refreshHours` is 1..168,
 * default 12. `hideGroups` are group titles not to show (case-insensitive), at most 50. With
 * `resolve: true` each entry plays through your `resolve(<entry url>)` instead of directly.
 */
interface KinoPlaylist {
  playlist: {
    url: string;
    format: "m3u";
    headers?: Record<string, string>;
    /**
     * Headers the PLAYER sends for every channel of the list: a `User-Agent` some channels only answer to, a
     * `Referer`. Filtered like a Stream's `headers` (at most 20). Kept apart from `headers` on purpose: those carry
     * the list's own credentials and go only to the list's host, never to the hosts the channels are on. A header an
     * M3U entry names itself (`#EXTVLCOPT:http-user-agent=...`) wins. Kino versions before this field ignore it.
     */
    streamHeaders?: Record<string, string>;
    /** The [genre](KinoLiveCategory) of every group this list produces; without it Kino guesses from each group's title. */
    genre?: KinoGenre;
    epg?: { url: string; format: "xmltv" };
    refreshHours?: number;
    hideGroups?: string[];
    resolve?: boolean;
  };
}

/**
 * One channel: give `ref` (resolved on play, exactly like a `live` item's) or `stream` (played as
 * is, checked like `resolve()`'s answer). With both, the stream plays and `ref` is the fallback.
 * An `id` starting with `~` is reserved for Kino and dropped.
 */
interface KinoLiveChannel {
  id: string;
  title: string;
  ref?: string;
  stream?: KinoStream;
  /**
   * In liveChannels, informational: the channel is listed under the category it was asked for. Not a valid id = empty.
   * In a liveSearch hit (apiVersion 6), the category it belongs to: one of your 18+ categories makes it 18+, a plain one
   * makes it plain. A hit with neither `categoryId` nor `adult` counts as 18+ when you have any 18+ category.
   */
  categoryId?: string;
  /** https image, like a poster. */
  logo?: string;
  /** 1..9999. */
  number?: number;
  /**
   * apiVersion 6: true = an 18+ entry, shown only while the person's 18+ code is unlocked on that device (Ajustes ▸ Adultos).
   * Below apiVersion 6 it is dropped. On a liveSearch hit, `false` says it is plain (needed when your categories can't be
   * read and it carries no `categoryId`): mark every hit with `adult` or `categoryId`.
   */
  adult?: boolean;
}

interface KinoLiveChannelPage {
  items: KinoLiveChannel[];
  /** Opaque cursor for the next page; omit or null at the end. */
  next?: string | null;
}

/** One programme. `start`/`end` are epoch milliseconds. */
interface KinoGuideEntry {
  channelId: string;
  title: string;
  start: number;
  end: number;
  description?: string;
}

/** apiVersion 6, capability "migrate": one value Kino stored and can no longer open. */
type KinoMigrateInput =
  | { kind: "title"; ref: string }
  | { kind: "chapter"; ref: string; season: number | null; episode: number | null }
  | { kind: "live"; provider: string; code: string };

/** Your answer: the same id/ref you would return from search() today. `ref` never starts with "plg1:". */
type KinoMigrateAnswer =
  | { kind: "movie" | "series"; id: string; ref: string }
  | { kind: "episode"; ref: string; season?: number; number: number }
  | { kind: "live"; code: string };

/** apiVersion 6, with `"section": { "label" }` in the manifest: your own section (TV sidebar, chip atop Inicio on the phone). */
interface KinoSectionAnswer {
  /** At most 8; each `id` matches the item id pattern, each `label` at most 24 characters. */
  tabs?: { id: string; label: string }[];
  /** The tab this answer is for; an unknown or missing one reads as the first tab. */
  tab?: string;
  /** A banner above the rows: `title` as an item title, `text` at most 300 characters, `image` http or https (the Images rule). */
  hero?: { title: string; image?: string; text?: string };
  /** The same shape and limits as `home`. */
  rows: KinoRow[];
}

/** apiVersion 6, optional, needs the `browse` capability: a tile of your Categorías group; it opens `browse(ref, null)`. */
interface KinoCategory {
  /** The item id pattern. */
  id: string;
  /** At most 40 characters. */
  title: string;
  /** http or https image (the Images rule), same rules as a poster. */
  art?: string;
  /** At most 4096 characters. */
  ref: string;
  /** apiVersion 6: true = an 18+ entry, shown only while the person's 18+ code is unlocked on that device (Ajustes ▸ Adultos). Below apiVersion 6 it is dropped. */
  adult?: boolean;
}

/** Your module's exports. `resolve` is required, and at least one of `search`/`home`. */
interface KinoPlugin {
  /** apiVersion 6, capability "migrate". Return null for anything that is not yours. 10 s per call. */
  migrate?(input: KinoMigrateInput): Promise<KinoMigrateAnswer | null>;
  /** apiVersion 6, required when the manifest declares `section`. `tab` is null the first time. 20 s per call. */
  section?(arg: { tab: string | null }): Promise<KinoSectionAnswer>;
  /** apiVersion 6, optional, needs `browse`: up to 24 tiles in Categorías, in your order. 20 s per call. */
  categories?(arg: null): Promise<KinoCategory[]>;
  /** With `query.within` (capability "scopedSearch", apiVersion 6): null = "can't search inside this page". 15 s per call. */
  search?(query: KinoSearchQuery): Promise<KinoItem[] | KinoPage | null>;
  home?(): Promise<KinoRow[]>;
  browse?(ref: string, cursor: string | null): Promise<KinoPage>;
  episodes?(ref: string): Promise<KinoEpisodes>;
  /** `options.retry` (apiVersion 6) only when Kino resolves again after the origin refused your stream. `attempt` is 1 to 3; `status` is the origin's HTTP status when Kino heard one. */
  resolve(ref: string, options?: { retry?: { reason: "conflict" | "expired"; attempt: number; status?: 401 | 403 | 409 } }): Promise<KinoStream>;
  /**
   * apiVersion 6, needed when a stream says `signing: "request"`: headers for one request, computed with
   * kino.crypto / kino.secret only. kino.fetch answers host_not_allowed; kino.storage, kino.cookies and
   * kino.sleep fail with not_allowed. 1.5 s limit.
   */
  sign?(request: { url: string; kind: "playlist" | "segment"; ref: string; context: string }): Promise<{ headers: Record<string, string> }>;
  /** apiVersion 3, capability "channels" (required with it). At most 200 categories. */
  liveCategories?(): Promise<Array<KinoLiveCategory | KinoPlaylist> | KinoPlaylist>;
  /**
   * apiVersion 3, capability "channels" (required with it). At most 500 per page. Kino asks 10
   * pages at first and 5 more each time the person scrolls near the end, up to 10,000 channels.
   */
  liveChannels?(arg: { categoryId: string; cursor: string | null }): Promise<KinoLiveChannelPage | KinoLiveChannel[]>;
  /**
   * apiVersion 3, optional with "channels": channels whose name matches `query`, listed or not (the
   * En vivo search, while some of your channels were never listed). At most 100 kept; `next` ignored.
   * apiVersion 6 with an 18+ category: give every hit `adult` or `categoryId`; an unmarked hit counts as 18+.
   */
  liveSearch?(arg: { query: string }): Promise<KinoLiveChannelPage | KinoLiveChannel[]>;
  /** apiVersion 3, optional with "channels". At most 50 channels and a 24 h window per call. */
  guide?(arg: { channelIds: string[]; from: number; to: number }): Promise<KinoGuideEntry[]>;
  /** apiVersion 6: required when a setting has `type: "status"`. One text per status setting key, shown as-is (at most 200 characters; a missing key or a non-text reads "Sin información"). 10 s. */
  settingsStatus?(): Promise<Record<string, string>>;
  /** apiVersion 6: required when a setting has `type: "action"`. Runs when the person presses that button (30 s); the `message` (at most 300 characters, default "Listo") is shown; settingsStatus() is asked again after every action (and when the form opens); `refresh: true` is still accepted and changes nothing. `clearSettings` (up to 12 keys of your own optional, valued settings: not a `required` one, not a section/status/action) is emptied by Kino right after a successful action, as if the person had emptied the field and saved (a password leaves the Keystore; your sandbox closes as for any saved change; `kino.storage` survives); anything else in it is dropped. A throwing action clears nothing. */
  action?(key: string): Promise<{ message?: string; refresh?: boolean; clearSettings?: string[] } | null | void>;
  /**
   * apiVersion 6, optional: checks the values BEFORE Kino saves them (20 s). `null` accepts; `{ key: "mensaje" }`
   * refuses with the message under that field (a key that is not one of your valued settings refuses too, as a
   * general message); a text refuses with that text. If it throws, times out or answers anything else, nothing is
   * saved and the person may "Guardar sin comprobar".
   */
  validateSettings?(values: Record<string, string | boolean | Array<Record<string, string>>>): Promise<Record<string, string> | string | null>;
}

/** A subtitles() track: a Stream's `subtitles` entry plus an optional `label` and `translated` (a machine translation). */
interface KinoSubtitleTrack { lang: string; url: string; format?: "vtt" | "srt"; label?: string; translated?: boolean }

/**
 * `subtitles` -- optional for any plugin (Kino asks every plugin that exports it), required with the capability
 * "subtitles". Tracks for a title Kino knows by IMDb or TMDB id (an episode's ids are the series'); `languages` are ISO
 * 639-1, best first. Checked like a Stream's `subtitles`: 30 kept, then only the person's languages are listed. 10 s, a
 * background call.
 */
type KinoSubtitlesFn = (arg: {
  imdbId?: string; tmdbId?: number; kind: "movie" | "series"; season?: number; episode?: number;
  title?: string; year?: number; languages: string[];
}) => Promise<KinoSubtitleTrack[]>;

/** A plugin that plays (`resolve` required, as above), optionally finding subtitles too. */
interface KinoPlayingPlugin extends KinoPlugin { subtitles?: KinoSubtitlesFn }

/** A subtitle provider: capabilities exactly ["subtitles"], so `subtitles` is its only export. */
interface KinoSubtitleProvider { subtitles: KinoSubtitlesFn }

/** Your module's exports: one or the other. */
type KinoPluginModule = KinoPlayingPlugin | KinoSubtitleProvider;

// ---------- the kino API ----------

type KinoErrorCode = "auth_required" | "not_found" | "geo_blocked" | "rate_limited" | "unavailable";
type KinoFetchErrorCode = "host_not_allowed" | "timeout" | "network" | "too_large" | "invalid_request";
type KinoEncoding = "utf8" | "hex" | "base64";
type KinoKeyType = "ec" | "ed25519" | "x25519";
/** A public key as a JWK, in WebCrypto's key order: EC `{ crv, kty: "EC", x, y }`, OKP `{ crv: "Ed25519" | "X25519", kty: "OKP", x }` (base64url, no padding). */
interface KinoJwk { readonly crv: string; readonly kty: "EC" | "OKP"; readonly x: string; readonly y?: string }
/** apiVersion 6: a handle to a private key that lives only inside Kino, in this runtime. */
interface KinoPrivateKey { readonly type: KinoKeyType; readonly namedCurve?: "P-256" | "P-384"; readonly handle: string }
/** apiVersion 6: `spki` is DER as base64; `raw` is base64 (an uncompressed point 04||x||y for ec, 32 bytes otherwise). */
interface KinoPublicKey { readonly type: KinoKeyType; readonly namedCurve?: "P-256" | "P-384"; readonly jwk: KinoJwk; readonly spki: string; readonly raw: string }

interface KinoError extends Error {
  /** `KinoError_<code>` (e.g. `KinoError_not_found`). */
  readonly name: string;
  readonly code: KinoErrorCode | KinoFetchErrorCode | "crypto_error" | "unknown";
  /** The sentence you passed as `{ userMessage }`, cut at 161 characters; absent when you passed none. */
  readonly userMessage?: string;
}

interface KinoErrorOptions {
  /**
   * Your own sentence for the person, shown INSTEAD of Kino's line for the code as "Mensaje de <plugin>: <sentence>",
   * only when: your plugin's name has no ":", no digit glued to a letter, spells no Kino and uses only the characters
   * below; the code is one of
   * the five `KinoErrorCode`s; it is 1..160 characters once trimmed, made only of Basic Latin and Latin-1 letters
   * (á é í ó ú ü ñ ç ã õ…, not ø æ ð þ ß), digits 0-9, the plain space and . , : ; ¿ ? ¡ ! ' ’ ‘ “ ” « » ( ) % - – — ▸
   * (; only before a space); it reads as
   * plain words (two or more, no URL, no "TypeError:" prefix, no undefined/null/NaN, not ending in : , ; -); fewer than
   * 6 digits in all and none glued to a letter; no domain (site.app, site .app, site. app, www, punto/dot + com, app…);
   * no "kino" once 1 l ! ¡ read as
   * i, 0 as o and non-letters dropped; no credential, money or contact stem (pag…, abon…, recarg…, transfer…,
   * contraseñ…, passw…, clave…, token…, tarjeta, PIN, Nequi, Daviplata, WhatsApp, Telegram, SMS/verification code);
   * and none of the person's passwords or a sealed value. Otherwise Kino's line stays. A host the person refused still
   * wins, whatever the code. It counts only for the call that built the error. Older Kino builds ignore it. Plugins
   * that use it to ask for money, credentials or contact outside Kino are removed from the catalog.
   */
  userMessage?: string;
}

interface KinoFetchOptions {
  method?: "GET" | "HEAD" | "POST" | "PUT" | "PATCH" | "DELETE";
  headers?: Record<string, string>;
  /** A string, or JSON, a form, or raw bytes as base64. URL + headers + body at most 1,048,576 characters. */
  body?: string | { json: unknown } | { form: Record<string, string | number | boolean> } | { base64: string };
  /** "follow" (default, at most 10 hops, each host-checked) or "manual" (returns the 3xx). */
  redirect?: "follow" | "manual";
  /** true (default): send and store cookies from the plugin's jar. */
  cookies?: boolean;
  /** Default 15000, at most 30000. */
  timeoutMs?: number;
}

interface KinoResponse {
  readonly ok: boolean;
  readonly status: number;
  readonly url: string;
  /** Lower-cased names; repeated headers joined with ", "; never set-cookie. */
  readonly headers: Readonly<Record<string, string>>;
  text(): string;
  json(): any;
  /** The body bytes (at most 5 MB) as base64. */
  base64(): string;
}

interface KinoHtmlMatch {
  text: string;
  html: string;
  attrs: Record<string, string>;
}

interface KinoCipherOptions {
  key: string;
  iv?: string;
  data: string;
  /** CBC/ECB only. Default "pkcs7". */
  padding?: "pkcs7" | "none";
  /** GCM only: additional authenticated data. */
  aad?: string;
  /** Default utf8 to encrypt, base64 to decrypt. */
  inputEncoding?: KinoEncoding;
  /** Default base64 from encrypt, utf8 from decrypt. */
  outputEncoding?: KinoEncoding;
  keyEncoding?: KinoEncoding;
  ivEncoding?: KinoEncoding;
  aadEncoding?: KinoEncoding;
}

type KinoCipher =
  | "aes-128-cbc" | "aes-192-cbc" | "aes-256-cbc"
  | "aes-128-ecb" | "aes-192-ecb" | "aes-256-ecb"
  | "aes-128-ctr" | "aes-192-ctr" | "aes-256-ctr"
  | "aes-128-gcm" | "aes-192-gcm" | "aes-256-gcm"
  | "des-ede3-cbc" | "des-ede3-ecb";

/** apiVersion 6: `kino.browser.capture` options. */
interface KinoBrowserCaptureOptions {
  /** 1..25000 ms; default 18000. */
  timeoutMs?: number;
  /** Extra headers for the first page load only (a `Referer` an embed insists on). */
  headers?: Record<string, string>;
  /** A regular expression (case-insensitive, up to 500 characters) for what counts as the video request; default: m3u8, mpd, mp4, `master.txt`, `videoplayback`, `/hls/`. */
  match?: string;
  /** Default true: mute and start the page's player, click common play buttons, tap the middle. */
  autoplay?: boolean;
}

/** apiVersion 6: what `kino.browser.capture` saw. */
interface KinoBrowserCapture {
  /** At most 8, manifests first. `headers` carries Referer, User-Agent and, when the request had them, Origin and Cookie. */
  media: { url: string; mime?: string; headers: Record<string, string> }[];
  /** `.vtt`/`.srt` requests the page made, at most 10. */
  subtitles: { url: string; lang?: string }[];
  /** The top page's last address. */
  finalUrl: string;
}

/** apiVersion 6, `"browser": "pages"`: `kino.browser.page` options. */
interface KinoBrowserPageOptions {
  /**
   * 1..25000 ms; default 15000. Counts inside your call's own time limit, which ends the read when it runs out: pass
   * less than what is left of it (about 12000 in `search`, whose whole call has 15 s; about 16000 in the 20 s exports).
   */
  timeoutMs?: number;
  /**
   * A JavaScript regular expression (source string or RegExp; matched case-insensitively against the page's HTML, up
   * to 500 characters): the page is returned only once it matches. Without it, as soon as the page is loaded and is no
   * longer the site's browser check page. Use it for pages that fill in their list with scripts.
   */
  waitFor?: string | RegExp;
}

/** apiVersion 6, `"browser": "pages"`: what `kino.browser.page` read. */
interface KinoBrowserPage {
  /** The doctype and the DOM's outerHTML (after the page's scripts ran), at most 2,000,000 characters. Feed it to `kino.html.select`. */
  html: string;
  /** The top page's last address (after redirects and the browser check). */
  finalUrl: string;
  /** The HTTP status of the top page's last load: 200 unless that load answered an error. */
  status: number;
  /** True when `html` was cut at 2,000,000 characters. */
  truncated: boolean;
}

declare namespace kino {
  const apiVersion: number;
  const appVersion: string;
  const lang: string;

  /** Only to the manifest's hosts over https (http only on a host declared `insecureHttp`), or to the person's own server as typed. Never throws for a non-2xx status. */
  function fetch(url: string, options?: KinoFetchOptions): Promise<KinoResponse>;

  /**
   * `throw kino.error("not_found", "…")`: the app words the message; yours is a detail of at most 200 characters.
   * `throw kino.error("not_found", "…", { userMessage: "Este capítulo ya no está disponible." })`: your own sentence
   * for the person, shown instead of Kino's line when it is safe (see `KinoErrorOptions`).
   */
  function error(code: KinoErrorCode, message?: string, options?: KinoErrorOptions): KinoError;

  /** 0..5000 ms, counts inside the call's own timeout. */
  function sleep(ms: number): Promise<void>;

  /**
   * apiVersion 6, with `"browser": true` (or `"pages"`) in the manifest (the person approves it in red): from `resolve` only, and only
   * a `resolve` the person started (they pressed play, or they started a download; never a background one), opens
   * `url` in a hidden web view, lets the page run its own player (muted; with `autoplay`, the default, it also clicks the
   * usual play buttons and taps the middle of the page), and answers the video requests the page made, HLS/DASH first,
   * each with the headers to play it with (put them in your Stream's `headers`). The start `url` must be a host your
   * `kino.fetch` may reach; the page may then load from any public server, never the home network. One page at a
   * time in the whole app (a download's capture never waits: `busy` at once). Throws a typed error: `browser_unavailable`
   * (no WebView on this device, and always under the Node kit), `timeout` (no video in `timeoutMs`, default 18000, at
   * most 25000), `blocked`, `busy`, `not_allowed` (no approved `"browser": true`, not inside `resolve`, or a `resolve`
   * nobody started), `invalid_request`.
   */
  namespace browser {
    function capture(url: string, options?: KinoBrowserCaptureOptions): Promise<KinoBrowserCapture>;
    /**
     * apiVersion 6, with `"browser": "pages"` in the manifest (`true` is capture-only and answers `not_allowed` here; the
     * person approves "Puede abrir páginas web ocultas para mostrar contenido y
     * encontrar el video", in red): from `search`, `home`, `browse`, `episodes`, `section`, `categories` or `resolve`, only
     * while the person is using the app (never a background call), loads `url` in the same hidden web view and returns its
     * HTML once the page is past the site's automatic browser check (Cloudflare's "Just a moment…") and matches `waitFor`.
     * Kino never clicks, taps, types or scrolls in it and never solves a captcha: a page that asks for a human answers
     * `blocked` at once, and one still on its check page when the time runs out answers `blocked` too. Same start-host
     * rule, same one page at a time, fresh cookies per call; at most 20 page reads per minute per plugin. Throws a typed
     * error: `browser_unavailable` (always under the Node kit: keep a plain `kino.fetch` path), `timeout`, `blocked`,
     * `busy` (another page is open, or the person pressed play and the read was ended), `not_allowed`, `rate_limited`,
     * `invalid_request`.
     */
    function page(url: string, options?: KinoBrowserPageOptions): Promise<KinoBrowserPage>;
  }

  /** apiVersion 4: a marker for a secret the manifest's `secrets` declares (throws for any other name). Kino swaps it for the value in `kino.fetch`, toward the manifest's own hosts only; your code never sees the value. apiVersion 6: a secret declared `{ seal, use: "cipher-key", encoding }` is accepted as the whole `key` of any `kino.crypto.encrypt`/`decrypt` (des-ede3 included), read with the manifest's encoding; it is refused everywhere else, including `kino.fetch`. */
  function secret(name: string): string;

  /** Writes to Kino's log (and console.* does the same); lines are cut at 2000 characters. When a call of a plugin whose manifest says `"telemetry": true` or `"verbose"` (apiVersion 6) fails (a plugin that does not declare it never sends a line; a later Kino build adds a per-device "Enviar registros de errores" switch, on by default, that stops them) (sign and the settings exports included), the last 30 lines it logged (cut at 300 characters, scrubbed of URLs, hosts, ids, secrets and the person's text, 2 KB in all) go with the failure report; never for a call that succeeds. Log what happened, never what the person typed. */
  function log(...args: unknown[]): void;
  namespace log {
    /** apiVersion 6, with `"telemetry": true`: a log line that also tells Kino's error tracker your plugin served a degraded result (a fallback account, a backup source). The line's first word is its area (`[a-z0-9_:]`, with a `_` or `:`, up to 24 characters; anything else is filed as "other"); at most one report per area an hour and 3 per plugin per session, scrubbed like any line. Without telemetry (or, once the per-device switch exists, with it off) it is only a log line. With `"telemetry": "verbose"` a plugin's playback metrics, live/cast problems and edge cases also reach the board (see the README). In a debug build, or with `"debug": true`, every line is in logcat under `KinoPlugin/<id>` and Kino's playback lines under `KinoPlay`. */
    function report(...args: unknown[]): void;
  }

  namespace html {
    /** Jsoup CSS selectors; at most 500 matches. Only inside Kino. */
    function select(html: string, css: string): KinoHtmlMatch[];
  }

  namespace storage {
    /** 256 KB in total for this plugin. Returns `null` once the entry has expired (see `set`). */
    function get(key: string): string | null;
    /**
     * `options.ttlMs` makes the entry expire: after that many milliseconds, `get` returns `null` and
     * `keys()` leaves it out, even across a restart of the app. A whole number greater than 0,
     * at most 2,592,000,000 ms (30 days); anything else throws before the entry is touched. Leave
     * out `options` (or `ttlMs`) for a permanent entry, exactly as before this option existed. An
     * expired entry never counts against the 256 KB cap: it is dropped the next time your plugin
     * reads or writes storage.
     */
    function set(key: string, value: string, options?: { ttlMs?: number }): void;
    function remove(key: string): void;
    /** Expired keys are already gone. */
    function keys(): string[];
  }

  namespace config {
    /** A setting's value (string; boolean for a toggle; an array of `{ [field.key]: string }` for a `list`, apiVersion 4); undefined when unset with no default (a `url` setting never has one). Read-only. */
    function get(key: string): string | boolean | Array<Record<string, string>> | undefined;
    function all(): Record<string, string | boolean | Array<Record<string, string>>>;
  }

  namespace cookies {
    /** The value of cookie `name` for `url` (a host the plugin may reach), or null. */
    function get(url: string, name: string): string | null;
    /** Forgets every cookie of this plugin (they also go when its settings change). */
    function clear(): void;
  }

  namespace crypto {
    /** Default input utf8, output hex. Data at most 5 MB. Errors carry code "crypto_error". */
    function hash(alg: "md5" | "sha1" | "sha256" | "sha512", data: string, options?: { inputEncoding?: KinoEncoding; outputEncoding?: KinoEncoding }): string;
    function hmac(alg: "md5" | "sha1" | "sha256" | "sha512", key: string, data: string, options?: { keyEncoding?: KinoEncoding; inputEncoding?: KinoEncoding; outputEncoding?: KinoEncoding }): string;
    /** GCM appends the 16-byte tag to the ciphertext. */
    function encrypt(alg: KinoCipher, options: KinoCipherOptions): string;
    /** GCM expects the 16-byte tag appended. */
    function decrypt(alg: KinoCipher, options: KinoCipherOptions): string;
    /** iterations at most 100000, keyLength at most 64 bytes. Password uses keyEncoding, salt inputEncoding. */
    function pbkdf2(hash: "sha1" | "sha256" | "sha512", password: string, salt: string, iterations: number, keyLength: number, options?: { keyEncoding?: KinoEncoding; inputEncoding?: KinoEncoding; outputEncoding?: KinoEncoding }): string;
    /** 1..1024 bytes, hex by default. */
    function randomBytes(n: number, outputEncoding?: KinoEncoding): string;
    /** A random (v4) UUID. */
    function uuid(): string;
    /**
     * apiVersion 6: a new key pair. The private key stays inside Kino: you get a handle that works only in this
     * runtime (not in sign()'s signing lane, not after the plugin restarts) and is gone when it closes; at most 64
     * live at once (a new one drops the oldest). Node's generateKeyPairSync / WebCrypto's generateKey map here.
     */
    function generateKeyPair(options: { type: "ec"; namedCurve: "P-256" | "P-384" } | { type: "ed25519" } | { type: "x25519" }): { readonly privateKey: KinoPrivateKey; readonly publicKey: KinoPublicKey };
    /** apiVersion 6: a peer's public key (jwk object, spki base64, or raw base64 with `type` and, for ec, `namedCurve`). Private keys cannot be imported. */
    function importKey(options: { format: "jwk"; key: KinoJwk } | { format: "spki"; key: string } | { format: "raw"; key: string; type: KinoKeyType; namedCurve?: "P-256" | "P-384" }): KinoPublicKey;
    /**
     * apiVersion 6: signs `data` (read with `encoding`, default utf8) with your private key; base64 by default.
     * ec: `hash` "SHA-256" (default) or "SHA-384"; `format` "der" (default, Node's crypto.sign) or "ieee-p1363"
     * (r||s, 64 bytes on P-256, 96 on P-384: WebCrypto's). ed25519: 64 bytes, no `hash`. x25519 does not sign.
     */
    function sign(options: { key: KinoPrivateKey | string; data: string; encoding?: KinoEncoding; hash?: "SHA-256" | "SHA-384"; format?: "der" | "ieee-p1363"; outputEncoding?: "base64" | "hex" }): string;
    /** apiVersion 6: true when `signature` (base64 by default) is valid for `data`; a malformed signature is false. `key`: a public key, a `{ jwk }`, or your own private key. */
    function verify(options: { key: KinoPublicKey | { jwk: KinoJwk } | KinoPrivateKey | string; data: string; encoding?: KinoEncoding; signature: string; signatureEncoding?: KinoEncoding; hash?: "SHA-256" | "SHA-384"; format?: "der" | "ieee-p1363" }): boolean;
    /** apiVersion 6: ECDH (ec, same curve) or X25519: the shared secret, base64 by default (32 bytes; 48 on P-384). */
    function deriveSharedSecret(options: { privateKey: KinoPrivateKey | string; publicKey: KinoPublicKey | { jwk: KinoJwk }; outputEncoding?: "base64" | "hex" }): string;
  }

  namespace rank {
    /**
     * The title's HEAD, up to its first `:`, `,`, `|`, en dash or em dash -- for a search backend
     * that ranks a short query better than a long one. A one- or two-letter head identifies
     * nothing, so the whole (trimmed) text comes back instead; a plain "-" is never a cut point (it
     * would split a hyphenated word like "Spider-Man").
     */
    function shortQuery(query: string): string;
    /**
     * Reorders `items` so the ones sharing the most words with `query` come first; ties keep
     * `items`' own order. `query` is a title, or several forms of one (try `query.q`,
     * `query.originalTitle` and `query.altTitles` together: a backend may only know a title in one
     * language). `getTitle` reads a title off an item, string or array of them; it defaults to
     * `(item) => item.title`. Never throws: `items` not an array answers `[]`; an item with no
     * usable title (missing, not a string, or `getTitle` itself failing) sorts after every item
     * that has one, in `items`' own order among themselves.
     */
    function sortBySimilarity(items: any[], query: string | string[], getTitle?: (item: any) => string | string[]): any[];
    /**
     * Drops items sharing too few words with `query` (under 60% of its distinctive words of 3+
     * letters), and any item with no usable title along with them. Never throws: `items` not an
     * array answers `[]`. Reordering alone (`sortBySimilarity`) still shows a full page of near-misses when
     * the title genuinely is not on the backend, so an absent title comes back with 0 results
     * instead.
     */
    function filterRelevant(items: any[], query: string | string[], getTitle?: (item: any) => string | string[]): any[];
  }
}

// ---------- web globals Kino adds (QuickJS has none of them natively) ----------
// URL, URLSearchParams, atob, btoa, TextEncoder and TextDecoder (UTF-8 only) behave like the
// browser's, without IDN/punycode. Use the lib "dom" typings, or declare them in your editor.

/**
 * The manifest's optional `categories` (every apiVersion; read only by Kino's plugin marketplace for its category chips).
 * A list without repeats; when present it replaces what Kino guesses from the capabilities.
 */
type KinoManifestCategory = "movies" | "series" | "anime" | "live" | "radio" | "subtitles" | "utilities" | "adult";

/** apiVersion 6, capability "meta": what `meta(query)` is asked about a title another source listed. */
interface KinoMetaQuery {
  type: "movie" | "series";
  ids: { imdb?: string; tmdb?: number; kitsu?: number; mal?: number; anilist?: number };
  /** The title's own Stremio-style id in its source ("kitsu:1376"), when it has one. */
  id?: string;
  /** The person's language ("es"). */
  lang?: string;
}

/** `meta`'s answer (or null: a title you do not know). Every field optional; Kino only fills what TMDB and AniList left empty. */
interface KinoTitleMeta {
  title?: string;
  overview?: string;
  poster?: string;
  backdrop?: string;
  year?: string;
  genres?: string[];
  runtimeMinutes?: number;
  episodes?: { season: number; number: number; title?: string; overview?: string; still?: string; airDate?: string; id?: string }[];
}
