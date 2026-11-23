document.getElementById("open").addEventListener("click", () => {
  chrome.tabs.create({ url: "https://cloud.mail.ru/attaches#all" });
});
