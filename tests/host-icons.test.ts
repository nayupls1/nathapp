import { expect, test } from "bun:test";
import { Glob } from "bun";
import { isIcon } from "../src/server/icons";

// The host UI refers to Lucide icons by string name; a typo renders nothing.
test("every icon name used in the renderer exists", async () => {
  const unknown: string[] = [];
  for await (const file of new Glob("src/renderer/**/*.tsx").scan()) {
    const source = await Bun.file(file).text();
    for (const [, name] of source.matchAll(/(?:\bname=|\bicon: )"([a-z0-9-]+)"/g)) {
      if (!isIcon(name!)) unknown.push(`${file}: ${name}`);
    }
  }
  expect(unknown).toEqual([]);
});
