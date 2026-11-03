/** Pure file-size and quota-allocation helpers; see server/space.ts. */

export function formatBytes(bytes: number): string {
  if (bytes <= 0) return "0 KB";
  if (bytes >= 1024 ** 4) return `${(bytes / 1024 ** 4).toFixed(1).replace(/\.0$/, "")} TB`;
  if (bytes >= 1024 ** 3) return `${(bytes / 1024 ** 3).toFixed(1).replace(/\.0$/, "")} GB`;
  if (bytes >= 1024 ** 2) return `${Math.round(bytes / 1024 ** 2)} MB`;
  return `${Math.max(1, Math.round(bytes / 1024))} KB`;
}

/** Validate that individual member quotas and their sum do not exceed the portfolio quota. */
export function checkShares(portfolio: number | null, members: Map<string, number>): string | null {
  if (portfolio === null) return null;
  let sum = 0;
  for (const bytes of members.values()) {
    if (bytes > portfolio)
      return `Ningún usuario puede tener más que el portafolio (${formatBytes(portfolio)}).`;
    sum += bytes;
  }
  if (sum > portfolio) {
    return `Lo repartido (${formatBytes(sum)}) pasa del espacio del portafolio (${formatBytes(portfolio)}).`;
  }
  return null;
}
