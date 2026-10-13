# Propagate navigation

## Goal
Keep shared tabs useful as their URLs change.

## Expected outcome
Navigation updates the corresponding remote tab without leaving the old URL behind or creating another destination copy.

## Tasks
- Track stable committed navigation and handle redirects and in-page URL changes.
- Update shared entries while preserving query parameters and fragments.
- Reuse and coalesce existing destination URLs when appropriate.
- Avoid publishing follower-side redirects or remote application as owner navigation.
- Define duplicate-local-tab behavior when one copy navigates away.
- Verify navigation, redirects, destination collisions, and back/forward actions.
