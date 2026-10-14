import { describe, expect, test } from "bun:test";
import { catalogSpec, chartExamples, componentDocs } from "../src/shared/catalog";
import { AppSpec, checkReferences, UINode } from "../src/shared/spec";
import { isIcon } from "../src/server/icons";
import { systemPrompt } from "../src/server/prompt";

// Compile-time check: adding a UINode type without documenting it fails typecheck.
const documented: Record<UINode["type"], true> = {
  stack: true,
  card: true,
  tabs: true,
  heading: true,
  text: true,
  icon: true,
  form: true,
  table: true,
  list: true,
  stat: true,
  chart: true,
  button: true,
};

describe("catalog", () => {
  test("documents every component exactly once", () => {
    const types = componentDocs.map((d) => d.type).sort();
    expect(types).toEqual(Object.keys(documented).sort() as typeof types);
  });

  test.each(componentDocs.map((d) => [d.type, d.example] as const))("%s example is a valid node", (_, example) => {
    expect(UINode.safeParse(example).error).toBeUndefined();
  });

  test.each(chartExamples.map((e, i) => [i, e] as const))("chart example %d is valid", (_, example) => {
    expect(UINode.safeParse(example).error).toBeUndefined();
  });

  test("demo spec validates, including references and icons", () => {
    expect(AppSpec.safeParse(catalogSpec).error).toBeUndefined();
    expect(checkReferences(catalogSpec, { isIcon })).toEqual([]);
  });

  test("system prompt documents every component", () => {
    for (const doc of componentDocs) expect(systemPrompt).toContain(`{ "type": "${doc.type}"`);
  });
});
