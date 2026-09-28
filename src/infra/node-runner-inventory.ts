import { isRecord } from "@openclaw/normalization-core/record-coerce";
import { WORKER_BUNDLE_PREWARM_VERSION } from "../../packages/gateway-protocol/src/schema/worker-admission.js";
import { parseWorkerSlotSummary } from "../shared/node-list-parse.js";
import {
  isWorkerToolName,
  WORKER_TOOL_NAMES,
  type WorkerToolName,
} from "../worker/tool-authority.js";

export { NODE_WORKER_CAPACITY_MAX } from "../shared/node-list-parse.js";

export const NODE_RUNNER_INVENTORY_UPDATE_METHOD = "node.runnerInventory.update";
export const NODE_WORKER_SUPERVISOR_PROTOCOL_FEATURE = "node-worker-supervisor-v6";
const RETIRED_NODE_WORKER_SUPERVISOR_PROTOCOL_FEATURES = [
  "node-worker-supervisor-v1",
  "node-worker-supervisor-v2",
  "node-worker-supervisor-v3",
  "node-worker-supervisor-v4",
  "node-worker-supervisor-v5",
] as const;
export const NODE_WORKER_BUNDLE_RETENTION_VERSION = 1;
export const NODE_WORKER_BUNDLE_STATUS_VERSION = 1;
export const NODE_WORKER_PORTAL_STREAM_VERSION = 1;
export const NODE_WORKER_ENVIRONMENT_SESSION_VERSION = 1;
export const NODE_WORKER_PREPARED_WORKSPACE_VERSION = 1;

// Supervisors predating launchToolNames admit this closed vocabulary: OpenClaw 2026.9.6
// is the only published release that passes the worker-turn launch gate. Retire with the next dialect.
const LEGACY_NODE_WORKER_LAUNCH_TOOL_NAMES = Object.freeze([
  "read",
  "write",
  "edit",
  "apply_patch",
  "exec",
  "process",
  "browser",
  "computer",
  "skill_workshop",
  "sessions_spawn",
  "sessions_send",
  "portal",
] satisfies WorkerToolName[]);

export const NODE_RUNNER_UPDATE_REQUIRED_ISSUE = {
  code: "update-required",
  action: "update-and-reconnect",
  updateCommand: "openclaw update",
  headlessReconnectCommand: "openclaw node restart",
} as const;

export type NodeRunnerInventoryIssue = typeof NODE_RUNNER_UPDATE_REQUIRED_ISSUE;
export type NodeWorkerCapacitySnapshot = Readonly<{
  total: number;
  available: number;
}>;

export type NodeWorkerHostDeclaration =
  | { enabled: false }
  | {
      enabled: true;
      capacity: NodeWorkerCapacitySnapshot;
      bundlePrewarm?: typeof WORKER_BUNDLE_PREWARM_VERSION;
      bundleRetention?: typeof NODE_WORKER_BUNDLE_RETENTION_VERSION;
      bundleStatus?: typeof NODE_WORKER_BUNDLE_STATUS_VERSION;
      portalStream?: typeof NODE_WORKER_PORTAL_STREAM_VERSION;
      environmentSession?: typeof NODE_WORKER_ENVIRONMENT_SESSION_VERSION;
      preparedWorkspace?: typeof NODE_WORKER_PREPARED_WORKSPACE_VERSION;
      capturedExecPolicy?: true;
      launchToolNames?: readonly WorkerToolName[];
    };

export type NodeRunnerInventoryDeclaration =
  | { protocolFeatures: readonly [] }
  | {
      protocolFeatures: readonly [
        (typeof RETIRED_NODE_WORKER_SUPERVISOR_PROTOCOL_FEATURES)[number],
      ];
    }
  | {
      protocolFeatures: readonly [typeof NODE_WORKER_SUPERVISOR_PROTOCOL_FEATURE];
      workerHost: NodeWorkerHostDeclaration;
    };

