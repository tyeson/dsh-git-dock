/**
 * dsh-git-dock — Host half.
 *
 * Serves the session's Git state to the browser half over one fenced,
 * same-origin route prefix (`/plugins/dsh-git-dock/api/*`). The browser never
 * supplies a path: the working directory is resolved here from the Session id
 * through `ctx.workingDirectory` (falling back to the immutable header), so a
 * caller cannot point the plugin at an arbitrary repository.
 *
 * Write operations (switch / create) are serialized per repository, guarded by
 * an `expectHead` optimistic check, and refused while the Session's turn is
 * open unless the caller explicitly confirms.
 *
 * @module dsh-git-dock
 */
import { spawn } from 'node:child_process'
import { createHash, randomUUID } from 'node:crypto'
import { appendFile, mkdir, readFile, realpath, rename, rm, stat, writeFile } from 'node:fs/promises'
import { homedir } from 'node:os'
import { basename, dirname, isAbsolute, join, resolve } from 'node:path'

export const name = 'dsh-git-dock'

/** `sessions` is required; the web carrier is injected optionally in apply(). */
export const inject = ['sessions']

const ROUTE_PREFIX = '/plugins/dsh-git-dock/api'
const MAX_BODY_BYTES = 32 * 1024
const READ_TIMEOUT_MS = 20_000
const WRITE_TIMEOUT_MS = 60_000
const OUTPUT_LIMIT_BYTES = 8 * 1024 * 1024
const STDERR_LIMIT_CHARS = 64_000
const STATUS_ROW_LIMIT = 4_000
const FILE_ROW_LIMIT = 2_000
const DIFF_LINE_LIMIT = 5_000
const DIFF_OUTPUT_LIMIT = 4 * 1024 * 1024
const UNTRACKED_READ_LIMIT = 1024 * 1024

/** Stable child environment: no optional locks, no interactive prompts. */
const GIT_ENV = Object.freeze({
  GIT_OPTIONAL_LOCKS: '0',
  GIT_TERMINAL_PROMPT: '0',
  GIT_EDITOR: 'true',
  EDITOR: 'true',
  LC_ALL: 'C',
})

/** Operation markers inside the git directory, with the state they mean. */
const OPERATION_MARKERS = [
  ['MERGE_HEAD', 'merge'],
  ['rebase-merge', 'rebase'],
  ['rebase-apply', 'rebase'],
  ['CHERRY_PICK_HEAD', 'cherry-pick'],
  ['REVERT_HEAD', 'revert'],
  ['BISECT_LOG', 'bisect'],
]

/** A request-level failure with a stable code the UI localizes. */
class ApiError extends Error {
  /**
   * @param {string} code - machine-readable code.
   * @param {string} message - human-readable fallback message.
   * @param {number} [status] - HTTP status.
   * @param {object} [details] - extra payload for the client.
   */
  constructor(code, message, status = 400, details) {
    super(message)
    this.code = code
    this.status = status
    this.details = details
  }
}

/** First non-empty line of a git failure. */
function firstLine(text) {
  const match = /[^\r\n]*/.exec(String(text ?? '').trimStart())
  return match === null ? '' : match[0].trim()
}

/** Serialize one JSON response. */
function sendJson(res, status, value) {
  if (res.headersSent === true) {
    res.destroy?.()
    return
  }
  res.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' })
  res.end(JSON.stringify(value))
}

/** Map a thrown value onto the wire error envelope. */
function sendError(res, error, requestId) {
  const id = requestId ?? randomUUID()
  if (error instanceof ApiError) {
    sendJson(res, error.status, {
      ok: false,
      requestId: id,
      error: { code: error.code, message: error.message, details: error.details },
    })
    return
  }
  const message = error instanceof Error ? error.message : String(error)
  sendJson(res, 500, { ok: false, requestId: id, error: { code: 'internal', message } })
}

/** Read a bounded JSON body; empty bodies become `{}`. */
async function readJsonBody(req) {
  const chunks = []
  let size = 0
  for await (const chunk of req) {
    const buffer = Buffer.from(chunk)
    size += buffer.length
    if (size > MAX_BODY_BYTES) throw new ApiError('too-large', 'request body too large', 413)
    chunks.push(buffer)
  }
  if (chunks.length === 0) return {}
  const text = Buffer.concat(chunks).toString('utf8')
  if (text.trim() === '') return {}
  try {
    const parsed = JSON.parse(text)
    return parsed !== null && typeof parsed === 'object' ? parsed : {}
  } catch {
    throw new ApiError('bad-request', 'request body is not valid JSON')
  }
}

/**
 * Spawn one git command and resolve to its stdout.
 *
 * @param {string} cwd - directory the command runs in.
 * @param {readonly string[]} args - argument vector (no shell involved).
 * @param {{ timeoutMs?: number, signal?: AbortSignal, maxBytes?: number, input?: string }} [options]
 * @returns {Promise<string>} stdout.
 */
function runGit(cwd, args, options = {}) {
  const timeoutMs = options.timeoutMs ?? READ_TIMEOUT_MS
  const maxBytes = options.maxBytes ?? OUTPUT_LIMIT_BYTES
  return new Promise((resolve, reject) => {
    /** @type {import('node:child_process').ChildProcess} */
    let child
    try {
      child = spawn('git', args, {
        cwd,
        windowsHide: true,
        stdio: options.input === undefined ? ['ignore', 'pipe', 'pipe'] : ['pipe', 'pipe', 'pipe'],
        env: { ...process.env, ...GIT_ENV },
      })
    } catch (error) {
      reject(new ApiError('git-missing', error.message, 503))
      return
    }
    if (options.input !== undefined) {
      child.stdin.on('error', () => {
        // The child may exit before reading a large patch; the exit code still
        // reports the real result.
      })
      child.stdin.end(options.input)
    }
    let stdout = ''
    let stderr = ''
    let bytes = 0
    let settled = false
    /** @type {NodeJS.Timeout | undefined} */
    let timer
    const onAbort = () => {
      try { child.kill() } catch { /* already gone */ }
      settle(new ApiError('aborted', 'request aborted', 499))
    }
    const settle = (error, value) => {
      if (settled) return
      settled = true
      if (timer !== undefined) clearTimeout(timer)
      options.signal?.removeEventListener?.('abort', onAbort)
      if (error === null) resolve(value)
      else reject(error)
    }
    timer = setTimeout(() => {
      try { child.kill() } catch { /* already gone */ }
      settle(new ApiError('timeout', `git ${args[0] ?? ''} timed out after ${timeoutMs}ms`, 504))
    }, timeoutMs)
    if (options.signal !== undefined) {
      if (options.signal.aborted) {
        onAbort()
        return
      }
      options.signal.addEventListener('abort', onAbort, { once: true })
    }
    child.stdout.setEncoding('utf8')
    child.stderr.setEncoding('utf8')
    child.stdout.on('data', (chunk) => {
      bytes += chunk.length
      if (bytes > maxBytes) {
        settle(new ApiError('too-large', 'git output exceeded the size limit', 413))
        return
      }
      stdout += chunk
    })
    child.stderr.on('data', (chunk) => {
      if (stderr.length < STDERR_LIMIT_CHARS) stderr += chunk
    })
    child.on('error', (error) => {
      const missing = error.code === 'ENOENT'
      settle(new ApiError(missing ? 'git-missing' : 'spawn-failed', missing ? 'git executable not found' : error.message, 503))
    })
    child.on('close', (code) => {
      if (code === 0) {
        settle(null, options.rawResult === true ? { code, stdout, stderr } : stdout)
        return
      }
      // `git diff --no-index` answers 1 when the files differ — the expected
      // outcome when diffing an untracked file against /dev/null.
      if (Array.isArray(options.exitCodes) && options.exitCodes.includes(code)) {
        settle(null, options.rawResult === true ? { code, stdout, stderr } : stdout)
        return
      }
      const detail = stderr.trim()
      if (/not a git repository/i.test(detail)) {
        settle(new ApiError('not-repo', 'not a git repository', 409))
        return
      }
      if (/not found/i.test(detail) && /git/i.test(firstLine(detail))) {
        settle(new ApiError('git-missing', 'git executable not found', 503))
        return
      }
      settle(new ApiError('git-error', firstLine(detail) || `git ${args[0] ?? ''} failed (exit ${code})`, 400, {
        command: `git ${args.join(' ')}`,
        detail: detail.slice(0, 4_000),
      }))
    })
  })
}

/** runGit with the trailing newline removed (single-value reads). */
async function gitText(cwd, args, options) {
  const out = await runGit(cwd, args, options)
  return out.replace(/\r?\n$/, '')
}

/**
 * Resolve the session's effective working directory.
 *
 * @param {import('@deepseek-ai/cordis').Context} ctx - plugin context.
 * @param {unknown} sessionId - claimed session id.
 * @returns {{ session: any, cwd: string }}
 */
function resolveSessionCwd(ctx, sessionId) {
  if (typeof sessionId !== 'string' || sessionId === '') {
    throw new ApiError('bad-request', 'sessionId required')
  }
  const session = ctx.sessions.get(sessionId)
  if (session === undefined) throw new ApiError('session-not-found', 'session is not live', 404)
  let cwd
  try {
    cwd = ctx.get('workingDirectory')?.get(session) ?? session.header?.cwd
  } catch {
    cwd = session.header?.cwd
  }
  if (typeof cwd !== 'string' || cwd === '') throw new ApiError('no-cwd', 'session has no working directory', 409)
  return { session, cwd }
}

/** Whether the session currently has an open turn (agent is working on it). */
function isSessionRunning(ctx, session) {
  try {
    // `ctx.get` is the inject-free read: a bare `ctx.agents` access throws on
    // Cordis contexts that did not declare the service, which would otherwise
    // make this guard silently always false.
    const agents = ctx.get('agents')
    const boundary = agents?.turnBoundaryOf?.(session)
    return boundary !== undefined && boundary.openTurnStartSeq !== null
  } catch {
    return false
  }
}

/** Refuse a name that could be mistaken for an option or is not a ref. */
function assertSafeRef(ref) {
  if (typeof ref !== 'string' || ref === '') throw new ApiError('bad-request', 'branch name required')
  if (ref.length > 250) throw new ApiError('bad-request', 'branch name is too long')
  if (ref.startsWith('-') || ref.includes('\0') || ref.includes('..') || ref.includes(' ')) {
    throw new ApiError('bad-request', `invalid branch name: ${ref}`)
  }
}

/** Parse `git status --porcelain=v2 -z --branch` output. */
function parseStatusV2(raw) {
  const result = {
    branch: null,
    detached: false,
    head: null,
    upstream: null,
    ahead: 0,
    behind: 0,
    staged: 0,
    unstaged: 0,
    untracked: 0,
    conflicts: 0,
    changed: 0,
    truncated: false,
  }
  const fields = raw.split('\0')
  for (let index = 0; index < fields.length; index += 1) {
    const field = fields[index]
    if (field === '') continue
    if (field.startsWith('# ')) {
      const line = field.slice(2)
      if (line.startsWith('branch.oid ')) result.head = line.slice('branch.oid '.length).trim()
      else if (line.startsWith('branch.head ')) {
        const value = line.slice('branch.head '.length).trim()
        if (value === '(detached)') result.detached = true
        else result.branch = value
      } else if (line.startsWith('branch.upstream ')) result.upstream = line.slice('branch.upstream '.length).trim()
      else if (line.startsWith('branch.ab ')) {
        const match = /^\+(\d+)\s+-(\d+)/.exec(line.slice('branch.ab '.length))
        if (match !== null) {
          result.ahead = Number(match[1])
          result.behind = Number(match[2])
        }
      }
      continue
    }
    if (field.startsWith('2 ')) {
      // Rename/copy: one record followed by the original path.
      countStatus(result, field.slice(2, 4))
      index += 1
      continue
    }
    if (field.startsWith('1 ')) {
      countStatus(result, field.slice(2, 4))
      continue
    }
    if (field.startsWith('u ')) {
      countStatus(result, field.slice(2, 4))
      result.conflicts += 1
      continue
    }
    if (field.startsWith('? ')) {
      result.untracked += 1
      result.changed += 1
      continue
    }
    // `!` (ignored) and anything unknown contribute nothing.
  }
  if (result.changed > STATUS_ROW_LIMIT) {
    result.truncated = true
    result.changed = STATUS_ROW_LIMIT
  }
  return result
}

/** Count one `XY` status pair into the aggregate buckets. */
function countStatus(result, xy) {
  const x = xy[0]
  const y = xy[1]
  if (x !== '.' && x !== undefined) result.staged += 1
  if (y !== '.' && y !== undefined) result.unstaged += 1
  result.changed += 1
}

/** Detect an in-progress merge/rebase/cherry-pick in the git directory. */
async function detectOperation(gitDir) {
  for (const [marker, operation] of OPERATION_MARKERS) {
    try {
      await stat(join(gitDir, marker))
      return operation
    } catch {
      // Not present: keep looking.
    }
  }
  return 'none'
}

/**
 * Classify one unmerged index entry by its porcelain XY code.
 *
 * @param {string} x - index-side status code.
 * @param {string} y - worktree-side status code.
 * @returns {string} conflict type key.
 */
function conflictTypeOf(x, y) {
  const code = `${x}${y}`
  if (code === 'UU') return 'content'
  if (code === 'AA') return 'both-added'
  if (code === 'DD') return 'both-deleted'
  if (code === 'AU' || code === 'UA') return 'added'
  if (code === 'DU' || code === 'UD') return 'deleted-modified'
  return 'other'
}

/**
 * Read the full repository state for one session.
 *
 * @param {import('@deepseek-ai/cordis').Context} ctx - plugin context.
 * @param {unknown} sessionId - session id from the request.
 * @param {AbortSignal} [signal] - cancellation.
 * @returns {Promise<object>} repository state.
 */
async function readRepoState(ctx, sessionId, signal) {
  const { session, cwd } = resolveSessionCwd(ctx, sessionId)
  const registered = sessionId === undefined || sessionId === null ? undefined : activeRepoBySession.get(sessionId)
  const baseCwd = typeof registered === 'string' && registered !== '' ? registered : cwd
  let repoRoot
  try {
    repoRoot = await gitText(baseCwd, ['rev-parse', '--show-toplevel'], { signal })
  } catch (error) {
    if (error instanceof ApiError && error.code === 'not-repo') {
      if (baseCwd !== cwd) activeRepoBySession.delete(sessionId)
      throw new ApiError('not-repo', 'session directory is not a git repository', 409, { cwd: baseCwd })
    }
    throw error
  }
  const gitDir = await gitText(repoRoot, ['rev-parse', '--absolute-git-dir'], { signal })
  const [statusRaw, operation] = await Promise.all([
    runGit(repoRoot, ['status', '--porcelain=v2', '-z', '--branch', '--untracked-files=normal'], { signal }),
    detectOperation(gitDir),
  ])
  const status = parseStatusV2(statusRaw)
  const conflictRows = parseStatusRows(statusRaw).filter((row) => row.conflict === true)
  const conflictPaths = conflictRows.map((row) => row.path)
  const conflictTypes = conflictRows.map((row) => ({
    path: row.path,
    type: conflictTypeOf(row.x, row.y),
    code: `${row.x}${row.y}`,
  }))
  return {
    repoRoot,
    repoName: basename(repoRoot),
    gitDir,
    branch: status.branch,
    detached: status.detached,
    head: status.head,
    upstream: status.upstream,
    ahead: status.ahead,
    behind: status.behind,
    operation,
    conflictPaths,
    conflictTypes,
    running: isSessionRunning(ctx, session),
    changes: {
      staged: status.staged,
      unstaged: status.unstaged,
      untracked: status.untracked,
      conflicts: status.conflicts,
      changed: status.changed,
      truncated: status.truncated,
    },
    cwd,
  }
}

/** Parse NUL-free, tab-separated for-each-ref output. */
function parseRefLines(raw, kind) {
  const rows = []
  for (const line of raw.split('\n')) {
    if (line.trim() === '') continue
    const parts = line.split('\t')
    if (parts.length < 6) continue
    const name = parts[0]
    if (name === '') continue
    if (kind === 'remote' && name.endsWith('/HEAD')) continue
    rows.push({
      name,
      sha: parts[1],
      committedAt: Number(parts[2]) * 1000,
      upstream: parts[3] === '' ? null : parts[3],
      current: parts[4] === '*',
      subject: parts.slice(5).join('\t'),
    })
  }
  return rows
}

/**
 * List local and remote branches.
 *
 * @param {string} repoRoot - repository root.
 * @param {AbortSignal} [signal] - cancellation.
 * @returns {Promise<{ local: object[], remote: object[] }>} branches.
 */
async function readBranches(repoRoot, signal) {
  const format = [
    '%(refname:short)',
    '%(objectname:short)',
    '%(committerdate:unix)',
    '%(upstream:short)',
    '%(HEAD)',
    '%(subject)',
  ].join('\t')
  const [localRaw, remoteRaw] = await Promise.all([
    runGit(repoRoot, ['for-each-ref', `--format=${format}`, 'refs/heads'], { signal }),
    runGit(repoRoot, ['for-each-ref', `--format=${format}`, 'refs/remotes'], { signal }),
  ])
  const local = parseRefLines(localRaw, 'local')
  local.sort((left, right) => {
    if (left.current !== right.current) return left.current ? -1 : 1
    if (right.committedAt !== left.committedAt) return right.committedAt - left.committedAt
    return left.name.localeCompare(right.name)
  })
  const remote = parseRefLines(remoteRaw, 'remote').sort((left, right) => right.committedAt - left.committedAt)
  return { local, remote }
}

// ── P1: change lists and comparisons ──────────────────────────────────────

/** One status record from `--porcelain=v2 -z`. */
function parseStatusRows(raw) {
  const fields = raw.split('\0')
  const rows = []
  for (let index = 0; index < fields.length; index += 1) {
    const field = fields[index]
    if (field === '' || field.startsWith('# ')) continue
    if (field.startsWith('2 ')) {
      // Rename/copy: record carries the new path; the original path is the
      // NEXT NUL field.
      const parts = field.split(' ')
      rows.push({ path: parts.slice(9).join(' '), origPath: fields[index + 1], x: field[2], y: field[3] })
      index += 1
      continue
    }
    if (field.startsWith('1 ')) {
      const parts = field.split(' ')
      rows.push({ path: parts.slice(8).join(' '), x: field[2], y: field[3] })
      continue
    }
    if (field.startsWith('u ')) {
      const parts = field.split(' ')
      rows.push({ path: parts.slice(10).join(' '), x: field[2], y: field[3], conflict: true })
      continue
    }
    if (field.startsWith('? ')) {
      rows.push({ path: field.slice(2), untracked: true })
    }
  }
  return rows
}

/** Parse `git diff --numstat -z` into path → counts. */
function parseNumstat(raw) {
  const map = new Map()
  const fields = raw.split('\0')
  for (let index = 0; index < fields.length; index += 1) {
    const field = fields[index]
    if (field === '') continue
    const parts = field.split('\t')
    if (parts.length < 3) continue
    const additions = parts[0] === '-' ? null : Number(parts[0])
    const deletions = parts[1] === '-' ? null : Number(parts[1])
    const binary = parts[0] === '-'
    if (parts[2] === '') {
      const newPath = fields[index + 2]
      index += 2
      if (typeof newPath === 'string' && newPath !== '') map.set(newPath, { additions, deletions, binary })
      continue
    }
    map.set(parts[2], { additions, deletions, binary })
  }
  return map
}

/** Parse `git diff --name-status -z` into rows. */
function parseNameStatus(raw) {
  const fields = raw.split('\0')
  const rows = []
  for (let index = 0; index < fields.length; index += 1) {
    const status = fields[index]
    if (status === '') continue
    const letter = status[0]
    if (letter === 'R' || letter === 'C') {
      rows.push({ path: fields[index + 2], origPath: fields[index + 1], status: letter })
      index += 2
      continue
    }
    const path = fields[index + 1]
    if (typeof path !== 'string' || path === '') continue
    rows.push({ path, origPath: null, status: letter === 'T' ? 'M' : letter })
    index += 1
  }
  return rows
}

/** One-letter status for a porcelain-v2 row. */
function statusLetter(row) {
  if (row.untracked === true) return '?'
  if (row.conflict === true) return 'U'
  const xy = `${row.x ?? '.'}${row.y ?? '.'}`
  for (const letter of xy) {
    if (letter === 'A' || letter === 'D' || letter === 'R' || letter === 'C') return letter
  }
  return 'M'
}

/** Size one untracked file: bounded read, NUL-detected binary, line count. */
async function sizeUntrackedFile(repoRoot, relativePath) {
  try {
    const absolute = join(repoRoot, relativePath)
    const info = await stat(absolute)
    if (!info.isFile() || info.size > UNTRACKED_READ_LIMIT) return { additions: null, deletions: 0, binary: false }
    const data = await readFile(absolute)
    if (data.subarray(0, 8_000).includes(0)) return { additions: null, deletions: 0, binary: true }
    const text = data.toString('utf8')
    const lines = text === '' ? 0 : text.split('\n').length - (text.endsWith('\n') ? 1 : 0)
    return { additions: lines, deletions: 0, binary: false }
  } catch {
    return { additions: null, deletions: 0, binary: false }
  }
}

/** Reject a client path that could escape the repository. */
function assertRepoPath(value) {
  if (typeof value !== 'string' || value === '') throw new ApiError('bad-request', 'path required')
  if (value.length > 4_096) throw new ApiError('bad-request', 'path is too long')
  if (value.startsWith('/') || /^[A-Za-z]:[\\/]/.test(value) || value.includes('\0')) {
    throw new ApiError('bad-request', 'path must be repository-relative')
  }
  for (const segment of value.split('/')) {
    if (segment === '' || segment === '.' || segment === '..') throw new ApiError('bad-request', 'invalid path')
  }
  return value
}

/**
 * Resolve the comparison base and its candidate list.
 *
 * @param {string} repoRoot - repository root.
 * @param {unknown} requested - explicit base from the client, if any.
 * @param {AbortSignal} [signal] - cancellation.
 * @returns {Promise<{ base: string | null, baseCandidates: string[] }>}
 */
