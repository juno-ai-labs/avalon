import SwiftUI

/// Grok Bot's 2026 palette, with a HIG-required light counterpart.
/// Dark is OLED true-black (`#000000`). Light inverts the same steps so the
/// transcript remains the only thing on the canvas.
enum RallyPalette {
    static let canvasDark = Color(red: 0, green: 0, blue: 0)
    static let canvasLight = Color(red: 1, green: 1, blue: 1)
    static let surface1Dark = Color(red: 0.086, green: 0.094, blue: 0.110) // #16181C
    static let surface1Light = Color(red: 0.969, green: 0.976, blue: 0.976) // #F7F9F9
    static let surface2Dark = Color(red: 0.118, green: 0.129, blue: 0.149) // #1E2126
    static let surface2Light = Color(red: 0.937, green: 0.953, blue: 0.957)
    static let surface3Dark = Color(red: 0.153, green: 0.165, blue: 0.180) // #272A2E
    static let surface3Light = Color(red: 0.886, green: 0.898, blue: 0.902)
    static let dividerDark = Color(red: 0.184, green: 0.200, blue: 0.212) // #2F3336
    static let dividerLight = Color(red: 0.937, green: 0.953, blue: 0.957) // #EFF3F4
    static let textPrimaryDark = Color(red: 0.906, green: 0.914, blue: 0.918) // #E7E9EA
    static let textPrimaryLight = Color(red: 0.059, green: 0.078, blue: 0.098) // #0F1419
    static let textSecondaryDark = Color(red: 0.443, green: 0.463, blue: 0.482) // #71767B
    static let textSecondaryLight = Color(red: 0.325, green: 0.357, blue: 0.376)
    static let textTertiaryDark = Color(red: 0.302, green: 0.318, blue: 0.337)
    static let textTertiaryLight = Color(red: 0.510, green: 0.541, blue: 0.561)
    static let accentWhite = Color.white
    static let pressedWhite = Color(red: 0.843, green: 0.859, blue: 0.863)
    static let linkBlue = Color(red: 0.114, green: 0.608, blue: 0.941) // #1D9BF0
    static let linkPressed = Color(red: 0.102, green: 0.549, blue: 0.847)
    static let success = Color(red: 0.000, green: 0.729, blue: 0.486)
    static let error = Color(red: 0.957, green: 0.129, blue: 0.180)
    static let focusBorder = Color(red: 0.243, green: 0.255, blue: 0.275)
}

struct RallyColors {
    let colorScheme: ColorScheme
    let increaseContrast: Bool

    var canvas: Color { colorScheme == .dark ? RallyPalette.canvasDark : RallyPalette.canvasLight }
    var surface1: Color { colorScheme == .dark ? RallyPalette.surface1Dark : RallyPalette.surface1Light }
    var surface2: Color { colorScheme == .dark ? RallyPalette.surface2Dark : RallyPalette.surface2Light }
    var surface3: Color { colorScheme == .dark ? RallyPalette.surface3Dark : RallyPalette.surface3Light }
    var divider: Color { colorScheme == .dark ? RallyPalette.dividerDark : RallyPalette.dividerLight }
    var textPrimary: Color { colorScheme == .dark ? RallyPalette.textPrimaryDark : RallyPalette.textPrimaryLight }
    var textSecondary: Color {
        if increaseContrast {
            return colorScheme == .dark
                ? Color(red: 0.545, green: 0.561, blue: 0.580) // #8B8F94
                : Color(red: 0.220, green: 0.247, blue: 0.263)
        }
        return colorScheme == .dark ? RallyPalette.textSecondaryDark : RallyPalette.textSecondaryLight
    }
    var textTertiary: Color { colorScheme == .dark ? RallyPalette.textTertiaryDark : RallyPalette.textTertiaryLight }
    var sendFillEnabled: Color { colorScheme == .dark ? RallyPalette.accentWhite : RallyPalette.textPrimaryLight }
    var sendGlyphEnabled: Color { colorScheme == .dark ? .black : .white }
    var link: Color { RallyPalette.linkBlue }
    /// In-app Rally mark ink. Same as desktop `--av-sys-color-brand-ink`.
    var brandInk: Color { colorScheme == .dark ? .white : .black }
}

private struct RallyColorsKey: EnvironmentKey {
    static let defaultValue = RallyColors(colorScheme: .dark, increaseContrast: false)
}

extension EnvironmentValues {
    var rallyColors: RallyColors {
        get { self[RallyColorsKey.self] }
        set { self[RallyColorsKey.self] = newValue }
    }
}

struct RallyColorEnvironment: ViewModifier {
    @Environment(\.colorScheme) private var colorScheme
    @Environment(\.accessibilityDifferentiateWithoutColor) private var differentiate
    @Environment(\.legibilityWeight) private var legibility

    func body(content: Content) -> some View {
        content.environment(
            \.rallyColors,
            RallyColors(
                colorScheme: colorScheme,
                increaseContrast: legibility == .bold || differentiate
            )
        )
    }
}

extension View {
    func rallyColors() -> some View {
        modifier(RallyColorEnvironment())
    }
}

enum RallyType {
    /// HIG: system typeface and Dynamic Type. Weights echo Grok Bot's Inter ladder.
    static func screenTitle() -> Font { .largeTitle.weight(.bold) }
    static func sectionHeader() -> Font { .title3.weight(.bold) }
    static func conversationTitle() -> Font { .headline }
    static func body() -> Font { .body }
    static func prompt() -> Font { .body }
    static func pill() -> Font { .subheadline.weight(.semibold) }
    static func bodySmall() -> Font { .subheadline }
    static func button() -> Font { .body.weight(.semibold) }
    static func caption() -> Font { .caption }
    static func labelUpper() -> Font { .caption2.weight(.bold) }
    static func code() -> Font { .body.monospaced() }
}

enum RallyMotion {
    static let sendSpring = Animation.spring(response: 0.28, dampingFraction: 0.82)
    static let pillSpring = Animation.spring(response: 0.22, dampingFraction: 0.86)
    static let screenSpring = Animation.spring(response: 0.35, dampingFraction: 0.88)
    static let cursorBlink: TimeInterval = 0.53
}

/// The shared Rally loop, the same mask desktop paints through `.rally-mark`.
/// Template rendering so the glyph follows brand ink, not the volt baked into
/// the PNG. The retired four-pointed spark is gone.
struct RallyMark: View {
    @Environment(\.rallyColors) private var colors

    var body: some View {
        Image("RallyMark")
            .resizable()
            .renderingMode(.template)
            .scaledToFit()
            .foregroundStyle(colors.brandInk)
    }
}

struct RallyPressableStyle: ButtonStyle {
    var scale: CGFloat = 0.97
    func makeBody(configuration: Configuration) -> some View {
        PressableBody(configuration: configuration, scale: scale)
    }

    private struct PressableBody: View {
        var configuration: Configuration
        var scale: CGFloat
        @Environment(\.accessibilityReduceMotion) private var reduceMotion

        var body: some View {
            configuration.label
                .scaleEffect(configuration.isPressed && !reduceMotion ? scale : 1)
                .animation(reduceMotion ? nil : RallyMotion.sendSpring, value: configuration.isPressed)
        }
    }
}
