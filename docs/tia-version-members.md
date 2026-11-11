# 接口插件族的多成员形态：V17 / V18 如何共存、如何替换

> **状态**：技术路线**已定**（[`decisions.md`](decisions.md) **D36**），**尚未实现**。
> 做 V18 时按本文执行，不要再重新论证一次。
>
> **一句话**：族内成员是**不同的包**（`…-v17-min` / `…-v18`），同一时刻**只激活一个**；
> 激活单位是**插件页上的 bundle 开关**，不是逐行开关；切换后**重启客户端**；
> 互斥靠**先到先占 + 报错日志**；宿主行与自己 `/tools` 行之间的内部缝**同名 + `version` 字段比对**。
>
> 依据：本文的每条机制结论都在 **DSH 0.2.2-rc.1** 的安装产物上读过实现（`app.asar` 里的
> `dsh-plugin-manager` / `dsh-agent-preset-registry` / `dsh-app-boot` / `@deepseek-ai/cordis`）。
> 标注「**未实证**」的条目是推断，见 §10。

---

## 1. 为什么必须有"同一时刻只一个"

三条**硬约束**，任意一条都足以否掉"两个版本同时激活"：

| # | 约束 | 出处（0.2.2-rc.1 实测实现） |
|---|---|---|
| 1 | **同名服务只能有一个提供者**，第二个直接抛 | `cordis` 的 `reflect.provide`：`if (this.store[key]) throw new Error(... service "X" has been registered at <fiber name> ...)` |
| 2 | **同名工具 / 命令 / skill provider 不能注册两次**，第二个直接抛 | `tool "${name}" is already registered in this scope`、`command "${name}" is already registered in this scope`、`a skill provider named "${name}" is already registered in this scope`（都是 `NamedEntries`） |
| 3 | **一个宿主一个控制器**（Openness 侧的限制） | 本仓 D2 硬约束 1、D31；`runtime-service.ts` 顶部注释 |

第 1 条卡的是 `engineeringAccess` / `projectTextAccess` 这两个**版本中立的族契约服务**：
它们必须叫同一个名字（否则工程上下文插件要为每个版本写一份适配），而同一个名字只能有一个提供者。
第 2 条卡的是 39 个工具名与 7 个 `/tia-*` 命令名：它们也必须跨版本一致（否则 todo bridge、
persona 政策文本、TIA 控制台按钮全部要按版本分叉）。

所以"只一个"不是保守，而是**这两条中立性要求的直接推论**。

> **顺带记一条反直觉的事实**：两个版本的 C# 控制器是**独立子进程**，装机里 V17/V18 共存时
> 理论上可以各开一个 TIA Portal。真正卡住的只有上面的服务名/名字层。
> 也就是说"只一个"是**我们选的设计**，不是 Openness 逼的——代价是同一个用户不能在一个会话里
> 同时操作 V17 与 V18 工程；要并行就开两个 profile（`docs/distribution.md` §4 已有并存先例）。

---

## 2. 用户看到的形态（这是验收目标）

| 动作 | 在哪里做 | 结果 |
|---|---|---|
| 装 V17 / 装 V18 | 插件页 **Add plugin** | 两个 bundle 都出现在列表里，卡片标题为 **TIA Portal V17** / **TIA Portal V18** |
| 选 V17 | 插件页把 V17 的 bundle 开关打开、V18 的关掉 | 只有 V17 的宿主行在跑：一个控制器、一个 TIA 会话 |
| 切到 V18 | 反过来拨，**然后重启客户端** | 新版本的控制器与 TIA 会话 |

三条性质必须同时成立：

1. **互斥可见**：两个都开着时，只有一个真正工作，另一个在日志里明确报错，并且 `doctor` 会报；
2. **名字不变**：39 个工具名、7 个 `/tia-*` 命令名、`tia-openness` 路由 skill 名**跨版本逐字相同**；
3. **后端零改动**：除成员包自己，其余插件**一行不改** —— `dsh-engineering-context`、`dsh-engineering-graph`、
   `dsh-drawing`、`dsh-plcsim-advanced`、`dsh-tool-git`、`dsh-tia-todo-bridge`，以及 8 个 UI 插件
   （`ui-plc-source` / `ui-tia-console` / `ui-versions` / `ui-changes` / `ui-hardware` / `ui-prompt-guide` /
   `ui-project-dashboard` / `ui-brandmark`）。
   > 唯一的**例外**是 §9 那张表：`dsh-engineering-context` 里的 V17 硬编码文案与包名要在做 V18 时一并清掉
   > ——但那属于"说错话"的问题，不是"接不上"的问题，V18 成员本身不需要它们改动就能工作。

---

## 3. 激活为什么是 bundle 开关，而不是逐行开关

`dsh-plugin-manager` 的逐行开关 `setPluginEnabled` **只接受宿主面（`include` 平面）的行**：

```js
// dsh-plugin-manager/lib/index.js · listPlugins()
if (candidate === undefined || candidates.length > 1
    || candidate.name !== entry.moduleName
    || actual?.parent.tree.ctx.fiber.entry?.id !== "include")
  return { ...entry, readOnlyReason: "unaddressable" };
```