async function resolveBase(repoRoot, requested, signal) {
  const candidates = []
  const push = (name) => {
    if (typeof name === 'string' && name !== '' && !candidates.includes(name)) candidates.push(name)
  }
  try {
    const symbolic = await gitText(repoRoot, ['symbolic-ref', '--quiet', 'refs/remotes/origin/HEAD'], { signal })
    push(symbolic.replace(/^refs\/remotes\//, ''))
  } catch {
    // No origin/HEAD: fall through to the usual names.
  }
  for (const guess of ['origin/main', 'origin/master', 'main', 'master']) push(guess)
  try {
    const branches = await readBranches(repoRoot, signal)
    for (const branch of branches.remote) push(branch.name)
    for (const branch of branches.local) push(branch.name)
  } catch {
    // Candidate discovery is best-effort; the verified list may be shorter.
  }
  const verified = []
  for (const name of candidates.slice(0, 40)) {
    try {
      await runGit(repoRoot, ['rev-parse', '--verify', '--quiet', `${name}^{commit}`], { signal })
      verified.push(name)
    } catch {
      // Not a commit ref: skip.
    }
  }
  if (typeof requested === 'string' && requested !== '') {
    if (!verified.includes(requested)) throw new ApiError('unknown-ref', `base not found: ${requested}`, 404)
    return { base: requested, baseCandidates: verified.slice(0, 20) }
  }
  const preferred = verified.find((name) => name === 'origin/main' || name === 'origin/master' || name === 'main' || name === 'master')
  return { base: preferred ?? verified[0] ?? null, baseCandidates: verified.slice(0, 20) }
}

/**
 * Parse a unified diff into structured hunks.
 *
 * @param {string} raw - `git diff --no-color` output.
 * @returns {{ binary: boolean, hunks: object[], truncated: boolean }} parsed diff.
 */
function parseUnifiedDiff(raw) {
  const hunks = []
  let current = null
  let oldNo = 0
  let newNo = 0
  let lineCount = 0
  const binary = /^Binary files .* differ$/m.test(raw)
  for (const line of raw.split('\n')) {
    const header = /^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@/.exec(line)
    if (header !== null) {
      current = {
        oldStart: Number(header[1]),
        oldLines: header[2] === undefined ? 1 : Number(header[2]),
        newStart: Number(header[3]),
        newLines: header[4] === undefined ? 1 : Number(header[4]),
        lines: [],
      }
      hunks.push(current)
      oldNo = current.oldStart
      newNo = current.newStart
      continue
    }
    if (current === null) continue
    if (line.startsWith('\\')) continue
    const kind = line[0]
    if (kind !== ' ' && kind !== '+' && kind !== '-') continue
    lineCount += 1
    if (lineCount > DIFF_LINE_LIMIT) return { binary, hunks, truncated: true }
    const text = line.slice(1)
    if (kind === ' ') {
      current.lines.push({ kind: ' ', oldNo, newNo, text })
      oldNo += 1
      newNo += 1
    } else if (kind === '-') {
      current.lines.push({ kind: '-', oldNo, newNo: null, text })
      oldNo += 1
    } else {
      current.lines.push({ kind: '+', oldNo: null, newNo, text })
      newNo += 1
    }
  }
  return { binary, hunks, truncated: false }
}

/**
 * Split raw unified-diff text into a preamble and hunk blocks.
 *
 * @param {string} raw - git diff output for one file.
 * @returns {{ preamble: string[], hunks: object[] }} blocks to rebuild a patch from.
 */
function splitRawDiff(raw) {
  const lines = raw.split('\n')
  if (lines.length > 0 && lines[lines.length - 1] === '') lines.pop()
  const preamble = []
  const hunks = []
  let current = null
  for (const line of lines) {
    if (line.startsWith('@@')) {
      current = { header: line, body: [] }
      hunks.push(current)
      continue
    }
    if (current === null) {
      preamble.push(line)
      continue
    }
    current.body.push(line)
  }
  return { preamble, hunks }
}

/**
 * Rebuild one hunk with a selected subset of its change lines.
 *
 * @param {string} header - original `@@` header line.
 * @param {string[]} body - original body lines.
 * @param {boolean[]} keep - one flag per body line.
 * @returns {string} rebuilt hunk, or '' when nothing is left.
 */
function rebuildHunk(header, body, keep) {
  let oldCount = 0
  let newCount = 0
  for (let index = 0; index < body.length; index += 1) {
    if (keep[index] !== true) continue
    const kind = body[index][0]
    if (kind === ' ') {
      oldCount += 1
      newCount += 1
    } else if (kind === '-') {
      oldCount += 1
    } else if (kind === '+') {
      newCount += 1
    }
  }
  if (oldCount === 0 && newCount === 0) return ''
  const match = /^@@ -(\d+)(?:,\d+)? \+(\d+)(?:,\d+)? @@/.exec(header)
  if (match === null) return ''
  const format = (start, count) => `${start}${count === 1 ? '' : `,${count}`}`
  const out = [`@@ -${format(Number(match[1]), oldCount)} +${format(Number(match[2]), newCount)} @@`]
  for (let index = 0; index < body.length; index += 1) {
    if (keep[index] === true) out.push(body[index])
  }
  return out.join('\n')
}

/**
 * Turn the client's `{ hunk, changeLines }` selection into per-body-line flags.
 *
 * Context lines are always kept so the hunk stays contiguous; `\ No newline`
 * markers follow their preceding line.
 *
 * @param {unknown} specs - requested selection list.
 * @param {object[]} hunks - raw hunk blocks.
 * @returns {(boolean[])[]} matrix indexed by hunk position.
 */
function patchKeepMatrix(specs, hunks) {
  const matrix = []
  const entries = Array.isArray(specs) ? specs : []
  for (const spec of entries) {
    if (spec === null || typeof spec !== 'object') continue
    const hunkIndex = Number(spec.hunk)
    if (!Number.isInteger(hunkIndex) || hunkIndex < 0 || hunkIndex >= hunks.length) continue
    const ordinals = Array.isArray(spec.changeLines)
      ? [...new Set(spec.changeLines.map((value) => Number(value)).filter((value) => Number.isInteger(value) && value >= 0))]
      : null
    const keep = []
    let ordinal = 0
    let lastKept = true
    let anySelected = false
    for (const line of hunks[hunkIndex].body) {
      const kind = line[0]
      if (kind === '\\') {
        keep.push(lastKept)
        continue
      }
      if (kind === ' ') {
        keep.push(true)
        lastKept = true
        continue
      }
      if (kind !== '+' && kind !== '-') {
        keep.push(false)
        lastKept = false
        continue
      }
      const selected = ordinals === null ? true : ordinals.includes(ordinal)
      keep.push(selected)
      lastKept = selected
      if (selected) anySelected = true
      ordinal += 1
    }
    if (anySelected) matrix[hunkIndex] = keep
  }
  return matrix
}

/** Blob hash of one path as stored in the index ('' when absent). */
async function indexBlobHash(repoRoot, path, signal) {
  try {
    return (await gitText(repoRoot, ['rev-parse', '--verify', '--quiet', `:${path}`], { signal })).trim()
  } catch {
    return ''
  }
}

/** Git blob hash of a worktree file, computed without spawning git. */
async function worktreeBlobHash(repoRoot, relativePath) {
  try {
    const bytes = await readFile(join(repoRoot, relativePath))
    return createHash('sha1').update(`blob ${bytes.length}\0`).update(bytes).digest('hex')
  } catch {
    return null
  }
}

/**
 * Stage or unstage a selected subset of one file's changes.
 *
 * @param {import('@deepseek-ai/cordis').Context} ctx - plugin context.
 * @param {object} body - `{ sessionId, direction, path, untracked?, hunks, expectedIndexTree?, expectedWorktreeHash? }`.
 * @returns {Promise<object>} the refreshed repository state.
 */
async function applyPatch(ctx, body, signal) {
  const direction = body.direction === 'unstage' ? 'unstage' : 'stage'
  const path = assertRepoPath(body.path)
  const repoRoot = await resolveRepoRoot(ctx, body.sessionId, signal)
  return withRepoLock(repoRoot, async () => {
    const before = await readRepoState(ctx, body.sessionId, signal)
    if (before.operation === 'merge') throw new ApiError('merge-open', 'complete the merge first', 409, { state: before })
    if (before.operation !== 'none') throw new ApiError('operation-in-progress', `a ${before.operation} is in progress`, 409, { state: before })
    if (before.conflictPaths.includes(path)) {
      throw new ApiError('conflicted', 'resolve this conflict before staging parts of it', 409, { conflicts: before.conflictTypes })
    }
    const indexHash = await indexBlobHash(before.repoRoot, path, signal)
    if (typeof body.expectedIndexTree === 'string' && body.expectedIndexTree !== indexHash) {
      throw new ApiError('patch-stale', 'the staged version changed since this diff was loaded; refresh and retry', 409, { indexTree: indexHash })
    }
    if (direction === 'stage') {
      const worktreeHash = await worktreeBlobHash(before.repoRoot, path)
      if (typeof body.expectedWorktreeHash === 'string' && worktreeHash !== null && body.expectedWorktreeHash !== worktreeHash) {
        throw new ApiError('patch-stale', 'the working tree changed since this diff was loaded; refresh and retry', 409, {})
      }
    }
    const args = ['diff']
    if (direction === 'unstage') args.push('--cached')
    args.push('--no-color', '--no-ext-diff', '-U3')
    if (direction === 'stage' && body.untracked === true) {
      args.push('--no-index', '--', '/dev/null', path)
    } else {
      args.push('--', path)
    }
    const raw = await runGit(before.repoRoot, args, { signal, exitCodes: [0, 1], maxBytes: DIFF_OUTPUT_LIMIT })
    if (/^Binary files .* differ$/m.test(raw)) {
      throw new ApiError('binary-file', 'binary files cannot be partially staged', 409)
    }
    const { preamble, hunks } = splitRawDiff(raw)
    const matrix = patchKeepMatrix(body.hunks, hunks)
    const parts = []
    if (preamble.length > 0) parts.push(preamble.join('\n'))
    let appliedHunks = 0
    let appliedLines = 0
    for (let index = 0; index < hunks.length; index += 1) {
      const keep = matrix[index]
      if (keep === undefined) continue
      const rebuilt = rebuildHunk(hunks[index].header, hunks[index].body, keep)
      if (rebuilt === '') continue
      parts.push(rebuilt)
      appliedHunks += 1
      appliedLines += keep.filter(Boolean).length
    }
    if (appliedHunks === 0) throw new ApiError('nothing-selected', 'select at least one change line', 400)
    const applyArgs = ['apply', '--cached']
    if (direction === 'unstage') applyArgs.push('--reverse')
    const result = await runGit(before.repoRoot, applyArgs, {
      signal,
      input: `${parts.join('\n')}\n`,
      rawResult: true,
      exitCodes: [0, 1],
      timeoutMs: WRITE_TIMEOUT_MS,
    })
    if (result.code !== 0) {
      const detail = String(result.stderr ?? '')
      const reason = /does not apply|conflict|corrupt|patch failed/i.test(detail)
        ? 'the selected changes do not apply cleanly'
        : firstLine(detail) || 'git apply failed'
      throw new ApiError(reason === '' ? 'patch-failed' : 'patch-failed', reason, 409, { detail: detail.slice(0, 4_000) })
    }
    await appendAudit({
      action: direction === 'stage' ? 'stage.patch' : 'unstage.patch',
      repoRoot: before.repoRoot,
      branch: before.branch,
      target: [path],
      result: 'ok',
      details: { hunks: appliedHunks, lines: appliedLines },
    })
    return {
      repo: await readRepoState(ctx, body.sessionId, signal),
      applied: { path, direction, hunks: appliedHunks, lines: appliedLines },
    }
  })
}

// ── A3: three-way conflict inspection ──────────────────────────────────────

/** Largest text blob served for the conflict editor. */
const CONFLICT_CONTENT_LIMIT = 512 * 1024

/** Read one stage's version of a path; null when that side has no file. */
async function conflictStageContent(repoRoot, stage, path, signal) {
  try {
    const raw = await runGit(repoRoot, ['show', `:${stage}:${path}`], { signal, maxBytes: CONFLICT_CONTENT_LIMIT, exitCodes: [0, 1] })
    if (raw.length >= CONFLICT_CONTENT_LIMIT) {
      return { content: raw.slice(0, CONFLICT_CONTENT_LIMIT), truncated: true, binary: false }
    }
    const binary = raw.includes('\u0000')
    return { content: binary ? '' : raw, truncated: false, binary }
  } catch {
    return null
  }
}

/**
 * Describe every open conflict with all four versions of each file.
 *
 * @param {import('@deepseek-ai/cordis').Context} ctx - plugin context.
 * @param {object} body - `{ sessionId }`.
 * @param {AbortSignal} [signal] - cancellation.
 * @returns {Promise<object>} the conflict descriptions.
 */
async function readConflictInfo(ctx, body, signal) {
  const state = await readRepoState(ctx, body.sessionId, signal)
  if (state.operation !== 'merge') {
    return { operation: state.operation, conflicts: [] }
  }
  const rows = []
  for (const item of state.conflictTypes) {
    const base = await conflictStageContent(state.repoRoot, 1, item.path, signal)
    const ours = await conflictStageContent(state.repoRoot, 2, item.path, signal)
    const theirs = await conflictStageContent(state.repoRoot, 3, item.path, signal)
    let result = null
    try {
      const bytes = await readFile(join(state.repoRoot, item.path))
      result = {
        content: bytes.toString('utf8').slice(0, CONFLICT_CONTENT_LIMIT),
        truncated: bytes.length > CONFLICT_CONTENT_LIMIT,
        binary: bytes.includes(0),
      }
    } catch {
      result = null
    }
    rows.push({
      path: item.path,
      type: item.type,
      code: item.code,
      base,
      ours,
      theirs,
      result,
      markerCount: result === null || result.binary ? 0 : (result.content.match(/^(<{7}|={7}|>{7})(?!={7}$)/gm) ?? []).length,
    })
  }
  rows.sort((left, right) => left.path.localeCompare(right.path))
  return { operation: 'merge', branch: state.branch, conflicts: rows }
}

/**
 * Apply one side of a conflict to the worktree and mark it resolved.
 *
 * @param {import('@deepseek-ai/cordis').Context} ctx - plugin context.
 * @param {object} body - `{ sessionId, path, side: 'ours' | 'theirs' }`.
 * @param {AbortSignal} [signal] - cancellation.
 * @returns {Promise<object>} the refreshed repository state.
 */
async function acceptConflictSide(ctx, body, signal) {
  const path = assertRepoPath(body.path)
  const side = body.side === 'theirs' ? 'theirs' : 'ours'
  const repoRoot = await resolveRepoRoot(ctx, body.sessionId, signal)
  return withRepoLock(repoRoot, async () => {
    const before = await readRepoState(ctx, body.sessionId, signal)
    if (before.operation !== 'merge') throw new ApiError('no-merge', 'no merge is in progress', 409)
    if (!before.conflictPaths.includes(path)) {
      throw new ApiError('not-conflicted', `not a conflicted path: ${path}`, 400, { conflicts: before.conflictPaths })
    }
    const checkout = await runGit(before.repoRoot, ['checkout', `--${side}`, '--', path], {
      signal,
      rawResult: true,
      exitCodes: [0, 1],
      timeoutMs: WRITE_TIMEOUT_MS,
    })
    if (checkout.code !== 0) {
      throw new ApiError('conflict-accept-failed', firstLine(checkout.stderr) || `git checkout --${side} failed`, 409, {
        detail: String(checkout.stderr ?? '').slice(0, 4_000),
      })
    }
    await runGit(before.repoRoot, ['add', '--', path], { signal, timeoutMs: WRITE_TIMEOUT_MS })
    await appendAudit({ action: 'conflict.accept', repoRoot: before.repoRoot, branch: before.branch, target: [path], result: side })
    const after = await readRepoState(ctx, body.sessionId, signal)
    return { repo: after, conflicts: after.conflictTypes }
  })
}

/**
 * Save an edited RESULT body for one conflict and mark it resolved.
 *
 * @param {import('@deepseek-ai/cordis').Context} ctx - plugin context.
 * @param {object} body - `{ sessionId, path, content }`.
 * @param {AbortSignal} [signal] - cancellation.
 * @returns {Promise<object>} the refreshed repository state.
 */
async function saveConflictResult(ctx, body, signal) {
  const path = assertRepoPath(body.path)
  if (typeof body.content !== 'string') throw new ApiError('bad-request', 'content is required', 400)
  const repoRoot = await resolveRepoRoot(ctx, body.sessionId, signal)
  return withRepoLock(repoRoot, async () => {
    const before = await readRepoState(ctx, body.sessionId, signal)
    if (before.operation !== 'merge') throw new ApiError('no-merge', 'no merge is in progress', 409)
    if (!before.conflictPaths.includes(path)) {
      throw new ApiError('not-conflicted', `not a conflicted path: ${path}`, 400, { conflicts: before.conflictPaths })
    }
    const target = join(before.repoRoot, path)
    try {
      await mkdir(dirname(target), { recursive: true })
      await writeFile(target, body.content, 'utf8')
    } catch {
      throw new ApiError('conflict-save-failed', 'could not write the conflicted file', 409, { path })
    }
    await runGit(before.repoRoot, ['add', '--', path], { signal, timeoutMs: WRITE_TIMEOUT_MS })
    await appendAudit({ action: 'conflict.save', repoRoot: before.repoRoot, branch: before.branch, target: [path], result: 'ok' })
    const after = await readRepoState(ctx, body.sessionId, signal)
    return { repo: after, conflicts: after.conflictTypes }
  })
}

// ── A4: history, branch maintenance, stash, tags, revert/reset ─────────────

/** Field and record separators used by the log format. */
const LOG_FORMAT = ['%H', '%h', '%an', '%ae', '%at', '%P', '%s'].join('%x1f') + '%x1e'

/** Parse `git log` records into commit rows. */
function parseLogRecords(raw) {
  return String(raw ?? '')
    .split('\x1e')
    .map((record) => record.trim())
    .filter((record) => record !== '')
    .map((record) => {
      const parts = record.split('\x1f')
      return {
        id: parts[0] ?? '',
        short: parts[1] ?? '',
        author: parts[2] ?? '',
        email: parts[3] ?? '',
        at: Number(parts[4]) || 0,
        parents: typeof parts[5] === 'string' ? parts[5].split(' ').filter((value) => value !== '') : [],
        subject: parts.slice(6).join('\x1f'),
      }
    })
}

/** Clamp a page size to a sane window. */
function clampLimit(value, fallback, max) {
  const number = Number(value)
  if (!Number.isFinite(number) || number <= 0) return fallback
  return Math.min(Math.floor(number), max)
}

/**
 * Commit list for one repository, optionally narrowed to one path.
 *
 * @returns {Promise<{ commits: object[], total: number, path: string|null }>} history page.
 */
async function readHistory(ctx, body, signal) {
  const state = await readRepoState(ctx, body.sessionId, signal)
  const limit = clampLimit(body.limit, 50, 200)
  const offset = Math.max(0, Math.floor(Number(body.offset) || 0))
  const path = typeof body.path === 'string' && body.path !== '' ? assertRepoPath(body.path) : null
  const args = ['log', `--format=${LOG_FORMAT}`, '--no-color']
  if (path !== null) args.push('--follow', '--', path)
  args.push(`--skip=${offset}`, `--max-count=${limit}`)
  const [commitsRaw, countRaw] = await Promise.all([
    runGit(state.repoRoot, args, { signal, maxBytes: 8_000_000 }),
    runGit(state.repoRoot, ['rev-list', '--count', 'HEAD', ...(path === null ? [] : ['--', path])], { signal }),
  ])
  return { commits: parseLogRecords(commitsRaw), total: Number(countRaw.trim()) || 0, path }
}

/**
 * One commit with its changed files and an optional single-file diff.
 *
 * @param {object} body - `{ sessionId, commit, path? }`.
 * @returns {Promise<object>} commit detail.
 */
async function readCommitDetail(ctx, body, signal) {
  const state = await readRepoState(ctx, body.sessionId, signal)
  assertSafeRef(body.commit)
  const commit = body.commit
  try {
    await gitText(state.repoRoot, ['rev-parse', '--verify', '--quiet', `${commit}^{commit}`], { signal })
  } catch {
    throw new ApiError('unknown-ref', `commit not found: ${commit}`, 404)
  }
  const metaRaw = await gitText(state.repoRoot, ['show', '-s', `--format=${LOG_FORMAT}`, commit], { signal })
  const row = parseLogRecords(metaRaw)[0] ?? null
  const nameStatusRaw = await runGit(
    state.repoRoot,
    ['diff-tree', '--no-commit-id', '--name-status', '-r', '--root', '-m', '--first-parent', '-z', commit],
    { signal, exitCodes: [0, 1] },
  )
  const numstatRaw = await runGit(
    state.repoRoot,
    ['diff-tree', '--no-commit-id', '--numstat', '-r', '--root', '-m', '--first-parent', '-z', commit],
    { signal, exitCodes: [0, 1] },
  )
  const counts = parseNumstat(numstatRaw)
  const files = parseNameStatus(nameStatusRaw).map((entry) => Object.assign({}, entry, counts.get(entry.path) ?? {}))
  let diff = null
  if (typeof body.path === 'string' && body.path !== '') {
    const path = assertRepoPath(body.path)
    const raw = await runGit(
      state.repoRoot,
      ['show', '--no-color', '--no-ext-diff', '-U3', commit, '--', path],
      { signal, maxBytes: DIFF_OUTPUT_LIMIT, exitCodes: [0, 1] },
    )
    const parsed = parseUnifiedDiff(raw)
    diff = { path, binary: parsed.binary, hunks: parsed.hunks, truncated: parsed.truncated }
  }
  return { commit: row, files, diff, parents: row === null ? [] : row.parents }
}

/**
 * Compare two refs: divergence, commits on one side, and file changes.
 *
 * @param {object} body - `{ sessionId, base, target }`.
 * @returns {Promise<object>} comparison result.
 */
async function compareRefs(ctx, body, signal) {
  const state = await readRepoState(ctx, body.sessionId, signal)
  assertSafeRef(body.base)
  assertSafeRef(body.target)
  const base = body.base
  const target = body.target
  for (const ref of [base, target]) {
    try {
      await gitText(state.repoRoot, ['rev-parse', '--verify', '--quiet', `${ref}^{commit}`], { signal })
    } catch {
      throw new ApiError('unknown-ref', `ref not found: ${ref}`, 404)
    }
  }
  const [countsRaw, commitsRaw, filesRaw] = await Promise.all([
    gitText(state.repoRoot, ['rev-list', '--left-right', '--count', `${base}...${target}`], { signal }),
    runGit(state.repoRoot, ['log', `--format=${LOG_FORMAT}`, `${base}..${target}`], { signal, maxBytes: 4_000_000 }),
    runGit(state.repoRoot, ['diff', '--name-status', '-z', base, target], { signal, maxBytes: 2_000_000 }),
  ])
  const parts = countsRaw.trim().split(/\s+/)
  return {
    base,
    target,
    behind: Number(parts[0]) || 0,
    ahead: Number(parts[1]) || 0,
    commits: parseLogRecords(commitsRaw),
    files: parseNameStatus(filesRaw),
  }
}

/** Rename a local branch. */
async function renameBranchOp(ctx, body, signal) {
  const repoRoot = await resolveRepoRoot(ctx, body.sessionId, signal)
  return withRepoLock(repoRoot, async () => {
    const before = await readRepoState(ctx, body.sessionId, signal)
    assertNotBusy(before, body.confirmed)
    assertSafeRef(body.from)
    assertSafeRef(body.to)
    const from = body.from
    const to = body.to
    await assertBranchName(before.repoRoot, to, signal)
    const exists = await runGit(before.repoRoot, ['show-ref', '--verify', '--quiet', `refs/heads/${from}`], { signal }).then(() => true, () => false)
    if (!exists) throw new ApiError('unknown-branch', `branch not found: ${from}`, 404)
    if (from === to) throw new ApiError('same-branch', 'the new name equals the current name', 400)
    const taken = await runGit(before.repoRoot, ['show-ref', '--verify', '--quiet', `refs/heads/${to}`], { signal }).then(() => true, () => false)
    if (taken) throw new ApiError('branch-exists', `branch already exists: ${to}`, 409)
    await runGit(before.repoRoot, ['branch', '--move', from, to], { signal, timeoutMs: WRITE_TIMEOUT_MS })
    await appendAudit({ action: 'branch.rename', repoRoot: before.repoRoot, branch: from, target: [to], result: 'ok' })
    return { repo: await readRepoState(ctx, body.sessionId, signal), branches: await readBranches(before.repoRoot, signal) }
  })
}

/** Delete a local branch; `-D` only with explicit confirmation. */
async function deleteBranchOp(ctx, body, signal) {
  const repoRoot = await resolveRepoRoot(ctx, body.sessionId, signal)
  return withRepoLock(repoRoot, async () => {
    const before = await readRepoState(ctx, body.sessionId, signal)
    assertNotBusy(before, body.confirmed)
    assertSafeRef(body.name)
    const name = body.name
    if (before.branch === name) throw new ApiError('current-branch', 'cannot delete the checked-out branch', 409)
    const exists = await runGit(before.repoRoot, ['show-ref', '--verify', '--quiet', `refs/heads/${name}`], { signal }).then(() => true, () => false)
    if (!exists) throw new ApiError('unknown-branch', `branch not found: ${name}`, 404)
    const force = body.force === true && body.confirmed === true
    const args = force ? ['branch', '-D', name] : ['branch', '-d', name]
    const result = await runGit(before.repoRoot, args, { signal, rawResult: true, exitCodes: [0, 1], timeoutMs: WRITE_TIMEOUT_MS })
    if (result.code !== 0) {
      throw new ApiError('branch-not-merged', 'the branch has unmerged commits; confirm a forced delete', 409, {
        detail: String(result.stderr ?? '').slice(0, 2_000),
      })
    }
    await appendAudit({ action: 'branch.delete', repoRoot: before.repoRoot, branch: name, result: force ? 'forced' : 'ok' })
    return { repo: await readRepoState(ctx, body.sessionId, signal), branches: await readBranches(before.repoRoot, signal) }
  })
}

/** Rebase the current branch onto another ref. */
async function rebaseOnto(ctx, body, signal) {
  const repoRoot = await resolveRepoRoot(ctx, body.sessionId, signal)
  return withRepoLock(repoRoot, async () => {
    const before = await readRepoState(ctx, body.sessionId, signal)
    assertNotBusy(before, body.confirmed)
    assertSafeRef(body.target)
    const target = body.target
    assertSafeRef(typeof body.upstream === 'string' && body.upstream !== '' ? body.upstream : 'HEAD')
    const upstream = typeof body.upstream === 'string' && body.upstream !== '' ? body.upstream : null
    const args = upstream === null ? ['rebase', target] : ['rebase', '--onto', target, upstream]
    const result = await runGit(before.repoRoot, args, { signal, rawResult: true, exitCodes: [0, 1], timeoutMs: WRITE_TIMEOUT_MS })
    const after = await readRepoState(ctx, body.sessionId, signal)
    if (result.code !== 0) {
      await appendAudit({ action: 'rebase', repoRoot: before.repoRoot, branch: before.branch, target: [target], result: 'conflict' })
      throw new ApiError('rebase-conflict', 'the rebase stopped with conflicts', 409, {
        operation: after.operation,
        conflicts: after.conflictTypes,
        detail: String(result.stderr ?? '').slice(0, 2_000),
      })
    }
    await appendAudit({ action: 'rebase', repoRoot: before.repoRoot, branch: before.branch, target: [target], result: 'ok' })
    return { repo: after }
  })
}

/** Cherry-pick one or more commits onto the current branch. */
async function cherryPickCommit(ctx, body, signal) {
  const repoRoot = await resolveRepoRoot(ctx, body.sessionId, signal)
  return withRepoLock(repoRoot, async () => {
    const before = await readRepoState(ctx, body.sessionId, signal)
    assertNotBusy(before, body.confirmed)
    const commits = (Array.isArray(body.commits) ? body.commits : []).map((value) => { assertSafeRef(value); return value })
    if (commits.length === 0) throw new ApiError('bad-request', 'at least one commit is required', 400)
    const args = ['cherry-pick', ...commits]
    const result = await runGit(before.repoRoot, args, { signal, rawResult: true, exitCodes: [0, 1], timeoutMs: WRITE_TIMEOUT_MS })
    const after = await readRepoState(ctx, body.sessionId, signal)
    if (result.code !== 0) {
      throw new ApiError('cherry-pick-conflict', 'the cherry-pick stopped with conflicts', 409, {
        operation: after.operation,
        conflicts: after.conflictTypes,
        detail: String(result.stderr ?? '').slice(0, 2_000),
      })
    }
    await appendAudit({ action: 'cherry-pick', repoRoot: before.repoRoot, branch: before.branch, target: commits, result: 'ok' })
    return { repo: after }
  })
}

/** Continue an interrupted rebase/cherry-pick/revert. */
async function continueSequence(ctx, body, signal) {
  const repoRoot = await resolveRepoRoot(ctx, body.sessionId, signal)
  return withRepoLock(repoRoot, async () => {
    const before = await readRepoState(ctx, body.sessionId, signal)
    const map = { rebase: ['rebase', '--continue'], 'cherry-pick': ['cherry-pick', '--continue'], revert: ['revert', '--continue'] }
    const args = Object.hasOwn(map, before.operation) ? map[before.operation] : null
    if (args === null) throw new ApiError('no-operation', `no sequence is in progress (${before.operation})`, 409)
    if (before.conflictPaths.length > 0) {
      throw new ApiError('conflicts-remain', 'resolve every conflicted file first', 409, { conflicts: before.conflictTypes })
    }
    const result = await runGit(before.repoRoot, args, { signal, rawResult: true, exitCodes: [0, 1], timeoutMs: WRITE_TIMEOUT_MS })
    if (result.code !== 0) {
      throw new ApiError('sequence-failed', firstLine(result.stderr) || `git ${args.join(' ')} failed`, 409, { detail: String(result.stderr ?? '').slice(0, 2_000) })
    }
    await appendAudit({ action: 'sequence.continue', repoRoot: before.repoRoot, branch: before.branch, result: 'ok' })
    return { repo: await readRepoState(ctx, body.sessionId, signal) }
  })
}

/** Abort an interrupted rebase/cherry-pick/revert. */
async function abortSequence(ctx, body, signal) {
  const repoRoot = await resolveRepoRoot(ctx, body.sessionId, signal)
  return withRepoLock(repoRoot, async () => {
    const before = await readRepoState(ctx, body.sessionId, signal)
    const map = { rebase: ['rebase', '--abort'], 'cherry-pick': ['cherry-pick', '--abort'], revert: ['revert', '--abort'] }
    const args = Object.hasOwn(map, before.operation) ? map[before.operation] : null
    if (args === null) throw new ApiError('no-operation', `no sequence is in progress (${before.operation})`, 409)
    await runGit(before.repoRoot, args, { signal, timeoutMs: WRITE_TIMEOUT_MS })
    await appendAudit({ action: 'sequence.abort', repoRoot: before.repoRoot, branch: before.branch, result: 'ok' })
    return { repo: await readRepoState(ctx, body.sessionId, signal) }
  })
}

/** List lightweight and annotated tags with their target commits. */
async function listTags(ctx, body, signal) {
  const state = await readRepoState(ctx, body.sessionId, signal)
  const namesRaw = await runGit(state.repoRoot, ['for-each-ref', '--format=%(refname:short)', 'refs/tags'], { signal })
  const names = String(namesRaw).split('\n').map((name) => name.trim()).filter(Boolean).slice(0, 200)
  const tags = await Promise.all(names.map(async (name) => {
    try {
      const metaRaw = await gitText(state.repoRoot, ['log', '-1', `--format=${LOG_FORMAT}`, name], { signal })
      const row = parseLogRecords(metaRaw)[0] ?? null
      return {
        name,
        commit: row?.id ?? '',
        createdAt: row?.at ?? 0,
        subject: row?.subject ?? '',
      }
    } catch {
      return { name, commit: '', createdAt: 0, subject: '' }
    }
  }))
  tags.sort((left, right) => right.createdAt - left.createdAt || left.name.localeCompare(right.name))
  return { tags }
}

/** Create a tag, annotated when a message is supplied. */
async function createTag(ctx, body, signal) {
  const repoRoot = await resolveRepoRoot(ctx, body.sessionId, signal)
  return withRepoLock(repoRoot, async () => {
    const before = await readRepoState(ctx, body.sessionId, signal)
    assertNotBusy(before, body.confirmed)
    assertSafeRef(body.name)
    const name = body.name
    assertSafeRef(typeof body.ref === 'string' && body.ref !== '' ? body.ref : 'HEAD')
    const ref = typeof body.ref === 'string' && body.ref !== '' ? body.ref : 'HEAD'
    try {
      await runGit(before.repoRoot, ['check-ref-format', '--branch', name], { signal, exitCodes: [0, 1] })
    } catch {
      throw new ApiError('invalid-name', `invalid tag name: ${name}`, 400)
    }
    const exists = await runGit(before.repoRoot, ['show-ref', '--verify', '--quiet', `refs/tags/${name}`], { signal }).then(() => true, () => false)
    if (exists) throw new ApiError('tag-exists', `tag already exists: ${name}`, 409)
    const message = typeof body.message === 'string' ? body.message.trim() : ''
    const args = message === '' ? ['tag', name, ref] : ['tag', '-a', name, '-m', message, ref]
    await runGit(before.repoRoot, args, { signal, timeoutMs: WRITE_TIMEOUT_MS })
    await appendAudit({ action: 'tag.create', repoRoot: before.repoRoot, target: [name, ref], result: 'ok' })
    return { repo: await readRepoState(ctx, body.sessionId, signal) }
  })
}

/** Delete one tag. */
async function deleteTag(ctx, body, signal) {
  const repoRoot = await resolveRepoRoot(ctx, body.sessionId, signal)
  return withRepoLock(repoRoot, async () => {
    const before = await readRepoState(ctx, body.sessionId, signal)
    assertNotBusy(before, body.confirmed)
    assertSafeRef(body.name)
    const name = body.name
    const result = await runGit(before.repoRoot, ['tag', '-d', name], { signal, rawResult: true, exitCodes: [0, 1], timeoutMs: WRITE_TIMEOUT_MS })
    if (result.code !== 0) {
      throw new ApiError('unknown-tag', `tag not found: ${name}`, 404, { detail: String(result.stderr ?? '').slice(0, 1_000) })
    }
    await appendAudit({ action: 'tag.delete', repoRoot: before.repoRoot, target: [name], result: 'ok' })
    return { repo: await readRepoState(ctx, body.sessionId, signal) }
  })
}

/** List stash entries. */
async function listStash(ctx, body, signal) {
  const state = await readRepoState(ctx, body.sessionId, signal)
  const format = ['%gd', '%H', '%gs', '%ct'].join('%x1f') + '%x1e'
  const raw = await runGit(state.repoRoot, ['stash', 'list', `--format=${format}`], { signal })
  const entries = String(raw).split('\x1e').map((row) => row.trim()).filter(Boolean).map((row) => {
    const parts = row.split('\x1f')
    return { ref: parts[0] ?? '', commit: parts[1] ?? '', message: parts[2] ?? '', at: Number(parts[3]) || 0 }
  })
  return { entries }
}

/** Save the current changes into a stash. */
async function stashSave(ctx, body, signal) {
  const repoRoot = await resolveRepoRoot(ctx, body.sessionId, signal)
  return withRepoLock(repoRoot, async () => {
    const before = await readRepoState(ctx, body.sessionId, signal)
    if (before.operation !== 'none') throw new ApiError('operation-in-progress', `a ${before.operation} is in progress`, 409)
    const message = typeof body.message === 'string' && body.message.trim() !== '' ? body.message.trim() : `dsh-git-dock ${new Date().toISOString()}`
    const paths = Array.isArray(body.paths) ? normalizePaths(body.paths) : []
    const args = ['stash', 'push', '--include-untracked', '-m', message]
    if (paths.length > 0) args.push('--', ...paths)
    const result = await runGit(before.repoRoot, args, { signal, rawResult: true, exitCodes: [0, 1], timeoutMs: WRITE_TIMEOUT_MS })
    if (result.code !== 0 && !/No local changes to save/i.test(String(result.stdout ?? '') + String(result.stderr ?? ''))) {
      throw new ApiError('stash-failed', firstLine(result.stderr) || 'git stash push failed', 409, { detail: String(result.stderr ?? '').slice(0, 2_000) })
    }
    await appendAudit({ action: 'stash.save', repoRoot: before.repoRoot, branch: before.branch, result: 'ok' })
    return { repo: await readRepoState(ctx, body.sessionId, signal), entries: (await listStash(ctx, body, signal)).entries }
  })
}

/** Apply or pop one stash entry. */
async function stashApply(ctx, body, signal) {
  const repoRoot = await resolveRepoRoot(ctx, body.sessionId, signal)
  return withRepoLock(repoRoot, async () => {
    const before = await readRepoState(ctx, body.sessionId, signal)
    if (before.operation !== 'none') throw new ApiError('operation-in-progress', `a ${before.operation} is in progress`, 409)
    assertSafeRef(body.ref)
    const ref = body.ref
    if (!/^stash@\{\d+\}$/.test(ref)) throw new ApiError('bad-request', 'invalid stash reference', 400)
    const args = body.drop === true ? ['stash', 'pop', ref] : ['stash', 'apply', ref]
    const result = await runGit(before.repoRoot, args, { signal, rawResult: true, exitCodes: [0, 1], timeoutMs: WRITE_TIMEOUT_MS })
    if (result.code !== 0) {
      throw new ApiError('stash-apply-failed', firstLine(result.stderr) || 'git stash apply failed', 409, { detail: String(result.stderr ?? '').slice(0, 2_000) })
    }
    await appendAudit({ action: 'stash.apply', repoRoot: before.repoRoot, branch: before.branch, target: [ref], result: 'ok' })
    return { repo: await readRepoState(ctx, body.sessionId, signal), entries: (await listStash(ctx, body, signal)).entries }
  })
}

/** Drop one stash entry. */
async function stashDrop(ctx, body, signal) {
  const repoRoot = await resolveRepoRoot(ctx, body.sessionId, signal)
  return withRepoLock(repoRoot, async () => {
    const before = await readRepoState(ctx, body.sessionId, signal)
    assertSafeRef(body.ref)
    const ref = body.ref
    if (!/^stash@\{\d+\}$/.test(ref)) throw new ApiError('bad-request', 'invalid stash reference', 400)
    await runGit(before.repoRoot, ['stash', 'drop', ref], { signal, timeoutMs: WRITE_TIMEOUT_MS })
    await appendAudit({ action: 'stash.drop', repoRoot: before.repoRoot, branch: before.branch, target: [ref], result: 'ok' })
    return { entries: (await listStash(ctx, body, signal)).entries }
  })
}

/** Revert one commit without opening an editor. */
async function revertCommitOp(ctx, body, signal) {
  const repoRoot = await resolveRepoRoot(ctx, body.sessionId, signal)
  return withRepoLock(repoRoot, async () => {
    const before = await readRepoState(ctx, body.sessionId, signal)
    assertNotBusy(before, body.confirmed)
    assertSafeRef(body.commit)
    const commit = body.commit
    try {
      await gitText(before.repoRoot, ['rev-parse', '--verify', '--quiet', `${commit}^{commit}`], { signal })
    } catch {
      throw new ApiError('unknown-ref', `commit not found: ${commit}`, 404)
    }
    const result = await runGit(before.repoRoot, ['revert', '--no-edit', commit], { signal, rawResult: true, exitCodes: [0, 1], timeoutMs: WRITE_TIMEOUT_MS })
    const after = await readRepoState(ctx, body.sessionId, signal)
    if (result.code !== 0) {
      throw new ApiError('revert-conflict', 'the revert stopped with conflicts', 409, { operation: after.operation, conflicts: after.conflictTypes })
    }
    await appendAudit({ action: 'revert', repoRoot: before.repoRoot, branch: before.branch, target: [commit], result: 'ok' })
    return { repo: after }
  })
}

/** Reset HEAD to a commit; `--hard` needs confirmation and writes a backup ref. */
async function resetTo(ctx, body, signal) {
  const repoRoot = await resolveRepoRoot(ctx, body.sessionId, signal)
  return withRepoLock(repoRoot, async () => {
    const before = await readRepoState(ctx, body.sessionId, signal)
    assertNotBusy(before, body.confirmed)
    assertSafeRef(body.commit)
    const commit = body.commit
    const mode = body.mode === 'soft' || body.mode === 'mixed' ? body.mode : 'hard'
    try {
      await gitText(before.repoRoot, ['rev-parse', '--verify', '--quiet', `${commit}^{commit}`], { signal })
    } catch {
      throw new ApiError('unknown-ref', `commit not found: ${commit}`, 404)
    }
    if (mode === 'hard') {
      if (body.confirmed !== true) throw new ApiError('confirm-required', 'a hard reset discards worktree changes and needs confirmation', 409)
      await backupHead(before.repoRoot, 'pre-reset', signal)
    }
    const args = ['reset', mode === 'mixed' ? '--mixed' : `--${mode}`, commit]
    const result = await runGit(before.repoRoot, args, { signal, rawResult: true, exitCodes: [0, 1], timeoutMs: WRITE_TIMEOUT_MS })
    if (result.code !== 0) {
      throw new ApiError('reset-failed', firstLine(result.stderr) || 'git reset failed', 409, { detail: String(result.stderr ?? '').slice(0, 2_000) })
    }
    await appendAudit({
      action: 'reset',
      repoRoot: before.repoRoot,
      branch: before.branch,
      target: [commit],
      result: mode,
    })
    return { repo: await readRepoState(ctx, body.sessionId, signal) }
  })
}

/**
 * Change list for one scope: the working tree, or the branch against a base.
 *
 * @param {import('@deepseek-ai/cordis').Context} ctx - plugin context.
 * @param {object} body - `{ sessionId, scope?, base? }`.
 * @param {AbortSignal} [signal] - cancellation.
 * @returns {Promise<object>} the change list.
 */
async function readChanges(ctx, body, signal) {
  const state = await readRepoState(ctx, body.sessionId, signal)
  const scope = body.scope === 'branch' ? 'branch' : 'worktree'
  let base = null
  let baseCandidates = []
  let commits = 0
  if (scope === 'branch') {
    const resolved = await resolveBase(state.repoRoot, body.base, signal)
    base = resolved.base
    baseCandidates = resolved.baseCandidates
    if (base === null) throw new ApiError('no-base', 'no base branch could be resolved', 409)
    if (base === state.branch) throw new ApiError('same-base', 'the base is the current branch', 400)
    commits = Number(await gitText(state.repoRoot, ['rev-list', '--count', `${base}..HEAD`], { signal })) || 0
  }
  let files = []
  if (scope === 'worktree') {
    const [statusRaw, numstatRaw] = await Promise.all([
      runGit(state.repoRoot, ['status', '--porcelain=v2', '-z', '--untracked-files=normal'], { signal }),
      runGit(state.repoRoot, ['diff', '--numstat', '-z', 'HEAD'], { signal }).catch(() => ''),
    ])
    const counts = parseNumstat(numstatRaw)
    const rows = parseStatusRows(statusRaw)
    files = await Promise.all(rows.map(async (row) => {
      const stats = row.untracked === true ? await sizeUntrackedFile(state.repoRoot, row.path) : counts.get(row.path)
      const indexLetter = row.untracked === true ? '?' : (row.x !== undefined && row.x !== '.' && row.x !== ' ' ? row.x : null)
      const worktreeLetter = row.untracked === true ? '?' : (row.y !== undefined && row.y !== '.' && row.y !== ' ' ? row.y : null)
      return {
        path: row.path,
        origPath: typeof row.origPath === 'string' ? row.origPath : null,
        status: statusLetter(row),
        indexStatus: indexLetter,
        worktreeStatus: worktreeLetter,
        staged: row.x !== undefined && row.x !== '.' && row.x !== ' ',
        unstaged: row.y !== undefined && row.y !== '.' && row.y !== ' ',
        unstaged: row.y !== undefined && row.y !== '.' && row.y !== ' ',
        conflict: row.conflict === true,
        additions: stats === undefined ? null : stats.additions,
        deletions: stats === undefined ? null : stats.deletions,
        binary: stats === undefined ? false : stats.binary,
      }
    }))
  } else {
    const [nameRaw, numstatRaw] = await Promise.all([
      runGit(state.repoRoot, ['diff', '--name-status', '-z', `${base}...HEAD`], { signal }),
      runGit(state.repoRoot, ['diff', '--numstat', '-z', `${base}...HEAD`], { signal }),
    ])
    const counts = parseNumstat(numstatRaw)
    files = parseNameStatus(nameRaw).map((row) => {
      const stats = counts.get(row.path)
      return {
        path: row.path,
        origPath: row.origPath,
        status: row.status,
        indexStatus: row.status,
        worktreeStatus: null,
        staged: true,
        unstaged: false,
        conflict: false,
        additions: stats === undefined ? null : stats.additions,
        deletions: stats === undefined ? null : stats.deletions,
        binary: stats === undefined ? false : stats.binary,
      }
    })
  }
  files.sort((left, right) => left.path.localeCompare(right.path))
  const truncated = files.length > FILE_ROW_LIMIT
  return {
    scope,
    base,
    baseCandidates,
    commits,
    files: truncated ? files.slice(0, FILE_ROW_LIMIT) : files,
    truncated,
    repo: state,
  }
}

/**
 * One file's comparison as structured hunks.
 *
 * @param {import('@deepseek-ai/cordis').Context} ctx - plugin context.
 * @param {object} body - `{ sessionId, scope?, base?, path, untracked? }`.
 * @param {AbortSignal} [signal] - cancellation.
 * @returns {Promise<object>} the comparison.
 */
async function readDiff(ctx, body, signal) {
  const state = await readRepoState(ctx, body.sessionId, signal)
  const path = assertRepoPath(body.path)
  const scope = body.scope === 'branch' ? 'branch' : body.scope === 'staged' ? 'staged' : body.scope === 'commit' ? 'commit' : 'worktree'
  let args
  if (scope === 'branch') {
    const resolved = await resolveBase(state.repoRoot, body.base, signal)
    if (resolved.base === null) throw new ApiError('no-base', 'no base branch could be resolved', 409)
    args = ['diff', '--no-color', '--no-ext-diff', '-U3', `${resolved.base}...HEAD`, '--', path]
  } else if (scope === 'commit') {
    assertSafeRef(body.commit)
    args = ['show', '--no-color', '--no-ext-diff', '-U3', body.commit, '--', path]
  } else if (scope === 'staged') {
    args = ['diff', '--cached', '--no-color', '--no-ext-diff', '-U3', '--', path]
  } else if (body.untracked === true) {
    args = ['diff', '--no-index', '--no-color', '--no-ext-diff', '-U3', '--', '/dev/null', path]
  } else {
    // Index vs working tree: exactly the changes that staging would capture.
    args = ['diff', '--no-color', '--no-ext-diff', '-U3', '--', path]
  }
  const raw = await runGit(state.repoRoot, args, { signal, maxBytes: DIFF_OUTPUT_LIMIT, exitCodes: [0, 1] })
  const parsed = parseUnifiedDiff(raw)
  return {
    path,
    scope,
    binary: parsed.binary,
    hunks: parsed.hunks,
    truncated: parsed.truncated,
    indexTree: await indexBlobHash(state.repoRoot, path, signal),
    worktreeHash: scope === 'staged' ? null : await worktreeBlobHash(state.repoRoot, path),
  }
}

// ── P2: merging ───────────────────────────────────────────────────────────

/** Pending merge confirmations: token → details, with a 60s lifetime. */
const mergeTokens = new Map()
const MERGE_TOKEN_TTL_MS = 60_000
const BACKUP_REF_LIMIT = 20

/** Normalize a requested merge mode; unknown values fall back to `--no-ff`. */
function normalizeMode(mode) {
  return mode === 'ff-only' || mode === 'squash' ? mode : 'no-ff'
}

/** Mint one single-use confirmation for the merge the preview showed. */
function issueMergeToken(details) {
  const token = randomUUID()
  mergeTokens.set(token, Object.assign({}, details, { expires: Date.now() + MERGE_TOKEN_TTL_MS }))
  return token
}

/** Consume a merge confirmation, refusing another Session's or a stale one. */
function takeMergeToken(token, sessionId) {
  if (typeof token !== 'string' || token === '') {
    throw new ApiError('merge-token', 'merge confirmation required; run the preview again', 409)
  }
  const entry = mergeTokens.get(token)
  if (entry === undefined) {
    throw new ApiError('merge-token', 'merge confirmation not found; run the preview again', 409)
  }
  mergeTokens.delete(token)
  if (entry.expires < Date.now()) {
    throw new ApiError('merge-token', 'merge confirmation expired; run the preview again', 409)
  }
  if (entry.sessionId !== sessionId) {
    throw new ApiError('merge-token', 'merge confirmation belongs to another session', 409)
  }
  return entry
}

/** Keep only the newest backup refs of one repository. */
async function pruneBackupRefs(repoRoot, signal) {
  try {
    const raw = await gitText(repoRoot, ['for-each-ref', '--sort=creatordate', '--format=%(refname)', 'refs/dsh/backup'], { signal })
    const refs = raw.split('\n').filter((ref) => ref !== '')
    for (const ref of refs.slice(0, Math.max(0, refs.length - BACKUP_REF_LIMIT))) {
      await runGit(repoRoot, ['update-ref', '-d', ref], { signal })
    }
  } catch {
    // Retention is housekeeping; never fail the operation on it.
  }
}

/** Record `HEAD` under `refs/dsh/backup/<stamp>/<label>` before a rewrite. */
async function backupHead(repoRoot, label, signal) {
  try {
    const head = (await gitText(repoRoot, ['rev-parse', 'HEAD'], { signal })).trim()
    if (head === '') return null
    const stamp = new Date().toISOString().replace(/[-:]/g, '').replace(/\..*$/, '')
    const safeLabel = String(label ?? 'auto').replace(/[^A-Za-z0-9._-]+/g, '-').slice(0, 40)
    const ref = `refs/dsh/backup/${stamp}/${safeLabel}`
    await runGit(repoRoot, ['update-ref', ref, head], { signal })
    await pruneBackupRefs(repoRoot, signal)
    return { ref, commit: head }
  } catch {
    return null
  }
}

/** Verify that `source` resolves to a commit, and is safe as an argument. */
async function assertSourceRef(repoRoot, source, signal) {
  if (typeof source !== 'string' || source === '') throw new ApiError('bad-request', 'source branch required')
  try {
    assertSafeRef(source)
  } catch {
    throw new ApiError('unknown-ref', `unknown ref: ${source}`, 404)
  }
  try {
    await runGit(repoRoot, ['rev-parse', '--verify', '--quiet', `${source}^{commit}`], { signal })
  } catch {
    throw new ApiError('unknown-ref', `unknown ref: ${source}`, 404)
  }
  return source
}

/** Summarize what merging `source` would bring, without touching the tree. */
async function previewMerge(ctx, body, signal) {
  const state = await readRepoState(ctx, body.sessionId, signal)
  if (state.operation !== 'none') {
    throw new ApiError('operation-in-progress', `a ${state.operation} is in progress; finish or abort it first`, 409, {
      operation: state.operation,
      state,
    })
  }
  const mode = normalizeMode(body.mode)
  const source = await assertSourceRef(state.repoRoot, body.source, signal)
  if (state.detached === true) throw new ApiError('detached', 'cannot merge on a detached HEAD', 409, { state })
  if (source === state.branch) throw new ApiError('same-branch', 'the source is the current branch', 400)
  const sourceSha = (await gitText(state.repoRoot, ['rev-parse', `${source}^{commit}`], { signal })).trim()
  const mergeBase = (await gitText(state.repoRoot, ['merge-base', 'HEAD', sourceSha], { signal })).trim()
  let kind = 'merge'
  if (mergeBase === sourceSha) kind = 'up-to-date'
  else if (mergeBase === state.head) kind = 'fast-forward'
  if (mode === 'ff-only' && kind === 'merge') {
    throw new ApiError('not-fast-forward', `the current branch cannot fast-forward to ${source}`, 409, { kind, source })
  }
  let conflicts = []
  if (kind === 'merge') {
    const tree = await runGit(state.repoRoot, ['merge-tree', '--write-tree', '--name-only', 'HEAD', sourceSha], {
      signal,
      exitCodes: [0, 1],
    })
    const lines = tree.split('\n')
    const blank = lines.findIndex((line) => line === '')
    const header = blank === -1 ? lines : lines.slice(0, blank)
    conflicts = header.slice(1).map((line) => line.trim()).filter((line) => line !== '')
  }
  let files = []
  let additions = 0
  let deletions = 0
  let fileCount = 0
  if (kind !== 'up-to-date') {
    const numstat = await runGit(state.repoRoot, ['diff', '--numstat', '-z', 'HEAD', sourceSha], { signal })
    const counts = parseNumstat(numstat)
    fileCount = counts.size
    files = [...counts.entries()].slice(0, 200).map(([path, stats]) => ({
      path,
      additions: stats.additions,
      deletions: stats.deletions,
      binary: stats.binary,
    }))
    for (const stats of counts.values()) {
      additions += stats.additions ?? 0
      deletions += stats.deletions ?? 0
    }
  }
  return {
    source,
    mode,
    kind,
    files,
    fileCount,
    additions,
    deletions,
    conflicts,
    confirmToken: issueMergeToken({ sessionId: body.sessionId, head: state.head, source, mode }),
    repo: state,
  }
}

/** Perform the merge the preview confirmed. */
async function applyMerge(ctx, body, signal) {
  const entry = takeMergeToken(body.confirmToken, body.sessionId)
  const repoRoot = await resolveRepoRoot(ctx, body.sessionId, signal)
  return withRepoLock(repoRoot, async () => {
    const before = await readRepoState(ctx, body.sessionId, signal)
    if (before.operation !== 'none') {
      throw new ApiError('operation-in-progress', `a ${before.operation} is in progress; finish or abort it first`, 409, {
        operation: before.operation,
        state: before,
      })
    }
    if (before.head !== entry.head) {
      throw new ApiError('stale', 'the repository changed since the preview; run it again', 409, { state: before })
    }
    if (before.running === true && body.confirmed !== true) {
      throw new ApiError('running', 'the session is running; the merge needs explicit confirmation', 409, { state: before })
    }
    const source = await assertSourceRef(before.repoRoot, entry.source, signal)
    const backup = await backupHead(before.repoRoot, `pre-merge-${entry.mode}`, signal)
    const args = entry.mode === 'ff-only'
      ? ['merge', '--ff-only', '--no-edit', source]
      : entry.mode === 'squash'
        ? ['merge', '--squash', source]
        : ['merge', '--no-ff', '--no-edit', source]
    const result = await runGit(before.repoRoot, args, {
      signal,
      timeoutMs: WRITE_TIMEOUT_MS,
      rawResult: true,
      exitCodes: [0, 1],
    })
    const after = await readRepoState(ctx, body.sessionId, signal)
    const conflicts = after.conflictPaths
    if (result.code === 0) {
      return {
        status: entry.mode === 'squash' ? 'squashed' : 'merged',
        source,
        mode: entry.mode,
        conflicts: [],
        backup,
        repo: after,
      }
    }
    if (conflicts.length > 0) {
      return { status: 'conflicts', source, mode: entry.mode, conflicts, backup, repo: after }
    }
    if (entry.mode === 'ff-only') {
      throw new ApiError('not-fast-forward', `the current branch cannot fast-forward to ${source}`, 409, { state: after })
    }
    throw new ApiError('merge-failed', firstLine(result.stderr) || 'git merge failed', 400, {
      detail: result.stderr.slice(0, 4_000),
    })
  })
}

/** Abort an in-progress merge. */
async function abortMerge(ctx, body, signal) {
  const repoRoot = await resolveRepoRoot(ctx, body.sessionId, signal)
  return withRepoLock(repoRoot, async () => {
    const before = await readRepoState(ctx, body.sessionId, signal)
    if (before.operation !== 'merge') throw new ApiError('no-merge', 'no merge is in progress', 409)
    await runGit(before.repoRoot, ['merge', '--abort'], { signal, timeoutMs: WRITE_TIMEOUT_MS })
    await appendAudit({ action: 'merge.abort', repoRoot: before.repoRoot, branch: before.branch, result: 'ok' })
    return { repo: await readRepoState(ctx, body.sessionId, signal) }
  })
}

/** Commit the resolved merge that is still open. */
async function completeMerge(ctx, body, signal) {
  const repoRoot = await resolveRepoRoot(ctx, body.sessionId, signal)
  return withRepoLock(repoRoot, async () => {
    const before = await readRepoState(ctx, body.sessionId, signal)
    if (before.operation !== 'merge') throw new ApiError('no-merge', 'no merge is in progress', 409)
    if (before.conflictPaths.length > 0) {
      throw new ApiError('conflicts-remain', 'resolve every conflicted file first', 409, { conflicts: before.conflictPaths })
    }
    const result = await runGit(before.repoRoot, ['commit', '--no-edit'], {
      signal,
      timeoutMs: WRITE_TIMEOUT_MS,
      rawResult: true,
      exitCodes: [0, 1],
    })
    if (result.code !== 0) {
      throw new ApiError('merge-failed', firstLine(result.stderr) || 'git commit failed', 400, {
        detail: result.stderr.slice(0, 4_000),
      })
    }
    const committed = await readRepoState(ctx, body.sessionId, signal)
    await appendAudit({ action: 'merge.complete', repoRoot: before.repoRoot, branch: before.branch, result: 'ok' })
    return { repo: committed }
  })
}

/** Mark one conflicted path resolved (`git add`). */
async function resolveConflict(ctx, body, signal) {
  const path = assertRepoPath(body.path)
  const repoRoot = await resolveRepoRoot(ctx, body.sessionId, signal)
  return withRepoLock(repoRoot, async () => {
    const before = await readRepoState(ctx, body.sessionId, signal)
    if (before.operation !== 'merge') throw new ApiError('no-merge', 'no merge is in progress', 409)
    if (!before.conflictPaths.includes(path)) {
      throw new ApiError('not-conflicted', `not a conflicted path: ${path}`, 400, { conflicts: before.conflictPaths })
    }
    await runGit(before.repoRoot, ['add', '--', path], { signal, timeoutMs: WRITE_TIMEOUT_MS })
    const after = await readRepoState(ctx, body.sessionId, signal)
    return { repo: after, conflicts: after.conflictPaths }
  })
}

/**
 * Ask the session's live model to resolve every open merge conflict and stage it.
 * The model only edits and `git add`s; committing and pushing stay manual.
 */
async function notifyAgentResolveConflicts(ctx, body, signal) {
  const state = await readRepoState(ctx, body.sessionId, signal)
  if (state.operation !== 'merge') {
    throw new ApiError('no-merge', 'no merge is in progress', 409, { state })
  }
  const allConflicts = state.conflictPaths
  if (allConflicts.length === 0) {
    throw new ApiError('no-conflicts', 'no conflicted files remain; complete the merge instead', 409, { state })
  }
  // An explicit path list narrows the request to the file the user picked; an
  // unknown path is refused so the model is never asked to invent one.
  const requested = Array.isArray(body.paths)
    ? [...new Set(body.paths.filter((path) => typeof path === 'string' && path !== ''))]
    : []
  const unknown = requested.filter((path) => !allConflicts.includes(path))
  if (unknown.length > 0) {
    throw new ApiError('not-conflicted', `not a conflicted path: ${unknown.join(', ')}`, 400, { conflicts: allConflicts })
  }
  const conflicts = requested.length > 0 ? requested : allConflicts
  const agents = ctx.get('agents')
  const agent = agents === undefined || agents === null || typeof agents.get !== 'function'
    ? undefined
    : agents.get(body.sessionId)
  if (agent === undefined || agent === null) {
    throw new ApiError('session-not-found', 'the session is not live', 404)
  }
  if (typeof agent.followup !== 'function') {
    throw new ApiError('agent-unavailable', 'this session cannot accept a prompt right now', 503)
  }
  const remaining = allConflicts.filter((path) => !conflicts.includes(path))
  const prompt = [
    '当前会话的工作区处于 Git 合并冲突状态，请立即处理以下冲突文件。',
    `仓库：${state.repoRoot}`,
    `当前分支：${state.branch ?? 'detached HEAD'}`,
    `本次需要处理的冲突文件（${conflicts.length} 个）：`,
    ...conflicts.map((path) => `- ${path}`),
    ...(remaining.length === 0
      ? []
      : ['', `其余仍未解决的冲突（本次不处理）：`, ...remaining.map((path) => `- ${path}`)]),
    '',
    '要求：',
    '1. 逐个读取冲突文件，理解双方意图，合并两边改动，保留全部有效逻辑；',
    '2. 解决后用 `git add <该文件>` 标记为已解决；',
    '3. 不要执行 git commit、git merge --abort、git push，也不要改动无关文件；',
    '4. 全部标记完成后，简短汇报每个文件是如何处理的。',
  ].join('\n')
  await agent.followup({ content: [{ type: 'text', text: prompt }], source: { kind: 'user' } })
  return { notified: true, conflicts, remaining, branch: state.branch ?? null }
}

// ── P3: refs, checkout, staging, commit, remote ───────────────────────────

/** Parse rich for-each-ref lines: name, sha, date, author, upstream, HEAD, subject. */
function parseRichRefs(raw) {
  const rows = []
  for (const line of raw.split('\n')) {
    if (line.trim() === '') continue
    const parts = line.split('\t')
    if (parts.length < 7) continue
    rows.push({
      name: parts[0],
      sha: parts[1],
      committedAt: Number(parts[2]) * 1000,
      author: parts[3],
      upstream: parts[4] === '' ? null : parts[4],
      current: parts[5] === '*',
      subject: parts.slice(6).join('\t'),
    })
  }
  return rows
}

/** List local branches, remote branches and tags with row metadata. */
async function readRefs(repoRoot, signal) {
  const branchFormat = [
    '%(refname:short)',
    '%(objectname:short)',
    '%(committerdate:unix)',
    '%(authorname)',
    '%(upstream:short)',
    '%(HEAD)',
    '%(subject)',
  ].join('\t')
  const tagFormat = [
    '%(refname:short)',
    '%(objectname:short)',
    '%(creatordate:unix)',
    '%(objecttype)',
    '%(subject)',
  ].join('\t')
  const [localRaw, remoteRaw, tagRaw] = await Promise.all([
    runGit(repoRoot, ['for-each-ref', `--format=${branchFormat}`, 'refs/heads'], { signal }),
    runGit(repoRoot, ['for-each-ref', `--format=${branchFormat}`, 'refs/remotes'], { signal }),
    runGit(repoRoot, ['for-each-ref', `--format=${tagFormat}`, 'refs/tags'], { signal }),
  ])
  const local = parseRichRefs(localRaw)
  local.sort((left, right) => {
    if (left.current !== right.current) return left.current ? -1 : 1
    if (right.committedAt !== left.committedAt) return right.committedAt - left.committedAt
    return left.name.localeCompare(right.name)
  })
  const localNames = new Set(local.map((branch) => branch.name))
  const remote = parseRichRefs(remoteRaw)
    .filter((branch) => !branch.name.endsWith('/HEAD'))
    .map((branch) => {
      const slash = branch.name.indexOf('/')
      const shortName = slash === -1 ? branch.name : branch.name.slice(slash + 1)
      return Object.assign({}, branch, {
        remote: slash === -1 ? '' : branch.name.slice(0, slash),
        shortName,
        hasLocal: localNames.has(shortName),
      })
    })
    .sort((left, right) => right.committedAt - left.committedAt)
  const tags = []
  for (const line of tagRaw.split('\n')) {
    if (line.trim() === '') continue
    const parts = line.split('\t')
    if (parts.length < 5) continue
    tags.push({
      name: parts[0],
      sha: parts[1],
      committedAt: Number(parts[2]) * 1000,
      annotated: parts[3] === 'tag',
      subject: parts.slice(4).join('\t'),
    })
  }
  tags.sort((left, right) => right.committedAt - left.committedAt)
  return { local, remote, tags }
}

/** Validate an array of repository-relative paths. */
function normalizePaths(value) {
  if (!Array.isArray(value) || value.length === 0) throw new ApiError('bad-request', 'paths required')
  if (value.length > 500) throw new ApiError('bad-request', 'too many paths')
  return value.map((path) => assertRepoPath(path))
}

/** Check out a local branch, a remote branch (as a tracking branch), a tag, or a commit. */
async function checkoutRef(ctx, body, signal) {
  const repoRoot = await resolveRepoRoot(ctx, body.sessionId, signal)
  return withRepoLock(repoRoot, async () => {
    const before = await readRepoState(ctx, body.sessionId, signal)
    assertFreshHead(before, body.expectHead)
    assertNotBusy(before, body.confirmed)
    const target = body.target !== null && typeof body.target === 'object' ? body.target : {}
    const kind = target.kind
    const name = target.name
    if (!['local', 'remote', 'tag', 'commit'].includes(kind)) throw new ApiError('bad-request', 'unknown checkout target')
    if (typeof name !== 'string' || name === '') throw new ApiError('bad-request', 'checkout target required')
    if (kind === 'commit') {
      if (!/^[0-9a-f]{7,40}$/i.test(name)) throw new ApiError('bad-request', 'invalid commit id')
    } else {
      try {
        assertSafeRef(name)
      } catch {
        throw new ApiError('unknown-ref', `unknown ref: ${name}`, 404)
      }
    }
    if (kind === 'tag' && body.confirmed !== true) {
      throw new ApiError('detached-confirm', 'checking out a tag leaves a detached HEAD', 409, { target })
    }
    const backup = await backupHead(before.repoRoot, `pre-checkout-${kind}`, signal)
    if (kind === 'local') {
      await assertLocalBranch(before.repoRoot, name, signal)
      if (before.branch !== name || before.detached === true) {
        await runGit(before.repoRoot, ['switch', '--no-guess', '--end-of-options', name], { signal, timeoutMs: WRITE_TIMEOUT_MS })
      }
    } else if (kind === 'remote') {
      const slash = name.indexOf('/')
      const shortName = slash === -1 ? name : name.slice(slash + 1)
      if (shortName === '') throw new ApiError('unknown-ref', `unknown remote branch: ${name}`, 404)
      const localExists = await runGit(before.repoRoot, ['show-ref', '--verify', '--quiet', `refs/heads/${shortName}`], { signal })
        .then(() => true, () => false)
      if (localExists) {
        await runGit(before.repoRoot, ['switch', '--no-guess', '--end-of-options', shortName], { signal, timeoutMs: WRITE_TIMEOUT_MS })
      } else {
        await runGit(before.repoRoot, ['switch', '-c', shortName, '--track', name], { signal, timeoutMs: WRITE_TIMEOUT_MS })
      }
    } else if (kind === 'tag') {
      await runGit(before.repoRoot, ['rev-parse', '--verify', '--quiet', `refs/tags/${name}`], { signal })
      await runGit(before.repoRoot, ['switch', '--detach', `refs/tags/${name}`], { signal, timeoutMs: WRITE_TIMEOUT_MS })
    } else {
      await runGit(before.repoRoot, ['switch', '--detach', name], { signal, timeoutMs: WRITE_TIMEOUT_MS })
    }
    return {
      repo: await readRepoState(ctx, body.sessionId, signal),
      previousBranch: before.detached === true ? null : before.branch,
      backup,
    }
  })
}

/** Stage paths (or everything). */
async function stagePaths(ctx, body, signal) {
  const paths = body.all === true ? [] : normalizePaths(body.paths)
  const repoRoot = await resolveRepoRoot(ctx, body.sessionId, signal)
  return withRepoLock(repoRoot, async () => {
    const before = await readRepoState(ctx, body.sessionId, signal)
    if (before.operation === 'merge') throw new ApiError('merge-open', 'complete the merge first', 409, { state: before })
    const args = body.all === true ? ['add', '-A'] : ['add', '--', ...paths]
    await runGit(before.repoRoot, args, { signal, timeoutMs: WRITE_TIMEOUT_MS })
    return { repo: await readRepoState(ctx, body.sessionId, signal) }
  })
}

/** Unstage paths (or everything). */
async function unstagePaths(ctx, body, signal) {
  const paths = body.all === true ? [] : normalizePaths(body.paths)
  const repoRoot = await resolveRepoRoot(ctx, body.sessionId, signal)
  return withRepoLock(repoRoot, async () => {
    const before = await readRepoState(ctx, body.sessionId, signal)
    const run = async (args) => {
      const result = await runGit(before.repoRoot, args, { signal, rawResult: true, exitCodes: [0, 1], timeoutMs: WRITE_TIMEOUT_MS })
      return result.code === 0
    }
    if (body.all === true) {
      if (!(await run(['reset', '-q', 'HEAD', '--', '.']))) await run(['rm', '--cached', '-r', '--quiet', '--', '.'])
    } else if (!(await run(['restore', '--staged', '--', ...paths]))) {
      await run(['reset', '-q', 'HEAD', '--', ...paths])
    }
    return { repo: await readRepoState(ctx, body.sessionId, signal) }
  })
}

/** Discard paths: stash them aside (recoverable) after recording a backup ref. */
async function discardPaths(ctx, body, signal) {
  const paths = normalizePaths(body.paths)
  const repoRoot = await resolveRepoRoot(ctx, body.sessionId, signal)
  return withRepoLock(repoRoot, async () => {
    const before = await readRepoState(ctx, body.sessionId, signal)
    if (before.operation !== 'none') throw new ApiError('operation-in-progress', `a ${before.operation} is in progress`, 409, { state: before })
    const backup = await backupHead(before.repoRoot, 'pre-discard', signal)
    const stamp = new Date().toISOString()
    const result = await runGit(
      before.repoRoot,
      ['stash', 'push', '--include-untracked', '-m', `dsh-git-dock discard ${stamp}`, '--', ...paths],
      { signal, rawResult: true, exitCodes: [0, 1], timeoutMs: WRITE_TIMEOUT_MS },
    )
    const clean = /No local changes to save/i.test(result.stderr) || /No local changes to save/i.test(result.stdout)
    if (result.code !== 0 && !clean) {
      throw new ApiError('discard-failed', firstLine(result.stderr) || 'git stash failed', 400, { detail: result.stderr.slice(0, 4_000) })
    }
    const repo = await readRepoState(ctx, body.sessionId, signal)
    await appendAudit({
      action: 'discard',
      repoRoot: before.repoRoot,
      branch: before.branch,
      target: paths,
      result: clean ? 'no-op' : 'stashed',
    })
    return { repo, backup, stashed: !clean, message: `dsh-git-dock discard ${stamp}` }
  })
}

/** Undo the newest discard by applying its stash entry back into the worktree. */
async function undoDiscard(ctx, body, signal) {
  const repoRoot = await resolveRepoRoot(ctx, body.sessionId, signal)
  return withRepoLock(repoRoot, async () => {
    const before = await readRepoState(ctx, body.sessionId, signal)
    if (before.operation !== 'none') throw new ApiError('operation-in-progress', `a ${before.operation} is in progress`, 409, { state: before })
    if (before.conflictPaths.length > 0) throw new ApiError('unresolved-conflicts', 'resolve the conflicts first', 409, { conflicts: before.conflictTypes })
    const list = await gitText(before.repoRoot, ['stash', 'list', '--format=%gd %s'], { signal })
    const match = list.split('\n').find((line) => line.includes('dsh-git-dock discard'))
    if (match === undefined) throw new ApiError('no-discard', 'no discarded change is available to undo', 404)
    const ref = match.split(' ')[0]
    if (!/^stash@\{\d+\}$/.test(ref)) throw new ApiError('no-discard', 'no discarded change is available to undo', 404)
    const apply = await runGit(before.repoRoot, ['stash', 'apply', ref], {
      signal,
      rawResult: true,
      exitCodes: [0, 1],
      timeoutMs: WRITE_TIMEOUT_MS,
    })
    if (apply.code !== 0) {
      throw new ApiError('discard-undo-failed', firstLine(apply.stderr) || 'git stash apply failed', 409, { detail: apply.stderr.slice(0, 4_000) })
    }
    await runGit(before.repoRoot, ['stash', 'drop', ref], { signal, timeoutMs: WRITE_TIMEOUT_MS })
    await appendAudit({ action: 'discard.undo', repoRoot: before.repoRoot, branch: before.branch, target: [ref], result: 'restored' })
    return { repo: await readRepoState(ctx, body.sessionId, signal), restored: ref }
  })
}

/** Refuse changing pushed history: is HEAD contained in its upstream? */
async function assertHeadNotPushed(repoRoot, signal) {
  let upstream
  try {
    upstream = (await gitText(repoRoot, ['rev-parse', '--abbrev-ref', '--symbolic-full-name', '@{upstream}'], { signal })).trim()
  } catch {
    return
  }
  if (upstream === '') return
  const pushed = await runGit(repoRoot, ['merge-base', '--is-ancestor', 'HEAD', upstream], { signal })
    .then(() => true, () => false)
  if (pushed) throw new ApiError('amend-pushed', 'HEAD is already pushed; amending it is disabled', 409, { upstream })
}

/** Total commit-message cap, overridable per repository or by the saved config. */
async function commitTotalLimit(repoRoot) {
  const override = await readTextIfExists(join(repoRoot, '.dsh-git-dock.json'), 16 * 1024)
  if (override !== null) {
    try {
      const parsed = JSON.parse(override)
      const limit = parsed.commit !== undefined && parsed.commit !== null ? parsed.commit.totalMaxLength : undefined
      if (typeof limit === 'number' && limit >= 100 && limit <= 5_000) return limit
    } catch {
      // Fall through to the saved config.
    }
  }
  const saved = await readSavedCommitConfig()
  if (saved !== null && typeof saved.totalMaxLength === 'number') return saved.totalMaxLength
  return DEFAULT_COMMIT_CONVENTION.totalMaxLength
}

/** Commit staged changes, optionally amending the tip. */
async function commitChanges(ctx, body, signal) {
  const message = typeof body.message === 'string' ? body.message.replace(/\r\n?/g, '\n').trim() : ''
  if (message === '') throw new ApiError('message-required', 'a commit message is required', 400)
  const amend = body.amend === true
  const repoRoot = await resolveRepoRoot(ctx, body.sessionId, signal)
  const totalLimit = await commitTotalLimit(repoRoot)
  if (message.length > totalLimit) {
    throw new ApiError('message-too-long', `the commit message exceeds ${totalLimit} characters`, 400, { limit: totalLimit })
  }
  return withRepoLock(repoRoot, async () => {
    const before = await readRepoState(ctx, body.sessionId, signal)
    if (before.operation === 'merge') throw new ApiError('merge-open', 'complete the merge first', 409, { state: before })
    if (before.operation !== 'none') throw new ApiError('operation-in-progress', `a ${before.operation} is in progress`, 409, { state: before })
    if (amend) await assertHeadNotPushed(before.repoRoot, signal)
    if (!amend && before.changes.staged === 0) throw new ApiError('nothing-staged', 'no staged changes to commit', 409)
    const args = amend ? ['commit', '--amend', '-m', message] : ['commit', '-m', message]
    const result = await runGit(before.repoRoot, args, {
      signal,
      rawResult: true,
      exitCodes: [0, 1],
      timeoutMs: WRITE_TIMEOUT_MS,
    })
    if (result.code !== 0) {
      throw new ApiError('commit-failed', firstLine(result.stderr) || 'git commit failed', 400, { detail: result.stderr.slice(0, 4_000) })
    }
    const after = await readRepoState(ctx, body.sessionId, signal)
    const sha = (await gitText(after.repoRoot, ['rev-parse', '--short', 'HEAD'], { signal })).trim()
    const subject = firstLine(await gitText(after.repoRoot, ['log', '-1', '--format=%s'], { signal }))
    if (amend) {
      await appendAudit({ action: 'commit.amend', repoRoot: after.repoRoot, branch: after.branch, target: sha, result: 'ok' })
    }
    return { repo: after, commit: { sha, subject, amend } }
  })
}

/** Resolve the model route a commit suggestion should use (session first). */
function commitModelRoute(ctx, session) {
  try {
    const context = session.requestContext()
    if (context !== null && context !== undefined && typeof context.provider === 'string' && typeof context.model === 'string') {
      return { provider: context.provider, model: context.model }
    }
  } catch {
    // No request yet: fall back to the default selection.
  }
  try {
    const selection = ctx.get('agentDefaultModel')?.currentSelection()
    if (selection !== null && selection !== undefined && typeof selection.provider === 'string' && typeof selection.model === 'string') {
      return { provider: selection.provider, model: selection.model }
    }
  } catch {
    // Fall through.
  }
  return null
}

/**
 * List provider/model routes with their reasoning efforts, plus the session's
 * current choice, so the review tab offers the same picker as the composer.
 */
async function listModelOptions(ctx, body) {
  const llm = ctx.get('llm')
  if (llm === undefined || llm === null || typeof llm.listProviders !== 'function') {
    throw new ApiError('llm-unavailable', 'no LLM service is mounted', 503)
  }
  const deadline = Date.now() + 8_000
  // A stalled provider probe must not keep the picker empty forever.
  const providers = await Promise.race([
    Promise.resolve(llm.listProviders()),
    new Promise((resolve) => {
      const timer = setTimeout(() => resolve([]), 4_000)
      if (typeof timer.unref === 'function') timer.unref()
    }),
  ])
  const entries = []
  for (const providerInfo of Array.isArray(providers) ? providers : []) {
    if (Date.now() > deadline) break
    const providerCandidates = providerInfo !== null && typeof providerInfo === 'object'
      ? [providerInfo.provider, providerInfo.id, providerInfo.route, providerInfo.name]
      : [providerInfo]
    const provider = providerCandidates.find((value) => typeof value === 'string' && value !== '')
    if (provider === undefined) continue
    const providerLabel = providerInfo !== null && typeof providerInfo === 'object' && typeof providerInfo.name === 'string' && providerInfo.name !== ''
      ? providerInfo.name
      : provider
    let models = []
    try {
      const budget = Math.max(500, Math.min(4_000, deadline - Date.now()))
      models = await Promise.race([
        Promise.resolve(llm.listModels(provider)),
        new Promise((resolve) => {
          const timer = setTimeout(() => resolve([]), budget)
          if (typeof timer.unref === 'function') timer.unref()
        }),
      ])
    } catch {
      models = []
    }
    const mapped = []
    for (const modelInfo of Array.isArray(models) ? models : []) {
      const modelCandidates = modelInfo !== null && typeof modelInfo === 'object'
        ? [modelInfo.id, modelInfo.model, modelInfo.name]
        : [modelInfo]
      const model = modelCandidates.find((value) => typeof value === 'string' && value !== '')
      if (model === undefined) continue
      const modelLabel = modelInfo !== null && typeof modelInfo === 'object' && typeof modelInfo.name === 'string' && modelInfo.name !== ''
        ? modelInfo.name
        : model
      const efforts = []
      const rawEfforts = modelInfo !== null && typeof modelInfo === 'object'
        && modelInfo.reasoning !== null && modelInfo.reasoning !== undefined
        ? modelInfo.reasoning.efforts
        : undefined
      for (const effort of Array.isArray(rawEfforts) ? rawEfforts : []) {
        const id = typeof effort === 'string' ? effort : effort !== null && typeof effort === 'object' ? effort.id : undefined
        if (typeof id !== 'string' || id === '') continue
        const name = effort !== null && typeof effort === 'object' && typeof effort.name === 'string' && effort.name !== '' ? effort.name : id
        efforts.push({ id, name })
      }
      mapped.push({ model, name: modelLabel, efforts })
    }
    entries.push({ provider, name: providerLabel, models: mapped })
  }
  let current = null
  try {
    const { session } = resolveSessionCwd(ctx, body.sessionId)
    const route = commitModelRoute(ctx, session)
    let effort = null
    try {
      const context = session.requestContext()
      if (context !== null && context !== undefined && typeof context.reasoningEffort === 'string' && context.reasoningEffort !== '') {
        effort = context.reasoningEffort
      }
    } catch {
      // No request yet.
    }
    if (route !== null) current = { provider: route.provider, model: route.model, reasoningEffort: effort }
  } catch {
    // Session lookup is optional for this read-only listing.
  }
  return { providers: entries, current }
}

/**
 * Resolve one model's reasoning efforts. `listModels` only advertises ids, so the
 * picker asks for the exact model's metadata when it opens the effort list.
 */
async function resolveModelEfforts(llm, provider, model) {
  const result = { efforts: [], defaultEffort: null }
  try {
    if (typeof llm.resolveModelInfo !== 'function') return result
    const info = await llm.resolveModelInfo(provider, model)
    const reasoning = info !== null && info !== undefined ? info.reasoning : undefined
    if (reasoning !== null && reasoning !== undefined && Array.isArray(reasoning.efforts)) {
      for (const effort of reasoning.efforts) {
        const id = typeof effort === 'string' ? effort : effort !== null && typeof effort === 'object' ? effort.id : undefined
        if (typeof id !== 'string' || id === '') continue
        const name = effort !== null && typeof effort === 'object' && typeof effort.name === 'string' && effort.name !== '' ? effort.name : id
        result.efforts.push({ id, name })
      }
    }
    if (reasoning !== null && reasoning !== undefined && typeof reasoning.defaultEffort === 'string' && reasoning.defaultEffort !== '') {
      result.defaultEffort = reasoning.defaultEffort
    }
  } catch {
    // An adapter that cannot resolve this model keeps the picker on "default".
  }
  return result
}

/** The built-in convention used when the repository declares nothing stricter. */
const DEFAULT_COMMIT_CONVENTION = Object.freeze({
  format: 'type(scope): 中文描述',
  types: ['feat', 'fix', 'docs', 'style', 'refactor', 'perf', 'test', 'build', 'ci', 'chore', 'revert'],
  scopeRequired: true,
  language: 'zh',
  maxLength: null,
  totalMaxLength: 500,
  trailingPeriod: false,
  vague: ['update', 'fix bugs', 'fix bug', 'bugfix', 'misc changes', 'misc', 'cleanup', 'changes'],
})

/** Files that may declare the repository's commit-message convention. */
const CONVENTION_FILES = [
  'commitlint.config.js',
  'commitlint.config.cjs',
  'commitlint.config.mjs',
  '.commitlintrc',
  '.commitlintrc.json',
  '.commitlintrc.yml',
  '.commitlintrc.yaml',
  '.commitlintrc.js',
  '.czrc',
  '.cz-config.js',
  '.gitlint',
]

/** Read a small text file, or null when absent/too large. */
async function readTextIfExists(path, limit) {
  try {
    const info = await stat(path)
    if (!info.isFile() || info.size > limit) return null
    return await readFile(path, 'utf8')
  } catch {
    return null
  }
}

/** DSH home directory (env override first, then ~/.dsh). */
function dshHomePath() {
  const fromEnv = typeof process.env.DSH_HOME === 'string' ? process.env.DSH_HOME : ''
  return fromEnv !== '' ? fromEnv : join(homedir(), '.dsh')
}

/** Plugin-owned commit-convention store path. */
function commitConfigPath() {
  return join(dshHomePath(), 'dsh-git-dock', 'commit-convention.json')
}

// ── A0: audit log for dangerous operations ─────────────────────────────────

/** Path of the append-only audit log. */
function auditLogPath() {
  return join(dshHomePath(), 'dsh-git-dock', 'audit.jsonl')
}

/**
 * Append one audit record. Failure to write must never break the operation.
 *
 * @param {object} entry - `{ action, repoRoot, branch?, target?, result?, details? }`.
 * @returns {Promise<void>} resolves after the best-effort append.
 */
async function appendAudit(entry) {
  try {
    const file = auditLogPath()
    await mkdir(dirname(file), { recursive: true })
    const record = Object.assign({ at: new Date().toISOString(), id: randomUUID() }, entry)
    await appendFile(file, `${JSON.stringify(record)}\n`, 'utf8')
  } catch {
    // Auditing is best effort and never blocks the Git operation.
  }
}

// ── A1: repository registry and per-session active repository ──────────────

/** sessionId → absolute repository root selected for that session. */
const activeRepoBySession = new Map()

/** Path of the repository registry file. */
function repositoriesFile() {
  return join(dshHomePath(), 'dsh-git-dock', 'repositories.json')
}

/** Stable id for one canonical repository path. */
function repositoryIdFor(path) {
  return createHash('sha1').update(path).digest('hex').slice(0, 12)
}

/** Read the registry; a missing or broken file reads as empty. */
async function loadRepositoryEntries() {
  try {
    const parsed = JSON.parse(await readFile(repositoriesFile(), 'utf8'))
    if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed.repositories) !== true) return []
    return parsed.repositories.filter((entry) => entry !== null && typeof entry === 'object'
      && typeof entry.id === 'string' && entry.id !== ''
      && typeof entry.path === 'string' && entry.path !== '')
  } catch {
    return []
  }
}

