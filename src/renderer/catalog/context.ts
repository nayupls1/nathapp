import { createContext, createResource, useContext, type Accessor } from "solid-js";
import type { DataRequest, DataResponse } from "../../shared/api";
import type { AppSpec, Bucket, Column, Table, Value } from "../../shared/spec";
import { api } from "../lib/api";

export interface AppContextValue {
  appId: string;
  spec: Accessor<AppSpec>;
  dataVersion: Accessor<number>;
  /** Marks data as changed so every data component refetches. */
  invalidate: () => void;
}

export const AppContext = createContext<AppContextValue>();

/** Card-like components drop their own frame when nested inside a card. */
export const InCard = createContext(false);
export const framed = () => !useContext(InCard);

export function useApp() {
  const ctx = useContext(AppContext);
  if (!ctx) throw new Error("useApp must be used inside <AppView>");
  return ctx;
}

export function useTable(name: Accessor<string>) {
  const { spec } = useApp();
  return () => spec().tables.find((t) => t.name === name());
}

export const builtinColumns: Column[] = [
  { name: "id", label: "ID", type: "number" },
  { name: "created_at", label: "Created", type: "date" },
];

export function findColumn(table: Table | undefined, name: string): Column | undefined {
  return [...(table?.columns ?? []), ...builtinColumns].find((c) => c.name === name);
}

export const columnLabel = (col: Column) =>
  col.label ?? col.name.replace(/_/g, " ").replace(/^./, (c) => c.toUpperCase());

/** Fetches app data and refetches whenever the request or data version changes. */
export function useData<T extends DataResponse>(request: Accessor<DataRequest>) {
  const { appId, dataVersion } = useApp();
  const [data] = createResource(
    () => ({ req: request(), v: dataVersion() }),
    ({ req }) => api.data<T>(appId, req),
  );
  return data;
}

/** Runs a mutation and refreshes all data components afterwards. */
export function useMutate() {
  const { appId, invalidate } = useApp();
  return async (req: DataRequest) => {
    const res = await api.data(appId, req);
    invalidate();
    return res;
  };
}

// --- Formatting ------------------------------------------------------------------

export function formatValue(col: Column | undefined, value: Value | undefined): string {
  if (value === null || value === undefined || value === "") return "—";
  if (col?.type === "boolean") return value ? "Yes" : "No";
  if (col?.name === "created_at") return new Date(String(value)).toLocaleString();
  if (col?.type === "date") {
    const d = new Date(`${value}T00:00:00`);
    return Number.isNaN(d.getTime()) ? String(value) : d.toLocaleDateString();
  }
  if (col?.type === "number" && typeof value === "number") return value.toLocaleString();
  return String(value);
}

export function formatBucket(bucket: Bucket, key: Value): string {
  if (key === null) return "—";
  const k = String(key);
  if (bucket === "month") {
    const d = new Date(`${k}-01T00:00:00`);
    return Number.isNaN(d.getTime()) ? k : d.toLocaleDateString(undefined, { month: "short", year: "numeric" });
  }
  if (bucket === "day") return new Date(`${k}T00:00:00`).toLocaleDateString();
  return k;
}

export function formatStat(value: number | null, format?: "number" | "currency" | "percent") {
  if (value === null) return "—";
  if (format === "currency") return value.toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 });
  if (format === "percent") return `${value.toLocaleString(undefined, { maximumFractionDigits: 1 })}%`;
  return value.toLocaleString(undefined, { maximumFractionDigits: 2 });
}
