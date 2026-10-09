export const CASES = [
  {
    id: "stable-priority-v1",
    domain: "analysis",
    complexity: "simple",
    instruction:
      'Return JSON only: {"ids":[...]}. Sort these jobs by priority ascending, preserving the input order for equal priority. Jobs: [{"id":"c","priority":2},{"id":"b","priority":1},{"id":"a","priority":1},{"id":"d","priority":3}].',
    verify: (x) =>
      Array.isArray(x?.ids) &&
      JSON.stringify(x.ids) === JSON.stringify(["b", "a", "c", "d"]),
  },
  {
    id: "dependency-blocking-v1",
    domain: "analysis",
    complexity: "complex",
    instruction:
      'Return JSON only: {"order":[...],"blocked":[...]}. Schedule all runnable jobs in dependency order. Choose the alphabetically smallest currently runnable job at each step. A missing dependency blocks the job and its dependants. Cycles block their jobs and dependants. Return blocked ids alphabetically. Jobs: A:[], B:[A], C:[A], D:[X], E:[D], F:[G], G:[F], H:[B,C]. X is absent.',
    verify: (x) =>
      JSON.stringify(x?.order) === JSON.stringify(["A", "B", "C", "H"]) &&
      JSON.stringify(x?.blocked) === JSON.stringify(["D", "E", "F", "G"]),
  },
];
export function parseAnswer(text) {
  const clean = text
    .trim()
    .replace(/^```(?:json)?\s*/i, "")
    .replace(/\s*```$/, "");
  return JSON.parse(clean);
}