/** Persist the registry through a temporary file and a rename. */
async function saveRepositoryEntries(entries) {
  const file = repositoriesFile()
  await mkdir(dirname(file), { recursive: true })
  const temp = `${file}.${randomUUID()}.tmp`
  await writeFile(temp, JSON.stringify({ repositories: entries }, null, 2), 'utf8')
  await rename(temp, file)
}

/**
 * Validate one candidate path and canonicalize it to a repository root.
 *
 * @param {unknown} candidate - user-supplied path.
 * @param {AbortSignal} [signal] - cancellation.
 * @returns {Promise<{ id: string, path: string }>} canonical identity.
 */
async function validateRepositoryPath(candidate, signal) {
  if (typeof candidate !== 'string' || candidate.trim() === '') {
    throw new ApiError('bad-request', 'a repository path is required', 400)
  }
  if (candidate.includes('\0')) throw new ApiError('bad-request', 'the repository path contains an invalid character', 400)
  let absolute
  try {
    absolute = resolve(candidate.trim())
  } catch {
    throw new ApiError('bad-request', 'the repository path is not valid', 400)
  }
  let canonical
  try {
    canonical = await realpath(absolute)
  } catch {
    throw new ApiError('path-missing', 'the repository path does not exist', 404, { path: absolute })
  }
  const info = await stat(canonical).catch(() => null)
  if (info === null || info.isDirectory() !== true) {
    throw new ApiError('not-directory', 'the repository path is not a directory', 400, { path: canonical })
  }
  let repoRoot
  try {
    repoRoot = await gitText(canonical, ['rev-parse', '--show-toplevel'], { signal })
  } catch {
    throw new ApiError('not-repo', 'the directory is not a git repository', 409, { path: canonical })
  }
  const rootInfo = await stat(repoRoot).catch(() => null)
  if (rootInfo === null || rootInfo.isDirectory() !== true) {
    throw new ApiError('not-repo', 'the repository root is unavailable', 409, { path: repoRoot })
  }
  return { id: repositoryIdFor(repoRoot), path: repoRoot }
}

