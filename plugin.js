// language: JavaScript, file: plugin.js, target: QuickJS (Kino Engine), apiVersion: 5

function cleanText(str) {
  if (!str) return '';
  return str
    .replace(/<[^>]+>/g, '')
    .replace(/&quot;/g, '"')
    .replace(/&amp;/g, '&')
    .replace(/&#039;/g, "'")
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .trim();
}

function getText(res) {
  if (!res) return '';
  if (typeof res.text === 'function') return res.text();
  if (typeof res.text === 'string') return res.text;
  return '';
}

function slugToTitle(slug) {
  return slug
    .split('-')
    .map(w => w.charAt(0).toUpperCase() + w.slice(1))
    .join(' ');
}

const RESERVED_SLUGS = new Set([
  'directorio', 'horario', 'top', 'dash', 'comunidad',
  'aplicacion', 'buscar', 'historial', 'guardado', 'notificaciones',
  'login', 'register', 'dashboard', 'tipo', 'genero', 'estrenos'
]);

const ITEM_ID_RE = /^[A-Za-z0-9._~-]{1,128}$/;

function isValidSlug(s) {
  return typeof s === 'string' && ITEM_ID_RE.test(s) && !RESERVED_SLUGS.has(s);
}

// -------------------------------------------------------------
// VER-PELICULAS-ONLINE (Cine en Español Latino)
// -------------------------------------------------------------

function parseVpoArticles(html) {
  if (!html || typeof html !== 'string') return [];
  const items = [];
  const seen = new Set();

  const cardRe = /<article[^>]*>([\s\S]*?)<\/article>/gi;
  let match;
  while ((match = cardRe.exec(html)) !== null) {
    const block = match[1];
    const linkM = block.match(/href="https:\/\/ver-peliculas-online\.net\/pelicula\/([^"\/]+)\/?"/i) ||
                  block.match(/href="https:\/\/ver-peliculas-online\.net\/serie\/([^"\/]+)\/?"/i);
    if (!linkM) continue;

    const rawSlug = linkM[1].trim();
    const isSerie = block.includes('/serie/');
    const slug = 'vpo-' + (isSerie ? 'serie-' : 'movie-') + rawSlug;

    if (!isValidSlug(slug) || seen.has(slug)) continue;
    seen.add(slug);

    const titleM = block.match(/alt="([^"]+)"/i) || block.match(/<h3[^>]*>([\s\S]*?)<\/h3>/i);
    const imgM = block.match(/data-src="([^"]+)"/i) || block.match(/src="(https?:\/\/[^"]+)"/i);

    items.push({
      id: slug,
      ref: 'vpo:' + (isSerie ? 'serie:' : 'movie:') + rawSlug,
      title: titleM ? cleanText(titleM[1]) : slugToTitle(rawSlug),
      kind: isSerie ? 'series' : 'movie',
      poster: imgM ? imgM[1] : null
    });
  }

  return items;
}

async function resolveVpoMovie(rawSlug) {
  const movieUrl = 'https://ver-peliculas-online.net/pelicula/' + rawSlug + '/';
  const res = await kino.fetch(movieUrl, {
    headers: { 'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64)' }
  });

  if (!res.ok) kino.error('unavailable', 'No se pudo cargar la película de cine');

  const html = getText(res);
  const postIdM = html.match(/<body[^>]*class="[^"]*postid-(\d+)[^"]*"/i) ||
                  html.match(/id="post-(\d+)"/i);

  if (!postIdM) kino.error('not_found', 'No se encontró el reproductor de la película');

  const postId = postIdM[1];
  const streams = [];

  for (let nume = 1; nume <= 4; nume++) {
    try {
      const body = 'action=doo_player_ajax&post=' + postId + '&type=movie&nume=' + nume;
      const ajaxRes = await kino.fetch('https://ver-peliculas-online.net/wp-admin/admin-ajax.php', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/x-www-form-urlencoded; charset=UTF-8',
          'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64)',
          'X-Requested-With': 'XMLHttpRequest',
          'Referer': movieUrl
        },
        body: body
      });

      if (!ajaxRes.ok) continue;
      const json = ajaxRes.json();
      if (json && json.embed_url && typeof json.embed_url === 'string' && json.embed_url.startsWith('http')) {
        const embedUrl = json.embed_url.trim();
        streams.push({
          label: 'Servidor Latino ' + nume,
          url: embedUrl
        });
      }
    } catch (e) {
      // skip option if failed
    }
  }

  if (streams.length === 0) kino.error('unavailable', 'Ningún servidor disponible para esta película');

  const primary = streams[0];
  const alts = streams.slice(1, 9);

  return {
    url: primary.url,
    alternatives: alts.map(a => ({ label: a.label, url: a.url }))
  };
}

// -------------------------------------------------------------
// JKANIME (Anime)
// -------------------------------------------------------------

