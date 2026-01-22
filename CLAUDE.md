# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Build and Development Commands

```bash
# Install dependencies (requires Bun 1.3.3+)
bun install

# Development - run all apps in parallel
bun dev

# Run specific app
cd apps/whispering && bun dev      # Desktop app with Tauri
cd apps/whispering && bun dev:web  # Web-only (no Tauri)

# Production build
bun build

# Linting and formatting
bun lint        # Fix lint issues (eslint + biome)
bun format      # Fix formatting (biome + prettier)
bun lint:check  # Check only (for CI)
bun format:check

# Type checking
bun typecheck   # Runs turbo typecheck across all packages

# Clean caches and node_modules
bun clean

# Full reset including Rust target (rarely needed)
bun nuke
```

## Monorepo Architecture

This is a Bun workspace monorepo using Turborepo for task orchestration.

### Apps (`apps/`)

- `whispering` - Main transcription desktop app (Svelte 5 + SvelteKit + Tauri). The most mature app and primary development focus.
- `landing` - Marketing site
- `tab-manager` - Browser tab manager
- `demo-mcp` - MCP demo

### Packages (`packages/`)

- `@epicenter/ui` - Shared UI components (shadcn-svelte based)
- `@epicenter/shared` - Shared constants and utilities
- `@epicenter/constants` - Environment-specific constants (vite, node, cloudflare)
- `@epicenter/config` - Shared configuration
- `@epicenter/svelte-utils` - Svelte utilities
- `@epicenter/vault-core` - Core vault functionality
- `@epicenter/epicenter` - CLI package

### Skills System (`skills/`)

Skills are loaded on-demand based on the task. Each skill has a `SKILL.md` with a `description` field. Load relevant skills when working on specific areas:

- `typescript` - TypeScript style, type co-location, arktype patterns
- `svelte` - Svelte 5 patterns, TanStack Query mutations, shadcn-svelte
- `rust-errors` - Rust to TypeScript error handling for Tauri
- `error-handling` - wellcrafted trySync/tryAsync patterns
- `styling` - CSS and Tailwind guidelines
- `git` - Conventional commits, PR guidelines
- `monorepo` - Script commands and conventions

## Whispering App Architecture (Three-Layer)

The main app uses a clean three-layer architecture with 97% code sharing between desktop and web:

```
UI Layer (Svelte 5) → Query Layer (TanStack Query) → Service Layer (Pure Functions)
```

### Service Layer (`apps/whispering/src/lib/services/`)

Pure functions returning `Result<T, E>` types from `wellcrafted`. Platform differences handled at build time:

```typescript
export const ClipboardServiceLive = window.__TAURI_INTERNALS__
  ? createClipboardServiceDesktop()
  : createClipboardServiceWeb();
```

Services accept explicit parameters and never import settings directly.

### Query Layer (`apps/whispering/src/lib/query/`)

Wraps services with TanStack Query. Handles runtime dependency injection, cache manipulation, and error transformation. Access via unified `rpc` namespace:

```typescript
import { rpc } from '$lib/query';

// Reactive (for components)
const recordings = createQuery(rpc.recordings.getAllRecordings.options());

// Imperative (for event handlers)
const { data, error } = await rpc.recordings.deleteRecording.execute(id);
```

### Stores (`apps/whispering/src/lib/stores/`)

Singleton reactive state for live data that must update immediately (hardware state, user preferences).

## Key Conventions

### Error Handling

Use `wellcrafted` Result types throughout. Never use try-catch in application code.

```typescript
import { trySync, tryAsync, Ok, Err } from 'wellcrafted/result';

const { data, error } = await tryAsync({
  try: () => riskyOperation(),
  catch: (e) => Ok(fallbackValue), // Graceful recovery
});
if (error) return Err(error); // Must wrap with Err() when returning
```

### TypeScript

- Use `type` instead of `interface`
- Co-locate types with their services (never create generic `types.ts` buckets)
- Use parameter destructuring for factory functions
- Use `'key?': 'string'` (not `'key': 'string | undefined'`) in arktype for optional properties

### Svelte 5

- Use `createMutation` from TanStack Query with callbacks passed to `.mutate()`
- Namespace imports for multi-part components: `import * as Dialog from '$lib/components/ui/dialog'`
- Individual Lucide icon imports: `import Database from '@lucide/svelte/icons/database'`
- Prefer self-contained components over parent state management

### Git

- Conventional commits: `feat(scope): description`
- No AI attribution in commits or PRs
- Use `gh pr merge --merge` (not squash)

## Constraints

- Don't put business logic in Svelte components
- Don't access settings directly in services (pass as parameters)
- Services should never import `WhisperingError` (that's for the query layer)
- Always get approval before expensive actions (test, build) or destructive actions (commit, push)

## Documentation Structure

- `specs/` - Planning documents (design decisions, todos, timestamped)
- `docs/` - Reference materials (articles, patterns, guides, architecture)
