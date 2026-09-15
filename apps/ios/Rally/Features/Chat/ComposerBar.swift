import PhotosUI
import SwiftUI
import UniformTypeIdentifiers

struct ComposerBar: View {
    @Binding var text: String
    var isStreaming: Bool
    var attachments: [AppModel.PendingAttachment]
    var onSend: () -> Void
    var onStop: () -> Void
    var onAttach: (Data, String, String) -> Void
    var onRemoveAttachment: (String) -> Void
    var onVoice: () -> Void
    var placeholder: String = "Ask Rally anything"
    var isDisabled: Bool = false

    @Environment(\.rallyColors) private var colors
    @FocusState private var focused: Bool
    @State private var photoItem: PhotosPickerItem?
    @State private var pickingFile = false

    private var sendEnabled: Bool {
        !text.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty || !attachments.isEmpty
    }

    var body: some View {
        VStack(spacing: 8) {
            if !attachments.isEmpty {
                ScrollView(.horizontal, showsIndicators: false) {
                    HStack {
                        ForEach(attachments) { item in
                            HStack(spacing: 6) {
                                Image(systemName: "paperclip")
                                Text(item.fileName)
                                    .lineLimit(1)
                                Button {
                                    onRemoveAttachment(item.id)
                                } label: {
                                    Image(systemName: "xmark.circle.fill")
                                }
                                .accessibilityLabel("Remove \(item.fileName)")
                            }
                            .font(RallyType.caption())
                            .foregroundStyle(colors.textPrimary)
                            .padding(.horizontal, 10)
                            .padding(.vertical, 6)
                            .rallyGlass(in: Capsule())
                        }
                    }
                    .padding(.horizontal, 16)
                }
            }
            GlassEffectContainer(spacing: 10) {
                HStack(alignment: .bottom, spacing: 10) {
                    HStack(alignment: .bottom, spacing: 8) {
                        PhotosPicker(selection: $photoItem, matching: .images, photoLibrary: .shared()) {
                            Image(systemName: "paperclip")
                                .font(.system(size: 18, weight: .semibold))
                                .foregroundStyle(colors.textSecondary)
                                .frame(width: 32, height: 32)
                        }
                        .disabled(isDisabled)
                        .accessibilityLabel("Attach a photo")
                        .contextMenu {
                            Button("Choose file") { pickingFile = true }
                        }
                        TextField(placeholder, text: $text, axis: .vertical)
                            .font(RallyType.prompt())
                            .foregroundStyle(colors.textPrimary)
                            .tint(colors.textPrimary)
                            .lineLimit(1...5)
                            .focused($focused)
                            .disabled(isDisabled)
                            .submitLabel(.send)
                            .onSubmit { if sendEnabled && !isStreaming && !isDisabled { onSend() } }
                            .accessibilityLabel("Message")
                        Button(action: onVoice) {
                            Image(systemName: "waveform")
                                .font(.system(size: 16, weight: .semibold))
                                .foregroundStyle(colors.textSecondary)
                                .frame(width: 32, height: 32)
                        }
                        .accessibilityLabel("Speak a message")
                    }
                    .padding(.horizontal, 12)
                    .padding(.vertical, 8)
                    .glassEffect(.regular.interactive(), in: RoundedRectangle(cornerRadius: 24, style: .continuous))

                    SendButton(isStreaming: isStreaming, enabled: sendEnabled && !isDisabled, onSend: onSend, onStop: onStop)
                }
            }
            .padding(.horizontal, 16)
            .padding(.bottom, 8)
        }
        .onChange(of: photoItem) { _, item in
            guard let item else { return }
            Task {
                if let data = try? await item.loadTransferable(type: Data.self) {
                    onAttach(data, "photo.jpg", "image/jpeg")
                }
                photoItem = nil
            }
        }
        .fileImporter(isPresented: $pickingFile, allowedContentTypes: [.item], allowsMultipleSelection: false) { result in
            guard case .success(let urls) = result, let url = urls.first else { return }
            let accessed = url.startAccessingSecurityScopedResource()
            defer { if accessed { url.stopAccessingSecurityScopedResource() } }
            guard let data = try? Data(contentsOf: url) else { return }
            onAttach(data, url.lastPathComponent, "application/octet-stream")
        }
    }
}

struct SendButton: View {
    var isStreaming: Bool
    var enabled: Bool
    var onSend: () -> Void
    var onStop: () -> Void
    @Environment(\.rallyColors) private var colors

    var body: some View {
        Button {
            isStreaming ? onStop() : onSend()
        } label: {
            Group {
                if isStreaming {
                    Image(systemName: "stop.fill")
                } else {
                    Image(systemName: "arrow.up")
                }
            }
            .font(.system(size: 16, weight: .semibold))
            .frame(width: 32, height: 32)
            .contentTransition(.symbolEffect(.replace))
        }
        .buttonStyle(.glassProminent)
        .disabled(!isStreaming && !enabled)
        .accessibilityLabel(isStreaming ? "Stop generating" : "Send message")
        .sensoryFeedback(.impact(flexibility: .soft), trigger: isStreaming)
    }
}
