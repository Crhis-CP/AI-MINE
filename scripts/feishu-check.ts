// Checks the Feishu set-up for operations alerts (TASK-0062): reads the server's Feishu settings, asks Feishu which chats the message app's bot
// is in, and says in plain words what is missing. Read-only, no database; only --send, which sends one test message to the alert chat, shows
// that alerts get through. It never prints the App Secret, the tenant token or request headers. Run it on the server as a deployment step:
//   docker compose run --rm --no-deps worker node scripts/feishu-check.ts [--send]
import { feishuSettingsSummary, listBotChats, sendAlert } from "@amp/backend/notify/deliver";

const USAGE = "用法：node scripts/feishu-check.ts [--send]";

/** Feishu's own words from an error, without our "feishu token:" / "feishu chats:" / "feishu send:" prefix. */
const feishuSays = (error: unknown) => (error instanceof Error ? error.message : String(error)).replace(/^feishu (token|chats|send): /, "");

export async function main(argv: string[], print: (line: string) => void): Promise<number> {
  const unknown = argv.filter((arg) => arg !== "--send");
  if (unknown.length) {
    print(`不认识的参数：${unknown.join(" ")}`);
    print(USAGE);
    return 2;
  }
  const send = argv.includes("--send");
  const s = feishuSettingsSummary();
  let ok = true;

  if (s.enabled) print("提醒开关：开着（FEISHU_INTERNAL_ENABLED=true）。");
  else if (!s.switchValue) print("提醒开关：关着（FEISHU_INTERNAL_ENABLED 没填），提醒不会发出去。");
  else print(`提醒开关：写的是“${s.switchValue}”。开关只认 true，现在等于关着，提醒不会发出去。`);
  if (!s.enabled) ok = false;

  print(`应用凭据：App ID ${s.appIdSet ? "已填" : "没填"}，App Secret ${s.appSecretSet ? "已填" : "没填"}。`);
  if (!s.appIdSet || !s.appSecretSet) {
    print("先经安全录入填好飞书自建应用的 App ID 和 App Secret，再跑一次。没有向飞书发任何请求。");
    return 1;
  }

  let chats: Array<{ chatId: string; name: string }>;
  try {
    chats = await listBotChats();
  } catch (error) {
    if (error instanceof Error && error.name === "FeishuTokenError") {
      if (error.message.startsWith("feishu token:")) print(`取令牌：飞书没有接受这对应用凭据。飞书的说明：${feishuSays(error)}`);
      else print(`取令牌：连不上飞书，稍后再试。出错的说明：${feishuSays(error)}`);
    } else if (error instanceof Error && error.message.startsWith("feishu chats:")) {
      print("列群：列不出机器人所在的群。多半是应用还没开“获取群组信息”权限，或者开了权限还没发布新版本。");
      print(`飞书的说明：${feishuSays(error)}`);
    } else print(`列群：连不上飞书，稍后再试。出错的说明：${feishuSays(error)}`);
    return 1;
  }
  print("取令牌：飞书接受了这对应用凭据。");
  if (chats.length === 0) {
    print("机器人所在的群：一个也没有。先把机器人拉进提醒群。");
    ok = false;
  } else {
    print(`机器人所在的群（${chats.length} 个）：`);
    for (const chat of chats) print(`  ${chat.name || "（没有群名）"}（${chat.chatId}）`);
  }
  const nameOf = (chatId: string) => chats.find((chat) => chat.chatId === chatId)?.name;

  if (!s.alertTarget) {
    print("提醒群：没填群号（FEISHU_ALERT_CHAT_ID、FEISHU_INTERNAL_CHAT_ID 都没填），提醒发不出去。从上面的列表里选一个群号填上。");
    ok = false;
  } else if (!s.alertChatId) {
    print(`提醒群：没填 FEISHU_ALERT_CHAT_ID，提醒会发到反馈群（${s.alertTarget}）。`);
  } else if (nameOf(s.alertChatId) === undefined) {
    print(`提醒群：群号 ${s.alertChatId} 不在机器人所在的群里。先把机器人拉进群，或改正群号。`);
    ok = false;
  } else {
    print(`提醒群：${nameOf(s.alertChatId) || "（没有群名）"}（${s.alertChatId}），机器人在群里。`);
  }

  if (!s.feedbackChatId) print("反馈群：没填，读者反馈不转发到飞书（Owner 确认隐私说明之前，这是正常的）。");
  else if (nameOf(s.feedbackChatId) === undefined) {
    print(`反馈群：群号 ${s.feedbackChatId} 不在机器人所在的群里。先把机器人拉进群，或改正群号。`);
    ok = false;
  } else print(`反馈群：${nameOf(s.feedbackChatId) || "（没有群名）"}（${s.feedbackChatId}），机器人在群里。`);

  if (s.alertChatId && s.feedbackChatId && s.alertChatId === s.feedbackChatId) {
    print("提示：提醒群和反馈群是同一个群；反馈里有读者的联系方式和截图，建议分开。");
  }

  if (send) {
    if (!s.enabled) {
      print("--send：开关没开，什么也没发。");
      ok = false;
    } else if (!s.alertTarget) {
      print("--send：没有提醒群，什么也没发。");
      ok = false;
    } else {
      try {
        const result = await sendAlert("【测试】运行提醒已接通", ["这是接通检查发的测试消息，不用处理。"]);
        if (result === "sent") print("--send：已发到提醒群，请在飞书里看一眼。");
        else {
          print("--send：没有发出去。");
          ok = false;
        }
      } catch (error) {
        print(`--send：发送失败。多半是应用没开“以应用的身份发消息”权限、开了还没发布新版本，或机器人不在提醒群里。飞书的说明：${feishuSays(error)}`);
        ok = false;
      }
    }
  }

  if (ok && !send) print("结论：通过（设置和群都对）；能不能真的发出去，加 --send 发一条测试消息确认。");
  else print(ok ? "结论：通过，提醒能发出去。" : "结论：没通过，照上面说的改好以后再跑一次。");
  return ok ? 0 : 1;
}

if (import.meta.main) process.exit(await main(process.argv.slice(2), (line) => console.log(line)));
