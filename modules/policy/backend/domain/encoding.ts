export class PolicyEncodingError extends Error {}
export type PolicyDecodedOriginal = { text: string; encoding: string; basis: "header" | "bom" | "declaration" | "probe" };
function canonical(label: string) {
  if (!label.trim() || label.length > 64) throw new PolicyEncodingError("原件编码声明无效");
  try {
    return new TextDecoder(label.trim()).encoding;
  } catch {
    throw new PolicyEncodingError(`原件编码不支持：${label}`);
  }
}
function declarations(head: string) {
  const result: string[] = [];
  const xml = /^\s*<\?xml\b[^>]*\bencoding\s*=\s*["']([^"']+)["']/i.exec(head);
  if (xml) result.push(xml[1]!);
  for (const match of head.matchAll(/<meta\b[^>]*>/gi)) {
    const tag = match[0];
    const direct = /\bcharset\s*=\s*(?:["']\s*([^"']+)\s*["']|([^\s"'>;/]+))/i.exec(tag);
    if (direct) result.push((direct[1] ?? direct[2])!.trim());
  }
  return result;
}
/** Strict original decoding: higher-priority evidence selects the codec, but contradictory declarations never disappear. */
export function decodePolicyOriginal(bytes: Uint8Array, mediaType: string | null): PolicyDecodedOriginal {
  const body = Buffer.from(bytes);
  const headers = [...(mediaType ?? "").matchAll(/\bcharset\s*=\s*(?:"([^"]+)"|'([^']+)'|([^\s;]+))/gi)].map((m) => (m[1] ?? m[2] ?? m[3])!);
  const bom = body.subarray(0, 3).equals(Buffer.from([0xef, 0xbb, 0xbf]))
    ? "utf-8"
    : body.subarray(0, 2).equals(Buffer.from([0xff, 0xfe]))
      ? "utf-16le"
      : body.subarray(0, 2).equals(Buffer.from([0xfe, 0xff]))
        ? "utf-16be"
        : null;
  const signature = body[0] === 0x3c && body[1] === 0 && body[3] === 0 ? "utf-16le" : body[0] === 0 && body[1] === 0x3c && body[2] === 0 ? "utf-16be" : null;
  const head = new TextDecoder(bom ?? signature ?? "windows-1252").decode(body.subarray(0, 8192));
  const declared = declarations(head);
  const normalize = (label: string) => (/^utf-16$/i.test(label.trim()) && (bom?.startsWith("utf-16") || signature) ? (bom ?? signature)! : canonical(label));
  const evidence = [...headers, ...(bom ? [bom] : []), ...declared, ...(signature ? [signature] : [])].map(normalize);
  if (new Set(evidence).size > 1) throw new PolicyEncodingError("原件编码声明相互冲突");
  const encoding = evidence[0] ?? "utf-8";
  const basis = headers.length ? "header" : bom ? "bom" : declared.length ? "declaration" : "probe";
  let text: string;
  try {
    text = new TextDecoder(encoding, { fatal: true }).decode(body);
  } catch {
    throw new PolicyEncodingError(`原件无法按${encoding}编码完整解码，来源编码待核实`);
  }
  if (text.includes("\0") || text.includes("\uFFFD")) throw new PolicyEncodingError("原件字符完整性未通过");
  // Without a declaration, only a complete Unicode round trip or an XML/HTML UTF-16 byte signature proves this probe.
  if (basis === "probe") {
    const encoded = encoding === "utf-8" ? Buffer.from(text, "utf8") : Buffer.from(text, "utf16le");
    if (encoding === "utf-16be") encoded.swap16();
    if (!encoded.equals(body)) throw new PolicyEncodingError("原件编码探测无法无损验证");
  }
  return { text, encoding, basis };
}