而本发行版的 TIA **模型面工具行与命令行是故意放在 preset 平面里的**（D23 / D31 的落地形态）：

| 行 | 声明位置 | 平面 | 插件页能逐行开关？ |
|---|---|---|---|
| `tia-openness-v17-min`（宿主行：控制器 + 服务 + skill） | bundle 的 `cordis.patch.yml` → profile `insert` | **include** | ✅ 能 |
| `@voltarenyah/dsh-tia-openness-v17-min/tools` | profile 蓝图的 `preset-leader` 内 | **preset** | ❌ 一律 `unaddressable`，开关不出现 |
| `@voltarenyah/dsh-tia-openness-v17-min/commands` | 同上 | **preset** | ❌ 同上 |

所以**逐行开关只能开到控制器/服务那一层**，而工具行永远在 preset 里常驻。
这正是必须选 **bundle 开关** 的原因：bundle 开关写的是 `package.json` 的
`dsh.profile.bundles` 有序列表（"Disabling retains the dependency; enabling appends the bundle at the end"），
一次动作就让整个成员（宿主行 + 服务 + skill）进入或退出组合。

**代价（必须接受）**：关掉 bundle **不会卸载依赖**。所以被关掉那个成员的工具行仍然会被 import、
`apply()` 仍然会跑——§5 的"空转"设计就是为这一条准备的。

---

## 4. 包名与显示名（已定）

### 4.1 命名

| 项 | V17（现状） | V18（新成员） |
|---|---|---|
| 包名 | `@voltarenyah/dsh-tia-openness-v17-min` | `@voltarenyah/dsh-tia-openness-v18` |
| bundle 显示名 | **TIA Portal V17** | **TIA Portal V18** |
| 宿主行 id | `tia-openness-v17-min` | `tia-openness-v18` |
| tools 行 id / 子路径 | `tia-openness-v17-min-tools` / `./tools` | `tia-openness-v18-tools` / `./tools` |
| commands 行 id / 子路径 | `tia-openness-v17-min-commands` / `./commands` | `tia-openness-v18-commands` / `./commands` |
| 控制器程序集 | `TiaOpennessV17Min.Controller` | `TiaOpennessV18.Controller` |
| 控制器 exe | `controller/bin/TiaOpennessV17Min.Controller.exe` | `controller/bin/TiaOpennessV18.Controller.exe` |
| 技能 provider 名 | `tia-openness-v17-min` | `tia-openness-v18` |

**`-min` 后缀不再出现在 V18 及以后**：它是 D2 时代"min / std / pro 三档"的残留，D31 之后档位已不成立，
继续带后缀只会让人以为 V18 也有张三档。**V17 的包名保持不动**（有已发布 tarball、已装 profile、
归档仓库的历史提交都按这个名字），改名属于独立的破坏性操作，不在 V18 的工作里做。

### 4.2 显示名怎么来

插件页卡片标题由 `readPluginMeta` 读 `locale/<lang>.json` 的 `title` 字段；缺省回退到
`package.json.name`。所以每个成员需要：

```
locale/en.json    { "title": "TIA Portal V18", "description": "…" }
locale/zh.json    { "title": "TIA Portal V18", "description": "…" }
```

外加 `package.json` 的 `files` 与 `exports`（照 `@deepseek-ai/dsh-client-ui-plugin-manager` 的写法）：

```jsonc
"exports": { "./locale/*.json": "./locale/*.json" },
"files": ["lib", "cordis.patch.yml", "controller/bin", "skills", "locale/*.json", "README.md", "…"]
```

**版本号必须写进显示名**——如果两个成员都叫 "TIA Openness"，用户在插件页上根本分不清该关哪个。
这一条是 §2 验收的硬要求。

---

## 5. 机制：三个必须改的地方

本节是本文的核心。三处改动**全部在成员包内部**，不涉及任何其他插件。

### 5.1 内部缝带 `version`（同一服务名 + 字段比对）

**现状**：`tiaOpennessRuntime` 是宿主行给自己 `/tools` / `/commands` 行用的内部缝
（`runtime-service.ts:44`），当前没有任何版本标识；`tiaOpennessRuntimeOf()` 在缺席时**抛错**
（`runtime-service.ts:96-104`）。

**问题**：V17 的工具行如果只看"有没有 runtime"，就会拿到 **V18 的** runtime 并用 V17 的工具体
驱动 V18 的控制器——**静默接错控制器**，是本方案里最危险的情形。

**决定**：服务名**保持 `tiaOpennessRuntime` 不变**，对象上增加只读成员：

```ts
// runtime-service.ts
export interface FamilyMemberIdentity {
  /** 这个成员绑定的 TIA Portal 主版本号。 */
  readonly version: number       // V17 → 17，V18 → 18
  /** 成员的包名，只用于日志与诊断。 */
  readonly packageName: string
}

export class TiaOpennessRuntime extends Service {
  readonly member: FamilyMemberIdentity   // 新增
  // request / status / verbose 不变
}
```

