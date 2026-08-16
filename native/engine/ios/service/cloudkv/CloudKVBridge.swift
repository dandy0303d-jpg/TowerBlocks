//
//  CloudKVBridge.swift
//  NSUbiquitousKeyValueStore wrapper — small (<1MB) key/value data
//  synced across the player's iCloud-signed-in devices. Perfect for
//  guest-account continuity (uuid + bearer + display name + avatar),
//  which is exactly what we need to make "install on new iPhone,
//  see all my gems + progress" work without forcing SIWA sign-in.
//
//  Design:
//  - One JSON blob under key "tt.identity" stores the full identity
//    snapshot. Simple, atomic, easy to version.
//  - Writes are opportunistic — Apple syncs in the background when
//    the app is foregrounded / networked. We call synchronize() after
//    every write to nudge it but don't rely on immediate delivery.
//  - Reads always return the LOCAL iCloud cache (populated from the
//    cloud on first launch after install, then kept up-to-date by
//    iCloud daemon). Fast — no network in the request path.
//  - NSUbiquitousKeyValueStoreDidChangeExternallyNotification fires
//    when the cloud pushes a change from another device; we forward
//    to JS so the game can re-read + apply.
//
//  Requires:
//  - Xcode Signing & Capabilities → "iCloud" capability with
//    "Key-value storage" checked. This adds
//    com.apple.developer.ubiquity-kvstore-identifier entitlement.
//  - Device signed into iCloud in Settings (otherwise the store
//    still works locally but no cross-device sync happens).
//

import Foundation

@objc public class CloudKVBridge: NSObject {

    @objc public static let shared = CloudKVBridge()

    private let store = NSUbiquitousKeyValueStore.default
    private static let IDENTITY_KEY = "tt.identity"

    // Callback set by the ObjC glue to forward change notifications
    // to JS. Only fires for changes originating from ANOTHER device,
    // not for our own writes.
    @objc public var onIdentityChanged: ((String) -> Void)?

    private override init() {
        super.init()
        NotificationCenter.default.addObserver(
            self,
            selector: #selector(handleExternalChange(_:)),
            name: NSUbiquitousKeyValueStore.didChangeExternallyNotification,
            object: store
        )
        // Kick a sync at boot so the local cache is fresh if the
        // player just installed on a new device.
        store.synchronize()
    }

    /// Write the identity JSON blob. Called by JS after any
    /// PlayerProfile mutation. `json` is opaque to us — Swift just
    /// stores whatever the caller gives it.
    @objc public func setIdentity(_ json: String) {
        store.set(json, forKey: Self.IDENTITY_KEY)
        store.synchronize()   // nudge; iCloud daemon actually does the network
        NSLog("[CloudKV] setIdentity — \(json.count) chars written")
    }

    /// Read the identity JSON blob. Returns empty string when nothing
    /// is stored (fresh iCloud account or key never set).
    /// Callback is JSON `{"success":true,"identity":"<blob>"}` or
    /// `{"success":false,"error":"..."}`.
    @objc public func getIdentity(completion: @escaping (String) -> Void) {
        let raw = store.string(forKey: Self.IDENTITY_KEY) ?? ""
        let payload: [String: Any] = [
            "success":  true,
            "identity": raw,
        ]
        let json = Self.encodeJSON(payload) ??
                   #"{"success":false,"error":"json encode failed"}"#
        completion(json)
    }

    /// Clear the identity (used by delete-account flow so the deleted
    /// uuid doesn't get restored from iCloud on next launch).
    @objc public func clearIdentity() {
        store.removeObject(forKey: Self.IDENTITY_KEY)
        store.synchronize()
        NSLog("[CloudKV] clearIdentity — removed")
    }

    @objc private func handleExternalChange(_ notification: Notification) {
        // Another device pushed a change. Forward the fresh blob so
        // the game can decide whether to apply (e.g. remote sign-in
        // shifted the uuid; local should follow suit).
        let raw = store.string(forKey: Self.IDENTITY_KEY) ?? ""
        NSLog("[CloudKV] external change detected — \(raw.count) chars")
        if let cb = onIdentityChanged {
            DispatchQueue.main.async { cb(raw) }
        }
    }

    private static func encodeJSON(_ obj: Any) -> String? {
        guard let data = try? JSONSerialization.data(withJSONObject: obj, options: []) else {
            return nil
        }
        return String(data: data, encoding: .utf8)
    }
}
