/* Тема, динамическая палитра факультета и плавные анимации появления.
   Нажатие на птицу — ночь падает кругом от птицы. */
(function () {
  const KEY = "aves.theme";
  const FAC_KEY = "aves.faculty";
  const root = document.documentElement;

  /* Пока идёт круг от птицы (View Transition), у элементов не должно быть своих переходов цвета.
     Иначе круг раскрывает ещё не перекрашенную страницу, и вместо «ночь падает кругом»
     получается обычное затухание — так эффект и пропал в новой версии. */
  (function injectInstantStyle() {
    if (document.getElementById("aves-theme-instant")) return;
    const st = document.createElement("style");
    st.id = "aves-theme-instant";
    st.textContent =
      ":root.theme-instant *, :root.theme-instant *::before, :root.theme-instant *::after" +
      "{ transition: none !important; }";
    (document.head || root).appendChild(st);
  })();

  function current() { return root.dataset.theme === "dark" ? "dark" : "light"; }

  function save(theme) { try { localStorage.setItem(KEY, theme); } catch (_) {} }

  function apply(theme) {
    root.dataset.theme = theme;
    const meta = document.querySelector('meta[name="theme-color"]');
    if (meta) {
      const bg = getComputedStyle(root).getPropertyValue("--paper").trim();
      meta.content = bg || (theme === "dark" ? "#070b16" : "#f6f8fc");
    }
    document.querySelectorAll("[data-theme-toggle]").forEach((b) => {
      b.setAttribute("aria-pressed", String(theme === "dark"));
      b.setAttribute("aria-label", theme === "dark" ? "Включить дневную тему" : "Включить ночную тему");
    });
    document.dispatchEvent(new CustomEvent("aves:theme", { detail: theme }));
  }

  function applyFaculty(fac) {
    if (fac && (fac === "bio" || fac === "fsk" || fac === "fmo")) {
      if (root.dataset.faculty !== fac) {
        root.dataset.faculty = fac;
        document.dispatchEvent(new CustomEvent("aves:theme", { detail: current() }));
      }
    }
  }

  function detectFaculty() {
    try {
      const qs = new URLSearchParams(location.search).get("f");
      if (qs && (qs === "bio" || qs === "fsk" || qs === "fmo")) {
        applyFaculty(qs);
        return;
      }
      const stored = localStorage.getItem(FAC_KEY);
      if (stored && (stored === "bio" || stored === "fsk" || stored === "fmo")) {
        applyFaculty(stored);
        return;
      }
    } catch (_) {}

    // Внутри приложения отслеживаем смену факультета по шапке (#head) или глобальному AvesApp.S.faculty
    if (window.AvesApp && window.AvesApp.S && window.AvesApp.S.faculty) {
      applyFaculty(window.AvesApp.S.faculty);
      return;
    }
    const headEl = document.getElementById("head");
    if (headEl) {
      const txt = headEl.textContent || "";
      if (/биолог|биофак/i.test(txt)) applyFaculty("bio");
      else if (/социокультур|фск/i.test(txt)) applyFaculty("fsk");
      else if (/международн|фмо/i.test(txt)) applyFaculty("fmo");
    }
  }

  function toggle(fromEl) {
    const next = current() === "dark" ? "light" : "dark";
    save(next);

    if (fromEl) {
      fromEl.classList.remove("is-flapping");
      void fromEl.offsetWidth;
      fromEl.classList.add("is-flapping");
    }

    const reduce = window.matchMedia("(prefers-reduced-motion: reduce)").matches;
    // Без View Transitions (Firefox, старый Safari) — мягкое затухание через CSS-переходы, как и было
    if (!document.startViewTransition || reduce || !fromEl) { apply(next); return; }

    const r = fromEl.getBoundingClientRect();
    const x = r.left + r.width / 2, y = r.top + r.height / 2;
    const radius = Math.hypot(Math.max(x, innerWidth - x), Math.max(y, innerHeight - y));
    root.style.setProperty("--vt-x", x + "px");
    root.style.setProperty("--vt-y", y + "px");
    root.style.setProperty("--vt-r", radius + "px");

    root.classList.add("theme-instant");
    const done = () => root.classList.remove("theme-instant");
    try {
      const vt = document.startViewTransition(() => apply(next));
      vt.finished.then(done, done);
    } catch (_) {
      apply(next); done();
    }
  }

  document.addEventListener("click", (e) => {
    const btn = e.target.closest("[data-theme-toggle]");
    if (btn) toggle(btn);
    setTimeout(detectFaculty, 20);
  });

  function initScrollReveal() {
    detectFaculty();
    const headEl = document.getElementById("head");
    if (headEl && "MutationObserver" in window) {
      new MutationObserver(detectFaculty).observe(headEl, { childList: true, subtree: true });
    }

    // На витрине при наведении на карточку факультета мягко подсвечиваем фон её оттенком
    document.querySelectorAll(".species[data-bird]").forEach((card) => {
      card.addEventListener("mouseenter", () => {
        const b = card.getAttribute("data-bird");
        if (b === "bio") applyFaculty("bio");
        else if (b === "flow") applyFaculty("fsk");
        else if (b === "globe") applyFaculty("fmo");
      });
    });

    if (!("IntersectionObserver" in window)) return;
    if (window.matchMedia("(prefers-reduced-motion: reduce)").matches) return;
    const targets = document.querySelectorAll(".species, .bsu-radar, .chat-sim, .steps li, .rule, .plan, .faq-item, .author, .web-start, .bells-card, .about-card");
    if (!targets.length) return;
    const obs = new IntersectionObserver((entries) => {
      entries.forEach((entry) => {
        if (entry.isIntersecting) {
          entry.target.classList.add("is-visible");
          obs.unobserve(entry.target);
        }
      });
    }, { threshold: 0.12, rootMargin: "0px 0px -32px 0px" });

    targets.forEach((el, idx) => {
      el.classList.add("reveal-item");
      el.style.setProperty("--delay", ((idx % 3) * 65) + "ms");
      obs.observe(el);
    });
  }

  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", initScrollReveal);
  } else {
    initScrollReveal();
  }

  apply(current());
  detectFaculty();
  window.AvesTheme = { toggle, apply, applyFaculty, current, save };
})();
