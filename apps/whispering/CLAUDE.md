# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Monorepo Context

This app is part of the `epicenter` monorepo. When working on a standalone copy:
- Dependencies won't install (workspace references fail)
- Run typecheck from epicenter root: `cd ../epicenter && bun run --filter @epicenter/whispering typecheck`
- If bun not in PATH: `~/.bun/bin/bun`

## Build and Development Commands

```bash
# Development (runs Tauri desktop app with hot reload)
bun tauri dev

# Web-only development (no Tauri)
bun run dev:web

# Production build
bun run build

# Build desktop executable
bun tauri build

# Type checking
bun run typecheck

# Linting
bun run lint
```

## Architecture Overview

Whispering is a speech-to-text desktop app built with Svelte 5, SvelteKit, and Tauri. It uses a three-layer architecture with 97% code sharing between desktop and web versions.

### Layer Structure

```
UI Layer (Svelte 5) → Query Layer (TanStack Query) → Service Layer (Pure Functions)
```

### Service Layer (`src/lib/services/`)

Pure functions that return `Result<T, E>` types from the `wellcrafted` library. Services have no knowledge of UI state or reactive stores. Platform differences (Tauri vs browser) are handled at build time:

```typescript
export const ClipboardServiceLive = window.__TAURI_INTERNALS__
  ? createClipboardServiceDesktop()
  : createClipboardServiceWeb();
```

Services accept explicit parameters and never import settings directly.

### Query Layer (`src/lib/query/`)

Wraps services with TanStack Query for caching and reactivity. Handles runtime dependency injection (switching service implementations based on user settings) and cache manipulation. Access everything through the unified `rpc` namespace:

```typescript
import { rpc } from '$lib/query';

// Reactive (for components)
const recordings = createQuery(rpc.recordings.getAllRecordings.options());

// Imperative (for event handlers)
const { data, error } = await rpc.recordings.deleteRecording.execute(id);
```

### Stores (`src/lib/stores/`)

Singleton reactive state for live data that must update immediately (hardware state, user preferences). Use stores when you need immediate updates; use the query layer for data fetching with caching.

## Error Handling

Use `wellcrafted` Result types throughout. Never use try-catch.

Services return domain-specific tagged errors. The query layer transforms these into `WhisperingError` for UI display. Never double-wrap errors.

```typescript
// Service layer - domain error
return Err({ name: 'RecorderServiceError', message: '...', context: {} });

// Query layer - transform to UI error
return Err(WhisperingError({ title: '...', description: error.message }));

// UI layer - use directly (no re-wrapping)
notify.error.execute(error);
```

## Key Directories

- `src/lib/services/` - Platform-agnostic business logic
- `src/lib/services/isomorphic/transcription/realtime/` - Realtime streaming transcription (ElevenLabs Scribe v2)
- `src/lib/services/isomorphic/audio/` - Audio processing (PCM capture for realtime streaming)
- `src/lib/query/` - Reactive data management with TanStack Query
- `src/lib/stores/` - Singleton reactive state (settings, VAD, realtime recorder)
- `src/lib/components/` - Svelte 5 UI components
- `src/lib/settings/` - Settings schema and persistence
- `src-tauri/` - Rust backend for desktop features

## Constraints

- Don't put business logic in Svelte components
- Don't access settings directly in services (pass as parameters)
- Don't use try-catch; use wellcrafted Result types
- Services should never import `WhisperingError` (that's for the query layer)

## Realtime Transcription (ElevenLabs Scribe v2)

The app supports streaming realtime transcription via the ElevenLabs Scribe v2 API, which transcribes speech during recording rather than after (~150ms latency).

### Architecture

```
MediaStream → PCM Processor → WebSocket → ElevenLabs API
                   ↓                            ↓
            16kHz Int16 PCM          partial/committed transcripts
```

### Key Files

- `src/lib/services/isomorphic/audio/pcm-processor.ts` - Captures raw PCM audio from MediaStream using Web Audio API (ScriptProcessorNode), resamples to 16kHz mono, converts Float32 to Int16
- `src/lib/services/isomorphic/transcription/realtime/elevenlabs-realtime.ts` - WebSocket service for ElevenLabs Scribe v2 API, handles connection lifecycle and transcript parsing
- `src/lib/stores/realtime-recorder.svelte.ts` - Svelte 5 store coordinating PCM processor and WebSocket, exposes reactive state (`partialTranscript`, `fullTranscript`, `committedTranscripts`)

### Flow Integration

When "ElevenLabs Realtime" is selected as the transcription service:
1. Recording start triggers both normal recorder AND realtime WebSocket session
2. Audio streams to ElevenLabs via WebSocket during recording
3. Partial transcripts appear in UI in real-time
4. On stop, the realtime transcript is used directly (batch transcription is skipped)
5. If realtime fails, an error is shown (no silent fallback)

## Tauri/Rust Backend

The Rust code in `src-tauri/src/` handles native desktop features:
- `recorder/` - CPAL audio recording
- `transcription/` - Local transcription (Whisper C++)
- `command.rs` - Tauri command definitions
- `lib.rs` - Plugin initialization
