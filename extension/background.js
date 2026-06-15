importScripts("templates.js");

const MENU_ID_ROOT = "dsa-templates";

// Group definitions — order controls menu order
const GROUPS = [
  { id: "bfs", label: "BFS", prefix: "BFS: " },
  { id: "dfs", label: "DFS", prefix: "DFS: " },
  { id: "backtracking", label: "Backtracking", prefix: "Backtracking: " },
  { id: "binary-search", label: "Binary Search", prefix: "Binary Search: " },
  { id: "dp", label: "Dynamic Programming", prefix: "Dynamic Programming: " },
  { id: "sliding-window", label: "Sliding Window", prefix: "Sliding Window: " },
  { id: "two-pointers", label: "Two Pointers", prefix: "Two Pointers: " },
  { id: "prefix-sum", label: "Prefix Sum", prefix: "Prefix Sum" },
  { id: "stack", label: "Stack", prefix: "Stack" },
  { id: "trie", label: "Trie", prefix: "Trie" },
  { id: "linked-list", label: "Linked List", prefix: "Linked List" },
  { id: "union-find", label: "Union Find", prefix: "Union Find" },
];

function buildMenus() {
  chrome.contextMenus.removeAll(() => {
    chrome.contextMenus.create({
      id: MENU_ID_ROOT,
      title: "Insert DSA Template",
      contexts: ["editable"],
    });

    for (const group of GROUPS) {
      const keys = Object.keys(TEMPLATES).filter((k) =>
        k.startsWith(group.prefix)
      );
      if (keys.length === 0) continue;

      if (keys.length === 1) {
        chrome.contextMenus.create({
          id: `template:${keys[0]}`,
          parentId: MENU_ID_ROOT,
          title: group.label,
          contexts: ["editable"],
        });
      } else {
        chrome.contextMenus.create({
          id: `group:${group.id}`,
          parentId: MENU_ID_ROOT,
          title: group.label,
          contexts: ["editable"],
        });
        for (const key of keys) {
          const subLabel = key.replace(group.prefix, "").trim();
          chrome.contextMenus.create({
            id: `template:${key}`,
            parentId: `group:${group.id}`,
            title: subLabel,
            contexts: ["editable"],
          });
        }
      }
    }
  });
}

chrome.runtime.onInstalled.addListener(buildMenus);
chrome.runtime.onStartup.addListener(buildMenus);

chrome.contextMenus.onClicked.addListener((info, tab) => {
  if (!info.menuItemId.startsWith("template:")) return;
  const key = info.menuItemId.slice("template:".length);
  const code = TEMPLATES[key];
  if (!code || !tab?.id) return;

  chrome.scripting.executeScript({
    target: { tabId: tab.id },
    func: (text) => {
      window.__dsaInsertText = text;
      window.dispatchEvent(new CustomEvent("dsa-insert"));
    },
    args: [code],
  });
});
