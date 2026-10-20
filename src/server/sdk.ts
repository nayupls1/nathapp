// The realtime SDK's source, embedded into the server (also in the compiled
// binary): served as JavaScript to custom components and copied into backends.
// @ts-expect-error -- Bun text import (the file's contents as a string)
import source from "../sdk/gapp.ts" with { type: "text" };

export const sdkSource = source as string;
export const sdkJs = new Bun.Transpiler({ loader: "ts" }).transformSync(sdkSource);
