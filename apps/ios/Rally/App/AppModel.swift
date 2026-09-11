import AVFoundation
import AuthenticationServices
import Foundation
import Observation
import Security
import SwiftUI
import UIKit
import UserNotifications

@MainActor
@Observable
final class AppModel {
    enum Phase: Equatable {
        case launching
        case signedOut
        case pickingWorkspace
        case ready
    }

    var phase: Phase = .launching
    var appearance: AppearancePreference = .system
    var identitySession: RallySession?
    var workspaceSession: RallySession?
    var onboarding: RallyOnboardingState = RallyOnboardingState(workspace: nil, workspaces: [], invitations: [])
    var workstreams: [RallyWorkstream] = []
    var currentWorkstream: RallyWorkstream?
    var messages: [RallyChatMessage] = []
    var composerText = ""
    var isStreaming = false
    var isSending = false
    var errorMessage: String?
    var greetingName: String { workspaceSession?.user.name.split(separator: " ").first.map(String.init) ?? "there" }
    var opportunities: [RallyOpportunity] = []
    var notes: [RallyNote] = []
    var sidekicks: [RallySidekick] = []
    var members: [RallyMember] = []
    var projects: [RallyProject] = []
    var currentProject: RallyProject?
    var currentNote: RallyNote?
    var searchHits: [RallySearchHit] = []
    var searchQuery = ""
    var selectedTab: MainTab = .chats
    var speakingMessageId: String?
    var firstUnreadSequence: Int?
    var hasOlderTranscript = false
    var jumpToLatestToken = 0
    var digest: RallyDigest?

    enum MainTab: String, CaseIterable, Identifiable {
        case chats, projects, notes, sidekicks
        var id: String { rawValue }
    }
    var isHistoryPresented = false
    var isSettingsPresented = false
    var isSearchPresented = false
    var isInspectorPresented = false
    var isVoicePresented = false
    var pendingAttachments: [PendingAttachment] = []
    var isConnectingConversation = false

    let keychain = KeychainStore()
    private var client = RallyClient()
    private var socket = ConversationSocket()
    private var workspaceSocket = WorkspaceSocket()
    private var listenTask: Task<Void, Never>?
    private var workspaceListenTask: Task<Void, Never>?
    private let speaker = AVSpeechSynthesizer()
    private var pkce: PKCEChallenge?
    private var authSession: ASWebAuthenticationSession?

    struct PendingAttachment: Identifiable, Equatable {
        var id: String
        var fileName: String
        var mimeType: String
        var data: Data
        var resourceId: String?
        var failed: Bool = false
    }

    var preferredColorScheme: ColorScheme? {
        switch appearance {
        case .system: nil
        case .light: .light
        case .dark: .dark
        }
    }

    func bootstrap() async {
        appearance = (try? keychain.load(account: SessionAccounts.appearance)).flatMap {
            try? JSONDecoder().decode(AppearancePreference.self, from: $0)
        } ?? .system
        if let identityData = try? keychain.load(account: SessionAccounts.identity),
           let identity = try? JSONDecoder().decode(RallySession.self, from: identityData) {
            identitySession = identity
            await client.update(baseURL: APIConfiguration.globalURL(), accessToken: identity.accessToken)
            if let workspaceData = try? keychain.load(account: SessionAccounts.workspace),
               let workspace = try? JSONDecoder().decode(RallySession.self, from: workspaceData),
               let url = URL(string: workspace.apiBaseUrl) {
                workspaceSession = workspace
                await client.update(baseURL: url, accessToken: workspace.accessToken)
                await refreshIfNeeded(session: workspace)
                phase = .ready
                await loadWorkspaceContent()
                return
            }
            do {
                onboarding = try await client.onboardingState()
                phase = .pickingWorkspace
            } catch {
                phase = .signedOut
            }
            return
        }
        phase = .signedOut
    }

    func setAppearance(_ preference: AppearancePreference) {
        appearance = preference
        if let data = try? JSONEncoder().encode(preference) {
            try? keychain.save(data, account: SessionAccounts.appearance)
        }
    }

    // MARK: Sign-in

