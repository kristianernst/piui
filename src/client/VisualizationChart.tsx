import type * as React from "react";
import {
  Area,
  AreaChart,
  Bar,
  BarChart,
  CartesianGrid,
  Cell,
  Line,
  LineChart,
  Pie,
  PieChart,
  ResponsiveContainer,
  Scatter,
  ScatterChart,
  Tooltip,
  XAxis,
  YAxis,
  ZAxis,
} from "recharts";
import type { ToolResultDetails } from "./piSocket";

type VisualizationDetails = Extract<ToolResultDetails, { kind: "analytics_visualization" }>;
type Mode = VisualizationDetails["chartType"];
type ChartTooltipPayload = ReadonlyArray<{ value?: unknown; name?: unknown; payload?: unknown }>;

export default function VisualizationChart({
  details,
  rows,
  mode,
}: {
  details: VisualizationDetails;
  rows: Array<Record<string, unknown>>;
  mode: Mode;
}) {
  const points = rows
    .map((row) => ({ label: formatCell(row[details.x]), value: Number(row[details.y]) }))
    .filter((point) => Number.isFinite(point.value))
    .slice(0, 40);
  if (!points.length) return <div className="emptyChart">No numeric data for {details.y}</div>;

  const max = Math.max(...points.map((point) => point.value));
  const min = Math.min(...points.map((point) => point.value));
  const avg = points.reduce((sum, point) => sum + point.value, 0) / points.length;
  const xLabel = details.xLabel || humanizeColumn(details.x);
  const yLabel = details.yLabel || humanizeColumn(details.y);

  const longestLabel = points.reduce((acc, point) => Math.max(acc, point.label.length), 0);
  // Rotate categorical axis labels when they would otherwise collide. Time-series
  // line charts keep horizontal ticks because Recharts thins them with minTickGap.
  const isLineLike = mode === "line" || mode === "area" || mode === "step" || mode === "cumulative";
  const rotated = !isLineLike && mode !== "horizontalBar" && mode !== "pie" && (longestLabel > 8 || points.length > 14);
  const xAxisHeight = rotated ? 46 : 22;

  const margin = { top: 8, right: 8, bottom: 0, left: 0 };
  const renderXTick = ((tickProps: unknown) => {
    const props = tickProps as { x?: number; y?: number; payload?: { value?: unknown } };
    return <AxisTick x={props.x} y={props.y} payload={props.payload} rotated={rotated} />;
  }) as never;
  const renderTooltip = (tipProps: { active?: boolean; payload?: ChartTooltipPayload; label?: string | number }) => (
    <ChartTooltip active={tipProps.active} payload={tipProps.payload} label={tipProps.label} xLabel={xLabel} yLabel={yLabel} mode={mode} />
  );

  return (
    <div className="vizBody">
      <div className="vizMetricLine">
        <span className="vizMetricName">{yLabel}</span>
        <span className="vizMetricSep">·</span>
        <span className="vizMetricDim">by {xLabel.toLowerCase()}</span>
        <span className="vizMetricSpacer" />
        <span className="vizMetricMeta">
          <span><b>{points.length}</b>{details.truncated ? "+" : ""} pts</span>
          {details.elapsedMs ? <span>{details.elapsedMs}ms</span> : null}
        </span>
      </div>
      <div className="vizStats">
        <Stat label="max" value={max} />
        <Stat label="avg" value={avg} />
        <Stat label="min" value={min} />
      </div>
      <div className="miniChart">
        <ResponsiveContainer width="100%" height="100%">
          {renderChart(mode, points, { margin, renderXTick, renderTooltip, xAxisHeight, yLabel })}
        </ResponsiveContainer>
      </div>
    </div>
  );
}

type Point = { label: string; value: number };
type ChartCtx = {
  margin: { top: number; right: number; bottom: number; left: number };
  renderXTick: never;
  renderTooltip: (tipProps: { active?: boolean; payload?: ChartTooltipPayload; label?: string | number }) => React.ReactElement | null;
  xAxisHeight: number;
  yLabel: string;
};

