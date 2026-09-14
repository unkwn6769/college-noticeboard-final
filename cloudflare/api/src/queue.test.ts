import { strict as assert } from "node:assert";
import test from "node:test";

import {
  DEFERRED_QUEUE_RETRY_DELAY_SECONDS,
  getQueueConcurrency,
  MAX_QUEUE_MESSAGES_PER_INVOCATION,
  runWithBoundedConcurrency,
  shouldProcessQueueMessage,
} from "./queueLimit";

test("queue invocation bounds expensive migration work", () => {
  assert.equal(MAX_QUEUE_MESSAGES_PER_INVOCATION, 20);
  assert.equal(DEFERRED_QUEUE_RETRY_DELAY_SECONDS, 1);
  assert.equal(shouldProcessQueueMessage(0), true);
  assert.equal(shouldProcessQueueMessage(19), true);
  assert.equal(shouldProcessQueueMessage(20), false);
  assert.equal(shouldProcessQueueMessage(99), false);
});

test("queue concurrency is configurable but capped at the hard maximum", () => {
  assert.equal(getQueueConcurrency({ MIGRATION_QUEUE_CONCURRENCY: "2" }), 2);
  assert.equal(getQueueConcurrency({ MIGRATION_QUEUE_CONCURRENCY: "4" }), 4);
  assert.equal(getQueueConcurrency({ MIGRATION_QUEUE_CONCURRENCY: "20" }), 20);
  assert.equal(getQueueConcurrency({ MIGRATION_QUEUE_CONCURRENCY: "21" }), 20);
  assert.equal(getQueueConcurrency({ MIGRATION_QUEUE_CONCURRENCY: "invalid" }), 20);
});

test("bounded queue workers run four items concurrently and isolate failures", async () => {
  const started: number[] = [];
  const completed: number[] = [];
  let active = 0;
  let maximumActive = 0;

  await runWithBoundedConcurrency([0, 1, 2, 3, 4], 4, async (item) => {
    started.push(item);
    active += 1;
    maximumActive = Math.max(maximumActive, active);

    await new Promise((resolve) => setTimeout(resolve, 5));
    active -= 1;
    completed.push(item);
  });

  assert.equal(maximumActive, 4);
  assert.deepEqual(started, [0, 1, 2, 3, 4]);
  assert.equal(completed.length, 5);
});

test("bounded queue workers continue sibling work after one failure", async () => {
  const completed: number[] = [];

  await assert.rejects(
    runWithBoundedConcurrency([0, 1, 2, 3], 4, async (item) => {
      if (item === 1) {
        throw new Error("one item failed");
      }
      completed.push(item);
    }),
    /one item failed/,
  );

  assert.deepEqual(completed.sort(), [0, 2, 3]);
});
