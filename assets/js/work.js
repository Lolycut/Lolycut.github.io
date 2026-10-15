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
    App.setHead({ title: "Смены", sub, chip: { act: "wk-hours", label: "Мои часы" } });
  }

  async function render(force) {
    head();
    App.view.innerHTML = `<div id="wk-body"></div>`;
    if (!W.feed || force) {
      body().innerHTML = App.loadingHTML("Сверяем смены с вашим расписанием…");
      try { await load(force); } catch (e) { return bodyError(e); }
    }
    if (S.tab !== "work") return;
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
      const shifts = (byDay[d.date] || []).filter((i) => W.mode === "all" || i.fits)
        .map((i) => `<i class="b b--shift${i.fits ? "" : " is-off"}" style="left:${pct(toMin(i.start))}%;width:${Math.max(1.5, pct(toMin(i.end)) - pct(toMin(i.start)))}%"></i>`).join("");
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
    return `<div class="wk-note"><span>${how}</span><button class="link-btn" type="button" data-act="wk-hours">Настроить</button></div>`;
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
        : `<p class="wk-fit is-off">Пересекается: ${esc(i.conflict ? i.conflict.label : "")}</p>`;
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
    body().innerHTML = `
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

  /* ───────────── «Мои часы» ───────────── */
  function hoursSheet(form) {
    const me = W.me, st = me.settings;
    const f = form || { days: [], start: "18:00", end: "20:00", title: "" };
    const rows = me.busy.length
      ? me.busy.map((b) => `<li><span><b>${esc(b.title)}</b><small>${b.days.map((d) => DSHORT[d]).join(", ")} · ${esc(b.start)}–${esc(b.end)}</small></span>
          <button class="icon-btn" type="button" data-act="wk-busy-del" data-ids="${b.ids.join(",")}" aria-label="Удалить ${esc(b.title)}">${CLOSE}</button></li>`).join("")
      : `<li class="is-empty">Пары мы уже знаем из расписания. Добавьте сюда тренировки, курсы или сон.</li>`;
    const relayHint = !st.relay_available
      ? "Тестовый режим: пока только для тестеров"
      : relayBot() ? `Одной строкой в @${esc(relayBot())}, не чаще раза в день` : "Одной строкой в боте расписания";
    const botRow = st.bot_connected
      ? `<div class="row"><label class="row__label" for="wk-n3"><span>Подробные карточки</span><small>В @${esc(me.bot || "AvesWork")}, по каждой новой смене</small></label>
           <input class="switch" id="wk-n3" type="checkbox" data-wk-pref="bot_notifications" ${st.bot_notifications ? "checked" : ""}></div>`
      : `<div class="row"><div class="row__label"><span>Подробные карточки</span><small>Отдельный бот AvesWork — по каждой новой смене</small></div>
           <button class="link-btn" type="button" data-act="wk-connect">Подключить</button></div>`;
    return `<div class="sheet__head"><h3>Мои часы</h3>
        <button class="icon-btn" type="button" data-act="sheet-close" aria-label="Закрыть">${CLOSE}</button></div>
      <div class="sheet__body wk-sheet">
        <div class="row"><label class="row__label" for="wk-n1"><span>Ищу подработку</span><small>Выключите, чтобы смены не приходили</small></label>
          <input class="switch" id="wk-n1" type="checkbox" data-wk-pref="search_active" ${st.search_active ? "checked" : ""}></div>
        <div class="row"><label class="row__label" for="wk-n2"><span>Уведомления о сменах</span><small>${relayHint}</small></label>
          <input class="switch" id="wk-n2" type="checkbox" data-wk-pref="relay_enabled" ${st.relay_enabled ? "checked" : ""}></div>
        ${botRow}
        ${schedulesHTML(me)}

        <p class="section-label" style="margin:1.4rem 0 .4rem">Когда я занят</p>
        <ul class="wk-busy">${rows}</ul>

        <form class="wk-add" id="wk-add">
          <div class="wk-daypick" role="group" aria-label="Дни недели">
            ${DSHORT.map((d, n) => `<button class="chip${f.days.includes(n) ? " is-on" : ""}" type="button" data-act="wk-pickday" data-d="${n}" aria-pressed="${f.days.includes(n)}">${d}</button>`).join("")}
          </div>
          <div class="wk-times">
            <label>с <input class="field" type="time" id="wk-from" value="${esc(f.start)}" step="900" required></label>
            <label>до <input class="field" type="time" id="wk-to" value="${esc(f.end)}" step="900" required></label>
          </div>
          <label class="visually-hidden" for="wk-title">Что за дело</label>
          <input class="field" id="wk-title" maxlength="60" placeholder="Например, тренировка" value="${esc(f.title)}">
          <button class="btn btn--solid" type="submit">Добавить</button>
        </form>
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
      App.haptic("success"); App.toast("Сохранено — пересчитываем смены");
      repaintHours(); refreshFeed();
    } catch (e) { if (!fatal(e)) App.toast(e.message); }
  }

  let hoursForm = null;
  function openHours() {
    if (!W.me) return;
    hoursForm = { days: [], start: "18:00", end: "20:00", title: "" };
    App.openSheet(hoursSheet(hoursForm));
    bindHours();
  }
  function readForm() {
    if (!hoursForm) return;
    const a = $("#wk-from"), b = $("#wk-to"), t = $("#wk-title");
    if (a) hoursForm.start = a.value; if (b) hoursForm.end = b.value; if (t) hoursForm.title = t.value;
  }
  function repaintHours() {
    readForm();
    $("#sheet").innerHTML = hoursSheet(hoursForm);
    bindHours();
  }
  function bindHours() {
    const form = $("#wk-add");
    if (form) form.addEventListener("submit", (e) => { e.preventDefault(); addBusy(); });
    document.querySelectorAll("[data-wk-pref]").forEach((el) => el.addEventListener("change", () => setPref(el)));
    document.querySelectorAll("[data-wk-sched]").forEach((el) => el.addEventListener("change", () => saveSchedules(el)));
  }

  async function setPref(el) {
    const key = el.dataset.wkPref, val = el.checked;
    try {
      W.me = await api("/api/work/me", { method: "PATCH", body: { [key]: val } });
      App.haptic("success");
      App.toast({ search_active: val ? "Поиск включён" : "Поиск на паузе", relay_enabled: val ? "Уведомления включены" : "Уведомления выключены", bot_notifications: val ? "Карточки включены" : "Карточки выключены" }[key]);
      if (W.feed) { W.feed.search_active = W.me.settings.search_active; paint(); }
    } catch (e) { el.checked = !val; if (!fatal(e)) App.toast(e.message); }
  }

  async function addBusy() {
    readForm();
    const f = hoursForm;
    if (!f.days.length) return App.toast("Выберите хотя бы один день");
    if (!f.start || !f.end || f.start >= f.end) return App.toast("Время «до» должно быть позже «с»");
    const btn = $("#wk-add .btn"); if (btn) btn.disabled = true;
    try {
      W.me = await api("/api/work/busy", { method: "POST", body: { days: f.days, start: f.start, end: f.end, title: f.title } });
      App.haptic("success"); App.toast("Сохранено — в эти часы смены не предложим");
      hoursForm = { days: [], start: f.start, end: f.end, title: "" };
      repaintHours();
      refreshFeed();
    } catch (e) { if (btn) btn.disabled = false; if (!fatal(e)) App.toast(e.message); }
  }

  async function refreshFeed() {
    try { W.feed = await api("/api/work/feed"); loadedAt = Date.now(); if (S.tab === "work") paintQuiet(); } catch (_) {}
  }
  function paintQuiet() { const keep = window.scrollY; paint(); window.scrollTo(0, keep); }

  /* ───────────── действия ───────────── */
  Object.assign(actions, {
    "wk-retry"() { render(true); },
    async "wk-relayfac"(el) {
      try {
        W.me = await api("/api/work/me", { method: "PATCH", body: { relay_faculty: el.dataset.f } });
        App.haptic("select"); App.toast(`Уведомления будут приходить в @${relayBot()}`);
        repaintHours(); if (W.feed) paintQuiet();
      } catch (e) { if (!fatal(e)) App.toast(e.message); }
    },
    "wk-mode"(el) { W.mode = el.dataset.m; App.haptic("select"); paint(); },
    "wk-day"(el) { W.day = W.day === el.dataset.date ? null : el.dataset.date; App.haptic("select"); paint(); },
    "wk-open"(el) { openShift(+el.dataset.id); },
    "wk-hours"() { openHours(); },
    async "wk-resume"() {
      try { W.me = await api("/api/work/me", { method: "PATCH", body: { search_active: true } }); App.toast("Поиск включён"); paint(); }
      catch (e) { if (!fatal(e)) App.toast(e.message); }
    },
    "wk-connect"() {
      const bot = W.me && W.me.bot;
      if (bot) App.openExt(`https://t.me/${bot}?start=web`); else App.toast("Бот AvesWork пока недоступен");
    },
    "wk-pickday"(el) {
      readForm();
      const d = +el.dataset.d, set = hoursForm.days;
      hoursForm.days = set.includes(d) ? set.filter((x) => x !== d) : [...set, d].sort();
      App.haptic("select"); repaintHours();
    },
    async "wk-busy-del"(el) {
      try {
        W.me = await api("/api/work/busy?ids=" + el.dataset.ids, { method: "DELETE" });
        App.toast("Удалено"); repaintHours(); refreshFeed();
      } catch (e) { if (!fatal(e)) App.toast(e.message); }
    },
    async "wk-apply"(el) {
      el.disabled = true; el.textContent = "Отправляем…";
      try {
        const r = await api(`/api/work/shifts/${el.dataset.id}/apply`, { method: "POST" });
        const ids = new Set(r.applied_ids || [+el.dataset.id]);
        W.feed.items.forEach((i) => { if (ids.has(i.id)) i.applied = true; });
        App.haptic("success");
        App.toast(r.status === "already" ? "Вы уже откликались" : r.has_username ? "Отклик отправлен — ждите сообщения" : "Отклик отправлен. Совет: заведите @username, чтобы вам было проще написать");
        repaintSheet(); paintQuiet();
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
        repaintSheet(); paintQuiet();
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
    if (!document.hidden && S.tab === "work" && W.feed && Date.now() - loadedAt > 300000) { loadedAt = Date.now(); refreshFeed(); }
  });
  // Смена аккаунта или факультета — начинаем с чистого листа
  document.addEventListener("click", () => {
    const uid = S.user && S.user.telegram_id;
    if (W.feed && uid !== lastUser) { lastUser = uid; Object.assign(W, { me: null, feed: null, day: null, open: null }); }
  }, true);
})();
