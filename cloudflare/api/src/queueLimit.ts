export const MAX_QUEUE_MESSAGES_PER_INVOCATION = 1;

export function shouldProcessQueueMessage(
  index: number,
): boolean {
  return index < MAX_QUEUE_MESSAGES_PER_INVOCATION;
}
