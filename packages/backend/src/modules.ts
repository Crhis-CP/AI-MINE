import type { FastifyInstance } from "fastify";
import type { PgBoss, WorkOptions } from "pg-boss";
/** Extension hooks installed by process entry points; the engine does not import site extensions. */
export interface Scheduled {
  name: string;
  cron: string;
  run: () => Promise<unknown>;
  missed?: "skip" | "once";
  when?: () => boolean;
}
/** A module-owned queue. The handler receives every item in the requested batch. */
export interface ModuleQueue<T = never> {
  name: string;
  options: NonNullable<Parameters<PgBoss["createQueue"]>[1]>;
  worker: WorkOptions;
  run: (data: T[]) => Promise<unknown>;
}
export function defineQueue<T>(queue: ModuleQueue<T>): ModuleQueue<T> {
  return queue;
}
export interface ServerModule {
  name: string;
  http?: (app: FastifyInstance) => void | Promise<void>;
  schedules?: readonly Scheduled[];
  queues?: readonly ModuleQueue[];
  /** Protected administrative extensions; never registered on the legacy reader-only API. */
  admin?: { http?: (app: FastifyInstance) => void | Promise<void> };
}
export function defineServerModule(module: ServerModule): ServerModule {
  return module;
}
let installed: readonly ServerModule[] = [];
export function installModules(modules: readonly ServerModule[]): void {
  const names = new Set<string>();
  for (const module of modules) {
    if (!module.name.trim() || names.has(module.name)) throw new Error(`Invalid or duplicate module: ${module.name}`);
    names.add(module.name);
  }
  installed = [...modules];
}
export function serverModules(): readonly ServerModule[] {
  return installed;
}
/** Validate the complete active set before registering any timers. */
export function scheduledTasks(engine: readonly Scheduled[]): readonly Scheduled[] {
  const tasks = [...engine, ...installed.flatMap((module) => module.schedules ?? [])].filter((task) => task.when?.() ?? true);
  const names = new Set<string>();
  for (const task of tasks) {
    if (!task.name.trim() || names.has(task.name)) throw new Error(`Invalid or duplicate schedule: ${task.name}`);
    names.add(task.name);
  }
  return tasks;
}
