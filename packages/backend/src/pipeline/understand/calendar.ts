// Calendar words of the source languages the news line reads most (en, es, pt, fr): month names, and the words that
// make a date or a year relative to the day an article was written. Shared by the dateline reader and the figure
// check, so the two cannot disagree on what counts as a date. Pure.

/** Month names and their usual short forms, lower case, each with its month number. */
const MONTH_NAMES: Record<string, number> = {};
for (const [month, names] of [
  [1, "january jan enero ene janeiro janvier janv"],
  [2, "february feb febrero fevereiro fev février févr fevrier fevr"],
  [3, "march mar marzo março marco mars"],
  [4, "april apr abril abr avril avr"],
  [5, "may mayo maio mai"],
  [6, "june jun junio junho juin"],
  [7, "july jul julio julho juillet juil"],
  [8, "august aug agosto ago août aout"],
  [9, "september sep sept septiembre setiembre setembro set septembre"],
  [10, "october oct octubre outubro out octobre"],
  [11, "november nov noviembre novembro novembre"],
  [12, "december dec diciembre dic dezembro dez décembre déc decembre"],
] as const)
  for (const name of names.split(" ")) MONTH_NAMES[name] = month;

/** Alternation of every month name, longest first so "sept" wins over "sep". For use inside a case-insensitive regex. */
export const MONTH_PATTERN = Object.keys(MONTH_NAMES)
  .sort((a, b) => b.length - a.length)
  .join("|");

/** The month a name stands for, or null. */
export const monthNumber = (name: string): number | null => MONTH_NAMES[name.toLowerCase().replace(/\.$/, "")] ?? null;

/**
 * Words that place a day relative to when the article was written: today, yesterday, a weekday. When the source
 * uses one, a date a few days before the article's own date is a fair reading of it.
 */
export const RELATIVE_DAY =
  /\b(?:today|yesterday|tonight|this (?:morning|afternoon|evening|week)|last week|(?:mon|tues|wednes|thurs|fri|satur|sun)day|hoy|ayer|anoche|esta semana|(?:lunes|martes|miércoles|jueves|viernes|sábado|domingo)|hoje|ontem|(?:segunda|terça|quarta|quinta|sexta)-feira|sábado|domingo|aujourd'hui|hier|cette semaine|(?:lundi|mardi|mercredi|jeudi|vendredi|samedi|dimanche))\b|今天|今日|昨天|昨日|本周|上周|(?:周|星期)[一二三四五六日天]/iu;

/**
 * Words that place a year relative to when the article was written: next year, last year, this year. When the
 * source uses one, the year before or after the article's own year is a fair reading of it.
 */
export const RELATIVE_YEAR =
  /\b(?:next|last|this|coming|previous|past) year\b|\b(?:el )?(?:próximo|proximo|pasado|este) año\b|\baño (?:próximo|pasado|que viene)\b|\b(?:próximo|proximo|este) ano\b|\bano (?:passado|que vem)\b|\bl'(?:année|an) (?:prochaine?|dernière?|passée)\b|\bcette année\b|明年|去年|今年|上一年|下一年/iu;
