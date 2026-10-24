// friday-audio: capture system audio via ScreenCaptureKit (the interviewer)
// and, optionally, the microphone via AVAudioEngine with Apple's voice
// processing (echo cancellation) enabled (the candidate). Spawned by the
// Electron main process.
//
// Usage: friday-audio [--mic]
//
// stdout: a stream of tagged frames. Every frame is written atomically:
//   byte 0       source: 0 = system audio, 1 = microphone
//   bytes 1..4   payload length in bytes, UInt32 little-endian
//   bytes 5..    payload: 16 kHz mono Int16 LE PCM
// The Node side demuxes by source and re-chunks each source into ~100ms
// blocks (3200 bytes) before forwarding to the renderer over IPC.
//
// stderr: log lines prefixed [friday-audio] for diagnostics.
// SIGTERM/SIGINT: stops capture cleanly and exits 0.
//
// Mic failures (permission denied, no input device, engine errors) are logged
// as "[friday-audio] mic unavailable: <reason>" and never terminate the
// helper; system audio keeps flowing.

import AVFoundation
import CoreMedia
import Foundation
import ScreenCaptureKit

let stderrHandle = FileHandle.standardError
let stdoutHandle = FileHandle.standardOutput

func logErr(_ message: String) {
    if let data = ("[friday-audio] " + message + "\n").data(using: .utf8) {
        stderrHandle.write(data)
    }
}

// MARK: - framed stdout writer

enum AudioSource: UInt8 {
    case system = 0
    case mic = 1
}

/// Serializes stdout writes from both capture queues so a frame's header and
/// payload are always written contiguously.
final class FrameWriter: @unchecked Sendable {
    static let shared = FrameWriter()
    private let lock = NSLock()

    func write(source: AudioSource, buffer: AVAudioPCMBuffer) {
        guard let int16 = buffer.int16ChannelData else { return }
        let count = Int(buffer.frameLength)
        if count == 0 { return }
        let payloadBytes = count * MemoryLayout<Int16>.size

        var frame = Data(capacity: 5 + payloadBytes)
        frame.append(source.rawValue)
        var len = UInt32(payloadBytes).littleEndian
        withUnsafeBytes(of: &len) { frame.append(contentsOf: $0) }
        frame.append(UnsafeRawPointer(int16[0]).assumingMemoryBound(to: UInt8.self), count: payloadBytes)

        lock.lock()
        defer { lock.unlock() }
        do {
            try stdoutHandle.write(contentsOf: frame)
        } catch {
            // Stdout closed (parent died). Exit cleanly.
            exit(0)
        }
    }
}

let targetFormat: AVAudioFormat = AVAudioFormat(
    commonFormat: .pcmFormatInt16,
    sampleRate: 16_000,
    channels: 1,
    interleaved: true
)!

/// Run `input` through a long-lived converter (keeps resampler state across
/// buffers) into a fresh 16 kHz mono Int16 buffer.
func convert(_ input: AVAudioPCMBuffer, with converter: AVAudioConverter) -> AVAudioPCMBuffer? {
    let ratio = targetFormat.sampleRate / input.format.sampleRate
    let capacity = AVAudioFrameCount(Double(input.frameLength) * ratio + 1024)
    guard let output = AVAudioPCMBuffer(pcmFormat: targetFormat, frameCapacity: capacity)
    else { return nil }

    var error: NSError?
    var consumed = false
    let status = converter.convert(to: output, error: &error) { _, statusOut in
        if consumed {
            statusOut.pointee = .noDataNow
            return nil
        }
        consumed = true
        statusOut.pointee = .haveData
        return input
    }
    if status == .error {
        logErr("convert failed: \(error?.localizedDescription ?? "unknown")")
        return nil
    }
    return output
}

// MARK: - system audio (ScreenCaptureKit)

@available(macOS 13.0, *)
final class AudioCapture: NSObject, SCStreamOutput, SCStreamDelegate {
    private var stream: SCStream?
    private var converter: AVAudioConverter?

    func start() async throws {
        let content = try await SCShareableContent.current
        guard let display = content.displays.first else {
            throw NSError(
                domain: "friday-audio",
                code: 1,
                userInfo: [NSLocalizedDescriptionKey: "no displays available"]
            )
        }

        let filter = SCContentFilter(display: display, excludingWindows: [])

        let config = SCStreamConfiguration()
        config.capturesAudio = true
        config.excludesCurrentProcessAudio = true
        config.sampleRate = 48_000
        config.channelCount = 2
        // Video output is unused but SCStream still produces a video stream;
        // make it as cheap as possible.
        config.width = 2
        config.height = 2
        config.minimumFrameInterval = CMTime(value: 1, timescale: 1)
        config.queueDepth = 5

        let stream = SCStream(filter: filter, configuration: config, delegate: self)
        try stream.addStreamOutput(
            self,
            type: .audio,
            sampleHandlerQueue: DispatchQueue(label: "friday.audio.queue")
        )
        try await stream.startCapture()
        self.stream = stream
        logErr("capture started")
    }

