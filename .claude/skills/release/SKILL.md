---
name: release
description: Cut and publish a release of vno (@msareen/voice-notes-organizer) — preflight checks, git tag, npm publish, and a GitHub release with generated notes. Use this whenever the user asks to release, publish, ship, cut a version, push to npm, tag a version, or make a GitHub release, and also when they ask what's unpublished or whether npm is behind the repo. Publishing is irreversible, so this skill exists to make the pre-flight checks happen every time rather than from memory.
---

# Releasing vno

`vno` ships to users through **npm**, not through GitHub. A GitHub release is
the changelog and the human-readable record; `npm publish` is the part that
actually puts new code on people's machines. A release that tags but doesn't
publish looks complete and delivers nothing. That has happened here before —
versions bumped in `package.json`, committed, and never pushed to the registry —
so "is npm actually current?" is the first question to answer, not an
afterthought.

## The one rule

**Never run `npm publish` or `gh release create` without the user explicitly
confirming that specific version, in this conversation.** Bumping a version
number is routine and often happens as part of ordinary code changes; deciding
that the world should get it is a separate, deliberate call that belongs to the
user. npm's unpublish window is 72 hours and republishing the same version
number is permanently forbidden, so a mistaken publish can't be cleanly undone —
it can only be superseded by another version.

Everything before the publish step is safe and reversible. Do that work
proactively, present what you found, and stop for a yes.

## Step 1 — Establish what a release would even mean right now

Three numbers matter, and they drift apart:

```bash
node -p "require('./package.json').version"   # what the repo thinks it is
npm view @msareen/voice-notes-organizer version   # what users actually get
git tag --list "v*" --sort=-v:refname | head -5   # what's been marked
```

Then look at what's changed since the last published version:

```bash
LAST=$(git tag --list 'v*' --sort=-v:refname | head -1)
[ -n "$LAST" ] && git log --oneline "$LAST"..HEAD || git log --oneline -20
```

The guard matters because this repo currently has no tags at all, and
`git log ..HEAD` with an empty left side is an error, not an empty list.

Report the gap plainly before proposing anything. A sentence like "package.json
says 0.8.2, npm has 0.8.0, no tags exist, 9 commits since" tells the user what
decision they're actually making. If the repo version is already ahead of npm and the user is
happy with it, that version *is* the release — don't bump again on top of it,
or you'll skip a number for no reason.

## Step 2 — Decide the version (only if it needs deciding)

Skip this entirely when package.json already holds an unpublished version the
user wants to ship. Otherwise pick from what the commits actually did — this is
a CLI people depend on, and `^0.8.0` in someone's dependencies means a minor
bump reaches them automatically:

| Change | Bump |
| --- | --- |
| Bug fix, doc change, internal refactor | patch |
| New command, new flag, new UI capability | minor |
| Removed/renamed a command or flag, changed a config key's meaning, changed where files land | major |

```bash
npm version patch --no-git-tag-version   # or minor / major
```

`--no-git-tag-version` keeps the bump as a plain file edit, so it can go in a
normal commit alongside the code it describes. The tag gets created in step 5,
after the checks have passed — tagging first would mean either an untested tag
or a tag you have to move.

Version lives in `package.json` only. `bin/vno.js` reads it at runtime, so
there's nothing else to keep in sync — don't go looking for a constant to edit.

## Step 3 — Preflight

These are quick, and each one has actually broken a release somewhere:

```bash
git status --short                    # must be clean
git rev-parse --abbrev-ref HEAD       # expect main
git fetch && git status -sb | head -1 # expect no divergence from origin
npm whoami                            # expect msareen
gh auth status                        # expect logged in
```

A dirty tree matters more here than in most projects: **`npm pack` packs the
working tree, not the git index.** Uncommitted edits — and uncommitted
*deletions* — go into the tarball exactly as they sit on disk. That's the same
mechanism behind the line-ending check below.

## Step 4 — Verify what will actually ship

There's no build, no test suite and no lint here (see CLAUDE.md), so the
tarball itself is the artifact to inspect. Three things are worth confirming,
and the third is the one that has historically shipped broken:

```bash
npm pack --dry-run --json | node -e "
  const f = JSON.parse(require('fs').readFileSync(0))[0].files.map(x => x.path);
  const want = ['bin/vno.js','src/web/assets/sw.js','src/web/assets/app.js','src/web/page.js'];
  want.forEach(w => console.log((f.includes(w) ? 'ok   ' : 'MISSING ') + w));
  console.log(f.length + ' files total');
"
```