**为什么用同一服务名 + 字段，而不是 `tiaOpennessRuntime17` / `18`**：
工具行与命令行的 `inject` 是**静态声明**，服务名一旦带版本，成员包就没法用一份代码跑两个版本；
而"同一服务名 + 运行时比对字段"让两份代码结构完全对称，也让"先到先占"只有一个争用点。
**注意**：`engineeringAccess` / `projectTextAccess` **不得**带版本——它们是族契约（§6）。

**同一包内的 V17 改造清单**（做 V18 时用同一套）：

| 位置 | 改动 |
|---|---|
| `src/runtime-service.ts:44` | `TIA_RUNTIME_SERVICE` 不变；加 `version` / `packageName` |
| `src/runtime-service.ts:96` | 新增**不抛错**的 `tiaOpennessRuntimeMaybe(ctx)`；`tiaOpennessRuntimeOf` 保留给测试 |
| `src/index.ts:108` | 构造 `TiaOpennessRuntime` 时带上身份 |
| `src/tools-entry.ts:44` | `inject` 从 `['tools', TIA_RUNTIME_SERVICE]` 改为 `['tools']` |
| `src/commands-entry.ts:45` | `inject` 从 `['commands', TIA_RUNTIME_SERVICE]` 改为 `['commands']` |

### 5.2 工具行 / 命令行"认错就空转"

**问题**：如果工具行继续 `inject: ['tools', 'tiaOpennessRuntime']`，那么在
"V17 关了、V18 开了"或"V17 关了、V18 没装"时，V17 的工具行**永远等不到自己那一版的服务**，
停在 `pending`。而 preset 的挂载校验会把 pending 行也算成坏行：

```js
// dsh-agent-preset-registry/lib/index.js
async diagnostic(record) {
  let audit = await auditRows(tree);                 // fiber.state 仍是 PENDING
  if (audit.pending.length > 0) {
    await this.owner.loader.await();
    audit = await auditRows(tree);
  }
  const lines = [...audit.failed, ...audit.pending]; // pending 也计入
  return lines.length === 0 ? undefined : lines.join("\n");
}
async retain(id) { … if (broken !== undefined || generation === undefined)
  throw new RemoteError("agent-preset/invalid", reason, …) }   // ⇒ 新建会话被拒
```

这就是本仓已经踩过的那种事故（`profile/dsh-automation-suite/cordis.patch.yml:59-63` 记录的
`agent-preset/invalid: … never started` **拒绝新建会话**）。只不过那时是 `fiber === undefined`（failed），
现在是 `PENDING`——`diagnostic()` 把两者都算坏。

**决定**：工具行与命令行**把 runtime 从 `inject` 里拿掉**，改为在 `apply()` 里主动取、比对、**不匹配就空转**：

```ts
// tools-entry.ts
export const inject = ['tools']            // 只等注册表，不等 runtime

export function apply(ctx: Context, _config?: unknown): void {
  const log = ctx.logger(name)
  const runtime = tiaOpennessRuntimeMaybe(ctx)      // 不抛错

  if (runtime === undefined) {
    log.info('No TIA interface plugin is active in this composition; this /tools row registers nothing.')
    return                                          // 合法空转，不是失败
  }
  if (runtime.member.version !== MEMBER.version) {
    log.info(
      `The active TIA interface plugin is V${runtime.member.version} (${runtime.member.packageName}), ` +
      `but this /tools row belongs to V${MEMBER.version}. Registering nothing; restart the client after ` +
      'switching the active interface plugin.',
    )
    return
  }
  // 正常注册 39 个工具
}
```

命令行同款。**空转的语义是"这个 agent 这一轮没有 TIA 工具"，不是"插件坏了"**——
消费侧本来就接受这种状态：工程上下文插件对缺席的 `engineeringAccess` 一律降级
（`packages/dsh-engineering-context/src/access.ts:441` 起的 `engineeringAccess(ctx)` 返回 `undefined`），
它自己的错误码已经覆盖"装的成员没有某个能力"这一类（`scan.ts:25` / `sync.ts:127` 等）。
所以空转下会话可以正常用，只是没有 TIA 工具。

> **为什么不用 `ctx.inject(['tiaOpennessRuntime'], cb)` 让子插件延迟挂载**：
> 先把两种 `inject` 分清，这里容易写错：
>
> | 形态 | 服务缺席时 | preset 校验怎么看 |
> |---|---|---|
> | **模块级** `export const inject = ['tools', 'tiaOpennessRuntime']` | **这一行本身**停在 `PENDING` | `auditRows()` 扫 `tree.entries()` 看到它，`missing` 非空 ⇒ `pending` ⇒ **preset `invalid`** |
> | **`apply()` 里** `ctx.inject(['tiaOpennessRuntime'], cb)` | 那一行照常 ACTIVE，只有 `cb` 派生的**子 fiber** 一直等 | 子 fiber 不是 Loader entry，`auditRows()` 扫不到 ⇒ **不会 invalid** |
>
> 也就是说 `ctx.inject` 确实能绕开 §5.2 的 pending 事故（`skills.ts:14` 用的就是它）。
> **但它解决不了本方案真正的问题**：`tiaOpennessRuntime` 的服务名是版本中立的，
> V17 的工具行 `inject` 它照样会拿到 **V18 的** runtime —— 延迟挂载把"静默接错控制器"
> 从同步变成异步，问题一点没少。反过来，如果坚持 `ctx.inject`，就必须在回调里再做一次
> `member.version` 比对，于是和"在 `apply()` 里主动取 + 比对"是同一件事，只是多了一层异步
> 与"工具在会话中途才出现"的不确定时机。
>
> 所以选**不 inject、在 `apply()` 里同步取、比对后决定注册与否**：结果是确定性的
> （有 runtime 就这一瞬间注册完，没有就永远不注册），也不需要解释"工具为什么晚到了"。

