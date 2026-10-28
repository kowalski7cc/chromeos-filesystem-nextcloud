# ChromeOS storage service for Nextcloud (Unofficial)

Access a Nextcloud or ownCloud server directly from the ChromeOS Files app through the WebDAV API.

This project is a Chrome extension that exposes a remote WebDAV-based storage backend as a ChromeOS file system provider. It is intended for use with the ChromeOS Files app and supports the current Manifest V3 extension model.

Forked from [yoichiro/chromeos-filesystem-nextcloud](https://github.com/yuntan/chromeos-filesystem-nextcloud).

## Features

- Mount one or more remote WebDAV servers as ChromeOS file systems
- Works as a Manifest V3 extension with a service worker background page
- Uses declarative network request rules for host-scoped WebDAV compatibility
- Supports Nextcloud login and WebDAV flows through the browser extension environment
- Opens Nextcloud files and directories in Files from the ChromeOS context menu
- Keeps state resilient across Chrome service-worker restarts

The **Open in web** action is available for Nextcloud mounts. Files open in
preview mode, and multiple selected items open in separate tabs. ownCloud
mounts do not expose this Nextcloud-specific action.

## Uploads

Nextcloud writes use the recommended
[WebDAV Chunked Upload v2 API](https://docs.nextcloud.com/server/35/developer_manual/client_apis/WebDAV/chunking.html#chunked-upload-v2). File writes
are staged in 256 KiB IndexedDB blocks, so each write only updates affected
blocks instead of copying and persisting the entire accumulated file. This
supports arbitrary write offsets and survives service-worker restarts. Full
10 MiB chunks by default (configurable) are uploaded in numeric order as soon
as the staged file contains them; a write that changes an already-uploaded
chunk causes that chunk to be sent again. This moves most network transfer out
of the close callback while preserving out-of-order writes. Close uploads any
remaining final partial chunk and asks Nextcloud to assemble the file. The
final chunk may be smaller;
Nextcloud's 10,000-chunk limit is enforced. Empty files are sent with a direct
PUT.

Downloads use HTTP range read-ahead: by default, small and sequential reads are
served from 16 MiB ranges held in a 64 MiB process-wide LRU cache. Concurrent
reads for the same range of an open file share one request. Larger individual
reads fetch only the requested range. Range responses are checked before being
returned.

Transfer tuning is available from the extension's **Settings** page in
`chrome://extensions`. Settings apply globally to all mounts and are stored
locally. Upload chunks can be set from 5 to 100 MiB (default 10 MiB); download
read-ahead ranges from 1 to 64 MiB (default 16 MiB); and the shared download
cache from 16 to 512 MiB (default 64 MiB). The cache limit must be at least as
large as one read-ahead range. Sequential prefetch is enabled by default and
can be disabled. Settings apply to newly opened files; an active upload keeps
its selected chunk size so its staged and already-uploaded chunks remain
consistent.

The extension logs an `Upload timing` summary after a successful write close.
It reports file size, write count/bytes, cumulative write-handler time observed
in the current service-worker lifetime, the number and duration of chunks
uploaded during writes, and close-time upload duration. The write count and
bytes persist across worker restarts; the handler-time and chunk timing totals
do not.
Successful read closes log a `Download timing` summary with range request
count, fetched/returned bytes, cache hits, and cumulative range-request time.
Large Nextcloud uploads log `Nextcloud chunks uploaded` before the final
assembly request and `Nextcloud chunk assembly complete` after the server's
final MOVE succeeds, so slow chunk transfer can be distinguished from server
assembly latency.

ownCloud writes continue to use a direct WebDAV PUT. Nextcloud's
[bulk-upload API](https://docs.nextcloud.com/server/35/developer_manual/client_apis/WebDAV/bulkupload.html)
is not currently used because ChromeOS does not provide a batch boundary for
multiple file closes; a future implementation needs an explicit batching and
flush policy.

## Requirements

- ChromeOS device or Chrome browser with Chrome 154 or newer
- A running Nextcloud or ownCloud instance with WebDAV enabled
- A valid HTTPS URL for the server, such as https://cloud.example.com
- Network access from the machine running Chrome

## Installation

1. Clone or download this repository.
2. Install dependencies:

   npm install

3. Build the extension:

   npm run build

4. For a packaged build, run:

   npm run package

This creates a zip bundle suitable for installation or distribution.

## Loading the extension in Chrome

1. Open chrome://extensions
2. Enable Developer mode
3. Click Load unpacked
4. Select the project directory
5. If prompted, allow optional host access for your Nextcloud server

When the extension is installed, ChromeOS can use it as a network-backed storage provider from the Files app.

## How to connect a remote server

After installing the extension:

1. Open the ChromeOS Files app
2. Add a new storage source or mount
3. Select the installed Nextcloud storage provider
4. Enter the server URL and complete the login flow
5. Grant the optional host permission for the server if Chrome asks for it

The extension uses the WebDAV endpoint exposed by the server and can work with standard Nextcloud and ownCloud deployments.

## Manifest V3 notes

This project targets modern Chrome extension requirements:

- manifest_version is set to 3
- the background worker runs as a service worker
- host access is granted through optional host permissions and declarative net request rules
- the extension avoids legacy blocking webRequest APIs that are not allowed in public Manifest V3 extensions

## Troubleshooting

### Extension does not mount the server

- Confirm the server is reachable over HTTPS from the browser
- Make sure the correct host permission is granted
- Verify that the server exposes WebDAV endpoints correctly

### Service worker errors

- Update to the latest build of this extension
- Ensure you are using a recent Chrome version
- Check the browser console for runtime errors related to the background worker or network rules

### Login flow stalls or returns repeated polling responses

- This can happen while the server login flow is still waiting for approval or completion
- Confirm the login request is completing successfully in the browser
- Check that the server is configured to allow the flow used by the browser

## Development

Useful commands:

- npm run build: build the extension for development
- npm run typecheck: run the strict TypeScript check
- npm run package: create the distributable zip archive
- npm test: run the project test suite

## License

BSD-3-Clause

## Credits

This project is based on the original ChromeOS filesystem integration work for Nextcloud and keeps the compatibility updates needed for current Chrome extension requirements.