**1. New files are included.** `files` in package.json ships `bin/`, `src/` and
`docs/` wholesale, so new modules are usually picked up for free — but a new
top-level directory would not be, and would vanish silently.

**2. The CLI runs from a clean checkout's perspective:**

```bash
node bin/vno.js --version
node bin/vno.js setup --check
```

`prepublishOnly` already runs the first of these, so a broken entry point fails
the publish rather than shipping. Running it yourself first just means finding
out before the irreversible step.

**3. No CRLF has crept into the shipped source.** This is the load-bearing one:

```bash
npm pack --dry-run --json 2>/dev/null | node -e "
  const fs = require('fs');
  const files = JSON.parse(fs.readFileSync(0))[0].files.map(x => x.path);
  const crlf = files.filter(p => /\.(js|json|md|html|css)$/.test(p) && fs.readFileSync(p).includes(13));
  const fatal = crlf.filter(p => p.startsWith('bin/'));
  if (fatal.length) console.log('BLOCKING — CRLF in an executable:\n  ' + fatal.join('\n  '));
  if (crlf.length) console.log('CRLF present in ' + crlf.length + ' packed file(s):\n  ' + crlf.join('\n  '));
  if (!crlf.length) console.log('LF ok');
"
```

Anything under `bin/` is **blocking**: a `#!/usr/bin/env node\r` shebang makes
every Linux and macOS install fail with `env: 'node\r': No such file or
directory`, while Windows keeps working perfectly — so it passes local testing
and breaks for everyone else. CRLF elsewhere isn't fatal (Node parses CRLF
fine) but is against the repo's own policy and means something is
reintroducing it, so fix it before shipping.

The usual advice for this is `git rm --cached -r . && git reset --hard`. **Don't
use it** — `reset --hard` destroys any uncommitted work in the tree, and you are
by definition running this during a release, when losing an unstaged fix is
expensive. Two safe options instead:

```bash
git ls-files --eol | grep 'w/crlf'   # see exactly which files are affected
git checkout -- <those files>        # index already holds LF, so this restores LF
git add --renormalize .              # if the index itself holds CRLF; then commit
```

`git checkout --` is the fix when only the working tree drifted (index `i/lf`,
worktree `w/crlf`), which is the common case. `--renormalize` is for when CRLF
actually got committed. Verify with `git ls-files --eol bin/vno.js` — you want
`w/lf`, not `w/crlf`.

`git status` will **not** show this problem: with `core.autocrlf=true` the
index holds LF while the working tree holds CRLF, so the diff is empty and only
`--eol` (or the scan above) reveals it. That gap between what git shows and
what `npm pack` reads is the entire reason this check exists.

Also confirm `publishConfig.access` is still `"public"` — this is a scoped
package, and scoped packages default to restricted, so losing that line makes
`npm publish` fail outright.

## Step 5 — Publish, after the user says yes

Show the user the version, the commit list, and anything the checks turned up.
Get an explicit go. Then, in this order:

```bash
VERSION=v$(node -p "require('./package.json').version")
git tag -a "$VERSION" -m "$VERSION"
git push origin "$VERSION"
npm publish
gh release create "$VERSION" --title "$VERSION" --generate-notes
```

Order matters: tag and push first so the tag exists for `--generate-notes` to
diff against and for the release page to point at real commits. Publish before
creating the GitHub release so the release notes never advertise a version npm
doesn't have — if `npm publish` fails, you stop with a tag pushed (harmless,
and reusable once fixed) rather than a release page promising vapour.

`--generate-notes` builds the notes from commit and PR titles between tags.
It's only as good as the commit messages, so read what it produced and rewrite
it with `gh release edit` if the result is noise.

## Step 6 — Confirm it landed

```bash
npm view @msareen/voice-notes-organizer version
gh release view "$VERSION" --json url,name --jq '.url'
```

npm's registry can lag a few seconds; if the version doesn't show immediately,
that's propagation, not failure. Report the published version and the release
URL back to the user.

## When something goes wrong

- **`npm publish` 403s** — either not logged in as `msareen`, or
  `publishConfig.access` isn't `"public"`, or that exact version already
  exists on the registry. Version numbers are never reusable; bump and go again.
- **`gh release create` 403s** — `gh auth status` will show whether the token
  has `repo` scope.
- **Published something broken** — do not try to unpublish. Fix it forward with
  a patch release; unpublishing a version other people may already depend on
  breaks their installs, and npm blocks reusing the number anyway.
- **Tag pushed but publish failed** — the tag is fine where it is. Fix the
  cause and re-run `npm publish`; there's no need to delete or move the tag
  unless the code that it points at is itself the problem.
