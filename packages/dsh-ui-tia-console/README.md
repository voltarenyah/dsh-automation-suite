# dsh-ui-tia-console

输入框上方的 **TIA 控制台**：显示 TIA Portal 的实时状态、长时间操作的已用时长，并直接提供
打开 / 保存 / 编译 / 关闭 与刷新。

它是 `dsh-automation-suite` 发行版的一个 UI 插件，和 `dsh-ui-plc-source` 同构：一个空的宿主行
（只为让浏览器半侧有包可挂）+ 一个 `conversation.input.dock` 占位组件。

## 它解决什么

DSH 的斜线指令结果是一个**时间线节点**，而新建会话显示的是 Hero 空状态、不是时间线；命令又
不产生 turn，所以空会话里 `/tia-open` 跑完没有任何可见反馈。控制台把状态和入口放到**输入框上方**，
空会话可见，并且不产生模型消息。

| 状态 | 显示 |
|---|---|
| 未检测 | `TIA 状态未检测`（点刷新校准） |
| 无项目 | `TIA 无项目` |
| 正在打开/保存/编译/关闭 | `正在打开… 1:42`（每秒刷新已用时长） |
| 已打开 | `TIA 已打开 · <项目名>` + 已编译徽章 |
| 失败 | 状态点变黄/红，展开看错误码与原因 |
| 控制器缺失 | `TIA 不可用` |

按钮：**打开 / 保存 / 编译 / 关闭 / 刷新**。打开使用当前会话的工作区工程（与 `/tia-open` 完全同一份
逻辑），因此不需要在 UI 里选路径。

## 状态从哪来

只读**本会话的事件窗口**（`ctx.sessions.binding(sessionId).eventSource`），折叠：

- `command/run` → `command/done`：斜线指令与按钮（按钮就是 dispatch 现有的 `/tia-*`）；
- `tool/call` → `tool/result`：模型调用的 `open_project` / `close_project` / `compile_plc` 等；
- 项目名/路径从渲染文本的 `Project: <name> (<path>)` 读取，编译结果从 `Compile state: …` 读取。

所以三种触发源（模型、指令、按钮）都会实时反映，**不需要宿主服务、不需要轮询控制器**。

## 已知边界（Step 1）

- **按会话**：状态来自本会话的操作记录。在另一个会话打开工程时，本会话不会自动知道；
  点**刷新**（dispatch `/tia-info`）即可与控制器对齐。
- **外部关闭不实时**：在 TIA 窗口里手动关掉工程/进程后，状态点会短暂说谎，直到点刷新。
- 刷新本身是一条 `/tia-info` 指令，会在会话里留下一条 command 记录（可审计，不是模型消息）。
- Step 2 会把这些收进一个宿主 `tiaStatus` 服务：全局一致、初始快照、队列与外部关闭检测。

## 安装

```yaml
# profile 的 bundles 里加一行；bundle 自带的 cordis.patch.yml 会插入自己的 Loader 行
- dsh-ui-tia-console
```

开发：

```powershell
npm run build   # tsc 宿主空壳 + esbuild 浏览器 bundle
npm test        # 纯事件折叠 + 字典校验
```

## 结构

```
src/index.ts            宿主空壳（Loader 行需要它）
src/client/index.jsx    注册 conversation.input.dock 占位
src/client/TiaBar.jsx   控制台组件（状态、按钮、展开详情、秒表）
src/client/model.js     纯事件折叠（可单测，不依赖 React）
src/client/locales.js   zh/en 字典
src/client/style.js     主题令牌样式
scripts/build.mjs       tsc + esbuild（平台模块保持 external）
```
