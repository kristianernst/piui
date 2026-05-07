import { defineTool, type ExtensionAPI } from "@mariozechner/pi-coding-agent";
import pg from "pg";
import { Type } from "typebox";

const { Pool } = pg;
const DEFAULT_DSN =
  "postgresql://medicine_agent_ro:medicine_agent_ro_password@localhost:55432/medicine_supply_chain_demo";
const DEFAULT_SCHEMAS = ["ops", "olap"];
const MAX_LIMIT = 500;

type QueryRow = Record<string, unknown>;

type SqlResultDetails = {
  kind: "sql_result";
  title?: string;
  sql: string;
  columns: Array<{ name: string; dataType?: string }>;
  rows: QueryRow[];
  rowCount: number;
  truncated: boolean;
  elapsedMs: number;
};

type VisualizationDetails = Omit<SqlResultDetails, "kind"> & {
  kind: "analytics_visualization";
  chartType: "bar" | "line";
  x: string;
  y: string;
  xLabel?: string;
  yLabel?: string;
};

const pool = new Pool({
  connectionString: process.env.PIUI_ANALYTICS_DB_DSN ?? process.env.ANALYSIS_DB_MEDICINE_DSN ?? DEFAULT_DSN,
  max: 4,
  idleTimeoutMillis: 15_000,
  statement_timeout: 15_000,
  application_name: "piui_sql_analytics",
});

function cleanSql(sql: string) {
  return sql.trim().replace(/;+$/g, "").trim();
}

function stripSqlForChecks(sql: string) {
  return sql
    .replace(/'([^']|'')*'/g, "''")
    .replace(/"([^"]|"")*"/g, '""')
    .replace(/--.*$/gm, "")
    .replace(/\/\*[\s\S]*?\*\//g, "");
}

function assertReadOnlySql(input: string) {
  const sql = cleanSql(input);
  if (!sql) throw new Error("SQL is empty.");
  const stripped = stripSqlForChecks(sql);
  if (stripped.includes(";")) throw new Error("Only one SQL statement is allowed.");
  if (!/^\s*(select|with)\b/i.test(stripped)) throw new Error("Only SELECT/WITH read-only queries are allowed.");
  const blocked = /\b(insert|update|delete|drop|alter|create|truncate|grant|revoke|copy|call|do|execute|merge|vacuum|analyze|refresh|set|reset|listen|notify)\b/i;
  const match = blocked.exec(stripped);
  if (match) throw new Error(`Blocked non-read-only SQL keyword: ${match[1]}`);
  return sql;
}

function normalizeLimit(limit: number | undefined) {
  const requested = Number.isFinite(limit) ? Math.floor(Number(limit)) : 100;
  return Math.max(1, Math.min(MAX_LIMIT, requested));
}

function normalizeRows(rows: QueryRow[]) {
  return rows.map((row) => Object.fromEntries(Object.entries(row).map(([key, value]) => [key, normalizeValue(value)])));
}

function normalizeValue(value: unknown): unknown {
  if (value instanceof Date) return value.toISOString();
  if (typeof value === "bigint") return value.toString();
  return value;
}

async function runReadOnlyQuery(sqlInput: string, limitInput?: number) {
  const sql = assertReadOnlySql(sqlInput);
  const limit = normalizeLimit(limitInput);
  const started = performance.now();
  const client = await pool.connect();
  try {
    await client.query("BEGIN READ ONLY");
    await client.query("SET LOCAL statement_timeout = '15s'");
    const result = await client.query({
      text: `SELECT * FROM (${sql}) AS piui_query_result LIMIT $1`,
      values: [limit + 1],
    });
    await client.query("ROLLBACK");
    const rows = normalizeRows(result.rows.slice(0, limit));
    return {
      sql,
      columns: result.fields.map((field) => ({ name: field.name, dataType: String(field.dataTypeID) })),
      rows,
      rowCount: rows.length,
      truncated: result.rows.length > limit,
      elapsedMs: Math.max(0, Math.round(performance.now() - started)),
    };
  } catch (error) {
    await client.query("ROLLBACK").catch(() => undefined);
    throw error;
  } finally {
    client.release();
  }
}

function markdownTable(columns: string[], rows: QueryRow[]) {
  if (rows.length === 0) return "_No rows returned._";
  const visibleColumns = columns.slice(0, 8);
  const visibleRows = rows.slice(0, 12);
  const header = `| ${visibleColumns.join(" | ")} |`;
  const divider = `| ${visibleColumns.map(() => "---").join(" | ")} |`;
  const body = visibleRows.map((row) => `| ${visibleColumns.map((column) => String(row[column] ?? "").replace(/\|/g, "\\|")).join(" | ")} |`);
  return [header, divider, ...body].join("\n");
}

