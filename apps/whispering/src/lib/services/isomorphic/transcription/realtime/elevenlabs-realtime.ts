import { createTaggedError } from 'wellcrafted/error';
import { Err, Ok, type Result, trySync } from 'wellcrafted/result';

export const { ElevenLabsRealtimeError, ElevenLabsRealtimeErr } =
	createTaggedError('ElevenLabsRealtimeError');
export type ElevenLabsRealtimeError = ReturnType<typeof ElevenLabsRealtimeError>;

/**
 * WebSocket endpoint for ElevenLabs Scribe v2 Realtime API.
 */
const ELEVENLABS_REALTIME_WS_URL =
	'wss://api.elevenlabs.io/v1/speech-to-text/realtime';

/**
 * Connection state for the realtime transcription session.
 */
export type RealtimeConnectionState =
	| 'DISCONNECTED'
	| 'CONNECTING'
	| 'CONNECTED'
	| 'ERROR';

/**
 * Transcript segment with metadata.
 */
export type TranscriptSegment = {
	text: string;
	timestamp: number;
	status: 'partial' | 'committed';
};

/**
 * Callbacks for realtime transcription events.
 */
export type RealtimeTranscriptionCallbacks = {
	onStateChange: (state: RealtimeConnectionState) => void;
	onPartialTranscript: (segment: TranscriptSegment) => void;
	onCommittedTranscript: (segment: TranscriptSegment) => void;
	onError: (error: ElevenLabsRealtimeError) => void;
};

/**
 * Options for connecting to ElevenLabs Realtime API.
 */
export type ElevenLabsRealtimeOptions = {
	apiKey: string;
	languageCode?: string;
};

/**
 * Message types sent to ElevenLabs WebSocket.
 */
type ElevenLabsInputMessage = {
	message_type: 'input_audio_chunk';
	audio_base_64: string; // base64-encoded PCM16 audio
	commit: boolean;
	sample_rate: number;
};

/**
 * Message types received from ElevenLabs WebSocket.
 */
type ElevenLabsOutputMessage =
	| {
			message_type: 'session_started';
			session_id: string;
	  }
	| {
			message_type: 'partial_transcript';
			text: string;
	  }
	| {
			message_type: 'committed_transcript';
			text: string;
	  }
	| {
			message_type: 'committed_transcript_with_timestamps';
			text: string;
			language_code?: string;
			words?: Array<{
				text: string;
				start: number;
				end: number;
				type: 'word' | 'spacing';
			}>;
	  }
	| {
			message_type: 'error' | 'input_error' | 'auth_error';
			error: string;
	  };

/**
 * Creates an ElevenLabs Realtime transcription service.
 *
 * This service manages the WebSocket connection to ElevenLabs' Scribe v2 Realtime API,
 * handling audio chunk transmission and transcript reception with VAD-based auto-commit.
 */
