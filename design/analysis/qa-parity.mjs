import { readFileSync, readdirSync } from 'node:fs';
import { runInNewContext } from 'node:vm';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { crc16Ccitt, encodePayload } from '../../src/dsp/eq0xcb.mjs';

// Run from any directory: node design/analysis/qa-parity.mjs
// Parse literal data only, never execute a mock's UI or its inline codec.
const root = new URL('../../', import.meta.url);
const fixture = JSON.parse(readFileSync(new URL('test/fixtures/eq0xcb.reference.json', root), 'utf8'));
const directory = new URL('design/mocks/v2/', root);
const hex = (n) => `0x${n.toString(16).toUpperCase().padStart(4, '0')}`;
let failures = 0;
function check(ok, message) {
  if (!ok) failures++;
  console.log(`${ok ? 'PASS' : 'FAIL'} ${message}`);
}
function payloadCrc(bands, pre) {
  const payload = encodePayload(bands, pre);
  const crc = crc16Ccitt(payload.slice(0, -2));
  if (crc !== (payload.at(-2) | (payload.at(-1) << 8))) throw new Error('CRC trailer mismatch');
  return { payload, crc };
}

for (const [id, preset] of Object.entries(fixture.presets)) {
  const { payload, crc } = payloadCrc(preset.eqBands, preset.preampDb);
  const referenceCrc = preset.payload.at(-2) | (preset.payload.at(-1) << 8);
  check(payload.length === preset.payload.length && payload.every((byte, i) => byte === preset.payload[i]),
    `fixture ${id}: CRC ${hex(crc)} (reference ${hex(referenceCrc)}), ${payload.length} bytes`);
}
const neutral = payloadCrc(Array.from({ length: 10 }, () => ({ kind: 'OFF' })), -0.5);
check(neutral.crc === 0x4fff, `Neutro: 10 × OFF, preamp -0.5 dB, CRC ${hex(neutral.crc)} (expected 0x4FFF)`);

