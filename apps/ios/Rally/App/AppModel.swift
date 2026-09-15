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
    var sidekicks: [RallySidekick] = []
    var members: [RallyMember] = []
    var searchHits: [RallySearchHit] = []
    var searchQuery = ""
    var searchNextCursor: String?
    var isFetchingMoreSearch = false
    var workstreamNextCursor: String?
    var workstreamHasPagedPastFirst = false
    var isFetchingMoreWorkstreams = false
    var isLoadingOlder = false
    var selectedTab: MainTab = .chats
    var speakingMessageId: String?
    var firstUnreadSequence: Int?
    var hasOlderTranscript = false
    var jumpToLatestToken = 0
    var digest: RallyDigest?
    var accountPresentation: RallyPersonalPresentation?

    var accountAvatarName: String {
        workspaceSession?.user.name ?? identitySession?.user.name ?? "Rally"
    }

    var accountAvatarPresentation: RallyPersonalPresentation? {
        accountPresentation
            ?? workspaceSession?.user.presentation
            ?? identitySession?.user.presentation
    }

    enum MainTab: String, CaseIterable, Identifiable {
        case chats, sidekicks
        var id: String { rawValue }
    }

    enum ChatRoute: Hashable {
        case substreams(workstreamId: String)
        case conversation(workstreamId: String, substreamId: String)
        case compose
    }

    var chatPath: [ChatRoute] = []
    var isSettingsPresented = false
    var isSearchPresented = false
    var isInspectorPresented = false
    var isVoicePresented = false
    var pendingAttachments: [PendingAttachment] = []
    var isConnectingConversation = false
    private var conversationLoadToken = UUID()
    var currentSubstreamId = SubstreamAddress.main
    var privateChildren: [RallyPrivateChild] = []
    var openChildTitle: String?
    var substreamLaunch: SubstreamCreationAttempt?
    var launchProvenance: [RallyChatMessage] = []
    var isCreatingSubstream = false
    var reservedChildId: String?
    var launchError: String?
    var hasChildDirectory = false

    private var preparedOnServer = false
    private var warmedFeeds: Set<RallyFeedKey> = []
    private var warmTasks: [RallyFeedKey: Task<Void, Never>] = [:]

    let keychain = KeychainStore()
    private var client = RallyClient()
    private let pool = RallySocketPool()
    private let speaker = AVSpeechSynthesizer()
    private var pkce: PKCEChallenge?
    private var authSession: ASWebAuthenticationSession?

    init() {
        pool.onWorkspace = { [weak self] sidebar in
            self?.applyWorkspaceSidebar(sidebar)
        }
        pool.onWorkstreamRecency = { [weak self] workstream in
            self?.applyWorkstreamRecency(workstream)
        }
        pool.onControl = { [weak self] parentId, metadata in
            self?.apply(control: metadata, parentId: parentId)
        }
        pool.onFeed = { [weak self] key, event in
            self?.handleFeed(key, event)
        }
    }

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

#if RALLY_DEBUG
    func startLocalDevelopmentSession(workspaceName: String = "Rally Development") async {
        errorMessage = nil
        do {
            let global = APIConfiguration.globalURL()
            await client.update(baseURL: global, accessToken: nil)
            let workspace = try await client.createDevelopmentWorkspaceSession(workspaceName: workspaceName)
            let identity = try await client.createDevelopmentIdentitySession()
            try Self.validateDevelopmentSessions(workspace: workspace, identity: identity, expectedGlobalURL: global)
            identitySession = identity
            try persist(identity, account: SessionAccounts.identity)
            guard let url = URL(string: workspace.apiBaseUrl) else {
                throw RallyAPIError(status: 502, code: "missing_api", message: "The development session did not return an API URL.")
            }
            workspaceSession = workspace
            try persist(workspace, account: SessionAccounts.workspace)
            await client.update(baseURL: url, accessToken: workspace.accessToken)
            phase = .ready
            await loadWorkspaceContent()
        } catch {
            errorMessage = (error as? LocalizedError)?.errorDescription
                ?? "Couldn’t use the local development account. Point the Global API at http://127.0.0.1:8787."
        }
    }

    nonisolated static func validateDevelopmentSessions(
        workspace: RallySession,
        identity: RallySession,
        expectedGlobalURL: URL
    ) throws {
        guard workspace.workspace != nil else {
            throw RallyAPIError(status: 502, code: "dev_session_mismatch", message: "The development session did not include a workspace.")
        }
        guard identity.workspace == nil else {
            throw RallyAPIError(status: 502, code: "dev_identity_mismatch", message: "The development identity session included a workspace.")
        }
        guard Self.sameAPIOrigin(expectedGlobalURL, workspace.apiBaseUrl),
              Self.sameAPIOrigin(expectedGlobalURL, identity.apiBaseUrl) else {
            throw RallyAPIError(
                status: 502,
                code: "dev_endpoint_mismatch",
                message: "The development session returned a mismatched API URL."
            )
        }
        guard identity.user.email.localizedLowercase == workspace.user.email.localizedLowercase else {
            throw RallyAPIError(status: 502, code: "dev_identity_mismatch", message: "The development identity did not match the workspace account.")
        }
    }

    nonisolated private static func sameAPIOrigin(_ expected: URL, _ raw: String) -> Bool {
        guard let actual = URL(string: raw) else { return false }
        return expected.scheme == actual.scheme
            && expected.host == actual.host
            && expected.port == actual.port
    }
