import assert from 'node:assert/strict';
import test from 'node:test';
import fs from 'node:fs';
import vm from 'node:vm';

function deferred() { let resolve; const promise = new Promise(r => resolve = r); return {promise, resolve}; }
async function settle() { for (let i = 0; i < 16; i++) await Promise.resolve(); }
function harness(start, getMedia = async()=>({getTracks:()=>[{stop(){}}]})) {
  const elements = new Map(), calls = [], timers = new Map(), intervals = new Map(); let serial = 0;
  const element = id => { if (!elements.has(id)) elements.set(id, {textContent:'', className:'', hidden:false, disabled:false, style:{}, handlers:{}, addEventListener(name,fn){this.handlers[name]=fn;}}); return elements.get(id); };
  const store = new Map();
  const context = vm.createContext({
    console, Date, Math, JSON, String, Float32Array, Promise,
    document: {getElementById:element, visibilityState:'visible', addEventListener(){}},
    navigator: {wakeLock:{request:async()=>({release:async()=>{}})},mediaDevices:{getUserMedia:getMedia}},
    localStorage: {getItem:k=>store.get(k),setItem:(k,v)=>store.set(k,v)},
    performance:{now:()=>1000},
    setInterval:(fn,ms)=>{const id=++serial;intervals.set(id,{fn,ms});return id;},clearInterval:id=>intervals.delete(id),
    setTimeout:(fn,ms)=>{const id=++serial;timers.set(id,{fn,ms});return id;},clearTimeout:id=>timers.delete(id),
    requestAnimationFrame:()=>++serial,cancelAnimationFrame(){},
    window:{AudioContext:class {state='running';createMediaStreamSource(){return {connect(){}};}createAnalyser(){return {fftSize:1024,getFloatTimeDomainData(a){a.fill(0);}};}async close(){}async resume(){}}},
    Conversation:{startSession:options=>{calls.push(options);return start(options,calls.length);}}
  });
  const html=fs.readFileSync(new URL('./index.html',import.meta.url),'utf8');
  const script=html.match(/<script type="module">([\s\S]*?)<\/script>/)[1].replace(/^\s*import .*;\s*$/m,'');
  vm.runInContext(script+`;globalThis.app={startDrive,endDrive,connect,state:()=>({driving,conv,connecting,generation,transcript:transcript.slice()})};`,context);
  return {app:context.app,calls,elements,element,timers,intervals};
}
function session() { return {ended:0,updates:[],async endSession(){this.ended++;},sendContextualUpdate(note){this.updates.push(note);}}; }

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

test('repeated reconnects keep only the current room and close each prior room',async()=>{
  const sessions=[session(),session(),session()];
  const h=harness(async(o,n)=>{o.onConnect();return sessions[n-1];});
  await h.app.startDrive();
  for (let i=0;i<2;i++) { await h.element('recover').handlers.click(); await settle(); }
  assert.equal(h.calls.length,3);
  assert.equal(sessions[0].ended,1);assert.equal(sessions[1].ended,1);assert.equal(sessions[2].ended,0);
  assert.equal(h.app.state().conv,sessions[2]);assert.equal(h.element('status').textContent,'Connected');
});

test('microphone denial after a disconnect leaves recovery available and a later reconnect works',async()=>{
  const first=session(),second=session(); let denied=true;
  const h=harness(async(o,n)=>{o.onConnect();return n===1?first:second;},async()=>{
    if (denied) throw new Error('permission denied');
    return {getTracks:()=>[{stop(){}}]};
  });
  await h.app.startDrive();h.calls[0].onDisconnect();await settle();
  assert.equal(h.element('recover').hidden,false);assert.match(h.element('device').textContent,/microphone recovery unavailable/);
  denied=false;await h.element('recover').handlers.click();await settle();
  assert.equal(h.app.state().conv,second);assert.equal(h.element('status').textContent,'Connected');
});

