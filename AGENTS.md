# AGENTS.md — memark

## 项目定位

memark = **mem**ory + **m**arkdown，pi 编码代理的长期记忆扩展。

设计原则（不可违背）：**自动系统只负责发现候选，正式写入必须经用户批准。**

完整设计文档：[docs/记忆系统重构完整方案.md](docs/记忆系统重构完整方案.md)（16 节，唯一权威，本文件只做索引不复制其内容）。命名备注：memd 已被 pi 生态同名扩展占用，故取名 memark。

## 双仓库结构

| 仓库 | 内容 | 状态 |
|---|---|---|
| `memark`（本仓库） | 扩展代码：recall 工具、curator 流程、/memory 命令；Jev 门卫已搁置 | v0.3.5 |
| `memory`（独立私有仓库） | 记忆数据：五层目录、README 路由协议、INDEX.md、scripts/ | 已创建并推送；默认路径 `~/DEV/memory`（`$MEMARK_REPO` 可覆盖） |

分工原则：**协议和校验跟数据走**——校验脚本放 memory 仓库（无扩展也能自检），本仓库只承载 pi 集成逻辑。

## 当前状态（历史里程碑与已发布版本）

- v0.1（commit `2a6b46b`）：`memark_recall` 工具（INDEX.md 路由 → 读取正文）+ `/memory` 初版
- v0.3.0：多文件重构（repo.ts / curator.ts / index.ts），建立 `memark_remember`、pending 审核和 Git 写入流程
- v0.3.1 安全加固：取消会话启动联网，改为每会话第一次 recall 在 5 秒内尝试同步；安全路径限制兼容 Windows；批准前只在临时副本校验并展示修改预览；精确暂存/精确回滚；pending 本机忽略且写前查密；仓库级排队与本机锁；归档保留原目录；新增 maintain、全文补充检索、过期过滤和跨项目参数
- v0.3.1 测试改为公开虚构 fixture，不读取私人 memory；严格 TypeScript 检查 + GitHub 自动测试，覆盖首次同步、approve、supersedes、路径越界、用户未提交修改保护、commit 失败恢复、并发写入、远端竞态、归档/撤销和索引修复
- v0.3.2 交互与效率：确认窗口改为 Yes / No / Edit 三选项（Edit 在终端编辑器改草案后重新校验）；category 可省略并按 type 自动归档、单复数归一化；新增 /memory edit 与 memark_remember 的 edit 参数支持原地修改措辞
- v0.3.3：分类以 type 唯一推导（旧 category 兼容、冲突拒绝）；TUI 滚动预览与固定三选项、RPC 分页；新草案可在 Edit 中改归属；status 显示加载版本/路径/代码指纹。真实参数链和普通/全屏渲染测试通过，标签 v0.3.3；逐机交互验收仍待完成，详见方案 §8.3 与 README。
- v0.3.4：RPC 一次完整滚动预览后独立确认；按用户要求，TUI/RPC 均为 Yes / No / Edit 顺序、默认选中 Yes（仍须显式确认）。文件锁内重查审核快照；pending 版本保护；失败回滚清理本次空目录；recall 重查审核状态/范围；统一引号/null 元数据与有效期；首次同步总预算；完整预检撤销。memory 协议配套隔离 pending 链接，升级需同步两个仓库；新增真实 Pi 文件队列回归。
- v0.3.5：记忆写入可选参数支持省略与 null，兼容强制全字段必填的模型接口；核心必填 null 和真实分类冲突仍拒绝，不绕过用户审核。测试入口兼容 Pi 1.0，Pi 0.85.1 / 本机 1.0.0 全套回归通过；本次无需修改 memory 协议，逐机模型调用验收仍待完成。
- 开发工作区新增每轮 `before_agent_start` 基线与本机角色注入（只读已审核个人摘要 + 本机首次交互设定角色/实时 OS；不使用 hostname 或设备 ID；尚待逐机验收）
- memory 私有仓库已创建并推送：`git@github.com:bladescepter/memory.git`，本地路径 `~/DEV/memory`，初始协议 commit `1ad6d0d`
- P1 已完成：五层目录、根/分层 README 路由、frontmatter 规范、INDEX 生成、schema/secret/重复/链接校验、pre-commit hook 和单元测试均已建立
- 2026-09-21 协议升级为单仓双区：个人区（五层，跨项目有效）+ 项目区 `projects/<项目名>/`（decisions/topics/incidents/handoffs，单项目有效，scope: project）；方案 §4.2 已同步改写；memory 仓库 commit `c17946e`，memark recall 已支持项目区索引
- 2026-09-21 P2 首批完成：从 Hindsight 心智模型提炼的 67 条记忆经用户逐条审核后入库（个人区 8、newswrite 6、cmnrag 14、proofreading 17、wiki 22，共 71 个 commit 推送）；观察拆条（768 条）经审核决定不迁移，仅作本地评审参考 `hindsight-migration-candidates.md`（已 gitignore）
- memark 扩展已通过 `~/.pi/agent/extensions/memark` symlink 挂载；当前会话需执行 `/reload` 后才会加载
- Hindsight 仅保留手动查询作为迁移源；自动 recall、自动 retain、心智模型注入均关闭
- 2026-09-23 Jev Gate 搁置：实测确认手动触发记忆最可靠，自动判断暂不引入；计划保留在方案 §7/§12 备查，解冻前须先完成 200–500 轮中文标注评测

## 下一步

1. 各机更新 v0.3.5 扩展（从 v0.3.4 之前升级时还需同步配套 memory 协议脚本），各运行实例 `/reload` 并用 `/memory status` 核对加载版本和指纹；逐机实测新项目长预览的 Yes / No / Edit、缩放与改归属，再完成真实 recall、正式写入和 `/memory sync` 的 P3 验收
2. 日常使用，观察漏召回、误报和同步冲突
3. 基线与当前主机注入已实现（保守长度上限），需按方案 §3.2、§6.1 在各机首次交互设置本机角色，并实测角色、OS 及 token 数

## 本项目纪律

- Gate / Jev 只产候选，无正式写入权；用户批准是唯一写入闸门
- 审核操作按用户指定的 Yes / No / Edit 顺序，默认焦点为 Yes；不得擅自改顺序或默认项。默认选中不等于自动批准，必须收到用户明确确认；取消、超时、异常不可写入
- 密钥、Token、私钥、Cookie 永不入记忆仓库；提交前 secret scan（Git 历史不可回收）
- memory 仓库一条记忆一个 commit，历史即审计日志
- memory 仓库写入前 `git pull --ff-only`，非 fast-forward 停止自动化交人工处理
- Hindsight 迁移期只读；P6 才停容器（先备份、保留数据卷观察）
- 扩展所有事件 handler 必须 try/catch：Gate 失败静默跳过，recall 失败提示后降级为直接读仓库文件

## 开发参考

- pi 扩展 API：当前安装目录下 `docs/extensions.md` 与 `examples/extensions/`（`@earendil-works/pi-coding-agent`，随 pi 升级路径会变，可用 `npm root -g` 定位）
- `typebox`、`@earendil-works/pi-coding-agent` 在扩展中可直接 import（pi 内置 alias；`import type` 不参与运行时解析）
- 扩展开发挂载方式见 [README.md](README.md)
