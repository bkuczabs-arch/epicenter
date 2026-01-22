# Issues TODO - Commit dafe348 (ElevenLabs Realtime Transcription)

Review completed: 2026-01-20

---

## Critical Issues (Must Fix)

### [ ] 1. sendAudioChunk return value ignored
- **File:** `src/lib/stores/realtime-recorder.svelte.ts:233-237`
- **Problem:** If WebSocket send fails, audio chunks are silently dropped. Users get incomplete transcripts with no explanation.
- **Fix:** Check the Result from `sendAudioChunk()`. Track consecutive failures and either notify user or stop recording if threshold exceeded.
```typescript
onAudioChunk: (pcm16Data) => {
    const { error } = _realtimeService?.sendAudioChunk(pcm16Data) ?? { error: null };
    if (error) {
        console.error('Failed to send audio chunk:', error);
        // Consider tracking failures and stopping if too many
    }
},
```

### [ ] 2. PCM processor onError only logs, no state update
- **File:** `src/lib/stores/realtime-recorder.svelte.ts:238-240`
- **Problem:** Audio processing errors are invisible to users. UI shows "RECORDING" but capture has failed.
- **Fix:** Set `_state = 'ERROR'` and trigger user notification when PCM processing fails.
```typescript
onError: (error) => {
    console.error('PCM processor error:', error);
    _state = 'ERROR';
    // Trigger user notification
},
```

### [ ] 3. API Key exposed in WebSocket URL
- **File:** `src/lib/services/isomorphic/transcription/realtime/elevenlabs-realtime.ts:165-166`
- **Problem:** Browser WebSockets can't use headers, so API key is in URL. Visible in dev tools, network logs, browser history.
- **Fix:** Add warning in settings UI when ElevenLabs Realtime is selected, informing users about security implications.

---

## Important Issues (Should Fix)

### [ ] 4. WebSocket onError callback only logs
- **File:** `src/lib/stores/realtime-recorder.svelte.ts:214-217`
- **Problem:** State becomes ERROR but user receives no toast notification explaining what happened.
- **Fix:** Store errors that occur during recording and surface them through the notification system. Consider adding an `onError` callback parameter to `startRecording()`.

### [ ] 5. CLAUDE.md violation: try-catch used instead of trySync
- **File:** `src/lib/services/isomorphic/transcription/realtime/elevenlabs-realtime.ts:167-254`
- **Problem:** Project guidelines state "Don't use try-catch; use wellcrafted Result types"
- **Fix:** Refactor to use `trySync` from wellcrafted:
```typescript
const { data: websocket, error: wsError } = trySync({
    try: () => new WebSocket(wsUrl.toString()),
    catch: (err) => ElevenLabsRealtimeErr({
        message: `Failed to create WebSocket: ${err instanceof Error ? err.message : 'Unknown error'}`,
    }),
});
if (wsError) {
    setState('ERROR');
    return Err(wsError);
}
ws = websocket;
```

### [ ] 6. CLAUDE.md violation: settings imported directly in store
- **File:** `src/lib/stores/realtime-recorder.svelte.ts:22, 68-69, 95-96`
- **Problem:** Project guidelines state "Services accept explicit parameters and never import settings directly"
- **Fix:** Pass settings values as parameters to `startRecording()`:
```typescript
async startRecording({
    onCommittedTranscript,
    apiKey,
    deviceId,
    languageCode,
}: {
    onCommittedTranscript?: (segment: TranscriptSegment) => void;
    apiKey: string;
    deviceId: string;
    languageCode?: string;
})
```

### [ ] 7. Race condition: stopRecording during CONNECTING state
- **File:** `src/lib/stores/realtime-recorder.svelte.ts:162-166`
- **Problem:** If called while CONNECTING, returns empty result without cleaning up resources. Connection attempt continues, potentially leaving dangling WebSocket.
- **Fix:** Handle CONNECTING state explicitly:
```typescript
async stopRecording() {
    if (_state === 'IDLE' || _state === 'ERROR') {
        return Ok({ fullTranscript: '', segments: [] });
    }
    if (_state === 'CONNECTING') {
        cleanup();
        _state = 'IDLE';
        return Ok({ fullTranscript: '', segments: [] });
    }
    // ... rest of stop logic
}
```

### [ ] 8. disconnect() not awaited in cleanup
- **File:** `src/lib/stores/realtime-recorder.svelte.ts:68-69`
- **Problem:** `_realtimeService.disconnect()` is async but not awaited. Creates race condition if new recording starts immediately.
- **Fix:** Either await the disconnect or make cleanup async and await it.

### [ ] 9. stopRecording discards partialTranscript
- **File:** `src/lib/stores/realtime-recorder.svelte.ts:193-195`
- **Problem:** Final partial transcript is lost when stopping. Last words being spoken may be discarded.
- **Fix:** Include partial transcript in final result:
```typescript
const fullTranscript = _partialTranscript
    ? _committedTranscripts.join(' ') + ' ' + _partialTranscript
    : _committedTranscripts.join(' ');
```

