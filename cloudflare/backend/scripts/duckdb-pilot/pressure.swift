import Foundation
import Dispatch
import Darwin
func emit(_ state: String, _ origin: String) {
 let value: [String: Any] = ["timestampMs": Int(Date().timeIntervalSince1970 * 1000), "pressure": state, "origin": origin]
 if let bytes = try? JSONSerialization.data(withJSONObject: value, options: [.sortedKeys]) {
  FileHandle.standardOutput.write(bytes); FileHandle.standardOutput.write(Data([10]))
 }
}
var raw: Int32 = 0
var length = MemoryLayout<Int32>.size
if sysctlbyname("kern.memorystatus_vm_pressure_level", &raw, &length, nil, 0) == 0 {
 emit(raw == 1 ? "normal" : raw == 2 ? "warning" : raw == 4 ? "critical" : "unknown", "sysctl")
} else { emit("unknown", "initial-state-unavailable") }
let source = DispatchSource.makeMemoryPressureSource(eventMask: [.normal, .warning, .critical], queue: .main)
source.setEventHandler {
 let flags = source.data
 emit(flags.contains(.critical) ? "critical" : flags.contains(.warning) ? "warning" : flags.contains(.normal) ? "normal" : "unknown", "dispatch-event")
}
source.resume()
dispatchMain()
