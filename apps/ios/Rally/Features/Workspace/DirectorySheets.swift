import SwiftUI

struct SearchSheet: View {
    @Environment(AppModel.self) private var model
    @Environment(\.rallyColors) private var colors
    @Environment(\.dismiss) private var dismiss

    var body: some View {
        @Bindable var model = model
        NavigationStack {
            List {
                if model.searchHits.isEmpty {
                    ContentUnavailableView("Search this workspace", systemImage: "magnifyingglass", description: Text("Messages, links, and files Rally can see."))
                        .listRowBackground(Color.clear)
                } else {
                    ForEach(model.searchHits) { hit in
                        Button {
                            model.openSearchHit(hit)
                        } label: {
                            VStack(alignment: .leading, spacing: 4) {
                                Text(hit.title ?? "Result")
                                    .font(RallyType.conversationTitle())
                                    .foregroundStyle(colors.textPrimary)
                                if let snippet = hit.snippet {
                                    Text(snippet)
                                        .font(RallyType.caption())
                                        .foregroundStyle(colors.textSecondary)
                                        .lineLimit(3)
                                }
                                if let kind = hit.kind {
                                    Text(kind)
                                        .font(RallyType.caption())
                                        .foregroundStyle(colors.textTertiary)
                                }
                            }
                        }
                        .listRowBackground(Color.clear)
                        .rallyInfiniteScroll(
                            isTerminal: hit.id == model.searchHits.last?.id,
                            hasMore: model.searchNextCursor != nil,
                            isLoading: model.isFetchingMoreSearch
                        ) {
                            Task { await model.fetchMoreSearch() }
                        }
                    }
                    if model.isFetchingMoreSearch {
                        ProgressView()
                            .frame(maxWidth: .infinity)
                            .listRowBackground(Color.clear)
                            .accessibilityLabel("Loading more results")
                    }
                }
            }
            .scrollContentBackground(.hidden)
            .background(colors.canvas)
            .navigationTitle("Search")
            .searchable(text: $model.searchQuery, prompt: "Search")
            .onSubmit(of: .search) {
                Task { await model.search() }
            }
            .onChange(of: model.searchQuery) { _, _ in
                Task { await model.search() }
            }
            .toolbar {
                ToolbarItem(placement: .topBarTrailing) {
                    Button("Done") { dismiss() }
                }
            }
        }
    }
}

struct InspectorSheet: View {
    @Environment(AppModel.self) private var model
    @Environment(\.rallyColors) private var colors
    @Environment(\.dismiss) private var dismiss

    var body: some View {
        NavigationStack {
            List {
                if let stream = model.currentWorkstream {
                    Section("Work stream") {
                        LabeledContent("Title", value: stream.title)
                        if let email = stream.emailAddress {
                            LabeledContent("Email", value: email)
                        }
                        LabeledContent("Visibility", value: stream.scope == "workspace" ? "Workspace" : "Private")
                        Button(stream.scope == "workspace" ? "Make private" : "Make public to workspace") {
                            Task { await model.setScope(stream, scope: stream.scope == "workspace" ? "personal" : "workspace") }
                        }
                    }
                    Section("People") {
                        ForEach(model.members) { member in
                            Button {
                                Task { await model.addParticipant(userId: member.id) }
                            } label: {
                                VStack(alignment: .leading) {
                                    Text(member.name)
                                        .foregroundStyle(colors.textPrimary)
                                    if let email = member.email {
                                        Text(email)
                                            .font(RallyType.caption())
                                            .foregroundStyle(colors.textSecondary)
                                    }
                                }
                            }
                            .rallyInfiniteScroll(
                                isTerminal: member.id == model.members.last?.id,
                                hasMore: false,
                                isLoading: false
                            ) {}
                        }
                    }
                } else {
                    ContentUnavailableView("Open a work stream", systemImage: "info.circle", description: Text("Details, people, and resources show up here."))
                        .listRowBackground(colors.canvas)
                }
            }
            .navigationTitle("Details")
            .task { await model.refreshLiveDirectory() }
            .toolbar {
                ToolbarItem(placement: .topBarTrailing) {
                    Button("Done") { dismiss() }
                }
            }
        }
    }
}
