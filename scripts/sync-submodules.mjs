#!/usr/bin/env node
import { maybeSyncSubmodulesOnStart } from "../src/submodule-sync.js";

process.env.DATA_SYNC_ON_START = "true";
console.log("[data-sync] cli wrapper enabled DATA_SYNC_ON_START=true");
await maybeSyncSubmodulesOnStart();
