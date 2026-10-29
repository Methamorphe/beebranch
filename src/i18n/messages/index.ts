// Message catalogue entry point.
//
// Every namespace lives in its own module under `fr/` and `en/`. The French
// catalogue defines the key set; the English one must cover it exactly (see
// `translate.ts`). Namespace prefixes keep keys disjoint, e.g. `shell.topbar.*`
// and `graph.legend.*`.

export { default as fr } from './fr'
export { default as en } from './en'
