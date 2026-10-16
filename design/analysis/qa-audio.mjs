// Curva's shared-block integration checks. Node 22+; no third-party packages.
import { readFileSync, writeFileSync, mkdirSync, readdirSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { spawn, spawnSync } from 'node:child_process';
import { createServer } from 'node:net';
import { setTimeout as delay } from 'node:timers/promises';
import { Script } from 'node:vm';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const root = new URL('../../', import.meta.url);
const mocks = new URL('design/mocks/v2/', root);
const temp = join(tmpdir(), "Claude", "qa-audio");
const screenshots = new URL('_qa/', mocks);
mkdirSync(temp, { recursive: true });
mkdirSync(screenshots, { recursive: true });
let failures = 0;
function check(ok, label, detail) {
  console.log(`${ok ? 'PASS' : 'FAIL'} ${label}${detail === undefined ? '' : ': ' + JSON.stringify(detail)}`);
  if (!ok) failures++;
}
const source = readFileSync(new URL('curva.html', mocks), 'utf8');
function block(name, html = false) {
  const start = html ? `<!-- === OA SHARED: ${name} === -->` : `/* === OA SHARED: ${name} === */`;
  const end = html ? `<!-- === END OA SHARED: ${name} === -->` : `/* === END OA SHARED: ${name} === */`;
  const a = source.indexOf(start), b = source.indexOf(end);
  if (a < 0 || b < a || source.indexOf(start, a + start.length) >= 0 || source.indexOf(end, b + end.length) >= 0) throw new Error(`Missing, duplicate or out-of-order shared markers: ${name}`);
  console.log(`MARKERS ${name}: ${source.slice(0, a).split('\n').length}-${source.slice(0, b).split('\n').length}`);
  return source.slice(a + start.length, b);
}
const css = block('audio-loader v1 (CSS)');
const html = block('audio-loader v1 (HTML)', true);
const storage = block('storage v2');
const audio = block('audio-loader v1');
for (const file of readdirSync(mocks).filter((file) => file.endsWith('.html'))) {
  const text = readFileSync(new URL(file, mocks), 'utf8');
  const result = {};
  for (const [name, expected] of [['audio-loader v1 (CSS)', css], ['audio-loader v1 (HTML)', html], ['storage v2', storage], ['audio-loader v1', audio]]) {
    const isHtml = name.endsWith('(HTML)');
    const begin = isHtml ? `<!-- === OA SHARED: ${name} === -->` : `/* === OA SHARED: ${name} === */`;
    const end = isHtml ? `<!-- === END OA SHARED: ${name} === -->` : `/* === END OA SHARED: ${name} === */`;
    const a = text.indexOf(begin), b = text.indexOf(end);
    const value = a >= 0 && b > a ? text.slice(a + begin.length, b) : null;
    check(value === expected, `${file} shared ${name} byte identity`);
    result[name] = { start: text.slice(0, a).split('\n').length, end: text.slice(0, b).split('\n').length, sha256: value === null ? null : createHash('sha256').update(value).digest('hex') };
  }
  console.log('SHARED RANGES', file, JSON.stringify(result));
  const lines = text.split('\n');
  console.log('ACCENT FIX LINES', file, lines.flatMap((line, i) => line.includes('.oa-audio-btn.has-file{') || line.includes('.oa-audio-rate.approx{') ? [{ line: i + 1, text: line }] : []));
}
check(!/255\s*,\s*122\s*,\s*47|#ffcfae|#ff7a2f/i.test(css), 'shared loader CSS contains no hard-coded orange');
new Script(storage + '\n' + audio);
const ids = [...html.matchAll(/\bid="([^"]+)"/g)].map((match) => match[1]);
check(ids.length === new Set(ids).size, 'shared HTML ids unique', ids);
writeFileSync(`${temp}/loader-only.html`, `<!doctype html><html lang="pt-BR"><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Shared loader QA</title><style>${css}</style><body>${html}<script type="module">${storage}\n${audio}</script></body></html>`);

const samples = 44100 * 3;
const wav = Buffer.alloc(44 + samples * 2);
wav.write('RIFF', 0); wav.writeUInt32LE(wav.length - 8, 4); wav.write('WAVEfmt ', 8);
wav.writeUInt32LE(16, 16); wav.writeUInt16LE(1, 20); wav.writeUInt16LE(1, 22);
wav.writeUInt32LE(44100, 24); wav.writeUInt32LE(88200, 28); wav.writeUInt16LE(2, 32); wav.writeUInt16LE(16, 34);
wav.write('data', 36); wav.writeUInt32LE(samples * 2, 40);
for (let i = 0; i < samples; i++) wav.writeInt16LE(Math.round(Math.sin(i * 2 * Math.PI * 440 / 44100) * 0.05 * 32767), 44 + 2 * i);
writeFileSync(`${temp}/tone.wav`, wav);
console.log(`WAV ${temp}/tone.wav: 3 s, 440 Hz, mono 44100 Hz / PCM16, ${wav.length} B`);
const parity = spawnSync(process.execPath, [fileURLToPath(new URL('qa-parity.mjs', import.meta.url))], { encoding: 'utf8' });
console.log(parity.stdout);
if (parity.stderr) console.log(parity.stderr);
check(parity.status === 0, 'preset parity script');

const server = createServer();
await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
const port = server.address().port;
await new Promise((resolve) => server.close(resolve));
const profile = `${temp}/chrome-${Date.now()}`;
mkdirSync(profile, { recursive: true });
const chrome = spawn('C:/Program Files/Google/Chrome/Application/chrome.exe', [
  '--headless=new', `--remote-debugging-port=${port}`, `--user-data-dir=${profile}`,
  '--autoplay-policy=no-user-gesture-required', '--no-first-run', '--no-default-browser-check',
  '--disable-background-networking', '--disable-extensions', '--hide-scrollbars', 'about:blank',
], { stdio: 'ignore' });
const exited = new Promise((resolve) => chrome.once('exit', resolve));
const sockets = new Set();
async function connect(url) {
  const ws = new WebSocket(url); sockets.add(ws);
  await new Promise((resolve, reject) => { ws.onopen = resolve; ws.onerror = reject; });
  let next = 0;
  const pending = new Map(), listeners = new Map();
  ws.onmessage = ({ data }) => {
    const message = JSON.parse(data);
    if (message.id) {
      const job = pending.get(message.id); pending.delete(message.id);
      if (message.error) job?.reject(new Error(JSON.stringify(message.error))); else job?.resolve(message.result);
    } else for (const callback of listeners.get(message.method) || []) callback(message.params);
  };
  return {
    send(method, params = {}) {
      return new Promise((resolve, reject) => {
        const id = ++next; pending.set(id, { resolve, reject }); ws.send(JSON.stringify({ id, method, params }));
      });
    },
    on(method, callback) { listeners.set(method, [...(listeners.get(method) || []), callback]); },
    close() { ws.close(); sockets.delete(ws); },
  };
}
// Observe native nodes, without exposing/changing the mock's private state.
const instrumentation = `(() => {
  const q = globalThis.__qa = { media: [], iirs: [], buffers: [], gains: [], sources: [], connections: [] };
  globalThis.Audio = new Proxy(globalThis.Audio, { construct(Target, args) { const el=Reflect.construct(Target,args);q.media.push(el);return el; } });
  const p=BaseAudioContext.prototype, iir=p.createIIRFilter, buffer=p.createBufferSource;
  p.createIIRFilter=function(...args){const n=Reflect.apply(iir,this,args);q.iirs.push(args);return n;};
  p.createBufferSource=function(...args){const n=Reflect.apply(buffer,this,args);q.buffers.push(n);return n;};
  const gain=p.createGain, media=AudioContext.prototype.createMediaElementSource, connect=AudioNode.prototype.connect;
  p.createGain=function(...args){const n=Reflect.apply(gain,this,args);q.gains.push(n);return n;};
  AudioContext.prototype.createMediaElementSource=function(...args){const n=Reflect.apply(media,this,args);q.sources.push(n);return n;};
  AudioNode.prototype.connect=function(...args){const result=Reflect.apply(connect,this,args);q.connections.push([this,args[0]]);return result;};
})()`;
const inspectAudio = `(() => {
  const state=OA.audio.state(), el=__qa.media.at(-1), ctx=state.ready?OA.audio.getSource().context:null;
  const noise=__qa.buffers.at(-1), data=noise?.buffer?.getChannelData(0);
  return {state,context:ctx?{state:ctx.state,sampleRate:ctx.sampleRate}:null,
    media:el?{paused:el.paused,currentTime:el.currentTime,duration:el.duration,error:el.error?.message||null,dead:!!el.oaDead}:null,
    iirCount:__qa.iirs.length,gainCount:__qa.gains.length,mediaSourceCount:__qa.sources.length,
    sourceBusOutputs:ctx?__qa.connections.filter(c=>c[0]===OA.audio.getSource()).length:0,
    gainValues:__qa.gains.map(g=>g.gain.value),
    noise:noise?{loop:noise.loop,sampleRate:noise.buffer?.sampleRate,length:data?.length,rms:data?Math.sqrt(data.reduce((s,v)=>s+v*v,0)/data.length):null}:null};
})()`;
const readIdb = `new Promise((resolve,reject)=>{const r=indexedDB.open('oa-v2',1);r.onerror=()=>reject(r.error);r.onsuccess=()=>{const db=r.result,tx=db.transaction('audio','readonly'),g=tx.objectStore('audio').get('current');g.onerror=()=>reject(g.error);g.onsuccess=()=>{const v=g.result;resolve(v?{name:v.name,type:v.type,size:v.size,blobSize:v.blob?.size,isBlob:v.blob instanceof Blob,addedAt:v.addedAt}:null)};tx.oncomplete=()=>db.close()}})`;
// Opening the Windows audio device can outlast the generic click settle time.
// Require real media-clock progress, not just an unpaused element or UI state.
async function playing(tab) {
  let state;
  for (let i = 0; i < 50; i++) {
    state = await tab.evaluate(inspectAudio);
    if (state.media && !state.media.paused && state.media.currentTime > 0) return state;
    await delay(100);
  }
  return state;
}
let browser;
async function newPage(url, waitMs = 6000) {
  const { targetId } = await browser.send('Target.createTarget', { url: 'about:blank' });
  const list = await (await fetch(`http://127.0.0.1:${port}/json/list`)).json();
  const page = await connect(list.find((target) => target.id === targetId).webSocketDebuggerUrl);
  const events = [], contexts = [];
  page.on('Runtime.consoleAPICalled', (event) => {
    if (['warning', 'warn', 'error'].includes(event.type)) events.push({ type: event.type, text: event.args.map((arg) => arg.description ?? arg.value ?? arg.unserializableValue).join(' '), stack: event.stackTrace });
  });
  page.on('Runtime.exceptionThrown', ({ exceptionDetails: error }) => events.push({ type: 'exception', text: error.exception?.description || error.text, url: error.url, line: error.lineNumber + 1 }));
  page.on('Log.entryAdded', ({ entry }) => { if (['warning', 'error'].includes(entry.level)) events.push({ type: `log.${entry.level}`, text: entry.text, url: entry.url }); });
  page.on('WebAudio.contextCreated', ({ context }) => contexts.push(context));
  await page.send('Runtime.enable'); await page.send('Log.enable'); await page.send('Page.enable'); await page.send('DOM.enable'); await page.send('WebAudio.enable');
  await page.send('Page.addScriptToEvaluateOnNewDocument', { source: instrumentation });
  const evaluate = async (expression) => {
    const response = await page.send('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true });
    if (response.exceptionDetails) throw new Error(response.exceptionDetails.exception?.description || response.exceptionDetails.text);
    return response.result.value;
  };
  async function dimensions(width = 1440) {
    await page.send('Emulation.setDeviceMetricsOverride', { width, height: width === 390 ? 844 : 1000, mobile: width === 390, deviceScaleFactor: 1 });
  }
  await dimensions(); await page.send('Page.navigate', { url }); await delay(waitMs);
  console.log(`\nPAGE ${url}`);
  let consumed = 0;
  function audit(label) {
    const fresh = events.slice(consumed); consumed = events.length;
    check(fresh.length === 0, `${label}: console errors/warnings/exceptions`, fresh);
  }
  async function click(selector, index = 0) {
    const point = await evaluate(`(() => {const e=document.querySelectorAll(${JSON.stringify(selector)})[${index}];if(!e)throw Error('Missing selector: '+${JSON.stringify(selector)});e.scrollIntoView({block:'center',behavior:'instant'});const r=e.getBoundingClientRect(),x=r.x+r.width/2,y=r.y+r.height/2,hit=document.elementFromPoint(x,y);if(!hit||!e.contains(hit))throw Error('Click target obscured: '+${JSON.stringify(selector)}+' by '+hit?.tagName+'.'+hit?.className);return{x,y}})()`);
    await page.send('Input.dispatchMouseEvent', { type: 'mousePressed', button: 'left', clickCount: 1, ...point });
    await page.send('Input.dispatchMouseEvent', { type: 'mouseReleased', button: 'left', clickCount: 1, ...point });
    await delay(550); audit(`click ${selector}[${index}]`);
  }
  async function key(key) {
    await page.send('Input.dispatchKeyEvent', { type: 'keyDown', key, code: key });
    await page.send('Input.dispatchKeyEvent', { type: 'keyUp', key, code: key });
    await delay(550); audit(`key ${key}`);
  }
  async function body(label) {
    const result = await evaluate(`(() => {const t=document.body.innerText;return{occurrences:Object.fromEntries(['NaN','undefined','Infinity','[object Object]'].map(x=>[x,t.split(x).length-1])),width:innerWidth,scrollWidth:document.documentElement.scrollWidth,layer:document.body.dataset.layer}})()`);
    check(Object.values(result.occurrences).every((n) => n === 0), label, result); return result;
  }
  async function screenshot(name, width = 1440) {
    await evaluate('document.fonts.ready.then(()=>true)');
    await evaluate('scrollTo(0,0)'); await delay(300);
    const { cssContentSize } = await page.send('Page.getLayoutMetrics');
    const height = Math.ceil(cssContentSize.height);
    const { data } = await page.send('Page.captureScreenshot', { format: 'png', captureBeyondViewport: true, clip: { x: 0, y: 0, width, height, scale: 1 } });
    writeFileSync(new URL(`${name}.png`, screenshots), Buffer.from(data, 'base64'));
    console.log(`SCREENSHOT ${name}.png ${width}x${height}`);
  }
  async function reload() {
    await page.send('Page.reload', { ignoreCache: true }); await delay(2500);
    await evaluate('OA.audio.ready.then(()=>true)'); await delay(500); audit('reload');
  }
  async function setFile() {
    const { root: document } = await page.send('DOM.getDocument');
    const { nodeId } = await page.send('DOM.querySelector', { nodeId: document.nodeId, selector: '#oaAudioFile' });
    await page.send('DOM.setFileInputFiles', { nodeId, files: [`${temp}/tone.wav`] });
    await delay(1000); audit('DOM.setFileInputFiles tone.wav');
  }
  return { page, targetId, events, contexts, evaluate, dimensions, audit, click, key, body, screenshot, reload, setFile,
    async close() { audit('final'); console.log('WEB AUDIO CONTEXTS', JSON.stringify(contexts)); await browser.send('Target.closeTarget', { targetId }); page.close(); },
  };
}

async function sharedPagesQa() {
  const files = ['biblioteca.html', 'comparar.html', 'soe-como-x.html', 'comunidade.html', 'teste-cego.html', 'cabo.html', 'docs.html'];
  const curve = await newPage(new URL('curva.html?camada=ouvir', mocks).href);
  curve.audit('shared audio initial');
  await curve.click('#oaAudioBtn'); await curve.setFile();
  check((await curve.evaluate(readIdb))?.name === 'tone.wav', 'shared WAV initially stored in Curva');
  await curve.screenshot('curva-audio-popover');
  await curve.click('#oaAudioBtn'); await curve.click('#prevSw');
  let state = await playing(curve);
  check(state.state.mode === 'chains' && state.iirCount === 20 && state.context?.sampleRate === 96000, 'Curva shared preview', state);
  await curve.click('#abSw'); await curve.click('#abSw'); await curve.click('#prevSw');
  const structure = `(() => {function shape(root){return root?{tag:root.tagName,classes:root.className,children:Array.from(root.children).map(shape)}:null}return{header:shape(document.querySelector('.cable-bar')),footer:shape(document.querySelector('.site-footer'))}})()`;
  const canonicalStructure = await curve.evaluate(structure);

  for (const file of files) {
    const tab = await newPage(new URL(file, mocks).href);
    tab.audit(`${file} initial`);
    await tab.evaluate('OA.audio.ready.then(()=>true)');
    const name = await tab.evaluate('document.querySelector("#oaAudioName").textContent');
    check(name === 'tone.wav' && (await tab.evaluate(readIdb))?.name === 'tone.wav', `${file}: file loaded in Curva restored across pages`, name);
    const colors = await tab.evaluate(`({accent:getComputedStyle(document.documentElement).getPropertyValue('--accent').trim(),loadedBorder:getComputedStyle(document.querySelector('#oaAudioBtn')).borderColor,colorMixSupported:CSS.supports('color','color-mix(in srgb,red 55%,transparent)')})`);
    console.log('LOADER ACCENT', file, JSON.stringify(colors));
    if (file === 'biblioteca.html') {
      await tab.click('#oaAudioBtn'); await tab.screenshot('biblioteca-audio-popover'); await tab.click('#oaAudioBtn');
      await tab.click('[data-preset="pref6"]'); await tab.click('[data-action="listen"]');
      state = await playing(tab);
      check(state.state.mode === 'chains' && state.iirCount === 20, 'Biblioteca Ouvir tape sheet', state);
      await tab.click('[data-action="ab-b"]'); await tab.click('[data-action="ab-a"]'); await tab.click('[data-action="listen"]');
      await tab.key('Escape');
    } else if (file === 'comparar.html') {
      for (const owner of ['S4', 'Sos']) {
        const before = (await tab.evaluate(inspectAudio)).iirCount;
        await tab.click(`#ab${owner}Play`); state = await playing(tab);
        check(state.state.mode === 'chains' && state.iirCount > before, `Comparar ${owner} preview`, state);
        await tab.click(`#ab${owner}B`); await tab.click(`#ab${owner}A`); await tab.click(`#ab${owner}Play`);
      }
    } else if (file === 'soe-como-x.html') {
      await tab.click('#solve'); await delay(10000); tab.audit('Soe como X solver');
      await tab.click('#abPlay'); state = await playing(tab);
      check(state.state.mode === 'chains' && state.iirCount > 10, 'Soe como X solved preview A/B', state);
      await tab.click('#abA'); await tab.click('#abB'); await tab.click('#abPlay');
    } else if (file === 'comunidade.html') {
      await tab.click('#ab-play'); state = await playing(tab);
      check(state.state.mode === 'chains' && state.iirCount > 10, 'Comunidade master preview A/B', state);
      await tab.click('#ab-b'); await tab.click('#ab-a'); await tab.click('#ab-play');
    } else if (file === 'teste-cego.html') {
      const sourceName = await tab.evaluate('document.querySelector("#srcName").innerText');
      check(sourceName.includes('tone.wav'), 'Teste cego Preparo file name', sourceName);
      await tab.click('input[name="out"][value="outra"]');
      await tab.click('#tab-candidatos'); await tab.click('.cand[data-id="padrao"]'); await tab.click('.cand[data-id="pref6"]');
      await tab.click('#startBtn'); await tab.click('#playKey');
      const first = await playing(tab);
      check(first.state.mode === 'chains' && first.mediaSourceCount === 1 && first.iirCount === 20 && first.gainCount === 10 && first.sourceBusOutputs === 3, 'blind test one media source / two parallel ten-IIR chains / ten gains', first);
      await tab.click('.key[data-n="2"]');
      const second = await tab.evaluate(inspectAudio);
      check(second.iirCount === first.iirCount && second.mediaSourceCount === 1 && JSON.stringify(first.gainValues) !== JSON.stringify(second.gainValues), 'blind switch 1 to 2 changes gains without rebuilding source or IIR chains', second);
      await tab.click('.key[data-n="1"]'); await tab.click('#playKey');
      state = first;
    } else {
      await tab.click('#oaAudioBtn'); await tab.click('#oaAudioPlay'); state = await playing(tab);
      check(state.state.mode === 'raw' && !state.media.paused, `${file} raw loader playback (no DSP preview on this page)`, state);
      await tab.click('#oaAudioPlay'); await tab.click('#oaAudioBtn');
    }
    check(state.context?.sampleRate === 96000 && state.context.state === 'running', `${file} AudioContext sampleRate`, state.context);
    if (file === 'docs.html') {
      const actual = await tab.evaluate(structure);
      for (const part of ['header', 'footer']) {
        const identical = JSON.stringify(actual[part]) === JSON.stringify(canonicalStructure[part]);
        check(identical, `Docs ${part} tag/class tree matches Curva`, identical ? undefined : { curva: canonicalStructure[part], docs: actual[part] });
      }
      console.log('DOCS COLOPHON CHECK', await tab.evaluate(`({footerChildren:Array.from(document.querySelector('.site-footer').children).map(e=>({tag:e.tagName,class:e.className})),colophons:Array.from(document.querySelectorAll('[class*="colophon"],.footer-bottom,.footer-base')).map(e=>({class:e.className,text:e.innerText}))})`));
    }
    await tab.close();
  }

  // Remove from a running preview: retain the chains and replace only their source.
  await curve.click('#prevSw'); await curve.click('#oaAudioBtn'); await curve.click('#oaAudioRemove');
  state = await curve.evaluate(inspectAudio);
  check(state.state.file === null && state.state.mode === 'chains' && state.noise?.rms > 0 && await curve.evaluate(readIdb) === null, 'cross-page WAV removal falls back to pink noise', state);
  await curve.setFile(); await curve.click('#oaAudioBtn'); await curve.click('#prevSw');

  // Language: change through the real Curva toggle; every other app must initialize in EN.
  await curve.click('#lang');
  for (const file of files) {
    const tab = await newPage(new URL(file, mocks).href, 3500);
    const result = await tab.evaluate(`({stored:OA.store.getLang(),lang:document.documentElement.lang,nav:document.querySelector('.main-nav a').textContent.trim(),audioTitle:document.querySelector('#oaAudioTitle').textContent})`);
    check(result.stored === 'en-US' && result.nav === 'Curve' && result.audioTitle === 'Preview audio', `${file} initializes in shared English`, result);
    await tab.close();
  }
  await curve.click('#lang');

  // Follow the real handoff link in the same tab; do not inject the curve into storage.
  const library = await newPage(new URL('biblioteca.html', mocks).href);
  await library.click('[data-preset="musical"]'); await library.click('[data-action="open-curve"]'); await delay(3000);
  const handoff = await library.evaluate(`({url:location.href,name:document.querySelector('#npName')?.textContent,current:JSON.parse(localStorage.getItem('oa.v2.current'))})`);
  check(handoff.url.includes('curva.html') && handoff.name === 'Musical' && handoff.current?.source === 'preset:musical' && handoff.current.preampDb === -2.3, 'Biblioteca Abrir na Curva -> storage handoff', handoff);
  await library.close();

  const cable = await newPage(new URL('cabo.html', mocks).href);
  const before = await cable.evaluate('({counts:OA.store.flashCounts(),journal:OA.store.journal()})');
  await cable.click('#connect');
  for (const kind of ['vol', 'plug']) { await cable.click(`#cover-${kind}`); await cable.click(`#sw-${kind}`); }
  await cable.click('#cover-write'); await cable.click('#write-sim'); await delay(1000);
  const after = await cable.evaluate(`({counts:OA.store.flashCounts(),journal:OA.store.journal(),day:OA.store.get(OA.store.KEYS.flashDay),total:OA.store.get(OA.store.KEYS.flashTotal),session:OA.store.get(OA.store.KEYS.flashSession),transport:document.querySelector('#tp-status').innerText})`);
  check(after.counts.session === before.counts.session + 1 && after.counts.today === before.counts.today + 1 && after.counts.total === before.counts.total + 1 && after.journal.length === before.journal.length + 1, 'Cabo simulated write updates canonical journal and all flash counters', after);
  // sessionStorage belongs to a tab: navigate, rather than incorrectly expecting a new tab to share it.
  await cable.page.send('Page.navigate', { url: new URL('curva.html?camada=ouvir', mocks).href }); await delay(3500);
  await cable.click('button[data-action="write"]');
  const counters = await cable.evaluate(`({counts:OA.store.flashCounts(),shown:Array.from(document.querySelectorAll('#wCounters .sr-only')).map(e=>Number(e.textContent)),payload:document.querySelector('#wPayload').textContent})`);
  check(JSON.stringify(counters.shown) === JSON.stringify([after.counts.session, after.counts.today, after.counts.total]), 'Curva checklist reflects Cabo write (same tab session)', counters);
  await cable.key('Escape');

  // Delete only in the throwaway profile, through Docs' actual confirmed UI.
  await cable.page.send('Page.navigate', { url: new URL('docs.html', mocks).href }); await delay(3500);
  await cable.evaluate('OA.audio.ready.then(()=>true)');
  await cable.click('#oaAudioBtn');
  await cable.evaluate(`(() => {const e=document.querySelector('#oaAudioVol');e.value='-13';e.dispatchEvent(new Event('input',{bubbles:true}));return true})()`);
  await cable.click('#oaAudioBtn');
  console.log('BEFORE CLEAR', await cable.evaluate(`({local:Object.keys(localStorage).filter(k=>k.startsWith('oa.v2.')),session:Object.keys(sessionStorage).filter(k=>k.startsWith('oa.v2.')),file:OA.audio.state().file})`));
  const dialogs = [];
  cable.page.on('Page.javascriptDialogOpening', (dialog) => { dialogs.push({ type: dialog.type, message: dialog.message }); void cable.page.send('Page.handleJavaScriptDialog', { accept: true }).catch((error) => check(false, 'accept clear confirmation', error.message)); });
  await cable.click('#clear-local'); await delay(1000);
  const erased = await cable.evaluate(`(async () => ({local:Object.keys(localStorage).filter(k=>k.startsWith('oa.v2.')),session:Object.keys(sessionStorage).filter(k=>k.startsWith('oa.v2.')),file:OA.audio.state().file,databases:(await indexedDB.databases()).map(d=>d.name),toast:document.querySelector('#toast').innerText}))()`);
  check(dialogs.length === 1 && dialogs[0].type === 'confirm' && erased.local.length === 0 && erased.session.length === 0 && erased.file === null && !erased.databases.includes('oa-v2'), 'Docs confirmed clear removes oa.v2 keys and IndexedDB audio database', { dialogs, ...erased });
  await cable.close(); await curve.close();
}

try {
  let version;
  for (let i = 0; i < 100; i++) {
    try { version = await (await fetch(`http://127.0.0.1:${port}/json/version`)).json(); break; } catch { await delay(100); }
  }
  if (!version) throw new Error(`No CDP response from launched Chrome PID ${chrome.pid}`);
  console.log(`BROWSER ${version.Browser}, PID ${chrome.pid}, port ${port}, profile ${profile}`);
  browser = await connect(version.webSocketDebuggerUrl);
  if (process.argv.includes('--all')) {
    await sharedPagesQa();
  } else {
  for (const layer of ['ouvir', 'ajustar', 'engenharia']) {
    const tab = await newPage(new URL(`curva.html?camada=${layer}`, mocks).href);
    tab.audit(`${layer} @6s`); await tab.body(`${layer} body @6s`);
    await tab.screenshot(`curva-${layer}`);
    if (layer === 'ouvir') {
      await tab.dimensions(390); await delay(800); await tab.body('ouvir mobile'); await tab.screenshot('curva-ouvir-mobile', 390);
    }
    await tab.close();
  }

  const tab = await newPage(new URL('curva.html?camada=ouvir', mocks).href);
  tab.audit('audio initial');
  await tab.click('#oaAudioBtn'); await tab.setFile();
  check(await tab.evaluate('document.querySelector("#oaAudioName").textContent') === 'tone.wav', 'loader shows file name');
  let record = await tab.evaluate(readIdb);
  check(record?.name === 'tone.wav' && record.isBlob && record.size === wav.length && record.blobSize === wav.length, 'IndexedDB oa-v2/audio/current', record);
  await tab.reload();
  let audioState = await tab.evaluate(inspectAudio);
  check(audioState.state.file?.name === 'tone.wav' && audioState.media?.duration === 3, 'file survives reload', audioState);
  await tab.click('#oaAudioBtn'); await tab.click('#oaAudioPlay');
  audioState = await playing(tab);
  check(audioState.state.mode === 'raw' && audioState.media?.paused === false && audioState.media.currentTime > 0 && !audioState.media.error && audioState.context?.state === 'running', 'raw playback', audioState);
  check(audioState.context?.sampleRate === 96000 && audioState.state.exact, 'requested 96000 Hz granted', audioState.context);
  await tab.click('#oaAudioPlay');
  check((await tab.evaluate(inspectAudio)).media.paused === true, 'raw pause');
  await tab.screenshot('curva-audio-popover');
  await tab.click('#oaAudioBtn'); await tab.click('#prevSw');
  audioState = await tab.evaluate(inspectAudio);
  check(audioState.state.mode === 'chains' && audioState.iirCount === 20 && !audioState.media.paused && await tab.evaluate('document.querySelector("#prevSw").getAttribute("aria-pressed")') === 'true', 'OUVIR PRÉVIA: file through exact IIR A/B chains', audioState);
  await tab.click('#abSw'); check(await tab.evaluate('document.querySelector("#abSw").dataset.pos') === 'A', 'A/B switches to A');
  await tab.click('#abSw'); check(await tab.evaluate('document.querySelector("#abSw").dataset.pos') === 'B', 'A/B switches to B');
  await tab.click('#oaAudioBtn'); await tab.click('#oaAudioRemove');
  audioState = await tab.evaluate(inspectAudio); record = await tab.evaluate(readIdb);
  check(audioState.state.file === null && audioState.state.mode === 'chains' && audioState.noise?.loop && audioState.noise.rms > 0 && record === null, 'remove file: running preview falls back to pink noise; IDB cleared', audioState);
  await tab.body('audio interactions body'); await tab.click('#oaAudioBtn'); await tab.click('#prevSw'); await tab.close();

  const editor = await newPage(new URL('curva.html?camada=ajustar', mocks).href);
  editor.audit('editor initial');
  await editor.click('#tabsPref button[data-id="pref6"]');
  const preset = await editor.evaluate('JSON.parse(localStorage.getItem("oa.v2.current"))');
  check(preset?.source === 'preset:pref6' && preset.bands?.length === 10, 'preset storage contract', preset);
  await editor.click('#modules .fmod:first-child .knobs .kunit:nth-child(2) .readout');
  await editor.page.send('Input.insertText', { text: '-2.1' }); await editor.key('Enter'); await delay(500);
  const current = await editor.evaluate('JSON.parse(localStorage.getItem("oa.v2.current"))');
  check(current?.source === 'custom' && typeof current.name === 'string' && Number.isFinite(current.preampDb) && Number.isFinite(current.updatedAt) && current.bands?.length === 10 && current.bands.every((band) => typeof band === 'string') && current.bands[0] !== preset.bands[0], 'edited-band storage contract', current);
  await editor.click('#lang');
  check(await editor.evaluate('JSON.parse(localStorage.getItem("oa.v2.lang"))') === 'en-US', 'language saved en-US');
  await editor.reload();
  check(await editor.evaluate('document.documentElement.lang') === 'en' && await editor.evaluate('OA.store.getLang()') === 'en-US', 'language survives reload');
  check(await editor.evaluate('OA.store.loadCurrent().bands[0].gainDb') === -2.1, 'edited gain survives reload');
  await editor.click('#lang'); await editor.close();

  const engineering = await newPage(new URL('curva.html?camada=engenharia', mocks).href);
  engineering.audit('engineering initial');
  await engineering.click('button[data-action="neutral"]');
  for (const kind of ['HS', 'HP']) {
    const index = await engineering.evaluate(`Array.from(document.querySelectorAll('#modules .fmod:first-child .kbtn')).findIndex(b=>b.textContent===${JSON.stringify(kind)})`);
    await engineering.click('#modules .fmod:first-child .kbtn', index);
    const result = await engineering.evaluate(`({kind:document.querySelector('#modules .fmod:first-child .kbtn[aria-pressed=true]').textContent,badge:document.querySelector('#modules .fmod:first-child .exp-badge').innerText,badgeHidden:document.querySelector('#modules .fmod:first-child .exp-badge').hidden,gate:document.querySelector('#gateRow').innerText,verdict:document.querySelector('#gate1').innerText,current:OA.store.loadCurrent()})`);
    check(result.kind === kind && !result.badgeHidden && result.badge.includes('EXPERIMENTAL') && result.current.bands.some((band) => band.kind === kind), `Engenharia ${kind}: experimental badge / gate update`, result);
  }
  await engineering.click('.mode-lbl[data-layer="ajustar"]');
  await engineering.click('button[data-action="default"]');
  const locked = await engineering.evaluate(`Array.from(document.querySelectorAll('#modules .fmod:first-child .kbtn')).filter(b=>['HS','LP','HP'].includes(b.textContent)).map(b=>({kind:b.textContent,disabled:b.getAttribute('aria-disabled'),locked:b.classList.contains('locked'),hint:b.title}))`);
  check(locked.length === 3 && locked.every((button) => button.disabled === 'true' && button.locked && button.hint.includes('Engenharia')), 'Ajustar HS/LP/HP locked with hint', locked);
  const hsIndex = await engineering.evaluate(`Array.from(document.querySelectorAll('#modules .fmod:first-child .kbtn')).findIndex(b=>b.textContent==='HS')`);
  await engineering.click('#modules .fmod:first-child .kbtn', hsIndex);
  check(await engineering.evaluate(`document.querySelector('#modules .fmod:first-child .kbtn[aria-pressed=true]').textContent`) === 'PK', 'locked HS click leaves PK unchanged', await engineering.evaluate('document.querySelector("#toast").innerText'));
  await engineering.body('engineering interactions body'); await engineering.close();

  const only = await newPage(pathToFileURL(`${temp}/loader-only.html`).href);
  only.audit('loader-only initial');
  check(await only.evaluate('!!globalThis.OA?.audio && !!globalThis.OA?.audioUI && !!globalThis.OA?.store'), 'copied blocks initialize independently');
  if (await only.evaluate('!!OA.audio.state().file')) await only.evaluate('OA.audio.removeFile().then(()=>true)');
  await only.click('#oaAudioBtn'); await only.setFile();
  record = await only.evaluate(readIdb); check(record?.name === 'tone.wav' && record.isBlob, 'loader-only file stored', record);
  await only.reload();
  check(await only.evaluate('OA.audio.state().file?.name') === 'tone.wav', 'loader-only file restored');
  await only.click('#oaAudioBtn'); await only.click('#oaAudioPlay');
  audioState = await playing(only);
  check(audioState.state.mode === 'raw' && !audioState.media.paused && audioState.media.currentTime > 0 && audioState.context?.state === 'running', 'loader-only raw playback without codec or page code', audioState);
  await only.click('#oaAudioPlay'); await only.click('#oaAudioRemove');
  check(await only.evaluate(readIdb) === null && await only.evaluate('OA.audio.state().file') === null, 'loader-only removal');
  await only.evaluate(`OA.audio.start('raw').then(()=>true)`); await delay(500);
  audioState = await only.evaluate(inspectAudio);
  check(audioState.noise?.rms > 0 && audioState.noise.loop && audioState.state.mode === 'raw', 'loader-only pink-noise source', audioState);
  await only.evaluate('OA.audio.stop()'); await only.body('loader-only body'); await only.close();
  }
} catch (error) {
  failures++; console.error('QA ERROR', error.stack || error);
} finally {
  if (browser) await browser.send('Browser.close').catch(() => {});
  for (const ws of sockets) ws.close();
  await Promise.race([exited, delay(2500)]);
  if (chrome.exitCode === null) { chrome.kill(); await Promise.race([exited, delay(2000)]); }
  console.log(`CHROME CLEANUP PID ${chrome.pid}: ${chrome.exitCode === null ? 'kill requested for owned PID' : `exited (${chrome.exitCode})`}`);
}
console.log(`\nAudio integration QA: ${failures} failure(s).`);
if (failures) process.exitCode = 1;
