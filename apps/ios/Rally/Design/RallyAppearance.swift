import SwiftUI

/// Shared work-stream / Sidekick appearance: the same catalog and hash desktop
/// uses in `workstream-glyph.tsx`. A stored key this build does not know falls
/// back to the id-derived mark rather than blanking the row.
struct RallySavedAppearance: Codable, Sendable, Equatable {
    var icon: String?
    var color: String?
}

enum RallyPaletteKey: String, CaseIterable, Sendable {
    case rose, red, orange, amber, lime, green, emerald, cyan
    case blue, indigo, violet, purple, fuchsia, pink
    case black
    case gray, brown, yellow, teal

    /// The picker ring. `black` is an account neutral, not a derived fill.
    static let ring: [RallyPaletteKey] = [
        .rose, .red, .orange, .amber, .lime, .green, .emerald,
        .cyan, .blue, .indigo, .violet, .purple, .fuchsia, .pink,
    ]

    /// Retired personal accents → the colour the picker still offers.
    private static let personalAliases: [String: RallyPaletteKey] = [
        "teal": .emerald,
        "green": .emerald,
        "amber": .orange,
        "slate": .black,
    ]

    /// Account color from Global identity. Unknown names fall to `blue`, the
    /// same default desktop uses before a person picks.
    static func personal(from raw: String?) -> RallyPaletteKey {
        guard let raw, !raw.isEmpty else { return .blue }
        if let alias = personalAliases[raw] { return alias }
        return RallyPaletteKey(rawValue: raw) ?? .blue
    }

    /// The twelve identity symbols hashed from an id. Order is the catalog.
    static let generatedIconKeys = [
        "aperture", "atom", "boxes", "circle-dot", "circuit-board", "component",
        "dices", "orbit", "sparkles", "spline", "wand-sparkles", "workflow",
    ]

    var usesLightInk: Bool {
        switch self {
        case .amber, .lime, .green: false
        default: true
        }
    }

    func fill(colorScheme: ColorScheme) -> Color {
        if self == .black {
            return colorScheme == .dark
                ? Color(red: 69 / 255, green: 69 / 255, blue: 77 / 255) // #45454d
                : Color(red: 23 / 255, green: 23 / 255, blue: 26 / 255) // #17171a
        }
        return Self.fills[self] ?? Color(red: 168 / 255, green: 85 / 255, blue: 247 / 255)
    }

    var ink: Color {
        usesLightInk
            ? Color(red: 252 / 255, green: 252 / 255, blue: 252 / 255) // #fcfcfc
            : Color(red: 20 / 255, green: 20 / 255, blue: 20 / 255) // #141414
    }

    /// Hue fills are identical in light and dark; only `black` shifts.
    private static let fills: [RallyPaletteKey: Color] = [
        .rose: Color(red: 244 / 255, green: 63 / 255, blue: 94 / 255),
        .red: Color(red: 239 / 255, green: 68 / 255, blue: 68 / 255),
        .orange: Color(red: 249 / 255, green: 115 / 255, blue: 22 / 255),
        .amber: Color(red: 245 / 255, green: 158 / 255, blue: 11 / 255),
        .lime: Color(red: 132 / 255, green: 204 / 255, blue: 22 / 255),
        .green: Color(red: 34 / 255, green: 197 / 255, blue: 94 / 255),
        .emerald: Color(red: 16 / 255, green: 185 / 255, blue: 129 / 255),
        .cyan: Color(red: 6 / 255, green: 182 / 255, blue: 212 / 255),
        .blue: Color(red: 59 / 255, green: 130 / 255, blue: 246 / 255),
        .indigo: Color(red: 99 / 255, green: 102 / 255, blue: 241 / 255),
        .violet: Color(red: 139 / 255, green: 92 / 255, blue: 246 / 255),
        .purple: Color(red: 168 / 255, green: 85 / 255, blue: 247 / 255),
        .fuchsia: Color(red: 217 / 255, green: 70 / 255, blue: 239 / 255),
        .pink: Color(red: 236 / 255, green: 72 / 255, blue: 153 / 255),
        .gray: Color(red: 107 / 255, green: 114 / 255, blue: 128 / 255),
        .brown: Color(red: 146 / 255, green: 64 / 255, blue: 14 / 255),
        .yellow: Color(red: 202 / 255, green: 138 / 255, blue: 4 / 255),
        .teal: Color(red: 13 / 255, green: 148 / 255, blue: 136 / 255),
    ]
}

