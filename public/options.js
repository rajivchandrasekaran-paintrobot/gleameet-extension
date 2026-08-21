const DEFAULT_BACKEND_URL = 'https://gleameet.onrender.com';

document.addEventListener('DOMContentLoaded', () => {
  const input = document.getElementById('backendUrl');
  const saveBtn = document.getElementById('save');
  const status = document.getElementById('status');

  // Load saved URL
  chrome.storage.sync.get({ backendUrl: DEFAULT_BACKEND_URL }, (items) => {
    input.value = items.backendUrl;
  });

  saveBtn.addEventListener('click', () => {
    let url = input.value.trim();
    // Remove trailing slash
    if (url.endsWith('/')) url = url.slice(0, -1);
    if (!url) url = DEFAULT_BACKEND_URL;

    chrome.storage.sync.set({ backendUrl: url }, () => {
      status.textContent = 'Saved!';
      setTimeout(() => { status.textContent = ''; }, 2000);
    });
  });
});
