/**
 * PermissionService — manages pending permission requests.
 * Adapted from OpenCode (MIT License).
 * Source: packages/opencode/src/permission/index.ts
 *
 * Handles ask/reply lifecycle, session-approved rules, and cleanup.
 */

import { randomUUID } from "node:crypto"
import type {
  PermissionRequest,
  PermissionReply,
  PermissionRule,
  PermissionServiceInterface,
} from "./types.js"
import { createSessionRule } from "./rules.js"
import { matchWildcard } from "./wildcard.js"

/* ── Errors ── */

export class PermissionRejectedError extends Error {
  constructor() {
    super("The user rejected this permission request")
    this.name = "PermissionRejectedError"
  }
}

export class PermissionNotFoundError extends Error {
  constructor(requestId: string) {
    super(`Permission request not found: ${requestId}`)
    this.name = "PermissionNotFoundError"
  }
}

/* ── Pending Entry ── */

interface PendingEntry {
  info: PermissionRequest
  resolve: (reply: PermissionReply) => void
  reject: (error: Error) => void
}

/* ── PermissionService ── */

export class PermissionService implements PermissionServiceInterface {
  private pending = new Map<string, PendingEntry>()
  private sessionApproved = new Map<string, PermissionRule[]>()

  /**
   * Request permission from the user.
   * Returns a Promise that resolves when the user replies.
   */
  async ask(input: {
    sessionId: string
    permission: string
    patterns: string[]
    always?: string[]
    metadata?: Record<string, unknown>
    tool?: { toolCallId: string; toolName: string }
    parentSessionId?: string
  }): Promise<PermissionReply> {
    const id = `perm_${randomUUID()}`
    const request: PermissionRequest = {
      id,
      sessionId: input.sessionId,
      permission: input.permission,
      patterns: input.patterns,
      always: input.always ?? [],
      metadata: input.metadata ?? {},
      tool: input.tool,
      parentSessionId: input.parentSessionId,
    }

    return new Promise<PermissionReply>((resolve, reject) => {
      this.pending.set(id, { info: request, resolve, reject })
    })
  }

  /**
   * Reply to a pending permission request.
   * @param reply "once" - approve this instance
   *             "always" - approve and add to session rules
   *             "reject" - deny this and all pending requests for the session
   */
  reply(input: { requestId: string; reply: PermissionReply; message?: string }): void {
    const entry = this.pending.get(input.requestId)
    if (!entry) {
      throw new PermissionNotFoundError(input.requestId)
    }

    this.pending.delete(input.requestId)

    if (input.reply === "reject") {
      // Reject this request
      entry.reject(new PermissionRejectedError())

      // Also reject all other pending requests for the same session
      // (OpenCode behavior: reject cascades)
      const sessionId = entry.info.sessionId
      for (const [id, other] of this.pending) {
        if (other.info.sessionId === sessionId) {
          this.pending.delete(id)
          other.reject(new PermissionRejectedError())
        }
      }
      return
    }

    if (input.reply === "always") {
      // Add session-approved rules for each pattern
      const rules: PermissionRule[] = []
      for (const pattern of entry.info.patterns) {
        rules.push(createSessionRule(entry.info.permission, pattern))
      }
      this.addSessionRules(entry.info.sessionId, rules)

      // Auto-approve other pending requests that match the new rules
      for (const [id, other] of this.pending) {
        if (other.info.sessionId === entry.info.sessionId) {
          if (this.matchesSessionRules(other.info)) {
            this.pending.delete(id)
            other.resolve("once")
          }
        }
      }
    }

    // Resolve the original request
    entry.resolve(input.reply)
  }

  /**
   * List pending permission requests.
   * Optionally filter by session ID.
   */
  list(sessionId?: string): PermissionRequest[] {
    const entries = Array.from(this.pending.values(), (x) => x.info)
    if (sessionId) {
      return entries.filter((e) => e.sessionId === sessionId)
    }
    return entries
  }

  /**
   * Check if a permission request matches session-approved rules.
   */
  matchesSessionRules(request: PermissionRequest): boolean {
    const rules = this.sessionApproved.get(request.sessionId) ?? []
    for (const rule of rules) {
      if (rule.permission === request.permission || rule.permission === "*") {
        for (const pattern of request.patterns) {
          if (matchWildcard(rule.pattern, pattern)) {
            return true
          }
        }
      }
    }
    return false
  }

  /**
   * Get session-approved rules.
   */
  getSessionRules(sessionId: string): PermissionRule[] {
    return this.sessionApproved.get(sessionId) ?? []
  }

  /**
   * Reject all pending requests for a session.
   */
  interrupt(sessionId?: string): void {
    for (const [id, entry] of this.pending) {
      if (!sessionId || entry.info.sessionId === sessionId) {
        this.pending.delete(id)
        entry.reject(new PermissionRejectedError())
      }
    }
  }

  /**
   * Shutdown and reject all pending requests.
   */
  shutdown(): void {
    for (const [id, entry] of this.pending) {
      entry.reject(new PermissionRejectedError())
    }
    this.pending.clear()
    this.sessionApproved.clear()
  }

  /* ── Private Helpers ── */

  private addSessionRules(sessionId: string, rules: PermissionRule[]): void {
    const existing = this.sessionApproved.get(sessionId) ?? []
    this.sessionApproved.set(sessionId, [...existing, ...rules])
  }
}

/* ── Wildcard Matching (imported from S1-6 shared module) ── */
