import PhotosUI
import SwiftUI

struct ConversationScreen: View {
    @Environment(AppModel.self) private var model
    @Environment(\.rallyColors) private var colors
    @Environment(\.accessibilityReduceMotion) private var reduceMotion

    var body: some View {
        @Bindable var model = model
        NavigationStack {
            ZStack {
                colors.canvas.ignoresSafeArea()
                VStack(spacing: 0) {
                    topBar
                    if model.messages.isEmpty {
                        EmptyGreeting(name: model.greetingName, opportunities: model.opportunities) { prompt in
                            model.composerText = prompt
                            Task { await model.send() }
                        }
                    } else {
                        MessageList(messages: model.messages, isConnecting: model.isConnectingConversation)
                    }
                    ComposerBar(
                        text: $model.composerText,
                        isStreaming: model.isStreaming,
                        attachments: model.pendingAttachments,
                        onSend: { Task { await model.send() } },
                        onStop: { Task { await model.stopGeneration() } },
                        onAttach: { data, name, mime in model.attach(data: data, fileName: name, mimeType: mime) },
                        onRemoveAttachment: { model.removeAttachment($0) },
                        onVoice: { model.isVoicePresented = true }
                    )
                }
            }
            .toolbar(.hidden, for: .navigationBar)
            .sheet(isPresented: $model.isHistoryPresented) {
                HistoryPanel()
                    .presentationDetents([.large])
                    .presentationDragIndicator(.visible)
            }
            .sheet(isPresented: $model.isSettingsPresented) {
                SettingsScreen()
            }
            .sheet(isPresented: $model.isVoicePresented) {
                VoiceBar { transcript in
                    model.composerText = transcript
                    model.isVoicePresented = false
                    Task { await model.send() }
                }
                .presentationDetents([.height(220)])
            }
        }
    }

    private var topBar: some View {
        HStack {
            Button {
                model.isHistoryPresented = true
            } label: {
                Image(systemName: "line.3.horizontal")
                    .font(.system(size: 20, weight: .regular))
                    .foregroundStyle(colors.textPrimary)
                    .frame(width: 44, height: 44)
                    .rallyGlass(in: Circle())
            }
            .accessibilityLabel("History")
            Spacer()
            WorkspacePill()
            Spacer()
            Button {
                model.openNewChat()
            } label: {
                Image(systemName: "square.and.pencil")
                    .font(.system(size: 20, weight: .regular))
                    .foregroundStyle(colors.textPrimary)
                    .frame(width: 44, height: 44)
                    .rallyGlass(in: Circle())
            }
            .accessibilityLabel("New chat")
        }
        .padding(.horizontal, 16)
        .frame(height: 44)
    }
}

struct WorkspacePill: View {
    @Environment(AppModel.self) private var model
    @Environment(\.rallyColors) private var colors

    var body: some View {
        Button {
            model.isSettingsPresented = true
        } label: {
            Text(model.workspaceSession?.workspace?.name ?? "Rally")
                .font(RallyType.pill())
                .foregroundStyle(colors.sendGlyphEnabled)
                .padding(.vertical, 7)
                .padding(.horizontal, 14)
                .background(Capsule().fill(colors.sendFillEnabled))
        }
        .buttonStyle(RallyPressableStyle(scale: 0.96))
        .accessibilityLabel("Workspace and settings")
        .sensoryFeedback(.selection, trigger: model.isSettingsPresented)
    }
}

struct EmptyGreeting: View {
    var name: String
    var opportunities: [RallyOpportunity]
    var onPrompt: (String) -> Void
    @Environment(\.rallyColors) private var colors

    private var greeting: String {
        let hour = Calendar.current.component(.hour, from: Date())
        let hello: String
        if hour < 12 { hello = "Good morning" }
        else if hour < 18 { hello = "Good afternoon" }
        else { hello = "Good evening" }
        return "\(hello), \(name)"
    }

    var body: some View {
        ScrollView {
            VStack(alignment: .leading, spacing: 20) {
                Spacer().frame(height: 48)
                Text(greeting)
                    .font(RallyType.screenTitle())
                    .foregroundStyle(colors.textPrimary)
                    .frame(maxWidth: .infinity, alignment: .center)
                    .accessibilityAddTraits(.isHeader)
                Text("Ask Rally anything")
                    .font(RallyType.body())
                    .foregroundStyle(colors.textSecondary)
                    .frame(maxWidth: .infinity, alignment: .center)
                let chips = opportunities.map(\.displayPrompt) + [
                    "Catch me up on what’s moving",
                    "Draft an update for the team",
                    "What’s blocking us?",
                ]
                FlexibleChips(items: Array(chips.prefix(6)), onTap: onPrompt)
                    .padding(.top, 8)
            }
            .padding(.horizontal, 20)
            .frame(maxWidth: .infinity)
        }
        .scrollDismissesKeyboard(.interactively)
    }
}

struct FlexibleChips: View {
    var items: [String]
    var onTap: (String) -> Void
    @Environment(\.rallyColors) private var colors

