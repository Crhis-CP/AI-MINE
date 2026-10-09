import { sendAlert } from "../notify/feishu.ts";
import { audit } from "./auth.ts";
/** Redacted operational notice; failures are recorded without reversing a completed account change. */
export async function accountNotice(kind: "owner_recovery" | "account_change" | "login_traffic", subject: string | null) {
  const title = kind === "owner_recovery" ? "负责人登录恢复已执行" : kind === "login_traffic" ? "后台登录请求增多" : "后台账号权限已更新";
  const lines =
    kind === "owner_recovery"
      ? ["旧会话已撤销；临时密码只能使用一次，15分钟内有效。", "如非预期操作，请通过已登记的服务器恢复渠道核查。"]
      : kind === "login_traffic"
        ? ["来源与账号限速继续生效；其他账号仍可登录，公开阅读不受影响。"]
        : ["相关账号的旧会话已撤销，请在后台账号页核对当前权限。"];
  let delivery: string;
  try {
    delivery = await sendAlert(title, lines);
  } catch {
    delivery = "failed";
  }
  await audit("system", "auth.notice", subject, null, null, { kind, delivery }).catch(() => undefined);
}
