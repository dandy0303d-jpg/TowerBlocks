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
    ${CC_PROJECT_DIR}/service/gc/GameCenterBridge.swift
    ${CC_PROJECT_DIR}/service/gc/GameCenterBridgeGlue.h
    ${CC_PROJECT_DIR}/service/gc/GameCenterBridgeGlue.mm
    ${CC_PROJECT_DIR}/service/haptic/HapticBridge.swift
    ${CC_PROJECT_DIR}/service/haptic/HapticBridgeGlue.h
    ${CC_PROJECT_DIR}/service/haptic/HapticBridgeGlue.mm
    ${CC_PROJECT_DIR}/service/cloudkv/CloudKVBridge.swift
    ${CC_PROJECT_DIR}/service/cloudkv/CloudKVBridgeGlue.h
    ${CC_PROJECT_DIR}/service/cloudkv/CloudKVBridgeGlue.mm
    ${CC_PROJECT_DIR}/service/ClipboardBridgeGlue.h
    ${CC_PROJECT_DIR}/service/ClipboardBridgeGlue.mm
)

# Bundle the privacy manifest (Apple 2024-05 requirement) into the
# built .app. Adding to CC_ALL_SOURCES + marking as a Resource is the
# Xcode-native way to have it end up at Tetri Tower: To the Heavens.app/PrivacyInfo.xcprivacy
# (the exact path Apple's App Store validator scans for).
set(PRIVACY_MANIFEST ${CC_PROJECT_DIR}/PrivacyInfo.xcprivacy)
list(APPEND CC_ALL_SOURCES ${PRIVACY_MANIFEST})
set_source_files_properties(${PRIVACY_MANIFEST} PROPERTIES
    MACOSX_PACKAGE_LOCATION "Resources")

cc_ios_before_target(${EXECUTABLE_NAME})
add_executable(${EXECUTABLE_NAME} ${CC_ALL_SOURCES})
cc_ios_after_target(${EXECUTABLE_NAME})

# ---- StoreKit 2 + SIWA frameworks + Swift build settings ----
target_link_libraries(${EXECUTABLE_NAME}
    "-framework StoreKit"
    "-framework AuthenticationServices"
    "-framework GameKit"
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
)
