# @voltarenyah/dsh-tia-todo-bridge

输入框上方的 Todo 列表在 TIA 操作期间**一直有内容、状态会自己结束**的兜底插件。

## 它解决什么

模型不是每次都会先写一份 `todo_write` 计划；写了之后，也可能在工具返回后忘记把对应项改成
`completed`。于是用户看到两种坏状态：

- 干活过程中上方根本没有 Todo 面板；
- 面板出现了，活已经干完了，某一项还在转。

本插件监听工具执行流水线和会话事件，做一个**不抢模型所有权**的兜底：

| 场景 | 行为 |
|---|---|
| 模型自己用 `todo_write` 写了清单 | **完全不改**；清单归模型 |
| 模型清单里对应项在操作返回时还没 `completed` | 追加一条 model-visible 的 settlement notice（`source.kind = 'tia-todo-bridge'`），要求**立即**用 `todo_write` 更新；仍然不改清单 |
| 本轮第一次 TIA 操作开始时还没有清单 | 追加 `TIA · <tool> · <object>`，状态 `in_progress` |
| 该操作返回 | 把插件自己创建的那一项改成 `completed` |
| 该操作失败 | 内容加 `（失败）` 后缀，仍改成 `completed`，避免死转 |
| 同一轮还有第二个 TIA 操作 | 再追加一项，各自在返回时结束 |
| 模型中途写了清单 | 后续不再改；插件只保留“模型清单”的所有权 |

“本轮”的边界与 DSH 的 `todos` 投影一致：`turn/start` 清空，`turn/end` 保留刚完成的清单。
因此新用户消息到来时旧清单会消失，这是宿主既有行为，插件不改变它。

## 覆盖范围

**同步的 TIA 操作**（`packages/dsh-ui-tia-console/src/client/model.js` 的 `TIA_TOOL_NAMES` 是
同一族的参照）以及**版本工作流里耗时或改状态的工具**：

```
open_project / create_project / save_project / archive_project / close_project
export_blocks / import_blocks / compile_plc
update_project / create_plc_objects / delete_plc_objects / write_tags
set_block_attributes / protect_blocks / generate_source / watch_and_force_tables
show_blocks_in_editor / download / online_connect / online_disconnect
export_hardware_config / adopt_open_project
create_engineering_project / project_sync / project_diff / project_commit
project_translate / project_version_reindex / project_version_verify / project_doc_index
knowledge_ingest / knowledge_update
```

**不覆盖**纯查询（`project_info`、`list_plc_objects`、`controller_status`、`knowledge_query` …）：
一秒内完成的读取不需要占一行待办，它们的实时状态归 TIA 控制台。
**不覆盖** `subagent`：它启动子 agent 后立即返回，真正的分钟级工作在 auditor 子会话里；
leader 的清单由 persona 规定“派发时标 in_progress、auditor 结果到达才 completed”，
插件无法从 leader 会话可靠地知道子 agent 何时结束，所以不猜。

## 安装

```yaml
# profile 的 bundles 里加一行；bundle 自带的 cordis.patch.yml 会插入自己的 Loader 行
- '@voltarenyah/dsh-tia-todo-bridge'
```

插件不注册工具、不注册服务，**宿主面一行即可**，所有 agent 共享同一套监听；没有 `todos`
投影的会话（如 `expert`）上不会产生可见面板，事件写入也无副作用。

## 结构

```
src/bridge.ts   纯状态机：所有权、任务命名、开始/结束计划、日志重建（可单测）
src/index.ts    cordis 接线：session/event、tools/execute、tools/post-execute
test/           纯状态机 + 假 ctx 的接线测试
```

## 与 persona 的分工

- 插件保证“**没有清单时也有**、插件自己创建的项会结束”；
- `profile/dsh-automation-suite/cordis.patch.yml` 的 leader / auditor persona 规定
  “**有清单时**怎么命名、什么时候标 in_progress、什么时候标 completed、派发任务何时结束”。

两层合起来才是完整的：插件不替模型做计划，模型也不能把状态停在半空。

## 验收

```powershell
node node_modules/typescript/bin/tsc -p packages/dsh-tia-todo-bridge
node --test --test-reporter=spec "packages/dsh-tia-todo-bridge/test/*.test.mjs"
```

真机验收：启动 suite 环境，做一次 `open_project`（模型不写清单也应出现一行
`TIA · open_project · <工程名>`，返回后变已完成），再让模型写一份自己的清单并做一个
`export_blocks`，确认模型清单不被插件改写。
