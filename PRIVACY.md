# Privacy Policy

Last updated: October 15, 2026

ChromeOS Storage Service for Nextcloud is an unofficial, independent extension. It is not affiliated with or endorsed by Nextcloud GmbH or ownCloud GmbH.

## Single purpose

The extension's sole purpose is to let users access and manage files on their own Nextcloud or ownCloud server through WebDAV in the ChromeOS Files app. The extension mounts the server selected by the user as network storage.

## Data processed

To provide this functionality, the extension processes:

- the server's HTTPS address, the name assigned to the volume, the username, and the password or app password required to authenticate;
- file and folder names and paths, sizes, dates, and other metadata requested by the Files app;
- file contents during read and write operations. Data needed to resume a write operation may be temporarily stored in the extension's IndexedDB database.

Credentials and information about mounted servers are stored in the extension's local storage (`chrome.storage.local`) to restore volumes after the service worker or device restarts. File-operation records are stored in IndexedDB and removed when the operation completes or during operation recovery. Data is not sent to the developer, and the extension does not use analytics, advertising, or tracking services.

## Transmission and sharing

WebDAV requests, credentials, and file contents are transmitted directly to the HTTPS server configured by the user. The extension does not operate its own server and does not sell or share this data with the developer or third parties. The server selected by the user is subject to its own privacy policy and data-retention practices.

For WebDAV compatibility, the extension's network rules modify certain request headers sent to the authorized server. The rules are limited to the HTTPS origin authorized by the user. Affected headers include User-Agent, Cookie, and `Sec-Fetch`/`Origin` headers. `Set-Cookie` headers received from that server are removed. The extension does not use browser cookies to authenticate these requests.

The extension may open a browser tab to the server's Files page when the user selects the “Open on web” action. In that case, the server address and selected path are included in the URL that is opened.

## Permission justifications

- **`fileSystemProvider`**: required to expose the WebDAV server as network storage in the ChromeOS Files app and handle file operations requested by the user.
- **`declarativeNetRequestWithHostAccess`**: required to apply the header modifications needed for WebDAV compatibility. Host access is optional and requested for the server selected by the user; the rules apply only to that host.
- **`storage`**: required to store mount information locally and restore volumes after restarts. Credentials are used only to authenticate requests to the configured server.

## Remote code

The extension does not download or execute remote JavaScript or WebAssembly code. The extension's code and its dependencies are included in the distributed package. Server connections only download or upload data and content required for WebDAV operations and the web view selected by the user.

## Security and retention

Connections to configured servers use HTTPS. Credentials are stored in the user's local Chrome profile storage; the extension does not claim to provide additional encryption for credentials. Users can unmount a server to remove its credentials from the extension's storage. Uninstalling the extension removes local data managed by Chrome according to the platform's settings.

## Contact

Publisher contact email: **[insert the publisher's email address]**.

Before publication, replace this placeholder with a valid address. The publisher's email address must also be entered and verified on the **Settings** page of the Chrome Web Store Developer Dashboard. This verification cannot be completed through the repository.

## Chrome Web Store declaration

The collection and use of data described in this policy are limited to the extension's single purpose. Before publication, the publisher must verify that the declarations match the submitted version and certify in the **Privacy practices** tab of the Chrome Web Store Developer Dashboard that data use complies with the Developer Program Policies.