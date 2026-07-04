import { createTaskDigest } from "./packets/task-digest";
import { createReviewPacket, type ReviewPacket } from "./packets/review-packet";
import { createIncidentPacket, classifyFailureClass, type IncidentPacket } from "./packets/incident-packet";
import { createRecoveryPacket, type RecoveryPacket } from "./packets/recovery-packet";
import { PacketStore } from "./packets/packet-store";
import type { PacketBase, HarnessMode, RepairLoopState } from "./packets/types";
import { anyGateFailed } from "./loop/deterministic-gates";
import type { DeterministicGateResult } from "./loop/deterministic-gates";

export interface RepairLoopConfig {
  baseDir: string;
  runId: string;
  mode: HarnessMode;
  maxRounds: number;
  role: "worker" | "supervisor" | "system";
  onPacket?: (packet: { type: string; data: unknown }) => void;
  keepBest?: boolean;
}

export interface RepairPlan {
  accept: boolean;
  escalate: boolean;
  remainingRounds: number;
  recoveryPacket: RecoveryPacket | null;
  summary: string;
  bestRoundNumber?: number;
}

export interface RepairRound {
  roundNumber: number;
  state: RepairLoopState;
  reviewPacket: ReviewPacket | null;
  incidentPacket: IncidentPacket | null;
  recoveryPacket: RecoveryPacket | null;
  accepted: boolean;
  workerOutput: string;
  gateResults?: DeterministicGateResult[];
}

/**
 * 有界修复循环 — 实验性模块，尚未实际接入 engine runtime 路径。
 *
 * 在门禁检查失败后自动修复提示表面。真正接入需要单独设计，当前不要在生产 submit 中依赖。
 *
 * @experimental
 */
export class BoundedRepairLoop {
  private config: RepairLoopConfig;
  private store: PacketStore;
  private rounds: RepairRound[] = [];
  private active: RepairRound | null = null;

  constructor(config: RepairLoopConfig) {
    this.config = config;
    this.store = new PacketStore({
      baseDir: config.baseDir,
      runId: config.runId,
    });
  }

  get currentRound(): Readonly<RepairRound> | null {
    return this.active ? { ...this.active } : null;
  }

  get allRounds(): readonly RepairRound[] {
    return [...this.rounds];
  }

  get gateFailureCount(): number {
    return this.rounds.filter(r =>
      r.gateResults && anyGateFailed(r.gateResults),
    ).length;
  }

  getBestRound(): RepairRound | null {
    if (this.rounds.length === 0) return null;
    const scored = this.rounds.map(r => ({
      round: r,
      failures: r.gateResults ? r.gateResults.filter(g => !g.passed).length : Infinity,
      accepted: r.accepted,
    }));
    scored.sort((a, b) => a.failures - b.failures || (b.accepted ? 1 : 0) - (a.accepted ? 1 : 0));
    return scored[0].round;
  }

  async init(): Promise<void> {
    await this.store.init();
  }

  startRound(roundNumber: number): RepairRound {
    const round: RepairRound = {
      roundNumber,
      state: "planned",
      reviewPacket: null,
      incidentPacket: null,
      recoveryPacket: null,
      accepted: false,
      workerOutput: "",
    };
    this.active = round;
    this.rounds.push(round);
    return round;
  }

  completeWorker(workerOutput: string): void {
    if (!this.active) return;
    this.active.workerOutput = workerOutput;
    this.active.state = "reviewing";
  }

  setGateResults(results: DeterministicGateResult[]): void {
    if (!this.active) return;
    this.active.gateResults = results;
  }

  setReview(review: ReviewPacket): void {
    if (!this.active) return;
    this.active.reviewPacket = review;
    this.store.append(review).catch(() => {});
    this.config.onPacket?.({ type: "review", data: review });
  }

  setIncident(incident: IncidentPacket): void {
    if (!this.active) return;
    this.active.incidentPacket = incident;
    this.store.append(incident).catch(() => {});
    this.config.onPacket?.({ type: "incident", data: incident });
  }

  getPlan(): RepairPlan {
    const round = this.active ?? this.rounds[this.rounds.length - 1];
    const remainingRounds = this.config.maxRounds - this.rounds.length;

    if (!round) {
      return { accept: false, escalate: false, remainingRounds: 0, recoveryPacket: null, summary: "No rounds executed" };
    }

    const review = round.reviewPacket;
    const incidents = round.incidentPacket?.incidents ?? [];

    const reviewAccepted = review?.verdict === "ACCEPTED";

    if (reviewAccepted && incidents.length === 0) {
      round.accepted = true;
      round.state = "accepted";
      return { accept: true, escalate: false, remainingRounds, recoveryPacket: null, summary: "Review accepted, no incidents" };
    }

    if (remainingRounds <= 0) {
      round.state = "escalated";
      const bestRound = this.getBestRound();
      return {
        accept: false,
        escalate: true,
        remainingRounds: 0,
        recoveryPacket: null,
        summary: `Max repair rounds exceeded (best: round ${bestRound?.roundNumber ?? "none"})`,
        bestRoundNumber: bestRound?.roundNumber,
      };
    }

    const recoveryPacket = createRecoveryPacket({
      packetId: `${this.config.runId}:recovery:r${round.roundNumber}`,
      runId: this.config.runId,
      mode: this.config.mode,
      role: this.config.role,
      incidents,
    });
    this.store.append(recoveryPacket).catch(() => {});
    this.config.onPacket?.({ type: "recovery", data: recoveryPacket });
    round.recoveryPacket = recoveryPacket;

    round.state = recoveryPacket.gate.disposition === "ready" ? "repairing" : "failed";

    return {
      accept: false,
      escalate: recoveryPacket.gate.disposition === "blocked",
      remainingRounds,
      recoveryPacket,
      summary: recoveryPacket.gate.disposition === "ready"
        ? `Round ${round.roundNumber} incident(s): ${incidents.map(i => i.kind).join(", ")}`
        : `Round ${round.roundNumber} gate blocked: no recovery path`,
    };
  }

  async close(accepted: boolean): Promise<void> {
    if (!this.active) return;
    this.active.state = accepted ? "accepted" : "failed";
    this.active.accepted = accepted;
  }
}

export function buildRepairInstruction(recoveryPacket: RecoveryPacket, round: number): string {
  const steps = recoveryPacket.steps.map(s =>
    `[${s.phase}] ${s.action}`,
  ).join("\n");
  return `## Repair Round ${round}\n${recoveryPacket.gate.reasons.join("; ")}\n\nSteps:\n${steps}\n\nApply the minimal fix.`;
}