function parseWorkerHostDeclaration(value: unknown): NodeWorkerHostDeclaration | null {
  if (!isRecord(value) || typeof value.enabled !== "boolean") {
    return null;
  }
  const keys = Object.keys(value);
  if (!value.enabled) {
    return keys.length === 1 && keys[0] === "enabled" ? { enabled: false } : null;
  }
  const capacity = parseWorkerSlotSummary(value.capacity);
  if (
    !capacity ||
    keys.length < 2 ||
    keys.length > 10 ||
    !keys.includes("enabled") ||
    !keys.includes("capacity") ||
    keys.some(
      (key) =>
        key !== "enabled" &&
        key !== "capacity" &&
        key !== "bundlePrewarm" &&
        key !== "bundleRetention" &&
        key !== "bundleStatus" &&
        key !== "portalStream" &&
        key !== "environmentSession" &&
        key !== "preparedWorkspace" &&
        key !== "capturedExecPolicy" &&
        key !== "launchToolNames",
    ) ||
    (value.bundlePrewarm !== undefined && value.bundlePrewarm !== WORKER_BUNDLE_PREWARM_VERSION) ||
    (value.bundleRetention !== undefined &&
      value.bundleRetention !== NODE_WORKER_BUNDLE_RETENTION_VERSION) ||
    (value.bundleStatus !== undefined &&
      value.bundleStatus !== NODE_WORKER_BUNDLE_STATUS_VERSION) ||
    (value.portalStream !== undefined &&
      value.portalStream !== NODE_WORKER_PORTAL_STREAM_VERSION) ||
    (value.environmentSession !== undefined &&
      value.environmentSession !== NODE_WORKER_ENVIRONMENT_SESSION_VERSION) ||
    (value.preparedWorkspace !== undefined &&
      value.preparedWorkspace !== NODE_WORKER_PREPARED_WORKSPACE_VERSION) ||
    (value.capturedExecPolicy !== undefined && value.capturedExecPolicy !== true) ||
    (value.bundleStatus !== undefined && value.bundleRetention === undefined)
  ) {
    return null;
  }
  let launchToolNames: WorkerToolName[] | undefined;
  if ("launchToolNames" in value) {
    const declared = value.launchToolNames;
    if (
      !Array.isArray(declared) ||
      declared.length > 64 ||
      new Set(declared).size !== declared.length
    ) {
      return null;
    }
    for (const name of declared) {
      if (typeof name !== "string" || name.length === 0 || name.length > 64) {
        return null;
      }
    }
    const knownNames = new Set(declared.filter(isWorkerToolName));
    launchToolNames = WORKER_TOOL_NAMES.filter((name) => knownNames.has(name));
  }
  return {
    enabled: true,
    capacity,
    ...(value.bundlePrewarm === WORKER_BUNDLE_PREWARM_VERSION
      ? { bundlePrewarm: WORKER_BUNDLE_PREWARM_VERSION }
      : {}),
    ...(value.bundleRetention === NODE_WORKER_BUNDLE_RETENTION_VERSION
      ? { bundleRetention: NODE_WORKER_BUNDLE_RETENTION_VERSION }
      : {}),
    ...(value.bundleStatus === NODE_WORKER_BUNDLE_STATUS_VERSION
      ? { bundleStatus: NODE_WORKER_BUNDLE_STATUS_VERSION }
      : {}),
    ...(value.portalStream === NODE_WORKER_PORTAL_STREAM_VERSION
      ? { portalStream: NODE_WORKER_PORTAL_STREAM_VERSION }
      : {}),
    ...(value.environmentSession === NODE_WORKER_ENVIRONMENT_SESSION_VERSION
      ? { environmentSession: NODE_WORKER_ENVIRONMENT_SESSION_VERSION }
      : {}),
    ...(value.preparedWorkspace === NODE_WORKER_PREPARED_WORKSPACE_VERSION
      ? { preparedWorkspace: NODE_WORKER_PREPARED_WORKSPACE_VERSION }
      : {}),
    ...(value.capturedExecPolicy === true ? { capturedExecPolicy: true } : {}),
    ...(launchToolNames !== undefined ? { launchToolNames } : {}),
  };
}

/** Parses the closed reconnect-scoped node-host runner declaration. */
export function parseNodeRunnerInventoryDeclaration(
  value: unknown,
): NodeRunnerInventoryDeclaration | null {
  if (!isRecord(value) || !Array.isArray(value.protocolFeatures)) {
    return null;
  }
  const keys = Object.keys(value);
  if (value.protocolFeatures.length === 0) {
    return keys.length === 1 && keys.includes("protocolFeatures") ? { protocolFeatures: [] } : null;
  }
  if (value.protocolFeatures.length !== 1) {
    return null;
  }
  const feature = value.protocolFeatures[0];
  const retiredFeature = RETIRED_NODE_WORKER_SUPERVISOR_PROTOCOL_FEATURES.find(
    (candidate) => candidate === feature,
  );
  if (retiredFeature) {
    // Retired payloads never become consent or launch authority; only their marker drives recovery.
    return keys.length <= 2 &&
      keys.every(
        (key) => key === "protocolFeatures" || key === "workerRuns" || key === "workerHost",
      )
      ? { protocolFeatures: [retiredFeature] }
      : null;
  }
  if (feature !== NODE_WORKER_SUPERVISOR_PROTOCOL_FEATURE || keys.length !== 2) {
    return null;
  }
  const workerHost = parseWorkerHostDeclaration(value.workerHost);
  return workerHost
    ? { protocolFeatures: [NODE_WORKER_SUPERVISOR_PROTOCOL_FEATURE], workerHost }
    : null;
}

export function formatNodeRunnerUpdateRequired(
  nodeId: string,
  issue: NodeRunnerInventoryIssue,
): string {
  return `device worker node ${nodeId} requires an update before it can host sessions; run ${issue.updateCommand}, then reconnect it (for a headless node, run ${issue.headlessReconnectCommand})`;
}

/** Worker execution requires the node to preserve the Gateway's captured exec policy. */
export function resolveNodeWorkerExecutionIssue(
  workerHost: NodeWorkerHostDeclaration,
): NodeRunnerInventoryIssue | undefined {
  return workerHost.enabled && workerHost.capturedExecPolicy !== true
    ? NODE_RUNNER_UPDATE_REQUIRED_ISSUE
    : undefined;
}

export function resolveNodeWorkerLaunchToolNames(
  workerHost: NodeWorkerHostDeclaration | undefined,
): readonly WorkerToolName[] {
  return (
    (workerHost?.enabled && workerHost.launchToolNames) || LEGACY_NODE_WORKER_LAUNCH_TOOL_NAMES
  );
}
