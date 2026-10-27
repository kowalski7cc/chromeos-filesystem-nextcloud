export const OPEN_IN_WEB_ACTION = 'open-in-web';

export const NEXTCLOUD_FILE_INFO_PROPFIND_BODY =
  '<?xml version="1.0" encoding="UTF-8"?>' +
  '<d:propfind xmlns:d="DAV:" xmlns:oc="http://owncloud.org/ns">' +
  '<d:prop><oc:fileid/><d:resourcetype/></d:prop></d:propfind>';

export function getNextcloudFileMetadata(xml: string): {
  fileId: string
  isDirectory: boolean
} {
  const fileIdElement = xml.match(
    /<((?:[A-Za-z_][\w.-]*:)?fileid)\b[^>]*>([^<]*)<\/\1\s*>/i
  );
  const fileId = fileIdElement?.[2].trim();
  if (!fileId)
    throw new Error('Nextcloud file ID is unavailable from WebDAV metadata');

  const resourceType = xml.match(
    /<((?:[A-Za-z_][\w.-]*:)?resourcetype)\b[^>]*>([\s\S]*?)<\/\1\s*>/i
  );

  return {
    fileId,
    isDirectory: !!resourceType &&
      /<(?:[A-Za-z_][\w.-]*:)?collection(?:\s|\/?>)/i.test(resourceType[2]),
  };
}

export function getOpenInWebActions(
  server: 'nc' | 'oc' | undefined,
  entryCount: number,
  title: string
): [chrome.fileSystemProvider.Action[]] {
  if (server === 'oc' || entryCount === 0) return [[]];
  return [[{ id: OPEN_IN_WEB_ACTION, title }]];
}

export function buildNextcloudFilesUrl(
  domain: string,
  entryPath: string,
  isDirectory: boolean,
  fileId: string
): string {
  const url = new URL(
    `/apps/files/files/${encodeURIComponent(fileId)}`,
    `https://${domain}`
  );
  const path = entryPath.endsWith('/') && entryPath !== '/'
    ? entryPath.slice(0, -1)
    : entryPath;
  const parentSeparator = path.lastIndexOf('/');
  url.searchParams.set(
    'dir',
    parentSeparator <= 0 ? '/' : path.slice(0, parentSeparator)
  );

  if (!isDirectory) {
    url.searchParams.set('editing', 'false');
    url.searchParams.set('openfile', 'true');
  }

  return url.toString();
}
