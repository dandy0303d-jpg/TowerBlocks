cmake_minimum_required(VERSION 3.16)  # 3.15+ for Swift, 3.16 for stable iOS Swift

set(CMAKE_SYSTEM_NAME iOS)

# StoreKit 2 requires iOS 15.0. See docs/BRANCHING.md § iOS deployment target.
set(CMAKE_OSX_DEPLOYMENT_TARGET "15.0" CACHE STRING "Minimum iOS deployment target")

# CMake's Swift language detection can't always find swiftc in the Xcode
# toolchain (bug/quirk when using -G Xcode generator). Locate it via
# xcrun BEFORE project() so enable-language succeeds.
if(NOT DEFINED CMAKE_Swift_COMPILER)
    execute_process(
        COMMAND xcrun --sdk iphoneos --find swiftc
        OUTPUT_VARIABLE _swiftc_path
        OUTPUT_STRIP_TRAILING_WHITESPACE
        ERROR_QUIET
    )
    if(_swiftc_path)
        set(CMAKE_Swift_COMPILER "${_swiftc_path}" CACHE FILEPATH "swiftc" FORCE)
        message(STATUS "Using Swift compiler: ${_swiftc_path}")
    endif()
endif()

set(APP_NAME "tower-blocks"  CACHE STRING "Project Name")

# Enable Swift alongside C++ for StoreKit 2 native bridge.
# Use a fixed safe identifier for project() — APP_NAME can be overridden
# by Cocos with a user-facing string like "Tetri Tower: To the Heavens"
# which contains spaces/colons that CMake project() cannot handle.
project(tower_blocks CXX Swift)

set(CC_PROJECT_DIR ${CMAKE_CURRENT_LIST_DIR})
set(CC_UI_RESOURCES)
set(CC_PROJ_SOURCES)
set(CC_ASSET_FILES)
set(CC_COMMON_SOURCES)
set(CC_ALL_SOURCES)

include(${CC_PROJECT_DIR}/../common/CMakeLists.txt)
set(EXECUTABLE_NAME ${APP_NAME}-mobile)

# StoreKit 2 IAP bridge — Swift + ObjC glue. Add explicitly to the
# source list Cocos assembles; these files aren't picked up by the
# default iOS template scan.
list(APPEND CC_ALL_SOURCES
    ${CC_PROJECT_DIR}/service/iap/PurchaseBridge.swift
    ${CC_PROJECT_DIR}/service/iap/PurchaseBridgeGlue.h
    ${CC_PROJECT_DIR}/service/iap/PurchaseBridgeGlue.mm
    ${CC_PROJECT_DIR}/service/auth/AppleAuthBridge.swift
    ${CC_PROJECT_DIR}/service/auth/AppleAuthBridgeGlue.h
    ${CC_PROJECT_DIR}/service/auth/AppleAuthBridgeGlue.mm
    ${CC_PROJECT_DIR}/service/auth/GoogleAuthBridge.swift
    ${CC_PROJECT_DIR}/service/auth/GoogleAuthBridgeGlue.h
    ${CC_PROJECT_DIR}/service/auth/GoogleAuthBridgeGlue.mm
    ${CC_PROJECT_DIR}/service/gc/GameCenterBridge.swift
    ${CC_PROJECT_DIR}/service/gc/GameCenterBridgeGlue.h
    ${CC_PROJECT_DIR}/service/gc/GameCenterBridgeGlue.mm
    ${CC_PROJECT_DIR}/service/haptic/HapticBridge.swift
    ${CC_PROJECT_DIR}/service/haptic/HapticBridgeGlue.h
    ${CC_PROJECT_DIR}/service/haptic/HapticBridgeGlue.mm
    # AppLovin MAX bridge — files kept on disk for future mediation
    # reference but NOT compiled (Podfile does not include AppLovinSDK,
    # so Swift can't resolve `import AppLovinSDK`). Re-add these three
    # lines and add `pod 'AppLovinSDK'` to Podfile if switching back
    # to AppLovin, or use AppLovin as a mediation network under AdMob.
    #     ${CC_PROJECT_DIR}/service/ads/AppLovinBridge.swift
    #     ${CC_PROJECT_DIR}/service/ads/AppLovinBridgeGlue.h
    #     ${CC_PROJECT_DIR}/service/ads/AppLovinBridgeGlue.mm
    # Google AdMob bridge — active ad provider.
    ${CC_PROJECT_DIR}/service/ads/AdMobBridge.swift
    ${CC_PROJECT_DIR}/service/ads/AdMobBridgeGlue.h
    ${CC_PROJECT_DIR}/service/ads/AdMobBridgeGlue.mm
    ${CC_PROJECT_DIR}/service/ClipboardBridgeGlue.h
    ${CC_PROJECT_DIR}/service/ClipboardBridgeGlue.mm
    # Firebase bridge — Analytics, Crashlytics, Remote Config.
    # No Swift companion here; the .mm uses `@import Firebase*` module
    # imports directly, so all logic lives in one file.
    ${CC_PROJECT_DIR}/service/FirebaseBridgeGlue.h
    ${CC_PROJECT_DIR}/service/FirebaseBridgeGlue.mm
)

