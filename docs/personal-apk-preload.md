# Personal Android preload

The Android shell loads the existing HTTPS site. This change adds a local
code-only backup inside the APK and installs it before the desktop is mounted.
Deploy the web changes before using a preload APK. An old site will still open,
but will not call the new preload bridge.

## Prepare private data locally

Run `python scripts/split-personal-backup.py FULL_BACKUP.zip OUTPUT_DIRECTORY`.
The script validates ZIP integrity, media hashes, unique runtime IDs, and a
lossless partition of all records. It produces:

- `01-apps-preload.zip`: app code, permissions, manifests, assets, original IDs.
- `02-app-usage.zip`: the remaining content-app module, including app collections.
- `03-personal-data.zip`: all other modules, including chat/settings/themes.
- `04-personal-all-without-app-code.zip`: convenient union of 02 and 03.
- `05-desktop-theme.zip` and `06-chat-records.zip`: optional selective recovery.
- `individual-apps/`: conventional editable app ZIPs. Ordinary installation
  generates NEW runtime IDs; use 01 for migration with existing app data.

The packages are PRIVATE. Personal settings can contain provider credentials,
and some custom app code may contain personalized content. No backup or extracted
app source is committed to the public repository.

For a personal build, copy 01 to
`android-shell/app/src/main/assets/preinstalled.zip`. Write
`preinstalled-info.json` next to it with `{ "sha256": "<SHA-256 of ZIP bytes>" }`.
Both files are ignored by git. Set `SHELL_SITE_URL` to the deployed HTTPS site
and build using the existing Android instructions. Public Actions builds without
these local inputs remain ordinary shells.

The WebView intercepts exactly one same-origin HTTPS path to serve the local ZIP.
The frontend checks the package hash and every extracted media hash. It accepts
only the custom-app installation record and never imports chat, credentials or
theme data during preload. A persistent device-local ledger preserves existing
edits and prevents reinstalls after an intentional uninstall. New app IDs can be
added by a later preload package. Existing IDs are left intact rather than silently
replaced; app updates stay under user control.

## Restore personal data

On a new device: allow preload to finish, then import 04 via Settings → Data
Management. Alternatively import 03 followed by 02. Do not import all overlapping
packages. Use 05 or 06 only when selective recovery is wanted. Existing main-app
import behavior supports merge or overwrite; choose overwrite only when deliberately
restoring that snapshot. The split does not alter importer semantics.

## Multi-device work still required

Existing Supabase functionality provides scheduled backup and manual restore,
not bidirectional sync. These changes do not activate automatic device handoff.
The next stage requires an atomic cloud revision/writer coordinator, a local
conflict/recovery copy, write fencing, and integration tests across two devices.
Do not implement handoff by blindly restoring the newest timestamp or allowing
every device to upload its independent copy. In particular, the current overwrite
import updates existing keys and does not propagate deletions: a sync-specific
replace/rollback operation is required before claiming complete snapshot sync.

Use the same private Supabase project for backup and manual restore in the meantime.
Keep its connection credentials out of the APK and out of public source control.

## Validation

`node --test scripts/test-shell-preload.mjs` checks preservation, idempotence and
uninstall behavior. Run TypeScript checks and a production build. Android compilation
and real-device restore/export need separate validation. The new native save bridge
opens Android's document picker and writes bounded 256 KiB chunks. Browser downloads
keep their existing path. Cancellation and byte fidelity are covered by the JS tests;
Android document-provider behavior still needs a real device test.
