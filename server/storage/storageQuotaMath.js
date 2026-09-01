export function aggregateQuota(accounts) {
  let totalCapacity = 0n;
  let totalUsed = 0n;
  let knownAccounts = 0;
  let unavailableAccounts = 0;
  let staleAccounts = 0;
  let lastSuccessfulRefreshAt = null;

  const normalized = accounts.map((account) => {
    const limit = account.limitBytes == null ? null : BigInt(account.limitBytes);
    const usage = account.usageBytes == null ? null : BigInt(account.usageBytes);
    const known = account.status === "connected" && limit !== null && usage !== null && limit >= 0n && usage >= 0n && usage <= limit;
    const stale = Boolean(account.lastError);

    if (known) {
      knownAccounts += 1;
      totalCapacity += limit;
      totalUsed += usage;
      if (stale && account.status === "connected") staleAccounts += 1;

      const refreshedAt = account.lastSuccessfulRefreshAt
        ? new Date(account.lastSuccessfulRefreshAt)
        : null;
      if (refreshedAt && !Number.isNaN(refreshedAt.getTime()) && (!lastSuccessfulRefreshAt || refreshedAt > lastSuccessfulRefreshAt)) {
        lastSuccessfulRefreshAt = refreshedAt;
      }
    } else if (account.status === "connected") {
      unavailableAccounts += 1;
    }

    const free = known ? limit - usage : null;
    const usagePercent = known && limit > 0n
      ? Math.min(100, Math.max(0, (Number(usage) / Number(limit)) * 100))
      : null;

    return {
      ...account,
      limitBytes: limit?.toString() ?? null,
      usageBytes: usage?.toString() ?? null,
      freeBytes: free?.toString() ?? null,
      usagePercent: Number.isFinite(usagePercent) ? usagePercent : null,
      quotaAvailable: known,
      quotaStale: stale,
    };
  });

  const totalFree = totalCapacity >= totalUsed ? totalCapacity - totalUsed : 0n;
  const usagePercent = totalCapacity > 0n
    ? Math.min(100, Math.max(0, (Number(totalUsed) / Number(totalCapacity)) * 100))
    : null;

  return {
    totalCapacityBytes: totalCapacity.toString(),
    totalUsedBytes: totalUsed.toString(),
    totalFreeBytes: totalFree.toString(),
    usagePercent: Number.isFinite(usagePercent) ? usagePercent : null,
    knownAccounts,
    unavailableAccounts,
    staleAccounts,
    complete: unavailableAccounts === 0 && staleAccounts === 0,
    lastSuccessfulRefreshAt: lastSuccessfulRefreshAt?.toISOString() ?? null,
    accounts: normalized,
  };
}
