import SwiftUI

struct HistoryPanel: View {
    @Environment(AppModel.self) private var model
    @Environment(\.rallyColors) private var colors
    @Environment(\.dismiss) private var dismiss
    @State private var query = ""

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
                    ForEach(grouped, id: \.title) { group in
                        Section(group.title) {
                            ForEach(group.items) { item in
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
                        model.openNewChat()
                        dismiss()
                    }
                }
            }
        }
        .task { await model.loadWorkspaceContent() }
    }

    private var grouped: [(title: String, items: [RallyWorkstream])] {
        let calendar = Calendar.current
        var today: [RallyWorkstream] = []
        var week: [RallyWorkstream] = []
        var earlier: [RallyWorkstream] = []
        for item in filtered {
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
