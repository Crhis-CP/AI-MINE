// TASK-0004 D1: import-time SQL fragments are lazy; only composition roots register connections.
import type { Db, Sql } from "./db.ts";

const connections = new Map<string, Sql>();
const handles = new Map<string, Sql>();
const deferred = new WeakMap<object, () => unknown>();

/** Resolve our fragments before handing them to postgres.js, including fragments nested in builders. */
function unwrap(value: unknown): unknown {
  if (!value || (typeof value !== "object" && typeof value !== "function")) return value;
  const resolve = deferred.get(value);
  if (resolve) return resolve();
  if (Array.isArray(value)) return Object.hasOwn(value, "raw") ? value : value.map(unwrap);
  if (Object.getPrototypeOf(value) === Object.prototype) return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, unwrap(item)]));
  return value;
}

/** A query/identifier/JSON helper can be constructed before injection, but cannot execute before it. */
function lazy(build: () => unknown): object {
  let resolved = false;
  let value: unknown;
  const materialize = () => {
    if (!resolved) {
      value = build();
      resolved = true;
    }
    return value;
  };
  const proxy = new Proxy(
    {},
    {
      get(_target, key) {
        const actual = materialize();
        const member = Reflect.get(Object(actual), key);
        return typeof member === "function" ? member.bind(actual) : member;
      },
    },
  );
  deferred.set(proxy, materialize);
  return proxy;
}

function wrap(resolve: () => Db): Sql {
  const call = (...args: unknown[]) => lazy(() => Reflect.apply(resolve(), undefined, args.map(unwrap)));
  return new Proxy(call, {
    get(_target, key) {
      if (key === "json" || key === "array" || key === "unsafe") {
        return (...args: unknown[]) =>
          lazy(() => {
            const sql = resolve();
            return Reflect.apply(Reflect.get(sql, key), sql, args.map(unwrap));
          });
      }
      const sql = resolve();
      const member = Reflect.get(sql, key);
      if (typeof member !== "function") return member;
      return (...args: unknown[]) => {
        const values = args.map(unwrap);
        if (key === "begin" || key === "savepoint") {
          const callback = values.at(-1);
          if (typeof callback === "function") values[values.length - 1] = (tx: Db) => callback(wrap(() => tx));
        }
        return Reflect.apply(member, sql, values);
      };
    },
  }) as unknown as Sql;
}

/** Stable module handle, with no default connection or credentials of its own. */
export function dbOf(module: string): Sql {
  if (!module || module.trim() !== module) throw new Error("Invalid database module name");
  let handle = handles.get(module);
  if (!handle) {
    handle = wrap(() => {
      const sql = connections.get(module);
      if (!sql) throw new Error(`Database connection not injected for module ${module}`);
      return sql;
    });
    handles.set(module, handle);
  }
  return handle;
}

/** Atomic registration; replacement requires explicit disposal of the previous root's registration. */
export function injectDb(bindings: Readonly<Record<string, Sql>>): () => void {
  const entries = Object.entries(bindings);
  for (const [module, sql] of entries) {
    if (!module || module.trim() !== module || typeof sql !== "function") throw new Error("Invalid database binding");
    if (connections.has(module)) throw new Error(`Database connection already injected for module ${module}`);
  }
  for (const [module, sql] of entries) connections.set(module, sql);
  let disposed = false;
  return () => {
    if (disposed) return;
    disposed = true;
    for (const [module, sql] of entries) if (connections.get(module) === sql) connections.delete(module);
  };
}
