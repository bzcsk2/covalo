import type { PacketBase, EvidenceRef } from "./types";

export const RUNTIME_GUARD_SCHEMA_VERSION = "covalo.runtime-guard.v1";

export type RuntimeGuardDisposition = "allow" | "review" | "block";

export const GUARD_FINDING_KINDS = [
  "prompt_injection",
  "untrusted_input",
  "untrusted_input_controls_action",
  "destructive_action",
  "privileged_action_without_certificate",
  "approval_missing",
  "secret_exfiltration",
  "source_provenance",
] as const;

export type GuardFindingKind = typeof GUARD_FINDING_KINDS[number];

export type GuardFindingSeverity = "critical" | "major" | "minor";

export interface GuardFinding {
  id: string;
  kind: GuardFindingKind;
  severity: GuardFindingSeverity;
  summary: string;
  evidence: EvidenceRef[];
  recommendedChecks: string[];
}

export interface RuntimeGuardPacket extends PacketBase {
  schemaVersion: typeof RUNTIME_GUARD_SCHEMA_VERSION;
  disposition: RuntimeGuardDisposition;
  findings: GuardFinding[];
}

// Patterns adapted from FuguNano runtime-guard.ts
const PROMPT_INJECTION_RE = /\b(?:ignore|override|bypass|forget|disregard|neglect|skip)\s+(?:all\s+)?(?:(?:previous|prior|above|earlier)(?:\s+(?:system|developer|user))?|system|developer)\s+instructions\b|\breveal\s+(?:the\s+)?(?:system|developer)\s+prompt\b|\b(?:print|output|show|display|leak)\s+(?:the\s+)?(?:system|initial)\s+prompt\b/i;
const UNTRUSTED_INPUT_RE = /\b(?:untrusted|external|third[-\s]?party|browser|email|issue|pull request|comment|pasted|scraped)\b/i;
const DESTRUCTIVE_ACTION_RE = /\b(?:rm\s+-rf|git\s+reset\s+--hard|git\s+clean\s+-f|drop\s+database|truncate\s+table|terraform\s+destroy|kubectl\s+delete)\b/i;
const PRIVILEGED_ACTION_RE = /\b(?:git\s+push|npm\s+publish|pnpm\s+publish|deploy\b|terraform\s+apply|kubectl\s+apply)\b/i;
const SECRET_EXFIL_RE = /\b(?:api[-_\s]?key|access[-_\s]?token|secret|password|credential)\b[\s\S]{0,80}\b(?:send|upload|post|curl|wget|exfiltrate|leak)\b/i;
const APPROVAL_RE = /\b(?:approved|approval|human-reviewed|operator-reviewed)\b/i;

export interface GuardResult {
  disposition: RuntimeGuardDisposition;
  findings: GuardFinding[];
}

