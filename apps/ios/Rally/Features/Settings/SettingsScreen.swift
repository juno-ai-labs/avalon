import SwiftUI

struct SettingsScreen: View {
    @Environment(AppModel.self) private var model
    @Environment(\.rallyColors) private var colors
    @Environment(\.dismiss) private var dismiss
    @State private var confirmLeave = false
    @State private var confirmDelete = false
    @State private var apiOverride = UserDefaults.standard.string(forKey: "rally.api.global") ?? ""

    var body: some View {
        @Bindable var model = model
        NavigationStack {
            List {
                Section("Appearance") {
                    Picker("Appearance", selection: Binding(
                        get: { model.appearance },
                        set: { model.setAppearance($0) }
                    )) {
                        ForEach(AppearancePreference.allCases) { preference in
                            Text(preference.title).tag(preference)
                        }
                    }
                    .pickerStyle(.segmented)
                    .accessibilityLabel("Appearance")
                }

                Section("Account") {
                    if let user = model.workspaceSession?.user ?? model.identitySession?.user {
                        LabeledContent("Name", value: user.name)
                        LabeledContent("Email", value: user.email)
                    }
                    if let workspace = model.workspaceSession?.workspace {
                        LabeledContent("Workspace", value: workspace.name)
                        LabeledContent("Region", value: workspace.region.displayName)
                    }
                }

                Section("Privacy") {
                    Link("Privacy Policy", destination: APIConfiguration.privacyURL)
                    Link("Terms of Service", destination: APIConfiguration.termsURL)
                    Text("Sessions live in the Keychain on this device. Rally does not put refresh tokens in iCloud or UserDefaults.")
                        .font(RallyType.caption())
                        .foregroundStyle(colors.textSecondary)
                }

                Section("Workspace") {
                    Button("Leave this workspace", role: .destructive) {
                        confirmLeave = true
                    }
                    .disabled(model.workspaceSession?.workspace == nil)
                }

                Section("Account deletion") {
                    Text("Rally has no member-facing account-erasure API yet. Deleting your account on this device leaves the current workspace, signs you out, and removes tokens from the Keychain. Operator erasure of identity and workspace data is requested at the privacy address.")
                        .font(RallyType.caption())
                        .foregroundStyle(colors.textSecondary)
                    Button("Delete account on this device", role: .destructive) {
                        confirmDelete = true
                    }
                    Link("Request data deletion", destination: APIConfiguration.privacyURL)
                }

                Section {
                    Button("Sign out", role: .destructive) {
                        Task {
                            await model.signOut()
                            dismiss()
                        }
                    }
                }

                #if RALLY_DEBUG
                Section("Developer") {
                    TextField("Global API URL", text: $apiOverride)
                        .textInputAutocapitalization(.never)
                        .keyboardType(.URL)
                        .autocorrectionDisabled()
                    Button("Save API URL") {
                        let trimmed = apiOverride.trimmingCharacters(in: .whitespacesAndNewlines)
                        if trimmed.isEmpty {
                            UserDefaults.standard.removeObject(forKey: "rally.api.global")
                        } else {
                            UserDefaults.standard.set(trimmed, forKey: "rally.api.global")
                        }
                    }
                    LabeledContent("Bundle", value: APIConfiguration.bundleIdentifier)
                    LabeledContent("Version", value: Bundle.main.object(forInfoDictionaryKey: "CFBundleShortVersionString") as? String ?? "1.0.0")
                }
                #endif
            }
            .navigationTitle("Settings")
            .toolbar {
                ToolbarItem(placement: .topBarTrailing) {
                    Button("Done") { dismiss() }
                }
            }
            .confirmationDialog("Leave this workspace?", isPresented: $confirmLeave, titleVisibility: .visible) {
                Button("Leave", role: .destructive) {
                    Task {
                        await model.leaveCurrentWorkspace()
                        dismiss()
                    }
                }
                Button("Cancel", role: .cancel) {}
            } message: {
                Text("You will stop seeing this workspace on this device. Work already in it stays with the remaining members.")
            }
            .confirmationDialog("Delete account on this device?", isPresented: $confirmDelete, titleVisibility: .visible) {
                Button("Delete on this device", role: .destructive) {
                    Task {
                        await model.deleteAccountOnThisDevice()
                        dismiss()
                    }
                }
                Button("Cancel", role: .cancel) {}
            } message: {
                Text("This signs you out of Rally on this iPhone. It does not erase the workspace for other members. Use Request data deletion for operator erasure.")
            }
        }
    }
}
