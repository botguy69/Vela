import { useMemo, useState } from "react";
import {
  Area,
  AreaChart,
  CartesianGrid,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
} from "recharts";
import type { Candle } from "@/lib/engine";
import { formatAxisPx, formatPx, formatTime } from "@/lib/format";
import { cn } from "@/lib/utils";

export function PriceChart({
  candles,
  className,
  height = 280,
}: {
  candles: Candle[];
  className?: string;
  height?: number;
}) {
  const [ready, setReady] = useState(false);
  const data = useMemo(
    () =>
      candles.map((c) => ({
        t: c.time,
        close: c.close,
        label: formatTime(c.time),
      })),
    [candles],
  );
  const up = (data.at(-1)?.close ?? 0) >= (data[0]?.close ?? 0);
  const stroke = up ? "var(--color-up)" : "var(--color-down)";

  return (
    <div className={cn("w-full overflow-hidden", className)} style={{ height }} ref={() => setReady(true)}>
      {ready && data.length > 1 ? (
        <ResponsiveContainer width="100%" height="100%">
          <AreaChart data={data} margin={{ top: 8, right: 8, left: 0, bottom: 0 }}>
            <defs>
              <linearGradient id="velaFill" x1="0" y1="0" x2="0" y2="1">
                <stop offset="0%" stopColor={stroke} stopOpacity={0.28} />
                <stop offset="100%" stopColor={stroke} stopOpacity={0} />
              </linearGradient>
            </defs>
            <CartesianGrid stroke="var(--color-line)" vertical={false} />
            <XAxis
              dataKey="label"
              tick={{ fill: "var(--color-subtle)", fontSize: 11 }}
              tickLine={false}
              axisLine={false}
              minTickGap={48}
            />
            <YAxis
              domain={["auto", "auto"]}
              tick={{ fill: "var(--color-subtle)", fontSize: 11 }}
              tickLine={false}
              axisLine={false}
              width={52}
              tickFormatter={(v: number) => formatAxisPx(v)}
            />
            <Tooltip
              contentStyle={{
                background: "var(--color-surface)",
                border: "1px solid var(--color-line)",
                borderRadius: 8,
                color: "var(--color-fg)",
                fontSize: 12,
              }}
              formatter={(value) => [formatPx(Number(value ?? 0)), "Last"]}
              labelFormatter={(_, payload) => payload?.[0]?.payload?.label ?? ""}
            />
            <Area
              type="monotone"
              dataKey="close"
              stroke={stroke}
              strokeWidth={1.6}
              fill="url(#velaFill)"
              isAnimationActive={false}
            />
          </AreaChart>
        </ResponsiveContainer>
      ) : (
        <div className="h-full w-full animate-pulse rounded-lg bg-raised" />
      )}
    </div>
  );
}
