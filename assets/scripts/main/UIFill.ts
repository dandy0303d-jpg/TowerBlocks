/**
 * Placeholder — the Sprite-based UI fill helpers that used to live here
 * were reverted because the Cocos 3.8.8 runtime texture upload path hit
 * "texSubImage2D Overload resolution failed" in editor preview, and we
 * couldn't find a reliable workaround in time. The original Graphics-
 * based fills are back in MenuController/HudController. If/when we
 * revisit Android UI rendering, this file can host a shared white-
 * texture helper again.
 *
 * Deliberately empty of side-effects.
 */
export {};
