// A test plugin for the settings form (apiVersion 6): every outcome the app must survive, on demand.
export async function search() { return []; }
export async function resolve() { throw kino.error("not_found", "demo"); }

export async function settingsStatus() {
  const email = kino.config.get("email");
  // kino.storage holds strings, so compare the string the plugin wrote.
  const linked = (await kino.storage.get("linked")) === "true";
  return { linked: linked && email ? `Vinculada como ${email}` : "Sin cuenta: sesión anónima", slow: 42 };
}

export async function action(key) {
  if (key === "test") return { message: "Conexión correcta" };
  if (key === "logout") { await kino.storage.remove("linked"); return { message: "Sesión cerrada", refresh: true }; }
  if (key === "boom") throw new Error("falló a propósito");
  return null;
}

export async function validateSettings(values) {
  if (values.email && !values.email.includes("@")) return { email: "Escribe un correo válido" };
  if (values.password === "mala") return { password: "La contraseña no es correcta" };
  // kino.sleep caps at 5 s per call, so chain 5 x 5 s = 25 s to pass the 20 s validateSettings timeout.
  if (values.password === "lenta") for (let i = 0; i < 5; i++) await kino.sleep(5000);
  if (values.password === "rara") return [1, 2];
  // Marks storage "linked" only here: "Cerrar sesión" / refresh shows a change only after a valid email is saved.
  if (values.email) await kino.storage.set("linked", "true");
  return null;
}
