export async function isModuleEnabled(id) {
  const key = `moduleEnabled:${id}`;
  const result = await chrome.storage.local.get(key);
  return result[key] !== false;
}
