//
//  PurchaseBridge.swift
//  Native StoreKit 2 wrapper for the TypeScript IPurchaseProvider.
//
//  Design:
//  - Async StoreKit 2 API wrapped in @objc-visible methods that take
//    completion handlers, so ObjC (and by extension the Cocos JS bridge)
//    can call them.
//  - Unfinished Transaction objects are cached between buy() and
//    consume() so the server can confirm delivery BEFORE we call
//    Transaction.finish() (otherwise iOS won't re-deliver the receipt
//    if server confirmation fails, and the player loses their gems).
//  - On boot, a listener drains Transaction.updates so any pending
//    purchase (e.g. app crashed after buy() but before consume) gets
//    re-surfaced to JS via the "iap.pendingTransaction" event.
//
//  This file is Swift because StoreKit 2's modern API is Swift-only.
//  ObjC entry points are exposed via @objc annotations.
//

import Foundation
import StoreKit

@available(iOS 15.0, *)
@objc public class PurchaseBridge: NSObject {

    // MARK: - Singleton

    @objc public static let shared = PurchaseBridge()

    private override init() {
        super.init()
        // Kick off the background listener that drains Transaction.updates.
        // Any transactions that arrive while the app is running (e.g. Ask
        // to Buy approval finally comes through) get forwarded to JS.
        Task {
            for await result in Transaction.updates {
                self.handleUpdate(result: result)
            }
        }
    }

    // MARK: - State

    /// Products fetched from the App Store, keyed by SKU id. Populated
    /// by fetchProducts() and consulted by buy().
    private var productCache: [String: Product] = [:]

    /// Transactions that were successfully purchased but haven't been
    /// finish()'ed yet. TS calls consume(transactionId) once the server
    /// has credited the player — at that point we look up the cached
    /// Transaction and call .finish() on it.
    ///
    /// Keyed by String(Transaction.id).
    private var unfinishedTransactions: [String: Transaction] = [:]

    /// Optional callback set by the ObjC glue for `iap.pendingTransaction`
    /// events (transactions delivered outside of a buy() flow).
    @objc public var onPendingTransaction: ((String) -> Void)?

    // MARK: - Public API — all @objc so PurchaseBridgeGlue.mm can call.

    /// Fetch product metadata for the given SKU ids from the App Store.
    /// Result is a JSON string: `[{"id":"gems_60","displayPrice":"¥6",
    /// "priceCents":600,"currency":"CNY"}, ...]` or `[]` on failure.
    @objc public func fetchProducts(skus: [String], completion: @escaping (String) -> Void) {
        Task {
            do {
                let products = try await Product.products(for: skus)
                var results: [[String: Any]] = []
                for p in products {
                    self.productCache[p.id] = p
                    let cents = NSDecimalNumber(decimal: p.price * 100).intValue
                    let currency = p.priceFormatStyle.currencyCode
                    results.append([
                        "id": p.id,
                        "displayPrice": p.displayPrice,
                        "priceCents": cents,
                        "currency": currency,
                    ])
                }
                completion(Self.encodeJSON(results) ?? "[]")
            } catch {
                NSLog("[IAP] fetchProducts failed: \(error.localizedDescription)")
                completion("[]")
            }
        }
    }