for (const file of readdirSync(directory).filter((file) => file.endsWith('.html')).sort()) {
  const source = readFileSync(new URL(file, directory), 'utf8');
  const found = new Set();
  // Both PRESETS.<id> = { pre, b } and OFFICIAL = [{ id, pre, b }].
  // Matching each literal rather than evaluating the map also catches duplicate tables.
  const entries = /(?:\b([a-z][\w]*)\s*:\s*)?\{\s*(?:id\s*:\s*['"]([\w-]+)['"]\s*,)?[^{}]*?\bb\s*:\s*(\[(?:[^\[\]]|\[[^\[\]]*\])*\])\s*[^{}]*?\}/g;
  let tables = 0;
  const startFailures = failures;
  for (const match of source.matchAll(entries)) {
    const id = match[2] || match[1];
    const expected = fixture.presets[id];
    if (!expected) continue;
    tables++;
    found.add(id);
    const line = source.slice(0, match.index).split('\n').length;
    const pre = match[0].match(/\bpre\s*:\s*(-?(?:\d+(?:\.\d*)?|\.\d+))/);
    const rows = runInNewContext(match[3], Object.create(null), { timeout: 100 });
    const bands = rows.map(([kind, freqHz, gainDb, qFactor]) => kind === 'OFF' ? { kind } : { kind, freqHz, gainDb, qFactor });
    const where = `${file}:${line} ${id}`;
    if (!pre || Number(pre[1]) !== expected.preampDb) check(false, `${where}: preamp ${pre?.[1]} != ${expected.preampDb}`);
    if (bands.length !== expected.eqBands.length) check(false, `${where}: band count ${bands.length} != ${expected.eqBands.length}`);
    for (const [i, band] of bands.entries()) {
      for (const field of ['kind', 'freqHz', 'gainDb', 'qFactor']) {
        if (band[field] !== expected.eqBands[i]?.[field]) check(false, `${where} band ${i + 1} ${field}: ${band[field]} != ${expected.eqBands[i]?.[field]}`);
      }
    }
    if (pre) {
      const { payload } = payloadCrc(bands, Number(pre[1]));
      if (payload.some((byte, i) => byte !== expected.payload[i])) check(false, `${where}: payload differs from fixture`);
    }
  }
  for (const id of Object.keys(fixture.presets)) if (!found.has(id)) check(false, `${file}: missing embedded preset ${id}`);
  console.log(`${failures === startFailures ? 'PASS' : 'FAIL'} ${file}: ${tables} tables / ${found.size} preset ids; ${failures - startFailures} mismatches`);
}
console.log(`\nParity: ${failures} failure(s).`);
if (failures) process.exitCode = 1;

if (process.argv.includes('--browser')) await browserQa();

async function browserQa() {
  const { spawn } = await import('node:child_process');
  const { mkdirSync, writeFileSync } = await import('node:fs');
  const { createServer } = await import('node:net');
  const { setTimeout: delay } = await import('node:timers/promises');
  const server = createServer();
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const port = server.address().port;
  await new Promise((resolve) => server.close(resolve));
  const profile = join(tmpdir(), "Claude", "chrome-qa2", `run-${Date.now()}`);
  mkdirSync(profile, { recursive: true });
  mkdirSync(new URL('_qa/', directory), { recursive: true });
  const chrome = spawn('C:/Program Files/Google/Chrome/Application/chrome.exe', [
    '--headless=new', `--remote-debugging-port=${port}`, `--user-data-dir=${profile}`,
    '--no-first-run', '--no-default-browser-check', '--disable-background-networking',
    '--disable-extensions', '--hide-scrollbars', 'about:blank',
  ], { stdio: 'ignore' });
  let browser;
  const sockets = new Set();
  async function cdp(url) {
    const ws = new WebSocket(url);
    sockets.add(ws);
    await new Promise((resolve, reject) => { ws.onopen = resolve; ws.onerror = reject; });
    let next = 0;
    const pending = new Map();
    const listeners = new Map();
    ws.onmessage = ({ data }) => {
      const message = JSON.parse(data);
      if (message.id) {
        const job = pending.get(message.id);
        pending.delete(message.id);
        if (message.error) job?.reject(new Error(JSON.stringify(message.error)));
        else job?.resolve(message.result);
      } else for (const fn of listeners.get(message.method) || []) fn(message.params);
    };
    return {
      send(method, params = {}) {
        return new Promise((resolve, reject) => {
          const id = ++next;
          pending.set(id, { resolve, reject });
          ws.send(JSON.stringify({ id, method, params }));
        });
      },
      on(method, fn) { listeners.set(method, [...(listeners.get(method) || []), fn]); },
      close() { ws.close(); sockets.delete(ws); },
    };
  }
  try {
    let version;
    for (let i = 0; i < 100; i++) {
      try { version = await (await fetch(`http://127.0.0.1:${port}/json/version`)).json(); break; }
      catch { await delay(100); }
    }
    if (!version) throw new Error(`Chrome PID ${chrome.pid} did not expose CDP`);
    console.log(`\nBROWSER ${version.Browser}; PID ${chrome.pid}; CDP ${port}; profile ${profile}`);
    browser = await cdp(version.webSocketDebuggerUrl);
    const urls = ['curva.html?camada=ouvir', 'curva.html?camada=ajustar', 'curva.html?camada=engenharia',
      'biblioteca.html', 'comparar.html', 'soe-como-x.html', 'comunidade.html', 'teste-cego.html', 'cabo.html', 'docs.html'];
    const filter = process.env.QA_PAGES?.split(',');
    for (const relative of urls.filter((url) => !filter || filter.some((part) => url.includes(part)))) {
      const { targetId } = await browser.send('Target.createTarget', { url: 'about:blank' });
      const targets = await (await fetch(`http://127.0.0.1:${port}/json/list`)).json();
      const page = await cdp(targets.find((t) => t.id === targetId).webSocketDebuggerUrl);
      const events = [];
      page.on('Runtime.consoleAPICalled', (e) => {
        if (['error', 'warning', 'warn'].includes(e.type)) events.push({ type: e.type, text: e.args.map((a) => a.description ?? a.value ?? a.unserializableValue).join(' '), stack: e.stackTrace });
      });
      page.on('Runtime.exceptionThrown', (e) => events.push({ type: 'exception', text: e.exceptionDetails.exception?.description || e.exceptionDetails.text, line: e.exceptionDetails.lineNumber + 1, url: e.exceptionDetails.url }));
      page.on('Log.entryAdded', ({ entry }) => {
        if (['error', 'warning'].includes(entry.level)) events.push({ type: `log.${entry.level}`, text: entry.text, url: entry.url });
      });
      const evaluate = async (expression) => {
        const result = await page.send('Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true });
        if (result.exceptionDetails) throw new Error(result.exceptionDetails.exception?.description || result.exceptionDetails.text);
        return result.result.value;
      };
      await page.send('Runtime.enable');
      await page.send('Log.enable');
      await page.send('Page.enable');
      await page.send('Emulation.setDeviceMetricsOverride', { width: 1440, height: 1000, deviceScaleFactor: 1, mobile: false });
      const url = new URL(relative, directory).href;
      await page.send('Page.navigate', { url });
      await delay(6000);
      console.log(`\n### ${url}`);
      console.log('INITIAL EVENTS', JSON.stringify(events));
      const bodyAudit = () => evaluate(`(() => { const t=document.body.innerText; return {occurrences:Object.fromEntries(['NaN','undefined','Infinity','[object Object]'].map(x=>[x,t.split(x).length-1])),width:innerWidth,scrollWidth:document.documentElement.scrollWidth,height:document.documentElement.scrollHeight,layer:document.body.dataset.layer,fonts:document.fonts.status}; })()`);
      const initialBody = await bodyAudit();
      console.log('BODY @6s', JSON.stringify(initialBody));
      for (const [token, count] of Object.entries(initialBody.occurrences)) {
        const expected = relative === 'docs.html' && token === 'NaN' ? 1 : 0;
        if (count !== expected) { console.log(`FAIL ${relative}: ${token} count ${count} != ${expected}`); process.exitCode = 1; }
      }
      async function screenshot(name) {
        await evaluate('document.fonts.ready.then(()=>true)');
        const { cssContentSize } = await page.send('Page.getLayoutMetrics');
        const { data } = await page.send('Page.captureScreenshot', { format: 'png', captureBeyondViewport: true, clip: { x: 0, y: 0, width: 1440, height: Math.ceil(cssContentSize.height), scale: 1 } });
        writeFileSync(new URL(`_qa/${name}.png`, directory), Buffer.from(data, 'base64'));
        console.log(`SCREENSHOT ${name}.png 1440x${Math.ceil(cssContentSize.height)}`);
      }
      const name = relative.replace('.html', '').replace('?camada=', '-');
      await screenshot(name);
      if (relative === 'curva.html?camada=ouvir' || relative === 'biblioteca.html') {
        await page.send('Emulation.setDeviceMetricsOverride', { width: 390, height: 844, deviceScaleFactor: 1, mobile: true });
        await delay(1000);
        const { cssContentSize } = await page.send('Page.getLayoutMetrics');
        const { data } = await page.send('Page.captureScreenshot', { format: 'png', captureBeyondViewport: true, clip: { x: 0, y: 0, width: 390, height: Math.ceil(cssContentSize.height), scale: 1 } });
        writeFileSync(new URL(`_qa/${name}-mobile.png`, directory), Buffer.from(data, 'base64'));
        console.log('MOBILE', JSON.stringify(await bodyAudit()), `${name}-mobile.png`);
        await page.send('Emulation.setDeviceMetricsOverride', { width: 1440, height: 1000, deviceScaleFactor: 1, mobile: false });
        await delay(500);
      }
      if (process.env.QA_INSPECT) console.log('CONTROLS', JSON.stringify(await evaluate(`Array.from(document.querySelectorAll('button,input,select,[role="button"]')).filter(e=>e.getBoundingClientRect().width && !e.closest('header')).slice(0,65).map(e=>({tag:e.tagName,id:e.id,text:e.innerText?.trim().slice(0,85),type:e.type,role:e.getAttribute('role'),data:{...e.dataset}}))`)));
      let consumed = events.length;
      async function step(label, action) {
        try { await action(); await delay(label.includes('RESOLVER') ? 10000 : 700); console.log('SMOKE', label, JSON.stringify(events.slice(consumed))); }
        catch (error) { console.log('SMOKE FAILED', label, error.message); process.exitCode = 1; }
        consumed = events.length;
      }
      async function click(selector, index = 0) {
        const point = await evaluate(`(() => { const e=document.querySelectorAll(${JSON.stringify(selector)})[${index}]; if(!e)throw Error('Missing ${selector}'); e.scrollIntoView({block:'center'}); const r=e.getBoundingClientRect();return {x:r.x+r.width/2,y:r.y+r.height/2}; })()`);
        await page.send('Input.dispatchMouseEvent', { type: 'mousePressed', button: 'left', clickCount: 1, ...point });
        await page.send('Input.dispatchMouseEvent', { type: 'mouseReleased', button: 'left', clickCount: 1, ...point });
      }
      async function key(key) {
        await page.send('Input.dispatchKeyEvent', { type: 'keyDown', key, code: /^\d$/.test(key) ? `Digit${key}` : key });
        await page.send('Input.dispatchKeyEvent', { type: 'keyUp', key, code: /^\d$/.test(key) ? `Digit${key}` : key });
      }
      if (relative.startsWith('curva')) {
        for (const k of ['2', '3', '1']) {
          await step(`key ${k}`, () => key(k));
          console.log('LAYER', await evaluate('document.body.dataset.layer'));
        }
        await step('choose preset', () => click('#tabsPref button', 1));
        console.log('PRESET', await evaluate('document.querySelector("#npName").innerText'));
      } else if (relative === 'biblioteca.html') {
        await step('open Natural tape', () => click('[data-preset="pref6"]'));
        console.log('TAPE SHEET', await evaluate('({open:document.querySelector("#sheet").open,tracks:document.querySelectorAll("#sheet .track").length})'));
        await step('restore master', () => click('[data-action="reset"]'));
        await step('close tape sheet', () => key('Escape'));
      } else if (relative === 'comparar.html') {
        for (const n of [1, 2]) {
          const selector = `button[aria-label="ARM da pista ${n}"]`;
          // The initial tracks are armed: exercise off and back on, leaving two armed.
          await step(`ARM track ${n} off`, () => click(selector));
          await step(`ARM track ${n} on`, () => click(selector));
        }
        await step('swap A/B', () => click('#swapAB'));
        console.log('ARM STATES', await evaluate('Array.from(document.querySelectorAll("button")).filter(e=>e.ariaLabel?.startsWith("ARM da pista")).map(e=>({label:e.ariaLabel,checked:e.getAttribute("aria-checked")}))'));
      } else if (relative === 'soe-como-x.html') {
        await step('RESOLVER', () => click('#solve'));
        console.log('SOLVER RESULT', await evaluate('({status:document.querySelector("#solverStatus").innerText,rms:document.querySelector("#rms").innerText})'));
        await step('Neutral', () => click('#neutral'));
        await step('Auri default', () => click('#default'));
      } else if (relative === 'comunidade.html') {
        await step('SOLO first strip', () => click('button.solo'));
        console.log('SOLO STATE', await evaluate('({pressed:document.querySelector("button.solo").getAttribute("aria-pressed"),lamp:document.querySelector("#solo-lamp").className})'));
        await step('select second strip', () => click('button.sel', 1));
        await step('sort relevance', () => click('[data-sort="rel"]'));
      } else if (relative === 'teste-cego.html') {
        await step('open candidates', () => click('#tab-candidatos'));
        await step('select Auri', () => click('.cand[data-id="padrao"]'));
        await step('select Natural', () => click('.cand[data-id="pref6"]'));
        console.log('CANDIDATES', await evaluate('Array.from(document.querySelectorAll(".cand[aria-checked=true]")).map(e=>e.ariaLabel)'));
      } else if (relative === 'cabo.html') {
        await step('connect simulated cable', () => click('#connect'));
        for (const k of ['vol', 'plug']) {
          await step(`lift ${k} cover`, () => click(`#cover-${k}`));
          await step(`confirm ${k}`, () => click(`#sw-${k}`));
        }
        await step('lift write cover', () => click('#cover-write'));
        await step('simulated write', () => click('#write-sim'));
        console.log('WRITE RESULT', await evaluate('({lastWrite:document.querySelector("#last-write-ro").innerText,toast:document.querySelector("#toast").innerText,transport:document.querySelector("#tp-status").innerText})'));
      } else if (relative === 'docs.html') {
        await step('open search', () => click('#search-open'));
        await step('type CRC', () => page.send('Input.insertText', { text: 'CRC' }));
        console.log('SEARCH RESULTS', await evaluate(`document.querySelector('#search-count').innerText`));
        await step('Escape', () => key('Escape'));
      }
      console.log('FINAL BODY', JSON.stringify(await bodyAudit()));
      console.log('FINAL EVENTS', JSON.stringify(events));
      if (events.length) process.exitCode = 1;
      await browser.send('Target.closeTarget', { targetId });
      page.close();
    }
  } finally {
    if (browser) await browser.send('Browser.close').catch(() => {});
    for (const ws of sockets) ws.close();
    // Only this run's freshly launched PID, never a global chrome.exe kill.
    if (chrome.exitCode === null) chrome.kill();
  }
}
