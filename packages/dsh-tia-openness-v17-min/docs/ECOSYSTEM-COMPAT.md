# 生态兼容性验收（L0–L3）实测记录

对象：`dsh-tia-openness-v17-min@0.1.0`（本仓库）。
环境：Windows、TIA Portal V17 Update 7、DSH `0.2.0-rc.2`（桌面端 0.2.0-rc.2）。
原则：**不修改默认 profile 的语义、可回滚**；隔离部分用独立 `DSH_HOME`。

> 文末 §5 记录了本轮**我造成的两处破坏及其修复**，以及当前仍需用户处理的一项环境问题。请一并阅读。

---

## 1. 分层结果

| 层 | 验什么 | 结果 |
|---|---|---|
| **L0 静态组合** | bundle patch 语法、插件行插入、Config 进组合 schema | ✅ `--dump-config` 带 `--patch` 时插入本插件行；`--dump-config-schema` 输出的 29,188 行 schema 中含 `opennessDir`、`requestTimeoutMs`、`const:"dsh-tia-openness-v17-min"`、`const:"tia-openness-v17-min"` |
| **L1 隔离 home 真宿主** | `apply` 被真实 loader 调用；`ctx.effect` 持有子进程；宿主退出不留残 | ✅ 宿主在 3080 起来；控制器子进程出现（**恰好 1 个**，无重复挂载）；宿主结束 → 子进程退出；`~/.dsh` 未被触碰 |
| **L1b UI 级复核** | 插件页/工具可见、**禁用→启用**触发 disposer | ✅ 插件页显示 `dsh-tia-openness-v17-min v0.1.0` + 描述 + Uninstall + 总开关；Components `1 total · 1 running`；**关闭开关 → 控制器 pid 15404 消失；重新启用 → 新 pid 43936**（`ctx.effect` 异步 disposer 实证） |
| **L2 隔离 home 真 agent** | 模型能否发现并正确调用工具、错误语义、与自带工具共存 | ✅ 见 §2；控制器从隔离 home 的 `node_modules` 内运行成功 |
| **L3 desktop profile** | 装进真实 profile、活宿主可见性、卸载后是否回基线 | ✅ 见 §3；卸载后 5 个 profile 文件与快照**逐字节一致** |
| **L4 分发形态** | `npm pack` 产物是否自洽（`link:` 会掩盖打包问题） | ✅ 596 KB / 34 文件，含 `lib/index.js`、`cordis.patch.yml`、`controller/bin/*.exe`；从 tarball 安装后宿主正常起、控制器从该目录运行 |

## 2. L2 的真 agent 运行（headless，一次任务）

命令形态：`DSH_HOME=<隔离> dsh --profile tia-headless --json "<任务>"`（profile 由 `--from-default-profile headless` 建立；插件用 tarball 安装；凭据文件复制进隔离 home）。
结果：**退出码 0，11.7 s，20 个事件**（3 thinking / 3 tool_call / 3 tool_result / 1 final）。agent 的表现：

* **自主列出全部 6 个工具**并给出准确用途（说明工具描述足够模型推导）；
* 调用 `controller_status` → `ready`，控制器 exe 路径指向**隔离 home 的 node_modules**，Openness `1700.7.501.6` 可用，用户组 `Siemens TIA Openness` 成员 = 是；
* 调用 `export_blocks`（当时传了 `dry_run`）且未打开项目 → 得到结构化错误 **`project_not_open`**，模型正确识别"这是项目未打开，而不是目录无效"，并**并行调用宿主自带的 `pwsh` 工具**做 `Test-Path` 独立验证（生态内工具共存 ✓）；
* 最终答复给出 4 行中文总结，明确"全程未打开项目、未做任何写操作"。

## 3. L3 desktop profile（可回滚）

