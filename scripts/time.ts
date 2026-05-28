export function hoursBetween(from: string | Date | undefined | null, to = new Date()): number {
  if (!from) return 0;
  return Math.max(0, (to.getTime() - new Date(from).getTime()) / 36e5);
}

export function formatDuration(hours: number): string {
  if (!Number.isFinite(hours)) return "unknown";
  if (hours < 1) return `${Math.max(1, Math.round(hours * 60))}m`;
  if (hours < 48) return `${Math.round(hours)}h`;
  const days = Math.floor(hours / 24);
  const restHours = Math.round(hours % 24);
  return restHours ? `${days}d ${restHours}h` : `${days}d`;
}

export function nowInTimezone(timezone: string): string {
  return new Intl.DateTimeFormat("en-US", {
    timeZone: timezone,
    dateStyle: "medium",
    timeStyle: "short",
  }).format(new Date());
}
