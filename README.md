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

安装或更新后，在已有会话中执行 `/reload`。记忆仓库路径由 `MEMARK_REPO` 指定，默认 `~/DEV/memory`；项目名默认从当前目录及其父目录中匹配，也可用 `MEMARK_PROJECT` 指定。

## 当前功能（v0.3.1）

### 查找记忆

- `memark_recall` 默认查找个人区和当前项目区。
- 每个会话第一次真正查找记忆时，先尝试在 5 秒内下载远端最新版本；不再在会话启动时联网。
- 同一会话后续查找不重复下载；失败时使用本地快照并明确提示。
- `all_projects=true` 可显式跨项目查找。
- 先查标题、描述和标签，再以正文关键词补充；过期记忆不返回。
- 输出总量限制为 50KB/2000 行。

### 受控写入

`memark_remember` 只在用户明确要求“记住”时使用：

1. 下载远端最新版本并确认仓库没有未处理修改；
2. 在临时副本中生成草案、索引并运行格式、重复、链接和敏感信息检查；
3. 展示修改前后预览；
4. 用户确认后才写入正式目录；
5. 只提交本次计划内文件，然后上传。

无 UI、离线或仓库有未处理修改时，候选只保存在本机 `pending/`，不会进入 Git。写入按顺序执行，并使用本机仓库锁防止多个 pi 进程互相覆盖。

### `/memory` 命令

```text
/memory status                    状态、数量和本地/远端差异
/memory sync                      完整同步；必要时只修复索引
/memory review                    查看待审核候选
/memory approve <id>              预览并批准候选
/memory reject <id> [原因]        拒绝候选；原因记入当前会话审计
/memory maintain                  只读校验并列出过期记忆
/memory forget <path>             按原目录结构移入 archive/
/memory revert                    安全撤销最近一次记忆修改
```

所有文件路径都限制在记忆仓库内；失败时只恢复本次操作涉及的文件，不会清除用户的其他未提交修改。

## 测试

```bash
npm test
```

测试先执行严格的 TypeScript 类型检查，再使用 `tests/fixtures/memory/` 中完全虚构的独立记忆库；不读取私人 `~/DEV/memory`。覆盖首次查找同步、项目隔离、待审核批准/拒绝、敏感信息、路径越界、失败恢复、并发写入、远端竞态、归档、撤销和索引修复。GitHub 在每次推送和合并请求时自动运行同一套测试。

## 后续计划

- 建立 200–500 轮人工标注集后，再接入 Jev 候选门卫；它只能写入 `pending/`。
- 增加不超过 600 tokens 的稳定基础记忆注入。
- 三台机器分别完成一次真实同步验证后，再结束 P3 验收。

## 降级

扩展不可用时，记忆仓库仍是普通 Markdown：按其 `README.md` 协议使用 `read`/`grep` 读取，手工运行校验脚本后提交即可。