---

## Medium Issues (Nice to Have)

### [ ] 10. Magic 500ms timeout instead of event-based completion
- **File:** `src/lib/stores/realtime-recorder.svelte.ts:275-276`
- **Problem:** Arbitrary delay with no guarantee of correctness. Slow networks may lose transcripts.
- **Fix:** Implement proper session termination by sending end-of-stream message and waiting for acknowledgment, or track pending transcripts.

### [ ] 11. No connection timeout
- **File:** `src/lib/services/isomorphic/transcription/realtime/elevenlabs-realtime.ts:176-263`
- **Problem:** If neither onopen nor onerror fires (browser quirks, firewall), connection hangs forever in CONNECTING state.
- **Fix:** Add timeout (10-30 seconds) that rejects the Promise if connection doesn't complete.

### [ ] 12. audioContext.close() error not handled
- **File:** `src/lib/services/isomorphic/audio/pcm-processor.ts:211-213`
- **Problem:** `audioContext.close()` is async and can reject, but error is not handled.
- **Fix:** Either await and handle, or explicitly ignore if cleanup errors are acceptable.

### [ ] 13. Inaccurate ~150ms latency claim
- **Files:** `src/lib/query/isomorphic/actions.ts:35`, `src/lib/services/isomorphic/transcription/registry.ts`
- **Problem:** True end-to-end latency is 200-400ms (128ms client buffering + network + API processing).
- **Fix:** Change to "low-latency streaming transcription (typically 200-400ms)" or remove specific figure.

### [ ] 14. Incorrect buffer latency comment
- **File:** `src/lib/services/isomorphic/audio/pcm-processor.ts:15-18`
- **Problem:** Comment says "~64ms latency per chunk" but actual emission is after 2 buffers (~128ms).
- **Fix:** Update comment to reflect actual latency:
```typescript
/**
 * Buffer size for ScriptProcessorNode (samples per callback).
 * At 16kHz, each buffer holds ~64ms of audio.
 * Combined with BUFFERS_PER_EMIT=2, actual emission latency is ~128ms.
 */
```

### [ ] 15. "Singleton" export is misleading
- **File:** `src/lib/services/isomorphic/transcription/realtime/elevenlabs-realtime.ts:329-332`
- **Problem:** `ElevenLabsRealtimeServiceLive` is called "singleton" but realtime-recorder creates fresh instances.
- **Fix:** Either remove the singleton export or update comment:
```typescript
/**
 * Default instance of the ElevenLabs Realtime service.
 * Note: The realtime-recorder creates fresh instances per session.
 */
```

### [ ] 16. JSON parse uses type assertion
- **File:** `src/lib/services/isomorphic/transcription/realtime/elevenlabs-realtime.ts:203-212`
- **Problem:** `JSON.parse(event.data) as ElevenLabsOutputMessage` bypasses validation. Malformed messages slip through.
- **Fix:** Add runtime validation using zod or manual checks before type assertion.

---

## Documentation Issues

### [ ] 17. Missing @returns JSDoc on startRecording
- **File:** `src/lib/stores/realtime-recorder.svelte.ts:140-144`
- **Fix:** Add:
```typescript
* @returns Ok(deviceOutcome) on success with info about which device was used,
*          or Err(WhisperingError) if connection or audio setup fails.
```

### [ ] 18. Missing return type documentation on connect()
- **File:** `src/lib/services/isomorphic/transcription/realtime/elevenlabs-realtime.ts:134-139`
- **Fix:** Add:
```typescript
* @returns Ok(void) when WebSocket opens successfully,
*          Err when API key is missing, already connected, or connection fails.
```

### [ ] 19. fullTranscript getter docstring incomplete
- **File:** `src/lib/stores/realtime-recorder.svelte.ts:98-100`
- **Problem:** Comment says "all committed segments joined" but code also includes partial.
- **Fix:** Update to:
```typescript
/**
 * Full transcript text (committed segments + current partial).
 * Includes the in-progress partial transcript if speech is ongoing.
 */
```

### [ ] 20. 500ms delay needs rationale comment
- **File:** `src/lib/stores/realtime-recorder.svelte.ts:275-276`
- **Fix:** Expand comment:
```typescript
// Allow 500ms for ElevenLabs to flush any pending VAD-triggered commits.
// This delay accounts for the vad_silence_threshold_secs (1.0s) plus network jitter.
// Reducing this may cause final words to be lost.
```

---

## Summary

| Priority | Count | Status |
|----------|-------|--------|
| Critical | 3 | Pending |
| Important | 6 | Pending |
| Medium | 7 | Pending |
| Documentation | 4 | Pending |
| **Total** | **20** | **Pending** |
