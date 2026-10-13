# Implement session coordination

## Goal
Store the shared session and enforce a single current publisher.

## Expected outcome
Authenticated clients can fetch state, acquire control, publish changes, and release control safely.

## Tasks
- Implement atomic ownership acquisition and generation checks.
- Implement revision-checked publication and retry-safe operation processing.
- Return snapshots, changes since a revision, and clear stale-owner responses.
- Save a recovery snapshot before session changes that may remove or replace tabs.
- Define takeover from unavailable devices without waiting indefinitely.
- Verify concurrent acquisition, delayed writes, and duplicate requests.
