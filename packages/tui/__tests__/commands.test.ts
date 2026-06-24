import { describe, expect, it } from "bun:test"
import {
  buildHelpText,
  formatSkillList,
  getThinkingModes,
  parseSlashCommand,
  toggleAgent,
  validateThinkingMode,
} from "../src/commands.js"
import type { Strings } from "../src/i18n/strings.js"

function stubStrings(overrides?: Partial<Strings>): Strings {
  return {
    placeholder: '',
    queued: () => '',
    processing: '',
    pasteSummary: () => '',
    allow: '',
    alwaysAllow: '',
    deny: '',
    permissionTitle: '',
    requestsToExecute: '',
    parameters: () => '',
    permissionHint: '',
    thinking: '',
    toolUse: '',
    you: '',
    assistant: '',
    reply: '',
    ctrlO: '',
    thinkingDots: '',
    roleWorker: '',
    roleSupervisor: '',
    roleUnknown: '',
    inputTokens: '',
    outputTokens: '',
    cacheHit: '',
    sessions: '',
    sessionHint: '',
    loading: '',
    error: '',
    noSessions: '',
    msgs: () => '',
    modelSettings: '',
    current: '',
    enterApiKey: () => '',
    escToGoBack: '',
    pressEToEdit: '',
    pressDToDelete: '',
    keySourceEnv: '',
    keySourceFile: '',
    keySourceDefault: '',
    configured: '',
    yourApiKey: '',
    confirmDelete: '',
    pressYToConfirm: '',
    updateKey: '',
    apiKeyMasked: () => '',
    cmdExit: 'exit',
    cmdHelp: 'show help',
    cmdModel: 'switch provider/model',
    cmdSessions: 'browse past sessions',
    cmdAgent: 'switch agent (deprecated, use dual-role mode)',
    cmdSkill: 'manage skills',
    cmdLang: 'switch language',
    cmdStatus: 'show runtime status',
    cmdContext: 'configure context trim/compact',
    pressCtrlC: '',
    shuttingDown: '',
    loadedSkills: () => '',
    failedLoadSkills: () => '',
    switchedTo: () => '',
    switchedModel: () => '',
    switchedLang: () => '',
    resumedSession: () => '',
    writing: '',
    aborted: '',
    tps: () => '',
    linesDropped: () => '',
    truncatedByEsc: '',
    rejected: '',
    exitCode: () => '',
    cmdAutocompleteHint: '',
    searchHint: '',
    unknownError: '',
    unknownWarning: '',
    unknown: '',
    pendingTasks: '',
    plural: () => '',
    helpTitle: 'Commands:',
    helpAgents: 'Agents:',
    helpCurrent: 'Current:',
    helpDeprecatedAgentNote: 'Note: /agent build|plan commands are deprecated.',
    cmdTheme: '',
    cmdThinking: '',
    cmdWorkflow: '',
    cmdTalk: '',
    cmdGoal: '',
    cmdGoalSet: '',
    cmdGoalEdit: '',
    cmdGoalPause: '',
    cmdGoalResume: '',
    cmdGoalClear: '',
    cmdGoalBudget: '',
    cmdGoalNoBudget: '',
    failedLoadStatus: '',
    thinkingModeSet: () => '',
    thinkingModeCurrent: () => '',
    harnessStatus: () => '',
    harnessSetSession: () => '',
    harnessSetProject: () => '',
    harnessProjectUsage: '',
    workflowInstructionQueued: () => '',
    inputTargetSwitched: () => '',
    goalSet: () => '',
    goalReplaced: () => '',
    goalUpdated: () => '',
    goalNoActive: '',
    goalNoActiveToEdit: '',
    goalPause: '',
    goalResume: '',
    goalClear: '',
    goalInvalidBudget: '',
    goalBudgetSet: () => '',
    goalBudgetRemoved: '',
    goalStatusLine: () => '',
    goalOnlyLoop: '',
    goalNoBudgetSet: '',
    goalUsage: '',
    welcomeTagline: '',
    welcomePanelAgent: '',
    welcomePanelComponents: '',
    welcomeThinking: '',
    welcomeContext: '',
    welcomeSubagent: '',
    welcomeProvider: '',
    welcomeSkills: '',
    welcomeMcp: '',
    welcomeDiagnostics: () => '',
    welcomeDiagnosticsLabel: '',
    welcomeHelpHint: '',
    welcomeLangHint: '',
    contextModeTrim: '',
    contextModeCompact: '',
    modalEscClose: '',
    selectHint: '',
    loadingSkills: '',
    skillsAvailable: () => '',
    noSkillsFound: '',
    skillEnabled: () => '',
    skillDisabled: () => '',
    skillNoDescription: '',
    skillFooterHint: '',
    contextLoading: '',
    contextLoaded: '',
    contextSaved: '',
    contextReducing: '',
    contextSubtitle: () => '',
    contextModeDescription: '',
    contextTriggerDescription: () => '',
    contextTargetDescription: () => '',
    contextRunNow: '',
    contextRunDescription: '',
    contextFooterHint: '',
    contextRunResult: () => '',
    permissionRead: '',
    permissionEdit: '',
    permissionExecute: '',
    permissionDirectory: '',
    permissionFetch: '',
    permissionSearch: '',
    permissionAgent: '',
    permissionAllowOnce: '',
    permissionAlwaysAllow: '',
    permissionReject: '',
    permissionToolWants: '',
    permissionPatterns: '',
    permissionSuggested: '',
    permissionEnterConfirm: '',
    permissionEscReject: '',
    permissionRejectTitle: '',
    permissionToolDenied: '',
    permissionTypeMessage: '',
    permissionEnterSubmit: '',
    permissionEscCancel: '',
    permissionUpDownSelect: '',
    permissionAlwaysTitle: '',
    permissionAlwaysAutoApproved: '',
    questionSummary: '',
    questionNoAnswer: '',
    questionSubmitting: '',
    questionConfirmAnswers: '',
    questionTypeYourOwn: '',
    questionTypeAnswer: '',
    statusSectionStatus: '',
    statusSectionContext: '',
    statusSectionStats: '',
    statusSectionSessionWriter: '',
    statusYes: '',
    statusNo: '',
    workflowPhaseAnalyse: '',
    workflowPhaseDo: '',
    workflowPhaseReport: '',
    workflowPhaseCheck: '',
    workflowPhaseContinue: '',
    workflowPhaseRevise: '',
    workflowPhaseApprove: '',
    workflowPhaseBlocked: '',
    workflowPhaseAskUser: '',
    workflowLifecycleAwaitingGoal: '',
    workflowLifecycleRunning: '',
    workflowLifecycleWaiting: '',
    workflowLifecycleBlocked: '',
    workflowLifecycleCompleted: '',
    workflowLifecycleFailed: '',
    workflowRoleIdle: '',
    workflowRoleAnalyse: '',
    workflowRoleDo: '',
    workflowRoleReport: '',
    workflowRoleWait: '',
    workflowRoleBlocked: '',
    workflowModeAlone: '',
    workflowModeSubagent: '',
    workflowModeLoop: '',
    workflowAwaitingGoal: '',
    workflowBlockedMsg: '',
    workflowAlreadyRunning: '',
    workflowModeChanged: () => '',
    workflowLoopStarted: '',
    agentStatusQueued: '',
    agentStatusStarting: '',
    agentStatusRunning: '',
    agentStatusPermission: '',
    agentStatusAnswer: '',
    agentStatusReview: '',
    agentStatusVerifying: '',
    agentStatusPaused: '',
    agentStatusCompleted: '',
    agentStatusFailed: '',
    agentStatusCancelled: '',
    agentStatusIdle: '',
    agentGroupRunning: () => '',
    agentGroupCompleted: () => '',
    agentGroupFailed: () => '',
    agentGroupNoWorkers: '',
    agentGroupWorkersIdle: () => '',
    workerPanelTitle: '',
    workerPanelTotal: () => '',
    workerPanelOutputFocused: '',
    workerPanelList: '',
    workerPanelNoActive: '',
    workerPanelNoOutput: '',
    workerPanelNotFound: '',
    workerPanelOutput: () => '',
    workerPanelSelectHint: '',
    workerPanelEscBack: '',
    workerPanelNavigate: '',
    workerTaskDone: '',
    workerTaskError: '',
    workerTaskIdle: '',
    virtualizedNoMessages: '',
    virtualizedScrollToBottom: '',
    virtualizedBottom: '',
    contextModeRowLabel: '',
    contextTriggerRowLabel: '',
    contextTargetRowLabel: '',
    contextRunRowLabel: '',
    modelCustomConfigure: '',
    modelCustomBaseUrl: '',
    modelCustomModel: '',
    modelCustomPlaceholder: '',
    harnessStrictDesc: '',
    harnessNormalDesc: '',
    harnessLooseDesc: '',
    harnessSetTo: () => '',
    harnessProjectSet: () => '',
    harnessFooter: '',
    workflowMenuAlone: () => '',
    workflowMenuSubagent: () => '',
    workflowMenuLoop: () => '',
    workflowInterruptRunning: '',
    agentMenuTitle: () => '',
    agentMenuSubtitle: () => '',
    searchNoMatch: '',
    customProviderName: '',
    ...overrides,
  }
}