struct RallyResolvedAppearance: Equatable, Sendable {
    var colorKey: RallyPaletteKey
    var iconKey: String
    var systemImage: String

    static func resolve(id: String, saved: RallySavedAppearance?) -> RallyResolvedAppearance {
        let generated = derived(from: id)
        let colorKey = saved?.color.flatMap(RallyPaletteKey.init(rawValue:)) ?? generated.color
        let iconKey: String = {
            if let icon = saved?.icon, !icon.isEmpty, Self.systemImages[icon] != nil {
                return icon
            }
            return generated.icon
        }()
        return RallyResolvedAppearance(
            colorKey: colorKey,
            iconKey: iconKey,
            systemImage: Self.systemImages[iconKey] ?? Self.systemImages["circle-dot"]!
        )
    }

    /// FNV-1a as `Math.imul` + `>>> 0` in `workstreamAppearance`.
    static func derived(from id: String) -> (color: RallyPaletteKey, icon: String) {
        var hash = Int32(bitPattern: 2_166_136_261)
        for unit in id.utf16 {
            hash ^= Int32(unit)
            hash &*= 16_777_619
        }
        let unsigned = UInt32(bitPattern: hash)
        let ring = RallyPaletteKey.ring
        let icons = RallyPaletteKey.generatedIconKeys
        let color = ring[Int(unsigned % UInt32(ring.count))]
        let icon = icons[Int((unsigned / UInt32(ring.count)) % UInt32(icons.count))]
        return (color, icon)
    }

    /// Lucide catalog keys → the closest SF Symbol. Unknown keys never enter
    /// this map; `resolve` sends those to the id-derived mark instead.
    private static let systemImages: [String: String] = [
        "aperture": "camera.aperture",
        "atom": "atom",
        "boxes": "shippingbox",
        "circle-dot": "smallcircle.filled.circle",
        "circuit-board": "memorychip",
        "component": "square.grid.2x2",
        "dices": "dice",
        "orbit": "circle.dotted",
        "sparkles": "sparkles",
        "spline": "point.topleft.down.to.point.bottomright.curvepath",
        "wand-sparkles": "wand.and.stars",
        "workflow": "arrow.triangle.branch",
        "briefcase": "briefcase",
        "target": "target",
        "calendar-days": "calendar",
        "list-checks": "checklist",
        "clipboard-list": "list.clipboard",
        "file-text": "doc.text",
        "folder": "folder",
        "lightbulb": "lightbulb",
        "star": "star",
        "flag": "flag",
        "rocket": "airplane",
        "chart-no-axes-combined": "chart.bar.xaxis",
        "calculator": "plus.forwardslash.minus",
        "coins": "centsign.circle",
        "users": "person.2",
        "user-search": "person.crop.circle.badge.questionmark",
        "handshake": "handshake",
        "megaphone": "megaphone",
        "palette": "paintpalette",
        "image": "photo",
        "pen-tool": "pencil.tip",
        "package": "shippingbox",
        "building-2": "building.2",
        "globe-2": "globe",
        "heart": "heart",
    ]
}

/// Account chip: server initials on the chosen personal color, always a circle.
/// Desktop can paint diamond/flower/arch; a 32pt navigation control does not.
struct AccountAvatar: View {
    var presentation: RallyPersonalPresentation?
    var fallbackName: String
    var size: CGFloat = 32
    @Environment(\.colorScheme) private var colorScheme

