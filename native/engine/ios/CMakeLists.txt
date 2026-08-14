cmake_minimum_required(VERSION 3.16)  # 3.15+ for Swift, 3.16 for stable iOS Swift

set(CMAKE_SYSTEM_NAME iOS)

# StoreKit 2 requires iOS 15.0. See docs/BRANCHING.md § iOS deployment target.
set(CMAKE_OSX_DEPLOYMENT_TARGET "15.0" CACHE STRING "Minimum iOS deployment target")

set(APP_NAME "tower-blocks"  CACHE STRING "Project Name")

# Enable Swift alongside C++ for StoreKit 2 native bridge.
# The Swift source files themselves are added via CC_PROJ_SOURCES in
# ../common/CMakeLists.txt's platform-specific hook; project() just
# tells CMake the toolchain must include swiftc.
project(${APP_NAME} CXX Swift)

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
)

cc_ios_before_target(${EXECUTABLE_NAME})
add_executable(${EXECUTABLE_NAME} ${CC_ALL_SOURCES})
cc_ios_after_target(${EXECUTABLE_NAME})

# ---- StoreKit 2 framework + Swift build settings ----
target_link_libraries(${EXECUTABLE_NAME} "-framework StoreKit")

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
