// Controlled interactive Owner approval of completed evaluation evidence. Never invokes a model.
import { readFile } from "node:fs/promises";
import { Writable } from "node:stream";
import { createInterface } from "node:readline/promises";
import { initializeDb, closeDb } from "@amp/backend/db";
import { passwordLogin, sessionPrincipal, SESSION_COOKIE, endSession } from "@amp/backend/admin/auth";
import { approveModelRoute, revokeModelRouteApproval } from "../packages/backend/src/providers/model-fallback-quality.ts";
let muted = false;
const output = new Writable({
  write(chunk, _encoding, done) {
    if (!muted) process.stdout.write(chunk);
    done();
  },
});
const cli = createInterface({ input: process.stdin, output, terminal: true });
let cookie: string | undefined;
try {
  if (!process.stdin.isTTY || !process.stdout.isTTY) throw new Error("仅在受控且不录屏的交互终端执行；不要把密码写入参数或文件");
  const operation = process.argv[2],
    file = process.argv[3];
  if (operation !== "approve" && operation !== "revoke") throw new Error("选择 approve 或 revoke，并提供 JSON 文件路径");
  if (!file) throw new Error("提供已审阅的资格 JSON 文件路径");
  const input = JSON.parse(await readFile(file, "utf8"));
  await initializeDb("private-api");
  const login = await cli.question("负责人登录名：");
  process.stdout.write("负责人密码（不显示）：");
  muted = true;
  let password = await cli.question("");
  muted = false;
  process.stdout.write("\n");
  const session = await passwordLogin(password, "/admin/models", "controlled-route-qualification", login, "controlled-route-qualification");
  password = "";
  cookie = `${SESSION_COOKIE}=${session.token}`;
  const principal = await sessionPrincipal(cookie);
  if (!principal) throw new Error("负责人身份验证失败");
  const confirm = await cli.question(
    operation === "revoke"
      ? `确认撤销 ${String(input.runId)} 的 ${String(input.approvalId)}？原评测保留。输入“确认”：`
      : `确认已审阅 ${String(input.runId)} 的金标、留出/密封集及影子/小流量结果，仅为 ${String(input.modelKey)} 的 ${String(input.capability)} 安装质量记录？输入“确认”：`,
  );
  if (confirm !== "确认") throw new Error("未确认，未写入资格");
  if (operation === "revoke") {
    await revokeModelRouteApproval(String(input.runId), String(input.approvalId), String(input.reason ?? ""), principal);
    process.stdout.write("质量记录已撤销，后续备用调用会重新核验并停止使用。\n");
  } else {
    const record = await approveModelRoute(input, principal);
    process.stdout.write(`质量记录已保存：${record.id}；来源 ${record.sourceIds.length} 项。备用仍需在模型页显式选择。\n`);
  }
} finally {
  if (cookie) await endSession(cookie);
  cli.close();
  await closeDb();
}
