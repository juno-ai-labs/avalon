import SwiftUI

extension View {
    /// Liquid Glass on a custom floating control. System tab bars, navigation
    /// bars, and toolbars already adopt the material — do not wrap those, and
    /// do not stack this on an opaque fill. Apple: apply the effect sparingly
    /// so glass draws attention to the content beneath it, not to itself.
    @ViewBuilder
    func rallyGlass(in shape: some Shape) -> some View {
        if #available(iOS 26.0, *) {
            self.glassEffect(.regular.interactive(), in: shape)
        } else {
            self.background(shape.fill(.ultraThinMaterial))
        }
    }
}
