/* Вкладка «Конспекты» приложения Aves: лента карточек с превью, поиск, избранное, фото дня.
   Данные — из бота AvesStudy (/api/study/*), вход — тот же сессионный токен, что у расписания. */
(function () {
  "use strict";
  const App = window.AvesApp;
  if (!App) return;
  const { S, A, C, esc, actions } = App;
  const CFG = C.study || {};
  const BASE = (CFG.api || "").replace(/\/$/, "");
  const $ = (s, r = document) => r.querySelector(s);

  const ST = {
    mode: "notes",           // notes | photos
    me: null,
    queue: [], cur: null, done: false, fetching: null,
    list: null,              // { title, items } — поиск / избранное / автор
    single: null,            // карточка, открытая из списка
    ph: { day: undefined, queue: [], cur: null, done: false, fetching: null },
  };

  /* ───────────── сеть ───────────── */
  async function api(path, { method = "GET", body, raw = false } = {}) {
    const t = A.getToken();
    if (!t) throw new A.ApiError(401, "unauthorized", "Нужно войти через Telegram.");
    const ctrl = new AbortController();
    const kill = setTimeout(() => ctrl.abort(), 75000);
    const slow = setTimeout(App.slowMsg, 3500);
    try {
      const r = await fetch(BASE + path, {
        method, signal: ctrl.signal,
        headers: { Authorization: "Bearer " + t, "Content-Type": "application/json" },
        body: body ? JSON.stringify(body) : undefined,
      });
      if (raw && r.ok) return r;
      const data = await r.json().catch(() => ({}));
      if (!r.ok) {
        const err = new A.ApiError(r.status, data.error || "http", data.message || "Сервер ответил ошибкой " + r.status + ".");
        err.data = data;
        throw err;
      }
      return data;
    } catch (e) {
      if (e instanceof A.ApiError) throw e;
      if (e.name === "AbortError") throw new A.ApiError(0, "timeout", "Сервер конспектов не ответил за минуту. Попробуйте ещё раз.");
      throw new A.ApiError(0, "network", "Нет связи с сервером конспектов.");
    } finally {
      clearTimeout(kill); clearTimeout(slow);
    }
  }
  const img = (path) => (path ? BASE + path : null);

  function fatal(e) {
    if (e && (e.status === 401 || e.code === "banned")) { App.handleError(e); return true; }
    return false;
  }
  function bodyError(e, retryAct) {
    if (fatal(e)) return;
    body().innerHTML = `<div class="empty"><span class="bird bird--dove"></span><h3>Не получилось</h3><p>${esc(e.message)}</p>
      <p style="margin-top:1rem"><button class="btn btn--line" type="button" data-act="${retryAct}">Попробовать ещё раз</button></p></div>`;
  }

  /* ───────────── каркас вкладки ───────────── */
  const body = () => $("#st-body");

  function plural(n, a, b, c) { return App.plural(n, a, b, c); }
  function sizeLabel(bytes) {
    if (!bytes) return "";
    const mb = bytes / 1048576;
    return mb >= 0.1 ? mb.toFixed(1).replace(".", ",") + " МБ" : Math.max(1, Math.round(bytes / 1024)) + " КБ";
  }
  function filesBadge(m) {
    if (m.is_link) return "Ссылка на облако";
    const n = m.files.length;
    if (n > 1) return `${n} ${plural(n, "файл", "файла", "файлов")}`;
    const name = (m.files[0] && m.files[0].name) || "";
    const ext = (name.match(/\.([a-z0-9]{2,5})$/i) || [])[1];
    return ext ? ext.toUpperCase() : "Файл";
  }

  function render() {
    App.setHead({
      title: "Конспекты",
      sub: ST.me ? `Лента: ${ST.me.course_label.toLowerCase()}` : "AvesStudy",
      chip: { act: "st-upload", label: "Загрузить" },
    });
    const seg = `<div class="seg" role="group" aria-label="Раздел">
        <button type="button" data-act="st-mode" data-m="notes" aria-pressed="${ST.mode === "notes"}">Конспекты</button>
        <button type="button" data-act="st-mode" data-m="photos" aria-pressed="${ST.mode === "photos"}">Фото дня</button>
      </div>`;
    const tools = ST.mode === "notes"
      ? `<form class="st-search" id="st-sform" role="search"><label class="visually-hidden" for="st-q">Найти конспект</label>
           <input class="field" id="st-q" type="search" enterkeyhint="search" autocomplete="off" placeholder="Найти: «микра 3 курс»"></form>
         <button class="chip" type="button" data-act="st-favs">★ Избранное</button>`
      : "";
    App.view.innerHTML = `<div class="st-top">${seg}${tools}</div><div id="st-body"></div>`;
    const f = $("#st-sform");
    if (f) f.addEventListener("submit", (e) => { e.preventDefault(); search($("#st-q").value); });
    ST.mode === "notes" ? showNotes() : showPhotos();
  }

  async function ensureMe() {
    if (ST.me) return;
    ST.me = await api("/api/study/me");
    App.setHead({ title: "Конспекты", sub: `Лента: ${ST.me.course_label.toLowerCase()}`, chip: { act: "st-upload", label: "Загрузить" } });
  }

  /* ───────────── лента конспектов ───────────── */
  async function fill() {
    if (ST.fetching) return ST.fetching;
    if (ST.done) return;
    const exclude = [ST.cur && ST.cur.id, ...ST.queue.map((m) => m.id)].filter(Boolean).join(",");
    ST.fetching = api(`/api/study/feed?limit=5${exclude ? "&exclude=" + exclude : ""}`)
      .then((r) => {
        if (!r.items.length) ST.done = true;
        ST.queue.push(...r.items);
        r.items.forEach((m) => { if (m.preview) new Image().src = img(m.preview); });
      })
      .finally(() => { ST.fetching = null; });
    return ST.fetching;
  }

  async function showNotes() {
    if (ST.list) return paintList();
    if (ST.single) return paintCard(ST.single, true);
    if (!ST.cur) {
      body().innerHTML = App.loadingHTML("Подбираем конспекты для вашего курса…");
      try {
        await ensureMe();
        if (!ST.queue.length) await fill();
        ST.cur = ST.queue.shift() || null;
        if (ST.cur) markView(ST.cur);
      } catch (e) { return bodyError(e, "st-retry"); }
    }
    if (S.tab !== "study" || ST.mode !== "notes") return;
    ST.cur ? paintCard(ST.cur, false) : paintEmpty();
  }

  function markView(m) { api(`/api/study/materials/${m.id}/view`, { method: "POST" }).catch(() => {}); }

  function cardHTML(m, single) {
    const media = m.preview
      ? `<img src="${esc(img(m.preview))}" alt="Первая страница: ${esc(m.title)}" class="is-doc" loading="eager" draggable="false" data-fallback>`
      : `<div class="media-wait"><div><span class="bird bird--dove"></span>Превью готовится — загляните чуть позже</div></div>`;
    const author = m.author.public
      ? `<button class="card__author" type="button" data-act="st-author" data-id="${m.id}">${esc(m.author.name)}</button>`
      : `<button class="card__author" type="button" disabled>${esc(m.author.name)}</button>`;
    return `<article class="card enter" id="st-card" data-id="${m.id}">
        <div class="card__media">${media}<span class="card__badge">${esc(filesBadge(m))}</span></div>
        <div class="card__body">
          <p class="card__meta">${esc(m.subject)}, ${esc(m.course_label.toLowerCase())}</p>
          <h2 class="card__title">${esc(m.title)}</h2>
          ${m.description ? `<p class="card__desc">${esc(m.description)}</p>` : ""}
          <p class="card__meta">Автор: ${author}</p>
        </div>
      </article>
      <div class="acts">
        <button class="round" type="button" data-act="st-react" data-t="ice" aria-pressed="${m.my_reaction === "ice"}" aria-label="Льдинка: так себе"><span class="emo">🧊</span><span>${m.ice}</span></button>
        <button class="round round--big" type="button" data-act="st-fav" aria-pressed="${!!m.favorite}" aria-label="${m.favorite ? "Убрать из избранного" : "В избранное"}"><span class="emo">${m.favorite ? "★" : "☆"}</span></button>
        <button class="round" type="button" data-act="st-react" data-t="fire" aria-pressed="${m.my_reaction === "fire"}" aria-label="Огонёк: полезно"><span class="emo">🔥</span><span>${m.fire}</span></button>
      </div>
      <div class="cta">
        <button class="btn btn--solid" type="button" data-act="st-get">${m.is_link ? "Открыть ссылку" : "Получить"}</button>
        ${single
          ? `<button class="btn btn--line" type="button" data-act="st-back">Назад</button>`
          : `<button class="btn btn--line" type="button" data-act="st-next">Дальше</button>`}
      </div>
      ${single ? "" : `<p class="st-hint">Смахните карточку, чтобы листать</p>`}
      <p class="st-hint"><button class="link-btn" type="button" data-act="st-report">Пожаловаться</button></p>`;
  }

  function paintCard(m, single) {
    body().innerHTML = `<div class="deck">${cardHTML(m, single)}</div>`;
    const im = $("#st-card img[data-fallback]");
    if (im) im.addEventListener("error", () => {
      im.parentElement.insertAdjacentHTML("afterbegin", `<div class="media-wait"><div><span class="bird bird--dove"></span>Превью не загрузилось</div></div>`);
      im.remove();
    });
    if (!single) bindSwipe($("#st-card"));
  }

  function paintEmpty() {
    const scope = ST.me ? ST.me.course_label.toLowerCase() : "вашего курса";
    body().innerHTML = `<div class="empty"><span class="bird bird--dove"></span>
      <h3>Вы посмотрели всё</h3>
      <p>Лента показывает конспекты только для: ${esc(scope)} и общие. Другие курсы — через поиск.</p>
      <div class="stack" style="max-width:320px;margin:1.25rem auto 0">
        <button class="btn btn--solid" type="button" data-act="st-upload">Загрузить свой конспект</button>
        <button class="btn btn--line" type="button" data-act="st-restart">Смотреть сначала</button>
      </div></div>`;
  }

  async function next(dir) {
    const card = $("#st-card");
    if (card) {
      card.classList.add(dir === "right" ? "fly-right" : "fly-left");
      App.haptic("select");
      await new Promise((r) => setTimeout(r, 220));
    }
    if (ST.queue.length < 2 && !ST.done) {
      if (!ST.queue.length) body().innerHTML = App.loadingHTML("Ищем ещё конспекты…");
      try { await fill(); } catch (e) { if (!ST.queue.length) return bodyError(e, "st-retry"); }
    }
    ST.cur = ST.queue.shift() || null;
    if (ST.cur) markView(ST.cur);
    if (S.tab !== "study" || ST.mode !== "notes" || ST.list || ST.single) return;
    ST.cur ? paintCard(ST.cur, false) : paintEmpty();
    window.scrollTo({ top: 0, behavior: "smooth" });
  }

  function bindSwipe(card) {
    if (!card) return;
    let x0 = 0, y0 = 0, dx = 0, active = false, horiz = null;
    card.addEventListener("pointerdown", (e) => {
      if (e.target.closest("button, a")) return;
      if (e.pointerType === "mouse") e.preventDefault();
      active = true; horiz = null; x0 = e.clientX; y0 = e.clientY; dx = 0;
    });
    card.addEventListener("pointermove", (e) => {
      if (!active) return;
      dx = e.clientX - x0;
      const dy = e.clientY - y0;
      if (horiz === null && (Math.abs(dx) > 8 || Math.abs(dy) > 8)) horiz = Math.abs(dx) > Math.abs(dy);
      if (!horiz) return;
      card.classList.add("is-dragging");
      card.setPointerCapture && card.setPointerCapture(e.pointerId);
      card.style.transform = `translateX(${dx}px) rotate(${dx / 25}deg)`;
    });
    const end = () => {
      if (!active) return;
      active = false;
      card.classList.remove("is-dragging");
      if (horiz && Math.abs(dx) > 90) { card.style.transform = ""; next(dx > 0 ? "right" : "left"); }
      else card.style.transform = "";
    };
    card.addEventListener("pointerup", end);
    card.addEventListener("pointercancel", end);
  }

  function current() { return ST.single || ST.cur; }

  function repaintActs(m) {
    const acts = $(".acts");
    if (!acts) return;
    const tmp = document.createElement("div");
    tmp.innerHTML = cardHTML(m, !!ST.single);
    acts.replaceWith(tmp.querySelector(".acts"));
  }

  /* ───────────── списки: поиск, избранное ───────────── */
  async function search(q) {
    q = (q || "").trim();
    if (q.length < 2) return App.toast("Введите хотя бы два символа");
    body().innerHTML = App.loadingHTML("Ищем…");
    try {
      const r = await api("/api/study/search?q=" + encodeURIComponent(q));
      ST.list = { title: `Поиск: «${q}»`, items: r.items, empty: "Ничего не нашлось. Попробуйте название предмета или фамилию лектора." };
      ST.single = null;
      paintList();
    } catch (e) { bodyError(e, "st-back"); }
  }

  function paintList() {
    const L = ST.list;
    const items = L.items.map((m, i) => `<li><button class="mitem" type="button" data-act="st-open" data-i="${i}">
        ${m.preview ? `<img src="${esc(img(m.preview))}" alt="" loading="lazy">` : `<span class="ph"></span>`}
        <span><b>${esc(m.title)}</b><small>${esc(m.subject)}, ${esc(m.course_label.toLowerCase())}. 🔥 ${m.fire}, скачиваний ${m.downloads}</small></span>
      </button></li>`).join("");
    body().innerHTML = `<div class="back-row"><button class="link-btn" type="button" data-act="st-back">← К ленте</button></div>
      <div class="result-title"><h2>${esc(L.title)}</h2></div>
      ${L.items.length ? `<ul class="mlist">${items}</ul>` : App.emptyHTML("Пусто", L.empty)}`;
  }

  /* ───────────── получить файлы ───────────── */
  function openGet(m) {
    if (m.is_link) { App.openExt(m.link); return; }
    const canDirect = !App.inTg;
    const rows = m.files.map((f) => `<li><span class="f-name">${esc(f.name)}</span><span class="f-size">${sizeLabel(f.size)}</span>
        ${canDirect && f.direct ? `<button class="link-btn" type="button" data-act="st-dl" data-i="${f.index}">Скачать</button>` : ""}</li>`).join("");
    App.openSheet(`<div class="sheet__head"><h3>${esc(m.title)}</h3>
        <button class="icon-btn" type="button" data-act="sheet-close" aria-label="Закрыть"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round"><path d="M6 6l12 12M18 6L6 18"/></svg></button></div>
      <div class="sheet__body">
        <ul class="files">${rows}</ul>
        <div class="stack">
          <button class="btn btn--solid" type="button" data-act="st-send">${m.files.length > 1 ? "Прислать все файлы в Telegram" : "Прислать в Telegram"}</button>
        </div>
        <p class="st-hint" style="margin-top:.8rem">Бот конспектов пришлёт файлы в личные сообщения — так открываются файлы любого размера.</p>
      </div>`);
  }

  async function send(m) {
    const btn = $('[data-act="st-send"]');
    if (btn) { btn.disabled = true; btn.textContent = "Отправляем…"; }
    try {
      await api(`/api/study/materials/${m.id}/send`, { method: "POST" });
      App.closeSheet(); App.haptic("success"); App.toast("Готово — файлы в чате с ботом конспектов");
    } catch (e) {
      if (fatal(e)) return;
      if (e.code === "start_bot") {
        const bot = (e.data && e.data.bot) || CFG.bot;
        $(".sheet__body .stack").innerHTML = `<p style="margin:0 0 .8rem">${esc(e.message)}</p>
          <button class="btn btn--solid" type="button" data-act="st-open-bot">Открыть @${esc(bot)}</button>
          <button class="btn btn--line" type="button" data-act="st-send">Я нажал «Старт», прислать</button>`;
        return;
      }
      App.toast(e.message);
      if (btn) { btn.disabled = false; btn.textContent = "Прислать в Telegram"; }
    }
  }

  async function download(m, idx) {
    App.toast("Скачиваем…");
    try {
      const r = await api(`/api/study/materials/${m.id}/file/${idx}`, { raw: true });
      const blob = await r.blob();
      const f = m.files[idx];
      const a = document.createElement("a");
      a.href = URL.createObjectURL(blob);
      a.download = (f && f.name) || "file";
      document.body.appendChild(a); a.click(); a.remove();
      setTimeout(() => URL.revokeObjectURL(a.href), 30000);
    } catch (e) { if (!fatal(e)) App.toast(e.message); }
  }

  /* ───────────── автор ───────────── */
  async function openAuthor(mid) {
    App.openSheet(`<div class="sheet__body">${App.loadingHTML("Открываем профиль…")}</div>`);
    try {
      const a = await api(`/api/study/materials/${mid}/author`);
      ST.authorItems = a.materials;
      $("#sheet").innerHTML = `<div class="sheet__head"><h3>${esc(a.name)}</h3>
          <button class="icon-btn" type="button" data-act="sheet-close" aria-label="Закрыть"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round"><path d="M6 6l12 12M18 6L6 18"/></svg></button></div>
        <div class="sheet__body">
          ${a.course_label ? `<p class="card__meta">${esc(a.course_label)}</p>` : ""}
          <div class="author-stats">
            <div><b>${a.karma}</b><span>карма</span></div>
            <div><b>${a.uploads}</b><span>${plural(a.uploads, "конспект", "конспекта", "конспектов")}</span></div>
            <div><b>${a.fires}</b><span>огоньков</span></div>
          </div>
          ${a.username
            ? `<div class="stack"><button class="btn btn--solid" type="button" data-act="st-open-url" data-url="https://t.me/${esc(a.username)}">Написать @${esc(a.username)}</button></div>`
            : `<p class="st-hint">У автора нет публичного @username — написать ему нельзя.</p>`}
          <p class="section-label">Конспекты автора</p>
          <ul class="mlist" style="padding:0">${a.materials.map((m, i) => `<li><button class="mitem" type="button" data-act="st-author-open" data-i="${i}">
            ${m.preview ? `<img src="${esc(img(m.preview))}" alt="" loading="lazy">` : `<span class="ph"></span>`}
            <span><b>${esc(m.title)}</b><small>${esc(m.subject)}. 🔥 ${m.fire}</small></span></button></li>`).join("")}</ul>
        </div>`;
    } catch (e) {
      App.closeSheet();
      if (!fatal(e)) App.toast(e.message);
    }
  }

  /* ───────────── фото дня ───────────── */
  async function fillPhotos() {
    const P = ST.ph;
    if (P.fetching || P.done) return P.fetching;
    const exclude = [P.cur && P.cur.id, ...P.queue.map((p) => p.id)].filter(Boolean).join(",");
    P.fetching = api(`/api/study/photos/feed?limit=5${exclude ? "&exclude=" + exclude : ""}`)
      .then((r) => { if (!r.items.length) P.done = true; P.queue.push(...r.items); r.items.forEach((p) => { new Image().src = img(p.image); }); })
      .finally(() => { P.fetching = null; });
    return P.fetching;
  }

  async function showPhotos() {
    const P = ST.ph;
    if (P.day === undefined || (!P.cur && !P.done)) {
      body().innerHTML = App.loadingHTML("Загружаем фото…");
      try {
        if (P.day === undefined) P.day = (await api("/api/study/photos/day")).photo;
        if (!P.cur) {
          if (!P.queue.length) await fillPhotos();
          P.cur = P.queue.shift() || null;
          if (P.cur) api(`/api/study/photos/${P.cur.id}/view`, { method: "POST" }).catch(() => {});
        }
      } catch (e) { return bodyError(e, "st-retry"); }
    }
    if (S.tab === "study" && ST.mode === "photos") paintPhotos();
  }

  function reactBar(p) {
    const b = (t, emo, n, label) => `<button class="round" type="button" data-act="st-ph-react" data-id="${p.id}" data-t="${t}" aria-pressed="${p.my_reaction === t}" aria-label="${label}"><span class="emo">${emo}</span><span>${n}</span></button>`;
    return `<div class="acts">${b("heart", "❤️", p.heart, "Нравится")}${b("laugh", "😂", p.laugh, "Смешно")}${b("fire", "🔥", p.fire, "Огонь")}</div>`;
  }

  function photoBlock(p) {
    return `<img class="photo" src="${esc(img(p.image))}" alt="${esc(p.caption || "Фото студента")}">
      ${p.caption ? `<p class="photo-cap">${esc(p.caption)}</p>` : ""}
      <p class="photo-by">${esc(p.author)}</p>${reactBar(p)}`;
  }

  function paintPhotos() {
    const P = ST.ph;
    const day = P.day
      ? `<section class="pod" data-ph="${P.day.id}"><div class="pod__label">🏆 Фото дня</div>${photoBlock(P.day)}</section>`
      : "";
    const feed = P.cur
      ? `<section class="pod" data-ph="${P.cur.id}" id="st-ph-cur">${photoBlock(P.cur)}
           <div class="cta"><button class="btn btn--solid" type="button" data-act="st-ph-next">Дальше</button>
           <button class="btn btn--line" type="button" data-act="st-ph-report">⚠</button></div></section>`
      : `<div class="empty"><span class="bird bird--dove"></span><h3>Вы посмотрели все фото</h3>
           <p>Загрузите своё — лучшее фото за день попадает наверх.</p>
           <div class="stack" style="max-width:320px;margin:1.25rem auto 0">
             <button class="btn btn--solid" type="button" data-act="st-upload-photo">Загрузить фото</button>
             <button class="btn btn--line" type="button" data-act="st-ph-restart">Смотреть сначала</button></div></div>`;
    body().innerHTML = `${day}<p class="section-label">${P.day ? "Ещё фото" : "Лента фото"}</p>${feed}
      <p class="st-hint" style="margin-top:1rem"><button class="link-btn" type="button" data-act="st-upload-photo">Загрузить своё фото через бота</button></p>`;
  }

  function findPhoto(id) {
    const P = ST.ph;
    return [P.day, P.cur].find((p) => p && p.id === id);
  }

  /* ───────────── действия ───────────── */
  Object.assign(actions, {
    "st-mode"(el) { ST.mode = el.dataset.m; App.haptic("select"); render(); },
    "st-retry"() { render(); },
    "st-upload"() { App.openExt(`https://t.me/${CFG.bot}`); },
    "st-upload-photo"() { App.openExt(`https://t.me/${CFG.bot}`); App.toast("В боте нажмите «📸 Фото дня» → «Загрузить»"); },
    "st-open-bot"() { App.openExt(`https://t.me/${CFG.bot}?start=web`); },
    "st-open-url"(el) { App.openExt(el.dataset.url); },
    "st-next"() { next("left"); },
    async "st-restart"() {
      body().innerHTML = App.loadingHTML();
      try {
        await api("/api/study/feed/reset", { method: "POST" });
        Object.assign(ST, { queue: [], cur: null, done: false });
        showNotes();
      } catch (e) { bodyError(e, "st-retry"); }
    },
    async "st-react"(el) {
      const m = current(); if (!m) return;
      el.classList.remove("pop"); void el.offsetWidth; el.classList.add("pop");
      App.haptic("select");
      try {
        const r = await api(`/api/study/materials/${m.id}/react`, { method: "POST", body: { type: el.dataset.t } });
        Object.assign(m, { fire: r.fire, ice: r.ice, my_reaction: r.my_reaction });
        repaintActs(m);
      } catch (e) { if (!fatal(e)) App.toast(e.message); }
    },
    async "st-fav"() {
      const m = current(); if (!m) return;
      try {
        const r = await api(`/api/study/materials/${m.id}/favorite`, { method: "POST" });
        m.favorite = r.favorite; repaintActs(m);
        App.toast(r.favorite ? "В избранном ★" : "Убрано из избранного");
      } catch (e) { if (!fatal(e)) App.toast(e.message); }
    },
    "st-get"() { const m = current(); if (m) openGet(m); },
    "st-send"() { const m = current(); if (m) send(m); },
    "st-dl"(el) { const m = current(); if (m) download(m, +el.dataset.i); },
    "st-author"(el) { openAuthor(+el.dataset.id); },
    "st-author-open"(el) {
      const m = (ST.authorItems || [])[+el.dataset.i]; if (!m) return;
      App.closeSheet(); ST.single = m; ST.list = ST.list || null; paintCard(m, true); window.scrollTo(0, 0);
    },
    async "st-report"() {
      const m = current(); if (!m) return;
      try { await api("/api/study/report", { method: "POST", body: { kind: "material", id: m.id } }); App.toast("Жалоба отправлена модераторам"); }
      catch (e) { if (!fatal(e)) App.toast(e.message); }
    },
    async "st-favs"() {
      body().innerHTML = App.loadingHTML();
      try {
        const r = await api("/api/study/favorites");
        ST.list = { title: "Избранное", items: r.items, empty: "Отмечайте конспекты звёздочкой — они появятся здесь." };
        ST.single = null; paintList();
      } catch (e) { bodyError(e, "st-back"); }
    },
    "st-open"(el) { const m = ST.list && ST.list.items[+el.dataset.i]; if (m) { ST.single = m; const keep = ST.list; ST.list = null; ST.backTo = keep; paintCard(m, true); window.scrollTo(0, 0); } },
    "st-back"() {
      if (ST.single && ST.backTo) { ST.single = null; ST.list = ST.backTo; ST.backTo = null; return paintList(); }
      ST.single = null; ST.list = null; ST.backTo = null; showNotes();
    },

    async "st-ph-react"(el) {
      const p = findPhoto(+el.dataset.id); if (!p) return;
      el.classList.remove("pop"); void el.offsetWidth; el.classList.add("pop");
      App.haptic("select");
      try {
        const r = await api(`/api/study/photos/${p.id}/react`, { method: "POST", body: { type: el.dataset.t } });
        [ST.ph.day, ST.ph.cur].forEach((x) => { if (x && x.id === p.id) Object.assign(x, r); });
        document.querySelectorAll(`[data-ph="${p.id}"] .acts`).forEach((bar) => {
          const tmp = document.createElement("div"); tmp.innerHTML = reactBar(Object.assign({}, p, r)); bar.replaceWith(tmp.firstElementChild);
        });
      } catch (e) { if (!fatal(e)) App.toast(e.message); }
    },
    async "st-ph-next"() {
      const P = ST.ph;
      const cur = $("#st-ph-cur");
      if (cur) { cur.style.transition = "opacity .2s"; cur.style.opacity = "0"; }
      if (P.queue.length < 2 && !P.done) { try { await fillPhotos(); } catch (e) { return bodyError(e, "st-retry"); } }
      P.cur = P.queue.shift() || null;
      if (P.cur) api(`/api/study/photos/${P.cur.id}/view`, { method: "POST" }).catch(() => {});
      App.haptic("select");
      paintPhotos();
      const c = $("#st-ph-cur"); if (c) c.scrollIntoView({ behavior: "smooth", block: "start" });
    },
    async "st-ph-restart"() {
      body().innerHTML = App.loadingHTML();
      try {
        await api("/api/study/photos/reset", { method: "POST" });
        Object.assign(ST.ph, { queue: [], cur: null, done: false });
        showPhotos();
      } catch (e) { bodyError(e, "st-retry"); }
    },
    async "st-ph-report"() {
      const p = ST.ph.cur; if (!p) return;
      try { await api("/api/study/report", { method: "POST", body: { kind: "photo", id: p.id } }); App.toast("Жалоба отправлена модераторам"); }
      catch (e) { if (!fatal(e)) App.toast(e.message); }
    },
  });

  window.AvesTabs = Object.assign(window.AvesTabs || {}, {
    study() {
      if (!BASE) { App.view.innerHTML = App.emptyHTML("Раздел не настроен", "В config.js не указан адрес бота конспектов."); return; }
      render();
    },
  });

  // Смена аккаунта / факультета — начинаем с чистого листа
  let lastUser = null;
  document.addEventListener("click", () => {
    const uid = S.user && S.user.telegram_id;
    if (uid !== lastUser) {
      lastUser = uid;
      Object.assign(ST, { me: null, queue: [], cur: null, done: false, list: null, single: null,
        ph: { day: undefined, queue: [], cur: null, done: false, fetching: null } });
    }
  }, true);
})();
