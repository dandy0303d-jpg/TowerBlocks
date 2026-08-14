#!/bin/bash
# Patch Cocos Creator 3.8.8's enoki/half.h to be compatible with
# newer libc++ (Xcode 15+, tested through Xcode 26.6).
#
# Background:
#   enoki/half.h contains user specializations of std::is_floating_point,
#   std::is_arithmetic, std::is_signed for the enoki::half type.
#   C++20 forbids user code from specializing these standard type traits,
#   and newer libc++ (Xcode 15+) enforces this with the
#   [[_Clang::no_specializations]] attribute — turning the previous warning
#   into a hard compile error. This blocks native iOS builds.
#
# The patch wraps the three specializations in a preprocessor guard so they
# only compile on old libc++ (Xcode 14 and earlier). Cocos elsewhere does
# not depend on these traits being specialized for enoki::half, so skipping
# them on new toolchains is safe.
#
# Usage:  sudo ./scripts/patch-cocos-enoki.sh
# Rerun:  idempotent — safe to run multiple times.
# Undo:   sudo cp <path>/half.h.bak <path>/half.h

set -e

COCOS_VER="3.8.8"
ENOKI_DIR="/Applications/Cocos/Creator/${COCOS_VER}/CocosCreator.app/Contents/Resources/resources/3d/engine/native/external/sources/enoki"
TARGET="${ENOKI_DIR}/half.h"

# --- Preflight --------------------------------------------------------------

if [ "$(id -u)" -ne 0 ]; then
    echo "ERROR: this script writes into /Applications and needs sudo." >&2
    echo "Rerun with:  sudo $0" >&2
    exit 1
fi

if [ ! -f "$TARGET" ]; then
    echo "ERROR: cannot find $TARGET" >&2
    echo "Is Cocos Creator ${COCOS_VER} installed at /Applications/Cocos/Creator/${COCOS_VER}/ ?" >&2
    exit 1
fi

# --- Idempotency check ------------------------------------------------------

if grep -q "_LIBCPP_VERSION < 170000" "$TARGET"; then
    echo "Already patched. Nothing to do."
    exit 0
fi

# --- Backup (only on first patch) ------------------------------------------

if [ ! -f "${TARGET}.bak" ]; then
    cp "$TARGET" "${TARGET}.bak"
    echo "Backed up original -> ${TARGET}.bak"
fi

# --- Apply patch ------------------------------------------------------------

python3 <<PYEOF
import re, sys

path = "$TARGET"
with open(path) as f:
    src = f.read()

pattern = re.compile(
    r'(NAMESPACE_BEGIN\(std\)\s*\n'
    r'template<>\s*struct\s+is_floating_point<enoki::half>[^\n]*\n'
    r'template<>\s*struct\s+is_arithmetic<enoki::half>[^\n]*\n'
    r'template<>\s*struct\s+is_signed<enoki::half>[^\n]*\n'
    r'NAMESPACE_END\(std\))'
)

new_src, n = pattern.subn(
    r'#if !defined(_LIBCPP_VERSION) || _LIBCPP_VERSION < 170000\n\1\n#endif',
    src,
    count=1,
)

if n == 0:
    print("ERROR: patch pattern did not match. Cocos version may differ. Inspect the file manually:", path, file=sys.stderr)
    sys.exit(2)

with open(path, "w") as f:
    f.write(new_src)

print("Patch applied.")
PYEOF

# --- Verify -----------------------------------------------------------------

if grep -q "_LIBCPP_VERSION < 170000" "$TARGET"; then
    echo ""
    echo "OK. half.h now guards the std specializations for libc++ 17+."
    echo ""
    echo "Next steps:"
    echo "  1. Close Xcode."
    echo "  2. Clear Xcode DerivedData for this project:"
    echo "       rm -rf ~/Library/Developer/Xcode/DerivedData/tower-blocks-*"
    echo "  3. Reopen build/ios/proj/tower-blocks.xcodeproj"
    echo "  4. Product -> Clean Build Folder (Cmd+Shift+K)"
    echo "  5. Cmd+R to Run"
else
    echo "ERROR: post-patch verification failed." >&2
    exit 3
fi
