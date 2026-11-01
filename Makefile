.PHONY: release

# Builds and publishes release VERSION (an existing local tag) on a Mac; DRY_RUN=1 builds without
# publishing. Steps and one-time setup: scripts/release.sh and safari/README.md#release.
release:
	@test -n "$(VERSION)" || { echo "usage: make release VERSION=vX.Y.Z [DRY_RUN=1]" >&2; exit 1; }
	DRY_RUN="$(or $(DRY_RUN),0)" ./scripts/release.sh "$(VERSION)"
