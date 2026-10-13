# Define the synchronization contract

## Goal
Turn the agreed behavior into a precise shared protocol.

## Expected outcome
A documented, versioned contract used by both extensions and the backend.

## Tasks
- Define devices, shared tab identities, URL matching, local mappings, ownership generations, and server revisions.
- Define snapshot, open, navigate, close, acquire, and release messages with retry-safe operation IDs.
- Specify last-local-copy closure, intentional reopening, and coalescing entries with the same URL.
- Specify tab order, pinned-state fallback, and receiving-window behavior without window organization.
- Define manual handover ordering, failures, and acknowledgments.
- Record privacy and encryption decisions, including which metadata the server must inspect.
