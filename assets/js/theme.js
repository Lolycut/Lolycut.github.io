/* Тема. Нажатие на птицу — ночь падает кругом от птицы.
   В <head> каждой страницы стоит короткий инлайн-скрипт, который ставит тему до отрисовки. */
(function () {
  const KEY = "aves.theme";
  const root = document.documentElement;

  function current() { return root.dataset.theme === "dark" ? "dark" : "light"; }

  function save(theme) { try { localStorage.setItem(KEY, theme); } catch (_) {} }

  function apply(theme) {
    root.dataset.theme = theme;
    const meta = document.querySelector('meta[name="theme-color"]');
    if (meta) meta.content = theme === "dark" ? "#0b1022" : "#ffffff";
    document.querySelectorAll("[data-theme-toggle]").forEach((b) => {
      b.setAttribute("aria-pressed", String(theme === "dark"));
      b.setAttribute("aria-label", theme === "dark" ? "Включить дневную тему" : "Включить ночную тему");
    });
    document.dispatchEvent(new CustomEvent("aves:theme", { detail: theme }));
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
    if (!document.startViewTransition || reduce || !fromEl) { apply(next); return; }

    const r = fromEl.getBoundingClientRect();
    const x = r.left + r.width / 2, y = r.top + r.height / 2;
    const radius = Math.hypot(Math.max(x, innerWidth - x), Math.max(y, innerHeight - y));
    root.style.setProperty("--vt-x", x + "px");
    root.style.setProperty("--vt-y", y + "px");
    root.style.setProperty("--vt-r", radius + "px");
    document.startViewTransition(() => apply(next));
  }

  document.addEventListener("click", (e) => {
    const btn = e.target.closest("[data-theme-toggle]");
    if (btn) toggle(btn);
  });

  apply(current());
  window.AvesTheme = { toggle, apply, current, save };
})();
