/**
 * Body pictures after the first load when the reader scrolls near them, so a long illustrated article does not
 * download every picture before the page can be used on a phone (TASK-0593). The first stays as it was: it may be
 * on screen at once. A picture the body already marks keeps its own setting.
 */
export function lazyBodyImages(html: string): string {
  let seen = 0;
  return html.replace(/<img(?=[\s/>])(?![^>]*\sloading=)/gi, (tag) => (seen++ === 0 ? tag : `${tag} loading="lazy" decoding="async"`));
}
