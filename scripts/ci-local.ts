// Runs the CI workflow's commands on this machine and posts the verdict as a `local-ci` commit status, which the
// master ruleset requires. It is the merge gate so merges never wait on Actions minutes; Actions CI is a second
// opinion. Keep STEPS in line with .github/workflows/ci.yml.
//
//   npm run ci:local                    # checks HEAD
//   npm run ci:local -- <ref>           # checks a branch or sha (a PR's head)
//   npm run ci:local -- <ref> --no-status
//
// The checks run in a throwaway worktree of the commit, so untracked or uncommitted files in the checkout can neither
// fail nor rescue the run. The worktree borrows the checkout's node_modules through junctions (a sub-project's
// node_modules goes in LINKS). Originated in idapixl/slotkeeper, 2026-09-22; runs on Node 22.18+ type stripping, no tsx.

import { spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, rmSync, symlinkSync } from "node:fs";
import { hostname, tmpdir } from "node:os";
import { join, resolve } from "node:path";

interface Step {
  name: string;
  command: string;
  advisory?: boolean;
}

const STEPS: readonly Step[] = [
  { name: "Type Check", command: "npx tsc -p tsconfig.json --noEmit" },
  { name: "Build", command: "npm run build" },
  // Two workers: a full-width run on this machine starves everything else (2026-09-24).
  { name: "Test", command: "npm test -- --maxWorkers=2" },
  { name: "Audit", command: "npm audit --audit-level=high" },
];

// Every node_modules the steps need, relative to the repo root; each is borrowed from this checkout by a junction.
const LINKS: readonly string[] = ["node_modules"];

const CONTEXT = "local-ci";

function run(command: string, cwd: string, quiet = false): { ok: boolean; out: string } {
  const r = spawnSync(command, { cwd, shell: true, encoding: "utf8", stdio: quiet ? "pipe" : "inherit" });
  return { ok: r.status === 0, out: (r.stdout ?? "").trim() };
}

// No shell for git: cmd.exe reads `^` in `<ref>^{commit}` as its escape character.
function git(args: readonly string[], cwd: string): string {
  const r = spawnSync("git", args, { cwd, encoding: "utf8" });
  if (r.status !== 0) throw new Error(`git ${args.join(" ")} failed: ${(r.stderr ?? "").trim()}`);
  return (r.stdout ?? "").trim();
}

function postStatus(sha: string, state: "success" | "failure", description: string, cwd: string): void {
  const r = run(
    `gh api -X POST repos/{owner}/{repo}/statuses/${sha} -f state=${state} -f context=${CONTEXT} -f "description=${description}"`,
    cwd,
    true,
  );
  console.log(r.ok ? `status: ${CONTEXT} = ${state} on ${sha.slice(0, 7)}` : `status: not posted (is ${sha.slice(0, 7)} pushed?)`);
}

function main(): void {
  const args = process.argv.slice(2);
  const ref = args.find((a) => !a.startsWith("--")) ?? "HEAD";
  const postToGitHub = !args.includes("--no-status");
  const repo = resolve(git(["rev-parse", "--show-toplevel"], process.cwd()));
  const sha = git(["rev-parse", "--verify", `${ref}^{commit}`], repo);
  for (const link of LINKS) {
    if (!existsSync(join(repo, link))) throw new Error(`${link} missing in this checkout: install it first`);
  }

  const dir = mkdtempSync(join(tmpdir(), "cortex-engine-ci-"));
  const tree = join(dir, "tree");
  console.log(`local CI: ${ref} (${sha.slice(0, 7)}) in ${tree}`);
  git(["worktree", "add", "--detach", tree, sha], repo);

  const failed: string[] = [];
  try {
    for (const link of LINKS) symlinkSync(join(repo, link), join(tree, link), "junction");
    for (const step of STEPS) {
      console.log(`\n=== ${step.name}${step.advisory ? " (advisory)" : ""}: ${step.command}`);
      const ok = run(step.command, tree).ok;
      if (!ok && !step.advisory) failed.push(step.name);
      if (!ok && step.advisory) console.log(`${step.name} failed (advisory, not a gate)`);
    }
  } finally {
    // The junctions go first so removing the worktree can never walk into the real node_modules.
    for (const link of LINKS) rmSync(join(tree, link), { force: true, recursive: false });
    spawnSync("git", ["worktree", "remove", "--force", tree], { cwd: repo });
    rmSync(dir, { recursive: true, force: true });
  }

  const passed = failed.length === 0;
  console.log(`\nlocal CI ${passed ? "PASSED" : `FAILED: ${failed.join(", ")}`} at ${sha.slice(0, 7)}`);
  if (postToGitHub) {
    const description = passed ? `typecheck, build, test, audit passed on ${hostname()}` : `failed: ${failed.join(", ")}`;
    postStatus(sha, passed ? "success" : "failure", description, repo);
  }
  process.exit(passed ? 0 : 1);
}

main();