    func stop() async {
        if let stream = self.stream {
            try? await stream.stopCapture()
            self.stream = nil
            logErr("capture stopped")
        }
    }

    // MARK: - SCStreamOutput

    func stream(
        _ stream: SCStream,
        didOutputSampleBuffer sampleBuffer: CMSampleBuffer,
        of type: SCStreamOutputType
    ) {
        guard type == .audio, sampleBuffer.isValid else { return }
        guard let input = makePCMBuffer(from: sampleBuffer) else { return }
        guard let output = convertToInt16Mono16k(input) else { return }
        FrameWriter.shared.write(source: .system, buffer: output)
    }

    // MARK: - SCStreamDelegate

    func stream(_ stream: SCStream, didStopWithError error: Error) {
        logErr("stream error: \(error.localizedDescription)")
        exit(2)
    }

    // MARK: - helpers

    private func makePCMBuffer(from sampleBuffer: CMSampleBuffer) -> AVAudioPCMBuffer? {
        guard let formatDesc = sampleBuffer.formatDescription,
              let asbdPtr = CMAudioFormatDescriptionGetStreamBasicDescription(formatDesc)
        else { return nil }
        var asbd = asbdPtr.pointee
        guard let format = AVAudioFormat(streamDescription: &asbd) else { return nil }
        let frames = AVAudioFrameCount(CMSampleBufferGetNumSamples(sampleBuffer))
        guard frames > 0,
              let buffer = AVAudioPCMBuffer(pcmFormat: format, frameCapacity: frames)
        else { return nil }
        buffer.frameLength = frames

        let abl = buffer.mutableAudioBufferList
        let status = CMSampleBufferCopyPCMDataIntoAudioBufferList(
            sampleBuffer,
            at: 0,
            frameCount: Int32(frames),
            into: abl
        )
        return status == noErr ? buffer : nil
    }

    private func convertToInt16Mono16k(_ input: AVAudioPCMBuffer) -> AVAudioPCMBuffer? {
        if input.format == targetFormat { return input }
        if converter == nil {
            converter = AVAudioConverter(from: input.format, to: targetFormat)
        }
        guard let converter = converter else { return nil }
        return convert(input, with: converter)
    }
}

// MARK: - microphone (AVAudioEngine + voice processing / AEC)

final class MicCapture: @unchecked Sendable {
    private let engine = AVAudioEngine()
    // Own converter; never shared with the system-audio path.
    private var converter: AVAudioConverter?
    private var monoFormat: AVAudioFormat?
    private var running = false
    private var configObserver: NSObjectProtocol?

    /// Starts mic capture. Never throws or exits: failures are logged as
    /// "mic unavailable" and system audio continues.
    func start() async {
        switch AVCaptureDevice.authorizationStatus(for: .audio) {
        case .authorized:
            break
        case .notDetermined:
            let granted = await AVCaptureDevice.requestAccess(for: .audio)
            if !granted {
                logErr("mic unavailable: microphone permission denied")
                return
            }
        case .denied:
            logErr("mic unavailable: microphone permission denied")
            return
        case .restricted:
            logErr("mic unavailable: microphone access restricted")
            return
        @unknown default:
            logErr("mic unavailable: unknown microphone authorization status")
            return
        }

        do {
            try startEngine()
            configObserver = NotificationCenter.default.addObserver(
                forName: .AVAudioEngineConfigurationChange,
                object: engine,
                queue: nil
            ) { [weak self] _ in
                self?.handleConfigurationChange()
            }
            logErr("mic capture started (voice processing on)")
        } catch {
            teardown()
            logErr("mic unavailable: \(error.localizedDescription)")
        }
    }

    func stop() {
        if let observer = configObserver {
            NotificationCenter.default.removeObserver(observer)
            configObserver = nil
        }
        if running {
            teardown()
            logErr("mic capture stopped")
        }
    }

    private func startEngine() throws {
        let input = engine.inputNode

        // Echo cancellation must be enabled before the engine starts.
        try input.setVoiceProcessingEnabled(true)
        if #available(macOS 14.0, *) {
            // Don't turn the interviewer's audio down while we capture.
            input.voiceProcessingOtherAudioDuckingConfiguration =
                AVAudioVoiceProcessingOtherAudioDuckingConfiguration(
                    enableAdvancedDucking: false,
                    duckingLevel: .min
                )
        }

