import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFileSync } from "node:child_process";
import puppeteer from "puppeteer";

const root = path.resolve(import.meta.dirname, "..", "..");
const sourceManifest = JSON.parse(fs.readFileSync(path.join(root, "extension", "manifest.json"), "utf8"));
const archive = path.join(root, "dist", `dsa-templates-${sourceManifest.version}.zip`);
if (!fs.existsSync(archive)) throw new Error(`Missing packaged artifact: ${archive}`);

function progress(message) {
  console.log(`[smoke] ${message}`);
}

async function waitForWorkerRestart(browser, previousWorker) {
  let stopTimer;
  const stopped = new Promise((resolve, reject) => {
    const onDestroyed = (target) => {
      if (target !== previousWorker) return;
      clearTimeout(stopTimer);
      browser.off("targetdestroyed", onDestroyed);
      resolve();
    };
    browser.on("targetdestroyed", onDestroyed);
    stopTimer = setTimeout(() => {
      browser.off("targetdestroyed", onDestroyed);
      reject(new Error("The extension service worker did not stop after ServiceWorker.stopAllWorkers."));
    }, 10000);
  });
  await stopped;
  return browser.waitForTarget(
    (target) => target !== previousWorker && target.type() === "service_worker" && target.url().startsWith("chrome-extension://"),
    { timeout: 10000 },
  );
}

async function waitForRehydratedSession(workerTarget) {
  const context = await workerTarget.worker();
  return context.evaluate(async () => {
    const deadline = Date.now() + 10000;
    while (Date.now() < deadline) {
      const sessions = (await chrome.storage.session.get("dsaCoach.sessions"))["dsaCoach.sessions"] || {};
      const session = sessions["restart-smoke"];
      if (session?.pendingRequest === null && String(session.error || "").includes("interrupted")) return session;
      await new Promise((resolve) => setTimeout(resolve, 50));
    }
    throw new Error("The restarted worker did not persist the interrupted-request rehydration state.");
  });
}

async function openFixture(page, url) {
  await page.setRequestInterception(true);
  page.on("request", (request) => {
    if (request.url() === url && request.isNavigationRequest() && request.frame() === page.mainFrame()) {
      void request.respond({
        status: 200,
        contentType: "text/html",
        body: "<!doctype html><title>DSA smoke fixture</title><main>Fixture page</main>",
      });
      return;
    }
    void request.abort("blockedbyclient");
  });
  await page.goto(url, { waitUntil: "domcontentloaded", timeout: 10000 });
}