    func startGoogleSignIn(anchor: ASPresentationAnchor) async {
        errorMessage = nil
        let challenge = PKCEChallenge.generate()
        pkce = challenge
        do {
            await client.update(baseURL: APIConfiguration.globalURL(), accessToken: nil)
            let url = try await client.beginGoogleLogin(challenge: challenge)
            let callback = try await withCheckedThrowingContinuation { (continuation: CheckedContinuation<URL, Error>) in
                let session = ASWebAuthenticationSession(url: url, callbackURLScheme: "rallywithai") { callbackURL, error in
                    if let error {
                        continuation.resume(throwing: error)
                    } else if let callbackURL {
                        continuation.resume(returning: callbackURL)
                    } else {
                        continuation.resume(throwing: RallyAPIError(status: 0, code: "cancelled", message: "Sign-in was cancelled."))
                    }
                }
                session.presentationContextProvider = SignInPresenter.shared.binding(anchor)
                session.prefersEphemeralWebBrowserSession = false
                self.authSession = session
                session.start()
            }
            try await completeSignIn(callback: callback)
        } catch {
            if (error as NSError).code == ASWebAuthenticationSessionError.canceledLogin.rawValue { return }
            errorMessage = (error as? LocalizedError)?.errorDescription ?? "Couldn’t sign in with Google."
        }
    }

    func handleIncomingURL(_ url: URL) async {
        if url.scheme == "rallywithai" && url.host == "auth" {
            try? await completeSignIn(callback: url)
            return
        }
        await openUniversalLink(url)
    }

    private func completeSignIn(callback: URL) async throws {
        guard let challenge = pkce else { return }
        let components = URLComponents(url: callback, resolvingAgainstBaseURL: false)
        let items = Dictionary(uniqueKeysWithValues: (components?.queryItems ?? []).compactMap { item in
            item.value.map { (item.name, $0) }
        })
        if let error = items["error"] {
            throw RallyAPIError(status: 401, code: error, message: "Google sign-in didn’t finish.")
        }
        guard let ticket = items["ticket"] else {
            throw RallyAPIError(status: 401, code: "missing_ticket", message: "Google sign-in didn’t return a ticket.")
        }
        let timezone = TimeZone.current.identifier
        let session = try await client.exchangeDesktopTicket(
            ticket: ticket,
            attemptId: challenge.attemptId,
            verifier: challenge.verifier,
            timezone: timezone
        )
        identitySession = session
        try persist(session, account: SessionAccounts.identity)
        await client.update(baseURL: APIConfiguration.globalURL(), accessToken: session.accessToken)
        pkce = nil
        onboarding = try await client.onboardingState()
        if onboarding.workspaces.count == 1, let only = onboarding.workspaces.first {
            try await activate(only)
        } else {
            phase = .pickingWorkspace
        }
    }

    func activate(_ workspace: RallyWorkspace) async throws {
        let session = try await client.activateWorkspace(region: workspace.region, workspaceId: workspace.id)
        guard let url = URL(string: session.apiBaseUrl) else {
            throw RallyAPIError(status: 502, code: "missing_api", message: "The workspace did not return an API URL.")
        }
        workspaceSession = session
        try persist(session, account: SessionAccounts.workspace)
        await client.update(baseURL: url, accessToken: session.accessToken)
        phase = .ready
        await loadWorkspaceContent()
    }

    func createWorkspace(name: String, region: RallyRegion) async {
        errorMessage = nil
        do {
            let session = try await client.createWorkspace(name: name, region: region)
            guard let url = URL(string: session.apiBaseUrl) else { return }
            workspaceSession = session
            try persist(session, account: SessionAccounts.workspace)
            await client.update(baseURL: url, accessToken: session.accessToken)
            phase = .ready
            await loadWorkspaceContent()
        } catch {
            errorMessage = (error as? LocalizedError)?.errorDescription ?? "Couldn’t create that workspace."
        }
    }

    func signOut() async {
        listenTask?.cancel()
        await socket.disconnect()
        await client.logout(refreshToken: workspaceSession?.refreshToken ?? identitySession?.refreshToken)
        try? keychain.delete(account: SessionAccounts.identity)
        try? keychain.delete(account: SessionAccounts.workspace)
        identitySession = nil
        workspaceSession = nil
        workstreams = []
        messages = []
        currentWorkstream = nil
        notes = []
        sidekicks = []
        projects = []
        currentProject = nil
        currentNote = nil
        phase = .signedOut
        workspaceListenTask?.cancel()
        Task { await workspaceSocket.disconnect() }
    }