    /// Trigger the native purchase UI for the given SKU. Result JSON:
    ///   Success: {"success":true,"sku":"gems_60","transactionId":"...",
    ///             "platformReceipt":"<jws>","paymentKind":"apple"}
    ///   Failure: {"success":false,"kind":"user-cancelled|network|already-owned|unknown",
    ///             "error":"..."}
    /// Errors surface as "kind" so the TS layer can map to
    /// PurchaseErrorKind. The success path caches the unfinished
    /// Transaction; the caller MUST call consume() with the returned
    /// transactionId once the server has credited the purchase.
    ///
    /// `appAccountTokenUuid` — REQUIRED for anti-fraud. When non-empty
    /// and a valid UUID string, StoreKit stamps the transaction JWS
    /// with `appAccountToken = <uuid>`. The server verifies this
    /// matches the requesting player's uuid, blocking replay attacks
    /// where one player's receipt is submitted to another player's
    /// account. Pass empty string to skip (dev only — production
    /// server should reject transactions without appAccountToken).
    @objc public func buy(skuId: String, appAccountTokenUuid: String, completion: @escaping (String) -> Void) {
        Task {
            // Auto-fetch fallback: if the TS layer never called
            // fetchLocalizedPrices for this SKU (e.g. TopUpController
            // hasn't wired the price-display step yet), pull just this
            // one product on-demand so buy() still works. Small extra
            // network round-trip; only happens the first time each SKU
            // is bought in a session.
            if self.productCache[skuId] == nil {
                do {
                    let fetched = try await Product.products(for: [skuId])
                    for p in fetched {
                        self.productCache[p.id] = p
                    }
                } catch {
                    completion(Self.errorJSON(kind: "network", detail: "product fetch failed: \(error.localizedDescription)"))
                    return
                }
            }
            guard let product = self.productCache[skuId] else {
                // Product truly doesn't exist in the App Store for this
                // sandbox / storefront. Common causes: SKU not created
                // in ASC yet, product ID typo, or ASC propagation delay
                // (new IAPs take 15-60 minutes to reach StoreKit).
                completion(Self.errorJSON(kind: "unknown", detail: "product not available in App Store (check ASC + wait 15-60 min for new IAPs to propagate)"))
                return
            }
            do {
                // Build purchase options — if we got a valid UUID from
                // the TS layer, tag the transaction so the server can
                // bind receipt → uuid. UUID(uuidString:) returns nil
                // for anything non-UUID; we silently drop the tag in
                // that case (server anti-fraud will reject the topup).
                var options: Set<Product.PurchaseOption> = []
                if !appAccountTokenUuid.isEmpty,
                   let token = UUID(uuidString: appAccountTokenUuid) {
                    options.insert(.appAccountToken(token))
                    NSLog("[IAP] buy \(skuId) with appAccountToken=\(appAccountTokenUuid)")
                } else if !appAccountTokenUuid.isEmpty {
                    NSLog("[IAP] buy \(skuId) — appAccountToken value '\(appAccountTokenUuid)' is not a valid UUID, dropping")
                } else {
                    NSLog("[IAP] buy \(skuId) — no appAccountToken (dev / unregistered player?)")
                }
                let result = try await product.purchase(options: options)
                switch result {
                case .success(let verification):
                    switch verification {
                    case .verified(let tx):
                        let jws = verification.jwsRepresentation
                        // Cache — DO NOT finish() yet. Server confirms first.
                        self.unfinishedTransactions[String(tx.id)] = tx
                        let response: [String: Any] = [
                            "success": true,
                            "sku": tx.productID,
                            "transactionId": String(tx.id),
                            "platformReceipt": jws,
                            "paymentKind": "apple",
                        ]
                        completion(Self.encodeJSON(response) ?? Self.errorJSON(kind: "unknown", detail: "json encode failed"))
                    case .unverified(_, let err):
                        completion(Self.errorJSON(kind: "unknown", detail: "unverified: \(err.localizedDescription)"))
                    }
                case .userCancelled:
                    completion(Self.errorJSON(kind: "user-cancelled", detail: "user dismissed the purchase sheet"))
                case .pending:
                    // Ask to Buy / SCA pending. Transaction will arrive
                    // via Transaction.updates later — surfaced as pending.
                    completion(Self.errorJSON(kind: "unknown", detail: "pending approval"))
                @unknown default:
                    completion(Self.errorJSON(kind: "unknown", detail: "unknown result"))
                }
            } catch {
                // StoreKitError.networkError, .systemError, .notEntitled, etc.
                let kind = Self.mapPurchaseError(error)
                completion(Self.errorJSON(kind: kind, detail: error.localizedDescription))
            }
        }
    }

