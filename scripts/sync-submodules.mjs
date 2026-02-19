#!/usr/bin/env node
import { maybeSyncSubmodulesOnStart } from "../src/submodule-sync.js";

process.env.DATA_SYNC_ON_START = "true";
await maybeSyncSubmodulesOnStart();
