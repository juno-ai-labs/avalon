import SwiftUI

struct SidekicksScreen: View {
    @Environment(AppModel.self) private var model
    @Environment(\.rallyColors) private var colors

    var body: some View {
        NavigationStack {
            List {
                if model.sidekicks.isEmpty {
                    ContentUnavailableView(
                        "No Sidekicks",
                        systemImage: "hexagon",
                        description: Text("Sidekicks in this workspace will show up here.")
                    )
                    .listRowSeparator(.hidden)
                    .listRowBackground(Color.clear)
                } else {
                    ForEach(model.sidekicks) { item in
                        Button {
                            model.open(sidekick: item)
                        } label: {
                            HStack(alignment: .top, spacing: 14) {
                                SidekickGlyph(id: item.id, appearance: item.appearance, isActive: item.status == "active")
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
                            .padding(.vertical, 2)
                        }
                        .listRowInsets(EdgeInsets(top: 10, leading: 16, bottom: 10, trailing: 16))
                        .listRowSeparator(.hidden)
                        .listRowBackground(Color.clear)
                        .onAppear { model.appearDirectoryFeed(parentId: item.id) }
                        .onDisappear { model.disappearDirectoryFeed(parentId: item.id) }
                        .rallyInfiniteScroll(
                            isTerminal: item.id == model.sidekicks.last?.id,
                            hasMore: false,
                            isLoading: false
                        ) {}
                    }
                }
            }
            .listStyle(.plain)
            .scrollContentBackground(.hidden)
            .background(colors.canvas.ignoresSafeArea())
            .navigationTitle("Sidekicks")
            .refreshable { await model.loadWorkspaceContent() }
        }
    }
}
