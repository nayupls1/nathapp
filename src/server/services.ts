// All of the server's services, wired together. The HTTP server (index.ts)
// and the tests build on this.
import { Layer } from "effect";
import * as Agent from "./agent/Agent";
import * as Mcp from "./agent/Mcp";
import { ServerConfig, type ServerConfigShape } from "./Config";
import * as Apps from "./db/Apps";
import * as Db from "./db/Db";
import * as Settings from "./db/Settings";
import * as Sites from "./db/Sites";
import * as Hub from "./Hub";
import * as Providers from "./providers/Providers";
import * as Runtime from "./workspace/Runtime";
import * as Sandbox from "./workspace/Sandbox";
import * as Workspace from "./workspace/Workspace";

export const services = (config: ServerConfigShape) =>
  Agent.layer.pipe(
    Layer.provideMerge(Runtime.layer),
    Layer.provideMerge(Layer.mergeAll(Workspace.layer, Sandbox.layer, Providers.layer, Mcp.layer(config.url))),
    Layer.provideMerge(Layer.mergeAll(Apps.layer, Settings.layer, Sites.layer, Hub.layer)),
    Layer.provideMerge(Db.layer),
    Layer.provideMerge(Layer.succeed(ServerConfig, config)),
  );
