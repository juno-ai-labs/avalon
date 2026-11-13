import ExpoModulesCore
import CrashReporter
import Foundation

// PLCrashReporter owns fatal-signal handling. All JSON/file operations happen
// outside that handler, on the next launch or during ordinary JS calls.
private final class CrashStore {
  static let shared = CrashStore()
  private let lock = NSRecursiveLock()
  private let defaults = UserDefaults.standard
  private let key = "rally.crash.context"
  private let lifetime = 14.0 * 24 * 60 * 60
  private let maxBytes = 20 * 1024 * 1024
  private let reporter = PLCrashReporter(configuration: PLCrashReporterConfig(signalHandlerType: .mach, symbolicationStrategy: []))
  private var enabled = false
  private var context: [String: Any]?
  private let launchId = CrashStore.uuidV7()
  private var directory: URL {
    FileManager.default.urls(for: .applicationSupportDirectory, in: .userDomainMask)[0]
      .appendingPathComponent("RallyCrashes", isDirectory: true)
  }

  private static func uuidV7() -> String {
    let random = UUID().uuidString.lowercased().replacingOccurrences(of: "-", with: "")
    let time = String(format: "%012llx", UInt64(Date().timeIntervalSince1970 * 1000))
    let hex = time + "7" + random.dropFirst(13)
    return "\(hex.prefix(8))-\(hex.dropFirst(8).prefix(4))-\(hex.dropFirst(12).prefix(4))-\(hex.dropFirst(16).prefix(4))-\(hex.dropFirst(20))"
  }

  func start() {
    lock.lock(); defer { lock.unlock() }
    do {
      try FileManager.default.createDirectory(at: directory, withIntermediateDirectories: true,
        attributes: [.protectionKey: FileProtectionType.completeUntilFirstUserAuthentication])
      var location = directory
      var values = URLResourceValues(); values.isExcludedFromBackup = true
      try location.setResourceValues(values)
      context = defaults.dictionary(forKey: key)
      if reporter?.hasPendingCrashReport() == true {
        let data = try? reporter?.loadPendingCrashReportDataAndReturnError()
        reporter?.purgePendingCrashReport()
        do {
          if let data, data.count <= maxBytes {
            let report = try PLCrashReport(data: data)
            if let custom = report.customData,
               let captured = try JSONSerialization.jsonObject(with: custom) as? [String: Any],
               valid(captured), sameScope(captured, context),
               let text = PLCrashReportTextFormatter.stringValue(for: report, with: PLCrashReportTextFormatiOS) {
              let signals = ["SIGABRT", "SIGBUS", "SIGFPE", "SIGILL", "SIGSEGV", "SIGTRAP", "SIGSYS", "SIGPIPE"]
              let threads = (report.threads as? [PLCrashReportThreadInfo] ?? []).map { thread -> [String: Any] in
                let frames = (thread.stackFrames as? [PLCrashReportStackFrameInfo] ?? []).compactMap { frame -> [String: String]? in
                  guard let image = report.image(forAddress: frame.instructionPointer), image.hasImageUUID,
                    let uuid = image.imageUUID, frame.instructionPointer >= image.imageBaseAddress else { return nil }
                  return ["imageUUID": uuid, "offset": String(frame.instructionPointer - image.imageBaseAddress, radix: 16)]
                }
                return ["crashed": thread.crashed, "frames": frames]
              }
              try save(captured, payload: ["kind": "ios-native", "report": text,
                "signal": signals.contains(report.signalInfo.name) ? report.signalInfo.name! : "unknown", "threads": threads])
            }
          }
        } catch { /* A malformed previous crash must not disable the next capture. */ }
      }
      prune()
      if let old = context, valid(old), let scope = old["scope"] as? [String: String] {
        configure(scope, deleteAfter: old["deleteAfter"] as? Double)
      } else { configure(nil) }
    } catch { /* Capture must never prevent launch. */ }
  }

  func configure(_ scope: [String: String]?, deleteAfter: Double? = nil) {
    lock.lock(); defer { lock.unlock() }
    guard let scope else {
      context = nil; defaults.removeObject(forKey: key); reporter?.customData = nil
      for file in files() { try? FileManager.default.removeItem(at: file) }
      return
    }
    if let old = context, !sameScope(old, ["scope": scope]) {
      for file in files() { try? FileManager.default.removeItem(at: file) }
    }
    let installation = defaults.string(forKey: "rally.crash.installation") ?? CrashStore.uuidV7()
    defaults.set(installation, forKey: "rally.crash.installation")
    #if arch(x86_64)
    let architecture = "x64"
    #else
    let architecture = "arm64"
    #endif
    let metadata: [String: Any] = ["uploadId": CrashStore.uuidV7(), "installationId": installation,
      "route": scope["route"] ?? "", "release": Bundle.main.object(forInfoDictionaryKey: "CFBundleShortVersionString") as? String ?? "unknown",
      "buildId": "ios-" + (Bundle.main.object(forInfoDictionaryKey: "CFBundleVersion") as? String ?? "unknown"),
      "platform": "darwin", "architecture": architecture, "processRole": "main", "launchId": launchId,
      "channel": "stable", "format": "mobile-json"]
    let next: [String: Any] = ["scope": scope, "metadata": metadata,
      "deleteAfter": deleteAfter ?? Date().addingTimeInterval(lifetime).timeIntervalSince1970 * 1000]
    guard let data = try? JSONSerialization.data(withJSONObject: next) else { return }
    context = next; defaults.set(next, forKey: key); reporter?.customData = data
    if !enabled {
      do { try reporter?.enableAndReturnError(); enabled = reporter != nil }
      catch { /* Another debugger/handler may own crash interception. */ }
    }
  }

