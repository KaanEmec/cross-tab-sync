# Pair and authenticate devices

## Goal
Allow only the user's registered browsers to access the shared session.

## Expected outcome
Safari and Brave can pair securely and independently revoke their credentials.

## Tasks
- Implement a short-lived pairing flow and separate credentials per device.
- Authenticate session reads, writes, ownership changes, and device management.
- Add device naming, listing, and revocation.
- Store credentials appropriately in extension storage; keep tokens and tab URLs out of logs.
- Require HTTPS outside local development and verify unauthorized and revoked access.
