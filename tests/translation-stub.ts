// Model stubs for full-text translation (TASK-0711): a one-block request carries {"text"}, a batch of consecutive
// blocks {"texts":[...]}. These helpers answer both forms with one per-block function, so a stub gives each block the
// same answer whether it was sent alone or in a batch.

interface TranslationInput {
  text?: string;
  texts?: string[];
  referenceOnly?: string;
}

/** The user message of a chat request body. */
export function translationInput(requestBody: string): TranslationInput {
  return JSON.parse((JSON.parse(requestBody) as { messages: { content: string }[] }).messages[1]!.content) as TranslationInput;
}

/** Every block the request asks for, in order. */
export function translationBlocks(requestBody: string): string[] {
  const input = translationInput(requestBody);
  return Array.isArray(input.texts) ? input.texts : [input.text ?? ""];
}

/** True for a batched request. */
export function isTranslationBatch(requestBody: string): boolean {
  return Array.isArray(translationInput(requestBody).texts);
}

/** The model's content: {"text"} for one block, {"texts"} for a batch, each block answered by `translate`. */
export function translationAnswer(requestBody: string, translate: (text: string, index: number) => string): string {
  const input = translationInput(requestBody);
  return JSON.stringify(Array.isArray(input.texts) ? { texts: input.texts.map(translate) } : { text: translate(input.text ?? "", 0) });
}
