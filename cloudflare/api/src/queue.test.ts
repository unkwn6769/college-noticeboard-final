import { strict as assert } from "node:assert";
import test from "node:test";

import {
  MAX_QUEUE_MESSAGES_PER_INVOCATION,
  shouldProcessQueueMessage,
} from "./queueLimit";

test("queue invocation bounds expensive migration work", () => {
  assert.equal(MAX_QUEUE_MESSAGES_PER_INVOCATION, 1);
  assert.equal(shouldProcessQueueMessage(0), true);
  assert.equal(shouldProcessQueueMessage(1), false);
  assert.equal(shouldProcessQueueMessage(99), false);
});
