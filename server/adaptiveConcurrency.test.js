import assert from "node:assert/strict";
import test from "node:test";
import {
  AdaptiveConcurrency,
  getAdaptiveConcurrencyConfig,
} from "./adaptiveConcurrency.js";

const healthy = {
  latencyMs: 400,
  throughput: 10,
  retryRate: 0,
  rateLimited: false,
};

test("adaptive concurrency ramps up gradually after stable healthy observations", () => {
  const controller = new AdaptiveConcurrency({
    min: 2,
    max: 6,
    initial: 2,
    stableSamples: 2,
    latencyTargetMs: 1_000,
  });

  assert.equal(controller.observe(healthy), 2);
  assert.equal(controller.observe(healthy), 3);
  assert.equal(controller.observe(healthy), 3);
  assert.equal(controller.observe({ ...healthy, throughput: 11 }), 4);
  assert.equal(controller.snapshot().max, 6);
});

test("rate limits and degraded signals reduce concurrency aggressively", () => {
  const controller = new AdaptiveConcurrency({
    min: 1,
    max: 16,
    initial: 12,
    stableSamples: 3,
    latencyTargetMs: 1_000,
  });

  assert.equal(controller.observe({
    latencyMs: 1_600,
    throughput: 4,
    retryRate: 0.2,
    rateLimited: true,
  }), 6);
  assert.equal(controller.observe({
    latencyMs: 400,
    throughput: 2,
    retryRate: 0,
    rateLimited: false,
  }), 3);
  assert.equal(controller.observe({
    latencyMs: 400,
    throughput: 1,
    retryRate: 0,
    rateLimited: false,
  }), 1);
});

test("configuration clamps initial and max values without workflow coupling", () => {
  const config = getAdaptiveConcurrencyConfig({
    MIGRATION_FILE_WORKERS_MIN: "3",
    MIGRATION_FILE_WORKERS_INITIAL: "99",
    MIGRATION_FILE_WORKERS_MAX: "8",
  });

  assert.deepEqual(
    { min: config.min, initial: config.initial, max: config.max },
    { min: 3, initial: 8, max: 8 },
  );
});
