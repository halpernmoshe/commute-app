import assert from 'node:assert/strict';
import test from 'node:test';
import fs from 'node:fs';
import vm from 'node:vm';

function deferred() { let resolve; const promise = new Promise(r => resolve = r); return {promise, resolve}; }
async function settle() { for (let i = 0; i < 16; i++) await Promise.resolve(); }
function harness(start, getMedia = async()=>({getTracks:()=>[{stop(){}}]})) {
  const elements = new Map(), calls = [], timers = new Map(); let serial = 0;
  const element = id => { if (!elements.has(id)) elements.set(id, {textContent:'', className:'', hidden:false, disabled:false, style:{}, handlers:{}, addEventListener(name,fn){this.handlers[name]=fn;}}); return elements.get(id); };
  const store = new Map();
  const context = vm.createContext({
    console, Date, Math, JSON, String, Float32Array, Promise,
    document: {getElementById:element, visibilityState:'visible', addEventListener(){}},
    navigator: {wakeLock:{request:async()=>({release:async()=>{}})},mediaDevices:{getUserMedia:getMedia}},
    localStorage: {getItem:k=>store.get(k),setItem:(k,v)=>store.set(k,v)},
    performance:{now:()=>1000},
    setInterval:()=>++serial,clearInterval(){},
    setTimeout:(fn,ms)=>{const id=++serial;timers.set(id,{fn,ms});return id;},clearTimeout:id=>timers.delete(id),
    requestAnimationFrame:()=>++serial,cancelAnimationFrame(){},
    window:{AudioContext:class {state='running';createMediaStreamSource(){return {connect(){}};}createAnalyser(){return {fftSize:1024,getFloatTimeDomainData(a){a.fill(0);}};}async close(){}async resume(){}}},
    Conversation:{startSession:options=>{calls.push(options);return start(options,calls.length);}}
  });
  const html=fs.readFileSync(new URL('./index.html',import.meta.url),'utf8');
  const script=html.match(/<script type="module">([\s\S]*?)<\/script>/)[1].replace(/^\s*import .*;\s*$/m,'');
  vm.runInContext(script+`;globalThis.app={startDrive,endDrive,connect,state:()=>({driving,conv,connecting,generation,transcript:transcript.slice()})};`,context);
  return {app:context.app,calls,elements,element,timers};
}
function session() { return {ended:0,async endSession(){this.ended++;},sendContextualUpdate(){}}; }

test('actual app preserves connected state after startSession resolves',async()=>{
  const s=session(); const h=harness(async o=>{o.onConnect();return s;});
  await h.app.startDrive();
  assert.equal(h.app.state().conv,s);
  assert.equal(h.app.state().connecting,false);
  assert.equal(h.element('status').textContent,'Connected');
  assert.equal(h.element('big').textContent,'On call');
});

test('ending a drive while SDK startup is pending closes the late session',async()=>{
  const pending=deferred(),s=session();const h=harness(()=>pending.promise);
  const opening=h.app.startDrive();await settle();assert.equal(h.calls.length,1);
  await h.app.endDrive();pending.resolve(s);await opening;
  assert.equal(h.app.state().driving,false);assert.equal(h.app.state().conv,null);assert.equal(s.ended,1);
  h.calls[0].onConnect();h.calls[0].onMessage({source:'agent',message:'stale reply'});
  assert.equal(h.app.state().transcript.length,0);
  assert.equal(h.element('status').textContent,'Drive ended');assert.equal(h.element('end').hidden,true);
});

test('late callbacks from a disconnected session cannot clear the replacement',async()=>{
  const first=session(),second=session();const h=harness(async(o,n)=>{o.onConnect();return n===1?first:second;});
  await h.app.startDrive();h.calls[0].onDisconnect();await settle();await h.app.connect();
  h.calls[0].onDisconnect();h.calls[0].onError(new Error('late transport error'));h.calls[0].onMessage({source:'agent',message:'old result'});
  assert.equal(h.app.state().conv,second);assert.equal(h.element('status').textContent,'Connected');assert.equal(h.app.state().transcript.length,0);
});

test('tool/session error exposes recovery without abandoning a connected room',async()=>{
  const s=session();const h=harness(async o=>{o.onConnect();return s;});await h.app.startDrive();
  h.calls[0].onError(new Error('tool unavailable'));
  assert.equal(h.app.state().conv,s);assert.equal(s.ended,0);assert.equal(h.element('recover').hidden,false);
  assert.match(h.element('err').textContent,/tool unavailable/);
  assert.equal([...h.timers.values()].filter(x=>x.ms===45000).length,0,'server owns silence detection; no client timer cuts off speech');
});


test('a late idle microphone acquisition releases its tracks after reconnect',async()=>{
  const mic=deferred();let stopped=0;const first=session(),second=session();
  const h=harness(async(o,n)=>{o.onConnect();return n===1?first:second;},()=>mic.promise);
  await h.app.startDrive();h.calls[0].onDisconnect();await settle();
  await h.app.connect();mic.resolve({getTracks:()=>[{stop(){stopped++;}}]});await settle();
  assert.equal(h.app.state().conv,second);assert.equal(stopped,1);
});
