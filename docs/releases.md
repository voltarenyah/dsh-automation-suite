# 发布记录与流程

本文件是发行版的**发布台账**：记录了哪些版本发布过、每个版本对应哪个提交，以及下次发布
必须走哪些步骤。版本摘要另见根 [`CHANGELOG.md`](../CHANGELOG.md)。

> **唯一事实来源**：GitHub Releases 与其 git tag（`v<version>`）。本文件与 `CHANGELOG.md`
> 是仓库内的镜像；三者不一致时，以 GitHub Release 的资产与 tag 为准，并立即修正台账。

---

## 1. 已发布版本

| 版本 | 发布日期 | profile 名 | 主要变化 | 内容提交 | 远端 tag 现状 |
|---|---|---|---|---|---|
| **0.1.4** | 2026-10-26 | `dsh-automation-suite-v0.1.4` | 四个内置 preset 默认禁用；选择器只留 3 个 | `de237b8` | ⚠️ `v0.1.4` → `bee7947`（旧一版） |
| **0.1.3** | 2026-10-26 | `dsh-automation-suite-v0.1.3` | 专用 DSH_HOME；`start.cmd` / `install.json`；自动端口 | `bee7947` | ⚠️ `v0.1.3` → `2d83df5`（旧一版） |
| **0.1.2** | 2026-10-26 | `dsh-automation-suite-v0.1.2` | `install.cmd`（MOTW/执行策略） | `9197005` | ⚠️ `v0.1.2` → `d19a904`（旧一版） |
| **0.1.1** | 2026-10-26 | `dsh-automation-suite-v0.1.1` | 版本化 profile；junction 防护；`-Force` 备份；加入 plcsim | `d19a904` | ⚠️ `v0.1.1` → `fe0ed14`（旧一版） |
| **0.1.0** | 2026-10-23 | `dsh-automation-suite` | 首个公开版本；zip + `install.ps1` | `dab47a3` | ✅ `v0.1.0` → `dab47a3` |

> “内容提交”是**真正包含该版本发布内容**的 commit；复现某个版本时用它，不要用当前 tag。

---

## 2. 已知问题：v0.1.1–v0.1.4 的 tag 偏移

### 现象

`v0.1.1` 到 `v0.1.4` 的 tag 都指向**上一个版本的内容提交**：

```
v0.1.4 -> bee7947   （v0.1.3 的内容：start.cmd / 专用 home）
v0.1.3 -> 2d83df5   （v0.1.3 之前的文档提交，没有 start.cmd）
v0.1.2 -> d19a904   （v0.1.1 的内容：版本化 profile）
v0.1.1 -> fe0ed14   （v0.1.x 之前的仓库 HEAD）
v0.1.0 -> dab47a3   ✅ 正确
```

### 原因

发布时先执行了 `gh release create`（tag 落在当时的 HEAD），**之后**才提交该版本的内容。
GitHub Release 的资产是对的（从工作树构建），但 tag 指向的 commit 不含这些改动。

### 验证

```powershell
# v0.1.4 的 tag 里，内置 preset 仍是注释状态（未禁用）
git show v0.1.4:profile/dsh-automation-suite/cordis.patch.yml |
  Select-String 'preset-standard' -Context 0,2
# v0.1.4 的内容提交里是启用状态
git show de237b8:profile/dsh-automation-suite/cordis.patch.yml |
  Select-String 'preset-standard' -Context 0,2
```

### 影响

- `git checkout v0.1.x` 不能复现对应版本的源码；
- 自动更新/溯源若用 tag 会拿错内容。

### 处理（**待确认**）

| 方案 | 做法 | 代价 |
|---|---|---|
| **A. 重指 tag（推荐）** | 把 `v0.1.1`→`d19a904`、`v0.1.2`→`9197005`、`v0.1.3`→`bee7947`、`v0.1.4`→`de237b8`，然后 `git push --force origin <tags>` | 需要 force-push 公开 tag；GitHub Release 的 tag 会显示新 commit，资产不变 |
| B. 保留现状 | 只用本表的“内容提交”列复现 | tag 持续误导；不推荐 |

在方案 A 执行前，**不要**用 tag 复现版本；用上表的“内容提交”。

---

## 3. 版本号规则

- **发行版版本**独立于插件版本与 DSH 版本；用 `X.Y.Z`（可带预发布段）。
- 发布 tag：`v<version>`；**永不复用**已发布过的版本号。
- profile 名：`dsh-automation-suite-v<version>`（0.1.0 例外，当时还没有版本化命名）。
- 专用 home：`%USERPROFILE%\dsh-automation-suite-home`。
- 资产命名：`dsh-automation-suite-<version>.zip`、`<scope>-<name>-<pluginVersion>.tgz`。
- 版本记录三处同步：本文件表格、`CHANGELOG.md`、GitHub Release 标题/tag。

