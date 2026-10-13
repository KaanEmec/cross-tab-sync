# Handle long-disconnected devices

## Goal
Prevent obsolete local state from undoing newer session changes.

## Expected outcome
A device can return after extended absence without resurrecting closed tabs or losing genuine new work.

## Tasks
- Define operation and tombstone retention with a minimum supported revision.
- Require a full resync when a device's revision is outside retained history.
- Preserve pending intentional local work during full resync.
- Prevent old snapshots from being interpreted as new opening operations.
- Apply ownership checks before normal publication resumes.
- Verify stale devices, revoked devices, and expired change history.
