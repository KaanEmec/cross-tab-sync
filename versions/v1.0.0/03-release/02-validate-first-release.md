# Validate the first release

## Goal
Confirm that the agreed browsing workflow works reliably end to end.

## Expected outcome
v1.0.0 meets the project behavior contract with documented compatibility and no unresolved blocking failures.

## Tasks
- Run bidirectional handover and automatic-sync scenarios on Safari/macOS and Brave/Windows.
- Cover offline additions, closures, reopening, navigation conflicts, and long-disconnected devices.
- Cover duplicate URLs, existing local duplicates, private-tab exclusion, order, and pinned-state fallback.
- Cover shutdown, crashes, suspension, interrupted application, retries, and recovery.
- Verify authentication, revocation, log privacy, and the chosen encryption behavior.
- Record results and remaining limitations; confirm scope excludes cookies, history, groups, and window organization.