    var body: some View {
        VStack(alignment: .leading, spacing: 8) {
            ForEach(items, id: \.self) { item in
                Button {
                    onTap(item)
                } label: {
                    Text(item)
                        .font(RallyType.bodySmall())
                        .foregroundStyle(colors.textPrimary)
                        .padding(.vertical, 10)
                        .padding(.horizontal, 14)
                        .background(
                            RoundedRectangle(cornerRadius: 14, style: .continuous)
                                .fill(colors.surface1)
                        )
                        .overlay(
                            RoundedRectangle(cornerRadius: 14, style: .continuous)
                                .strokeBorder(colors.divider, lineWidth: 1)
                        )
                }
                .buttonStyle(RallyPressableStyle())
            }
        }
        .frame(maxWidth: .infinity, alignment: .center)
    }
}

struct MessageList: View {
    var messages: [RallyChatMessage]
    var isConnecting: Bool
    @Environment(\.rallyColors) private var colors

    var body: some View {
        ScrollViewReader { proxy in
            ScrollView {
                LazyVStack(alignment: .leading, spacing: 20) {
                    if isConnecting {
                        ProgressView()
                            .tint(colors.textSecondary)
                            .frame(maxWidth: .infinity)
                            .padding(.top, 24)
                            .accessibilityLabel("Loading conversation")
                    }
                    ForEach(messages) { message in
                        MessageRow(message: message)
                            .id(message.id)
                    }
                }
                .padding(.horizontal, 16)
                .padding(.vertical, 12)
            }
            .scrollDismissesKeyboard(.interactively)
            .onChange(of: messages.last?.text) { _, _ in
                if let id = messages.last?.id {
                    withAnimation(.easeOut(duration: 0.2)) {
                        proxy.scrollTo(id, anchor: .bottom)
                    }
                }
            }
        }
    }
}

struct MessageRow: View {
    var message: RallyChatMessage
    @Environment(\.rallyColors) private var colors
    @Environment(\.accessibilityReduceMotion) private var reduceMotion
    @State private var cursorOn = true

    var body: some View {
        Group {
            if message.role == .user {
                UserBubble(text: message.text)
            } else {
                AssistantResponse(text: message.text, isStreaming: message.isStreaming && !reduceMotion, cursorOn: cursorOn)
            }
        }
        .onAppear { startCursor() }
    }

    private func startCursor() {
        guard message.isStreaming, !reduceMotion else { return }
        Task {
            while !Task.isCancelled && message.isStreaming {
                try? await Task.sleep(for: .seconds(RallyMotion.cursorBlink))
                cursorOn.toggle()
            }
        }
    }
}

struct UserBubble: View {
    var text: String
    @Environment(\.rallyColors) private var colors

    var body: some View {
        HStack {
            Spacer(minLength: 48)
            Text(text)
                .font(RallyType.body())
                .foregroundStyle(colors.textPrimary)
                .padding(.vertical, 12)
                .padding(.horizontal, 16)
                .background(
                    UnevenRoundedRectangle(
                        cornerRadii: .init(topLeading: 20, bottomLeading: 20, bottomTrailing: 6, topTrailing: 20)
                    )
                    .fill(colors.surface1)
                )
                .textSelection(.enabled)
        }
        .accessibilityElement(children: .combine)
        .accessibilityLabel("You, \(text)")
    }
}

struct AssistantResponse: View {
    var text: String
    var isStreaming: Bool
    var cursorOn: Bool
    @Environment(\.rallyColors) private var colors

    var body: some View {
        VStack(alignment: .leading, spacing: 12) {
            RallyMark()
                .stroke(colors.textPrimary, lineWidth: 1.4)
                .frame(width: 24, height: 24)
                .accessibilityHidden(true)
            (Text(text) + (isStreaming ? Text("▍").foregroundStyle(cursorOn ? colors.textPrimary : .clear) : Text("")))
                .font(RallyType.body())
                .foregroundStyle(colors.textPrimary)
                .lineSpacing(6)
                .textSelection(.enabled)
                .fixedSize(horizontal: false, vertical: true)
            if !isStreaming, !text.isEmpty {
                MessageActions(text: text)
            }
        }
        .frame(maxWidth: .infinity, alignment: .leading)
        .accessibilityLabel(isStreaming ? "Rally is writing. \(text)" : "Rally, \(text)")
    }
}

struct MessageActions: View {
    var text: String
    @Environment(\.rallyColors) private var colors
    @State private var copied = false

    var body: some View {
        HStack(spacing: 20) {
            Button {
                UIPasteboard.general.string = text
                copied = true
            } label: {
                Image(systemName: copied ? "checkmark" : "doc.on.doc")
                    .font(.system(size: 18))
                    .foregroundStyle(copied ? RallyPalette.success : colors.textSecondary)
            }
            .accessibilityLabel(copied ? "Copied" : "Copy")
            .sensoryFeedback(.success, trigger: copied)
            ShareLink(item: text) {
                Image(systemName: "square.and.arrow.up")
                    .font(.system(size: 18))
                    .foregroundStyle(colors.textSecondary)
            }
            .accessibilityLabel("Share")
            Spacer()
        }
        .padding(.top, 4)
    }
}
