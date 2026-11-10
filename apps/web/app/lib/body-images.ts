/**
 * Body pictures after the first load when the reader scrolls near them, so a long illustrated article does not
 * download every picture before the page can be used on a phone (TASK-0593). The first stays as it was: it may be
 * on screen at once. A picture the body already marks keeps its own setting.
 */
export function lazyBodyImages(html: string): string {
  let seen = 0;
  // Every picture counts toward the position, also one that keeps its own setting: the first in the body is the one
  // that may be on screen.
  return html.replace(/<img(?=[\s/>])([^>]*)/gi, (tag, rest: string) =>
    seen++ === 0 || /\sloading=/i.test(rest) ? tag : tag.replace(/^<img/i, (open) => `${open} loading="lazy" decoding="async"`),
  );
}
