import SwiftUI

struct HistoryPanel: View {
    @Environment(AppModel.self) private var model
    @Environment(\.rallyColors) private var colors
    @Environment(\.dismiss) private var dismiss
    @State private var query = ""
    @State private var renaming: RallyWorkstream?
    @State private var renameTitle = ""

    private var filtered: [RallyWorkstream] {
        let items = model.workstreams
        let trimmed = query.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !trimmed.isEmpty else { return items }
        return items.filter { $0.title.localizedCaseInsensitiveContains(trimmed) }
    }

    var body: some View {
        NavigationStack {
            List {
                if filtered.isEmpty {
                    ContentUnavailableView("No work streams", systemImage: "bubble.left", description: Text("Start one from the composer."))
                        .listRowBackground(colors.canvas)
                } else {
                    let pinned = filtered.filter(\.isPinned)
                    if !pinned.isEmpty {
                        Section("Pinned") {
                            ForEach(pinned) { item in
                                workstreamRow(item)
                            }
                        }
                    }
                    ForEach(grouped, id: \.title) { group in
                        Section(group.title) {
                            ForEach(group.items) { item in
                                workstreamRow(item)
                            }
                        }
                    }
                }
            }
            .listStyle(.plain)
            .scrollContentBackground(.hidden)
            .background(colors.canvas)
            .navigationTitle("History")
            .searchable(text: $query, prompt: "Search work streams")
            .toolbar {
                ToolbarItem(placement: .topBarLeading) {
                    Button("Close", systemImage: "xmark") { dismiss() }
                }
                ToolbarItem(placement: .topBarTrailing) {
                    Button("New", systemImage: "square.and.pencil") {
                        model.currentProject = nil
                        model.openNewChat()
                        dismiss()
                    }
                }
            }
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
        .task { await model.loadWorkspaceContent() }
    }

    @ViewBuilder
    private func workstreamRow(_ item: RallyWorkstream) -> some View {
        Button {
            Task {
                await model.open(workstream: item)
                dismiss()
            }
        } label: {
            HStack {
                VStack(alignment: .leading, spacing: 4) {
                    Text(item.title)
                        .font(RallyType.conversationTitle())
                        .foregroundStyle(colors.textPrimary)
                        .lineLimit(2)
                    if let last = item.lastActivityAt {
                        Text(Self.relative(last))
                            .font(RallyType.caption())
                            .foregroundStyle(colors.textSecondary)
                    }
                }
                Spacer()
                if item.hasUnread == true {
                    Circle()
                        .fill(RallyPalette.linkBlue)
                        .frame(width: 8, height: 8)
                        .accessibilityLabel("Unread")
                }
            }
            .padding(.vertical, 6)
        }
        .listRowBackground(colors.canvas)
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
                Task { await model.setScope(item, scope: item.scope == "public" ? "private" : "public") }
            } label: {
                Label(item.scope == "public" ? "Make private" : "Make public", systemImage: item.scope == "public" ? "lock" : "globe")
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

    private var grouped: [(title: String, items: [RallyWorkstream])] {
        let calendar = Calendar.current
        let unpinned = filtered.filter { !$0.isPinned }
        var today: [RallyWorkstream] = []
        var week: [RallyWorkstream] = []
        var earlier: [RallyWorkstream] = []
        for item in unpinned {
            let date = item.lastActivityAt.flatMap {
                ISO8601DateFormatter.fractional.date(from: $0) ?? ISO8601DateFormatter.full.date(from: $0)
            } ?? Date()
            if calendar.isDateInToday(date) {
                today.append(item)
            } else if date > calendar.date(byAdding: .day, value: -7, to: Date()) ?? date {
                week.append(item)
            } else {
                earlier.append(item)
            }
        }
        return [
            ("Today", today),
            ("Previous 7 Days", week),
            ("Earlier", earlier),
        ].filter { !$0.items.isEmpty }
    }

    private static func relative(_ raw: String) -> String {
        guard let date = ISO8601DateFormatter.fractional.date(from: raw) ?? ISO8601DateFormatter.full.date(from: raw) else {
            return raw
        }
        return date.formatted(.relative(presentation: .named))
    }
}
