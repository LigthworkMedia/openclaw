import { quoteCliArg, quotePowerShellArg } from "../cli/quote-cli-arg.js";
import { DEV_BRANCH } from "./update-channels.js";
import { isFailedUpdateStep } from "./update-run-step.js";
import { runStep } from "./update-runner-command.js";
import type { RunStepOptions } from "./update-runner-types.js";

// A successful Git status command does not imply a clean checkout.
export async function runGitCleanCheckStep(options: RunStepOptions) {
  const result = await runStep({
    ...options,
    progress: { ...options.progress, onStepComplete: undefined },
  });
  const dirty = !isFailedUpdateStep(result) && Boolean(result.stdoutTail?.trim());
  if (dirty) {
    result.exitCode = 1;
    result.stderrTail = "This checkout has local changes. Installation has not started.";
  }
  options.progress?.onStepComplete?.({
    ...result,
    index: options.stepIndex,
    total: options.totalSteps,
  });
  return { result, dirty };
}

// Publish completion only after the owner classifies its recoverable result.
export async function runGitUpstreamStep(options: RunStepOptions) {
  const upstreamStep = await runStep({
    ...options,
    progress: { ...options.progress, onStepComplete: undefined },
  });
  if (
    typeof upstreamStep.exitCode === "number" &&
    upstreamStep.exitCode !== 0 &&
    !upstreamStep.signal &&
    !upstreamStep.killed &&
    !upstreamStep.outputLimitExceeded &&
    (!upstreamStep.termination || upstreamStep.termination === "exit") &&
    upstreamStep.exitCode !== 130 &&
    upstreamStep.exitCode !== 143
  ) {
    const quote = process.platform === "win32" ? quotePowerShellArg : quoteCliArg;
    upstreamStep.advisory = {
      kind: "recoverable-maintenance",
      message: `Skipped Git upstream tracking setup. Complete it with: git ${options.argv.slice(1).map(quote).join(" ")}. Reason: ${upstreamStep.stderrTail || "git branch failed"}`,
    };
  }
  options.progress?.onStepComplete?.({
    ...upstreamStep,
    index: options.stepIndex,
    total: options.totalSteps,
  });
  return upstreamStep;
}

export async function runGitActivationBranchCheckStep(stepOptions: RunStepOptions, branch: string) {
  const devBranchRef = `refs/heads/${branch}`;
  return runStep({
    ...stepOptions,
    runCommand: async (argv, options) => {
      const exists = await stepOptions.runCommand(
        ["git", "-C", stepOptions.cwd, "show-ref", "--verify", "--quiet", devBranchRef],
        options,
      );
      if (exists.code === 1) {
        return { ...exists, code: 0, stdout: "", stderr: "" };
      }
      if (exists.code !== 0) {
        return {
          ...exists,
          stdout: "",
          stderr: `Could not inspect local branch ${branch} before activation. Resolve the Git branch error, then rerun openclaw update.`,
        };
      }
      // Resetting a branch to its current ref is a ref/reflog no-op, but Git still
      // enforces every worktree owner state, including paused rebase and bisect.
      const result = await stepOptions.runCommand(argv, options);
      const sanitized = { ...result, stdout: "" };
      return result.code !== 0
        ? {
            ...sanitized,
            stderr:
              `Cannot activate this dev update because a Git worktree uses or reserves branch ${branch}. ` +
              `Finish or abort its rebase or bisect, or move it off ${branch}, then rerun openclaw update.`,
          }
        : sanitized;
    },
  });
}