    var body: some View {
        let initials = RallyPersonalPresentation.initials(
            stored: presentation?.initials,
            fallbackName: fallbackName
        )
        let color = RallyPaletteKey.personal(from: presentation?.color)
        Text(initials)
            .font(.system(size: min(size * 0.42, size * 0.7 / CGFloat(max(1, initials.count))), weight: .semibold))
            .foregroundStyle(color.ink)
            .frame(width: size, height: size)
            .background(color.fill(colorScheme: colorScheme), in: Circle())
            .clipShape(Circle())
            .accessibilityHidden(true)
    }
}

/// Filled circle for a work stream in a directory.
struct WorkstreamGlyph: View {
    var id: String
    var appearance: RallySavedAppearance?
    var size: CGFloat = 48
    @Environment(\.colorScheme) private var colorScheme

    var body: some View {
        let resolved = RallyResolvedAppearance.resolve(id: id, saved: appearance)
        Image(systemName: resolved.systemImage)
            .font(.system(size: max(12, size * 0.42), weight: .semibold))
            .foregroundStyle(resolved.colorKey.ink)
            .frame(width: size, height: size)
            .background(resolved.colorKey.fill(colorScheme: colorScheme), in: Circle())
            .accessibilityHidden(true)
    }
}

/// Rounded hexagon a Sidekick wears. Same silhouette as desktop `HexagonGlyph`.
struct SidekickGlyph: View {
    var id: String
    var appearance: RallySavedAppearance?
    var isActive: Bool = false
    var size: CGFloat = 48
    @Environment(\.colorScheme) private var colorScheme
    @Environment(\.rallyColors) private var colors

    var body: some View {
        let resolved = RallyResolvedAppearance.resolve(id: id, saved: appearance)
        ZStack {
            SidekickHexagon()
                .fill(resolved.colorKey.fill(colorScheme: colorScheme))
            Image(systemName: resolved.systemImage)
                .font(.system(size: max(12, size * 0.42), weight: .semibold))
                .foregroundStyle(resolved.colorKey.ink)
            if isActive {
                Image(systemName: "play.fill")
                    .font(.system(size: max(8, size * 0.22), weight: .bold))
                    .foregroundStyle(RallyPalette.success)
                    .padding(3)
                    .background(colors.canvas, in: Circle())
                    .offset(x: size * 0.32, y: size * 0.32)
            }
        }
        .frame(width: size, height: size)
        .accessibilityHidden(true)
    }
}

/// Desktop viewBox path `M43 6C47 3 … 14 22Z` on a 100×100 square.
struct SidekickHexagon: Shape {
    func path(in rect: CGRect) -> Path {
        let sx = rect.width / 100
        let sy = rect.height / 100
        func point(_ x: CGFloat, _ y: CGFloat) -> CGPoint {
            CGPoint(x: rect.minX + x * sx, y: rect.minY + y * sy)
        }
        var path = Path()
        path.move(to: point(43, 6))
        path.addCurve(to: point(57, 6), control1: point(47, 3), control2: point(52, 3))
        path.addLine(to: point(86, 23))
        path.addCurve(to: point(94, 36), control1: point(91, 26), control2: point(94, 30))
        path.addLine(to: point(94, 66))
        path.addCurve(to: point(86, 79), control1: point(94, 72), control2: point(91, 76))
        path.addLine(to: point(57, 95))
        path.addCurve(to: point(42, 95), control1: point(52, 98), control2: point(47, 98))
        path.addLine(to: point(14, 78))
        path.addCurve(to: point(6, 65), control1: point(9, 75), control2: point(6, 71))
        path.addLine(to: point(6, 35))
        path.addCurve(to: point(14, 22), control1: point(6, 29), control2: point(9, 25))
        path.closeSubpath()
        return path
    }
}