// Splits each point into the floor (transparent base bar) and the delta segment
// so a stacked bar chart visually behaves like a finance-style waterfall —
// running total carried forward, deltas colored by sign.
type WaterfallPoint = { label: string; base: number; delta: number; running: number; sign: "pos" | "neg" };
function toWaterfall(points: Point[]): WaterfallPoint[] {
  let running = 0;
  return points.map((point) => {
    const start = running;
    const end = running + point.value;
    running = end;
    const base = Math.min(start, end);
    const delta = Math.abs(point.value);
    return { label: point.label, base, delta, running: end, sign: point.value >= 0 ? "pos" : "neg" };
  });
}

function renderChart(mode: Mode, points: Point[], ctx: ChartCtx): React.ReactElement {
  const { margin, renderXTick, renderTooltip, xAxisHeight, yLabel } = ctx;
  switch (mode) {
    case "line":
    case "area": {
      const fillStrong = mode === "area";
      return (
        <AreaChart data={points} margin={margin} accessibilityLayer>
          <defs>
            <linearGradient id="vizAreaFill" x1="0" y1="0" x2="0" y2="1">
              <stop offset="0%" stopColor="var(--accent)" stopOpacity={fillStrong ? 0.45 : 0.18} />
              <stop offset="100%" stopColor="var(--accent)" stopOpacity={0} />
            </linearGradient>
          </defs>
          <CartesianGrid stroke="var(--hairline)" strokeDasharray="2 4" vertical={false} />
          <XAxis dataKey="label" tickLine={false} axisLine={false} interval="preserveStartEnd" minTickGap={36} tick={renderXTick} height={xAxisHeight} />
          <YAxis width={42} tickLine={false} axisLine={false} tickCount={4} tickFormatter={formatCompactNumber} tick={{ className: "vizTick" } as never} />
          <Tooltip cursor={{ stroke: "var(--accent)", strokeDasharray: "3 3", strokeOpacity: 0.55 }} content={renderTooltip} />
          <Area type="monotone" dataKey="value" name={yLabel} stroke="var(--accent)" strokeWidth={1.75} fill="url(#vizAreaFill)" dot={false} activeDot={{ r: 4, strokeWidth: 2, stroke: "var(--card)", fill: "var(--accent)" }} />
        </AreaChart>
      );
    }
    case "step": {
      // stepAfter so the segment carries the previous value forward through the
      // x position before changing — reads as a state-change timeline.
      return (
        <LineChart data={points} margin={margin} accessibilityLayer>
          <CartesianGrid stroke="var(--hairline)" strokeDasharray="2 4" vertical={false} />
          <XAxis dataKey="label" tickLine={false} axisLine={false} interval="preserveStartEnd" minTickGap={36} tick={renderXTick} height={xAxisHeight} />
          <YAxis width={42} tickLine={false} axisLine={false} tickCount={4} tickFormatter={formatCompactNumber} tick={{ className: "vizTick" } as never} />
          <Tooltip cursor={{ stroke: "var(--accent)", strokeDasharray: "3 3", strokeOpacity: 0.55 }} content={renderTooltip} />
          <Line type="stepAfter" dataKey="value" name={yLabel} stroke="var(--accent)" strokeWidth={1.75} dot={false} activeDot={{ r: 4, strokeWidth: 2, stroke: "var(--card)", fill: "var(--accent)" }} />
        </LineChart>
      );
    }
    case "cumulative": {
      // Running total over the points in their current order. We replace the
      // raw `value` with the running sum so the rest of the chart pipeline
      // (tooltip, stats) treats it as a normal line.
      let running = 0;
      const cum = points.map((point) => ({ label: point.label, value: (running += point.value) }));
      return (
        <AreaChart data={cum} margin={margin} accessibilityLayer>
          <defs>
            <linearGradient id="vizCumFill" x1="0" y1="0" x2="0" y2="1">
              <stop offset="0%" stopColor="var(--accent)" stopOpacity={0.32} />
              <stop offset="100%" stopColor="var(--accent)" stopOpacity={0} />
            </linearGradient>
          </defs>
          <CartesianGrid stroke="var(--hairline)" strokeDasharray="2 4" vertical={false} />
          <XAxis dataKey="label" tickLine={false} axisLine={false} interval="preserveStartEnd" minTickGap={36} tick={renderXTick} height={xAxisHeight} />
          <YAxis width={42} tickLine={false} axisLine={false} tickCount={4} tickFormatter={formatCompactNumber} tick={{ className: "vizTick" } as never} />
          <Tooltip cursor={{ stroke: "var(--accent)", strokeDasharray: "3 3", strokeOpacity: 0.55 }} content={renderTooltip} />
          <Area type="monotone" dataKey="value" name={`Σ ${yLabel}`} stroke="var(--accent)" strokeWidth={1.75} fill="url(#vizCumFill)" dot={false} />
        </AreaChart>
      );
    }
    case "scatter": {
      // Use the index as the x dimension so categorical labels still work; the
      // tooltip rebuilds the human label from the underlying point.
      const scatter = points.map((point, index) => ({ x: index, y: point.value, label: point.label }));
      return (
        <ScatterChart margin={margin} accessibilityLayer>
          <CartesianGrid stroke="var(--hairline)" strokeDasharray="2 4" vertical={false} />
          <XAxis
            type="number"
            dataKey="x"
            tickLine={false}
            axisLine={false}
            domain={[0, Math.max(0, scatter.length - 1)]}
            tickFormatter={(value: number) => points[Math.round(value)]?.label ?? ""}
            interval="preserveStartEnd"
            minTickGap={36}
            tick={renderXTick}
            height={xAxisHeight}
          />
          <YAxis type="number" dataKey="y" width={42} tickLine={false} axisLine={false} tickCount={4} tickFormatter={formatCompactNumber} tick={{ className: "vizTick" } as never} />
          <ZAxis range={[40, 40]} />
          <Tooltip cursor={{ strokeDasharray: "3 3" }} content={renderTooltip} />
          <Scatter data={scatter} name={yLabel} fill="var(--accent)" />
        </ScatterChart>
      );
    }
    case "waterfall": {
      const wf = toWaterfall(points);
      return (
        <BarChart data={wf} margin={margin} stackOffset="sign" barCategoryGap="22%" accessibilityLayer>
          <CartesianGrid stroke="var(--hairline)" strokeDasharray="2 4" vertical={false} />
          <XAxis dataKey="label" tickLine={false} axisLine={false} interval={wf.length > 18 ? "preserveStartEnd" : 0} minTickGap={2} tick={renderXTick} height={xAxisHeight} />
          <YAxis width={42} tickLine={false} axisLine={false} tickCount={4} tickFormatter={formatCompactNumber} tick={{ className: "vizTick" } as never} />
          <Tooltip cursor={{ fill: "oklch(from var(--accent) l c h / 0.10)" }} content={renderTooltip} />
          {/* Transparent base lifts the visible bar to its running-total floor. */}
          <Bar dataKey="base" stackId="wf" fill="transparent" isAnimationActive={false} />
          <Bar dataKey="delta" stackId="wf" radius={[3, 3, 0, 0]} maxBarSize={32}>
            {wf.map((point, index) => (
              <Cell key={index} fill={point.sign === "pos" ? "var(--ok)" : "var(--bad)"} />
            ))}
          </Bar>
        </BarChart>
      );
    }
    case "horizontalBar": {
      // Recharts' `layout="vertical"` actually produces horizontal bars (axis
      // labels stack on Y). Useful when category labels are long.
      return (
        <BarChart data={points} layout="vertical" margin={{ ...margin, left: 8 }} accessibilityLayer>
          <CartesianGrid stroke="var(--hairline)" strokeDasharray="2 4" horizontal={false} />
          <XAxis type="number" tickLine={false} axisLine={false} tickCount={4} tickFormatter={formatCompactNumber} tick={{ className: "vizTick" } as never} />
          <YAxis type="category" dataKey="label" tickLine={false} axisLine={false} width={Math.min(140, Math.max(60, longestLabelOf(points) * 7 + 12))} tick={{ className: "vizTick" } as never} />
          <Tooltip cursor={{ fill: "oklch(from var(--accent) l c h / 0.10)" }} content={renderTooltip} />
          <Bar dataKey="value" name={yLabel} fill="var(--accent)" radius={[0, 3, 3, 0]} maxBarSize={22} />
        </BarChart>
      );
    }
    case "pie": {
      // Aggregate by label so duplicate categories sum together; ignore points
      // with non-positive values because pies can't represent them.
      const aggregated = aggregatePositive(points);
      if (!aggregated.length) {
        return (
          <BarChart data={points} margin={margin} accessibilityLayer>
            <CartesianGrid stroke="var(--hairline)" strokeDasharray="2 4" vertical={false} />
            <XAxis dataKey="label" tickLine={false} axisLine={false} tick={renderXTick} height={xAxisHeight} />
            <YAxis width={42} tickLine={false} axisLine={false} tickCount={4} tickFormatter={formatCompactNumber} tick={{ className: "vizTick" } as never} />
            <Tooltip cursor={{ fill: "oklch(from var(--accent) l c h / 0.10)" }} content={renderTooltip} />
            <Bar dataKey="value" name={yLabel} fill="var(--accent)" radius={[3, 3, 0, 0]} maxBarSize={32} />
          </BarChart>
        );
      }
      return (
        <PieChart margin={margin} accessibilityLayer>
          <Tooltip content={renderTooltip} />
          <Pie data={aggregated} dataKey="value" nameKey="label" innerRadius="45%" outerRadius="80%" paddingAngle={1} stroke="var(--card)" strokeWidth={1}>
            {aggregated.map((_, index) => (
              <Cell key={index} fill={pieColor(index)} />
            ))}
          </Pie>
        </PieChart>
      );
    }
    case "bar":
    default:
      return (
        <BarChart data={points} margin={margin} barCategoryGap="22%" accessibilityLayer>
          <CartesianGrid stroke="var(--hairline)" strokeDasharray="2 4" vertical={false} />
          <XAxis dataKey="label" tickLine={false} axisLine={false} interval={points.length > 18 ? "preserveStartEnd" : 0} minTickGap={2} tick={renderXTick} height={xAxisHeight} />
          <YAxis width={42} tickLine={false} axisLine={false} tickCount={4} tickFormatter={formatCompactNumber} tick={{ className: "vizTick" } as never} />
          <Tooltip cursor={{ fill: "oklch(from var(--accent) l c h / 0.10)" }} content={renderTooltip} />
          <Bar dataKey="value" name={yLabel} fill="var(--accent)" radius={[3, 3, 0, 0]} maxBarSize={32} />
        </BarChart>
      );
  }
}

