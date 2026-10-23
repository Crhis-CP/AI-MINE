import type { MaterialDiscovered, ModuleBrand, ModuleTopicSummary, ModuleTopicMember } from "@amp/contracts/modules";
import type { Db, Tx } from "./db.ts";
import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import type { PgBoss, WorkOptions } from "pg-boss";
import type { z } from "zod";
import type { Finding } from "./notify/feishu.ts";
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
export interface ModelStep {
  label: string;
  env: string;
  purposes: string[];
  vision?: boolean;
}
export interface AgentAbility {
  path: string;
  title: string;
  ask: string;
  answer: () => Promise<string>;
  etagPrefix: string;
  cacheControl: string;
  mcp: {
    tool: string;
    use: string;
    description: string;
    input: z.ZodObject;
    run: (args: Record<string, unknown>) => Promise<{ text: string; structured: Record<string, unknown> }>;
  };
}
export interface LlmsLines {
  api?: string[];
  pace?: string[];
  pages?: string[];
  topics?: string[];
  access?: string[];
  usage?: string[];
  guideClients?: string[];
  ways?: string[];
}
export interface SitemapEntry {
  loc: string;
  revision?: string;
  lastmod?: Date | null;
  changefreq?: string;
  priority?: number;
}
export interface EngineHooks {
  articleChanged: (
    change: { id: string; kind: "detail" | "body" | "content"; reduced?: boolean; reason: string; previousStoryIds?: number[] },
    tx: Db,
  ) => Promise<void>;
  sourceRepublished: (change: { sourceId: string }) => Promise<void>;
  reportsChanged: (change: { reason: string }, tx: Db) => Promise<void>;
  requestAnswered: (req: FastifyRequest, reply: FastifyReply, path: string) => void;
  exitServed: (exit: string, req: FastifyRequest) => void;
}
export interface TopicPageAsk {
  topic: ModuleTopicSummary;
  page: number;
  members: readonly ModuleTopicMember[];
  index: unknown;
  now: Date;
}
export interface JsonNotice {
  notice: object;
  private?: boolean;
}
export interface McpNotice {
  instructions: string;
  text: string;
  notice: object;
}
export interface FeedNotice {
  guid: string;
  title: string;
  link: string;
  description: string;
  at: Date;
}
export interface RequestNotices {
  json: (req: FastifyRequest) => JsonNotice | null;
  agent: (req: FastifyRequest) => string | null;
  mcp: (req: FastifyRequest) => McpNotice | null;
  feed: (req: FastifyRequest, feedPath: string) => FeedNotice | null;
}
export interface ServerModule {
  name: string;
  on?: Partial<EngineHooks> & { materialDiscovered?: (data: MaterialDiscovered, tx: Tx) => Promise<boolean> };
  http?: (app: FastifyInstance) => void | Promise<void>;
  schedules?: readonly Scheduled[];
  queues?: readonly ModuleQueue[];
  /** Protected administrative extensions; never registered on the legacy reader-only API. */
  admin?: {
    http?: (app: FastifyInstance) => void | Promise<void>;
    currentJobs?: () => Promise<readonly string[]>;
    counts?: Record<string, () => Promise<number>>;
    runs?: () => Promise<unknown>;
  };
  independentSelectedSources?: readonly string[];
  agent?: { abilities?: AgentAbility[]; unavailable?: string[]; requests?: string[] };
  llms?: () => Promise<LlmsLines> | LlmsLines;
  sitemap?: { entries?: () => Promise<SitemapEntry[]> };
  models?: Record<string, ModelStep>;
  alerts?: (now: number) => Promise<Finding[]>;
  followUps?: (now: number) => Promise<Finding[]>;
  retention?: (now: Date) => Promise<Record<string, unknown>>;
  topics?: {
    page?: {
      index?: (members: readonly ModuleTopicMember[], now: Date) => Promise<unknown>;
      read: (ask: TopicPageAsk) => { recheck: string[]; part: (current: ReadonlyMap<string, ModuleTopicMember>) => unknown } | null;
    };
    marks?: () => Promise<Record<string, ModuleBrand>>;
  };
  sourceKinds?: Record<
    string,
    {
      resumed?: (sourceId: string, tx: Db) => Promise<void>;
      fetchNow?: (source: { id: string; config: Record<string, unknown> }) => Promise<Record<string, unknown>>;
    }
  >;
  sourceHealth?: (now: number) => Promise<string[]>;
  hosts?: string[];
  notices?: Partial<RequestNotices>;
  storyOrigin?: () => string | null;
  feedbackKeys?: (ip: string) => string[];
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
/** The material and its follow-up job commit together; an unhandled notification must not be lost. */
export async function emitMaterialDiscovered(data: MaterialDiscovered, tx: Tx): Promise<void> {
  let handled = false;
  for (const module of installed) {
    if (await module.on?.materialDiscovered?.(data, tx)) handled = true;
  }
  if (!handled) throw new Error(`No module accepted material discovery for lane ${data.lane}`);
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
