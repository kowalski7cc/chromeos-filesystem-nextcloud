'use strict';

const message = key => chrome.i18n.getMessage(key);
const link = document.querySelector('#shareLink');
const copyButton = document.querySelector('#copyButton');
const status = document.querySelector('#status');
const title = message('shareLinkTitle');

document.title = title;
document.querySelector('#title').textContent = title;
document.querySelector('#description').textContent = message('shareLinkDescription');
copyButton.textContent = message('copyLink');

try {
  const value = new URLSearchParams(location.search).get('url');
  const shareUrl = new URL(value);
  if (shareUrl.protocol !== 'https:') throw new Error('Invalid share URL');
  link.href = shareUrl.toString();
  link.textContent = shareUrl.toString();
} catch {
  status.textContent = message('copyLinkFailed');
  copyButton.disabled = true;
}

copyButton.addEventListener('click', async () => {
  try {
    await navigator.clipboard.writeText(link.href);
    status.textContent = message('linkCopied');
  } catch {
    status.textContent = message('copyLinkFailed');
  }
});