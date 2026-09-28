import { quoteCliArg, quotePowerShellArg } from "../cli/quote-cli-arg.js";
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
