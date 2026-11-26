/**
 * Standalone smoke test for dsh-git-dock's Host half.
 *
 * Drives the registered route handler with a mocked Cordis context and a real
 * temporary git repository, so the porcelain parser, branch listing, switch,
 * create and every guard are exercised without booting DSH.
 *
 * Usage: npm test   (node test/smoke.mjs)
 */
import { execFileSync } from 'node:child_process'
import { EventEmitter } from 'node:events'
import { appendFileSync, existsSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const PLUGIN = new URL('../index.js', import.meta.url).href
const SESSION = 'session-smoke'

const failures = []

// Isolate the plugin-owned convention store from the real DSH home.
const SMOKE_DSH_HOME = mkdtempSync(join(tmpdir(), 'dgd-home-'))
process.env.DSH_HOME = SMOKE_DSH_HOME

function check(name, condition, extra) {
  if (condition) {
    console.log(`  ok   ${name}`)
  } else {
    console.log(`  FAIL ${name}${extra === undefined ? '' : ` -> ${JSON.stringify(extra)}`}`)
    failures.push(name)
  }
}

function git(cwd, ...args) {
  return execFileSync('git', args, { cwd, encoding: 'utf8' }).trim()
}

/** Create a repository with `main` and one feature branch. */
function makeRepo() {
  const dir = mkdtempSync(join(tmpdir(), 'dgd-'))
  git(dir, 'init', '-q', '-b', 'main')
  git(dir, 'config', 'user.email', 'smoke@test.local')
  git(dir, 'config', 'user.name', 'smoke')
  writeFileSync(join(dir, 'a.txt'), 'a\n')
  git(dir, 'add', 'a.txt')
  git(dir, 'commit', '-qm', 'first')
  git(dir, 'switch', '-qc', 'feature-1')
  writeFileSync(join(dir, 'b.txt'), 'b\n')
  git(dir, 'add', 'b.txt')
  git(dir, 'commit', '-qm', 'second')
  git(dir, 'switch', '-q', 'main')
  writeFileSync(join(dir, 'dirty.txt'), 'dirty\n')
  return dir
}

/** Mock Cordis context with just the services the Host half reads. */
function makeContext(cwd, state) {
  const handlers = new Map()
  const tools = []
  const agents = {
    turnBoundaryOf: () => ({ openTurnStartSeq: state.running ? 1 : null }),
    get: (id) => (id === SESSION
      ? { followup: async (message) => { agentPrompts.push(message) } }
      : undefined),
  }
  const agentPrompts = []
  const toolsService = {
    register(definition) {
      tools.push(definition)
      return () => {
        const index = tools.indexOf(definition)
        if (index >= 0) tools.splice(index, 1)
      }
    },
  }
  const llm = {
    script: [],
    calls: [],
    stream(options) {
      llm.calls.push(options)
      const text = llm.script.length > 0 ? llm.script.shift() : 'feat(core): 新增测试功能'
      return (async function* chunks() {
        yield { type: 'text-delta', index: 0, text }
        yield { type: 'finish', reason: { kind: 'stop' } }
      })()
    },
    listProviders() {
      return [
        {
          provider: 'mock',
          name: 'Mock',
          models: undefined,
        },
      ]
    },
    listModels(provider) {
      if (provider !== 'mock') return []
      return [
        {
          id: 'mock',
          name: 'Mock Chat',
          reasoning: { efforts: [{ id: 'low', name: 'Low' }, { id: 'high', name: 'High' }] },
        },
      ]
    },
    async resolveModelInfo(provider, model) {
      if (provider !== 'mock' || model !== 'mock') throw new Error('unknown model')
      return {
        provider,
        id: model,
        name: 'Mock Chat',
        reasoning: { efforts: [{ id: 'low', name: 'Low' }, { id: 'high', name: 'High' }], defaultEffort: 'low' },
      }
    },
  }
  const ctx = {
    sessions: {
      get: (id) => (id === SESSION
        ? { header: { cwd }, requestContext: () => ({ provider: 'mock', model: 'mock' }) }
        : undefined),
    },
    get(name) {
      if (name === 'workingDirectory') return { get: () => cwd }
      if (name === 'connection') return { requestRejection: () => undefined }
      if (name === 'agents') return agents
      if (name === 'tools') return toolsService
      if (name === 'llm') return llm
      return undefined
    },
    inject(_deps, callback) {
      callback({
        effect: (factory) => factory(),
        get: (name) => (name === 'tools' ? toolsService : undefined),
        webServer: { register: (route) => handlers.set(route.path, route.handler) },
      })
    },
    effect: (factory) => factory(),
  }
  return { ctx, handlers, tools, llm, agentPrompts }
}

/** Call one API method through the real route handler. */
function callApi(handler, method, payload) {
  const req = {
    method: 'POST',
    url: `/plugins/dsh-git-dock/api/${method}`,
    headers: {},
    async *[Symbol.asyncIterator]() {
      yield Buffer.from(JSON.stringify(payload))
    },
  }
  return new Promise((resolve) => {
    let status = 0
    let text = ''
    const res = new EventEmitter()
    res.headersSent = false
    res.writeHead = (code) => {
      status = code
      res.headersSent = true
    }
    res.end = (chunk) => {
      text = chunk ?? ''
      resolve({ status, body: JSON.parse(text) })
    }
    res.destroy = () => {}
    handler(req, res)
  })
}

function unwrap(result) {
  if (result.status !== 200) throw new Error(`HTTP ${result.status}: ${JSON.stringify(result.body)}`)
  return result.body.value
}

const repoDir = makeRepo()
const state = { running: false }
const { ctx, handlers, tools, llm, agentPrompts } = makeContext(repoDir, state)
const plugin = await import(PLUGIN)
plugin.apply(ctx)

const route = [...handlers.keys()].find((path) => path.startsWith('/plugins/dsh-git-dock/api'))
check('route registered', typeof handlers.get(route) === 'function', [...handlers.keys()])
const handler = handlers.get(route)

console.log('repo state')
const repo = unwrap(await callApi(handler, 'repo', { sessionId: SESSION })).repo
check('branch is main', repo.branch === 'main', repo.branch)
check('repo root matches', repo.repoRoot.replace(/\\/g, '/').endsWith(repoDir.replace(/\\/g, '/')), repo.repoRoot)
check('detached is false', repo.detached === false)
check('untracked dirty file counted', repo.changes.untracked === 1 && repo.changes.changed === 1, repo.changes)
check('no in-progress operation', repo.operation === 'none', repo.operation)
check('running reported', repo.running === false)

console.log('branch listing')
const listed = unwrap(await callApi(handler, 'branches', { sessionId: SESSION }))
check('two local branches', listed.local.length === 2, listed.local.map((b) => b.name))
check('current branch first', listed.local[0].current === true && listed.local[0].name === 'main', listed.local[0])
check('feature branch has a subject', listed.local.some((b) => b.name === 'feature-1' && b.subject === 'second'))

console.log('guards')
const stale = await callApi(handler, 'switch', { sessionId: SESSION, branch: 'feature-1', expectHead: 'deadbeef' })
check('stale head rejected', stale.status === 409 && stale.body.error.code === 'stale', stale.body)
const unknown = await callApi(handler, 'switch', { sessionId: SESSION, branch: 'nope', expectHead: repo.head })
check('unknown branch rejected', unknown.status === 404 && unknown.body.error.code === 'unknown-branch', unknown.body)
const badCreate = await callApi(handler, 'create', { sessionId: SESSION, name: 'bad name', expectHead: repo.head })
check('invalid name rejected', badCreate.status === 400 && badCreate.body.error.code === 'invalid-name', badCreate.body)

state.running = true
const busy = await callApi(handler, 'switch', { sessionId: SESSION, branch: 'feature-1', expectHead: repo.head })
check('running session needs confirmation', busy.status === 409 && busy.body.error.code === 'running', busy.body)
check('busy refusal carries fresh state', busy.body.error.details?.state?.running === true, busy.body.error.details)
const busyCreate = await callApi(handler, 'create', { sessionId: SESSION, name: 'feature-x', expectHead: repo.head })
check('create needs confirmation while running', busyCreate.status === 409 && busyCreate.body.error.code === 'running', busyCreate.body)
state.running = false

console.log('switch')
const switched = unwrap(await callApi(handler, 'switch', {
  sessionId: SESSION, branch: 'feature-1', expectHead: repo.head, confirmed: true,
}))
check('switched to feature-1', switched.repo.branch === 'feature-1', switched.repo.branch)
check('previous branch recorded', switched.previousBranch === 'main', switched.previousBranch)
check('untracked file survived', switched.repo.changes.untracked === 1, switched.repo.changes)

console.log('create')
const created = unwrap(await callApi(handler, 'create', {
  sessionId: SESSION, name: 'feature-2', from: 'main', expectHead: switched.repo.head,
}))
check('created and switched', created.repo.branch === 'feature-2', created.repo.branch)
check('new branch listed', created.branches.local.some((b) => b.name === 'feature-2'))
const duplicate = await callApi(handler, 'create', { sessionId: SESSION, name: 'feature-2', expectHead: created.repo.head })
check('duplicate name rejected', duplicate.status === 409 && duplicate.body.error.code === 'branch-exists', duplicate.body)

console.log('P1 worktree change list')
appendFileSync(join(repoDir, 'a.txt'), 'four\n')
writeFileSync(join(repoDir, 'new-file.txt'), 'n1\nn2\n')
const worktree = unwrap(await callApi(handler, 'changes', { sessionId: SESSION, scope: 'worktree' }))
check('worktree lists the modified file', worktree.files.some((file) => file.path === 'a.txt' && file.status === 'M' && file.additions > 0), worktree.files)
check('worktree lists the untracked file', worktree.files.some((file) => file.path === 'new-file.txt' && file.status === '?' && file.additions === 2), worktree.files)
const diffTracked = unwrap(await callApi(handler, 'diff', { sessionId: SESSION, scope: 'worktree', path: 'a.txt' }))
check('tracked diff has hunks', diffTracked.hunks.length > 0 && diffTracked.hunks[0].lines.some((line) => line.kind === '+'), diffTracked)
const diffUntracked = unwrap(await callApi(handler, 'diff', { sessionId: SESSION, scope: 'worktree', path: 'new-file.txt', untracked: true }))
check('untracked diff has hunks', diffUntracked.hunks.length > 0 && diffUntracked.hunks[0].lines.every((line) => line.kind === '+'), diffUntracked)
const escaped = await callApi(handler, 'diff', { sessionId: SESSION, scope: 'worktree', path: '../escape.txt' })
check('path escape rejected', escaped.status === 400 && escaped.body.error.code === 'bad-request', escaped.body)

console.log('P1 branch comparison')
git(repoDir, 'add', 'new-file.txt')
git(repoDir, 'commit', '-qm', 'feature-2 work')
const branchChanges = unwrap(await callApi(handler, 'changes', { sessionId: SESSION, scope: 'branch', base: 'main' }))
check('explicit base honoured', branchChanges.base === 'main', branchChanges.base)
check('branch shows the committed file', branchChanges.files.some((file) => file.path === 'new-file.txt' && file.status === 'A'), branchChanges.files)
check('branch commit count', branchChanges.commits === 1, branchChanges.commits)
const branchDiff = unwrap(await callApi(handler, 'diff', { sessionId: SESSION, scope: 'branch', base: 'main', path: 'new-file.txt' }))
check('branch diff has hunks', branchDiff.hunks.length > 0, branchDiff)
const autoBase = unwrap(await callApi(handler, 'changes', { sessionId: SESSION, scope: 'branch' }))
check('auto base detected', typeof autoBase.base === 'string' && autoBase.base !== '', autoBase.base)
const unknownBase = await callApi(handler, 'changes', { sessionId: SESSION, scope: 'branch', base: 'no-such-base' })
check('unknown base rejected', unknownBase.status === 404 && unknownBase.body.error.code === 'unknown-ref', unknownBase.body)

console.log('P2 merge')
git(repoDir, 'add', 'a.txt')
git(repoDir, 'commit', '-qm', 'feature-2 second')
const clean = unwrap(await callApi(handler, 'repo', { sessionId: SESSION })).repo
const onMain = unwrap(await callApi(handler, 'switch', { sessionId: SESSION, branch: 'main', expectHead: clean.head, confirmed: true }))
check('switched back to main', onMain.repo.branch === 'main', onMain.repo.branch)
check('switch wrote a backup ref', typeof onMain.backup?.ref === 'string' && onMain.backup.ref.startsWith('refs/dsh/backup/'), onMain.backup)
writeFileSync(join(repoDir, 'main-only.txt'), 'm\n')
git(repoDir, 'add', 'main-only.txt')
git(repoDir, 'commit', '-qm', 'main only')

const preview = unwrap(await callApi(handler, 'merge.preview', { sessionId: SESSION, source: 'feature-2', mode: 'no-ff' }))
check('preview is a real merge', preview.kind === 'merge', preview.kind)
check('preview lists changed files', preview.fileCount > 0 && preview.files.length > 0, preview.files)
check('preview reports no conflicts', preview.conflicts.length === 0, preview.conflicts)
const merged = unwrap(await callApi(handler, 'merge.apply', { sessionId: SESSION, confirmToken: preview.confirmToken, confirmed: true }))
check('merge applied', merged.status === 'merged', merged.status)
check('merge commit created', git(repoDir, 'log', '-1', '--merges', '--format=%s') !== '')
check('merged file present', existsSync(join(repoDir, 'new-file.txt')))
check('merge wrote a backup ref', typeof merged.backup?.ref === 'string', merged.backup)
const reuse = await callApi(handler, 'merge.apply', { sessionId: SESSION, confirmToken: preview.confirmToken, confirmed: true })
check('merge token is single use', reuse.status === 409 && reuse.body.error.code === 'merge-token', reuse.body)

const ff = await callApi(handler, 'merge.preview', { sessionId: SESSION, source: 'feature-1', mode: 'ff-only' })
check('ff-only refuses divergence', ff.status === 409 && ff.body.error.code === 'not-fast-forward', ff.body)

console.log('P2 squash')
unwrap(await callApi(handler, 'create', { sessionId: SESSION, name: 'squash-test', from: 'main', expectHead: merged.repo.head }))
const squashPreview = unwrap(await callApi(handler, 'merge.preview', { sessionId: SESSION, source: 'feature-1', mode: 'squash' }))
const squashed = unwrap(await callApi(handler, 'merge.apply', { sessionId: SESSION, confirmToken: squashPreview.confirmToken, confirmed: true }))
check('squash result reported', squashed.status === 'squashed', squashed.status)
check('squash leaves staged changes', squashed.repo.changes.staged > 0, squashed.repo.changes)
git(repoDir, 'reset', '--hard', '-q')

console.log('P2 conflicts')
git(repoDir, 'switch', '-q', 'main')
writeFileSync(join(repoDir, 'shared.txt'), 'base\n')
git(repoDir, 'add', 'shared.txt')
git(repoDir, 'commit', '-qm', 'shared base')
git(repoDir, 'switch', '-qc', 'conflict-side')
writeFileSync(join(repoDir, 'shared.txt'), 'side\n')
git(repoDir, 'add', 'shared.txt')
git(repoDir, 'commit', '-qm', 'side edit')
git(repoDir, 'switch', '-q', 'main')
writeFileSync(join(repoDir, 'shared.txt'), 'main\n')
git(repoDir, 'add', 'shared.txt')
git(repoDir, 'commit', '-qm', 'main edit')
const conflictPreview = unwrap(await callApi(handler, 'merge.preview', { sessionId: SESSION, source: 'conflict-side' }))
check('preview reports conflicts', conflictPreview.conflicts.includes('shared.txt'), conflictPreview.conflicts)
const conflicted = unwrap(await callApi(handler, 'merge.apply', { sessionId: SESSION, confirmToken: conflictPreview.confirmToken, confirmed: true }))
check('merge reports conflicts', conflicted.status === 'conflicts', conflicted.status)
check('repo reports an open merge', conflicted.repo.operation === 'merge', conflicted.repo.operation)
check('conflict paths listed', conflicted.repo.conflictPaths.includes('shared.txt'), conflicted.repo.conflictPaths)
check('conflict types are classified', conflicted.repo.conflictTypes.some((item) => item.path === 'shared.txt' && item.type === 'content'), conflicted.repo.conflictTypes)
const pushBlocked = await callApi(handler, 'push', { sessionId: SESSION, setUpstream: false })
check('push refuses unresolved conflicts', pushBlocked.status === 409 && pushBlocked.body.error.code === 'unresolved-conflicts', pushBlocked.body)
const syncPushBlocked = unwrap(await callApi(handler, 'syncPush', { sessionId: SESSION }))
check('sync push blocks while conflicts remain', syncPushBlocked.push.status === 'blocked' && syncPushBlocked.push.conflicts.length > 0, syncPushBlocked.push)
const assisted = unwrap(await callApi(handler, 'merge.assist', { sessionId: SESSION }))
check('assist notifies the live agent', assisted.notified === true && assisted.conflicts.includes('shared.txt'), assisted)
const assistPrompt = agentPrompts.length > 0 ? agentPrompts[agentPrompts.length - 1] : null
check('assist prompt lists the conflict file', assistPrompt !== null && assistPrompt.content[0].text.includes('shared.txt'), assistPrompt)
check('assist prompt forbids committing and pushing', assistPrompt !== null && assistPrompt.content[0].text.includes('git push'), assistPrompt)
const earlyComplete = await callApi(handler, 'merge.complete', { sessionId: SESSION })
check('complete refuses unresolved conflicts', earlyComplete.status === 409 && earlyComplete.body.error.code === 'conflicts-remain', earlyComplete.body)
const aborted = unwrap(await callApi(handler, 'merge.abort', { sessionId: SESSION }))
check('abort clears the merge', aborted.repo.operation === 'none', aborted.repo.operation)
const assistNoMerge = await callApi(handler, 'merge.assist', { sessionId: SESSION })
check('assist refuses without a merge', assistNoMerge.status === 409 && assistNoMerge.body.error.code === 'no-merge', assistNoMerge.body)
const previewAgain = unwrap(await callApi(handler, 'merge.preview', { sessionId: SESSION, source: 'conflict-side' }))
unwrap(await callApi(handler, 'merge.apply', { sessionId: SESSION, confirmToken: previewAgain.confirmToken, confirmed: true }))
const resolved = unwrap(await callApi(handler, 'merge.resolve', { sessionId: SESSION, path: 'shared.txt' }))
check('resolve marks the file resolved', resolved.conflicts.length === 0, resolved.conflicts)
const assistResolved = await callApi(handler, 'merge.assist', { sessionId: SESSION })
check('assist refuses once conflicts are resolved', assistResolved.status === 409 && assistResolved.body.error.code === 'no-conflicts', assistResolved.body)
const completed = unwrap(await callApi(handler, 'merge.complete', { sessionId: SESSION }))
check('merge completed', completed.repo.operation === 'none' && git(repoDir, 'log', '-1', '--merges', '--format=%s') !== '')
const syncPullClean = unwrap(await callApi(handler, 'syncPull', { sessionId: SESSION }))
check('sync pull reports up-to-date', syncPullClean.pull.status === 'up-to-date', syncPullClean.pull)
const syncPushClean = unwrap(await callApi(handler, 'syncPush', { sessionId: SESSION }))
check('sync push reports up-to-date', syncPushClean.push.status === 'up-to-date', syncPushClean.push)
const syncLogValue = unwrap(await callApi(handler, 'syncLog', { sessionId: SESSION }))
check('sync log records both phases', Array.isArray(syncLogValue.entries) && syncLogValue.entries.some((entry) => entry.pull.status === 'up-to-date') && syncLogValue.entries.some((entry) => entry.push.status === 'up-to-date'), syncLogValue.entries?.length)
const noMerge = await callApi(handler, 'merge.abort', { sessionId: SESSION })
check('abort refuses without a merge', noMerge.status === 409 && noMerge.body.error.code === 'no-merge', noMerge.body)

console.log('P2 model tool')
check('git_branch tool registered', tools.length === 1 && tools[0].name === 'git_branch', tools.map((tool) => tool.name))
const toolCall = (args) => tools[0].execute(args, { agent: { id: SESSION }, signal: new AbortController().signal })
const toolStatus = await toolCall({ action: 'status' })
check('tool status returns a branch', typeof toolStatus.branch === 'string', toolStatus.branch)
const toolList = await toolCall({ action: 'list' })
check('tool list returns branches', Array.isArray(toolList.local) && toolList.local.length > 0)
const toolSwitch = await toolCall({ action: 'switch', branch: 'feature-2' })
check('tool switch works', toolSwitch.repo.branch === 'feature-2', toolSwitch.repo.branch)

console.log('P3 refs & checkout')
git(repoDir, 'tag', 'v1')
const refs1 = unwrap(await callApi(handler, 'branches', { sessionId: SESSION }))
check('tags are listed', refs1.tags.some((tag) => tag.name === 'v1' && tag.annotated === false), refs1.tags)
check('branch rows carry the author', refs1.local.every((branch) => typeof branch.author === 'string' && branch.author !== ''), refs1.local.slice(0, 1))
const detached = unwrap(await callApi(handler, 'checkout', { sessionId: SESSION, target: { kind: 'tag', name: 'v1' }, expectHead: refs1.repo.head, confirmed: true }))
check('tag checkout leaves a detached HEAD', detached.repo.detached === true, detached.repo.detached)
const tagNeedsConfirm = await callApi(handler, 'checkout', { sessionId: SESSION, target: { kind: 'tag', name: 'v1' }, expectHead: detached.repo.head })
check('tag checkout needs confirmation', tagNeedsConfirm.status === 409 && tagNeedsConfirm.body.error.code === 'detached-confirm', tagNeedsConfirm.body)
const backToBranch = unwrap(await callApi(handler, 'checkout', { sessionId: SESSION, target: { kind: 'local', name: 'feature-2' }, expectHead: detached.repo.head, confirmed: true }))
check('checkout returns to a branch', backToBranch.repo.branch === 'feature-2', backToBranch.repo.branch)

const bareDir = mkdtempSync(join(tmpdir(), 'dgd-remote-'))
execFileSync('git', ['init', '--bare', '-q', bareDir])
git(repoDir, 'remote', 'add', 'origin', bareDir.replace(/\\/g, '/'))
git(repoDir, 'push', '-q', 'origin', 'main:refs/heads/remote-only')
unwrap(await callApi(handler, 'fetch', { sessionId: SESSION }))
const refs2 = unwrap(await callApi(handler, 'branches', { sessionId: SESSION }))
check('remote branches are listed', refs2.remote.some((branch) => branch.name === 'origin/remote-only'), refs2.remote.map((branch) => branch.name))
const tracking = unwrap(await callApi(handler, 'checkout', {
  sessionId: SESSION,
  target: { kind: 'remote', name: 'origin/remote-only' },
  expectHead: refs2.repo.head,
  confirmed: true,
}))
check('remote checkout creates a tracking branch', tracking.repo.branch === 'remote-only', tracking.repo.branch)
check('tracking branch has an upstream', tracking.repo.upstream === 'origin/remote-only', tracking.repo.upstream)

console.log('P4 stage / discard / commit')
const onMainAgain = unwrap(await callApi(handler, 'checkout', { sessionId: SESSION, target: { kind: 'local', name: 'main' }, expectHead: tracking.repo.head, confirmed: true }))
check('back on main', onMainAgain.repo.branch === 'main')
appendFileSync(join(repoDir, 'main-only.txt'), 'staged\n')
const staged = unwrap(await callApi(handler, 'stage', { sessionId: SESSION, paths: ['main-only.txt'] }))
check('stage moves the file into the index', staged.repo.changes.staged > 0, staged.repo.changes)
const unstagedAgain = unwrap(await callApi(handler, 'unstage', { sessionId: SESSION, paths: ['main-only.txt'] }))
check('unstage clears the index entry', unstagedAgain.repo.changes.staged === 0, unstagedAgain.repo.changes)
writeFileSync(join(repoDir, 'discard-me.txt'), 'temp\n')
const discarded = unwrap(await callApi(handler, 'discard', { sessionId: SESSION, paths: ['main-only.txt', 'discard-me.txt'] }))
check('discard removes the untracked file', !existsSync(join(repoDir, 'discard-me.txt')))
check('discard restores the tracked file', git(repoDir, 'diff', '--name-only', '--', 'main-only.txt') === '')
check('discard writes a backup ref', typeof discarded.backup?.ref === 'string', discarded.backup)
check('discard stashes the change', discarded.stashed === true)
check('discard names the stash', /dsh-git-dock discard/.test(discarded.message), discarded.message)
const undone = unwrap(await callApi(handler, 'discardUndo', { sessionId: SESSION }))
check('discard undo restores the tracked file', undone.repo.changes.changed > 0 && git(repoDir, 'diff', '--name-only', '--', 'main-only.txt') !== '', undone.restored)
const undoneAgain = await callApi(handler, 'discardUndo', { sessionId: SESSION })
check('discard undo reports when nothing is stashed', undoneAgain.status === 404 && undoneAgain.body.error.code === 'no-discard', undoneAgain.body)

appendFileSync(join(repoDir, 'main-only.txt'), 'commit\n')
unwrap(await callApi(handler, 'stage', { sessionId: SESSION, paths: ['main-only.txt'] }))
const committed = unwrap(await callApi(handler, 'commit', { sessionId: SESSION, message: 'test: commit from plugin' }))
check('commit records the message', committed.commit.subject === 'test: commit from plugin', committed.commit)
const amended = unwrap(await callApi(handler, 'commit', { sessionId: SESSION, message: 'test: amended subject', amend: true }))
check('amend rewrites the tip', amended.commit.subject === 'test: amended subject', amended.commit)

console.log('P5 push / pull / AI message')
const firstPush = unwrap(await callApi(handler, 'push', { sessionId: SESSION, setUpstream: true }))
check('push configures the upstream', firstPush.setUpstream === true, firstPush)
appendFileSync(join(repoDir, 'main-only.txt'), 'pushed\n')
unwrap(await callApi(handler, 'stage', { sessionId: SESSION, paths: ['main-only.txt'] }))
unwrap(await callApi(handler, 'commit', { sessionId: SESSION, message: 'test: second' }))
const secondPush = unwrap(await callApi(handler, 'push', { sessionId: SESSION }))
check('push leaves the branch in sync', secondPush.repo.ahead === 0 && secondPush.repo.behind === 0, secondPush.repo)
const amendPushed = await callApi(handler, 'commit', { sessionId: SESSION, message: 'nope', amend: true })
check('amend of a pushed HEAD is disabled', amendPushed.status === 409 && amendPushed.body.error.code === 'amend-pushed', amendPushed.body)
const pulled = unwrap(await callApi(handler, 'pull', { sessionId: SESSION }))
check('ff-only pull is a no-op when in sync', pulled.repo.ahead === 0, pulled.repo.ahead)
appendFileSync(join(repoDir, 'main-only.txt'), 'ai\n')
unwrap(await callApi(handler, 'stage', { sessionId: SESSION, paths: ['main-only.txt'] }))
const suggestion = unwrap(await callApi(handler, 'commitMessage', { sessionId: SESSION, language: 'en' }))
check('AI drafts a convention-compliant message', suggestion.message === 'feat(core): 新增测试功能', suggestion)
check('AI reports the session model', suggestion.provider === 'mock' && suggestion.model === 'mock', suggestion)
check('the default convention requires a scope', suggestion.conventions.scopeRequired === true, suggestion.conventions)
check('the default convention lists the standard types', suggestion.conventions.types.includes('refactor') && suggestion.conventions.types.includes('ci'), suggestion.conventions.types)
check('the default convention caps the total message', suggestion.conventions.totalMaxLength === 500, suggestion.conventions.totalMaxLength)
const modelOptions = unwrap(await callApi(handler, 'modelOptions', { sessionId: SESSION }))
check('model options list the provider', modelOptions.providers.some((provider) => provider.provider === 'mock'), modelOptions.providers)
check('model options carry reasoning efforts', modelOptions.providers[0].models[0].efforts.length === 2, modelOptions.providers[0].models[0])
check('model options expose the session route', modelOptions.current !== null && modelOptions.current.provider === 'mock', modelOptions.current)
const modelInfo = unwrap(await callApi(handler, 'modelInfo', { sessionId: SESSION, provider: 'mock', model: 'mock' }))
check('model info lists reasoning efforts', modelInfo.efforts.length === 2 && modelInfo.efforts[1].id === 'high', modelInfo)
check('model info reports the default effort', modelInfo.defaultEffort === 'low', modelInfo.defaultEffort)
const badModelInfo = await callApi(handler, 'modelInfo', { sessionId: SESSION, provider: 'mock' })
check('model info requires provider and model', badModelInfo.status === 400 && badModelInfo.body.error.code === 'bad-request', badModelInfo.body)
const chosen = unwrap(await callApi(handler, 'commitMessage', {
  sessionId: SESSION,
  language: 'en',
  provider: 'mock',
  model: 'mock',
  reasoningEffort: 'high',
}))
check('the chosen model drafts the message', typeof chosen.message === 'string' && chosen.message.length > 0, chosen)
const chosenCall = llm.calls[llm.calls.length - 1]
check('the request carries the chosen model', chosenCall.provider === 'mock' && chosenCall.model === 'mock', chosenCall)
check('the request carries the chosen reasoning effort', chosenCall.reasoningEffort === 'high', chosenCall.reasoningEffort)
const longCommit = await callApi(handler, 'commit', { sessionId: SESSION, message: `fix(core): ${'长'.repeat(600)}` })
check('commit rejects an over-long message', longCommit.status === 400 && longCommit.body.error.code === 'message-too-long', longCommit.body)
const multiLineCommit = unwrap(await callApi(handler, 'commit', {
  sessionId: SESSION,
  message: 'fix(core): 修复提交信息长度校验\n\n- 总长度限制为 500 字符\n- 支持小点换行',
}))
check('a multi-line commit body is preserved', multiLineCommit.commit.subject === 'fix(core): 修复提交信息长度校验', multiLineCommit.commit)
check('the commit body keeps its bullets', git(repoDir, 'log', '-1', '--format=%B').includes('- 支持小点换行'))

console.log('commit conventions')
const convDir = mkdtempSync(join(tmpdir(), 'dgd-conv-'))
execFileSync('git', ['init', '-q', '-b', 'main'], { cwd: convDir })
git(convDir, 'config', 'user.email', 'conv@test.local')
git(convDir, 'config', 'user.name', 'conv')
const convCommit = (message) => {
  appendFileSync(join(convDir, 'a.txt'), `${message}\n`)
  git(convDir, 'add', 'a.txt')
  git(convDir, 'commit', '-qm', message)
}
convCommit('feat(auth): add login')
convCommit('fix: handle crash')
convCommit('chore: bump deps')
convCommit('docs: update readme')
appendFileSync(join(convDir, 'a.txt'), 'staged\n')
const convCtx = makeContext(convDir, { running: false })
plugin.apply(convCtx.ctx)
const convHandler = convCtx.handlers.get(route)
convCtx.llm.script.push('update stuff')
convCtx.llm.script.push('feat(auth): 新增登录表单')
const convResult = unwrap(await callApi(convHandler, 'commitMessage', { sessionId: SESSION }))
check('history makes the convention conventional', convResult.conventions.style === 'conventional', convResult.conventions)
check('repository types are listed', convResult.conventions.types.includes('feat') && convResult.conventions.types.includes('fix'), convResult.conventions.types)
check('an off-convention draft is retried', convResult.message === 'feat(auth): 新增登录表单', convResult.message)
check('the convention summary is reported', typeof convResult.conventions.summary === 'string' && convResult.conventions.summary.includes('conventional'), convResult.conventions.summary)
check('the default scope rule is enforced', convResult.conventions.scopeRequired === true, convResult.conventions)
check('the current history language stays Chinese', convResult.conventions.language === 'zh', convResult.conventions.language)

writeFileSync(join(convDir, 'commitlint.config.js'), "module.exports = { rules: { 'type-enum': [2, 'always', ['feat', 'fix']], 'header-max-length': [2, 'always', 24] } }\n")
convCtx.llm.script.push('chore(core): 不允许的类型')
convCtx.llm.script.push('fix(core): 修复崩溃问题')
const lintResult = unwrap(await callApi(convHandler, 'commitMessage', { sessionId: SESSION }))
check('commitlint types are enforced', lintResult.message === 'fix(core): 修复崩溃问题', lintResult.message)
check('commitlint types are reported', lintResult.conventions.types.join(',') === 'feat,fix', lintResult.conventions.types)
check('commitlint max length is reported', lintResult.conventions.maxLength === 24, lintResult.conventions.maxLength)
convCtx.llm.script.push('fix(core): 这是一个非常非常长的提交描述用来测试长度上限')
convCtx.llm.script.push('fix(core): 这是一个非常非常长的提交描述用来测试长度上限')
const trimmedConvention = unwrap(await callApi(convHandler, 'commitMessage', { sessionId: SESSION }))
check('an over-long draft is trimmed to the limit', trimmedConvention.message.length <= 24, trimmedConvention.message)

writeFileSync(join(convDir, '.dsh-git-dock.json'), JSON.stringify({ commit: { types: ['feat', 'fix'], language: 'zh', maxLength: 20 } }))
convCtx.llm.script.push('feat(ui): 新增登录表单')
const zhResult = unwrap(await callApi(convHandler, 'commitMessage', { sessionId: SESSION }))
check('a repository override sets the language', zhResult.conventions.language === 'zh', zhResult.conventions.language)
check('a repository override accepts a local draft', zhResult.message === 'feat(ui): 新增登录表单', zhResult.message)

convCtx.llm.script.push('feat(auth): 新增登录校验\n\n- 增加手机号校验\n- 补充登录单元测试')
const multi = unwrap(await callApi(convHandler, 'commitMessage', { sessionId: SESSION }))
check('a bulleted body is accepted', multi.message === 'feat(auth): 新增登录校验\n\n- 增加手机号校验\n- 补充登录单元测试', multi.message)
check('newlines survive the model round trip', multi.message.split('\n').length === 4, multi.message)
convCtx.llm.script.push('feat(auth): 新增登录校验\n\n随便写一段没有小点的内容')
convCtx.llm.script.push('feat(auth): 新增登录校验')
const retriedBody = unwrap(await callApi(convHandler, 'commitMessage', { sessionId: SESSION }))
check('a non-bulleted body is corrected', retriedBody.message === 'feat(auth): 新增登录校验', retriedBody.message)
const longBody = 'feat(auth): 新增登录校验\n\n'
  + Array.from({ length: 12 }, (_, index) => `- 第 ${index + 1} 条：${'这是一段很长的说明文字'.repeat(4)}`).join('\n')
convCtx.llm.script.push(longBody)
convCtx.llm.script.push(longBody)
const trimmedBody = unwrap(await callApi(convHandler, 'commitMessage', { sessionId: SESSION }))
check('an over-long body is trimmed to the total limit', trimmedBody.message.length <= 500, trimmedBody.message.length)
check('trimming keeps the subject line', trimmedBody.message.startsWith('feat(auth): 新增登录校验'), trimmedBody.message)

console.log('commit convention config')
const defaultConv = unwrap(await callApi(handler, 'convention', { sessionId: SESSION }))
check('default convention has no subject limit', defaultConv.effective.maxLength === null, defaultConv.effective.maxLength)
check('default convention caps the total at 500', defaultConv.effective.totalMaxLength === 500, defaultConv.effective.totalMaxLength)
check('default convention requires a scope', defaultConv.effective.scopeRequired === true)
const savedConv = unwrap(await callApi(handler, 'convention.save', {
  sessionId: SESSION,
  commit: { types: ['feat', 'fix'], scopeRequired: false, language: 'zh', maxLength: 30, totalMaxLength: 300, vague: ['update'] },
}))
check('saving applies the new types', savedConv.effective.types.join(',') === 'feat,fix', savedConv.effective.types)
check('saving applies the lengths', savedConv.effective.maxLength === 30 && savedConv.effective.totalMaxLength === 300, savedConv.effective)
check('saving records the source', savedConv.effective.sources.includes('saved-config'), savedConv.effective.sources)
const rereadConv = unwrap(await callApi(handler, 'convention', { sessionId: SESSION }))
check('the saved config is persisted', rereadConv.effective.types.join(',') === 'feat,fix', rereadConv.effective.types)
appendFileSync(join(repoDir, 'main-only.txt'), 'saved config\n')
unwrap(await callApi(handler, 'stage', { sessionId: SESSION, paths: ['main-only.txt'] }))
llm.script.push('chore(core): 更新一些内容')
llm.script.push('fix: 修复问题')
const savedDraft = unwrap(await callApi(handler, 'commitMessage', { sessionId: SESSION }))
check('saved config drives generation', savedDraft.message === 'fix: 修复问题', savedDraft.message)
check('saved config drops the scope requirement', savedDraft.conventions.scopeRequired === false, savedDraft.conventions.scopeRequired)
const savedCommitLimit = await callApi(handler, 'commit', { sessionId: SESSION, message: `fix(core): ${'长'.repeat(300)}` })
check('saved total limit is enforced on commit', savedCommitLimit.status === 400 && savedCommitLimit.body.error.code === 'message-too-long', savedCommitLimit.body)
const resetConv = unwrap(await callApi(handler, 'convention.save', { sessionId: SESSION, reset: true }))
check('reset restores the defaults', resetConv.effective.maxLength === null && resetConv.effective.totalMaxLength === 500 && resetConv.effective.types.includes('chore'), resetConv.effective)
check('reset clears the saved value', resetConv.saved === null)

console.log('in-progress operation')
writeFileSync(join(repoDir, '.git', 'MERGE_HEAD'), `${created.repo.head}\n`)
const duringMerge = unwrap(await callApi(handler, 'repo', { sessionId: SESSION })).repo
check('merge detected', duringMerge.operation === 'merge', duringMerge.operation)
const blocked = await callApi(handler, 'switch', { sessionId: SESSION, branch: 'main', expectHead: duringMerge.head })
check('switch blocked during merge', blocked.status === 409 && blocked.body.error.code === 'operation-in-progress', blocked.body)
await rm(join(repoDir, '.git', 'MERGE_HEAD'), { force: true })

console.log('non-repository directory')
const plain = mkdtempSync(join(tmpdir(), 'dgd-plain-'))
const plainCtx = makeContext(plain, { running: false })
const plainHandlers = plainCtx.handlers
plugin.apply(plainCtx.ctx)
const plainHandler = plainHandlers.get(route)
const notRepo = await callApi(plainHandler, 'repo', { sessionId: SESSION })
check('non-repository answers not-repo', notRepo.status === 409 && notRepo.body.error.code === 'not-repo', notRepo.body)

rmSync(repoDir, { recursive: true, force: true })
rmSync(plain, { recursive: true, force: true })
rmSync(SMOKE_DSH_HOME, { recursive: true, force: true })

console.log(failures.length === 0 ? '\nall checks passed' : `\n${failures.length} check(s) failed`)
process.exitCode = failures.length === 0 ? 0 : 1
