/**
 * ConsentApi — HTTP calls for user-agreement / privacy consent.
 *
 *   GET  /player/consent/status   — poll every launch to check if the
 *                                   player has agreed to the CURRENT
 *                                   version of ToS + Privacy
 *   POST /player/consent          — record agreement (with age +
 *                                   optional marketing opt-in)
 *
 * Loading flow (see LoadingController):
 *   1. ensureRegistered → bearer available
 *   2. ConsentApi.fetchStatus()
 *      - needsConsent=false → continue booting
 *      - needsConsent=true  → pause loading, show ConsentModal
 *   3. ConsentModal → user checks required boxes → POST /player/consent
 *   4. On 200 → resume boot, hand off to MenuController
 */

import { httpGetJson, httpPostJson } from './Http';
import { BACKEND_BASE_URL } from './BackendConfig';

export interface ConsentVersions {
    tos:     string;
    privacy: string;
}

export interface ConsentAgreedState {
    tos:            string;
    privacy:        string;
    ageConfirmed:   boolean;
    marketingOptIn: boolean;
}

export interface ConsentStatusResult {
    needsConsent: boolean;
    current:      ConsentVersions;
    /** Only present if the player has ever agreed. Use to show "you
     *  previously agreed to versions X/Y" if we want, otherwise ignore. */
    agreed?:      ConsentAgreedState;
}

export async function fetchConsentStatus(): Promise<ConsentStatusResult> {
    const url = `${BACKEND_BASE_URL}/player/consent/status`;
    return httpGetJson<ConsentStatusResult>(url);
}

export interface ConsentPostBody {
    tosVersion:      string;
    privacyVersion:  string;
    ageConfirmed:    boolean;
    marketingOptIn:  boolean;
}

export interface ConsentPostResult {
    ok: true;
}

/** Record the player's agreement. Server rejects (409) if the client's
 *  posted versions don't match server-authoritative current versions —
 *  in that case caller should re-fetch status and re-show the modal. */
export async function postConsent(body: ConsentPostBody): Promise<ConsentPostResult> {
    const url = `${BACKEND_BASE_URL}/player/consent`;
    return httpPostJson<ConsentPostResult>(url, body);
}
