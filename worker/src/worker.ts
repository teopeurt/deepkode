// Worker entry: call runWorker() from the deployment with its ActivityDeps (real plane wiring is WP-A).
import { NativeConnection, Worker } from "@temporalio/worker";
import { createActivities, type ActivityDeps } from "./activities";

export async function runWorker(deps: ActivityDeps, opts: { address?: string; namespace?: string; taskQueue?: string; workflowsPath?: string } = {}) {
  const connection = await NativeConnection.connect({ address: opts.address ?? process.env.TEMPORAL_ADDRESS ?? "localhost:7233" });
  const worker = await Worker.create({
    connection,
    namespace: opts.namespace ?? process.env.TEMPORAL_NAMESPACE ?? "default",
    taskQueue: opts.taskQueue ?? process.env.TEMPORAL_TASK_QUEUE ?? "deepcode",
    workflowsPath: opts.workflowsPath, // FlowKit's workflow bundle is supplied by the deployment
    activities: createActivities(deps),
  });
  await worker.run();
}

if (import.meta.main) {
  throw new Error("No default deps: build ActivityDeps (plane, collectDiff, planRequest, taskSpec) and call runWorker().");
}