    func leaveCurrentWorkspace() async {
        guard let workspace = workspaceSession?.workspace else { return }
        do {
            try await client.leaveWorkspace(workspaceId: workspace.id, expectedOutcome: "left")
            try? keychain.delete(account: SessionAccounts.workspace)
            workspaceSession = nil
            await client.update(baseURL: APIConfiguration.globalURL(), accessToken: identitySession?.accessToken)
            onboarding = try await client.onboardingState()
            phase = .pickingWorkspace
        } catch {
            errorMessage = (error as? LocalizedError)?.errorDescription ?? "Couldn’t leave this workspace."
        }
    }

    // MARK: Directory + conversation

    func loadWorkspaceContent() async {
        do {
            async let listed = client.listWorkstreams()
            async let chips = client.workOpportunities()
            workstreams = try await listed.items.filter { $0.archivedAt == nil && ($0.systemKind == nil) }
            opportunities = (try? await chips) ?? []
            notes = (try? await client.listNotes()) ?? []
            sidekicks = (try? await client.listSidekicks()) ?? []
            members = (try? await client.listMembers()) ?? []
            digest = try? await client.getDigest()
            await listenToWorkspaceSocket()
        } catch let error as RallyAPIError where error.status == 401 {
            await recoverSession()
        } catch {
            errorMessage = (error as? LocalizedError)?.errorDescription
        }
    }

    func openNewChat() {
        currentWorkstream = nil
        currentNote = nil
        messages = []
        isStreaming = false
        hasOlderTranscript = false
        selectedTab = .chats
        listenTask?.cancel()
        Task { await socket.disconnect() }
    }

    func open(workstream: RallyWorkstream) async {
        currentWorkstream = workstream
        currentNote = nil
        isHistoryPresented = false
        selectedTab = .chats
        await loadConversation(id: workstream.id)
    }

    func send() async {
        let text = composerText.trimmingCharacters(in: .whitespacesAndNewlines)
        let attachments = pendingAttachments
        guard !text.isEmpty || !attachments.isEmpty else { return }
        guard text.count <= APIConfiguration.messageMaxCharacters else {
            errorMessage = "This message is over 100,000 characters, please shorten it."
            return
        }
        composerText = ""
        isSending = true
        let clientMessageId = UUID().uuidString
        let operationId = UUID().uuidString
        let userMessage = RallyChatMessage(
            id: clientMessageId,
            role: .user,
            text: text,
            createdAt: Date(),
            isStreaming: false,
            clientMessageId: clientMessageId,
            sequence: nil
        )
        messages.append(userMessage)
        do {
            var resourceIds: [String] = []
            for attachment in attachments where attachment.resourceId == nil {
                let uploaded = try await client.uploadResource(
                    data: attachment.data,
                    fileName: attachment.fileName,
                    mimeType: attachment.mimeType,
                    draftId: UUID().uuidString
                )
                resourceIds.append(uploaded.id)
            }
            resourceIds.append(contentsOf: attachments.compactMap(\.resourceId))
            pendingAttachments = []
            if let current = currentWorkstream {
                try await ensureSocket(parentId: current.id)
                try await socket.sendMessage(text: text, clientMessageId: clientMessageId, operationId: operationId, attachmentIds: resourceIds)
                isStreaming = true
            } else {
                let created = try await client.createWorkstream(
                    openingMessage: text,
                    clientMessageId: clientMessageId,
                    operationId: operationId,
                    attachmentIds: resourceIds,
                    projectId: currentProject?.id
                )
                currentWorkstream = created.workstream
                workstreams.insert(created.workstream, at: 0)
                if var project = currentProject {
                    project.workstreamIds.append(created.workstream.id)
                    currentProject = project
                    if let index = projects.firstIndex(where: { $0.id == project.id }) {
                        projects[index] = project
                    }
                }
                await loadConversation(id: created.workstream.id)
                isStreaming = true
            }
        } catch {
            errorMessage = (error as? LocalizedError)?.errorDescription ?? "That message didn’t send."
            isStreaming = false
        }
        isSending = false
    }

    func stopGeneration() async {
        await socket.stop(operationId: UUID().uuidString)
        isStreaming = false
        if let index = messages.lastIndex(where: { $0.role == .assistant && $0.isStreaming }) {
            messages[index].isStreaming = false
        }
    }

    func attach(data: Data, fileName: String, mimeType: String) {
        pendingAttachments.append(PendingAttachment(id: UUID().uuidString, fileName: fileName, mimeType: mimeType, data: data))
    }

    func removeAttachment(_ id: String) {
        pendingAttachments.removeAll { $0.id == id }
    }

