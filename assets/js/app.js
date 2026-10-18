/* Aves — приложение расписания. Работает в браузере (вход через Telegram)
   и как Telegram Mini App (вход автоматически по initData). */
(function () {
  "use strict";
  const A = window.Aves, C = A.config;
  const tg = window.Telegram && window.Telegram.WebApp;
  const inTg = !!(tg && tg.initData);

  const $ = (s, r = document) => r.querySelector(s);
  const view = $("#view"), head = $("#head"), tabbar = $("#tabbar"), shell = $(".shell");
  const esc = (s) => String(s == null ? "" : s).replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));

  const S = {
    faculty: null, user: null, meta: null, groupsById: {},
    tab: "day", date: null,
    week: null, weekKey: "", viewGroup: null, viewSub: 0,
    compare: { ids: [], data: null, key: "" },
    search: { q: "", res: null, fullWeek: false },
    ob: null, picker: null, regResults: null,
    viewAll: false,          // ФМО: показать все языковые подгруппы, а не только свои
  };

  /* ───────────── даты и время (всё по Минску) ───────────── */
  const MONTHS = ["января", "февраля", "марта", "апреля", "мая", "июня", "июля", "августа", "сентября", "октября", "ноября", "декабря"];
  const DAYS = ["Понедельник", "Вторник", "Среда", "Четверг", "Пятница", "Суббота", "Воскресенье"];
  const DAYS_SHORT = ["Пн", "Вт", "Ср", "Чт", "Пт", "Сб"];

  const parseISO = (s) => { const [y, m, d] = s.split("-").map(Number); return new Date(Date.UTC(y, m - 1, d)); };
  const iso = (d) => d.toISOString().slice(0, 10);
  const addDays = (s, n) => { const d = parseISO(s); d.setUTCDate(d.getUTCDate() + n); return iso(d); };
  const weekday = (s) => (parseISO(s).getUTCDay() + 6) % 7;
  const mondayOf = (s) => addDays(s, -weekday(s));
  const dayNum = (s) => parseISO(s).getUTCDate();
  const human = (s) => { const d = parseISO(s); return d.getUTCDate() + " " + MONTHS[d.getUTCMonth()]; };
  const toMin = (hhmm) => { const [h, m] = hhmm.split(":").map(Number); return h * 60 + m; };

  function minskNow() {
    const p = new Intl.DateTimeFormat("en-CA", {
      timeZone: "Europe/Minsk", year: "numeric", month: "2-digit", day: "2-digit",
      hour: "2-digit", minute: "2-digit", hourCycle: "h23",
    }).formatToParts(new Date());
    const g = (t) => p.find((x) => x.type === t).value;
    return { date: `${g("year")}-${g("month")}-${g("day")}`, minutes: +g("hour") * 60 + +g("minute") };
  }
  function defaultDate() { const t = minskNow().date; return weekday(t) === 6 ? addDays(t, 1) : t; }

  function slotTime(id) {
    const raw = (S.meta && S.meta.timeslots[String(id)]) || "--:-- - --:--";
    const [a, b] = raw.split(" - ");
    return { start: a, end: b, s: a.includes("-") ? 0 : toMin(a), e: b.includes("-") ? 0 : toMin(b) };
  }
  // У ФМО у пары своё время (9.30, 12.30, 16.30…) — берём его, если API его прислал
  function timeOf(it) {
    if (it.time_start && it.time_end) return { start: it.time_start, end: it.time_end, s: toMin(it.time_start), e: toMin(it.time_end) };
    return slotTime(it.slot);
  }
  const keyOf = (it) => it.time_start || "s" + it.slot;
  // Языковые подгруппы и ДВС (ФМО): API отдаёт у студента tracks/choices
  const hasLangs = () => !!(S.user && S.user.tracks != null);
  const TRACK_TITLES = { lang1: "1-й иностранный язык", lang2: "2-й иностранный язык", east: "Восточный язык", west: "Западный язык", lang: "Иностранный язык" };
  function weekKeyNow() { return mondayOf(S.date) + ":" + currentGroup().id + (S.viewAll ? ":all" : ""); }

  function plural(n, one, few, many) {
    const m10 = n % 10, m100 = n % 100;
    if (m10 === 1 && m100 !== 11) return one;
    if (m10 >= 2 && m10 <= 4 && (m100 < 12 || m100 > 14)) return few;
    return many;
  }
  function weekLabel(mon) {
    const sat = addDays(mon, 5), a = parseISO(mon), b = parseISO(sat);
    return a.getUTCMonth() === b.getUTCMonth()
      ? `${a.getUTCDate()}–${b.getUTCDate()} ${MONTHS[b.getUTCMonth()]}`
      : `${human(mon)} – ${human(sat)}`;
  }
  const inMinutes = (m) => m < 60 ? `${m} мин` : `${Math.floor(m / 60)} ч ${m % 60 ? (m % 60) + " мин" : ""}`.trim();

  /* ───────────── Telegram ───────────── */
  function haptic(kind) {
    try {
      if (!tg || !tg.HapticFeedback) return;
      if (kind === "select") tg.HapticFeedback.selectionChanged();
      else tg.HapticFeedback.notificationOccurred(kind);
    } catch (_) {}
  }
  function syncTgColors() {
    if (!tg) return;
    const bg = getComputedStyle(document.documentElement).getPropertyValue("--paper").trim();
    try { tg.setHeaderColor(bg); tg.setBackgroundColor(bg); if (tg.setBottomBarColor) tg.setBottomBarColor(bg); } catch (_) {}
  }
  function openExt(url) {
    if (inTg && /^https:\/\/t\.me\//.test(url)) tg.openTelegramLink(url);
    else if (inTg) tg.openLink(url);
    else window.open(url, "_blank", "noopener");
  }

  /* ───────────── мелкие UI-штуки ───────────── */
  let toastTimer;
  function toast(msg) {
    const t = $("#toast");
    t.textContent = msg; t.classList.add("is-on");
    clearTimeout(toastTimer); toastTimer = setTimeout(() => t.classList.remove("is-on"), 2600);
  }
  function chrome(on) {
    head.hidden = !on; tabbar.hidden = !on;
    shell.classList.toggle("shell--bare", !on);
  }
  function loadingHTML(text) {
    return `<div class="loading hover" aria-live="polite"><div><span class="bird bird--dove"></span><p id="load-msg">${esc(text || "Загружаем…")}</p></div></div>`;
  }
  function slowMsg() {
    const m = $("#load-msg");
    if (m) m.textContent = "Птица просыпается: сервер бесплатный и засыпает, если долго никто не заходил. Обычно это до минуты.";
  }
  function showLoading(text) { view.innerHTML = loadingHTML(text); }
  function emptyHTML(title, text) {
    return `<div class="empty"><span class="bird bird--dove"></span><h3>${esc(title)}</h3><p>${esc(text)}</p></div>`;
  }

  const ICONS = {
    prev: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M15 5l-7 7 7 7"/></svg>',
    next: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M9 5l7 7-7 7"/></svg>',
    close: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round"><path d="M6 6l12 12M18 6L6 18"/></svg>',
  };

  /* ───────────── шапка и вкладки ───────────── */
  function setHead({ title, sub, pick = false, chip = null }) {
    head.innerHTML = `
      <button class="theme-bird" type="button" data-theme-toggle aria-label="Сменить тему"><span class="bird bird--dove"></span></button>
      <button class="head-title" type="button" ${pick ? 'data-act="view-group"' : "disabled"} ${pick ? 'aria-label="Посмотреть другую группу"' : ""}>
        <b>${esc(title)}</b>${sub ? `<span>${esc(sub)}</span>` : ""}
      </button>
      ${chip ? `<button class="chip" type="button" data-act="${chip.act}">${esc(chip.label)}</button>` : ""}`;
  }
  function subLabel(n) { return n ? `${n} п/г` : "Вся группа"; }

  function go(tab) {
    S.tab = tab;
    tabbar.querySelectorAll(".tab").forEach((b) => { if (b.dataset.tab === tab) b.setAttribute("aria-current", "page"); else b.removeAttribute("aria-current"); });
    tabbar.querySelectorAll("[data-only]").forEach((b) => { b.hidden = b.dataset.only !== S.faculty; });
    window.scrollTo(0, 0);
    const own = { day: renderDay, search: renderSearch, compare: renderCompare, profile: renderProfile };
    (own[tab] || (window.AvesTabs || {})[tab] || renderDay)();
  }

  /* ───────────── подготовка пар ───────────── */
  function prepare(lessons, sub, spec) {
    let ls = lessons.filter((l) => !l.subgroup || !sub || l.subgroup === sub);
    if (spec) ls = ls.filter((l) => l.spec_order == null || l.spec_order === spec);
    const byKey = {};
    ls.forEach((l) => (byKey[keyOf(l)] = byKey[keyOf(l)] || []).push(l));
    const out = [];
    Object.keys(byKey).sort((a, b) => timeOf(byKey[a][0]).s - timeOf(byKey[b][0]).s || byKey[a][0].slot - byKey[b][0].slot).forEach((k) => {
      const arr = byKey[k];
      const slot = arr[0].slot;
      const base = { slot, time_start: arr[0].time_start, time_end: arr[0].time_end };
      const specs = arr.filter((l) => l.spec_order != null);
      if (specs.length > 1) {
        out.push({
          ...base, collapsed: true, kind: "specs", variants: specs,
          subject: (specs.find((x) => x.spec_title) || {}).spec_title || "Спецпрактикум",
          type: specs[0].type,
          comment: specs.some((x) => x.comment) ? "Есть примечания — раскройте варианты" : null,
        });
        arr.filter((l) => l.spec_order == null).forEach((l) => out.push({ slot, ...l }));
        return;
      }
      // ФМО: больше двух языковых подгрупп одного занятия — одна строка «N подгрупп» с раскрытием
      const bySubj = {};
      arr.filter((l) => l.label).forEach((l) => (bySubj[l.subject] = bySubj[l.subject] || []).push(l));
      const folded = new Set(Object.keys(bySubj).filter((x) => bySubj[x].length > 2));
      folded.forEach((subj) => out.push({
        ...base, collapsed: true, kind: "labels", variants: bySubj[subj], subject: subj, type: bySubj[subj][0].type,
        comment: bySubj[subj].some((x) => x.comment) ? "Есть примечания — раскройте подгруппы" : null,
      }));
      arr.filter((l) => !(l.label && folded.has(l.subject))).forEach((l) => out.push({ slot, ...l }));
    });
    return out;
  }

  function normSlot(s) {
    return {
      slot: s.slot, subject: s.subject || s.subject_name, type: s.lesson_type, room: s.room,
      address: s.address, offcampus: S.faculty === "fsk" && !!(s.address && !/курчатова/i.test(s.address)),
      teacher_short: s.teacher_short, subgroup: s.subgroup, comment: s.comment, groups: s.groups_display,
      time_start: s.time_start, time_end: s.time_end, label: s.label, online_url: s.online_url,
    };
  }

  function lessonHTML(it, state, label, same) {
    const t = timeOf(it);
    const cls = (state === "past" ? " is-past" : state === "now" ? " is-now" : "") + (same ? " is-same" : "");
    let meta = "";
    if (it.type) meta += `<span class="tag">${esc(it.type)}</span>`;
    if (it.collapsed) {
      meta += it.kind === "labels"
        ? `<span>${it.variants.length} ${plural(it.variants.length, "подгруппа", "подгруппы", "подгрупп")}</span>`
        : `<span>${it.variants.length} ${plural(it.variants.length, "вариант", "варианта", "вариантов")} по кафедрам</span>`;
    } else {
      if (it.label) meta += `<span class="tag">${esc(it.label)}</span>`;
      if (it.room) meta += `<span class="room">ауд. ${esc(it.room)}${it.floor ? `, ${it.floor} эт.` : ""}</span>`;
      else if (it.online_url) meta += `<span class="room">дистант</span>`;
      if (it.teacher_short && it.teacher_short !== "—") meta += `<span>${esc(it.teacher_short)}</span>`;
      if (it.subgroup) meta += `<span class="tag">${it.subgroup} п/г</span>`;
      if (it.choice) meta += `<span class="tag">по выбору</span>`;
      if (it.optional) meta += `<span class="tag">факультатив</span>`;
      if (it.usr) meta += `<span class="tag">УСР</span>`;
    }
    const variants = it.collapsed
      ? `<details class="lesson__more"><summary>${it.kind === "labels" ? "Показать подгруппы" : "Показать варианты"}</summary><ul class="variants">${it.variants.map((v) =>
          `<li><b>${esc(v.label || v.subject)}</b><br><span>${[v.room && "ауд. " + v.room, v.teacher_short].filter(Boolean).map(esc).join(", ")}</span>${v.comment ? `<br>✏️ ${esc(v.comment)}` : ""}</li>`).join("")}</ul></details>`
      : "";
    const online = !it.collapsed && it.online_url
      ? `<p class="lesson__note">💻 <button class="link-btn" type="button" data-act="open" data-url="${esc(it.online_url)}">Подключиться к дистанту</button></p>` : "";
    return `<li class="lesson${cls}">
      <div class="lesson__time"><b>${it.slot}</b><span>${t.start}<br>${t.end}</span></div>
      <div>
        ${label ? `<span class="lesson__state">${esc(label)}</span>` : ""}
        <p class="lesson__subject">${esc(it.subject)}</p>
        <div class="lesson__meta">${meta}</div>
        ${it.groups ? `<p class="lesson__groups">Группы: ${esc(it.groups)}</p>` : ""}
        ${it.comment && !it.collapsed ? `<p class="lesson__note">✏️ ${esc(it.comment)}${it.comment_author ? ` <small>— ${esc(it.comment_author)}</small>` : ""}</p>` : ""}
        ${online}
        ${it.offcampus ? `<p class="lesson__warn">Не в главном корпусе: ${esc(it.address)}</p>` : ""}
        ${variants}
      </div>
    </li>`;
  }

  function listHTML(items, dateIso) {
    const now = minskNow();
    const isToday = dateIso === now.date;
    let nextSlot = null;
    return `<ul class="lessons">${items.map((it, i) => {
      const same = i > 0 && keyOf(items[i - 1]) === keyOf(it);
      if (!isToday) return lessonHTML(it, null, null, same);
      const t = timeOf(it);
      if (now.minutes > t.e) return lessonHTML(it, "past", null, same);
      if (now.minutes >= t.s) return lessonHTML(it, "now", same ? null : `Идёт, до ${t.end}`, same);
      if (nextSlot === null || nextSlot === keyOf(it)) {
        const first = nextSlot === null; nextSlot = keyOf(it); const d = t.s - now.minutes;
        return lessonHTML(it, null, first && d <= 180 ? `Через ${inMinutes(d)}` : null, same);
      }
      return lessonHTML(it, null, null, same);
    }).join("")}</ul>`;
  }

  function weekNavHTML(dateIso, emptyDays) {
    const mon = mondayOf(dateIso), today = minskNow().date;
    const days = DAYS_SHORT.map((n, i) => {
      const d = addDays(mon, i);
      const cls = (d === today ? " is-today" : "") + (emptyDays && emptyDays[i] ? " is-empty" : "");
      return `<button class="day-btn${cls}" type="button" data-act="day" data-date="${d}" aria-pressed="${d === dateIso}" aria-label="${DAYS[i]}, ${human(d)}"><small>${n}</small><b>${dayNum(d)}</b></button>`;
    }).join("");
    return `<div class="week-nav">
        <button class="icon-btn" type="button" data-act="week" data-dir="-1" aria-label="Предыдущая неделя">${ICONS.prev}</button>
        <span class="week-nav__label">${weekLabel(mon)}</span>
        <button class="icon-btn" type="button" data-act="week" data-dir="1" aria-label="Следующая неделя">${ICONS.next}</button>
      </div>
      <div class="days" role="group" aria-label="Дни недели">${days}</div>`;
  }

  /* ───────────── вкладка «Пары» ───────────── */
  function currentGroup() { return S.viewGroup || S.user.group; }

  async function renderDay() {
    const g = currentGroup();
    const chip = hasLangs()
      ? (S.viewGroup ? null : { act: "langs-toggle", label: S.viewAll ? "Все подгруппы" : "Мои языки" })
      : { act: "sub-cycle", label: subLabel(S.viewSub) };
    setHead({ title: g.tag, sub: g.name, pick: true, chip });
    const key = weekKeyNow();
    if (S.weekKey !== key) {
      showLoading();
      try {
        S.week = await A.api(S.faculty, `/api/schedule?date=${mondayOf(S.date)}${S.viewGroup ? "&group_id=" + g.id : ""}${S.viewAll ? "&all=1" : ""}`, { onSlow: slowMsg });
        S.weekKey = key;
      } catch (e) { return handleError(e, renderDay); }
    }
    if (S.tab === "day") paintDay();
  }

  function paintDay() {
    const di = weekday(S.date);
    const spec = S.viewGroup ? null : S.user.specialization;
    const perDay = S.week.days.map((d) => prepare(d.lessons, S.viewSub, spec));
    const items = perDay[di] || [];
    const slots = new Set(items.map(keyOf)).size;
    const weekEmpty = perDay.every((d) => !d.length);

    let notes = "";
    if (S.viewGroup) notes += `<div class="notice">Вы смотрите группу ${esc(S.viewGroup.tag)}. <button class="link-btn" type="button" data-act="back-own">Вернуться к своей</button></div>`;
    if (S.week.is_fallback_week && !weekEmpty) notes += `<div class="notice">Расписание на эту неделю ещё не опубликовали. Показана последняя доступная неделя — с ${human(S.week.week_start)}.</div>`;

    let body;
    if (weekEmpty) body = emptyHTML("Неделя пустая", "Расписание на эти даты пока не выложили. Загляните позже — бот пришлёт уведомление, когда оно появится.");
    else if (!items.length) body = emptyHTML("Пар нет", "Можно выспаться или заняться своими делами.");
    else body = listHTML(items, S.date);

    view.innerHTML = `${weekNavHTML(S.date, perDay.map((d) => !d.length))}
      ${notes}
      <div class="day-head"><h2>${DAYS[di]}</h2><p>${human(S.date)}${slots ? `, ${slots} ${plural(slots, "пара", "пары", "пар")}` : ""}</p></div>
      ${body}`;
  }

  /* ───────────── вкладка «Поиск» ───────────── */
  function renderSearch() {
    setHead({ title: "Поиск", sub: C.faculties[S.faculty].title });
    const hints = (S.meta && S.meta.search_hints) || ["Свободные аудитории сейчас", "Что у меня в пятницу", "На неделю"];
    view.innerHTML = `<div class="search">
        <form id="sform" role="search">
          <label class="visually-hidden" for="q">Что найти</label>
          <input class="field" id="q" name="q" type="search" autocomplete="off" enterkeyhint="search"
            placeholder="Преподаватель, аудитория, предмет или группа" value="${esc(S.search.q)}">
          <button class="btn btn--solid" type="submit">Найти</button>
        </form>
        <div class="hints">${hints.map((h) => `<button class="chip" type="button" data-act="hint" data-q="${esc(h)}">${esc(h)}</button>`).join("")}</div>
      </div>
      <div id="sres" aria-live="polite"></div>`;
    $("#sform").addEventListener("submit", (e) => { e.preventDefault(); runSearch($("#q").value); });
    if (S.search.res) paintSearch();
  }

  async function runSearch(q) {
    q = (q || "").trim();
    if (q.length < 2) return toast("Введите хотя бы два символа");
    S.search.q = q; S.search.fullWeek = false;
    const out = $("#sres");
    out.innerHTML = loadingHTML("Ищем…");
    try {
      S.search.res = await A.api(S.faculty, "/api/search?q=" + encodeURIComponent(q), { onSlow: slowMsg });
      if (S.tab === "search") paintSearch();
    } catch (e) { out.innerHTML = emptyHTML("Поиск не сработал", e.message); }
  }

  function byDaysHTML(slots, weekStart, focusDay, norm) {
    const days = {};
    slots.forEach((s) => (days[s.day] = days[s.day] || []).push(s));
    const keys = Object.keys(days).map(Number).sort((a, b) => a - b)
      .filter((d) => focusDay == null || S.search.fullWeek || d === focusDay);
    if (!keys.length) return emptyHTML("В этот день пусто", "На другие дни недели есть совпадения.") + fullWeekBtn(focusDay);
    return keys.map((d) => {
      const date = addDays(weekStart, d);
      const items = norm ? days[d].map(normSlot).sort((a, b) => a.slot - b.slot) : days[d];
      return `<p class="day-label">${DAYS[d]}, ${human(date)}</p>${listHTML(items, date)}`;
    }).join("") + fullWeekBtn(focusDay);
  }
  function fullWeekBtn(focusDay) {
    return focusDay != null && !S.search.fullWeek
      ? `<div style="padding:0 1.25rem 1.5rem"><button class="btn btn--line" type="button" data-act="full-week">Показать всю неделю</button></div>` : "";
  }

  function paintSearch() {
    const r = S.search.res, out = $("#sres");
    if (!out) return;
    const title = (t, sub) => `<div class="result-title"><h2>${esc(t)}</h2>${sub ? `<p>${esc(sub)}</p>` : ""}</div>`;

    if (r.kind === "nothing") {
      out.innerHTML = emptyHTML("Ничего не нашлось", r.hint || "Попробуйте фамилию преподавателя, номер аудитории, предмет или «что у 1-41 в чт».");
    } else if (r.kind === "teacher" || r.kind === "room" || r.kind === "subject") {
      const label = { teacher: "Преподаватель", room: "Аудитория", subject: "Предмет" }[r.kind];
      out.innerHTML = title(r.title, `${label}, неделя ${weekLabel(r.week_start)}`) +
        (r.slots.length ? byDaysHTML(r.slots, r.week_start, r.day_index, true) : emptyHTML("Пар нет", "На этой неделе совпадений нет."));
    } else if (r.kind === "group") {
      const slots = [];
      r.days.forEach((d) => prepare(d.lessons, 0, null).forEach((it) => slots.push({ ...it, day: d.index })));
      out.innerHTML = title(r.group.tag, `${r.group.name}, неделя ${weekLabel(r.week_start)}`) +
        (slots.length ? byDaysHTML(slots, r.week_start, r.focus_day, false) : emptyHTML("Пар нет", "На этой неделе у группы нет занятий."));
    } else if (r.kind === "free_rooms") {
      if (r.all_done) { out.innerHTML = emptyHTML("Пары закончились", "На сегодня занятий больше нет — свободен весь корпус."); return; }
      const t = slotTime(r.slot);
      out.innerHTML = title(`Свободно на ${r.slot} паре`, `${DAYS[r.day_index]}, ${human(r.date)}, ${t.start}–${t.end}`) +
        (r.potochki && r.potochki.length ? `<p class="day-label">Поточки</p><div class="rooms">${r.potochki.map((x) => `<span class="tag">${esc(x)}</span>`).join("")}</div>` : "") +
        `<p class="day-label">Аудитории${r.classrooms ? ": " + r.classrooms.length : ""}</p>` +
        (r.classrooms && r.classrooms.length ? `<div class="rooms">${r.classrooms.map((x) => `<span class="tag">${esc(x)}</span>`).join("")}</div>` : `<p class="day-label">Свободных аудиторий не нашлось</p>`);
    } else if (r.kind === "free_rooms_day") {
      out.innerHTML = title("Свободные аудитории", `${DAYS[r.day_index]}, ${human(r.date)}`) +
        r.slots_summary.map((s) => {
          const t = slotTime(s.slot_id);
          return `<div class="free-slot"><b>${s.slot_id} пара, ${t.start}–${t.end}</b>
            <p>${s.free_potochki && s.free_potochki.length ? "Поточки: " + s.free_potochki.map(esc).join(", ") + ". " : ""}Свободных аудиторий: ${s.free_classrooms_count}${s.free_classrooms_preview.length ? " — " + s.free_classrooms_preview.map(esc).join(", ") : ""}</p></div>`;
        }).join("") +
        (r.all_day_free && r.all_day_free.length ? `<p class="day-label">Свободны весь день</p><div class="rooms">${r.all_day_free.map((x) => `<span class="tag">${esc(x)}</span>`).join("")}</div>` : "");
    } else {
      out.innerHTML = emptyHTML("Непонятный ответ", "Обновите приложение.");
    }
  }

  /* ───────────── вкладка «Сравнить» ───────────── */
  async function renderCompare() {
    setHead({ title: "Сравнить группы", sub: weekLabel(mondayOf(S.date)) });
    if (!S.compare.ids.length) S.compare.ids = [S.user.group.id];
    const key = S.compare.ids.join(",") + "@" + mondayOf(S.date);
    if (S.compare.key !== key) {
      showLoading();
      try {
        S.compare.data = await A.api(S.faculty, `/api/compare?ids=${S.compare.ids.join(",")}&date=${mondayOf(S.date)}`, { onSlow: slowMsg });
        S.compare.key = key;
      } catch (e) { return handleError(e, renderCompare); }
    }
    if (S.tab === "compare") paintCompare();
  }

  function paintCompare() {
    const weeks = S.compare.data.weeks, di = weekday(S.date);
    const chips = S.compare.ids.map((id) => {
      const g = S.groupsById[id];
      const removable = S.compare.ids.length > 1;
      return `<button class="chip is-on" type="button" ${removable ? `data-act="cmp-remove" data-id="${id}" aria-label="Убрать ${esc(g && g.tag)}"` : "disabled"}>${esc(g ? g.tag : id)}${removable ? '<span class="x" aria-hidden="true">×</span>' : ""}</button>`;
    }).join("");
    const add = S.compare.ids.length < 4 ? `<button class="chip" type="button" data-act="cmp-add">+ Группа</button>` : "";

    const cols = weeks.map((w) => prepare(w.days[di].lessons, 0, null));
    const slots = [...new Set(cols.flat().map((x) => x.slot))].sort((a, b) => a - b);
    const timeIn = (s) => { const t = cols.flat().find((x) => x.slot === s && x.time_start); return t ? t.time_start : slotTime(s).start; };

    let grid;
    if (!slots.length) grid = emptyHTML("Ни у кого нет пар", "Выберите другой день или добавьте группу.");
    else {
      const n = weeks.length;
      let cells = `<div class="cgrid__head"></div>` + weeks.map((w) => `<div class="cgrid__head">${esc(w.group.tag)}<small>${esc(w.group.name)}</small></div>`).join("");
      slots.forEach((s) => {
        const t = slotTime(s);
        cells += `<div class="cgrid__slot"><b>${s}</b><span>${timeIn(s) || t.start}</span></div>`;
        cols.forEach((items) => {
          const here = items.filter((x) => x.slot === s);
          cells += here.length
            ? `<div class="cgrid__cell">${here.map((x) => `<div class="one"><b>${esc(x.subject)}</b><span>${[x.type, x.collapsed && x.kind === "labels" ? x.variants.length + " подгр." : x.label, x.room && "ауд. " + x.room, x.subgroup && x.subgroup + " п/г"].filter(Boolean).map(esc).join(", ")}</span></div>`).join("")}</div>`
            : `<div class="cgrid__cell is-free">окно</div>`;
        });
      });
      grid = `<div class="grid-wrap"><div class="cgrid" style="grid-template-columns: 3.4rem repeat(${n}, minmax(150px, 1fr))">${cells}</div></div>`;
    }
    view.innerHTML = `<div class="compare-bar">${chips}${add}</div>${weekNavHTML(S.date)}
      <div class="day-head"><h2>${DAYS[di]}</h2><p>${human(S.date)}</p></div>${grid}`;
  }

  /* ───────────── вкладка «Профиль» ───────────── */
  function renderProfile() {
    const u = S.user, f = C.faculties[S.faculty];
    setHead({ title: "Профиль", sub: f.title });
    const subSeg = [0, 1, 2].map((n) => `<button type="button" data-act="set-sub" data-sub="${n}" aria-pressed="${(u.subgroup || 0) === n}">${n ? n : "Вся"}</button>`).join("");
    const specs = u.specializations && u.specializations.length
      ? `<div class="row"><div class="row__label"><span>Специализация</span><small>Чтобы видеть только свою кафедру</small></div>
          <select class="field" id="spec" style="max-width:55%"><option value="">Все варианты</option>${u.specializations.map((s) => `<option value="${s.order}" ${u.specialization === s.order ? "selected" : ""}>${esc(s.title)}</option>`).join("")}</select></div>` : "";
    const multi = Object.keys(C.faculties).length > 1;

    view.innerHTML = `
      <section class="panel">
        <p class="hello">Привет, ${esc(u.name)}</p>
        <p style="margin:0;color:var(--muted)">${esc(u.group.tag)}, ${esc(u.group.name)}</p>
      </section>
      <section class="panel"><h3>Учёба</h3>
        <div class="row"><div class="row__label"><span>Группа ${esc(u.group.tag)}</span><small>${esc(f.short)}, ${u.group.course} курс</small></div>
          <button class="link-btn" type="button" data-act="change-group">Сменить</button></div>
        ${hasLangs()
          ? `<div class="row"><div class="row__label"><span>Языки и ДВС</span><small>${esc(langsSummary(u))}</small></div>
              <button class="link-btn" type="button" data-act="langs-edit">Настроить</button></div>`
          : `<div class="row"><div class="row__label"><span>Подгруппа</span><small>Пары другой подгруппы скрываются</small></div><div class="seg">${subSeg}</div></div>`}
        ${specs}
      </section>
      <section class="panel"><h3>Уведомления от бота</h3>
        <div class="row"><label class="row__label" for="n1"><span>Расписание от бота</span><small>${u.notify_mode === "evening" ? "Вечером в 20:00 — пары на завтра" : u.notify_mode === "both" ? "В 7:45 на сегодня и в 20:00 на завтра" : "Утром в 7:45 — пары на сегодня"}</small></label>
          <input class="switch" id="n1" type="checkbox" data-pref="notifications" ${u.notifications ? "checked" : ""}></div>
        ${u.notify_mode != null && u.notifications ? `<div class="row"><div class="row__label"><span>Когда присылать</span><small>Вечером удобно заранее собраться</small></div>
          <div class="seg">${[["morning", "Утро"], ["evening", "Вечер"], ["both", "Оба"]].map(([v, l]) => `<button type="button" data-act="set-nmode" data-v="${v}" aria-pressed="${u.notify_mode === v}">${l}</button>`).join("")}</div></div>` : ""}
        <div class="row"><label class="row__label" for="n2"><span>Изменения в расписании</span><small>Замены, переносы, новые пары</small></label>
          <input class="switch" id="n2" type="checkbox" data-pref="change_notifications" ${u.change_notifications ? "checked" : ""}></div>
      </section>
      <section class="panel"><h3>Имя в карточках</h3>
        <form class="name-form" id="nform"><label class="visually-hidden" for="nm">Имя</label>
          <input class="field" id="nm" maxlength="32" value="${esc(u.name)}"><button class="btn btn--line" type="submit">Сохранить</button></form>
      </section>
      <section class="panel"><h3>Ещё в стае</h3>
        <div class="row"><div class="row__label"><span>Конспекты</span><small>AvesStudy — лента вашего факультета</small></div>
          <button class="link-btn" type="button" data-act="open" data-url="https://t.me/${esc(C.studyBot)}">Открыть</button></div>
        <div class="row"><div class="row__label"><span>Скидки для студентов</span><small>Раздел готовится</small></div><span class="soon">Скоро</span></div>
        <div class="row"><div class="row__label"><span>Подработки</span><small>Раздел готовится</small></div><span class="soon">Скоро</span></div>
      </section>
      <section class="panel"><h3>Aves</h3>
        <div class="row"><div class="row__label"><span>Ночная тема</span><small>Или нажмите на птицу вверху</small></div>
          <input class="switch" type="checkbox" data-act="theme" ${AvesTheme.current() === "dark" ? "checked" : ""} aria-label="Ночная тема"></div>
        <div class="row"><span>Идея или баг</span><button class="link-btn" type="button" data-act="open" data-url="${esc(C.channelUrl)}">Написать в канал</button></div>
        <div class="row"><span>О проекте</span><button class="link-btn" type="button" data-act="open" data-url="${esc(C.site)}/">${esc(C.site.replace("https://", ""))}</button></div>
        ${!inTg && multi ? `<div class="row"><span>Другой факультет</span><button class="link-btn" type="button" data-act="switch-faculty">Сменить</button></div>` : ""}
        ${!inTg ? `<div class="row"><span>Выход с этого устройства</span><button class="link-btn" type="button" data-act="logout">Выйти</button></div>` : ""}
      </section>`;

    view.querySelectorAll("[data-pref]").forEach((el) => el.addEventListener("change", () =>
      patchMe({ [el.dataset.pref]: el.checked }, el.checked ? "Включено" : "Выключено").then((ok) => { if (!ok) el.checked = !el.checked; else if (el.dataset.pref === "notifications") renderProfile(); })));
    const sp = $("#spec");
    if (sp) sp.addEventListener("change", () => patchMe({ specialization: sp.value ? +sp.value : null }, "Специализация сохранена").then(resetWeek));
    $("#nform").addEventListener("submit", (e) => { e.preventDefault(); patchMe({ name: $("#nm").value.trim() }, "Имя сохранено").then(() => go("profile")); });
  }

  async function patchMe(body, okMsg) {
    try {
      const r = await A.api(S.faculty, "/api/me", { method: "PATCH", body });
      S.user = r.user; haptic("success"); if (okMsg) toast(okMsg);
      return true;
    } catch (e) {
      haptic("error");
      if (e.code === "banned" || e.status === 401) { handleError(e); return false; }
      toast(e.message); return false;
    }
  }
  function resetWeek() { S.weekKey = ""; S.compare.key = ""; }

  /* ───────────── языки и ДВС (ФМО) ───────────── */
  function langsSummary(u) {
    const keys = Object.values(u.tracks || {}).flat();
    const ch = u.choices || [];
    if (!keys.length && !ch.length) return "Не выбраны — видны все подгруппы";
    return [keys.join(", "), ch.length ? `ДВС: ${ch.length}` : ""].filter(Boolean).join("; ");
  }

  function langsFormHTML(opts, u) {
    const tracks = (opts.tracks || []).map((t) => {
      const mine = ((u && u.tracks) || {})[t.track] || [];
      const options = t.options.map((o) =>
        `<option value="${esc(o.key)}" ${mine.includes(o.key) ? "selected" : ""}>${esc(o.key)}${o.teachers.length && !o.key.includes("·") ? " — " + esc(o.teachers[0]) : ""}${o.here ? " · ваша группа" : ""}</option>`).join("");
      return `<label class="lang-field"><span>${esc(TRACK_TITLES[t.track] || "Иностранный язык")}</span>
        <select class="field" data-track="${esc(t.track)}"><option value="">Все подгруппы</option>${options}</select></label>`;
    }).join("");
    const choices = (opts.choices || []).map((set, i) => {
      const picked = set.find((x) => ((u && u.choices) || []).includes(x)) || "";
      return `<label class="lang-field"><span>Дисциплина по выбору${opts.choices.length > 1 ? " " + (i + 1) : ""}</span>
        <select class="field" data-choice="${i}"><option value="">Не знаю / все</option>${set.map((x) => `<option ${x === picked ? "selected" : ""}>${esc(x)}</option>`).join("")}</select></label>`;
    }).join("");
    if (!tracks && !choices) return `<p>У вашей группы нет языковых подгрупп и дисциплин по выбору — видно всё расписание.</p>`;
    return `<div class="stack lang-form">${tracks}${choices}</div>`;
  }

  function readLangsForm(root) {
    const tracks = {}, choices = [];
    root.querySelectorAll("select[data-track]").forEach((el) => { if (el.value) tracks[el.dataset.track] = [el.value]; });
    root.querySelectorAll("select[data-choice]").forEach((el) => { if (el.value) choices.push(el.value); });
    return { tracks, choices };
  }

  async function loadOptions(groupId) {
    return A.api(S.faculty, "/api/options" + (groupId ? "?group_id=" + groupId : ""), { onSlow: slowMsg });
  }

  async function openLangsSheet() {
    window.AvesApp.openSheet(`<div class="sheet__body">${loadingHTML("Загружаем подгруппы…")}</div>`);
    try {
      const opts = await loadOptions();
      $("#sheet").innerHTML = `<div class="sheet__head"><h3>Языки и ДВС</h3>
          <button class="icon-btn" type="button" data-act="sheet-close" aria-label="Закрыть">${ICONS.close}</button></div>
        <div class="sheet__body"><p style="margin-top:0;color:var(--muted)">Расписание, уведомления и заметки будут только по вашим подгруппам. Не уверены — оставьте «Все подгруппы».</p>
          ${langsFormHTML(opts, S.user)}
          <div class="stack" style="margin-top:1rem"><button class="btn btn--solid" type="button" data-act="langs-save">Сохранить</button></div></div>`;
    } catch (e) { closeSheet(); toast(e.message); }
  }

  /* ───────────── выбор группы (лист снизу) ───────────── */
  function courseKey(g) { return (g.study_mode === "Дневная" ? "d" : g.study_mode === "Магистратура" ? "m" : "z") + g.course; }
  function courseName(key) {
    const c = key.slice(1);
    return key[0] === "d" ? `${c} курс` : key[0] === "m" ? `${c} курс маг.` : `${c} курс заоч.`;
  }
  function courseList() {
    const seen = [];
    S.meta.groups.forEach((g) => { const k = courseKey(g); if (!seen.includes(k)) seen.push(k); });
    const order = { d: 0, m: 1, z: 2 };
    return seen.sort((a, b) => order[a[0]] - order[b[0]] || +a.slice(1) - +b.slice(1));
  }

  function openGroupPicker(title, onPick, startKey) {
    S.picker = { title, onPick, active: startKey || courseKey(currentGroup()) };
    paintPicker();
    $("#sheet-back").hidden = false; $("#sheet").hidden = false;
    requestAnimationFrame(() => { $("#sheet-back").classList.add("is-open"); $("#sheet").classList.add("is-open"); });
    if (tg && tg.BackButton) { tg.BackButton.show(); tg.BackButton.onClick(closeSheet); }
  }
  function paintPicker() {
    const p = S.picker;
    const groups = S.meta.groups.filter((g) => courseKey(g) === p.active);
    $("#sheet").innerHTML = `<div class="sheet__head"><h3>${esc(p.title)}</h3>
        <button class="icon-btn" type="button" data-act="sheet-close" aria-label="Закрыть">${ICONS.close}</button></div>
      <div class="sheet__body">
        <div class="courses">${courseList().map((k) => `<button class="chip ${k === p.active ? "is-on" : ""}" type="button" data-act="gp-course" data-key="${k}">${courseName(k)}</button>`).join("")}</div>
        <div class="stack">${groups.map((g) => `<button class="choice" type="button" data-act="gp-group" data-id="${g.id}"><b>${esc(g.tag)}</b><small>${esc(g.name)}</small></button>`).join("")}</div>
      </div>`;
  }
  function closeSheet() {
    const sh = $("#sheet"), bk = $("#sheet-back");
    sh.classList.remove("is-open"); bk.classList.remove("is-open");
    setTimeout(() => { sh.hidden = true; bk.hidden = true; }, 300);
    if (tg && tg.BackButton) { tg.BackButton.offClick(closeSheet); tg.BackButton.hide(); }
    S.picker = null;
  }

  /* ───────────── вход, выбор факультета, онбординг ───────────── */
  function showLogin() {
    chrome(false);
    view.innerHTML = `<div class="center">
      <button class="theme-bird" type="button" data-theme-toggle aria-label="Сменить тему" style="justify-self:start"><span class="bird bird--dove big"></span></button>
      <h1>Ваше расписание</h1>
      <p>Войдите через Telegram — тем же аккаунтом, что и в боте. Если ботом ещё не пользовались, группу выберете прямо здесь.</p>
      <div class="stack">
        <button class="btn btn--solid" type="button" data-act="login">${A.tgIcon}<span>Войти через Telegram</span></button>
        <a class="btn btn--line" href="/">Что такое Aves</a>
      </div></div>`;
  }

  function showFacultyChoice(keys, mode) {
    chrome(false);
    const t = mode === "registered" ? ["Какое расписание открыть?", "Вы пользуетесь несколькими ботами Aves."]
      : ["Ваш факультет", "Сайт подключится к боту вашего факультета. Настройки сразу появятся и в Telegram."];
    view.innerHTML = `<div class="center">
      <span class="bird bird--dove big" aria-hidden="true"></span>
      <h1>${t[0]}</h1><p>${t[1]}</p>
      <div class="stack">${keys.map((k) => `<button class="choice" type="button" data-act="faculty" data-f="${k}" data-mode="${mode}"><b>${esc(C.faculties[k].title)}</b><small>${esc(C.faculties[k].bird)}, @${esc(C.faculties[k].bot)}</small></button>`).join("")}</div>
      ${!inTg ? `<button class="link-btn back" type="button" data-act="logout">Выйти</button>` : ""}</div>`;
  }

  function startOnboarding() {
    chrome(false);
    S.ob = { step: "course", key: null, groupId: null };
    paintOnboarding();
  }
  function paintOnboarding() {
    const ob = S.ob, f = C.faculties[S.faculty];
    let title, text, list, step;
    if (ob.step === "course") {
      step = 1; title = "Какой у вас курс?"; text = f.title;
      list = courseList().map((k) => `<button class="choice" type="button" data-act="ob-course" data-key="${k}"><b>${courseName(k)}</b></button>`).join("");
    } else if (ob.step === "group") {
      step = 2; title = "Ваша группа"; text = courseName(ob.key);
      list = S.meta.groups.filter((g) => courseKey(g) === ob.key)
        .map((g) => `<button class="choice" type="button" data-act="ob-group" data-id="${g.id}"><b>${esc(g.tag)}</b><small>${esc(g.name)}</small></button>`).join("");
    } else if (ob.step === "langs") {
      step = 3; title = "Языки и ДВС"; text = "Выберите свои подгруппы — в расписании останутся только ваши пары. Поменять можно в профиле.";
      list = ob.opts ? langsFormHTML(ob.opts, null) + `<button class="btn btn--solid" type="button" data-act="ob-langs">Готово</button>` : loadingHTML("Загружаем подгруппы…");
    } else {
      step = 3; title = "Подгруппа"; text = "Не знаете — выберите «Вся группа». Поменять можно в профиле.";
      list = [[0, "Вся группа"], [1, "1 подгруппа"], [2, "2 подгруппа"]]
        .map(([n, l]) => `<button class="choice" type="button" data-act="ob-sub" data-sub="${n}"><b>${l}</b></button>`).join("");
    }
    view.innerHTML = `<div class="center">
      <p class="progress">Шаг ${step} из 3</p>
      <h1>${title}</h1><p>${esc(text)}</p>
      <div class="stack">${list}</div>
      ${step > 1 ? `<button class="link-btn back" type="button" data-act="ob-back">Назад</button>` : ""}</div>`;
    window.scrollTo(0, 0);
  }

  /* ───────────── ошибки ───────────── */
  function handleError(e, retry) {
    if (e && e.status === 401 && !inTg) { A.logout(); return showLogin(); }
    if (e && e.code === "banned") {
      chrome(false);
      view.innerHTML = `<div class="center"><span class="bird bird--dove big" aria-hidden="true"></span>
        <h1>Доступ ограничен</h1><p>${esc(e.message)}</p>
        <p>Если это ошибка, напишите в личные сообщения канала.</p>
        <div class="stack"><button class="btn btn--line" type="button" data-act="open" data-url="${esc(C.channelUrl)}">Написать в канал</button>
        ${!inTg ? `<button class="link-btn back" type="button" data-act="logout">Выйти</button>` : ""}</div></div>`;
      return;
    }
    chrome(S.user && S.user.group ? true : false);
    view.innerHTML = `<div class="center"><span class="bird bird--dove big" aria-hidden="true"></span>
      <h1>Птица не долетела</h1><p>${esc(e && e.message ? e.message : "Что-то пошло не так.")}</p>
      <div class="stack"><button class="btn btn--solid" type="button" data-act="retry">Попробовать ещё раз</button></div></div>`;
    S.retry = retry || boot;
  }

  /* ───────────── запуск ───────────── */
  async function enter() {
    if (!inTg) A.store.set(A.K.faculty, S.faculty);
    S.meta = await A.api(S.faculty, "/api/meta", { auth: false, onSlow: slowMsg });
    S.groupsById = {};
    S.meta.groups.forEach((g) => (S.groupsById[g.id] = g));
    if (!S.meta.ready) throw new Error("Бот только что проснулся и ещё загружает расписание. Попробуйте через полминуты.");
    if (!S.user || !S.user.group) return startOnboarding();

    S.date = defaultDate();
    S.viewSub = S.user.subgroup || 0;
    S.viewGroup = null;
    S.viewAll = false;
    S.compare.ids = [S.user.group.id];
    resetWeek();
    chrome(true);
    go("day");
  }

  async function bootTelegram() {
    const qf = new URLSearchParams(location.search).get("f") || (tg.initDataUnsafe && tg.initDataUnsafe.start_param);
    const keys = qf && C.faculties[qf] ? [qf] : Object.keys(C.faculties);
    const res = await Promise.any(keys.map((k) =>
      A.api(k, "/api/auth/webapp", { method: "POST", auth: false, body: { init_data: tg.initData }, onSlow: slowMsg }).then((r) => ({ k, r }))
    )).catch((agg) => { throw (agg.errors && agg.errors[0]) || agg; });
    A.setToken(res.r.token, false);
    S.faculty = res.k; S.user = res.r.user;
    await enter();
  }

  async function bootWeb() {
    if (!A.getToken()) return showLogin();
    const stored = A.store.get(A.K.faculty);
    if (stored && C.faculties[stored]) {
      const r = await A.api(stored, "/api/me", { onSlow: slowMsg });
      S.faculty = stored; S.user = r.user;
      return enter();
    }
    const keys = Object.keys(C.faculties);
    const settled = await Promise.allSettled(keys.map((k) => A.api(k, "/api/me", { onSlow: slowMsg }).then((r) => ({ k, r }))));
    const good = settled.filter((x) => x.status === "fulfilled").map((x) => x.value);
    if (!good.length) throw settled[0].reason;
    S.regResults = {};
    good.forEach((x) => (S.regResults[x.k] = x.r.user));
    const reg = good.filter((x) => x.r.user && x.r.user.group);
    if (reg.length === 1) { S.faculty = reg[0].k; S.user = reg[0].r.user; return enter(); }
    if (reg.length > 1) return showFacultyChoice(reg.map((x) => x.k), "registered");
    return showFacultyChoice(good.map((x) => x.k), "new");
  }

  async function boot() {
    chrome(false);
    showLoading();
    try {
      if (inTg) await bootTelegram(); else await bootWeb();
    } catch (e) { handleError(e, boot); }
  }

  /* ───────────── действия ───────────── */
  const actions = {
    async login(el) { el.disabled = true; await A.startLogin("/app/"); },
    logout() { A.logout(); location.href = "/app/"; },
    retry() { (S.retry || boot)(); },
    tab(el) { haptic("select"); go(el.dataset.tab); },
    day(el) { haptic("select"); S.date = el.dataset.date; S.tab === "compare" ? renderCompare() : renderDay(); },
    week(el) { haptic("select"); S.date = addDays(S.date, 7 * +el.dataset.dir); S.tab === "compare" ? renderCompare() : renderDay(); },
    "sub-cycle"() { haptic("select"); S.viewSub = (S.viewSub + 1) % 3; renderDay(); },
    "langs-toggle"() { haptic("select"); S.viewAll = !S.viewAll; renderDay(); },
    "langs-edit"() { openLangsSheet(); },
    async "langs-save"() {
      const ok = await patchMe(readLangsForm($("#sheet")), "Языки сохранены");
      if (ok) { closeSheet(); S.viewAll = false; resetWeek(); renderProfile(); }
    },
    async "ob-langs"() {
      const picked = readLangsForm(view);   // до showLoading: он перерисует экран
      showLoading("Сохраняем…");
      const ok = await patchMe(picked);
      if (!ok) return paintOnboarding();
      toast("Готово! Бот тоже знает вашу группу и языки");
      try { await enter(); } catch (e) { handleError(e, boot); }
    },
    "view-group"() { openGroupPicker("Чьё расписание смотрим?", (g) => { S.viewGroup = g.id === S.user.group.id ? null : g; S.viewSub = S.viewGroup ? 0 : S.user.subgroup || 0; renderDay(); }); },
    "back-own"() { S.viewGroup = null; S.viewSub = S.user.subgroup || 0; renderDay(); },
    hint(el) { const q = el.dataset.q; const inp = $("#q"); if (inp) inp.value = q; runSearch(q); },
    "full-week"() { S.search.fullWeek = true; paintSearch(); },
    "cmp-add"() { openGroupPicker("Добавить к сравнению", (g) => { if (!S.compare.ids.includes(g.id)) S.compare.ids.push(g.id); renderCompare(); }); },
    "cmp-remove"(el) { S.compare.ids = S.compare.ids.filter((x) => x !== +el.dataset.id); renderCompare(); },
    "set-nmode"(el) {
      patchMe({ notify_mode: el.dataset.v }, { morning: "Буду присылать утром", evening: "Буду присылать вечером", both: "Утром и вечером" }[el.dataset.v])
        .then((ok) => { if (ok) renderProfile(); });
    },
    "set-sub"(el) {
      const n = +el.dataset.sub;
      patchMe({ subgroup: n }, n ? `${n} подгруппа` : "Вся группа").then((ok) => { if (ok) { S.viewSub = n; renderProfile(); } });
    },
    "change-group"() {
      openGroupPicker("Ваша группа", (g) => patchMe({ group_id: g.id }, `Группа ${g.tag}`).then((ok) => {
        if (ok) { S.viewGroup = null; S.compare.ids = [g.id]; resetWeek(); renderProfile(); }
      }), courseKey(S.user.group));
    },
    theme(el) { AvesTheme.save(el.checked ? "dark" : "light"); AvesTheme.apply(el.checked ? "dark" : "light"); },
    open(el) { openExt(el.dataset.url); },
    "switch-faculty"() { A.store.del(A.K.faculty); boot(); },
    "sheet-close"() { closeSheet(); },
    "gp-course"(el) { haptic("select"); S.picker.active = el.dataset.key; paintPicker(); },
    "gp-group"(el) { const g = S.groupsById[+el.dataset.id]; const cb = S.picker.onPick; haptic("select"); closeSheet(); cb(g); },
    async faculty(el) {
      S.faculty = el.dataset.f;
      S.user = S.regResults ? S.regResults[S.faculty] : null;
      showLoading();
      try { await enter(); } catch (e) { handleError(e, boot); }
    },
    "ob-course"(el) { S.ob.key = el.dataset.key; S.ob.step = "group"; paintOnboarding(); },
    async "ob-group"(el) {
      S.ob.groupId = +el.dataset.id;
      if (S.meta && S.meta.faculty === "fmo") {
        // ФМО: сразу сохраняем группу и спрашиваем языки (у ФМО нет подгрупп 1/2, есть языковые)
        showLoading("Сохраняем…");
        if (!(await patchMe({ group_id: S.ob.groupId }))) return paintOnboarding();
        S.ob.step = "langs"; S.ob.opts = null; paintOnboarding();
        try { S.ob.opts = await loadOptions(S.ob.groupId); } catch (e) { S.ob.opts = { tracks: [], choices: [] }; }
        if (S.ob.step === "langs") paintOnboarding();
        return;
      }
      S.ob.step = "sub"; paintOnboarding();
    },
    "ob-back"() { S.ob.step = S.ob.step === "sub" || S.ob.step === "langs" ? "group" : "course"; paintOnboarding(); },
    async "ob-sub"(el) {
      showLoading("Сохраняем…");
      const ok = await patchMe({ group_id: S.ob.groupId, subgroup: +el.dataset.sub });
      if (!ok) return paintOnboarding();
      toast("Готово! Бот тоже знает вашу группу");
      try { await enter(); } catch (e) { handleError(e, boot); }
    },
  };

  document.addEventListener("click", (e) => {
    const el = e.target.closest("[data-act]");
    if (!el || el.disabled) return;
    const fn = actions[el.dataset.act];
    if (fn) fn(el, e);
  });
  $("#sheet-back").addEventListener("click", closeSheet);
  document.addEventListener("keydown", (e) => { if (e.key === "Escape" && S.picker) closeSheet(); });

  // Свайп по дню — соседний день
  let tx = 0, ty = 0;
  view.addEventListener("touchstart", (e) => { tx = e.touches[0].clientX; ty = e.touches[0].clientY; }, { passive: true });
  view.addEventListener("touchend", (e) => {
    if (S.tab !== "day" || !S.week) return;
    if (e.target.closest(".grid-wrap, details")) return;
    const dx = e.changedTouches[0].clientX - tx, dy = e.changedTouches[0].clientY - ty;
    if (Math.abs(dx) < 60 || Math.abs(dy) > 45) return;
    let d = addDays(S.date, dx < 0 ? 1 : -1);
    if (weekday(d) === 6) d = addDays(d, dx < 0 ? 1 : -1);
    S.date = d; haptic("select"); renderDay();
  }, { passive: true });

  // Раз в минуту обновляем «идёт сейчас»
  setInterval(() => { if (S.tab === "day" && S.week && S.user && S.weekKey === weekKeyNow() && !S.picker && !document.hidden && !view.querySelector("details[open]")) paintDay(); }, 60000);

  document.addEventListener("aves:theme", syncTgColors);

  if (tg) {
    try {
      tg.ready(); tg.expand();
      if (tg.disableVerticalSwipes) tg.disableVerticalSwipes();
      if (!A.store.get("aves.theme")) AvesTheme.apply(tg.colorScheme === "dark" ? "dark" : "light");
      syncTgColors();
    } catch (_) {}
  }

  // Для подключаемых вкладок (assets/js/study.js)
  window.AvesApp = {
    S, A, C, $, view, esc, inTg, tg, actions, go, setHead, toast, haptic, openExt,
    emptyHTML, loadingHTML, slowMsg, handleError, closeSheet, plural,
    openSheet(html) {
      const sh = $("#sheet"), bk = $("#sheet-back");
      sh.innerHTML = html; S.picker = { custom: true };
      bk.hidden = false; sh.hidden = false;
      requestAnimationFrame(() => { bk.classList.add("is-open"); sh.classList.add("is-open"); });
      if (tg && tg.BackButton) { tg.BackButton.show(); tg.BackButton.onClick(closeSheet); }
    },
  };

  boot();
})();