### 5.3 互斥：先到先占 + 报错日志

**决定**：族内用**一个中立的占位服务**做互斥，先到者占领，后到者**不提供任何族服务、不起控制器**，
只打一条醒目 error 日志。

```ts
// family-claim.ts（每个成员包里各有一份同样的实现；不抽共享包，D10）
export const FAMILY_CLAIM_SERVICE = 'tiaOpennessFamilyMember'

/**
 * 族位。继承 `Service` 是**必须**的：
 * 本包手写的 `src/dsh-runtime.d.ts` 里 `Context` 只声明了 `tools` / `get` / `effect` / `inject`，
 * **没有 `reflect`**；而 `Service` 的构造函数内部就走 `ctx.reflect.provide(name, this, check)`，
 * 生命周期也跟着 fiber（卸载即释放）。直接调 `ctx.reflect.provide` 要么改手写声明，要么改成 `any`，
 * 两者都比继承 `Service` 差。
 */
export class FamilyClaim extends Service {
  constructor(ctx: Context, readonly version: number, readonly packageName: string) {
    super(ctx, FAMILY_CLAIM_SERVICE)
  }
}

/**
 * 尝试占领族位；成功返回占领记录，失败返回 undefined。
 * 必须在 `apply()` 里**最先**调用，早于任何 provide / spawn。
 */
export function claimFamily(
  ctx: Context,
  claim: { version: number; packageName: string },
  log: LogSink,
): FamilyClaim | undefined {
  // ⚠️ 必须用非严格 get（第二个参数 false）：严格 get 在
  // `impl.ctx.fiber.state !== ACTIVE` 时返回 undefined（cordis `_getImpl`），
  // 而另一成员的宿主行可能刚刚 provide 完、状态仍是 LOADING。
  // 用严格 get 会在那一刻误判"没人占领"，随后 provide 直接抛
  // `service "tiaOpennessFamilyMember" has been registered at …`。
  const taken = ctx.get(FAMILY_CLAIM_SERVICE, false) as FamilyClaim | undefined
  if (taken !== undefined) {
    log.error(
      `TIA Portal V${claim.version} (${claim.packageName}) was NOT activated: this composition already has ` +
      `TIA Portal V${taken.version} (${taken.packageName}) active. Only one interface-plugin family member may be ` +
      'active at a time. Disable the other one on the Plugins page and restart the client.',
    )
    return undefined
  }
  // 检查与 provide 之间没有 await，所以在单线程里这一对是原子的。
  return new FamilyClaim(ctx, claim.version, claim.packageName)
}
```

> **两个实现细节，都会被踩到**：
>
> 1. **必须用非严格 `ctx.get(name, false)`**（见上面注释）。本包手写的 `dsh-runtime.d.ts` 现在只声明了
>    `get(name: string): unknown`，实现时要把它扩成 `get(name: string, strict?: boolean): unknown`。
> 2. **`claimFamily()` 必须在第一个 `await` 之前完成**。`apply()` 里只要在"检查 + provide"之间插入任何
>    `await`，两个成员就可能同时通过检查，然后第二个 `provide` 抛错（表现为一行 `failed` 而不是我们要的
>    友好日志）。所以这一对要放在 `apply()` 最顶部，同步完成。

宿主行 `apply()` 变成：

```
claimFamily(...) 成功 ?
  → new TiaOpennessRuntime / EngineeringAccess / ProjectTextAccess
  → registerSkillProvider
  → 起控制器（prewarm）
失败 ?
  → 什么都不提供、什么都不起，只留那条 error 日志，然后 return
```

**四条必须写进实现的行为约束**：

1. **后到者不做任何事**：不 provide `engineeringAccess`（否则第一条硬约束炸）、不 provide runtime、
   不注册 skill provider、不 spawn 控制器。**只打日志**。
2. **后到者不重试**：占领者卸载后，后到者不会自动接管。这是**有意的**——用户切换本就要重启（§7），
   做热接管只会制造"半个组合"。实现里不要加 `ctx.on('internal/service', …)` 之类的重试。
3. **谁先谁后由**组合顺序决定（`dsh.profile.bundles` 的顺序 / patch 的插入顺序），是确定性的但
   未必符合用户意图——所以**必须靠 §8 的 doctor 检查把冲突显式暴露**，不能指望日志被看到。
