import { execFile, spawn } from "node:child_process"
import type { AgentTool } from "@covalo/protocol"
import { safeStringify } from "./safe-stringify.js"
import { getNotificationBackend } from "./platform/notification-backend.js"
import { normalizePlatform } from "./platform/capabilities.js"

export function createPushNotificationTool(): AgentTool {
  return {
    name: "PushNotification",
    description: "Send a desktop notification. Use this to alert the user when a long-running task completes or requires attention.",
    parameters: {
      type: "object",
      properties: {
        title: { type: "string", description: "Notification title" },
        message: { type: "string", description: "Notification body message" },
        urgency: { type: "string", enum: ["low", "normal", "critical"], description: "Notification urgency (default: normal)" },
      },
      required: ["title", "message"],
    },
    concurrency: "shared",
    approval: "read",
    async execute(args) {
      if (typeof args.title !== "string" || !args.title) {
        return { content: safeStringify({ error: "title is required" }), isError: true }
      }
      if (typeof args.message !== "string" || !args.message) {
        return { content: safeStringify({ error: "message is required" }), isError: true }
      }
      const urgency = args.urgency === "low" || args.urgency === "normal" || args.urgency === "critical"
        ? args.urgency
        : "normal"

      const platform = normalizePlatform()
      const backend = getNotificationBackend(platform)

      let fallbackReason: string | undefined

      try {
        if (backend.id === "notify-send") {
          await sendNotifySend(args.title, args.message, urgency)
          return { content: safeStringify({ sent: true, method: "notify-send", title: args.title, message: args.message }), isError: false }
        }

        if (backend.id === "osascript") {
          await sendOsAScript(args.title, args.message)
          return { content: safeStringify({ sent: true, method: "osascript", title: args.title, message: args.message }), isError: false }
        }

        if (backend.id === "powershell") {
          const sent = await sendPowerShell(args.title, args.message)
          if (sent) {
            return { content: safeStringify({ sent: true, method: "powershell", title: args.title, message: args.message }), isError: false }
          }
          fallbackReason = "PowerShell notification not available"
        }
      } catch (e) {
        fallbackReason = e instanceof Error ? e.message : String(e)
      }

      // Fallback to terminal bell
      process.stdout.write("\x07")
      return {
        content: safeStringify({ sent: true, method: "terminal-bell", fallbackReason, title: args.title, message: args.message }),
        isError: false,
      }
    },
  }
}

function notifySendArgs(title: string, message: string, urgency: string): string[] {
  return ["--urgency=" + urgency, title, message]
}

function sendNotifySend(title: string, message: string, urgency: string): Promise<void> {
  return new Promise((resolve, reject) => {
    execFile("notify-send", notifySendArgs(title, message, urgency), { timeout: 5000 }, (err) => {
      if (err) reject(err)
      else resolve()
    })
  })
}

function sendOsAScript(title: string, message: string): Promise<void> {
  const script = `display notification ${osAEscape(message)} with title ${osAEscape(title)}`
  return new Promise((resolve, reject) => {
    execFile("osascript", ["-e", script], { timeout: 5000 }, (err) => {
      if (err) reject(err)
      else resolve()
    })
  })
}

function osAEscape(s: string): string {
  // osascript uses double quotes in AppleScript string literals;
  // escape internal quotes and backslashes
  return `"${s.replace(/[\\"]/g, "\\$&")}"`
}

function sendPowerShell(title: string, message: string): Promise<boolean> {
  // Use BurntToast or BalloonTip for non-blocking notification
  // Fallback: use [System.Windows.Forms] which doesn't block
  const escapedMessage = message.replace(/["\\]/g, "\\$&")
  const escapedTitle = title.replace(/["\\]/g, "\\$&")
  // BalloonTip is non-blocking and auto-hides
  const script = `
Add-Type -AssemblyName System.Windows.Forms
$notify = New-Object System.Windows.Forms.NotifyIcon
$notify.Icon = [System.Drawing.SystemIcons]::Information
$notify.BalloonTipTitle = "${escapedTitle}"
$notify.BalloonTipText = "${escapedMessage}"
$notify.Visible = $true
$notify.ShowBalloonTip(3000)
Start-Sleep -Milliseconds 500
$notify.Dispose()
`

  return new Promise((resolve) => {
    const proc = spawn("powershell.exe", ["-NoProfile", "-NonInteractive", "-Command", script], { timeout: 5000 })
    proc.on("error", () => resolve(false))
    proc.on("close", (code) => resolve(code === 0))
  })
}
