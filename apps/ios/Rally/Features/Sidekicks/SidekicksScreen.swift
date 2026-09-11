import SwiftUI

struct SidekicksScreen: View {
    @Environment(AppModel.self) private var model
    @Environment(\.rallyColors) private var colors

    var body: some View {
        NavigationStack {
            List {
                if model.sidekicks.isEmpty {
                    ContentUnavailableView("No Sidekicks", systemImage: "sparkles", description: Text("Create one to draft an automation in its own conversation."))
                        .listRowBackground(colors.canvas)
                } else {
                    ForEach(model.sidekicks) { item in
                        Button {
                            Task { await model.open(sidekick: item) }
                        } label: {
                            VStack(alignment: .leading, spacing: 4) {
                                Text(item.name)
                                    .font(RallyType.conversationTitle())
                                    .foregroundStyle(colors.textPrimary)
                                HStack {
                                    if let status = item.status {
                                        Text(status)
                                    }
                                    if let description = item.description, !description.isEmpty {
                                        Text(description)
                                            .lineLimit(2)
                                    }
                                }
                                .font(RallyType.caption())
                                .foregroundStyle(colors.textSecondary)
                            }
                        }
                        .listRowBackground(colors.canvas)
                    }
                }
            }
            .scrollContentBackground(.hidden)
            .background(colors.canvas.ignoresSafeArea())
            .navigationTitle("Sidekicks")
            .toolbar {
                ToolbarItem(placement: .topBarTrailing) {
                    Button("New", systemImage: "plus") {
                        Task { await model.createSidekick() }
                    }
                    .accessibilityLabel("New Sidekick")
                }
            }
        }
    }
}
