import SwiftUI

/// Substream directory for one work stream. Pushed from the Chats list; picking
/// a row opens the feed. System navigation is the glass layer.
struct SubstreamListScreen: View {
    @Environment(AppModel.self) private var model
    @Environment(\.rallyColors) private var colors
    @State private var renaming: RenameTarget?
    @State private var renameTitle = ""
    @State private var archiveTarget: ArchiveTarget?

    private enum RenameTarget: Identifiable {
        case main
        case child(RallyPrivateChild)
        var id: String {
            switch self {
            case .main: SubstreamAddress.main
            case .child(let child): child.substreamId
            }
        }
    }

    private enum ArchiveTarget: Identifiable {
        case main
        case child(RallyPrivateChild)
        var id: String {
            switch self {
            case .main: SubstreamAddress.main
            case .child(let child): child.substreamId
            }
        }
    }

    var body: some View {
        List {
            row(
                title: model.currentWorkstream?.title ?? "Main",
                subtitle: "Main"
            ) {
                if let stream = model.currentWorkstream {
                    WorkstreamGlyph(id: stream.id, appearance: stream.appearance)
                } else {
                    Image(systemName: "smallcircle.filled.circle")
                        .font(.body.weight(.semibold))
                        .foregroundStyle(colors.textSecondary)
                        .frame(width: 48, height: 48)
                }
            } action: {
                model.selectSubstream(SubstreamAddress.main)
            }
            .accessibilityLabel("Main, \(model.currentWorkstream?.title ?? "Main")")
            .contextMenu { mainMenu }

            switch RallySubstreamListChrome.resolve(hasChildDirectory: model.hasChildDirectory) {
            case .awaitingChildren:
                HStack(spacing: 10) {
                    ProgressView()
                    Text("Loading substreams")
                        .font(RallyType.bodySmall())
                        .foregroundStyle(colors.textSecondary)
                }
                .listRowBackground(Color.clear)
                .listRowSeparator(.hidden)
                .accessibilityElement(children: .ignore)
                .accessibilityLabel("Loading substreams")
            case .directory:
                ForEach(model.displayedChildren) { child in
                    row(
                        title: child.title,
                        subtitle: nil
                    ) {
                        Image(systemName: "arrow.turn.down.right")
                            .font(.body.weight(.semibold))
                            .foregroundStyle(colors.textSecondary)
                            .frame(width: 48, height: 48)
                            .background(colors.surface1, in: Circle())
                    } action: {
                        model.selectSubstream(child.substreamId)
                    }
                    .contextMenu { childMenu(child) }
                    .onAppear {
                        if let id = model.currentWorkstream?.id {
                            model.appearDirectoryFeed(parentId: id, substreamId: child.substreamId, warmupSeconds: 0)
                        }
                    }
                    .onDisappear {
                        if let id = model.currentWorkstream?.id {
                            model.disappearDirectoryFeed(parentId: id, substreamId: child.substreamId)
                        }
                    }
                    .rallyInfiniteScroll(
                        isTerminal: child.id == model.displayedChildren.last?.id,
                        hasMore: false,
                        isLoading: false
                    ) {}
                }
            }

            Button {
                model.startSubstream(throughTurnId: nil)
            } label: {
                Label("New substream", systemImage: "plus")
                    .font(RallyType.conversationTitle())
                    .foregroundStyle(colors.textPrimary)
            }
            .listRowBackground(Color.clear)
            .listRowSeparator(.hidden)
            .accessibilityLabel("New substream")
        }
        .listStyle(.plain)
        .scrollContentBackground(.hidden)
        .background(colors.canvas.ignoresSafeArea())
        .navigationTitle(model.currentWorkstream?.title ?? "Conversations")
        .navigationBarTitleDisplayMode(.inline)
        .toolbar(.hidden, for: .tabBar)
        .alert("Rename", isPresented: Binding(
            get: { renaming != nil },
            set: { if !$0 { renaming = nil } }
        )) {
            TextField("Title", text: $renameTitle)
            Button("Save") {
                let target = renaming
                let title = renameTitle
                Task {
                    switch target {
                    case .main:
                        if let workstream = model.currentWorkstream {
                            await model.rename(workstream, title: title)
                        }
                    case .child(let child):
                        await model.renameChild(child, title: title)
                    case .none:
                        break
                    }
                }
                renaming = nil
            }
            Button("Cancel", role: .cancel) { renaming = nil }
        }
        .alert(archiveTitle, isPresented: Binding(
            get: { archiveTarget != nil },
            set: { if !$0 { archiveTarget = nil } }
        )) {
            Button("Archive", role: .destructive) {
                let target = archiveTarget
                Task {
                    switch target {
                    case .main:
                        if let workstream = model.currentWorkstream {
                            await model.archive(workstream)
                        }
                    case .child(let child):
                        await model.archiveChild(child)
                    case .none:
                        break
                    }
                }
                archiveTarget = nil
            }
            Button("Cancel", role: .cancel) { archiveTarget = nil }
        } message: {
            Text(archiveMessage)
        }
    }

