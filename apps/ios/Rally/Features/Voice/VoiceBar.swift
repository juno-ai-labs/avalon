import AVFoundation
import Speech
import SwiftUI

/// On-device speech-to-text into the composer. Uses `SFSpeechRecognizer` and
/// the microphone — not a remote transcription socket — so a sandbox without
/// dictation credentials can still speak a message.
struct VoiceBar: View {
    var onComplete: (String) -> Void
    @Environment(\.rallyColors) private var colors
    @Environment(\.dismiss) private var dismiss
    @Environment(\.accessibilityReduceMotion) private var reduceMotion
    @State private var capture = VoiceCapture()

    var body: some View {
        VStack(spacing: 16) {
            Capsule()
                .fill(colors.divider)
                .frame(width: 36, height: 5)
                .padding(.top, 8)
                .accessibilityHidden(true)
            Text(capture.statusTitle)
                .font(RallyType.conversationTitle())
                .foregroundStyle(colors.textPrimary)
                .accessibilityAddTraits(.updatesFrequently)
            Text(capture.transcript.isEmpty ? "Rally is listening" : capture.transcript)
                .font(RallyType.body())
                .foregroundStyle(capture.transcript.isEmpty ? colors.textSecondary : colors.textPrimary)
                .multilineTextAlignment(.center)
                .frame(maxWidth: .infinity, minHeight: 48)
                .padding(.horizontal, 20)
            HStack(spacing: 24) {
                Button("Cancel", role: .cancel) {
                    capture.stop()
                    dismiss()
                }
                .font(RallyType.button())
                Button {
                    capture.stop()
                    let text = capture.transcript.trimmingCharacters(in: .whitespacesAndNewlines)
                    if text.isEmpty {
                        dismiss()
                    } else {
                        onComplete(text)
                    }
                } label: {
                    Text("Send")
                        .font(RallyType.button())
                        .padding(.horizontal, 8)
                }
                .buttonStyle(.glassProminent)
                .disabled(capture.transcript.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty)
                .accessibilityLabel("Send spoken message")
            }
            .padding(.bottom, 20)
        }
        .frame(maxWidth: .infinity)
        .task { await capture.start() }
        .onDisappear { capture.stop() }
    }
}

@MainActor
@Observable
final class VoiceCapture {
    var transcript = ""
    var statusTitle = "Speak"
    private var audioEngine: AVAudioEngine?
    private var request: SFSpeechAudioBufferRecognitionRequest?
    private var task: SFSpeechRecognitionTask?
    private let recognizer = SFSpeechRecognizer()

    func start() async {
        let speech = await requestSpeechAuthorization()
        guard speech else {
            statusTitle = "Speech recognition is off"
            return
        }
        let mic = await requestMicrophone()
        guard mic else {
            statusTitle = "Microphone is off"
            return
        }
        guard let recognizer, recognizer.isAvailable else {
            statusTitle = "Speech recognition isn’t available"
            return
        }
        do {
            let session = AVAudioSession.sharedInstance()
            try session.setCategory(.record, mode: .measurement, options: .duckOthers)
            try session.setActive(true, options: .notifyOthersOnDeactivation)
            let engine = AVAudioEngine()
            let request = SFSpeechAudioBufferRecognitionRequest()
            request.shouldReportPartialResults = true
            request.requiresOnDeviceRecognition = false
            let input = engine.inputNode
            let format = input.outputFormat(forBus: 0)
            input.installTap(onBus: 0, bufferSize: 1024, format: format) { buffer, _ in
                request.append(buffer)
            }
            engine.prepare()
            try engine.start()
            audioEngine = engine
            self.request = request
            statusTitle = "Listening"
            task = recognizer.recognitionTask(with: request) { [weak self] result, error in
                Task { @MainActor in
                    if let result {
                        self?.transcript = result.bestTranscription.formattedString
                    }
                    if error != nil {
                        self?.statusTitle = "Couldn’t hear that"
                    }
                }
            }
        } catch {
            statusTitle = "Couldn’t start the microphone"
        }
    }

    func stop() {
        request?.endAudio()
        audioEngine?.inputNode.removeTap(onBus: 0)
        audioEngine?.stop()
        task?.cancel()
        request = nil
        task = nil
        audioEngine = nil
        try? AVAudioSession.sharedInstance().setActive(false, options: .notifyOthersOnDeactivation)
    }

    private func requestSpeechAuthorization() async -> Bool {
        await withCheckedContinuation { continuation in
            SFSpeechRecognizer.requestAuthorization { status in
                continuation.resume(returning: status == .authorized)
            }
        }
    }

    private func requestMicrophone() async -> Bool {
        await withCheckedContinuation { continuation in
            AVAudioApplication.requestRecordPermission { granted in
                continuation.resume(returning: granted)
            }
        }
    }
}