    private func loadConversation(id: String) async {
        isConnectingConversation = true
        do {
            let boot = try await client.getConversation(id: id)
            apply(boot: boot)
            await listenToSocket(parentId: id)
        } catch {
            errorMessage = (error as? LocalizedError)?.errorDescription
        }
        isConnectingConversation = false
    }

    private func ensureSocket(parentId: String) async throws {
        let ticket = try await client.conversationSocketTicket(parentId: parentId)
        listenTask?.cancel()
        let stream = await socket.connect(ticket: ticket)
        listenTask = Task { await consume(stream) }
    }

    private func listenToSocket(parentId: String) async {
        do {
            try await ensureSocket(parentId: parentId)
        } catch {
            // REST snapshot already painted; live updates retry on the next send.
        }
    }

    private func consume(_ stream: AsyncStream<ConversationSocket.Incoming>) async {
        for await event in stream {
            switch event {
            case .snapshot(let boot):
                apply(boot: boot)
            case .turnUpserted(let turn):
                upsert(turn)
            case .olderTurns(let turns):
                prepend(turns)
            case .commandSucceeded:
                break
            case .commandFailed(let message):
                errorMessage = message
                isStreaming = false
            case .closed:
                isStreaming = false
            }
        }
    }

    private func apply(boot: ConversationBoot) {
        let turns = (boot.transcript?.ranges ?? []).flatMap { $0.turns ?? [] } + (boot.transcript?.activeTurns ?? [])
        var seen = Set<String>()
        messages = FeedProjection.rows(from: turns).filter { seen.insert($0.id).inserted }
            .sorted { ($0.sequence ?? 0, $0.createdAt) < ($1.sequence ?? 0, $1.createdAt) }
        isStreaming = messages.contains { $0.isStreaming }
        hasOlderTranscript = (messages.compactMap(\.sequence).min() ?? 1) > 1
        if let title = boot.title, var current = currentWorkstream {
            current.title = title
            currentWorkstream = current
        }
    }

    private func upsert(_ turn: TranscriptTurn) {
        let mapped = FeedProjection.rows(from: turn)
        for row in mapped {
            if let index = messages.firstIndex(where: { $0.id == row.id || ($0.clientMessageId != nil && $0.clientMessageId == row.clientMessageId) }) {
                messages[index] = row
            } else {
                messages.append(row)
            }
        }
        messages = FeedProjection.collapseSettledWork(messages)
        isStreaming = messages.contains { $0.isStreaming }
    }

    private func prepend(_ turns: [TranscriptTurn]) {
        let incoming = FeedProjection.rows(from: turns)
        var seen = Set(messages.map(\.id))
        let unique = incoming.filter { seen.insert($0.id).inserted }
        messages = FeedProjection.collapseSettledWork(unique + messages)
        hasOlderTranscript = (messages.compactMap(\.sequence).min() ?? 1) > 1
    }

    private func refreshIfNeeded(session: RallySession) async {
        // Access tokens last 15 minutes. Refresh proactively when we have no
        // reliable parse of expiresAt, by always refreshing on launch.
        do {
            let refreshed = try await client.refresh(refreshToken: session.refreshToken)
            workspaceSession = refreshed
            try persist(refreshed, account: SessionAccounts.workspace)
            if let url = URL(string: refreshed.apiBaseUrl) {
                await client.update(baseURL: url, accessToken: refreshed.accessToken)
            }
        } catch {
            // Keep the stored session; the next authenticated call will retry.
        }
    }

    private func recoverSession() async {
        if let refresh = workspaceSession?.refreshToken {
            do {
                let refreshed = try await client.refresh(refreshToken: refresh)
                workspaceSession = refreshed
                try persist(refreshed, account: SessionAccounts.workspace)
                if let url = URL(string: refreshed.apiBaseUrl) {
                    await client.update(baseURL: url, accessToken: refreshed.accessToken)
                }
                await loadWorkspaceContent()
                return
            } catch { }
        }
        await signOut()
    }

    private func persist(_ session: RallySession, account: String) throws {
        let data = try JSONEncoder().encode(session)
        try keychain.save(data, account: account)
    }

    func acceptInvitation(_ invitation: RallyInvitation) async {
        guard let region = invitation.region else {
            errorMessage = "This invitation is missing a region."
            return
        }
        do {
            let session = try await client.acceptInvitation(id: invitation.id, region: region)
            guard let url = URL(string: session.apiBaseUrl) else { return }
            workspaceSession = session
            try persist(session, account: SessionAccounts.workspace)
            await client.update(baseURL: url, accessToken: session.accessToken)
            phase = .ready
            await loadWorkspaceContent()
        } catch {
            errorMessage = (error as? LocalizedError)?.errorDescription ?? "Couldn’t accept that invitation."
        }
    }

