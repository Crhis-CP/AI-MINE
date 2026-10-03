// TASK-0004 D1: import-time SQL fragments are lazy; only composition roots register connections.
import type { Db, Sql } from "./db.ts";

const connections = new Map<string, { sql: Sql }>();
const handles = new Map<string, Sql>();
const deferred = new WeakMap<object, () => unknown>();
type Binding = { get: () => Db; compose: () => Db; construct: () => void };

function scoped(sql: Db, check: () => void): Binding {
  const get = () => {
    check();
    return sql;
  };
  return { get, compose: get, construct: check };
}

/** Cursor iteration can execute SQL; return remains available to close an already opened cursor. */
function cursor(target: unknown, check: () => void): object {
  if (!target || typeof target !== "object") throw new Error("Invalid database cursor");
  return new Proxy(
    {},
    {
      get(_target, key) {
        if (key !== "return") check();
        const member = Reflect.get(target, key);
        if (typeof member !== "function") return member;
        return (...args: unknown[]) => {
          if (key !== "return") check();
          const result = Reflect.apply(member, target, args);
          return key === Symbol.asyncIterator ? cursor(result, check) : result;
        };
      },
    },
  );
}

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
function lazy(build: (resolve: () => Db) => unknown, connection: () => Db, compose = connection): object {
  let resolved = false;
  let value: unknown;
  let owner: Db;
  const materialize = () => {
    const current = connection();
    if (resolved && current !== owner) throw new Error("Database binding changed for a prepared query");
    if (!resolved) {
      value = build(connection);
      owner = current;
      resolved = true;
    }
    return value;
  };
  const proxy: object = new Proxy(
    {},
    {
      get(_target, key) {
        if (key === "cancel") {
          const actual = resolved ? value : materialize();
          return () => {
            // Observe cancellation without Query.then/catch, which would start a still-pending query.
            if (actual instanceof Promise) Promise.prototype.then.call(actual, undefined, () => {});
            return Reflect.apply(Reflect.get(Object(actual), key), actual, []);
          };
        }
        const actual = materialize();
        const member = Reflect.get(Object(actual), key);
        if (typeof member !== "function") return member;
        return (...args: unknown[]) => {
          materialize();
          const result = Reflect.apply(member, actual, args);
          return result === actual ? proxy : key === "cursor" ? cursor(result, materialize) : result;
        };
      },
    },
  );
  // Interpolation builds a new query in the current root. Observing/executing this object instead
  // pins its original lifetime; it must never silently become a query on a replacement root.
  deferred.set(proxy, () => (resolved ? materialize() : build(compose)));
  return proxy;
}

function wrap(bind: () => Binding, release?: () => void): Sql {
  const call = (...args: unknown[]) => {
    const binding = bind();
    return lazy((resolve) => Reflect.apply(resolve(), undefined, args.map(unwrap)), binding.get, binding.compose);
  };
  return new Proxy(call, {
    get(_target, key) {
      if (key === "release" && release) return release;
      if (key === "json" || key === "array" || key === "unsafe" || key === "file") {
        const method = bind();
        return (...args: unknown[]) => {
          method.construct();
          const call = bind();
          const resolve = () => {
            method.get();
            return call.get();
          };
          return lazy(
            (current) => {
              const sql = current();
              return Reflect.apply(Reflect.get(sql, key), sql, args.map(unwrap));
            },
            resolve,
            key === "file" ? resolve : call.compose,
          );
        };
      }
      const resolve = bind().get;
      const sql = resolve();
      const member = Reflect.get(sql, key);
      if (typeof member !== "function") return member;
      return (...args: unknown[]) => {
        if (resolve() !== sql) throw new Error("Database binding changed for a saved method");
        const values = args.map(unwrap);
        if (key === "reserve")
          return (async () => {
            const reserved = (await Reflect.apply(member, sql, values)) as Db & { release: () => void };
            let released = false;
            const release = () => {
              if (!released) {
                released = true;
                reserved.release();
              }
            };
            try {
              resolve();
            } catch (error) {
              release();
              throw error;
            }
            return wrap(
              () =>
                scoped(reserved, () => {
                  resolve();
                  if (released) throw new Error("Reserved database connection released");
                }),
              release,
            );
          })();
        if (key === "begin" || key === "savepoint") {
          const callback = values.at(-1);
          if (typeof callback === "function")
            values[values.length - 1] = async (tx: Db) => {
              const returned = callback(
                wrap(() =>
                  scoped(tx, () => {
                    resolve();
                  }),
                ),
              );
              // postgres.js recognises synchronous arrays before awaiting a callback's return value.
              // Our async validity check must preserve that eager Promise.all behaviour.
              const result = await (Array.isArray(returned) ? Promise.all(returned) : returned);
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
      const current = () => {
        const current = connections.get(module);
        if (!current) throw new Error(`Database connection not injected for module ${module}`);
        return current;
      };
      const get = () => {
        const registration = current();
        if (owner && owner !== registration) throw new Error(`Database binding changed for module ${module}`);
        owner ??= registration;
        return registration.sql;
      };
      return {
        get,
        compose: () => current().sql,
        construct: () => {
          if (owner || connections.has(module)) get();
        },
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
