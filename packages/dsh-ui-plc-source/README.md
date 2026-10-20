# dsh-ui-plc-source

DSH 插件（**浏览器半侧**）：在 dsh-web 的**右侧栏**增加一个 **PLC Blocks** 标签页，把会话工作区
`source/` 下每个 device 导出的 PLC 源对象**平铺**成一张可筛选的表。

> 本包只有 UI：宿主半侧是一个空的 `apply()`，存在的意义是让包在 Loader 里有一行——
> `client-modules` 是**扫描已启用的 Loader 条目**才发现 `lib/client.js` 的，
> 没有行就不会有 `/plugins/??dsh-ui-plc-source/client.js`，而且**不报错**。

## 它做什么

- 列 `source/` 找到 device 目录，读每个 device 的 `_tia-openness-manifest.json`（**整文件** `readBytes`，
  一次往返；不用按行分页的 `read`——17 464 行要 4 页）；
- 把 `blocks[]` 的每条对象**平铺**成一行：类型徽章、名称、编号、语言、大小、写后校验标记；
  **不渲染** `group` 的目录层级；
- **TIA 拒绝导出的对象也列成行**（`failures[]`）：徽章显示「拒绝」、灰显、不可点击，悬停看 TIA 的完整原因。
  它们不在 `blocks[]` 里，不列出来就等于"少了几块但查不到是谁"；
- 三个筛选：**device** 与 **simaticType** 两个下拉（各带计数，互不收窄对方选项）＋ **名称/编号搜索框**
  （不分大小写，`scp` 命中 `SCP_IN`，`1001` 命中编号 1001）；
- **单击 = 选中**（高亮该行；选中本身暂时不做任何事，留给后续功能），
  **右键菜单**里是动作：「打开源文件」用既有的文档预览打开那个 `.xml`
  （复用 `ui-sidebar-documentpreview`，不自己写查看器）；「在对话里提及」把 `@'块名'` 插进输入框。
  拒导对象的这两项都是禁用状态并说明原因；
- 「刷新」清缓存重读（保留当前的筛选/搜索/选中/滚动位置）。

**视图状态放在 slot store 里**（`src/client/store.js`，`defineStore` + `ctx.slots.register({ store })`）：
两个筛选、搜索串、选中行、滚动位置，以及**已读到的行本身**（作为视图缓存，与官方
`ui-sidebar-files` 把目录列举放在 store 里同一做法）。所以切到别的侧栏 tab 再切回来，
设置还在、**也不会重读清单**（每 device 一次 `readBytes`，773 KB 级）。
状态按 tab id 分桶；tab 记录消失（关闭或插件卸载，`tab.signal` 中止）时清掉那个桶。

`simaticType`（`OB/FB/FC/InstanceDB/GlobalDB/ArrayDB/PlcStruct/PlcTagTable`）只存在于清单里，
所以这个 tab **必须**读清单；清单缺失/不可读时该 device 退回递归列目录（只有名字与大小，
类型显示为「未知」），其余 device 照常。

## 文案与语言

界面文字**跟随 DSH 自己的语言设置**（设置 → 通用 → 语言），中文显示中文、English 显示英文，
切换时**不用刷新页面**，已经打开的 tab 也一样。

- 字典在 `src/client/locales.js`：`NS = 'plcSource'`，`zh` / `en` 两份（约 50 个键）。
  `apply` 里 `ctx.locale.register(NS, { zh, en })` 注册，`ctx.locale.bind(NS)` 拿到 `t`；
- 两个 `slots.register` 都带 `locale: NS`，框架据此把 `t` 交给组件；
- tab 类型与引导项里的标题是 **thunk**（`() => t('tab.title')`），注册表存函数，所以文字跟着语言走；
- 侧栏 chip 另占一个座位（`src/client/Title.jsx` 注册到 `sidebar.right.pane.tab.title`）：
  tab 记录会在**打开那一刻**冻住标题文本，只有这个座位能让**已打开**的 chip 跟着语言变；
- 错误提示也不写死句子：`model.ts` 的 `errorCopy(code)` 只把宿主返回的错误码映射成**字典键**，
  句子由字典给。

`test/locales.test.mjs` 会检查两份字典的键集合一致、没有空串、`model.ts` 的每个错误码都有对应键、
占位符集合一致——加文案时忘了补英文会**测试失败**，不会静默显示中文。

面板里"语言"那一列是 **PLC 编程语言**（STL / LAD / FBD），不是界面语言，不进字典。

## 在对话里提及（Mention in chat）

右键菜单第二项「在对话里提及」把 **`@'块名'`** 插到当前会话的输入框里（插在光标处、单独成段），
并且**模型会收到这个块的引用信息**。两件事分在两半做，是这个功能唯一的复杂点：

- 输入框里只有 `@'SCP_IN'` 一行，没有别的字；
- 发送后，模型在那条消息后面看到一段 **宿主半侧追加的上下文**：

  ```
  ## PLC blocks cited in this message
  [plc-block] name="SCP_IN" device="Sino_PEI" type="FB" number="1001" language="SCL" file="source/Sino_PEI/blocks/…/SCP_IN.xml"
  ```

  一行一个对象，`key="value"` 是为了让模型能分别挑出设备、类型、编号与文件；名字对不上时
  写 `found="false"`，模型就不会去找一个不存在的文件。

