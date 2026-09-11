import SwiftUI

extension View {
    /// Liquid Glass on the navigation layer. Falls back to ultra-thin material
    /// when the iOS 26 SDK is not compiling this module.
    @ViewBuilder
    func rallyGlass(in shape: some Shape) -> some View {
        if #available(iOS 26.0, *) {
            self.glassEffect(.regular, in: shape)
        } else {
            self.background(shape.fill(.ultraThinMaterial))
        }
    }
}
