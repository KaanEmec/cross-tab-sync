# Build the shared extension shell

## Goal
Run the same core extension logic in Safari and Brave.

## Expected outcome
Both browsers load an extension with pairing, connection status, and durable local state.

## Tasks
- Set up TypeScript builds, browser-specific manifests, and a small browser adapter.
- Package Safari in a minimal Swift/Xcode macOS wrapper.
- Add pairing, backend address, device name, and connection settings.
- Persist credentials, last revision, ownership generation, and local tab mappings.
- Add popup status for owner, last successful sync, pending changes, and errors.
- Request only the permissions required by the validated capabilities.
