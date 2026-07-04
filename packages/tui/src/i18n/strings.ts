/** i18n string definitions and locale management. */

export type Locale = 'zh-CN' | 'en';

export interface Strings {
  // Input
  placeholder: string;
  queued: (n: number) => string;
  processing: string;
  /** 多行粘贴折叠占位符，如 [粘贴 +70 行] */
  pasteSummary: (lineCount: number) => string;
  // Permission
  allow: string;
  alwaysAllow: string;
  deny: string;
  permissionTitle: string;
  requestsToExecute: string;
  parameters: (n: number) => string;
  permissionHint: string;
  // Message cards
  thinking: string;
  toolUse: string;
  you: string;
  assistant: string;
  reply: string;
  ctrlO: string;
  thinkingDots: string;
  /** 角色名标签：双角色模式下时间线每条消息的角色前缀 */
  roleWorker: string;
  roleSupervisor: string;
  roleUnknown: string;
  // Status bar
  inputTokens: string;
  outputTokens: string;
  cacheHit: string;
  // Session picker
  sessions: string;
  sessionHint: string;
  loading: string;
  error: string;
  noSessions: string;
  msgs: (n: number) => string;
  // Model picker
  modelSettings: string;
  current: string;
  enterApiKey: (name: string) => string;
  escToGoBack: string;
  pressEToEdit: string;
  pressDToDelete: string;
  keySourceEnv: string;
  keySourceFile: string;
  keySourceDefault: string;
  configured: string;
  yourApiKey: string;
  confirmDelete: string;
  pressYToConfirm: string;
  updateKey: string;
  apiKeyMasked: (suffix: string) => string;
  // Slash commands
  cmdCases: string;
  cmdEval: string;
  cmdExit: string;
  cmdHelp: string;
  cmdModel: string;
  cmdSessions: string;
  cmdAgent: string;
  cmdSkill: string;
  cmdLang: string;
  cmdStatus: string;
  cmdContext: string;
  cmdAlone: string;
  cmdSubagent: string;
  cmdLoop: string;
  cmdEvalStart: string;
  cmdEvalCancel: string;
  // App
  pressCtrlC: string;
  shuttingDown: string;
  loadedSkills: (n: number) => string;
  failedLoadSkills: (e: string) => string;
  switchedTo: (label: string) => string;
  switchedModel: (provider: string, model: string) => string;
  switchedLang: (locale: string) => string;
  resumedSession: (id: string, n: number) => string;
  // StreamingCard
  writing: string;
  aborted: string;
  tps: (rate: string) => string;
  linesDropped: (n: number) => string;
  truncatedByEsc: string;
  // ToolCard
  rejected: string;
  exitCode: (code: number) => string;
  // CommandAutocomplete
  cmdAutocompleteHint: string;
  // Search
  searchHint: string;
  // Bridge
  unknownError: string;
  unknownWarning: string;
  unknown: string;
  // P3: Mid-session instruction queue
  pendingTasks: string;
  // stringUtils
  plural: (n: number, word: string) => string;
  // P0: slash/help
  helpTitle: string;
  helpAgents: string;
  helpCurrent: string;
  helpDeprecatedAgentNote: string;
  cmdTheme: string;
  cmdThinking: string;
  cmdTalk: string;
  cmdReset: string;
  // P0: App command feedback
  evalStarted: (models: number, cases: number, runs: number) => string;
  evalProgress: (index: number, total: number, model: string, caseId: string, score?: number, grade?: string) => string;
  evalSkipped: (index: number, total: number, model: string, caseId: string, reason: string) => string;
  evalComplete: (evalRunId: string) => string;
  evalLeaderboardHeader: string;
  evalReportPath: (path: string) => string;
  evalNoModels: string;
  evalDryRunHeader: string;
  failedLoadStatus: string;
  thinkingModeSet: (mode: string) => string;
  thinkingModeCurrent: (mode: string) => string;
  harnessStatus: (strictness: string, source: string) => string;
  harnessSetSession: (strictness: string) => string;
  harnessSetProject: (val: string) => string;
  harnessProjectUsage: string;
  workflowInstructionQueued: (content: string) => string;
  inputTargetSwitched: (role: string) => string;
  // P0: welcome
  welcomeTagline: string;
  welcomePanelAgent: string;
  welcomePanelComponents: string;
  welcomeThinking: string;
  welcomeContext: string;
  welcomeSubagent: string;
  welcomeProvider: string;
  welcomeSkills: string;
  welcomeMcp: string;
  welcomeDiagnostics: (errors: number, warnings: number) => string;
  welcomeDiagnosticsLabel: string;
  welcomeHelpHint: string;
  welcomeLangHint: string;
  contextModeTrim: string;
  contextModeCompact: string;
  // P0: modal/common
  modalEscClose: string;
  selectHint: string;
  loadingSkills: string;
  skillsAvailable: (n: number) => string;
  noSkillsFound: string;
  skillEnabled: (name: string) => string;
  skillDisabled: (name: string) => string;
  skillNoDescription: string;
  skillFooterHint: string;
  contextLoading: string;
  contextLoaded: string;
  contextSaved: string;
  contextReducing: string;
  contextSubtitle: (ratio: string, tokens: string, window: string) => string;
  contextModeDescription: string;
  contextTriggerDescription: (tokens: string) => string;
  contextTargetDescription: (tokens: string) => string;
  contextRunNow: string;
  contextRunDescription: string;
  contextFooterHint: string;
  contextRunResult: (mode: string, before: string, after: string, removed: number) => string;
  // P0: permission
  permissionRead: string;
  permissionEdit: string;
  permissionExecute: string;
  permissionDirectory: string;
  permissionFetch: string;
  permissionSearch: string;
  permissionAgent: string;
  permissionAllowOnce: string;
  permissionAlwaysAllow: string;
  permissionReject: string;
  permissionToolWants: string;
  permissionPatterns: string;
  permissionSuggested: string;
  permissionEnterConfirm: string;
  permissionEscReject: string;
  permissionRejectTitle: string;
  permissionToolDenied: string;
  permissionTypeMessage: string;
  permissionEnterSubmit: string;
  permissionEscCancel: string;
  permissionUpDownSelect: string;
  permissionAlwaysTitle: string;
  permissionAlwaysAutoApproved: string;
  // P0: question
  questionSummary: string;
  questionNoAnswer: string;
  questionSubmitting: string;
  questionConfirmAnswers: string;
  questionTypeYourOwn: string;
  questionTypeAnswer: string;
  // P0: status
  statusSectionStatus: string;
  statusSectionContext: string;
  statusSectionStats: string;
  statusSectionSessionWriter: string;
  statusYes: string;
  statusNo: string;
  // P0: workflow labels
  workflowPhaseAnalyse: string;
  workflowPhaseDo: string;
  workflowPhaseReport: string;
  workflowPhaseCheck: string;
  workflowPhaseContinue: string;
  workflowPhaseRevise: string;
  workflowPhaseApprove: string;
  workflowPhaseBlocked: string;
  workflowPhaseAskUser: string;
  workflowLifecycleAwaitingGoal: string;
  workflowLifecycleRunning: string;
  workflowLifecycleWaiting: string;
  workflowLifecycleBlocked: string;
  workflowLifecycleCompleted: string;
  workflowLifecycleFailed: string;
  workflowRoleIdle: string;
  workflowRoleAnalyse: string;
  workflowRoleDo: string;
  workflowRoleReport: string;
  workflowRoleWait: string;
  workflowRoleBlocked: string;
  workflowModeAlone: string;
  workflowModeSubagent: string;
  workflowModeLoop: string;
  workflowAwaitingGoal: string;
  workflowBlockedMsg: string;
  workflowAlreadyRunning: string;
  workflowModeChanged: (mode: string) => string;
  workflowLoopStarted: string;
  workflowContinuationGuard: string;
  workflowStuckGuard: string;
  // P0: agent/worker labels
  agentStatusQueued: string;
  agentStatusStarting: string;
  agentStatusRunning: string;
  agentStatusPermission: string;
  agentStatusAnswer: string;
  agentStatusReview: string;
  agentStatusVerifying: string;
  agentStatusPaused: string;
  agentStatusCompleted: string;
  agentStatusFailed: string;
  agentStatusCancelled: string;
  agentStatusIdle: string;
  agentGroupRunning: (n: number) => string;
  agentGroupCompleted: (n: number) => string;
  agentGroupFailed: (n: number) => string;
  agentGroupNoWorkers: string;
  agentGroupWorkersIdle: (n: number) => string;
  workerPanelTitle: string;
  workerPanelTotal: (n: number) => string;
  workerPanelOutputFocused: string;
  workerPanelList: string;
  workerPanelNoActive: string;
  workerPanelNoOutput: string;
  workerPanelNotFound: string;
  workerPanelOutput: (name: string) => string;
  workerPanelSelectHint: string;
  workerPanelEscBack: string;
  workerPanelNavigate: string;
  workerTaskDone: string;
  workerTaskError: string;
  workerTaskIdle: string;
  virtualizedNoMessages: string;
  virtualizedScrollToBottom: string;
  virtualizedBottom: string;
  // P0: modal action hints
  contextModeRowLabel: string;
  contextTriggerRowLabel: string;
  contextTargetRowLabel: string;
  contextRunRowLabel: string;
  modelCustomConfigure: string;
  modelCustomBaseUrl: string;
  modelCustomModel: string;
  modelCustomPlaceholder: string;
  // P0: harness
  harnessStrictDesc: string;
  harnessNormalDesc: string;
  harnessLooseDesc: string;
  harnessSetTo: (strictness: string) => string;
  harnessProjectSet: (val: string) => string;
  harnessFooter: string;
  // P0: workflow menu descriptions
  workflowMenuAlone: (running: string) => string;
  workflowMenuSubagent: (running: string) => string;
  workflowMenuLoop: (running: string) => string;
  workflowInterruptRunning: string;
  // P0: agent menu
  agentMenuTitle: (role: string) => string;
  agentMenuSubtitle: (role: string) => string;
  // P0: search
  searchNoMatch: string;
  // P0: custom provider
  customProviderName: string;
  // P1: config
  cmdConfig: string;
  cmdConfigSet: string;
  cmdConfigOpen: string;
  cmdConfigReload: string;
  configLoaded: (path: string) => string;
  configSet: (key: string, value: string) => string;
  configOpen: (path: string) => string;
  configReloaded: string;
  configError: (msg: string) => string;
  configCurrent: (path: string) => string;
  configAll: (content: string) => string;
  // Fixed eval wizard
  evalWizardHeader: string;
  evalWizardUsage: string;
  evalWizardCategoryList: (list: string) => string;
  evalWizardCategoryInfo: (id: string, title: string, desc: string, caseCount: number) => string;
  evalWizardSuiteInfo: (suite: string, desc: string, mins: string, caseCount: number) => string;
  evalWizardRunning: (caseId: string, title: string, index: number, total: number) => string;
  evalWizardResult: (caseId: string, verdict: string, score: number) => string;
  evalWizardSuiteComplete: (passed: number, failed: number, score: number, reportPath: string) => string;
}