/** List registry entries with existence and active flags for one session. */
async function listRepositories(sessionId) {
  const entries = await loadRepositoryEntries()
  const active = sessionId === undefined || sessionId === null ? undefined : activeRepoBySession.get(sessionId)
  const rows = []
  for (const entry of entries) {
    const info = await stat(entry.path).catch(() => null)
    rows.push({
      id: entry.id,
      path: entry.path,
      name: typeof entry.name === 'string' && entry.name !== '' ? entry.name : basename(entry.path),
      createdAt: entry.createdAt ?? null,
      lastOpenedAt: entry.lastOpenedAt ?? null,
      exists: info !== null && info.isDirectory() === true,
      active: active !== undefined && active === entry.path,
    })
  }
  rows.sort((left, right) => (right.lastOpenedAt ?? 0) - (left.lastOpenedAt ?? 0))
  return rows
}

/**
 * Register (or refresh) one repository and make it the session's active one.
 *
 * @returns {Promise<{ repository: object, repositories: object[] }>} registry view.
 */
async function addRepository(sessionId, candidate, signal) {
  const validated = await validateRepositoryPath(candidate, signal)
  const entries = await loadRepositoryEntries()
  const now = Date.now()
  const index = entries.findIndex((entry) => entry.id === validated.id)
  if (index >= 0) {
    entries[index] = Object.assign({}, entries[index], { path: validated.path, name: basename(validated.path), lastOpenedAt: now })
  } else {
    entries.push({ id: validated.id, path: validated.path, name: basename(validated.path), createdAt: now, lastOpenedAt: now })
  }
  await saveRepositoryEntries(entries)
  if (sessionId !== undefined && sessionId !== null) activeRepoBySession.set(sessionId, validated.path)
  const repositories = await listRepositories(sessionId)
  return { repository: repositories.find((entry) => entry.id === validated.id) ?? null, repositories }
}

