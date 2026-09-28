import { readOperatorToolGatewayAuthority } from "../../gateway/operator-tool-gateway-authority.js";
import { operatorScopeSatisfied } from "../../shared/operator-scope-compat.js";
import {
  assertAdmittedRunOperatorAuthority,
  type AdmittedRunOperatorAuthority,
} from "../admitted-run-context.js";
import {
  captureGatewayToolCallerAssertion,
  getGatewayToolCallerIdentity,
} from "./gateway-caller-context.js";

/** Availability only: archive still uses the caller-bound Gateway mutation policy. */
export function hasSessionArchiveAuthority(prepared?: AdmittedRunOperatorAuthority): boolean {
  const invocation = readOperatorToolGatewayAuthority();
  const authority =
    prepared ??
    getGatewayToolCallerIdentity()?.operatorAuthority ??
    invocation?.operatorRunAuthority;
  if (!authority) {
    return false;
  }
  assertAdmittedRunOperatorAuthority(authority);
  authority.assertCurrent();
  captureGatewayToolCallerAssertion()?.("sessions.patch");
  invocation?.signal.throwIfAborted();
  invocation?.assertCurrent?.();
  return (
    operatorScopeSatisfied("operator.sessions.write", authority.scopes) &&
    (!invocation || operatorScopeSatisfied("operator.sessions.write", invocation.scopes))
  );
}
