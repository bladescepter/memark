# AGENTS.md — memark

## 项目定位

memark = **mem**ory + **m**arkdown，pi 编码代理的长期记忆扩展。

设计原则（不可违背）：**自动系统只负责发现候选，正式写入必须经用户批准。**

完整设计文档：[docs/记忆系统重构完整方案.md](docs/记忆系统重构完整方案.md)（16 节，唯一权威，本文件只做索引不复制其内容）。命名备注：memd 已被 pi 生态同名扩展占用，故取名 memark。

## 双仓库结构

| 仓库 | 内容 | 状态 |
|---|---|---|
| `memark`（本仓库） | 扩展代码：recall 工具、curator 流程、/memory 命令、Jev 门卫 | v0.1 已推送 |
| `memory`（独立私有仓库） | 记忆数据：五层目录、README 路由协议、INDEX.md、scripts/ | **尚未创建**，默认路径 `~/DEV/memory`（`$MEMARK_REPO` 可覆盖） |

分工原则：**协议和校验跟数据走**——校验脚本放 memory 仓库（无扩展也能自检），本仓库只承载 pi 集成逻辑。

## 当前状态（截至 2026-09-21）

- v0.1（commit `2a6b46b`）：`memark_recall` 工具（INDEX.md 路由 → 读取正文，含路径逃逸防护与截断）+ `/memory` 命令（分层计数、pending、git 状态）；Gate（v0.2）在 index.ts 中留有明确未启用注记
- 2026-09-22 P3 完成并发布 v0.3.0：多文件重构（repo.ts / curator.ts / index.ts）；`memark_remember` curator 工具（草案→仓库校验→ctx.ui.confirm→一条一 commit→push，无 UI 降级只写 pending）；`/memory` 命令族（status/review/approve/reject/forget/revert，revert 会跳过已回滚的记忆提交）；supersedes 取代流程；回归测试 `sh tests/run.sh`（隔离 git 环境全流程）全部通过
- memory 私有仓库已创建并推送：`git@github.com:bladescepter/memory.git`，本地路径 `~/DEV/memory`，初始协议 commit `1ad6d0d`
- P1 已完成：五层目录、根/分层 README 路由、frontmatter 规范、INDEX 生成、schema/secret/重复/链接校验、pre-commit hook 和单元测试均已建立；尚无正式记忆
- 2026-09-21 协议升级为单仓双区：个人区（五层，跨项目有效）+ 项目区 `projects/<项目名>/`（decisions/topics/incidents/handoffs，单项目有效，scope: project）；方案 §4.2 已同步改写；memory 仓库 commit `c17946e`，memark recall 已支持项目区索引
- 2026-09-21 P2 首批完成：从 Hindsight 心智模型提炼的 67 条记忆经用户逐条审核后入库（个人区 8、newswrite 6、cmnrag 14、proofreading 17、wiki 22，共 71 个 commit 推送）；观察拆条（768 条）经审核决定不迁移，仅作本地评审参考 `hindsight-migration-candidates.md`（已 gitignore）
- memark 扩展已通过 `~/.pi/agent/extensions/memark` symlink 挂载；当前会话需执行 `/reload` 后才会加载
- Hindsight 侧：心智模型刷新已由用户关闭；自动 retain 与查询能力迁移期保留（只读迁移源，不做任何自动写入）
- Jev（typesafe.ai）early access 尚未申请；接入前须先完成 200–500 轮标注评测（方案 §12）

## 下一步

1. 日常使用：用户说「记住 XX」→ agent 调 `memark_remember` → 确认入库；定期观察漏召回/误报，积累评测集
2. P4：接入 Jev Gate（先离线跑标注集校准，再接 `agent_settled`，只写 pending）
3. 基线注入：`before_agent_start` 注入 ≤600 tokens 稳定基线

## 本项目纪律

- Gate / Jev 只产候选，无正式写入权；用户批准是唯一写入闸门
- 密钥、Token、私钥、Cookie 永不入记忆仓库；提交前 secret scan（Git 历史不可回收）
- memory 仓库一条记忆一个 commit，历史即审计日志
- memory 仓库写入前 `git pull --ff-only`，非 fast-forward 停止自动化交人工处理
- Hindsight 迁移期只读；P6 才停容器（先备份、保留数据卷观察）
- 扩展所有事件 handler 必须 try/catch：Gate 失败静默跳过，recall 失败提示后降级为直接读仓库文件

## 开发参考

- pi 扩展 API：当前安装目录下 `docs/extensions.md` 与 `examples/extensions/`（`@earendil-works/pi-coding-agent`，随 pi 升级路径会变，可用 `npm root -g` 定位）
- `typebox`、`@earendil-works/pi-coding-agent` 在扩展中可直接 import（pi 内置 alias；`import type` 不参与运行时解析）
- 扩展开发挂载方式见 [README.md](README.md)
