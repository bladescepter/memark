# memark

**mem**ory + **mark**down —— [pi](https://pi.dev) 编码代理的长期记忆扩展。

设计原则：**自动系统只负责发现候选，正式写入必须经用户批准。** 完整设计见
[docs/记忆系统重构完整方案.md](docs/记忆系统重构完整方案.md)。

## 仓库分工

| 仓库 | 内容 |
|---|---|
| `memark`（本仓库） | 扩展代码：recall 工具、curator 流程、/memory 命令、Jev 门卫 |
| `memory`（独立私有仓库） | 记忆数据：五层目录、README 路由协议、INDEX.md、校验脚本 |

## 安装

```bash
git clone git@github.com:bladescepter/memark.git ~/DEV/memark
mkdir -p ~/.pi/agent/extensions
ln -s ~/DEV/memark ~/.pi/agent/extensions/memark
```

或在 `~/.pi/agent/settings.json` 中：

```json
{ "extensions": ["~/DEV/memark"] }
```

记忆仓库路径由环境变量 `MEMARK_REPO` 指定，默认 `~/DEV/memory`。

## 功能

### v0.1（当前）

- `memark_recall` 工具：按任务检索记忆仓库，经 INDEX.md 路由后返回相关记忆正文；仓库未初始化时明确报告并放行，不阻塞任务
- `/memory` 命令：仓库状态（索引条目、五层计数、pending、git 状态）

### 计划

- v0.2 Gate：`agent_settled` → 本地硬规则 + secret scan → Jev 结构化判断（durable / user_grounded / ephemeral / sensitive）→ pending 候选区
- v0.3 curator：候选提炼、去重、diff、用户批准（`ctx.ui.confirm`）后提交 Git
- 基线注入：`before_agent_start` 注入 ≤600 tokens 稳定基线

## 降级

仓库本身是纯 Markdown：扩展不可用时，在全局指令中保留一行说明（记忆位于 `~/DEV/memory`，按其 `README.md` 协议用 `read`/`grep` 直接读取）即可。