#endif

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
        resetCreation()
        await pool.disconnectAll()
        pool.clearSnapshots()
        await client.logout(refreshToken: workspaceSession?.refreshToken ?? identitySession?.refreshToken)
        try? keychain.delete(account: SessionAccounts.identity)
        try? keychain.delete(account: SessionAccounts.workspace)
        identitySession = nil
        workspaceSession = nil
        accountPresentation = nil
        workstreams = []
        workstreamNextCursor = nil
        workstreamHasPagedPastFirst = false
        isFetchingMoreWorkstreams = false
        searchHits = []
        searchNextCursor = nil
        clearWarmedFeeds()
        messages = []
        currentWorkstream = nil
        chatPath = []
        sidekicks = []
        phase = .signedOut
    }

    func leaveCurrentWorkspace() async {
        guard let workspace = workspaceSession?.workspace else { return }
        do {
            try await client.leaveWorkspace(workspaceId: workspace.id, expectedOutcome: "left")
            try? keychain.delete(account: SessionAccounts.workspace)
            workspaceSession = nil
            chatPath = []
            await pool.disconnectAll()
            pool.clearSnapshots()
            tearDownConversation()
            await client.update(baseURL: APIConfiguration.globalURL(), accessToken: identitySession?.accessToken)
            onboarding = try await client.onboardingState()
            phase = .pickingWorkspace
        } catch {
            errorMessage = (error as? LocalizedError)?.errorDescription ?? "Couldn’t leave this workspace."
        }
    }

    // MARK: Directory + conversation

    func loadWorkspaceContent() async {
        // Identity presentation is Global HTTP, not a workspace socket field.
        async let account = fetchAccountOnboarding()
        // Members, digest, and suggested-work chips are not on the workspace
        // connect payload yet — see choosing-sockets-or-rest.md known
        // divergence. The directory and Sidekicks come down subscribe.
        async let chips = client.workOpportunities()
        async let listedMembers = client.listMembers()
        async let nextDigest = client.getDigest()
        await syncPool()
        opportunities = (try? await chips) ?? []
        members = (try? await listedMembers) ?? []
        digest = try? await nextDigest
        if let fetched = await account {
            accountPresentation = fetched.presentation
        } else if accountPresentation == nil,
                  let userId = workspaceSession?.user.id ?? identitySession?.user.id {
            accountPresentation = members.first(where: { $0.id == userId })?.presentation
        }
    }

    private func fetchAccountOnboarding() async -> RallyAccountOnboarding? {
        guard let token = identitySession?.accessToken else { return nil }
        return try? await client.getAccountOnboarding(accessToken: token)
    }

    func openNewChat() {
        selectedTab = .chats
        tearDownConversation()
        setChatPath([.compose])
        Task { await syncPool() }
    }

    func revealSubstreams(_ workstream: RallyWorkstream) {
        selectedTab = .chats
        let switchingParent = currentWorkstream?.id != workstream.id
        currentWorkstream = workstream
        if switchingParent {
            privateChildren = []
            hasChildDirectory = false
            openChildTitle = nil
            currentSubstreamId = SubstreamAddress.main
        }
        setChatPath([.substreams(workstreamId: workstream.id)])
        resetCreation()
        messages = []
        isStreaming = false
        hasOlderTranscript = false
        isConnectingConversation = false
        Task { await syncPool() }
    }

    func open(workstream: RallyWorkstream, substreamId: String = SubstreamAddress.main) {
        let switchingParent = currentWorkstream?.id != workstream.id
        resetCreation()
        currentWorkstream = workstream
        selectedTab = .chats
        if switchingParent {
            privateChildren = []
            hasChildDirectory = false
            openChildTitle = nil
        }
        currentSubstreamId = substreamId.isEmpty ? SubstreamAddress.main : substreamId
        beginFeed(workstreamId: workstream.id, substreamId: currentSubstreamId)
        if canUseSubstreams {
            setChatPath([
                .substreams(workstreamId: workstream.id),
                .conversation(workstreamId: workstream.id, substreamId: currentSubstreamId),
            ])
        } else {
            setChatPath([.conversation(workstreamId: workstream.id, substreamId: currentSubstreamId)])
        }
        Task { await loadConversation(id: workstream.id, substreamId: currentSubstreamId) }
    }

    var canUseSubstreams: Bool {
        guard let current = currentWorkstream else { return false }
        if sidekicks.contains(where: { $0.id == current.id }) { return false }
        return current.systemKind == nil
    }

    var conversationTitle: String {
        if substreamLaunch != nil { return "New substream" }
        if currentSubstreamId == SubstreamAddress.main {
            return currentWorkstream?.title ?? "Main"
        }
        if let openChildTitle, !openChildTitle.isEmpty { return openChildTitle }
        return privateChildren.first(where: { $0.substreamId == currentSubstreamId })?.title ?? "Substream"
    }

    var displayedChildren: [RallyPrivateChild] {
        var rows = privateChildren
        if let reservedChildId,
           isCreatingSubstream,
           !rows.contains(where: { $0.substreamId == reservedChildId }) {
            rows.append(RallyPrivateChild(substreamId: reservedChildId, title: "New substream"))
        }
        if currentSubstreamId != SubstreamAddress.main,
           let openChildTitle,
           let index = rows.firstIndex(where: { $0.substreamId == currentSubstreamId }) {
            rows[index].title = openChildTitle
        }
        return rows
    }

    func selectSubstream(_ substreamId: String) {
        guard let parent = currentWorkstream else { return }
        resetCreation()
        currentSubstreamId = substreamId
        openChildTitle = nil
        warmedFeeds.insert(RallyFeedKey(parentId: parent.id, substreamId: substreamId))
        beginFeed(workstreamId: parent.id, substreamId: substreamId)
        showConversationRoute(workstreamId: parent.id, substreamId: substreamId)
        Task { await loadConversation(id: parent.id, substreamId: substreamId) }
    }

    func startSubstream(throughTurnId: String?) {
        guard canUseSubstreams, let parent = currentWorkstream else { return }
        let alreadyOnFeed = if case .conversation = chatPath.last { true } else { false }
        resetCreation()
        launchProvenance = FeedProjection.branchProvenance(messages: messages, throughTurnId: throughTurnId)
        substreamLaunch = SubstreamCreationAttempt(
            parentId: parent.id,
            throughTurnId: throughTurnId,
            operationId: UUID().uuidString,
            clientMessageId: UUID().uuidString
        )
        composerText = ""
        if !alreadyOnFeed {
            setChatPath(chatPath + [.conversation(workstreamId: parent.id, substreamId: SubstreamAddress.main)])
        }
    }

    func cancelSubstreamLaunch() {
        let launchedFromList = messages.isEmpty
        resetCreation()
        if launchedFromList, case .conversation = chatPath.last, chatPath.count > 1 {
            setChatPath(Array(chatPath.dropLast()))
        }
    }

    func submitSubstreamLaunch() async {
        let text = composerText.trimmingCharacters(in: .whitespacesAndNewlines)
        let attachments = pendingAttachments
        guard let attempt = substreamLaunch else { return }
        guard !text.isEmpty || !attachments.isEmpty else { return }
        guard text.count <= APIConfiguration.messageMaxCharacters else {
            errorMessage = "This message is over 100,000 characters, please shorten it."
            return
        }
        composerText = ""
        isCreatingSubstream = true
        isSending = true
        launchError = nil
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
            let prepared = try await client.prepareSubstream(
                parentId: attempt.parentId,
                operationId: attempt.operationId,
                throughTurnId: attempt.throughTurnId
            )
            if substreamLaunch == attempt {
                preparedOnServer = true
                reservedChildId = prepared.substreamId
            }
            let created = try await client.confirmSubstream(
                parentId: attempt.parentId,
                operationId: attempt.operationId,
                clientMessageId: attempt.clientMessageId,
                text: text,
                attachmentIds: resourceIds
            )
            guard substreamLaunch == attempt else { return }
            preparedOnServer = false
            if !created.title.isEmpty {
                openChildTitle = created.title
            }
            if !privateChildren.contains(where: { $0.substreamId == created.substreamId }) {
                privateChildren.append(RallyPrivateChild(substreamId: created.substreamId, title: created.title))
            }
            resetCreation(cancelPrepared: false)
            currentSubstreamId = created.substreamId
            showConversationRoute(workstreamId: attempt.parentId, substreamId: created.substreamId)
            messages = [
                RallyChatMessage(
                    id: created.opening?.turnId ?? attempt.clientMessageId,
                    role: .user,
                    text: text,
                    createdAt: Date(),
                    isStreaming: false,
                    clientMessageId: attempt.clientMessageId,
                    turnId: created.opening?.turnId
                ),
            ]
            isStreaming = true
            rememberVisibleFeed(RallyFeedKey(parentId: attempt.parentId, substreamId: created.substreamId))
            await syncPool()
        } catch {
            if substreamLaunch == attempt {
                composerText = text
                isCreatingSubstream = false
                launchError = (error as? LocalizedError)?.errorDescription ?? "The substream could not be created."
            }
        }
        isSending = false
    }

    func renameCurrentConversation(title: String) async {
        let trimmed = title.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !trimmed.isEmpty, let parent = currentWorkstream else { return }
        if currentSubstreamId == SubstreamAddress.main {
            await rename(parent, title: trimmed)
            return
        }
        do {
            try await client.renameSubstream(parentId: parent.id, substreamId: currentSubstreamId, title: trimmed)
            openChildTitle = trimmed
            if let index = privateChildren.firstIndex(where: { $0.substreamId == currentSubstreamId }) {
                privateChildren[index].title = trimmed
            }
        } catch {
            errorMessage = (error as? LocalizedError)?.errorDescription ?? "That substream could not be renamed."
        }
    }

    func renameChild(_ child: RallyPrivateChild, title: String) async {
        let trimmed = title.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !trimmed.isEmpty, let parent = currentWorkstream else { return }
        do {
            try await client.renameSubstream(parentId: parent.id, substreamId: child.substreamId, title: trimmed)
            if let index = privateChildren.firstIndex(where: { $0.substreamId == child.substreamId }) {
                privateChildren[index].title = trimmed
            }
            if currentSubstreamId == child.substreamId {
                openChildTitle = trimmed
            }
        } catch {
            errorMessage = (error as? LocalizedError)?.errorDescription ?? "That substream could not be renamed."
        }
    }

    func archiveChild(_ child: RallyPrivateChild) async {
        guard let parent = currentWorkstream else { return }
        do {
            try await client.setSubstreamArchived(parentId: parent.id, substreamId: child.substreamId, archived: true)
            privateChildren.removeAll { $0.substreamId == child.substreamId }
            if currentSubstreamId == child.substreamId {
                selectSubstream(SubstreamAddress.main)
            }
        } catch {
            errorMessage = (error as? LocalizedError)?.errorDescription ?? "That substream could not be archived."
        }
    }

    func copyConversationLink(substreamId: String) {
        guard let workspace = workspaceSession?.workspace,
              let workstreamId = currentWorkstream?.id,
              let url = RallyDeepLink.canonicalURL(
                region: workspace.region,
                workspaceId: workspace.id,
                workstreamId: workstreamId,
                substreamId: substreamId
              ) else { return }
        UIPasteboard.general.string = url.absoluteString
    }

    func send() async {
        let text = composerText.trimmingCharacters(in: .whitespacesAndNewlines)
        let attachments = pendingAttachments
        guard !text.isEmpty || !attachments.isEmpty else { return }
        if substreamLaunch != nil {
            await submitSubstreamLaunch()
            return
        }
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
                try await syncPool()
                guard let socket = pool.feedSocket(for: RallyFeedKey(parentId: current.id, substreamId: currentSubstreamId)) else {
                    throw RallyAPIError(status: 503, code: "socket_unavailable", message: "That message didn’t send.")
                }
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
                currentSubstreamId = SubstreamAddress.main
                workstreams.insert(created.workstream, at: 0)
                setChatPath([
                    .substreams(workstreamId: created.workstream.id),
                    .conversation(workstreamId: created.workstream.id, substreamId: SubstreamAddress.main),
                ])
                await loadConversation(id: created.workstream.id, substreamId: SubstreamAddress.main)
                isStreaming = true
            }
        } catch {
            errorMessage = (error as? LocalizedError)?.errorDescription ?? "That message didn’t send."
            isStreaming = false
        }
        isSending = false
    }

    func stopGeneration() async {
        if let current = currentWorkstream {
            await pool.feedSocket(for: RallyFeedKey(parentId: current.id, substreamId: currentSubstreamId))?
                .stop(operationId: UUID().uuidString)
        }
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

    private func loadConversation(id: String, substreamId: String) async {
        let key = RallyFeedKey(parentId: id, substreamId: substreamId)
        if let snapshot = pool.snapshot(for: key) {
            present(snapshot, parentId: id, substreamId: substreamId)
        } else {
            messages = []
            isStreaming = false
            hasOlderTranscript = false
            isConnectingConversation = true
        }
        await syncPool()
    }

    private var visibleSubstreamId: String? {
        guard currentWorkstream != nil else { return nil }
        if case .conversation = chatPath.last { return currentSubstreamId }
        return nil
    }

    private func currentRetainSet() -> RallySocketRetainSet {
        RallySocketPolicy.retainSet(
            workspaceReady: phase == .ready && workspaceSession != nil,
            parentId: currentWorkstream?.id,
            visibleSubstreamId: visibleSubstreamId,
            canUseSubstreams: canUseSubstreams,
            warmedFeeds: warmedFeeds
        )
    }

    private func syncPool() async {
        await pool.apply(currentRetainSet(), client: client)
    }

    func resumeSockets() async {
        guard phase == .ready else { return }
        await syncPool()
    }

    private func applyWorkspaceSidebar(_ sidebar: WorkspaceSocket.WorkspaceSidebar) {
        if let page = sidebar.workstreams {
            let incoming = Self.directoryWorkstreams(page.items ?? [])
            workstreams = RallyPagedDirectory.applySubscribePage(
                existing: workstreams,
                incoming: incoming,
                nextCursor: page.nextCursor
            )
            if page.nextCursor == nil {
                workstreamNextCursor = nil
                workstreamHasPagedPastFirst = false
            } else if !workstreamHasPagedPastFirst {
                workstreamNextCursor = page.nextCursor
            }
        }
        if let items = sidebar.automations?.items {
            sidekicks = items
        }
        Task { await self.refreshLiveDirectory() }
    }

    private func applyWorkstreamRecency(_ workstream: RallyWorkstream) {
        if workstream.archivedAt != nil || workstream.systemKind != nil {
            workstreams.removeAll { $0.id == workstream.id }
            return
        }
        workstreams = RallyPagedDirectory.upsert(existing: workstreams, item: workstream)
    }

    func fetchMoreWorkstreams() async {
        guard let cursor = workstreamNextCursor, !isFetchingMoreWorkstreams else { return }
        isFetchingMoreWorkstreams = true
        defer { isFetchingMoreWorkstreams = false }
        let page: RallyWorkstreamPage
        if let socketPage = await pool.listWorkstreams(before: cursor) {
            page = RallyWorkstreamPage(items: socketPage.items, nextCursor: socketPage.nextCursor)
        } else {
            return
        }
        let incoming = Self.directoryWorkstreams(page.items)
        let beforeCount = workstreams.count
        workstreams = RallyPagedDirectory.appendPage(existing: workstreams, incoming: incoming)
        workstreamNextCursor = workstreams.count > beforeCount ? page.nextCursor : nil
        workstreamHasPagedPastFirst = true
    }

    func refreshLiveDirectory() async {
        // workspace_sync still invalidates these surfaces rather than carrying
        // them; choosing-sockets-or-rest.md records that Worker gap.
        if let listed = try? await client.listMembers() {
            members = listed
        }
        if let chips = try? await client.workOpportunities() {
            opportunities = chips
        }
        if let next = try? await client.getDigest() {
            digest = next
        }
    }

    private static func directoryWorkstreams(_ items: [RallyWorkstream]) -> [RallyWorkstream] {
        items.filter { $0.archivedAt == nil && $0.systemKind == nil }
    }

    func appearDirectoryFeed(
        parentId: String,
        substreamId: String = SubstreamAddress.main,
        warmupSeconds: TimeInterval = RallySocketPolicy.hoverWarmupSeconds
    ) {
        let key = RallyFeedKey(parentId: parentId, substreamId: substreamId)
        warmTasks[key]?.cancel()
        if warmupSeconds <= 0 {
            warmedFeeds.insert(key)
            Task { await syncPool() }
            return
        }
        warmTasks[key] = Task { [weak self] in
            try? await Task.sleep(for: .seconds(warmupSeconds))
            guard !Task.isCancelled, let self else { return }
            self.warmedFeeds.insert(key)
            self.warmTasks[key] = nil
            await self.syncPool()
        }
    }

    func disappearDirectoryFeed(parentId: String, substreamId: String = SubstreamAddress.main) {
        let key = RallyFeedKey(parentId: parentId, substreamId: substreamId)
        warmTasks[key]?.cancel()
        warmTasks[key] = nil
        if visibleFeedKey() == key { return }
        warmedFeeds.remove(key)
    }

    private func clearWarmedFeeds() {
        for task in warmTasks.values { task.cancel() }
        warmTasks.removeAll()
        warmedFeeds.removeAll()
    }

    private func handleFeed(_ key: RallyFeedKey, _ event: ConversationSocket.Incoming) {
        let visible = visibleFeedKey()
        switch event {
        case .snapshot(let boot):
            let snapshot = snapshot(from: boot)
            pool.storeSnapshot(snapshot, for: key)
            if key == visible { present(snapshot, parentId: key.parentId, substreamId: key.substreamId) }
        case .turnUpserted(let turn):
            if key == visible {
                upsert(turn)
                rememberVisibleFeed(key)
            } else {
                upsert(turn, into: key)
            }
        case .olderTurns(let turns, let coveredStart):
            isLoadingOlder = false
            if key == visible {
                prepend(turns, coveredStartInclusive: coveredStart)
                rememberVisibleFeed(key)
            } else {
                prepend(turns, into: key, coveredStartInclusive: coveredStart)
            }
        case .commandSucceeded:
            break
        case .commandFailed(let message):
            let wasLoadingOlder = isLoadingOlder
            isLoadingOlder = false
            if key == visible, !wasLoadingOlder {
                errorMessage = message
                isStreaming = false
            }
        case .resyncRequired:
            isLoadingOlder = false
            if key == visible {
                Task { await pool.feedSocket(for: key)?.requestSnapshot() }
            }
        case .closed:
            isLoadingOlder = false
            if key == visible { isStreaming = false }
        }
    }

    private func visibleFeedKey() -> RallyFeedKey? {
        guard let parentId = currentWorkstream?.id, let substreamId = visibleSubstreamId else { return nil }
        return RallyFeedKey(parentId: parentId, substreamId: substreamId)
    }

    private func snapshot(from boot: ConversationBoot) -> RallyFeedSnapshot {
        let turns = (boot.transcript?.ranges ?? []).flatMap { $0.turns ?? [] } + (boot.transcript?.activeTurns ?? [])
        var seen = Set<String>()
        let rows = FeedProjection.rows(from: turns).filter { seen.insert($0.id).inserted }
            .sorted { ($0.sequence ?? 0, $0.createdAt) < ($1.sequence ?? 0, $1.createdAt) }
        return RallyFeedSnapshot(
            messages: FeedProjection.collapseSettledWork(rows),
            title: boot.title,
            hasOlderTranscript: (rows.compactMap(\.sequence).min() ?? 1) > 1,
            snapshotId: boot.transcript?.snapshotId,
            eventSequence: boot.transcript?.eventSequence ?? 0
        )
    }

    private func present(_ snapshot: RallyFeedSnapshot, parentId: String, substreamId: String) {
        messages = snapshot.messages
        isStreaming = snapshot.messages.contains { $0.isStreaming }
        hasOlderTranscript = snapshot.hasOlderTranscript
        isConnectingConversation = false
        if let title = snapshot.title {
            if substreamId == SubstreamAddress.main, var current = currentWorkstream, current.id == parentId {
                current.title = title
                currentWorkstream = current
            } else if substreamId != SubstreamAddress.main {
                openChildTitle = title
            }
        }
    }

    private func rememberVisibleFeed(_ key: RallyFeedKey) {
        let existing = pool.snapshot(for: key)
        pool.storeSnapshot(
            RallyFeedSnapshot(
                messages: messages,
                title: openChildTitle ?? currentWorkstream?.title,
                hasOlderTranscript: hasOlderTranscript,
                snapshotId: existing?.snapshotId,
                eventSequence: existing?.eventSequence ?? 0
            ),
            for: key
        )
    }

    private func upsert(_ turn: TranscriptTurn, into key: RallyFeedKey) {
        var snapshot = pool.snapshot(for: key) ?? RallyFeedSnapshot(messages: [], title: nil, hasOlderTranscript: false)
        let mapped = FeedProjection.rows(from: turn)
        for row in mapped {
            if let index = snapshot.messages.firstIndex(where: { $0.id == row.id || ($0.clientMessageId != nil && $0.clientMessageId == row.clientMessageId) }) {
                snapshot.messages[index] = row
            } else {
                snapshot.messages.append(row)
            }
        }
        snapshot.messages = FeedProjection.collapseSettledWork(snapshot.messages)
        pool.storeSnapshot(snapshot, for: key)
    }

    private func apply(control metadata: RallyWorkstreamControlMetadata, parentId: String) {
        guard currentWorkstream?.id == parentId else { return }
        if let title = metadata.title, var current = currentWorkstream {
            current.title = title
            currentWorkstream = current
        }
        if let scope = metadata.scope, var current = currentWorkstream {
            current.scope = scope
            currentWorkstream = current
        }
        if let appearance = metadata.appearance, var current = currentWorkstream {
            current.appearance = appearance
            currentWorkstream = current
        }
        let previousIds = Set(privateChildren.map(\.substreamId))
        privateChildren = metadata.privateChildren ?? []
        hasChildDirectory = true
        if currentSubstreamId != SubstreamAddress.main,
           previousIds.contains(currentSubstreamId),
           !privateChildren.contains(where: { $0.substreamId == currentSubstreamId }) {
            Task { selectSubstream(SubstreamAddress.main) }
        }
    }

    private func resetSubstreamChrome() {
        currentSubstreamId = SubstreamAddress.main
        privateChildren = []
        openChildTitle = nil
        hasChildDirectory = false
        reservedChildId = nil
        launchProvenance = []
        launchError = nil
    }

    func chatPathDidChange(from old: [ChatRoute], to new: [ChatRoute]) {
        if new.count < old.count {
            switch new.last {
            case nil:
                tearDownConversation()
            case .substreams:
                tearDownFeedOnly()
            case .conversation, .compose:
                break
            }
            Task { await syncPool() }
            return
        }

        switch new.last {
        case .substreams(let workstreamId):
            adoptParent(workstreamId)
            Task { await syncPool() }
        case .conversation(let workstreamId, let substreamId):
            adoptParent(workstreamId)
            if substreamLaunch != nil {
                Task { await syncPool() }
                return
            }
            currentSubstreamId = substreamId
            beginFeed(workstreamId: workstreamId, substreamId: substreamId)
            Task { await loadConversation(id: workstreamId, substreamId: substreamId) }
        case .compose, nil:
            break
        }
    }

    private func adoptParent(_ workstreamId: String) {
        guard currentWorkstream?.id != workstreamId else { return }
        resetCreation()
        messages = []
        isStreaming = false
        hasOlderTranscript = false
        isConnectingConversation = false
        privateChildren = []
        hasChildDirectory = false
        openChildTitle = nil
        currentSubstreamId = SubstreamAddress.main
        if let stream = workstreams.first(where: { $0.id == workstreamId }) {
            currentWorkstream = stream
        } else if let sidekick = sidekicks.first(where: { $0.id == workstreamId }) {
            currentWorkstream = RallyWorkstream(id: sidekick.id, title: sidekick.name)
        } else {
            currentWorkstream = RallyWorkstream(
                id: workstreamId,
                title: currentWorkstream?.title ?? "Work stream"
            )
        }
    }

    private func beginFeed(workstreamId: String, substreamId: String) {
        conversationLoadToken = UUID()
        let key = RallyFeedKey(parentId: workstreamId, substreamId: substreamId)
        if let snapshot = pool.snapshot(for: key) {
            present(snapshot, parentId: workstreamId, substreamId: substreamId)
        } else {
            messages = []
            isStreaming = false
            hasOlderTranscript = false
            isConnectingConversation = true
        }
    }

    private func showConversationRoute(workstreamId: String, substreamId: String) {
        let route = ChatRoute.conversation(workstreamId: workstreamId, substreamId: substreamId)
        var path = chatPath
        if let index = path.lastIndex(where: {
            if case .conversation = $0 { return true }
            if case .compose = $0 { return true }
            return false
        }) {
            path[index] = route
        } else {
            path.append(route)
        }
        setChatPath(path)
    }

    /// Path changes skip the navigation animation so the destination's first
    /// frame is the skeleton (or cached snapshot), not the end of a zoom.
    private func setChatPath(_ path: [ChatRoute]) {
        var transaction = Transaction()
        transaction.disablesAnimations = true
        withTransaction(transaction) {
            chatPath = path
        }
    }

    private func tearDownFeedOnly() {
        conversationLoadToken = UUID()
        resetCreation()
        messages = []
        isStreaming = false
        hasOlderTranscript = false
        isLoadingOlder = false
        isConnectingConversation = false
        currentSubstreamId = SubstreamAddress.main
        openChildTitle = nil
    }

    private func tearDownConversation() {
        tearDownFeedOnly()
        currentWorkstream = nil
        resetSubstreamChrome()
    }

    private func resetCreation(cancelPrepared: Bool = true) {
        let abandoned = (cancelPrepared && preparedOnServer) ? substreamLaunch : nil
        preparedOnServer = false
        substreamLaunch = nil
        isCreatingSubstream = false
        reservedChildId = nil
        launchError = nil
        launchProvenance = []
        if let abandoned {
            Task { await client.cancelSubstream(parentId: abandoned.parentId, operationId: abandoned.operationId) }
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

    private func prepend(_ turns: [TranscriptTurn], coveredStartInclusive: Int) {
        let incoming = FeedProjection.rows(from: turns)
        var seen = Set(messages.map(\.id))
        let unique = incoming.filter { seen.insert($0.id).inserted }
        messages = FeedProjection.collapseSettledWork(unique + messages)
        hasOlderTranscript = coveredStartInclusive > 1
    }

    private func prepend(_ turns: [TranscriptTurn], into key: RallyFeedKey, coveredStartInclusive: Int) {
        var snapshot = pool.snapshot(for: key) ?? RallyFeedSnapshot(messages: [], title: nil, hasOlderTranscript: false)
        let incoming = FeedProjection.rows(from: turns)
        var seen = Set(snapshot.messages.map(\.id))
        let unique = incoming.filter { seen.insert($0.id).inserted }
        snapshot.messages = FeedProjection.collapseSettledWork(unique + snapshot.messages)
        snapshot.hasOlderTranscript = coveredStartInclusive > 1
        pool.storeSnapshot(snapshot, for: key)
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
                chatPath = []
                tearDownConversation()
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
        guard let current = currentWorkstream,
              let socket = pool.feedSocket(for: RallyFeedKey(parentId: current.id, substreamId: currentSubstreamId)) else { return }
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
        guard let current = currentWorkstream else { return }
        await pool.feedSocket(for: RallyFeedKey(parentId: current.id, substreamId: currentSubstreamId))?
            .retry(operationId: UUID().uuidString)
        isStreaming = true
    }

    func loadOlder() async {
        guard !isLoadingOlder else { return }
        let before = messages.compactMap(\.sequence).min() ?? 1
        guard let range = RallyPagedDirectory.olderTranscriptRange(oldestLoadedSequence: before) else {
            hasOlderTranscript = false
            return
        }
        guard let current = currentWorkstream else { return }
        let key = RallyFeedKey(parentId: current.id, substreamId: currentSubstreamId)
        guard let socket = pool.feedSocket(for: key),
              let snapshotId = pool.snapshot(for: key)?.snapshotId
        else { return }
        let eventSequence = pool.snapshot(for: key)?.eventSequence ?? 0
        isLoadingOlder = true
        do {
            try await socket.loadOlder(
                requestId: UUID().uuidString,
                snapshotId: snapshotId,
                startInclusive: range.startInclusive,
                endExclusive: range.endExclusive,
                resumeAfterEventSequence: eventSequence
            )
        } catch {
            isLoadingOlder = false
        }
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
            searchNextCursor = nil
            return
        }
        do {
            let page = try await client.searchWorkspace(query: query)
            searchHits = page.results
            searchNextCursor = page.nextCursor
        } catch {
            errorMessage = (error as? LocalizedError)?.errorDescription ?? "Search didn’t complete."
        }
    }

    func fetchMoreSearch() async {
        let query = searchQuery.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !query.isEmpty, let cursor = searchNextCursor, !isFetchingMoreSearch else { return }
        isFetchingMoreSearch = true
        defer { isFetchingMoreSearch = false }
        do {
            let page = try await client.searchWorkspace(query: query, cursor: cursor)
            searchHits = RallyPagedDirectory.appendPage(existing: searchHits, incoming: page.results)
            searchNextCursor = page.nextCursor
        } catch {
            errorMessage = (error as? LocalizedError)?.errorDescription ?? "Search didn’t complete."
        }
    }

    func openSearchHit(_ hit: RallySearchHit) {
        isSearchPresented = false
        if let id = hit.workstreamId {
            open(
                workstream: RallyWorkstream(id: id, title: hit.title ?? "Work stream"),
                substreamId: hit.substreamId ?? SubstreamAddress.main
            )
        }
    }

    func open(sidekick: RallySidekick) {
        selectedTab = .chats
        open(workstream: RallyWorkstream(id: sidekick.id, title: sidekick.name))
    }

    func createSidekick() async {
        do {
            let id = try await client.createSidekick()
            let created = RallySidekick(id: id, name: "New Sidekick", status: "draft")
            sidekicks.insert(created, at: 0)
            open(sidekick: created)
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

    private func openUniversalLink(_ url: URL) async {
        if let target = RallyDeepLink.workstreamTarget(from: url) {
            if let match = workstreams.first(where: { $0.id == target.workstreamId }) {
                open(workstream: match, substreamId: target.substreamId)
            } else {
                open(workstream: RallyWorkstream(id: target.workstreamId, title: "Work stream"), substreamId: target.substreamId)
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
