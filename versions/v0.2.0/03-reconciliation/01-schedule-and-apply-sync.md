# Schedule and apply synchronization

## Goal
Keep followers current without disrupting browsing.

## Expected outcome
Automatic reconciliation runs approximately every five minutes, with immediate takeover and manual sync.

## Tasks
- Use browser alarms and reconcile on startup and resume-related activity.
- Publish owner changes and retrieve newer revisions on followers.
- Apply additions, navigation, and recorded closures using persisted local mappings.
- Recheck tabs before creating them to prevent duplicates from concurrent local actions.
- Suppress echo operations and preserve local focus and selection.
- Recover from partial application without replaying destructive actions blindly.
