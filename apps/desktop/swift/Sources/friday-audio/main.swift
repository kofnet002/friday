// friday-audio: capture system audio via ScreenCaptureKit, emit 16kHz mono
// Int16 LE PCM to stdout. Spawned by the Electron main process.
//
// stdout: raw audio bytes (no framing). The Node side chunks into ~100ms
// blocks (3200 bytes) before forwarding to the renderer over IPC.
// stderr: log lines prefixed [friday-audio] for diagnostics.
// SIGTERM: stops capture cleanly and exits 0.

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

@available(macOS 13.0, *)
final class AudioCapture: NSObject, SCStreamOutput, SCStreamDelegate {
    private var stream: SCStream?
    private var converter: AVAudioConverter?
    private let targetFormat: AVAudioFormat = AVAudioFormat(
        commonFormat: .pcmFormatInt16,
        sampleRate: 16_000,
        channels: 1,
        interleaved: true
    )!

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
        writeToStdout(output)
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

    private func writeToStdout(_ buffer: AVAudioPCMBuffer) {
        guard let int16 = buffer.int16ChannelData else { return }
        let count = Int(buffer.frameLength)
        if count == 0 { return }
        let data = Data(bytes: int16[0], count: count * MemoryLayout<Int16>.size)
        do {
            try stdoutHandle.write(contentsOf: data)
        } catch {
            // Stdout closed (parent died). Exit cleanly.
            exit(0)
        }
    }
}

// MARK: - entry point

guard #available(macOS 13.0, *) else {
    logErr("requires macOS 13 or later")
    exit(1)
}

let capture = AudioCapture()
let exitGroup = DispatchSemaphore(value: 0)

let sigtermSource = DispatchSource.makeSignalSource(signal: SIGTERM, queue: .global())
sigtermSource.setEventHandler {
    Task {
        await capture.stop()
        exitGroup.signal()
    }
}
signal(SIGTERM, SIG_IGN)
sigtermSource.resume()

let sigintSource = DispatchSource.makeSignalSource(signal: SIGINT, queue: .global())
sigintSource.setEventHandler {
    Task {
        await capture.stop()
        exitGroup.signal()
    }
}
signal(SIGINT, SIG_IGN)
sigintSource.resume()

Task {
    do {
        try await capture.start()
    } catch {
        logErr("start failed: \(error.localizedDescription)")
        exitGroup.signal()
    }
}

exitGroup.wait()
exit(0)
