# Validate online synchronization

## Goal
Verify the complete automatic behavior on both target browsers.

## Expected outcome
Repeatable online scenarios pass with no ownership loops, duplicate creation, or unintended shared deletion.

## Tasks
- Exercise automatic takeover, manual overrides, and two focused computers.
- Exercise additions, navigation, explicit closures, duplicate URLs, and window shutdown.
- Exercise five-minute alarms, background suspension, restart, and unavailable destinations.
- Interrupt requests and application; verify retry safety and stale-write rejection.
- Document browser versions, observed limitations, and unresolved failures.
