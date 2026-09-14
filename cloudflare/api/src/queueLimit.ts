// The clean item path is approximately 18 Hyperdrive statements, two Drive
// calls, and one cleanup enqueue. Four items therefore stay below 100 backend
// operations even before normal queue overhead; the cap prevents the former
// unbounded batch behavior from returning.
export const MAX_QUEUE_MESSAGES_PER_INVOCATION = 4;
export const DEFERRED_QUEUE_RETRY_DELAY_SECONDS = 1;

export function shouldProcessQueueMessage(
  index: number,
  limit = MAX_QUEUE_MESSAGES_PER_INVOCATION,
): boolean {
  return index < limit;
}

export function getQueueConcurrency(
  env: { MIGRATION_QUEUE_CONCURRENCY?: string } = {},
): number {
  const configured = Number(env.MIGRATION_QUEUE_CONCURRENCY);

  if (!Number.isInteger(configured) || configured < 1) {
    return MAX_QUEUE_MESSAGES_PER_INVOCATION;
  }

  return Math.min(configured, MAX_QUEUE_MESSAGES_PER_INVOCATION);
}

export async function runWithBoundedConcurrency<T>(
  items: readonly T[],
  concurrency: number,
  worker: (item: T, index: number) => Promise<void>,
): Promise<void> {
  if (items.length === 0) {
    return;
  }

  const workerCount = Math.max(
    1,
    Math.min(Math.floor(concurrency), items.length),
  );
  let nextIndex = 0;

  await Promise.all(
    Array.from({ length: workerCount }, async () => {
      while (true) {
        const index = nextIndex++;

        if (index >= items.length) {
          return;
        }

        await worker(items[index], index);
      }
    }),
  );
}
