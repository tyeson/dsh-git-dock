# dsh-git-dock 错误码表（A0）

所有 API 响应都带 `requestId`：

- 成功：`{ ok: true, value: <data>, requestId }`
- 失败：`{ ok: false, requestId, error: { code, message, details? } }`

客户端把 `requestId` 附加到错误对象上（`error.requestId`），排查时可用它对照审计日志与 Host 日志。

## 请求与环境

| code | HTTP | 含义 | 处理建议 |
|---|---|---|---|
| `bad-request` | 400 | 参数缺失或不合法（路径、名称等） | 修正输入 |
| `method-error` | 405 | 非 POST 调用 | 修正客户端 |
| `forbidden` | 403 | 请求未通过浏览器信任检查 | 从 DSH 页面内调用 |
| `not-found` | 404 | 未知 API 方法 | 升级插件/客户端版本 |
| `internal` | 500 | 未预期异常 | 记录 requestId 后反馈 |
| `git-missing` | 503 | 找不到 git 可执行文件 | 安装 git 并加入 PATH |
| `git-error` | 400 | git 执行失败（含 stderr 摘要） | 查看 details.detail |
| `timeout` | 504 | 操作超时 | 重试或检查仓库规模 |
| `too-large` | 413 | 输出超过上限 | 缩小范围后重试 |
| `aborted` | 499 | 客户端中断 | 无需处理 |
| `no-cwd` | 409 | 会话没有工作目录 | 打开带目录的会话 |
| `session-not-found` | 404 | 会话不存在 | 刷新页面 |

## 仓库与路径

| code | HTTP | 含义 | 处理建议 |
|---|---|---|---|
| `not-repo` | 409 | 目录不是 git 仓库 | 选择仓库根目录 |
| `path-missing` | 404 | 注册路径不存在 | 修正路径 |
| `not-directory` | 400 | 注册路径不是目录 | 选择目录 |
| `no-remote` | 409 | 仓库没有配置远程 | 添加远程 |
| `running` | 409 | 会话正在运行写操作 | 等待后重试 |

## 变更 / 暂存 / 提交

| code | HTTP | 含义 | 处理建议 |
|---|---|---|---|
| `stale` | 409 | HEAD 已变化（expectHead 不匹配） | 刷新后重试 |
| `nothing-staged` | 409 | 没有可提交/可汇总的改动 | 先暂存或修改文件 |
| `patch-stale` | 409 | 索引或工作区在 diff 加载后已变化（部分暂存） | 刷新后重新选择再应用 |
| `patch-failed` | 409 | 所选变更无法干净应用 | 查看 details.detail |
| `nothing-selected` | 400 | 未选择任何变更行 | 选择后重试 |
| `binary-file` | 409 | 二进制文件不能部分暂存 | 整体暂存或跳过 |
| `message-required` | 400 | 提交信息为空 | 填写提交信息 |
| `message-too-long` | 400 | 超过提交信息长度上限 | 精简信息 |
| `commit-failed` | 400 | git commit 失败 | 查看 details.detail |
| `amend-pushed` | 409 | HEAD 已推送，禁止 amend | 新建提交 |
| `merge-open` | 409 | 合并未完成时不能普通提交 | 完成或放弃合并 |
| `operation-in-progress` | 409 | 有进行中的 git 操作 | 完成/放弃后重试 |
| `discard-failed` | 400 | stash 丢弃失败 | 查看 details.detail |
| `discard-undo-failed` | 409 | 撤销丢弃时 stash apply 失败 | 手动解决冲突 |
| `no-discard` | 404 | 没有可撤销的丢弃记录 | 无需撤销 |

## 分支 / 合并 / 冲突

| code | HTTP | 含义 | 处理建议 |
|---|---|---|---|
| `branch-exists` | 409 | 分支已存在 | 换名 |
| `invalid-name` | 400 | 分支名不合法 | 使用合法名称 |
| `unknown-branch` | 404 | 分支不存在 | 刷新分支列表 |
| `unknown-ref` | 404 | 起点引用不存在 | 检查引用名 |
| `same-branch` | 400 | 目标就是当前分支 | 换目标 |
| `no-base` | 409 | 无法解析对比基线 | 手动指定基线 |
| `same-base` | 400 | 基线与当前分支相同 | 换基线 |
| `no-merge` | 409 | 没有进行中的合并 | 先发起合并 |
| `merge-token` | 409 | 合并确认令牌失效 | 重新预检 |
| `merge-failed` | 400 | 合并提交失败 | 查看 details.detail |
| `conflicts-remain` | 409 | 仍有未解决冲突 | 解决冲突后继续 |
| `not-conflicted` | 400 | 文件不是冲突文件 | 刷新冲突列表 |
| `unresolved-conflicts` | 409 | 存在未解决冲突，操作被阻止 | 解决冲突 |
| `conflicted` | 409 | 文件处于冲突中，不能部分暂存 | 先解决冲突 |
| `conflict-accept-failed` | 409 | `git checkout --ours/--theirs` 失败 | 查看 details.detail |
| `conflict-save-failed` | 409 | 写入结果文件失败 | 检查权限与路径 |
| `detached` | 409 | detached HEAD | 切回分支 |
| `detached-confirm` | 409 | 需要二次确认的 detached 操作 | 确认后重试 |

## 远程同步

| code | HTTP | 含义 | 处理建议 |
|---|---|---|---|
| `no-upstream` | 409 | 分支没有上游关联 | 使用「推送并关联」 |
| `fetch-failed` | 400 | fetch 失败 | 检查网络/认证 |
| `not-fast-forward` | 409 | 不能快进 | 先合并或变基 |
| `push-rejected` | 409 | 远端拒绝推送 | 拉取合并后重试 |
| `push-failed` | 409 | 推送失败 | 查看 details.detail |

## AI

| code | HTTP | 含义 | 处理建议 |
|---|---|---|---|
| `llm-unavailable` | 503 | 没有可用的模型服务/模型 | 配置模型 |
| `llm-failed` | 502 | 模型请求失败 | 重试或换模型 |

## 审计日志

危险操作（A0 起）写入 `<DSH_HOME>/dsh-git-dock/audit.jsonl`，每行一条 JSON：

```json
{"at":"2026-11-26T08:00:00.000Z","id":"…","action":"discard","repoRoot":"C:/repo","branch":"main","target":["a.ts"],"result":"stashed"}
```

当前覆盖动作：`discard`、`discard.undo`、`commit.amend`、`merge.abort`、`merge.complete`、`push`、`stage.patch`、`unstage.patch`、`conflict.accept`、`conflict.save`。日志不记录文件内容与凭证。
