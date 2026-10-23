/* Сетки звонков факультетов — один источник для главной (радар, демо-чат) и страницы /zvonki/.
   Время взято из кода ботов: биофак — MambaBot/services/formatter.py, ФСК — MambaFSK/config.py,
   ФМО — MambaFMO/fmo_db/slots.py (сверено с PDF-таблицами fir.bsu.by).
   Поменялась сетка у бота — поменяй здесь и в таблицах на /zvonki/index.html. */
(function () {
  var DATA = {
    bio: {
      short: "Биофак",
      campus: "Биофак · ул. Курчатова, 10",
      note: "Сетка AvesBio. Пары по 85 минут, большая перемена — перед 4-й парой.",
      slots: [
        ["09:00", "10:25"], ["10:35", "12:00"], ["12:10", "13:35"], ["14:00", "15:25"],
        ["15:35", "17:00"], ["17:10", "18:35"], ["18:45", "20:10"], ["20:30", "21:55"]
      ]
    },
    fsk: {
      short: "ФСК",
      campus: "ФСК · ул. Курчатова, 5",
      note: "Сетка AvesFlow. Пары по 85 минут, длинные перемены — перед 3-й и 6-й парой.",
      slots: [
        ["08:30", "09:55"], ["10:05", "11:30"], ["11:50", "13:15"], ["13:25", "14:50"],
        ["15:00", "16:25"], ["16:45", "18:10"], ["18:20", "19:45"]
      ]
    },
    fmo: {
      short: "ФМО",
      campus: "ФМО · ул. Ленинградская, 20",
      note: "Сетка AvesGlobe по таблицам факультета. Пары по 80 минут, большая перемена — перед 4-й парой. Некоторые занятия идут по своему времени (например, физкультура 9.30–10.50) — точное время бот показывает у каждой пары.",
      slots: [
        ["08:30", "09:50"], ["10:00", "11:20"], ["11:30", "12:50"], ["13:20", "14:40"],
        ["14:50", "16:10"], ["16:30", "17:50"], ["18:00", "19:20"], ["19:30", "20:50"]
      ]
    }
  };

  function toMin(hhmm) { var p = hhmm.split(":"); return (+p[0]) * 60 + (+p[1]); }

  function inMinutes(m) {
    if (m < 60) return m + " мин";
    var h = Math.floor(m / 60), r = m % 60;
    return h + " ч" + (r ? " " + r + " мин" : "");
  }

  // Сейчас по Минску: дата (UTC-полночь той же календарной даты), день недели 0=пн … 6=вс, минуты от полуночи
  function minskNow() {
    var p = new Intl.DateTimeFormat("en-CA", {
      timeZone: "Europe/Minsk", year: "numeric", month: "2-digit", day: "2-digit",
      hour: "2-digit", minute: "2-digit", hourCycle: "h23"
    }).formatToParts(new Date());
    var g = function (t) { var f = p.find(function (x) { return x.type === t; }); return f ? f.value : "00"; };
    var date = new Date(Date.UTC(+g("year"), +g("month") - 1, +g("day")));
    return {
      date: date,
      weekday: (date.getUTCDay() + 6) % 7,
      hh: g("hour"), mm: g("minute"),
      minutes: (+g("hour")) * 60 + (+g("minute"))
    };
  }

  // Что происходит на факультете прямо сейчас: заголовок, подпись, прогресс (0–100), индекс текущей пары
  function status(fac, now) {
    var slots = DATA[fac].slots;
    now = now || minskNow();
    var m = now.minutes, res = { title: "", sub: "", pct: 0, active: -1, sunday: now.weekday === 6 };
    var first = slots[0], last = slots[slots.length - 1];

    if (res.sunday) {
      res.title = "Воскресенье — пар нет";
      res.sub = "Завтра первая пара в " + first[0];
      res.pct = 100;
      return res;
    }
    if (m < toMin(first[0])) {
      res.title = "До 1-й пары " + inMinutes(toMin(first[0]) - m);
      res.sub = "Первая пара: " + first[0] + "–" + first[1];
      return res;
    }
    if (m >= toMin(last[1])) {
      res.title = "Пары на сегодня закончились";
      res.sub = (now.weekday === 5 ? "В понедельник" : "Завтра") + " первая пара в " + first[0];
      res.pct = 100;
      return res;
    }
    for (var i = 0; i < slots.length; i++) {
      var s = toMin(slots[i][0]), e = toMin(slots[i][1]);
      if (m >= s && m < e) {
        res.active = i;
        res.pct = Math.round(((m - s) / (e - s)) * 100);
        res.title = "Идёт " + (i + 1) + "-я пара · до звонка " + inMinutes(e - m);
        res.sub = slots[i][0] + "–" + slots[i][1] + (slots[i + 1] ? " · дальше " + (i + 2) + "-я пара в " + slots[i + 1][0] : " · последняя пара в сетке");
        return res;
      }
      if (slots[i + 1] && m >= e && m < toMin(slots[i + 1][0])) {
        var next = toMin(slots[i + 1][0]), total = next - e;
        res.pct = Math.round(((m - e) / total) * 100);
        res.title = (total >= 20 ? "Большая перемена" : "Перемена") + " · до " + (i + 2) + "-й пары " + inMinutes(next - m);
        res.sub = "Следующая пара: " + slots[i + 1][0] + "–" + slots[i + 1][1];
        return res;
      }
    }
    return res;
  }

  window.AvesBells = { data: DATA, toMin: toMin, inMinutes: inMinutes, minskNow: minskNow, status: status };
})();