describe("CL-52: slash command routing helpers", () => {
  it("parses supported commands and the exit alias", () => {
    expect(parseSlashCommand("/exit")).toEqual({ name: "exit" })
    expect(parseSlashCommand("/bye")).toEqual({ name: "exit" })
    expect(parseSlashCommand("  /model  ")).toEqual({ name: "model" })
    expect(parseSlashCommand("/sessions")).toEqual({ name: "sessions" })
    expect(parseSlashCommand("/skill")).toEqual({ name: "skill" })
    expect(parseSlashCommand("/agent")).toEqual({ name: "agent" })
    expect(parseSlashCommand("/lang")).toEqual({ name: "lang" })
    expect(parseSlashCommand("/status")).toEqual({ name: "status" })
    expect(parseSlashCommand("/context")).toEqual({ name: "context" })
  })

  it("keeps normal and unknown input outside slash routing", () => {
    expect(parseSlashCommand("hello")).toBeNull()
    expect(parseSlashCommand("/unknown")).toBeNull()
  })

  it("parses /goal commands", () => {
    expect(parseSlashCommand("/goal")).toEqual({ name: "goal" })
    expect(parseSlashCommand("/goal fix all bugs")).toEqual({ name: "goal", subcommand: "status", objective: "fix all bugs" })
    expect(parseSlashCommand("/goal edit")).toEqual({ name: "goal", subcommand: "edit" })
    expect(parseSlashCommand("/goal pause")).toEqual({ name: "goal", subcommand: "pause" })
    expect(parseSlashCommand("/goal resume")).toEqual({ name: "goal", subcommand: "resume" })
    expect(parseSlashCommand("/goal clear")).toEqual({ name: "goal", subcommand: "clear" })
    expect(parseSlashCommand("/goal budget 50000")).toEqual({ name: "goal", subcommand: "budget", arg: "50000" })
    expect(parseSlashCommand("/goal no-budget")).toEqual({ name: "goal", subcommand: "no-budget" })
    expect(parseSlashCommand("/goal edit fix the tests")).toEqual({ name: "goal", subcommand: "edit", arg: "fix the tests" })
  })

  it("parses and validates thinking modes", () => {
    expect(parseSlashCommand("/thinking high")).toEqual({ name: "thinking", mode: "high" })
    expect(parseSlashCommand("/thinking")).toEqual({ name: "thinking", mode: "" })
    expect(getThinkingModes()).toEqual(["off", "high", "max"])
    expect(validateThinkingMode("max")).toBeNull()
    expect(validateThinkingMode("open")).toContain("Usage: /thinking <mode>")
    expect(validateThinkingMode("invalid")).toContain("Usage: /thinking <mode>")
  })

  it("toggles through all registered agents", () => {
    expect(toggleAgent("worker").next).toBe("supervisor")
    expect(toggleAgent("supervisor").next).toBe("worker")
  })

  it("builds help text with command strings and the active agent", () => {
    const help = buildHelpText("build", stubStrings({
      cmdExit: "exit",
      cmdHelp: "help",
      cmdModel: "model",
      cmdSessions: "sessions",
      cmdAgent: "agent",
      cmdSkill: "skill",
      cmdLang: "lang",
      cmdStatus: "status",
      cmdContext: "context",
    }))

    expect(help).toContain("/exit, /bye")
    expect(help).toContain("/status")
    expect(help).toContain("/context")
    expect(help).toContain("Agents:")
    expect(help).toContain("Current:")
  })

  it("buildHelpText includes new commands", () => {
    const help = buildHelpText("worker", stubStrings({
      cmdTheme: "theme description",
      cmdThinking: "thinking description",
      cmdWorkflow: "workflow description",
    }))

    expect(help).toContain("/theme")
    expect(help).toContain("/thinking")
    expect(help).toContain("/workflow")
  })

  it("formats skill lists with truncation and preserves malformed fallback", () => {
    const skills = Array.from({ length: 21 }, (_, index) => ({
      name: `skill-${index}`,
      description: `description-${index}`,
    }))
    const formatted = formatSkillList(
      JSON.stringify({ count: skills.length, skills }),
      count => `Loaded ${count}\n`,
    )

    expect(formatted).toContain("Loaded 21")
    expect(formatted).toContain("skill-19")
    expect(formatted).not.toContain("skill-20")
    expect(formatted).toContain("... and 1 more")
    expect(formatSkillList("not-json", count => `Loaded ${count}\n`)).toBe("not-json")
  })
})
