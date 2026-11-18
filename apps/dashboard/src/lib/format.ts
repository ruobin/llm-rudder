const usd = new Intl.NumberFormat("en-US", {
  style: "currency",
  currency: "USD",
  minimumFractionDigits: 2,
  maximumFractionDigits: 2,
});
const count = new Intl.NumberFormat("en-US");
const compact = new Intl.NumberFormat("en-US", { notation: "compact", maximumFractionDigits: 1 });

export function formatUsd(value: number): string {
  if (value > 0 && value < 0.01) return "<$0.01";
  return usd.format(value);
}

export const formatCount = (value: number): string => count.format(value);
export const formatCompact = (value: number): string => compact.format(value);

export function formatDuration(ms: number | null | undefined): string {
  if (ms === null || ms === undefined) return "–";
  if (ms < 1000) return `${Math.round(ms)} ms`;
  if (ms < 60_000) return `${(ms / 1000).toFixed(1)} s`;
  return `${Math.floor(ms / 60_000)} min ${Math.round((ms % 60_000) / 1000)} s`;
}

export function formatTime(iso: string | undefined | null): string {
  if (!iso) return "–";
  const time = new Date(iso);
  if (Number.isNaN(time.getTime())) return "–";
  return `${time.toISOString().slice(0, 16).replace("T", " ")} UTC`;
}

export function formatRelative(iso: string | undefined, now: number): string {
  if (!iso) return "unknown";
  const seconds = Math.round((Date.parse(iso) - now) / 1000);
  const size = Math.abs(seconds);
  const text =
    size < 60
      ? `${size} s`
      : size < 3600
        ? `${Math.round(size / 60)} min`
        : size < 172_800
          ? `${Math.round(size / 3600)} h`
          : `${Math.round(size / 86_400)} days`;
  return seconds >= 0 ? `in ${text}` : `${text} ago`;
}

export function formatUptime(seconds: number): string {
  if (seconds < 3600) return `${Math.floor(seconds / 60)} min`;
  if (seconds < 172_800) return `${Math.floor(seconds / 3600)} h`;
  return `${Math.floor(seconds / 86_400)} days`;
}

/** A round axis maximum at or above the value. */
export function niceMax(value: number): number {
  if (value <= 0) return 1;
  const power = 10 ** Math.floor(Math.log10(value));
  const step = [1, 2, 2.5, 5, 10].find((candidate) => candidate * power >= value) ?? 10;
  return step * power;
}
