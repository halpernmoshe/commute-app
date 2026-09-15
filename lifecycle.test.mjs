import assert from 'node:assert/strict';
import test from 'node:test';
import fs from 'node:fs';
import vm from 'node:vm';

function deferred() { let resolve; const promise = new Promise(r => resolve = r); return {promise, resolve}; }
async function settle() { for (let i = 0; i < 16; i++) await Promise.resolve(); }
function harness(start, getMedia = async()=>({getTracks:()=>[{stop(){}}]}), initialSaved = null, initialDiagnostics = null) {
  const elements = new Map(), calls = [], timers = new Map(), intervals = new Map(); let serial = 0;
  const element = id => { if (!elements.has(id)) elements.set(id, {textContent:'', className:'', hidden:false, disabled:false, style:{}, handlers:{}, addEventListener(name,fn){this.handlers[name]=fn;}}); return elements.get(id); };
  const store = new Map();
  if (initialSaved) store.set('commute-'+new Date().toISOString().slice(0,10),JSON.stringify(initialSaved));
  if (initialDiagnostics) store.set('commute-diagnostics',JSON.stringify(initialDiagnostics));
  const context = vm.createContext({
    console, Date, Math, JSON, String, Float32Array, Promise,
    document: {getElementById:element, visibilityState:'visible', addEventListener(){},createElement:()=>({click(){}})},
    navigator: {onLine:true,wakeLock:{request:async()=>({release:async()=>{}})},mediaDevices:{getUserMedia:getMedia}},
    localStorage: {getItem:k=>store.get(k),setItem:(k,v)=>store.set(k,v)},
    performance:{now:()=>1000},
    setInterval:(fn,ms)=>{const id=++serial;intervals.set(id,{fn,ms});return id;},clearInterval:id=>intervals.delete(id),
    setTimeout:(fn,ms)=>{const id=++serial;timers.set(id,{fn,ms});return id;},clearTimeout:id=>timers.delete(id),
    requestAnimationFrame:()=>++serial,cancelAnimationFrame(){},
    Blob:class {},URL:{createObjectURL:()=>"blob:test",revokeObjectURL(){}},
    window:{speechSynthesis:{spoken:[],speak(u){this.spoken.push(u.text);},cancel(){}},SpeechSynthesisUtterance:class {constructor(text){this.text=text;}},AudioContext:class {state='running';createMediaStreamSource(){return {connect(){}};}createAnalyser(){return {fftSize:1024,getFloatTimeDomainData(a){a.fill(0);}};}async close(){}async resume(){}}},
    Conversation:{startSession:options=>{calls.push(options);return start(options,calls.length);}}
  });
  const html=fs.readFileSync(new URL('./index.html',import.meta.url),'utf8');
  const script=html.match(/<script type="module">([\s\S]*?)<\/script>/)[1].replace(/^\s*import .*;\s*$/m,'');
  vm.runInContext(script+`;globalThis.app={startDrive,endDrive,connect,state:()=>({driving,conv,connecting,generation,transcript:transcript.slice(),recentRequests:recentRequests.slice(),pendingTasks:pendingTasks.slice(),retryCount,automaticRecovery,diagnostics:diagnostics.slice()})};`,context);
  return {app:context.app,calls,elements,element,timers,intervals,window:context.window,store};
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
  assert.match(h.element('err').textContent,/reported a problem/);
  assert.match(h.app.state().diagnostics.find(x=>x.event==='sdk_error').reason,/tool unavailable/);
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

test('reconnect keeps the request but does not infer acknowledgment from agent wording',async()=>{
  const first=session(),second=session();const h=harness(async(o,n)=>{o.onConnect();return n===1?first:second;});
  await h.app.startDrive();
  h.calls[0].onMessage({source:'user',message:'Please retrieve the original submitted manuscript.'});
  h.calls[0].onMessage({source:'agent',message:'I accepted it and sent it.'});
  await h.element('recover').handlers.click();await settle();
  const vars=h.calls[1].dynamicVariables;
  assert.match(vars.recent_context,/Moshe: Please retrieve the original submitted manuscript\./);
  assert.match(vars.recent_context,/You: I accepted it and sent it\./);
  assert.match(vars.recent_context,/completion is unknown/);
  assert.match(vars.recent_context,/Please retrieve the original submitted manuscript\./);
  assert.match(vars.recent_context,/Structured server tool results: none/);
  assert.equal(h.app.state().pendingTasks.length,0);
});

test('structured tool response is the only durable completion evidence',async()=>{
  const first=session(),second=session();const h=harness(async(o,n)=>{o.onConnect();return n===1?first:second;});
  await h.app.startDrive();h.calls[0].onMessage({role:'user',message:'Send the report.'});
  h.calls[0].onAgentToolResponse({tool_call_id:'call-1',tool_name:'dispatch_task',is_called:true,is_error:false});
  await h.element('recover').handlers.click();await settle();
  assert.match(h.calls[1].dynamicVariables.recent_context,/tool=dispatch_task; state=dispatch webhook succeeded; worker completion unknown/);
  assert.equal(h.app.state().pendingTasks[0].request,'Send the report.');
});

test('backend error disconnect retries twice with backoff then stops',async()=>{
  const h=harness(async o=>{o.onConnect();return session();});await h.app.startDrive();
  h.calls[0].onDisconnect({reason:'error',message:'LLM cascade failed at https://secret.invalid/?token=abc'});await settle();
  let retry=[...h.timers.values()].find(t=>t.ms===1500);assert.ok(retry);retry.fn();await settle();
  h.calls[1].onDisconnect({reason:'error',message:'again'});await settle();retry=[...h.timers.values()].find(t=>t.ms===5000);assert.ok(retry);retry.fn();await settle();
  h.calls[2].onDisconnect({reason:'error',message:'third'});await settle();
  assert.equal(h.calls.length,3);assert.equal([...h.timers.values()].filter(t=>t.ms===1500||t.ms===5000).length,0);
  assert.match(h.element('status').textContent,/Service unavailable/);assert.equal(h.window.speechSynthesis.spoken.length,1);
  assert.doesNotMatch(h.app.state().diagnostics.find(x=>x.event==='disconnected').reason,/secret|token=abc/);
});

test('retry budget resets only after a substantive agent response',async()=>{
  const h=harness(async o=>{o.onConnect();return session();});await h.app.startDrive();
  h.calls[0].onDisconnect({reason:'error',message:'one'});let retry=[...h.timers.values()].find(t=>t.ms===1500);retry.fn();await settle();
  assert.equal(h.app.state().retryCount,1,'connect itself does not reset the budget');
  h.calls[1].onMessage({role:'user',message:'Are you back?'});
  h.calls[1].onMessage({role:'agent',message:'Recovered and ready.'});assert.equal(h.app.state().retryCount,0);
  h.calls[1].onDisconnect({reason:'error',message:'later'});retry=[...h.timers.values()].find(t=>t.ms===1500);assert.ok(retry);
});

test('static greeting after reconnect cannot create an unlimited retry loop',async()=>{
  const h=harness(async o=>{o.onConnect();o.onMessage({role:'agent',message:"I'm here."});return session();});await h.app.startDrive();
  for (const delay of [1500,5000]) { h.calls.at(-1).onDisconnect({reason:'error',message:'backend'});const retry=[...h.timers.values()].find(t=>t.ms===delay);assert.ok(retry);retry.fn();await settle(); }
  h.calls.at(-1).onDisconnect({reason:'error',message:'still down'});await settle();
  assert.equal(h.calls.length,3);assert.equal(h.app.state().retryCount,2);assert.match(h.element('status').textContent,/Service unavailable/);
});

test('read and log tool responses are not recorded as research dispatches',async()=>{
  const h=harness(async o=>{o.onConnect();return session();});await h.app.startDrive();
  h.calls[0].onMessage({role:'user',message:'Read the briefing.'});
  h.calls[0].onAgentToolResponse({tool_call_id:'read-1',tool_name:'read_context',is_called:true,is_error:false});
  h.calls[0].onAgentToolResponse({tool_call_id:'log-1',tool_name:'log_conversation',is_called:true,is_error:false});
  assert.equal(h.app.state().pendingTasks.length,0);
});

test('legacy inferred acknowledgments migrate without claiming completion',()=>{
  const h=harness(async()=>session(),undefined,{pendingTasks:[{request:'Old request',summary:'sending it',acceptedAt:12345}]});
  assert.equal(h.app.state().pendingTasks.length,1);assert.match(h.app.state().pendingTasks[0].state,/legacy acknowledgment only; worker completion unknown/);
  assert.equal(h.app.state().pendingTasks[0].updatedAt,12345);
});

test('automatic recovery never starts idle VAD that could bypass the retry limit',async()=>{
  let gum=0;const h=harness(async o=>{o.onConnect();return session();},async()=>{gum++;return {getTracks:()=>[{stop(){}}]};});await h.app.startDrive();
  for (const delay of [1500,5000]) { h.calls.at(-1).onDisconnect({reason:'error',message:'backend'});assert.equal(gum,0);const retry=[...h.timers.values()].find(t=>t.ms===delay);retry.fn();await settle(); }
  h.calls.at(-1).onDisconnect({reason:'error',message:'still down'});await settle();
  assert.equal(gum,0);assert.equal(h.app.state().automaticRecovery,false);assert.match(h.element('status').textContent,/Tap reconnect/);
});

test('diagnostics correlate session id and sanitize failure metadata',async()=>{
  const s={...session(),getId:()=>"conv-safe-id"};const h=harness(async o=>{o.onConnect({conversationId:'conv-safe-id'});return s;});await h.app.startDrive();
  h.calls[0].onDisconnect({reason:'error',message:'failed https://private.invalid/?token=secret',closeCode:1011});await settle();
  const item=h.app.state().diagnostics.find(x=>x.event==='disconnected');
  assert.equal(item.conversationId,'conv-safe-id');assert.equal(item.code,1011);assert.equal(item.errorClass,'error');
  assert.match(item.timestampUtc,/Z$/);assert.equal(item.appBuild,'2026-09-15.1');assert.equal(item.online,true);assert.equal(item.visibility,'visible');
  assert.doesNotMatch(JSON.stringify(item),/private\.invalid|secret/);
});

test('diagnostic ledger persists separately and remains bounded to 200 events',()=>{
  const old=Array.from({length:205},(_,i)=>({timestampUtc:'old-'+i,appBuild:'old',event:'old'}));
  const h=harness(async()=>session(),undefined,null,old);
  assert.equal(h.app.state().diagnostics.length,200);assert.equal(h.app.state().diagnostics[0].timestampUtc,'old-5');
  assert.equal(JSON.parse(h.store.get('commute-diagnostics')).length,200);
});

test('tool diagnostics retain identifiers and status without arguments or results',async()=>{
  const h=harness(async o=>{o.onConnect({conversationId:'conv-tools'});return session();});await h.app.startDrive();
  h.calls[0].onAgentToolResponse({tool_call_id:'tool-7',tool_name:'read_context',is_called:true,is_error:false,parameters:{secret:'no'},full_tool_result:'private result'});
  const item=h.app.state().diagnostics.find(x=>x.event==='tool_response');assert.equal(item.toolCallId,'tool-7');assert.equal(item.toolName,'read_context');assert.equal(item.toolStatus,'called');
  assert.equal('parameters' in item,false);assert.equal('full_tool_result' in item,false);
});

test('diagnostic export is available only while parked',async()=>{
  const h=harness(async o=>{o.onConnect();return session();});assert.equal(h.element('exportDiagnostics').hidden,false);
  await h.app.startDrive();assert.equal(h.element('exportDiagnostics').hidden,true);
  await h.app.endDrive();assert.equal(h.element('exportDiagnostics').hidden,false);
});

test('normal agent end does not auto-reconnect and ending cancels a pending retry',async()=>{
  const h=harness(async o=>{o.onConnect();return session();});await h.app.startDrive();
  h.calls[0].onDisconnect({reason:'agent'});await settle();assert.equal([...h.timers.values()].filter(t=>t.ms===1500).length,0);
  await h.app.connect();h.calls[1].onDisconnect({reason:'error',message:'down'});assert.ok([...h.timers.values()].some(t=>t.ms===1500));
  await h.app.endDrive();assert.equal([...h.timers.values()].filter(t=>t.ms===1500||t.ms===5000).length,0);
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
