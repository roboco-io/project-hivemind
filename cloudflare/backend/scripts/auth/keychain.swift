import Foundation
import Security
import Darwin

// One persistent process owns the lock until the caller closes its input pipe.
let root = FileManager.default.homeDirectoryForCurrentUser
    .appendingPathComponent("Library/Application Support/HIVEMIND")
try FileManager.default.createDirectory(at: root, withIntermediateDirectories: true,
    attributes: [.posixPermissions: 0o700])
let lockPath = root.appendingPathComponent("pi-oauth.lock").path
let fd = open(lockPath, O_CREAT | O_RDWR | O_NOFOLLOW, 0o600)
guard fd >= 0 else { exit(1) }
defer { close(fd) }
let until = Date().addingTimeInterval(60)
while flock(fd, LOCK_EX | LOCK_NB) != 0 {
    guard errno == EWOULDBLOCK && Date() < until else { exit(1) }
    usleep(100_000)
}
let query: [String: Any] = [
    kSecClass as String: kSecClassGenericPassword,
    kSecAttrService as String: "io.roboco.hivemind.pi-openai-oauth",
    kSecAttrAccount as String: "operator"
]
func reply(_ value: [String: Any]) {
    if let data = try? JSONSerialization.data(withJSONObject: value) {
        FileHandle.standardOutput.write(data)
        FileHandle.standardOutput.write(Data([10]))
    }
}
reply(["ready": true])
while let line = readLine() {
    guard let bytes = line.data(using: .utf8), bytes.count < 131072,
          let request = try? JSONSerialization.jsonObject(with: bytes) as? [String: Any],
          let command = request["command"] as? String else {
        reply(["error": "Invalid request"]); continue
    }
    if command == "get" {
        var read = query
        read[kSecReturnData as String] = true
        read[kSecMatchLimit as String] = kSecMatchLimitOne
        var result: CFTypeRef?
        let status = SecItemCopyMatching(read as CFDictionary, &result)
        if status == errSecItemNotFound { reply(["value": NSNull()]) }
        else if status == errSecSuccess, let data = result as? Data,
                let text = String(data: data, encoding: .utf8) { reply(["value": text]) }
        else { reply(["error": "Keychain read failed", "status": status]) }
    } else if command == "set", let value = request["value"] as? String,
              let data = value.data(using: .utf8), data.count < 65536 {
        var status = SecItemUpdate(query as CFDictionary, [kSecValueData as String: data] as CFDictionary)
        if status == errSecItemNotFound {
            var add = query
            add[kSecValueData as String] = data
            add[kSecAttrAccessible as String] = kSecAttrAccessibleWhenUnlockedThisDeviceOnly
            status = SecItemAdd(add as CFDictionary, nil)
        }
        reply(status == errSecSuccess ? ["ok": true] : ["error": "Keychain write failed", "status": status])
    } else if command == "delete" {
        let status = SecItemDelete(query as CFDictionary)
        reply(status == errSecSuccess || status == errSecItemNotFound ?
              ["ok": true] : ["error": "Keychain delete failed", "status": status])
    } else { reply(["error": "Invalid command"]) }
}
