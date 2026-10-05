// A tiny plugin that exercises every Section G widening: a section with tabs and a hero, its own
// categories with art, and a palette in which ONE token (highlight) fails a guardrail on purpose,
// so `node sdk/run.mjs <dir> theme` and the app both show the fallback to Kino's value.
const item = (n) => ({ id: `m${n}`, ref: `x36xhzz-${n}`, title: `Prueba ${n}`, kind: "movie" });
const row = (id, title) => ({ id, title, ref: id, items: [1, 2, 3, 4].map(item) });
const art = (name) => `https://image.tmdb.org/t/p/w500/${name}.jpg`;

export async function home() { return [row("inicio", "Inicio demo")]; }

export async function section({ tab } = {}) {
  const tabs = [{ id: "pelis", label: "Películas" }, { id: "series", label: "Series" }, { id: "vacia", label: "Vacía" }];
  const chosen = tabs.some((t) => t.id === tab) ? tab : "pelis";
  if (chosen === "vacia") return { tabs, tab: chosen, rows: [] };
  return {
    tabs,
    tab: chosen,
    hero: { title: chosen === "pelis" ? "Películas de prueba" : "Series de prueba", text: "Una sección hecha por un plugin." },
    rows: [row(`${chosen}-a`, "Destacadas"), row(`${chosen}-b`, "Recientes")],
  };
}

export async function categories() {
  return [
    { id: "accion", title: "Acción", ref: "accion", art: art("accion") },
    { id: "comedia", title: "Comedia", ref: "comedia", art: art("comedia") },
    { id: "drama", title: "Drama", ref: "drama", art: art("drama") },
  ];
}

export async function browse(ref) { return { items: [1, 2, 3, 4, 5, 6].map(item), next: null }; }

export async function resolve(ref) { return { url: "https://test-streams.mux.dev/x36xhzz/x36xhzz.m3u8", mime: "application/x-mpegURL" }; }
