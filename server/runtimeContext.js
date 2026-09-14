import { AsyncLocalStorage } from "node:async_hooks";

const runtimeStorage = new AsyncLocalStorage();

export function runWithRuntimeContext(runtimeEnv, fn) {
  const context = { env: runtimeEnv, client: null };
  return runtimeStorage.run(context, async () => {
    try {
      return await fn();
    } finally {
      if (context.client) {
        await context.client.end().catch(() => {});
      }
    }
  });
}

export function getRuntimeContext() {
  return runtimeStorage.getStore() ?? null;
}