---

## 4. 发布检查清单（下次照做）

### 4.1 准备

1. `git status` 必须干净；`git fetch --tags`。
2. 确认最新版本：
   ```powershell
   gh release list --limit 5
   git tag --sort=-v:refname | Select-Object -First 5
   Select-String -Path CHANGELOG.md -Pattern '^## \['
   ```
3. 选定新版本号（不要复用）。

### 4.2 先提交内容（关键）

4. 更新 `CHANGELOG.md`：把 `[Unreleased]` 改成 `[X.Y.Z] - 日期`，补条目。
5. 新建 `docs/releases/v<version>.md` 作为发布说明（**这是要被 tag 到的内容**）。
6. 提交这两处改动（以及该版本的所有代码改动），确保 `git status` 干净。
   > 顺序必须是“先提交，再打 tag，再发布”。v0.1.1–v0.1.4 的 tag 偏移就是反例。

### 4.3 构建与自测

7. 生成发布目录：
   ```powershell
   node scripts/build-distribution.mjs --version X.Y.Z
   ```
   不带 `--version` 时脚本会使用**最新 tag**，只适合重建旧版本；新版本必须显式传。
8. 检查 `dist/release/X.Y.Z/manifest.json` 的资产/大小/sha256。
9. 本地自测：
   ```powershell
   pwsh -NoProfile -File dist/release/X.Y.Z/install.ps1 -DshHome C:\temp\dsh-test
   # 启动后（或 --no-open）：
   dsh --profile dsh-automation-suite-vX.Y.Z --dump-config
   ```
   确认行数、插件行、preset、专用 home 的 workspace 列表。
10. 打 zip：
    ```powershell
    Compress-Archive -Path dist/release/X.Y.Z/* -DestinationPath dist/dsh-automation-suite-X.Y.Z.zip -Force
    ```

### 4.4 打 tag 与发布

11. 在**内容提交**上打 tag 并推送：
    ```powershell
    git tag -a vX.Y.Z -m "dsh-automation-suite X.Y.Z"
    git push origin vX.Y.Z
    ```
12. 创建 Release（`--verify-tag` 确保 tag 已存在）：
    ```powershell
    gh release create vX.Y.Z --verify-tag `
      --title "dsh-automation-suite X.Y.Z" `
      --notes-file docs/releases/vX.Y.Z.md
    ```
13. 上传资产：
    ```powershell
    gh release upload vX.Y.Z dist/release/X.Y.Z/assets/*.tgz `
      dist/dsh-automation-suite-X.Y.Z.zip dist/release/X.Y.Z/manifest.json
    ```
14. 校验 tag 与内容一致：
    ```powershell
    git rev-parse vX.Y.Z          # 应等于内容提交
    gh release view vX.Y.Z --json assets --jq '.assets[].name'
    ```
    刚上传后 CDN 可能有短暂 404，等 1–2 分钟再校验下载。

### 4.5 收尾

15. 在本文件 §1 的表格中加一行（版本、日期、profile、内容提交、tag 状态）。
16. 提交并推送台账更新。
17. 不要删除旧 Release/资产；需要撤回时发新 patch 版本。

---

## 5. 发布物与存放

| 位置 | 内容 | 是否入库 |
|---|---|---|
| GitHub Releases | zip、插件 tarball、`manifest.json`、`latest.json`（未来） | 云端，唯一事实来源 |
| `dist/` | 本地构建产物、旧版 `RELEASE_NOTES-*.md` | ❌ gitignored |
| `docs/releases/v<version>.md` | 发布说明的仓库副本 | ✅ 从下一版开始 |
| `CHANGELOG.md` | 版本摘要 | ✅ |
| 本文件 | 版本表格、流程、已知问题 | ✅ |

---

## 6. 常见错误

1. **先发布后提交** → tag 指向旧内容（v0.1.1–v0.1.4 的现状）。
2. **忘记 `--version`** → 脚本默认用最新 tag，等于重建旧版；新版本必须显式传。
3. **复用 tag/版本号** → GitHub 资产名不可重复上传，必须用新版本。
4. **忘记更新台账** → 下次不知道发到哪；本文件与 CHANGELOG 必须同一次提交更新。
5. **上传后立刻下载 404** → CDN 传播延迟，不是资产丢失；等 1–2 分钟重试。
