import { createContext, createResource, useContext, type Accessor } from "solid-js";
import type { DataRequest, DataResponse } from "../../shared/api";
import type { AppSpec, Column, Table } from "../../shared/spec";
import { api } from "../lib/api";

export interface AppContextValue {
  appId: string;
  spec: Accessor<AppSpec>;
  dataVersion: Accessor<number>;
  /** Marks data as changed so every data component refetches. */
  invalidate: () => void;
}

export const AppContext = createContext<AppContextValue>();

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
