/* Вкладка «Смены»: лента подработок под расписание студента, окна недели, занятые часы, отклик.
   Данные — из AvesWork (/api/work/*), вход — тот же сессионный токен, что у расписания. */
(function () {
  "use strict";
  const App = window.AvesApp;
  if (!App) return;
  const { S, A, C, esc, actions } = App;
  const CFG = C.work || {};
  // Адрес можно задать в config.js (work.api); по умолчанию — сервис AvesWork на Render
  const BASE = (CFG.api || "https://aveswork.onrender.com").replace(/\/$/, "");
  const $ = (s, r = document) => r.querySelector(s);

  const MONTHS = ["января", "февраля", "марта", "апреля", "мая", "июня", "июля", "августа", "сентября", "октября", "ноября", "декабря"];
  const DAYS = ["Понедельник", "Вторник", "Среда", "Четверг", "Пятница", "Суббота", "Воскресенье"];
  const DSHORT = ["Пн", "Вт", "Ср", "Чт", "Пт", "Сб", "Вс"];
  const FROM = 8 * 60, TO = 22 * 60;

  let loadedAt = 0, lastUser = null;

  const W = {
    me: null, feed: null, loading: null,
    mode: "fits",     // fits | all
    day: null,        // выбранный день в полосе недели (ISO) или null
    open: null,       // id смены в листе
    deep: null,       // ?shift= из ссылки в боте
    view: A.store.get("aves.wk.view") === "hours" ? "hours" : "feed",   // «Смены» или «Мои часы»
    hours: null,      // /api/work/hours
    hweek: 0,         // неделя в «Моих часах»: 0 — эта
    rem: null,        // напоминания (из бота расписания)
    remDraft: "",
  };

  /* ───────────── сеть ───────────── */
  async function api(path, { method = "GET", body } = {}) {
    const t = A.getToken();
    if (!t) throw new A.ApiError(401, "unauthorized", "Нужно войти через Telegram.");
    const ctrl = new AbortController();
    const kill = setTimeout(() => ctrl.abort(), 75000);
    const slow = setTimeout(App.slowMsg, 3500);
    const sep = path.includes("?") ? "&" : "?";
    try {
      const r = await fetch(BASE + path + (S.faculty ? sep + "f=" + encodeURIComponent(S.faculty) : ""), {
        method, signal: ctrl.signal,
        headers: { Authorization: "Bearer " + t, "Content-Type": "application/json" },
        body: body ? JSON.stringify(body) : undefined,
      });
      const data = await r.json().catch(() => ({}));
      if (!r.ok) throw new A.ApiError(r.status, data.error || "http", data.message || "Сервер ответил ошибкой " + r.status + ".");
      return data;
    } catch (e) {
      if (e instanceof A.ApiError) throw e;
      if (e.name === "AbortError") throw new A.ApiError(0, "timeout", "Сервер подработок не ответил за минуту. Попробуйте ещё раз.");
      throw new A.ApiError(0, "network", "Нет связи с сервером подработок.");
    } finally { clearTimeout(kill); clearTimeout(slow); }
  }

  /* ───────────── мелочи ───────────── */
  const parseISO = (s) => { const [y, m, d] = s.split("-").map(Number); return new Date(Date.UTC(y, m - 1, d)); };
  const wd = (s) => (parseISO(s).getUTCDay() + 6) % 7;
  const human = (s) => { const d = parseISO(s); return d.getUTCDate() + " " + MONTHS[d.getUTCMonth()]; };
  const toMin = (hhmm) => { const [h, m] = hhmm.split(":").map(Number); return h * 60 + m; };
  const pct = (m) => ((Math.min(Math.max(m, FROM), TO) - FROM) / (TO - FROM)) * 100;
  const hours = (h) => (Number.isInteger(h) ? h : String(h).replace(".", ",")) + " ч";
  const plural = App.plural;
  // Через какого бота приходят короткие уведомления (человек может быть в нескольких ботах)
  const relayBot = () => {
    const f = W.me && W.me.settings.relay_faculty;
    return (f && (C.faculties[f] || {}).bot) || (C.faculties[S.faculty] || {}).bot;
  };

  function dayTitle(iso) {
    const today = W.feed && W.feed.today;
    if (iso === today) return "Сегодня";
    if (today) {
      const diff = Math.round((parseISO(iso) - parseISO(today)) / 86400000);
      if (diff === 1) return "Завтра";
    }
    return DAYS[wd(iso)];
  }

  function fatal(e) {
    if (e && (e.status === 401 || e.code === "banned")) { App.handleError(e); return true; }
    return false;
  }
  const body = () => $("#wk-body");

  function bodyError(e) {
    if (fatal(e)) return;
    if (e && e.code === "closed_beta") {
      body().innerHTML = App.emptyHTML("Скоро", e.message);
      return;
    }
    body().innerHTML = `<div class="empty"><span class="bird bird--dove"></span><h3>Не получилось</h3><p>${esc(e.message)}</p>
      <p style="margin-top:1rem"><button class="btn btn--line" type="button" data-act="wk-retry">Попробовать ещё раз</button></p></div>`;
  }

  /* ───────────── загрузка ───────────── */
  async function load(force) {
    if (W.feed && W.me && !force) return;
    if (!W.loading) {
      W.loading = Promise.all([api("/api/work/me"), api("/api/work/feed")])
        .then(([me, feed]) => { W.me = me; W.feed = feed; loadedAt = Date.now(); lastUser = S.user && S.user.telegram_id; })
        .finally(() => { W.loading = null; });
    }
    return W.loading;
  }

  function head() {
    const sub = W.me && W.me.mode === "test" ? "Тестовый режим" : "Под ваше расписание";
    App.setHead({ title: W.view === "hours" ? "Мои часы" : "Смены", sub, chip: { act: "wk-settings", label: "Настройки" } });
  }

  async function render(force) {
    head();
    App.view.innerHTML = `<div id="wk-body"></div>`;
    if (W.view === "hours") { if (force) W.hours = null; return renderHours(force); }
    if (!W.feed || force) {
      body().innerHTML = App.loadingHTML("Сверяем смены с вашим расписанием…");
      try { await load(force); } catch (e) { return bodyError(e); }
    }
    if (S.tab !== "work" || W.view !== "feed") return;
    head();
    paint();
    if (W.deep) { const id = W.deep; W.deep = null; openShift(id, true); }
  }

  /* ───────────── отрисовка ───────────── */
  function visibleItems() {
    let items = W.feed.items;
    if (W.mode === "fits") items = items.filter((i) => i.fits);
    if (W.day) items = items.filter((i) => i.date === W.day);
    return items;
  }

  function weekHTML() {
    const byDay = {};
    W.feed.items.forEach((i) => (byDay[i.date] = byDay[i.date] || []).push(i));
    const nowMin = toMin(W.feed.now);
    const ticks = [8, 12, 16, 20].map((h) => `<span style="left:${pct(h * 60)}%">${h}</span>`).join("");
    const rows = W.feed.week.map((d) => {
      const lessons = d.lessons.map((l) => `<i class="b b--lesson" title="${esc(l.label || "")}" style="left:${pct(toMin(l.start))}%;width:${pct(toMin(l.end)) - pct(toMin(l.start))}%"></i>`).join("");
      const busy = d.busy.map((b) => `<i class="b b--busy" style="left:${pct(toMin(b.start))}%;width:${pct(toMin(b.end)) - pct(toMin(b.start))}%"></i>`).join("");
      const free = d.free.map((f) => `<i class="b b--free" style="left:${pct(toMin(f.start))}%;width:${pct(toMin(f.end)) - pct(toMin(f.start))}%"></i>`).join("");
      const shifts = (byDay[d.date] || []).filter((i) => W.mode === "all" || i.fits || i.applied)
        .map((i) => `<i class="b b--shift${i.fits || i.applied ? "" : " is-off"}" style="left:${pct(toMin(i.start))}%;width:${Math.max(1.5, pct(toMin(i.end)) - pct(toMin(i.start)))}%"></i>`).join("");
      const now = d.date === W.feed.today && nowMin > FROM && nowMin < TO ? `<i class="now" style="left:${pct(nowMin)}%"></i>` : "";
      const n = (byDay[d.date] || []).filter((i) => i.fits).length;
      const dnum = parseISO(d.date).getUTCDate();
      return `<button class="wk-row" type="button" data-act="wk-day" data-date="${d.date}" aria-pressed="${W.day === d.date}"
          aria-label="${DAYS[wd(d.date)]}, ${human(d.date)}: ${n ? n + " " + plural(n, "смена", "смены", "смен") + " под вас" : "смен под вас нет"}">
          <span class="wk-row__d"><b>${DSHORT[wd(d.date)]}</b> ${dnum}</span>
          <span class="wk-row__t">${free}${lessons}${busy}${shifts}${now}</span>
          <span class="wk-row__n">${n || ""}</span>
        </button>`;
    }).join("");
    return `<section class="wk-week" aria-label="Ваши окна на неделю">
        <div class="wk-week__ticks" aria-hidden="true"><span></span><span class="wk-week__axis">${ticks}</span><span></span></div>
        ${rows}
        ${W.feed.schedules_used && W.feed.schedules_used.length > 1 ? `<p class="wk-legend">Учитываем пары: ${W.feed.schedules_used.map(esc).join(", ")}</p>` : ""}
        <p class="wk-legend"><span><i class="b--free"></i>свободно</span><span><i class="b--lesson"></i>пары</span><span><i class="b--busy"></i>ваши дела</span><span><i class="b--shift"></i>смена</span></p>
      </section>`;
  }

  function noticeHTML() {
    const me = W.me, st = me.settings;
    if (!st.search_active) {
      return `<div class="wk-note is-warn"><span>Поиск на паузе — новые смены не приходят.</span><button class="link-btn" type="button" data-act="wk-resume">Возобновить</button></div>`;
    }
    if (!W.feed.has_schedule) {
      return `<div class="wk-note"><span>Не нашли вашу группу в ботах расписания — подбираем только по вашим занятым часам.</span></div>`;
    }
    let how;
    if (st.bot_connected && st.bot_notifications) how = `Новые смены присылает @${esc(me.bot || "AvesWork")}`;
    else if (st.relay_enabled && st.relay_available && relayBot()) how = `Новые смены — одной строкой в @${esc(relayBot())}, не чаще раза в день`;
    else if (st.relay_enabled && !st.relay_available) how = "Уведомления о сменах скоро включим для всех";
    else how = "Уведомления о новых сменах выключены";
    return `<div class="wk-note"><span>${how}</span><button class="link-btn" type="button" data-act="wk-settings">Настроить</button></div>`;
  }

  function cardHTML(i) {
    const meta = [i.company, i.place].filter(Boolean).map(esc).join(" · ");
    const tags = [
      i.pay ? `<span class="wk-pay">${esc(i.pay)}</span>` : `<span class="tag">Оплата по договорённости</span>`,
      i.new ? `<span class="tag tag--new">Новая</span>` : "",
      i.demo ? `<span class="tag">Демо</span>` : "",
      i.batch.dates.length > 1 ? `<span class="tag">${i.batch.require_all ? "все " : ""}${i.batch.dates.length} ${plural(i.batch.dates.length, "день", "дня", "дней")}</span>` : "",
    ].join("");
    const fit = i.applied
      ? `<p class="wk-fit is-applied">✓ Вы откликнулись</p>`
      : i.fits
        ? `<p class="wk-fit is-ok">Без пересечений с парами</p>`
        : `<p class="wk-fit is-off">${i.conflict && i.conflict.kind === "shift" ? "Вы уже взяли смену" : "Пересекается"}: ${esc(i.conflict ? i.conflict.label : "")}</p>`;
    return `<li><button class="wk-card${i.fits ? "" : " is-off"}" type="button" data-act="wk-open" data-id="${i.id}">
        <span class="wk-card__time"><b>${esc(i.start)}</b><span>${esc(i.end)}</span><small>${hours(i.hours)}</small></span>
        <span class="wk-card__main">
          <span class="wk-card__title">${esc(i.title)}</span>
          ${meta ? `<span class="wk-card__meta">${meta}</span>` : ""}
          <span class="wk-card__tags">${tags}</span>
          ${fit}
        </span>
      </button></li>`;
  }

  function listHTML() {
    const items = visibleItems();
    if (!items.length) {
      const total = W.feed.items.length, fits = W.feed.items.filter((i) => i.fits).length;
      if (W.day) {
        return App.emptyHTML("В этот день пусто", W.mode === "fits" && total ? "Под ваше расписание в этот день смен нет. Посмотрите все или другой день." : "Работодатели пока не публиковали смены на этот день.");
      }
      if (W.mode === "fits" && total > fits) {
        return App.emptyHTML("Под вас пока ничего", `Есть ${total} ${plural(total, "смена", "смены", "смен")}, но они пересекаются с парами или вашими делами.`) +
          `<div class="wk-center"><button class="btn btn--line" type="button" data-act="wk-mode" data-m="all">Показать все</button></div>`;
      }
      return App.emptyHTML("Смен пока нет", "Работодатели публикуют смены на пиковые часы. Как только появится подходящая — пришлём.");
    }
    const byDate = {};
    items.forEach((i) => (byDate[i.date] = byDate[i.date] || []).push(i));
    return Object.keys(byDate).sort().map((d) =>
      `<p class="day-label">${dayTitle(d)}, ${human(d)}</p><ul class="wk-list">${byDate[d].map(cardHTML).join("")}</ul>`
    ).join("");
  }

  function paint() {
    if (!body()) return;
    const fits = W.feed.items.filter((i) => i.fits).length;
    const total = W.feed.items.length;
    body().innerHTML = `${viewsHTML()}
      <div class="wk-top">
        <div class="seg" role="group" aria-label="Какие смены показывать">
          <button type="button" data-act="wk-mode" data-m="fits" aria-pressed="${W.mode === "fits"}">Под меня${fits ? " · " + fits : ""}</button>
          <button type="button" data-act="wk-mode" data-m="all" aria-pressed="${W.mode === "all"}">Все${total ? " · " + total : ""}</button>
        </div>
        ${W.me.mode === "test" ? `<span class="wk-badge" title="Раздел в тестовом режиме">Тест</span>` : ""}
      </div>
      ${weekHTML()}
      ${noticeHTML()}
      ${W.day ? `<div class="wk-filter">${DAYS[wd(W.day)]}, ${human(W.day)} <button class="link-btn" type="button" data-act="wk-day" data-date="${W.day}">Показать все дни</button></div>` : ""}
      <div id="wk-list">${listHTML()}</div>`;
  }

  /* ───────────── карточка смены ───────────── */
  const BELL = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M6 16.5V11a6 6 0 0 1 12 0v5.5l1.5 1.5h-15z"/><path d="M10 20.5a2 2 0 0 0 4 0"/></svg>';
  const CLOSE = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round"><path d="M6 6l12 12M18 6L6 18"/></svg>';

  function shiftSheet(i) {
    const dates = i.batch.dates.length > 1
      ? `<p class="wk-dates">${i.batch.require_all ? "Нужен человек на все дни: " : "Можно выйти в любой из дней: "}${i.batch.dates.map((d) => `<span class="tag${d === i.date ? " is-on" : ""}">${DSHORT[wd(d)].toLowerCase()} ${parseISO(d).getUTCDate()}</span>`).join(" ")}</p>`
      : "";
    const fit = i.fits
      ? `<p class="wk-fit is-ok">Не пересекается с вашими парами и делами, с запасом 15 минут на дорогу</p>`
      : `<p class="wk-fit is-off">Пересекается: ${esc(i.conflict ? i.conflict.label : "")}</p>`;
    const cta = i.applied
      ? `<p class="wk-done">✓ Вы откликнулись. Работодатель напишет вам в Telegram.</p>
         <button class="btn btn--line" type="button" data-act="wk-withdraw" data-id="${i.id}">Отозвать отклик</button>`
      : `<button class="btn btn--solid" type="button" data-act="wk-apply" data-id="${i.id}">${i.batch.require_all ? "Откликнуться на все дни" : "Откликнуться"}</button>
         <p class="st-hint" style="margin:.7rem 0 0">Работодатель получит ваш Telegram и сам напишет, чтобы договориться.</p>`;
    return `<div class="sheet__head"><h3>${esc(i.title)}</h3>
        <button class="icon-btn" type="button" data-act="sheet-close" aria-label="Закрыть">${CLOSE}</button></div>
      <div class="sheet__body wk-sheet">
        <p class="wk-when"><b>${dayTitle(i.date)}, ${human(i.date)}</b><br>${esc(i.start)}–${esc(i.end)}, ${hours(i.hours)}</p>
        <dl class="wk-facts">
          ${i.company ? `<div><dt>Работодатель</dt><dd>${esc(i.company)}</dd></div>` : ""}
          ${i.place ? `<div><dt>Где</dt><dd>${esc(i.place)}</dd></div>` : ""}
          <div><dt>Оплата</dt><dd>${esc(i.pay || "По договорённости")}</dd></div>
          <div><dt>Сфера</dt><dd>${esc(i.category_title)}</dd></div>
        </dl>
        ${dates}
        ${fit}
        <p class="wk-text">${esc(i.text)}</p>
        <div class="stack">${cta}</div>
      </div>`;
  }

  function openShift(id, fromLink) {
    const i = W.feed && W.feed.items.find((x) => x.id === +id);
    if (!i) { if (fromLink) App.toast("Эту смену уже закрыли"); return; }
    W.open = i.id;
    App.openSheet(shiftSheet(i));
  }

  function repaintSheet() {
    const i = W.open && W.feed.items.find((x) => x.id === W.open);
    if (i && S.picker && S.picker.custom) $("#sheet").innerHTML = shiftSheet(i);
  }

  /* ───────────── настройки (чип в шапке) ───────────── */
  function settingsSheet() {
    const me = W.me, st = me.settings;
    const relayHint = !st.relay_available
      ? "Тестовый режим: пока только для тестеров"
      : relayBot() ? `Одной строкой в @${esc(relayBot())}, не чаще раза в день` : "Одной строкой в боте расписания";
    const botRow = st.bot_connected
      ? `<div class="row"><label class="row__label" for="wk-n3"><span>Подробные карточки</span><small>В @${esc(me.bot || "AvesWork")}, по каждой новой смене</small></label>
           <input class="switch" id="wk-n3" type="checkbox" data-wk-pref="bot_notifications" ${st.bot_notifications ? "checked" : ""}></div>`
      : `<div class="row"><div class="row__label"><span>Подробные карточки</span><small>Отдельный бот AvesWork — по каждой новой смене</small></div>
           <button class="link-btn" type="button" data-act="wk-connect">Подключить</button></div>`;
    return `<div class="sheet__head"><h3>Настройки смен</h3>
        <button class="icon-btn" type="button" data-act="sheet-close" aria-label="Закрыть">${CLOSE}</button></div>
      <div class="sheet__body wk-sheet">
        <div class="row"><label class="row__label" for="wk-n1"><span>Ищу подработку</span><small>Выключите, чтобы смены не приходили</small></label>
          <input class="switch" id="wk-n1" type="checkbox" data-wk-pref="search_active" ${st.search_active ? "checked" : ""}></div>
        <div class="row"><label class="row__label" for="wk-n2"><span>Уведомления о сменах</span><small>${relayHint}</small></label>
          <input class="switch" id="wk-n2" type="checkbox" data-wk-pref="relay_enabled" ${st.relay_enabled ? "checked" : ""}></div>
        ${botRow}
        ${schedulesHTML(me)}
        <div class="row"><div class="row__label"><span>Когда я занят</span><small>${me.busy.length ? me.busy.length + " " + plural(me.busy.length, "интервал", "интервала", "интервалов") : "Тренировки, курсы, сон — смены в это время не предложим"}</small></div>
          <button class="link-btn" type="button" data-act="wk-goto-busy">${me.busy.length ? "Изменить" : "Добавить"}</button></div>
      </div>`;
  }

  // Студент в нескольких ботах расписания (как в AvesStudy): какие пары учитывать и через кого писать
  function schedulesHTML(me) {
    const list = me.schedules || [];
    if (list.length < 2) return "";
    const rows = list.map((x) => `<div class="row"><label class="row__label" for="wk-s-${x.faculty}">
        <span>Пары: ${esc(x.title)}${x.group ? " · " + esc(x.group.tag) : ""}</span><small>Из ${esc(x.bot)}</small></label>
        <input class="switch" id="wk-s-${x.faculty}" type="checkbox" data-wk-sched="${x.faculty}" ${x.used ? "checked" : ""}></div>`).join("");
    const relayable = list.filter((x) => x.relay);
    const seg = relayable.length > 1
      ? `<div class="row"><div class="row__label"><span>Уведомления присылает</span><small>Одно сообщение, без дублей</small></div>
          <div class="seg">${relayable.map((x) => `<button type="button" data-act="wk-relayfac" data-f="${x.faculty}" aria-pressed="${me.settings.relay_faculty === x.faculty}">${esc(x.bot.replace(/^Aves/, ""))}</button>`).join("")}</div></div>`
      : "";
    return `<p class="section-label" style="margin:1.4rem 0 .2rem">Вы в нескольких ботах расписания</p>
      <p class="st-hint" style="text-align:left;margin:0 0 .3rem">Смена подходит, только если вы свободны по каждому включённому расписанию.</p>
      ${rows}${seg}`;
  }

  async function saveSchedules(changed) {
    const off = [...document.querySelectorAll("[data-wk-sched]")].filter((el) => !el.checked).map((el) => el.dataset.wkSched);
    if (off.length === (W.me.schedules || []).length) {
      changed.checked = true;
      App.toast("Оставьте хотя бы одно расписание");
      return;
    }
    try {
      W.me = await api("/api/work/me", { method: "PATCH", body: { schedules_off: off } });
      App.haptic("success"); App.toast("Сохранено — пересчитываем смены и часы");
      repaintSettings(); W.hours = null; refreshFeed();
    } catch (e) { if (!fatal(e)) App.toast(e.message); }
  }

  function openSettings() {
    if (!W.me) return;
    App.openSheet(settingsSheet());
    bindSettings();
  }
  function repaintSettings() {
    if (!S.picker || !S.picker.custom || !$("#wk-n1")) return;
    $("#sheet").innerHTML = settingsSheet();
    bindSettings();
  }
  function bindSettings() {
    document.querySelectorAll("[data-wk-pref]").forEach((el) => el.addEventListener("change", () => setPref(el)));
    document.querySelectorAll("[data-wk-sched]").forEach((el) => el.addEventListener("change", () => saveSchedules(el)));
  }

  async function setPref(el) {
    const key = el.dataset.wkPref, val = el.checked;
    try {
      W.me = await api("/api/work/me", { method: "PATCH", body: { [key]: val } });
      App.haptic("success");
      App.toast({ search_active: val ? "Поиск включён" : "Поиск на паузе", relay_enabled: val ? "Уведомления включены" : "Уведомления выключены", bot_notifications: val ? "Карточки включены" : "Карточки выключены" }[key]);
      if (W.feed) { W.feed.search_active = W.me.settings.search_active; paintQuiet(); }
    } catch (e) { el.checked = !val; if (!fatal(e)) App.toast(e.message); }
  }

  async function refreshFeed() {
    try { W.feed = await api("/api/work/feed"); loadedAt = Date.now(); if (S.tab === "work") paintQuiet(); } catch (_) {}
  }
  function paintQuiet() { if (W.view !== "feed") return; const keep = window.scrollY; paint(); window.scrollTo(0, keep); }

  /* ───────────── «Мои часы»: свободное время недели, занятые часы, напоминания ───────────── */
  const RANGE_KEY = "aves.wk.range";
  const RANGE_FROM = ["06:00", "07:00", "08:00", "09:00", "10:00", "11:00", "12:00"];
  const RANGE_TO = ["18:00", "19:00", "20:00", "21:00", "22:00", "23:00", "24:00"];
  const fmtMin = (m) => {
    m = Math.round(m); const h = Math.floor(m / 60), r = m % 60;
    if (!m) return "0 ч";
    return h && r ? `${h} ч ${r} мин` : h ? `${h} ч` : `${r} мин`;
  };
  function dayRange() {
    const v = A.store.get(RANGE_KEY);
    if (v && /^\d\d:\d\d-\d\d:\d\d$/.test(v)) { const [a, b] = v.split("-"); if (RANGE_FROM.includes(a) && RANGE_TO.includes(b)) return [a, b]; }
    return ["08:00", "22:00"];
  }
  const remApi = (path, opts = {}) => A.api(S.faculty, path, Object.assign({ onSlow: App.slowMsg }, opts));
  const remBot = () => (C.faculties[S.faculty] || {}).bot;
  let busyForm = { days: [], start: "18:00", end: "20:00", title: "" };

  async function loadHours(force) {
    if (W.hours && !force) return;
    const [a, b] = dayRange();
    const [h, r] = await Promise.all([
      api(`/api/work/hours?week=${W.hweek}&from=${a}&to=${b}`),
      remApi("/api/reminders").then((x) => ({ items: x.items || [] }), (e) => ({ items: [], error: e })),
    ]);
    W.hours = h; W.rem = r;
  }

  async function renderHours(force) {
    if (!W.hours || force) {
      body().innerHTML = viewsHTML() + App.loadingHTML("Считаем ваши свободные часы…");
      try { await load(); await loadHours(true); } catch (e) { return bodyError(e); }
      if (S.tab !== "work" || W.view !== "hours") return;
    }
    paintHours();
  }

  function weekTitle(h) {
    const a = parseISO(h.monday), b = parseISO(h.sunday);
    const left = a.getUTCMonth() === b.getUTCMonth() ? a.getUTCDate() : human(h.monday);
    return `${left} – ${human(h.sunday)}`;
  }
  const weekSub = (n) => n === 0 ? "эта неделя" : n === 1 ? "следующая неделя" : n === -1 ? "прошлая неделя" : `через ${n} ${plural(n, "неделю", "недели", "недель")}`;

  // Пары подряд (перемена < 30 мин) показываем одной строкой: «Пары 9:00–14:10 · 3 пары»
  function lessonGroups(lessons) {
    const out = [];
    lessons.slice().sort((x, y) => toMin(x.start) - toMin(y.start)).forEach((l) => {
      const last = out[out.length - 1];
      if (last && toMin(l.start) - toMin(last.end) < 30) { last.end = l.end > last.end ? l.end : last.end; last.n++; last.labels.push(l.label); }
      else out.push({ start: l.start, end: l.end, n: 1, labels: [l.label] });
    });
    return out;
  }

  function dayItems(d, rems) {
    const items = [];
    lessonGroups(d.lessons).forEach((g) => items.push({ t: g.start, html: `<li class="hr-it hr-it--lesson"><span class="hr-it__t">${esc(g.start)}–${esc(g.end)}</span>
      <span class="hr-it__m"><b>${g.n > 1 ? "Пары" : "Пара"}</b>${g.n > 1 ? ` · ${g.n} ${plural(g.n, "пара", "пары", "пар")}` : g.labels[0] ? " · " + esc(String(g.labels[0]).replace(/^[^:]+:\s*/, "")) : ""}</span></li>` }));
    d.shifts.forEach((x) => items.push({ t: x.start, html: `<li class="hr-it hr-it--shift"><span class="hr-it__t">${esc(x.start)}–${esc(x.end)}</span>
      <span class="hr-it__m"><b>${esc(x.title)}</b>${x.company ? " · " + esc(x.company) : ""}${x.closed ? " · снята" : ""}</span>
      ${x.closed ? "" : `<button class="link-btn" type="button" data-act="wk-open-shift" data-id="${x.id}">Смена</button>`}</li>` }));
    d.busy.forEach((x) => items.push({ t: x.start, html: `<li class="hr-it hr-it--busy"><span class="hr-it__t">${esc(x.start)}–${esc(x.end)}</span>
      <span class="hr-it__m"><b>${esc(x.title)}</b></span></li>` }));
    d.free.forEach((x) => {
      if (x.past) return;
      const from = x.now ? W.hours.now : x.start;
      const left = toMin(x.end) - toMin(from);
      if (left < W.hours.min_gap) return;
      items.push({ t: from, html: `<li class="hr-it hr-it--free"><span class="hr-it__t">${esc(from)}–${esc(x.end)}</span>
        <span class="hr-it__m"><b>Свободно</b> · ${fmtMin(left)}</span>
        <button class="hr-bell" type="button" data-act="wk-rem-at" data-date="${d.date}" data-time="${esc(from)}" aria-label="Напомнить ${dayLong(d.date)} в ${esc(from)}">${BELL}</button></li>` });
    });
    rems.forEach((r) => items.push({ t: r.time, html: `<li class="hr-it hr-it--rem"><span class="hr-it__t">${esc(r.time)}</span>
      <span class="hr-it__m"><b>⏰ ${esc(r.text)}</b>${r.repeat ? " · " + esc(r.repeat_label) : ""}</span>
      <button class="icon-btn" type="button" data-act="wk-rem-del" data-id="${r.id}" aria-label="Удалить напоминание">${CLOSE}</button></li>` }));
    return items.sort((x, y) => toMin(x.t) - toMin(y.t)).map((x) => x.html).join("");
  }
  const dayLong = (iso) => `${DSHORT[wd(iso)].toLowerCase()}, ${human(iso)}`;

  function barHTML(d, lo, hi) {
    const p = (m) => ((Math.min(Math.max(m, lo), hi) - lo) / (hi - lo)) * 100;
    const seg = (cls, a, b, title) => `<i class="b ${cls}"${title ? ` title="${esc(title)}"` : ""} style="left:${p(toMin(a))}%;width:${Math.max(.8, p(toMin(b)) - p(toMin(a)))}%"></i>`;
    const nowMin = toMin(W.hours.now);
    return `<span class="wk-row__t hr-bar" aria-hidden="true">
      ${d.free.filter((f) => !f.past).map((f) => seg("b--free", f.now ? W.hours.now : f.start, f.end)).join("")}
      ${d.lessons.map((l) => seg("b--lesson", l.start, l.end, l.label)).join("")}
      ${d.busy.map((b) => seg("b--busy", b.start, b.end, b.title)).join("")}
      ${d.shifts.map((x) => seg("b--shift", x.start, x.end, x.title)).join("")}
      ${d.is_today && nowMin > lo && nowMin < hi ? `<i class="now" style="left:${p(nowMin)}%"></i>` : ""}
    </span>`;
  }

  function remindersHTML() {
    const R = W.rem || { items: [] };
    const bot = remBot();
    const list = R.error
      ? `<li class="is-empty">${esc(fatal(R.error) ? "" : R.error.message)}</li>`
      : R.items.length
        ? R.items.slice(0, 20).map((r) => `<li><span><b>${esc(r.text)}</b><small>${esc(r.when)}${r.repeat ? " · 🔁 " + esc(r.repeat_label) : ""}</small></span>
            <button class="icon-btn" type="button" data-act="wk-rem-del" data-id="${r.id}" aria-label="Удалить напоминание «${esc(r.text)}»">${CLOSE}</button></li>`).join("")
        : `<li class="is-empty">Напоминаний нет. Напишите, что и когда — как в чате с ботом.</li>`;
    return `<section class="hr-block" id="wk-rem">
        <h3 class="hr-h">Напоминания</h3>
        <form class="hr-rem" id="wk-rem-form" novalidate>
          <label class="visually-hidden" for="wk-rem-text">Что и когда напомнить</label>
          <input class="field" id="wk-rem-text" maxlength="300" autocomplete="off" enterkeyhint="send"
            placeholder="Завтра в 19:30 сдать лабу" value="${esc(W.remDraft || "")}">
          <button class="btn btn--solid" type="submit">Поставить</button>
        </form>
        <p class="hr-err" id="wk-rem-err" role="alert" hidden></p>
        <p class="hr-hint">«в чт к 8 утра забрать справку», «через 2 часа позвонить», «каждую среду в 18 бассейн».
          ${bot ? `Придёт сообщением от @${esc(bot)} — ему можно писать и прямо в чат.` : ""}</p>
        <ul class="wk-busy">${list}</ul>
      </section>`;
  }

  function busyHTML() {
    const me = W.me, f = busyForm;
    const rows = me.busy.length
      ? me.busy.map((b) => `<li><span><b>${esc(b.title)}</b><small>${b.days.map((d) => DSHORT[d]).join(", ")} · ${esc(b.start)}–${esc(b.end)}</small></span>
          <button class="icon-btn" type="button" data-act="wk-busy-del" data-ids="${b.ids.join(",")}" aria-label="Удалить ${esc(b.title)}">${CLOSE}</button></li>`).join("")
      : `<li class="is-empty">Пары мы уже знаем из расписания. Добавьте тренировки, курсы или сон — смены в это время не предложим.</li>`;
    return `<section class="hr-block" id="wk-busy">
        <h3 class="hr-h">Когда я занят</h3>
        <ul class="wk-busy">${rows}</ul>
        <form class="wk-add" id="wk-add" novalidate>
          <div class="wk-daypick" role="group" aria-label="Дни недели">
            ${DSHORT.map((d, n) => `<button class="chip${f.days.includes(n) ? " is-on" : ""}" type="button" data-act="wk-pickday" data-d="${n}" aria-pressed="${f.days.includes(n)}">${d}</button>`).join("")}
          </div>
          <div class="wk-times">
            <label>с <input class="field" type="time" id="wk-from" value="${esc(f.start)}"></label>
            <label>до <input class="field" type="time" id="wk-to" value="${esc(f.end)}"></label>
          </div>
          <label class="visually-hidden" for="wk-title">Что за дело</label>
          <input class="field" id="wk-title" maxlength="60" placeholder="Например, тренировка" value="${esc(f.title)}">
          <button class="btn btn--solid" type="submit">Добавить</button>
        </form>
      </section>`;
  }

  function paintHours() {
    if (!body() || !W.hours) return;
    const h = W.hours, t = h.totals;
    const [lo, hi] = [toMin(h.day_from), h.day_to === "24:00" ? 1440 : toMin(h.day_to)];
    const span = (hi - lo) * 7 || 1;
    const share = (m) => Math.max(0, Math.min(100, (m / span) * 100));
    const remByDate = {};
    ((W.rem && W.rem.items) || []).forEach((r) => (remByDate[r.date] = remByDate[r.date] || []).push(r));
    const days = h.days.map((d) => {
      const head = d.is_past ? "прошёл" : `свободно ${fmtMin(d.is_today ? d.minutes.free_left : d.minutes.free)}`;
      const items = d.is_past ? "" : dayItems(d, remByDate[d.date] || []);
      return `<article class="hr-day${d.is_today ? " is-today" : ""}${d.is_past ? " is-past" : ""}">
          <header class="hr-day__h"><b>${d.is_today ? "Сегодня" : DAYS[d.weekday]}</b><span>${human(d.date)}</span><em>${head}</em></header>
          ${barHTML(d, lo, hi)}
          ${items ? `<ul class="hr-items">${items}</ul>` : d.is_past ? "" : `<p class="hr-none">Весь день занят</p>`}
        </article>`;
    }).join("");
    const sel = (id, list, cur) => `<select class="hr-sel" id="${id}">${list.map((v) => `<option${v === cur ? " selected" : ""}>${v}</option>`).join("")}</select>`;
    const [ra, rb] = dayRange();
    body().innerHTML = `${viewsHTML()}
      <section class="hr-sum">
        <div class="hr-nav">
          <button class="icon-btn" type="button" data-act="wk-hweek" data-dir="-1" aria-label="Предыдущая неделя" ${W.hweek <= -1 ? "disabled" : ""}>‹</button>
          <div><b>${weekTitle(h)}</b><small>${weekSub(W.hweek)}</small></div>
          <button class="icon-btn" type="button" data-act="wk-hweek" data-dir="1" aria-label="Следующая неделя" ${W.hweek >= 4 ? "disabled" : ""}>›</button>
        </div>
        <p class="hr-big"><b>${fmtMin(t.free)}</b><span>свободно за неделю</span></p>
        ${W.hweek === 0 ? `<p class="hr-left">Осталось до конца недели: <b>${fmtMin(t.free_left)}</b></p>` : ""}
        <div class="hr-split" aria-hidden="true">
          <i class="b--lesson" style="width:${share(t.study)}%"></i><i class="b--shift" style="width:${share(t.shifts)}%"></i><i class="b--busy" style="width:${share(t.busy)}%"></i><i class="b--free" style="width:${share(t.free)}%"></i>
        </div>
        <p class="wk-legend hr-legend"><span><i class="b--lesson"></i>Пары ${fmtMin(t.study)}</span><span><i class="b--shift"></i>Смены ${fmtMin(t.shifts)}</span><span><i class="b--busy"></i>Мои дела ${fmtMin(t.busy)}</span><span><i class="b--free"></i>Свободно ${fmtMin(t.free)}</span></p>
        <p class="hr-range">Считаем с ${sel("wk-ra", RANGE_FROM, ra)} до ${sel("wk-rb", RANGE_TO, rb)}, окна от ${h.min_gap} минут${h.schedules_used.length ? ` · пары: ${h.schedules_used.map(esc).join(", ")}` : ""}</p>
        ${h.has_schedule ? "" : `<p class="wk-note" style="margin:.6rem 0 0">Не нашли вашу группу в ботах расписания — считаем только смены и ваши дела.</p>`}
      </section>
      <section class="hr-days">${days}</section>
      ${remindersHTML()}
      ${busyHTML()}`;
    bindHoursView();
  }

  function bindHoursView() {
    const form = $("#wk-add");
    if (form) form.addEventListener("submit", (e) => { e.preventDefault(); addBusy(); });
    const rf = $("#wk-rem-form");
    if (rf) rf.addEventListener("submit", (e) => { e.preventDefault(); addReminder(); });
    const rt = $("#wk-rem-text");
    if (rt) rt.addEventListener("input", () => { W.remDraft = rt.value; const er = $("#wk-rem-err"); if (er) er.hidden = true; });
    ["#wk-ra", "#wk-rb"].forEach((id) => { const el = $(id); if (el) el.addEventListener("change", saveRange); });
  }

  async function saveRange() {
    const a = $("#wk-ra").value, b = $("#wk-rb").value;
    A.store.set(RANGE_KEY, `${a}-${b}`);
    App.haptic("select");
    try { await loadHours(true); paintHoursQuiet(); } catch (e) { if (!fatal(e)) App.toast(e.message); }
  }

  function readBusyForm() {
    const a = $("#wk-from"), b = $("#wk-to"), t = $("#wk-title");
    if (a) busyForm.start = a.value; if (b) busyForm.end = b.value; if (t) busyForm.title = t.value;
  }
  function paintHoursQuiet() { const keep = window.scrollY; paintHours(); window.scrollTo(0, keep); }

  // Время приходит из <input type="time"> как «19:45» (иногда с секундами) — берём часы и минуты как есть
  const cleanTime = (v) => { const m = /^(\d{1,2}):(\d{2})/.exec(v || ""); return m ? m[1].padStart(2, "0") + ":" + m[2] : ""; };

  async function addBusy() {
    readBusyForm();
    const f = busyForm, start = cleanTime(f.start), end = cleanTime(f.end);
    if (!f.days.length) return App.toast("Выберите хотя бы один день");
    if (!start || !end) return App.toast("Укажите время «с» и «до»");
    if (start >= end) return App.toast("Время «до» должно быть позже «с»");
    const btn = $("#wk-add .btn"); if (btn) btn.disabled = true;
    try {
      W.me = await api("/api/work/busy", { method: "POST", body: { days: f.days, start, end, title: f.title } });
      App.haptic("success"); App.toast("Сохранено — в эти часы смены не предложим");
      busyForm = { days: [], start, end, title: "" };
      await afterHoursChange();
    } catch (e) { if (btn) btn.disabled = false; if (!fatal(e)) App.toast(e.message); }
  }

  async function afterHoursChange() {
    W.hours = null;
    try { await loadHours(true); } catch (_) {}
    if (S.tab === "work" && W.view === "hours") paintHoursQuiet();
    repaintSettings();
    refreshFeed();
  }

  async function addReminder(structured) {
    const input = $("#wk-rem-text");
    const text = structured ? structured.text : (input ? input.value.trim() : "");
    if (!structured && !text) { App.toast("Напишите, что и когда напомнить"); if (input) input.focus(); return; }
    const btn = structured ? $("#wk-rem-at .btn") : $("#wk-rem-form .btn");
    if (btn) btn.disabled = true;
    try {
      const r = await remApi("/api/reminders", { method: "POST", body: structured || { text } });
      const made = r.items || [r.item];
      App.haptic("success");
      App.toast(`Напомню ${made.map((x) => x.when).join(", ")}${r.has_time === false ? " (время не указали — в 9:00)" : ""}`);
      W.remDraft = "";
      if (structured) App.closeSheet();
      W.rem = await remApi("/api/reminders").then((x) => ({ items: x.items || [] }), (e) => ({ items: [], error: e }));
      if (S.tab === "work" && W.view === "hours") paintHoursQuiet();
    } catch (e) {
      App.haptic("error");
      if (btn) btn.disabled = false;
      if (fatal(e)) return;
      // длинные подсказки парсера — под полем, а не во всплывашке
      const box = $(structured ? "#wk-rem-at-err" : "#wk-rem-err");
      if (box) { box.textContent = e.message; box.hidden = false; } else App.toast(e.message);
    }
  }

  function reminderSheet(date, time) {
    return `<div class="sheet__head"><h3>Напоминание</h3>
        <button class="icon-btn" type="button" data-act="sheet-close" aria-label="Закрыть">${CLOSE}</button></div>
      <div class="sheet__body wk-sheet">
        <form class="wk-add" id="wk-rem-at" novalidate>
          <p class="wk-when" style="margin:0"><b>${dayLong(date).replace(/^./, (c) => c.toUpperCase())}</b></p>
          <div class="wk-times"><label>в <input class="field" type="time" id="wk-rem-time" value="${esc(time)}"></label></div>
          <label class="visually-hidden" for="wk-rem-what">О чём напомнить</label>
          <input class="field" id="wk-rem-what" maxlength="300" placeholder="Например, написать курсовую" autocomplete="off">
          <button class="btn btn--solid" type="submit">Напомнить</button>
          <p class="hr-err" id="wk-rem-at-err" role="alert" hidden></p>
          <p class="hr-hint" style="margin:0">${remBot() ? `Придёт сообщением от @${esc(remBot())}` : ""}</p>
        </form>
      </div>`;
  }

  /* ───────────── переключатель «Смены | Мои часы» ───────────── */
  function viewsHTML() {
    const fits = W.feed ? W.feed.items.filter((i) => i.fits).length : 0;
    return `<div class="wk-views seg" role="group" aria-label="Раздел">
        <button type="button" data-act="wk-view" data-v="feed" aria-pressed="${W.view === "feed"}">Смены${fits ? " · " + fits : ""}</button>
        <button type="button" data-act="wk-view" data-v="hours" aria-pressed="${W.view === "hours"}">Мои часы</button>
      </div>`;
  }

  /* ───────────── действия ───────────── */
  Object.assign(actions, {
    "wk-retry"() { render(true); },
    async "wk-relayfac"(el) {
      try {
        W.me = await api("/api/work/me", { method: "PATCH", body: { relay_faculty: el.dataset.f } });
        App.haptic("select"); App.toast(`Уведомления будут приходить в @${relayBot()}`);
        repaintSettings(); if (W.feed) paintQuiet();
      } catch (e) { if (!fatal(e)) App.toast(e.message); }
    },
    "wk-mode"(el) { W.mode = el.dataset.m; App.haptic("select"); paint(); },
    "wk-day"(el) { W.day = W.day === el.dataset.date ? null : el.dataset.date; App.haptic("select"); paint(); },
    "wk-open"(el) { openShift(+el.dataset.id); },
    "wk-settings"() { openSettings(); },
    "wk-hours"() { W.view = "hours"; A.store.set("aves.wk.view", "hours"); render(false); },
    "wk-view"(el) {
      if (W.view === el.dataset.v) return;
      W.view = el.dataset.v; A.store.set("aves.wk.view", W.view); App.haptic("select");
      head(); window.scrollTo(0, 0);
      if (W.view === "hours") renderHours(false);
      else if (W.feed) paint(); else render(true);
    },
    async "wk-hweek"(el) {
      W.hweek = Math.max(-1, Math.min(4, W.hweek + +el.dataset.dir)); App.haptic("select");
      try { await loadHours(true); paintHours(); } catch (e) { if (!fatal(e)) App.toast(e.message); }
    },
    "wk-goto-busy"() {
      App.closeSheet();
      W.view = "hours"; A.store.set("aves.wk.view", "hours"); head();
      const go = () => { const el = $("#wk-busy"); if (el) el.scrollIntoView({ behavior: "smooth", block: "start" }); };
      (W.hours ? Promise.resolve(paintHours()) : renderHours(false)).then(() => setTimeout(go, 60));
    },
    "wk-open-shift"(el) {
      const id = +el.dataset.id;
      if (W.feed && W.feed.items.find((x) => x.id === id)) openShift(id); else App.toast("Эта смена уже прошла или снята");
    },
    "wk-rem-at"(el) {
      App.openSheet(reminderSheet(el.dataset.date, el.dataset.time));
      const f = $("#wk-rem-at");
      f.addEventListener("submit", (e) => {
        e.preventDefault();
        const time = cleanTime($("#wk-rem-time").value), text = $("#wk-rem-what").value.trim();
        if (!time) return App.toast("Укажите время");
        addReminder({ date: el.dataset.date, time, text: text || "Напоминание" });
      });
      setTimeout(() => { const w = $("#wk-rem-what"); if (w) w.focus(); }, 250);
    },
    async "wk-rem-del"(el) {
      el.disabled = true;
      try {
        await remApi(`/api/reminders/${el.dataset.id}/delete`, { method: "POST" });
        W.rem.items = W.rem.items.filter((r) => r.id !== +el.dataset.id);
        App.haptic("success"); App.toast("Напоминание удалено"); paintHoursQuiet();
      } catch (e) { el.disabled = false; if (!fatal(e)) App.toast(e.message); }
    },
    async "wk-resume"() {
      try { W.me = await api("/api/work/me", { method: "PATCH", body: { search_active: true } }); App.toast("Поиск включён"); paint(); }
      catch (e) { if (!fatal(e)) App.toast(e.message); }
    },
    "wk-connect"() {
      const bot = W.me && W.me.bot;
      if (bot) App.openExt(`https://t.me/${bot}?start=web`); else App.toast("Бот AvesWork пока недоступен");
    },
    "wk-pickday"(el) {
      readBusyForm();
      const d = +el.dataset.d, set = busyForm.days;
      busyForm.days = set.includes(d) ? set.filter((x) => x !== d) : [...set, d].sort();
      App.haptic("select");
      // перерисовываем только выбор дней, чтобы не сбить прокрутку и фокус
      el.classList.toggle("is-on", busyForm.days.includes(d)); el.setAttribute("aria-pressed", busyForm.days.includes(d));
    },
    async "wk-busy-del"(el) {
      el.disabled = true;
      try {
        W.me = await api("/api/work/busy/delete?ids=" + el.dataset.ids, { method: "POST" });
        App.toast("Удалено"); await afterHoursChange();
      } catch (e) { el.disabled = false; if (!fatal(e)) App.toast(e.message); }
    },
    async "wk-apply"(el) {
      el.disabled = true; el.textContent = "Отправляем…";
      try {
        const r = await api(`/api/work/shifts/${el.dataset.id}/apply`, { method: "POST" });
        const ids = new Set(r.applied_ids || [+el.dataset.id]);
        W.feed.items.forEach((i) => { if (ids.has(i.id)) i.applied = true; });
        App.haptic("success");
        App.toast(r.status === "already" ? "Вы уже откликались" : r.has_username ? "Отклик отправлен — ждите сообщения" : "Отклик отправлен. Совет: заведите @username, чтобы вам было проще написать");
        W.hours = null; repaintSheet(); paintQuiet();
      } catch (e) {
        App.haptic("error");
        if (fatal(e)) return;
        App.toast(e.message);
        if (e.status === 410) { App.closeSheet(); refreshFeed(); }
        else { el.disabled = false; el.textContent = "Откликнуться"; }
      }
    },
    async "wk-withdraw"(el) {
      el.disabled = true;
      try {
        await api(`/api/work/shifts/${el.dataset.id}/withdraw`, { method: "POST" });
        const cur = W.feed.items.find((i) => i.id === +el.dataset.id);
        W.feed.items.forEach((i) => { if (cur && (i.id === cur.id || (cur.batch.require_all && i.batch.key === cur.batch.key))) i.applied = false; });
        App.toast("Отклик отозван, работодателю сообщили");
        W.hours = null; repaintSheet(); paintQuiet();
      } catch (e) { el.disabled = false; if (!fatal(e)) App.toast(e.message); }
    },
  });

  window.AvesTabs = Object.assign(window.AvesTabs || {}, {
    work() {
      render(false);
    },
  });

  /* ───────────── подключение к приложению без правок app.js ───────────── */

  // Стили вкладки
  if (!document.querySelector('link[href$="/work.css"]')) {
    const css = document.createElement("link");
    css.rel = "stylesheet"; css.href = "/assets/css/work.css";
    document.head.appendChild(css);
  }

  // Конспекты общие для всех факультетов (AvesStudy) — снимаем старое «только биофак»,
  // если на сайте остался index.html из версии до ФМО
  const studyTab = document.querySelector('#tabbar [data-tab="study"][data-only]');
  if (studyTab) { studyTab.removeAttribute("data-only"); studyTab.hidden = false; }

  // Кнопка «Смены» в нижней панели — перед «Профилем»
  const tabbarIn = document.querySelector("#tabbar .tabbar__in");
  if (tabbarIn && !tabbarIn.querySelector('[data-tab="work"]')) {
    const btn = document.createElement("button");
    btn.className = "tab"; btn.type = "button"; btn.dataset.act = "tab"; btn.dataset.tab = "work";
    btn.innerHTML = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><rect x="3.5" y="7" width="17" height="12.5" rx="2.5"/><path d="M9 7V5.5C9 4.7 9.7 4 10.5 4h3c.8 0 1.5.7 1.5 1.5V7"/><path d="M3.5 12.5h17M12 11.5v2"/></svg>Смены';
    tabbarIn.insertBefore(btn, tabbarIn.querySelector('[data-tab="profile"]'));
  }

  // Ссылка из бота: ?tab=work&shift=123 — как только приложение покажет вкладки, открываем «Смены»
  const qs = new URLSearchParams(location.search);
  if (qs.get("shift")) W.deep = +qs.get("shift");
  const tabbar = document.getElementById("tabbar");
  if (qs.get("tab") === "work" && tabbar) {
    const obs = new MutationObserver(() => {
      if (tabbar.hidden || !S.user) return;
      obs.disconnect();
      try {
        const u = new URL(location.href);
        ["tab", "shift"].forEach((k) => u.searchParams.delete(k));
        history.replaceState(null, "", u.pathname + u.search + u.hash);
      } catch (_) {}
      App.go("work");
    });
    obs.observe(tabbar, { attributes: true, attributeFilter: ["hidden"] });
  }

  // В профиле строка «Подработки — Скоро» превращается в ссылку на вкладку
  new MutationObserver(() => {
    if (S.tab !== "profile") return;
    App.view.querySelectorAll(".row").forEach((row) => {
      const label = row.querySelector(".row__label span");
      const soon = row.querySelector(".soon");
      if (!label || !soon || label.textContent.trim() !== "Подработки") return;
      const small = row.querySelector(".row__label small");
      if (small) small.textContent = "Смены под ваше расписание, тест";
      soon.outerHTML = '<button class="link-btn" type="button" data-act="tab" data-tab="work">Открыть</button>';
    });
  }).observe(App.view, { childList: true });

  // Возвращаемся во вкладку — освежаем ленту, если прошло больше пяти минут
  document.addEventListener("visibilitychange", () => {
    if (!document.hidden && S.tab === "work" && W.feed && Date.now() - loadedAt > 300000) {
      loadedAt = Date.now(); refreshFeed();
      if (W.view === "hours") loadHours(true).then(paintHoursQuiet, () => {});
    }
  });
  // Смена аккаунта или факультета — начинаем с чистого листа
  document.addEventListener("click", () => {
    const uid = S.user && S.user.telegram_id;
    if (W.feed && uid !== lastUser) { lastUser = uid; Object.assign(W, { me: null, feed: null, day: null, open: null, hours: null, rem: null, hweek: 0 }); }
  }, true);
})();
