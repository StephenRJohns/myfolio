// MyFolio — popup script
// Copyright (c) 2026 JJJJJ Enterprises, LLC.
// Licensed under the MIT License (see LICENSE).

document.getElementById('open-btn').addEventListener('click', () => {
  try { chrome.tabs.create({ url: 'https://accountview.lpl.com/' }); } catch (e) {}
});

const versionEl = document.getElementById('popup-version');
if (versionEl) {
  try { versionEl.textContent = 'v' + chrome.runtime.getManifest().version; }
  catch (e) { versionEl.textContent = ''; }
}
