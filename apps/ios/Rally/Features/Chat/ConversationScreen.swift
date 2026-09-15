import PhotosUI
import SwiftUI

struct ConversationScreen: View {
    @Environment(AppModel.self) private var model
    @Environment(\.rallyColors) private var colors

    var body: some View {
        @Bindable var model = model
        NavigationStack(path: $model.chatPath) {
            WorkstreamListScreen()
                .navigationDestination(for: AppModel.ChatRoute.self) { route in
                    switch route {
                    case .substreams:
                        SubstreamListScreen()
                    case .conversation, .compose:
                        ConversationFeedScreen()
                    }
                }
        }
        .onChange(of: model.chatPath) { oldPath, newPath in
            model.chatPathDidChange(from: oldPath, to: newPath)
        }
        .sheet(isPresented: $model.isSettingsPresented) {
            SettingsScreen()
        }
        .sheet(isPresented: $model.isVoicePresented) {
            VoiceBar { transcript in
                model.composerText = transcript
                model.isVoicePresented = false
                Task {
                    if model.substreamLaunch != nil {
                        await model.submitSubstreamLaunch()
                    } else {
                        await model.send()
                    }
                }
            }
            .presentationDetents([.height(220)])
        }
        .sheet(isPresented: $model.isSearchPresented) {
            SearchSheet()
        }
        .inspector(isPresented: $model.isInspectorPresented) {
            InspectorSheet()
        }
    }
}

struct ConversationFeedScreen: View {
    @Environment(AppModel.self) private var model
    @Environment(\.rallyColors) private var colors