function schemaDigestText({
  schemas,
  tables,
  columns,
}: {
  schemas: string[];
  tables: Array<{ schema: string; name: string; type: string; rowEstimate?: number | null }>;
  columns: Array<{ schema: string; table: string; name: string; dataType: string; nullable: boolean }>;
}) {
  const relationRows = tables.map((table) => ({
    schema: table.schema,
    relation: table.name,
    type: table.type,
    rows: table.rowEstimate == null || table.rowEstimate < 0 ? "view" : table.rowEstimate.toLocaleString(),
  }));
  const agentFacing = [
    "olap.metric_catalog",
    "olap.v_current_orders",
    "olap.v_current_backlog",
    "olap.v_shipment_health",
    "olap.v_inventory_risk",
    "olap.v_daily_supply_chain_kpi",
    "olap.v_medicine_supply_profile",
    "olap.v_seed_row_counts",
  ];
  const columnsByRelation = new Map<string, Array<{ name: string; dataType: string }>>();
  for (const column of columns) {
    const key = `${column.schema}.${column.table}`;
    const existing = columnsByRelation.get(key) ?? [];
    existing.push({ name: column.name, dataType: column.dataType });
    columnsByRelation.set(key, existing);
  }
  const relationLines = agentFacing
    .filter((relation) => columnsByRelation.has(relation))
    .map((relation) => {
      const relationColumns = columnsByRelation.get(relation) ?? [];
      const renderedColumns = relationColumns.slice(0, 18).map((column) => `${column.name} ${column.dataType}`).join(", ");
      const suffix = relationColumns.length > 18 ? `, ... ${relationColumns.length - 18} more` : "";
      return `- ${relation}: ${renderedColumns}${suffix}`;
    });

  return [
    `Found ${tables.length} relations in ${schemas.join(", ")}. Prefer the olap schema for analytics; use ops for normalized operational detail.`,
    "",
    "Relations:",
    markdownTable(["schema", "relation", "type", "rows"], relationRows),
    "",
    "Agent-facing OLAP views and metric tables:",
    relationLines.join("\n") || "- No agent-facing OLAP views found.",
    "",
    "Before inventing metric SQL, query olap.metric_catalog. For backlog, shipment health, inventory risk, daily KPIs, and medicine supply profile, start from the olap.v_* views listed above.",
  ].join("\n");
}

const describeDatabaseTool = defineTool({
  name: "db_describe",
  label: "Describe Database",
  description: "Inspect the read-only analytics database schemas, tables, views, and columns.",
  promptSnippet: "Inspect available SQL tables/views in the read-only analytics database",
  promptGuidelines: [
    "Use db_describe before writing SQL when the user asks database or analytics questions.",
    "Prefer the olap schema and metric_catalog for analytics questions; use ops only when operational detail is required.",
  ],
  parameters: Type.Object({
    schemas: Type.Optional(Type.Array(Type.String(), { description: "Schemas to inspect. Defaults to ops and olap." })),
  }),
  async execute(_toolCallId, params) {
    const schemas = params.schemas?.length ? params.schemas : DEFAULT_SCHEMAS;
    const client = await pool.connect();
    try {
      const tableResult = await client.query(
        `
          SELECT n.nspname AS schema, c.relname AS name,
                 CASE c.relkind WHEN 'r' THEN 'table' WHEN 'v' THEN 'view' WHEN 'm' THEN 'materialized_view' ELSE c.relkind::text END AS type,
                 c.reltuples::bigint AS row_estimate
          FROM pg_class c
          JOIN pg_namespace n ON n.oid = c.relnamespace
          WHERE n.nspname = ANY($1) AND c.relkind IN ('r', 'v', 'm')
          ORDER BY n.nspname, c.relkind, c.relname
        `,
        [schemas],
      );
      const columnResult = await client.query(
        `
          SELECT table_schema AS schema, table_name AS table, column_name AS name, data_type, is_nullable = 'YES' AS nullable
          FROM information_schema.columns
          WHERE table_schema = ANY($1)
          ORDER BY table_schema, table_name, ordinal_position
        `,
        [schemas],
      );
      const tables = tableResult.rows.map((row) => ({
        schema: String(row.schema),
        name: String(row.name),
        type: String(row.type),
        rowEstimate: row.row_estimate === null ? null : Number(row.row_estimate),
      }));
      const columns = columnResult.rows.map((row) => ({
        schema: String(row.schema),
        table: String(row.table),
        name: String(row.name),
        dataType: String(row.data_type),
        nullable: Boolean(row.nullable),
      }));
      const text = schemaDigestText({ schemas, tables, columns });
      return {
        content: [{ type: "text", text }],
        details: { kind: "database_schema", title: "Analytics database schema", schemas, tables, columns },
      };
    } finally {
      client.release();
    }
  },
});