# Bundle the privacy manifest (Apple 2024-05 requirement) into the
# built .app. Adding to CC_ALL_SOURCES + marking as a Resource is the
# Xcode-native way to have it end up at Tetri Tower: To the Heavens.app/PrivacyInfo.xcprivacy
# (the exact path Apple's App Store validator scans for).
set(PRIVACY_MANIFEST ${CC_PROJECT_DIR}/PrivacyInfo.xcprivacy)
list(APPEND CC_ALL_SOURCES ${PRIVACY_MANIFEST})
set_source_files_properties(${PRIVACY_MANIFEST} PROPERTIES
    MACOSX_PACKAGE_LOCATION "Resources")

# Localized InfoPlist.strings — one per language. Each file overrides
# CFBundleDisplayName / CFBundleName / NSUserTrackingUsageDescription
# so iOS shows the localized game name on the Home Screen + localized
# ATT prompt copy based on device language.
#
# NOTE: we don't use `MACOSX_PACKAGE_LOCATION` here because CMake's
# Xcode generator + the fact these files live under `<lang>.lproj/`
# on disk causes double-nesting (`.app/ko.lproj/ko.lproj/InfoPlist.strings`).
# POST_BUILD copy is straightforward and bypasses Xcode's PBXVariantGroup
# logic entirely.
set(INFO_PLIST_LOCALIZATIONS
    ko en ja zh-Hans zh-Hant es fr pt-BR de ru
)

cc_ios_before_target(${EXECUTABLE_NAME})
add_executable(${EXECUTABLE_NAME} ${CC_ALL_SOURCES})
cc_ios_after_target(${EXECUTABLE_NAME})

# POST_BUILD: copy each <lang>.lproj folder into the built .app bundle.
# Uses Xcode's build-time env vars ($TARGET_BUILD_DIR + $WRAPPER_NAME) —
# NOT CMake's $<TARGET_BUNDLE_DIR:...> generator expression, which bakes
# in the wrong SYMROOT path (`build/ios-release/proj/Debug…`) when Xcode
# actually builds into DerivedData. Escaping the $ preserves the literal
# ${...} in the generated pbxproj so Xcode evaluates it at build time.
foreach(LANG IN LISTS INFO_PLIST_LOCALIZATIONS)
    # `\$` is a CMake-literal `$` (won't be expanded as CMake variable).
    # `${LANG}` still gets expanded by CMake. Result string is:
    #   ${TARGET_BUILD_DIR}/${WRAPPER_NAME}/ko.lproj
    # which Xcode evaluates as shell env vars at build time.
    # No VERBATIM here — otherwise CMake shell-escapes `$` into `\$`.
    add_custom_command(TARGET ${EXECUTABLE_NAME} POST_BUILD
        COMMAND ${CMAKE_COMMAND} -E copy_directory
            "${CC_PROJECT_DIR}/${LANG}.lproj"
            "\${TARGET_BUILD_DIR}/\${WRAPPER_NAME}/${LANG}.lproj"
        COMMENT "Copying ${LANG}.lproj into .app bundle"
    )
endforeach()

# ---- CocoaPods integration for AdMob ----
# Copy the source-controlled Podfile into the generated project dir
# (alongside the .xcodeproj) so `pod install` works without extra
# steps after each Cocos regen. COPYONLY = no variable expansion
# (the Podfile has no CMake @VARS@).
configure_file(
    ${CC_PROJECT_DIR}/Podfile
    ${CMAKE_BINARY_DIR}/Podfile
    COPYONLY
)

