# Implement manual handover

## Goal
Complete an end-to-end transfer between the two browsers.

## Expected outcome
Hand over saves current state and releases control; Continue here retrieves and applies state before publishing as owner.

## Tasks
- Capture eligible tabs and merge missing URLs into the shared session.
- Reuse existing local tabs across eligible windows and create missing tabs in the background.
- Implement both buttons with server acknowledgments and ownership-generation checks.
- Preserve local selection, existing extra tabs, and existing local duplicates.
- Apply supported order and pinned metadata without recreating windows.
- Verify Safari-to-Brave and Brave-to-Safari transfers, including an unavailable destination.
