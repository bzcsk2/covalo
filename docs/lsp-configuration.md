# LSP Configuration

Covalo includes built-in support for Language Server Protocol (LSP) to provide code intelligence (hover, definition, references, diagnostics, completion, etc.) for common programming languages.

## Default Configuration

Covalo ships with built-in default configurations for the following languages:

| Language | Server Command | Status |
|---|---|---|
| TypeScript/TSX | `typescript-language-server` | ✅ OpenJDK |
| JavaScript/JSX | `typescript-language-server` | ✅ OpenJDK |
| Python | `pyright-langserver` | ⚠️ Best-effort |
| Go | `gopls` | ⚠️ Best-effort |
| Rust | `rust-analyzer` | ⚠️ Best-effort |
| JSON | `vscode-langservers-extracted` | ⚠️ Best-effort |
| CSS | `vscode-langservers-extracted` | ⚠️ Best-effort |
| HTML | `vscode-langservers-extracted` | ⚠️ Best-effort |

When covalo is installed globally via `npm install -g covalo`, TS/JS support works immediately without additional setup. Other languages require the corresponding server to be installed separately.

## How Servers Are Resolved

When an LSP action is requested, covalo searches for the server binary in this order:

1. **User-defined config** → `.covalo/lsp.json` can override any language's command
2. **Environment variables** → `COVALO_LSP_SERVER_<LANGUAGE>` for per-language overrides
3. **PATH** → The server binary is looked up in system PATH
4. **Package-local** → The server binary is searched in `node_modules/.bin/` relative to covalo's installation directory
5. **npx fallback** → Only when `COVALO_LSP_ALLOW_NPX=1` is set (default: off)

If none of these succeed, the tool returns a `server_not_installed` error with an install hint.

## Custom Configuration

Create a `.covalo/lsp.json` file in your project root to customize LSP settings:

```jsonc
{
  "version": 1,
  "requestTimeoutMs": 8000,
  "idleTimeoutMs": 300000,
  "languages": {
    "typescript": {
      "command": "/path/to/typescript-language-server",
      "args": ["--stdio"]
    }
  }
}
```

### Configuration Fields

| Field | Type | Default | Description |
|---|---|---|---|
| `version` | number | 1 | Schema version |
| `requestTimeoutMs` | number | 8000 | Per-request timeout (1000–30000) |
| `idleTimeoutMs` | number | 300000 | Server idle timeout in ms (60000–600000) |
| `languages` | object | (see default) | Per-language server configurations |

Each language entry supports:

| Field | Type | Description |
|---|---|---|
| `command` | string | Server binary path or name |
| `args` | string[] | CLI arguments (default: `["--stdio"]`) |
| `rootPatterns` | string[] | Patterns to detect project root |
| `initializationOptions` | object | Options passed in `initialize` request |
| `settings` | object | Workspace settings |

### User Config Override Behavior

Your `.covalo/lsp.json` merges with the default configuration, and your settings always take precedence:

```text
Final Config = { ...DEFAULT_CONFIG, ...USER_CONFIG, languages: { ...DEFAULT.languages, ...USER.languages } }
```

If you only want to override certain languages, you can omit others — they will fall back to defaults.

## Environment Variables

| Variable | Description |
|---|---|
| `COVALO_LSP_CONFIG` | Path to an alternative LSP config file |
| `COVALO_LSP_ALLOW_NPX` | Set to `1` to enable npx fallback for server resolution |
| `COVALO_LSP_SERVER_TYPESCRIPT` | Override command for TypeScript (same pattern for other languages). Takes priority over default config commands. |

## Platform Support

| Platform | Status |
|---|---|
| Linux (x64) | ✅ Full support |
| macOS | ✅ Full support |
| Windows | ✅ Supported: PATH uses platform-appropriate `;` delimiter, and `.cmd`/`.exe`/`.ps1` shims are detected automatically |

## Pool Behavior (Session-Level Connection)

Covalo uses a persistent LSP client pool to reuse server processes within a session:

- **Idle timeout**: Servers idle for 300s (configurable via `idleTimeoutMs`) are automatically shut down
- **Document cache**: Opening the same file multiple times does NOT send duplicate `didOpen` notifications; content changes trigger `didChange` with incremented version
- **Session lifecycle**: All server processes are cleaned up when covalo exits
- **Subagent sharing**: Sub-agents spawned by the supervisor inherit the same pool and reuse existing connections

## Troubleshooting

**"LSP server not found for language X"**
→ Install the required language server. Run the command shown in the install hint, or create a `.covalo/lsp.json` pointing to a custom server path.

**"LSP request failed"**
→ The server binary was found but failed to start or crashed. Check that the server is properly installed and supports the `--stdio` transport. Run `which <command>` to verify the binary location.

**Server not using my custom config**
→ Ensure `.covalo/lsp.json` is valid JSON. The `languages` field merges with defaults — your entries override, but must match the correct language key (e.g. `"typescript"`, not `"ts"`).