test('rapid recovery taps create one replacement session',async()=>{
  const first=session(),second=session();const h=harness(async(o,n)=>{o.onConnect();return n===1?first:second;});
  await h.app.startDrive();
  const a=h.element('recover').handlers.click(),b=h.element('recover').handlers.click();
  await Promise.all([a,b]);await settle();
  assert.equal(h.calls.length,2);assert.equal(first.ended,1);assert.equal(h.app.state().conv,second);
});

test('a pending replacement SDK session is ended when the drive ends',async()=>{
  const first=session(),late=session(),opening=deferred();
  const h=harness((o,n)=>{if(n===1){o.onConnect();return Promise.resolve(first);}return opening.promise;});
  await h.app.startDrive();const reconnect=h.element('recover').handlers.click();await settle();
  assert.equal(h.calls.length,2);await h.app.endDrive();opening.resolve(late);await reconnect;
  assert.equal(late.ended,1);assert.equal(h.app.state().conv,null);assert.equal(h.element('status').textContent,'Drive ended');
});

test('a long connected call keeps one clock and sends its contextual minute note',async()=>{
  const s=session(),h=harness(async o=>{o.onConnect();return s;});await h.app.startDrive();
  const clocks=[...h.intervals.values()].filter(x=>x.ms===60000);
  assert.equal(clocks.length,1);clocks[0].fn();
  assert.equal(s.updates.length,1);assert.match(s.updates[0],/^Time note: it is /);
  await h.app.endDrive();assert.equal([...h.intervals.values()].filter(x=>x.ms===60000).length,0);
});

test('reconnect includes the recorded conversation and task acknowledgment as context',async()=>{
  const first=session(),second=session();const h=harness(async(o,n)=>{o.onConnect();return n===1?first:second;});
  await h.app.startDrive();
  h.calls[0].onMessage({source:'user',message:'Please retrieve the original submitted manuscript.'});
  h.calls[0].onMessage({source:'agent',message:'I accepted it and sent it.'});
  await h.element('recover').handlers.click();await settle();
  const vars=h.calls[1].dynamicVariables;
  assert.match(vars.recent_context,/Moshe: Please retrieve the original submitted manuscript\./);
  assert.match(vars.recent_context,/You: I accepted it and sent it\./);
  assert.match(vars.recent_context,/request=Please retrieve the original submitted manuscript\./);
});


test('audio recovery is available even when a connected call has no explicit SDK error',async()=>{
  const h=harness(async o=>{o.onConnect();return session();});await h.app.startDrive();
  assert.equal(h.element('recover').hidden,false);
});

test('an older microphone request cannot replace the newer idle listener',async()=>{
  const old=deferred(),fresh=deferred();let micCalls=0,oldStops=0,newStops=0;
  const h=harness(async o=>{o.onConnect();return session();},()=>++micCalls===1?old.promise:fresh.promise);
  await h.app.startDrive();h.calls[0].onDisconnect();await settle();
  await h.app.connect();h.calls[1].onDisconnect();await settle();
  fresh.resolve({getTracks:()=>[{stop(){newStops++;}}]});await settle();
  old.resolve({getTracks:()=>[{stop(){oldStops++;}}]});await settle();
  assert.equal(oldStops,1);assert.equal(newStops,0);
  await h.app.endDrive();assert.equal(newStops,1);
});

test('120 minute-note callbacks and 100 reconnects do not accumulate session clocks',async()=>{
  const sessions=[];const h=harness(async o=>{const s=session();sessions.push(s);o.onConnect();return s;});
  await h.app.startDrive();
  for(let minute=0;minute<120;minute++) for(const t of [...h.intervals.values()]) if(t.ms===60000)t.fn();
  assert.equal(sessions[0].updates.length,120);
  for(let n=0;n<100;n++) {await h.element('recover').handlers.click();await settle();}
  assert.equal(sessions.length,101);
  assert.equal(sessions.filter(s=>s.ended===0).length,1);
  assert.equal([...h.intervals.values()].filter(t=>t.ms===60000).length,1);
  await h.app.endDrive();assert.equal(sessions.every(s=>s.ended===1),true);
  assert.equal([...h.intervals.values()].filter(t=>t.ms===60000).length,0);
});
