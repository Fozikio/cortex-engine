# Contributing

## Getting set up

```bash
npm ci
npm run build     # tsc
npm test          # vitest, 326 tests
```

Node 20 or newer (`engines: node >=20`). CI runs the suite on Node 24 across
Ubuntu and Windows, and separately checks that the package still builds and
tests on Node 20 so the published `engines` claim stays honest.

Windows is in the test matrix on purpose: service supervision is
platform-specific — detached spawning, `taskkill` and PID handling all differ
there — and an Ubuntu-only gate cannot see any of it.

## Before you open a PR

```bash
npm run build            # must be clean
npm test                 # must be green
npm audit --audit-level=high
npm run verify:package   # only if you touched `files` or the build output
```

`verify:package` exists because the web dashboard silently stopped shipping at
1.2.2 — a `files` entry was omitted and nothing caught it. If you add an asset
that must reach the published tarball, **the `files` entry and the build step
that produces it have to land in the same PR.** Adding the entry first fails
the publish; adding the build step first silently ships nothing.

## Commit messages

Conventional Commits, with a scope where it adds clarity:

```
type(scope): summary
```

Types: `feat`, `fix`, `chore`, `docs`, `refactor`, `test`, `ci`, `build`,
`perf`, `security`, `style`, `revert`.

The body should explain **why**. The diff already shows what changed. A commit
that fixes a subtle bug should leave behind the reasoning that made it subtle,
not a restatement of the patch.

## Pull requests

This repository is on the **Production** workflow tier:

- No direct pushes to `master` — every change goes through a PR.
- CI is a hard merge gate. The required context is **`Type Check`**; do not
  rename that job, or branch protection will wait forever on a check that no
  longer reports.
- Branches must be up to date with `master` before merging.

## Dependencies

Security fixes are preferred as lockfile-only changes (`npm audit fix` without
`--force`). Two cautions learned the hard way:

- **`npm audit fix --force` will propose downgrades.** It suggests the newest
  version its advisory data marks clean, which can be several majors *below*
  what you run. Read the proposed version before accepting it.
- **A green audit is not proof of a working tree.** A dependency whose fix
  shipped alongside an ESM migration can satisfy `npm audit` and `tsc` while
  throwing at runtime for CommonJS callers. Run the suite after any override.

Use `overrides` to pin a transitive dependency; several are already in place.

## Optional peer dependencies

Cloud and embedding providers are optional peers loaded through dynamic
`import()`. If you add one, it must be:

1. listed in `peerDependencies` **and** `peerDependenciesMeta` as optional,
2. mirrored into `devDependencies` so tests can exercise it, and
3. **actually imported.**

Point 3 is not rhetorical — `openai` and `@anthropic-ai/sdk` sat in all three
lists for months while nothing imported them, because both providers speak
HTTP through `providers/openai-compatible.ts` via native `fetch`. They
generated a recurring dependency-drift finding for a decision that did not
exist. Declare a peer only when something loads it.
