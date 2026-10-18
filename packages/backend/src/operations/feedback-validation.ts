import { FEEDBACK_LIMITS } from "@amp/contracts/http/public";
import sharp from "sharp";
import { config } from "../config.ts";

export class FeedbackRejected extends Error {
  readonly status: number;
  readonly code: string;
  readonly retryAfter?: number;
  constructor(status: number, code: string, message: string, retryAfter?: number) {
    super(message);
    this.status = status;
    this.code = code;
    this.retryAfter = retryAfter;
  }
}

export function feedbackPageUrl(input?: string | null): string | null {
  const value = input?.trim();
  if (!value) return null;
  const reject = () => new FeedbackRejected(400, "invalid_request", "相关页面请使用 AI矿策网站地址（最多2048字符）。");
  if (value.length > 2048 || value.includes("\\") || [...value].some((char) => char.charCodeAt(0) < 32 || char.charCodeAt(0) === 127)) throw reject();
  try {
    const site = new URL(config.siteUrl);
    const absolute = /^https?:\/\//i.test(value);
    if (!absolute && (!value.startsWith("/") || value.startsWith("//"))) throw reject();
    const url = new URL(value, site);
    if (!/^https?:$/.test(url.protocol) || url.origin !== site.origin || url.username || url.password) throw reject();
    return value;
  } catch {
    throw reject();
  }
}

/** Decode bounded pixels and re-encode, stripping EXIF/ICC and ignoring the untrusted MIME claim. */
export async function feedbackImage(input?: { mime: string; data: Buffer } | null): Promise<{ data: Buffer; extension: string } | null> {
  if (!input) return null;
  const data = input.data;
  if (data.length > FEEDBACK_LIMITS.screenshotBytes) throw new FeedbackRejected(400, "invalid_request", "截图最大 8MB。");
  const bad = () => new FeedbackRejected(400, "invalid_request", "图片需为有效的 PNG、JPEG、WebP 或 GIF，大小不超过8MB，总像素不超过6000万。");
  const format = data.subarray(0, 8).equals(Buffer.from("89504e470d0a1a0a", "hex"))
    ? "png"
    : data.length >= 3 && data[0] === 0xff && data[1] === 0xd8 && data[2] === 0xff
      ? "jpeg"
      : data.length >= 12 && data.toString("ascii", 0, 4) === "RIFF" && data.toString("ascii", 8, 12) === "WEBP"
        ? "webp"
        : data.length >= 6 && /^GIF8[79]a$/.test(data.toString("ascii", 0, 6))
          ? "gif"
          : null;
  if (!format) throw bad();
  try {
    const decoder = sharp(data, { animated: true, limitInputPixels: FEEDBACK_LIMITS.imagePixels, failOn: "warning" });
    const metadata = await decoder.metadata();
    if (
      metadata.format !== format ||
      !metadata.width ||
      !metadata.height ||
      metadata.width * (metadata.pageHeight ?? metadata.height) * (metadata.pages ?? 1) > FEEDBACK_LIMITS.imagePixels
    )
      throw bad();
    return { data: await ((metadata.pages ?? 1) > 1 ? decoder : decoder.rotate()).toFormat(format).toBuffer(), extension: format };
  } catch {
    throw bad();
  }
}
