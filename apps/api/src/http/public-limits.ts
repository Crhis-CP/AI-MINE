import { createHmac } from "node:crypto";
/** Bounded anonymous-read rate guard. Only keyed digests stay in memory; raw client addresses are never logged. */
export function publicReadLimiter(secret: string, limit = 600, now: () => number = Date.now) {
  const clients = new Map<string, { window: number; count: number }>();
  return (client: string): number => {
    const time = now(),
      window = Math.floor(time / 60_000);
    const key = createHmac("sha256", secret).update(client).digest("hex");
    if (clients.size >= 50_000) {
      for (const [id, value] of clients) if (value.window < window) clients.delete(id);
      if (!clients.has(key) && clients.size >= 50_000) return 60 - Math.floor((time % 60_000) / 1000);
    }
    const old = clients.get(key),
      value = old?.window === window ? old : { window, count: 0 };
    value.count += 1;
    clients.set(key, value);
    return value.count > limit ? 60 - Math.floor((time % 60_000) / 1000) : 0;
  };
}