/**
 * Select an existing registry entry or a path, making it active for the session.
 *
 * @returns {Promise<{ repository: object|null, repositories: object[] }>} registry view.
 */
async function selectRepository(sessionId, idOrPath, signal) {
  if (typeof idOrPath !== 'string' || idOrPath.trim() === '') {
    throw new ApiError('bad-request', 'repositoryId or path is required', 400)
  }
  const entries = await loadRepositoryEntries()
  const known = entries.find((entry) => entry.id === idOrPath || entry.path === idOrPath)
  const validated = await validateRepositoryPath(known === undefined ? idOrPath : known.path, signal)
  activeRepoBySession.set(sessionId, validated.path)
  const now = Date.now()
  const index = entries.findIndex((entry) => entry.id === validated.id)
  if (index >= 0) {
    entries[index] = Object.assign({}, entries[index], { path: validated.path, lastOpenedAt: now })
  } else {
    entries.push({ id: validated.id, path: validated.path, name: basename(validated.path), createdAt: now, lastOpenedAt: now })
  }
  await saveRepositoryEntries(entries)
  const repositories = await listRepositories(sessionId)
  return { repository: repositories.find((entry) => entry.id === validated.id) ?? null, repositories }
}

/** Remove one registry entry; the directory on disk is left alone. */
async function removeRepository(sessionId, id) {
  const entries = await loadRepositoryEntries()
  const next = entries.filter((entry) => entry.id !== id)
  if (next.length !== entries.length) await saveRepositoryEntries(next)
  const active = activeRepoBySession.get(sessionId)
  if (active !== undefined && next.every((entry) => entry.path !== active)) activeRepoBySession.delete(sessionId)
  return { repositories: await listRepositories(sessionId) }
}

