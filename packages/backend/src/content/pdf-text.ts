import { Worker } from "node:worker_threads";

export const PDF_TEXT_LIMITS = { bytes: 6 * 1024 * 1024, pages: 100, itemsPerPage: 20_000, characters: 1_000_000, timeoutMs: 15_000 } as const;
export class PdfPasswordRequired extends Error {}
let reading: Promise<unknown> = Promise.resolve();

/** One bounded parser at a time; the existing extraction jobs retain scheduling and permissions. */
export function readPdfText(bytes: Uint8Array): Promise<string> {
  const next = reading.then(async () => {
    if (bytes.byteLength > PDF_TEXT_LIMITS.bytes || ![37, 80, 68, 70, 45].every((value, i) => bytes[i] === value))
      throw new Error("PDF格式或文件容量不符合读取要求");
    const data = Uint8Array.from(bytes);
    const worker = new Worker(new URL("./pdf-text-worker.ts", import.meta.url), {
      workerData: data,
      transferList: [data.buffer],
      env: {},
      execArgv: [],
      resourceLimits: { maxOldGenerationSizeMb: 128, stackSizeMb: 4 },
    });
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      return await new Promise<string>((resolve, reject) => {
        timer = setTimeout(() => reject(new Error("PDF文字读取超时")), PDF_TEXT_LIMITS.timeoutMs);
        worker.once("message", (value: unknown) => {
          if (typeof value !== "string" || value.length > PDF_TEXT_LIMITS.characters) reject(new Error("PDF文字结果不符合读取要求"));
          else resolve(value);
        });
        worker.once("error", (error) => {
          if (error.name === "PasswordException") reject(new PdfPasswordRequired("PDF需要密码，不能直接读取"));
          else reject(new Error(error.name === "PdfCapacity" ? "PDF超过本地文字读取容量" : "PDF文字读取未完成"));
        });
        worker.once("exit", () => reject(new Error("PDF文字读取进程已退出")));
      });
    } finally {
      clearTimeout(timer);
      await worker.terminate();
    }
  });
  reading = next.catch(() => undefined);
  return next;
}
