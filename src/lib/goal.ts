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

export function phaseFor(equity: number, continueToGoal = false): Phase {
  if (equity >= GOAL_USD) {
    return {
      id: "done",
      name: "Done",
      marginPct: 1,
      style: "swing",
      maxOpen: 0,
      minRr: 2.2,
      minConf: 74,
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
      minConf: 74,
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
      minConf: 70,
      method: "trend",
      note: "Stage 1: full list. High-prob scalps to $1,000. Long + short ok. Not two same-way BTC bets.",
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
      minConf: 70,
      method: "trend",
      note: "Stage 1: full list to $1,000. Long + short ok. After TP1/BE, the next ticket can open — up to 6 live.",
    };
  }
  return {
    id: "grow",
    name: "Stage 2",
    marginPct: 2,
    style: "scalp",
    maxOpen: 2,
    minRr: 1.9,
    minConf: 70,
    method: "trend",
    note: "Stage 2: $1k → $10k. Same high-prob bar. Majors only. Second ticket only if it isn’t the same beta. Stop at $10k.",
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
      maxOpen: 2,
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
  drawdownPct: number;
  closed: number;
  wins: number;
}): Phase {
  if (opts.phase.id === "checkpoint" || opts.phase.id === "done") return opts.phase;
  let next = { ...opts.phase };
  const wr = opts.closed >= 5 ? opts.wins / opts.closed : 1;

  if (opts.closed >= 12 && wr < 0.35) {
    if (next.method === "vela") {
      next = { ...next, method: "trend", minRr: Math.max(next.minRr, 1.9), note: "First method missed. Rotating to trend-only, still 1–2% margin at coin max." };
    } else if (next.method === "trend" && wr < 0.3 && opts.closed >= 18) {
      next = { ...next, method: "fade", style: "scalp", note: "Trend wasn't paying. Trying mean-reversion fades. Same margin box." };
    } else if (next.method === "fade" && wr < 0.3 && opts.closed >= 24) {
      next = { ...next, method: "break", style: "scalp", note: "Fades missed. Trying range breaks only. Still 1–2% at max leverage." };
    }
  }

  // Size cools. Slot count does not — BE compounding still works.
  if (opts.drawdownPct >= 30) {
    next = {
      ...next,
      marginPct: 1,
      maxOpen: 1,
      minRr: Math.max(next.minRr, 2),
      minConf: Math.min(82, next.minConf + 6),
      note: `${next.note} Book is ~30% off peak. One at-risk at 1% until equity heals.`,
    };
  } else if (opts.lossStreak >= 5) {
    next = {
      ...next,
      marginPct: 1,
      minConf: Math.min(82, next.minConf + 4),
      note: `${next.note} Five losses: still two at-risk, 1% margin, higher conf.`,
    };
  } else if (opts.lossStreak >= 4) {
    next = {
      ...next,
      marginPct: Math.min(next.marginPct, 1.2),
      minConf: Math.min(82, next.minConf + 2),
      note: `${next.note} Four losses: 1.2% size, still two at-risk.`,
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
