import { Err, Ok } from 'wellcrafted/result';
import { defineQuery } from '$lib/query/client';
import { WhisperingErr } from '$lib/result';
import {
	createPcmProcessor,
	type PcmProcessor,
} from '$lib/services/isomorphic/audio/pcm-processor';
import {
	cleanupRecordingStream,
	enumerateDevices,
	getRecordingStream,
} from '$lib/services/isomorphic/device-stream';
import {
	createElevenLabsRealtimeService,
	type ElevenLabsRealtimeService,
	type RealtimeConnectionState,
	type TranscriptSegment,
} from '$lib/services/isomorphic/transcription/realtime';
import { settings } from '$lib/stores/settings.svelte';

/**
 * State for the realtime recorder.
 */
export type RealtimeRecorderState =
	| 'IDLE'
	| 'CONNECTING'
	| 'RECORDING'
	| 'STOPPING'
	| 'ERROR';

/**
 * Creates a Realtime Recorder with reactive state.
 *
 * This module provides realtime transcription using ElevenLabs Scribe v2 API.
 * State is managed with Svelte's $state rune for automatic reactivity.
 *
 * Usage:
 * - Access state reactively: `realtimeRecorder.state`
 * - Access partial transcript: `realtimeRecorder.partialTranscript`
 * - Access committed transcripts: `realtimeRecorder.committedTranscripts`
 * - Start recording: `await realtimeRecorder.startRecording({ onCommittedTranscript })`
 * - Stop recording: `await realtimeRecorder.stopRecording()`
 */
