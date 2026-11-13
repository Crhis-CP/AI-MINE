/**
 * An operator's input that cannot be accepted (a missing reason, a malformed value). adminHandler answers it with
 * 400 and this message; a plain Error would be logged as a server fault and answered with 500 (TASK-0618).
 */
export function invalidInput(message: string): Error {
  return Object.assign(new Error(message), { statusCode: 400 });
}
