# 试跑指南（三层，默认 profile 全程不动）

目标：从"最安全、零副作用"到"真实项目验收"逐层加深，任何一层失败都能立刻定位到是哪一半的问题
（C# 控制器 / DSH 装载 / TIA 交互），而且**不需要**把插件装进 `desktop`（你的默认 profile）。

| 层 | 验证什么 | 会不会写磁盘 | 需要 TIA 项目 | 需要模型 |
|---|---|---|---|---|
| **0. 控制器直测** | 协议、白名单、dry-run、Openness 探测、参数校验 | 只写 `test-profile/logs`（第 1 层）与临时导出目录 | 否（可选） | 否 |
| **1. 独立 profile 装载/退出** | DSH 真的调用 `apply`、注册工具、持有并回收子进程 | 新建 `~/.dsh/profiles/tia-test`（可整目录删除） | 否 | 否 |
| **2. 真实项目功能验收** | 导出 → 改 → 导入 → 编译，读写后验证 | 导出目录 + 你操作的项目（建议用副本） | **是** | 是（要模型来调工具） |

一次性准备（两个变量，后面命令都用它们）：

```powershell
$dsh = "$env:LOCALAPPDATA\Programs\DeepSeek Harness\resources\runtime\cli\bin\dsh.cmd"
$repo = 'C:\Users\Ansel\dsh-automation-suite\packages\dsh-tia-openness-v17-min'
```

---

## 第 0 层：直接测 C# 控制器（2 分钟，不启动 DSH）

```powershell
pwsh -NoProfile -File $repo\test-profile\test-controller.ps1
```

它做四件事：`--self-test`（14 项，无 TIA）、`--version/--help`、越权操作被拒、
一条 NDJSON 会话（ready 帧 + 参数校验 + `project_not_open`）。**本机实测输出**：

```
1) 控制器自检（--self-test，无需 TIA Portal）
  [OK]   self-test 14/14 通过（协议 1）
       Openness: available=True version=17.0.0.0 resolvedFrom=registry resolver=1.1.0.0
       用户组 'Siemens TIA Openness' 成员: True
2) --version / --help
  [OK]   白名单 25 个操作 = OpenProject, ExportBlocks, ImportBlocks, CompilePlc, CloseProject, CreateProject, …
  [OK]   越权操作 RunScript 被拒绝（unsupported_operation）
3) NDJSON 会话：ready 帧 + 参数校验 + 白名单
  [OK]   r1 越权帧被拒
  [OK]   r2 缺少 output_dir → invalid_params
  [OK]   r3 无项目 → project_not_open（说明解析器已就绪，未触及 TIA）
  [OK]   r4 dry-run 同样先要求打开项目（参数默认值 dry_run=true 生效）
结果: 全部通过
```

带上真实项目（先只读，再加 `-ExportDir ... -Execute` 才真导出）：

```powershell
pwsh -NoProfile -File $repo\test-profile\test-controller.ps1 -ProjectPath D:\Demo\Demo.ap17
pwsh -NoProfile -File $repo\test-profile\test-controller.ps1 -ProjectPath D:\Demo\Demo.ap17 -ExportDir C:\temp\tia-export -Execute
```

这一步**会真的启动 headless TIA Portal**（打开项目），结束时会关掉项目；
如果还有 `TiaPortal.exe` 残留，用 `close_project({save:true, close_portal:true})` 收尾，或手动结束它。

---

## 第 1 层：在独立 profile 里验证装载 / 退出（5 分钟，不碰 desktop）

### 1.1 建一个专用测试 profile + 链接本仓库

```powershell
# 只新建 tia-test（从官方 web 模板派生）；desktop 与 web 都不动
& $dsh --profile tia-test --from-default-profile web --dump-config | Out-Null

# 用 pnpm link 把本仓库作为依赖链接进去（写的是 tia-test 的 package.json + node_modules）
& $dsh plugin --profile tia-test add link:$repo
```

> 说明：本插件的 bundle patch 只声明"插入自己这一行"，而 `--patch` 叠加层正好做同一件事，
> 所以**不需要**改 `package.json` 的 `dsh.profile.bundles`，也不需要动 profile 的 `cordis.patch.yml`。
> `link:` 只建立符号链接，不改动本仓库。

### 1.2 先空跑，确认前置条件都对

```powershell
pwsh -NoProfile -File $repo\test-profile\test-dsh-load.ps1 -PlanOnly
```

期望：`[OK] dsh CLI / 测试 profile / 插件已链接 / overlay / 端口 3080 空闲`。

### 1.3 真正跑装载 + 退出验证

```powershell
pwsh -NoProfile -File $repo\test-profile\test-dsh-load.ps1
```

脚本会：启动**第二个** DSH 实例（独立端口 3080、`--patch` 叠加、`--no-open`，不写任何 profile 文件）→
轮询等 `TiaOpennessV17Min.Controller` 子进程出现 → 结束宿主 → 再等子进程消失，并打印结论。

- **子进程出现** = 插件被真实 DSH 加载、`apply()` 执行、`ctx.effect` 持有子进程（这是验收清单里
  "插件能被 DSH 正确加载"的真实宿主证据）。
- **子进程消失** = 宿主退出后没有残留（控制器读到 stdin EOF 后自行退出）。

也可以手动观察：