1. 快照 `package.json` / `cordis.yml` / `cordis.patch.yml` / `pnpm-lock.yaml` / `pnpm-workspace.yaml` 并记录 SHA-256；
2. `dsh plugin --profile desktop add link:<repo>` → `dependencies` 与 **`dsh.profile.bundles` 自动追加**本包；
3. **活宿主立刻可见**：`plugin_manager list_bundles` 返回 `{"name":"dsh-tia-openness-v17-min","version":"0.1.0","enabled":true,"installed":true,"removable":true, rows:[tia-openness-v17-min]}`；
4. **但不热挂载**：宿主 Config 检查器里该条目状态为 **`inactive`**，且**没有** prewarm 控制器子进程 → 说明"CLI 安装 → 清单可见，挂载需重启宿主（或由管理器动作触发）"。因此**正在使用的会话没有被扰动**；
5. `dsh plugin --profile desktop remove` → 5 个 profile 文件**逐字节回到快照**。

## 4. 结论：对使用者有影响的 4 条发现

1. **装完即 bundle，无需手写 overlay**：`dsh plugin --profile X add <包或 tgz>` 会把包自动写进 `dsh.profile.bundles`，宿主按包内 `dsh.bundle.patch` 挂载。本仓库 `test-profile/plugin-overlay.yml` 在 bundle 已登记后会造成**同一 id 的重复条目**（实测未导致重复挂载，仍建议只保留一种方式）。
2. **`remove` 会留下 `node_modules` 里的 Junction**：`link:` 安装卸载后 junction 残留，导致随后改用 tarball 安装时报 `EPERM … rename …_tmp_ → <pkg>`。清理方式见 §5 注 1。
3. **CLI 安装不会热挂载到运行中的宿主**（见 §3.4）。想在界面里立刻用，需要重启宿主或用插件管理器的启用动作。
4. **隔离实例的两个前置条件**：web 端需要启动器打印的 `?token=`（否则 401）；隔离 home 里没有 `~/.dsh/.credentials.yaml` 时 GUI 会要求 API key、headless 会无法鉴权。

## 5. 本轮造成的问题、已做的修复与待办

### 5.1 `.git` 元数据被误删（已修复）

**原因**：我用 `[System.IO.Directory]::Delete(<desktop profile>\node_modules\dsh-tia-openness-v17-min, $false)` 清理 pnpm 残留的 junction；.NET 对 junction 的删除**跟进了链接目标**（本仓库），删掉了 `.git` 下的元数据文件与 `node_modules`。

**损失与修复**：`.git/objects`（310 项）与 `.git/refs`（main、feat/siemens-nuget）**完好**，因此历史完整。我重建了 `.git/HEAD`（`ref: refs/heads/feat/siemens-nuget`）与 `.git/config`，并用 `git reset` 重建索引。验证：`git log` 连续 9 个提交、`git fsck` 退出码 0、`git status --short` **为空**（工作树与 HEAD 完全一致，0 删除 / 0 修改 / 0 未跟踪）。
**永久损失**：`.git/logs`（reflog）、`ORIG_HEAD`、`hooks/` 样例、`info/exclude` —— 均非必需（`ORIG_HEAD` 仅影响 `git reset --hard ORIG_HEAD` 这类回退）。
**注意**：清理 junction 请用 `cmd /c rmdir "<junction>"`（只删链接）或 `Remove-Item -Force`（不加 `-Recurse`），**不要**用 `Directory.Delete`。

### 5.2 仓库开发用运行时链接失效（待处理，不影响插件本身）

**原因**：我执行 `npm install`（为恢复被 5.1 删除的 `node_modules`）时，npm 的缓存回收删除了 `profiles/node_modules/@deepseek-ai/*` 所指向的 `_npx` 缓存内容，同时 npm 裁剪掉了仓库里原有的 `node_modules/@deepseek-ai/{dsh-tools,cordis}` junction。这两处都指向 npm `_npx` 缓存（现为空壳），因此 `scripts/link-dsh-runtime.mjs` 找不到源。
（说明：CLI 本身不走 npx —— `dsh.cmd` 用 Electron 以 Node 方式运行 `app.asar` 内的 CLI，因此**命令行与桌面端都正常**；受影响的只有本仓库跑单测时需要的那三个包。）