    var body: some View {
        @Bindable var model = model
        ZStack {
            colors.canvas.ignoresSafeArea()
            VStack(spacing: 0) {
                switch RallyFeedChrome.resolve(
                    isLaunch: model.substreamLaunch != nil,
                    isConnecting: model.isConnectingConversation,
                    hasMessages: !model.messages.isEmpty
                ) {
                case .launch:
                    SubstreamLaunchView()
                case .skeleton:
                    ConversationSkeleton()
                case .emptyGreeting:
                    EmptyGreeting(name: model.greetingName, opportunities: model.opportunities) { prompt in
                        model.composerText = prompt
                        Task { await model.send() }
                    }
                case .messages:
                    MessageList(
                        messages: model.messages,
                        isConnecting: model.isConnectingConversation,
                        firstUnreadSequence: model.firstUnreadSequence,
                        hasOlder: model.hasOlderTranscript,
                        jumpToken: model.jumpToLatestToken
                    )
                    .id("\(model.currentWorkstream?.id ?? "")/\(model.currentSubstreamId)")
                }
                if model.substreamLaunch == nil, model.messages.contains(where: { $0.statusKind == "assistant_turn_failed" }) {
                    Button("Retry", systemImage: "arrow.clockwise") { Task { await model.retryHarness() } }
                        .buttonStyle(.glass)
                        .padding(.bottom, 4)
                }
            }
        }
        .navigationTitle(model.substreamLaunch != nil ? "New substream" : (model.currentWorkstream == nil ? "New chat" : model.conversationTitle))
        .navigationBarTitleDisplayMode(.inline)
        .toolbar(.hidden, for: .tabBar)
        .toolbar {
            ToolbarItem(placement: .topBarTrailing) {
                Button("Details", systemImage: "info.circle") {
                    model.isInspectorPresented = true
                }
                .disabled(model.currentWorkstream == nil)
                .accessibilityLabel("Details")
            }
        }
        .safeAreaBar(edge: .bottom) {
            if model.substreamLaunch == nil {
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
        .overlay(alignment: .bottomTrailing) {
            if model.substreamLaunch == nil, !model.isConnectingConversation, model.messages.count > 6 {
                Button {
                    model.jumpToLatest()
                } label: {
                    Image(systemName: "arrow.down")
                        .font(.body.weight(.semibold))
                        .frame(width: 44, height: 44)
                }
                .buttonStyle(.glass)
                .accessibilityLabel("Jump to latest")
                .padding(.trailing, 20)
                .padding(.bottom, 12)
            }
        }
    }
}

struct ConversationSkeleton: View {
    @Environment(\.rallyColors) private var colors

    var body: some View {
        VStack(alignment: .leading, spacing: 20) {
            HStack {
                Spacer(minLength: 48)
                pill(height: 44, trailing: true)
                    .frame(maxWidth: 200)
            }
            VStack(alignment: .leading, spacing: 10) {
                pill(height: 14, trailing: false)
                pill(height: 14, trailing: false)
                    .padding(.trailing, 48)
                pill(height: 14, trailing: false)
                    .padding(.trailing, 120)
            }
            HStack {
                Spacer(minLength: 48)
                pill(height: 44, trailing: true)
                    .frame(maxWidth: 160)
            }
            VStack(alignment: .leading, spacing: 10) {
                pill(height: 14, trailing: false)
                    .padding(.trailing, 32)
                pill(height: 14, trailing: false)
                    .padding(.trailing, 80)
            }
            Spacer()
        }
        .padding(.horizontal, 16)
        .padding(.vertical, 12)
        .redacted(reason: .placeholder)
        .accessibilityElement(children: .ignore)
        .accessibilityLabel("Loading conversation")
    }

    private func pill(height: CGFloat, trailing: Bool) -> some View {
        UnevenRoundedRectangle(
            cornerRadii: trailing
                ? .init(topLeading: 20, bottomLeading: 20, bottomTrailing: 6, topTrailing: 20)
                : .init(topLeading: 6, bottomLeading: 6, bottomTrailing: 6, topTrailing: 6)
        )
        .fill(colors.surface1)
        .frame(maxWidth: .infinity)
        .frame(height: height)
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
                        .glassEffect(.regular.interactive(), in: RoundedRectangle(cornerRadius: 14, style: .continuous))
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
    var firstUnreadSequence: Int?
    var hasOlder: Bool
    var jumpToken: Int
    @Environment(AppModel.self) private var model
    @Environment(\.rallyColors) private var colors
    @State private var edge = RallyScrollEdge(
        offsetY: 0, containerHeight: 0, contentHeight: 0, topInset: 0, bottomInset: 0
    )
    @State private var settledAtBottom = false

    var body: some View {
        ScrollViewReader { proxy in
            ScrollView {
                LazyVStack(alignment: .leading, spacing: 20) {
                    if model.isLoadingOlder {
                        ProgressView()
                            .tint(colors.textSecondary)
                            .frame(maxWidth: .infinity)
                            .padding(.top, 8)
                            .accessibilityLabel("Loading earlier messages")
                    }
                    ForEach(Array(messages.enumerated()), id: \.element.id) { _, message in
                        if let unread = firstUnreadSequence, message.sequence == unread {
                            UnreadDivider()
                        }
                        MessageRow(message: message)
                            .id(message.id)
                    }
                }
                .padding(.horizontal, 16)
                .padding(.vertical, 12)
            }
            .defaultScrollAnchor(.bottom)
            .scrollDismissesKeyboard(.interactively)
            .onScrollGeometryChange(for: RallyScrollEdge.self) { geometry in
                RallyScrollEdge(
                    offsetY: geometry.contentOffset.y,
                    containerHeight: geometry.containerSize.height,
                    contentHeight: geometry.contentSize.height,
                    topInset: geometry.contentInsets.top,
                    bottomInset: geometry.contentInsets.bottom
                )
            } action: { _, newEdge in
                edge = newEdge
                if !settledAtBottom {
                    if newEdge.nearBottom { settledAtBottom = true }
                    return
                }
                requestOlderIfNeeded()
            }
            .onChange(of: model.isLoadingOlder) { _, loading in
                if !loading { requestOlderIfNeeded() }
            }
            .onChange(of: messages.last?.id, initial: true) { _, _ in
                if edge.nearBottom || !settledAtBottom {
                    scrollToLatest(proxy)
                }
            }
            .onChange(of: messages.last?.text) { _, _ in
                guard edge.nearBottom else { return }
                scrollToLatest(proxy)
            }
            .onChange(of: jumpToken) { _, _ in
                scrollToLatest(proxy)
            }
        }
    }

    private func requestOlderIfNeeded() {
        guard settledAtBottom, edge.atTop, hasOlder, !model.isLoadingOlder, !isConnecting else { return }
        Task { await model.loadOlder() }
    }

    private func scrollToLatest(_ proxy: ScrollViewProxy) {
        if let id = messages.last?.id {
            withAnimation(.easeOut(duration: 0.2)) {
                proxy.scrollTo(id, anchor: .bottom)
            }
        }
    }
}

struct UnreadDivider: View {
    @Environment(\.rallyColors) private var colors

    var body: some View {
        HStack {
            Rectangle().fill(RallyPalette.linkBlue).frame(height: 1)
            Text("Unread")
                .font(RallyType.caption())
                .foregroundStyle(RallyPalette.linkBlue)
            Rectangle().fill(RallyPalette.linkBlue).frame(height: 1)
        }
        .accessibilityLabel("Unread messages below")
    }
}

struct MessageRow: View {
    var message: RallyChatMessage
    @Environment(\.rallyColors) private var colors
    @Environment(\.accessibilityReduceMotion) private var reduceMotion
    @State private var cursorOn = true

    var body: some View {
        Group {
            switch message.kind {
            case .text:
                if message.role == .user {
                    UserBubble(message: message)
                } else {
                    AssistantResponse(message: message, cursorOn: cursorOn && !reduceMotion)
                }
            case .thought:
                MachineryRow(icon: "ellipsis.bubble", title: message.isStreaming ? "Thinking" : "Thought", detail: message.text)
            case .toolEvent:
                MachineryRow(icon: "wrench", title: message.toolName ?? "Tool", detail: message.toolStatus ?? message.text)
            case .pluginActivity:
                MachineryRow(icon: "puzzlepiece.extension", title: message.pluginName ?? "Plugin", detail: message.isStreaming ? "Working" : "Worked")
            case .workAccordion:
                WorkAccordion(message: message)
            case .elicitation:
                ElicitationCard(message: message)
            case .system:
                SystemNotice(message: message)
            case .automationActivation:
                AssistantResponse(message: message, cursorOn: false, authorOverride: message.authorName ?? "Sidekick")
            case .omitted:
                OmittedPlaceholder(text: message.text)
            }
        }
        .task(id: message.isStreaming) { await runCursor() }
    }

    private func runCursor() async {
        guard message.isStreaming, !reduceMotion else { return }
        while !Task.isCancelled {
            try? await Task.sleep(for: .seconds(RallyMotion.cursorBlink))
            cursorOn.toggle()
        }
    }
}

struct UserBubble: View {
    var message: RallyChatMessage
    @Environment(\.rallyColors) private var colors

    var body: some View {
        VStack(alignment: .trailing, spacing: 6) {
            if let name = message.authorName, message.role == .external {
                Text(name)
                    .font(RallyType.caption())
                    .foregroundStyle(colors.textSecondary)
            }
            HStack {
                Spacer(minLength: 48)
                VStack(alignment: .trailing, spacing: 8) {
                    if !message.text.isEmpty {
                        Text(message.text)
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
                    if !message.attachments.isEmpty {
                        AttachmentChips(attachments: message.attachments)
                    }
                    if let delivery = message.deliveryState {
                        Text(delivery.replacingOccurrences(of: "_", with: " "))
                            .font(RallyType.caption())
                            .foregroundStyle(colors.textSecondary)
                        if delivery == "failed" {
                            Button("Retry") { Task { await model.retryFailedSend(message) } }
                                .font(RallyType.caption())
                        }
                    }
                    if !message.isStreaming {
                        MessageActions(message: message)
                    }
                }
            }
        }
        .accessibilityLabel("You, \(message.text)")
    }
}

struct AssistantResponse: View {
    var message: RallyChatMessage
    var cursorOn: Bool
    var authorOverride: String? = nil
    @Environment(\.rallyColors) private var colors

    var body: some View {
        VStack(alignment: .leading, spacing: 12) {
            RallyMark()
                .frame(width: 24, height: 24)
                .accessibilityHidden(true)
            if let authorOverride {
                Text(authorOverride)
                    .font(RallyType.caption())
                    .foregroundStyle(colors.textSecondary)
            }
            (Text(message.text) + (message.isStreaming ? Text("▍").foregroundStyle(cursorOn ? colors.textPrimary : .clear) : Text("")))
                .font(RallyType.body())
                .foregroundStyle(colors.textPrimary)
                .lineSpacing(6)
                .textSelection(.enabled)
                .fixedSize(horizontal: false, vertical: true)
            if !message.attachments.isEmpty {
                AttachmentChips(attachments: message.attachments)
            }
            if !message.isStreaming, !message.text.isEmpty {
                MessageActions(message: message)
            }
        }
        .frame(maxWidth: .infinity, alignment: .leading)
        .accessibilityLabel(message.isStreaming ? "Rally is writing. \(message.text)" : "Rally, \(message.text)")
    }
}

struct MachineryRow: View {
    var icon: String
    var title: String
    var detail: String
    @Environment(\.rallyColors) private var colors

    var body: some View {
        HStack(alignment: .top, spacing: 10) {
            Image(systemName: icon)
                .foregroundStyle(colors.textSecondary)
                .frame(width: 20)
            VStack(alignment: .leading, spacing: 2) {
                Text(title)
                    .font(RallyType.bodySmall())
                    .foregroundStyle(colors.textPrimary)
                if !detail.isEmpty, detail != title {
                    Text(detail)
                        .font(RallyType.caption())
                        .foregroundStyle(colors.textSecondary)
                }
            }
        }
        .padding(10)
        .frame(maxWidth: .infinity, alignment: .leading)
        .background(RoundedRectangle(cornerRadius: 12, style: .continuous).fill(colors.surface1))
        .accessibilityLabel("\(title). \(detail)")
    }
}

struct WorkAccordion: View {
    var message: RallyChatMessage
    @Environment(\.rallyColors) private var colors

    var body: some View {
        DisclosureGroup {
            VStack(alignment: .leading, spacing: 8) {
                ForEach(message.nested) { row in
                    MessageRow(message: row)
                }
            }
            .padding(.top, 8)
        } label: {
            Label("Worked", systemImage: "chevron.right.circle")
                .font(RallyType.bodySmall())
                .foregroundStyle(colors.textSecondary)
        }
        .tint(colors.textSecondary)
        .accessibilityLabel("Worked, \(message.nested.count) steps")
    }
}

struct ElicitationCard: View {
    var message: RallyChatMessage
    @Environment(AppModel.self) private var model
    @Environment(\.rallyColors) private var colors
    @State private var textAnswer = ""
    @State private var selected: Set<String> = []

    var body: some View {
        VStack(alignment: .leading, spacing: 12) {
            Text(message.elicitation?.prompt ?? message.text)
                .font(RallyType.body())
                .foregroundStyle(colors.textPrimary)
            let elicitation = message.elicitation
            let closed = elicitation?.status != "open"
            let isMulti = elicitation?.responseType == "multi_select"
            if let elicitation, elicitation.responseType == "text" || elicitation.responseType == "free_text" || elicitation.responseType.isEmpty {
                TextField("Your answer", text: $textAnswer, axis: .vertical)
                    .disabled(closed)
                    .padding(10)
                    .background(colors.surface2, in: RoundedRectangle(cornerRadius: 10))
            } else if let elicitation {
                ForEach(elicitation.options) { option in
                    let value = option.value ?? option.label ?? option.id
                    Button {
                        if isMulti {
                            if selected.contains(value) { selected.remove(value) } else { selected.insert(value) }
                        } else {
                            selected = [value]
                        }
                    } label: {
                        HStack {
                            Image(systemName: selected.contains(value) ? "checkmark.circle.fill" : "circle")
                            Text(option.label ?? value)
                            Spacer()
                        }
                        .foregroundStyle(colors.textPrimary)
                    }
                    .disabled(closed)
                }
            }
            if !closed {
                HStack {
                    Button("Skip") {
                        Task { await model.answerElicitation(message.elicitation ?? RallyElicitation(id: message.id, prompt: message.text, responseType: "text", options: [], status: "open", answer: nil), answer: nil, skipped: true) }
                    }
                    Spacer()
                    Button("Submit") {
                        let answer: RallyElicitation.RallyElicitationAnswer?
                        if message.elicitation?.responseType == "text"
                            || message.elicitation?.responseType == "free_text"
                            || message.elicitation?.responseType.isEmpty == true {
                            answer = .text(textAnswer)
                        } else if isMulti {
                            answer = .list(selected.sorted())
                        } else {
                            answer = .text(selected.sorted().first ?? "")
                        }
                        Task { await model.answerElicitation(message.elicitation ?? RallyElicitation(id: message.id, prompt: message.text, responseType: "text", options: [], status: "open", answer: nil), answer: answer, skipped: false) }
                    }
                    .disabled(
                        (message.elicitation?.responseType == "text"
                            || message.elicitation?.responseType == "free_text"
                            || message.elicitation?.responseType.isEmpty == true)
                            ? textAnswer.isEmpty
                            : selected.isEmpty
                    )
                }
                .font(RallyType.button())
            }
        }
        .padding(14)
        .background(RoundedRectangle(cornerRadius: 16, style: .continuous).fill(colors.surface1))
        .overlay(RoundedRectangle(cornerRadius: 16, style: .continuous).strokeBorder(colors.divider))
        .accessibilityLabel("Rally needs input. \(message.text)")
    }
}

struct SystemNotice: View {
    var message: RallyChatMessage
    @Environment(AppModel.self) private var model
    @Environment(\.rallyColors) private var colors

    var body: some View {
        VStack(spacing: 8) {
            Text(message.text)
                .font(RallyType.caption())
                .foregroundStyle(colors.textSecondary)
                .multilineTextAlignment(.center)
                .frame(maxWidth: .infinity)
            if message.statusKind == "assistant_turn_failed" {
                Button("Retry") { Task { await model.retryHarness() } }
                    .font(RallyType.bodySmall())
            }
        }
        .padding(.vertical, 4)
        .accessibilityLabel(message.text)
    }
}

struct OmittedPlaceholder: View {
    var text: String
    @Environment(\.rallyColors) private var colors

    var body: some View {
        Text(text)
            .font(RallyType.bodySmall())
            .foregroundStyle(colors.textSecondary)
            .padding(12)
            .frame(maxWidth: .infinity)
            .background(
                RoundedRectangle(cornerRadius: 12, style: .continuous)
                    .strokeBorder(style: StrokeStyle(lineWidth: 1, dash: [5, 4]))
                    .foregroundStyle(colors.divider)
            )
            .accessibilityLabel(text)
    }
}

struct AttachmentChips: View {
    var attachments: [RallyAttachment]
    @Environment(\.rallyColors) private var colors

    var body: some View {
        VStack(alignment: .leading, spacing: 4) {
            ForEach(attachments) { item in
                Label(item.fileName, systemImage: "paperclip")
                    .font(RallyType.caption())
                    .foregroundStyle(colors.textSecondary)
            }
        }
    }
}

struct MessageActions: View {
    var message: RallyChatMessage
    @Environment(AppModel.self) private var model
    @Environment(\.rallyColors) private var colors
    @State private var copied = false

    private var canStartSubstream: Bool {
        model.canUseSubstreams
            && model.currentSubstreamId == SubstreamAddress.main
            && model.substreamLaunch == nil
            && !message.isStreaming
            && message.turnId != nil
    }

    var body: some View {
        HStack(spacing: 20) {
            Button {
                UIPasteboard.general.string = message.text
                copied = true
            } label: {
                Image(systemName: copied ? "checkmark" : "doc.on.doc")
                    .font(.system(size: 18))
                    .foregroundStyle(copied ? RallyPalette.success : colors.textSecondary)
            }
            .accessibilityLabel(copied ? "Copied" : "Copy")
            .sensoryFeedback(.success, trigger: copied)
            Button {
                model.speak(message)
            } label: {
                Image(systemName: model.speakingMessageId == message.id ? "speaker.wave.2.fill" : "speaker.wave.2")
                    .font(.system(size: 18))
                    .foregroundStyle(colors.textSecondary)
            }
            .accessibilityLabel(model.speakingMessageId == message.id ? "Stop speaking" : "Speak")
            ShareLink(item: message.text) {
                Image(systemName: "square.and.arrow.up")
                    .font(.system(size: 18))
                    .foregroundStyle(colors.textSecondary)
            }
            .accessibilityLabel("Share")
            if canStartSubstream {
                Button {
                    model.startSubstream(throughTurnId: message.turnId)
                } label: {
                    Image(systemName: "arrow.turn.down.right")
                        .font(.system(size: 18))
                        .foregroundStyle(colors.textSecondary)
                }
                .accessibilityLabel("New substream")
            }
            Spacer()
        }
        .padding(.top, 4)
    }
}