/** Parse `git remote -v` output into remote rows. */
async function readRemotes(repoRoot, signal) {
  const raw = await gitText(repoRoot, ['remote', '-v'], { signal })
  const map = new Map()
  for (const line of raw.split('\n')) {
    const match = /^(\S+)\s+(\S+)\s+\((fetch|push)\)$/.exec(line.trim())
    if (match === null) continue
    const [, name, url, kind] = match
    const row = map.get(name) ?? { name, fetchUrl: '', pushUrl: '' }
    if (kind === 'fetch') row.fetchUrl = url
    else row.pushUrl = url
    map.set(name, row)
  }
  return [...map.values()].map((row) => Object.assign({}, row, { pushUrl: row.pushUrl === '' ? row.fetchUrl : row.pushUrl }))
}

/** Sanitize one saved commit config; null when nothing usable remains. */
function sanitizeSavedCommitConfig(raw) {
  if (raw === null || typeof raw !== 'object') return null
  const config = {}
  if (Array.isArray(raw.types)) {
    const types = raw.types.map(String).map((type) => type.trim()).filter((type) => /^[a-z][a-z0-9-]*$/.test(type)).slice(0, 30)
    if (types.length > 0) config.types = types
  }
  if (raw.scopeRequired === true || raw.scopeRequired === false) config.scopeRequired = raw.scopeRequired
  if (raw.language === 'zh' || raw.language === 'en') config.language = raw.language
  if (raw.maxLength === null) config.maxLength = null
  else if (typeof raw.maxLength === 'number' && raw.maxLength >= 20 && raw.maxLength <= 300) config.maxLength = raw.maxLength
  if (typeof raw.totalMaxLength === 'number' && raw.totalMaxLength >= 100 && raw.totalMaxLength <= 5_000) config.totalMaxLength = raw.totalMaxLength
  if (Array.isArray(raw.vague)) {
    config.vague = raw.vague.map(String).map((term) => term.trim()).filter((term) => term !== '').slice(0, 30)
  }
  return Object.keys(config).length === 0 ? null : config
}

/** Read the saved (global) commit convention, if any. */
async function readSavedCommitConfig() {
  const text = await readTextIfExists(commitConfigPath(), 32 * 1024)
  if (text === null) return null
  try {
    const parsed = JSON.parse(text)
    const raw = parsed !== null && typeof parsed === 'object' && parsed.commit !== undefined ? parsed.commit : parsed
    return sanitizeSavedCommitConfig(raw)
  } catch {
    return null
  }
}

/** Persist the saved (global) commit convention. */
async function writeSavedCommitConfig(config) {
  const path = commitConfigPath()
  await mkdir(dirname(path), { recursive: true })
  await writeFile(path, `${JSON.stringify({ commit: config }, null, 2)}\n`, 'utf8')
}

/** Remove the saved commit convention. */
async function clearSavedCommitConfig() {
  try {
    await rm(commitConfigPath(), { force: true })
  } catch {
    // Already absent.
  }
}

/** The serializable view of one convention profile. */
function conventionView(profile) {
  return {
    types: profile.allowedTypes,
    scopes: profile.allowedScopes,
    suggestedScopes: profile.scopes.map((scope) => scope.name),
    scopeRequired: profile.scopeRequired,
    language: profile.language,
    maxLength: profile.maxLength,
    totalMaxLength: profile.totalMaxLength,
    vague: profile.vague,
    sources: profile.sources,
  }
}