    /// Finish the transaction — called AFTER the server has credited
    /// the gems. Removes it from Apple's queue so the same SKU can be
    /// bought again (for consumables like gems).
    /// Result JSON: {"success":true} or {"success":false,"error":"..."}
    @objc public func consume(transactionId: String, completion: @escaping (String) -> Void) {
        Task {
            // Fast path: cached from buy().
            if let tx = self.unfinishedTransactions[transactionId] {
                await tx.finish()
                self.unfinishedTransactions.removeValue(forKey: transactionId)
                completion(#"{"success":true}"#)
                return
            }
            // Fallback: scan currently-unfinished transactions (covers
            // relaunch-after-crash cases).
            for await result in Transaction.unfinished {
                if case .verified(let tx) = result, String(tx.id) == transactionId {
                    await tx.finish()
                    completion(#"{"success":true}"#)
                    return
                }
            }
            completion(#"{"success":false,"error":"transaction-not-found"}"#)
        }
    }

    /// Enumerate all non-consumable entitlements the player still has.
    /// For our current SKU set (all consumables) this normally returns
    /// []. Kept for the "Restore Purchases" button Apple mandates.
    /// Result JSON: [{"sku":"...","transactionId":"...","platformReceipt":"...","paymentKind":"apple"}, ...]
    @objc public func restore(completion: @escaping (String) -> Void) {
        Task {
            var receipts: [[String: Any]] = []
            for await result in Transaction.currentEntitlements {
                if case .verified(let tx) = result {
                    receipts.append([
                        "sku": tx.productID,
                        "transactionId": String(tx.id),
                        "platformReceipt": result.jwsRepresentation,
                        "paymentKind": "apple",
                    ])
                }
            }
            completion(Self.encodeJSON(receipts) ?? "[]")
        }
    }

    // MARK: - Background listener

    private func handleUpdate(result: VerificationResult<Transaction>) {
        guard case .verified(let tx) = result else { return }
        // A transaction we DIDN'T just buy — e.g. Ask to Buy approved,
        // or refund reversal. Cache it so consume() can find it, and
        // signal JS so it can call topupWallet() to catch up on the
        // credit.
        self.unfinishedTransactions[String(tx.id)] = tx
        let payload: [String: Any] = [
            "sku": tx.productID,
            "transactionId": String(tx.id),
            "platformReceipt": result.jwsRepresentation,
            "paymentKind": "apple",
        ]
        if let json = Self.encodeJSON(payload), let cb = self.onPendingTransaction {
            DispatchQueue.main.async { cb(json) }
        }
    }

    // MARK: - Helpers

    private static func encodeJSON(_ obj: Any) -> String? {
        guard let data = try? JSONSerialization.data(withJSONObject: obj, options: []) else {
            return nil
        }
        return String(data: data, encoding: .utf8)
    }

    private static func errorJSON(kind: String, detail: String) -> String {
        let obj: [String: Any] = [
            "success": false,
            "kind": kind,
            "error": detail,
        ]
        return encodeJSON(obj) ?? #"{"success":false,"kind":"unknown","error":"encode failure"}"#
    }

    private static func mapPurchaseError(_ err: Error) -> String {
        if let sk = err as? StoreKitError {
            switch sk {
            case .userCancelled:      return "user-cancelled"
            case .networkError:       return "network"
            case .notEntitled:        return "already-owned"
            case .notAvailableInStorefront: return "unknown"
            case .systemError:        return "unknown"
            case .unknown:            return "unknown"
            @unknown default:         return "unknown"
            }
        }
        if let purchaseErr = err as? Product.PurchaseError {
            switch purchaseErr {
            case .productUnavailable:  return "unknown"
            case .purchaseNotAllowed:  return "unknown"
            case .ineligibleForOffer:  return "unknown"
            case .invalidOfferIdentifier, .invalidOfferPrice, .invalidOfferSignature,
                 .missingOfferParameters:
                return "unknown"
            @unknown default:          return "unknown"
            }
        }
        return "unknown"
    }
}
