import { argon2, randomBytes, timingSafeEqual } from "node:crypto";
const PARAMETERS = { parallelism: 1, tagLength: 32, memory: 65536, passes: 3 } as const;
const base64 = (bytes: Uint8Array) => Buffer.from(bytes).toString("base64").replace(/=+$/u, "");
const derive = (password: string, salt: Uint8Array) =>
  new Promise<Buffer>((resolve, reject) =>
    argon2("argon2id", { ...PARAMETERS, message: Buffer.from(password, "utf8"), nonce: salt }, (error, key) => (error ? reject(error) : resolve(key))),
  );
/** Fixed, bounded Argon2id parameters; neither stored strings nor requests can choose a costly work factor. */
export async function hashAccountPassword(password: string) {
  if (password.length < 12 || password.length > 128) throw new Error("密码需为12–128个字符。");
  const salt = randomBytes(16),
    hash = await derive(password, salt);
  return `$argon2id$v=19$m=65536,t=3,p=1$${base64(salt)}$${base64(hash)}`;
}
/** Unknown accounts and malformed hashes perform the same bounded derivation before giving the same rejection. */
export async function verifyAccountPassword(password: string, encoded: string | null) {
  const match = /^\$argon2id\$v=19\$m=65536,t=3,p=1\$([A-Za-z0-9+/]{22})\$([A-Za-z0-9+/]{43})$/u.exec(encoded ?? "");
  const salt = match ? Buffer.from(match[1]!, "base64") : Buffer.alloc(16),
    expected = match ? Buffer.from(match[2]!, "base64") : Buffer.alloc(32);
  const actual = await derive(password.slice(0, 256), salt);
  return !!match && password.length <= 256 && salt.length === 16 && expected.length === 32 && timingSafeEqual(actual, expected);
}