**为什么不在输入框里直接写全。** DSH 没有"只给模型看"的输入通道：输入框里的字就是模型看到的字。
所以要么把引用信息也塞进输入框（吵，而且用户要的是干净的 `@'块名'`），要么在宿主拦截请求时补上。
选后者：浏览器半侧只插记号，宿主半侧在 `agent/pre-step` 把记号解析成上下文块，追加到那条用户消息的
content 里（内置的 `@session` 引用用的是同一个事件，见它的 `prepend: true` 用法）。

几处不显然的取舍：

- 记号用**单引号** `@'…'`。`@path` 与 `@"path with spaces"` 已经被文件引用语法占用，
  单引号是唯一不会和它抢同一个 span 的写法；对话记录里这个记号渲染成一个小 chip
  （`conversation.user.text.node` 座位 + 一条 `order: 5` 的 userText 规则），
  否则文件语法会把它当成一个打不开的文件。输入框里不渲染 chip（输入机只认 pick 产生的 chip），
  就是普通文本，用户还能自己改。
- 解析在宿主、复用 `src/model.ts` 的 `parseManifest`：读 `<cwd>/source/*/_tia-openness-manifest.json`，
  按名字**精确匹配**、再**大小写不敏感**匹配。结果按 `source/` 绝对路径缓存，
  **只有名字没命中时才重读一次**——刚导出的块能认到，打错字也不会每步扫一遍目录。
  实测 777 KB 清单首次 **16 ms**、命中缓存 **120 µs**。
- 拒导对象（`failures[]`）**不能**提及：菜单项禁用，和「打开源文件」一致——它没有文件，
  让模型按名字去找只会得到空结果。（手动打这个记号仍会解析成 `export="refused"` 一行，
  那是有意留的逃生口。）
- 读取失败不会让这一轮失败：异常只写一条 warn，消息原样发出去。

## 装到本发行版

三处（少一处就静默不生效）：

1. `profile/dsh-automation-suite/package.json` 的 `dependencies` 加 `"dsh-ui-plc-source": "workspace:^"`；
2. 同文件 `dsh.profile.bundles` **末尾**加 `"dsh-ui-plc-source"`；
3. 已物化的 profile（`<DSH_HOME>/profiles/dsh-automation-suite/package.json`）的
   `dsh.profile.bundles` 也要补这一行——`start-env.ps1` 只写依赖，CLI 只追加"本次新加的依赖"。

```powershell
pwsh -NoProfile -File scripts\start-env.ps1 -DshHome <那个 home> -Restart
```

## 开发

```powershell
node scripts/build.mjs      # tsc → lib/index.js + lib/model.js；esbuild → lib/client.js
node scripts/run-tests.mjs  # 先构建，再 node --test（纯模型 33 项 + 宿主 9 项 + 文案 5 项）
node scripts/tsc.mjs -p tsconfig.json --noEmit
```

两个构建面各有原因：

- **宿主半侧 + 纯模型**：`tsc`（仓库根的 typescript），与兄弟包一致；
- **浏览器半侧**：`esbuild`（本仓 `.pnpm` 里已有，按候选路径探测，不新增依赖），产出
  `window.__ModuleLoader__.load({ id, factory })` 包装 —— 宿主只认这个形状，不是普通 ESM；
  只有宿主冻结的基座模块保持 external（`react` / `react/jsx-runtime` 等，清单见
  `scripts/build.mjs` 的 `PLATFORM_MODULES`），**其它 `@deepseek-ai/*` 一律不 import**。

浏览器半侧写 `.jsx` 而不是 `.tsx` 是有意的：本仓没有 `@types/react`，抽取的宿主运行时也没有 `.d.ts`，
`.tsx` 过不了 `tsc`。于是把"能类型检查的部分"留在 `src/model.ts`（有单测），
把"只能靠浏览器验证的部分"写成 `.jsx`。

## 已知边界

- 「刷新」与「切换到别的 tab 再回来」都不重读清单；只有首次进入、换工作区（`cwd` 变化）或手动刷新才读。
- 清单超过 `maxFileBytes`（32 MiB）时该 device 退化到目录列举；行数超过 2000 会截断并提示收窄筛选
  （搜索与两个筛选都会收窄，所以 2000 这个上限只在"全部"视图下才可能碰到）。
- 清单的 `sha256` 是"导出文件字节"的哈希，**每次导出都会变**，所以本 tab **不做**变更标记。
- `failures[]` 只有 TIA 给出的名字与原因，**没有类型/编号/语言**：被拒对象的类型一律按「未知」归类，
  它们也因此排在列表末尾（类型序最后）。
- 选中一行后**暂时没有后续动作**（这是刻意的：选中态先落地，动作后续加）。
- 右键菜单只有两项；键盘可用 `Shift+F10` / 菜单键打开同一个菜单，`Esc` 关闭。
- 提及只在**有 `source/` 的工作区**里解析得到；宿主缓存的是"这个 `source/` 目录"的清单，
  换了工程（同名不同内容）要重开 App 或重启会话进程才会重新读。
- 提及插入要求该会话的输入框在（会话已打开）；输入机正在发送时插入会被拒绝，
  面板会显示一条错误提示，而不是悄悄改掉草稿。
