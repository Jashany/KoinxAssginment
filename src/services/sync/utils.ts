// small helpers
export function getTodayKey(): string {
  const now = new Date();
  const day = now.getDate();
  const month = now.toLocaleString("en-US", { month: "short" }).toLowerCase();
  return `${day}${month}`;
}
