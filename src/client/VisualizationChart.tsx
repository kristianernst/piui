import {
  Area,
  AreaChart,
  Bar,
  BarChart,
  CartesianGrid,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
} from "recharts";
import type { ToolResultDetails } from "./piSocket";

type VisualizationDetails = Extract<ToolResultDetails, { kind: "analytics_visualization" }>;
type ChartTooltipPayload = ReadonlyArray<{ value?: unknown; name?: unknown }>;

export default function VisualizationChart({
  details,
  rows,
  mode,
}: {
  details: VisualizationDetails;
  rows: Array<Record<string, unknown>>;
  mode: "line" | "bar";
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
  // Rotate categorical bar labels when they would otherwise collide. Time-series
  // line charts keep horizontal ticks because Recharts thins them with minTickGap.
  const rotated = mode === "bar" && (longestLabel > 8 || points.length > 14);
  const xAxisHeight = rotated ? 46 : 22;

  const margin = { top: 8, right: 8, bottom: 0, left: 0 };
  const renderXTick = ((tickProps: unknown) => {
    const props = tickProps as { x?: number; y?: number; payload?: { value?: unknown } };
    return <AxisTick x={props.x} y={props.y} payload={props.payload} rotated={rotated} />;
  }) as never;
  const renderTooltip = (tipProps: { active?: boolean; payload?: ChartTooltipPayload; label?: string | number }) => (
    <ChartTooltip active={tipProps.active} payload={tipProps.payload} label={tipProps.label} xLabel={xLabel} yLabel={yLabel} />
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
          {mode === "line" ? (
            <AreaChart data={points} margin={margin} accessibilityLayer>
              <defs>
                <linearGradient id="vizAreaFill" x1="0" y1="0" x2="0" y2="1">
                  <stop offset="0%" stopColor="var(--accent)" stopOpacity={0.18} />
                  <stop offset="100%" stopColor="var(--accent)" stopOpacity={0} />
                </linearGradient>
              </defs>
              <CartesianGrid stroke="var(--hairline)" strokeDasharray="2 4" vertical={false} />
              <XAxis dataKey="label" tickLine={false} axisLine={false} interval="preserveStartEnd" minTickGap={36} tick={renderXTick} height={xAxisHeight} />
              <YAxis width={42} tickLine={false} axisLine={false} tickCount={4} tickFormatter={formatCompactNumber} tick={{ className: "vizTick" } as never} />
              <Tooltip cursor={{ stroke: "var(--accent)", strokeDasharray: "3 3", strokeOpacity: 0.55 }} content={renderTooltip} />
              <Area type="monotone" dataKey="value" name={yLabel} stroke="var(--accent)" strokeWidth={1.75} fill="url(#vizAreaFill)" dot={false} activeDot={{ r: 4, strokeWidth: 2, stroke: "var(--card)", fill: "var(--accent)" }} />
            </AreaChart>
          ) : (
            <BarChart data={points} margin={margin} barCategoryGap="22%" accessibilityLayer>
              <CartesianGrid stroke="var(--hairline)" strokeDasharray="2 4" vertical={false} />
              <XAxis dataKey="label" tickLine={false} axisLine={false} interval={points.length > 18 ? "preserveStartEnd" : 0} minTickGap={2} tick={renderXTick} height={xAxisHeight} />
              <YAxis width={42} tickLine={false} axisLine={false} tickCount={4} tickFormatter={formatCompactNumber} tick={{ className: "vizTick" } as never} />
              <Tooltip cursor={{ fill: "oklch(from var(--accent) l c h / 0.10)" }} content={renderTooltip} />
              <Bar dataKey="value" name={yLabel} fill="var(--accent)" radius={[3, 3, 0, 0]} maxBarSize={32} />
            </BarChart>
          )}
        </ResponsiveContainer>
      </div>
    </div>
  );
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
}: {
  active?: boolean;
  payload?: ChartTooltipPayload;
  label?: string | number;
  xLabel: string;
  yLabel: string;
}) {
  if (!active || !payload?.length) return null;
  const raw = payload[0]?.value;
  const value = Number(raw);
  return (
    <div className="vizTooltip">
      <div className="vizTooltipRow">
        <span>{xLabel}</span>
        <strong>{label}</strong>
      </div>
      <div className="vizTooltipRow">
        <span>{yLabel}</span>
        <strong className="accent">{Number.isFinite(value) ? formatNumber(value) : formatCell(raw)}</strong>
      </div>
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