    func deleteAccountOnThisDevice() async {
        if workspaceSession?.workspace != nil {
            await leaveCurrentWorkspace()
        }
        await signOut()
    }

    func pin(_ workstream: RallyWorkstream) async {
        do {
            if workstream.isPinned {
                try await client.unpinWorkstream(id: workstream.id)
            } else {
                try await client.pinWorkstream(id: workstream.id)
            }
            await loadWorkspaceContent()
        } catch {
            errorMessage = (error as? LocalizedError)?.errorDescription ?? "Couldn’t update the pin."
        }
    }

    func markUnread(_ workstream: RallyWorkstream) async {
        do {
            try await client.markWorkstreamUnread(id: workstream.id)
            await loadWorkspaceContent()
        } catch {
            errorMessage = (error as? LocalizedError)?.errorDescription ?? "Couldn’t mark that unread."
        }
    }

    func archive(_ workstream: RallyWorkstream) async {
        do {
            _ = try await client.patchWorkstream(id: workstream.id, archived: workstream.archivedAt == nil)
            if currentWorkstream?.id == workstream.id {
                openNewChat()
            }
            await loadWorkspaceContent()
        } catch {
            errorMessage = (error as? LocalizedError)?.errorDescription ?? "Couldn’t archive that work stream."
        }
    }

    func rename(_ workstream: RallyWorkstream, title: String) async {
        let trimmed = title.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !trimmed.isEmpty else { return }
        do {
            let updated = try await client.patchWorkstream(id: workstream.id, title: trimmed)
            if currentWorkstream?.id == workstream.id {
                currentWorkstream = updated
            }
            await loadWorkspaceContent()
        } catch {
            errorMessage = (error as? LocalizedError)?.errorDescription ?? "Couldn’t rename that work stream."
        }
    }

    func setScope(_ workstream: RallyWorkstream, scope: String) async {
        do {
            let updated = try await client.patchWorkstream(id: workstream.id, scope: scope)
            if currentWorkstream?.id == workstream.id {
                currentWorkstream = updated
            }
            await loadWorkspaceContent()
        } catch {
            errorMessage = (error as? LocalizedError)?.errorDescription ?? "Couldn’t change who can see that work stream."
        }
    }

    func addParticipant(userId: String) async {
        guard let id = currentWorkstream?.id else { return }
        do {
            try await client.addParticipant(workstreamId: id, userId: userId)
        } catch {
            errorMessage = (error as? LocalizedError)?.errorDescription ?? "Couldn’t add that person."
        }
    }

    func answerElicitation(_ elicitation: RallyElicitation, answer: String?, skipped: Bool) async {
        do {
            try await socket.answerElicitation(
                id: elicitation.id,
                answer: answer,
                skipped: skipped,
                operationId: UUID().uuidString
            )
        } catch {
            errorMessage = (error as? LocalizedError)?.errorDescription ?? "Couldn’t send that answer."
        }
    }

    func retryHarness() async {
        await socket.retry(operationId: UUID().uuidString)
        isStreaming = true
    }

    func loadOlder() async {
        let before = messages.compactMap(\.sequence).min() ?? 1
        guard before > 1 else {
            hasOlderTranscript = false
            return
        }
        await socket.loadOlder(requestId: UUID().uuidString, beforeSequence: before)
    }

    func jumpToLatest() {
        jumpToLatestToken += 1
    }

    func speak(_ message: RallyChatMessage) {
        if speakingMessageId == message.id {
            speaker.stopSpeaking(at: .immediate)
            speakingMessageId = nil
            return
        }
        speaker.stopSpeaking(at: .immediate)
        let utterance = AVSpeechUtterance(string: message.text)
        utterance.prefersAssistiveTechnologySettings = true
        speakingMessageId = message.id
        speaker.speak(utterance)
    }

    func search() async {
        let query = searchQuery.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !query.isEmpty else {
            searchHits = []
            return
        }
        do {
            searchHits = try await client.searchWorkspace(query: query)
        } catch {
            errorMessage = (error as? LocalizedError)?.errorDescription ?? "Search didn’t complete."
        }
    }

    func openSearchHit(_ hit: RallySearchHit) async {
        isSearchPresented = false
        if let id = hit.workstreamId {
            await open(workstream: RallyWorkstream(id: id, title: hit.title ?? "Work stream"))
        }
    }

