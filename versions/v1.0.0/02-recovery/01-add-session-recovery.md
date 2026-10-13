# Add session recovery

## Goal
Make unintended shared changes recoverable.

## Expected outcome
The user can inspect and restore a recent session snapshot without bypassing synchronization rules.

## Tasks
- Retain a bounded set of recovery snapshots with revision and device information.
- Provide a concise snapshot list and explicit restore action.
- Apply restoration as new versioned operations rather than rewinding revisions.
- Preserve a snapshot of the pre-restore state.
- Explain that URL recovery cannot restore unsaved forms or page memory.
- Verify recovery after accidental closure and interrupted restoration.