function parseAnimesJson(html) {
  if (!html || typeof html !== 'string') return [];
  const match = html.match(/var\s+animes\s*=\s*(\{[\s\S]*?\});\s*(?:var|\n|<)/);
  if (!match) return [];
  try {
    const data = JSON.parse(match[1]);
    const list = Array.isArray(data.data) ? data.data : [];
    return list.map(x => {
      const slug = (x.slug || '').trim();
      if (!isValidSlug(slug)) return null;
      const isMovie = (x.tipo && x.tipo.toLowerCase().includes('pel')) ||
                      (x.type && x.type.toLowerCase().includes('movie')) ||
                      slug.includes('pelicula');
      return {
        id: slug,
        ref: slug,
        title: cleanText(x.title || slugToTitle(slug)),
        kind: isMovie ? 'movie' : 'series',
        poster: x.image || null,
        overview: cleanText(x.synopsis || '')
      };
    }).filter(Boolean);
  } catch (e) {
    return [];
  }
}

async function extractDirectMediafire(embedUrl) {
  try {
    const res = await kino.fetch(embedUrl, {
      headers: { 'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64)' }
    });
    if (!res.ok) return null;
    const html = getText(res);
    const m = html.match(/href="(https?:\/\/download[^"]+)"/i) || html.match(/aria-label="Download file"\s+href="([^"]+)"/i);
    return m ? m[1] : null;
  } catch (e) {
    return null;
  }
}

async function extractDirectMp4upload(embedUrl) {
  try {
    const res = await kino.fetch(embedUrl, {
      headers: { 'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64)' }
    });
    if (!res.ok) return null;
    const html = getText(res);
    const m = html.match(/src:\s*"(https?:\/\/[^"]+\.mp4[^"]*)"/i) || html.match(/player\.src\("(https?:\/\/[^"]+)"\)/i);
    return m ? m[1] : null;
  } catch (e) {
    return null;
  }
}

async function resolveJkAnime(ref) {
  const epPath = ref.endsWith('/') ? ref : ref + '/';
  const url = 'https://jkanime.net/' + epPath;

  const res = await kino.fetch(url, {
    headers: { 'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64)' }
  });

  if (!res.ok) kino.error('unavailable', 'No se pudo cargar el episodio');

  const html = getText(res);

  const serversMatch = html.match(/var\s+servers\s*=\s*(\[[\s\S]*?\]);/);
  if (!serversMatch) kino.error('not_found', 'No se encontraron servidores de video');

  let serverList;
  try {
    serverList = JSON.parse(serversMatch[1]);
  } catch (e) {
    kino.error('unavailable', 'Error al procesar la lista de servidores');
  }

  if (!Array.isArray(serverList) || serverList.length === 0) {
    kino.error('not_found', 'Lista de servidores vacía');
  }

  const streams = [];

  for (const s of serverList) {
    if (!s.remote) continue;
    let decoded = '';
    try {
      decoded = atob(String(s.remote).trim());
    } catch (e) {
      continue;
    }
    if (!decoded || !decoded.startsWith('http')) continue;

    const serverName = (s.server || 'Servidor').trim();
    let directUrl = null;

    if (decoded.includes('mediafire.com')) {
      directUrl = await extractDirectMediafire(decoded);
    } else if (decoded.includes('mp4upload.com')) {
      directUrl = await extractDirectMp4upload(decoded);
    }

    streams.push({
      label: serverName + (s.size ? ' (' + s.size + ')' : ''),
      url: directUrl || decoded.trim()
    });
  }

  if (streams.length === 0) kino.error('unavailable', 'Ningún servidor disponible');

  const primary = streams[0];
  const alts = streams.slice(1, 9);

  return {
    url: primary.url,
    alternatives: alts.map(a => ({ label: a.label, url: a.url }))
  };
}

// -------------------------------------------------------------
// EXPORTS
// -------------------------------------------------------------

export async function search(params) {
  await kino.sleep(0);
  let query = '';
  if (typeof params === 'string') {
    query = params.trim();
  } else if (params && typeof params.query === 'string') {
    query = params.query.trim();
  } else if (params && typeof params.q === 'string') {
    query = params.q.trim();
  }
  if (!query) return [];

  const [resVpo, resJk] = await Promise.all([
    kino.fetch('https://ver-peliculas-online.net/?s=' + encodeURIComponent(query), { headers: { 'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64)' } }),
    kino.fetch('https://jkanime.net/buscar/' + encodeURIComponent(query) + '/1/', { headers: { 'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64)' } })
  ]);

  const vpoItems = resVpo.ok ? parseVpoArticles(getText(resVpo)) : [];
  const jkItems = resJk.ok ? parseAnimesJson(getText(resJk)) : [];

  const combined = [...vpoItems, ...jkItems];
  return combined.slice(0, 60);
}

