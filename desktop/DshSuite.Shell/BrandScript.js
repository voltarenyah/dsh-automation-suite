/*
 * SPIKE B (shipped form) — pure-DOM branding for the DSH landing hero.
 *
 * Injected by DshSuite.Shell through
 *   CoreWebView2.AddScriptToExecuteOnDocumentCreatedAsync
 * i.e. before the DSH web client boots, exactly like TitleBarScript.js.
 *
 * Why DOM and not a client plugin: the hero copy is hard-coded in DSH's own
 * conversation client (`conversation` namespace: `hero.headline`,
 * `hero.preview`) and the official brand plugin deliberately leaves it alone.
 * Patching it from a plugin needs the client's private `locale` service; patching
 * it from the shell needs nothing but text.
 *
 * Contract with the host (MainForm.cs):
 *   window.__DSH_SUITE_MARK__  optional data-URL of the 128 px brand mark.
 *                              When absent the inline SVG below is used.
 *
 * Deliberately depends on NO client internals: no __ModuleLoader__, no React,
 * no locale/slot service, no package.
 *
 * Stability strategy:
 *   - match by TEXT, never by CSS-module class (WOwLGG_*, an3WzG_* are build hashes);
 *   - the one stable hook DSH does expose is `data-slot="conversation.hero.brand.mark"`;
 *   - keep the native <svg> in place and only hide it: React still owns its node, so
 *     unmounting the hero cannot hit a "removeChild on a foreign node" exception;
 *   - write only when the current value differs, so the observer settles;
 *   - if DSH renames the strings or moves the slot, do nothing (native hero shows).
 */
(() => {
  "use strict";
  // Top frame only: the shell injects into every frame.
  if (window.top !== window) return;
  if (window.__dshSuiteBrand) return; // already installed in this document
  window.__dshSuiteBrand = true;

  const HEADLINE = "dsh-automation-suite";
  const BADGE = "TIA-V17";

  // The client translates these per document language; match both.
  const HEADLINES = ["Into the Unknown", "探索未至之境"];
  const BADGES = ["Preview", "预览版"];

  const MARK_SLOT = '[data-slot="conversation.hero.brand.mark"]';
  const MARK_CLASS = "dsh-suite-mark";
  const MARK_SIZE = 34; // same side length the removed plugin used

  const FALLBACK_MARK =
    '<svg class="' + MARK_CLASS + '" width="' + MARK_SIZE + '" height="' + MARK_SIZE + '" ' +
    'viewBox="0 0 34 34" aria-hidden="true"><rect width="34" height="34" rx="8" fill="#4D6BFE"/>' +
    '<path d="M7 23 13.5 12l4.5 7 3.5-4.5L28 23z" fill="#fff"/></svg>';

  const textNodes = (wanted) => {
    const out = [];
    const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT);
    while (walker.nextNode()) {
      const node = walker.currentNode;
      const value = (node.nodeValue || "").trim();
      if (value !== "" && wanted.includes(value)) out.push(node);
    }
    return out;
  };

  const fixHeadline = () => {
    for (const node of textNodes(HEADLINES)) {
      if (node.nodeValue === HEADLINE) continue;
      const leading = (node.nodeValue || "").match(/^\s*/)[0];
      node.nodeValue = leading + HEADLINE;
    }
  };

  const fixBadge = () => {
    for (const node of textNodes(BADGES)) {
      const parent = node.parentElement;
      if (!parent) continue;
      // Only the hero badge — never the "Preview Notice" dialog heading/copy.
      if (parent.closest('[role="dialog"]')) continue;
      if (node.nodeValue === BADGE) continue;
      node.nodeValue = BADGE;
    }
  };

  const markSource = () => {
    const url = window.__DSH_SUITE_MARK__;
    if (typeof url === "string" && url.indexOf("data:image/") === 0) {
      const img = document.createElement("img");
      img.className = MARK_CLASS;
      img.src = url;
      img.width = MARK_SIZE;
      img.height = MARK_SIZE;
      img.alt = "dsh-automation-suite";
      img.draggable = false;
      img.style.display = "block";
      img.style.borderRadius = Math.round(MARK_SIZE * 0.24) + "px";
      return img;
    }
    const holder = document.createElement("span");
    holder.innerHTML = FALLBACK_MARK;
    return holder.firstElementChild;
  };

  const fixMark = () => {
    const slot = document.querySelector(MARK_SLOT);
    if (!slot) return;
    if (!slot.querySelector("." + MARK_CLASS)) {
      const ours = markSource();
      if (ours) slot.appendChild(ours);
    }
    // Hide, never remove, the native mark: React keeps owning that node.
    for (const child of Array.from(slot.children)) {
      if (child.classList.contains(MARK_CLASS)) continue;
      if (child.style.display !== "none") child.style.display = "none";
    }
  };

  let scheduled = false;
  const apply = () => {
    scheduled = false;
    try {
      fixHeadline();
      fixBadge();
      fixMark();
    } catch (error) {
      // Never let branding break the page.
      if (window.console && typeof window.console.warn === "function") {
        window.console.warn("[dsh-suite-brand] skipped:", error && error.message ? error.message : error);
      }
    }
  };

  const schedule = () => {
    if (scheduled) return;
    scheduled = true;
    // rAF runs before the next paint, so the brand lands in the same frame the
    // hero appears in — no flash of the native copy.
    if (typeof requestAnimationFrame === "function") requestAnimationFrame(apply);
    else setTimeout(apply, 16);
  };

  const boot = () => {
    apply();
    new MutationObserver(schedule).observe(document.body, {
      childList: true,
      subtree: true,
      characterData: true,
    });
  };

  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", boot, { once: true });
  } else {
    boot();
  }
})();