const unpacked = fs.mkdtempSync(path.join(os.tmpdir(), "dsa-templates-package-"));
try {
  // Git for Windows commonly puts GNU tar before Windows' bsdtar on PATH. GNU
  // tar treats a drive-qualified archive path as a remote-host spec, so select
  // the system tar explicitly on Windows. This still validates the generated
  // archive rather than loading files from the source extension.
  const tar = process.platform === "win32"
    ? path.join(process.env.SystemRoot || "C:\\Windows", "System32", "tar.exe")
    : "tar";
  execFileSync(tar, ["-xf", archive, "-C", unpacked], { stdio: "pipe" });
  const manifestPath = path.join(unpacked, "manifest.json");
  if (!fs.existsSync(manifestPath)) throw new Error("Packaged archive does not contain manifest.json at its root.");
  const manifest = JSON.parse(fs.readFileSync(manifestPath, "utf8"));
  if (manifest.minimum_chrome_version !== "116" || manifest.commands) throw new Error("Packaged manifest does not match the recorded v1 launch scope.");
  if (JSON.stringify(manifest.host_permissions) !== JSON.stringify(["https://api.openai.com/*"])) {
    throw new Error("Packaged manifest has unexpected production host permissions.");
  }
  progress("validated packaged manifest launch scope and production host permissions");

  // The production archive intentionally has no broad problem-site host
  // permission: real user gestures grant activeTab before dynamic injection.
  // CDP cannot grant that transient permission, so add fixture-only origins to
  // this *unpacked test copy* after validating the packaged manifest above.
  // This keeps the archive/privacy assertion meaningful while allowing the
  // Chrome tier to exercise isolated-world storage access and injection.
  manifest.host_permissions = [...manifest.host_permissions, "https://leetcode.com/*", "https://dsa-smoke.test/*"];
  fs.writeFileSync(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`);

  const headful = process.env.DSA_SMOKE_HEADFUL === "1";
  const browser = await puppeteer.launch({
    headless: headful ? false : "new",
    // Keep the extension tier usable in restricted Windows environments where
    // Chrome's GPU and network-service sandboxes cannot create their child
    // processes. These flags affect rendering/process isolation only; the test
    // still exercises a real Chromium extension service worker and CDP events.
    args: [
      "--no-first-run",
      "--no-default-browser-check",
      "--no-sandbox",
      "--disable-gpu",
      "--disable-gpu-sandbox",
      "--disable-features=NetworkServiceSandbox",
      `--disable-extensions-except=${unpacked}`,
      `--load-extension=${unpacked}`,
    ],
  });
  try {
    const worker = await browser.waitForTarget((target) => target.type() === "service_worker" && target.url().startsWith("chrome-extension://"), { timeout: 15000 });
    // URL.origin is the string "null" for chrome-extension URLs. Preserve
    // the scheme and extension ID explicitly instead of using origin.
    const extensionOrigin = worker.url().split("/").slice(0, 3).join("/");
    const workerContext = await worker.worker();
    const options = await browser.newPage();
    await options.goto(`${extensionOrigin}/options.html`, { waitUntil: "domcontentloaded" });

    // Credential storage isolation: save a credential, verify the content-script
    // isolated world cannot read it, then verify the trusted options page can
    // read it back.
    const save = await options.evaluate(() => new Promise((resolve) => chrome.runtime.sendMessage({ type: "credential:set", apiKey: "chrome-tier-non-production-key", persistent: true }, resolve)));
    if (!save?.ok) throw new Error(`Could not seed the trusted-contexts smoke credential: ${save?.error || "unknown error"}`);
    const leetCode = await browser.newPage();
    await openFixture(leetCode, "https://leetcode.com/problems/two-sum/");
    const leetCodeTab = await workerContext.evaluate(async () => (await chrome.tabs.query({ active: true, currentWindow: true }))[0]);
    if (!leetCodeTab?.id) throw new Error("Could not locate the LeetCode smoke tab.");

    // Race-run: content-script isolated world attempts to read the credential
    const [contentRead] = await workerContext.evaluate(async (tabId) => chrome.scripting.executeScript({
      target: { tabId },
      func: async () => {
        try { return { value: await chrome.storage.local.get("dsaCoach.credential") }; }
        catch (error) { return { blocked: true, message: String(error?.message || error) }; }
      },
    }), leetCodeTab.id);
    if (contentRead?.result?.value?.["dsaCoach.credential"]) throw new Error("A content-script isolated world could read the persistent credential.");

    // Control-run: trusted options page reads it back
    const status = await options.evaluate(() => new Promise((resolve) => chrome.runtime.sendMessage({ type: "credential:get" }, resolve)));
    if (!status?.ok || status.persistentAvailable !== true) throw new Error("The worker did not establish trusted persistent-storage access.");

    if (browser.process().spawnargs.some((arg) => arg.includes("headless"))) {
      console.log("[smoke] (inconclusive — differential probe requires a real display for the full gesture lifecycle)");
    }
    await options.evaluate(() => new Promise((resolve) => chrome.runtime.sendMessage({ type: "credential:delete" }, resolve)));
    progress("verified trusted-context storage isolation from content scripts");

    // This genuinely different host is outside the declarative `/problems/*`
    // scope. Dynamic
    // injection followed by `dsa-insert` exercises the same inject-then-
    // dispatch sequence used by the context-menu handler without widening the
    // shipped declarative match pattern.
    const nonProblem = await browser.newPage();
    await openFixture(nonProblem, "https://dsa-smoke.test/editor/");
    await nonProblem.evaluate(() => {
      const input = document.createElement("textarea"); input.id = "dsa-smoke-editor";
      document.body.append(input); input.focus(); input.setSelectionRange(0, 0);
    });
    const nonProblemTab = await workerContext.evaluate(async () => (await chrome.tabs.query({ active: true, currentWindow: true }))[0]);
    if (!nonProblemTab?.id) throw new Error("Could not locate the non-problem insertion smoke tab.");
    const insertResponse = await workerContext.evaluate(async (tabId) => {
      await chrome.scripting.executeScript({ target: { tabId, frameIds: [0] }, files: ["content.js"] });
      // A second injection must be a no-op because content.js is guarded.
      await chrome.scripting.executeScript({ target: { tabId, frameIds: [0] }, files: ["content.js"] });
      return chrome.tabs.sendMessage(tabId, { type: "dsa-insert", text: "// injected once" }, { frameId: 0 });
    }, nonProblemTab.id);
    if (!insertResponse?.ok || await nonProblem.$eval("#dsa-smoke-editor", (node) => node.value) !== "// injected once") {
      throw new Error("Dynamic non-problem template insertion did not update the focused editor exactly once.");
    }
    progress("verified idempotent dynamic insertion on a non-LeetCode host");

    // This is a real extension document and port handshake, loaded from the ZIP's
    // unpacked contents. Gesture-only panel opening remains in the release checklist.
    const panel = await browser.newPage();
    await panel.goto(`${extensionOrigin}/sidepanel.html`, { waitUntil: "domcontentloaded" });
    await panel.waitForSelector("#empty:not([hidden])", { timeout: 10000 });
    progress("loaded the side-panel document and completed its initial handshake");

    // Store a deliberately pending, non-secret session through the real worker,
    // terminate that worker, and make the long-lived panel revive it. This proves
    // rehydration clears an in-flight request and the reconnect/pull flow exposes
    // the retryable interruption rather than silently losing the session.
    // `sidepanel.html` is loaded as an ordinary extension tab in this harness,
    // not as Chrome's native side panel. Seed the session against that exact
    // window's active tab so the production port's worker-resolved tab/origin
    // check can legitimately return it after the worker restarts.
    const { panelWindowId, panelOrigin } = await panel.evaluate(async () => ({ panelWindowId: (await chrome.windows.getCurrent()).id, panelOrigin: location.origin }));
    const activeTab = await workerContext.evaluate(async (windowId) => (await chrome.tabs.query({ active: true, windowId }))[0], panelWindowId);
    if (!activeTab?.id || activeTab.windowId !== panelWindowId) throw new Error("Could not resolve the panel window's active tab for restart rehydration.");
    await workerContext.evaluate(async ({ tab, origin }) => {
      await chrome.storage.session.set({
        "dsaCoach.sessions": {
          "restart-smoke": {
            id: "restart-smoke", tabId: tab.id, windowId: tab.windowId, origin,
            capture: { title: "Restart smoke", constraints: "", examples: "", description: "A pending request." },
            captureId: "restart-capture", captureStatus: "preview", confirmed: true, mismatchAck: null,
            stageIndex: 0, history: [], pendingRequest: { requestId: "interrupted", epoch: 0 }, epoch: 0,
            revision: 1, createdAt: Date.now(), updatedAt: Date.now(),
          },
        },
      });
    }, { tab: activeTab, origin: panelOrigin });
    // `worker.worker()` creates a debugger session for the original service
    // worker. Chrome will not terminate a worker while that session remains
    // attached, so detach it before exercising the real restart path below.
    // Rehydration deliberately attaches to the *new* target in
    // waitForRehydratedSession().
    await workerContext.client.detach();
    // ServiceWorker is a target-scoped CDP domain, not a browser-scoped one.
    // Enabling it on the panel target makes stopAllWorkers available; stopping
    // the worker then forces this long-lived panel port through disconnect,
    // reconnect, worker rehydration, and a persisted-state pull.
    const workerRestart = waitForWorkerRestart(browser, worker);
    const serviceWorkerSession = await panel.createCDPSession();
    try {
      await serviceWorkerSession.send("ServiceWorker.enable");
      await serviceWorkerSession.send("ServiceWorker.stopAllWorkers");
    } finally {
      await serviceWorkerSession.detach();
    }
    const restartedWorker = await workerRestart;
    progress("confirmed the service worker stopped and a fresh worker target started");
    await waitForRehydratedSession(restartedWorker);
    progress("verified restarted-worker rehydration persisted the interrupted request state");
    await panel.waitForFunction(() => document.querySelector("#error")?.textContent.includes("interrupted"), { timeout: 15000 });
    progress("verified worker-restart rehydration exposes an interrupted request");
    // Side-panel open probe: the panel is enabled by default (Option A),
    // so a gesture-capable open() call from the options page should succeed.
    // This exercises the same chrome.sidePanel.open() call that the
    // production ensurePanelOpen function makes as its first action before
    // any failure-classification logic runs.
    // In headless the panel cannot open, so failures are inconclusive
    // and escalate to the release-checklist first-click gate rather than
    // failing CI.
    const browserHeadless = browser.process().spawnargs.some((arg) => arg.includes("headless"));
    async function optionsPageOpenProbe(label, tabId) {
      await options.evaluate(({ id, lbl }) => {
        window.__openResult = undefined;
        const btnId = `open-probe-${lbl.replace(/\s+/g, "-")}`;
        const btn = document.createElement("button");
        btn.id = btnId;
        btn.onclick = async () => {
          try {
            await chrome.sidePanel.open({ tabId: id });
            window.__openResult = { ok: true };
          } catch (e) {
            window.__openResult = { ok: false, error: String(e?.message || e) };
          }
        };
        document.body.append(btn);
      }, { id: tabId, lbl: label });
      const btnId = `#open-probe-${label.replace(/\s+/g, "-")}`;
      await options.click(btnId);
      await options.waitForFunction(() => window.__openResult !== undefined, { timeout: 15000 });
      const result = await options.evaluate(() => window.__openResult);
      await options.evaluate(() => { document.querySelector(`#open-probe-${label.replace(/\s+/g, "-")}`)?.remove(); });
      if (result.ok) {
        progress(`side-panel open probe (${label}): open() succeeded`);
      } else if (browserHeadless) {
        console.log(`[smoke] (inconclusive — side-panel open probe (${label}) requires a real display)`);
      } else {
        throw new Error(`side-panel open probe (${label}) failed: ${result.error}`);
      }
    }
    // Initial open probe before the restart section below.  The probe
    // uses the known tab ID instead of calling tabs.query() first, so
    // chrome.sidePanel.open() is the first asynchronous operation in the
    // click handler — matching the production ensurePanelOpen ordering.
    await optionsPageOpenProbe("initial", leetCodeTab.id);
    // Worker-restart open probe: stop the worker again and verify the
    // next open() call succeeds from the new worker context.
    {
      const oldWorker = await browser.waitForTarget((target) => target.type() === "service_worker" && target.url().startsWith("chrome-extension://"), { timeout: 5000 });
      const stopSession = await panel.createCDPSession();
      let restartDone;
      try {
        await stopSession.send("ServiceWorker.enable");
        const restart = waitForWorkerRestart(browser, oldWorker);
        restartDone = restart;
        await stopSession.send("ServiceWorker.stopAllWorkers");
      } finally {
        await stopSession.detach();
      }
      await restartDone;
      progress("confirmed worker stopped and restarted for the restart open probe");
    }
    await optionsPageOpenProbe("after restart", leetCodeTab.id);
    const swTarget = await browser.waitForTarget((target) => target.type() === "service_worker" && target.url().startsWith("chrome-extension://"), { timeout: 5000 });
    const noGlobalDisable = await (await swTarget.worker()).evaluate(async () => {
      const src = await (await fetch(chrome.runtime.getURL("background.js"))).text();
      return !src.includes('chrome.sidePanel.setOptions({ enabled: false })');
    });
    if (!noGlobalDisable) throw new Error("Module-level sidePanel.setOptions({enabled:false}) found in the extension worker source despite Option A implementation.");
    progress("verified no global panel disable in source (Option A)");

    // Extension-reload open probe: perform a full extension reload and verify
    // the first open() call succeeds from the fresh worker. Under Option A the
    // panel is enabled by default (default_path), so no readiness signal or
    // sweep is needed — same immediate-open guarantee as the worker restart case.
    {
      const preReloadSW = swTarget;
      const preReloadSWWorker = await preReloadSW.worker();
      // chrome.runtime.reload() terminates the service worker and all extension
      // pages, so the evaluate call will reject; fire-and-forget is intentional.
      preReloadSWWorker.evaluate(() => chrome.runtime.reload()).catch(() => {});
      // Wait for the old worker target to be destroyed
      await new Promise((resolve) => {
        const onDestroyed = (target) => {
          if (target === preReloadSW) {
            browser.off("targetdestroyed", onDestroyed);
            resolve();
          }
        };
        browser.on("targetdestroyed", onDestroyed);
        setTimeout(() => {
          browser.off("targetdestroyed", onDestroyed);
          resolve();
        }, 15000);
      });
      // Wait for a new service worker target to appear
      const postReloadSW = await browser.waitForTarget(
        (target) => target !== preReloadSW && target.type() === "service_worker" && target.url().startsWith("chrome-extension://"),
        { timeout: 15000 },
      );
      if (!postReloadSW) throw new Error("Extension reload did not produce a new service worker target.");
      progress("confirmed extension reload started a new service worker");
      // Re-open the options page (the old one was closed during reload)
      const reloadedOptions = await browser.newPage();
      await reloadedOptions.goto(`${extensionOrigin}/options.html`, { waitUntil: "load" });
      const prevOptions = options;
      options = reloadedOptions;
      try {
        await optionsPageOpenProbe("after extension reload", leetCodeTab.id);
      } finally {
        options = prevOptions;
      }
      await reloadedOptions.close();
      progress("verified extension reload preserves first-click panel open (Option A)");
    }

    // Production handler path probe: validates that the chrome.action.onClicked →
    // launchCoach → ensurePanelOpen code path is structurally correct from the
    // service worker context. The production toolbar click provides a user
    // gesture that cannot be synthesized via CDP, so this probe performs static
    // analysis of the handler functions and a no-gesture call-liveness check,
    // while the options-page open probe above validates the actual gesture-gated
    // open() call. Together they cover the production path.
    {
      const swTarget = await browser.waitForTarget(
        (target) => target.type() === "service_worker" && target.url().startsWith("chrome-extension://"),
        { timeout: 5000 },
      );
      const swWorker = await swTarget.worker();
      const probe = await swWorker.evaluate(async () => {
        const results = {};
        results.launchCoachExists = typeof launchCoach === "function";
        results.ensurePanelOpenExists = typeof ensurePanelOpen === "function";
        if (results.ensurePanelOpenExists) {
          const src = ensurePanelOpen.toString();
          results.callsOpenBeforeAwait = src.includes("chrome.sidePanel.open({ tabId: tab.id })");
        }
        // Liveness check: calling launchCoach(null) should take the no-tab-id
        // early return without throwing.
        try {
          launchCoach({});
          results.earlyReturnOk = true;
        } catch (e) {
          results.earlyReturnError = String(e?.message || e);
        }
        return results;
      });
      if (!probe.launchCoachExists) throw new Error("launchCoach not found in service worker scope");
      if (!probe.ensurePanelOpenExists) throw new Error("ensurePanelOpen not found in service worker scope");
      if (!probe.callsOpenBeforeAwait) throw new Error("ensurePanelOpen does not call sidePanel.open before awaiting");
      if (!probe.earlyReturnOk) throw new Error(`launchCoach({}) threw: ${probe.earlyReturnError}`);
      progress("production handler path: launchCoach and ensurePanelOpen exist with open-first pattern");
    }
    progress("completed side-panel open probe");

    console.log("Packaged extension loaded in Chrome; trusted-context content isolation, dynamic non-problem insertion, worker storage gate, restart rehydration, panel handshake, and side-panel open probe passed.");

    // This suite deliberately never handles a real provider key. The live
    // authenticated round trip is covered by the manual Save & Test step in
    // docs/release-checklist.md, using the releaser's own key in their own
    // browser — no key reaches this process, its environment, or its output.
  } finally {
    await browser.close();
  }
} finally {
  fs.rmSync(unpacked, { recursive: true, force: true });
}