    func open(project: RallyProject) {
        currentProject = project
        selectedTab = .projects
    }

    func createProject(name: String) async {
        let trimmed = name.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !trimmed.isEmpty else { return }
        do {
            let created = try await client.createProject(name: trimmed)
            projects.insert(created, at: 0)
            currentProject = created
        } catch {
            errorMessage = (error as? LocalizedError)?.errorDescription ?? "Couldn’t create that project."
        }
    }

    func open(note: RallyNote) async {
        do {
            currentNote = try await client.getNote(id: note.id)
            selectedTab = .notes
        } catch {
            currentNote = note
            selectedTab = .notes
        }
    }

    func createNote() async {
        do {
            let created = try await client.createNote(id: UUID().uuidString, title: "New note")
            notes.insert(created, at: 0)
            currentNote = created
            selectedTab = .notes
        } catch {
            errorMessage = (error as? LocalizedError)?.errorDescription ?? "Couldn’t create that note."
        }
    }

    func open(sidekick: RallySidekick) async {
        selectedTab = .chats
        await open(workstream: RallyWorkstream(id: sidekick.id, title: sidekick.name))
    }

    func createSidekick() async {
        do {
            let id = try await client.createSidekick()
            let created = RallySidekick(id: id, name: "New Sidekick", status: "draft")
            sidekicks.insert(created, at: 0)
            await open(sidekick: created)
        } catch {
            errorMessage = (error as? LocalizedError)?.errorDescription ?? "Couldn’t create that Sidekick."
        }
    }

    func saveDigest(_ next: RallyDigest) async {
        do {
            digest = try await client.updateDigest(next)
        } catch {
            errorMessage = (error as? LocalizedError)?.errorDescription ?? "Couldn’t save the digest."
        }
    }

    func workstreams(in project: RallyProject) -> [RallyWorkstream] {
        let ids = Set(project.workstreamIds)
        if ids.isEmpty { return [] }
        return workstreams.filter { ids.contains($0.id) || $0.projectId == project.id }
    }

    private func listenToWorkspaceSocket() async {
        do {
            let ticket = try await client.workspaceSocketTicket()
            workspaceListenTask?.cancel()
            let stream = await workspaceSocket.connect(ticket: ticket)
            workspaceListenTask = Task { await consumeWorkspace(stream) }
        } catch {
            // HTTP lists already painted the directory.
        }
    }

    private func consumeWorkspace(_ stream: AsyncStream<WorkspaceSocket.Incoming>) async {
        for await event in stream {
            switch event {
            case .sidebar(let sidebar):
                if let items = sidebar.workstreams?.items {
                    workstreams = items.filter { $0.archivedAt == nil && $0.systemKind == nil }
                }
                if let items = sidebar.notes?.items {
                    notes = items.filter { $0.archivedAt == nil }
                }
                if let items = sidebar.automations?.items {
                    sidekicks = items
                }
                if let active = sidebar.projects?.active?.items {
                    projects = active
                }
            case .closed:
                break
            }
        }
    }

    private func openUniversalLink(_ url: URL) async {
        if let workstreamId = RallyDeepLink.workstreamId(from: url) {
            if let match = workstreams.first(where: { $0.id == workstreamId }) {
                await open(workstream: match)
            } else {
                await open(workstream: RallyWorkstream(id: workstreamId, title: "Work stream"))
            }
            return
        }
        errorMessage = "This Rally view does not exist or is no longer available."
    }

    func requestPushAuthorization() async {
        let center = UNUserNotificationCenter.current()
        _ = try? await center.requestAuthorization(options: [.alert, .sound, .badge])
        await MainActor.run {
            UIApplication.shared.registerForRemoteNotifications()
        }
    }
}

enum ChatMapping {
    static func message(from turn: TranscriptTurn) -> RallyChatMessage? {
        FeedProjection.rows(from: turn).first { $0.kind == .text || $0.kind == .system || $0.kind == .elicitation }
    }
}

final class SignInPresenter: NSObject, ASWebAuthenticationPresentationContextProviding {
    static let shared = SignInPresenter()
    private var anchor: ASPresentationAnchor?

    func binding(_ anchor: ASPresentationAnchor) -> SignInPresenter {
        self.anchor = anchor
        return self
    }

    func presentationAnchor(for session: ASWebAuthenticationSession) -> ASPresentationAnchor {
        anchor ?? ASPresentationAnchor()
    }
}
