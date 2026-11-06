// Workflow used only by the Temporal-backed test. Proxy options mirror what an orchestrator registration should set.
import { proxyActivities, isCancellation, ActivityCancellationType } from "@temporalio/workflow";
import type { OrchestrationActivities, RunSubagentInput } from "./activities";

const acts = proxyActivities<OrchestrationActivities>({
  startToCloseTimeout: "1 minute",
  heartbeatTimeout: "10 seconds",
  cancellationType: ActivityCancellationType.WAIT_CANCELLATION_COMPLETED,
  retry: { maximumAttempts: 3, initialInterval: "50ms", maximumInterval: "200ms", nonRetryableErrorTypes: ["SubagentTurnFailed", "PlanInvalid"] },
});

export async function subagentWorkflow(input: RunSubagentInput): Promise<string> {
  try { return (await acts.runSubagent(input)).output; }
  catch (e) { if (isCancellation(e)) return "cancelled"; throw e; }
}
