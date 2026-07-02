/**
 * Unified prompt catalog — single entry point for all Covalo-authored prompts.
 *
 * Modules:
 * - locale:     locale state, persistence, normalization
 * - system:     base system prompt (bilingual)
 * - agents:     Worker, Supervisor, Subagent built-in prompts (bilingual)
 * - workflow:   supervisor guided loop prompts (bilingual)
 * - eval:       eval wrapper prompts (bilingual)
 * - governance: task ledger, verification gate, branch budget, steering (bilingual)
 *
 * @module
 */
export * as system from "./system.js";
export * as agents from "./agents.js";
export * as workflow from "./workflow.js";
export * as eval_ from "./eval.js";
export * as governance from "./governance.js";
