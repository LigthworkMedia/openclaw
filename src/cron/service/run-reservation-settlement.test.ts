import { expect, it, vi } from "vitest";
import {
  observeCronJobWrites,
  observeCronStoreCommits,
} from "../../../test/helpers/cron/runtime-mutation.js";
import {
  createCronRegressionState,
  createDueIsolatedJob,
  setupCronRegressionFixtures,
} from "../../../test/helpers/cron/service-regression-fixtures.js";
import { createDeferred } from "../../../test/helpers/promise.js";
import { openOpenClawStateDatabase } from "../../state/openclaw-state-db.js";
import { loadCronStore, saveCronStore } from "../store.js";
import { cronStoreKey } from "../store/key.js";
import { start, stop } from "./ops-lifecycle.js";
import { run } from "./ops-run.js";
import { runWithCronAdmission } from "./run-admission.js";
import { runMissedJobs } from "./timer.js";
import { onTimer } from "./timer.test-support.js";

const opsRegressionFixtures = setupCronRegressionFixtures({
  prefix: "cron-reservation-settlement-",
});

it.each([
  { trigger: "manual", restartScheduler: false },
  { trigger: "scheduled", restartScheduler: false },
  { trigger: "startup", restartScheduler: false },
  { trigger: "scheduled", restartScheduler: true },
] as const)(
  "retries $trigger cleanup when stop follows the committed reservation (restart: $restartScheduler)",
  async ({ trigger, restartScheduler }) => {
    const store = opsRegressionFixtures.makeStorePath();
    const dueAt = Date.parse("2026-02-06T10:05:03.250Z");
    const job = createDueIsolatedJob({
      id: `stopped-during-${trigger}-reservation`,
      nowMs: dueAt,
      nextRunAtMs: trigger === "manual" ? dueAt + 3_600_000 : dueAt,
    });
    await saveCronStore(store.storePath, { version: 1, jobs: [job] });

    const state = createCronRegressionState({
      storePath: store.storePath,
      nowMs: () => dueAt,
      runIsolatedAgentJob: vi.fn(async () => ({ status: "ok" as const })),
    });
    const releaseSuccessor = createDeferred();
    let restarted: Promise<void> | undefined;
    let successorAdmission: Promise<unknown> | undefined;
    let reservationPersisted = false;
    let cleanupFailed = false;
    const stopObserving = observeCronJobWrites(job.id, ({ queuedAtMs }) => {
      if (reservationPersisted && !cleanupFailed && queuedAtMs === undefined) {
        cleanupFailed = true;
        throw new Error("reservation cleanup persist failed");
      }
    });
    const database = openOpenClawStateDatabase().db;
    const stopObservingCommits = observeCronStoreCommits(store.storePath, () => {
      const queued = database
        .prepare(
          "SELECT 1 FROM cron_jobs WHERE store_key = ? AND job_id = ? AND json_extract(state_json, '$.queuedAtMs') = ?",
        )
        .get(cronStoreKey(store.storePath), job.id, dueAt);
      if (!reservationPersisted && queued) {
        reservationPersisted = true;
        stop(state);
        if (restartScheduler) {
          restarted = start(state);
          successorAdmission = runWithCronAdmission(state, () => releaseSuccessor.promise);
        }
      }
    });

    try {
      if (trigger === "manual") {
        await expect(run(state, job.id, "force")).resolves.toEqual({
          ok: true,
          ran: false,
          reason: "stopped",
        });
      } else if (trigger === "scheduled") {
        await onTimer(state);
      } else {
        await expect(runMissedJobs(state)).rejects.toThrow("reservation cleanup persist failed");
      }
      await restarted;
      expect(state.stopped).toBe(!restartScheduler);
      expect(state.queuedRunReservationsByJobId.has(job.id)).toBe(false);
      expect(reservationPersisted && cleanupFailed).toBe(true);
      expect(state.runAdmission.active).toBe(restartScheduler ? 1 : 0);
      expect(state.deps.runIsolatedAgentJob).not.toHaveBeenCalled();
      const persisted = (await loadCronStore(store.storePath)).jobs.find(
        (entry) => entry.id === job.id,
      );
      expect(persisted?.state.queuedAtMs).toBeUndefined();
      expect(persisted?.state.runningAtMs).toBeUndefined();
    } finally {
      stopObservingCommits();
      stopObserving();
      releaseSuccessor.resolve();
      await Promise.allSettled([restarted, successorAdmission]);
      stop(state);
    }
    expect(state.runAdmission.active).toBe(0);
  },
);