function createRealtimeRecorder() {
	// Private state
	let _state = $state<RealtimeRecorderState>('IDLE');
	let _partialTranscript = $state<string>('');
	let _committedTranscripts = $state<string[]>([]);
	let _connectionState = $state<RealtimeConnectionState>('DISCONNECTED');

	// Active session resources
	let _currentStream: MediaStream | null = null;
	let _pcmProcessor: PcmProcessor | null = null;
	let _realtimeService: ElevenLabsRealtimeService | null = null;
	let _onCommittedTranscriptCallback:
		| ((segment: TranscriptSegment) => void)
		| null = null;

	/**
	 * Clean up all resources.
	 */
	function cleanup() {
		if (_pcmProcessor) {
			_pcmProcessor.stop();
			_pcmProcessor = null;
		}

		if (_realtimeService) {
			_realtimeService.disconnect();
			_realtimeService = null;
		}

		if (_currentStream) {
			cleanupRecordingStream(_currentStream);
			_currentStream = null;
		}

		_onCommittedTranscriptCallback = null;
	}

	return {
		/**
		 * Current recorder state. Reactive - reading this in an $effect will
		 * cause the effect to re-run when the state changes.
		 */
		get state(): RealtimeRecorderState {
			return _state;
		},

		/**
		 * Current partial (uncommitted) transcript being recognized.
		 * Updates in real-time as the user speaks.
		 */
		get partialTranscript(): string {
			return _partialTranscript;
		},

		/**
		 * Full transcript text (all committed segments joined).
		 */
		get fullTranscript(): string {
			const committed = _committedTranscripts.join(' ');
			if (_partialTranscript) {
				return committed ? `${committed} ${_partialTranscript}` : _partialTranscript;
			}
			return committed;
		},

		/**
		 * Array of committed transcript segments.
		 */
		get committedTranscripts(): string[] {
			return _committedTranscripts;
		},

		/**
		 * WebSocket connection state.
		 */
		get connectionState(): RealtimeConnectionState {
			return _connectionState;
		},

		/**
		 * Enumerate available audio input devices.
		 */
		enumerateDevices: defineQuery({
			queryKey: ['realtime', 'devices'],
			queryFn: async () => {
				const { data, error } = await enumerateDevices();
				if (error) {
					return WhisperingErr({
						title: '❌ Failed to enumerate devices',
						serviceError: error,
					});
				}
				return Ok(data);
			},
		}),

		/**
		 * Start realtime recording and transcription.
		 *
		 * @param options.onCommittedTranscript - Callback fired when a transcript segment is committed
		 */
		async startRecording({
			onCommittedTranscript,
		}: {
			onCommittedTranscript?: (segment: TranscriptSegment) => void;
		} = {}) {
			// Prevent starting if already recording
			if (_state !== 'IDLE' && _state !== 'ERROR') {
				return WhisperingErr({
					title: '⚠️ Already recording',
					description: 'Stop the current recording before starting a new one.',
				});
			}

			// Reset state
			_partialTranscript = '';
			_committedTranscripts = [];
			_onCommittedTranscriptCallback = onCommittedTranscript ?? null;
			_state = 'CONNECTING';

			// Get device ID from settings
			const deviceId = settings.value['recording.navigator.deviceId'];

			// Get audio stream
			const { data: streamResult, error: streamError } =
				await getRecordingStream({
					selectedDeviceId: deviceId,
					sendStatus: (status) => {
						console.log('Realtime recorder status:', status);
					},
				});

			if (streamError) {
				_state = 'ERROR';
				return WhisperingErr({
					title: '❌ Failed to get audio stream',
					serviceError: streamError,
				});
			}

			const { stream, deviceOutcome } = streamResult;
			_currentStream = stream;

			// Create ElevenLabs realtime service
			_realtimeService = createElevenLabsRealtimeService();

			// Connect to ElevenLabs
			const apiKey = settings.value['apiKeys.elevenlabs'];
			const languageCode = settings.value['transcription.outputLanguage'];

			const { error: connectError } = await _realtimeService.connect(
				{
					apiKey,
					languageCode: languageCode !== 'auto' ? languageCode : undefined,
				},
				{
					onStateChange: (state) => {
						_connectionState = state;
					},
					onPartialTranscript: (segment) => {
						_partialTranscript = segment.text;
					},
					onCommittedTranscript: (segment) => {
						// Clear partial and add to committed
						_partialTranscript = '';
						_committedTranscripts = [..._committedTranscripts, segment.text];

						// Fire callback
						_onCommittedTranscriptCallback?.(segment);
					},
					onError: (error) => {
						console.error('Realtime transcription error:', error);
						_state = 'ERROR';
					},
				},
			);

			if (connectError) {
				cleanup();
				_state = 'ERROR';
				return WhisperingErr({
					title: '❌ Failed to connect to ElevenLabs',
					serviceError: connectError,
				});
			}

			// Create PCM processor
			_pcmProcessor = createPcmProcessor();

			const { error: processorError } = _pcmProcessor.start(stream, {
				onAudioChunk: (pcm16Data) => {
					// Send audio to ElevenLabs
					_realtimeService?.sendAudioChunk(pcm16Data);
				},
				onError: (error) => {
					console.error('PCM processor error:', error);
				},
			});

			if (processorError) {
				cleanup();
				_state = 'ERROR';
				return WhisperingErr({
					title: '❌ Failed to start audio processing',
					serviceError: processorError,
				});
			}

			_state = 'RECORDING';
			return Ok(deviceOutcome);
		},

		/**
		 * Stop recording and return the final transcript.
		 */
		async stopRecording() {
			if (_state !== 'RECORDING') {
				return Ok({
					fullTranscript: '',
					segments: [] as string[],
				});
			}

			_state = 'STOPPING';

			// Stop PCM processor first to flush any remaining audio
			if (_pcmProcessor) {
				_pcmProcessor.stop();
				_pcmProcessor = null;
			}

			// Give WebSocket time to receive final transcripts
			await new Promise((resolve) => setTimeout(resolve, 500));

			// Disconnect from ElevenLabs
			if (_realtimeService) {
				await _realtimeService.disconnect();
				_realtimeService = null;
			}

			// Clean up stream
			if (_currentStream) {
				cleanupRecordingStream(_currentStream);
				_currentStream = null;
			}

			// Get final result
			const fullTranscript = _committedTranscripts.join(' ');
			const segments = [..._committedTranscripts];

			// Reset state
			_onCommittedTranscriptCallback = null;
			_connectionState = 'DISCONNECTED';
			_state = 'IDLE';

			return Ok({
				fullTranscript,
				segments,
			});
		},

		/**
		 * Cancel recording without returning transcripts.
		 */
		async cancelRecording() {
			cleanup();
			_partialTranscript = '';
			_committedTranscripts = [];
			_connectionState = 'DISCONNECTED';
			_state = 'IDLE';
			return Ok(undefined);
		},
	};
}

export const realtimeRecorder = createRealtimeRecorder();
