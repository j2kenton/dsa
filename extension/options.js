const $ = (selector) => document.querySelector(selector);
const status = (message, error = false) => { $("#status").textContent = message; $("#status").className = error ? "error" : "success"; };
async function request(type, data = {}) {
  const response = await chrome.runtime.sendMessage({ type, ...data });
  if (!response?.ok) throw new Error(response?.error || "Operation failed.");
  return response;
}
async function load() {
  try {
    const { credential, persistentAvailable } = await request("credential:get");
    $("#persistent").disabled = !persistentAvailable;
    $("#persistent-note").hidden = persistentAvailable;
    if (credential) { $("#provider").value = credential.provider; $("#persistent").checked = credential.persistent; status(`Saved key: ${credential.fingerprint} (${credential.persistent ? "local device" : "session only"}).`); }
  } catch (error) { status(error.message, true); }
}
async function save() {
  const apiKey = $("#api-key").value;
  const result = await request("credential:set", { apiKey, provider: $("#provider").value, persistent: $("#persistent").checked });
  $("#api-key").value = "";
  status(`Saved ${result.credential.fingerprint} (${result.credential.persistent ? "local device" : "session only"}).${result.credential.warning ? ` ${result.credential.warning}` : ""}`);
}
$("#save").onclick = async () => { try { await save(); } catch (error) { status(error.message, true); } };
$("#save-test").onclick = async () => { try { await save(); await request("credential:test"); status("Key saved and provider connection succeeded."); } catch (error) { status(error.message, true); } };
$("#mode").onclick = async () => { try {
  const result = await request("credential:set-mode", { persistent: $("#persistent").checked });
  status(`Storage mode updated: ${result.credential.fingerprint} (${result.credential.persistent ? "local device" : "session only"}).${result.credential.warning ? ` ${result.credential.warning}` : ""}`);
} catch (error) { status(error.message, true); } };
$("#test").onclick = async () => { try { await request("credential:test"); status("Provider connection succeeded."); } catch (error) { status(error.message, true); } };
$("#delete").onclick = async () => { try { const result = await request("credential:delete"); $("#api-key").value = ""; status(`Saved API key deleted.${result.result.warning ? ` ${result.result.warning}` : ""}`); } catch (error) { status(error.message, true); } };
load();
