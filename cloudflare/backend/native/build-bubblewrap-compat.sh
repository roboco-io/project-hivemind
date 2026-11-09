#!/bin/sh
set -eu

bwrap_build_root=${1:-/build}
bwrap_output_root=${2:-/artifacts}
bwrap_input_root=${3:-/build-input}
bwrap_version=0.8.0-2+deb12u1
bwrap_source_dir="$bwrap_output_root/bubblewrap-source"

mkdir -p "$bwrap_build_root" "$bwrap_output_root/bin" "$bwrap_source_dir/downloads" "$bwrap_source_dir/licenses" "$bwrap_source_dir/build-files"
cd "$bwrap_build_root"
# apt checks the source archives against the signed Debian repository metadata.
apt-get source "bubblewrap=$bwrap_version"
test "$(dpkg-parsechangelog --file bubblewrap-0.8.0/debian/changelog --show-field Version)" = "$bwrap_version"
cp "$bwrap_build_root"/bubblewrap_* "$bwrap_source_dir/downloads/"
cd bubblewrap-0.8.0
patch --batch --forward --fuzz=0 -p1 < "$bwrap_input_root/bubblewrap-nested-proc.patch"

# Match Debian's PIE/bindnow hardening and retain its SELinux-enabled build.
export DEB_BUILD_MAINT_OPTIONS=hardening=+pie,+bindnow
export CFLAGS="$(dpkg-buildflags --get CFLAGS)"
export CPPFLAGS="$(dpkg-buildflags --get CPPFLAGS)"
export LDFLAGS="$(dpkg-buildflags --get LDFLAGS)"
meson setup "$bwrap_build_root/out" . -Dselinux=enabled -Dman=disabled -Dtests=false -Dbash_completion=disabled -Dzsh_completion=disabled
meson compile -C "$bwrap_build_root/out"
install -m 0755 "$bwrap_build_root/out/bwrap" "$bwrap_output_root/bin/bwrap"

cp COPYING "$bwrap_source_dir/licenses/COPYING"
cp debian/copyright "$bwrap_source_dir/licenses/debian-copyright"
cp /usr/share/common-licenses/LGPL-2 /usr/share/common-licenses/GPL-2 "$bwrap_source_dir/licenses/"
cp -a debian/patches "$bwrap_source_dir/debian-patches"
cp "$bwrap_input_root/bubblewrap-nested-proc.patch" "$bwrap_source_dir/"
cp "$bwrap_input_root/BUBBLEWRAP-NOTICE.md" "$bwrap_source_dir/NOTICE.md"
cp "$bwrap_input_root/bubblewrap-compatibility.md" "$bwrap_source_dir/BUILD.md"
cp "$bwrap_input_root/build-bubblewrap-compat.sh" "$bwrap_source_dir/rebuild.sh"
cp "$bwrap_input_root/Dockerfile.backend" "$bwrap_input_root/Dockerfile.phase0" "$bwrap_source_dir/build-files/"
cp -a "$bwrap_input_root" "$bwrap_source_dir/build-input"
mkdir -p hivemind-patches
cp "$bwrap_input_root/bubblewrap-nested-proc.patch" hivemind-patches/
tar -C "$bwrap_build_root" -cJf "$bwrap_source_dir/modified-source.tar.xz" bubblewrap-0.8.0
printf '%s\n' "$bwrap_version" > "$bwrap_source_dir/DEBIAN-SOURCE-VERSION"
sha256sum "$bwrap_output_root/bin/bwrap" | sed "s@ $bwrap_output_root/bin/bwrap\$@ /opt/hivemind/compat-bin/bwrap@" > "$bwrap_source_dir/BINARY.sha256"
cd "$bwrap_source_dir"
find . -type f ! -name SHA256SUMS -print0 | sort -z | xargs -0 sha256sum > SHA256SUMS
