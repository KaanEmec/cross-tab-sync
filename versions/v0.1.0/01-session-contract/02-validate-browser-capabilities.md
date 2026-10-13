# Validate browser capabilities

## Goal
Prove the required Safari and Brave extension capabilities before building the sync engine.

## Expected outcome
A minimal technical prototype and a documented compatibility matrix for supported browser versions.

## Tasks
- Verify reading URLs and observing creation, removal, navigation, activation, focus, and startup.
- Verify creating, reusing, moving, pinning, and closing tabs.
- Verify alarms, background suspension, local persistence, and HTTPS access to the backend.
- Check permissions, private-tab exclusion, and window-close versus individual-close behavior.
- Record limits around detecting human activity, navigation, and other extensions' changes.
- Confirm Safari packaging and document any required behavior fallback.
