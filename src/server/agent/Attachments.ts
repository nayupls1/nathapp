// Files the user gives an agent with a message (pasted screenshots, dropped
// files): kept per tab in <data>/attachments/<tab>/, shown in the chat, and
// handed to the provider: images (and PDFs, for Claude) as content the model
// sees, text files inlined in the prompt, anything else by its path.
import { existsSync, mkdirSync, readFileSync, statSync } from "node:fs";
import { readFile, rm, writeFile } from "node:fs/promises";
import { extname, join } from "node:path";
import { Context, Data, Effect, Layer } from "effect";
import type { Attachment } from "../../shared/api";
import { ServerConfig } from "../Config";

export class AttachmentError extends Data.TaggedError("AttachmentError")<{ readonly message: string }> {}

export const MAX_ATTACHMENT = 20 * 1024 * 1024;
/** Text files up to this size go into the prompt. */
const INLINE_TEXT = 200 * 1024;
export const IMAGE_TYPES = new Set(["image/png", "image/jpeg", "image/gif", "image/webp"]);

/** An attachment on disk, for a provider. */
export interface AttachedFile extends Attachment {
  readonly path: string;
}

const ID = /^[a-f0-9-]{36}$/;
const safeName = (name: string) => name.replace(/[^\w.\- ()]+/g, "_").slice(0, 120) || "file";

const textLike = (mime: string, name: string) =>
  mime.startsWith("text/") ||
  /^application\/(json|xml|javascript|typescript|x-yaml|yaml|toml|x-sh|sql|graphql)/.test(mime) ||
  /\.(txt|md|csv|tsv|json|ya?ml|toml|xml|html?|css|scss|js|jsx|ts|tsx|mjs|py|rb|go|rs|java|kt|swift|c|h|cpp|cs|php|sh|sql|log|ini|env\.example)$/i.test(name);

export interface AttachmentsShape {
  readonly save: (tabId: string, input: { name: string; mime: string; data: Uint8Array }) => Effect.Effect<Attachment, AttachmentError>;
  readonly get: (tabId: string, id: string) => Effect.Effect<AttachedFile | null>;
  /** The prompt with the text files in it, and the files for the provider (images, PDFs, other files by path). */
  readonly forTurn: (prompt: string, files: readonly AttachedFile[]) => Effect.Effect<{ prompt: string; files: AttachedFile[] }>;
  readonly forgetTab: (tabId: string) => Effect.Effect<void>;
}

export class Attachments extends Context.Service<Attachments, AttachmentsShape>()("nathapp/Attachments") {}

export const make = Effect.gen(function* () {
  const config = yield* ServerConfig;
  const root = join(config.dataDir, "attachments");
  const dirOf = (tabId: string) => join(root, tabId.replace(/[^\w-]/g, ""));

  return {
    save: (tabId, { name, mime, data }) =>
      Effect.gen(function* () {
        if (!data.length) return yield* new AttachmentError({ message: "The file is empty." });
        if (data.length > MAX_ATTACHMENT) return yield* new AttachmentError({ message: `${name} is too large (at most ${MAX_ATTACHMENT / 1048576} MB).` });
        const id = crypto.randomUUID();
        const dir = dirOf(tabId);
        const meta: Attachment = { id, name: safeName(name), mime: mime || "application/octet-stream", size: data.length };
        yield* Effect.promise(async () => {
          mkdirSync(dir, { recursive: true });
          await writeFile(join(dir, `${id}${extname(meta.name).slice(0, 10)}`), data);
          await writeFile(join(dir, `${id}.json`), JSON.stringify(meta));
        });
        return meta;
      }),

    get: (tabId, id) =>
      Effect.sync(() => {
        if (!ID.test(id)) return null;
        const dir = dirOf(tabId);
        const metaFile = join(dir, `${id}.json`);
        if (!existsSync(metaFile)) return null;
        const meta = JSON.parse(readFileSync(metaFile, "utf8")) as Attachment;
        const path = join(dir, `${id}${extname(meta.name).slice(0, 10)}`);
        return existsSync(path) && statSync(path).isFile() ? { ...meta, path } : null;
      }),

    forTurn: (prompt, files) =>
      Effect.gen(function* () {
        const inline: string[] = [];
        const rest: AttachedFile[] = [];
        for (const file of files) {
          if (!IMAGE_TYPES.has(file.mime) && file.mime !== "application/pdf" && textLike(file.mime, file.name) && file.size <= INLINE_TEXT) {
            const content = yield* Effect.promise(() => readFile(file.path, "utf8"));
            inline.push(`<attached-file name="${file.name}">\n${content}\n</attached-file>`);
          } else rest.push(file);
        }
        const others = rest.filter((f) => !IMAGE_TYPES.has(f.mime) && f.mime !== "application/pdf");
        const notes = others.length ? `\n\nFiles the user attached (read them from these paths if you can):\n${others.map((f) => `- ${f.name}: ${f.path}`).join("\n")}` : "";
        return { prompt: `${inline.length ? `${inline.join("\n\n")}\n\n` : ""}${prompt}${notes}`, files: rest };
      }),

    forgetTab: (tabId) => Effect.promise(() => rm(dirOf(tabId), { recursive: true, force: true })),
  } satisfies AttachmentsShape;
});

export const layer = Layer.effect(Attachments, make);
