import { isIP } from "node:net";

export function clientNetwork(ip: string): string {
  if (isIP(ip) !== 6) return ip;
  const [head = "", tail] = ip.toLowerCase().split("%", 1)[0]!.split("::", 2);
  const left = head ? head.split(":") : [],
    right = tail ? tail.split(":") : [];
  const dotted = (right.at(-1) ?? left.at(-1) ?? "").includes(".");
  const width = left.length + right.length + (dotted ? 1 : 0);
  const groups = tail === undefined ? left : [...left, ...Array<string>(8 - width).fill("0"), ...right];
  if (groups.slice(0, 5).every((group) => /^0+$/.test(group)) && groups[5] === "ffff") {
    if (dotted) return groups.at(-1)!;
    const high = Number.parseInt(groups[6]!, 16),
      low = Number.parseInt(groups[7]!, 16);
    return `${high >> 8}.${high & 255}.${low >> 8}.${low & 255}`;
  }
  return `${groups
    .slice(0, 4)
    .map((group) => Number.parseInt(group, 16).toString(16))
    .join(":")}::/64`;
}
