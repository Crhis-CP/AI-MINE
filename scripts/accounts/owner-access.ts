// Fixed server-side setup/recovery entry. Never exposed through the website.
// A production operator registers this exact script in the trusted cloud operation console.
import { initializeDb, closeDb } from "@amp/backend/db";
import { provisionFirstOwner, recoverOwnerPassword } from "../../packages/backend/src/admin/accounts.ts";
import { createInterface } from "node:readline/promises";
const cli = createInterface({ input: process.stdin, output: process.stdout });
try {
  if (!process.stdin.isTTY || !process.stdout.isTTY) throw new Error("账号恢复必须在不录屏、不留输出日志的受控交互终端执行。");
  const command = process.argv[2];
  if (command !== "provision" && command !== "recover") throw new Error("选择 provision 首次开通，或 recover 恢复既有负责人。");
  await initializeDb("private-api");
  const reason = await cli.question("填写本次操作依据：");
  let result: Awaited<ReturnType<typeof provisionFirstOwner>>;
  if (command === "provision") {
    const loginName = await cli.question("已核对的负责人登录名："),
      displayName = await cli.question("负责人显示名称："),
      existing = await cli.question("已有账号编号（新建留空）：");
    if (existing && !/^[1-9][0-9]*$/u.test(existing)) throw new Error("账号编号无效。");
    result = await provisionFirstOwner({ loginName, displayName, reason, ...(existing ? { existingUserId: Number(existing) } : {}) });
  } else result = await recoverOwnerPassword(reason);
  process.stdout.write(
    `\n登录名：${result.loginName}\n一次性临时密码：${result.temporaryPassword}\n15分钟内有效，首次登录后必须修改。请勿复制到聊天或工单。\n`,
  );
} finally {
  cli.close();
  await closeDb();
}
