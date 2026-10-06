/* Вход через Telegram (OpenID Connect + PKCE) и обращение к API ботов. */
(function () {
  const C = window.AVES_CONFIG;
  const K = { token: "aves.token", faculty: "aves.faculty", pkce: "aves.pkce" };

  const store = {
    get(k, session) { try { return (session ? sessionStorage : localStorage).getItem(k); } catch (_) { return null; } },
    set(k, v, session) { try { (session ? sessionStorage : localStorage).setItem(k, v); } catch (_) {} },
    del(k, session) { try { (session ? sessionStorage : localStorage).removeItem(k); } catch (_) {} },
  };

  /* ---------- сессия ---------- */
  let memoryToken = null; // внутри Telegram токен живёт только в памяти

  function tokenPayload(t) {
    try {
      const p = t.split(".")[0].replace(/-/g, "+").replace(/_/g, "/");
      return JSON.parse(decodeURIComponent(escape(atob(p))));
    } catch (_) { return null; }
  }

  function getToken() {
    const t = memoryToken || store.get(K.token);
    if (!t) return null;
    const p = tokenPayload(t);
    if (!p || p.exp * 1000 < Date.now()) { logout(); return null; }
    return t;
  }

  function setToken(t, persist) {
    memoryToken = t;
    if (persist) store.set(K.token, t);
  }

  function logout() {
    memoryToken = null;
    store.del(K.token);
    store.del(K.faculty);
  }

  /* ---------- PKCE ---------- */
  function b64url(bytes) {
    let s = "";
    bytes.forEach((b) => (s += String.fromCharCode(b)));
    return btoa(s).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
  }
  function randomString(n) {
    const a = new Uint8Array(n);
    crypto.getRandomValues(a);
    return b64url(a);
  }
  async function sha256(text) {
    const buf = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(text));
    return new Uint8Array(buf);
  }

  const redirectUri = () => location.origin + "/auth/callback/";

  async function startLogin(returnTo) {
    const verifier = randomString(48);
    const state = randomString(16);
    const challenge = b64url(await sha256(verifier));
    store.set(K.pkce, JSON.stringify({ verifier, state, returnTo: returnTo || "/app/" }), true);

    const q = new URLSearchParams({
      client_id: C.telegramClientId,
      redirect_uri: redirectUri(),
      response_type: "code",
      scope: C.telegramScope,
      state,
      code_challenge: challenge,
      code_challenge_method: "S256",
    });
    location.href = "https://oauth.telegram.org/auth?" + q.toString();
  }

  async function finishLogin() {
    const params = new URLSearchParams(location.search);
    const saved = JSON.parse(store.get(K.pkce, true) || "null");
    store.del(K.pkce, true);

    if (params.get("error")) throw new Error("Вход отменён в Telegram.");
    if (!saved || !params.get("code") || params.get("state") !== saved.state) {
      throw new Error("Ссылка входа устарела. Начните вход заново.");
    }
    const res = await api(C.loginFaculty, "/api/auth/telegram", {
      method: "POST",
      auth: false,
      body: { code: params.get("code"), code_verifier: saved.verifier, redirect_uri: redirectUri() },
    });
    setToken(res.token, true);
    return saved.returnTo || "/app/";
  }

  /* ---------- API ---------- */
  class ApiError extends Error {
    constructor(status, code, message) { super(message); this.status = status; this.code = code; }
  }

  async function api(faculty, path, { method = "GET", body, auth = true, onSlow, timeout = 75000 } = {}) {
    const f = C.faculties[faculty];
    if (!f) throw new ApiError(0, "no_faculty", "Неизвестный факультет.");

    const headers = { "Content-Type": "application/json" };
    if (auth) {
      const t = getToken();
      if (!t) throw new ApiError(401, "unauthorized", "Нужно войти через Telegram.");
      headers.Authorization = "Bearer " + t;
    }

    const ctrl = new AbortController();
    const kill = setTimeout(() => ctrl.abort(), timeout);
    const slow = onSlow ? setTimeout(onSlow, 3500) : null;

    try {
      const r = await fetch(f.api + path, {
        method, headers, signal: ctrl.signal,
        body: body ? JSON.stringify(body) : undefined,
      });
      const data = await r.json().catch(() => ({}));
      if (!r.ok) throw new ApiError(r.status, data.error || "http", data.message || "Сервер ответил ошибкой " + r.status + ".");
      return data;
    } catch (e) {
      if (e instanceof ApiError) throw e;
      if (e.name === "AbortError") throw new ApiError(0, "timeout", "Сервер не ответил за минуту. Попробуйте обновить страницу.");
      throw new ApiError(0, "network", "Нет связи с сервером. Проверьте интернет.");
    } finally {
      clearTimeout(kill);
      if (slow) clearTimeout(slow);
    }
  }

  window.Aves = {
    config: C, store, K, api, ApiError,
    getToken, setToken, logout, tokenPayload,
    startLogin, finishLogin,
    isLoggedIn: () => !!getToken(),
    tgIcon:
      '<svg class="tg-icon" viewBox="0 0 24 24" aria-hidden="true" fill="currentColor"><path d="M21.6 3.2 2.9 10.4c-1.3.5-1.3 1.2-.2 1.6l4.8 1.5 1.8 5.6c.2.6.1.9.8.9.5 0 .7-.2 1-.5l2.3-2.3 4.9 3.6c.9.5 1.5.2 1.7-.8l3.2-15c.3-1.3-.5-1.9-1.4-1.6ZM8.6 13.3l9.9-6.2c.5-.3.9-.1.5.2l-8.4 7.6-.3 3.6-1.7-5.2Z"/></svg>',
  };
})();
