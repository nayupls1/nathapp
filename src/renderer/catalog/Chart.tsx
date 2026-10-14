// The "chart" catalog component, rendered with TanStack Charts.
import * as stylex from "@stylexjs/stylex";
import { areaY, barX, barY, colorLegend, defineChart, lineY, ruleY } from "@tanstack/charts";
import { pie, polar, radialArc } from "@tanstack/charts/polar";
import { scaleBand } from "@tanstack/charts/scales/band";
import { scaleLinear } from "@tanstack/charts/scales/linear";
import { scalePoint } from "@tanstack/charts/scales/point";
import { Chart as TanStackChart } from "@tanstack/charts/solid";
import { tooltip } from "@tanstack/charts/tooltip";
import { createMemo, Show } from "solid-js";
import type { UINode, Value } from "../../shared/spec";
import { chartColors, colors, font, radius, space } from "../theme.stylex";
import { findColumn, formatBucket, formatStat, formatValue, framed, useData, useTable } from "./context";

type ChartNode = Extract<UINode, { type: "chart" }>;

interface Datum {
  label: string;
  series: string;
  value: number;
}

/** Feeds our palette into TanStack Charts' CSS palette tokens. */
const palette = {
  "--ts-chart-1": chartColors.c1,
  "--ts-chart-2": chartColors.c2,
  "--ts-chart-3": chartColors.c3,
  "--ts-chart-4": chartColors.c4,
  "--ts-chart-5": chartColors.c5,
  "--ts-chart-6": chartColors.c6,
};

const unique = (values: string[]) => [...new Set(values)];

function buildDefinition(kind: NonNullable<ChartNode["kind"]>, rows: Datum[], hasSeries: boolean) {
  const labels = unique(rows.map((r) => r.label));
  const legend = hasSeries ? { legend: colorLegend() } : undefined;
  const color = hasSeries ? ("series" as const) : undefined;

  switch (kind) {
    case "bar-horizontal":
      return defineChart({
        marks: [barX(rows, { x: "value", y: "label", color, inset: 2, radius: 3 })],
        scales: {
          x: { scale: scaleLinear, nice: true, grid: true },
          y: { scale: () => scaleBand<string>().domain(labels).padding(0.2) },
        },
        color: legend,
        tooltip,
      });
    case "line":
      return defineChart({
        // The zero rule keeps the baseline in the y domain, like bars have.
        marks: [ruleY([0]), lineY(rows, { x: "label", y: "value", color, z: color, points: true })],
        scales: {
          x: { scale: () => scalePoint<string>().domain(labels).padding(0.2) },
          y: { scale: scaleLinear, nice: true, grid: true },
        },
        color: legend,
        tooltip,
      });
    case "area":
      return defineChart({
        marks: [ruleY([0]), areaY(rows, { x: "label", y: "value", color, z: color, fillOpacity: 0.75 })],
        scales: {
          x: { scale: () => scalePoint<string>().domain(labels).padding(0.1) },
          y: { scale: scaleLinear, nice: true, grid: true },
        },
        color: legend,
        tooltip,
      });
    case "pie":
    case "donut": {
      const slices = pie(rows, { value: "value" });
      return defineChart({
        marks: [
          polar({
            inset: 8,
            radiusRatio: 0.85,
            marks: [
              radialArc(slices, {
                innerRadius: ({ radius }) => (kind === "donut" ? radius * 0.58 : 0),
                cornerRadius: 3,
                color: "label",
                key: "label",
              }),
            ],
            scales: { angle: null, radius: null },
          }),
        ],
        scales: { x: null, y: null },
        color: { domain: labels, legend: colorLegend() },
        tooltip,
      });
    }
    default:
      return defineChart({
        marks: [barY(rows, { x: "label", y: "value", color, inset: 2, radius: 3 })],
        scales: {
          x: { scale: () => scaleBand<string>().domain(labels).padding(0.2) },
          y: { scale: scaleLinear, nice: true, grid: true },
        },
        color: legend,
        tooltip,
      });
  }
}

export function Chart(props: { node: ChartNode }) {
  const table = useTable(() => props.node.table);
  const data = useData<{ groups: { key: Value; series?: Value; value: number | null }[] }>(() => ({
    op: "aggregate",
    table: props.node.table,
    aggregate: props.node.aggregate,
    column: props.node.column,
    where: props.node.where,
    groupBy: props.node.groupBy,
    bucket: props.node.bucket,
    seriesBy: props.node.seriesBy,
  }));

  const rows = createMemo((): Datum[] => {
    const groups = data.latest?.groups ?? [];
    const node = props.node;
    const label = (key: Value) =>
      node.bucket ? formatBucket(node.bucket, key) : formatValue(findColumn(table(), node.groupBy), key);
    const seriesCol = node.seriesBy ? findColumn(table(), node.seriesBy) : undefined;
    return groups.map((g) => ({
      label: label(g.key),
      series: seriesCol ? formatValue(seriesCol, g.series) : "",
      value: g.value ?? 0,
    }));
  });

  const definition = createMemo(() =>
    buildDefinition(props.node.kind ?? "bar", rows(), !!props.node.seriesBy),
  );
  const total = () => rows().reduce((sum, r) => sum + r.value, 0);

  return (
    <div {...stylex.attrs(s.root, framed() && s.frame)}>
      <Show when={props.node.title}>
        <h3 {...stylex.attrs(s.title)}>{props.node.title}</h3>
      </Show>
      <Show
        when={rows().length}
        fallback={<p {...stylex.attrs(s.empty)}>{data.latest ? "No data yet." : "Loading…"}</p>}
      >
        <TanStackChart
          definition={definition() as Parameters<typeof TanStackChart>[0]["definition"]}
          height={props.node.height ?? 260}
          initialWidth={600}
          ariaLabel={props.node.title ?? `${props.node.aggregate} by ${props.node.groupBy}`}
          style={palette}
        />
        <Show when={props.node.kind === "pie" || props.node.kind === "donut"}>
          <p {...stylex.attrs(s.caption)}>Total {formatStat(total())}</p>
        </Show>
      </Show>
    </div>
  );
}

const s = stylex.create({
  root: { display: "flex", flexDirection: "column", gap: space.md, minWidth: 0, color: colors.text },
  frame: {
    padding: space.lg,
    borderRadius: radius.md,
    borderWidth: 1,
    borderStyle: "solid",
    borderColor: colors.border,
    backgroundColor: colors.surface,
  },
  title: { margin: 0, fontSize: font.md, fontWeight: 600 },
  empty: { margin: 0, padding: space.lg, textAlign: "center", color: colors.muted, fontSize: font.sm },
  caption: { margin: 0, fontSize: font.xs, color: colors.muted, textAlign: "center" },
});