4. **skill provider 只在占领者那里注册**：两个 provider 名字不同（`…-v17-min` / `…-v18`），
   机械上可以共存，但语义上是两份重叠的 Openness 知识库，会让模型看到重复 skill。所以只注册一份。

> **可选的更严档（现在不做）**：后到者改为 `throw`。好处是"装错"绝不可能静默；坏处是一个配置错误
> 会让**整个宿主启动失败**（而不是"少一组工具"）。本仓的既有取向是"错误数据比缺失数据更贵"，
> 但这里缺失的后果是**模型完全没有 TIA 工具**，而报错日志 + doctor 已经把可观测性补齐了，所以选日志。

---

## 6. 族契约：哪些名字必须跨版本逐字一致

这一节是"可替换"的定义。V18 成员**必须**满足，否则消费侧就要改代码——那就不是"替换"而是"换成另一个东西"了。

### 6.1 服务面（名字固定，方法形状固定）

| 服务 | 生产者 | 消费者 | 必选方法 |
|---|---|---|---|
| `engineeringAccess` | 每个成员 | `dsh-engineering-context` | `readTiaSession` / `openProject` / `saveProjectAs` / `rebuildSource`（另有 5 个**可选**能力方法） |
| `projectTextAccess` | 每个成员 | `dsh-engineering-context` | `exportTexts` / `importTexts` / `readLanguages` / `setLanguages` / `archiveProject` / `saveProject` / `listBlocks`（7 个全必选） |

- 消费者用 `typeof service.xxx !== 'function'` 做能力探测
  （`src/scan.ts:42`、`src/sync.ts:124`、`src/tools/create-project.ts:233/691`、`src/tools/preflight.ts:87`、
 `src/tools/status.ts:317`），
  所以**新增方法一律做成可选的**，删方法则是破坏性变更。
- `engineeringAccess` 上线门槛（`access.ts:445`）：`readTiaSession` / `openProject` / `saveProjectAs` /
  `rebuildSource` 四个不在，整个服务被视为缺席——比"缺一个能力"严重得多。

### 6.2 磁盘工件面（路径与字段固定）

| 工件 | 路径 | schema |
|---|---|---|
| 工程副本 | `<workspace>/tia/…` | — |
| 源树 | `<workspace>/source/<device>/{blocks,types,tag_tables}/…xml` | — |
| 导出清单 | `<workspace>/source/<device>/_manifest.json` | `schemaVersion: 1`，喂图谱引擎与 PLC Blocks 面板 |
| 证据台账 | `<workspace>/source/<device>/_evidence.json` | `schemaVersion: 1`，**严格等于 1**（`evidence.ts:140-144`），消费者拒绝其它值 |
| 源树索引 | `<workspace>/source/_dsh-engineering-context.json` | — |
| 图谱库 | `<workspace>/knowledge/<device>/<device>_knowledge.db` | — |
| 本地状态 | `<workspace>/.dsh/local/**`、`<workspace>/.dsh/*.json` | 侧车 `schemaVersion` 各自单调 |

**硬要求**：同族成员必须**互认** `_manifest.json` 与 `_evidence.json` 的 `schemaVersion: 1`。
V18 若要加字段，只能**新增可选字段**（例如将来的 `tiaObjectId`，见 D7），**不得**升版本号——
一升就意味着"换了 V18 之后旧台账全废"，那与"可替换"直接冲突。

### 6.3 模型与人可见的名字面（固定）

| 名字 | 为什么不能变 |
|---|---|
| 39 个工具名（`open_project` / `export_blocks` / …） | `dsh-tia-todo-bridge` 的 `TRACKED_TOOLS`（`bridge.ts:64`）是**按名字**的白名单；persona 政策文本里写死了 `TIA · <tool_name> · <object>` 的待办格式 |
| 7 个 `/tia-*` 命令名 | TIA 控制台面板的按钮直接 `dispatch('/tia-open')` 等（`dsh-ui-tia-console/src/client/TiaBar.jsx:126/129/132/135/138`） |
| `tia-openness` 路由 skill 名 | 每个工具的描述都统一追加一句 `Troubleshooting: load the bundled `tia-openness` skill …`（`src/tools.ts:1156` 的 `KNOWLEDGE_HINT`）；名字一分裂，这句指向不存在的 skill |
| 服务名 `engineeringAccess` / `projectTextAccess` | §6.1 |
| 子路径 `./tools` / `./commands` | preset 行按 `<包名>/tools` 声明（`profile/…/cordis.patch.yml:487/493`） |

### 6.4 能力集合**不随版本变**

**决定**：V17 与 V18 的**能力集合视为相同**，差异只允许来自 Openness API 版本
（v0.2 那批操作在 V18 成员里应当同样存在）。理由：能力差异一律走"可选方法缺席"表达，
如果 V18 顺便少了几个能力，`expert` preset 的工具面就会随版本漂移，用户会以为"换了版本 = 换了个插件"。

