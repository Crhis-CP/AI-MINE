/** Normalize a bounded data literal to JSON. No identifiers as values, calls, getters or code execution. */
export function staticLiteralJson(input: string): string {
  if (input.length > 10_000_000) throw new Error("static data exceeds size limit");
  let at = 0;
  const fail = (): never => {
    throw new Error(`invalid static data at ${at}`);
  };
  const space = () => {
    while (at < input.length && /\s/.test(input[at]!)) at++;
  };
  const string = (): string => {
    const quote = input[at++];
    let value = "";
    while (at < input.length) {
      const char = input[at++]!;
      if (char === quote) return JSON.stringify(value);
      if (char < " " || char === "\u2028" || char === "\u2029") fail();
      if (char !== "\\") {
        value += char;
        continue;
      }
      const escaped = input[at++];
      const escapes: Record<string, string> = { "'": "'", '"': '"', "\\": "\\", "/": "/", b: "\b", f: "\f", n: "\n", r: "\r", t: "\t" };
      if (escaped && Object.hasOwn(escapes, escaped)) value += escapes[escaped];
      else if (escaped === "u" || escaped === "x") {
        const size = escaped === "u" ? 4 : 2,
          hex = input.slice(at, at + size);
        if (hex.length !== size || !/^[0-9a-f]+$/i.test(hex)) fail();
        value += String.fromCharCode(Number.parseInt(hex, 16));
        at += size;
      } else fail();
    }
    return fail();
  };
  const value = (depth: number): string => {
    if (depth > 64) fail();
    space();
    const char = input[at];
    if (char === "'" || char === '"') return string();
    if (char === "[" || char === "{") {
      at++;
      const close = char === "[" ? "]" : "}",
        parts: string[] = [];
      space();
      while (input[at] !== close) {
        let key = "";
        if (char === "{") {
          if (input[at] === "'" || input[at] === '"') key = string();
          else {
            const name = /^[a-z_$][\w$]*/i.exec(input.slice(at))?.[0];
            if (!name) return fail();
            key = JSON.stringify(name);
            at += name.length;
          }
          space();
          if (input[at++] !== ":") fail();
          key += ":";
        }
        parts.push(key + value(depth + 1));
        space();
        if (input[at] === close) break;
        if (input[at++] !== ",") fail();
        space();
      }
      at++;
      return char + parts.join(",") + close;
    }
    const token = /^(?:true|false|null|-?(?:0|[1-9]\d*)(?:\.\d+)?(?:[eE][+-]?\d+)?)/.exec(input.slice(at))?.[0];
    if (!token || (/^-?\d/.test(token) && !Number.isFinite(Number(token)))) return fail();
    at += token.length;
    return token;
  };
  const result = value(0);
  space();
  if (at !== input.length) fail();
  return result;
}
