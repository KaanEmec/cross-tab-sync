# Implement deterministic offline merging

## Goal
Combine independent device changes according to the agreed rules.

## Expected outcome
Reconnects converge to the same deduplicated session regardless of retries or arrival order.

## Tasks
- Reconcile pending offline changes separately from normal owner publication.
- Union intentional additions while respecting closure tombstones for old openings.
- Preserve a fresh concurrent reopening when another device closes the earlier opening.
- Preserve both resulting URLs after divergent offline navigation.
- Coalesce identical URLs and resolve metadata consistently using causal revisions.
- Verify convergence with reordered, repeated, and interrupted submissions.