**唯一的例外**：V18 若拿到 V21+ 的 `ObjectIdentifierProvider`（D7），那是**新增可选字段**，
不是能力缺失，属允许范围。

---

## 7. 为什么要重启（写进文档，不要当成缺陷）

**先说清机制能做到什么**，否则这条要求会被当成"实现偷懒"：

- 本发行版蓝图里有 `id: hmr` 行（`disabled: !!js "!ctx.get('profileContext')"`），所以桌面/Web GUI 里
  **HMR 是开着的**。`setBundleEnabled()` 的路径是 `selectBundle()` → `publishAndReload(bundleRows(name).map(r => r.id))`
  → `hmr.reconcileProfile(requiredIds)` → app-boot 的 `recomposeProfile()`；
- HMR 的上游文档写明："受影响的 runtime 会停掉但不把条目标记为停用，`reconcileProfile()` 把它们交给
  app-boot 的单次 `recomposeProfile()`，由它启动，**包括未变化 Include 之下的条目和 profile 组合之外的条目**"。
  也就是说**装一个新 bundle 是能热生效的**（"Installing a new bundle can activate through HMR"）。

**那为什么切换成员仍然要求重启**——三条都是真实理由，不是偷懒：

1. **preset 树的重新挂载没有保证**。TIA 的工具行在 `dsh-agent-preset` 的 `config.plugins` 里，
   它们是**按 agent 挂载时**装配的；`reconcileProfile()` 重启的是 **Loader 条目**，而"已存在的 agent
   会不会因此重挂它的 preset 子树"上游只承诺了 Loader 层面的事，**没有承诺 agent 层面**（§10 第 5 条待测）。
   不开重启就依赖一条没人承诺的行为，赌注是"模型看到 39 个工具但背后没有控制器"。
2. **旧控制器的 disposer 停子进程，但 TIA Portal 本体可能驻留**。不重启容易留下僵尸 Portal，
   下次 `open_project` 会以"已有实例"的形态撞上它；而族切换恰恰是**必然**要换 Portal 版本的时刻。
3. `opennessDir` / `requestTimeoutMs` 这类配置按行读取，重启是最干净的读时机。

所以「切换 = 拨开关 + 重启客户端」是**我们要求用户多做一步**，换来的是"切换后状态一定正确"。
在 UI 文案与 README 里都要这么写；`doctor` 发现"启用的族成员 ≠ 1"时提示"改完需重启客户端"。

> 这条**不排除**将来放宽：如果 §10 第 5 条实测证明 preset 子树会跟着重挂，那么"启用一个本来就装着的
> bundle"可以做到不重启。但在没测之前，文档与 UI 文案都按"要重启"写。

---

## 8. `doctor.ps1` 要加的三条检查

现有 `doctor.ps1` 只看"每个依赖有没有装"（§1 `Plugin packages`）和"每个 bundle 行在不在输出里"
（§"Profile composition"），完全不看"启用了几个族成员"。

| # | 检查 | 判定 |
|---|---|---|
| 1 | **族成员行数** | 解析 `--dump-config`，统计 `# == @voltarenyah/dsh-tia-openness-v*` 的**启用**行。`= 0` → `warn`（"没有 TIA 接口插件可用"）；`= 1` → `ok`；`≥ 2` → **`fail`**，文案指明"只能激活一个，请到插件页关掉多余的并重启" |
| 2 | **TIA 版本探测改为多版本** | 现在的 `$tiaDll` 写死 `Portal V17\PublicAPI\V17`（`doctor.ps1:250`）。改为探测 `Portal V*` 目录，列出找到的所有版本，并与"当前激活的族成员版本"对照：不匹配时 `warn`（"激活的是 V17 但本机只装了 V18"） |
| 3 | **残留控制器进程** | 若激活的是 V18，但 `Get-Process TiaOpennessV17Min.Controller` 还在 → `warn`（"旧版本控制器仍在运行，切换后请重启客户端"） |

第 1 条是**本方案唯一的自动互斥可见性**，必须做；2、3 是体验改善。

---

## 9. V18 落地时要清掉的"版本知识泄漏"

这些是**非版本插件里写死的 V17 事实**。它们不会让 V18 跑不起来，但会让 V18 用户看到错话、被误导确认。
做 V18 时要**同时**改掉，否则"可替换"只是编译期成立。