```powershell
Get-Process -Name TiaOpennessV17Min.Controller -ErrorAction SilentlyContinue
```

### 1.4 本层**没有**覆盖的一件事（需要你在 UI 里点一下）

`ctx.effect` 的**异步 disposer** 路径（在运行中的实例里禁用/启用插件）需要人在界面上操作：

```powershell
& $dsh --profile tia-test --patch $repo\test-profile\plugin-overlay.yml --port 3080 --no-open
# 浏览器打开 http://127.0.0.1:3080 → 设置 → 插件 → 找到本插件，禁用（观察控制器子进程消失）→ 再启用（重新出现）
```

### 1.5 清理（完全回退本层）

```powershell
Remove-Item -Recurse -Force "$env:USERPROFILE\.dsh\profiles\tia-test"
```

这一条就把本层写过的所有东西删干净；`desktop` / `web` 从未被改动。

---

## 第 2 层：真实项目功能验收（导出 → 改 → 导入 → 编译）

按 [`../docs/FUNCTIONAL-TEST.md`](../docs/FUNCTIONAL-TEST.md) 逐步做（含每一步的期望值与结果记录表）。
用第 1 层的实例即可，但要让**模型**来调工具，需要给测试 profile 配一个模型。桌面端的两行配置可以
直接搬过来（其中只有 provider 名与模型名，没有密钥；密钥由 `~/.dsh/.credentials.yaml` + 环境变量提供，
与 profile 无关）：

```powershell
# 看一眼 desktop 用的 provider / 默认模型
Select-String -Path "$env:USERPROFILE\.dsh\profiles\desktop\cordis.patch.yml" -Pattern 'opencode-go|agent-default-model' -Context 2,6
```

把那段 `insert: - id: opencode-go ...` 与 `- id: agent-default-model ...` 追加到
`~/.dsh/profiles/tia-test/cordis.patch.yml`，重启该实例后模型即可用。**这一步是本层唯一的"写 profile"动作，
而且写的是测试 profile。**

### 第 2 层里最该盯的两个点

1. **白名单（Openness 防火墙）**：V17 手册（SIOS 109798533）有"白名单条目"章节，而本插件还没有调用
   官方解析器自带的 `IsAppWhitelisted()` / `WhitelistApp()`。如果第一次 `open_project` 被拒绝、
   或弹出需要人点击的对话框 → 就是这一类。排查步骤见
   [`../docs/FUNCTIONAL-TEST.md`](../docs/FUNCTIONAL-TEST.md) 的排障表。
2. **官方解析器的首次真实加载**：第 0/1 层只能证明解析器**初始化成功并选中了正确路径**；
   真正加载 `Siemens.Engineering` 并连上 TIA 就发生在这一步。若这里出问题，
   `git checkout main` 换回自研解析器的版本（工具行为完全相同）即可做 A/B 对照。

把结论填回 [`../docs/verification.md`](../docs/verification.md) §C（§B.1 / §B.4 是这两项的具体步骤）。

---

## 验收通过之后：怎么正式装进 desktop（现在先不做）

任选其一（都会改 desktop，所以等你确认之后再做）：

```powershell
# A) 交给插件管理器（Web 侧边栏 Plugins 页，或 Creator 模式下的 plugin_manager 工具）
#    plugin_manager(action: "install_bundle", target: "<repo 路径>")

# B) 手工两条命令
& $dsh plugin --profile desktop add link:$repo        # 链接依赖
# 再把 test-profile/plugin-overlay.yml 里的 insert 段追加到
# ~/.dsh/profiles/desktop/cordis.patch.yml，然后重启 DSH
```

卸载同样干净：`dsh plugin --profile desktop remove @voltarenyah/dsh-tia-openness-v17-min` + 删掉那段 patch。

---

## 我验证过 / 没验证过（诚实清单）

| 项 | 状态 |
|---|---|
| `test-controller.ps1` 全流程 | ✅ 本机实跑通过（输出见上） |
| `test-dsh-load.ps1 -PlanOnly` 前置检查 | ✅ 本机实跑通过（正确报出缺 profile / 缺 link） |
| `--patch` 叠加层被接受、顺序正确（插在最后）、不写 profile | ✅ 用 `--dump-config` 验证：exit 0，组合树末尾出现 `id: tia-openness-v17-min` |
| `dsh web --help` 不监听端口、`--port` / `--no-open` 可用 | ✅ 实测（无新增监听端口） |
| `dsh plugin --profile X add ...` 是 pnpm 直通 | ✅ 实测（打印 pnpm 帮助；0.2.0-rc.2 上是 11.7.0，0.2.1-rc.2 上是 11.28.5） |
| **`--from-default-profile` + `--dump-config` 是否"创建后立即退出"** | ⚠️ **未验证**（我没有创建你的 profile）。若它直接启动了服务，`Ctrl+C` 即可，profile 已建好；再用 `-PlanOnly` 复核 |
| **第二个 DSH 实例与桌面端共用 `~/.dsh` 是否完全无冲突** | ⚠️ 未验证（不同端口、不写 profile；理论上安全）。若日志出现存储/会话告警，关掉它，改走"先装 desktop 再验收"的路线 |
| **HMR disposer 路径** | ⚠️ 需要你在 UI 里禁用/启用插件（§1.4） |
| 真实项目的导出/导入/编译与白名单 | ⚠️ 需要你按 §2 执行 |
