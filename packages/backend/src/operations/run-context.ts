import { AsyncLocalStorage } from "node:async_hooks";

/** Identity returned by recordRun; never infer this from status, timing or a job name alone. */
export const recordedRunContext = new AsyncLocalStorage<{ id: string; job: string }>();
