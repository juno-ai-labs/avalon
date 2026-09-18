import AuthenticationServices
import SwiftUI

struct SignInView: View {
    @Environment(AppModel.self) private var model
    @Environment(\.rallyColors) private var colors
    @State private var anchor: ASPresentationAnchor?
    @State private var showIntro = true

    var body: some View {
        ZStack {
            colors.canvas.ignoresSafeArea()
            WindowAnchorView { anchor = $0 }
            VStack(spacing: 28) {
                Spacer()
                RallyMark()
                    .frame(width: 64, height: 64)
                    .accessibilityHidden(true)
                Text("Rally")
                    .font(RallyType.screenTitle())
                    .foregroundStyle(colors.textPrimary)
                    .accessibilityAddTraits(.isHeader)
                Text("Work streams, not inboxes.")
                    .font(RallyType.body())
                    .foregroundStyle(colors.textSecondary)
                    .multilineTextAlignment(.center)
                    .padding(.horizontal, 32)
                Spacer()
                Button {
                    guard let anchor else { return }
                    Task { await model.startGoogleSignIn(anchor: anchor) }
                } label: {
                    Text("Continue with Google")
                        .font(RallyType.button())
                        .frame(maxWidth: .infinity)
                        .padding(.vertical, 6)
                }
                .buttonStyle(.glassProminent)
                .controlSize(.large)
                .padding(.horizontal, 24)
                .accessibilityHint("Opens Google in a secure browser sheet.")
#if RALLY_DEBUG
                Button {
                    Task { await model.startLocalDevelopmentSession() }
                } label: {
                    Text("Use local development account")
                        .font(RallyType.button())
                        .frame(maxWidth: .infinity)
                        .padding(.vertical, 6)
                }
                .buttonStyle(.glass)
                .controlSize(.large)
                .padding(.horizontal, 24)
                .accessibilityHint("Signs in to the local Worker without Google.")
#endif
                HStack(spacing: 16) {
                    Link("Privacy", destination: APIConfiguration.privacyURL)
                    Link("Terms", destination: APIConfiguration.termsURL)
                }
                .font(RallyType.caption())
                .foregroundStyle(colors.textSecondary)
                .padding(.bottom, 32)
            }
        }
        .sheet(isPresented: $showIntro) {
            IntroScreens { showIntro = false }
        }
    }
}

struct IntroScreens: View {
    var onDone: () -> Void
    @Environment(\.rallyColors) private var colors
    @State private var page = 0

    var body: some View {
        VStack(spacing: 0) {
            TabView(selection: $page) {
                introPage(
                    title: "A work stream for every piece of work",
                    body: "Rally is the home for a task, not a channel. Ask, and a stream starts.",
                    tag: 0
                )
                introPage(
                    title: "Rally is already in the room",
                    body: "You never add it. Every stream has Rally working alongside the people in it.",
                    tag: 1
                )
                introPage(
                    title: "Speak, type, or attach",
                    body: "The composer is always at the bottom. Voice and photos sit next to send.",
                    tag: 2
                )
            }
            .tabViewStyle(.page(indexDisplayMode: .always))
            Button(page == 2 ? "Get started" : "Next") {
                if page == 2 { onDone() } else { page += 1 }
            }
            .buttonStyle(.glassProminent)
            .controlSize(.large)
            .padding(24)
            .accessibilityLabel(page == 2 ? "Get started" : "Next intro screen")
        }
        .presentationDetents([.large])
    }

    private func introPage(title: String, body: String, tag: Int) -> some View {
        VStack(alignment: .leading, spacing: 16) {
            Spacer()
            Text(title)
                .font(RallyType.screenTitle())
                .foregroundStyle(colors.textPrimary)
            Text(body)
                .font(RallyType.body())
                .foregroundStyle(colors.textSecondary)
                .lineSpacing(6)
            Spacer()
        }
        .padding(28)
        .tag(tag)
    }
}
