import SwiftUI

/// Grok-style work-stream directory. This is the work-stream list: system
/// navigation and toolbar provide Liquid Glass; rows are content, not glass.
struct WorkstreamListScreen: View {
    @Environment(AppModel.self) private var model
    @Environment(\.rallyColors) private var colors
    @State private var renaming: RallyWorkstream?
    @State private var renameTitle = ""
    @State private var groupedAt = Date()

    private var sections: [RallyWorkstreamSection] {
        _ = groupedAt
        return RallyWorkstreamDirectory.sections(from: model.workstreams, now: groupedAt)
    }

    var body: some View {
        List {
            if model.workstreams.isEmpty {
                ContentUnavailableView(
                    "No work streams",
                    systemImage: "smallcircle.filled.circle",
                    description: Text("Work streams in this workspace will show up here.")
                )
                .listRowSeparator(.hidden)
                .listRowBackground(Color.clear)
            } else {
                ForEach(sections) { section in
                    Section(section.title) {
                        ForEach(section.items) { item in
                            workstreamEntry(item)
                                .rallyInfiniteScroll(
                                    isTerminal: item.id == sections.last?.items.last?.id,
                                    hasMore: model.workstreamNextCursor != nil,
                                    isLoading: model.isFetchingMoreWorkstreams
                                ) {
                                    Task { await model.fetchMoreWorkstreams() }
                                }
                        }
                    }
                }
                if model.isFetchingMoreWorkstreams {
                    Section {
                        ProgressView()
                            .frame(maxWidth: .infinity)
                            .listRowBackground(Color.clear)
                            .accessibilityLabel("Loading more work streams")
                    }
                }
            }
        }
        .listStyle(.plain)
        .scrollContentBackground(.hidden)
        .background(colors.canvas.ignoresSafeArea())
        .navigationTitle("Work streams")
        .navigationBarTitleDisplayMode(.large)
        .toolbar {
            ToolbarItem(placement: .topBarLeading) {
                Button {
                    model.isSettingsPresented = true
                } label: {
                    AccountAvatar(
                        presentation: model.accountAvatarPresentation,
                        fallbackName: model.accountAvatarName
                    )
                }
                .accessibilityLabel("Workspace and settings")
            }
        }
        .task(id: model.workstreams.map(\.id)) {
            groupedAt = Date()
            while !Task.isCancelled {
                let next = RallyWorkstreamDirectory.nextBoundary(items: model.workstreams, now: Date())
                let delay = max(0.001, next.timeIntervalSinceNow)
                try? await Task.sleep(for: .seconds(delay))
                groupedAt = Date()
            }
        }
        .refreshable { await model.loadWorkspaceContent() }
        .alert("Rename", isPresented: Binding(
            get: { renaming != nil },
            set: { if !$0 { renaming = nil } }
        )) {
            TextField("Title", text: $renameTitle)
            Button("Save") {
                if let renaming {
                    Task { await model.rename(renaming, title: renameTitle) }
                }
                renaming = nil
            }
            Button("Cancel", role: .cancel) { renaming = nil }
        }
    }

    @ViewBuilder
    private func workstreamEntry(_ item: RallyWorkstream) -> some View {
        Button {
            model.revealSubstreams(item)
        } label: {
            WorkstreamRow(item: item)
        }
        .listRowInsets(EdgeInsets(top: 10, leading: 16, bottom: 10, trailing: 16))
        .listRowSeparator(.hidden)
        .listRowBackground(Color.clear)
        .onAppear { model.appearDirectoryFeed(parentId: item.id) }
        .onDisappear { model.disappearDirectoryFeed(parentId: item.id) }
        .swipeActions(edge: .trailing, allowsFullSwipe: false) {
            Button {
                Task { await model.archive(item) }
            } label: {
                Label("Archive", systemImage: "archivebox")
            }
            .tint(.orange)
            Button {
                Task { await model.markUnread(item) }
            } label: {
                Label("Unread", systemImage: "envelope.badge")
            }
            Button {
                Task { await model.pin(item) }
            } label: {
                Label(item.isPinned ? "Unpin" : "Pin", systemImage: item.isPinned ? "pin.slash" : "pin")
            }
            .tint(.yellow)
        }
        .contextMenu {
            Button {
                renameTitle = item.title
                renaming = item
            } label: {
                Label("Rename", systemImage: "pencil")
            }
            Button {
                Task { await model.setScope(item, scope: item.scope == "workspace" ? "personal" : "workspace") }
            } label: {
                Label(item.scope == "workspace" ? "Make private" : "Make public to workspace", systemImage: item.scope == "workspace" ? "lock" : "globe")
            }
            Button {
                Task { await model.pin(item) }
            } label: {
                Label(item.isPinned ? "Unpin" : "Pin", systemImage: "pin")
            }
            Button {
                Task { await model.markUnread(item) }
            } label: {
                Label("Mark unread", systemImage: "envelope.badge")
            }
            Button(role: .destructive) {
                Task { await model.archive(item) }
            } label: {
                Label("Archive", systemImage: "archivebox")
            }
        }
    }
}

struct WorkstreamRow: View {
    var item: RallyWorkstream
    @Environment(\.rallyColors) private var colors

    var body: some View {
        HStack(alignment: .top, spacing: 14) {
            WorkstreamGlyph(id: item.id, appearance: item.appearance)
            VStack(alignment: .leading, spacing: 4) {
                HStack(alignment: .firstTextBaseline) {
                    Text(item.title)
                        .font(RallyType.conversationTitle())
                        .foregroundStyle(colors.textPrimary)
                        .lineLimit(1)
                    Spacer(minLength: 8)
                    if let last = item.lastActivityAt {
                        Text(Self.listTime(last))
                            .font(RallyType.caption())
                            .foregroundStyle(colors.textTertiary)
                    }
                }
                HStack(spacing: 6) {
                    if item.hasUnread == true {
                        Circle()
                            .fill(RallyPalette.linkBlue)
                            .frame(width: 8, height: 8)
                            .accessibilityLabel("Unread")
                    }
                    if let preview = item.preview, !preview.isEmpty {
                        Text(preview)
                            .font(RallyType.bodySmall())
                            .foregroundStyle(colors.textSecondary)
                            .lineLimit(2)
                    } else if item.isPinned {
                        Text("Pinned")
                            .font(RallyType.bodySmall())
                            .foregroundStyle(colors.textSecondary)
                    }
                }
            }
        }
        .padding(.vertical, 2)
        .contentShape(Rectangle())
        .accessibilityLabel(item.title)
        .accessibilityHint("Shows substreams in this work stream")
    }

    private static func listTime(_ raw: String) -> String {
        guard let date = JSONCoding.date(from: raw) else { return raw }
        let calendar = Calendar.current
        if calendar.isDateInToday(date) {
            return date.formatted(date: .omitted, time: .shortened)
        }
        if calendar.isDateInYesterday(date) {
            return "Yesterday"
        }
        if date > calendar.date(byAdding: .day, value: -7, to: Date()) ?? date {
            return date.formatted(.dateTime.weekday(.wide))
        }
        return date.formatted(date: .abbreviated, time: .omitted)
    }
}