| # | 位置 | 写死了什么 | V18 下的错误表现 |
|---|---|---|---|
| 1 | `dsh-engineering-context/src/tools/create-project.ts:204-209`（`sourceFileOf`） | `.zap17` 视为"无需升级"，其余 `.zap*` 一律 `needsUpgrade: true` | 传 `.zap18` → 被要求确认"会不可逆升级到 V17" |
| 2 | `dsh-engineering-context/src/tools/create-project.ts:245`、`:1321`、`:1334` | 文案 "TIA rewrites the copy to **V17**" / "upgraded … to V17" | 对 V18 成员说错目标版本 |
| 3 | `dsh-engineering-context/src/tools/create-project.ts:237`、`:695`、`:1091`；`src/sync.ts:127`；`src/scan.ts:25`；`src/tools/preflight.ts:90`；`src/tools/project-translate.ts:295` | 错误信息点名 `@voltarenyah/dsh-tia-openness-v17-min` | 让用户去"升级 V17 包"，而实际装的是 V18 |
| 4 | `dsh-engineering-context/src/tools/create-project.ts:1049-1060`、`:1123` | 工具描述把 `.ap17` / `.zap17` 当固定格式 | 模型对 V18 用户说错扩展名 |
| 5 | `scripts/doctor.ps1:250` | `Portal V17\PublicAPI\V17` | V18 用户被报"Openness 未安装"（见 §8 第 2 条） |
| 6 | `dsh-tia-todo-bridge/src/bridge.ts:64` 起的 `TRACKED_TOOLS` | 工具名白名单 | 只要工具名不变就没事——**但这是一条隐含约定，没人写过**；§6.3 已把它显式化 |

**修法（做 V18 时一并做，属 `dsh-engineering-context` 的改动）**：

给 `engineeringAccess` 加一个**可选**方法，让成员自报身份，消费者不再靠扩展名猜：

```ts
family?(): { product: 'tia'; version: number; projectExt: string; archiveExt: string; upgradeTarget: string }
```

- 缺席（老成员）→ 退化成当前行为，符合既有能力探测惯例；
- `sourceFileOf()` 按 `family().archiveExt` 判定，不再写 `.zap17`；
- 所有 "upgrade to V17" 文案读 `family().upgradeTarget`；
- 所有点名包名的错误改为"the installed TIA interface plugin"或读 `family().packageName`。

**这条改动不阻塞 V18**：可以先出 V18 成员（它自报 `version: 18`），再补消费者侧；
但**必须**在文档里记着它是待办，否则"用户按版本换插件"这件事会在提示文案上暴露成"文档在说谎"。

---

## 10. 本方案**未实证**的部分（做 V18 前先补测）

| # | 待验证的断言 | 为什么重要 | 怎么验 |
|---|---|---|---|
| 1 | 插件页上 preset 内的行确实显示为不可开关（无开关，或标 `unaddressable`） | 整个 §3 的立论。本文是读 `dsh-plugin-manager/lib/index.js` 的 `listPlugins()` 得出的，**没有在插件页上点过一次** | 起 3095 环境，进插件页看 TIA bundle 的 rows 区：`…/tools` 与 `…/commands` 两行应当没有开关 |
| 2 | 关掉 V17 bundle 后 V17 的宿主行真的卸载、控制器子进程真的停 | "bundle 开关 = 整成员进出"的另一半 | 同上，关掉后 `Get-Process TiaOpennessV17Min.Controller` 应当消失 |
| 3 | 空转的工具行不让 preset 变 `invalid` | 不做这条，用户在"V17 关、V18 没装"时会**连会话都开不起来** | 造一个 V17 形状的桩包（宿主行永远不起控制器），只装它的 `/tools` 行，新建会话应成功、且无 TIA 工具 |
| 4 | 后到者占领失败后确实"什么都没提供" | 不做这条，两个都开时会是加载期抛错而不是降级 | 两个宿主行同时 enabled，`--dump-config` 应能出结果，日志里有那条 error，会话可用 |
| 5 | **已挂载的 preset 子树会不会跟着 `reconcileProfile()` 重挂** | 决定 §7 的"必须重启"能不能放宽成"只有换路径才重启"。上游只承诺了 Loader 条目层面，agent 层面没承诺 | 拨一个 bundle 开关（不重启），新建会话看工具面是否随之变化；再在**已有**会话里看是否变化 |
| 6 | `disabled` 为真的宿主行**不会**被 import（读源码已确认，只需实测"已运行的那一行"会不会真的停） | 决定"被关掉的成员"会不会仍在后台持有控制器（若会，§5.2 的空转就不够，还得靠 `claimFamily` 失败兜底） | `cordis-plugin-loader` 的 `entry.refresh()` 是 `if (this.disabled) return;`、`update()` 是 `if (this.disabled) { await this.fiber?.dispose(); return }` —— **"不 import"这一半已由源码确证**；待实测的是"关掉开关后控制器进程真的消失"（与第 2 条同一动作） |

**未实证的原因**：本轮为只读评估，且本会话对
`%USERPROFILE%\dsh-automation-suite-home` 下 profile 目录**没有写权限**（`--dump-config` 以
`EPERM … cordis.yml` 失败），所以第 1–6 条全部只能读实现推断。第 5、6 条是**做 V18 之前必须先补**的两条。

---

## 11. 落地清单（做 V18 时照抄）

**A. V17 包的改造（一次，之后 V18 照抄）**

