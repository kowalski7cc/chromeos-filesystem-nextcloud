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
