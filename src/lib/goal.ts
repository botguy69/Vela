import type { Style } from "./ta";

export const GOAL_USD = 1_000_000;

export type PhaseId = "micro" | "seed" | "grow" | "scale" | "harvest" | "done";
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

export function phaseFor(equity: number): Phase {
  if (equity >= GOAL_USD) {
    return {
      id: "done",
      name: "Done",
      marginPct: 1,
      style: "swing",
      maxOpen: 1,
      minRr: 2.2,
      minConf: 74,
      method: "trend",
      note: "Goal printed. Stand down unless you raise the target.",
    };
  }
  if (equity < 100) {
    return {
      id: "micro",
      name: "Micro",
      marginPct: 2,
      style: "scalp",
      maxOpen: 1,
      minRr: 1.9,
      minConf: 70,
      method: "trend",
      note: "Stage 1: high-prob scalps only (70%+ conf, 1.9R+) until $1,000.",
    };
  }
  if (equity < 1000) {
    return {
      id: "seed",
      name: "Seed",
      marginPct: 2,
      style: "scalp",
      maxOpen: 1,
      minRr: 1.9,
      minConf: 70,
      method: "trend",
      note: "Stage 1: high-prob scalps only until $1,000. One ticket, 21h holds.",
    };
  }
  if (equity < 10_000) {
    return {
      id: "grow",
      name: "Grow",
      marginPct: 1.5,
      style: "swing",
      maxOpen: 2,
      minRr: 1.8,
      minConf: 64,
      method: "vela",
      note: "Stage 2. Past $1,000. Same 1–2% box, wider swings.",
    };
  }
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
      note: "Protect the pile. Tighter R, 1.2% margin.",
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

export function adaptMethod(opts: {
  phase: Phase;
  lossStreak: number;
  drawdownPct: number;
  closed: number;
  wins: number;
}): Phase {
  let next = { ...opts.phase };
  const wr = opts.closed >= 5 ? opts.wins / opts.closed : 1;

  // Honest first try stays on vela until the tape proves it isn't paying.
  if (opts.closed >= 12 && wr < 0.35) {
    if (next.method === "vela") {
      next = { ...next, method: "trend", minRr: Math.max(next.minRr, 1.9), note: "First method missed. Rotating to trend-only, still 1–2% margin at coin max." };
    } else if (next.method === "trend" && wr < 0.3 && opts.closed >= 18) {
      next = { ...next, method: "fade", style: "scalp", note: "Trend wasn't paying. Trying mean-reversion fades. Same margin box." };
    } else if (next.method === "fade" && wr < 0.3 && opts.closed >= 24) {
      next = { ...next, method: "break", style: "scalp", note: "Fades missed. Trying range breaks only. Still 1–2% at max leverage." };
    }
  }

  if (opts.lossStreak >= 3 || opts.drawdownPct >= 25) {
    next = {
      ...next,
      marginPct: 1,
      maxOpen: 1,
      minRr: Math.max(next.minRr, 2),
      minConf: Math.min(82, next.minConf + 6),
      note: `${next.note} Cooling: 1% margin, one ticket, higher conf until the book heals.`,
    };
  } else if (opts.lossStreak >= 2 || opts.drawdownPct >= 15) {
    next = {
      ...next,
      marginPct: Math.min(next.marginPct, 1.2),
      maxOpen: 1,
      minConf: Math.min(82, next.minConf + 4),
      note: `${next.note} Pulled back to 1.2% and one ticket. Raising the conf bar.`,
    };
  }
  return next;
}

export function progressPct(equity: number): number {
  if (equity <= 0) return 0;
  return Math.min(100, Math.max(0, (equity / GOAL_USD) * 100));
}

export function multipleToGoal(equity: number): number {
  if (equity <= 0) return GOAL_USD / 5;
  return GOAL_USD / equity;
}
