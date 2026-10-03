// TASK-0004 D1: import-time SQL fragments are lazy; only composition roots register connections.
import type { Db, Sql } from "./db.ts";

const connections = new Map<string, { sql: Sql }>();
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
function lazy(build: () => unknown, connection: () => Db): object {
  let resolved = false;
  let value: unknown;
  let owner: Db;
  const materialize = () => {
    const current = connection();
    if (resolved && current !== owner) throw new Error("Database binding changed for a prepared query");
    if (!resolved) {
      value = build();
      owner = current;
      resolved = true;
    }
    return value;
  };
  const proxy: object = new Proxy(
    {},
    {
      get(_target, key) {
        const actual = materialize();
        const member = Reflect.get(Object(actual), key);
        if (typeof member !== "function") return member;
        return (...args: unknown[]) => {
          materialize();
          const result = Reflect.apply(member, actual, args);
          return result === actual ? proxy : result;
        };
      },
    },
  );
  deferred.set(proxy, materialize);
  return proxy;
}

function wrap(bind: () => () => Db): Sql {
  const call = (...args: unknown[]) => {
    const resolve = bind();
    return lazy(() => Reflect.apply(resolve(), undefined, args.map(unwrap)), resolve);
  };
  return new Proxy(call, {
    get(_target, key) {
      if (key === "json" || key === "array" || key === "unsafe") {
        const method = bind();
        return (...args: unknown[]) => {
          const call = bind();
          const resolve = () => {
            method();
            return call();
          };
          return lazy(() => {
            const sql = resolve();
            return Reflect.apply(Reflect.get(sql, key), sql, args.map(unwrap));
          }, resolve);
        };
      }
      const resolve = bind();
      const sql = resolve();
      const member = Reflect.get(sql, key);
      if (typeof member !== "function") return member;
      return (...args: unknown[]) => {
        if (resolve() !== sql) throw new Error("Database binding changed for a saved method");
        const values = args.map(unwrap);
        if (key === "begin" || key === "savepoint") {
          const callback = values.at(-1);
          if (typeof callback === "function")
            values[values.length - 1] = async (tx: Db) => {
              const result = await callback(
                wrap(() => () => {
                  resolve();
                  return tx;
                }),
              );
              resolve();
              return result;
            };
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
      // No registration yet is valid for import-time fragments. Otherwise pin this generation now,
      // not when the query is first awaited; even reinjecting the same Sql starts a new lifetime.
      let owner = connections.get(module);
      return () => {
        const current = connections.get(module);
        if (!current) throw new Error(`Database connection not injected for module ${module}`);
        if (owner && owner !== current) throw new Error(`Database binding changed for module ${module}`);
        owner ??= current;
        return current.sql;
      };
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
  const registrations = entries.map(([module, sql]) => ({ module, binding: { sql } }));
  for (const { module, binding } of registrations) connections.set(module, binding);
  let disposed = false;
  return () => {
    if (disposed) return;
    disposed = true;
    for (const { module, binding } of registrations) if (connections.get(module) === binding) connections.delete(module);
  };
}
