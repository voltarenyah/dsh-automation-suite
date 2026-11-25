# AGENTS.md — @automation-suite/version-control

本文件是给在本目录工作的 agent 的项目级约定。仓库级约定见根 `AGENTS.md`；
用户级见 `~/.dsh/AGENTS.md`；拆包的来龙去脉见 `docs/decisions.md` D41/D42 与
`docs/version-control-plan.md`。

---

## 1. 这个包管什么

**工程历史**：把 `source/<device>` 记成带 `Tia-*` trailer 的 git 提交，并在
`<workspace>/.dsh/versions.db` 里建可查询的索引（事件 / 图 / 块时间线）。

三条硬边界，改代码前先读：

1. **不碰 TIA**。只读 `source/`、`source/_dsh-engineering-context.json`、
   `source/<device>/_evidence.json` 这些**已经落盘的事实**。设备解析用
   `src/device.ts` 的 `resolveDeviceFromDisk`。需要 TIA 的能力属于接口插件。
2. **不决定 layout**。`stateDirName` / `sourceDirName` 默认 `.dsh` / `source`；
   service 调用里由**调用方**传（见 `src/service.ts`），工具用本包 config。
   profile 若改了目录名，两个插件必须一起改。
3. **git 写操作只经 `gitContext`**（`@automation-suite/dsh-tool-git` 的宿主行）。
   当前 `src/git.ts` 是从 `engineering-context` 拷来的同一套实现（D42 记为技术债）；
   新增 git 调用**不要**再往它里面加，优先用 `gitContext` 的 `run` / `status` / `commit`。

## 2. 行与服务（D23：工具面就是权限边界）

- **宿主行**（`.`, `src/index.ts`）：**不注册任何模型工具**，只 `ctx.provide('versionControl', …)`。
  违反这条的工具会被每个 agent（包括子 agent）继承。
- `/record`（`record-entry.ts`）：`project_commit` / reindex / annotate / doc_index —— 只给 auditor。
- `/read`（`read-entry.ts`）：history / verify / doc_search / problem / query —— 只读，三个 preset 都有。
- `/diff`（`diff-entry.ts`）：`project_diff` —— auditor + expert。
- **读与写必须分在不同行**。合并工具可以，合并权限不行。

`versionControl` 只有两个方法（`planBaseline` / `recordBaseline`），签名在 `src/service.ts`。
`planBaseline` 是**预检**：`engineering-context` 在 dry run 阶段就要拿到"这里能不能提交"的答案。

## 3. 几条会静默出错的约定

- **`repo.json` 的 `createdBy` 必须保持 `engineering-context`**（`src/git-context.ts`）。
  它是磁盘上的**工作流身份**，不是包名；改成 `version-control` 会让拆分前创建的每个工作区被当成
  "别人的仓库"而拒绝提交。要改名得写迁移。
- **写路径必须回写投影**：`recordCommitAfterWrite`、`reindexVersionStore`、`annotate`、`doc_index`
  之后都要让 `.dsh/versions-view.json` 是新的（`writeVersionView`）。曾经漏了 replay 分支，
  Versions 页在导入后是空的（test/16 钉住这一条）。
- **service 的路径一律绝对**。传相对路径时 `gitPath()` 会指到仓库外，回放会静默跳过（`report.skipped`）。
- **账本是派生的**：删掉 `.dsh/versions.db` 不丢数据，`project_version_reindex` 从 git 重建。
  `.dsh/versions-view.json` 只是显示用，没有任何工具读它。
- **工具名不要随手改**：`tia-todo-bridge` 硬编码了 32 个工具名，`ui-prompt-guide` 的文案里也点到了它们。

## 4. 开发

```powershell
node scripts/link-dsh-runtime.mjs   # 裸 checkout 首次（只读 <DSH_HOME>/plugin-runtime）
node scripts/tsc.mjs -p tsconfig.json --noEmit
node scripts/run-tests.mjs          # 先构建，再 node:test
```

- `lib/` 不提交（`.gitignore`）；`run-tests.mjs` 会先构建。
- 测试用**真实 git 仓库**（`test/16` 的 `realGitService` 适配器）驱动服务层；
  工具层用 `test/helpers/harness.mjs` 的假 ctx。
- 依赖：`fast-xml-parser`（结构差异）。`node:sqlite` 是内置模块，进不了 package.json。
- 与 `engineering-context` 的共享代码是**拷贝**（`paths` / `errors` / `evidence` / `lock` /
  `scope` / `workspace` / `tools/{deps,outcome}`）。改其中一个时，**另一份也要改**——
  这是 D10"不抽共享包"的直接代价，别以为它们会自动同步。

## 5. 危险操作

- ❌ 不要用会跟进 junction 的递归删除清 `node_modules`（里面的 `@deepseek-ai/*` 指向
  `<DSH_HOME>/plugin-runtime`）。拆链接只用 `cmd /c rmdir "<路径>"` 或 `Remove-Item -Force`。
- ✅ 重新链接：`node scripts/link-dsh-runtime.mjs --force`（遇链接只 unlink，不下降）。
