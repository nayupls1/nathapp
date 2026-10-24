// All of the server's services, wired together. The HTTP server (index.ts)
// and the tests build on this.
import { Layer } from "effect";
import * as Agent from "./agent/Agent";
import * as Mcp from "./agent/Mcp";
import * as Ai from "./ai/Ai";
import * as AiTokens from "./ai/AiTokens";
import { ServerConfig, type ServerConfigShape } from "./Config";
import * as Apps from "./db/Apps";
import * as Db from "./db/Db";
import * as Settings from "./db/Settings";
import * as Sites from "./db/Sites";
import * as Workspaces from "./db/Workspaces";
import * as History from "./history/History";
import * as Hub from "./Hub";
import * as Providers from "./providers/Providers";
import * as Audit from "./security/Audit";
import * as Permissions from "./security/Permissions";
import * as Secrets from "./security/Secrets";
import * as Vault from "./security/Vault";
import * as Runtime from "./workspace/Runtime";
import * as Sandbox from "./workspace/Sandbox";
import * as Workspace from "./workspace/Workspace";

/** Everything but the agents: storage, security, projects, the runtime and history (enough for most tests). */
export const core = (config: ServerConfigShape) =>
  History.layer.pipe(
    Layer.provideMerge(Runtime.layer),
    Layer.provideMerge(Layer.mergeAll(Workspace.layer, Sandbox.layer)),
    Layer.provideMerge(Secrets.layer),
    Layer.provideMerge(Permissions.layer),
    Layer.provideMerge(Layer.mergeAll(Vault.layer, Audit.layer)),
    Layer.provideMerge(Layer.mergeAll(Apps.layer, Workspaces.layer, Settings.layer, Sites.layer, Hub.layer, AiTokens.tokensLayer)),
    Layer.provideMerge(Db.layer),
    Layer.provideMerge(Layer.succeed(ServerConfig, config)),
  );

export const services = (config: ServerConfigShape) =>
  Layer.mergeAll(Agent.layer, Ai.layer).pipe(
    Layer.provideMerge(Layer.mergeAll(Providers.layer, Mcp.layer(config.url))),
    Layer.provideMerge(core(config)),
  );
