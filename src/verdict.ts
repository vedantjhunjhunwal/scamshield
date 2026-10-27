import { gcounter, hll, type IndicatorState } from "./crdt.js";

export type Status = "unknown" | "reported" | "suspicious" | "scam";

export interface Verdict {
  status: Status;
  distinctReporters: number;
  totalReports: number;
  firstSeen: string | null;
  lastSeen: string | null;
}

// Verdicts depend on *distinct* reporters, so one account cannot flag a
// legitimate business as a scam by reporting it repeatedly.
export const THRESHOLDS = { suspicious: 5, scam: 20 } as const;

export function verdictOf(state: IndicatorState | undefined): Verdict {
  if (!state) return { status: "unknown", distinctReporters: 0, totalReports: 0, firstSeen: null, lastSeen: null };
  const distinct = hll.estimate(state.reporters);
  const status: Status = distinct >= THRESHOLDS.scam ? "scam" : distinct >= THRESHOLDS.suspicious ? "suspicious" : "reported";
  return {
    status,
    distinctReporters: distinct,
    totalReports: gcounter.value(state.reports),
    firstSeen: new Date(state.firstSeen).toISOString(),
    lastSeen: new Date(state.lastSeen).toISOString(),
  };
}
