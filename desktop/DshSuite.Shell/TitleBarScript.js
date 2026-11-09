// Injected into the DSH Web UI by DshSuite.Shell.
//
// The DSH web client already ships a desktop (Windows) layout: when
// <html data-windows-titlebar> is present it reserves a 40 px strip at the top
// (sidebar fill colour, rounded content corner, draggable region) and moves its
// own sidebar toggle into that strip. The official DeepSeek Harness desktop app
// sets that marker from its Electron preload and adds the Application/Edit
// caption menus plus the native window controls.
//
// This script does the same job for the WebView2 shell:
//   * mark the document as a Windows titlebar document before the app boots;
//   * render the Application/Edit caption menus in that strip (theme aware);
//   * render minimize / maximize / close controls at the top right;
//   * forward window/app commands to the C# host over WebMessage.
//
// Drag, double-click maximize/restore and the system menu on the strip itself
// are handled by WebView2's non-client region support (enabled by the host); the
// strip CSS from dsh-client-ui-layout already declares -webkit-app-region: drag.
(() => {
  "use strict";
  if (window.top !== window) return;
  const bridge = window.chrome && window.chrome.webview;
  if (!bridge) return;

  const HEIGHT = 40;
  const root = document.documentElement;
  const mark = () => {
    const element = document.documentElement;
    if (!element) return;
    element.setAttribute("data-windows-titlebar", "");
    element.style.setProperty("--dsh-windows-titlebar-height", HEIGHT + "px");
  };
  mark();

  const post = (message) => {
    try {
      bridge.postMessage(JSON.stringify(message));
    } catch (_) {
      // The host may be gone (window closing); nothing useful to do.
    }
  };

  const locale = () =>
    ((document.documentElement && document.documentElement.lang) || "en").toLowerCase();
  const zh = () => locale().startsWith("zh");
  const pick = (zhText, enText) => (zh() ? zhText : enText);

  const labels = {
    menuBar: () => pick("应用菜单", "Application menu"),
    application: () => pick("应用", "Application"),
    edit: () => pick("编辑", "Edit"),
    about: () => pick("关于 DSH Automation Suite", "About DSH Automation Suite"),
    logs: () => pick("打开日志", "Open Logs"),
    doctor: () => pick("运行诊断", "Run Doctor"),
    issues: () => pick("报告问题…", "Report Issues…"),
    exit: () => pick("退出", "Exit"),
    undo: () => pick("撤销", "Undo"),
    redo: () => pick("重做", "Redo"),
    cut: () => pick("剪切", "Cut"),
    copy: () => pick("复制", "Copy"),
    paste: () => pick("粘贴", "Paste"),
    selectAll: () => pick("全选", "Select All"),
    minimize: () => pick("最小化", "Minimize"),
    maximize: () => pick("最大化", "Maximize"),
    restore: () => pick("还原", "Restore"),
    close: () => pick("关闭", "Close"),
  };

  const CSS = `
    :host { display: contents; }
    * { box-sizing: border-box; }

    .menubar {
      position: fixed;
      top: 0;
      left: var(--dsh-windows-menu-start, 48px);
      height: var(--dsh-windows-titlebar-height, 40px);
      display: flex;
      align-items: center;
      gap: 2px;
      z-index: 2147483000;
      font-family: var(--dsw-font-family, "Segoe UI Variable Text", "Segoe UI", sans-serif);
      font-size: 14px;
      line-height: 1;
      -webkit-app-region: no-drag;
      pointer-events: auto;
    }

    .menubar[hidden] { display: none; }

    .menubar button {
      height: 28px;
      padding: 0 10px;
      border: 0;
      border-radius: 6px;
      background: transparent;
      color: var(--dsw-alias-label-secondary, #5f6368);
      font: inherit;
      font-size: 14px;
      line-height: 1;
      cursor: default;
      white-space: nowrap;
    }

    .menubar button:hover,
    .menubar button[aria-expanded="true"] {
      background: var(--dsw-alias-interactive-bg-hover, rgba(0, 0, 0, 0.06));
      color: var(--dsw-alias-label-primary, #202124);
    }

    .menubar button:focus-visible {
      outline: 2px solid var(--dsw-alias-state-business-primary, #4c8dff);
      outline-offset: -2px;
    }

    .controls {
      position: fixed;
      top: 0;
      right: 0;
      height: var(--dsh-windows-titlebar-height, 40px);
      display: flex;
      align-items: stretch;
      z-index: 2147483001;
      -webkit-app-region: no-drag;
      pointer-events: auto;
    }

    .controls button {
      width: 46px;
      height: 100%;
      margin: 0;
      padding: 0;
      border: 0;
      background: transparent;
      color: var(--dsw-alias-label-primary, #202124);
      display: flex;
      align-items: center;
      justify-content: center;
      font-family: "Segoe Fluent Icons", "Segoe MDL2 Assets", sans-serif;
      font-size: 10px;
      line-height: 1;
      cursor: default;
    }

    .controls button:hover {
      background: var(--dsw-alias-interactive-bg-hover, rgba(0, 0, 0, 0.06));
    }

    .controls button.close:hover {
      background: #c42b1c;
      color: #ffffff;
    }

    .controls button.close:active {
      background: #b12a1b;
      color: #ffffff;
    }

    .controls.inactive button {
      color: var(--dsw-alias-label-tertiary, #9aa0a6);
    }

    .controls.inactive button:hover {
      background: transparent;
    }

    .controls.inactive button.close:hover {
      background: #c42b1c;
      color: #ffffff;
    }

    .menu {
      position: fixed;
      z-index: 2147483002;
      min-width: 208px;
      padding: 4px;
      outline: none;
      border: 0.5px solid var(--dsw-alias-border-l2, rgba(0, 0, 0, 0.08));
      border-radius: var(--dsw-radius-lg, 10px);
      background: var(--dsw-menu-surface-fill, #ffffff);
      backdrop-filter: var(--dsw-menu-backdrop-filter, none);
      box-shadow: var(--dsw-elevation-panel, 0 8px 24px rgba(0, 0, 0, 0.18));
      color: var(--dsw-alias-label-primary, #202124);
      font-family: var(--dsw-font-family, "Segoe UI Variable Text", "Segoe UI", sans-serif);
      display: flex;
      flex-direction: column;
      -webkit-app-region: no-drag;
      pointer-events: auto;
      outline: none;
    }

    .menu button {
      width: 100%;
      min-height: 30px;
      padding: 0 10px;
      border: 0;
      border-radius: var(--dsw-radius-md, 6px);
      background: transparent;
      color: inherit;
      font: inherit;
      font-size: 13px;
      text-align: left;
      line-height: 30px;
      cursor: default;
      white-space: nowrap;
    }

    .menu button:hover,
    .menu button.active {
      background: var(--dsw-alias-interactive-bg-hover, rgba(0, 0, 0, 0.06));
    }

    .menu button:focus,
    .menu button:focus-visible {
      outline: none;
    }

    .menu .separator {
      height: 0;
      margin: 4px 6px;
      border-top: 0.5px solid var(--dsw-alias-border-l3, rgba(0, 0, 0, 0.08));
    }
  `;

  const isEditable = (target) =>
    target instanceof HTMLInputElement ||
    target instanceof HTMLTextAreaElement ||
    (target instanceof HTMLElement && target.isContentEditable);

  let host = null;
  let shadow = null;
  let menubar = null;
  let controls = null;
  let menuEl = null;
  let menuButton = null;
  let menuItems = [];
  let menuIndex = -1;
  let menuOwner = null;

  const state = { maximized: false, active: true, mounted: false };
  let restoreEditor = () => {};

  // The DSH theme is applied to <body data-ds-dark-theme>. The host uses this
  // to switch the DWM frame into dark mode so the 1 px window border and the
  // shadow match the app instead of Windows' default light frame.
  const isDarkTheme = () => {
    if (document.body && document.body.hasAttribute("data-ds-dark-theme")) return true;
    // Once the app shell is up, the DSH theme is authoritative: light mode is
    // the absence of the marker even when the OS prefers dark colours.
    if (document.body) return false;
    try {
      return window.matchMedia("(prefers-color-scheme: dark)").matches;
    } catch (_) {
      return false;
    }
  };

  let reportedDark = null;
  const syncTheme = () => {
    const dark = isDarkTheme();
    if (dark === reportedDark) return;
    reportedDark = dark;
    post({ type: "theme", dark });
  };

  const rememberEditor = (event) => {
    const target = event.composedPath()[0];
    if (!(target instanceof HTMLElement) || target === host || (shadow && shadow.contains(target))) return;
    if (!isEditable(target)) return;
    const selection = document.getSelection();
    const ranges =
      selection === null
        ? []
        : Array.from({ length: selection.rangeCount }, (_, index) => selection.getRangeAt(index).cloneRange());
    const input = target instanceof HTMLInputElement || target instanceof HTMLTextAreaElement ? target : undefined;
    const start = input ? input.selectionStart : null;
    const end = input ? input.selectionEnd : null;
    const direction = input ? input.selectionDirection : null;
    restoreEditor = () => {
      if (!target.isConnected) return;
      target.focus({ preventScroll: true });
      if (input && start !== null && end !== null) {
        input.setSelectionRange(start, end, direction || undefined);
      } else if (selection !== null && ranges.length > 0) {
        selection.removeAllRanges();
        for (const range of ranges) selection.addRange(range);
      }
    };
  };

  const closeMenu = (restore) => {
    if (menuEl === null) return;
    menuEl.remove();
    if (menuOwner !== null) menuOwner.setAttribute("aria-expanded", "false");
    if (menuButton !== null) menuButton.setAttribute("aria-expanded", "false");
    document.removeEventListener("keydown", onMenuKeyDown, true);
    document.removeEventListener("pointerdown", onMenuOutsidePointer, true);
    menuEl = null;
    menuButton = null;
    menuOwner = null;
    menuItems = [];
    menuIndex = -1;
    if (restore) restoreEditor();
  };

  const setMenuIndex = (index) => {
    if (menuItems.length === 0) return;
    if (menuIndex >= 0 && menuItems[menuIndex]) menuItems[menuIndex].classList.remove("active");
    menuIndex = ((index % menuItems.length) + menuItems.length) % menuItems.length;
    menuItems[menuIndex].classList.add("active");
    menuItems[menuIndex].focus({ preventScroll: true });
  };

  const onMenuKeyDown = (event) => {
    if (menuEl === null) return;
    if (event.key === "Escape") {
      event.preventDefault();
      event.stopPropagation();
      closeMenu(true);
    } else if (event.key === "ArrowDown") {
      event.preventDefault();
      setMenuIndex(menuIndex + 1);
    } else if (event.key === "ArrowUp") {
      event.preventDefault();
      setMenuIndex(menuIndex - 1);
    } else if (event.key === "Tab") {
      closeMenu(true);
    }
  };

  const onMenuOutsidePointer = (event) => {
    if (menuEl === null) return;
    const path = event.composedPath();
    if (menuEl.contains(path[0]) || (menuButton !== null && path.includes(menuButton))) return;
    closeMenu(true);
  };

  const openMenu = (owner, button, items) => {
    closeMenu(false);
    rememberEditor({ composedPath: () => [document.activeElement] });
    const rect = button.getBoundingClientRect();
    const menu = document.createElement("div");
    menu.className = "menu";
    menu.setAttribute("role", "menu");
    menu.tabIndex = -1;

    const focusable = [];
    for (const item of items) {
      if (item.type === "separator") {
        const separator = document.createElement("div");
        separator.className = "separator";
        separator.setAttribute("role", "separator");
        menu.append(separator);
        continue;
      }
      const entry = document.createElement("button");
      entry.type = "button";
      entry.setAttribute("role", "menuitem");
      entry.tabIndex = -1;
      entry.textContent = item.label();
      entry.addEventListener("mousedown", (event) => event.preventDefault());
      entry.addEventListener("click", (event) => {
        event.preventDefault();
        event.stopPropagation();
        closeMenu(false);
        restoreEditor();
        item.run();
      });
      menu.append(entry);
      focusable.push(entry);
    }

    const width = 220;
    const left = Math.max(4, Math.min(rect.left, window.innerWidth - width - 4));
    menu.style.left = left + "px";
    menu.style.top = rect.bottom + 2 + "px";
    shadow.append(menu);

    menuEl = menu;
    menuButton = button;
    menuOwner = owner;
    menuItems = focusable;
    menuIndex = -1;
    button.setAttribute("aria-expanded", "true");
    owner.setAttribute("aria-expanded", "true");

    menu.focus({ preventScroll: true });
    if (focusable.length > 0) setMenuIndex(0);

    document.addEventListener("keydown", onMenuKeyDown, true);
    document.addEventListener("pointerdown", onMenuOutsidePointer, true);
  };

  const menuButtonFor = (kind, items) => {
    const button = document.createElement("button");
    button.type = "button";
    button.setAttribute("role", "menuitem");
    button.setAttribute("aria-haspopup", "menu");
    button.setAttribute("aria-expanded", "false");
    button.tabIndex = -1;
    button.textContent = labels[kind]();
    button.addEventListener("pointerdown", (event) => event.preventDefault());
    button.addEventListener("mousedown", (event) => event.preventDefault());
    button.addEventListener("click", () => {
      if (menuEl !== null && menuOwner === button) {
        closeMenu(true);
        return;
      }
      openMenu(button, button, items);
    });
    button.addEventListener("keydown", (event) => {
      if (event.key === "ArrowLeft" || event.key === "ArrowRight") {
        event.preventDefault();
        const buttons = menubar === null ? [] : [...menubar.querySelectorAll("button")];
        if (buttons.length === 0) return;
        const index = buttons.indexOf(button);
        const step = event.key === "ArrowRight" ? 1 : buttons.length - 1;
        const next = buttons[(index + step) % buttons.length];
        for (const entry of buttons) entry.tabIndex = -1;
        next.tabIndex = 0;
        next.focus();
      } else if (event.key === "ArrowDown") {
        event.preventDefault();
        openMenu(button, button, items);
      }
    });
    return button;
  };

  const editCommand = (command) => () => {
    restoreEditor();
    if (command === "selectAll") {
      const active = document.activeElement;
      if (active instanceof HTMLInputElement || active instanceof HTMLTextAreaElement) {
        active.select();
      } else {
        document.execCommand("selectAll");
      }
      return;
    }
    if (command === "paste") {
      post({ type: "paste-request" });
      return;
    }
    document.execCommand(command);
  };

  const buildMenuBar = () => {
    const bar = document.createElement("div");
    bar.className = "menubar";
    bar.setAttribute("role", "menubar");
    bar.setAttribute("aria-label", labels.menuBar());
    bar.hidden = document.querySelector("[data-shell-overlay]") === null;

    const applicationItems = [
      { label: labels.about, run: () => post({ type: "app", action: "about" }) },
      { label: labels.logs, run: () => post({ type: "app", action: "logs" }) },
      { label: labels.doctor, run: () => post({ type: "app", action: "doctor" }) },
      { label: labels.issues, run: () => post({ type: "app", action: "issues" }) },
      { type: "separator" },
      { label: labels.exit, run: () => post({ type: "app", action: "exit" }) },
    ];
    const editItems = [
      { label: labels.undo, run: editCommand("undo") },
      { label: labels.redo, run: editCommand("redo") },
      { type: "separator" },
      { label: labels.cut, run: editCommand("cut") },
      { label: labels.copy, run: editCommand("copy") },
      { label: labels.paste, run: editCommand("paste") },
      { type: "separator" },
      { label: labels.selectAll, run: editCommand("selectAll") },
    ];

    const applicationButton = menuButtonFor("application", applicationItems);
    applicationButton.tabIndex = 0;
    bar.append(applicationButton, menuButtonFor("edit", editItems));
    menubar = bar;
    shadow.append(bar);
  };

  const applyState = (next) => {
    if (typeof next.maximized === "boolean") state.maximized = next.maximized;
    if (typeof next.active === "boolean") state.active = next.active;
    if (controls !== null) controls.classList.toggle("inactive", !state.active);
    if (maximizeButton !== null) {
      maximizeButton.textContent = state.maximized ? "\uE923" : "\uE922";
      maximizeButton.setAttribute("aria-label", state.maximized ? labels.restore() : labels.maximize());
    }
  };

  let maximizeButton = null;
  let minimizeButton = null;
  let closeButton = null;

  const buildControls = () => {
    const box = document.createElement("div");
    box.className = "controls";
    box.classList.toggle("inactive", !state.active);

    minimizeButton = document.createElement("button");
    minimizeButton.type = "button";
    minimizeButton.textContent = "\uE921";
    minimizeButton.setAttribute("aria-label", labels.minimize());
    minimizeButton.addEventListener("click", () => post({ type: "window", action: "minimize" }));

    maximizeButton = document.createElement("button");
    maximizeButton.type = "button";
    maximizeButton.textContent = state.maximized ? "\uE923" : "\uE922";
    maximizeButton.setAttribute("aria-label", state.maximized ? labels.restore() : labels.maximize());
    maximizeButton.addEventListener("click", () => post({ type: "window", action: "toggle-maximize" }));

    closeButton = document.createElement("button");
    closeButton.type = "button";
    closeButton.className = "close";
    closeButton.textContent = "\uE8BB";
    closeButton.setAttribute("aria-label", labels.close());
    closeButton.addEventListener("click", () => post({ type: "window", action: "close" }));

    box.append(minimizeButton, maximizeButton, closeButton);
    controls = box;
    shadow.append(box);
  };

  const mount = () => {
    if (host !== null) return;
    if (!document.body) return;
    // AddScriptToExecuteOnDocumentCreated may run before <html> exists; the
    // marker must be present once the app frame renders, so apply it again.
    mark();
    host = document.createElement("div");
    host.dataset.dshSuiteChrome = "";
    shadow = host.attachShadow({ mode: "open" });
    const style = document.createElement("style");
    style.textContent = CSS;
    shadow.append(style);

    buildControls();
    buildMenuBar();
    document.body.append(host);
    state.mounted = true;
    post({ type: "hello" });

    document.addEventListener("focusout", rememberEditor, true);

    syncTheme();
    const themeObserver = new MutationObserver(syncTheme);
    themeObserver.observe(document.body, {
      attributes: true,
      attributeFilter: ["data-ds-dark-theme"],
    });
    if (root) {
      themeObserver.observe(root, {
        attributes: true,
        attributeFilter: ["data-ds-dark-theme", "data-theme"],
      });
    }
    if (window.matchMedia) {
      const scheme = window.matchMedia("(prefers-color-scheme: dark)");
      if (scheme.addEventListener) scheme.addEventListener("change", syncTheme);
    }

    // The official app shows the caption menus once the app frame (and its
    // overlay layer) has mounted, not over the boot screen.
    const revealMenuBar = () => {
      if (menubar === null) return;
      if (menubar.hidden && document.querySelector("[data-shell-overlay]") !== null) {
        menubar.hidden = false;
      }
    };
    const observer = new MutationObserver(() => {
      revealMenuBar();
      if (menubar !== null && !menubar.hidden) observer.disconnect();
    });
    if (menubar !== null && menubar.hidden) {
      observer.observe(document.body, { childList: true, subtree: true });
      window.addEventListener("pagehide", () => observer.disconnect(), { once: true });
    }
    revealMenuBar();
  };

  bridge.addEventListener("message", (event) => {
    const data = event.data;
    if (!data || typeof data !== "object") return;
    if (data.type === "state") {
      applyState(data);
    } else if (data.type === "clipboard") {
      const text = typeof data.text === "string" ? data.text : "";
      if (text.length === 0) return;
      restoreEditor();
      document.execCommand("insertText", false, text);
    }
  });

  window.addEventListener("resize", () => {
    if (menuEl !== null) closeMenu(true);
  });

  // The host window has no native non-client frame (the client fills the whole
  // window, so the strip reaches the very top edge). Edges are therefore web
  // content: detect presses near them and ask the host to start the native
  // sizing loop. The top strip is intentionally excluded — it is the window
  // drag region (and holds the caption buttons).
  const resizeEdgeAt = (x, y) => {
    if (state.maximized) return null;
    if (y <= HEIGHT) return null;
    const border = 4;
    const width = window.innerWidth;
    const height = window.innerHeight;
    const left = x <= border;
    const right = x >= width - border;
    const bottom = y >= height - border;
    if (bottom && left) return "bottom-left";
    if (bottom && right) return "bottom-right";
    if (bottom) return "bottom";
    if (left) return "left";
    if (right) return "right";
    return null;
  };

  const resizeCursor = {
    left: "ew-resize",
    right: "ew-resize",
    bottom: "ns-resize",
    "bottom-left": "nesw-resize",
    "bottom-right": "nwse-resize",
  };

  document.addEventListener(
    "mousemove",
    (event) => {
      const edge = resizeEdgeAt(event.clientX, event.clientY);
      document.documentElement.style.cursor = edge === null ? "" : resizeCursor[edge];
    },
    true,
  );

  document.addEventListener(
    "mousedown",
    (event) => {
      if (event.button !== 0) return;
      const edge = resizeEdgeAt(event.clientX, event.clientY);
      if (edge === null) return;
      event.preventDefault();
      event.stopPropagation();
      post({ type: "resize", edge });
    },
    true,
  );

  window.addEventListener("blur", () => {
    document.documentElement.style.cursor = "";
  });

  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", mount, { once: true });
  } else {
    mount();
  }
})();
