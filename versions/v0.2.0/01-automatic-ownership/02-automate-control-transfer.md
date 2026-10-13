# Automate control transfer

## Goal
Transfer ownership on local activity while preventing competing publishers.

## Expected outcome
The newly used browser catches up and becomes the sole accepted publisher.

## Tasks
- Request ownership on qualified activity and reconcile before publishing local changes.
- Ask the prior owner to flush if reachable; use saved state if unavailable.
- Maintain ownership liveness without treating heartbeats as user attention.
- Reject and reconcile writes from superseded owners.
- Keep manual controls available and expose current ownership in the popup.
- Verify simultaneous takeover requests, disconnects, and delayed prior-owner uploads.
