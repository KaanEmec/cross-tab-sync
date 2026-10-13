# Create the Go service and SQLite storage

## Goal
Provide a durable foundation for session coordination.

## Expected outcome
A runnable API service with versioned storage and restart-safe session state.

## Tasks
- Set up the Go service, configuration, health endpoint, and graceful shutdown.
- Add SQLite migrations for devices, sessions, ownership, revisions, operations, and snapshots.
- Define transaction boundaries for ownership and session updates.
- Add request validation, payload limits, and structured errors.
- Verify restart persistence and migration behavior.