function longestLabelOf(points: Point[]): number {
  return points.reduce((acc, point) => Math.max(acc, point.label.length), 0);
}

// Sum values per label (for pie aggregation), keep only positives.
function aggregatePositive(points: Point[]): Array<{ label: string; value: number }> {
  const map = new Map<string, number>();
  for (const point of points) {
    if (!Number.isFinite(point.value) || point.value <= 0) continue;
    map.set(point.label, (map.get(point.label) ?? 0) + point.value);
  }
  return [...map.entries()].map(([label, value]) => ({ label, value }));
}

// A small palette walking around the color wheel from --accent. Keeps the
// chart on-theme (uses oklch derived from --accent) while still distinguishing
// up to ~10 slices clearly.
function pieColor(index: number): string {
  const offsets = [0, 60, -60, 120, -120, 30, -30, 90, -90, 150];
  const hue = offsets[index % offsets.length];
  return `oklch(from var(--accent) l c calc(h + ${hue}))`;
}

function Stat({ label, value }: { label: string; value: number }) {
  return (
    <span className="vizStat">
      <em>{label}</em>
      <b>{formatCompactNumber(value)}</b>
    </span>
  );
}

type AxisTickProps = {
  x?: number;
  y?: number;
  payload?: { value?: unknown };
  rotated: boolean;
};

