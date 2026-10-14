# Encrypt tab URLs end to end

## Goal
Make the server blind to tab URLs while keeping duplicate coalescing and convergence.

## Expected outcome
The server database and API responses contain no readable URLs. Two browsers sync through the blind server, and a browser with the wrong key is refused clearly. Behavior is specified in [PROTOCOL.md](../../../docs/PROTOCOL.md#encryption).

## Tasks
- Crypto module: HKDF-SHA256 key split, deterministic `urlKey` (HMAC-SHA256), `urlEnc` (AES-256-GCM, padded, version byte, `urlKey` as AAD); tests with fixed vectors, tamper and wrong-key cases.
- Protocol v2: `/v2` routes, `urlKey` and `urlEnc` replace `url` in operations and session, `v1` answers `404 not_found`, 256 KiB bodies, 240 KiB client batches.
- Server blind fields and migration: validate length and alphabet only (no decoding, no crypto), coalesce on `urlKey`, index it; upgrade wipes entries, operations and snapshots, resets the revision and revokes all devices; logs and diagnostics carry no URLs.
- Extension boundary encryption: encrypt on the way out and decrypt on the way in, so the core keeps working with plain URLs; restore and merge forks reuse the stored fields; decrypt failure reports `key_mismatch` and takes no local action.
- Pairing-link key: the first browser generates the 256-bit key, invite links carry it in the fragment (`#CODE.<key>`), a keyless link on a non-empty session revokes itself and asks for an invite, Disconnect clears the key.
- Docs: architecture threat model, install and upgrade notes, deploy and validation checklist.
- Measure the cost and fill the table below.

## Measured cost
Measured 2026-10-14 with `scratchpad/cost.sh`: a throwaway server, one device, 200 `open` operations with ~90-character URLs, then `GET session` and `GET changes?since=0`, three rounds, no proxy. Figures are per round.

| Metric | v1 (plain) | v2 (encrypted) | Change |
| --- | --- | --- | --- |
| Upload per round (200 opens + two GETs, bytes) | 45,118 | 80,538 | +79 % |
| Download per round (results + session + changes, bytes) | 150,467 | 219,307 | +46 % |
| Server process CPU per round (ms, `ps` utime+stime) | ~7 | ~10 | within measurement noise |
| On the wire with Caddy `encode zstd gzip` | not measured | not measured | ciphertext does not compress; envelope does |

The server does no decoding of `urlEnc`; `ValidateURLFields` allocates nothing (asserted by a test).