export async function runGitRollbackSteps({
  beforeSha,
  branch,
  gitRoot,
  createdDevBranchDuringUpdate,
  sourceTreeStagingPaths,
  recoveryStep,
  checkSourceUnchanged,
  assertCurrent,
  activatedSource,
}: {
  beforeSha: string | null;
  branch: string | null;
  gitRoot: string;
  createdDevBranchDuringUpdate: boolean;
  sourceTreeStagingPaths: string[] | undefined;
  recoveryStep: (name: string, argv: string[], cwd: string) => RunStepOptions;
  checkSourceUnchanged: (
    sha: string,
    branch: string | null,
    assertCurrent: () => void,
  ) => Promise<{ status: "error"; reason: "clean-check-failed" | "dirty" } | undefined>;
  assertCurrent: () => void;
  activatedSource?: { sha: string; branch: string | null };
}) {
  if (!beforeSha) {
    return false;
  }
  let source = activatedSource;
  const assertSourceCurrent = async () => {
    assertCurrent();
    if (source && (await checkSourceUnchanged(source.sha, source.branch, assertCurrent))) {
      throw new Error("Git checkout changed after activation; retained rollback was refused.");
    }
    assertCurrent();
  };
  type RefChange = { branch: string; operation: "rewrite" | "delete" };
  const execute = async (
    name: string,
    args: string[],
    expectedSource = source,
    refChange?: RefChange,
  ) => {
    if (source) {
      await assertSourceCurrent();
    }
    assertCurrent();
    const stepOptions = recoveryStep(name, ["git", "-C", gitRoot, ...args], gitRoot);
    let skipped: string | undefined;
    const result = await runStep({
      ...stepOptions,
      progress: { ...stepOptions.progress, onStepComplete: undefined },
      runCommand: async (argv, options) => {
        if (refChange) {
          // update-ref's SHA check does not protect linked-worktree branch custody.
          const worktrees = await stepOptions.runCommand(
            ["git", "-C", gitRoot, "worktree", "list", "--porcelain"],
            options,
          );
          assertCurrent();
          if (isFailedUpdateStep({ ...worktrees, exitCode: worktrees.code })) {
            return worktrees;
          }
          if (worktrees.stdout.split("\n").includes(`branch refs/heads/${refChange.branch}`)) {
            const message = `Branch ${refChange.branch} is used by another Git worktree.`;
            if (refChange.operation === "delete") {
              skipped = `Skipped deleting ${refChange.branch}. ${message}`;
              return { code: 0, stdout: skipped, stderr: "" };
            }
            return { code: 1, stdout: "", stderr: `Cannot restore branch. ${message}` };
          }
        }
        assertCurrent();
        return stepOptions.runCommand(argv, options);
      },
    });
    if (skipped) {
      result.advisory = { kind: "recoverable-maintenance", message: skipped };
    }
    stepOptions.progress?.onStepComplete?.({
      ...result,
      index: stepOptions.stepIndex,
      total: stepOptions.totalSteps,
    });
    assertCurrent();
    if (source) {
      if (isFailedUpdateStep(result)) {
        throw new Error(`Git source rollback failed at ${name}; previous runtime retained.`);
      }
      // Advance only to the command's planned result, never a fresh snapshot
      // that could adopt operator edits made while the child was running.
      source = expectedSource;
      await assertSourceCurrent();
    }
    return result;
  };
  const restore = async (
    name: string,
    args: string[],
    expectedSource = source,
    refChange?: RefChange,
  ) => !isFailedUpdateStep(await execute(name, args, expectedSource, refChange));
  // A retained transaction admitted a clean source tree. It owns no dirty
  // files to reset or clean, even if they appear after its last observation.
  let restored = true;
  if (!source) {
    restored = await restore("git-rollback-clean", ["reset", "--hard"]);
    restored =
      (await restore("git-rollback-clean-untracked", [
        "clean",
        "-fd",
        "-e",
        "dist/control-ui/",
        ...(sourceTreeStagingPaths?.flatMap((relative) => ["-e", `/${relative}/`]) ?? []),
      ])) && restored;
  }
  const attached = branch && branch !== "HEAD";
  const checkedOut = await restore(
    "git-rollback-checkout",
    attached
      ? ["checkout", source ? "--no-overwrite-ignore" : "--force", branch]
      : ["checkout", "--detach", ...(source ? ["--no-overwrite-ignore"] : []), beforeSha],
    source
      ? {
          sha: attached && branch === source.branch ? source.sha : beforeSha,
          branch: attached ? branch : "HEAD",
        }
      : undefined,
  );
  if (attached && checkedOut) {
    if (source) {
      const branchSha = source.sha;
      // Unlike reset --keep, checkout preserves staged content in unchanged files.
      await restore(
        "git-rollback-source",
        ["checkout", "--detach", "--no-overwrite-ignore", beforeSha],
        {
          sha: beforeSha,
          branch: "HEAD",
        },
      );
      await restore(
        "git-rollback-ref",
        ["update-ref", `refs/heads/${branch}`, beforeSha, branchSha],
        source,
        { branch, operation: "rewrite" },
      );
      await restore("git-rollback-attach", ["checkout", "--no-overwrite-ignore", branch], {
        sha: beforeSha,
        branch,
      });
    } else {
      restored = (await restore("git-rollback-reset", ["reset", "--hard", beforeSha])) && restored;
    }
  }
  if (createdDevBranchDuringUpdate && (!attached || checkedOut)) {
    await restore(
      "git-rollback-delete-branch",
      activatedSource
        ? ["update-ref", "-d", `refs/heads/${DEV_BRANCH}`, activatedSource.sha]
        : ["branch", "-D", DEV_BRANCH],
      source,
      activatedSource ? { branch: DEV_BRANCH, operation: "delete" } : undefined,
    );
  }
  const head = await execute("git-rollback-verify-head", ["rev-parse", "HEAD"]);
  const verified = !isFailedUpdateStep(head) && head.stdoutTail?.trim() === beforeSha;
  head.exitCode = verified ? 0 : 1;
  if (!verified) {
    head.stderrTail = `expected ${beforeSha}, found ${head.stdoutTail?.trim() || "unreadable HEAD"}`;
  }
  return restored && checkedOut && verified;
}
