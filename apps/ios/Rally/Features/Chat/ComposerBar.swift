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

    @Environment(\.rallyColors) private var colors
    @FocusState private var focused: Bool
    @State private var photoItem: PhotosPickerItem?

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
                            .background(colors.surface2, in: Capsule())
                        }
                    }
                    .padding(.horizontal, 16)
                }
            }
            HStack(alignment: .bottom, spacing: 8) {
                PhotosPicker(selection: $photoItem, matching: .images, photoLibrary: .shared()) {
                    Image(systemName: "paperclip")
                        .font(.system(size: 18))
                        .foregroundStyle(colors.textSecondary)
                        .frame(width: 32, height: 32)
                }
                .accessibilityLabel("Attach a photo")
                TextField("Ask Rally anything", text: $text, axis: .vertical)
                    .font(RallyType.prompt())
                    .foregroundStyle(colors.textPrimary)
                    .tint(colors.textPrimary)
                    .lineLimit(1...5)
                    .focused($focused)
                    .submitLabel(.send)
                    .onSubmit { if sendEnabled && !isStreaming { onSend() } }
                    .accessibilityLabel("Message")
                Button(action: onVoice) {
                    Image(systemName: "waveform")
                        .font(.system(size: 16, weight: .semibold))
                        .foregroundStyle(colors.textSecondary)
                        .frame(width: 32, height: 32)
                }
                .accessibilityLabel("Speak a message")
                SendButton(isStreaming: isStreaming, enabled: sendEnabled, onSend: onSend, onStop: onStop)
            }
            .padding(.horizontal, 12)
            .padding(.vertical, 8)
            .background(RoundedRectangle(cornerRadius: 24, style: .continuous).fill(colors.surface1))
            .overlay(
                RoundedRectangle(cornerRadius: 24, style: .continuous)
                    .strokeBorder(focused ? RallyPalette.focusBorder : colors.divider, lineWidth: 1)
            )
            .rallyGlass(in: RoundedRectangle(cornerRadius: 24, style: .continuous))
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
                        .foregroundStyle(colors.textPrimary)
                } else {
                    Image(systemName: "arrow.up")
                        .foregroundStyle(enabled ? colors.sendGlyphEnabled : colors.textSecondary)
                }
            }
            .font(.system(size: 16, weight: .semibold))
            .frame(width: 32, height: 32)
            .background(Circle().fill(fill))
            .contentTransition(.symbolEffect(.replace))
        }
        .buttonStyle(RallyPressableStyle(scale: 0.92))
        .disabled(!isStreaming && !enabled)
        .accessibilityLabel(isStreaming ? "Stop generating" : "Send message")
        .sensoryFeedback(.impact(flexibility: .soft), trigger: isStreaming)
    }

    private var fill: Color {
        if isStreaming { return colors.surface3 }
        return enabled ? colors.sendFillEnabled : colors.surface3
    }
}
