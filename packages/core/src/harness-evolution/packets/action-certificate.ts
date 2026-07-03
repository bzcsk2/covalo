import type { PacketBase } from "./types";

export const ACTION_CERTIFICATE_SCHEMA_VERSION = "covalo.action-certificate.v1";

export type RiskLevel = "low" | "medium" | "high";

export type ApprovalClass =
  | "not_required"
  | "supervisor_reviewed"
  | "human_reviewed"
  | "runtime_enforced";

export type ApprovalBy = "supervisor" | "human" | "policy";

export type OutcomeStatus = "ok" | "failed" | "cancelled" | "blocked_by_policy";

// High-risk command patterns
const HIGH_RISK_RE = /\b(?:rm\s+-rf|git\s+reset\s+--hard|git\s+clean\s+-f|drop\s+database|truncate\s+table|terraform\s+destroy|kubectl\s+delete|npm\s+publish|pnpm\s+publish|git\s+push|deploy\b|terraform\s+apply|kubectl\s+apply)\b/i;

// Medium-risk command patterns
const MEDIUM_RISK_RE = /\b(?:chmod|chown|mv|cp|rm|git\s+reset|git\s+rebase|git\s+merge\b|git\s+push\b--force|npm\s+run\s+(?:lint|format|check))\b/i;

export interface ActionInfo {
  toolName: string;
  command?: string;
  affectedFiles: string[];
  promptSha256?: string;
}

export interface ApprovalInfo {
  class: ApprovalClass;
  approvedBy?: ApprovalBy;
}

export interface ActionOutcome {
  status: OutcomeStatus;
  exitCode?: number | null;
  durationMs?: number;
  outputSha256?: string;
}

export interface ActionCertificatePacket extends PacketBase {
  schemaVersion: typeof ACTION_CERTIFICATE_SCHEMA_VERSION;
  actionId: string;
  action: ActionInfo;
  riskLevel: RiskLevel;
  approval: ApprovalInfo;
  assumptions: string[];
  rollbackPlan?: string;
  outcome?: ActionOutcome;
}

export function classifyRisk(command: string): RiskLevel {
  if (HIGH_RISK_RE.test(command)) return "high";
  if (MEDIUM_RISK_RE.test(command)) return "medium";
  return "low";
}

export function createActionCertificate(params: {
  packetId: string;
  runId: string;
  actionId: string;
  action: ActionInfo;
  riskLevel: RiskLevel;
  approval: ApprovalInfo;
  assumptions: string[];
  rollbackPlan?: string;
  mode: ActionCertificatePacket["mode"];
  role: ActionCertificatePacket["role"];
  evalRunId?: string;
  caseId?: string;
}): ActionCertificatePacket {
  return {
    schemaVersion: ACTION_CERTIFICATE_SCHEMA_VERSION,
    packetId: params.packetId,
    runId: params.runId,
    evalRunId: params.evalRunId,
    caseId: params.caseId,
    mode: params.mode,
    role: params.role,
    createdAt: new Date().toISOString(),
    actionId: params.actionId,
    action: params.action,
    riskLevel: params.riskLevel,
    approval: params.approval,
    assumptions: params.assumptions,
    rollbackPlan: params.rollbackPlan,
  };
}

export function completeActionCertificate(
  packet: ActionCertificatePacket,
  outcome: ActionOutcome,
): ActionCertificatePacket {
  return { ...packet, outcome };
}
