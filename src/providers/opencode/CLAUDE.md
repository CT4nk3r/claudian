# OpenCode Provider

Adaptor for OpenCode CLI via JSON-RPC 2.0 over stdio.

## Protocol Overview

OpenCode speaks JSON-RPC 2.0 over stdio (newline-delimited JSON) similar to Codex:
- **Startup**: `opencode stdio` spawns the CLI in stdio mode
- **Handshake**: client sends `initialize`, then notifies `initialized`
- **Client → Server**: `thread/*`, `turn/*`, `skills/list`
- **Server → Client**: streaming deltas, turn events, completion notifications
- **Server → Client → Server**: approval gates, user input requests

## Design Decisions

### Model Agnostic

OpenCode supports 75+ LLM providers (Claude, GPT, Gemini, local models via Ollama). The model selector shows common models but users can configure custom models via environment variables.

### Opt-In by Default

Like Codex, OpenCode is disabled by default. Users must explicitly enable it in settings.

### Skill Discovery via Filesystem

Unlike Codex which uses runtime `skills/list` RPC, OpenCode skill discovery scans `.opencode/skills/` and `.agents/skills/` directories directly.

## Storage Paths

| Path | Contents |
|------|----------|
| `.opencode/skills/*/SKILL.md` | OpenCode vault skills |
| `.agents/skills/*/SKILL.md` | Alternate vault skill root |
| `.opencode/agents/*.toml` | OpenCode vault subagent definitions |
| `~/.opencode/sessions/**/*.jsonl` | OpenCode transcripts |

## Implementation Status

**Implemented:**
- Provider registration and capabilities
- Settings UI (enable toggle, CLI path, safe mode)
- Skill catalog with filesystem discovery
- Agent mention provider
- History service skeleton
- Auxiliary services (title, refine, inline edit)
- RPC transport layer

**Pending (requires live OpenCode validation):**
- Full ChatRuntime query implementation
- Approval and ask-user handling
- Session management (resume, fork)
- Streaming notification routing
- Session file parsing format validation

## Environment Variables

| Variable | Description |
|----------|-------------|
| `OPENCODE_MODEL` | Override default model |
| `OPENCODE_API_KEY` | API key for the configured provider |
| `OPENCODE_BASE_URL` | Custom API endpoint |

## Gotchas

- OpenCode protocol details may differ from Codex — validate against running instance
- Session file format needs validation against real OpenCode transcripts
- Model list is approximate — actual available models depend on user's configured providers