1. `runtime-service.ts`：加 `member: { version, packageName }`；新增不抛错的 `tiaOpennessRuntimeMaybe()`。
2. `tools-entry.ts` / `commands-entry.ts`：`inject` 去掉 `TIA_RUNTIME_SERVICE`；`apply()` 加"身份不符就空转"分支。
3. 新文件 `family-claim.ts`：`tiaOpennessFamilyMember` 的占领/退让逻辑（§5.3）。
4. `index.ts`：`claimFamily()` 守卫整段 `apply()`；失败路径只打日志并 `return`。
5. `package.json` / 新建 `locale/{en,zh}.json`：显示名 "TIA Portal V17"。
6. 测试：把 `EXPECTED_TOOLS` 的注册路径改成"两段式"（有 runtime 时注册 39 个、无 runtime 时注册 0 个）；
   新增"占领失败 → 不提供 engineeringAccess"的用例。

**B. V18 新包**

7. 从 V17 复制 `packages/dsh-tia-openness-v17-min` → `packages/dsh-tia-openness-v18`；
   按 §4.1 表改名（包名、行 id、程序集、exe、provider 名、`member.version = 18`）。
8. `controller/` 的版本绑定四项：`TiaPortalMajorVersion=18`、`OpennessReferencePackageVersion`（18.0.x）、
   `OpennessResolverPackageVersion`（V21+ 才需要升到 2.x 线）、`AssemblyResolver.DefaultOpennessDir` 指向
   `Portal V18\PublicAPI\V18`；环境变量 `TIA_OPENNESS_V17_DIR` → `TIA_OPENNESS_V18_DIR`。
9. `skills/` 语料按 V18/V21 手册重新生成（`skills/UPSTREAM.json` 的 pinned commit 与本成员对齐）；
   覆盖矩阵**每个成员各一份**（V17 与 V21 的手册条目本来就不同）。
10. **不得**复用 V17 的任何版本常量：TS 侧 `controller.ts:121` 与 `:448` 的环境变量
    `TIA_OPENNESS_V17_MIN_CONTROLLER`（→ `TIA_OPENNESS_V18_CONTROLLER`）、C# 侧
    `AssemblyResolver.DefaultOpennessDir` 与 `:46` 的 `TIA_OPENNESS_V17_DIR`、`TiaPortalMajorVersion=17`、
    `OpennessReferencePackageVersion=17.0.1685432625`、`OpennessResolverPackageVersion=1.1.1725480302`
    （V17 的 Resolver 是 1.x 线；V18 是否换 2.x 线要按 Siemens 发布的对应版本定，别照抄）、
    程序集名 `TiaOpennessV17Min.Controller`、命名空间 `TiaOpennessV17Min.*`（26 个 `.cs`）、
    exe 名 `TiaOpennessV17Min.Controller.exe`。

**C. 蓝图（`profile/dsh-automation-suite/`）**

11. `package.json` 的 `dependencies` 加入 `@voltarenyah/dsh-tia-openness-v18`（装），但
    `dsh.profile.bundles` **暂不**加入（不默认启用）——这样插件页能看到它的卡片、可以一键打开，
    而默认组合仍是 V17。这是本方案对"默认只激活一个"的落地方式。
12. `cordis.patch.yml` 的 **`preset-leader`**（只有它声明了 TIA 行，见 `:486-493`）里，**再加一份** V18 成员的
    `/tools` 与 `/commands` 行：四行同时存在，空转机制保证任何时刻只有一套真正注册。行 id 必须互不相同
    （`leader-tia-tools` 已占用，V18 用 `leader-tia-v18-tools` / `leader-tia-v18-commands`，见 §4.1）。
    `preset-auditor` / `preset-expert` 刻意不给 TIA 原子工具（`:525-527` 的注释说明了原因），**不要顺手加**。
13. 同一文件 `:479-481` 的说明注释要改：它现在写着"`leader-tia-commands` 只 inject `commands` +
    `tiaOpennessRuntime`"，而 §5.1 之后命令行**不再 inject runtime**。注释不同步不会报错，但下一个人会
    照着错的写。
14. `scripts/start-env.ps1` 不需改动（它按蓝图 `bundles` 自动发现 `packages/` 下的本地插件）；
    `scripts/build-distribution.mjs` 也不需改动（同样自动发现）。
15. `scripts/doctor.ps1` 现有那条"按依赖名找 `# == <包名>` 行"的检查（`Profile composition`）
    **不用改**：它遍历 `package.json` 的 dependencies，V18 一旦进 dependencies 就自动被检查到。

**D. 分发与文档**

16. `doctor.ps1` 加 §8 的三条检查（第 1 条必做）。
17. `docs/architecture.md` §1 的族成员表、`docs/roadmap.md` §1/§4、根 `README.md` §2 三处同步。
18. 用户向文档写清：「切换版本 = 插件页拨 bundle 开关 + **重启客户端**；同一时刻只能激活一个」。

---

## 12. 非目标

- **不做**两个版本并存的运行时复用器（一个中立服务按工程分派到两个控制器）。它是唯一能支持
  "同一会话操作 V17 与 V18 工程"的路线，但会把作用域、超时、配置全部变复杂，且违反"一个宿主一个控制器"。
- **不做**V17 包改名（把 `-min` 去掉）。历史 tarball、已装 profile、归档仓库都按现名引用。
- **不做**运行时热切换成员。见 §7。
- **不做**"能力集合随版本变化"。见 §6.4。
