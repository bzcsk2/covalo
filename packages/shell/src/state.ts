export type ToolStatus = "running" | "done" | "error"

export interface AppStateSnapshot {
  messages: Array<{ role: string; content: string }>
  isStreaming: boolean
  streamingMessage: string
  reasoningMessage: string
  activeTools: Map<string, { name: string; status: ToolStatus }>
  promptTokens: number
  completionTokens: number
  cacheHitTokens: number
  cacheMissTokens: number
  currentAgent: string
  warnings: string[]
  errors: string[]
}

function emptySnapshot(): AppStateSnapshot {
  return {
    messages: [],
    isStreaming: false,
    streamingMessage: "",
    reasoningMessage: "",
    activeTools: new Map(),
    promptTokens: 0,
    completionTokens: 0,
    cacheHitTokens: 0,
    cacheMissTokens: 0,
    currentAgent: "build",
    warnings: [],
    errors: [],
  }
}

export type StateListener = (snapshot: AppStateSnapshot) => void

export class AppState {
  private snapshot: AppStateSnapshot = emptySnapshot()
  private listeners: Set<StateListener> = new Set()
  private toolIdSeq = 0

  subscribe(listener: StateListener): () => void {
    this.listeners.add(listener)
    return () => this.listeners.delete(listener)
  }

  getSnapshot(): AppStateSnapshot {
    return this.snapshot
  }

  private notify(): void {
    // Snapshot to prevent concurrent modification issues
    for (const cb of [...this.listeners]) {
      try { cb(this.snapshot) } catch (e) { console.error("AppState listener error:", e) }
    }
  }

  reset(): void {
    this.snapshot = emptySnapshot()
    this.notify()
  }

  setStreaming(v: boolean): void {
    this.snapshot = { ...this.snapshot, isStreaming: v, streamingMessage: v ? this.snapshot.streamingMessage : "", reasoningMessage: v ? this.snapshot.reasoningMessage : "" }
    this.notify()
  }

  appendAssistantDelta(text: string): void {
    this.snapshot = { ...this.snapshot, streamingMessage: this.snapshot.streamingMessage + text }
    this.notify()
  }

  appendReasoningDelta(text: string): void {
    this.snapshot = { ...this.snapshot, reasoningMessage: this.snapshot.reasoningMessage + text }
    this.notify()
  }

  addAssistantMessage(content: string): void {
    this.snapshot = {
      ...this.snapshot,
      messages: [...this.snapshot.messages, { role: "assistant", content }],
      streamingMessage: "",
      reasoningMessage: "",
    }
    this.notify()
  }

  addUserMessage(content: string): void {
    this.snapshot = { ...this.snapshot, messages: [...this.snapshot.messages, { role: "user", content }] }
    this.notify()
  }

  addToolStart(name: string, index: number): string {
    const id = `tool_${index}_${++this.toolIdSeq}`
    const tools = new Map(this.snapshot.activeTools)
    tools.set(id, { name, status: "running" })
    this.snapshot = { ...this.snapshot, activeTools: tools }
    this.notify()
    return id
  }

  setToolStatus(id: string, status: ToolStatus): void {
    const tools = new Map(this.snapshot.activeTools)
    const existing = tools.get(id)
    if (existing) {
      tools.set(id, { ...existing, status })
      this.snapshot = { ...this.snapshot, activeTools: tools }
      this.notify()
    }
  }

  addToolResult(name: string, content: string): void {
    this.snapshot = {
      ...this.snapshot,
      messages: [...this.snapshot.messages, { role: "tool", content }],
    }
    this.notify()
  }

  updateUsage(prompt: number, completion: number, cacheHit: number, cacheMiss: number): void {
    this.snapshot = { ...this.snapshot, promptTokens: prompt, completionTokens: completion, cacheHitTokens: cacheHit, cacheMissTokens: cacheMiss }
    this.notify()
  }

  setAgent(name: string): void {
    this.snapshot = { ...this.snapshot, currentAgent: name }
    this.notify()
  }

  addWarning(text: string): void {
    this.snapshot = { ...this.snapshot, warnings: [...this.snapshot.warnings, text] }
    this.notify()
  }

  addError(text: string): void {
    this.snapshot = { ...this.snapshot, errors: [...this.snapshot.errors, text] }
    this.notify()
  }

  clearTools(): void {
    this.snapshot = { ...this.snapshot, activeTools: new Map() }
    this.notify()
  }
}
