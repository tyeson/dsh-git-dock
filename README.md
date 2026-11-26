# dsh-git-dock

[![DSH](https://img.shields.io/badge/DSH-%E2%89%A50.2.2--rc.3-4d6bfe)](https://github.com/tyeson/dsh-git-dock)

A Qoder-style Git branch entry docked under the DSH composer: switch branches,
create branches, review and compare changes, commit, merge and sync — without
leaving the conversation.

Repository: <https://github.com/tyeson/dsh-git-dock>

> Status: **P3–P5 complete** — the Qoder-style surface: a ref picker for local
> branches, remote branches and tags; change review with unified/side-by-side
> comparisons; staging, discard, commit/amend and model-drafted commit messages;
> fetch/push/sync; merge with conflict handling (one click asks the live model to
> resolve and stage the conflicts; commit and push stay manual); and the
> `git_branch` tool. Commit-message drafting has its own model/effort picker
> (defaults to the conversation's choice, remembers the last one). Double-click a
> changed file for a full-screen, syntax-highlighted side-by-side preview with
> keyboard file switching.

## Install

The package is a DSH bundle distributed from GitHub (no npm release).

From GitHub:

```powershell
dsh plugin --profile desktop add github:tyeson/dsh-git-dock
```

or in the GUI: **Plugins → Add plugin** and enter
`github:tyeson/dsh-git-dock`.

From a local checkout:

```text
Plugins → Add plugin → pick this directory
```

or, with the manager tool available:

```text
plugin_manager install_bundle  target: <path to this directory>
```

Refresh the page afterwards. The chip appears at the left of the line under the
composer card. Open the review tab from the branch panel's list button, or from
the right sidebar's guide page (*Git changes*).

## Layout

```text
index.js              Host half: git runner, session→cwd resolution, fenced API
client.js             Browser half: composer-dock chip + shell.overlay panel
cordis.patch.yml      Bundle patch (one Host row)
locale/{en,zh}.json   Plugin manager metadata
docs/DETAIL.md        Bundle detail document
icon.svg              Plugin icon
test/smoke.mjs        Host-half smoke test (npm test)
```

## Wire contract

`POST /plugins/dsh-git-dock/api/<method>`, JSON in and out, behind
`ctx.connection.requestRejection`. Success is `{ ok: true, value }`; failure is
`{ ok: false, error: { code, message, details? } }`.

| Method | Body | Value |
|---|---|---|
| `repo` | `{ sessionId }` | `{ repo }` — branch, HEAD, upstream, ahead/behind, operation, changes, running |
| `branches` | `{ sessionId }` | `{ repo, local[], remote[] }` |
| `switch` | `{ sessionId, branch, expectHead, confirmed? }` | `{ repo, previousBranch }` |
| `create` | `{ sessionId, name, from?, expectHead }` | `{ repo, branches }` |
| `changes` | `{ sessionId, scope: 'worktree'\|'branch', base? }` | `{ scope, base, baseCandidates, commits, files[], truncated, repo }` |
| `diff` | `{ sessionId, scope, base?, path, untracked? }` | `{ path, scope, binary, hunks[], truncated }` |
| `merge.preview` | `{ sessionId, source, mode? }` | `{ source, mode, kind, files[], fileCount, additions, deletions, conflicts[], confirmToken, repo }` |
| `merge.apply` | `{ sessionId, confirmToken, confirmed? }` | `{ status, source, mode, conflicts[], backup, repo }` |
| `merge.abort` | `{ sessionId }` | `{ repo }` |
| `merge.complete` | `{ sessionId }` | `{ repo }` |
| `merge.resolve` | `{ sessionId, path }` | `{ repo, conflicts[] }` |
| `checkout` | `{ sessionId, target: {kind:'local'\|'remote'\|'tag'\|'commit', name}, expectHead, confirmed? }` | `{ repo, previousBranch, backup }` |
| `stage` / `unstage` | `{ sessionId, paths?, all? }` | `{ repo }` |
| `discard` | `{ sessionId, paths }` | `{ repo, backup, stashed, message }` |
| `commit` | `{ sessionId, message, amend? }` | `{ repo, commit: {sha, subject, amend} }` |
| `commitMessage` | `{ sessionId, language? }` | `{ message, provider, model, conventions: {style, language, maxLength, types, scopes, sources, summary} }` |
| `fetch` / `pull` / `push` | `{ sessionId, setUpstream? }` | `{ repo, setUpstream? }` |

Error codes the UI localizes: `not-repo`, `git-missing`, `session-not-found`,
`no-cwd`, `timeout`, `stale`, `running`, `operation-in-progress`,
`unknown-branch`, `branch-exists`, `invalid-name`, `unknown-ref`, `forbidden`,
`bad-request`, `too-large`, `git-error`, `internal`.

## Design decisions

- **HTTP routes, not generated Remotes.** A third-party package has no Typert
  code-generation step; same-origin `fetch` behind the browser-trust fence is the
  pattern the installed community plugins use.
- **The Host resolves the path.** `sessionId` is the only location input; the
  working directory comes from `ctx.workingDirectory` with the session header as
  fallback. No client-supplied paths reach `git`.
- **`spawn` with an argument vector.** No shell, `GIT_OPTIONAL_LOCKS=0`,
  `GIT_TERMINAL_PROMPT=0`, bounded output, per-command timeout and abort signal.
- **Serialize writes per repository.** Reads may overlap; `switch`/`create` go
  through a per-root promise chain.
- **`expectHead` + `confirmed`.** Optimistic concurrency and the running-session
  confirmation are enforced on the Host for both switching and creating, not
  only in the UI.
- **No session events.** The plugin is a derived view: it never appends to the
  session log and keeps no durable state of its own.

## Roadmap

| Stage | Scope | State |
|---|---|---|
| P0 | Dock chip, branch list/filter, switch, create, dirty & running guards, zh/en, icon | delivered |
| P1 | Right-sidebar review tab: working-tree changes, branch-vs-base changes, unified/side-by-side comparison | delivered |
| P2 | Merge (`--no-ff` / `--ff-only` / `--squash`), conflict state, backup refs, agent tool | delivered |
| P3 | Ref picker: tags, remote-branch checkout as tracking branch, detached checkout, author/hash metadata, create-from-ref | delivered |
| P4 | Stage/unstage, discard (recoverable stash), commit/amend (amend blocked after push), model-drafted commit message | delivered |
| P5 | Fetch, push (never forced, upstream setup), commit-and-push / sync (fetch + ff-only pull + push) | delivered |

## Model tool

When the deployment exposes a tool registry the plugin registers `git_branch`
(global; it acts on the calling Agent's session). One tool, one action field:

| action | arguments | result |
|---|---|---|
| `status` | — | branch, HEAD, upstream divergence, in-progress operation, change counts |
| `list` | — | status plus local and remote branches |
| `switch` | `branch` | the branch is checked out |
| `create` | `name`, `from?` | branch created and checked out |
| `merge` | `source`, `mode?` | preflight + apply; conflicts are reported, not resolved |
| `abort_merge` / `complete_merge` | — | settle an open conflicted merge |
| `resolve_conflict` | `path` | `git add` one conflicted path |

The tool calls the same Host operations as the UI; the approval pipeline is the
safety boundary, and mutating actions still refuse while another merge/rebase is
in progress.

## Repo commit conventions

`commitMessage` detects the repository's convention before asking the model, so
the draft needs no hand-fixing. The **built-in default** (used when the
repository declares nothing else) is:

- format: `type(scope): 中文描述`
- types: `feat`, `fix`, `docs`, `style`, `refactor`, `perf`, `test`, `build`, `ci`,
  `chore`, `revert`
- scope: **required**, English lowercase or kebab-case module name
- description: Chinese, concise, only about the staged changes
- never vague: `update`, `fix bugs`, `misc changes`, `cleanup`, …
- no subject-length limit by default (a repository commitlint may set one)
- total message ≤ 500 characters; when a change set needs detail, the subject
  stays alone on the first line, then one blank line, then `- ` bullet lines

Detection adds to that default (#3 wins over #2, and a repository's own
`.dsh-git-dock.json` wins over everything):

1. **History** — the last 40 subjects provide the types/scopes actually used and
   four real examples; only a sizeable (≥10) uniformly English history switches
   the description language to English.
2. **Configuration** — `commitlint.config.{js,cjs,mjs}`, `.commitlintrc{,.json,.yml,.yaml,.js}`,
   `.gitlint`, `.czrc`/`.cz-config.js`, `package.json` `commitlint`, and the
   `commit.template` configured in `.git/config`.
3. **Saved convention** — the *Convention* button next to **Amend** opens an
   editor for types, scope requirement, description language, subject limit,
   total limit and vague words. **Save** persists it for every session
   (`<DSH_HOME>/dsh-git-dock/commit-convention.json`); **Reset** removes it.
   Closing the editor without saving leaves the effective convention untouched,
   so generation keeps using the saved value or the default.
4. **Per-repository override** — `.dsh-git-dock.json`:

   ```json
   { "commit": { "types": ["feat", "fix"], "scopes": ["api"], "language": "zh", "maxLength": 72, "totalMaxLength": 500, "scopeRequired": true } }
   ```

The rules are sent with the staged diff (bounded to 16 KB). A draft that breaks
them (missing/ill-formed scope, unknown type, non-Chinese description, vague
wording, a non-bulleted body, over the subject or total limit, or a trailing
period) is retried once with the specific violations; a final fallback trims the
subject, drops trailing bullets and enforces the total cap. The model used is
the session's currently selected model, and the message stays editable. The
same total cap is enforced when committing, so an over-long manual message is
refused with `message-too-long`.

## Development

- Plain ESM/CommonJS-shaped JS; no build step. `npm run check` validates the
  syntax and `npm test` runs the Host-half smoke test (`test/smoke.mjs`) against
  real temporary repositories; it needs `git` on `PATH` and touches no user
  repository or the real `DSH_HOME`.
- **Host changes need an app restart.** The Host half is loaded once per
  process; the browser half is reloaded by a page refresh.
- The browser half must not `require` Harness client packages: it renders its
  own controls with `--dsw-alias-*` theme tokens.
- Verify after install by refreshing the page and checking that the chip
  reflects `git status` for the session's directory, that switching updates the
  chip and the working tree, and that the chip disappears outside a repository.
