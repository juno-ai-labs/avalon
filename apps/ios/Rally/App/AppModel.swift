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
    var isHistoryPresented = false
    var isSettingsPresented = false
    var isVoicePresented = false
    var pendingAttachments: [PendingAttachment] = []
    var isConnectingConversation = false

    let keychain = KeychainStore()
    private var client = RallyClient()
    private var socket = ConversationSocket()
    private var listenTask: Task<Void, Never>?
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
        phase = .signedOut
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
        } catch let error as RallyAPIError where error.status == 401 {
            await recoverSession()
        } catch {
            errorMessage = (error as? LocalizedError)?.errorDescription
        }
    }

    func openNewChat() {
        currentWorkstream = nil
        messages = []
        isStreaming = false
        listenTask?.cancel()
        Task { await socket.disconnect() }
    }

    func open(workstream: RallyWorkstream) async {
        currentWorkstream = workstream
        isHistoryPresented = false
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
                    attachmentIds: resourceIds
                )
                currentWorkstream = created.workstream
                workstreams.insert(created.workstream, at: 0)
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
        messages = turns.compactMap { turn in
            guard let mapped = ChatMapping.message(from: turn), seen.insert(mapped.id).inserted else { return nil }
            return mapped
        }.sorted { $0.createdAt < $1.createdAt }
        isStreaming = messages.contains { $0.isStreaming }
        if let title = boot.title, var current = currentWorkstream {
            current.title = title
            currentWorkstream = current
        }
    }

    private func upsert(_ turn: TranscriptTurn) {
        guard let mapped = ChatMapping.message(from: turn) else { return }
        if let index = messages.firstIndex(where: { $0.id == mapped.id || ($0.clientMessageId != nil && $0.clientMessageId == mapped.clientMessageId) }) {
            messages[index] = mapped
        } else {
            messages.append(mapped)
        }
        isStreaming = messages.contains { $0.isStreaming }
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

    private func openUniversalLink(_ url: URL) async {
        guard let workstreamId = RallyDeepLink.workstreamId(from: url) else { return }
        if let match = workstreams.first(where: { $0.id == workstreamId }) {
            await open(workstream: match)
        } else {
            await open(workstream: RallyWorkstream(id: workstreamId, title: "Work stream"))
        }
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
        let text = (turn.blocks ?? []).compactMap(\.text).joined(separator: "\n")
        let streaming = turn.blocks?.contains { $0.streaming == true } ?? false
        let role: RallyChatMessage.Role
        switch turn.actor {
        case "human": role = .user
        case "assistant": role = .assistant
        default: role = .system
        }
        let created = turn.createdAtUtc.flatMap { ISO8601DateFormatter.fractional.date(from: $0) ?? ISO8601DateFormatter.full.date(from: $0) } ?? Date()
        let id = turn.turnId ?? UUID().uuidString
        return RallyChatMessage(
            id: id,
            role: role,
            text: text,
            createdAt: created,
            isStreaming: streaming,
            clientMessageId: turn.clientMessageId,
            sequence: turn.transcriptSequence
        )
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
