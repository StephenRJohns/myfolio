document.getElementById('open-btn').addEventListener('click', () => {
  chrome.tabs.create({ url: 'https://accountview.lpl.com/web/overview' });
});
