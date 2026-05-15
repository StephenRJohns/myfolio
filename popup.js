// MyFolio — popup script
// Copyright (c) 2026 JJJJJ Enterprises, LLC.
// Licensed under the MIT License (see LICENSE).

document.getElementById('open-btn').addEventListener('click', () => {
  chrome.tabs.create({ url: 'https://accountview.lpl.com/web/overview' });
});