function AxisTick({ x = 0, y = 0, payload, rotated }: AxisTickProps) {
  const raw = String(payload?.value ?? "");
  const text = raw.length > 16 ? raw.slice(0, 15) + "…" : raw;
  if (rotated) {
    return (
      <g transform={`translate(${x},${y + 6})`}>
        <text className="vizTick" textAnchor="end" transform="rotate(-30)">{text}</text>
      </g>
    );
  }
  return <text className="vizTick" x={x} y={y + 12} textAnchor="middle">{text}</text>;
}

function ChartTooltip({
  active,
  payload,
  label,
  xLabel,
  yLabel,
  mode,
}: {
  active?: boolean;
  payload?: ChartTooltipPayload;
  label?: string | number;
  xLabel: string;
  yLabel: string;
  mode: Mode;
}) {
  if (!active || !payload?.length) return null;
  const first = payload[0];
  const point = (first?.payload as Record<string, unknown> | undefined) ?? undefined;
  // Most charts show a single x/y pair; waterfall surfaces the running total
  // alongside the delta, scatter's tooltip pulls the original label.
  if (mode === "waterfall") {
    const delta = Number(point?.delta);
    const running = Number(point?.running);
    const sign = String(point?.sign ?? "pos");
    return (
      <div className="vizTooltip">
        <div className="vizTooltipRow"><span>{xLabel}</span><strong>{label}</strong></div>
        <div className="vizTooltipRow"><span>Δ {yLabel}</span><strong className={sign === "neg" ? "bad" : "ok"}>{Number.isFinite(delta) ? (sign === "neg" ? "-" : "+") + formatNumber(delta) : ""}</strong></div>
        <div className="vizTooltipRow"><span>Running</span><strong className="accent">{Number.isFinite(running) ? formatNumber(running) : ""}</strong></div>
      </div>
    );
  }
  if (mode === "scatter") {
    const xPretty = String(point?.label ?? label ?? "");
    const value = Number(point?.y);
    return (
      <div className="vizTooltip">
        <div className="vizTooltipRow"><span>{xLabel}</span><strong>{xPretty}</strong></div>
        <div className="vizTooltipRow"><span>{yLabel}</span><strong className="accent">{Number.isFinite(value) ? formatNumber(value) : ""}</strong></div>
      </div>
    );
  }
  if (mode === "pie") {
    const value = Number(first?.value);
    const name = String(first?.name ?? label ?? "");
    return (
      <div className="vizTooltip">
        <div className="vizTooltipRow"><span>{xLabel}</span><strong>{name}</strong></div>
        <div className="vizTooltipRow"><span>{yLabel}</span><strong className="accent">{Number.isFinite(value) ? formatNumber(value) : ""}</strong></div>
      </div>
    );
  }
  const raw = first?.value;
  const value = Number(raw);
  return (
    <div className="vizTooltip">
      <div className="vizTooltipRow"><span>{xLabel}</span><strong>{label}</strong></div>
      <div className="vizTooltipRow"><span>{yLabel}</span><strong className="accent">{Number.isFinite(value) ? formatNumber(value) : formatCell(raw)}</strong></div>
    </div>
  );
}

function formatCell(value: unknown): string {
  if (value === null || value === undefined) return "";
  if (typeof value === "number") return formatNumber(value);
  if (typeof value === "boolean") return value ? "true" : "false";
  if (value instanceof Date) return value.toISOString();
  if (typeof value === "object") return JSON.stringify(value);
  return String(value);
}

function formatNumber(value: number) {
  return Number.isInteger(value) ? value.toLocaleString() : value.toLocaleString(undefined, { maximumFractionDigits: 2 });
}

function formatCompactNumber(value: number) {
  return Intl.NumberFormat(undefined, { notation: "compact", maximumFractionDigits: 1 }).format(value);
}

function humanizeColumn(value: string) {
  return value
    .replace(/[_-]+/g, " ")
    .replace(/\s+/g, " ")
    .trim()
    .replace(/\b\w/g, (char) => char.toUpperCase());
}