export function guardPrompt(prompt: string, sourceRef?: string): GuardResult {
  const findings: GuardFinding[] = [];
  let idCounter = 0;

  if (PROMPT_INJECTION_RE.test(prompt)) {
    findings.push({
      id: `GF${++idCounter}`,
      kind: "prompt_injection",
      severity: "critical",
      summary: "Prompt contains instructions to ignore or override system instructions",
      evidence: matchEvidence(prompt, PROMPT_INJECTION_RE),
      recommendedChecks: ["Strip injected instructions before dispatch", "Re-verify user intent"],
    });
  }

  if (UNTRUSTED_INPUT_RE.test(prompt) && !APPROVAL_RE.test(prompt)) {
    findings.push({
      id: `GF${++idCounter}`,
      kind: "untrusted_input",
      severity: "major",
      summary: "Prompt contains untrusted external input without explicit approval",
      evidence: matchEvidence(prompt, UNTRUSTED_INPUT_RE),
      recommendedChecks: ["Verify the external source reference", "Wrap untrusted content in data-only block"],
    });
  }

  if (DESTRUCTIVE_ACTION_RE.test(prompt)) {
    findings.push({
      id: `GF${++idCounter}`,
      kind: "destructive_action",
      severity: "critical",
      summary: "Prompt contains destructive command pattern",
      evidence: matchEvidence(prompt, DESTRUCTIVE_ACTION_RE),
      recommendedChecks: ["Require human approval for destructive actions", "Verify rollback plan exists"],
    });
  }

  if (PRIVILEGED_ACTION_RE.test(prompt)) {
    findings.push({
      id: `GF${++idCounter}`,
      kind: "privileged_action_without_certificate",
      severity: "major",
      summary: "Prompt contains privileged action without certificate",
      evidence: matchEvidence(prompt, PRIVILEGED_ACTION_RE),
      recommendedChecks: ["Obtain action certificate before dispatch", "Separate trusted control from untrusted data"],
    });
  }

  if (SECRET_EXFIL_RE.test(prompt)) {
    findings.push({
      id: `GF${++idCounter}`,
      kind: "secret_exfiltration",
      severity: "critical",
      summary: "Prompt may exfiltrate secrets via outbound action",
      evidence: matchEvidence(prompt, SECRET_EXFIL_RE),
      recommendedChecks: ["Block outbound action containing secrets", "Verify no credentials in outgoing data"],
    });
  }

  if (!sourceRef && findings.length === 0) {
    findings.push({
      id: `GF${++idCounter}`,
      kind: "source_provenance",
      severity: "minor",
      summary: "Prompt has no source reference for provenance tracking",
      evidence: [],
      recommendedChecks: ["Attach source ref for traceability"],
    });
  }

  const hasCritical = findings.some((f) => f.severity === "critical");
  const hasMajor = findings.some((f) => f.severity === "major");
  const disposition: RuntimeGuardDisposition = hasCritical ? "block" : hasMajor ? "review" : "allow";

  return { disposition, findings };
}

export function guardToolOutput(toolName: string, output: string): GuardResult {
  const findings: GuardFinding[] = [];
  let idCounter = 0;

  if (SECRET_EXFIL_RE.test(output)) {
    findings.push({
      id: `GF${++idCounter}`,
      kind: "secret_exfiltration",
      severity: "critical",
      summary: `Tool output from ${toolName} may contain secrets`,
      evidence: matchEvidence(output, SECRET_EXFIL_RE),
      recommendedChecks: ["Redact secrets before returning to model", "Verify tool output handling"],
    });
  }

  if (UNTRUSTED_INPUT_RE.test(output)) {
    findings.push({
      id: `GF${++idCounter}`,
      kind: "untrusted_input",
      severity: "major",
      summary: `Tool output from ${toolName} contains untrusted content patterns`,
      evidence: matchEvidence(output, UNTRUSTED_INPUT_RE),
      recommendedChecks: ["Wrap tool output in data-only block when injecting to context"],
    });
  }

  const hasCritical = findings.some((f) => f.severity === "critical");
  const hasMajor = findings.some((f) => f.severity === "major");
  const disposition: RuntimeGuardDisposition = hasCritical ? "block" : hasMajor ? "review" : "allow";

  return { disposition, findings };
}

function matchEvidence(text: string, re: RegExp): EvidenceRef[] {
  const evidence: EvidenceRef[] = [];
  const lines = text.split("\n");
  for (let i = 0; i < lines.length && evidence.length < 3; i++) {
    if (re.test(lines[i])) {
      evidence.push({
        file: "(prompt)",
        line: i + 1,
        excerpt: lines[i].trim().slice(0, 200),
      });
    }
  }
  return evidence;
}

export function createRuntimeGuardPacket(params: {
  packetId: string;
  runId: string;
  prompt: string;
  sourceRef?: string;
  mode: RuntimeGuardPacket["mode"];
  role: RuntimeGuardPacket["role"];
  evalRunId?: string;
  caseId?: string;
}): RuntimeGuardPacket {
  const { disposition, findings } = guardPrompt(params.prompt, params.sourceRef);
  return {
    schemaVersion: RUNTIME_GUARD_SCHEMA_VERSION,
    packetId: params.packetId,
    runId: params.runId,
    evalRunId: params.evalRunId,
    caseId: params.caseId,
    mode: params.mode,
    role: params.role,
    createdAt: new Date().toISOString(),
    disposition,
    findings,
  };
}
