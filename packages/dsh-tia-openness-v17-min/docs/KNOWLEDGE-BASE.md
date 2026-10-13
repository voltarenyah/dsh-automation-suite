# 知识库在哪、为什么不在 `docs/`

上游 Siemens Openness skill 集（31 篇）**没有**复制进 `docs/`，而是作为**随包出货的 skill** 放在
[`skills/`](../skills/README.md)，由 `src/skills.ts` 注册给模型按需加载。这一页解释这个选择的理由，
并把想读原文的人指对地方。

## 为什么不放 `docs/`

| 原因 | 说明 |
|---|---|
| `docs/` 是**第一方声明** | 这里的每一页（协议、输出契约、覆盖矩阵、决策记录）描述的是**本插件在 V17 上实测过的行为**。把上游 V21 时代的文本混进来，两种权威就分不清了 |
| 模型看不到"顺手" | 知识库要被**模型**用上，就得出现在它一定能读到的地方：会话 skill 目录 + 工具描述。`docs/` 里的文件只有被显式打开才有用 |
| 没有渐进披露 | 32 篇原文合计约 335 KB。全读=爆上下文，不读=等于没有；skill 的机制正好是"目录里一行 + 需要时才加载正文" |
| 上游目录结构有意义 | 上游用 `../openness-testing/SKILL.md` 这类相对链接互引；保持 `<name>/SKILL.md` 的结构才能让这些链接继续有效，而这个结构**恰好**就是 DSH skill 的目录约定 |

## 现在长什么样

```
skills/
  tia-openness/SKILL.md    本仓库维护的路由表（症状 → 文件，< 8192 字符，模型可见的那一条）
  <name>/SKILL.md          31 篇上游原文（逐字，MIT，commit b5c7041）
  UPSTREAM.json            上游 commit、逐文件 sha256、许可证、被排除项（生成物）
  LICENSE.siemens.txt      上游 MIT 许可证全文
```

- 模型看到的是 `tia-openness` 这一条；它的 `<skill_resources>` 给出绝对 base directory，
  需要细节时用 `read` 打开 `blocks/SKILL.md` 之类的文件（每次 4–23 KB，可分段读）。
- 每个工具的 description 末尾都有一句指向该 skill 的提示，见 `src/tools.ts` 的 `KNOWLEDGE_HINT`。
- 细节、合规与维护流程见 [`skills/README.md`](../skills/README.md)、
  [`../AGENTS.md`](../AGENTS.md) §2 与 [`../THIRD_PARTY_NOTICES.md`](../THIRD_PARTY_NOTICES.md)。

## 口径（读上游原文前请先记住）

上游面向 **TIA Portal V21**（modular assemblies、SIMATIC SD `.s7dcl`/`.s7res`、LTS 链重启都是 V21 语义），
本插件只做 **V17** 的块级读写。因此：

- 上游文本回答「Openness 能不能做 / 怎么做」，**不**回答「本插件能不能做」；
- 本插件的能力边界以 [`../README.md`](../README.md) §10 与
  [`coverage-matrix.html`](coverage-matrix.html)（生成物）为准；
- 涉及版本专有 API 的段落要按 V17 重新判断，必要时以本机实测为准，并说明这是推断。

## 更新

```powershell
npm run skills:build   # 按 pinned commit 重取上游并重写 skills/（联网）
npm run skills:check   # 离线校验 sha256 / frontmatter / 目录清单 / 依赖图 / 路由 skill 的引用与体积
```

`skills:check` 已并入 `npm run check`。上游文件**不要手改**；唯一可编辑的是
`skills/tia-openness/SKILL.md`。
