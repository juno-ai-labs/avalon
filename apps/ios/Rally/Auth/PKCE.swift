import Foundation
import CryptoKit

/// RFC 7636 S256 material for `/auth/google/start`.
///
/// Attempt ids and challenges are 43-character base64url strings (32 random
/// bytes). Verifiers are 64 characters (48 random bytes), matching the desktop
/// client's `DesktopAuthAttemptStore`.
struct PKCEChallenge: Equatable, Sendable {
    let attemptId: String
    let verifier: String
    let challenge: String

    static func generate(random: (Int) -> Data = { count in
        var bytes = [UInt8](repeating: 0, count: count)
        let status = SecRandomCopyBytes(kSecRandomDefault, count, &bytes)
        precondition(status == errSecSuccess, "SecRandomCopyBytes failed")
        return Data(bytes)
    }) -> PKCEChallenge {
        let attemptId = base64URL(random(32))
        let verifier = base64URL(random(48))
        let digest = SHA256.hash(data: Data(verifier.utf8))
        let challenge = base64URL(Data(digest))
        return PKCEChallenge(attemptId: attemptId, verifier: verifier, challenge: challenge)
    }

    static func base64URL(_ data: Data) -> String {
        data.base64EncodedString()
            .replacingOccurrences(of: "+", with: "-")
            .replacingOccurrences(of: "/", with: "_")
            .replacingOccurrences(of: "=", with: "")
    }
}
