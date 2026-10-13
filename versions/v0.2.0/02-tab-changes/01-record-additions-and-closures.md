# Record additions and explicit closures

## Goal
Propagate tab changes without deleting tabs based on snapshot absence.

## Expected outcome
New URLs sync additively; recorded individual-tab closures remove the corresponding shared entry.

## Tasks
- Maintain local tab-to-shared-entry mappings and count local URL duplicates.
- Record genuine additions and closure of the last local copy.
- Exclude window closure, shutdown, crash recovery, and unobserved absence from shared deletion.
- Persist closure tombstones so stale device state cannot resurrect tabs.
- Treat deliberate reopening as a fresh opening.
- Verify additions, duplicate copies, explicit closure, and shutdown preservation.
