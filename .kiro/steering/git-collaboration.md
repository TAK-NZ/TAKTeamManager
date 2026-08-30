---
inclusion: always
---

# Shared branches, parallel agents

This repo's branches are commonly worked on by more than one agent session
at the same time (a human, another Kiro session, or a background task),
not just the session currently reading this file. Working-tree state is
shared, not sandboxed per agent.

## `git stash` requires explicit human authorization, every time

Never run `git stash`, `git stash pop`, `git stash apply`, or `git stash
drop` without the user explicitly telling you to do so in that exact
turn. This is enforced by an `ask` rule in
`.kiro/settings/permissions.yaml` (`git stash*`), but do not treat "the
permission prompt will catch it" as a reason to reach for stash instead
of a safer alternative — prefer to just not attempt it.

This repo has already lost in-progress work once this way: an agent
stashed to test a hypothesis, and a concurrent session's edits were
clobbered as a result (see the `bch-category-vs-region-tiers` incident
referenced in past session summaries). A stash silently reshuffles
EVERY unstaged/uncommitted file in the tree, not just the ones the
current task touched — there is no way to stash "only my changes" when
another agent's edits sit alongside yours with no distinguishing marker.

**Use instead**, all of which are read-only and safe to run without asking:

- `git diff <path>` / `git diff --stat` — see what changed and where,
  including changes you didn't make this session.
- `git log --oneline -n 20` / `git show <ref>` — inspect history.
- `git status --short` — see what's modified/staged/untracked right now.
- `git stash list` — check whether a stash already exists (read-only,
  fine to run any time).

If you need to test code against a *clean* tree (e.g. to check whether a
test failure pre-exists your changes), do not clean the tree to find
out. Instead: read the diff for the file(s) in question and reason about
whether your changes could plausibly cause the failure, or ask the user
directly. A local clone/worktree (`git worktree add`) is a legitimate
sandboxed alternative to stashing if you truly need a clean checkout —
but that too should be proposed to the user first, not done unasked,
since `git worktree add` still touches shared repo metadata
(`.git/worktrees/`).

## Other commands to treat the same way

The same reasoning applies to anything that rewrites or discards
working-tree/index state rather than just reading it, even where no
`permissions.yaml` rule exists yet to force the prompt:

- `git checkout -- <path>` / `git restore <path>` (discards edits)
- `git reset --hard` / `git reset --mixed`
- `git clean -f` / `git clean -fd`
- `git branch -D`, force-push (`git push --force`)

These are already covered by this workspace's git safety rules
(non-destructive by default, explicit permission for destructive ops).
The stash-specific callout above exists because stash is easy to reach
for as a "harmless, reversible" diagnostic shortcut — it is not harmless
on a branch someone else may be actively editing.
