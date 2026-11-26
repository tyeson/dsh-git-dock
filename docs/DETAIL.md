# Git branch dock

A Git entry docked under the composer card, next to the workspace and context
usage line. It shows the session's current branch and opens a panel for
switching and creating branches.

## What it does

- **Current state at a glance** — branch name (or `detached HEAD`), ahead/behind
  counts against the upstream, a warning dot plus the changed-file count, and an
  in-progress merge/rebase badge in the chip's tooltip.
- **Switch branches** — the panel groups local branches (current first, then by
  most recent commit), remote branches and tags, with a filter box; a row shows
  author, short hash and relative time. Remote checkout creates a local tracking
  branch.
- **Create a branch** — pick a name and an optional start point (defaults to the
  current `HEAD`); the new branch is checked out immediately.
- **Review changes** — a native right-sidebar tab (also listed on the sidebar's
  guide page as *Git changes*) shows the working tree's changed files with
  `+/-` counts, or this branch against a base chosen from real refs (auto-picked
  from `origin/HEAD`, `origin/main`, `main`, `master`). Selecting a file renders
  its comparison as structured hunks: unified or side-by-side, optional line
  wrapping, binary and truncated output reported explicitly.
- **Check out anything** — the picker lists local branches, remote branches
  (with the local tracking branch created on checkout) and tags, each with
  author, short hash, subject and relative time. Checking out a tag or commit
  leaves a detached HEAD after a confirmation, and any ref can seed a new
  branch.
- **Stage, commit, amend** — the review tab stages or unstages one file or
  everything, discards paths into a recoverable `git stash` (plus a backup ref),
  and commits with a message. *Amend* is refused when `HEAD` is already
  contained in its upstream.
- **Convention-aware commit messages** — the **Draft message** button first
  applies a built-in default — `type(scope): 中文描述`, types
  `feat/fix/docs/style/refactor/perf/test/build/ci/chore/revert`, a required
  lowercase-or-kebab-case scope, a Chinese description about the staged changes
  only, no vague wording, no subject limit, total ≤500 characters — a longer
  change set becomes the subject, one blank line, then `- ` bullet lines — and
  then layers the repository's own convention on top: the last 40 commit
  subjects (types, scopes, examples), commitlint configuration
  (`commitlint.config.*`, `.commitlintrc*`, `.gitlint`, `package.json`
  `commitlint`), commitizen config, the configured `commit.template`, and an
  optional `.dsh-git-dock.json` override. A **Convention** button next to
  *Amend* edits the same settings (types, scope requirement, language, subject
  and total limits, vague words) and saves them for every session; closing it
  without saving changes nothing. Only the staged diff (bounded to 16 KB) and
  those rules go to the session's currently selected model; a draft that
  violates the rules is corrected once before it reaches the message box, and
  nothing is committed automatically. The total cap is also enforced when
  committing a hand-written message.
- **Fetch / push / sync** — fetch prunes remotes, push configures the upstream
  when missing and refuses non-fast-forward updates (never force), and *sync*
  composes commit (when a message and staged changes exist) → fetch →
  `pull --ff-only` → push. Authentication failures are reported verbatim.
- **Merge** — the review tab's **Merge** button (left of *Fetch*) picks a branch
  and merges it into the current one as `--no-ff` (default), `--ff-only`, or
  `--squash`. The branch picker in the composer dock only switches refs. A
  preflight (`git merge-tree`, no working-tree writes) reports the resulting
  kind, file and line counts, and conflicted paths before anything moves. A merge
  that conflicts stays open in the review tab: it lists the conflicted files,
  marks one resolved with `git add`, completes with `git commit --no-edit`, or
  aborts with `git merge --abort`. While conflicts remain, the **Merge** button
  becomes **Resolve conflicts**: one click wakes the live session model with the
  conflict list and asks it to merge both sides and `git add` each resolved file,
  explicitly forbidding commit, abort and push. Completing the merge and pushing
  stay manual. Commit-message drafting has its own model and reasoning-effort
  picker in the commit bar: it defaults to the conversation's current choice and
  remembers the last pick in `localStorage`, and the chosen route is sent with the
  `commitMessage` request. The draft walks the **entire** staged index (falling
  back to the working tree when nothing is staged) and lists every changed file
  sorted by path and deduplicated by final state, so re-staging one file cannot
  hide the rest; the response returns that path-sorted file list and the tab shows
  it above the commit bar for review before submitting.
- **Sync** runs as two reported phases (`syncPull` then `syncPush`): fetch, then
  fast-forward or merge the upstream, then push. Merge conflicts end the pull
  phase with the conflicted files typed by their porcelain XY code (content,
  both-added, both-deleted, added, deleted/modified, other); the tab shows a
  phase-coloured banner (amber pull, red push) with a copyable file list, a
  per-file link that opens its diff, and a **Later** action that keeps a badge
  with the unresolved count on the Sync button. Once the conflict markers are
  gone and no operation remains, the interrupted push resumes automatically.
  `syncPush` refuses while conflicts or an operation remain, and every phase
  result is appended to `<DSH_HOME>/dsh-git-dock/sync-log.json`; the tab's
  **Sync details** button reads the newest entries back. Switching continues to
  record `HEAD` under `refs/dsh/backup/…` (20 newest kept per repository).