    private var archiveTitle: String {
        if case .child = archiveTarget { return "Archive substream" }
        return "Archive work stream"
    }

    private var archiveMessage: String {
        if case .child = archiveTarget {
            return "This substream will leave the list. You can still open a link to it."
        }
        return "This work stream will leave History."
    }

    @ViewBuilder
    private var mainMenu: some View {
        if let workstream = model.currentWorkstream, workstream.systemKind == nil {
            Button {
                Task { await model.setScope(workstream, scope: "workspace") }
            } label: {
                Label("Make public to workspace", systemImage: "globe")
            }
            .disabled(workstream.scope == "workspace")
        }
        Button {
            renameTitle = model.currentWorkstream?.title ?? ""
            renaming = .main
        } label: {
            Label("Rename", systemImage: "pencil")
        }
        Button {
            model.copyConversationLink(substreamId: SubstreamAddress.main)
        } label: {
            Label("Copy work stream link", systemImage: "link")
        }
        Button(role: .destructive) {
            archiveTarget = .main
        } label: {
            Label("Archive work stream", systemImage: "archivebox")
        }
    }

    @ViewBuilder
    private func childMenu(_ child: RallyPrivateChild) -> some View {
        Button {
            renameTitle = child.title
            renaming = .child(child)
        } label: {
            Label("Rename", systemImage: "pencil")
        }
        Button {
            model.copyConversationLink(substreamId: child.substreamId)
        } label: {
            Label("Copy substream link", systemImage: "link")
        }
        Button(role: .destructive) {
            archiveTarget = .child(child)
        } label: {
            Label("Archive substream", systemImage: "archivebox")
        }
    }

    private func row<Leading: View>(
        title: String,
        subtitle: String?,
        @ViewBuilder leading: () -> Leading,
        action: @escaping () -> Void
    ) -> some View {
        Button(action: action) {
            HStack(spacing: 14) {
                leading()
                VStack(alignment: .leading, spacing: 2) {
                    Text(title)
                        .font(RallyType.conversationTitle())
                        .foregroundStyle(colors.textPrimary)
                    if let subtitle, subtitle != title {
                        Text(subtitle)
                            .font(RallyType.caption())
                            .foregroundStyle(colors.textSecondary)
                            .lineLimit(1)
                    }
                }
                Spacer()
            }
            .padding(.vertical, 4)
            .contentShape(Rectangle())
        }
        .listRowInsets(EdgeInsets(top: 8, leading: 16, bottom: 8, trailing: 16))
        .listRowBackground(Color.clear)
        .listRowSeparator(.hidden)
    }
}

struct SubstreamLaunchView: View {
    @Environment(AppModel.self) private var model
    @Environment(\.rallyColors) private var colors

    var body: some View {
        @Bindable var model = model
        VStack(spacing: 0) {
            HStack {
                Button("Cancel") {
                    model.cancelSubstreamLaunch()
                }
                .disabled(model.isCreatingSubstream)
                Spacer()
            }
            .padding(.horizontal, 16)
            .padding(.vertical, 8)

            ScrollView {
                VStack(alignment: .leading, spacing: 16) {
                    if !model.launchProvenance.isEmpty {
                        VStack(alignment: .leading, spacing: 12) {
                            ForEach(Array(model.launchProvenance.enumerated()), id: \.element.id) { index, message in
                                MessageRow(message: message)
                                    .opacity(provenanceOpacity(index: index, count: model.launchProvenance.count))
                                    .allowsHitTesting(false)
                            }
                        }
                        .mask(
                            LinearGradient(
                                colors: [.clear, .black.opacity(0.45), .black],
                                startPoint: .top,
                                endPoint: .bottom
                            )
                        )
                    }
                    if model.isCreatingSubstream {
                        HStack(spacing: 10) {
                            ProgressView()
                            Text("Starting substream")
                                .font(RallyType.bodySmall())
                                .foregroundStyle(colors.textSecondary)
                        }
                        .frame(maxWidth: .infinity, alignment: .leading)
                        .padding(.top, 8)
                    }
                    if let error = model.launchError {
                        Text(error)
                            .font(RallyType.caption())
                            .foregroundStyle(RallyPalette.error)
                    }
                }
                .padding(.horizontal, 16)
                .padding(.bottom, 12)
            }
            .scrollDismissesKeyboard(.interactively)

            ComposerBar(
                text: $model.composerText,
                isStreaming: false,
                attachments: model.pendingAttachments,
                onSend: { Task { await model.submitSubstreamLaunch() } },
                onStop: {},
                onAttach: { data, name, mime in model.attach(data: data, fileName: name, mimeType: mime) },
                onRemoveAttachment: { model.removeAttachment($0) },
                onVoice: { model.isVoicePresented = true },
                placeholder: "Start a substream",
                isDisabled: model.isCreatingSubstream
            )
        }
    }

    private func provenanceOpacity(index: Int, count: Int) -> Double {
        guard count > 1 else { return 0.7 }
        return 0.25 + (0.5 * Double(index) / Double(count - 1))
    }
}
