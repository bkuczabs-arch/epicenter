import { createTaggedError } from 'wellcrafted/error';
import { Err, Ok, type Result, trySync } from 'wellcrafted/result';

export const { PcmProcessorError, PcmProcessorErr } =
	createTaggedError('PcmProcessorError');
export type PcmProcessorError = ReturnType<typeof PcmProcessorError>;

/**
 * Target sample rate for ElevenLabs Scribe v2 Realtime API.
 * The API requires PCM audio at 16kHz.
 */
const TARGET_SAMPLE_RATE = 16000;

/**
 * Buffer size for ScriptProcessorNode.
 * 1024 samples at 16kHz = ~64ms latency per chunk.
 * This balances low latency with reasonable CPU overhead.
 */
const BUFFER_SIZE = 1024;

/**
 * Number of buffers to accumulate before emitting.
 * Accumulating 2 buffers gives us ~128ms chunks, which is good for WebSocket efficiency.
 */
const BUFFERS_PER_EMIT = 2;

type PcmProcessorState = 'IDLE' | 'PROCESSING' | 'ERROR';

type PcmProcessorCallbacks = {
	/**
	 * Called when a PCM chunk is ready for transmission.
	 * @param pcm16Data - Int16 PCM samples at 16kHz mono
	 */
	onAudioChunk: (pcm16Data: Int16Array) => void;

	/**
	 * Called when an error occurs during processing.
	 */
	onError: (error: PcmProcessorError) => void;
};

/**
 * Creates a PCM audio processor that captures raw audio from a MediaStream
 * and converts it to Int16 PCM at 16kHz mono for realtime transcription.
 *
 * Uses Web Audio API's ScriptProcessorNode for audio processing.
 * While ScriptProcessorNode is deprecated, it provides the simplest
 * cross-browser solution. Can be upgraded to AudioWorkletNode for
 * even lower latency in the future.
 */
export function createPcmProcessor() {
	let audioContext: AudioContext | null = null;
	let sourceNode: MediaStreamAudioSourceNode | null = null;
	let processorNode: ScriptProcessorNode | null = null;
	let state: PcmProcessorState = 'IDLE';
	let callbacks: PcmProcessorCallbacks | null = null;

	// Buffer for accumulating samples before emission
	let sampleBuffer: Float32Array = new Float32Array(
		BUFFER_SIZE * BUFFERS_PER_EMIT,
	);
	let bufferIndex = 0;

	/**
	 * Convert Float32 samples (-1.0 to 1.0) to Int16 PCM (-32768 to 32767)
	 */
	function float32ToInt16(float32Array: Float32Array): Int16Array {
		const int16Array = new Int16Array(float32Array.length);
		for (let i = 0; i < float32Array.length; i++) {
			// Clamp to -1.0 to 1.0 range
			const sample = Math.max(-1, Math.min(1, float32Array[i]));
			// Convert to Int16 range
			int16Array[i] = sample < 0 ? sample * 0x8000 : sample * 0x7fff;
		}
		return int16Array;
	}

	return {
		/**
		 * Get current processor state.
		 */
		getState(): PcmProcessorState {
			return state;
		},

		/**
		 * Start processing audio from the given MediaStream.
		 * The stream should already be acquired from the user's microphone.
		 *
		 * @param stream - MediaStream from getUserMedia
		 * @param cbs - Callbacks for audio chunks and errors
		 */
		start(
			stream: MediaStream,
			cbs: PcmProcessorCallbacks,
		): Result<void, PcmProcessorError> {
			if (state === 'PROCESSING') {
				return PcmProcessorErr({
					message:
						'PCM processor is already running. Stop it before starting again.',
				});
			}

			callbacks = cbs;
			bufferIndex = 0;

			// Create AudioContext with target sample rate
			// The browser will automatically resample the input to match
			const { data: ctx, error: contextError } = trySync({
				try: () => new AudioContext({ sampleRate: TARGET_SAMPLE_RATE }),
				catch: (error) =>
					PcmProcessorErr({
						message: `Failed to create AudioContext: ${error instanceof Error ? error.message : 'Unknown error'}`,
					}),
			});

			if (contextError) {
				state = 'ERROR';
				return Err(contextError);
			}

			audioContext = ctx;

			// Create source node from MediaStream
			const { data: source, error: sourceError } = trySync({
				try: () => audioContext!.createMediaStreamSource(stream),
				catch: (error) =>
					PcmProcessorErr({
						message: `Failed to create audio source: ${error instanceof Error ? error.message : 'Unknown error'}`,
					}),
			});

			if (sourceError) {
				audioContext.close();
				audioContext = null;
				state = 'ERROR';
				return Err(sourceError);
			}

			sourceNode = source;

			// Create ScriptProcessorNode for raw sample access
			// Using mono input/output (1 channel)
			const { data: processor, error: processorError } = trySync({
				try: () => audioContext!.createScriptProcessor(BUFFER_SIZE, 1, 1),
				catch: (error) =>
					PcmProcessorErr({
						message: `Failed to create audio processor: ${error instanceof Error ? error.message : 'Unknown error'}`,
					}),
			});

			if (processorError) {
				sourceNode.disconnect();
				audioContext.close();
				sourceNode = null;
				audioContext = null;
				state = 'ERROR';
				return Err(processorError);
			}

			processorNode = processor;

			// Set up audio processing callback
			processorNode.onaudioprocess = (event: AudioProcessingEvent) => {
				const inputData = event.inputBuffer.getChannelData(0);

				// Copy samples to accumulator buffer
				sampleBuffer.set(inputData, bufferIndex * BUFFER_SIZE);
				bufferIndex++;

				// When we've accumulated enough buffers, emit the chunk
				if (bufferIndex >= BUFFERS_PER_EMIT) {
					const pcm16 = float32ToInt16(sampleBuffer);
					callbacks?.onAudioChunk(pcm16);
					bufferIndex = 0;
				}
			};

			// Connect the audio graph
			// Source -> Processor -> Destination (destination is needed for processing to occur)
			sourceNode.connect(processorNode);
			processorNode.connect(audioContext.destination);

			state = 'PROCESSING';
			return Ok(undefined);
		},

		/**
		 * Stop processing and clean up resources.
		 */
		stop(): Result<void, PcmProcessorError> {
			// Emit any remaining buffered samples
			if (bufferIndex > 0 && callbacks) {
				const remainingSamples = sampleBuffer.slice(0, bufferIndex * BUFFER_SIZE);
				const pcm16 = float32ToInt16(remainingSamples);
				callbacks.onAudioChunk(pcm16);
			}

			// Clean up audio nodes
			if (processorNode) {
				processorNode.onaudioprocess = null;
				processorNode.disconnect();
				processorNode = null;
			}

			if (sourceNode) {
				sourceNode.disconnect();
				sourceNode = null;
			}

			if (audioContext) {
				audioContext.close();
				audioContext = null;
			}

			bufferIndex = 0;
			callbacks = null;
			state = 'IDLE';

			return Ok(undefined);
		},
	};
}

export type PcmProcessor = ReturnType<typeof createPcmProcessor>;
