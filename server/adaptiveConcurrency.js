const DEFAULT_MIN_CONCURRENCY = 1;
const DEFAULT_MAX_CONCURRENCY = 60;
const DEFAULT_LATENCY_TARGET_MS = 5_000;
const DEFAULT_STABLE_SAMPLES = 3;

function integer(value, fallback, minimum = 1) {
  const parsed = Number(value);
  return Number.isInteger(parsed) && parsed >= minimum ? parsed : fallback;
}

export function getAdaptiveConcurrencyConfig(env = process.env) {
  const min = integer(env.MIGRATION_FILE_WORKERS_MIN, DEFAULT_MIN_CONCURRENCY);
  const max = Math.max(
    min,
    integer(env.MIGRATION_FILE_WORKERS_MAX, DEFAULT_MAX_CONCURRENCY),
  );

  return {
    min,
    max,
    initial: Math.min(
      max,
      integer(env.MIGRATION_FILE_WORKERS_INITIAL, min),
    ),
    latencyTargetMs: Math.max(
      100,
      Number(env.MIGRATION_CONCURRENCY_LATENCY_TARGET_MS || DEFAULT_LATENCY_TARGET_MS),
    ),
    stableSamples: integer(
      env.MIGRATION_CONCURRENCY_STABLE_SAMPLES,
      DEFAULT_STABLE_SAMPLES,
    ),
  };
}

/*
 * This controller only changes the number of file workers. It does not own
 * migration state or claim semantics, so correctness is independent of the
 * number of workflow/scheduler processes running.
 */
export class AdaptiveConcurrency {
  constructor(config = getAdaptiveConcurrencyConfig()) {
    this.config = {
      ...config,
      min: Math.max(1, config.min),
      max: Math.max(config.min, config.max),
    };
    this.current = Math.min(
      this.config.max,
      Math.max(this.config.min, config.initial ?? config.min),
    );
    this.stableSamples = 0;
    this.previousThroughput = null;
    this.lastObservation = null;
  }

  get value() {
    return this.current;
  }

  observe(observation = {}) {
    const latencyMs = Number(observation.latencyMs);
    const throughput = Number(observation.throughput);
    const retryRate = Math.max(0, Number(observation.retryRate) || 0);
    const rateLimited = Boolean(observation.rateLimited);
    const validLatency = Number.isFinite(latencyMs) && latencyMs >= 0;
    const validThroughput = Number.isFinite(throughput) && throughput >= 0;
    const throughputDropped =
      validThroughput &&
      this.previousThroughput !== null &&
      throughput < this.previousThroughput * 0.8;

    this.lastObservation = {
      latencyMs: validLatency ? latencyMs : null,
      throughput: validThroughput ? throughput : null,
      retryRate,
      rateLimited,
    };

    const overloaded =
      rateLimited ||
      retryRate >= 0.1 ||
      (validLatency && latencyMs > this.config.latencyTargetMs * 1.5) ||
      throughputDropped;

    if (overloaded) {
      // Back off quickly when the service tells us to, or when saturation is
      // visible. A single healthy sample must not immediately ramp back up.
      this.current = Math.max(
        this.config.min,
        Math.floor(this.current / 2),
      );
      this.stableSamples = 0;
    } else {
      this.stableSamples += 1;
      if (
        this.stableSamples >= this.config.stableSamples &&
        this.current < this.config.max &&
        (!validLatency || latencyMs <= this.config.latencyTargetMs) &&
        (!validThroughput || this.previousThroughput === null ||
          throughput >= this.previousThroughput * 0.9)
      ) {
        // Additive increase keeps ramp-up conservative and predictable.
        this.current += 1;
        this.stableSamples = 0;
      }
    }

    if (validThroughput) {
      this.previousThroughput = throughput;
    }

    return this.current;
  }

  snapshot() {
    return {
      concurrency: this.current,
      min: this.config.min,
      max: this.config.max,
      lastObservation: this.lastObservation,
    };
  }
}
