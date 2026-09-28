/** Resolve setup runtime intent without turning automatic choices into persistent pins. */
import { resolveRecordedDaemonRuntime } from "../daemon/runtime-paths.js";
import { readDaemonRuntimePinForInstall } from "../daemon/runtime-pin-state.js";
import {
  resolveManagedGatewayServiceCommand,
  type GatewayServiceCommandConfig,
} from "../daemon/service-types.js";
import { DEFAULT_GATEWAY_DAEMON_RUNTIME, type GatewayDaemonRuntime } from "./daemon-runtime.js";

export async function resolveGatewaySetupRuntime(params: {
  env: NodeJS.ProcessEnv;
  existingCommand: GatewayServiceCommandConfig | null;
  runtime?: GatewayDaemonRuntime;
  selectRuntime?: (recorded?: GatewayDaemonRuntime) => Promise<GatewayDaemonRuntime>;
}) {
  const expected = readDaemonRuntimePinForInstall(
    { kind: "gateway", env: params.env },
    params.existingCommand,
    params.runtime !== undefined,
  );
  const pin = params.runtime === undefined ? expected.pin : undefined;
  const existing = resolveManagedGatewayServiceCommand(params.existingCommand);
  const env = {
    ...params.env,
    OPENCLAW_WRAPPER: params.env.OPENCLAW_WRAPPER ?? existing?.environment?.OPENCLAW_WRAPPER,
  };
  const recordedRuntime =
    params.runtime === undefined && !pin && !env.OPENCLAW_WRAPPER?.trim()
      ? await resolveRecordedDaemonRuntime(existing?.programArguments[0], env)
      : undefined;
  const retainedRuntime = recordedRuntime?.status === "supported" ? recordedRuntime : undefined;
  const runtime =
    params.runtime ??
    pin?.runtime ??
    (params.selectRuntime
      ? await params.selectRuntime(retainedRuntime?.runtime)
      : retainedRuntime?.runtime) ??
    DEFAULT_GATEWAY_DAEMON_RUNTIME;
  return {
    runtime,
    runtimeExplicit: params.runtime !== undefined,
    runtimePath: runtime === retainedRuntime?.runtime ? retainedRuntime.path : undefined,
    pinnedRuntimePath: pin?.path,
    runtimePinUpdate: { expected, pin },
    env,
  };
}
