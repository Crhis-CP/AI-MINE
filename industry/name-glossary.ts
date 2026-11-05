/**
 * 外国主体的通行中文名与原文名（Owner 2026-11-05：标题和摘要都用中文，首次出现写“中文名（原文名）”，方便读者）。
 * 只收确有通行中文名的；拿不准的不收，原文照留。`en` 是括注里显示的写法，`aliases` 是原文里常见的其他写法。
 * 只收外国主体：中国企业用其官方中文名，不括注英文（提示词同此）。提示词里的名单
 * （prompts/rules-domain-names.md 与 rules-domain-names-extra.md）须与这里一致，测试会核对。
 */
export interface NameEntry {
  zh: string;
  en: string;
  aliases?: string[];
}

export const NAME_GLOSSARY: readonly NameEntry[] = [
  { zh: "必和必拓", en: "BHP", aliases: ["BHP Group"] },
  { zh: "力拓", en: "Rio Tinto" },
  { zh: "嘉能可", en: "Glencore" },
  { zh: "淡水河谷", en: "Vale" },
  { zh: "英美资源", en: "Anglo American" },
  { zh: "自由港麦克莫兰", en: "Freeport-McMoRan", aliases: ["Freeport McMoRan"] },
  { zh: "纽蒙特", en: "Newmont" },
  { zh: "巴里克", en: "Barrick", aliases: ["Barrick Gold", "Barrick Mining"] },
  { zh: "第一量子", en: "First Quantum", aliases: ["First Quantum Minerals"] },
  { zh: "艾芬豪矿业", en: "Ivanhoe Mines" },
  { zh: "智利国家铜业公司", en: "Codelco" },
  { zh: "南方铜业", en: "Southern Copper" },
  { zh: "雅宝", en: "Albemarle" },
  { zh: "智利化工矿业", en: "SQM" },
  { zh: "泰克资源", en: "Teck Resources", aliases: ["Teck"] },
  { zh: "安托法加斯塔", en: "Antofagasta", aliases: ["Antofagasta Minerals"] },
  { zh: "福蒂斯丘", en: "Fortescue", aliases: ["Fortescue Metals"] },
  { zh: "南32", en: "South32" },
  { zh: "诺里尔斯克镍业", en: "Nornickel", aliases: ["Norilsk Nickel"] },
  { zh: "金田", en: "Gold Fields" },
  { zh: "盎格鲁黄金阿散蒂", en: "AngloGold Ashanti" },
  { zh: "金罗斯", en: "Kinross", aliases: ["Kinross Gold"] },
  { zh: "西班耶-斯蒂尔沃特", en: "Sibanye-Stillwater" },
  { zh: "托克", en: "Trafigura" },
  { zh: "摩科瑞", en: "Mercuria" },
];
