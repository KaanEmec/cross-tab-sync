# Persist offline changes

## Goal
Preserve observed local work while the backend is unreachable.

## Expected outcome
Each extension retains a durable pending-change journal through disconnects and browser restarts.

## Tasks
- Store operation IDs, base revisions, shared identities, and causal information locally.
- Record local openings, navigation, and explicit closures even without online ownership.
- Distinguish fresh local actions from stale restored tabs and remote application.
- Retry with bounded backoff and retain operations until acknowledged.
- Expose offline status and pending work without claiming global ownership.
- Verify restart recovery and interrupted request acknowledgments.
