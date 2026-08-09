/**
 * engine.ts — re-export shim.
 *
 * The cashflow engine now lives in components/finance/cashflow.ts so it can be
 * shared with the web UI (the WeeklyOutlook card) — the app tsconfig excludes
 * amplify/functions/, so the pure engine has to live under components/ for the
 * frontend to import it. Same pattern as finance-core.ts. This Lambda keeps
 * importing from "./engine" unchanged.
 */
export * from "../../../components/finance/cashflow";