/** Extract a quoted array element list after a key (`type-enum: ['feat', ...]`). */function extractQuotedList(text, key) {
  const index = text.indexOf(key)
  if (index === -1) return []
  const slice = text.slice(index, index + 2_000)
  // commitlint's rule shape is `[<level>, 'always'|'never', [...values]]`, so
  // start at the bracket AFTER the level token instead of the first bracket.
  const level = /['"](?:always|never|warn|error)['"]/.exec(slice)
  let open
  if (level !== null) {
    const after = slice.indexOf('[', level.index + level[0].length)
    open = after === -1 ? slice.indexOf('[') : after
  } else {
    open = slice.indexOf('[')
  }
  if (open === -1) return []
  const close = slice.indexOf(']', open)
  if (close === -1) return []
  return [...slice.slice(open + 1, close).matchAll(/['"]([^'"]{1,40})['"]/g)]
    .map((match) => match[1])
    .filter((name) => !['always', 'never', 'warn', 'error'].includes(name))
}

/** Extract a `- item` YAML list after a key. */
function extractYamlList(text, key) {
  const index = text.indexOf(key)
  if (index === -1) return []
  const names = []
  for (const line of text.slice(index, index + 1_200).split('\n').slice(1)) {
    const match = /^\s*-\s*['"]?([A-Za-z][\w-]*)['"]?\s*$/.exec(line)
    if (match === null) {
      if (names.length > 0 && line.trim() !== '') break
      continue
    }
    names.push(match[1])
    if (names.length >= 20) break
  }
  return names
}

/** Extract `"type-enum"`/`"scope-enum"` values from a commitlint config text. */
function extractCommitlintRules(text) {
  const types = extractQuotedList(text, 'type-enum')
  const scopes = extractQuotedList(text, 'scope-enum')
  const yamlTypes = types.length === 0 ? extractYamlList(text, 'type-enum') : []
  const yamlScopes = scopes.length === 0 ? extractYamlList(text, 'scope-enum') : []
  const headerMax = /header-max-length['"]?\s*[:=]\s*\[([^\]]{0,120})\]/.exec(text)
  let maxLength = null
  if (headerMax !== null) {
    const numbers = [...headerMax[1].matchAll(/\d+/g)].map((match) => Number(match[0]))
    if (numbers.length > 0) maxLength = numbers[numbers.length - 1]
  }
  return {
    types: types.length > 0 ? types : yamlTypes,
    scopes: scopes.length > 0 ? scopes : yamlScopes,
    maxLength: Number.isFinite(maxLength) ? maxLength : null,
  }
}

/**
 * Read the repository's commit-message conventions from history and config.
 *
 * @param {string} repoRoot - repository root.
 * @param {AbortSignal} [signal] - cancellation.
 * @returns {Promise<object>} a convention profile.
 */
async function detectCommitConventions(repoRoot, signal) {
  const profile = {
    conventional: true,
    hasHistory: false,
    scopeRequired: DEFAULT_COMMIT_CONVENTION.scopeRequired,
    vague: DEFAULT_COMMIT_CONVENTION.vague.slice(),
    types: [],
    scopes: [],
    allowedTypes: DEFAULT_COMMIT_CONVENTION.types.slice(),
    allowedScopes: [],
    language: DEFAULT_COMMIT_CONVENTION.language,
    maxLength: DEFAULT_COMMIT_CONVENTION.maxLength,
    totalMaxLength: DEFAULT_COMMIT_CONVENTION.totalMaxLength,
    trailingPeriod: DEFAULT_COMMIT_CONVENTION.trailingPeriod,
    samples: [],
    template: null,
    sources: ['default'],
  }
  let subjects = []
  try {
    subjects = (await gitText(repoRoot, ['log', '-40', '--format=%s'], { signal })).split('\n').filter((line) => line !== '')
  } catch {
    subjects = []
  }
  const conventionalRe = /^([A-Za-z][A-Za-z0-9-]*)(\([^)]{1,40}\))?!?: (.+)$/
  const typeCounts = new Map()
  const scopeCounts = new Map()
  let conventionalHits = 0
  let cjk = 0
  let withPeriod = 0
  for (const subject of subjects) {
    const match = conventionalRe.exec(subject)
    if (match !== null) {
      conventionalHits += 1
      typeCounts.set(match[1], (typeCounts.get(match[1]) ?? 0) + 1)
      if (match[2] !== undefined) {
        const scope = match[2].slice(1, -1)
        scopeCounts.set(scope, (scopeCounts.get(scope) ?? 0) + 1)
      }
    }
    if (/[\u4e00-\u9fff]/.test(subject)) cjk += 1
    if (/[.。]$/.test(subject)) withPeriod += 1
  }
  if (subjects.length > 0) {
    profile.hasHistory = true
    profile.sources.push('log')
    profile.types = [...typeCounts.entries()].sort((left, right) => right[1] - left[1]).slice(0, 8)
      .map(([name, count]) => ({ name, count }))
    profile.scopes = [...scopeCounts.entries()].sort((left, right) => right[1] - left[1]).slice(0, 8)
      .map(([name, count]) => ({ name, count }))
    // Only a sizeable, uniformly English history overrides the Chinese default.
    if (subjects.length >= 10 && cjk === 0 && conventionalHits / subjects.length >= 0.5) profile.language = 'en'
    profile.trailingPeriod = withPeriod > subjects.length * 0.3
    profile.samples = subjects.slice(0, 5)
  }
  for (const name of CONVENTION_FILES) {
    const text = await readTextIfExists(join(repoRoot, name), 64 * 1024)
    if (text === null) continue
    profile.sources.push(name)
    const rules = extractCommitlintRules(text)
    if (rules.types.length > 0) profile.allowedTypes = rules.types
    if (rules.scopes.length > 0) profile.allowedScopes = rules.scopes
    if (rules.maxLength !== null) profile.maxLength = rules.maxLength
  }
  const pkg = await readTextIfExists(join(repoRoot, 'package.json'), 256 * 1024)
  if (pkg !== null) {
    try {
      const parsed = JSON.parse(pkg)
      const rules = parsed.commitlint !== undefined && parsed.commitlint.rules !== undefined ? parsed.commitlint.rules : null
      if (rules !== null) {
        const types = rules['type-enum']
        const scopes = rules['scope-enum']
        if (Array.isArray(types) && types.length > 2) profile.allowedTypes = types.slice(2).map(String)
        if (Array.isArray(scopes) && scopes.length > 2) profile.allowedScopes = scopes.slice(2).map(String)
        const header = rules['header-max-length']
        if (Array.isArray(header) && header.length > 2 && typeof header[2] === 'number') profile.maxLength = header[2]
        profile.sources.push('package.json#commitlint')
      }
    } catch {
      // A malformed manifest is not a convention source.
    }
  }
  try {
    const templatePath = (await gitText(repoRoot, ['config', '--get', 'commit.template'], { signal })).trim()
    if (templatePath !== '') {
      const absolute = isAbsolute(templatePath) ? templatePath : join(repoRoot, templatePath)
      const text = await readTextIfExists(absolute, 8 * 1024)
      if (text !== null && text.trim() !== '') profile.template = text.slice(0, 1_500)
    }
  } catch {
    // No commit template configured.
  }
  const savedConfig = await readSavedCommitConfig()
  if (savedConfig !== null) {
    profile.sources.push('saved-config')
    if (savedConfig.types !== undefined) profile.allowedTypes = savedConfig.types
    if (savedConfig.scopeRequired !== undefined) profile.scopeRequired = savedConfig.scopeRequired
    if (savedConfig.language !== undefined) profile.language = savedConfig.language
    if (savedConfig.maxLength !== undefined) profile.maxLength = savedConfig.maxLength
    if (savedConfig.totalMaxLength !== undefined) profile.totalMaxLength = savedConfig.totalMaxLength
    if (savedConfig.vague !== undefined) profile.vague = savedConfig.vague
  }
  const override = await readTextIfExists(join(repoRoot, '.dsh-git-dock.json'), 16 * 1024)
  if (override !== null) {
    try {
      const parsed = JSON.parse(override)
      const commit = parsed.commit !== undefined && parsed.commit !== null ? parsed.commit : {}
      if (Array.isArray(commit.types) && commit.types.length > 0) profile.allowedTypes = commit.types.map(String)
      if (Array.isArray(commit.scopes) && commit.scopes.length > 0) profile.allowedScopes = commit.scopes.map(String)
      if (commit.language === 'zh' || commit.language === 'en') profile.language = commit.language
      if (typeof commit.maxLength === 'number' && commit.maxLength >= 20 && commit.maxLength <= 120) profile.maxLength = commit.maxLength
      if (typeof commit.totalMaxLength === 'number' && commit.totalMaxLength >= 100 && commit.totalMaxLength <= 5_000) profile.totalMaxLength = commit.totalMaxLength
      if (commit.scopeRequired === true || commit.scopeRequired === false) profile.scopeRequired = commit.scopeRequired
      profile.sources.push('.dsh-git-dock.json')
    } catch {
      // An unreadable override is ignored.
    }
  }
  return profile
}

/** Render a convention profile as prompt rules. */
function conventionRules(profile) {
  const languageLabel = profile.language === 'zh' ? 'Chinese' : 'English'
  const lines = ['Repository commit-message conventions (they OVERRIDE your own habits — follow them exactly):']
  lines.push('- Format: a single line "type(scope): description"')
  lines.push(`- Allowed types: ${profile.allowedTypes.slice(0, 12).join(', ')}`)
  if (profile.scopeRequired) {
    lines.push('- Scope: REQUIRED. English lowercase or kebab-case module name, e.g. "auth", "user-profile"')
  } else {
    lines.push('- Scope: optional; when present use an English lowercase or kebab-case module name')
  }
  if (profile.allowedScopes.length > 0) {
    lines.push(`- Allowed scopes: ${profile.allowedScopes.slice(0, 12).join(', ')}`)
  } else {
    const scopes = profile.scopes.map((scope) => scope.name).filter((name) => name !== '')
    if (scopes.length > 0) lines.push(`- Scopes seen in this repository: ${scopes.slice(0, 10).join(', ')}`)
    lines.push('- Derive the scope from the module the staged diff actually changes')
  }
  lines.push(`- Description: ${languageLabel}, concise, and ONLY about the staged changes shown below`)
  lines.push(`- Never use vague descriptions such as: ${profile.vague.join(', ')}`)
  if (profile.maxLength !== null) lines.push(`- Subject line: at most ${profile.maxLength} characters in total`)
  lines.push(`- Total message: at most ${profile.totalMaxLength} characters including newlines`)
  lines.push('- If the change needs detail, put the subject alone on the first line, add ONE blank line, then bullet lines that start with "- " (one short bullet per change), staying under the total limit.')
  lines.push(`- Trailing period: ${profile.trailingPeriod ? 'allowed' : 'never add one on the subject line'}`)
  if (profile.samples.length > 0) {
    lines.push('- Examples from this repository:', ...profile.samples.slice(0, 4).map((sample) => `  ${sample}`))
  }
  if (profile.template !== null) lines.push(`- The repository's commit template:\n${profile.template}`)
  return lines.join('\n')
}

/** Check one draft against the detected profile. */
function validateCommitMessage(message, profile) {
  const problems = []
  const lines = message.split('\n')
  const subject = lines[0] ?? ''
  const conventionalRe = /^([A-Za-z][A-Za-z0-9-]*)(\(([^)]{1,40})\))?!?: (.+)$/
  const match = conventionalRe.exec(subject)
  if (match === null) {
    problems.push('the first line must be "type(scope): 中文描述"')
  } else {
    const type = match[1]
    const scope = match[3]
    const description = match[4]
    if (/^[A-Z]/.test(type)) problems.push('write the type in lowercase')
    if (!profile.allowedTypes.includes(type)) {
      problems.push(`type "${type}" is not allowed (allowed: ${profile.allowedTypes.slice(0, 12).join(', ')})`)
    }
    if (profile.scopeRequired && (scope === undefined || scope === '')) {
      problems.push('the scope is required, e.g. "feat(auth): 新增登录"')
    }
    if (scope !== undefined && !/^[a-z][a-z0-9]*(-[a-z0-9]+)*$/.test(scope)) {
      problems.push(`scope "${scope}" must be lowercase English or kebab-case`)
    }
    if (profile.allowedScopes.length > 0 && scope !== undefined && !profile.allowedScopes.includes(scope)) {
      problems.push(`scope "${scope}" is not allowed (allowed: ${profile.allowedScopes.slice(0, 10).join(', ')})`)
    }
    if (description.trim() === '') problems.push('the description is empty')
    if (profile.language === 'zh' && !/[\u4e00-\u9fff]/.test(description)) {
      problems.push('the description must be written in Chinese')
    }
    const normalized = description.trim().toLowerCase().replace(/[.。,，!！?？\s]+$/g, '')
    if (profile.vague.some((term) => normalized === term || normalized.startsWith(`${term} `))) {
      problems.push(`the description "${description}" is too vague; state what changed`)
    }
  }
  if (lines.length > 1) {
    if (lines[1] !== '') problems.push('separate the subject from the body with exactly one blank line')
    const bullets = lines.slice(2).filter((line) => line.trim() !== '')
    if (bullets.length === 0) problems.push('the body has no bullet points; remove the blank line or add "- " bullets')
    for (const bullet of bullets) {
      if (!bullet.startsWith('- ')) {
        problems.push('every body line must be a bullet starting with "- "')
        break
      }
      if (bullet.slice(2).trim() === '') {
        problems.push('a bullet is empty')
        break
      }
      if (profile.language === 'zh' && !/[\u4e00-\u9fff]/.test(bullet)) {
        problems.push('body bullets must be written in Chinese')
        break
      }
    }
  }
  if (profile.maxLength !== null && subject.length > profile.maxLength) {
    problems.push(`keep the subject line to at most ${profile.maxLength} characters`)
  }
  if (profile.totalMaxLength !== null && message.length > profile.totalMaxLength) {
    problems.push(`keep the whole message to at most ${profile.totalMaxLength} characters`)
  }
  if (!profile.trailingPeriod && /[.。]$/.test(subject)) problems.push('do not end the subject with a period')
  return { ok: problems.length === 0, problems }
}

/** One streamed model call producing the cleaned message. */
async function streamCommitMessage(llm, route, system, prompt, signal, sessionId, reasoningEffort) {
  let output = ''
  const stream = llm.stream({
    provider: route.provider,
    model: route.model,
    ...(typeof reasoningEffort === 'string' && reasoningEffort !== '' ? { reasoningEffort } : {}),
    system,
    messages: [{ role: 'user', content: [{ type: 'text', text: prompt }] }],
    maxTokens: 300,
    temperature: 0.2,
    signal,
    sessionId,
  })
  for await (const chunk of stream) {
    if (chunk.type === 'text-delta') output += chunk.text
    else if (chunk.type === 'finish' && chunk.reason.kind === 'error') {
      throw new ApiError('llm-failed', chunk.reason.failure?.message ?? 'model request failed', 502)
    }
  }
  const raw = output
    .replace(/^```[a-z]*\s*/i, '')
    .replace(/```\s*$/i, '')
    .replace(/\r\n?/g, '\n')
  const cleanedLines = raw.split('\n').map((line) => line.replace(/[ \t]+/g, ' ').trim())
  const compact = []
  for (const line of cleanedLines) {
    if (line === '' && (compact.length === 0 || compact[compact.length - 1] === '')) continue
    compact.push(line)
  }
  while (compact.length > 0 && compact[compact.length - 1] === '') compact.pop()
  let message = compact.join('\n').trim()
  if (!message.includes('\n')) message = message.replace(/^["'`]|["'`]$/g, '')
  return message
}

/**
 * List the files of one comparison (staged index or working tree), sorted by
 * path and deduplicated so a path appears once in its final state.
 *
 * @param {string} repoRoot - repository root.
 * @param {'staged'|'worktree'} mode - comparison to list.
 * @param {AbortSignal} [signal] - cancellation.
 * @returns {Promise<object[]>} `{ path, origPath?, status, additions, deletions }` rows.
 */
async function listChangedFiles(repoRoot, mode, signal) {
  const statusRaw = await runGit(repoRoot, ['status', '--porcelain=v2', '-z', '--untracked-files=normal'], { signal })
  const rows = parseStatusRows(statusRaw)
  const allowed = rows.filter((row) => {
    if (mode === 'staged') return row.untracked !== true && row.x !== undefined && row.x !== '.' && row.x !== '!'
    if (row.untracked === true) return true
    return row.y !== undefined && row.y !== '.' && row.y !== '!'
  })
  let stats = new Map()
  try {
    const args = mode === 'staged'
      ? ['diff', '--cached', '--numstat', '-z', '--no-color']
      : ['diff', '--numstat', '-z', '--no-color']
    const numstat = await runGit(repoRoot, args, { signal })
    const tokens = numstat.split('\0')
    for (let index = 0; index < tokens.length; index += 1) {
      const token = tokens[index]
      if (token === '') continue
      const firstTab = token.indexOf('\t')
      const secondTab = firstTab < 0 ? -1 : token.indexOf('\t', firstTab + 1)
      if (firstTab < 0 || secondTab < 0) continue
      const added = token.slice(0, firstTab)
      const deleted = token.slice(firstTab + 1, secondTab)
      let path = token.slice(secondTab + 1)
      if (path === '') {
        path = tokens[index + 1] ?? ''
        index += 1
      }
      if (path === '') continue
      stats.set(path, {
        additions: added === '-' ? null : Number(added),
        deletions: deleted === '-' ? null : Number(deleted),
      })
    }
  } catch {
    stats = new Map()
  }
  const byPath = new Map()
  for (const row of allowed) {
    const status = row.untracked === true ? '?' : mode === 'staged' ? row.x : row.y
    const stat = stats.get(row.path)
    byPath.set(row.path, {
      path: row.path,
      origPath: row.origPath ?? null,
      status,
      additions: stat === undefined ? null : stat.additions,
      deletions: stat === undefined ? null : stat.deletions,
    })
  }
  // A diff entry that the status rows cannot name still belongs to the summary.
  for (const [path, stat] of stats) {
    if (byPath.has(path)) continue
    byPath.set(path, { path, origPath: null, status: 'M', additions: stat.additions, deletions: stat.deletions })
  }
  return [...byPath.values()].sort((left, right) => (left.path < right.path ? -1 : left.path > right.path ? 1 : 0))
}

/** Draft a commit message with the session's model, following repo conventions. */
async function suggestCommitMessage(ctx, body, signal) {
  const llm = ctx.get('llm')
  if (llm === undefined || llm === null || typeof llm.stream !== 'function') {
    throw new ApiError('llm-unavailable', 'no LLM service is mounted', 503)
  }
  const { session } = resolveSessionCwd(ctx, body.sessionId)
  const state = await readRepoState(ctx, body.sessionId, signal)
  const staged = await runGit(state.repoRoot, ['diff', '--cached', '--no-color', '--no-ext-diff'], { signal, maxBytes: DIFF_OUTPUT_LIMIT })
  const useWorktree = staged.trim() === ''
  const raw = useWorktree
    ? await runGit(state.repoRoot, ['diff', '--no-color', '--no-ext-diff'], { signal, maxBytes: DIFF_OUTPUT_LIMIT })
    : staged
  if (raw.trim() === '') {
    throw new ApiError('nothing-staged', 'nothing to summarize: stage files or modify the worktree first', 409)
  }
  const scope = useWorktree ? 'worktree' : 'staged'
  const files = await listChangedFiles(state.repoRoot, scope, signal)
  const diff = raw.length > 24_000 ? `${raw.slice(0, 24_000)}\n… (diff truncated; the file list above is complete)` : raw
  const requested = body !== null && typeof body === 'object' ? body : {}
  const explicitRoute = typeof requested.provider === 'string' && requested.provider !== ''
    && typeof requested.model === 'string' && requested.model !== ''
    ? { provider: requested.provider, model: requested.model }
    : null
  const route = explicitRoute ?? commitModelRoute(ctx, session)
  if (route === null) throw new ApiError('llm-unavailable', 'no model is selected for this session', 503)
  const reasoningEffort = typeof requested.reasoningEffort === 'string' && requested.reasoningEffort !== ''
    ? requested.reasoningEffort
    : null

  const conventions = await detectCommitConventions(state.repoRoot, signal)
  const language = conventions.language ?? (typeof body.language === 'string' && body.language.toLowerCase().startsWith('zh') ? 'zh' : 'en')
  const system = 'You write Git commit messages for the repository below. Reply with ONE line only, no quotes, '
    + 'no code fences, no trailing explanation.\n\n' + conventionRules(Object.assign({}, conventions, { language }))
  const fileLines = files
    .map((file) => {
      const name = file.origPath === null ? file.path : `${file.origPath} → ${file.path}`
      const counts = `${file.additions === null ? '' : ` +${file.additions}`}${file.deletions === null ? '' : ` -${file.deletions}`}`.trim()
      return `- ${name} (${file.status}${counts === '' ? '' : ` ${counts}`})`
    })
    .join('\n')
  const prompt = [
    `Commit scope: ${scope === 'staged' ? 'the staged index (all staged changes)' : 'the working tree (nothing is staged)'}.`,
    `Changed files (${files.length}), sorted by path and deduplicated by final state:`,
    fileLines,
    '',
    'Write a message that reflects every staged change above, not just the last one.',
    '',
    `Diff:\n${diff}`,
  ].join('\n')
  let message = await streamCommitMessage(llm, route, system, prompt, signal, body.sessionId, reasoningEffort)
  if (message === '') throw new ApiError('llm-failed', 'the model returned an empty message', 502)
  let check = validateCommitMessage(message, conventions)
  if (!check.ok) {
    const correction = `${system}\n\nThe previous draft "${message}" violated the conventions:\n- ${check.problems.join('\n- ')}\nReturn a corrected single-line message that satisfies every rule.`
    message = await streamCommitMessage(llm, route, correction, prompt, signal, body.sessionId, reasoningEffort)
    check = validateCommitMessage(message, conventions)
    if (!check.ok) {
      const fallbackLines = message.split('\n')
      fallbackLines[0] = fallbackLines[0].replace(/[.。]$/, '').trim()
      if (conventions.maxLength !== null && fallbackLines[0].length > conventions.maxLength) {
        fallbackLines[0] = fallbackLines[0].slice(0, conventions.maxLength).trim()
      }
      while (fallbackLines.length > 1 && fallbackLines[fallbackLines.length - 1].trim() === '') fallbackLines.pop()
      message = fallbackLines.join('\n')
      if (conventions.totalMaxLength !== null && message.length > conventions.totalMaxLength) {
        const parts = message.split('\n')
        while (parts.length > 1 && parts.join('\n').length > conventions.totalMaxLength) {
          parts.pop()
          while (parts.length > 0 && parts[parts.length - 1].trim() === '') parts.pop()
        }
        message = parts.join('\n')
        if (message.length > conventions.totalMaxLength) message = message.slice(0, conventions.totalMaxLength).trim()
      }
    }
  }
  if (message === '') throw new ApiError('llm-failed', 'the model returned an empty message', 502)
  const summary = [
    'conventional',
    conventions.allowedTypes.slice(0, 5).join('/'),
    language,
    conventions.scopeRequired ? 'scope' : null,
    conventions.maxLength === null ? null : `≤${conventions.maxLength}`,
    conventions.totalMaxLength === null ? null : `total ≤${conventions.totalMaxLength}`,
  ].filter(Boolean).join(' · ')
  return {
    message,
    scope,
    files,
    provider: route.provider,
    model: route.model,
    conventions: {
      style: 'conventional',
      format: DEFAULT_COMMIT_CONVENTION.format,
      language,
      scopeRequired: conventions.scopeRequired,
      maxLength: conventions.maxLength,
      totalMaxLength: conventions.totalMaxLength,
      types: conventions.allowedTypes,
      scopes: conventions.allowedScopes,
      vague: conventions.vague,
      sources: conventions.sources,
      summary,
    },
  }
}

/** Fetch every remote (pruning deleted refs). */
async function fetchRemote(ctx, body, signal) {
  const repoRoot = await resolveRepoRoot(ctx, body.sessionId, signal)
  return withRepoLock(repoRoot, async () => {
    const before = await readRepoState(ctx, body.sessionId, signal)
    const result = await runGit(before.repoRoot, ['fetch', '--all', '--prune'], {
      signal,
      rawResult: true,
      exitCodes: [0, 1],
      timeoutMs: 180_000,
    })
    if (result.code !== 0) {
      throw new ApiError('fetch-failed', firstLine(result.stderr) || 'git fetch failed', 400, { detail: result.stderr.slice(0, 4_000) })
    }
    return { repo: await readRepoState(ctx, body.sessionId, signal) }
  })
}

/** Pull the upstream into the current branch, fast-forward only. */
async function pullRemote(ctx, body, signal) {
  const repoRoot = await resolveRepoRoot(ctx, body.sessionId, signal)
  return withRepoLock(repoRoot, async () => {
    const before = await readRepoState(ctx, body.sessionId, signal)
    if (before.detached === true) throw new ApiError('detached', 'cannot pull on a detached HEAD', 409)
    if (before.upstream === null || before.upstream === undefined || before.upstream === '') {
      throw new ApiError('no-upstream', `no upstream is configured for ${before.branch}; push and track it first`, 409, { branch: before.branch })
    }
    const result = await runGit(before.repoRoot, ['pull', '--ff-only'], {
      signal,
      rawResult: true,
      exitCodes: [0, 1],
      timeoutMs: 180_000,
    })
    if (result.code !== 0) {
      const detail = result.stderr
      const diverged = /diverg|not possible to fast-forward|would be overwritten/i.test(detail)
      throw new ApiError(diverged ? 'diverged' : 'pull-failed', firstLine(detail) || 'git pull failed', 409, { detail: detail.slice(0, 4_000) })
    }
    return { repo: await readRepoState(ctx, body.sessionId, signal) }
  })
}

/** Push the current branch, optionally setting its upstream first. */
async function pushRemote(ctx, body, signal) {
  const repoRoot = await resolveRepoRoot(ctx, body.sessionId, signal)
  return withRepoLock(repoRoot, async () => {
    const before = await readRepoState(ctx, body.sessionId, signal)
    if (before.detached === true || before.branch === null) throw new ApiError('detached', 'cannot push a detached HEAD', 409)
    if (before.conflictPaths.length > 0) {
      throw new ApiError('unresolved-conflicts', 'resolve every conflicted file before pushing', 409, { conflicts: before.conflictTypes })
    }
    if (before.operation !== 'none') {
      throw new ApiError('operation-in-progress', `finish the ${before.operation} first`, 409, { operation: before.operation })
    }
    let upstream = null
    try {
      upstream = (await gitText(before.repoRoot, ['rev-parse', '--abbrev-ref', '--symbolic-full-name', '@{upstream}'], { signal })).trim()
    } catch {
      upstream = null
    }
    let args
    if (upstream === null || upstream === '') {
      if (body.setUpstream !== true) {
        throw new ApiError('no-upstream', `no upstream is configured for ${before.branch}`, 409, { branch: before.branch })
      }
      const remotes = (await gitText(before.repoRoot, ['remote'], { signal })).split('\n').filter((name) => name !== '')
      if (remotes.length === 0) throw new ApiError('no-remote', 'no git remote is configured', 409)
      const remote = remotes.includes('origin') ? 'origin' : remotes[0]
      args = ['push', '-u', remote, before.branch]
    } else {
      args = ['push']
    }
    const result = await runGit(before.repoRoot, args, {
      signal,
      rawResult: true,
      exitCodes: [0, 1],
      timeoutMs: 180_000,
    })
    if (result.code !== 0) {
      const detail = result.stderr
      const rejected = /rejected|non-fast-forward|fetch first|behind/i.test(detail)
      await appendAudit({ action: 'push', repoRoot: before.repoRoot, branch: before.branch, target: args.slice(-1), result: rejected ? 'rejected' : 'failed' })
      throw new ApiError(rejected ? 'push-rejected' : 'push-failed', firstLine(detail) || 'git push failed', 409, { detail: detail.slice(0, 4_000) })
    }
    await appendAudit({ action: 'push', repoRoot: before.repoRoot, branch: before.branch, target: args.slice(-1), result: 'pushed' })
    return { repo: await readRepoState(ctx, body.sessionId, signal), setUpstream: upstream === null || upstream === '', upstream: upstream ?? null }
  })
}

// ── Sync: pull phase, push phase, and a per-repository result log ─────────

/** File that keeps the newest sync results (pull and push separately). */
function syncLogFile() {
  return join(dshHomePath(), 'dsh-git-dock', 'sync-log.json')
}

/**
 * Append one sync result for a repository, keeping the newest 60 entries.
 *
 * @param {string} repoRoot - repository the result belongs to.
 * @param {object} entry - one sync report.
 * @returns {Promise<void>} resolves after a best-effort write.
 */
async function appendSyncLog(repoRoot, entry) {
  try {
    const file = syncLogFile()
    await mkdir(dirname(file), { recursive: true })
    let entries = []
    try {
      const parsed = JSON.parse(await readFile(file, 'utf8'))
      if (Array.isArray(parsed)) entries = parsed
    } catch {
      // A missing or broken log starts over.
    }
    entries.unshift(entry)
    while (entries.length > 60) entries.pop()
    await writeFile(file, JSON.stringify(entries, null, 2), 'utf8')
  } catch {
    // Logging must never fail the sync itself.
  }
}

/**
 * Read the newest sync results for one repository.
 *
 * @param {string} repoRoot - repository to filter by.
 * @returns {Promise<object[]>} newest-first entries.
 */
async function readSyncLog(repoRoot) {
  try {
    const parsed = JSON.parse(await readFile(syncLogFile(), 'utf8'))
    if (!Array.isArray(parsed)) return []
    return parsed.filter((entry) => entry !== null && typeof entry === 'object' && entry.repoRoot === repoRoot).slice(0, 20)
  } catch {
    return []
  }
}

/** Report one sync phase result to the log and to the caller. */
async function finishSyncPhase(repoRoot, entry) {
  await appendSyncLog(repoRoot, entry)
  return entry
}

/**
 * Pull phase of Sync: fetch, then fast-forward or merge the upstream.
 * Merge conflicts end the phase with the conflicted file list and types.
 */
async function syncPull(ctx, body, signal) {
  const repoRoot = await resolveRepoRoot(ctx, body.sessionId, signal)
  return withRepoLock(repoRoot, async () => {
    const before = await readRepoState(ctx, body.sessionId, signal)
    const entry = {
      at: new Date().toISOString(),
      branch: before.branch,
      head: before.head,
      repoRoot: before.repoRoot,
      pull: { status: 'up-to-date', conflicts: [] },
      push: { status: 'skipped' },
    }
    if (before.detached === true) throw new ApiError('detached', 'cannot sync a detached HEAD', 409)
    if (before.upstream === null || before.upstream === undefined || before.upstream === '') {
      entry.pull = { status: 'no-upstream', reason: 'no-upstream' }
      return finishSyncPhase(before.repoRoot, entry)
    }
    if (before.conflictPaths.length > 0) {
      entry.pull = { status: 'blocked', reason: 'unresolved-conflicts', conflicts: before.conflictTypes }
      return finishSyncPhase(before.repoRoot, entry)
    }
    const fetch = await runGit(before.repoRoot, ['fetch', '--all', '--prune'], {
      signal,
      rawResult: true,
      exitCodes: [0, 1],
      timeoutMs: 180_000,
    })
    if (fetch.code !== 0) {
      entry.pull = { status: 'fetch-error', message: firstLine(fetch.stderr) || 'git fetch failed' }
      return finishSyncPhase(before.repoRoot, entry)
    }
    const fetched = await readRepoState(ctx, body.sessionId, signal)
    if (fetched.behind === 0) {
      entry.pull = { status: fetched.ahead > 0 ? 'up-to-date' : 'up-to-date' }
      entry.repo = fetched
      return finishSyncPhase(before.repoRoot, entry)
    }
    const target = fetched.upstream === null || fetched.upstream === ''
      ? `origin/${fetched.branch}`
      : fetched.upstream
    if (fetched.ahead === 0) {
      const fastForward = await runGit(before.repoRoot, ['merge', '--ff-only', target], {
        signal,
        rawResult: true,
        exitCodes: [0, 1],
        timeoutMs: 180_000,
      })
      if (fastForward.code !== 0) {
        entry.pull = { status: 'error', message: firstLine(fastForward.stderr) || 'fast-forward failed' }
      } else {
        entry.pull = { status: 'fast-forward' }
      }
    } else {
      const merge = await runGit(before.repoRoot, ['merge', '--no-edit', target], {
        signal,
        rawResult: true,
        exitCodes: [0, 1],
        timeoutMs: 180_000,
      })
      if (merge.code !== 0) {
        const afterMerge = await readRepoState(ctx, body.sessionId, signal)
        if (afterMerge.conflictPaths.length > 0) {
          entry.pull = { status: 'conflict', message: 'merge conflicts', conflicts: afterMerge.conflictTypes }
        } else {
          entry.pull = { status: 'error', message: firstLine(merge.stderr) || 'git merge failed' }
        }
        entry.repo = afterMerge
        return finishSyncPhase(before.repoRoot, entry)
      }
      entry.pull = { status: 'merged' }
    }
    entry.repo = await readRepoState(ctx, body.sessionId, signal)
    return finishSyncPhase(before.repoRoot, entry)
  })
}

/**
 * Push phase of Sync. Refuses while conflicts or an operation is still open,
 * so an accidental push never carries conflict markers upstream.
 */
async function syncPush(ctx, body, signal) {
  const repoRoot = await resolveRepoRoot(ctx, body.sessionId, signal)
  return withRepoLock(repoRoot, async () => {
    const before = await readRepoState(ctx, body.sessionId, signal)
    const entry = {
      at: new Date().toISOString(),
      branch: before.branch,
      head: before.head,
      repoRoot: before.repoRoot,
      pull: { status: 'skipped' },
      push: { status: 'up-to-date' },
    }
    if (before.conflictPaths.length > 0) {
      entry.push = { status: 'blocked', reason: 'unresolved-conflicts', conflicts: before.conflictTypes }
      return finishSyncPhase(before.repoRoot, entry)
    }
    if (before.operation !== 'none') {
      entry.push = { status: 'blocked', reason: 'operation-in-progress', operation: before.operation }
      return finishSyncPhase(before.repoRoot, entry)
    }
    if (before.ahead === 0) {
      entry.repo = before
      return finishSyncPhase(before.repoRoot, entry)
    }
    if (before.upstream === null || before.upstream === '') {
      entry.push = { status: 'no-upstream', reason: 'no-upstream' }
      return finishSyncPhase(before.repoRoot, entry)
    }
    const push = await runGit(before.repoRoot, ['push'], {
      signal,
      rawResult: true,
      exitCodes: [0, 1],
      timeoutMs: 180_000,
    })
    if (push.code !== 0) {
      const rejected = /rejected|non-fast-forward|fetch first/i.test(push.stderr)
      entry.push = {
        status: rejected ? 'rejected' : 'error',
        message: firstLine(push.stderr) || 'git push failed',
        detail: push.stderr.slice(0, 4_000),
      }
    } else {
      entry.push = { status: 'pushed' }
    }
    entry.repo = await readRepoState(ctx, body.sessionId, signal)
    return finishSyncPhase(before.repoRoot, entry)
  })
}

// ── Model-facing tool ─────────────────────────────────────────────────────

const TOOL_NAME = 'git_branch'

/** One tool over the same Host operations the UI calls. */
function toolDefinition(ctx) {
  return {
    name: TOOL_NAME,
    description:
      'Inspect and change the Git branch of the session working directory. '
      + 'status returns branch, HEAD, upstream divergence, in-progress operation and change counts; '
      + 'list adds local and remote branches; switch checks out an existing local branch; '
      + 'create makes a branch and checks it out; merge merges source into the current branch '
      + '(mode no-ff by default, ff-only or squash) and reports conflicts; abort_merge abandons an open '
      + 'merge; complete_merge commits it once every conflict is resolved; resolve_conflict marks one '
      + 'conflicted path resolved. A conflicted merge stays open until aborted or completed.',
    parameters: {
      type: 'object',
      additionalProperties: false,
      required: ['action'],
      properties: {
        action: {
          type: 'string',
          enum: ['status', 'list', 'switch', 'create', 'merge', 'abort_merge', 'complete_merge', 'resolve_conflict'],
          description: 'operation to perform',
        },
        branch: { type: 'string', description: 'existing local branch to switch to' },
        name: { type: 'string', description: 'new branch name (create)' },
        from: { type: 'string', description: 'optional start point for create; defaults to HEAD' },
        source: { type: 'string', description: 'branch or ref to merge into the current branch (merge)' },
        mode: { type: 'string', enum: ['no-ff', 'ff-only', 'squash'], description: 'merge mode; defaults to no-ff' },
        path: { type: 'string', description: 'repository-relative conflicted path (resolve_conflict)' },
      },
    },
    output: {
      schema: { type: 'object', additionalProperties: true },
      render(args, value) {
        return [{ type: 'text', text: JSON.stringify(value, null, 2) }]
      },
    },
    timeoutMs: 180_000,
    isConcurrencySafe(args) {
      return args !== null && typeof args === 'object' && (args.action === 'status' || args.action === 'list')
    },
    async execute(args, exec) {
      const sessionId = exec.agent === undefined ? undefined : exec.agent.id
      if (typeof sessionId !== 'string' || sessionId === '') {
        throw new Error('git_branch requires a session context')
      }
      const body = args !== null && typeof args === 'object' ? args : {}
      const signal = exec.signal
      switch (body.action) {
        case 'status':
          return readRepoState(ctx, sessionId, signal)
        case 'list': {
          const state = await readRepoState(ctx, sessionId, signal)
          return Object.assign({ repo: state }, await readBranches(state.repoRoot, signal))
        }
        case 'switch': {
          const state = await readRepoState(ctx, sessionId, signal)
          if (typeof body.branch !== 'string' || body.branch === '') throw new Error('branch is required for switch')
          return API.switch(ctx, { sessionId, branch: body.branch, expectHead: state.head, confirmed: true }, signal)
        }
        case 'create': {
          const state = await readRepoState(ctx, sessionId, signal)
          if (typeof body.name !== 'string' || body.name === '') throw new Error('name is required for create')
          return API.create(ctx, {
            sessionId,
            name: body.name,
            from: typeof body.from === 'string' ? body.from : '',
            expectHead: state.head,
            confirmed: true,
          }, signal)
        }
        case 'merge': {
          if (typeof body.source !== 'string' || body.source === '') throw new Error('source is required for merge')
          const preview = await previewMerge(ctx, { sessionId, source: body.source, mode: body.mode }, signal)
          return applyMerge(ctx, { sessionId, confirmToken: preview.confirmToken, confirmed: true }, signal)
        }
        case 'abort_merge':
          return abortMerge(ctx, { sessionId }, signal)
        case 'complete_merge':
          return completeMerge(ctx, { sessionId }, signal)
        case 'resolve_conflict':
          if (typeof body.path !== 'string' || body.path === '') throw new Error('path is required for resolve_conflict')
          return resolveConflict(ctx, { sessionId, path: body.path }, signal)
        default:
          throw new Error(`unknown action: ${String(body.action)}`)
      }
    },
  }
}

/** Register the tool when this deployment exposes a tool registry. */
function registerTool(ctx) {
  try {
    ctx.inject(['tools'], (toolCtx) => {
      toolCtx.effect(() => {
        const tools = toolCtx.get('tools')
        if (tools === undefined || tools === null || typeof tools.register !== 'function') return undefined
        return tools.register(toolDefinition(ctx))
      }, 'dsh-git-dock: git_branch tool')
    })
  } catch (error) {
    console.warn('[dsh-git-dock] tool registration failed', error)
  }
}

/** Per-repository write queue: one mutating git command at a time. */
const writeChains = new Map()

/**
 * Run `operation` after every earlier write for the same repository settled.
 *
 * @template T
 * @param {string} key - repository root.
 * @param {() => Promise<T>} operation - work to serialize.
 * @returns {Promise<T>} the operation's value.
 */
function withRepoLock(key, operation) {
  const previous = writeChains.get(key) ?? Promise.resolve()
  const run = previous.then(operation, operation)
  const guard = run.then(() => undefined, () => undefined)
  writeChains.set(key, guard)
  void guard.then(() => {
    if (writeChains.get(key) === guard) writeChains.delete(key)
  })
  return run
}

/** Verify that the client's known HEAD still matches the repository. */
function assertFreshHead(state, expectHead) {
  if (typeof expectHead === 'string' && expectHead !== '' && state.head !== expectHead) {
    throw new ApiError('stale', 'the repository changed since the panel was opened', 409, { state })
  }
}

/** Refuse a mutation while the session's turn is open, unless confirmed. */
function assertNotBusy(state, confirmed) {
  if (state.running === true && confirmed !== true) {
    throw new ApiError('running', 'the session is running; the change needs explicit confirmation', 409, { state })
  }
  if (state.operation !== 'none') {
    throw new ApiError('operation-in-progress', `a ${state.operation} is in progress; finish or abort it first`, 409, {
      operation: state.operation,
    })
  }
}

/** Require an existing local branch. */
async function assertLocalBranch(repoRoot, branch, signal) {
  try {
    assertSafeRef(branch)
  } catch {
    throw new ApiError('unknown-branch', `local branch not found: ${branch}`, 404)
  }
  try {
    await runGit(repoRoot, ['rev-parse', '--verify', '--quiet', `refs/heads/${branch}`], { signal })
  } catch {
    throw new ApiError('unknown-branch', `local branch not found: ${branch}`, 404)
  }
}

/** Validate a name as a well-formed branch. */
async function assertBranchName(repoRoot, branch, signal) {
  try {
    assertSafeRef(branch)
  } catch {
    throw new ApiError('invalid-name', `invalid branch name: ${branch}`, 400)
  }
  try {
    await runGit(repoRoot, ['check-ref-format', '--branch', branch], { signal })
  } catch {
    throw new ApiError('invalid-name', `invalid branch name: ${branch}`, 400)
  }
}

/** Resolve the repository root for a session without reading the whole state. */
async function resolveRepoRoot(ctx, sessionId, signal) {
  const active = sessionId === undefined || sessionId === null ? undefined : activeRepoBySession.get(sessionId)
  if (typeof active === 'string' && active !== '') {
    try {
      return await gitText(active, ['rev-parse', '--show-toplevel'], { signal })
    } catch {
      // The registered repository moved or disappeared: fall back to the session cwd.
      activeRepoBySession.delete(sessionId)
    }
  }
  const { cwd } = resolveSessionCwd(ctx, sessionId)
  try {
    return await gitText(cwd, ['rev-parse', '--show-toplevel'], { signal })
  } catch (error) {
    if (error instanceof ApiError && error.code === 'not-repo') {
      throw new ApiError('not-repo', 'session directory is not a git repository', 409, { cwd })
    }
    throw error
  }
}

/** API method table. */
const API = {
  /** Current repository state for one session. */
  async repo(ctx, body, signal) {
    return { repo: await readRepoState(ctx, body.sessionId, signal) }
  },

  /** Local branches, remote branches and tags with row metadata. */
  async branches(ctx, body, signal) {
    const state = await readRepoState(ctx, body.sessionId, signal)
    return Object.assign({ repo: state }, await readRefs(state.repoRoot, signal))
  },

  /** Change list: the working tree, or this branch against a base. */
  async changes(ctx, body, signal) {
    return readChanges(ctx, body, signal)
  },

  /** One file's comparison. */
  async diff(ctx, body, signal) {
    return readDiff(ctx, body, signal)
  },

  /** Preflight a merge without touching the working tree. */
  async 'merge.preview'(ctx, body, signal) {
    return previewMerge(ctx, body, signal)
  },

  /** Perform the merge the preview confirmed. */
  async 'merge.apply'(ctx, body, signal) {
    return applyMerge(ctx, body, signal)
  },

  /** Abort an in-progress merge. */
  async 'merge.abort'(ctx, body, signal) {
    return abortMerge(ctx, body, signal)
  },

  /** Commit an in-progress merge whose conflicts are all resolved. */
  async 'merge.complete'(ctx, body, signal) {
    return completeMerge(ctx, body, signal)
  },

  /** Mark one conflicted path resolved. */
  async 'merge.resolve'(ctx, body, signal) {
    return resolveConflict(ctx, body, signal)
  },

  /** Ask the live model to resolve and stage every remaining conflict. */
  async 'merge.assist'(ctx, body, signal) {
    return notifyAgentResolveConflicts(ctx, body, signal)
  },

  /** Check out a local branch, remote branch, tag, or commit. */
  async checkout(ctx, body, signal) {
    return checkoutRef(ctx, body, signal)
  },

  /** Stage paths (or everything). */
  async stage(ctx, body, signal) {
    return stagePaths(ctx, body, signal)
  },

  /** Unstage paths (or everything). */
  async unstage(ctx, body, signal) {
    return unstagePaths(ctx, body, signal)
  },

  /** Stage a selected subset of one file's changes. */
  async stagePatch(ctx, body, signal) {
    return applyPatch(ctx, Object.assign({}, body, { direction: 'stage' }), signal)
  },

  /** Unstage a selected subset of one file's staged changes. */
  async unstagePatch(ctx, body, signal) {
    return applyPatch(ctx, Object.assign({}, body, { direction: 'unstage' }), signal)
  },

  /** Four versions of every conflicted file for the three-way editor. */
  async conflictInfo(ctx, body, signal) {
    return readConflictInfo(ctx, body, signal)
  },

  /** Take one side of a conflict and mark it resolved. */
  async conflictAccept(ctx, body, signal) {
    return acceptConflictSide(ctx, body, signal)
  },

  /** Save an edited result for a conflict and mark it resolved. */
  async conflictSave(ctx, body, signal) {
    return saveConflictResult(ctx, body, signal)
  },

  /** Discard paths through a recoverable stash plus a backup ref. */
  async discard(ctx, body, signal) {
    return discardPaths(ctx, body, signal)
  },

  /** Undo the newest discard by applying its stash entry back. */
  async discardUndo(ctx, body, signal) {
    return undoDiscard(ctx, body, signal)
  },

  /** Commit staged changes, optionally amending the tip. */
  async commit(ctx, body, signal) {
    return commitChanges(ctx, body, signal)
  },

  /** Draft a commit message with the session's current model. */
  async commitMessage(ctx, body, signal) {
    return suggestCommitMessage(ctx, body, signal)
  },

  /** Provider/model routes (with reasoning efforts) for the commit-message picker. */
  async modelOptions(ctx, body) {
    return listModelOptions(ctx, body)
  },

  /** Reasoning efforts offered by one exact model. */
  async modelInfo(ctx, body) {
    const provider = typeof body.provider === 'string' ? body.provider.trim() : ''
    const model = typeof body.model === 'string' ? body.model.trim() : ''
    if (provider === '' || model === '') throw new ApiError('bad-request', 'provider and model are required', 400)
    const llm = ctx.get('llm')
    if (llm === undefined || llm === null) throw new ApiError('llm-unavailable', 'no LLM service is mounted', 503)
    return resolveModelEfforts(llm, provider, model)
  },

  /** The effective commit convention plus the saved override. */
  async convention(ctx, body, signal) {
    const state = await readRepoState(ctx, body.sessionId, signal)
    const profile = await detectCommitConventions(state.repoRoot, signal)
    const defaults = {
      allowedTypes: DEFAULT_COMMIT_CONVENTION.types,
      allowedScopes: [],
      scopes: [],
      scopeRequired: DEFAULT_COMMIT_CONVENTION.scopeRequired,
      language: DEFAULT_COMMIT_CONVENTION.language,
      maxLength: DEFAULT_COMMIT_CONVENTION.maxLength,
      totalMaxLength: DEFAULT_COMMIT_CONVENTION.totalMaxLength,
      vague: DEFAULT_COMMIT_CONVENTION.vague,
      sources: ['default'],
    }
    return {
      effective: conventionView(profile),
      saved: await readSavedCommitConfig(),
      defaults: conventionView(defaults),
    }
  },

  /** Save or reset the global commit convention. */
  async 'convention.save'(ctx, body, signal) {
    if (body.reset === true) {
      await clearSavedCommitConfig()
    } else {
      const raw = body.commit !== undefined && body.commit !== null ? body.commit : body
      const config = sanitizeSavedCommitConfig(raw)
      if (config === null) throw new ApiError('bad-request', 'invalid commit convention')
      await writeSavedCommitConfig(config)
    }
    const state = await readRepoState(ctx, body.sessionId, signal)
    const profile = await detectCommitConventions(state.repoRoot, signal)
    return {
      effective: conventionView(profile),
      saved: await readSavedCommitConfig(),
    }
  },

  /** Fetch all remotes. */
  async fetch(ctx, body, signal) {
    return fetchRemote(ctx, body, signal)
  },

  /** Pull the upstream, fast-forward only. */
  async pull(ctx, body, signal) {
    return pullRemote(ctx, body, signal)
  },

  /** Push the current branch. */
  async push(ctx, body, signal) {
    return pushRemote(ctx, body, signal)
  },

  /** Sync phase 1: fetch, then fast-forward or merge the upstream. */
  async syncPull(ctx, body, signal) {
    return syncPull(ctx, body, signal)
  },

  /** Sync phase 2: push, refused while conflicts or an operation remain. */
  async syncPush(ctx, body, signal) {
    return syncPush(ctx, body, signal)
  },

  /** Newest sync results (pull and push) for this repository. */
  async syncLog(ctx, body, signal) {
    const state = await readRepoState(ctx, body.sessionId, signal)
    return { entries: await readSyncLog(state.repoRoot) }
  },

  /** Switch the working tree to an existing local branch. */
  async switch(ctx, body, signal) {
    const repoRoot = await resolveRepoRoot(ctx, body.sessionId, signal)
    return withRepoLock(repoRoot, async () => {
      const before = await readRepoState(ctx, body.sessionId, signal)
      assertFreshHead(before, body.expectHead)
      assertNotBusy(before, body.confirmed)
      await assertLocalBranch(before.repoRoot, body.branch, signal)
      let backup = null
      if (before.branch !== body.branch || before.detached === true) {
        backup = await backupHead(before.repoRoot, `pre-switch-${body.branch}`, signal)
        await runGit(before.repoRoot, ['switch', '--no-guess', '--end-of-options', body.branch], {
          signal,
          timeoutMs: WRITE_TIMEOUT_MS,
        })
      }
      const after = await readRepoState(ctx, body.sessionId, signal)
      return { repo: after, previousBranch: before.detached === true ? null : before.branch, backup }
    })
  },

  /** Create a branch at a start point and switch to it. */
  async create(ctx, body, signal) {
    const repoRoot = await resolveRepoRoot(ctx, body.sessionId, signal)
    return withRepoLock(repoRoot, async () => {
      const before = await readRepoState(ctx, body.sessionId, signal)
      assertFreshHead(before, body.expectHead)
      assertNotBusy(before, body.confirmed)
      await assertBranchName(before.repoRoot, body.name, signal)
      const from = typeof body.from === 'string' && body.from !== '' ? body.from : null
      if (from !== null) {
        assertSafeRef(from)
        try {
          await runGit(before.repoRoot, ['rev-parse', '--verify', '--quiet', `${from}^{commit}`], { signal })
        } catch {
          throw new ApiError('unknown-ref', `start point not found: ${from}`, 404)
        }
      }
      const exists = await runGit(before.repoRoot, ['show-ref', '--verify', '--quiet', `refs/heads/${body.name}`], { signal })
        .then(() => true, () => false)
      if (exists) throw new ApiError('branch-exists', `branch already exists: ${body.name}`, 409)
      const args = ['switch', '-c', body.name]
      if (from !== null) args.push(from)
      await runGit(before.repoRoot, args, { signal, timeoutMs: WRITE_TIMEOUT_MS })
      const after = await readRepoState(ctx, body.sessionId, signal)
      return { repo: after, branches: await readBranches(after.repoRoot, signal) }
    })
  },

  // ── A4: history, branches, stash, tags, revert/reset ─────────────────────

  /** Commit list, optionally narrowed to one path. */
  async history(ctx, body, signal) {
    return readHistory(ctx, body, signal)
  },

  /** One commit with its files and an optional single-file diff. */
  async commitDetail(ctx, body, signal) {
    return readCommitDetail(ctx, body, signal)
  },

  /** Divergence, one-sided commits and file changes between two refs. */
  async compare(ctx, body, signal) {
    return compareRefs(ctx, body, signal)
  },

  /** Rename a local branch. */
  async branchRename(ctx, body, signal) {
    return renameBranchOp(ctx, body, signal)
  },

  /** Delete a local branch (`force` requires `confirmed`). */
  async branchDelete(ctx, body, signal) {
    return deleteBranchOp(ctx, body, signal)
  },

  /** Rebase the current branch onto another ref. */
  async rebase(ctx, body, signal) {
    return rebaseOnto(ctx, body, signal)
  },

  /** Cherry-pick commits onto the current branch. */
  async cherryPick(ctx, body, signal) {
    return cherryPickCommit(ctx, body, signal)
  },

  /** Continue an interrupted rebase / cherry-pick / revert. */
  async sequenceContinue(ctx, body, signal) {
    return continueSequence(ctx, body, signal)
  },

  /** Abort an interrupted rebase / cherry-pick / revert. */
  async sequenceAbort(ctx, body, signal) {
    return abortSequence(ctx, body, signal)
  },

  /** List tags. */
  async tagList(ctx, body, signal) {
    return listTags(ctx, body, signal)
  },

  /** Create a tag (annotated when a message is given). */
  async tagCreate(ctx, body, signal) {
    return createTag(ctx, body, signal)
  },

  /** Delete a tag. */
  async tagDelete(ctx, body, signal) {
    return deleteTag(ctx, body, signal)
  },

  /** List stash entries. */
  async stashList(ctx, body, signal) {
    return listStash(ctx, body, signal)
  },

  /** Save current changes into a stash. */
  async stashSave(ctx, body, signal) {
    return stashSave(ctx, body, signal)
  },

  /** Apply or pop one stash entry. */
  async stashApply(ctx, body, signal) {
    return stashApply(ctx, body, signal)
  },

  /** Drop one stash entry. */
  async stashDrop(ctx, body, signal) {
    return stashDrop(ctx, body, signal)
  },

  /** Revert one commit. */
  async revert(ctx, body, signal) {
    return revertCommitOp(ctx, body, signal)
  },

  /** Reset HEAD to a commit; hard reset needs confirmation. */
  async reset(ctx, body, signal) {
    return resetTo(ctx, body, signal)
  },

  // ── A1: repository registry ─────────────────────────────────────────────

  /** Registered repositories plus which one this session is using. */
  async repositoryList(ctx, body) {
    return { repositories: await listRepositories(body.sessionId) }
  },

  /** Register one repository path and make it active for this session. */
  async repositoryAdd(ctx, body, signal) {
    return addRepository(body.sessionId, body.path, signal)
  },

  /** Switch the session's active repository (registry id or a path). */
  async repositorySelect(ctx, body, signal) {
    const selected = await selectRepository(body.sessionId, body.repositoryId ?? body.path, signal)
    return Object.assign({}, selected, { repo: await readRepoState(ctx, body.sessionId, signal) })
  },

  /** Remove one registry entry; the directory itself is never touched. */
  async repositoryRemove(ctx, body) {
    if (typeof body.repositoryId !== 'string' || body.repositoryId === '') {
      throw new ApiError('bad-request', 'repositoryId is required', 400)
    }
    return removeRepository(body.sessionId, body.repositoryId)
  },

  /** Check one path without registering it. */
  async repositoryValidate(ctx, body, signal) {
    try {
      const validated = await validateRepositoryPath(body.path, signal)
      return { valid: true, id: validated.id, path: validated.path }
    } catch (error) {
      if (error instanceof ApiError) return { valid: false, code: error.code, message: error.message }
      throw error
    }
  },

  /** Configured remotes of the session's repository. */
  async repositoryRemotes(ctx, body, signal) {
    const state = await readRepoState(ctx, body.sessionId, signal)
    return { remotes: await readRemotes(state.repoRoot, signal) }
  },

  /** Drop the registry override and go back to the session's own directory. */
  async repositorySession(ctx, body, signal) {
    activeRepoBySession.delete(body.sessionId)
    return { repo: await readRepoState(ctx, body.sessionId, signal), repositories: await listRepositories(body.sessionId) }
  },
}

/**
 * Fence one incoming request through the shared browser-trust check.
 *
 * @param {import('@deepseek-ai/cordis').Context} ctx - plugin context.
 * @param {import('node:http').IncomingMessage} req - incoming request.
 * @returns {boolean} whether the request may proceed.
 */
function fence(ctx, req) {
  const connection = ctx.get('connection')
  if (connection === undefined || connection === null) return false
  try {
    if (typeof connection.requestRejection === 'function') {
      return connection.requestRejection(req) === undefined
    }
    if (typeof connection.admit === 'function') {
      const verdict = connection.admit(req)
      return !(verdict !== null && typeof verdict === 'object' && 'rejection' in verdict)
    }
  } catch {
    return false
  }
  return false
}

/**
 * Route handler for the whole API prefix.
 *
 * @param {import('@deepseek-ai/cordis').Context} ctx - plugin context.
 * @param {import('node:http').IncomingMessage} req - incoming request.
 * @param {import('node:http').ServerResponse} res - response.
 */
async function handleApi(ctx, req, res) {
  const requestId = randomUUID()
  if ((req.method ?? 'GET').toUpperCase() !== 'POST') {
    sendError(res, new ApiError('method-error', 'method not allowed', 405), requestId)
    return
  }
  if (!fence(ctx, req)) {
    sendError(res, new ApiError('forbidden', 'forbidden', 403), requestId)
    return
  }
  const pathname = new URL(req.url ?? '/', 'http://dsh.internal').pathname
  const method = pathname.startsWith(`${ROUTE_PREFIX}/`) ? pathname.slice(ROUTE_PREFIX.length + 1) : ''
  if (method === '' || method.includes('/')) {
    sendError(res, new ApiError('not-found', 'unknown api method', 404), requestId)
    return
  }
  const handler = Object.hasOwn(API, method) ? API[method] : undefined
  if (typeof handler !== 'function') {
    sendError(res, new ApiError('not-found', `unknown api method: ${method}`, 404), requestId)
    return
  }
  const controller = new AbortController()
  const abort = () => controller.abort()
  res.once('close', abort)
  try {
    const body = await readJsonBody(req)
    const value = await handler(ctx, body, controller.signal)
    if (!controller.signal.aborted) sendJson(res, 200, { ok: true, value, requestId })
  } catch (error) {
    if (!controller.signal.aborted) sendError(res, error, requestId)
  } finally {
    res.off('close', abort)
  }
}

/**
 * Plugin entry: register the fenced API route when a web carrier exists.
 *
 * @param {import('@deepseek-ai/cordis').Context} ctx - plugin context.
 */
export function apply(ctx) {
  try {
    ctx.inject(['webServer'], (webCtx) => {
      webCtx.effect(() => webCtx.webServer.register({
        kind: 'prefix',
        path: ROUTE_PREFIX,
        handler: (req, res) => {
          void handleApi(ctx, req, res)
        },
      }), 'dsh-git-dock: api routes')
    })
  } catch {
    // Profiles without a web carrier keep the plugin loaded and idle.
  }
  registerTool(ctx)
}
