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
  'login', 'register', 'dashboard', 'tipo', 'genero'
]);

const ITEM_ID_RE = /^[A-Za-z0-9._~-]{1,128}$/;

function isValidSlug(s) {
  return typeof s === 'string' && ITEM_ID_RE.test(s) && !RESERVED_SLUGS.has(s);
}

function parseAnimeCards(html) {
  if (!html || typeof html !== 'string') return [];
  const items = [];
  const seen = new Set();

  const blocks = html.split(/<div[^>]*class="[^"]*anime__item[^"]*"[^>]*>/i);
  for (let i = 1; i < blocks.length; i++) {
    const block = blocks[i];

    const imgMatch = block.match(/data-setbg="(https?:\/\/[^"]+)"/i) ||
                     block.match(/src="(https:\/\/[^"]+)"/i);
    const poster = imgMatch ? imgMatch[1] : null;

    const linkRe = /href="https:\/\/jkanime\.net\/([a-z0-9][a-z0-9-]{0,127})\/?"[^>]*>([\s\S]*?)<\/a>/gi;
    let m;
    let slug = null;
    let title = null;

    while ((m = linkRe.exec(block)) !== null) {
      const s = m[1];
      if (!isValidSlug(s)) continue;
      slug = s;
      const t = cleanText(m[2]);
      if (t && t.length > 1 && !t.includes('-->') && !/^\d+$/.test(t)) {
        title = t;
        break;
      }
    }

    if (!slug || seen.has(slug)) continue;
    seen.add(slug);

    const isMovie = block.toLowerCase().includes('película') || block.toLowerCase().includes('pelicula') || slug.includes('movie') || slug.includes('pelicula');

    items.push({
      id: slug,
      ref: slug,
      title: title || slugToTitle(slug),
      kind: isMovie ? 'movie' : 'series',
      poster: poster || null
    });
  }

  return items;
}

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

  const res = await kino.fetch(
    'https://jkanime.net/buscar/' + encodeURIComponent(query) + '/1/',
    { headers: { 'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64)' } }
  );

  if (!res.ok && res.status !== 301 && res.status !== 302) return [];

  const items = parseAnimeCards(getText(res));
  return items.slice(0, 60);
}

export async function home() {
  await kino.sleep(0);

  const res = await kino.fetch(
    'https://jkanime.net/',
    { headers: { 'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64)' } }
  );

  if (!res.ok) return [];

  const html = getText(res);
  const latestItems = [];
  const latestSeen = new Set();

  const epRe = /href="https:\/\/jkanime\.net\/([a-z0-9][a-z0-9-]{0,127})\/(\d+)\/"[^>]*>/gi;
  let em;
  while ((em = epRe.exec(html)) !== null) {
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

  const popularItems = parseAnimeCards(html);

  const rows = [];
  if (latestItems.length > 0) {
    rows.push({
      id: 'ultimos-episodios',
      title: '🔥 ÚLTIMOS EPISODIOS',
      items: latestItems.slice(0, 30)
    });
  }
  if (popularItems.length > 0) {
    rows.push({
      id: 'populares',
      title: '⭐ ANIME POPULAR',
      items: popularItems.slice(0, 30)
    });
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

  const res = await kino.fetch(
    'https://jkanime.net/directorio/' + page + '/',
    { headers: { 'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64)' } }
  );

  if (!res.ok) return { items: [], next: null };
  const items = parseAnimeCards(getText(res)).slice(0, 60);
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

export async function resolve(params) {
  await kino.sleep(0);
  let ref = '';
  if (typeof params === 'string') {
    ref = params;
  } else if (params && typeof params.ref === 'string') {
    ref = params.ref;
  }
  if (!ref) kino.error('not_found', 'Referencia de episodio no especificada');

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
