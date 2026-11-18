"use client";

import { useState } from "react";
import { niceMax } from "@/lib/format";

export interface ChartPoint {
  day: string;
  value: number;
  display: string;
}

const dayLabel = (day: string) =>
  new Date(`${day}T00:00:00Z`).toLocaleDateString("en-US", {
    month: "short",
    day: "numeric",
    timeZone: "UTC",
  });

/** One column per day, on a single axis. Arrow keys move between days. */
export function UsageChart({
  label,
  points,
  formatAxis,
}: {
  label: string;
  points: ChartPoint[];
  formatAxis: "usd" | "count";
}) {
  const [active, setActive] = useState<number | null>(null);
  const top = niceMax(Math.max(...points.map((point) => point.value), 0));
  const axisText = (value: number) =>
    formatAxis === "usd"
      ? `$${value.toLocaleString("en-US", { maximumFractionDigits: value < 1 ? 3 : 0 })}`
      : value.toLocaleString("en-US", {
          notation: value >= 10_000 ? "compact" : "standard",
          maximumFractionDigits: 1,
        });
  const current = active === null ? null : (points[active] ?? null);
  const middle = Math.floor((points.length - 1) / 2);

  return (
    <figure className="m-0">
      <div className="relative flex gap-2">
        <div
          aria-hidden
          className="flex h-52 w-12 shrink-0 flex-col justify-between text-right text-[11px] leading-none text-muted tabular-nums"
        >
          <span>{axisText(top)}</span>
          <span>{axisText(top / 2)}</span>
          <span>{axisText(0)}</span>
        </div>
        <div
          role="img"
          aria-label={`${label}, by day. The table below lists every value.`}
          tabIndex={0}
          className="relative h-52 flex-1 rounded-sm"
          onBlur={() => setActive(null)}
          onKeyDown={(event) => {
            if (event.key !== "ArrowLeft" && event.key !== "ArrowRight") return;
            event.preventDefault();
            const step = event.key === "ArrowRight" ? 1 : -1;
            setActive((index) =>
              Math.min(points.length - 1, Math.max(0, (index ?? points.length) + step)),
            );
          }}
          onPointerLeave={() => setActive(null)}
        >
          <div aria-hidden className="absolute inset-x-0 top-0 border-t border-border" />
          <div aria-hidden className="absolute inset-x-0 top-1/2 border-t border-border" />
          <div aria-hidden className="absolute inset-x-0 bottom-0 border-t border-baseline" />
          <div className="absolute inset-0 flex items-end">
            {points.map((point, index) => (
              <div
                key={point.day}
                className="flex h-full min-w-0 flex-1 items-end justify-center px-px"
                onPointerEnter={() => setActive(index)}
              >
                <div
                  className="w-full max-w-6 rounded-t bg-chart transition-opacity"
                  style={{
                    height: point.value > 0 ? `max(2px, ${(point.value / top) * 100}%)` : 0,
                    opacity: active === null || active === index ? 1 : 0.55,
                  }}
                />
              </div>
            ))}
          </div>
          {current && active !== null ? (
            <div
              role="status"
              className="pointer-events-none absolute top-1 z-10 rounded-md border border-border bg-card px-2.5 py-1.5 text-xs shadow-sm"
              style={
                active > points.length / 2
                  ? { right: `${100 - ((active + 0.5) / points.length) * 100}%` }
                  : { left: `${((active + 0.5) / points.length) * 100}%` }
              }
            >
              <p className="whitespace-nowrap text-secondary">{dayLabel(current.day)}</p>
              <p className="font-medium whitespace-nowrap tabular-nums">{current.display}</p>
            </div>
          ) : null}
        </div>
      </div>
      <div aria-hidden className="mt-1.5 flex justify-between pl-14 text-[11px] text-muted">
        <span>{points[0] ? dayLabel(points[0].day) : ""}</span>
        <span>{points[middle] && points.length > 2 ? dayLabel(points[middle].day) : ""}</span>
        <span>{points.at(-1) ? dayLabel(points.at(-1)!.day) : ""}</span>
      </div>
    </figure>
  );
}
