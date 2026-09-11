import AuthenticationServices
import SwiftUI

struct RootView: View {
    @Environment(AppModel.self) private var model
    @Environment(\.rallyColors) private var colors

    var body: some View {
        Group {
            switch model.phase {
            case .launching:
                ZStack {
                    colors.canvas.ignoresSafeArea()
                    RallyMark()
                        .stroke(colors.textPrimary, lineWidth: 1.5)
                        .frame(width: 48, height: 48)
                        .accessibilityLabel("Rally")
                }
            case .signedOut:
                SignInView()
            case .pickingWorkspace:
                WorkspacePickerView()
            case .ready:
                MainShell()
            }
        }
        .animation(.easeInOut(duration: 0.25), value: model.phase)
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
        DispatchQueue.main.async {
            if let window = uiView.window {
                onResolve(window)
            }
        }
    }
}
