import { environmentValue } from "../config.ts";
import { createCipheriv, createDecipheriv, createHmac, randomBytes } from "node:crypto";
export class ModelStorageUnavailable extends Error {
  readonly statusCode = 503;
  constructor() {
    super("模型密钥保护配置不可用，请由部署管理员配置安全存储");
  }
}
function masterKey() {
  const value = environmentValue("MODEL_REGISTRY_ENCRYPTION_KEY");
  if (!value || !/^[A-Za-z0-9+/]{43}=$/.test(value)) throw new ModelStorageUnavailable();
  const key = Buffer.from(value, "base64");
  if (key.length !== 32 || key.toString("base64") !== value) throw new ModelStorageUnavailable();
  return key;
}
export function modelStorageReady() {
  try {
    masterKey();
    return true;
  } catch {
    return false;
  }
}
export type SealedModelSecret = { ciphertext: string; iv: string; tag: string; fingerprint: string };
export function sealModelSecret(secret: string, context: string): SealedModelSecret {
  if (!secret || /[\r\n\0]/.test(secret)) throw new Error("密钥格式无效");
  const key = masterKey(),
    iv = randomBytes(12),
    cipher = createCipheriv("aes-256-gcm", key, iv);
  cipher.setAAD(Buffer.from(context));
  const ciphertext = Buffer.concat([cipher.update(secret, "utf8"), cipher.final()]);
  return {
    ciphertext: ciphertext.toString("base64"),
    iv: iv.toString("base64"),
    tag: cipher.getAuthTag().toString("base64"),
    fingerprint: createHmac("sha256", key).update(secret).digest("hex").slice(0, 24),
  };
}
export function openModelSecret(sealed: SealedModelSecret, context: string): string {
  try {
    const decipher = createDecipheriv("aes-256-gcm", masterKey(), Buffer.from(sealed.iv, "base64"));
    decipher.setAAD(Buffer.from(context));
    decipher.setAuthTag(Buffer.from(sealed.tag, "base64"));
    return Buffer.concat([decipher.update(Buffer.from(sealed.ciphertext, "base64")), decipher.final()]).toString("utf8");
  } catch {
    throw new ModelStorageUnavailable();
  }
}
/** Provider errors and responses are untrusted; a provider can echo an authorization value. */
export const redactModelSecret = (value: string, secret: string) =>
  value.split(secret).join("[redacted]").split(JSON.stringify(secret).slice(1, -1)).join("[redacted]");
