/* Language, reveal-on-scroll, copy — no dependencies. */
(function () {
  "use strict";

  var KEY = "das.lang";

  var I18N = {
    en: {
      "nav.what": "What it is",
      "nav.plugins": "Plugins",
      "nav.start": "Quick start",
      "nav.status": "Status",
      "nav.github": "GitHub",

      "hero.eyebrow": "Unofficial DeepSeek Harness distribution",
      "hero.title": "A way into PLC projects",
      "hero.dot": ".",
      "hero.lead":
        "dsh-automation-suite adds TIA Portal V17 block access, an engineering knowledge graph and guard-railed Git to a single DeepSeek Harness session.",
      "hero.cta1": "Quick start",
      "hero.cta2": "Source on GitHub",
      "hero.fact.plugins": "plugins",
      "hero.fact.tools": "tools",
      "hero.fact.license": "license",
      "hero.fact.platform": "for TIA",

      "what.title": "What it is",
      "what.note": "Three layers, each one unlocking the next.",
      "what.l1.t": "Access",
      "what.l1.d":
        "Read and write TIA Portal V17 blocks through Openness — inside a whitelist, never arbitrary code.",
      "what.l2.t": "Semantics",
      "what.l2.d":
        "Project sources become a queryable graph of blocks, calls, tags and I/O.",
      "what.l3.t": "Governance",
      "what.l3.d":
        "Export to text, diff, commit and trace versions — with Git as the base.",

      "status.verified": "Verified",
      "status.partial": "Partial",
      "status.prototype": "Prototype",

      "plugins.title": "Plugins",
      "plugins.note":
        "Each package installs on its own; the blueprint assembles all of them.",
      "plugins.col.name": "Package",
      "plugins.col.role": "Role",
      "plugins.col.tools": "Tools",
      "plugins.col.status": "Status",
      "p.tia": "TIA Portal V17 access",
      "p.plcsim": "PLCSIM Advanced runtime",
      "p.ctx": "Project scope and version store",
      "p.graph": "Knowledge graph · SQLite + C# engine",
      "p.git": "Guard-railed Git",
      "p.u1": "Sidebar · PLC Blocks",
      "p.u2": "Composer · TIA console",
      "p.u3": "Sidebar · Versions",

      "start.title": "Quick start",
      "start.note":
        "Windows · Node 22.19+ · uses its own DSH_HOME, your daily setup stays untouched.",
      "start.copy": "Copy",

      "status.title": "Status",
      "status.body":
        "An early build. The access layer is proven on real projects, the semantic layer has a working prototype, and governance is a general Git base. Statuses on this page follow the repository roadmap.",
      "status.link": "Read the roadmap",

      "footer.disclaimer":
        "Unofficial project. Not affiliated with DeepSeek or Siemens. TIA Portal and SIMATIC are trademarks of Siemens AG, named here for reference only.",
      "footer.source": "GitHub",
      "footer.license": "MIT",
      "footer.updated": "Last checked 2026-11-03",

      "meta.title": "dsh-automation-suite — a way into PLC projects",
      "meta.desc":
        "An unofficial DeepSeek Harness distribution: TIA Portal V17 block access, an engineering knowledge graph, and guard-railed Git tools."
    },

    zh: {
      "nav.what": "是什么",
      "nav.plugins": "插件",
      "nav.start": "快速开始",
      "nav.status": "状态",
      "nav.github": "GitHub",

      "hero.eyebrow": "非官方 DeepSeek Harness 发行版",
      "hero.title": "让模型走进 PLC 工程",
      "hero.dot": "。",
      "hero.lead":
        "dsh-automation-suite 把 TIA Portal V17 的块级读写、工程知识图谱与受控 Git 装进同一个 DeepSeek Harness 会话。",
      "hero.cta1": "快速开始",
      "hero.cta2": "GitHub 仓库",
      "hero.fact.plugins": "个插件",
      "hero.fact.tools": "个工具",
      "hero.fact.license": "许可",
      "hero.fact.platform": "仅用于 TIA",

      "what.title": "它是什么",
      "what.note": "三层能力，每层解锁下一层。",
      "what.l1.t": "接入层",
      "what.l1.d": "通过 Openness 读写 TIA Portal V17 的程序块 —— 走白名单，不给任意代码执行。",
      "what.l2.t": "语义层",
      "what.l2.d": "把工程源文件变成可查询的图：块、调用、标签表与 I/O。",
      "what.l3.t": "管理与协作层",
      "what.l3.d": "导出为文本、比对、提交、追溯版本 —— 以 Git 为底座。",

      "status.verified": "已验证",
      "status.partial": "部分实现",
      "status.prototype": "原型",

      "plugins.title": "插件",
      "plugins.note": "每个包都能单独安装，蓝图把它们装成一套。",
      "plugins.col.name": "包",
      "plugins.col.role": "职责",
      "plugins.col.tools": "工具",
      "plugins.col.status": "状态",
      "p.tia": "TIA Portal V17 读写",
      "p.plcsim": "PLCSIM Advanced 运行时",
      "p.ctx": "工程作用域与版本库",
      "p.graph": "知识图谱 · SQLite + C# 引擎",
      "p.git": "受控 Git",
      "p.u1": "右侧栏 · PLC Blocks",
      "p.u2": "输入框 · TIA 控制台",
      "p.u3": "右侧栏 · Versions",

      "start.title": "快速开始",
      "start.note":
        "Windows · Node 22.19+ · 使用独立 DSH_HOME，不动日常环境。",
      "start.copy": "复制",

      "status.title": "状态",
      "status.body":
        "早期版本：接入层已在真实项目上验证，语义层有可用原型，管理与协作层目前是通用 Git 底座。本页状态以仓库路线图为准。",
      "status.link": "查看路线图",

      "footer.disclaimer":
        "非官方项目，与 DeepSeek 及 Siemens 均无隶属关系。TIA Portal 与 SIMATIC 是 Siemens AG 的商标，此处仅作事实性指称。",
      "footer.source": "GitHub",
      "footer.license": "MIT",
      "footer.updated": "最后核对 2026-11-03",

      "meta.title": "dsh-automation-suite — 让模型走进 PLC 工程",
      "meta.desc":
        "非官方 DeepSeek Harness 发行版：TIA Portal V17 块级读写、工程知识图谱与受控 Git 工具。"
    }
  };

  var html = document.documentElement;
  var nodes = document.querySelectorAll("[data-i18n]");
  var langBtns = document.querySelectorAll(".lang__btn");
  var metaDesc = document.querySelector('meta[name="description"]');

  function apply(lang) {
    var dict = I18N[lang] || I18N.en;

    nodes.forEach(function (node) {
      var key = node.getAttribute("data-i18n");
      if (dict[key] !== undefined) node.textContent = dict[key];
    });

    html.lang = lang === "zh" ? "zh-CN" : "en";
    document.title = dict["meta.title"];
    if (metaDesc) metaDesc.setAttribute("content", dict["meta.desc"]);

    langBtns.forEach(function (btn) {
      var on = btn.dataset.lang === lang;
      btn.classList.toggle("is-on", on);
      btn.setAttribute("aria-pressed", on ? "true" : "false");
    });

    try { localStorage.setItem(KEY, lang); } catch (e) { /* private mode */ }
  }

  var stored = null;
  try { stored = localStorage.getItem(KEY); } catch (e) { /* ignore */ }
  apply(stored === "zh" ? "zh" : "en");

  langBtns.forEach(function (btn) {
    btn.addEventListener("click", function () {
      apply(btn.dataset.lang === "zh" ? "zh" : "en");
    });
  });

  /* copy the command block, without prompt glyphs */
  var copyBtn = document.querySelector(".copy");
  if (copyBtn) {
    copyBtn.addEventListener("click", function () {
      var target = document.getElementById(copyBtn.dataset.copyTarget || "");
      if (!target) return;
      var text = target.textContent
        .split("\n")
        .map(function (line) { return line.replace(/^\s*\$\s?/, ""); })
        .join("\n")
        .trim();

      var done = function () {
        var label = copyBtn.querySelector("[data-i18n]") || copyBtn;
        var original = label.textContent;
        label.textContent = html.lang === "zh-CN" ? "已复制" : "Copied";
        copyBtn.classList.add("is-done");
        setTimeout(function () {
          label.textContent = I18N[html.lang === "zh-CN" ? "zh" : "en"]["start.copy"];
          copyBtn.classList.remove("is-done");
        }, 1600);
      };

      if (navigator.clipboard && navigator.clipboard.writeText) {
        navigator.clipboard.writeText(text).then(done, function () { done(); });
      } else {
        var ta = document.createElement("textarea");
        ta.value = text;
        ta.style.position = "fixed";
        ta.style.opacity = "0";
        document.body.appendChild(ta);
        ta.select();
        try { document.execCommand("copy"); } catch (e) { /* ignore */ }
        document.body.removeChild(ta);
        done();
      }
    });
  }
})();
