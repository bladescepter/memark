# memark

**mem**ory + **mark**down —— [pi](https://pi.dev) 编码代理的长期记忆扩展。

设计原则：**自动系统只负责发现候选，正式写入必须经用户批准。** 完整设计见
[docs/记忆系统重构完整方案.md](docs/记忆系统重构完整方案.md)。

## 仓库分工

| 仓库 | 内容 |
|---|---|
| `memark`（本仓库） | 扩展代码：记忆查找、受控写入、`/memory` 命令；未来接入候选门卫 |
| `memory`（独立私有仓库） | 记忆数据、路由协议、索引与校验脚本 |

## 安装

各机器先分别克隆扩展和私有记忆仓库：

```bash
git clone git@github.com:bladescepter/memark.git ~/DEV/memark
git clone git@github.com:bladescepter/memory.git ~/DEV/memory
```

**Linux/macOS/VPS（开发推荐）**：

```bash
mkdir -p ~/.pi/agent/extensions
ln -s ~/DEV/memark ~/.pi/agent/extensions/memark
```

**Windows**：在 `~/.pi/agent/settings.json` 中指向本地目录：

```json
{ "extensions": ["C:/Users/blade/DEV/memark"] }
```

**作为 pi 包安装**：

```bash
pi install git:github.com/bladescepter/memark
pi update --extensions
```

需 Node.js 22.19+、Pi 0.85.1 或更新版本。安装或更新后，在**实际执行工具的每个 Pi 实例**中执行 `/reload`，再用 `/memory status` 核对运行版本、加载路径与磁盘指纹。磁盘代码已更新不代表旧进程已加载；`/memory sync` 只同步记忆数据，不升级扩展。

记忆仓库路径由 `MEMARK_REPO` 指定，默认 `~/DEV/memory`；项目名默认从当前目录及其父目录中匹配，也可用 `MEMARK_PROJECT` 指定。

## 当前功能（v0.3.6）

v0.3.6 将首次 recall 的五秒阻塞同步改为一小时新鲜度后台下载，加入多会话/进程去重、失败退避、退出取消和一致本地快照；用户审核与正式写入规则不变。作为未固定旧引用的 Git 包安装时，运行 `pi update --extensions` 更新，再在每个 Pi 实例 `/reload`，用 `/memory status` 确认运行版本为 `0.3.6` 和代码指纹。

v0.3.5 的可选参数 nullable 兼容与 Pi 1.0 测试入口继续保留；不适用字段可省略或传 `null`，真实冲突仍拒绝。

本次不修改 memory 数据协议。若从 v0.3.4 之前升级，还需同步私有 `memory` 仓库的配套 `scripts/validate.py` 修复：候选链接不再参与正式区检查，批准时仍按正式目标校验。仅更新扩展不能替代协议脚本更新。

### 查找记忆

- `memark_recall` 默认查找个人区和当前项目区。
- recall 只读取一致的本地快照，不联网、不等待后台下载；不再缓存首次查询的失败结果。
- 启动、resume 或 reload 后，后台检查本机共享的一小时新鲜度；到期才下载，运行时存活期间定时检查。
- `all_projects=true` 可显式跨项目查找。
- 先查标题、描述和标签，再以正文关键词补充；最终按正文重新验证正式路径、当前项目范围、`reviewed: true`、`status: active` 与有效期，不信任陈旧索引替代审核状态。
- recall、基线和维护共用元数据解析；支持单/双引号日期及 `null`/`~`。`expires` 按 UTC 日期判断，当天仍有效，次日过期。
- 仓库正在后台下载或审核写入时，recall 和基线改读一个固定的本地 Git 提交；无写入时捕获工作区快照，核对 HEAD 和本机修改代次，防止混合索引与正文。
- 输出总量限制为 50KB/2000 行。

### 后台下载（v0.3.6，待其他设备实测）

- 默认新鲜度为 **1 小时**。可用 `MEMARK_SYNC_INTERVAL_MS` 配置 1 分钟至 24 小时的周期，无效值使用默认值；不需要修改服务器配置即可使用默认值。
- 扩展工厂不启动任务；`session_start` 注册后台检查，不等待网络。成功时间保存在仓库本机 `.git/memark-sync-state.json`，所有会话/进程共享，启动或恢复不足一小时不重复下载。
- 同一进程每仓库一个调度器；跨进程获得仓库锁后再检查新鲜度。仓库忙最多等待 0.5 秒后跳过；状态检查和下载共用 60 秒总预算，取消/超时不会迟到执行排队任务。
- 自动流程仅 `pull --ff-only --no-rebase`，禁用该次 Git 的 hooks、autostash 和自动维护，不修复索引、不提交、不 push；工作区有未处理修改时跳过。审核写入规则不变。
- 网络失败按 1/5/15/60 分钟退避；工作区修改、鉴权和非快进问题按正常周期再检查，状态提示人工处理，不密集重试。状态只保存时间、阶段和分类，不保存 stderr、远端 URL 或凭据。
- `/memory status` 显示最近成功时间、结果、阶段、耗时与重试时间。`/memory sync` 仍是立即完整同步入口，并刷新共享下载时间；同进程正在后台下载时先取消该任务，不取消审核写入或其他进程的操作。
- `session_shutdown` 清理本会话注册与定时器，取消属于退出运行时的下载；其他会话仍可继续调度。未注册 pi-web 保活租约，不让等待中的定时器阻止闲置回收。
- **pi-web**：后台任务在服务器，不在浏览器。默认闲置 10 分钟回收会话运行时，定时任务随之清理；再次恢复时按共享时间补检查。没有存活会话期间允许暂停，不保证无人使用时严格每小时执行，也不修改 `PI_WEB_IDLE_TIMEOUT_MS`。
- **herdr**：detach/attach 保留原 Pi 时继续调度；原生会话恢复创建新 Pi 时重新检查共享新鲜度。实际恢复路径仍需各机验收。

后台更新未完成时可能暂用旧的已审核快照；跨机器刚写入并要求立即最新时，先执行 `/memory sync`。本次升级无需更新 memory 协议脚本。VPS pi-web 已实测 reload 后运行指纹与磁盘一致、成功快进下载、到期后的后台下载成功；闲置回收补检查、herdr 重启与其他设备仍需验收。

### 每轮当前主机角色与稳定基线（待逐机实测）

- 每轮 `before_agent_start` 注入的**主机信息仅为本机角色和实时 OS**，不注入设备 ID、hostname 或工作目录；即使从 PC 浏览器访问 pi-web，Agent 的执行主机仍是 VPS。远程工具执行目标需另外核对。
- 同时读取本地已审核、active、未过期的个人身份/原则/偏好标题与描述；不读取项目记忆、不在每轮联网、不写入 Git。注入长度限制为 480 字符 / 1100 UTF-8 字节（具体 token 数依模型验证）。本地快照可通过 `/memory sync` 更新。
- 新机器首次交互对话时，扩展提示用户设置**当前 Pi 运行机器**的角色（如 `VPS`、`工作电脑`、`家庭电脑`、`Linux 笔记本`）；保存于本机 Pi 配置目录 `~/.pi/agent/memark/host-role.json`（若设置 `PI_CODING_AGENT_DIR` 则随之改变），不进入共享记忆仓库。可用 `/memory host` 查看、`/memory host set <角色>` 修改。扩展不读取 hostname，也不使用角色环境变量；无交互界面或取消时显示“未确认”，下次新会话可重试。pi-web 应设置 VPS 的角色，而非浏览器所在 PC 的角色。

### 受控写入

`memark_remember` 只在用户明确要求“记住”时使用：

1. 下载远端最新版本并确认仓库没有未处理修改；
2. 在临时副本中生成草案、索引并运行格式、重复、链接和敏感信息检查；
3. 展示完整 Git diff 与归属/文件清单，选项为 Yes / No / Edit；Edit 可修改措辞，新建记忆和 pending 还可修改归属，修改后重新校验并回到预览；
4. 用户确认后才写入正式目录；
5. 只提交本次计划内文件，然后上传。

**分类只由 `zone + type` 决定**：项目区传 `project + type`，不传 `category`；个人区 `layer` 可省略，knowledge 子目录也按 type 推导。`category` 仅向模型提供 Context 的 `current/relationships`。旧调用中匹配 type 的 category 仍兼容单复数、大小写和空白，规范化后移除；真正的类型/范围冲突明确拒绝，不为绕过错误擅自改成个人区。

**可选参数与严格 schema**：`layer/category/project/expires/supersedes/edit/as_pending` 均可省略或传 `null`。若模型接口要求所有字段必填，不适用的字段填 `null`，不要强行选择 `current` 或其他冲突值。参数预处理将这些 `null` 转为省略，再按原规则校验；项目区仍必须有实际 `project`，Handoff 仍必须有实际 `expires`。`as_pending=null` 与省略相同，不等于批准，也不绕过预览审核。标题、描述、正文、标签、区域和类型等核心必填字段拒绝 `null`，不让 Pi 将其转换成字符串 `"null"`。

**TUI 审核**：完整预览独立滚动，按 Yes / No / Edit 顺序固定显示，默认选中 Yes（须按 Enter 或点击才批准，不会自动写入）。↑↓ 或 1/2/3 选择，Enter 确认；PgUp/PgDn、Home/End 或鼠标滚轮查看内容，Esc 取消。过小窗口禁止批准，提示放大。新项目显著标明“新建项目”和记忆/辅助文件数量，README 与 INDEX 不冒充多条记忆。Edit → 修改归属可选择已有项目、新项目或个人区；跨区时由用户重新选择类型，旧项目附带文件不混入新计划。

**RPC 审核**：不再逐六行翻页。通过多行 editor 一次展示完整、可滚动的 diff；预览标题保持简短，正文不截断。预览窗口的“提交”**只是进入确认，不是批准写入**；下一窗口按 Yes / No / Edit 顺序提供操作，“重看完整预览”在其后；默认选中 Yes，仍须显式确认。预览仅用于查看，修改正文请在下一步选择 Edit；预览文本若被客户端截断或意外改动，会停止并保留候选，不将被改动的 diff 当成草案。需要支持多行 editor/select 的 RPC 客户端；能力不足、关闭或超时保留 pending，不回退到长标题或大量短分页。

调整已入库记忆的措辞可提供 `edit=<仓库相对路径>` 原地更新（只改标题、描述、标签和正文，保留原 type/timestamp/scope/expires/supersedes）；原地编辑不搬迁既有文件，无法审核/同步时停止并需重新发起，不生成用于新建的 pending。措辞编辑仍使用 Pi 终端编辑器，Ctrl+G 可调用外部编辑器。

无 UI、离线或仓库有未处理修改时，候选只保存在本机 `pending/`，不会进入 Git。新建记忆和待审核候选在审核中已修改的正文与归属会在延迟写入时保留，不退回最初参数。写入按顺序执行，并使用本机仓库锁防止多个 pi 进程互相覆盖。

### `/memory` 命令

```text
/memory status                    运行版本/加载指纹、记忆库与后台下载状态
/memory host                      查看本机角色
/memory host set <角色>           设置/修改本机角色（仅本机）
/memory sync                      完整同步；必要时只修复索引
/memory review                    查看待审核候选
/memory approve <id>              预览并批准候选（可先 Edit 调整措辞）
/memory reject <id> [原因]        拒绝候选；原因记入当前会话审计
/memory maintain                  只读校验并列出过期记忆
/memory forget <path>             按原目录结构移入 archive/
/memory edit <path>               在终端编辑器中原地编辑记忆
/memory revert                    安全撤销最近一次记忆修改
```

所有文件路径都限制在记忆仓库内。取得逐文件锁后再次核对 HEAD、工作区和审核时的原文快照；排队期间发生变化则停止，不覆盖新版本。pending 在批准前及清理前都比较版本，审核期间被更新或拒绝的候选不能按旧版本提交或无条件删除。

失败时只恢复本次涉及的文件及本次新建的空目录，保留原有目录和其他内容。`/memory revert` 同样在临时副本校验并展示完整反向 diff，再经确认和精确提交；若后续提交改动了同一正文，停止自动撤销。

## 测试

```bash
npm test
```

测试先执行严格的 TypeScript 类型检查，再使用 `tests/fixtures/memory/` 中完全虚构的独立记忆库；不读取私人 `~/DEV/memory`。覆盖本地快照/后台下载、项目隔离、待审核批准/拒绝、确认前编辑、原地编辑、敏感信息、路径越界、失败恢复、并发写入、远端竞态、归档、撤销、索引修复和基线/本机角色注入。

分类测试经过真实 Pi wrapper → prepareArguments → schema 校验链，并用被测 Pi 的 strict schema 转换/校验模块及只强制全字段必填的代理形式验证 nullable 请求，覆盖 Learning 审核拒绝/批准、Context/项目/Handoff 归属及条件必填、原地编辑和真实冲突拒绝；`tests/review_test.cjs` 使用真实 Pi 普通/全屏 overlay 合成器，覆盖长预览、中文宽字符、窗口缩放、固定按钮、键盘/取消、RPC 完整滚动预览与版本漂移。完整工具流程还覆盖新项目批准/取消、Edit 改归属及失败后保留最新 pending。GitHub 对 Pi 0.85.1 / 0.87.1 运行同一套测试；这不替代各机实际终端或 RPC 客户端的人工验收。

`tests/safety_test.cjs` 覆盖真实 Pi 文件队列竞争、忽略文件碰撞、pending 版本竞争/拒绝、新项目失败回滚、陈旧或错区索引、引号/null 元数据、非阻塞本地读取、候选链接隔离，以及完整预检撤销。文件队列不再用“直接执行回调”的 mock 代替。

`tests/sync_test.cjs` 使用虚构远端验证一小时新鲜度、共享调度/成功时间、真实 Pi 工厂恢复生命周期、网络退避、鉴权/非快进分类、未提交修改保护、超时/退出取消、写入中的一致快照、禁用 hook 和覆盖 rebase 配置，以及两个真实 Node 进程只 pull 一次。时间推进使用注入时钟，不等待真实一小时；不替代实际 pi-web 闲置回收与 herdr 重启验收。

可用 `MEMARK_TEST_PI_ROOT=/实际安装的/pi-coding-agent npm test` 对另一已安装 Pi 的参数处理和渲染组件复测（类型检查仍用项目依赖）。`tests/tool-pipeline.cjs` 兼容旧版准备入口和 Pi 1.0 的公开 `runToolCall`，两者都走真实 wrapper、参数准备和校验，不用 mock 代替。nullable 修补已在 Pi 0.85.1 与本机 Pi 1.0.0 完成全套回归；真实模型端仍需重载后验收。

## 后续计划

- Jev 候选门卫已搁置：实测确认手动触发记忆最可靠；方案保留备查，未来漏记/误记明显时再评估。
- 基线与当前主机注入已实现，下一步逐机验证首次角色提示、角色/OS、压缩后识别与实际模型 token 数，详见设计方案 §3.2、§6.1。
- v0.3.6 已完成 VPS pi-web 真实后台下载验收；其他设备更新后验证一小时去重、断网恢复、闲置回收补检查和 herdr 重启，再完成跨设备 P3 验收。

## 降级

扩展不可用时，记忆仓库仍是普通 Markdown：按其 `README.md` 协议使用 `read`/`grep` 读取，手工运行校验脚本后提交即可。
