# 与 GitFlow Studio 方案的偏离说明（A0）

依据：《GitFlow_Studio_插件开发技术方案_V1.0.docx》。本插件以“渐进扩展、不重写”为原则，以下偏离均为有意决策，需保持记录。

| 编号 | 方案要求 | 本插件实现 | 理由 | 后续 |
|---|---|---|---|---|
| D1 | TypeScript + pnpm Monorepo + 构建 | 单包纯 JavaScript，无构建步骤，JSDoc 注释 | 保持 git 直接安装、无需构建；降低迁移成本 | 若必须 TS，另立迁移阶段 |
| D2 | Monaco DiffEditor | 自绘 unified/side diff + 轻量语法高亮 | 避免 Monaco 体积与客户端加载/CSP 风险 | 若 DSH 提供编辑器再评估 |
| D3 | Remote Workspace Agent（P5） | 仅本地仓库 + 远程 origin | 远程执行需要 Agent 端能力，规模独立 | 单独立项 |
| D4 | 响应 `{ success, data, error, requestId }` | `{ ok, value, requestId }` / `{ ok:false, requestId, error }` | 继承既有契约，减少回归 | 客户端层做映射即可 |
| D5 | 仓库注册 + repositoryId | A1 起支持注册表 + 会话级活动仓库覆盖（repositoryId/path） | 兼容“会话 cwd 即仓库”的既有行为 | 后续可升级为显式 repositoryId 全链路 |
| D6 | 插件命名 GitFlow Studio | 包名/id 仍为 `dsh-git-dock`，界面可呈现品牌名 | 避免破坏已发布安装与用户配置 | 发布策略确定后再改名 |
| D7 | 文件监听 300ms 防抖 + 3–5s 轮询 | 12s 轮询 + 窗口 focus + 应用内事件 | 降低大仓库开销；功能上满足刷新需求 | A2/A5 可调低频率或引入 watch |
| D8 | 单元测试工具链 | 真实临时仓库集成烟测（150+ 断言） | 无构建 + 零依赖，覆盖核心路径 | A7 补 `node:test` 单元测试 |

所有偏离不影响方案的功能目标（P1–P3 日常 Git 工作流），只影响实现形态与交付工具链。