export function createElevenLabsRealtimeService() {
	let ws: WebSocket | null = null;
	let connectionState: RealtimeConnectionState = 'DISCONNECTED';
	let callbacks: RealtimeTranscriptionCallbacks | null = null;
	let sessionId: string | null = null;

	const setState = (newState: RealtimeConnectionState) => {
		connectionState = newState;
		callbacks?.onStateChange(newState);
	};

	/**
	 * Convert Int16Array to base64 string for WebSocket transmission.
	 */
	function int16ArrayToBase64(int16Array: Int16Array): string {
		const uint8Array = new Uint8Array(int16Array.buffer);
		let binary = '';
		for (let i = 0; i < uint8Array.length; i++) {
			binary += String.fromCharCode(uint8Array[i]);
		}
		return btoa(binary);
	}

	return {
		/**
		 * Get current connection state.
		 */
		getConnectionState(): RealtimeConnectionState {
			return connectionState;
		},

		/**
		 * Get current session ID (available after connection is established).
		 */
		getSessionId(): string | null {
			return sessionId;
		},

		/**
		 * Connect to ElevenLabs Realtime API.
		 *
		 * @param options - Connection options including API key
		 * @param cbs - Callbacks for transcription events
		 */
		async connect(
			options: ElevenLabsRealtimeOptions,
			cbs: RealtimeTranscriptionCallbacks,
		): Promise<Result<void, ElevenLabsRealtimeError>> {
			if (!options.apiKey) {
				return ElevenLabsRealtimeErr({
					message:
						'ElevenLabs API key is required for realtime transcription. Please add your API key in Settings.',
				});
			}

			if (ws) {
				return ElevenLabsRealtimeErr({
					message:
						'Already connected to ElevenLabs. Disconnect first before reconnecting.',
				});
			}

			callbacks = cbs;
			setState('CONNECTING');

			// Step 1: Get a single-use token for client-side WebSocket authentication
			// The API key is used server-side to get the token, which is then used client-side
			let token: string;
			try {
				const tokenResponse = await fetch(
					'https://api.elevenlabs.io/v1/single-use-token/realtime_scribe',
					{
						method: 'POST',
						headers: {
							'xi-api-key': options.apiKey,
						},
					},
				);

				if (!tokenResponse.ok) {
					const errorText = await tokenResponse.text();
					return ElevenLabsRealtimeErr({
						message: `Failed to get ElevenLabs token: ${tokenResponse.status} ${errorText}`,
					});
				}

				const tokenData = await tokenResponse.json();
				token = tokenData.token;
			} catch (err) {
				return ElevenLabsRealtimeErr({
					message: `Failed to authenticate with ElevenLabs: ${err instanceof Error ? err.message : 'Network error'}`,
				});
			}

			// Step 2: Build WebSocket URL with query parameters and token
			const wsUrl = new URL(ELEVENLABS_REALTIME_WS_URL);
			wsUrl.searchParams.set('model_id', 'scribe_v2_realtime');
			wsUrl.searchParams.set('audio_format', 'pcm_16000');
			wsUrl.searchParams.set('commit_strategy', 'vad');
			wsUrl.searchParams.set('vad_silence_threshold_secs', '1.0');

			if (options.languageCode && options.languageCode !== 'auto') {
				wsUrl.searchParams.set('language_code', options.languageCode);
			}

			// Use single-use token for authentication (not API key directly)
			wsUrl.searchParams.set('token', token);

			return new Promise((resolve) => {
				try {
					ws = new WebSocket(wsUrl.toString());

					ws.onopen = () => {
						setState('CONNECTED');
						resolve(Ok(undefined));
					};

					ws.onerror = (event) => {
						const error = ElevenLabsRealtimeError({
							message:
								'WebSocket connection error. Check your API key and network connection.',
						});
						setState('ERROR');
						callbacks?.onError(error);
						ws = null;
						resolve(Err(error));
					};

					ws.onclose = (event) => {
						ws = null;
						sessionId = null;

						if (connectionState !== 'DISCONNECTED') {
							setState('DISCONNECTED');

							if (!event.wasClean) {
								const error = ElevenLabsRealtimeError({
									message: `Connection closed unexpectedly (code: ${event.code}). ${event.reason || ''}`,
								});
								callbacks?.onError(error);
							}
						}
					};

					ws.onmessage = (event) => {
						const { data: message, error: parseError } = trySync({
							try: () => JSON.parse(event.data) as ElevenLabsOutputMessage,
							catch: () =>
								ElevenLabsRealtimeErr({
									message: 'Failed to parse message from ElevenLabs',
								}),
						});

						if (parseError) {
							callbacks?.onError(parseError);
							return;
						}

						switch (message.message_type) {
							case 'session_started':
								sessionId = message.session_id;
								break;

							case 'partial_transcript':
								callbacks?.onPartialTranscript({
									text: message.text,
									timestamp: Date.now(),
									status: 'partial',
								});
								break;

							case 'committed_transcript':
							case 'committed_transcript_with_timestamps':
								callbacks?.onCommittedTranscript({
									text: message.text,
									timestamp: Date.now(),
									status: 'committed',
								});
								break;

							case 'error':
							case 'input_error':
							case 'auth_error':
								const error = ElevenLabsRealtimeError({
									message: `ElevenLabs transcription error: ${message.error}`,
								});
								callbacks?.onError(error);
								break;
						}
					};
				} catch (err) {
					const error = ElevenLabsRealtimeError({
						message: `Failed to create WebSocket connection: ${err instanceof Error ? err.message : 'Unknown error'}`,
					});
					setState('ERROR');
					resolve(Err(error));
				}
			});
		},

		/**
		 * Send audio chunk to ElevenLabs for transcription.
		 *
		 * @param pcm16Data - Int16 PCM audio samples at 16kHz mono
		 */
		sendAudioChunk(pcm16Data: Int16Array): Result<void, ElevenLabsRealtimeError> {
			if (!ws || connectionState !== 'CONNECTED') {
				return ElevenLabsRealtimeErr({
					message: 'Cannot send audio: not connected to transcription service',
				});
			}

			const base64Audio = int16ArrayToBase64(pcm16Data);

			const message: ElevenLabsInputMessage = {
				message_type: 'input_audio_chunk',
				audio_base_64: base64Audio,
				commit: false, // VAD handles commits automatically
				sample_rate: 16000,
			};

			const { error: sendError } = trySync({
				try: () => ws!.send(JSON.stringify(message)),
				catch: () =>
					ElevenLabsRealtimeErr({
						message: 'Failed to send audio chunk to ElevenLabs',
					}),
			});

			if (sendError) return Err(sendError);
			return Ok(undefined);
		},

		/**
		 * Disconnect from ElevenLabs Realtime API.
		 */
		async disconnect(): Promise<Result<void, ElevenLabsRealtimeError>> {
			if (!ws) return Ok(undefined);

			setState('DISCONNECTED');

			const { error: closeError } = trySync({
				try: () => {
					ws!.close(1000, 'Client disconnect');
					ws = null;
					sessionId = null;
				},
				catch: () =>
					ElevenLabsRealtimeErr({
						message: 'Error while disconnecting from ElevenLabs',
					}),
			});

			callbacks = null;

			if (closeError) return Err(closeError);
			return Ok(undefined);
		},
	};
}

export type ElevenLabsRealtimeService = ReturnType<
	typeof createElevenLabsRealtimeService
>;

/**
 * Singleton instance of the ElevenLabs Realtime service.
 */
export const ElevenLabsRealtimeServiceLive = createElevenLabsRealtimeService();
