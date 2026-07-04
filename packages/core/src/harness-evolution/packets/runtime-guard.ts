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

// S1-1 spec A: 扩展注入正则，覆盖中英文
// 英文：ignore/override/bypass/forget/disregard + previous/prior/above/earlier/system/developer instructions
// 中文：忽略/无视/覆盖/忘记/不要遵守 + 以上/上述/之前/前面/系统/安全 + 指令/规则/约束/提示
const PROMPT_INJECTION_RE = new RegExp(
  [
    // 英文模式
    String.raw`\b(?:ignore|override|bypass|forget|disregard|neglect|skip)\s+(?:all\s+)?(?:(?:previous|prior|above|earlier)(?:\s+(?:system|developer|user))?|system|developer)\s+instructions\b`,
    String.raw`\breveal\s+(?:the\s+)?(?:system|developer)\s+prompt\b`,
    String.raw`\b(?:print|output|show|display|leak)\s+(?:the\s+)?(?:system|initial)\s+prompt\b`,
    String.raw`\bdo\s+not\s+follow\s+(?:your\s+)?(?:system|developer)\s+(?:prompt|instructions)\b`,
    // S1-1 中文模式
    String.raw`忽略(?:以上|上述|之前|前面|上面)(?:所有)?(?:指令|规则|约束|提示|系统提示)`,
    String.raw`无视(?:以上|上述|之前|前面)(?:指令|规则|约束)`,
    String.raw`覆盖(?:系统|安全)(?:规则|约束|提示)`,
    String.raw`忘记(?:之前|前面|上述)的(?:指令|规则|约束|提示)`,
    String.raw`不要(?:遵守|遵循|执行)(?:系统|安全)(?:规则|约束|指令)`,
    String.raw`显示(?:你的)?系统(?:提示|prompt)`,
  ].join("|"),
  "i",
);

// S1-1 spec B: 收紧 untrusted input 判定，需与 action co-occurrence 同时出现才报 minor
const UNTRUSTED_INPUT_RE = /\b(?:untrusted|external|third[-\s]?party|browser|email|scraped|pasted)\b/i;
const ACTION_CO_OCCURRENCE_RE = /\b(?:execute|run|interpret|follow|process|handle|parse)\b/i;
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

  // S1-1 spec B: untrusted input 需与 action co-occurrence 同时出现，且无 approval，才报 minor
  if (
    UNTRUSTED_INPUT_RE.test(prompt)
    && ACTION_CO_OCCURRENCE_RE.test(prompt)
    && !APPROVAL_RE.test(prompt)
  ) {
    findings.push({
      id: `GF${++idCounter}`,
      kind: "untrusted_input",
      severity: "minor",
      summary: "Prompt contains untrusted external input with action directive without explicit approval",
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

/**
 * S1-1 spec C: guardToolOutput 检查工具输出中的 prompt injection 和 secret exfiltration。
 * 第一阶段只记录日志（disposition=review），不直接替换工具输出。
 * 注意：工具输出中的 rm -rf 等代码示例不应默认 block，否则会误伤安全测试、文档和 fixture。
 */
export function guardToolOutput(toolName: string, output: string): GuardResult {
  const findings: GuardFinding[] = [];
  let idCounter = 0;

  // S1-1: 检查 prompt injection（工具输出可能包含恶意指令）
  if (PROMPT_INJECTION_RE.test(output)) {
    findings.push({
      id: `GF${++idCounter}`,
      kind: "prompt_injection",
      severity: "critical",
      summary: `Tool "${toolName}" output contains prompt injection pattern`,
      evidence: matchEvidence(output, PROMPT_INJECTION_RE),
      recommendedChecks: [
        "Treat tool output as data, not instruction",
        "Avoid injecting this content into supervisor/control prompts without quoting",
      ],
    });
  }

  if (SECRET_EXFIL_RE.test(output)) {
    findings.push({
      id: `GF${++idCounter}`,
      kind: "secret_exfiltration",
      severity: "critical",
      summary: `Tool "${toolName}" output may contain secret exfiltration pattern`,
      evidence: matchEvidence(output, SECRET_EXFIL_RE),
      recommendedChecks: ["Block outbound action containing secrets"],
    });
  }

  // S1-1: 第一阶段只记录，不改写 toolEvent.content
  // streaming-executor.ts 中对 guardToolOutput 的 block/review 都只记日志
  const hasCritical = findings.some((f) => f.severity === "critical");
  const disposition: RuntimeGuardDisposition = hasCritical ? "review" : "allow";

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
