// Explicit preload in the isolated web child only; timers and the verifier's own clock remain real.
import { FIXED_TIME } from "./time.ts";
const Original = Date;
const fixed = Original.parse(FIXED_TIME);
const ClockDate = function (this: unknown, ...args: unknown[]) {
  return new.target ? Reflect.construct(Original, args.length ? args : [fixed], new.target) : new Original(fixed).toString();
};
Object.setPrototypeOf(ClockDate, Original);
ClockDate.prototype = Original.prototype;
Object.defineProperty(ClockDate, "now", { value: () => fixed });
globalThis.Date = ClockDate as DateConstructor;
