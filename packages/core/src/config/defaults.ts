import type { CovaloConfig } from "./schema.js"

export const DEFAULT_CONFIG: CovaloConfig = {
  version: 1,
  providers: {},
  agents: {
    supervisor: {
      provider: "default",
      temperature: 0.2,
      reasoningEffort: "high",
      maxOutputTokens: 4096,
      topP: 1,
      contextStrategy: "full",
      contextTurns: 20,
    },
    worker: {
      provider: "default",
      temperature: 0.1,
      reasoningEffort: "medium",
      maxOutputTokens: 8192,
      topP: 1,
      contextStrategy: "full",
      contextTurns: 20,
    },
  },
  workflow: {
    defaultMode: "alone",
    maxRounds: 6,
    maxConsecutiveErrors: 2,
    supervisorInterventionErrorThreshold: 2,
    structuredProtocol: true,
    requireJsonDecisions: true,
    legacyTextFallback: true,
    askUserOnBlocked: true,
    autoResumeAfterAskUser: false,
  },
  goal: {
    enabled: true,
    autoContinue: true,
    maxAutoContinuations: 10,
    maxConsecutiveBlockedTurns: 3,
    maxConsecutiveTurnErrors: 2,
    defaultTokenBudget: 0,
    completionAuditRequired: true,
    blockedAuditRequired: true,
    injectContinuationPrompt: true,
    injectObjectiveUpdatedPrompt: true,
    injectBudgetLimitPrompt: true,
  },
  mailbox: {
    enabled: true,
    storage: "jsonl",
    waitTimeoutMs: 30000,
    maxMessagesPerRole: 200,
    markReadAfterTurn: true,
    persistStructuredPayloads: true,
    showInTui: true,
  },
  tools: {
    approvalPolicy: "on-request",
    sandbox: "workspace-write",
    dangerousToolsEnabled: false,
    strictMode: false,
    runtimeGuard: { enabled: true, reviewPolicy: "ask", toolOutputMode: "log" },
    supervisor: {
      loop: {
        allow: [],
        deny: ["bash", "edit_file", "apply_patch", "write_file", "AgentTool"],
      },
      subagent: {
        allow: [],
        deny: [],
      },
    },
    worker: {
      loop: {
        allow: [],
        deny: ["update_goal"],
      },
      subagent: {
        allow: [],
        deny: [],
      },
    },
  },
  context: {
    strategy: "goal_focused",
    maxInputTokens: 24000,
    summaryEnabled: true,
    summaryEveryTurns: 4,
    includeMailboxHistory: true,
    includeGoalHistory: true,
    includeToolEvents: false,
  },
  tui: {
    theme: "default",
    showGoalPanel: true,
    showAgentCommFeed: true,
    showTokenUsage: true,
    showToolEvents: false,
    compactReasoning: true,
    confirmBeforeReplacingGoal: true,
    confirmDangerousToolPolicy: true,
  },
  logging: {
    level: "info",
    path: ".covalo/logs",
    eventsJsonl: true,
    mailboxJsonl: true,
    workflowJsonl: true,
    redactSecrets: true,
  },
  trace: {
    enabled: true,
    includePrompts: false,
    includeToolArgs: true,
    includeToolResults: false,
    includeModelOutputs: false,
  },
}

// 预定义的配置模板
export const LOCAL_FIRST_CONFIG: Partial<CovaloConfig> = {
  providers: {
    default: {
      type: "openai-compatible",
      baseUrl: "http://localhost:11434/v1",
      apiKey: "none",
      model: "qwen2.5-coder:7b",
      local: true,
      free: false,
      timeoutMs: 30000,
      maxRetries: 3,
      headers: {},
    },
  },
  goal: {
    enabled: true,
    autoContinue: true,
    maxAutoContinuations: 20,
    maxConsecutiveBlockedTurns: 3,
    maxConsecutiveTurnErrors: 2,
    defaultTokenBudget: 0,
    completionAuditRequired: true,
    blockedAuditRequired: true,
    injectContinuationPrompt: true,
    injectObjectiveUpdatedPrompt: true,
    injectBudgetLimitPrompt: true,
  },
  tools: {
    approvalPolicy: "on-request",
    sandbox: "workspace-write",
    dangerousToolsEnabled: false,
    strictMode: false,
    runtimeGuard: { enabled: true, reviewPolicy: "ask", toolOutputMode: "log" },
    supervisor: {
      loop: {
        allow: [],
        deny: ["bash", "edit_file", "apply_patch", "write_file", "AgentTool"],
      },
      subagent: {
        allow: [],
        deny: [],
      },
    },
    worker: {
      loop: {
        allow: ["read_file", "grep", "list_dir", "bash", "edit_file", "apply_patch"],
        deny: [],
      },
      subagent: {
        allow: [],
        deny: [],
      },
    },
  },
}

export const SAFE_READONLY_CONFIG: Partial<CovaloConfig> = {
  tools: {
    approvalPolicy: "always",
    sandbox: "read-only",
    dangerousToolsEnabled: false,
    strictMode: true,
    runtimeGuard: { enabled: true, reviewPolicy: "block", toolOutputMode: "sanitize" },
    supervisor: {
      loop: {
        allow: [],
        deny: ["bash", "edit_file", "apply_patch", "write_file", "AgentTool"],
      },
      subagent: {
        allow: [],
        deny: [],
      },
    },
    worker: {
      loop: {
        allow: ["read_file", "grep", "list_dir"],
        deny: ["bash", "edit_file", "apply_patch", "write_file"],
      },
      subagent: {
        allow: [],
        deny: [],
      },
    },
  },
}

export const AUTONOMOUS_CODING_CONFIG: Partial<CovaloConfig> = {
  goal: {
    enabled: true,
    autoContinue: true,
    maxAutoContinuations: 50,
    maxConsecutiveBlockedTurns: 3,
    maxConsecutiveTurnErrors: 2,
    defaultTokenBudget: 0,
    completionAuditRequired: true,
    blockedAuditRequired: true,
    injectContinuationPrompt: true,
    injectObjectiveUpdatedPrompt: true,
    injectBudgetLimitPrompt: true,
  },
  tools: {
    approvalPolicy: "on-failure",
    sandbox: "workspace-write",
    dangerousToolsEnabled: false,
    strictMode: false,
    runtimeGuard: { enabled: true, reviewPolicy: "allow", toolOutputMode: "log" },
    supervisor: {
      loop: {
        allow: [],
        deny: ["bash", "edit_file", "apply_patch", "write_file", "AgentTool"],
      },
      subagent: {
        allow: [],
        deny: [],
      },
    },
    worker: {
      loop: {
        allow: [],
        deny: [],
      },
      subagent: {
        allow: [],
        deny: [],
      },
    },
  },
}

export const CONFIG_TEMPLATES: Record<string, Partial<CovaloConfig>> = {
  "default": DEFAULT_CONFIG,
  "local-first": LOCAL_FIRST_CONFIG,
  "safe-readonly": SAFE_READONLY_CONFIG,
  "autonomous-coding": AUTONOMOUS_CODING_CONFIG,
}