export async function home() {
  await kino.sleep(0);

  const [resVpo, resJkHome, resJkDir, resJkMov] = await Promise.all([
    kino.fetch('https://ver-peliculas-online.net/', { headers: { 'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64)' } }),
    kino.fetch('https://jkanime.net/', { headers: { 'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64)' } }),
    kino.fetch('https://jkanime.net/directorio/1/', { headers: { 'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64)' } }),
    kino.fetch('https://jkanime.net/directorio/1?tipo=pelicula', { headers: { 'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64)' } })
  ]);

  const rows = [];

  // Row 1: Live Action Hollywood Movies
  if (resVpo.ok) {
    const vpoMovies = parseVpoArticles(getText(resVpo));
    if (vpoMovies.length > 0) {
      rows.push({
        id: 'cine-estrenos',
        title: '🎬 PELÍCULAS DE CINE Y ESTRENOS (LATINO)',
        items: vpoMovies.slice(0, 30)
      });
    }
  }

  // Row 2: Latest Anime Episodes
  if (resJkHome.ok) {
    const htmlHome = getText(resJkHome);
    const latestItems = [];
    const latestSeen = new Set();
    const epRe = /href="https:\/\/jkanime\.net\/([a-z0-9][a-z0-9-]{0,127})\/(\d+)\/"[^>]*>/gi;
    let em;
    while ((em = epRe.exec(htmlHome)) !== null) {
      const slug = em[1];
      if (!isValidSlug(slug) || latestSeen.has(slug)) continue;
      latestSeen.add(slug);
      latestItems.push({
        id: slug,
        ref: slug,
        title: slugToTitle(slug),
        kind: 'series'
      });
    }
    if (latestItems.length > 0) {
      rows.push({
        id: 'ultimos-episodios-anime',
        title: '🔥 ÚLTIMOS EPISODIOS ANIME',
        items: latestItems.slice(0, 30)
      });
    }
  }

  // Row 3: Anime Series
  if (resJkDir.ok) {
    const seriesItems = parseAnimesJson(getText(resJkDir));
    if (seriesItems.length > 0) {
      rows.push({
        id: 'series-populares-anime',
        title: '⭐ ANIME Y SERIES DESTACADAS',
        items: seriesItems.slice(0, 30)
      });
    }
  }

  // Row 4: Anime Movies & OVAs
  if (resJkMov.ok) {
    const movieItems = parseAnimesJson(getText(resJkMov));
    if (movieItems.length > 0) {
      rows.push({
        id: 'peliculas-ovas-anime',
        title: '💥 PELÍCULAS Y ESPECIALES ANIME',
        items: movieItems.slice(0, 30)
      });
    }
  }

  return rows;
}

export async function browse(params) {
  await kino.sleep(0);
  let page = 1;
  if (typeof params === 'string' || typeof params === 'number') {
    page = parseInt(params, 10) || 1;
  } else if (params && params.cursor) {
    page = parseInt(params.cursor, 10) || 1;
  }

  const [resVpo, resJk] = await Promise.all([
    kino.fetch('https://ver-peliculas-online.net/page/' + page + '/', { headers: { 'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64)' } }),
    kino.fetch('https://jkanime.net/directorio/' + page + '/', { headers: { 'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64)' } })
  ]);

  const vpoItems = resVpo.ok ? parseVpoArticles(getText(resVpo)) : [];
  const jkItems = resJk.ok ? parseAnimesJson(getText(resJk)) : [];

  const items = [...vpoItems, ...jkItems].slice(0, 60);

  return {
    items: items,
    next: items.length > 0 ? String(page + 1) : null
  };
}

export async function episodes(params) {
  await kino.sleep(0);
  let ref = '';
  if (typeof params === 'string') {
    ref = params;
  } else if (params && typeof params.ref === 'string') {
    ref = params.ref;
  }
  if (!ref) return { episodes: [] };

  if (ref.startsWith('vpo:')) {
    // Movies from VPO do not have episodes
    return { episodes: [] };
  }

  const slug = ref.split('/')[0];
  if (!isValidSlug(slug)) return { episodes: [] };

  const res = await kino.fetch(
    'https://jkanime.net/' + slug + '/',
    { headers: { 'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64)' } }
  );

  if (!res.ok) return { episodes: [] };

  const html = getText(res);
  let maxEp = 0;

  const epNumRe = new RegExp(slug.replace(/-/g, '-') + '\\/(\\d+)\\/', 'gi');
  let em;
  while ((em = epNumRe.exec(html)) !== null) {
    const n = parseInt(em[1], 10);
    if (n > maxEp) maxEp = n;
  }

  if (maxEp === 0) {
    const totalMatch = html.match(/Episodios[^<]*:?\s*<[^>]+>\s*(\d+)/i) ||
                       html.match(/total[^\d]{0,10}(\d+)/i);
    if (totalMatch) maxEp = parseInt(totalMatch[1], 10);
  }

  if (maxEp <= 0) maxEp = 1;
  if (maxEp > 5000) maxEp = 5000;

  const list = [];
  for (let i = 1; i <= maxEp; i++) {
    list.push({
      number: i,
      season: 1,
      title: 'Episodio ' + i,
      ref: slug + '/' + i
    });
  }
  return { episodes: list };
}

export async function resolve(params) {
  await kino.sleep(0);
  let ref = '';
  if (typeof params === 'string') {
    ref = params;
  } else if (params && typeof params.ref === 'string') {
    ref = params.ref;
  }
  if (!ref) kino.error('not_found', 'Referencia no especificada');

  if (ref.startsWith('vpo:movie:')) {
    const rawSlug = ref.replace('vpo:movie:', '');
    return resolveVpoMovie(rawSlug);
  }

  return resolveJkAnime(ref);
}
