// Queue names are shared without importing event processing and its runtime dependencies.
export const EVENT_CONTINUATIONS = { consolidate: "news.events.consolidate", rematch: "news.events.rematch" } as const;
export const EVENT_CONTINUATION_OPTIONS = { policy: "short" as const, retryLimit: 4, retryDelay: 60, expireInSeconds: 600 };
