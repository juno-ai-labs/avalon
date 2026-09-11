import SwiftUI

struct WorkspacePickerView: View {
    @Environment(AppModel.self) private var model
    @Environment(\.rallyColors) private var colors
    @State private var newName = ""
    @State private var region: RallyRegion = .global

    var body: some View {
        NavigationStack {
            List {
                if !model.onboarding.workspaces.isEmpty {
                    Section("Your workspaces") {
                        ForEach(model.onboarding.workspaces) { workspace in
                            Button {
                                Task { try? await model.activate(workspace) }
                            } label: {
                                VStack(alignment: .leading, spacing: 4) {
                                    Text(workspace.name)
                                        .font(RallyType.conversationTitle())
                                        .foregroundStyle(colors.textPrimary)
                                    Text(workspace.region.displayName)
                                        .font(RallyType.caption())
                                        .foregroundStyle(colors.textSecondary)
                                }
                            }
                            .accessibilityHint("Opens \(workspace.name)")
                        }
                    }
                }
                if !model.onboarding.invitations.isEmpty {
                    Section("Invitations") {
                        ForEach(model.onboarding.invitations) { invitation in
                            Button {
                                Task { await model.acceptInvitation(invitation) }
                            } label: {
                                VStack(alignment: .leading, spacing: 4) {
                                    Text(invitation.workspaceName ?? "Workspace invitation")
                                        .font(RallyType.conversationTitle())
                                        .foregroundStyle(colors.textPrimary)
                                    if let name = invitation.invitedByName {
                                        Text("From \(name)")
                                            .font(RallyType.caption())
                                            .foregroundStyle(colors.textSecondary)
                                    }
                                }
                            }
                            .accessibilityHint("Accept invitation")
                        }
                    }
                }
                Section("Create a workspace") {
                    TextField("Workspace name", text: $newName)
                    Picker("Region", selection: $region) {
                        ForEach(RallyRegion.allCases) { item in
                            Text(item.displayName).tag(item)
                        }
                    }
                    Button("Create") {
                        Task { await model.createWorkspace(name: newName, region: region) }
                    }
                    .disabled(newName.trimmingCharacters(in: .whitespacesAndNewlines).count < 2)
                }
            }
            .navigationTitle("Workspaces")
            .toolbar {
                ToolbarItem(placement: .topBarTrailing) {
                    Button("Sign out") { Task { await model.signOut() } }
                }
            }
        }
        .tint(colors.link)
    }
}
