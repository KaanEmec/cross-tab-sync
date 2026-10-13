# Cross-Tab-Sync delivery roadmap

The folders under `versions/` are planning milestones. v0.1.0 and v0.2.0 are development previews; v1.0.0 is the complete first release described in [the project overview](README.md).

| Version | Goal | Epics |
| --- | --- | --- |
| [v0.1.0](versions/v0.1.0/) | Establish the protocol and complete manual handover between Safari and Brave. | 01 Session contract; 02 Backend; 03 Extensions |
| [v0.2.0](versions/v0.2.0/) | Add automatic ownership, additive sync, explicit closures, and navigation. | 01 Automatic ownership; 02 Tab changes; 03 Reconciliation |
| [v1.0.0](versions/v1.0.0/) | Complete offline merging, recovery, installation, and release validation. | 01 Offline merging; 02 Recovery; 03 Release |

## How to use the jobs

Each job file contains its goal, expected outcome, and concise completion tasks. Numbers suggest a working order; complete each version's foundations before building features that depend on them. Browser compatibility findings may adjust implementation details while preserving the agreed behavior.

## Completion criteria

- **v0.1.0:** pair both browsers and manually transfer a session through the VPS; stale owners cannot overwrite current state.
- **v0.2.0:** switch devices automatically; propagate additions, navigation, and explicit closures without duplicate creation or feedback loops.
- **v1.0.0:** reconcile offline changes deterministically, recover interrupted sync, and install and operate both extensions and the backend reliably.

Cookies, history, window organization, tab groups, and page-memory transfer are outside these milestones. Features beyond v1.0.0 need a separate scope decision.
