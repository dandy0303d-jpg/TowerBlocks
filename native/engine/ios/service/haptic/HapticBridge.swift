//
//  HapticBridge.swift
//  Thin wrapper over UIImpactFeedbackGenerator / UINotificationFeedbackGenerator.
//
//  Design:
//  - Cocos JS layer fires 'haptic.impact' with a style string; native
//    picks the right generator + fires. Fire-and-forget; no reply.
//  - Generators are cached (one per style) because iOS docs say the
//    first fire has 100-300ms latency — pre-warming by keeping them
//    alive removes that lag for the second+ fire.
//  - All calls dispatched to main queue (UIKit requirement).
//

import Foundation
import UIKit

@objc public class HapticBridge: NSObject {

    @objc public static let shared = HapticBridge()

    private let lightGen  = UIImpactFeedbackGenerator(style: .light)
    private let medGen    = UIImpactFeedbackGenerator(style: .medium)
    private let heavyGen  = UIImpactFeedbackGenerator(style: .heavy)
    private let successGen = UINotificationFeedbackGenerator()

    private override init() {
        super.init()
        // Pre-warm — takes ~30ms per generator, done once at register
        // time so gameplay impacts fire instantly.
        DispatchQueue.main.async {
            self.lightGen.prepare()
            self.medGen.prepare()
            self.heavyGen.prepare()
            self.successGen.prepare()
        }
    }

    /// Fire an impact of the given style. Recognised styles:
    ///   "light"   — line clear, single tap
    ///   "medium"  — item activation, piece landing
    ///   "heavy"   — game over, big event
    ///   "success" — celebratory (UINotificationFeedbackGenerator .success)
    /// Anything else → no-op.
    @objc public func impact(style: String) {
        DispatchQueue.main.async {
            switch style {
            case "light":
                self.lightGen.impactOccurred()
                self.lightGen.prepare()   // re-arm for next fire
            case "medium":
                self.medGen.impactOccurred()
                self.medGen.prepare()
            case "heavy":
                self.heavyGen.impactOccurred()
                self.heavyGen.prepare()
            case "success":
                self.successGen.notificationOccurred(.success)
                self.successGen.prepare()
            default:
                NSLog("[Haptic] unknown style '\(style)' — no-op")
            }
        }
    }
}
