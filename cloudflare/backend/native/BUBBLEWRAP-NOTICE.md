# Bubblewrap compatibility binary

This image contains a modified Bubblewrap executable at `/opt/hivemind/compat-bin/bwrap`.
It is built from Debian source package `bubblewrap` version `0.8.0-2+deb12u1`.
Bubblewrap and its Debian packaging are licensed under LGPL-2.0-or-later.
The source also includes the Autoconf macro exception described in Debian's copyright file.

Upstream: https://github.com/containers/bubblewrap/
Upstream copyright: 2016 Alexander Larsson.
Debian packaging copyright: 2016 Laszlo Boszormenyi (GCS).
HIVEMIND patch copyright: 2026 roboco-io contributors; LGPL-2.0-or-later.

The patch makes the existing namespace identifier query conditional on a requested
`--info-fd` or `--json-status-fd`. It changes no mount, namespace, capability,
filesystem, network or seccomp option. This is a modified third-party dependency,
not a modified Codex CLI, Claude Code CLI or Anthropic sandbox-runtime package.
The system `/usr/bin/bwrap` remains the Debian package's original executable.

The image includes corresponding source, original Debian source archives, Debian
patches, the HIVEMIND patch, build instructions and license texts at
`/usr/share/hivemind/bubblewrap-source`. Redistribute that directory with this
modified binary. `BUILD.md` explains how to rebuild and verify the bundle.
