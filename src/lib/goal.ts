import type { Style } from "./ta";

export const GOAL_USD = 1_000_000;
export const STAGE2_USD = 10_000;

export type PhaseId = "micro" | "seed" | "grow" | "checkpoint" | "scale" | "harvest" | "done";
export type MethodId = "vela" | "trend" | "fade" | "break";

export type Phase = {
  id: PhaseId;
  name: string;
  marginPct: number;
  style: Style;
  maxOpen: number;
  minRr: number;
  minConf: number;
  method: MethodId;
  note: string;
};

export function stageTarget(equity: number, continueToGoal: boolean): number {
  if (continueToGoal || equity >= GOAL_USD) return GOAL_USD;
  return STAGE2_USD;
}

export function clampPeak(equity: number, peak: number): number {
  const p = Math.max(Number.isFinite(peak) ? peak : 0, equity);
  if (equity > 50 && p > equity * 1.42) return equity / 0.82;
  return p;
}

export function phaseFor(equity: number, continueToGoal = false): Phase {
  if (equity >= GOAL_USD) {
    return {
      id: "done",
      name: "Done",
      marginPct: 1,
      style: "swing",
      maxOpen: 0,
      minRr: 2.2,
      minConf: 78,
      method: "trend",
      note: "Goal printed. Stand down unless you raise the target.",
    };
  }
  if (equity >= STAGE2_USD && !continueToGoal) {
    return {
      id: "checkpoint",
      name: "Re-evaluate",
      marginPct: 1,
      style: "swing",
      maxOpen: 0,
      minRr: 2,
      minConf: 78,
      method: "trend",
      note: "Stage 2 printed ($10k). No new tickets. Re-evaluate, then tap Continue to $1M.",
    };
  }
  if (equity < 100) {
    return {
      id: "micro",
      name: "Stage 1",
      marginPct: 2,
      style: "scalp",
      maxOpen: 2,
      minRr: 1.9,
      minConf: 78,
      method: "trend",
      note: "Stage 1 · 2% · 1 at-risk, 2nd after TP1/BE.",
    };
  }
  if (equity < 1000) {
    return {
      id: "seed",
      name: "Stage 1",
      marginPct: 2,
      style: "scalp",
      maxOpen: 2,
      minRr: 1.9,
      minConf: 78,
      method: "trend",
      note: "Stage 1 · 2% (1.2% after 3 losses). 1 at-risk, 2nd after TP1/BE.",
    };
  }
  return {
    id: "grow",
    name: "Stage 2",
    marginPct: 2,
    style: "scalp",
    maxOpen: 2,
    minRr: 1.9,
    minConf: 78,
    method: "trend",
    note: "Stage 2: $1k → $10k. 2% size. 1 at-risk, 2nd after TP1/BE. Stop at $10k.",
  };
}

export function afterCheckpoint(equity: number): Phase {
  if (equity >= GOAL_USD) return phaseFor(equity, true);
  if (equity < 100_000) {
    return {
      id: "scale",
      name: "Scale",
      marginPct: 1.2,
      style: "swing",
      maxOpen: 4,
      minRr: 2,
      minConf: 68,
      method: "trend",
      note: "You signed off. Scale toward $1M. Tighter R, 1.2% margin.",
    };
  }
  return {
    id: "harvest",
    name: "Harvest",
    marginPct: 1,
    style: "swing",
    maxOpen: 1,
    minRr: 2.2,
    minConf: 74,
    method: "trend",
    note: "Last stretch to $1M. One high-quality swing at 1%.",
  };
}

export function phaseForRun(equity: number, continueToGoal: boolean): Phase {
  if (continueToGoal && equity >= STAGE2_USD && equity < GOAL_USD) return afterCheckpoint(equity);
  return phaseFor(equity, continueToGoal);
}

export function adaptMethod(opts: {
  phase: Phase;
  lossStreak: number;
  winStreak: number;
  lastMargin: number;
  drawdownPct: number;
  closed: number;
  wins: number;
}): Phase {
  if (opts.phase.id === "checkpoint" || opts.phase.id === "done") return opts.phase;
  let next = { ...opts.phase };
  const wr = opts.closed >= 5 ? opts.wins / opts.closed : 1;

  if (opts.closed >= 12 && wr < 0.35) {
    next = {
      ...next,
      note: `${next.note} Book is cold — still A++ only, 86% bar. Size rules unchanged.`,
    };
  }

  next = { ...next, marginPct: 2 };

  // Size cuts lift on wins, not on waiting for equity to climb back.
  const restored = opts.winStreak >= 2;
  if (opts.drawdownPct >= 30 && !restored) {
    next = {
      ...next,
      marginPct: 1,
      minConf: Math.min(82, next.minConf + 4),
      note: `${next.note} ~30% off peak. 1% until two wins in a row — then back to 2%.`,
    };
  } else if (opts.lossStreak >= 5) {
    next = {
      ...next,
      marginPct: 1,
      minConf: Math.min(82, next.minConf + 3),
      note: `${next.note} Five losses. 1% size. A win restores 2%.`,
    };
  } else if (opts.lossStreak >= 3) {
    next = {
      ...next,
      marginPct: 1.2,
      note: `${next.note} Risk cut to 1.2% after three losses. A win restores 2%.`,
    };
  }
  return next;
}

export function progressPct(equity: number, target = GOAL_USD): number {
  if (equity <= 0 || target <= 0) return 0;
  return Math.min(100, Math.max(0, (equity / target) * 100));
}

export function multipleToGoal(equity: number, target = GOAL_USD): number {
  if (equity <= 0) return target / 5;
  return target / equity;
}
