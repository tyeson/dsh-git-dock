/**
 * dsh-git-dock — browser half.
 *
 * Renders the always-on Git entry under the composer card
 * (`conversation.composer.dock`) and its branch panel, which lives in
 * `shell.overlay` so the docked composer cannot clip it.
 *
 * The two halves share one tiny module-level store; the panel is positioned
 * from the chip's viewport rectangle and closes on outside press / Escape.
 * All data comes from the Host's fenced route prefix; the browser never names
 * a filesystem path.
 *
 * @module dsh-git-dock/client
 */
window.__ModuleLoader__.load({
  id: 'dsh-git-dock',
  factory(require) {
    const React = require('react')
    const h = React.createElement

    /** Locale namespace of this plugin. */
    const NS = 'gitDock'
    const STYLE_ID = 'dsh-git-dock-style'
    const CHIP_ATTR = 'data-dsh-git-dock-chip'
    const PANEL_WIDTH = 360
    const POLL_MS = 20000

    /** Right-sidebar tab type owned by this plugin. */
    const CHANGES_KIND = 'git-dock-changes'
    const CHANGES_TAB_ID = 'dsh-git-dock:changes'

    /** Flat dictionaries: `zh`/`en`, plus the keys the UI needs. */
    const DICT = {
      zh: {
        'chip.loading': '读取分支…',
        'chip.detached': '游离 HEAD',
        'chip.changed': '{n} 个文件变化',
        'chip.ahead': '领先 {n}',
        'chip.behind': '落后 {n}',
        'chip.gitMissing': 'Git 不可用',
        'chip.error': 'Git 状态读取失败，点击重试',
        'chip.title': 'Git 分支',
        'panel.title': 'Git 分支',
        'panel.search': '搜索分支',
        'panel.current': '当前分支',
        'panel.local': '本地分支',
        'panel.remote': '远程分支',
        'panel.remoteHint': '远程分支（仅展示）',
        'panel.createConfirm': '仍要创建',
        'panel.newBranch': '新建分支',
        'panel.name': '分支名称',
        'panel.namePlaceholder': '例如 feature/login',
        'panel.from': '起点',
        'panel.fromPlaceholder': '默认为当前 HEAD',
        'panel.create': '创建并切换',
        'panel.cancel': '取消',
        'panel.switch': '切换',
        'panel.refresh': '刷新',
        'panel.empty': '没有匹配的分支',
        'panel.loading': '加载中…',
        'panel.switching': '切换中…',
        'panel.creating': '创建中…',
        'panel.runningWarn': '会话正在运行，切换分支会改变工作区文件，可能影响正在进行的任务。',
        'panel.runningConfirm': '仍要切换',
        'panel.operation': '仓库有进行中的 {op}，请先完成或中止操作。',
        'panel.dirty': '{n} 个文件变化',
        'panel.detachedHint': '当前处于游离 HEAD，切换到任意分支即可恢复。',
        'op.merge': '合并',
        'op.rebase': '变基',
        'op.cherry-pick': '拣选',
        'op.revert': '回滚',
        'op.bisect': '二分排查',
        'panel.noUpstream': '未设置上游',
        'panel.upstream': '上游 {name}',
        'panel.aheadBehind': '↑{ahead} ↓{behind}',
        'panel.branchExists': '分支已存在',
        'panel.stale': '仓库状态已变化，已刷新，请重试。',
        'panel.notRepo': '当前目录不是 Git 仓库',
        'panel.noSession': '没有活动会话',
        'panel.error': '操作失败',
        'time.now': '刚刚',
        'time.minutes': '{n} 分钟前',
        'time.hours': '{n} 小时前',
        'time.days': '{n} 天前',
        'err.not-repo': '当前会话目录不是 Git 仓库',
        'err.git-missing': '未找到 git 命令，请先安装 Git 并加入 PATH',
        'err.session-not-found': '会话不在运行中，请重新打开会话',
        'err.no-cwd': '会话没有工作目录',
        'err.timeout': 'Git 命令超时',
        'err.stale': '仓库状态已变化，请重试',
        'err.running': '会话正在运行，需要再次确认',
        'err.operation-in-progress': '有进行中的合并/变基，请先完成或中止',
        'err.unknown-branch': '本地分支不存在',
        'err.branch-exists': '分支已存在',
        'err.invalid-name': '分支名不合法',
        'err.unknown-ref': '起点不存在',
        'err.forbidden': '请求被拒绝',
        'err.not-found': '接口不存在',
        'err.bad-request': '请求参数不合法',
        'err.too-large': '请求或输出过大',
        'err.git-error': 'Git 命令执行失败',
        'err.internal': '插件内部错误',
        'err.no-base': '无法确定基线分支，请手动选择',
        'err.same-base': '基线不能是当前分支',
        'err.merge-token': '合并确认已失效，请重新预检',
        'err.not-fast-forward': '当前分支不能快进到该分支',
        'err.no-merge': '当前没有进行中的合并',
        'err.conflicts-remain': '还有未解决的冲突文件',
        'err.detached': '游离 HEAD 状态下不能合并',
        'err.same-branch': '不能把当前分支合并到自身',
        'err.not-conflicted': '该文件不是冲突文件',
        'err.merge-failed': 'Git 合并命令执行失败',
        'merge.action': '合并到当前分支',
        'merge.button': '合并',
        'merge.pick': '选择要合并到当前分支的分支',
        'merge.title': '合并 {source} 到当前分支',
        'merge.mode.no-ff': '保留合并提交',
        'merge.mode.ff-only': '仅快进',
        'merge.mode.squash': '压缩为改动',
        'merge.modeHint.no-ff': '总是生成合并提交（--no-ff）',
        'merge.modeHint.ff-only': '只在可快进时合并',
        'merge.modeHint.squash': '改动进入暂存区，不生成合并提交',
        'merge.kind.up-to-date': '已是最新，无需合并',
        'merge.kind.fast-forward': '可直接快进',
        'merge.kind.merge': '将产生一个合并提交',
        'merge.summary': '{files} 个文件 · +{add} −{del}',
        'merge.conflictsPreview': '预检发现 {n} 个冲突文件，合并后需要手动解决',
        'merge.dirtyWarn': '工作区有未提交改动，合并可能失败',
        'merge.runningWarn': '会话正在运行，合并会改变工作区文件',
        'merge.apply': '合并',
        'merge.applying': '合并中…',
        'merge.done': '已合并 {source}',
        'merge.squashed': '已把 {source} 的改动压缩到暂存区，尚未提交',
        'merge.openTitle': '合并进行中 · {n} 个冲突文件',
        'merge.rowResolve': '标记已解决',
        'merge.complete': '完成合并',
        'merge.abort': '放弃合并',
        'merge.completing': '提交中…',
        'merge.aborting': '放弃中…',
        'merge.noConflicts': '所有冲突已解决，可以完成合并',
        'merge.resolveAction': '冲突解决',
        'merge.conflictsResolved': '冲突已解决',
        'merge.assisting': '通知中…',
        'merge.assisted': '已通知当前模型处理 {n} 个冲突文件，解决并暂存后请手动完成合并；push 仍需你手动操作',
        'err.no-conflicts': '没有需要解决的冲突',
        'err.agent-unavailable': '当前会话暂时无法接收指令',
        'tag.confirm': '签出标记 {name} 会进入游离 HEAD，可基于它新建分支。',
        'tag.confirmYes': '确认签出',
        'panel.tags': '标记',
        'panel.tracking': '将创建本地跟踪分支',
        'panel.createFrom': '以此新建分支',
        'commit.messagePlaceholder': '提交信息（Ctrl+Enter 提交）',
        'commit.submit': '提交',
        'commit.amend': '修订',
        'commit.busy': '提交中…',
        'commit.done': '已提交 {sha}',
        'commit.amended': '已修订 {sha}',
        'commit.ai': '生成提交信息',
        'commit.aiBusy': '生成中…',
        'commit.aiHint': '优先使用已暂存的 diff；没有暂存时使用工作区改动，发给当前会话模型',
        'commit.nothingToDraft': '没有可生成提交信息的改动（先修改或暂存文件）',
        'commit.modelTitle': '提交信息模型',
        'commit.modelHint': '选择生成提交信息使用的模型与推理等级',
        'commit.modelFollow': '跟随当前会话',
        'commit.effort': '推理等级',
        'commit.effortAuto': '默认',
        'commit.modelBusy': '加载模型…',
        'commit.modelUnavailable': '无法读取模型列表',
        'commit.conventionHint': '已按仓库规范生成：{summary}',
        'commit.charCount': '{n}/{max}',
        'commit.config': '提交规范',
        'commit.configTitle': '提交规范与长度',
        'commit.types': '类型（逗号分隔）',
        'commit.scopeRequired': 'scope 必填',
        'commit.language': '描述语言',
        'commit.lang.zh': '中文',
        'commit.lang.en': 'English',
        'commit.maxLength': '主题长度上限（留空不限制）',
        'commit.totalMaxLength': '总长度上限',
        'commit.vague': '模糊词（逗号分隔）',
        'commit.save': '保存',
        'commit.reset': '恢复默认',
        'commit.saved': '已保存提交规范',
        'commit.resetDone': '已恢复默认提交规范',
        'err.config-invalid': '提交规范配置不合法',
        'commit.nothingStaged': '没有已暂存的改动',
        'stage.all': '全部暂存',
        'unstage.all': '全部取消暂存',
        'stage.checkbox': '暂存该文件',
        'discard.action': '丢弃',
        'discard.confirm': '丢弃 {n} 个文件的改动？已跟踪的改动会存进 stash，仍可恢复。',
        'discard.confirmYes': '确认丢弃',
        'sync.fetch': '获取',
        'sync.push': '推送',
        'sync.sync': '同步',
        'sync.commitPush': '提交并推送',
        'sync.noUpstream': '未设置上游',
        'sync.aheadBehind': '↑{ahead} ↓{behind}',
        'sync.busy': '处理中…',
        'sync.fetched': '已获取远端',
        'sync.pushed': '已推送',
        'sync.synced': '已同步',
        'err.message-required': '请填写提交信息',
        'err.message-too-long': '提交信息超过长度上限',
        'err.nothing-staged': '没有已暂存的改动',
        'err.amend-pushed': '该提交已推送，禁止修订',
        'err.merge-open': '合并进行中，请先完成或放弃合并',
        'err.commit-failed': '提交失败',
        'err.commit-failed-detail': 'Git 提交命令失败',
        'err.discard-failed': '丢弃失败',
        'err.fetch-failed': '获取远端失败',
        'err.pull-failed': '拉取失败',
        'err.push-failed': '推送失败',
        'err.push-rejected': '推送被拒绝（远端有新的提交），请先同步',
        'err.no-upstream': '当前分支未设置上游',
        'err.no-remote': '仓库没有配置远端',
        'err.diverged': '本地与远端已分叉，无法快进',
        'err.llm-unavailable': '当前会话没有可用模型',
        'err.llm-failed': '模型生成失败',
        'err.detached-confirm': '签出标记需要确认',
        'err.not-staged': '没有已暂存的改动',
        'tab.title': 'Git 变更',
        'tab.scope.worktree': '工作区',
        'tab.scope.branch': '分支对比',
        'tab.base': '基线',
        'tab.summary': '{files} 个文件 · +{add} −{del}',
        'tab.summaryPrefix': '{files} 个文件 · ',
        'tab.summaryPrefixOne': '1 个文件 · ',
        'tab.commits': '{n} 个提交',
        'tab.empty': '没有变更',
        'tab.emptyBranch': '与基线 {base} 没有差异',
        'tab.loading': '加载中…',
        'tab.binary': '二进制文件，无法对比',
        'tab.truncated': '内容过大，仅显示前 5000 行',
        'tab.unified': '统一',
        'tab.side': '并排',
        'tab.wrap': '换行',
        'tab.refresh': '刷新',
        'tab.open': '查看变更',
        'tab.selectFile': '选择左侧文件查看对比',
        'tab.fileCount': '{n} 个文件',
        'tab.branch': '当前分支',
        'tab.branchHint': '切换分支',
        'tab.baseHint': '选择对比基线',
      },
      en: {
        'chip.loading': 'Reading branch…',
        'chip.detached': 'detached HEAD',
        'chip.changed': '{n} changed',
        'chip.ahead': '{n} ahead',
        'chip.behind': '{n} behind',
        'chip.gitMissing': 'Git unavailable',
        'chip.error': 'Could not read Git state — click to retry',
        'chip.title': 'Git branch',
        'panel.title': 'Git branch',
        'panel.search': 'Filter branches',
        'panel.current': 'Current branch',
        'panel.local': 'Local branches',
        'panel.remote': 'Remote branches',
        'panel.remoteHint': 'Remote branches (read-only)',
        'panel.createConfirm': 'Create anyway',
        'panel.newBranch': 'New branch',
        'panel.name': 'Branch name',
        'panel.namePlaceholder': 'e.g. feature/login',
        'panel.from': 'Start point',
        'panel.fromPlaceholder': 'Defaults to HEAD',
        'panel.create': 'Create and switch',
        'panel.cancel': 'Cancel',
        'panel.switch': 'Switch',
        'panel.refresh': 'Refresh',
        'panel.empty': 'No matching branches',
        'panel.loading': 'Loading…',
        'panel.switching': 'Switching…',
        'panel.creating': 'Creating…',
        'panel.runningWarn': 'The session is running. Switching changes working-tree files and may disturb the current task.',
        'panel.runningConfirm': 'Switch anyway',
        'panel.operation': 'A {op} is in progress; finish or abort it first.',
        'panel.dirty': '{n} changed',
        'panel.detachedHint': 'HEAD is detached; switch to a branch to reattach.',
        'op.merge': 'merge',
        'op.rebase': 'rebase',
        'op.cherry-pick': 'cherry-pick',
        'op.revert': 'revert',
        'op.bisect': 'bisect',
        'panel.noUpstream': 'no upstream',
        'panel.upstream': 'upstream {name}',
        'panel.aheadBehind': '↑{ahead} ↓{behind}',
        'panel.branchExists': 'Branch already exists',
        'panel.stale': 'The repository changed; refreshed — please retry.',
        'panel.notRepo': 'The current directory is not a Git repository',
        'panel.noSession': 'No active session',
        'panel.error': 'Operation failed',
        'time.now': 'just now',
        'time.minutes': '{n}m ago',
        'time.hours': '{n}h ago',
        'time.days': '{n}d ago',
        'err.not-repo': 'The session directory is not a Git repository',
        'err.git-missing': 'git was not found; install Git and add it to PATH',
        'err.session-not-found': 'The session is no longer live; reopen it',
        'err.no-cwd': 'The session has no working directory',
        'err.timeout': 'Git command timed out',
        'err.stale': 'The repository changed; please retry',
        'err.running': 'The session is running; confirmation is required',
        'err.operation-in-progress': 'A merge or rebase is in progress; finish or abort it first',
        'err.unknown-branch': 'Local branch not found',
        'err.branch-exists': 'Branch already exists',
        'err.invalid-name': 'Invalid branch name',
        'err.unknown-ref': 'Start point not found',
        'err.forbidden': 'Request rejected',
        'err.not-found': 'Unknown endpoint',
        'err.bad-request': 'Invalid request',
        'err.too-large': 'Request or output too large',
        'err.git-error': 'Git command failed',
        'err.internal': 'Plugin internal error',
        'err.no-base': 'No base branch detected — pick one',
        'err.same-base': 'The base cannot be the current branch',
        'err.merge-token': 'The merge confirmation expired — preview again',
        'err.not-fast-forward': 'The current branch cannot fast-forward to that branch',
        'err.no-merge': 'No merge is in progress',
        'err.conflicts-remain': 'Some conflicted files are still unresolved',
        'err.detached': 'Cannot merge on a detached HEAD',
        'err.same-branch': 'Cannot merge the current branch into itself',
        'err.not-conflicted': 'That file is not conflicted',
        'err.merge-failed': 'The git merge command failed',
        'merge.action': 'Merge into current branch',
        'merge.button': 'Merge',
        'merge.pick': 'Pick a branch to merge into the current one',
        'merge.title': 'Merge {source} into the current branch',
        'merge.mode.no-ff': 'Keep merge commit',
        'merge.mode.ff-only': 'Fast-forward only',
        'merge.mode.squash': 'Squash changes',
        'merge.modeHint.no-ff': 'Always create a merge commit (--no-ff)',
        'merge.modeHint.ff-only': 'Merge only when it can fast-forward',
        'merge.modeHint.squash': 'Leave the changes staged without a merge commit',
        'merge.kind.up-to-date': 'Already up to date',
        'merge.kind.fast-forward': 'Can fast-forward',
        'merge.kind.merge': 'Will create a merge commit',
        'merge.summary': '{files} files · +{add} −{del}',
        'merge.conflictsPreview': 'The preview found {n} conflicted files; they need manual resolution',
        'merge.dirtyWarn': 'The working tree has uncommitted changes; the merge may fail',
        'merge.runningWarn': 'The session is running; merging changes working-tree files',
        'merge.apply': 'Merge',
        'merge.applying': 'Merging…',
        'merge.done': 'Merged {source}',
        'merge.squashed': 'Squashed {source} into the index; nothing is committed yet',
        'merge.openTitle': 'Merge in progress · {n} conflicted files',
        'merge.rowResolve': 'Mark resolved',
        'merge.complete': 'Complete merge',
        'merge.abort': 'Abort merge',
        'merge.completing': 'Committing…',
        'merge.aborting': 'Aborting…',
        'merge.noConflicts': 'Every conflict is resolved — the merge can be completed',
        'merge.resolveAction': 'Resolve conflicts',
        'merge.conflictsResolved': 'Conflicts resolved',
        'merge.assisting': 'Notifying…',
        'merge.assisted': 'The model was asked to resolve and stage {n} conflicted file(s); complete the merge yourself afterwards — pushing stays manual',
        'err.no-conflicts': 'There are no conflicted files to resolve',
        'err.agent-unavailable': 'This session cannot accept a prompt right now',
        'tag.confirm': 'Checking out tag {name} leaves a detached HEAD; you can create a branch from it.',
        'tag.confirmYes': 'Check out',
        'panel.tags': 'Tags',
        'panel.tracking': 'Creates a local tracking branch',
        'panel.createFrom': 'Create branch from this',
        'commit.messagePlaceholder': 'Commit message (Ctrl+Enter to commit)',
        'commit.submit': 'Commit',
        'commit.amend': 'Amend',
        'commit.busy': 'Committing…',
        'commit.done': 'Committed {sha}',
        'commit.amended': 'Amended {sha}',
        'commit.ai': 'Draft message',
        'commit.aiBusy': 'Drafting…',
        'commit.aiHint': 'Uses the staged diff, or the working-tree diff when nothing is staged',
        'commit.nothingToDraft': 'There are no changes to draft a message from (edit or stage files first)',
        'commit.modelTitle': 'Commit message model',
        'commit.modelHint': 'Pick the model and reasoning effort used to draft commit messages',
        'commit.modelFollow': 'Follow this conversation',
        'commit.effort': 'Reasoning effort',
        'commit.effortAuto': 'Default',
        'commit.modelBusy': 'Loading models…',
        'commit.modelUnavailable': 'Could not read the model list',
        'commit.conventionHint': 'Drafted from the repository convention: {summary}',
        'commit.charCount': '{n}/{max}',
        'commit.config': 'Convention',
        'commit.configTitle': 'Commit convention and length',
        'commit.types': 'Types (comma separated)',
        'commit.scopeRequired': 'Scope required',
        'commit.language': 'Description language',
        'commit.lang.zh': '中文',
        'commit.lang.en': 'English',
        'commit.maxLength': 'Subject limit (blank = no limit)',
        'commit.totalMaxLength': 'Total limit',
        'commit.vague': 'Vague words (comma separated)',
        'commit.save': 'Save',
        'commit.reset': 'Reset',
        'commit.saved': 'Commit convention saved',
        'commit.resetDone': 'Commit convention reset to default',
        'err.config-invalid': 'Invalid commit convention',
        'commit.nothingStaged': 'Nothing is staged',
        'stage.all': 'Stage all',
        'unstage.all': 'Unstage all',
        'stage.checkbox': 'Stage this file',
        'discard.action': 'Discard',
        'discard.confirm': 'Discard changes in {n} file(s)? Tracked changes are stashed and can be recovered.',
        'discard.confirmYes': 'Discard',
        'sync.fetch': 'Fetch',
        'sync.push': 'Push',
        'sync.sync': 'Sync',
        'sync.commitPush': 'Commit and push',
        'sync.noUpstream': 'No upstream',
        'sync.aheadBehind': '↑{ahead} ↓{behind}',
        'sync.busy': 'Working…',
        'sync.fetched': 'Fetched remotes',
        'sync.pushed': 'Pushed',
        'sync.synced': 'Synced',
        'err.message-required': 'A commit message is required',
        'err.message-too-long': 'The commit message is over the length limit',
        'err.nothing-staged': 'No staged changes',
        'err.amend-pushed': 'That commit is already pushed; amending is disabled',
        'err.merge-open': 'A merge is in progress; complete or abort it first',
        'err.commit-failed': 'Commit failed',
        'err.commit-failed-detail': 'The git commit command failed',
        'err.discard-failed': 'Discard failed',
        'err.fetch-failed': 'Fetch failed',
        'err.pull-failed': 'Pull failed',
        'err.push-failed': 'Push failed',
        'err.push-rejected': 'Push rejected (the remote has newer commits); sync first',
        'err.no-upstream': 'The current branch has no upstream',
        'err.no-remote': 'No git remote is configured',
        'err.diverged': 'Local and remote have diverged; fast-forward is impossible',
        'err.llm-unavailable': 'No model is available for this session',
        'err.llm-failed': 'The model request failed',
        'err.detached-confirm': 'Checking out a tag needs confirmation',
        'err.not-staged': 'No staged changes',
        'tab.title': 'Git changes',
        'tab.scope.worktree': 'Working tree',
        'tab.scope.branch': 'Branch',
        'tab.base': 'Base',
        'tab.summary': '{files} files · +{add} −{del}',
        'tab.summaryPrefix': '{files} files · ',
        'tab.summaryPrefixOne': '1 file · ',
        'tab.commits': '{n} commits',
        'tab.empty': 'No changes',
        'tab.emptyBranch': 'No differences from {base}',
        'tab.loading': 'Loading…',
        'tab.binary': 'Binary file — no comparison',
        'tab.truncated': 'Too large — showing the first 5000 lines',
        'tab.unified': 'Unified',
        'tab.side': 'Side by side',
        'tab.wrap': 'Wrap',
        'tab.refresh': 'Refresh',
        'tab.open': 'Review changes',
        'tab.selectFile': 'Pick a file on the left to compare',
        'tab.fileCount': '{n} files',
        'tab.branch': 'Branch',
        'tab.branchHint': 'Switch branch',
        'tab.baseHint': 'Choose the comparison base',
      },
    }

    /** Locale service attached during apply(); null in bare compositions. */
    let localeService = null

    /** The Client context, kept for optional service lookups (`sidebarRight`). */
    let clientCtx = null

    /** The Session the mounted chip currently speaks for (panel ownership). */
    let chipSessionId = null

    /** Chip element that opened the panel: focus returns here on close. */
    let lastChipElement = null

    /** Sessions already proven to sit outside a Git repository (no flicker). */
    const notRepoCache = new Set()

    /** Active language id, `zh` or `en`. */
    function currentLang() {
      try {
        const snapshot = localeService === null ? null : localeService.getSnapshot()
        const id = snapshot === null ? undefined : (snapshot.id ?? snapshot.locale ?? snapshot.language ?? snapshot.active)
        if (typeof id === 'string' && id !== '') return id.toLowerCase().startsWith('zh') ? 'zh' : 'en'
      } catch {
        // Fall through to the browser preference.
      }
      const browser = typeof navigator === 'undefined' ? 'en' : navigator.language ?? 'en'
      return String(browser).toLowerCase().startsWith('zh') ? 'zh' : 'en'
    }

    /** Translate one key, interpolating `{name}` placeholders. */
    function t(key, vars) {
      const dict = DICT[currentLang()] ?? DICT.en
      let text = dict[key] ?? DICT.en[key] ?? key
      if (vars !== undefined) {
        for (const name of Object.keys(vars)) text = text.split(`{${name}}`).join(String(vars[name]))
      }
      return text
    }

    /** Localized name of an in-progress git operation. */
    function opName(op) {
      if (typeof op !== 'string' || op === '' || op === 'none') return ''
      const key = `op.${op}`
      const localized = t(key)
      return localized === key ? op : localized
    }

    /** Compact summary of one effective commit convention. */
    function conventionSummary(effective) {
      return [
        'conventional',
        Array.isArray(effective.types) ? effective.types.slice(0, 5).join('/') : '',
        effective.language === 'zh' ? 'zh' : effective.language === 'en' ? 'en' : '',
        effective.scopeRequired === true ? 'scope' : '',
        typeof effective.maxLength === 'number' ? `≤${effective.maxLength}` : '',
        typeof effective.totalMaxLength === 'number' ? `total ≤${effective.totalMaxLength}` : '',
      ].filter((part) => part !== '').join(' · ')
    }

    /** Localized error text for one failure. */
    function errorText(error) {      if (error === null || error === undefined) return ''
      const code = error.code
      const key = code === undefined ? '' : `err.${code}`
      const localized = key === '' ? key : t(key)
      if (localized !== key) return localized
      return typeof error.message === 'string' && error.message !== '' ? error.message : t('err.internal')
    }

    /** Human relative time for a commit timestamp. */
    function timeAgo(timestamp) {
      if (typeof timestamp !== 'number' || !Number.isFinite(timestamp) || timestamp <= 0) return ''
      const diff = Date.now() - timestamp
      if (diff < 60_000) return t('time.now')
      if (diff < 3_600_000) return t('time.minutes', { n: Math.round(diff / 60_000) })
      if (diff < 86_400_000) return t('time.hours', { n: Math.round(diff / 3_600_000) })
      if (diff < 2_592_000_000) return t('time.days', { n: Math.round(diff / 86_400_000) })
      const date = new Date(timestamp)
      const month = String(date.getMonth() + 1).padStart(2, '0')
      const day = String(date.getDate()).padStart(2, '0')
      return `${date.getFullYear()}-${month}-${day}`
    }

    /** Resolve one Host API method against the page's own base (prefix-safe). */
    function apiUrl(method) {
      let base
      try {
        base = new URL(document.baseURI)
      } catch {
        base = new URL('http://127.0.0.1/')
      }
      base.search = ''
      base.hash = ''
      if (!base.pathname.endsWith('/')) base.pathname += '/'
      return new URL(`plugins/dsh-git-dock/api/${method}`, base).href
    }

    /** One POST against the Host API; rejects with a coded error. */
    async function callApi(method, body) {
      let response
      try {
        response = await fetch(apiUrl(method), {
          method: 'POST',
          credentials: 'same-origin',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify(body),
        })
      } catch (error) {
        const failure = new Error(error instanceof Error ? error.message : String(error))
        failure.code = 'network'
        throw failure
      }
      const data = await response.json().catch(() => ({}))
      if (response.ok !== true || data.ok !== true) {
        const detail = data.error ?? {}
        const failure = new Error(typeof detail.message === 'string' ? detail.message : `HTTP ${response.status}`)
        failure.code = typeof detail.code === 'string' ? detail.code : 'internal'
        failure.details = detail.details
        failure.status = response.status
        throw failure
      }
      return data.value
    }

    // ── Shared store ──────────────────────────────────────────────────────

    let state = {
      open: false,
      anchor: null,
      sessionId: null,
      repoStatus: 'idle',
      repo: null,
      repoError: null,
      repoSessionId: null,
      branches: null,
      branchesStatus: 'idle',
      branchesError: null,
      pending: null,
      pendingBranch: null,
      actionError: null,
      createOpen: false,
      confirmCreate: false,
      filter: '',
      confirmBranch: null,
      tagConfirm: null,
      createFrom: null,
    }

    const listeners = new Set()

    /** Cross-surface notifications: any surface that mutates the repo pings the others. */
    const repoListeners = new Set()

    function onRepoChanged(listener) {
      repoListeners.add(listener)
      return () => repoListeners.delete(listener)
    }

    function notifyRepoChanged(sessionId) {
      for (const listener of repoListeners) {
        try {
          listener(sessionId)
        } catch {
          // A broken listener must not break the others.
        }
      }
    }

    function getSnapshot() {
      return state
    }

    function subscribe(listener) {
      listeners.add(listener)
      return () => listeners.delete(listener)
    }

    function setState(patch) {
      state = Object.assign({}, state, patch)
      for (const listener of listeners) {
        try {
          listener()
        } catch {
          // A broken subscriber must not break the others.
        }
      }
    }

    /** Subscribe one component to the shared store. */
    function useStore() {
      if (typeof React.useSyncExternalStore === 'function') {
        return React.useSyncExternalStore(subscribe, getSnapshot)
      }
      const [, force] = React.useState(0)
      React.useEffect(() => subscribe(() => force((value) => value + 1)), [])
      return state
    }

    // ── Merge picker store (floating dropdown anchored at the Merge button) ──

    let mergePicker = {
      open: false,
      anchor: null,
      sessionId: null,
      branches: null,
      status: 'idle',
      error: null,
      target: null,
      mode: 'no-ff',
      preview: null,
      previewStatus: 'idle',
      previewError: null,
      pending: false,
      actionError: null,
      repo: null,
    }

    const mergePickerListeners = new Set()
    let mergeBranchToken = 0
    let mergePreviewToken = 0

    function getMergeState() {
      return mergePicker
    }

    function subscribeMerge(listener) {
      mergePickerListeners.add(listener)
      return () => mergePickerListeners.delete(listener)
    }

    function setMergeState(patch) {
      mergePicker = Object.assign({}, mergePicker, patch)
      for (const listener of mergePickerListeners) {
        try {
          listener()
        } catch {
          // A broken subscriber must not break the others.
        }
      }
    }

    function useMergeStore() {
      if (typeof React.useSyncExternalStore === 'function') {
        return React.useSyncExternalStore(subscribeMerge, getMergeState)
      }
      const [, force] = React.useState(0)
      React.useEffect(() => subscribeMerge(() => force((value) => value + 1)), [])
      return mergePicker
    }

    /** Open the floating merge picker under the review tab's Merge button. */
    function openMergePicker(sessionId, element, repoInfo) {
      // The floating panels are mutually exclusive.
      closePanel(false)
      closeBasePicker()
      closeModelPicker()
      const rect = element.getBoundingClientRect()
      const viewportHeight = typeof window === 'undefined' ? 0 : window.innerHeight
      setMergeState({
        open: true,
        anchor: {
          left: rect.left,
          top: rect.top,
          right: rect.right,
          bottom: rect.bottom,
          placement: rect.top > viewportHeight * 0.5 ? 'above' : 'below',
        },
        sessionId,
        branches: null,
        status: 'loading',
        error: null,
        target: null,
        mode: 'no-ff',
        preview: null,
        previewStatus: 'idle',
        previewError: null,
        pending: false,
        actionError: null,
        repo: repoInfo ?? null,
      })
      void loadMergeBranches(sessionId)
    }

    function closeMergePicker() {
      mergeBranchToken += 1
      mergePreviewToken += 1
      setMergeState({
        open: false,
        anchor: null,
        branches: null,
        status: 'idle',
        error: null,
        target: null,
        preview: null,
        previewStatus: 'idle',
        previewError: null,
        pending: false,
        actionError: null,
      })
    }

    async function loadMergeBranches(sessionId) {
      const token = ++mergeBranchToken
      try {
        const value = await callApi('branches', { sessionId })
        if (token !== mergeBranchToken) return
        const current = value.repo !== null && value.repo !== undefined ? value.repo.branch : null
        setMergeState({
          branches: (value.local ?? [])
          .filter((branch) => branch.current !== true && branch.name !== current)
          .sort((left, right) => (right.committedAt ?? 0) - (left.committedAt ?? 0) || left.name.localeCompare(right.name)),
          status: 'ready',
          error: null,
          repo: value.repo ?? mergePicker.repo,
        })
      } catch (thrown) {
        if (token !== mergeBranchToken) return
        setMergeState({ status: 'error', error: { code: thrown.code, message: thrown.message } })
      }
    }

    function chooseMergeTarget(branch) {
      setMergeState({ target: { source: branch.name }, mode: 'no-ff', preview: null, previewStatus: 'loading', previewError: null, actionError: null })
      void loadMergePreview()
    }

    function setMergeMode(mode) {
      setMergeState({ mode, preview: null, previewStatus: 'loading', previewError: null })
      void loadMergePreview()
    }

    async function loadMergePreview() {
      const { sessionId, target, mode } = mergePicker
      if (sessionId === null || target === null) return
      const token = ++mergePreviewToken
      try {
        const value = await callApi('merge.preview', { sessionId, source: target.source, mode })
        if (token !== mergePreviewToken) return
        setMergeState({ preview: value, previewStatus: 'ready', previewError: null, repo: value.repo ?? mergePicker.repo })
      } catch (thrown) {
        if (token !== mergePreviewToken) return
        setMergeState({ previewStatus: 'error', previewError: { code: thrown.code, message: thrown.message } })
      }
    }

    async function applyMergeFromPicker() {
      const { sessionId, preview, pending } = mergePicker
      if (sessionId === null || preview === null || pending) return
      setMergeState({ pending: true, actionError: null })
      try {
        await callApi('merge.apply', { sessionId, confirmToken: preview.confirmToken, confirmed: true })
        closeMergePicker()
        notifyRepoChanged(sessionId)
      } catch (thrown) {
        setMergeState({ pending: false, actionError: { code: thrown.code, message: thrown.message } })
      }
    }

    /** Re-render when the Host locale changes. */
    function useLang() {
      useStore()
      const [lang, setLang] = React.useState(currentLang)
      React.useEffect(() => {
        if (localeService === null || typeof localeService.subscribe !== 'function') return undefined
        const off = localeService.subscribe(() => setLang(currentLang()))
        return () => {
          if (typeof off === 'function') off()
        }
      }, [])
      return lang
    }

    // ── Data actions ──────────────────────────────────────────────────────

    let repoRequest = 0
    let branchRequest = 0

    /** Load the repository state; `silent` keeps the last good value on screen. */
    async function refreshRepo(sessionId, options) {
      const silent = options !== undefined && options.silent === true
      const token = ++repoRequest
      if (!silent) setState({ repoStatus: 'loading', repoError: null })
      try {
        const value = await callApi('repo', { sessionId })
        if (token !== repoRequest) return
        notRepoCache.delete(sessionId)
        setState({ repo: value.repo, repoSessionId: sessionId, repoStatus: 'ready', repoError: null })
      } catch (error) {
        if (token !== repoRequest) return
        if (error.code === 'not-repo') {
          notRepoCache.add(sessionId)
          setState({ repo: null, repoSessionId: sessionId, repoStatus: 'not-repo', repoError: null })
          return
        }
        setState({ repoStatus: 'error', repoError: { code: error.code, message: error.message } })
      }
    }

    /** Load local and remote branches for the open panel. */
    async function loadBranches(sessionId) {
      const token = ++branchRequest
      setState({ branchesStatus: 'loading', branchesError: null })
      try {
        const value = await callApi('branches', { sessionId })
        if (token !== branchRequest) return
        setState({
          branches: value,
          branchesStatus: 'ready',
          branchesError: null,
          repo: value.repo ?? state.repo,
          repoSessionId: sessionId,
          repoStatus: 'ready',
        })
      } catch (error) {
        if (token !== branchRequest) return
        setState({ branchesStatus: 'error', branchesError: { code: error.code, message: error.message } })
      }
    }

    // ── Base picker store (comparison baseline dropdown) ─────────────────────

    let basePicker = {
      open: false,
      anchor: null,
      sessionId: null,
      candidates: null,
      status: 'idle',
      error: null,
      current: null,
      onSelect: null,
    }

    const basePickerListeners = new Set()
    let baseToken = 0

    function getBaseState() {
      return basePicker
    }

    function subscribeBase(listener) {
      basePickerListeners.add(listener)
      return () => basePickerListeners.delete(listener)
    }

    function setBaseState(patch) {
      basePicker = Object.assign({}, basePicker, patch)
      for (const listener of basePickerListeners) {
        try {
          listener()
        } catch {
          // A broken subscriber must not break the others.
        }
      }
    }

    function useBaseStore() {
      if (typeof React.useSyncExternalStore === 'function') {
        return React.useSyncExternalStore(subscribeBase, getBaseState)
      }
      const [, force] = React.useState(0)
      React.useEffect(() => subscribeBase(() => force((value) => value + 1)), [])
      return basePicker
    }

    /** Open the comparison-base dropdown under its toolbar button. */
    function openBasePicker(sessionId, element, names, current, onSelect) {
      closeMergePicker()
      closePanel(false)
      closeModelPicker()
      const rect = element.getBoundingClientRect()
      const viewportHeight = typeof window === 'undefined' ? 0 : window.innerHeight
      setBaseState({
        open: true,
        anchor: {
          left: rect.left,
          top: rect.top,
          right: rect.right,
          bottom: rect.bottom,
          placement: rect.top > viewportHeight * 0.5 ? 'above' : 'below',
        },
        sessionId,
        candidates: names.map((name) => ({ name })),
        status: 'loading',
        error: null,
        current,
        onSelect,
      })
      void loadBaseCandidates(sessionId, names)
    }

    function closeBasePicker() {
      baseToken += 1
      setBaseState({ open: false, anchor: null, candidates: null, status: 'idle', error: null, onSelect: null })
    }

    async function loadBaseCandidates(sessionId, names) {
      const token = ++baseToken
      try {
        const value = await callApi('branches', { sessionId })
        if (token !== baseToken) return
        const index = new Map()
        for (const branch of [...(value.local ?? []), ...(value.remote ?? [])]) index.set(branch.name, branch)
        setBaseState({
          candidates: names.map((name) => {
            const meta = index.get(name)
            return meta === undefined
              ? { name }
              : { name, sha: meta.sha, committedAt: meta.committedAt, author: meta.author }
          }),
          status: 'ready',
          error: null,
        })
      } catch (thrown) {
        if (token !== baseToken) return
        setBaseState({ status: 'error', error: { code: thrown.code, message: thrown.message } })
      }
    }

    /** Choose one comparison baseline: hand it to the tab, then close. */
    function chooseBase(name) {
      const select = basePicker.onSelect
      closeBasePicker()
      if (typeof select === 'function') select(name)
    }

    // ── Commit-message model picker store ────────────────────────────────────

    const COMMIT_MODEL_KEY = 'dsh-git-dock:commit-model'

    /** Read the last picked commit-message model (persisted across openings). */
    function readStoredModelChoice() {
      try {
        if (typeof localStorage === 'undefined') return null
        const raw = localStorage.getItem(COMMIT_MODEL_KEY)
        if (raw === null) return null
        const value = JSON.parse(raw)
        if (value === null || typeof value !== 'object') return null
        const provider = typeof value.provider === 'string' && value.provider !== '' ? value.provider : null
        const model = typeof value.model === 'string' && value.model !== '' ? value.model : null
        if (provider === null || model === null) return null
        const reasoningEffort = typeof value.reasoningEffort === 'string' && value.reasoningEffort !== ''
          ? value.reasoningEffort
          : null
        return { provider, model, reasoningEffort }
      } catch {
        return null
      }
    }

    /** Persist (or clear, when following the conversation again) that choice. */
    function writeStoredModelChoice(choice) {
      try {
        if (typeof localStorage === 'undefined') return
        if (choice === null) localStorage.removeItem(COMMIT_MODEL_KEY)
        else localStorage.setItem(COMMIT_MODEL_KEY, JSON.stringify(choice))
      } catch {
        // Storage can be unavailable; the choice still applies to this tab.
      }
    }

    let modelPicker = {
      open: false,
      anchor: null,
      options: null,
      choice: null,
      status: 'idle',
      error: null,
      onApply: null,
    }

    const modelPickerListeners = new Set()

    function getModelState() {
      return modelPicker
    }

    function subscribeModel(listener) {
      modelPickerListeners.add(listener)
      return () => modelPickerListeners.delete(listener)
    }

    function setModelState(patch) {
      modelPicker = Object.assign({}, modelPicker, patch)
      for (const listener of modelPickerListeners) {
        try {
          listener()
        } catch {
          // A broken subscriber must not break the others.
        }
      }
    }

    function useModelStore() {
      if (typeof React.useSyncExternalStore === 'function') {
        return React.useSyncExternalStore(subscribeModel, getModelState)
      }
      const [, force] = React.useState(0)
      React.useEffect(() => subscribeModel(() => force((value) => value + 1)), [])
      return modelPicker
    }

    /** Open the model/effort dropdown above the commit bar. */
    function openModelPicker(element, options, choice, onApply) {
      closeMergePicker()
      closeBasePicker()
      closePanel(false)
      const rect = element.getBoundingClientRect()
      const viewportHeight = typeof window === 'undefined' ? 0 : window.innerHeight
      setModelState({
        open: true,
        anchor: {
          left: rect.left,
          top: rect.top,
          right: rect.right,
          bottom: rect.bottom,
          placement: rect.top > viewportHeight * 0.5 ? 'above' : 'below',
        },
        options,
        choice,
        status: options === null ? 'loading' : 'ready',
        error: null,
        onApply,
      })
    }

    function closeModelPicker() {
      setModelState({ open: false, anchor: null, options: null, onApply: null, error: null, status: 'idle' })
    }

    /** Apply a choice (null means "follow the conversation") and close. */
    function applyModelChoice(choice) {
      const apply = modelPicker.onApply
      closeModelPicker()
      if (typeof apply === 'function') apply(choice)
    }

    /** Decide with one click: keep the panel open for the effort step. */
    function pickModelInPanel(choice) {
      setModelState({ choice })
      const apply = modelPicker.onApply
      if (typeof apply === 'function') apply(choice)
    }

    /** Open the panel anchored at the chip element. */
    function openPanel(sessionId, element) {
      // The floating panels are mutually exclusive.
      closeMergePicker()
      closeBasePicker()
      closeModelPicker()
      const rect = element.getBoundingClientRect()
      const viewportHeight = typeof window === 'undefined' ? 0 : window.innerHeight
      lastChipElement = element
      setState({
        open: true,
        sessionId,
        anchor: {
          left: rect.left,
          top: rect.top,
          right: rect.right,
          bottom: rect.bottom,
          placement: rect.top > viewportHeight * 0.5 ? 'above' : 'below',
        },
        actionError: null,
        confirmBranch: null,
        confirmCreate: false,
        pendingBranch: null,
        createOpen: false,
        filter: '',
        tagConfirm: null,
        createFrom: null,
      })
      void loadBranches(sessionId)
    }

    /**
     * Close the panel and drop transient UI state.
     * @param {boolean} [restoreFocus] - put focus back on the chip; pass false
     * when the user dismissed the panel by clicking somewhere else.
     */
    function closePanel(restoreFocus) {
      setState({
        open: false,
        anchor: null,
        actionError: null,
        confirmBranch: null,
        confirmCreate: false,
        pendingBranch: null,
        createOpen: false,
        filter: '',
        tagConfirm: null,
        createFrom: null,
      })
      const chip = lastChipElement
      lastChipElement = null
      if (restoreFocus !== false && chip !== null && typeof chip.focus === 'function' && document.contains(chip)) chip.focus()
    }

    /** Check out a branch, remote branch, tag, or commit through the Host. */
    async function doCheckout(sessionId, target) {
      const repo = state.repo
      if (repo === null || state.pending !== null) return
      const key = `${target.kind}:${target.name}`
      if (repo.running === true && state.confirmBranch !== key) {
        setState({ confirmBranch: key, actionError: null })
        return
      }
      setState({ pending: 'checkout', pendingBranch: key, actionError: null })
      try {
        const value = await callApi('checkout', { sessionId, target, expectHead: repo.head, confirmed: true })
        setState({
          repo: value.repo,
          repoSessionId: sessionId,
          pending: null,
          pendingBranch: null,
          confirmBranch: null,
          tagConfirm: null,
        })
        notifyRepoChanged(sessionId)
        void loadBranches(sessionId)
      } catch (error) {
        setState({ pending: null, pendingBranch: null, actionError: { code: error.code, message: error.message } })
        if (error.code === 'stale' || error.code === 'running') {
          if (error.details !== undefined && error.details !== null && error.details.state !== undefined) {
            setState({ repo: error.details.state, repoSessionId: sessionId })
          }
          void loadBranches(sessionId)
        }
      }
    }

    /** Switch branch, asking for confirmation first while the turn is open. */
    async function doSwitch(sessionId, branch) {
      const repo = state.repo
      if (repo === null || state.pending !== null) return
      if (repo.branch === branch && repo.detached !== true) {
        closePanel()
        return
      }
      if (repo.running === true && state.confirmBranch !== branch) {
        setState({ confirmBranch: branch, actionError: null })
        return
      }
      setState({ pending: 'switch', pendingBranch: branch, actionError: null })
      try {
        const value = await callApi('switch', {
          sessionId,
          branch,
          expectHead: repo.head,
          confirmed: repo.running === true,
        })
        setState({ repo: value.repo, repoSessionId: sessionId, pending: null, pendingBranch: null, confirmBranch: null })
        notifyRepoChanged(sessionId)
        void loadBranches(sessionId)
      } catch (error) {
        setState({ pending: null, pendingBranch: null, actionError: { code: error.code, message: error.message } })
        // The Host ships the current state on a stale OR busy refusal; applying
        // it is what makes the next click enter the confirmation state instead
        // of failing again until the next poll.
        if (error.code === 'stale' || error.code === 'running') {
          if (error.details !== undefined && error.details !== null && error.details.state !== undefined) {
            setState({ repo: error.details.state, repoSessionId: sessionId })
          }
          void loadBranches(sessionId)
        }
      }
    }

    /** Create a branch at an optional start point and switch to it. */
    async function doCreate(sessionId, name, from) {
      const repo = state.repo
      if (repo === null || state.pending !== null) return
      const trimmed = String(name ?? '').trim()
      if (trimmed === '') {
        setState({ actionError: { code: 'invalid-name', message: '' } })
        return
      }
      if (repo.running === true && state.confirmCreate !== true) {
        setState({ confirmCreate: true, actionError: null })
        return
      }
      setState({ pending: 'create', actionError: null })
      try {
        const value = await callApi('create', {
          sessionId,
          name: trimmed,
          from: String(from ?? '').trim(),
          expectHead: repo.head,
          confirmed: repo.running === true,
        })
        setState({
          repo: value.repo,
          repoSessionId: sessionId,
          pending: null,
          confirmCreate: false,
          createOpen: false,
          branches: value.branches ?? state.branches,
        })
        notifyRepoChanged(sessionId)
        void loadBranches(sessionId)
      } catch (error) {
        setState({ pending: null, actionError: { code: error.code, message: error.message } })
        if (error.code === 'stale' || error.code === 'running') {
          if (error.details !== undefined && error.details !== null && error.details.state !== undefined) {
            setState({ repo: error.details.state, repoSessionId: sessionId })
          }
          void loadBranches(sessionId)
        }
      }
    }

    // ── Styles ────────────────────────────────────────────────────────────

    function ensureStyle() {
      if (typeof document === 'undefined') return
      // Client-plugin HMR can replace the module while the previous <style> tag
      // stays in the page. Always rewrite its content so CSS changes land even
      // without a full page reload.
      const existing = document.getElementById(STYLE_ID)
      const style = existing !== null ? existing : document.createElement('style')
      style.id = STYLE_ID
      style.textContent = [
        '.dgd-chip{appearance:none;display:inline-flex;align-items:center;gap:4px;max-width:320px;padding:1px 8px;border:0;border-radius:var(--dsw-radius-sm,6px);background:transparent;color:var(--dsw-alias-label-tertiary);font:inherit;font-size:calc(var(--dsh-content-font-size-secondary,13px) - 1px);line-height:calc(20px + var(--dsh-content-font-delta-secondary,0px));cursor:pointer;transition:background .12s ease,color .12s ease}',
        '.dgd-chip:hover{background:var(--dsw-alias-interactive-bg-hover);color:var(--dsw-alias-label-primary)}',
        '.dgd-chip:focus-visible{outline:2px solid var(--dsw-alias-brand-primary);outline-offset:1px}',
        '.dgd-chip[data-open="true"]{background:var(--dsw-alias-interactive-bg-hover);color:var(--dsw-alias-label-primary)}',
        '.dgd-chip[data-disabled="true"]{cursor:default;opacity:.6}',
        '.dgd-chip[data-error="true"]{color:var(--dsw-alias-state-error-primary)}',
        '.dgd-chip-icon{display:inline-flex;flex:none;opacity:.9}',
        '.dgd-chip-label{overflow:hidden;text-overflow:ellipsis;white-space:nowrap;max-width:180px}',
        '.dgd-chip-meta{color:var(--dsw-alias-label-tertiary);font-variant-numeric:tabular-nums;white-space:nowrap;opacity:.85}',
        '.dgd-chip-dot{width:5px;height:5px;border-radius:50%;background:var(--dsw-alias-state-warn-primary);flex:none}',
        '.dgd-panel{position:fixed;z-index:1200;pointer-events:auto;display:flex;flex-direction:column;min-height:0;--dsw-elevation-stroke-color:var(--dsw-alias-border-l1);background:var(--dsw-specific-menu,var(--dsw-alias-bg-overlay));-webkit-backdrop-filter:var(--dsw-menu-backdrop-filter,none);backdrop-filter:var(--dsw-menu-backdrop-filter,none);border-radius:var(--dsw-radius-lg,12px);box-shadow:var(--dsw-elevation-prominent,0 12px 32px rgba(0,0,0,.18));color:var(--dsw-alias-label-primary);font:inherit;font-size:13px;overflow:hidden}',
        '.dgd-head{display:flex;align-items:center;gap:8px;padding:10px 12px 6px;min-width:0}',
        '.dgd-head-icon{color:var(--dsw-alias-label-secondary);display:inline-flex;flex:none}',
        '.dgd-head-text{display:flex;flex-direction:column;gap:1px;min-width:0;flex:1}',
        '.dgd-head-title{font-weight:600;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}',
        '.dgd-head-sub{color:var(--dsw-alias-label-tertiary);overflow:hidden;text-overflow:ellipsis;white-space:nowrap;font-size:12px}',
        '.dgd-icon-btn{appearance:none;display:inline-flex;align-items:center;justify-content:center;width:24px;height:24px;padding:0;border:0;border-radius:var(--dsw-radius-sm,6px);background:transparent;color:var(--dsw-alias-label-secondary);cursor:pointer}',
        '.dgd-icon-btn:hover{background:var(--dsw-alias-interactive-bg-hover);color:var(--dsw-alias-label-primary)}',
        '.dgd-icon-btn:focus-visible{outline:2px solid var(--dsw-alias-brand-primary);outline-offset:1px}',
        '.dgd-search{padding:0 10px 6px}',
        '.dgd-input{width:100%;height:28px;padding:0 8px;border:1px solid var(--dsw-alias-border-l1);border-radius:var(--dsw-radius-md,8px);background:var(--dsw-alias-bg-layer-1);color:var(--dsw-alias-label-primary);font:inherit;font-size:12px;outline:none}',
        '.dgd-input:focus{border-color:var(--dsw-alias-brand-primary)}',
        '.dgd-body{overflow:auto;padding:2px 6px 6px;min-height:0;flex:1}',
        '.dgd-section{color:var(--dsw-alias-label-tertiary);font-size:11px;padding:8px 6px 4px;letter-spacing:.02em}',
        '.dgd-row{display:flex;align-items:center;gap:8px;min-height:32px;padding:2px 8px;border-radius:var(--dsw-radius-sm,6px);cursor:pointer;min-width:0}',
        '.dgd-row:hover{background:var(--dsw-alias-interactive-bg-hover)}',
        '.dgd-row:focus-visible{outline:2px solid var(--dsw-alias-brand-primary);outline-offset:-2px}',
        '.dgd-row[data-current="true"]{color:var(--dsw-alias-label-primary)}',
        '.dgd-row[data-disabled="true"]{cursor:default;opacity:.55}',
        '.dgd-row[data-disabled="true"]:hover{background:transparent}',
        '.dgd-row-icon{display:inline-flex;flex:none;color:var(--dsw-alias-label-secondary)}',
        '.dgd-row-main{display:flex;flex-direction:column;min-width:0;flex:1;gap:0}',
        '.dgd-row-name{overflow:hidden;text-overflow:ellipsis;white-space:nowrap}',
        '.dgd-row-sub{color:var(--dsw-alias-label-tertiary);font-size:11px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}',
        '.dgd-row-trail{color:var(--dsw-alias-label-tertiary);font-size:11px;white-space:nowrap;display:inline-flex;align-items:center;gap:6px}',
        '.dgd-row-action{color:var(--dsw-alias-brand-primary);opacity:0}',
        '.dgd-row:hover .dgd-row-action{opacity:1}',
        '.dgd-warn{margin:0 10px 8px;padding:8px 10px;border:1px solid var(--dsw-alias-state-warn-primary);border-radius:var(--dsw-radius-md,8px);color:var(--dsw-alias-label-primary);background:transparent}',
        '.dgd-warn-actions{display:flex;gap:8px;justify-content:flex-end;margin-top:8px}',
        '.dgd-error{margin:0 10px 8px;padding:8px 10px;border:1px solid var(--dsw-alias-state-error-primary);border-radius:var(--dsw-radius-md,8px);color:var(--dsw-alias-state-error-primary);word-break:break-word}',
        '.dgd-foot{border-top:1px solid var(--dsw-alias-border-l1);padding:8px 10px;display:flex;flex-direction:column;gap:8px}',
        '.dgd-foot-row{display:flex;gap:8px}',
        '.dgd-btn{appearance:none;height:28px;padding:0 12px;border:1px solid var(--dsw-alias-border-l1);border-radius:var(--dsw-radius-md,8px);background:transparent;color:var(--dsw-alias-label-primary);font:inherit;font-size:12px;cursor:pointer;white-space:nowrap}',
        '.dgd-btn:hover:not(:disabled){background:var(--dsw-alias-interactive-bg-hover)}',
        '.dgd-btn:focus-visible{outline:2px solid var(--dsw-alias-brand-primary);outline-offset:1px}',
        '.dgd-btn:disabled{opacity:.55;cursor:default}',
        '.dgd-btn-primary{border-color:transparent;background:var(--dsw-alias-button-primary-fill,var(--dsw-alias-brand-primary));color:var(--dsw-alias-label-primary-foreground,#fff)}',
        '.dgd-btn-primary:hover:not(:disabled){background:var(--dsw-alias-button-primary-hover,var(--dsw-alias-brand-primary))}',
        '.dgd-btn-ghost{border-color:transparent;color:var(--dsw-alias-label-secondary)}',
        '.dgd-merge-title{font-weight:600;margin-bottom:6px}',
        '.dgd-conflict{display:flex;align-items:center;gap:8px;margin:4px 0}',
        '.dgd-conflict .dgd-path{flex:1;font-family:var(--dsw-font-mono,ui-monospace,Consolas,monospace);font-size:12px}',
        '.dgd-mode{display:flex;gap:6px;margin:8px 0;flex-wrap:wrap}',
        '.dgd-mode .dgd-btn[data-active="true"]{background:var(--dsw-alias-interactive-bg-hover);border-color:var(--dsw-alias-border-l1)}',
        '.dgd-merge-dialog{display:flex;flex-direction:column;gap:2px;padding:4px 6px}',
        '.dgd-field-label{color:var(--dsw-alias-label-tertiary);font-size:11px;margin-bottom:4px}',
        '.dgd-empty{color:var(--dsw-alias-label-tertiary);padding:12px 8px;text-align:center}',
        '.dgd-mono{font-family:var(--dsw-font-mono,ui-monospace,SFMono-Regular,Consolas,monospace)}',
        '.gdt-root{display:flex;flex-direction:column;height:100%;min-height:0;font:inherit;font-size:13px;color:var(--dsw-alias-label-primary)}',
        '.gdt-bar{display:flex;align-items:center;gap:8px;padding:8px 10px;border-bottom:1px solid var(--dsw-alias-border-l1);flex-wrap:wrap}',
        '.gdt-seg{display:inline-flex;gap:2px;padding:2px;border-radius:var(--dsw-radius-sm,6px);background:var(--dsw-alias-bg-layer-2)}',
        '.gdt-seg-btn{appearance:none;border:0;background:transparent;color:var(--dsw-alias-label-secondary);font:inherit;font-size:12px;padding:2px 8px;border-radius:calc(var(--dsw-radius-sm,6px) - 2px);cursor:pointer;white-space:nowrap}',
        '.gdt-seg-btn[data-active="true"]{background:var(--dsw-alias-bg-base);color:var(--dsw-alias-label-primary)}',
        '.gdt-seg-btn:focus-visible{outline:2px solid var(--dsw-alias-brand-primary);outline-offset:1px}',
        '.gdt-tabs{display:inline-flex;align-items:center;gap:2px;padding:2px;border-radius:var(--dsw-radius-md,8px);background:var(--dsw-alias-bg-overlay);align-self:center}',
        '.gdt-tab{appearance:none;background:transparent;border:0;padding:3px 10px;border-radius:calc(var(--dsw-radius-md,8px) - 2px);color:var(--dsw-alias-label-secondary);font:inherit;font-size:13px;cursor:pointer;white-space:nowrap}',
        '.gdt-tab:hover{background:var(--dsw-alias-interactive-bg-hover);color:var(--dsw-alias-label-primary)}',
        '.gdt-tab[data-active="true"]{background:var(--dsw-alias-bg-base);color:var(--dsw-alias-link);font-weight:600;box-shadow:0 1px 2px rgba(0,0,0,.10)}',
        '.gdt-tab:focus-visible{outline:2px solid var(--dsw-alias-brand-primary);outline-offset:1px}',
        '.gdt-caret{font-size:10px;opacity:.7;margin-left:2px}',
        '.gdt-model-name{max-width:170px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}',
        '.gdt-mp-row{display:flex;align-items:center;justify-content:space-between;gap:12px;padding:8px 10px;border-radius:6px;cursor:pointer;font-size:13px;color:var(--dsw-alias-label-primary)}',
        '.gdt-mp-row:hover{background:var(--dsw-alias-interactive-bg-hover)}',
        '.gdt-mp-row[data-current="true"]{font-weight:600}',
        '.gdt-mp-label{color:var(--dsw-alias-label-secondary);min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}',
        '.gdt-mp-value{display:inline-flex;align-items:center;gap:6px;max-width:190px;color:var(--dsw-alias-label-primary)}',
        '.gdt-mp-text{overflow:hidden;text-overflow:ellipsis;white-space:nowrap}',
        '.gdt-mp-caret{font-size:10px;opacity:.6}',
        '.gdt-mp-check{color:var(--dsw-alias-link);margin-left:4px}',
        '.gdt-mp-list{border-top:1px solid var(--dsw-alias-border-l1);margin:2px 0;padding-top:2px;max-height:260px;overflow:auto}',
        '.gdt-mp-list .gdt-mp-row{padding:6px 10px;font-size:12.5px}',
        '.gdt-summary{color:var(--dsw-alias-label-tertiary);font-size:12px;font-variant-numeric:tabular-nums;white-space:nowrap}',
        '.gdt-spacer{flex:1}',
        '.gdt-btn{appearance:none;display:inline-flex;align-items:center;gap:4px;height:24px;padding:0 8px;border:1px solid transparent;border-radius:var(--dsw-radius-sm,6px);background:transparent;color:var(--dsw-alias-label-secondary);font:inherit;font-size:12px;cursor:pointer;white-space:nowrap}',
        '.gdt-btn:hover{background:var(--dsw-alias-interactive-bg-hover);color:var(--dsw-alias-label-primary)}',
        '.gdt-btn[data-active="true"]{background:var(--dsw-alias-interactive-bg-hover);color:var(--dsw-alias-label-primary)}',
        '.gdt-btn:focus-visible{outline:2px solid var(--dsw-alias-brand-primary);outline-offset:1px}',
        '.gdt-select{height:24px;border:1px solid var(--dsw-alias-border-l1);border-radius:var(--dsw-radius-sm,6px);background:var(--dsw-alias-bg-layer-1);color:var(--dsw-alias-label-primary);font:inherit;font-size:12px;padding:0 4px;max-width:180px}',
        '.gdt-split{display:flex;flex-direction:column;min-height:0;flex:1}',
        '.gdt-files{max-height:38%;overflow:auto;border-bottom:1px solid var(--dsw-alias-border-l1);padding:2px 6px 6px}',
        '.gdt-file{display:flex;align-items:center;gap:8px;min-height:28px;padding:2px 6px;border-radius:var(--dsw-radius-sm,6px);cursor:pointer;min-width:0}',
        '.gdt-file:hover{background:var(--dsw-alias-interactive-bg-hover)}',
        '.gdt-file[data-active="true"]{background:var(--dsw-alias-interactive-bg-hover)}',
        '.gdt-file:focus-visible{outline:2px solid var(--dsw-alias-brand-primary);outline-offset:-2px}',
        '.gdt-status{flex:none;width:14px;text-align:center;font-family:var(--dsw-font-mono,ui-monospace,Consolas,monospace);font-size:11px;font-weight:600;color:var(--dsw-alias-label-secondary)}',
        '.gdt-status[data-status="A"],.gdt-status[data-status="?"]{color:var(--dsw-alias-state-success-primary)}',
        '.gdt-status[data-status="D"]{color:var(--dsw-alias-state-error-primary)}',
        '.gdt-status[data-status="U"]{color:var(--dsw-alias-state-warn-primary)}',
        '.gdt-status[data-status="M"],.gdt-status[data-status="R"],.gdt-status[data-status="C"]{color:var(--dsw-alias-brand-primary)}',
        '.gdt-path{overflow:hidden;text-overflow:ellipsis;white-space:nowrap;flex:1;min-width:0}',
        '.gdt-counts{flex:none;color:var(--dsw-alias-label-tertiary);font-size:11px;font-variant-numeric:tabular-nums;display:inline-flex;gap:6px}',
        '.gdt-add{color:var(--dsw-alias-state-success-primary)}',
        '.gdt-del{color:var(--dsw-alias-state-error-primary)}',
        '.gdt-diff{flex:1;min-height:0;display:flex;flex-direction:column}',
        '.gdt-diff-bar{display:flex;align-items:center;gap:8px;padding:6px 10px;border-bottom:1px solid var(--dsw-alias-border-l1);min-width:0}',
        '.gdt-diff-path{flex:1;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;font-family:var(--dsw-font-mono,ui-monospace,Consolas,monospace);font-size:12px;color:var(--dsw-alias-label-secondary)}',
        '.gdt-scroll{flex:1;overflow:auto;min-height:0;background:var(--dsw-alias-bg-base)}',
        '.gdt-hunk-head{padding:2px 10px;color:var(--dsw-alias-label-tertiary);background:var(--dsw-alias-bg-layer-2);font-family:var(--dsw-font-mono,ui-monospace,Consolas,monospace);font-size:11px;position:sticky;top:0}',
        '.gdt-line{display:flex;align-items:flex-start;min-height:18px;line-height:18px;font-family:var(--dsw-font-mono,ui-monospace,Consolas,monospace);font-size:12px;white-space:pre}',
        '.gdt-line[data-kind="+"]{background:color-mix(in srgb, var(--dsw-alias-state-success-primary) 12%, transparent)}',
        '.gdt-line[data-kind="-"]{background:color-mix(in srgb, var(--dsw-alias-state-error-primary) 12%, transparent)}',
        '.gdt-line[data-wrap="true"]{white-space:pre-wrap;word-break:break-all}',
        '.gdt-no{flex:none;width:44px;text-align:right;padding-right:8px;color:var(--dsw-alias-label-tertiary);user-select:none;font-variant-numeric:tabular-nums}',
        '.gdt-sign{flex:none;width:14px;text-align:center;color:var(--dsw-alias-label-secondary);user-select:none}',
        '.gdt-text{flex:1;min-width:0;padding-right:10px}',
        '.gdt-side{display:flex;min-width:0}',
        '.gdt-side-col{flex:1;min-width:0;border-right:1px solid var(--dsw-alias-border-l1)}',
        '.gdt-side-col:last-child{border-right:0}',
        '.gdt-side-line{display:flex;align-items:flex-start;min-height:18px;line-height:18px;font-family:var(--dsw-font-mono,ui-monospace,Consolas,monospace);font-size:12px;white-space:pre}',
        '.gdt-side-line[data-kind="+"]{background:color-mix(in srgb, var(--dsw-alias-state-success-primary) 12%, transparent)}',
        '.gdt-side-line[data-kind="-"]{background:color-mix(in srgb, var(--dsw-alias-state-error-primary) 12%, transparent)}',
        '.gdt-side-line[data-wrap="true"]{white-space:pre-wrap;word-break:break-all}',
        '.gdt-empty{color:var(--dsw-alias-label-tertiary);padding:18px;text-align:center}',
        '.gdt-note{padding:10px;color:var(--dsw-alias-label-tertiary);font-size:12px}',
        '.gdt-error{padding:10px;color:var(--dsw-alias-state-error-primary);font-size:12px;word-break:break-word}',
        '.gct-commit{padding:8px 10px;border-bottom:1px solid var(--dsw-alias-border-l1);display:flex;flex-direction:column;gap:6px}',
        '.gct-message{width:100%;box-sizing:border-box;min-height:44px;max-height:120px;resize:vertical;padding:6px 8px;border:1px solid var(--dsw-alias-border-l1);border-radius:var(--dsw-radius-md,8px);background:var(--dsw-alias-bg-layer-1);color:var(--dsw-alias-label-primary);font:inherit;font-size:12px;outline:none}',
        '.gct-message:focus{border-color:var(--dsw-alias-brand-primary)}',
        '.gct-commit-row{display:flex;align-items:center;gap:8px}',
        '.gct-amend{display:inline-flex;align-items:center;gap:4px;color:var(--dsw-alias-label-secondary);font-size:12px;cursor:pointer}',
        '.gct-check{margin:0;flex:none;accent-color:var(--dsw-alias-brand-primary)}',
        '.gct-remote{display:flex;align-items:center;gap:6px;padding:6px 10px;border-bottom:1px solid var(--dsw-alias-border-l1)}',
        '.gdt-branch-btn{font-weight:600;color:var(--dsw-alias-label-primary);max-width:260px}',
        '.gdt-branch-name{overflow:hidden;text-overflow:ellipsis;white-space:nowrap;max-width:190px}',
        '.gct-file-head{display:flex;align-items:center;gap:6px;padding:2px 4px 4px}',
        '.gct-actions{display:flex;gap:8px;justify-content:flex-end;margin-top:6px}',
        '.gct-config{padding:8px 10px;border-bottom:1px solid var(--dsw-alias-border-l1);display:flex;flex-direction:column;gap:6px}',
        '.gct-config-title{font-weight:600}',
        '.gct-config-row{display:flex;align-items:center;gap:8px}',
        '.gct-config-label{color:var(--dsw-alias-label-secondary);font-size:12px;min-width:120px;flex:none}',
        '.gct-merge{padding:8px 10px;border-bottom:1px solid var(--dsw-alias-border-l1);display:flex;flex-direction:column;gap:6px}',
        '.gct-merge-list{max-height:240px;overflow:auto;display:flex;flex-direction:column}',
      ].join('\n')
      if (existing === null) document.head.appendChild(style)
    }

    // ── Icons ─────────────────────────────────────────────────────────────

    function BranchIcon(props) {
      const size = props !== undefined && props.size !== undefined ? props.size : 14
      return h('svg', { viewBox: '0 0 16 16', width: size, height: size, fill: 'none', 'aria-hidden': 'true' },
        h('path', {
          d: 'M4.5 2.75v8.5M4.5 7.25c0 2.2 3.5 1.6 3.5 4.25',
          stroke: 'currentColor', 'stroke-width': '1.4', 'stroke-linecap': 'round',
        }),
        h('circle', { cx: '4.5', cy: '11.75', r: '1.5', fill: 'currentColor' }),
        h('circle', { cx: '4.5', cy: '2.75', r: '1.5', fill: 'currentColor' }),
        h('circle', { cx: '11.25', cy: '11.75', r: '1.5', fill: 'currentColor' }))
    }

    function CheckIcon(props) {
      const size = props !== undefined && props.size !== undefined ? props.size : 13
      return h('svg', { viewBox: '0 0 16 16', width: size, height: size, fill: 'none', 'aria-hidden': 'true' },
        h('path', { d: 'M3.5 8.5l3 3 6-6.5', stroke: 'currentColor', 'stroke-width': '1.6', 'stroke-linecap': 'round', 'stroke-linejoin': 'round' }))
    }

    function PlusIcon(props) {
      const size = props !== undefined && props.size !== undefined ? props.size : 13
      return h('svg', { viewBox: '0 0 16 16', width: size, height: size, fill: 'none', 'aria-hidden': 'true' },
        h('path', { d: 'M8 3.5v9M3.5 8h9', stroke: 'currentColor', 'stroke-width': '1.6', 'stroke-linecap': 'round' }))
    }

    function RefreshIcon(props) {
      const size = props !== undefined && props.size !== undefined ? props.size : 13
      return h('svg', { viewBox: '0 0 16 16', width: size, height: size, fill: 'none', 'aria-hidden': 'true' },
        h('path', {
          d: 'M13 8a5 5 0 1 1-1.6-3.7M13 3v2.6h-2.6',
          stroke: 'currentColor', 'stroke-width': '1.4', 'stroke-linecap': 'round', 'stroke-linejoin': 'round',
        }))
    }

    function ListIcon(props) {
      const size = props !== undefined && props.size !== undefined ? props.size : 13
      return h('svg', { viewBox: '0 0 16 16', width: size, height: size, fill: 'none', 'aria-hidden': 'true' },
        h('path', {
          d: 'M3 4.5h10M3 8h10M3 11.5h10',
          stroke: 'currentColor', 'stroke-width': '1.4', 'stroke-linecap': 'round',
        }))
    }

    function MergeIcon(props) {
      const size = props !== undefined && props.size !== undefined ? props.size : 12
      return h('svg', { viewBox: '0 0 16 16', width: size, height: size, fill: 'none', 'aria-hidden': 'true' },
        h('path', {
          d: 'M12.5 3.5v3.2c0 1.8-1.5 2.3-3.5 2.8-2 .5-3.5 1-3.5 2.8v1.2',
          stroke: 'currentColor', 'stroke-width': '1.3', 'stroke-linecap': 'round',
        }),
        h('path', { d: 'M3.2 13.2l2.3-2.4 2.3 2.4', stroke: 'currentColor', 'stroke-width': '1.3', 'stroke-linecap': 'round', 'stroke-linejoin': 'round' }))
    }

    // ── Chip (conversation.composer.dock) ────────────────────────────────

    function chipMeta(repo) {
      const parts = []
      if (repo.ahead > 0) parts.push(`↑${repo.ahead}`)
      if (repo.behind > 0) parts.push(`↓${repo.behind}`)
      return parts.join(' ')
    }

    function Chip(props) {
      useLang()
      const snapshot = useStore()
      const sessionId = props !== undefined ? props.sessionId : undefined
      React.useEffect(() => {
        ensureStyle()
      }, [])
      React.useEffect(() => {
        if (typeof sessionId !== 'string' || sessionId === '') return undefined
        void refreshRepo(sessionId)
        const tick = () => {
          if (typeof document !== 'undefined' && document.visibilityState === 'hidden') return
          void refreshRepo(sessionId, { silent: true })
        }
        const timer = setInterval(tick, POLL_MS)
        window.addEventListener('focus', tick)
        const offRepo = onRepoChanged((changedSession) => {
          if (changedSession === sessionId) void refreshRepo(sessionId, { silent: true })
        })
        return () => {
          clearInterval(timer)
          window.removeEventListener('focus', tick)
          offRepo()
        }
      }, [sessionId])

      React.useEffect(() => {
        // Close a panel that belongs to the Session the user just left, and
        // never show this Session the previous one's repository. A benign
        // remount of the same chip keeps both.
        const previous = chipSessionId
        chipSessionId = sessionId
        if (previous !== null && previous !== sessionId) {
          if (state.open === true && state.sessionId === previous) closePanel()
          setState({
            repo: null,
            repoSessionId: null,
            repoStatus: 'idle',
            repoError: null,
            branches: null,
            branchesStatus: 'idle',
            branchesError: null,
          })
        }
      }, [sessionId])

      if (typeof sessionId !== 'string' || sessionId === '') return null
      // A value loaded for another Session must never leak into this chip.
      const bound = snapshot.repoSessionId === sessionId
      const repo = bound ? snapshot.repo : null
      const repoStatus = bound ? snapshot.repoStatus : 'idle'

      // No chip at all outside a repository, and no loading placeholder that
      // would shift the dock's centred status line while the read settles.
      if (repoStatus === 'not-repo' || notRepoCache.has(sessionId)) return null
      if (repo === null && repoStatus === 'error') {
        const error = snapshot.repoError
        const label = error !== null && error !== undefined && error.code === 'git-missing' ? t('chip.gitMissing') : t('chip.error')
        return h('button', {
          type: 'button',
          className: 'dgd-chip',
          'data-error': 'true',
          title: errorText(error),
          onClick: () => {
            void refreshRepo(sessionId)
          },
        },
        h('span', { className: 'dgd-chip-icon' }, h(BranchIcon, null)),
        h('span', { className: 'dgd-chip-label' }, label))
      }
      if (repo === null) return null

      const isOpen = snapshot.open === true && snapshot.sessionId === sessionId
      const name = repo.detached === true ? t('chip.detached') : (repo.branch ?? 'HEAD')
      const meta = chipMeta(repo)
      const changed = repo.changes === undefined ? 0 : repo.changes.changed
      const titleParts = [name]
      if (repo.head !== null && repo.head !== undefined) titleParts.push(repo.head.slice(0, 7))
      if (changed > 0) titleParts.push(t('chip.changed', { n: changed }))
      if (repo.operation !== 'none') titleParts.push(opName(repo.operation))

      return h('button', {
        type: 'button',
        className: 'dgd-chip',
        'data-open': isOpen ? 'true' : 'false',
        [CHIP_ATTR]: '1',
        title: titleParts.join(' · '),
        'aria-label': `${t('chip.title')}: ${titleParts.join(' · ')}`,
        'aria-haspopup': 'dialog',
        'aria-expanded': isOpen ? 'true' : 'false',
        onClick: (event) => {
          if (isOpen) closePanel()
          else openPanel(sessionId, event.currentTarget)
        },
      },
      h('span', { className: 'dgd-chip-icon' }, h(BranchIcon, null)),
      h('span', { className: 'dgd-chip-label' }, name),
      meta === '' ? null : h('span', { className: 'dgd-chip-meta' }, meta),
      changed > 0 ? h('span', { className: 'dgd-chip-dot', title: t('chip.changed', { n: changed }) }) : null,
      changed > 0 ? h('span', { className: 'dgd-chip-meta' }, String(changed)) : null)
    }

    // ── Panel (shell.overlay) ─────────────────────────────────────────────

    function BranchRow(props) {
      const branch = props.branch
      const current = branch.current === true
      const busy = props.pending === true
      const sub = []
      const meta = [branch.author, branch.sha].filter((value) => typeof value === 'string' && value !== '').join(' · ')
      if (meta !== '') sub.push(meta)
      if (current) {
        if (branch.upstream === null || branch.upstream === undefined) sub.push(t('panel.noUpstream'))
        else sub.push(t('panel.upstream', { name: branch.upstream }))
      } else if (branch.subject !== '') {
        sub.push(branch.subject)
      }
      return h('div', {
        className: 'dgd-row',
        'data-current': current ? 'true' : 'false',
        'data-disabled': props.disabled ? 'true' : 'false',
        'data-pending': busy ? 'true' : 'false',
        role: 'button',
        tabIndex: props.disabled ? -1 : 0,
        title: branch.name,
        'aria-busy': busy ? 'true' : 'false',
        onClick: props.disabled ? undefined : props.onPick,
        onKeyDown: (event) => {
          if (props.disabled) return
          if (event.key === 'Enter' || event.key === ' ') {
            event.preventDefault()
            props.onPick()
          }
        },
      },
      h('span', { className: 'dgd-row-icon' }, current ? h(CheckIcon, null) : h(BranchIcon, { size: 12 })),
      h('span', { className: 'dgd-row-main' },
        h('span', { className: 'dgd-row-name' }, branch.name),
        sub.length === 0 ? null : h('span', { className: 'dgd-row-sub' }, sub.join(' · '))),
      busy
        ? h('span', { className: 'dgd-row-trail', style: { color: 'var(--dsw-alias-brand-primary)' } }, t('panel.switching'))
        : h('span', { className: 'dgd-row-trail' },
          current ? null : h('span', { className: 'dgd-row-action' }, t('panel.switch')),
          h('span', null, timeAgo(branch.committedAt))))
    }

    function RemoteRow(props) {
      const branch = props.branch
      const disabled = props.disabled === true
      const label = branch.subject === '' ? (branch.sha ?? '') : branch.subject
      return h('div', {
        className: 'dgd-row',
        'data-disabled': disabled ? 'true' : 'false',
        role: 'button',
        tabIndex: disabled ? -1 : 0,
        title: `${branch.name}${branch.hasLocal === true ? ` · ${t('panel.switch')}` : ` · ${t('panel.tracking')}`}`,
        onClick: disabled ? undefined : props.onPick,
        onKeyDown: (event) => {
          if (disabled) return
          if (event.key === 'Enter' || event.key === ' ') {
            event.preventDefault()
            props.onPick()
          }
        },
      },
      h('span', { className: 'dgd-row-icon' }, h(BranchIcon, { size: 12 })),
      h('span', { className: 'dgd-row-main' },
        h('span', { className: 'dgd-row-name' }, branch.shortName ?? branch.name),
        h('span', { className: 'dgd-row-sub' }, `${branch.remote ?? ''}${label === '' ? '' : ` · ${label}`}`)),
      h('span', { className: 'dgd-row-trail' },
        props.onCreateFrom === undefined
          ? null
          : h('button', {
            type: 'button',
            className: 'dgd-icon-btn',
            title: t('panel.createFrom'),
            'aria-label': t('panel.createFrom'),
            onClick: (event) => {
              event.stopPropagation()
              props.onCreateFrom()
            },
          }, h(PlusIcon, null)),
        h('span', null, timeAgo(branch.committedAt))))
    }

    function TagRow(props) {
      const tag = props.tag
      return h('div', {
        className: 'dgd-row',
        role: 'button',
        tabIndex: 0,
        title: `${tag.name} · ${tag.sha}`,
        onClick: props.onPick,
        onKeyDown: (event) => {
          if (event.key === 'Enter' || event.key === ' ') {
            event.preventDefault()
            props.onPick()
          }
        },
      },
      h('span', { className: 'dgd-row-icon' }, h(BranchIcon, { size: 12 })),
      h('span', { className: 'dgd-row-main' },
        h('span', { className: 'dgd-row-name' }, tag.name),
        h('span', { className: 'dgd-row-sub' }, [tag.sha, tag.subject].filter((value) => value !== '' && value !== undefined).join(' · '))),
      h('span', { className: 'dgd-row-trail' },
        h('button', {
          type: 'button',
          className: 'dgd-icon-btn',
          title: t('panel.createFrom'),
          'aria-label': t('panel.createFrom'),
          onClick: (event) => {
            event.stopPropagation()
            props.onCreateFrom()
          },
        }, h(PlusIcon, null)),
        h('span', null, timeAgo(tag.committedAt))))
    }

    function CreateForm(props) {
      const [name, setName] = React.useState('')
      const [from, setFrom] = React.useState(props.initialFrom === null || props.initialFrom === undefined ? '' : props.initialFrom)
      const pending = props.pending === 'create'
      const submit = () => {
        if (pending) return
        props.onCreate(name, from)
      }
      return h('div', null,
        h('div', { className: 'dgd-field-label' }, t('panel.name')),
        h('input', {
          className: 'dgd-input',
          value: name,
          placeholder: t('panel.namePlaceholder'),
          spellCheck: false,
          autoComplete: 'off',
          autoFocus: true,
          onChange: (event) => setName(event.target.value),
          onKeyDown: (event) => {
            if (event.key === 'Enter') {
              event.preventDefault()
              submit()
            }
          },
        }),
        h('div', { className: 'dgd-field-label', style: { marginTop: '8px' } }, t('panel.from')),
        h('input', {
          className: 'dgd-input',
          value: from,
          placeholder: props.currentBranch === null ? t('panel.fromPlaceholder') : props.currentBranch,
          spellCheck: false,
          autoComplete: 'off',
          onChange: (event) => setFrom(event.target.value),
          onKeyDown: (event) => {
            if (event.key === 'Enter') {
              event.preventDefault()
              submit()
            }
          },
        }),
        props.running === true ? h('div', { className: 'dgd-row-sub', style: { marginTop: '8px', color: 'var(--dsw-alias-state-warn-primary)' } }, t('panel.runningWarn')) : null,
        h('div', { className: 'dgd-foot-row', style: { marginTop: '8px', justifyContent: 'flex-end' } },
          h('button', { type: 'button', className: 'dgd-btn dgd-btn-ghost', onClick: props.onCancel, disabled: pending }, t('panel.cancel')),
          h('button', {
            type: 'button',
            className: props.confirmCreate === true ? 'dgd-btn dgd-btn-primary' : 'dgd-btn',
            onClick: submit,
            disabled: pending || name.trim() === '',
          }, pending ? t('panel.creating') : (props.confirmCreate === true ? t('panel.createConfirm') : t('panel.create')))))
    }

    function Panel() {
      useLang()
      const snapshot = useStore()
      const panelRef = React.useRef(null)
      const filterRef = React.useRef(null)
      React.useEffect(() => {
        ensureStyle()
      }, [])
      React.useEffect(() => {
        if (snapshot.open !== true) return undefined
        const panel = () => panelRef.current
        const onPointerDown = (event) => {
          const node = panel()
          if (node !== null && node.contains(event.target)) return
          const target = event.target
          if (target !== null && typeof target.closest === 'function' && target.closest(`[${CHIP_ATTR}]`) !== null) return
          closePanel(false)
        }
        const onKeyDown = (event) => {
          if (event.key === 'Escape') {
            event.stopPropagation()
            closePanel()
            return
          }
          if (event.key !== 'Tab') return
          const node = panel()
          if (node === null) return
          const focusable = node.querySelectorAll('button:not(:disabled),input:not(:disabled),[role="button"][tabindex="0"]')
          if (focusable.length === 0) return
          const first = focusable[0]
          const last = focusable[focusable.length - 1]
          if (event.shiftKey && document.activeElement === first) {
            event.preventDefault()
            last.focus()
          } else if (!event.shiftKey && document.activeElement === last) {
            event.preventDefault()
            first.focus()
          }
        }
        const onResize = () => closePanel(false)
        document.addEventListener('mousedown', onPointerDown, true)
        document.addEventListener('keydown', onKeyDown, true)
        window.addEventListener('resize', onResize)
        // Move focus into the panel so keyboard users do not have to tab
        // through the whole frame to reach it.
        window.setTimeout(() => {
          const node = filterRef.current
          if (node !== null && typeof node.focus === 'function') node.focus()
        }, 0)
        return () => {
          document.removeEventListener('mousedown', onPointerDown, true)
          document.removeEventListener('keydown', onKeyDown, true)
          window.removeEventListener('resize', onResize)
        }
      }, [snapshot.open])

      if (snapshot.open !== true || snapshot.anchor === null) return null
      const repo = snapshot.repo
      const sessionId = snapshot.sessionId
      const viewportWidth = typeof window === 'undefined' ? 0 : window.innerWidth
      const viewportHeight = typeof window === 'undefined' ? 0 : window.innerHeight
      const width = Math.max(260, Math.min(PANEL_WIDTH, viewportWidth - 16))
      const left = Math.max(8, Math.min(snapshot.anchor.left, viewportWidth - width - 8))
      const below = snapshot.anchor.placement === 'below'
      const panelTop = Math.max(8, snapshot.anchor.bottom + 8)
      const bottom = Math.max(8, viewportHeight - snapshot.anchor.top + 8)
      const maxHeight = below
        ? Math.min(460, Math.max(220, viewportHeight - snapshot.anchor.bottom - 24))
        : Math.min(460, Math.max(220, snapshot.anchor.top - 24))

      const branches = snapshot.branches
      const filter = snapshot.filter.trim().toLowerCase()
      const matches = (branch) => filter === '' || branch.name.toLowerCase().includes(filter)
      const local = branches === null ? [] : (branches.local ?? []).filter(matches)
      const remote = branches === null ? [] : (branches.remote ?? []).filter(matches).slice(0, 30)
      const tags = branches === null ? [] : (branches.tags ?? []).filter(matches).slice(0, 30)
      const current = repo === null ? null : (repo.detached === true ? null : repo.branch)
      const pending = snapshot.pending
      const remoteConfirm = typeof snapshot.confirmBranch === 'string' && snapshot.confirmBranch.startsWith('remote:')
        ? snapshot.confirmBranch.slice('remote:'.length)
        : null

      const onPick = (branch) => {
        if (sessionId === null || pending !== null) return
        void doSwitch(sessionId, branch.name)
      }

      return h('div', {
        ref: panelRef,
        className: 'dgd-panel',
        style: below
          ? { left: `${left}px`, top: `${panelTop}px`, width: `${width}px`, maxHeight: `${maxHeight}px` }
          : { left: `${left}px`, bottom: `${bottom}px`, width: `${width}px`, maxHeight: `${maxHeight}px` },
        role: 'dialog',
        'aria-modal': 'true',
        'aria-label': t('panel.title'),
      },
      h('div', { className: 'dgd-head' },
        h('span', { className: 'dgd-head-icon' }, h(BranchIcon, { size: 15 })),
        h('div', { className: 'dgd-head-text' },
          h('span', { className: 'dgd-head-title' }, repo === null ? t('panel.title') : (repo.detached === true ? t('chip.detached') : repo.branch ?? 'HEAD')),
          h('span', { className: 'dgd-head-sub' },
            repo === null
              ? ''
              : [repo.repoName, repo.changes.changed > 0 ? t('panel.dirty', { n: repo.changes.changed }) : ''].filter(Boolean).join(' · '))),
        h(React.Fragment, null,
          h('button', {
            type: 'button',
            className: 'dgd-icon-btn',
            title: t('tab.open'),
            'aria-label': t('tab.open'),
            onClick: () => openChangesTab(),
          }, h(ListIcon, null)),
          h('button', {
            type: 'button',
            className: 'dgd-icon-btn',
            title: t('panel.refresh'),
            'aria-label': t('panel.refresh'),
            disabled: pending !== null,
            onClick: () => {
              if (sessionId !== null) {
                void refreshRepo(sessionId, { silent: true })
                void loadBranches(sessionId)
              }
            },
          }, h(RefreshIcon, null)))),

      h('div', { className: 'dgd-search' },
        h('input', {
          ref: filterRef,
          className: 'dgd-input',
          value: snapshot.filter,
          placeholder: t('panel.search'),
          spellCheck: false,
          'aria-label': t('panel.search'),
          onChange: (event) => setState({ filter: event.target.value }),
          onKeyDown: (event) => {
            if (event.key !== 'Enter') return
            event.preventDefault()
            if (local.length > 0) onPick(local[0])
          },
        })),

      snapshot.actionError === null ? null : h('div', { className: 'dgd-error', role: 'alert' },
        h('div', null, t('panel.error'), '：', errorText(snapshot.actionError)),
        snapshot.actionError.message === '' ? null : h('div', { className: 'dgd-row-sub dgd-mono', style: { marginTop: '4px' } }, snapshot.actionError.message)),

      repo !== null && repo.running === true && snapshot.confirmBranch === null && snapshot.createOpen !== true ? h('div', { className: 'dgd-warn' }, t('panel.runningWarn')) : null,

      repo !== null && repo.operation !== 'none' && repo.operation !== 'merge' ? h('div', { className: 'dgd-warn' }, t('panel.operation', { op: opName(repo.operation) })) : null,

      repo !== null && repo.detached === true ? h('div', { className: 'dgd-warn' }, t('panel.detachedHint')) : null,

      remoteConfirm === null ? null : h('div', { className: 'dgd-warn' },
        h('div', null, t('panel.runningWarn')),
        h('div', { className: 'dgd-warn-actions' },
          h('button', { type: 'button', className: 'dgd-btn dgd-btn-ghost', onClick: () => setState({ confirmBranch: null }) }, t('panel.cancel')),
          h('button', {
            type: 'button',
            className: 'dgd-btn dgd-btn-primary',
            disabled: pending !== null,
            onClick: () => void doCheckout(sessionId, { kind: 'remote', name: remoteConfirm }),
          }, t('panel.runningConfirm')))),

      snapshot.tagConfirm === null ? null : h('div', { className: 'dgd-warn' },
        h('div', null, t('tag.confirm', { name: snapshot.tagConfirm })),
        h('div', { className: 'dgd-warn-actions' },
          h('button', { type: 'button', className: 'dgd-btn dgd-btn-ghost', onClick: () => setState({ tagConfirm: null }) }, t('panel.cancel')),
          h('button', {
            type: 'button',
            className: 'dgd-btn',
            onClick: () => setState({ createOpen: true, createFrom: snapshot.tagConfirm, tagConfirm: null }),
          }, t('panel.createFrom')),
          h('button', {
            type: 'button',
            className: 'dgd-btn dgd-btn-primary',
            disabled: pending !== null,
            onClick: () => void doCheckout(sessionId, { kind: 'tag', name: snapshot.tagConfirm }),
          }, t('tag.confirmYes')))),

      h('div', { className: 'dgd-body' },
        [
            snapshot.branchesStatus === 'loading' && branches === null
              ? h('div', { className: 'dgd-empty' }, t('panel.loading'))
              : null,
            snapshot.branchesStatus === 'error'
              ? h('div', { className: 'dgd-empty' }, errorText(snapshot.branchesError))
              : null,
            local.length === 0 && remote.length === 0 && snapshot.branchesStatus === 'ready'
              ? h('div', { className: 'dgd-empty' }, t('panel.empty'))
              : null,
            ...local.map((branch) => {
              const isConfirm = snapshot.confirmBranch === branch.name
              if (isConfirm) {
                return h('div', { key: `confirm-${branch.name}`, className: 'dgd-warn' },
                  h('div', null, t('panel.runningWarn')),
                  h('div', { className: 'dgd-warn-actions' },
                    h('button', { type: 'button', className: 'dgd-btn dgd-btn-ghost', onClick: () => setState({ confirmBranch: null }) }, t('panel.cancel')),
                    h('button', { type: 'button', className: 'dgd-btn dgd-btn-primary', onClick: () => void doSwitch(sessionId, branch.name), disabled: pending !== null }, t('panel.runningConfirm'))))
              }
              return h(BranchRow, {
                key: `local-${branch.name}`,
                branch,
                disabled: pending !== null,
                pending: snapshot.pendingBranch === branch.name,
                onPick: () => onPick(branch),
              })
            }),
            remote.length === 0 ? null : h('div', { className: 'dgd-section' }, `${t('panel.remoteHint')} (${remote.length})`),
            ...(remote.length === 0 ? [] : remote.map((branch) => h(RemoteRow, {
              key: `remote-${branch.name}`,
              branch,
              disabled: pending !== null,
              onPick: () => {
                void doCheckout(sessionId, { kind: 'remote', name: branch.name })
              },
              onCreateFrom: () => setState({ createOpen: true, createFrom: branch.name, actionError: null }),
            }))),
            tags.length === 0 ? null : h('div', { className: 'dgd-section' }, `${t('panel.tags')} (${tags.length})`),
            ...(tags.length === 0 ? [] : tags.map((tag) => h(TagRow, {
              key: `tag-${tag.name}`,
              tag,
              onPick: () => setState({ tagConfirm: tag.name, actionError: null }),
              onCreateFrom: () => setState({ createOpen: true, createFrom: tag.name, tagConfirm: null, actionError: null }),
            }))),
          ].filter((node) => node !== null && node !== undefined)),

      h('div', { className: 'dgd-foot' },
        snapshot.createOpen === true
          ? h(CreateForm, {
            pending,
            initialFrom: snapshot.createFrom,
            running: repo !== null && repo.running === true,
            confirmCreate: snapshot.confirmCreate === true,
            currentBranch: current,
            onCreate: (name, from) => {
              if (sessionId !== null) void doCreate(sessionId, name, from)
            },
            onCancel: () => setState({ createOpen: false, confirmCreate: false, actionError: null }),
          })
          : h('button', {
            type: 'button',
            className: 'dgd-btn dgd-btn-ghost',
            style: { display: 'inline-flex', alignItems: 'center', gap: '6px', justifyContent: 'flex-start' },
            onClick: () => setState({ createOpen: true, confirmCreate: false, actionError: null }),
            disabled: repo === null || repo.operation !== 'none' || pending !== null,
          }, h(PlusIcon, null), t('panel.newBranch'))))
    }

    // ── Merge picker overlay (floating dropdown) ──────────────────────────

    function MergePicker() {
      useLang()
      const snapshot = useMergeStore()
      const panelRef = React.useRef(null)
      React.useEffect(() => {
        ensureStyle()
      }, [])
      React.useEffect(() => {
        if (snapshot.open !== true) return undefined
        // A repository change (e.g. a branch switch elsewhere) invalidates the picker.
        return onRepoChanged(() => closeMergePicker())
      }, [snapshot.open])
      React.useEffect(() => {
        if (snapshot.open !== true) return undefined
        const onPointerDown = (event) => {
          const node = panelRef.current
          if (node !== null && node.contains(event.target)) return
          const target = event.target
          if (target !== null && typeof target.closest === 'function'
            && (target.closest(`[${CHIP_ATTR}]`) !== null || target.closest('[data-dsh-git-dock-merge]') !== null)) return
          closeMergePicker()
        }
        const onKeyDown = (event) => {
          if (event.key !== 'Escape') return
          event.stopPropagation()
          closeMergePicker()
        }
        const onResize = () => closeMergePicker()
        document.addEventListener('mousedown', onPointerDown, true)
        document.addEventListener('keydown', onKeyDown, true)
        window.addEventListener('resize', onResize)
        return () => {
          document.removeEventListener('mousedown', onPointerDown, true)
          document.removeEventListener('keydown', onKeyDown, true)
          window.removeEventListener('resize', onResize)
        }
      }, [snapshot.open])

      if (snapshot.open !== true || snapshot.anchor === null) return null
      const viewportWidth = typeof window === 'undefined' ? 0 : window.innerWidth
      const viewportHeight = typeof window === 'undefined' ? 0 : window.innerHeight
      const width = Math.max(260, Math.min(360, viewportWidth - 16))
      const left = Math.max(8, Math.min(snapshot.anchor.left, viewportWidth - width - 8))
      const below = snapshot.anchor.placement === 'below'
      const panelTop = Math.max(8, snapshot.anchor.bottom + 8)
      const bottom = Math.max(8, viewportHeight - snapshot.anchor.top + 8)
      const maxHeight = below
        ? Math.min(440, Math.max(200, viewportHeight - snapshot.anchor.bottom - 24))
        : Math.min(440, Math.max(200, snapshot.anchor.top - 24))
      const repo = snapshot.repo
      const currentBranch = repo === null || repo === undefined
        ? 'HEAD'
        : repo.detached === true ? `${t('chip.detached')} ${(repo.head ?? '').slice(0, 7)}` : repo.branch ?? 'HEAD'

      const listBody = snapshot.status === 'loading'
        ? h('div', { className: 'dgd-empty' }, t('panel.loading'))
        : snapshot.status === 'error'
          ? h('div', { className: 'dgd-empty' }, errorText(snapshot.error))
          : (snapshot.branches === null || snapshot.branches.length === 0)
            ? h('div', { className: 'dgd-empty' }, t('panel.empty'))
            : snapshot.branches.map((branch) => h('div', {
              key: branch.name,
              className: 'dgd-row',
              role: 'button',
              tabIndex: 0,
              title: `${branch.name} · ${new Date(branch.committedAt ?? Date.now()).toLocaleString()}`,
              onClick: () => chooseMergeTarget(branch),
              onKeyDown: (event) => {
                if (event.key === 'Enter' || event.key === ' ') {
                  event.preventDefault()
                  chooseMergeTarget(branch)
                }
              },
            },
            h('span', { className: 'dgd-row-icon' }, h(BranchIcon, { size: 12 })),
            h('span', { className: 'dgd-row-main' },
              h('span', { className: 'dgd-row-name' }, branch.name),
              h('span', { className: 'dgd-row-sub' }, [branch.author, branch.sha, timeAgo(branch.committedAt)].filter((value) => value !== undefined && value !== '').join(' · ')))))

      const preview = snapshot.preview
      const confirmBody = h('div', null,
        h('div', { className: 'dgd-mode' },
          ['no-ff', 'ff-only', 'squash'].map((mode) => h('button', {
            key: mode,
            type: 'button',
            className: 'dgd-btn',
            'data-active': snapshot.mode === mode ? 'true' : 'false',
            onClick: () => setMergeMode(mode),
          }, t(`merge.mode.${mode}`)))),
        h('div', { className: 'dgd-row-sub' }, t(`merge.modeHint.${snapshot.mode}`)),
        snapshot.previewStatus === 'loading'
          ? h('div', { className: 'dgd-row-sub', style: { marginTop: '6px' } }, t('panel.loading'))
          : snapshot.previewStatus === 'error'
            ? h('div', { className: 'dgd-error', style: { margin: '8px 0' } }, errorText(snapshot.previewError))
            : preview === null
              ? null
              : h('div', null,
                h('div', { className: 'dgd-row-sub', style: { marginTop: '6px' } }, t(`merge.kind.${preview.kind}`)),
                preview.kind === 'up-to-date'
                  ? null
                  : h('div', { className: 'dgd-row-sub' }, t('merge.summary', {
                    files: preview.fileCount,
                    add: preview.additions,
                    del: preview.deletions,
                  })),
                preview.conflicts.length > 0
                  ? h('div', { className: 'dgd-row-sub', style: { color: 'var(--dsw-alias-state-warn-primary)' } }, t('merge.conflictsPreview', { n: preview.conflicts.length }))
                  : null,
                repo !== null && repo !== undefined && repo.changes !== undefined && repo.changes.changed > 0
                  ? h('div', { className: 'dgd-row-sub' }, t('merge.dirtyWarn'))
                  : null,
                repo !== null && repo !== undefined && repo.running === true
                  ? h('div', { className: 'dgd-row-sub', style: { color: 'var(--dsw-alias-state-warn-primary)' } }, t('merge.runningWarn'))
                  : null),
        snapshot.actionError === null ? null : h('div', { className: 'dgd-error', style: { margin: '8px 0' } }, errorText(snapshot.actionError)),
        h('div', { className: 'dgd-warn-actions' },
          h('button', {
            type: 'button',
            className: 'dgd-btn dgd-btn-ghost',
            disabled: snapshot.pending,
            onClick: closeMergePicker,
          }, t('panel.cancel')),
          h('button', {
            type: 'button',
            className: 'dgd-btn dgd-btn-primary',
            disabled: snapshot.pending || snapshot.previewStatus !== 'ready' || preview === null || preview.kind === 'up-to-date',
            onClick: () => void applyMergeFromPicker(),
          }, snapshot.pending ? t('merge.applying') : t('merge.apply'))))

      return h('div', {
        ref: panelRef,
        className: 'dgd-panel',
        style: below
          ? { left: `${left}px`, top: `${panelTop}px`, width: `${width}px`, maxHeight: `${maxHeight}px` }
          : { left: `${left}px`, bottom: `${bottom}px`, width: `${width}px`, maxHeight: `${maxHeight}px` },
        role: 'dialog',
        'aria-label': t('merge.title', { source: snapshot.target === null ? '' : snapshot.target.source }),
      },
      h('div', { className: 'dgd-head' },
        h('span', { className: 'dgd-head-icon' }, h(MergeIcon, null)),
        h('div', { className: 'dgd-head-text' },
          h('span', { className: 'dgd-head-title' }, snapshot.target === null ? t('merge.pick') : t('merge.title', { source: snapshot.target.source })),
          h('span', { className: 'dgd-head-sub' }, `${t('tab.branch')}: ${currentBranch}`))),
      h('div', { className: 'dgd-body' }, snapshot.target === null ? listBody : confirmBody))
    }

    // ── Comparison-base picker overlay ─────────────────────────────────────

    function BasePicker() {
      useLang()
      const snapshot = useBaseStore()
      const panelRef = React.useRef(null)
      React.useEffect(() => {
        ensureStyle()
      }, [])
      React.useEffect(() => {
        if (snapshot.open !== true) return undefined
        // A repository change makes the candidate list stale.
        return onRepoChanged(() => closeBasePicker())
      }, [snapshot.open])
      React.useEffect(() => {
        if (snapshot.open !== true) return undefined
        const onPointerDown = (event) => {
          const node = panelRef.current
          if (node !== null && node.contains(event.target)) return
          const target = event.target
          if (target !== null && typeof target.closest === 'function'
            && (target.closest(`[${CHIP_ATTR}]`) !== null
              || target.closest('[data-dsh-git-dock-merge]') !== null
              || target.closest('[data-dsh-git-dock-base]') !== null)) return
          closeBasePicker()
        }
        const onKeyDown = (event) => {
          if (event.key !== 'Escape') return
          event.stopPropagation()
          closeBasePicker()
        }
        const onResize = () => closeBasePicker()
        document.addEventListener('mousedown', onPointerDown, true)
        document.addEventListener('keydown', onKeyDown, true)
        window.addEventListener('resize', onResize)
        return () => {
          document.removeEventListener('mousedown', onPointerDown, true)
          document.removeEventListener('keydown', onKeyDown, true)
          window.removeEventListener('resize', onResize)
        }
      }, [snapshot.open])

      if (snapshot.open !== true || snapshot.anchor === null) return null
      const viewportWidth = typeof window === 'undefined' ? 0 : window.innerWidth
      const viewportHeight = typeof window === 'undefined' ? 0 : window.innerHeight
      const width = Math.max(260, Math.min(360, viewportWidth - 16))
      const left = Math.max(8, Math.min(snapshot.anchor.left, viewportWidth - width - 8))
      const below = snapshot.anchor.placement === 'below'
      const panelTop = Math.max(8, snapshot.anchor.bottom + 8)
      const bottom = Math.max(8, viewportHeight - snapshot.anchor.top + 8)
      const maxHeight = below
        ? Math.min(440, Math.max(200, viewportHeight - snapshot.anchor.bottom - 24))
        : Math.min(440, Math.max(200, snapshot.anchor.top - 24))

      const body = snapshot.status === 'loading'
        ? h('div', { className: 'dgd-empty' }, t('panel.loading'))
        : snapshot.status === 'error'
          ? h('div', { className: 'dgd-empty' }, errorText(snapshot.error))
          : (snapshot.candidates === null || snapshot.candidates.length === 0)
            ? h('div', { className: 'dgd-empty' }, t('panel.empty'))
            : snapshot.candidates.map((candidate) => h('div', {
              key: candidate.name,
              className: 'dgd-row',
              'data-current': candidate.name === snapshot.current ? 'true' : 'false',
              role: 'button',
              tabIndex: 0,
              title: candidate.name,
              onClick: () => chooseBase(candidate.name),
              onKeyDown: (event) => {
                if (event.key === 'Enter' || event.key === ' ') {
                  event.preventDefault()
                  chooseBase(candidate.name)
                }
              },
            },
            h('span', { className: 'dgd-row-icon' }, candidate.name === snapshot.current ? h(CheckIcon, null) : h(BranchIcon, { size: 12 })),
            h('span', { className: 'dgd-row-main' },
              h('span', { className: 'dgd-row-name' }, candidate.name),
              h('span', { className: 'dgd-row-sub' }, [candidate.author, candidate.sha, timeAgo(candidate.committedAt)].filter((value) => value !== undefined && value !== '').join(' · '))),
            candidate.name === snapshot.current ? h('span', { className: 'dgd-row-trail' }, '✓') : null))

      return h('div', {
        ref: panelRef,
        className: 'dgd-panel',
        style: below
          ? { left: `${left}px`, top: `${panelTop}px`, width: `${width}px`, maxHeight: `${maxHeight}px` }
          : { left: `${left}px`, bottom: `${bottom}px`, width: `${width}px`, maxHeight: `${maxHeight}px` },
        role: 'dialog',
        'aria-label': t('tab.base'),
      },
      h('div', { className: 'dgd-head' },
        h('span', { className: 'dgd-head-icon' }, h(BranchIcon, { size: 15 })),
        h('div', { className: 'dgd-head-text' },
          h('span', { className: 'dgd-head-title' }, t('tab.base')),
          h('span', { className: 'dgd-head-sub' }, t('tab.baseHint')))),
      h('div', { className: 'dgd-body' }, body))
    }

    // ── Commit-message model picker overlay ────────────────────────────────

    function ModelPicker() {
      useLang()
      const snapshot = useModelStore()
      const panelRef = React.useRef(null)
      const [submenu, setSubmenu] = React.useState(null)
      React.useEffect(() => {
        ensureStyle()
      }, [])
      React.useEffect(() => {
        setSubmenu(null)
      }, [snapshot.open])
      React.useEffect(() => {
        if (snapshot.open !== true) return undefined
        const onPointerDown = (event) => {
          const node = panelRef.current
          if (node !== null && node.contains(event.target)) return
          const target = event.target
          if (target !== null && typeof target.closest === 'function'
            && (target.closest(`[${CHIP_ATTR}]`) !== null
              || target.closest('[data-dsh-git-dock-merge]') !== null
              || target.closest('[data-dsh-git-dock-base]') !== null
              || target.closest('[data-dsh-git-dock-model]') !== null)) return
          closeModelPicker()
        }
        const onKeyDown = (event) => {
          if (event.key !== 'Escape') return
          event.stopPropagation()
          closeModelPicker()
        }
        const onResize = () => closeModelPicker()
        document.addEventListener('mousedown', onPointerDown, true)
        document.addEventListener('keydown', onKeyDown, true)
        window.addEventListener('resize', onResize)
        return () => {
          document.removeEventListener('mousedown', onPointerDown, true)
          document.removeEventListener('keydown', onKeyDown, true)
          window.removeEventListener('resize', onResize)
        }
      }, [snapshot.open])

      if (snapshot.open !== true || snapshot.anchor === null) return null
      const viewportWidth = typeof window === 'undefined' ? 0 : window.innerWidth
      const viewportHeight = typeof window === 'undefined' ? 0 : window.innerHeight
      const width = Math.max(240, Math.min(320, viewportWidth - 16))
      const left = Math.max(8, Math.min(snapshot.anchor.left, viewportWidth - width - 8))
      const below = snapshot.anchor.placement === 'below'
      const panelTop = Math.max(8, snapshot.anchor.bottom + 8)
      const bottom = Math.max(8, viewportHeight - snapshot.anchor.top + 8)
      const maxHeight = below
        ? Math.min(420, Math.max(200, viewportHeight - snapshot.anchor.bottom - 24))
        : Math.min(420, Math.max(200, snapshot.anchor.top - 24))

      const options = snapshot.options
      const flat = []
      if (options !== null) {
        for (const provider of options.providers ?? []) {
          for (const model of provider.models ?? []) {
            flat.push({
              provider: provider.provider,
              providerName: provider.name ?? provider.provider,
              model: model.model,
              name: model.name ?? model.model,
              efforts: model.efforts ?? [],
            })
          }
        }
      }
      const conversationCurrent = options === null || options.current === null || options.current === undefined
        ? null
        : {
          provider: options.current.provider,
          model: options.current.model,
          name: (flat.find((entry) => entry.provider === options.current.provider && entry.model === options.current.model) ?? { name: options.current.model }).name,
          efforts: (flat.find((entry) => entry.provider === options.current.provider && entry.model === options.current.model) ?? { efforts: [] }).efforts,
        }
      const selectedModel = snapshot.choice === null
        ? null
        : flat.find((entry) => entry.provider === snapshot.choice.provider && entry.model === snapshot.choice.model) ?? {
          provider: snapshot.choice.provider,
          model: snapshot.choice.model,
          name: snapshot.choice.model,
          efforts: [],
        }
      const active = selectedModel ?? conversationCurrent
      const activeEffortId = snapshot.choice !== null
        ? snapshot.choice.reasoningEffort ?? null
        : options !== null && options.current !== null && options.current !== undefined
          ? options.current.reasoningEffort ?? null
          : null
      const effortLabel = (id) => {
        if (id === null || id === undefined || id === '') return t('commit.effortAuto')
        const effort = (active?.efforts ?? []).find((entry) => entry.id === id)
        return effort === undefined ? id : effort.name
      }
      const followBase = conversationCurrent === null
        ? null
        : { provider: conversationCurrent.provider, model: conversationCurrent.model, reasoningEffort: null }
      const pickFollow = () => {
        setModelState({ choice: null })
        if (typeof snapshot.onApply === 'function') snapshot.onApply(null)
        setSubmenu(null)
      }
      const pickModel = (entry) => {
        const keepEffort = snapshot.choice !== null && snapshot.choice.provider === entry.provider && snapshot.choice.model === entry.model
          ? snapshot.choice.reasoningEffort
          : null
        pickModelInPanel({ provider: entry.provider, model: entry.model, reasoningEffort: keepEffort })
        setSubmenu(null)
      }
      const pickEffort = (id) => {
        const base = snapshot.choice ?? followBase
        if (base === null) return
        pickModelInPanel(Object.assign({}, base, { reasoningEffort: id }))
        setSubmenu(null)
      }

      const headerRow = (label, value, open, onActivate) => h('div', {
        className: 'gdt-mp-row',
        role: 'button',
        tabIndex: 0,
        'aria-expanded': open ? 'true' : 'false',
        onClick: onActivate,
        onKeyDown: (event) => {
          if (event.key !== 'Enter' && event.key !== ' ') return
          event.preventDefault()
          onActivate()
        },
      },
      h('span', { className: 'gdt-mp-label' }, label),
      h('span', { className: 'gdt-mp-value' },
        h('span', { className: 'gdt-mp-text' }, value),
        h('span', { className: 'gdt-mp-caret' }, open ? '▴' : '▾')))

      const choiceRow = (key, label, selected, handle) => h('div', {
        key,
        className: 'gdt-mp-row',
        role: 'button',
        tabIndex: 0,
        'data-current': selected ? 'true' : 'false',
        onClick: handle,
        onKeyDown: (event) => {
          if (event.key !== 'Enter' && event.key !== ' ') return
          event.preventDefault()
          handle()
        },
      },
      h('span', { className: 'gdt-mp-label' }, label),
      selected ? h('span', { className: 'gdt-mp-check' }, '✓') : null)

      const modelChoices = [
        choiceRow('follow', t('commit.modelFollow'), snapshot.choice === null, pickFollow),
        ...flat.map((entry) => choiceRow(
          `model:${entry.provider}/${entry.model}`,
          entry.name,
          snapshot.choice !== null && snapshot.choice.provider === entry.provider && snapshot.choice.model === entry.model,
          () => pickModel(entry),
        )),
      ]
      const effortChoices = active === null
        ? [h('div', { key: 'effort-empty', className: 'dgd-empty' }, t('commit.modelUnavailable'))]
        : [
          choiceRow('effort:auto', t('commit.effortAuto'), activeEffortId === null, () => pickEffort(null)),
          ...(active.efforts ?? []).map((effort) => choiceRow(
            `effort:${effort.id}`,
            effort.name,
            activeEffortId === effort.id,
            () => pickEffort(effort.id),
          )),
        ]

      return h('div', {
        ref: panelRef,
        className: 'dgd-panel',
        style: below
          ? { left: `${left}px`, top: `${panelTop}px`, width: `${width}px`, maxHeight: `${maxHeight}px` }
          : { left: `${left}px`, bottom: `${bottom}px`, width: `${width}px`, maxHeight: `${maxHeight}px` },
        role: 'dialog',
        'aria-label': t('commit.modelTitle'),
      },
      h('div', { className: 'dgd-body' },
        options === null
          ? h('div', { className: 'dgd-empty' }, t('commit.modelBusy'))
          : h('div', null,
            headerRow(t('commit.modelTitle'), active === null ? t('commit.modelBusy') : active.name, submenu === 'model', () => setSubmenu(submenu === 'model' ? null : 'model')),
            submenu === 'model' ? h('div', { className: 'gdt-mp-list' }, modelChoices) : null,
            headerRow(t('commit.effort'), active === null ? '' : effortLabel(activeEffortId), submenu === 'effort', () => setSubmenu(submenu === 'effort' ? null : 'effort')),
            submenu === 'effort' ? h('div', { className: 'gdt-mp-list' }, effortChoices) : null)))
    }

    // ── Changes tab (sidebar.right.pane.tab) ──────────────────────────────

    /** Open this plugin's review tab in the session's right sidebar. */
    function openChangesTab() {
      try {
        const sidebarRight = clientCtx === null ? undefined : clientCtx.get('sidebarRight')
        if (sidebarRight !== undefined && sidebarRight !== null && typeof sidebarRight.openTab === 'function') {
          sidebarRight.openTab(CHANGES_KIND)
        }
      } catch (error) {
        console.warn('[dsh-git-dock] could not open the changes tab', error)
      }
    }

    /** `@@ -a,b +c,d @@` label for one hunk. */
    function hunkLabel(hunk) {
      return `@@ -${hunk.oldStart},${hunk.oldLines} +${hunk.newStart},${hunk.newLines} @@`
    }

    /** Unified comparison rows. */
    function UnifiedDiff(props) {
      const rows = []
      props.hunks.forEach((hunk, hunkIndex) => {
        rows.push(h('div', { key: `hunk-${hunkIndex}`, className: 'gdt-hunk-head' }, hunkLabel(hunk)))
        hunk.lines.forEach((line, lineIndex) => {
          rows.push(h('div', {
            key: `line-${hunkIndex}-${lineIndex}`,
            className: 'gdt-line',
            'data-kind': line.kind,
            'data-wrap': props.wrap ? 'true' : 'false',
          },
          h('span', { className: 'gdt-no' }, line.oldNo === null ? '' : String(line.oldNo)),
          h('span', { className: 'gdt-no' }, line.newNo === null ? '' : String(line.newNo)),
          h('span', { className: 'gdt-sign' }, line.kind === ' ' ? '' : line.kind),
          h('span', { className: 'gdt-text' }, line.text)))
        })
      })
      return h(React.Fragment, null, rows)
    }

    /** One side-of-pair cell for the side-by-side viewer. */
    function sideCell(line, side, wrap) {
      if (line === null) {
        return h('div', { className: 'gdt-side-col gdt-side-line', 'data-kind': ' ' },
          h('span', { className: 'gdt-no' }, ''),
          h('span', { className: 'gdt-text' }, ''))
      }
      return h('div', {
        className: 'gdt-side-col gdt-side-line',
        'data-kind': line.kind,
        'data-wrap': wrap ? 'true' : 'false',
      },
      h('span', { className: 'gdt-no' }, String((side === 0 ? line.oldNo : line.newNo) ?? '')),
      h('span', { className: 'gdt-text' }, line.text))
    }

    /** Side-by-side comparison rows, deletions paired with additions. */
    function SideDiff(props) {
      const rows = []
      props.hunks.forEach((hunk, hunkIndex) => {
        rows.push(h('div', { key: `hunk-${hunkIndex}`, className: 'gdt-hunk-head' }, hunkLabel(hunk)))
        const pairs = []
        let index = 0
        while (index < hunk.lines.length) {
          const line = hunk.lines[index]
          if (line.kind === ' ') {
            pairs.push({ left: line, right: line })
            index += 1
            continue
          }
          const removed = []
          while (index < hunk.lines.length && hunk.lines[index].kind === '-') {
            removed.push(hunk.lines[index])
            index += 1
          }
          const added = []
          while (index < hunk.lines.length && hunk.lines[index].kind === '+') {
            added.push(hunk.lines[index])
            index += 1
          }
          const count = Math.max(removed.length, added.length)
          for (let pairIndex = 0; pairIndex < count; pairIndex += 1) {
            pairs.push({ left: removed[pairIndex] ?? null, right: added[pairIndex] ?? null })
          }
        }
        pairs.forEach((pair, pairIndex) => {
          rows.push(h('div', { key: `pair-${hunkIndex}-${pairIndex}`, className: 'gdt-side' },
            sideCell(pair.left, 0, props.wrap),
            sideCell(pair.right, 1, props.wrap)))
        })
      })
      return h(React.Fragment, null, rows)
    }

    /** The right-sidebar review surface: change list + one file's comparison. */
    function ChangesView(props) {
      useLang()
      const sessionId = typeof props.sessionId === 'string' ? props.sessionId : undefined
      const [scope, setScope] = React.useState('worktree')
      const [baseSel, setBaseSel] = React.useState(null)
      const [data, setData] = React.useState(null)
      const [status, setStatus] = React.useState('loading')
      const [error, setError] = React.useState(null)
      const [selected, setSelected] = React.useState(null)
      const [diff, setDiff] = React.useState(null)
      const [diffStatus, setDiffStatus] = React.useState('idle')
      const [diffError, setDiffError] = React.useState(null)
      const [view, setView] = React.useState('unified')
      const [wrap, setWrap] = React.useState(false)
      const [message, setMessage] = React.useState('')
      const [amend, setAmend] = React.useState(false)
      const [commitBusy, setCommitBusy] = React.useState(false)
      const [aiBusy, setAiBusy] = React.useState(false)
      const [modelOptions, setModelOptions] = React.useState(null)
      const [modelChoice, setModelChoice] = React.useState(readStoredModelChoice)
      const [commitHint, setCommitHint] = React.useState(null)
      const [commitLimit, setCommitLimit] = React.useState(500)
      const [showConfig, setShowConfig] = React.useState(false)
      const [configForm, setConfigForm] = React.useState(null)
      const [configBusy, setConfigBusy] = React.useState(false)
      const [configError, setConfigError] = React.useState(null)
      const [remoteBusy, setRemoteBusy] = React.useState(null)
      const [actionError, setActionError] = React.useState(null)
      const [notice, setNotice] = React.useState(null)
      const [discardTarget, setDiscardTarget] = React.useState(null)
      const [mergeBusy, setMergeBusy] = React.useState(null)
      const [mergeError, setMergeError] = React.useState(null)
      const [assistBusy, setAssistBusy] = React.useState(false)
      React.useEffect(() => {
        if (sessionId === undefined) return undefined
        let cancelled = false
        void (async () => {
          try {
            const value = await callApi('modelOptions', { sessionId })
            if (!cancelled) {
              setModelOptions(value)
              // A remembered route that no longer exists falls back to the conversation.
              setModelChoice((previous) => {
                if (previous === null) return previous
                const exists = (value.providers ?? []).some((provider) => provider.provider === previous.provider
                  && (provider.models ?? []).some((model) => model.model === previous.model))
                if (exists) return previous
                writeStoredModelChoice(null)
                return null
              })
            }
          } catch (thrown) {
            if (!cancelled) {
              setModelOptions({ providers: [], current: null, lastError: { code: thrown.code, message: thrown.message } })
            }
          }
        })()
        return () => {
          cancelled = true
        }
      }, [sessionId])
      const requestRef = React.useRef(0)
      const dataRef = React.useRef(null)
      const [reloadTick, setReloadTick] = React.useState(0)

      React.useEffect(() => {
        ensureStyle()
      }, [])

      const loadChanges = React.useCallback(async () => {
        if (sessionId === undefined) return
        const token = ++requestRef.current
        setStatus('loading')
        setError(null)
        try {
          const value = await callApi('changes', {
            sessionId,
            scope,
            base: scope === 'branch' && baseSel !== null ? baseSel : undefined,
          })
          if (token !== requestRef.current) return
          setData(value)
          dataRef.current = value
          setStatus('ready')
          setSelected((previous) => {
            const files = value.files ?? []
            if (previous !== null && files.some((file) => file.path === previous.path)) return previous
            return files.length === 0 ? null : { path: files[0].path, untracked: files[0].status === '?' }
          })
        } catch (thrown) {
          if (token !== requestRef.current) return
          if (thrown.code === 'same-base' && baseSel !== null) {
            // The checked-out branch became the comparison base: drop it.
            setBaseSel(null)
            return
          }
          setStatus('error')
          setError({ code: thrown.code, message: thrown.message })
        }
      }, [sessionId, scope, baseSel, reloadTick])

      React.useEffect(() => {
        void loadChanges()
      }, [loadChanges])

      React.useEffect(() => {
        if (sessionId === undefined) return undefined
        return onRepoChanged((changedSession) => {
          if (changedSession === sessionId) setReloadTick((tick) => tick + 1)
        })
      }, [sessionId])

      React.useEffect(() => {
        if (sessionId === undefined) return undefined
        let cancelled = false
        const tick = async () => {
          if (typeof document !== 'undefined' && document.visibilityState === 'hidden') return
          try {
            const value = await callApi('repo', { sessionId })
            if (cancelled) return
            const current = dataRef.current
            if (current === null || current.repo === null || current.repo === undefined) return
            const before = current.repo
            const after = value.repo
            const changed = before.branch !== after.branch
              || before.head !== after.head
              || before.operation !== after.operation
              || (before.changes === undefined ? 0 : before.changes.changed) !== (after.changes === undefined ? 0 : after.changes.changed)
              || (before.conflictPaths === undefined ? 0 : before.conflictPaths.length) !== (after.conflictPaths === undefined ? 0 : after.conflictPaths.length)
            if (changed) setReloadTick((tickValue) => tickValue + 1)
          } catch {
            // A transient poll failure is ignored; the next tick retries.
          }
        }
        const timer = setInterval(() => {
          void tick()
        }, 12_000)
        window.addEventListener('focus', tick)
        return () => {
          cancelled = true
          clearInterval(timer)
          window.removeEventListener('focus', tick)
        }
      }, [sessionId])

      React.useEffect(() => {
        if (sessionId === undefined || selected === null) {
          setDiff(null)
          setDiffStatus('idle')
          return undefined
        }
        let cancelled = false
        setDiffStatus('loading')
        setDiffError(null)
        void (async () => {
          try {
            const value = await callApi('diff', {
              sessionId,
              scope,
              base: scope === 'branch' && baseSel !== null ? baseSel : undefined,
              path: selected.path,
              untracked: selected.untracked === true,
            })
            if (cancelled) return
            setDiff(value)
            setDiffStatus('ready')
          } catch (thrown) {
            if (cancelled) return
            setDiffStatus('error')
            setDiffError({ code: thrown.code, message: thrown.message })
          }
        })()
        return () => {
          cancelled = true
        }
      }, [sessionId, scope, baseSel, selected, reloadTick])

      if (sessionId === undefined) return h('div', { className: 'gdt-empty' }, t('panel.noSession'))

      const files = data === null ? [] : data.files ?? []
      const additions = files.reduce((sum, file) => sum + (file.additions ?? 0), 0)
      const deletions = files.reduce((sum, file) => sum + (file.deletions ?? 0), 0)
      const summary = t('tab.summary', { files: files.length, add: additions, del: deletions })
      const commits = data !== null && scope === 'branch' && data.commits > 0 ? t('tab.commits', { n: data.commits }) : ''
      const baseValue = baseSel ?? (data === null ? '' : data.base ?? '')

      const pickFile = (file) => {
        setSelected({ path: file.path, untracked: file.status === '?' })
      }

      const reload = () => {
        setNotice(null)
        void loadChanges()
      }

      const resolveConflict = async (path) => {
        if (mergeBusy !== null) return
        setMergeBusy(path)
        setMergeError(null)
        try {
          await callApi('merge.resolve', { sessionId, path })
          reload()
          notifyRepoChanged(sessionId)
        } catch (thrown) {
          setMergeError({ code: thrown.code, message: thrown.message })
        } finally {
          setMergeBusy(null)
        }
      }

      const completeMergeNow = async () => {
        if (mergeBusy !== null) return
        setMergeBusy('complete')
        setMergeError(null)
        try {
          await callApi('merge.complete', { sessionId })
          reload()
          setNotice(t('merge.done', { source: '' }))
          notifyRepoChanged(sessionId)
        } catch (thrown) {
          setMergeError({ code: thrown.code, message: thrown.message })
        } finally {
          setMergeBusy(null)
        }
      }

      const abortMergeNow = async () => {
        if (mergeBusy !== null) return
        setMergeBusy('abort')
        setMergeError(null)
        try {
          await callApi('merge.abort', { sessionId })
          reload()
          notifyRepoChanged(sessionId)
        } catch (thrown) {
          setMergeError({ code: thrown.code, message: thrown.message })
        } finally {
          setMergeBusy(null)
        }
      }

      /** Ask the live model to resolve and stage every open conflict. */
      const notifyConflictSolve = async () => {
        if (assistBusy) return
        setAssistBusy(true)
        setMergeError(null)
        setActionError(null)
        try {
          const value = await callApi('merge.assist', { sessionId })
          reload()
          setNotice(t('merge.assisted', { n: value.conflicts.length }))
        } catch (thrown) {
          setMergeError({ code: thrown.code, message: thrown.message })
        } finally {
          setAssistBusy(false)
        }
      }

      const runAction = async (operation, done) => {
        setActionError(null)
        try {
          await operation()
          if (typeof done === 'function') setNotice(done())
          reload()
          notifyRepoChanged(sessionId)
        } catch (thrown) {
          setActionError({ code: thrown.code, message: thrown.message })
        }
      }

      const stagePaths = (paths, all) => runAction(
        () => callApi('stage', { sessionId, paths, all }),
        () => null,
      )

      const unstagePaths = (paths, all) => runAction(
        () => callApi('unstage', { sessionId, paths, all }),
        () => null,
      )

      const discardPaths = async () => {
        const paths = discardTarget
        setDiscardTarget(null)
        if (paths === null) return
        await runAction(
          () => callApi('discard', { sessionId, paths }),
          () => null,
        )
      }

      const commitNow = async (amendFlag) => {
        if (commitBusy) return
        setCommitBusy(true)
        setActionError(null)
        try {
          const value = await callApi('commit', { sessionId, message, amend: amendFlag })
          setMessage('')
          setAmend(false)
          setNotice(t(amendFlag ? 'commit.amended' : 'commit.done', { sha: value.commit.sha }))
          void loadChanges()
          notifyRepoChanged(sessionId)
        } catch (thrown) {
          setActionError({ code: thrown.code, message: thrown.message })
        } finally {
          setCommitBusy(false)
        }
      }

      const modelSelectionLabel = (() => {
        const flat = []
        for (const provider of modelOptions?.providers ?? []) {
          for (const model of provider.models ?? []) {
            flat.push({ provider: provider.provider, name: model.name ?? model.model, model: model.model, efforts: model.efforts ?? [] })
          }
        }
        const current = modelOptions?.current ?? null
        const active = modelChoice !== null
          ? modelChoice
          : current === null
            ? null
            : { provider: current.provider, model: current.model, reasoningEffort: current.reasoningEffort }
        if (active === null) return t('commit.modelBusy')
        const match = flat.find((entry) => entry.provider === active.provider && entry.model === active.model)
        const name = match === undefined ? active.model : match.name
        const effortId = active.reasoningEffort === null || active.reasoningEffort === undefined ? null : active.reasoningEffort
        const effortName = effortId === null
          ? null
          : (match?.efforts ?? []).find((effort) => effort.id === effortId)?.name ?? effortId
        const effort = effortName === null ? '' : ` · ${effortName}`
        return `${name}${effort}`
      })()

      const openCommitModelPicker = (event) => {
        if (modelOptions === null) return
        openModelPicker(event.currentTarget, modelOptions, modelChoice, (next) => {
          setModelChoice(next)
          writeStoredModelChoice(next)
        })
      }

      const draftMessage = async () => {
        if (aiBusy) return
        const currentFiles = dataRef.current === null ? [] : dataRef.current.files ?? []
        if (currentFiles.length === 0) {
          setNotice(t('commit.nothingToDraft'))
          return
        }
        setAiBusy(true)
        setActionError(null)
        try {
          const value = await callApi('commitMessage', {
            sessionId,
            language: currentLang(),
            ...(modelChoice === null
              ? {}
              : {
                provider: modelChoice.provider,
                model: modelChoice.model,
                ...(modelChoice.reasoningEffort === null ? {} : { reasoningEffort: modelChoice.reasoningEffort }),
              }),
          })
          setMessage(value.message)
          setCommitHint(value.conventions === undefined || value.conventions === null ? null : value.conventions.summary ?? null)
          if (value.conventions !== undefined && value.conventions !== null && typeof value.conventions.totalMaxLength === 'number') {
            setCommitLimit(value.conventions.totalMaxLength)
          }
        } catch (thrown) {
          setActionError({ code: thrown.code, message: thrown.message })
        } finally {
          setAiBusy(false)
        }
      }

      const openConventionConfig = async () => {
        setConfigError(null)
        try {
          const value = await callApi('convention', { sessionId })
          const source = value.saved !== null && value.saved !== undefined ? value.saved : value.effective
          setConfigForm({
            types: (source.types ?? []).join(', '),
            scopeRequired: source.scopeRequired === true,
            language: source.language === 'en' ? 'en' : 'zh',
            maxLength: source.maxLength === null || source.maxLength === undefined ? '' : String(source.maxLength),
            totalMaxLength: String(source.totalMaxLength ?? 500),
            vague: (source.vague ?? []).join(', '),
          })
          setShowConfig(true)
        } catch (thrown) {
          setActionError({ code: thrown.code, message: thrown.message })
        }
      }

      const saveConvention = async (reset) => {
        if (configBusy) return
        setConfigBusy(true)
        setConfigError(null)
        try {
          const request = reset === true
            ? { sessionId, reset: true }
            : {
              sessionId,
              commit: {
                types: configForm.types.split(',').map((type) => type.trim()).filter((type) => type !== ''),
                scopeRequired: configForm.scopeRequired === true,
                language: configForm.language,
                maxLength: configForm.maxLength.trim() === '' ? null : Number(configForm.maxLength),
                totalMaxLength: Number(configForm.totalMaxLength),
                vague: configForm.vague.split(',').map((term) => term.trim()).filter((term) => term !== ''),
              },
            }
          const value = await callApi('convention.save', request)
          setCommitLimit(typeof value.effective.totalMaxLength === 'number' ? value.effective.totalMaxLength : 500)
          setCommitHint(conventionSummary(value.effective))
          setShowConfig(false)
          setNotice(t(reset === true ? 'commit.resetDone' : 'commit.saved'))
          void loadChanges()
        } catch (thrown) {
          setConfigError({ code: thrown.code, message: thrown.message })
        } finally {
          setConfigBusy(false)
        }
      }

      const remoteAction = async (action) => {
        if (remoteBusy !== null) return
        setRemoteBusy(action)
        setActionError(null)
        try {
          if (action === 'fetch') {
            await callApi('fetch', { sessionId })
            setNotice(t('sync.fetched'))
            void loadChanges()
            notifyRepoChanged(sessionId)
          } else if (action === 'push') {
            const upstream = data !== null && data.repo !== null ? data.repo.upstream : null
            await callApi('push', { sessionId, setUpstream: upstream === null || upstream === undefined })
            setNotice(t('sync.pushed'))
            void loadChanges()
            notifyRepoChanged(sessionId)
          } else {
            if (message.trim() !== '' && (data === null || (data.repo?.changes?.staged ?? 0) > 0)) {
              await callApi('commit', { sessionId, message, amend: false })
              setMessage('')
            }
            await callApi('fetch', { sessionId })
            await callApi('pull', { sessionId })
            const fresh = await callApi('repo', { sessionId })
            await callApi('push', { sessionId, setUpstream: fresh.repo.upstream === null || fresh.repo.upstream === undefined })
            setNotice(t('sync.synced'))
            void loadChanges()
            notifyRepoChanged(sessionId)
          }
        } catch (thrown) {
          setActionError({ code: thrown.code, message: thrown.message })
        } finally {
          setRemoteBusy(null)
        }
      }

      const repoInfo = data === null ? null : data.repo
      const conflictPaths = repoInfo === null || repoInfo === undefined ? [] : repoInfo.conflictPaths ?? []
      const mergeInProgress = repoInfo !== null && repoInfo !== undefined && repoInfo.operation === 'merge'
      const hasConflicts = conflictPaths.length > 0
      const branchLabel = repoInfo === null || repoInfo === undefined
        ? ''
        : repoInfo.detached === true
          ? `${t('chip.detached')} ${(repoInfo.head ?? '').slice(0, 7)}`
          : repoInfo.branch ?? 'HEAD'
      const ahead = repoInfo === null || repoInfo === undefined ? 0 : repoInfo.ahead
      const behind = repoInfo === null || repoInfo === undefined ? 0 : repoInfo.behind
      const aheadBehind = [ahead > 0 ? `↑${ahead}` : '', behind > 0 ? `↓${behind}` : ''].filter((part) => part !== '').join(' ')
      const branchButton = h('button', {
        type: 'button',
        className: 'gdt-btn gdt-branch-btn',
        [CHIP_ATTR]: '1',
        title: t('tab.branchHint'),
        'aria-label': `${t('tab.branch')}: ${branchLabel}`,
        onClick: (event) => {
          openPanel(sessionId, event.currentTarget)
        },
      },
      h(BranchIcon, { size: 12 }),
      h('span', { className: 'gdt-branch-name' }, branchLabel),
      aheadBehind === '' ? null : h('span', { className: 'gdt-summary' }, aheadBehind))

      const scopeButtons = h('div', { className: 'gdt-tabs' },
        h('button', {
          type: 'button',
          className: 'gdt-tab',
          'data-active': scope === 'worktree' ? 'true' : 'false',
          onClick: () => {
            setScope('worktree')
            setBaseSel(null)
            setSelected(null)
          },
        }, t('tab.scope.worktree')),
        h('button', {
          type: 'button',
          className: 'gdt-tab',
          'data-active': scope === 'branch' ? 'true' : 'false',
          onClick: () => {
            setScope('branch')
            setSelected(null)
          },
        }, t('tab.scope.branch')))

      const baseButton = scope === 'branch' && data !== null && data.baseCandidates.length > 0
        ? h('button', {
          type: 'button',
          className: 'gdt-btn gdt-branch-btn',
          'data-dsh-git-dock-base': '1',
          title: t('tab.baseHint'),
          'aria-label': `${t('tab.base')}: ${baseValue}`,
          onClick: (event) => {
            openBasePicker(sessionId, event.currentTarget, data.baseCandidates, baseValue, (name) => {
              setBaseSel(name)
              setSelected(null)
            })
          },
        },
        h(BranchIcon, { size: 12 }),
        h('span', { className: 'gdt-branch-name' }, baseValue === '' ? '—' : baseValue),
        h('span', { className: 'gdt-caret' }, '▾'))
        : null

      const toolbar = h('div', { className: 'gdt-bar' },
        scopeButtons,
        scope === 'branch' ? branchButton : null,
        baseButton,
        h('span', { className: 'gdt-summary' },
          t('tab.summaryPrefix', { files: files.length }),
          h('span', { className: 'gdt-add' }, `+${additions}`),
          ' ',
          h('span', { className: 'gdt-del' }, `−${deletions}`),
          commits === '' ? null : ` · ${commits}`),
        h('span', { className: 'gdt-spacer' }),
        h('button', {
          type: 'button',
          className: 'gdt-btn',
          title: t('tab.refresh'),
          onClick: () => {
            void loadChanges()
          },
        }, h(RefreshIcon, { size: 12 }), t('tab.refresh')))

      const statusNodes = []
      if (status === 'error') {
        statusNodes.push(h('div', { key: 'error', className: 'gdt-error', role: 'alert' }, errorText(error)))
      }
      if (status === 'loading' && data === null) {
        statusNodes.push(h('div', { key: 'loading', className: 'gdt-note' }, t('tab.loading')))
      }
      if (status !== 'error' && data !== null && files.length === 0) {
        statusNodes.push(h('div', { key: 'empty', className: 'gdt-empty' },
          scope === 'branch' ? t('tab.emptyBranch', { base: data.base ?? '' }) : t('tab.empty')))
      }

      const stagedCount = files.filter((file) => file.staged === true).length
      const worktreeScope = scope === 'worktree'

      const toggleStage = (file) => {
        if (file.staged === true) void unstagePaths([file.path], false)
        else void stagePaths([file.path], false)
      }

      const fileRow = (file) => {
        const active = selected !== null && selected.path === file.path
        const counts = file.binary === true
          ? h('span', null, 'bin')
          : h(React.Fragment, null,
            h('span', { className: 'gdt-add' }, `+${file.additions ?? '?'}`),
            h('span', { className: 'gdt-del' }, `−${file.deletions ?? '?'}`))
        const label = file.origPath === null || file.origPath === undefined ? file.path : `${file.origPath} → ${file.path}`
        return h('div', {
          key: file.path,
          className: 'gdt-file',
          'data-active': active ? 'true' : 'false',
          role: 'button',
          tabIndex: 0,
          title: label,
          onClick: () => pickFile(file),
          onKeyDown: (event) => {
            if (event.key === 'Enter' || event.key === ' ') {
              event.preventDefault()
              pickFile(file)
            }
          },
        },
        worktreeScope
          ? h('input', {
            type: 'checkbox',
            className: 'gct-check',
            checked: file.staged === true,
            title: t('stage.checkbox'),
            'aria-label': t('stage.checkbox'),
            onClick: (event) => event.stopPropagation(),
            onChange: () => toggleStage(file),
          })
          : null,
        h('span', { className: 'gdt-status', 'data-status': file.status }, file.status),
        h('span', { className: 'gdt-path' }, file.path),
        h('span', { className: 'gdt-counts' }, counts),
        worktreeScope
          ? h('button', {
            type: 'button',
            className: 'gdt-btn',
            title: t('discard.action'),
            'aria-label': t('discard.action'),
            onClick: (event) => {
              event.stopPropagation()
              setDiscardTarget([file.path])
            },
          }, t('discard.action'))
          : null)
      }

      const fileList = files.length === 0 ? null : h('div', { className: 'gdt-files' },
        worktreeScope
          ? h('div', { className: 'gct-file-head' },
            h('span', { className: 'gdt-summary' }, t('commit.staged', { n: stagedCount })),
            h('span', { className: 'gdt-spacer' }),
            h('button', { type: 'button', className: 'gdt-btn', onClick: () => void stagePaths([], true) }, t('stage.all')),
            h('button', { type: 'button', className: 'gdt-btn', onClick: () => void unstagePaths([], true) }, t('unstage.all')))
          : null,
        files.map(fileRow))

      const configRow = (label, node) => h('label', { className: 'gct-config-row' },
        h('span', { className: 'gct-config-label' }, label),
        node)

      const configPanel = showConfig && configForm !== null ? h('div', { className: 'gct-config' },
        h('div', { className: 'gct-config-title' }, t('commit.configTitle')),
        configRow(t('commit.types'), h('input', {
          className: 'gdt-input',
          value: configForm.types,
          spellCheck: false,
          onChange: (event) => setConfigForm(Object.assign({}, configForm, { types: event.target.value })),
        })),
        h('div', { className: 'gct-config-row' },
          h('span', { className: 'gct-config-label' }, t('commit.scopeRequired')),
          h('input', {
            type: 'checkbox',
            className: 'gct-check',
            checked: configForm.scopeRequired,
            onChange: (event) => setConfigForm(Object.assign({}, configForm, { scopeRequired: event.target.checked })),
          }),
          h('span', { className: 'gdt-spacer' }),
          h('span', { className: 'gct-config-label' }, t('commit.language')),
          h('select', {
            className: 'gdt-select',
            value: configForm.language,
            'aria-label': t('commit.language'),
            onChange: (event) => setConfigForm(Object.assign({}, configForm, { language: event.target.value })),
          },
          h('option', { value: 'zh' }, t('commit.lang.zh')),
          h('option', { value: 'en' }, t('commit.lang.en')))),
        configRow(t('commit.maxLength'), h('input', {
          className: 'gdt-input',
          type: 'number',
          min: 20,
          max: 300,
          value: configForm.maxLength,
          onChange: (event) => setConfigForm(Object.assign({}, configForm, { maxLength: event.target.value })),
        })),
        configRow(t('commit.totalMaxLength'), h('input', {
          className: 'gdt-input',
          type: 'number',
          min: 100,
          max: 5000,
          value: configForm.totalMaxLength,
          onChange: (event) => setConfigForm(Object.assign({}, configForm, { totalMaxLength: event.target.value })),
        })),
        configRow(t('commit.vague'), h('input', {
          className: 'gdt-input',
          value: configForm.vague,
          spellCheck: false,
          onChange: (event) => setConfigForm(Object.assign({}, configForm, { vague: event.target.value })),
        })),
        configError === null ? null : h('div', { className: 'gdt-error', role: 'alert' }, errorText(configError)),
        h('div', { className: 'gct-actions' },
          h('button', { type: 'button', className: 'gdt-btn', disabled: configBusy, onClick: () => void saveConvention(true) }, t('commit.reset')),
          h('button', { type: 'button', className: 'gdt-btn', disabled: configBusy, onClick: () => setShowConfig(false) }, t('panel.cancel')),
          h('button', { type: 'button', className: 'gdt-btn', disabled: configBusy, onClick: () => void saveConvention(false) },
            configBusy ? t('sync.busy') : t('commit.save')))) : null

      const commitBar = worktreeScope
        ? (configPanel !== null ? configPanel : h('div', { className: 'gct-commit' },
          h('textarea', {
            className: 'gct-message',
            rows: 3,
            value: message,
            placeholder: t('commit.messagePlaceholder'),
            'aria-label': t('commit.messagePlaceholder'),
            onChange: (event) => setMessage(event.target.value),
            onKeyDown: (event) => {
              if (event.key === 'Enter' && (event.ctrlKey || event.metaKey)) {
                event.preventDefault()
                void commitNow(amend)
              }
            },
          }),
          h('div', { className: 'gct-commit-row' },
            h('button', {
              type: 'button',
              className: 'gdt-btn gdt-branch-btn gdt-model-btn',
              'data-dsh-git-dock-model': '1',
              title: t('commit.modelHint'),
              disabled: commitBusy || modelOptions === null,
              onClick: openCommitModelPicker,
            },
            h('span', { className: 'gdt-model-name' }, modelSelectionLabel),
            h('span', { className: 'gdt-caret' }, '▾')),
            h('button', {
              type: 'button',
              className: 'gdt-btn',
              disabled: aiBusy || commitBusy,
              title: t('commit.aiHint'),
              onClick: () => void draftMessage(),
            }, aiBusy ? t('commit.aiBusy') : t('commit.ai')),
            h('label', { className: 'gct-amend' },
              h('input', { type: 'checkbox', checked: amend, onChange: (event) => setAmend(event.target.checked) }),
              t('commit.amend')),
            h('span', {
              className: 'gdt-summary',
              style: message.length > commitLimit ? { color: 'var(--dsw-alias-state-error-primary)' } : undefined,
            }, t('commit.charCount', { n: message.length, max: commitLimit })),
            h('button', {
              type: 'button',
              className: 'gdt-btn',
              disabled: commitBusy,
              title: t('commit.configTitle'),
              onClick: () => void openConventionConfig(),
            }, t('commit.config')),
            h('span', { className: 'gdt-spacer' }),
            h('button', {
              type: 'button',
              className: 'gdt-btn',
              style: { background: 'var(--dsw-alias-button-primary-fill,var(--dsw-alias-brand-primary))', color: 'var(--dsw-alias-label-primary-foreground,#fff)' },
              disabled: commitBusy || message.trim() === '' || message.length > commitLimit || (stagedCount === 0 && amend !== true),
              onClick: () => void commitNow(amend),
            }, commitBusy ? t('commit.busy') : t('commit.submit'))),
          commitHint === null ? null : h('div', { className: 'gdt-summary', style: { fontSize: '11px' } }, t('commit.conventionHint', { summary: commitHint }))))
        : null

      const remoteBar = worktreeScope ? h('div', { className: 'gct-remote' },
        branchButton,
        h('span', { className: 'gdt-spacer' }),
        h('button', {
          type: 'button',
          className: 'gdt-btn',
          'data-dsh-git-dock-merge': '1',
          'data-active': hasConflicts ? 'true' : 'false',
          disabled: remoteBusy !== null || assistBusy || (mergeInProgress && !hasConflicts),
          onClick: (event) => {
            if (mergeInProgress) {
              void notifyConflictSolve()
              return
            }
            openMergePicker(sessionId, event.currentTarget, repoInfo)
          },
        }, mergeInProgress
          ? (assistBusy ? t('merge.assisting') : (hasConflicts ? t('merge.resolveAction') : t('merge.conflictsResolved')))
          : t('merge.button')),
        h('button', { type: 'button', className: 'gdt-btn', disabled: remoteBusy !== null, onClick: () => void remoteAction('fetch') },
          remoteBusy === 'fetch' ? t('sync.busy') : t('sync.fetch')),
        h('button', { type: 'button', className: 'gdt-btn', disabled: remoteBusy !== null, onClick: () => void remoteAction('push') },
          remoteBusy === 'push' ? t('sync.busy') : t('sync.push')),
        h('button', { type: 'button', className: 'gdt-btn', disabled: remoteBusy !== null, onClick: () => void remoteAction('sync') },
          remoteBusy === 'sync' ? t('sync.busy') : t('sync.sync'))) : null

      const conflictSection = repoInfo === null || repoInfo === undefined || repoInfo.operation !== 'merge' ? null : h('div', { className: 'gct-merge' },
        h('div', { className: 'gct-config-title' }, t('merge.openTitle', { n: conflictPaths.length })),
        conflictPaths.length === 0
          ? h('div', { className: 'gdt-note' }, t('merge.noConflicts'))
          : h('div', null, conflictPaths.map((path) => h('div', { key: path, className: 'gct-config-row' },
            h('span', { className: 'gdt-path', title: path }, path),
            h('button', {
              type: 'button',
              className: 'gdt-btn',
              disabled: mergeBusy !== null,
              onClick: () => void resolveConflict(path),
            }, t('merge.rowResolve'))))),
        mergeError === null ? null : h('div', { className: 'gdt-error', role: 'alert' }, errorText(mergeError)),
        h('div', { className: 'gct-actions' },
          h('button', { type: 'button', className: 'gdt-btn', disabled: mergeBusy !== null, onClick: () => void abortMergeNow() },
            mergeBusy === 'abort' ? t('merge.aborting') : t('merge.abort')),
          h('button', { type: 'button', className: 'gdt-btn', disabled: mergeBusy !== null || conflictPaths.length > 0, onClick: () => void completeMergeNow() },
            mergeBusy === 'complete' ? t('merge.completing') : t('merge.complete'))))

      const banners = [
        actionError === null ? null : h('div', { key: 'action-error', className: 'gdt-error', role: 'alert' }, errorText(actionError)),
        notice === null ? null : h('div', { key: 'notice', className: 'gdt-note' }, notice),
        repoInfo !== null && repoInfo !== undefined && repoInfo.operation !== 'none' && repoInfo.operation !== 'merge'
          ? h('div', { key: 'operation', className: 'gdt-note' }, t('panel.operation', { op: opName(repoInfo.operation) }))
          : null,
        discardTarget === null ? null : h('div', { key: 'discard', className: 'gdt-error', role: 'alert' },
          h('div', null, t('discard.confirm', { n: discardTarget.length })),
          h('div', { className: 'gct-actions' },
            h('button', { type: 'button', className: 'gdt-btn', onClick: () => setDiscardTarget(null) }, t('panel.cancel')),
            h('button', { type: 'button', className: 'gdt-btn', onClick: () => void discardPaths() }, t('discard.confirmYes')))),
      ].filter((node) => node !== null)

      const diffToolbar = selected === null ? null : h('div', { className: 'gdt-diff-bar' },
        h('span', { className: 'gdt-diff-path', title: selected.path }, selected.path),
        h('button', {
          type: 'button',
          className: 'gdt-btn',
          'data-active': view === 'unified' ? 'true' : 'false',
          onClick: () => setView('unified'),
        }, t('tab.unified')),
        h('button', {
          type: 'button',
          className: 'gdt-btn',
          'data-active': view === 'side' ? 'true' : 'false',
          onClick: () => setView('side'),
        }, t('tab.side')),
        h('button', {
          type: 'button',
          className: 'gdt-btn',
          'data-active': wrap ? 'true' : 'false',
          onClick: () => setWrap((value) => !value),
        }, t('tab.wrap')))

      let diffBody = null
      if (selected !== null) {
        if (diffStatus === 'loading') {
          diffBody = h('div', { className: 'gdt-note' }, t('tab.loading'))
        } else if (diffStatus === 'error') {
          diffBody = h('div', { className: 'gdt-error', role: 'alert' }, errorText(diffError))
        } else if (diff === null) {
          diffBody = null
        } else if (diff.binary === true) {
          diffBody = h('div', { className: 'gdt-note' }, t('tab.binary'))
        } else if (diff.hunks.length === 0) {
          diffBody = h('div', { className: 'gdt-note' }, t('tab.empty'))
        } else {
          diffBody = h('div', { className: 'gdt-scroll' },
            view === 'side' ? h(SideDiff, { hunks: diff.hunks, wrap }) : h(UnifiedDiff, { hunks: diff.hunks, wrap }),
            diff.truncated === true ? h('div', { className: 'gdt-note' }, t('tab.truncated')) : null)
        }
      }

      const diffPane = h('div', { className: 'gdt-diff' },
        selected === null ? h('div', { className: 'gdt-empty' }, t('tab.selectFile')) : diffToolbar,
        diffBody)

      return h('div', { className: 'gdt-root' },
        toolbar,
        commitBar,
        remoteBar,
        conflictSection,
        banners,
        h('div', { className: 'gdt-split' }, statusNodes, fileList, diffPane))
    }

    // ── Plugin entry ──────────────────────────────────────────────────────

    const exportsObject = {}

    exportsObject.inject = ['slots']

    /**
     * Register the two composer seats, the right-sidebar tab type, and its body.
     * The dock entry is the always-on chip; the overlay entry is the branch
     * panel, which must live outside the composer card.
     */
    exportsObject.apply = function apply(ctx) {
      try {
        const slots = typeof ctx.get === 'function' ? ctx.get('slots') : undefined
        if (slots === undefined || typeof slots.inject !== 'function' || typeof slots.register !== 'function') {
          console.warn('[dsh-git-dock] slots service unavailable; entries not registered')
          return
        }
        clientCtx = ctx
        localeService = typeof ctx.get === 'function' ? ctx.get('locale') ?? null : null
        if (localeService !== null && typeof localeService.register === 'function') {
          ctx.effect(() => {
            const offZh = localeService.register(NS, 'zh', DICT.zh)
            const offEn = localeService.register(NS, 'en', DICT.en)
            return () => {
              if (typeof offZh === 'function') offZh()
              if (typeof offEn === 'function') offEn()
            }
          }, 'dsh-git-dock: dictionaries')
        }

        slots.inject('conversation.composer.dock', () => slots.register({
          name: 'conversation.composer.dock',
          id: 'git-dock',
          order: -1,
        }, Chip))

        slots.inject('shell.overlay', () => slots.register({
          name: 'shell.overlay',
          id: 'git-dock-panel',
          order: 100,
        }, Panel))

        slots.inject('shell.overlay', () => slots.register({
          name: 'shell.overlay',
          id: 'git-dock-merge',
          order: 101,
        }, MergePicker))

        slots.inject('shell.overlay', () => slots.register({
          name: 'shell.overlay',
          id: 'git-dock-base',
          order: 102,
        }, BasePicker))

        slots.inject('shell.overlay', () => slots.register({
          name: 'shell.overlay',
          id: 'git-dock-model',
          order: 103,
        }, ModelPicker))

        // The review surface is a native right-sidebar tab type. The type and
        // its body are two registrations under the SAME id, and the guide entry
        // makes the page discoverable without opening the branch panel first.
        slots.inject('sidebar.right.pane.tab', () => slots.register({
          name: 'sidebar.right.pane.tab',
          key: CHANGES_TAB_ID,
        }, ChangesView))

        ctx.inject(['sidebarRightTabs'], (injected) => {
          injected.effect(() => {
            const tabs = injected.get('sidebarRightTabs')
            if (tabs === undefined || tabs === null || typeof tabs.register !== 'function') return undefined
            return tabs.register({
              id: CHANGES_TAB_ID,
              kind: CHANGES_KIND,
              priority: 'extension',
              title: () => t('tab.title'),
              guide: [{ id: 'changes', order: 40, title: () => t('tab.title') }],
            })
          }, 'dsh-git-dock: changes tab type')
        })
      } catch (error) {
        console.warn('[dsh-git-dock] failed to register entries', error)
      }
    }

    return exportsObject
  },
})
