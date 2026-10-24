// Points the server modules at a throwaway data dir. Import this first.
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

process.env.NATHAPP_DATA_DIR = mkdtempSync(join(tmpdir(), "nathapp-test-"));
