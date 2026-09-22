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

**Linux/macOS/VPS（开发推荐）**：clone 后 symlink，改代码即生效（重启 pi 或 `/reload`）：

```bash
git clone git@github.com:bladescepter/memark.git ~/DEV/memark
mkdir -p ~/.pi/agent/extensions
ln -s ~/DEV/memark ~/.pi/agent/extensions/memark
```

**Windows**：clone 后在 `~/.pi/agent/settings.json` 中指向（无需管理员权限）：

```json
{ "extensions": ["C:/Users/blade/DEV/memark"] }
```

**任意机器（包安装）**：仓库公开，`pi install git:github.com/bladescepter/memark`，升级用 `pi update memark`。

记忆仓库路径由环境变量 `MEMARK_REPO` 指定，默认 `~/DEV/memory`（各机需先 clone）；项目区按当前目录名匹配 `projects/<项目名>/`，可用 `MEMARK_PROJECT` 显式指定。

## 功能

### v0.3（当前）

- `memark_recall` 工具：相关性排序检索（标题>描述>tags 加权），默认范围 = 个人区 + 当前项目区
- `memark_remember` 工具（curator，P3）：草案 → 仓库校验（schema/secret/去重/索引）→ 展示草案请用户确认 → 一条一 commit 并推送；无 UI 模式自动降级为只写 `pending/`
- `/memory` 命令族：`status`（默认）/ `review` / `approve <id>` / `reject <id>` / `forget <path>`（归档）/ `revert`（回滚最近一次未回滚的记忆写入）
- `supersedes` 取代流程：新条目写入同时原条目标记 `superseded`，同 commit
- 回归测试：`sh tests/run.sh`（隔离 git 环境全流程测试）

### 历史

- v0.2：单仓双区协议 + recall 项目区支持
- v0.1：recall 工具 + `/memory` 状态

### 计划

- v0.4 Gate：`agent_settled` → 本地硬规则 + secret scan → Jev 结构化判断（durable / user_grounded / ephemeral / sensitive）→ pending 候选区
- 基线注入：`before_agent_start` 注入 ≤600 tokens 稳定基线

## 降级

仓库本身是纯 Markdown：扩展不可用时，在全局指令中保留一行说明（记忆位于 `~/DEV/memory`，按其 `README.md` 协议用 `read`/`grep` 直接读取）即可。
