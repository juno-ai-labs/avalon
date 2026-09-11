import SwiftUI

struct ProjectsScreen: View {
    @Environment(AppModel.self) private var model
    @Environment(\.rallyColors) private var colors
    @State private var newName = ""

    var body: some View {
        NavigationStack {
            Group {
                if let project = model.currentProject {
                    ProjectSpaceView(project: project)
                } else {
                    projectList
                }
            }
            .background(colors.canvas.ignoresSafeArea())
            .navigationTitle(model.currentProject?.name ?? "Projects")
            .toolbar {
                if model.currentProject != nil {
                    ToolbarItem(placement: .topBarLeading) {
                        Button("Projects") { model.currentProject = nil }
                    }
                }
                ToolbarItem(placement: .topBarTrailing) {
                    Button("New", systemImage: "plus") {
                        if model.currentProject != nil {
                            model.openNewChat()
                            model.selectedTab = .chats
                        }
                    }
                    .accessibilityLabel(model.currentProject == nil ? "New project" : "New chat in this project")
                }
            }
        }
    }

    private var projectList: some View {
        List {
            Section {
                HStack {
                    TextField("Project name", text: $newName)
                    Button("Create") {
                        Task {
                            await model.createProject(name: newName)
                            newName = ""
                        }
                    }
                    .disabled(newName.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty)
                }
            }
            if model.projects.isEmpty {
                ContentUnavailableView("No projects", systemImage: "square.grid.2x2", description: Text("Create one to group work streams."))
                    .listRowBackground(colors.canvas)
            } else {
                ForEach(model.projects) { project in
                    Button {
                        model.open(project: project)
                    } label: {
                        VStack(alignment: .leading, spacing: 4) {
                            Text(project.name)
                                .font(RallyType.conversationTitle())
                                .foregroundStyle(colors.textPrimary)
                            Text("\(project.workstreamIds.count) work streams")
                                .font(RallyType.caption())
                                .foregroundStyle(colors.textSecondary)
                        }
                    }
                    .listRowBackground(colors.canvas)
                }
            }
        }
        .scrollContentBackground(.hidden)
    }
}

struct ProjectSpaceView: View {
    var project: RallyProject
    @Environment(AppModel.self) private var model
    @Environment(\.rallyColors) private var colors

    var body: some View {
        List {
            Section {
                Button {
                    model.currentProject = project
                    model.openNewChat()
                    model.selectedTab = .chats
                } label: {
                    Label("New work stream", systemImage: "square.and.pencil")
                }
            }
            let items = model.workstreams(in: project)
            if items.isEmpty {
                ContentUnavailableView("Nothing in this project yet", systemImage: "bubble.left", description: Text("Start a work stream from here."))
                    .listRowBackground(colors.canvas)
            } else {
                ForEach(items) { item in
                    Button {
                        Task { await model.open(workstream: item) }
                    } label: {
                        Text(item.title)
                            .font(RallyType.conversationTitle())
                            .foregroundStyle(colors.textPrimary)
                    }
                    .listRowBackground(colors.canvas)
                }
            }
        }
        .scrollContentBackground(.hidden)
    }
}
