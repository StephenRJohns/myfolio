// MyFolio — popup script
// Copyright (c) 2026 JJJJJ Enterprises, LLC. All rights reserved.

document.getElementById('open-btn').addEventListener('click', () => {
  chrome.tabs.create({ url: 'https://accountview.lpl.com/web/overview' });
});