- **Preview** — double-clicking a changed file opens a full-screen comparison
  window (side-by-side by default, unified/wrap toggles) with lightweight
  dependency-free syntax highlighting for common languages. `Esc` closes it,
  `↑/↓` or `J/K` switch between the changed files; because the list stays mounted,
  closing returns to the same scroll position.
- **Safety and layout** — discarding is confirmed and can be undone (the newest
  `dsh-git-dock discard` stash entry is reapplied), aborting a merge needs an
  explicit confirmation, and the tab groups its status (changes, sync, operation)
  into labelled chips. Buttons show hover/press/disabled feedback with inline
  spinners for loading, and a ResizeObserver switches the tab to a narrow layout
  (wrapped toolbars, shorter file list) below ~520px. All colours come from theme
  tokens or `color-mix` over them, so dark mode keeps the same contrast.
- **Upstream association** — Fetch, Pull and Sync stay disabled while the checked-out
  branch has no upstream, with a hover title explaining how to fix it; Push stays
  enabled as **Push and track** and runs `git push -u` (creating the remote branch
  when missing). The repo poll compares `upstream`, so a branch switch or a
  successful push re-enables the three buttons and clears the tooltip without a
  manual refresh. Pull and sync-pull refuse an unassociated branch on the Host side
  too, and sync reports it as a `no-upstream` pull phase.
- **Guards** — switching and creating are refused while a merge, rebase,
  cherry-pick, revert, or bisect is in progress; while the session's turn is
  open both require an explicit second confirmation; a stale panel (the
  repository moved since it opened) is refused and refreshed instead of
  overwriting newer work.

## How it works

The browser calls one same-origin route prefix,
`/plugins/dsh-git-dock/api/*`, behind the Harness browser-trust fence. The Host
resolves the working directory from the Session id — the browser never supplies
a path — runs `git` with an argument vector (no shell), bounds every command by
a timeout and an output cap, and serializes mutating commands per repository.

| Action | Git commands |
|---|---|
| read state | `rev-parse --show-toplevel`, `rev-parse --absolute-git-dir`, `status --porcelain=v2 -z --branch` |
| list branches | `for-each-ref` over `refs/heads` and `refs/remotes` |
| switch | `switch --no-guess --end-of-options <branch>` |
| create | `check-ref-format --branch`, `show-ref --verify`, `switch -c <name> [start]` |
| worktree changes | `status --porcelain=v2 -z`, `diff --numstat -z HEAD` |
| branch changes | `diff --name-status -z <base>...HEAD`, `diff --numstat -z <base>...HEAD` |
| one comparison | `diff -U3 HEAD -- <path>`; untracked files use `diff --no-index /dev/null <path>` |
| merge preflight | `merge-base`, `merge-tree --write-tree --name-only`, `diff --numstat` |
| merge | `merge --no-ff --no-edit`, `merge --ff-only`, `merge --squash` |
| conflicts | `merge --abort`, `add -- <path>`, `commit --no-edit` |
| backup | `update-ref refs/dsh/backup/<stamp>/<label> HEAD` |
| checkout | `switch --no-guess`, `switch -c <name> --track <remote>/<name>`, `switch --detach` |
| stage | `add -- <paths>` / `add -A`; `restore --staged` (fallback `reset`) |
| discard | `stash push --include-untracked -m dsh-git-dock-discard -- <paths>` |
| commit | `commit -m <message>`, `commit --amend -m <message>` |
| remote | `fetch --all --prune`, `pull --ff-only`, `push [-u <remote> <branch>]` |

A mutation carries the `HEAD` the panel displayed; a mismatch answers
`409 stale` with the fresh state, so the UI never applies a decision to a
repository it has not seen.

## Usage

Install the bundle (Plugins → Add plugin → this directory, or
`plugin_manager install_bundle`), then refresh the page. The chip appears to the
left of the composer's status line. If the session's directory is not a Git
repository, no chip is rendered.

## Limits of this version

- **Merges are never auto-resolved** — conflicts are surfaced and the user marks
  each file resolved; the plugin never edits the conflicted content itself.
- **Squash does not commit** — `--squash` leaves the changes staged; the merge
  dialog says so instead of inventing a commit message.
- **Discard is a stash, not a delete** — tracked and untracked paths specified
  for discard are stored in a `dsh-git-dock discard <timestamp>` stash, so they
  can be recovered with `git stash list` / `git stash pop`.
- **Amend is disabled after push** — when `HEAD` is contained in its upstream,
  the Host refuses the amend instead of rewriting published history.
- **Push is never forced** — non-fast-forward updates are rejected with a
  message to sync first.
- **`pull` is fast-forward only** — a diverged branch is reported, not merged;
  use the plugin's branch merge or resolve it in a terminal.
- **Suggestions are editable text** — the model drafts one line; the user edits
  and commits it. Only the staged diff (bounded to 16 KB) is sent.
- **Remote branches are read-only in the branch-vs-base picker** — the branch
  picker checks them out (as tracking branches), but the comparison base list
  only names refs.
- **No fetch/pull/push** — remote synchronisation stays out of scope.
- **Local branches only** — the panel operates on the branch checked out in the
  session's own working tree, not on other worktrees.
- **`git` must be on the Host's `PATH`** — otherwise the chip reports that Git
  is unavailable.
- **Detached `HEAD`** is shown and can be left by switching to a branch, but the
  plugin does not create commits, so it never reattaches a detached head itself.
