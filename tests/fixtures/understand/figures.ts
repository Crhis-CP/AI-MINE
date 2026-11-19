// Synthetic source and copy pairs for the figure check. `copy` is the Chinese summary; `flags` lists each figure the
// check must report, as `token problem class`. A pair with no flags must come out ok.
export interface FigurePair {
  name: string;
  copy: string;
  source: string;
  language?: string;
  /** The article's own date; 2026-11-18 when not given. */
  sourceDate?: string | null;
  occurredAt?: string;
  complete?: boolean;
  hasImage?: boolean;
  mask?: string[];
  flags?: string[];
}

export const FIGURE_PAIRS: FigurePair[] = [
  // Scale words, in each language
  { name: "billion", copy: "力拓批准25亿美元扩建计划", source: "Rio Tinto approves $2.5 billion expansion" },
  {
    name: "billion read as 亿",
    copy: "力拓批准2.5亿美元扩建计划",
    source: "Rio Tinto approves $2.5 billion expansion",
    flags: ["2.5亿美元 scale_mismatch hard"],
  },
  { name: "bn", copy: "收购价约31亿美元", source: "a deal valued at US$3.1bn" },
  { name: "B letter", copy: "收购价31亿美元", source: "a US$3.1B deal" },
  { name: "M letter", copy: "融资3亿美元", source: "raised $300M in new equity" },
  { name: "million", copy: "投入1200万美元勘探", source: "will spend $12 million on exploration" },
  { name: "million read as 亿", copy: "投入12亿美元勘探", source: "will spend $12 million on exploration", flags: ["12亿美元 scale_mismatch hard"] },
  { name: "thousand", copy: "产量4.5万吨", source: "output of 45 thousand tonnes" },
  { name: "k letter", copy: "产量4万吨", source: "about 40k tonnes" },
  { name: "trillion", copy: "规模达1.2万亿美元", source: "a $1.2 trillion market" },
  { name: "mil millones", copy: "投资25亿美元", source: "invertirá 2,5 mil millones de dólares", language: "es" },
  { name: "millones with thousands dot", copy: "投资25亿美元", source: "invertirá 2.500 millones de dólares", language: "es" },
  {
    name: "millones read as 亿",
    copy: "投资2.5亿美元",
    source: "invertirá 2.500 millones de dólares",
    language: "es",
    flags: ["2.5亿美元 scale_mismatch hard"],
  },
  { name: "billón is a trillion", copy: "资产1.5万亿比索", source: "activos por 1,5 billones de pesos", language: "es" },
  { name: "mil (thousand)", copy: "产量30万吨", source: "una producción de 300 mil toneladas", language: "es" },
  { name: "bilhões", copy: "投资42亿雷亚尔", source: "investimento de R$ 4,2 bilhões", language: "pt" },
  { name: "mil milhões", copy: "投资18亿欧元", source: "um investimento de 1,8 mil milhões de euros", language: "pt" },
  { name: "milliards", copy: "投资30亿欧元", source: "un investissement de 3 milliards d'euros", language: "fr" },
  { name: "млрд", copy: "投资100亿卢布", source: "инвестиции 10 млрд рублей", language: "ru" },
  // Number words
  { name: "half a billion", copy: "投资5亿美元", source: "a half a billion dollar investment" },
  { name: "two million tonnes", copy: "储量200万吨", source: "two million tonnes of ore" },
  { name: "dos millones", copy: "储量200万吨", source: "dos millones de toneladas", language: "es" },
  // Units carrying the scale letter
  { name: "Mt", copy: "年产120万吨", source: "to produce 1.2Mt a year" },
  { name: "koz", copy: "黄金产量25万盎司", source: "gold output of 250koz" },
  { name: "Mlb", copy: "铜产量3000万磅", source: "30Mlb of copper" },
  { name: "ktpa", copy: "产能每年5万吨", source: "a 50ktpa plant" },
  { name: "Mtpa", copy: "设计产能每年2500万吨", source: "a 25Mtpa concentrator" },
  // Separators and precision
  { name: "decimal comma", copy: "铜品位0.45%", source: "una ley de 0,45% de cobre", language: "es" },
  { name: "decimal comma misread", copy: "铜品位45%", source: "una ley de 0,45% de cobre", language: "es", flags: ["45% absent soft"] },
  { name: "thousands comma", copy: "钻探1234米", source: "drilled 1,234 metres" },
  { name: "rounded", copy: "约25亿美元", source: "a US$2.47 billion investment" },
  { name: "truncated", copy: "24亿美元", source: "a US$2.47 billion investment" },
  { name: "more than", copy: "超过30亿美元", source: "a US$3.2 billion investment" },
  { name: "round thousands", copy: "裁员3000人", source: "about 2,980 jobs will go" },
  { name: "wrong amount", copy: "投资35亿美元", source: "a US$2.5 billion investment", flags: ["35亿美元 absent hard"] },
  { name: "range", copy: "投资10至12亿美元", source: "between $1 billion and $1.2 billion" },
  { name: "chinese numerals", copy: "储量两千万吨", source: "20 million tonnes of reserves" },
  // Percent
  { name: "percent", copy: "产量下降12%", source: "output fell 12 percent" },
  { name: "per cent", copy: "股价上涨5.5%", source: "shares rose 5.5 per cent" },
  { name: "por ciento", copy: "产量增长8%", source: "la producción creció 8 por ciento", language: "es" },
  { name: "百分之", copy: "成本下降百分之五", source: "costs fell 5%" },
  { name: "basis points", copy: "利率下调0.5个百分点", source: "cut rates by 50 basis points" },
  { name: "percent not in source", copy: "利润增长30%", source: "profit rose sharply", flags: ["30% absent soft"] },
  // Dates
  { name: "date", copy: "公司于11月18日宣布", source: "announced on November 18, 2026" },
  { name: "date one day off", copy: "公司于11月17日宣布", source: "announced on November 18, 2026" },
  { name: "wrong date", copy: "公司于11月8日宣布", source: "announced on November 18, 2026", flags: ["11月8日 absent hard"] },
  { name: "full date", copy: "2026年11月18日签约", source: "signed on 18 November 2026" },
  { name: "spanish date", copy: "11月18日签约", source: "firmado el 18 de noviembre", language: "es" },
  { name: "portuguese date", copy: "11月18日签约", source: "assinado em 18 de novembro de 2026", language: "pt" },
  { name: "french date", copy: "11月18日签约", source: "signé le 18 novembre 2026", language: "fr" },
  { name: "numeric date day first", copy: "11月18日签约", source: "firmado el 18/11/2026", language: "es" },
  { name: "iso date", copy: "11月18日签约", source: "signed 2026-11-18" },
  { name: "the article's own date", copy: "11月18日宣布", source: "The company said it had signed." },
  { name: "yesterday", copy: "11月17日宣布", source: "The company said yesterday it had signed." },
  { name: "a weekday", copy: "11月16日宣布", source: "The company said on Monday it had signed." },
  { name: "no relative word", copy: "11月12日宣布", source: "The company said it had signed.", flags: ["11月12日 absent hard"] },
  { name: "fact date", copy: "公司宣布签约", source: "on Nov. 18, 2026 the company signed", occurredAt: "2026-11-08", flags: ["2026-11-08 absent hard"] },
  { name: "month", copy: "预计12月投产", source: "production is expected in December" },
  // Years, quarters, halves, fiscal years
  { name: "year", copy: "2027年投产", source: "first production in 2027" },
  { name: "next year", copy: "2027年投产", source: "production will start next year" },
  { name: "next year misread", copy: "2029年投产", source: "production will start next year", flags: ["2029年 absent hard"] },
  { name: "year range", copy: "2026至2030年规划", source: "the 2026-2030 plan" },
  { name: "quarter", copy: "第三季度产量创纪录", source: "record third-quarter output" },
  { name: "Q3", copy: "三季度利润", source: "Q3 profit" },
  { name: "trimestre", copy: "第三季度产量", source: "la producción del tercer trimestre", language: "es" },
  { name: "half", copy: "上半年利润", source: "H1 profit" },
  { name: "fiscal year", copy: "2026财年产量", source: "FY26 output guidance" },
  { name: "quarter not in source", copy: "四季度利润", source: "annual profit", flags: ["四季度 absent soft"] },
  // What is not checked
  { name: "small integers", copy: "3家公司组成财团", source: "a group of companies" },
  { name: "names with digits", copy: "南32出售矿山", source: "South32 sells mine", mask: ["南32", "South32"] },
  { name: "numeral words", copy: "推进一体化运营，十分重要", source: "integration matters" },
  { name: "time of day", copy: "上午10:30宣布", source: "announced in the morning" },
  // Caps
  { name: "incomplete body", copy: "投资35亿美元", source: "a US$2.5 billion investment", complete: false, flags: ["35亿美元 absent soft"] },
  { name: "image", copy: "投资35亿美元", source: "a US$2.5 billion investment", hasImage: true, flags: ["35亿美元 absent soft"] },
  { name: "unread language", copy: "投资35亿美元", source: "инвестиции 2,5 млрд долларов", language: "ru", flags: ["35亿美元 absent soft"] },
  { name: "another currency", copy: "约180亿元", source: "a US$2.5 billion investment", flags: ["180亿元 absent soft"] },
  { name: "metric from imperial", copy: "产量4.5万吨", source: "50,000 short tons of ore", flags: ["4.5万吨 absent soft"] },
  // A Chinese source
  { name: "chinese source", copy: "拟投资25亿元建设", source: "公司拟投资25亿元建设新矿", language: "zh" },
  { name: "chinese source date", copy: "11月18日签约", source: "双方于11月18日签约", language: "zh" },
];
