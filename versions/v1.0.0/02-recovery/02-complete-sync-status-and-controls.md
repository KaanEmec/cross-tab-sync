# Complete synchronization status and controls

## Goal
Make sync behavior and failures understandable.

## Expected outcome
The popup clearly shows which device controls the session and whether work is saved, pending, or applied remotely.

## Tasks
- Show owner, last successful sync, offline state, and pending changes.
- Distinguish server acknowledgment from destination-device application.
- Add retry, pause/resume, and device revocation controls.
- Define resume reconciliation so paused activity never implies shared deletion.
- Present actionable authentication, permission, and backend errors.
- Verify status remains accurate through takeover, sleep, reconnect, and partial failure.
