/* Architecture page data and renderer. Loaded only by /architecture/. */
(function () {
  "use strict";

  var GROUPS = [
    { key: "host", en: "Host services", zh: "宿主服务" },
    { key: "workflow", en: "Workflow", zh: "工作流" },
    { key: "view", en: "View plugins", zh: "视图插件" },
    { key: "standalone", en: "Standalone capabilities", zh: "独立能力" }
  ];

  var COMPONENTS = [
    {
      group: "host",
      name: "@voltarenyah/dsh-tia-openness-v17-min",
      role: { en: "TIA Portal V17 access", zh: "TIA Portal V17 读写" },
      tools: "39",
      version: "0.1.0",
      work: { en: '<span class="work-alone">Works alone</span>', zh: '<span class="work-alone">独立可用</span>' }
    },
    {
      group: "host",
      name: "@voltarenyah/dsh-plcsim-advanced",
      role: { en: "PLCSIM Advanced runtime", zh: "PLCSIM Advanced 运行时" },
      tools: "4",
      version: "0.1.0",
      work: { en: '<span class="work-alone">Works alone</span>', zh: '<span class="work-alone">独立可用</span>' }
    },
    {
      group: "host",
      name: "@voltarenyah/dsh-engineering-graph",
      role: { en: "Knowledge graph · SQLite + C# engine", zh: "知识图谱 · SQLite + C# 引擎" },
      tools: "9",
      version: "0.1.0",
      work: { en: '<span class="work-alone">Works alone</span>', zh: '<span class="work-alone">独立可用</span>' }
    },
    {
      group: "host",
      name: "dsh-tool-git",
      role: { en: "Guard-railed Git", zh: "受控 Git" },
      tools: "12",
      version: "0.1.3",
      work: { en: '<span class="work-alone">Works alone</span>', zh: '<span class="work-alone">独立可用</span>' }
    },
    {
      group: "workflow",
      name: "@voltarenyah/dsh-engineering-context",
      role: { en: "Project scope and version workflow", zh: "工程作用域与版本工作流" },
      tools: { en: "core + diff + version", zh: "核心 + diff + 版本" },
      version: "0.1.0",
      work: {
        en: '<code>TIA plugin</code> · <code>git</code> · <code>graph</code> <em class="work-optional">(optional)</em>',
        zh: '<code>TIA 插件</code> · <code>git</code> · <code>graph</code> <em class="work-optional">（可选）</em>'
      }
    },
    {
      group: "standalone",
      name: "@voltarenyah/dsh-drawing",
      role: { en: "PDF drawing index + sidebar", zh: "PDF 图纸索引 + 侧栏" },
      tools: "5",
      version: "0.1.0",
      work: { en: '<span class="work-alone">Works alone</span>', zh: '<span class="work-alone">独立可用</span>' }
    },
    {
      group: "view",
      name: "dsh-ui-plc-source",
      role: { en: "Sidebar · PLC Blocks", zh: "右侧栏 · PLC Blocks" },
      tools: "—",
      version: "0.1.0",
      work: {
        en: '<code>engineering-context</code>',
        zh: '<code>engineering-context</code>'
      }
    },
    {
      group: "view",
      name: "dsh-ui-tia-console",
      role: { en: "Composer · TIA console", zh: "输入框 · TIA 控制台" },
      tools: "—",
      version: "0.1.0",
      work: {
        en: '<code>TIA plugin</code>',
        zh: '<code>TIA 插件</code>'
      }
    },
    {
      group: "view",
      name: "dsh-ui-versions",
      role: { en: "Sidebar · Versions", zh: "右侧栏 · Versions" },
      tools: "—",
      version: "0.1.0",
      work: {
        en: '<code>engineering-context</code>',
        zh: '<code>engineering-context</code>'
      }
    },
    {
      group: "view",
      name: "dsh-ui-hardware",
      role: { en: "Sidebar · Hardware", zh: "右侧栏 · Hardware" },
      tools: "—",
      version: "0.1.0",
      work: {
        en: '<code>TIA plugin</code>',
        zh: '<code>TIA 插件</code>'
      }
    },
    {
      group: "standalone",
      name: "dsh-ui-prompt-guide",
      role: { en: "Main · Prompt Guide", zh: "主栏 · Prompt Guide" },
      tools: "—",
      version: "0.1.0",
      work: { en: '<span class="work-alone">Works alone</span>', zh: '<span class="work-alone">独立可用</span>' }
    },
    {
      group: "standalone",
      name: "dsh-ui-project-dashboard",
      role: { en: "Sidebar · Project dashboard", zh: "侧栏 · 工程看板" },
      tools: "—",
      version: "0.1.0",
      work: { en: '<span class="work-alone">Works alone</span>', zh: '<span class="work-alone">独立可用</span>' }
    }
  ];

  var PRESETS = [
    { surface: { en: "TIA tools · <code>/tools</code> (39)", zh: "TIA 工具 · <code>/tools</code>（39）" }, leader: true, auditor: false, expert: false },
    { surface: { en: "TIA <code>/tia-*</code> commands (human)", zh: "TIA <code>/tia-*</code> 斜线命令（人用）" }, leader: true, auditor: false, expert: false },
    { surface: { en: "PLCSIM tools · <code>/tools</code> (4)", zh: "PLCSIM 工具 · <code>/tools</code>（4）" }, leader: true, auditor: false, expert: false },
    { surface: { en: "Git tools · <code>/tools</code> (12)", zh: "Git 工具 · <code>/tools</code>（12）" }, leader: true, auditor: false, expert: false },
    { surface: { en: "Graph inspect · <code>/tools</code>", zh: "图谱检查 · <code>/tools</code>" }, leader: true, auditor: false, expert: false },
    { surface: { en: "Graph full + ingest · <code>/tools</code>", zh: "图谱全量 + ingest · <code>/tools</code>" }, leader: false, auditor: true, expert: false },
    { surface: { en: "Graph drill-down · <code>/tools</code>", zh: "图谱下钻 · <code>/tools</code>" }, leader: false, auditor: false, expert: true },
    { surface: { en: "Engineering workflow · main row", zh: "工程工作流 · 主行" }, leader: false, auditor: true, expert: false },
    { surface: { en: "<code>project_status</code> · <code>/status</code>", zh: "<code>project_status</code> · <code>/status</code>" }, leader: true, auditor: true, expert: false },
    { surface: { en: "<code>project_diff</code> · <code>/diff</code>", zh: "<code>project_diff</code> · <code>/diff</code>" }, leader: false, auditor: true, expert: true },
    { surface: { en: "Version tools · <code>/version</code>", zh: "版本工具 · <code>/version</code>" }, leader: true, auditor: true, expert: false },
    { surface: { en: "Version read-only · <code>/version-read</code>", zh: "版本只读 · <code>/version-read</code>" }, leader: false, auditor: false, expert: true },
    { surface: { en: "Filesystem", zh: "文件系统" }, leader: "rw", auditor: "ro", expert: "ro" }
  ];

  var I18N = {
    en: {
      "arch.head.eyebrow": "Architecture",
      "arch.head.title1": "One distribution,",
      "arch.head.title2": "twelve bundles",
      "arch.head.lead": "The suite is a DeepSeek Harness profile over twelve independently installable bundles. The profile decides which packages compose, which services connect them, and which tools each preset can see.",
      "arch.w.title": "Why a distribution",
      "arch.w.note": "DSH installs bundles; the profile composes them and sets policy.",
      "arch.w1.title": "Bundle = capability",
      "arch.w1.desc": "Each plugin is a normal DSH bundle with its own <code>cordis.patch.yml</code>. It can be installed on its own; the release publishes one tarball per package.",
      "arch.w2.title": "Profile = composition",
      "arch.w2.desc": "A profile is the composition layer: it declares bundles, presets and policy. It is not a bundle: <code>dsh plugin add</code> rejects it as <code>not-a-bundle</code>.",
      "arch.w3.title": "Release = a tested combination",
      "arch.w3.desc": "The GitHub release ships the blueprint, per-package tarball URLs and an installer. It pins the combination that was verified together — not a mega-package.",
      "arch.w.assembly": '<span class="assembly__node"><b>12</b> bundles</span><span class="assembly__arrow" aria-hidden="true">→</span><span class="assembly__node assembly__node--accent">profile · bundles + presets + policy</span><span class="assembly__arrow" aria-hidden="true">→</span><span class="assembly__node">dsh --profile …</span><span class="assembly__note">one tested combination</span>',
      "arch.w.foot": "The packages stay independent; the profile is what makes them one product.",
      "arch.p.title": "Principles",
      "arch.p.note": "Four rules that decide how the pieces are assembled.",
      "arch.p1.title": "Compose, don't absorb",
      "arch.p1.desc": "One capability per bundle. The distribution is a profile over packages, not a single plugin that swallows them.",
      "arch.p2.title": "Services are the cross-plugin API",
      "arch.p2.desc": "Plugins never import each other. They meet through a small set of host services — TIA access, the knowledge graph, and the git repository — and report a missing service instead of guessing.",
      "arch.p3.title": "Visibility is a preset decision",
      "arch.p3.desc": "Host rows own processes and services. Tool rows are mounted by a preset, so the same package can expose different surfaces to leader, auditor and expert.",
      "arch.p4.title": "Policy is configuration",
      "arch.p4.desc": "Personae, the default preset, disabled built-ins and subagent limits live in the profile. Changing them does not rebuild a plugin.",
      "arch.c.title": "Components",
      "arch.c.note": "Twelve bundles. “Work with” names the other bundles each one needs; “Version” is the package version.",
      "arch.c.legend": "“Work with” lists the bundles this one needs; “Works alone” means no other bundle is required. Versions are package versions; the suite release is versioned separately.",
      "arch.c.foot": "The profile blueprint is not a component: it is the assembly layer above these packages. Package versions are independent of the suite release.",
      "arch.s.title": "Preset surfaces",
      "arch.s.note": "The package is not the unit of visibility; the row is.",
      "arch.s.example": "<pre><span class=\"c\"># profile/cordis.patch.yml — a preset mounts an entry point</span>\n- id: leader-tia-tools\n  name: '@voltarenyah/dsh-tia-openness-v17-min/tools'\n\n<span class=\"c\"># the host row is separate; it owns the controller and the service</span>\n- id: tia-openness-v17-min\n  name: '@voltarenyah/dsh-tia-openness-v17-min'</pre>",
      "arch.s.foot": "<code>leader</code> gets the working surface; <code>auditor</code> owns the version workflow; <code>expert</code> gets read-only drill-down. A subagent cannot inherit a tool its preset did not mount.",
      "arch.r.title": "How it runs",
      "arch.r.note": "One process boundary, because Openness demands it.",
      "arch.r.body": "Openness can only be called from a 64-bit .NET Framework process, so the TIA plugin owns a C# controller subprocess and speaks one JSON object per line over stdio. Requests are serialized; a timeout terminates and restarts the controller.",
      "arch.r.mono": "TiaOpennessV17Min.Controller.exe · x64 · .NET Framework 4.8"
    },
    zh: {
      "arch.head.eyebrow": "架构",
      "arch.head.title1": "一个发行版，",
      "arch.head.title2": "十二个 bundle",
      "arch.head.lead": "这套发行版是一个 DSH profile，叠加在十二个可独立安装的 bundle 之上。profile 决定组合哪些包、服务怎么接、每个 preset 能看到哪些工具。",
      "arch.w.title": "为什么要做成发行版",
      "arch.w.note": "DSH 安装的是 bundle；profile 负责组合它们并设定政策。",
      "arch.w1.title": "Bundle = 能力",
      "arch.w1.desc": "每个插件都是标准 DSH bundle，带自己的 <code>cordis.patch.yml</code>，可以单独安装；发布时每个包各出一个 tarball。",
      "arch.w2.title": "Profile = 组合",
      "arch.w2.desc": "profile 是组合层：它声明 bundle、preset 与政策。它不是 bundle：<code>dsh plugin add</code> 会以 <code>not-a-bundle</code> 拒绝它。",
      "arch.w3.title": "Release = 已验证的组合",
      "arch.w3.desc": "GitHub Release 交付蓝图、各包 tarball 的 URL 和安装器，钉住一套一起验收过的组合，而不是一个巨型包。",
      "arch.w.assembly": '<span class="assembly__node"><b>12</b> 个 bundle</span><span class="assembly__arrow" aria-hidden="true">→</span><span class="assembly__node assembly__node--accent">profile · bundle + preset + 政策</span><span class="assembly__arrow" aria-hidden="true">→</span><span class="assembly__node">dsh --profile …</span><span class="assembly__note">一套已验证的组合</span>',
      "arch.w.foot": "包保持独立；让它们成为一个产品的是 profile。",
      "arch.p.title": "设计原则",
      "arch.p.note": "四条规则，决定这套东西怎么被组装。",
      "arch.p1.title": "组合，不要吞并",
      "arch.p1.desc": "一个 bundle 只承担一类能力。发行版是包之上的 profile，而不是把所有包塞进一个插件。",
      "arch.p2.title": "服务是跨插件 API",
      "arch.p2.desc": "插件之间不互相 import，而是通过少量宿主服务会合——TIA 访问、知识图谱、Git 仓库；服务缺席时明确报错，不靠猜。",
      "arch.p3.title": "可见性由 preset 决定",
      "arch.p3.desc": "宿主行持有进程与服务；工具行由 preset 挂载。同一个包可以给 leader、auditor、expert 不同的工具面。",
      "arch.p4.title": "政策是配置",
      "arch.p4.desc": "persona、默认 preset、禁用的内置 preset、子 agent 上限都在 profile 里；改政策不需要重新构建插件。",
      "arch.c.title": "组件",
      "arch.c.note": "十二个 bundle。“配合”列出它需要的其他插件；“版本”是各包自己的版本。",
      "arch.c.legend": "“配合”列出它需要的其他插件；“独立可用”表示不需要其他插件。版本是各包自己的版本；发行版版本单独维护。",
      "arch.c.foot": "profile 蓝图不是一个组件，而是这些包之上的组装层。各包版本与发行版版本相互独立。",
      "arch.s.title": "Preset 工具面",
      "arch.s.note": "可见性的单位不是包，而是行。",
      "arch.s.example": "<pre><span class=\"c\"># profile/cordis.patch.yml — preset 挂载一个入口行</span>\n- id: leader-tia-tools\n  name: '@voltarenyah/dsh-tia-openness-v17-min/tools'\n\n<span class=\"c\"># 宿主行是另一行；它持有控制器与服务</span>\n- id: tia-openness-v17-min\n  name: '@voltarenyah/dsh-tia-openness-v17-min'</pre>",
      "arch.s.foot": "<code>leader</code> 拿工作工具面；<code>auditor</code> 拿版本工作流；<code>expert</code> 只拿只读下钻。preset 没挂的行，子 agent 不会继承。",
      "arch.r.title": "它怎么运行",
      "arch.r.note": "一个进程边界，因为 Openness 只能这么调用。",
      "arch.r.body": "Openness 只能被 64 位 .NET Framework 进程调用，所以 TIA 插件持有一个 C# 控制器子进程，用「一行一个 JSON」的协议走 stdio 通信。请求串行化；超时会终止并自动重启控制器。",
      "arch.r.mono": "TiaOpennessV17Min.Controller.exe · x64 · .NET Framework 4.8"
    }
  };

  function buildComponents(lang) {
    var label = {
      package: lang === "zh" ? "包" : "Package",
      role: lang === "zh" ? "职责" : "Role",
      tools: lang === "zh" ? "工具" : "Tools",
      work: lang === "zh" ? "配合" : "Work with",
      version: lang === "zh" ? "版本" : "Version"
    };
    var head = '<table class="table table--components"><thead><tr><th>' +
      label.package + "</th><th>" + label.role + '</th><th class="num">' +
      label.tools + "</th><th>" + label.work + "</th><th>" +
      label.version + "</th></tr></thead><tbody>";
    var rows = "";
    GROUPS.forEach(function (group) {
      rows += '<tr class="table-group"><td colspan="5">' + group[lang] + "</td></tr>";
      COMPONENTS.forEach(function (component) {
        if (component.group !== group.key) return;
        var tools = typeof component.tools === "object" ? component.tools[lang] : component.tools;
        rows += '<tr><td data-label="' + label.package + '"><code>' + component.name +
          '</code></td><td data-label="' + label.role + '">' + component.role[lang] +
          '</td><td class="num" data-label="' + label.tools + '">' + tools +
          '</td><td data-label="' + label.work + '">' + component.work[lang] +
          '</td><td data-label="' + label.version + '"><span class="version">' +
          component.version + "</span></td></tr>";
      });
    });
    return head + rows + "</tbody></table>";
  }

  function mark(value, lang) {
    if (value === true) return '<span class="yes" aria-label="' + (lang === "zh" ? "有" : "yes") + '">●</span>';
    if (value === false) return '<span class="no" aria-hidden="true">—</span>';
    if (value === "rw") return '<span class="celltext">' + (lang === "zh" ? "可写" : "read/write") + "</span>";
    if (value === "ro") return '<span class="celltext">' + (lang === "zh" ? "只读" : "read-only") + "</span>";
    return "";
  }

  function buildPresets(lang) {
    var head = '<table class="table table--matrix"><thead><tr><th>' +
      (lang === "zh" ? "工具面" : "Surface") + "</th><th>leader</th><th>auditor</th><th>expert</th></tr></thead><tbody>";
    var rows = PRESETS.map(function (preset) {
      return "<tr><td>" + preset.surface[lang] +
        '</td><td data-label="leader">' + mark(preset.leader, lang) +
        '</td><td data-label="auditor">' + mark(preset.auditor, lang) +
        '</td><td data-label="expert">' + mark(preset.expert, lang) + "</td></tr>";
    }).join("");
    return head + rows + "</tbody></table>";
  }

  function renderArch(lang) {
    var key = lang === "zh" ? "zh" : "en";
    var components = document.querySelector('[data-block="arch.c.table"]');
    if (components) components.innerHTML = buildComponents(key);
    var presets = document.querySelector('[data-block="arch.s.table"]');
    if (presets) presets.innerHTML = buildPresets(key);
  }

  window.ARCH_I18N = I18N;
  window.renderArch = renderArch;
})();
