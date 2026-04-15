# Copilot Instructions

## Commands

```bash
npm run dev          # Watch mode
npm run build        # Production build
npm run typecheck    # Type checking
npm run lint         # Lint
npm run lint:fix     # Lint and fix
npm run test         # Run all tests
npm run test:watch   # Watch mode tests
npm run test:coverage
```

### Running specific tests

```bash
npm run test -- --selectProjects unit           # Unit tests only
npm run test -- --selectProjects integration    # Integration tests only
npm run test -- path/to/file.test.ts            # Single test file
npm run test -- -t "test name pattern"          # By test name
```

### Validation before committing

```bash
npm run typecheck && npm run lint && npm run test && npm run build
```

## Architecture

Claudian is an Obsidian plugin embedding AI chat runtimes (Claude, Codex) in a sidebar and inline-edit flow.

### Layer Structure

| Layer | Purpose |
|-------|---------|
| `app/` | Shared settings defaults and plugin-level storage helpers |
| `core/` | Provider-neutral runtime contracts, registries, tool types |
| `providers/claude/` | Claude SDK adaptor — runtime, prompt encoding, MCP, plugins |
| `providers/codex/` | Codex app-server adaptor — JSON-RPC transport, JSONL history |
| `features/chat/` | Sidebar chat — tabs, controllers, renderers |
| `features/inline-edit/` | Inline edit modal and provider edit services |
| `features/settings/` | Settings shell with provider tabs |
| `shared/` | Reusable UI components |
| `i18n/` | 10 locales |
| `utils/` | Cross-cutting utilities |
| `style/` | Modular CSS |

### Provider Boundary

- `ChatRuntime` is the provider-neutral interface in `core/runtime/`
- `ProviderRegistry` creates runtimes and auxiliary services
- `ProviderWorkspaceRegistry` owns command catalogs, agent mentions, CLI resolution, MCP managers
- `Conversation.providerState` is opaque in feature code — provider-specific fields stay behind typed helpers
- Claude state: `ClaudeProviderState`; Codex state: `CodexProviderState`

### Data Flow

```
User Input → InputController → ChatRuntime.prepareTurn() → ChatRuntime.query() → StreamController → MessageRenderer
```

Feature code consumes provider-neutral `StreamChunk` values. Providers own prompt encoding and history hydration.

## Key Conventions

### TDD Workflow

Write the failing test first in the mirrored `tests/` path, make it pass, then refactor. Tests mirror `src/` layout under `tests/unit/` and `tests/integration/`.

### Provider-Native First

Prefer official Claude SDK and Codex app-server behavior over reimplementing locally. Adapt to provider capabilities instead of shadowing them.

### Runtime Exploration

For provider integrations, inspect real runtime output first. Claude data: `~/.claude/`. Codex data: `~/.codex/`. Real transcripts beat guessed event shapes.

### Comments

Comment why, not what. Avoid narration and redundant JSDoc.

### No Console Logging

No `console.*` in production code.

### Throwaway Scripts

Put non-committed notes and throwaway scripts in `.context/`.

## Storage Locations

| Path | Contents |
|------|----------|
| `.claude/settings.json` | Claude Code project settings and permissions |
| `.claudian/claudian-settings.json` | Claudian app settings |
| `.claude/mcp.json` | Claudian-managed MCP servers |
| `.claude/commands/**/*.md` | Claude slash commands |
| `.claude/skills/*/SKILL.md` | Claude skills |
| `.codex/skills/*/SKILL.md` | Codex vault skills |
| `~/.claude/projects/{vault}/*.jsonl` | Claude transcripts |
| `~/.codex/sessions/**/*.jsonl` | Codex transcripts |

## Provider-Specific Patterns

### Claude

- Persistent query stays alive across turns; dynamic updates via SDK API calls
- SDK session files are tree-structured; `sdkBranchFilter` finds the canonical branch
- MCP dual-namespace: `mcpServers` (CC-compatible) and `_claudian.servers` (Claudian metadata)

### Codex

- JSON-RPC 2.0 over stdio with `initialize` → `initialized` handshake
- Dual tool source: transcript mode (session JSONL polling) vs fallback mode (live RPC)
- `thread/resume` required before any operation on existing thread in new daemon process
