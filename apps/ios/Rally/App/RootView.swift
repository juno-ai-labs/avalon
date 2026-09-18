import AuthenticationServices
import SwiftUI

struct RootView: View {
    @Environment(AppModel.self) private var model
    @Environment(\.rallyColors) private var colors
    @Environment(\.accessibilityReduceMotion) private var reduceMotion

    var body: some View {
        Group {
            switch model.phase {
            case .launching:
                ZStack {
                    colors.canvas.ignoresSafeArea()
                    RallyMark()
                        .frame(width: 48, height: 48)
                        .accessibilityLabel("Rally")
                        .accessibilityAddTraits(.isImage)
                }
            case .signedOut:
                SignInView()
            case .pickingWorkspace:
                WorkspacePickerView()
            case .ready:
                MainShell()
            }
        }
        .animation(reduceMotion ? nil : RallyMotion.screenSpring, value: model.phase)
        .alert("Something went wrong", isPresented: Binding(
            get: { model.errorMessage != nil },
            set: { if !$0 { model.errorMessage = nil } }
        )) {
            Button("OK", role: .cancel) { model.errorMessage = nil }
        } message: {
            Text(model.errorMessage ?? "")
        }
    }
}

struct WindowAnchorView: UIViewRepresentable {
    var onResolve: (ASPresentationAnchor) -> Void

    func makeUIView(context: Context) -> UIView {
        let view = UIView(frame: .zero)
        view.backgroundColor = .clear
        return view
    }

    func updateUIView(_ uiView: UIView, context: Context) {
        guard context.coordinator.resolved == nil, let window = uiView.window else { return }
        context.coordinator.resolved = window
        DispatchQueue.main.async { onResolve(window) }
    }

    func makeCoordinator() -> Coordinator {
        Coordinator()
    }

    final class Coordinator {
        var resolved: UIWindow?
    }
}