  func prepare(_ scope: [String: String]) {
    lock.lock(); defer { lock.unlock() }
    if let context, !sameScope(context, ["scope": scope]) { configure(nil) }
  }

  func captureJavascript(_ payload: String) {
    lock.lock(); defer { lock.unlock() }
    guard let context, valid(context), let data = payload.data(using: .utf8), data.count <= maxBytes,
      let value = try? JSONSerialization.jsonObject(with: data) as? [String: Any] else { return }
    var captured = context
    var metadata = captured["metadata"] as? [String: Any] ?? [:]
    metadata["uploadId"] = CrashStore.uuidV7(); metadata["processRole"] = "renderer"
    captured["metadata"] = metadata
    try? save(captured, payload: value)
  }

  func pending(_ scope: [String: String]) -> [String] {
    lock.lock(); defer { lock.unlock() }
    prune()
    return files().compactMap { file in
      guard let data = try? Data(contentsOf: file),
        let value = try? JSONSerialization.jsonObject(with: data) as? [String: Any],
        sameScope(value, ["scope": scope]) else { return nil }
      return String(data: data, encoding: .utf8)
    }
  }

  func acknowledge(_ uploadId: String) {
    lock.lock(); defer { lock.unlock() }
    guard UUID(uuidString: uploadId) != nil else { return }
    try? FileManager.default.removeItem(at: directory.appendingPathComponent(uploadId + ".json"))
  }

  private func save(_ captured: [String: Any], payload: [String: Any]) throws {
    var value = captured; value["payload"] = payload
    guard let metadata = captured["metadata"] as? [String: Any], let id = metadata["uploadId"] as? String else { return }
    let data = try JSONSerialization.data(withJSONObject: value)
    guard data.count <= maxBytes else { return }
    try data.write(to: directory.appendingPathComponent(id + ".json"), options: [.atomic, .completeFileProtectionUntilFirstUserAuthentication])
    prune()
  }

  private func files() -> [URL] {
    ((try? FileManager.default.contentsOfDirectory(at: directory, includingPropertiesForKeys: nil)) ?? [])
      .filter { $0.pathExtension == "json" }.sorted { $0.lastPathComponent < $1.lastPathComponent }
  }
  private func valid(_ value: [String: Any]) -> Bool {
    guard let deadline = value["deleteAfter"] as? Double else { return false }
    return deadline > Date().timeIntervalSince1970 * 1000
  }
  private func sameScope(_ left: [String: Any], _ right: [String: Any]?) -> Bool {
    guard let a = left["scope"] as? [String: String], let b = right?["scope"] as? [String: String] else { return false }
    return a == b
  }
  private func prune() {
    var retained: [(URL, Int)] = []
    for file in files() {
      guard let data = try? Data(contentsOf: file), data.count <= maxBytes,
        let value = try? JSONSerialization.jsonObject(with: data) as? [String: Any], valid(value) else {
        try? FileManager.default.removeItem(at: file); continue
      }
      retained.append((file, data.count))
    }
    var bytes = retained.reduce(0) { $0 + $1.1 }
    while retained.count > 20 || bytes > 100 * 1024 * 1024 {
      let oldest = retained.removeFirst(); bytes -= oldest.1
      try? FileManager.default.removeItem(at: oldest.0)
    }
  }
}

public class RallyCrashSubscriber: ExpoAppDelegateSubscriber {
  public func application(_ application: UIApplication, didFinishLaunchingWithOptions launchOptions: [UIApplication.LaunchOptionsKey: Any]? = nil) -> Bool {
    CrashStore.shared.start()
    return true
  }
}

public class RallyCrashReporterModule: Module {
  public func definition() -> ModuleDefinition {
    Name("RallyCrashReporter")
    #if DEBUG
    Function("crashForTesting") { abort() }
    #endif
    Function("prepare") { (scope: [String: String]) in CrashStore.shared.prepare(scope) }
    Function("configure") { (scope: [String: String]?) in CrashStore.shared.configure(scope) }
    Function("captureJavascript") { (payload: String) in CrashStore.shared.captureJavascript(payload) }
    AsyncFunction("pending") { (scope: [String: String]) in CrashStore.shared.pending(scope) }
    Function("acknowledge") { (uploadId: String) in CrashStore.shared.acknowledge(uploadId) }
  }
}