**当前状态**：`npm run build` ✅、`npm run matrix:check` ✅（391 能力条目 current）、控制器 exe 可运行 ✅、`schemastery` 已重新链接 ✅；`npm test` 的 **5 个测试文件全部无法启动**（都 `import '@deepseek-ai/dsh-tools'`）。

**恢复办法（任选）**：
* **A（忠实版本）** 从 `app.asar` 解包运行时包到稳定暂存目录，再 junction 到仓库：
  用 Electron 以 Node 方式跑一段拷贝脚本（`ELECTRON_RUN_AS_NODE=1 "<安装目录>\DeepSeek Harness.exe" -e "…fs.cpSync(asar路径, 目标, {recursive:true})"`），
  建议整段 `@deepseek-ai` 作用域一起解包，保证被解包包的自身依赖也能解析。
* **B（最省事）** 安装注册表上的发布版：`npm install -D @deepseek-ai/dsh-tools@0.0.1-rc.1 @deepseek-ai/cordis@4.0.4`（注意与运行时 `0.2.0-rc.2` 存在版本偏移，可能出现假失败）。
* **C** 让 `link:runtime` 支持一个显式来源（环境变量或 `--from <目录>`），并把 A 的结果作为长期来源；这样 `npm install` 之后也能一键复原。

### 5.3 `--self-test` 当前失败（环境问题，非代码）

现象：`self_test_harness` 失败，`checkCount=1`：
`UnauthorizedAccessException: Access to the path '<TEMP>\tia-openness-selftest-<guid>' is denied.`
（该异常来自 `SelfTest.Run` 开头的 `Directory.CreateDirectory(workDirectory)`。）

已排除：`%TEMP%` 存在且可写（pwsh `New-Item` 与 .NET `Directory.CreateDirectory` 都成功）；换成 ACL 干净目录（仅当前用户 FullControl）、再追加 `Everyone:(OI)(CI)F` 均**仍失败**；进程属主确认为 `DESKTOP-13PL8TF\Ansel`（Medium 完整性，无沙箱 SID）。**同一二进制今天早些时候在同一会话返回 14/14**。
→ 判断为**会话/环境层面的写限制**（未定位到具体机制；候选：安全产品对新建未签名 exe 的写入拦截）。
**建议**：在**普通（非本会话沙箱）终端**里 `cd <repo>\controller\bin && TiaOpennessV17Min.Controller.exe --self-test` 复跑确认；若同样失败再排查安全软件。控制器与插件功能本身不受影响：本轮 L1/L2 里控制器均由真实宿主成功启动并服务请求。

## 6. 复现命令

```powershell
# L0
$env:DSH_HOME='C:\tia-openness-test\dsh-home'
dsh --profile tia-test --patch <repo>\test-profile\plugin-overlay.yml --dump-config
dsh --profile tia-test --dump-config-schema | Select-String 'opennessDir|tia-openness-v17-min'
# L1（脚本会等控制器出现、结束后核对残留）
pwsh -NoProfile -File <repo>\test-profile\test-dsh-load.ps1 -Profile tia-test -Port 3080
# L4
npm pack ; dsh plugin --profile tia-test add <repo>\dsh-tia-openness-v17-min-0.1.0.tgz
# L2（需要把 ~/.dsh/.credentials.yaml 复制进隔离 home）
dsh --profile tia-headless --json "列出 TIA/PLC 相关工具；调用 controller_status；对不存在的目录 export_blocks dry_run"
```

> ⚠️ **这份记录写在 v0.1（6 个工具）时期**：上面两处出现的 `dry_run` 现在对 `export_blocks` 已不存在
> （决策 D22）。**注意未知参数是静默忽略的**（`defineTool` 编译出的 schema 不禁止多余属性），
> 所以照抄第 4 节的命令不会再报参数错误 —— 它只是不再有"预演"效果。该场景本身仍然安全
> （未打开项目 → `project_not_open` 在任何写入之前发生），但不要在别的场景里沿用这个写法。
