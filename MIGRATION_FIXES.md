# Migration reliability and throughput fixes

- Size-based migration selection supports target total size, minimum/maximum file size, minimum file count, and maximum file count.
- Size-mode candidates are selected largest-first within the configured size range until both the target byte total and minimum file count are satisfied, subject to the maximum file count.
- Migration workers release their slot after reconciliation/transient deferral instead of immediately reclaiming the same item.
- Reconciliation has a 30-second retry backoff and preserves its original deadline instead of extending the deadline on every retry.
- The worker claim path preserves `next_retry_at` for `reconciling` items, preventing immediate reclaim/hot-loop behavior.
- Reconciliation clears the active worker lease when it returns a waiting state.
- Scheduler lease acquisition retries during overlapping deployments instead of permanently abandoning scheduling.
- Stale running-item recovery runs periodically, not only at startup.
- PostgreSQL pool default is bounded at 6 for Supavisor/session-mode deployments.
- Redundant final PostgreSQL progress writes were removed from the upload stream flush/final-state path.
- Migration worker concurrency is configurable with `MIGRATION_FILE_WORKERS`; default is 40, maximum is 60.
- Source-retention visibility exposes retained cleanup states and provides owner-only retry for safe, verified source cleanup.
