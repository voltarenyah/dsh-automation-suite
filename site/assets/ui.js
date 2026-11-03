/* UI behaviour for the rebuilt pages: theme, mobile nav, reveal.
   Language and copy stay in main.js. */
(function () {
  "use strict";

  var html = document.documentElement;
  var THEME_KEY = "das.theme";
  var themeBtn = document.getElementById("theme-toggle");
  var sun = themeBtn && themeBtn.querySelector(".icon-sun");
  var moon = themeBtn && themeBtn.querySelector(".icon-moon");

  function applyTheme(dark) {
    html.classList.toggle("dark", dark);
    if (sun) sun.style.display = dark ? "" : "none";
    if (moon) moon.style.display = dark ? "none" : "";
    if (themeBtn) themeBtn.setAttribute("aria-pressed", dark ? "true" : "false");
    try { localStorage.setItem(THEME_KEY, dark ? "dark" : "light"); } catch (e) { /* ignore */ }
  }

  var stored = null;
  try { stored = localStorage.getItem(THEME_KEY); } catch (e) { /* ignore */ }
  var systemDark = window.matchMedia && window.matchMedia("(prefers-color-scheme: dark)").matches;
  applyTheme(stored ? stored === "dark" : systemDark);

  if (themeBtn) {
    themeBtn.addEventListener("click", function () {
      applyTheme(!html.classList.contains("dark"));
    });
  }

  /* mobile nav */
  var header = document.getElementById("site-header");
  var navToggle = document.getElementById("nav-toggle");
  if (header && navToggle) {
    navToggle.addEventListener("click", function (e) {
      e.stopPropagation();
      var open = header.getAttribute("data-open") === "true";
      header.setAttribute("data-open", open ? "false" : "true");
      navToggle.setAttribute("aria-expanded", open ? "false" : "true");
    });
    document.addEventListener("click", function (e) {
      if (header.getAttribute("data-open") === "true" && !header.contains(e.target)) {
        header.setAttribute("data-open", "false");
        navToggle.setAttribute("aria-expanded", "false");
      }
    });
  }

  /* reveal on scroll */
  var targets = document.querySelectorAll(".reveal");
  if ("IntersectionObserver" in window) {
    var io = new IntersectionObserver(function (entries) {
      entries.forEach(function (entry) {
        if (!entry.isIntersecting) return;
        entry.target.classList.add("in");
        io.unobserve(entry.target);
      });
    }, { rootMargin: "0px 0px -6% 0px", threshold: 0.06 });
    targets.forEach(function (el) { io.observe(el); });
  } else {
    targets.forEach(function (el) { el.classList.add("in"); });
  }
})();