const queryDatabaseTool = defineTool({
  name: "db_query",
  label: "Query Database",
  description: "Run a read-only SELECT query against the analytics database and return rows for inspection.",
  promptSnippet: "Run a bounded read-only SELECT/WITH query against the analytics database",
  promptGuidelines: [
    "Use db_query only for SELECT/WITH statements.",
    "Keep result sets compact and aggregate in SQL before returning rows.",
    "Prefer views in olap such as v_current_backlog, v_shipment_health, v_inventory_risk, v_daily_supply_chain_kpi, and v_medicine_supply_profile.",
  ],
  parameters: Type.Object({
    sql: Type.String({ description: "Read-only SELECT/WITH SQL. Do not include mutations or multiple statements." }),
    limit: Type.Optional(Type.Number({ description: `Maximum rows to return, capped at ${MAX_LIMIT}.` })),
    title: Type.Optional(Type.String({ description: "Short human-readable label for the result." })),
  }),
  async execute(_toolCallId, params) {
    const result = await runReadOnlyQuery(params.sql, params.limit);
    const details: SqlResultDetails = { kind: "sql_result", title: params.title, ...result };
    const text = [
      `${params.title || "SQL result"}: ${details.rowCount}${details.truncated ? "+" : ""} rows in ${details.elapsedMs}ms.`,
      markdownTable(details.columns.map((column) => column.name), details.rows),
    ].join("\n\n");
    return { content: [{ type: "text", text }], details };
  },
});

const visualizeDatabaseTool = defineTool({
  name: "db_visualize",
  label: "Visualize Database",
  description: "Run a read-only aggregate SQL query and return a chart-ready result for the UI.",
  promptSnippet: "Create a compact bar or line visualization from a read-only SQL aggregate",
  promptGuidelines: [
    "Use db_visualize when the user asks for a chart, trend, ranking, comparison, or visual summary.",
    "Return one label column and one numeric value column; use clear aliases matching the x and y parameters.",
    "yLabel must name the metric in 1-3 words (e.g. 'Units shipped', 'On-time %', 'Backlog orders'). xLabel must name the dimension in 1-2 words (e.g. 'Week', 'Facility', 'Carrier'). They render as a small caption above the chart, never as rotated axis labels — keep them short and skimmable.",
    "Prefer 12-40 rows so the visualization has enough shape to inspect. Aggregate to a meaningful grain such as day, week, facility, medicine category, lane, carrier, or status.",
    "For ordered time-series results, choose chartType=line and order by the x-axis column. For ranked categorical comparisons, choose chartType=bar and order by the metric descending.",
    "Keep categorical x-axis labels short (under ~14 chars). The UI truncates longer labels and rotates them when there are many bars, so prefer codes or abbreviations for facility/lane/carrier names when possible.",
    "Prefer OLAP views and fact/dimension tables for analytics. Avoid a single collapsed value unless the user explicitly asks for a KPI.",
  ],
  parameters: Type.Object({
    sql: Type.String({ description: "Read-only SELECT/WITH SQL for chart data." }),
    chartType: Type.Union([Type.Literal("bar"), Type.Literal("line")], { description: "Visualization type." }),
    x: Type.String({ description: "Column name to use for x-axis labels." }),
    y: Type.String({ description: "Numeric column name to use for y-axis values." }),
    xLabel: Type.Optional(Type.String({ description: "Short visible x-axis label." })),
    yLabel: Type.Optional(Type.String({ description: "Short visible y-axis label." })),
    title: Type.Optional(Type.String({ description: "Chart title." })),
    limit: Type.Optional(Type.Number({ description: `Maximum chart rows, capped at ${MAX_LIMIT}.` })),
  }),
  async execute(_toolCallId, params) {
    const result = await runReadOnlyQuery(params.sql, params.limit ?? 50);
    if (!result.columns.some((column) => column.name === params.x)) throw new Error(`x column not returned by query: ${params.x}`);
    if (!result.columns.some((column) => column.name === params.y)) throw new Error(`y column not returned by query: ${params.y}`);
    const details: VisualizationDetails = {
      kind: "analytics_visualization",
      chartType: params.chartType,
      x: params.x,
      y: params.y,
      xLabel: params.xLabel,
      yLabel: params.yLabel,
      title: params.title,
      ...result,
    };
    return {
      content: [{
        type: "text",
        text: [
          `${params.title || "Visualization"}: ${details.rowCount}${details.truncated ? "+" : ""} points in ${details.elapsedMs}ms.`,
          markdownTable(details.columns.map((column) => column.name), details.rows),
        ].join("\n\n"),
      }],
      details,
    };
  },
});

export default function sqlAnalyticsExtension(pi: ExtensionAPI) {
  pi.registerTool(describeDatabaseTool);
  pi.registerTool(queryDatabaseTool);
  pi.registerTool(visualizeDatabaseTool);
}