        let inFormat = input.outputFormat(forBus: 0)
        guard inFormat.sampleRate > 0, inFormat.channelCount > 0 else {
            throw NSError(
                domain: "friday-audio",
                code: 3,
                userInfo: [NSLocalizedDescriptionKey: "no input device"]
            )
        }

        // VPIO can report a multi-channel input format (mirroring the
        // hardware channel count); the echo-cancelled voice signal is on
        // channel 0. Float input is reduced to channel 0 ourselves, then a
        // mono converter resamples to 16 kHz Int16. Other formats go straight
        // through AVAudioConverter, which handles mono/stereo downmix.
        if inFormat.commonFormat == .pcmFormatFloat32 {
            guard let mono = AVAudioFormat(
                commonFormat: .pcmFormatFloat32,
                sampleRate: inFormat.sampleRate,
                channels: 1,
                interleaved: false
            ) else {
                throw NSError(
                    domain: "friday-audio",
                    code: 4,
                    userInfo: [NSLocalizedDescriptionKey: "unsupported input format \(inFormat)"]
                )
            }
            monoFormat = mono
            converter = AVAudioConverter(from: mono, to: targetFormat)
        } else {
            monoFormat = nil
            converter = AVAudioConverter(from: inFormat, to: targetFormat)
        }
        guard converter != nil else {
            throw NSError(
                domain: "friday-audio",
                code: 5,
                userInfo: [NSLocalizedDescriptionKey: "cannot convert from \(inFormat)"]
            )
        }

        input.installTap(onBus: 0, bufferSize: 4096, format: inFormat) { [weak self] buffer, _ in
            self?.handle(buffer)
        }
        running = true
        engine.prepare()
        try engine.start()
    }

    private func teardown() {
        engine.inputNode.removeTap(onBus: 0)
        if engine.isRunning { engine.stop() }
        running = false
    }

    private func handleConfigurationChange() {
        // Device changed (e.g. headphones plugged in). The engine has stopped;
        // rebuild the tap/converter for the new format and restart.
        guard running else { return }
        logErr("mic configuration changed, restarting")
        teardown()
        do {
            try startEngine()
        } catch {
            teardown()
            logErr("mic unavailable: \(error.localizedDescription)")
        }
    }

    private func handle(_ buffer: AVAudioPCMBuffer) {
        guard buffer.frameLength > 0, let converter = converter else { return }
        let source: AVAudioPCMBuffer
        if let mono = monoFormat {
            guard let channels = buffer.floatChannelData,
                  let monoBuf = AVAudioPCMBuffer(pcmFormat: mono, frameCapacity: buffer.frameLength),
                  let dst = monoBuf.floatChannelData
            else { return }
            let frames = Int(buffer.frameLength)
            let stride = buffer.stride // 1 when deinterleaved, channelCount when interleaved
            let src = channels[0]
            if stride == 1 {
                dst[0].update(from: src, count: frames)
            } else {
                for i in 0..<frames { dst[0][i] = src[i * stride] }
            }
            monoBuf.frameLength = buffer.frameLength
            source = monoBuf
        } else {
            source = buffer
        }
        guard let output = convert(source, with: converter) else { return }
        FrameWriter.shared.write(source: .mic, buffer: output)
    }
}

// MARK: - entry point

guard #available(macOS 13.0, *) else {
    logErr("requires macOS 13 or later")
    exit(1)
}

let micEnabled = CommandLine.arguments.dropFirst().contains("--mic")
let capture = AudioCapture()
let mic: MicCapture? = micEnabled ? MicCapture() : nil

func shutdown() {
    Task {
        mic?.stop()
        await capture.stop()
        exit(0)
    }
}

let sigtermSource = DispatchSource.makeSignalSource(signal: SIGTERM, queue: .main)
sigtermSource.setEventHandler { shutdown() }
signal(SIGTERM, SIG_IGN)
sigtermSource.resume()

let sigintSource = DispatchSource.makeSignalSource(signal: SIGINT, queue: .main)
sigintSource.setEventHandler { shutdown() }
signal(SIGINT, SIG_IGN)
sigintSource.resume()

Task {
    do {
        try await capture.start()
    } catch {
        logErr("start failed: \(error.localizedDescription)")
        mic?.stop()
        exit(0)
    }
}

if let mic = mic {
    Task {
        await mic.start()
    }
}

// Serve the main queue (signal handlers, AVFoundation notifications).
dispatchMain()
