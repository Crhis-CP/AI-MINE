// Bounded ZIP reader for price workbooks: entries are inflated only when read.
// Enforce entry count, declared and actual size, total size and archive boundaries.
import { inflateRawSync } from "node:zlib";

/** A workbook has tens of parts, a few MB uncompressed (the World Bank's: 31, 3.55 MB in all); these leave a wide margin. */
const LIMITS = { entries: 1_000, entryBytes: 16 * 2 ** 20, totalBytes: 32 * 2 ** 20 };

export function unzipEntries(buf: Buffer): Map<string, () => Buffer> {
  let eocd = -1;
  for (let i = buf.length - 22; i >= Math.max(0, buf.length - 65_557); i--) {
    if (buf.readUInt32LE(i) === 0x06054b50) {
      eocd = i;
      break;
    }
  }
  if (eocd < 0) throw new Error("not a zip archive");
  const count = buf.readUInt16LE(eocd + 10);
  if (count > LIMITS.entries) throw new Error(`zip has ${count} entries, the limit is ${LIMITS.entries}`);
  const directory = buf.readUInt32LE(eocd + 16);
  let p = directory;
  let total = 0;
  const out = new Map<string, () => Buffer>();
  for (let n = 0; n < count; n++) {
    if (p + 46 > eocd || buf.readUInt32LE(p) !== 0x02014b50) throw new Error("bad central directory");
    const method = buf.readUInt16LE(p + 10);
    const compressed = buf.readUInt32LE(p + 20);
    const size = buf.readUInt32LE(p + 24);
    const nameLen = buf.readUInt16LE(p + 28);
    const extraLen = buf.readUInt16LE(p + 30);
    const commentLen = buf.readUInt16LE(p + 32);
    const local = buf.readUInt32LE(p + 42);
    if (p + 46 + nameLen + extraLen + commentLen > eocd) throw new Error("bad central directory");
    const name = buf.subarray(p + 46, p + 46 + nameLen).toString("utf8");
    if (out.has(name)) throw new Error(`duplicate zip entry ${name}`);
    if (size > LIMITS.entryBytes) throw new Error(`zip entry ${name} declares ${size} bytes, the limit is ${LIMITS.entryBytes}`);
    total += size;
    if (total > LIMITS.totalBytes) throw new Error(`zip entries declare more than ${LIMITS.totalBytes} bytes in all`);
    // The local header and the data come before the central directory.
    if (local + 30 > directory || buf.readUInt32LE(local) !== 0x04034b50) throw new Error(`bad local header for ${name}`);
    const start = local + 30 + buf.readUInt16LE(local + 26) + buf.readUInt16LE(local + 28);
    if (start + compressed > directory) throw new Error(`zip entry ${name} runs past its data`);
    out.set(name, () => {
      const data = buf.subarray(start, start + compressed);
      let bytes: Buffer;
      if (method === 0) bytes = Buffer.from(data);
      // Inflating stops at the declared size, so a header that understates it cannot make the output grow.
      else if (method === 8) bytes = inflateRawSync(data, { maxOutputLength: Math.max(size, 1) });
      else throw new Error(`unsupported zip method ${method} for ${name}`);
      if (bytes.length !== size) throw new Error(`zip entry ${name} is ${bytes.length} bytes, not the declared ${size}`);
      return bytes;
    });
    p += 46 + nameLen + extraLen + commentLen;
  }
  return out;
}
