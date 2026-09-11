/**
 * MockAdProvider — default IAdProvider for main / non-channel builds.
 *
 * Simulates an instantly-loading rewarded ad that always resolves with
 * 'rewarded' after a short delay. Lets you test the "watch ad → grant
 * reward" flow end-to-end in the editor / on a plain APK without any
 * real ad SDK integration.
 */

import { IAdProvider, AdShowResult } from './IAdProvider';

const MOCK_SHOW_DELAY_MS = 400;

export class MockAdProvider implements IAdProvider {

    private _ready = false;

    async init(): Promise<void> {
        await this.loadRewardedAd();
    }

    async loadRewardedAd(): Promise<void> {
        this._ready = true;
    }

    isRewardedAdReady(): boolean {
        return this._ready;
    }

    async showRewardedAd(): Promise<AdShowResult> {
        if (!this._ready) return { kind: 'error', reason: 'not-loaded' };
        this._ready = false;
        await new Promise<void>(resolve => setTimeout(resolve, MOCK_SHOW_DELAY_MS));
        void this.loadRewardedAd();
        return { kind: 'rewarded' };
    }
}
