import Foundation

/// Electron sidebar headings for unpinned work streams. Sunday-start weeks,
/// local calendar, newest heading first. Same strings as
/// `apps/desktop/src/common/recency-groups.ts`.
enum RallyRecencyGroup: String, CaseIterable, Sendable {
    case lastHour = "Last hour"
    case today = "Today"
    case yesterday = "Yesterday"
    case thisWeek = "This week"
    case thisMonth = "This month"
    case beforeThisMonth = "Before this month"
}

struct RallyWorkstreamSection: Equatable, Identifiable, Sendable {
    var title: String
    var items: [RallyWorkstream]
    var id: String { title }
}

/// Pinned in server pin order, then recency groups by this viewer's last access.
enum RallyWorkstreamDirectory {
    static let hour: TimeInterval = 3_600

    static func sections(from items: [RallyWorkstream], now: Date = Date()) -> [RallyWorkstreamSection] {
        let pinned = items
            .filter { $0.pinPosition != nil }
            .sorted { left, right in
                let position = (left.pinPosition ?? 0) - (right.pinPosition ?? 0)
                if position != 0 { return position < 0 }
                return left.id < right.id
            }
        let unpinned = items.filter { $0.pinPosition == nil }
        var result: [RallyWorkstreamSection] = []
        if !pinned.isEmpty {
            result.append(RallyWorkstreamSection(title: "Pinned", items: pinned))
        }
        result.append(contentsOf: recencyGroups(from: unpinned, now: now))
        return result
    }

    static func recencyGroups(from items: [RallyWorkstream], now: Date) -> [RallyWorkstreamSection] {
        let calendar = gregorianCalendar()
        let nowTimestamp = now.timeIntervalSince1970
        let startOfToday = calendar.startOfDay(for: now).timeIntervalSince1970
        let startOfYesterday = calendar.date(byAdding: .day, value: -1, to: calendar.startOfDay(for: now))!
            .timeIntervalSince1970
        let startOfWeek = startOfSundayWeek(containing: now, calendar: calendar).timeIntervalSince1970
        let startOfMonth = calendar.date(from: calendar.dateComponents([.year, .month], from: now))!
            .timeIntervalSince1970

        let ordered = items.sorted { left, right in
            recencyTimestamp(left) > recencyTimestamp(right)
        }

        var buckets: [RallyRecencyGroup: [RallyWorkstream]] = [:]
        for item in ordered {
            let timestamp = recencyTimestamp(item)
            let group: RallyRecencyGroup
            if timestamp >= nowTimestamp - hour {
                group = .lastHour
            } else if timestamp >= startOfToday {
                group = .today
            } else if timestamp >= startOfYesterday {
                group = .yesterday
            } else if timestamp >= startOfWeek {
                group = .thisWeek
            } else if timestamp >= startOfMonth {
                group = .thisMonth
            } else {
                group = .beforeThisMonth
            }
            var grouped = buckets[group] ?? []
            grouped.append(item)
            buckets[group] = grouped
        }

        return RallyRecencyGroup.allCases.compactMap { group in
            guard let grouped = buckets[group], !grouped.isEmpty else { return nil }
            return RallyWorkstreamSection(title: group.rawValue, items: grouped)
        }
    }

    /// Next instant a heading can change with no new directory data.
    static func nextBoundary(items: [RallyWorkstream], now: Date = Date()) -> Date {
        let calendar = gregorianCalendar()
        let startOfTomorrow = calendar.date(
            byAdding: .day,
            value: 1,
            to: calendar.startOfDay(for: now)
        ) ?? now.addingTimeInterval(hour)
        var next = startOfTomorrow.timeIntervalSince1970
        let nowTimestamp = now.timeIntervalSince1970
        for item in items where item.pinPosition == nil {
            let leavesLastHour = recencyTimestamp(item) + hour
            if leavesLastHour.isFinite, leavesLastHour > nowTimestamp {
                next = min(next, leavesLastHour)
            }
        }
        return Date(timeIntervalSince1970: next)
    }

    static func recencyTimestamp(_ item: RallyWorkstream) -> TimeInterval {
        guard let raw = item.recencyRaw, let date = JSONCoding.date(from: raw) else {
            return -.infinity
        }
        return date.timeIntervalSince1970
    }

    private static func gregorianCalendar() -> Calendar {
        var calendar = Calendar(identifier: .gregorian)
        calendar.timeZone = .current
        calendar.firstWeekday = 1
        return calendar
    }

    /// Sunday 00:00 local, matching JS `now.getDate() - now.getDay()`.
    private static func startOfSundayWeek(containing now: Date, calendar: Calendar) -> Date {
        let start = calendar.startOfDay(for: now)
        let weekday = calendar.component(.weekday, from: start)
        let daysFromSunday = weekday - 1
        return calendar.date(byAdding: .day, value: -daysFromSunday, to: start) ?? start
    }
}