# Auto-run `pod install` every time CMake regenerates the project.
# Root cause: Cocos rebuilds the xcodeproj from scratch on every
# native build, wiping out the CocoaPods integration (xcconfig refs,
# framework search paths, workspace file). Without this hook you'd
# have to manually run `pod install` after every Cocos build or
# you'd hit `No such module 'GoogleMobileAds'`. Running it at CMake
# configure time is the earliest reliable point — before Xcode ever
# opens the project — so the workspace + Pods are ready by the time
# the user hits Cmd+B.
#
# ~5-10s slow on cold cache (first run downloads pods); fast on
# incremental (CocoaPods diffs Podfile.lock).
find_program(POD_EXECUTABLE
    NAMES pod
    HINTS /usr/local/bin /opt/homebrew/bin
    PATHS ENV PATH
)
if(POD_EXECUTABLE)
    message(STATUS "Auto-running pod install (keeps AdMob framework linked across Cocos regens)...")
    execute_process(
        COMMAND ${POD_EXECUTABLE} install
        WORKING_DIRECTORY ${CMAKE_BINARY_DIR}
        RESULT_VARIABLE POD_RESULT
        OUTPUT_VARIABLE POD_OUTPUT
        ERROR_VARIABLE  POD_ERROR
    )
    if(NOT POD_RESULT EQUAL 0)
        message(WARNING
            "pod install FAILED (exit code ${POD_RESULT}). "
            "Run manually: cd ${CMAKE_BINARY_DIR} && pod install\n"
            "Output: ${POD_OUTPUT}\nError: ${POD_ERROR}")
    else()
        message(STATUS "pod install OK — open Tetri Tower.xcworkspace (NOT .xcodeproj)")
    endif()
else()
    message(WARNING
        "CocoaPods 'pod' binary not found in PATH — AdMob framework won't link. "
        "Install with: sudo gem install cocoapods -v 1.11.3\n"
        "Then run manually: cd ${CMAKE_BINARY_DIR} && pod install")
endif()

# ---- StoreKit 2 + SIWA + ATT frameworks + Swift build settings ----
target_link_libraries(${EXECUTABLE_NAME}
    "-framework StoreKit"
    "-framework AuthenticationServices"
    "-framework GameKit"
    "-framework AppTrackingTransparency"
)

# The Swift-to-ObjC generated header is #import'ed from
# PurchaseBridgeGlue.mm as "tower_blocks_mobile-Swift.h". Xcode
# derives the module name from PRODUCT_MODULE_NAME (default =
# target name with '-' → '_'). Pin it here so the include stays valid
# even if someone changes the target name.
set_target_properties(${EXECUTABLE_NAME} PROPERTIES
    XCODE_ATTRIBUTE_SWIFT_VERSION            "5.0"
    XCODE_ATTRIBUTE_PRODUCT_MODULE_NAME      "tower_blocks_mobile"
    XCODE_ATTRIBUTE_CLANG_ENABLE_MODULES     "YES"
    XCODE_ATTRIBUTE_DEFINES_MODULE           "YES"
    XCODE_ATTRIBUTE_SWIFT_OBJC_INTERFACE_HEADER_NAME "tower_blocks_mobile-Swift.h"
    XCODE_ATTRIBUTE_ALWAYS_EMBED_SWIFT_STANDARD_LIBRARIES "YES"
    # dSYM generation for Release/Archive — otherwise App Store
    # Connect rejects the upload with "The archive did not include
    # a dSYM" and crash reports come back un-symbolicated. Setting
    # for ALL configs (Debug too) — Debug link is ~5% slower but
    # simpler than the per-variant syntax which older CMake versions
    # silently drop.
    XCODE_ATTRIBUTE_DEBUG_INFORMATION_FORMAT "dwarf-with-dsym"
    # DEBUG_INFORMATION_FORMAT alone is NOT enough — Xcode Release
    # template silently sets GCC_GENERATE_DEBUGGING_SYMBOLS=NO which
    # short-circuits dwarf-with-dsym → no .dSYM in Archive → App Store
    # Connect rejects upload with "The archive did not include a dSYM
    # for the Tetri Tower.app". Force YES for ALL configs (Debug too).
    XCODE_ATTRIBUTE_GCC_GENERATE_DEBUGGING_SYMBOLS "YES"
    # Persist the entitlements file across every Cocos regen. Without
    # this, Xcode's "Signing & Capabilities" panel resets on rebuild
    # and any manually-added capability (SIWA / Game Center / iCloud)
    # disappears from the generated project.pbxproj — even though the
    # .entitlements file itself is on disk.
    #
    # Xcode's automatic signing scans the entitlements file we point
    # at and auto-registers the required capabilities on the App ID
    # in the developer portal on next build, so we don't need to
    # click "+ Capability" ever again.
    XCODE_ATTRIBUTE_CODE_SIGN_ENTITLEMENTS   "${CC_PROJECT_DIR}/Tetri Tower: To the Heavens.entitlements"
)
