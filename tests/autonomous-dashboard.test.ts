import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { createContext, runInContext } from 'node:vm';

// A small DOM surface runs the shipped browser script and its real event handlers.
class Element {
  children: Element[] = [];
  dataset: Record<string, string> = {};
  style: Record<string, string> = {};
  listeners = new Map<string, (event: any) => unknown>();
  parent: Element | null = null;
  hidden = false;
  disabled = false;
  className = '';
  type = '';
  private text = '';
  private currentValue = '';
  constructor(readonly tagName: string, readonly id = '') {}
  set innerHTML(_value: string) { throw new Error('Untrusted HTML must not be inserted'); }
  set textContent(value: string) { this.text = String(value); this.children = []; }
  get textContent(): string { return this.text + this.children.map(child => child.textContent).join(''); }
  set value(value: string) { this.currentValue = value; }
  get value(): string { return this.currentValue || (this.tagName === 'select' ? this.children[0]?.value || '' : ''); }
  get firstChild() { return this.children[0]!; }
  get lastChild() { return this.children.at(-1)!; }
  append(...elements: Element[]) { for (const element of elements) { element.parent = this; this.children.push(element); } }
  replaceChildren(...elements: Element[]) { this.children = []; this.text = ''; this.append(...elements); }
  remove() { if (this.parent) this.parent.children = this.parent.children.filter(child => child !== this); }
  setAttribute(_name: string, _value: string) {}
  focus() {}
  reset() {}
  addEventListener(name: string, listener: (event: any) => unknown) { this.listeners.set(name, listener); }
  querySelectorAll(selector: string): Element[] {
    return this.children.flatMap(child => [
      ...(selector === 'button' ? child.tagName === 'button' : child.className.split(' ').includes(selector.slice(1))) ? [child] : [],
      ...child.querySelectorAll(selector)
    ]);
  }
  async dispatch(name: string, extra: Record<string, unknown> = {}) {
    await this.listeners.get(name)?.({ preventDefault() {}, ...extra });
  }
}

const spec={goal:'<img src=x onerror=alert(1)>',provider:'claude',model:'fixture-model-only',endsAt:1900000000000,budgetMicros:500,tools:['Bash','WebFetch'],web:{allowedHosts:['example.com']},systems:[],credentialIds:['subscription-ref'],externalProfiles:[],maxRunMs:10000,maxIterations:2};
const draft=()=>({id:'autonomous-1',spec:structuredClone(spec),revision:3,status:'awaiting_approval',spentMicros:0,reservedMicros:100,iteration:0,runs:[],actions:[],resources:[],interventions:[]});
async function operatorDashboard(){
  const [html,script]=await Promise.all(['index.html','app.js'].map(name=>readFile(new URL('../apps/dashboard/public/'+name,import.meta.url).pathname.replace('/dist/','/'),'utf8')));
  const elements=new Map<string,Element>();for(const match of html!.matchAll(/<(\w+)[^>]*\bid="([^"]+)"/g))elements.set(match[2]!,new Element(match[1]!,match[2]!));
  const get=(id:string)=>{const e=elements.get(id);assert.ok(e,id);return e;};get('operator-token').value='OPERATOR_CANARY';get('task-provider').append(Object.assign(new Element('option'),{value:'mock'}));get('task-runtime').append(Object.assign(new Element('option'),{value:'local'}));
  const calls:{path:string;body:any}[]=[];let current:any=draft(),unavailable=false,profiles:any={profiles:[]},approvalConflict:any=null,externalActions:any[]=[];const intervals:(()=>unknown)[]=[];
  const context=createContext({document:{getElementById:get,createElement:(tag:string)=>new Element(tag),addEventListener(){},hidden:false},AbortSignal,setInterval:(fn:()=>unknown)=>{intervals.push(fn);},fetch:async(path:string,options:any)=>{
    calls.push({path,body:options.body?JSON.parse(options.body):undefined});
    if(path.startsWith('/api/cloudflare/autonomous-tasks')){
      if(unavailable)return {ok:false,status:503,json:async()=>({error:'OPERATOR_CANARY'})};
      if(options.body&&path.endsWith('/approve')&&approvalConflict){profiles=approvalConflict;approvalConflict=null;return {ok:false,status:409,json:async()=>({error:'OPERATOR_CANARY'})};}
      if(path.endsWith('/external-profiles'))return {ok:true,json:async()=>profiles};
      if(path.includes('/external-actions?'))return {ok:true,json:async()=>({items:externalActions,nextCursor:'more-actions'})};
      if(path.includes('/history?'))return {ok:true,json:async()=>({items:current.runs,nextCursor:'next-runs'})};
      if(path.endsWith('?view=summary')){const {runs:_r,actions:_a,resources:_s,interventions:_i,...summary}=current;return {ok:true,json:async()=>summary};}
      return {ok:true,json:async()=>path.includes('?limit=')?{items:[current],nextCursor:'next-page'}:path.endsWith('/external-actions')?[]:current};
    }
    return {ok:true,json:async()=>path==='/api/state'?{tasks:[],workers:[],events:[]}:{providers:['mock'],repository:null}};
  }});runInContext(script!,context);await new Promise(r=>setImmediate(r));
  return {get,calls,run:(text:string)=>runInContext(text,context),refresh:async()=>{await runInContext('refreshAutonomous()',context);},select:async()=>{await runInContext("selectAutonomousTask('autonomous-1')",context);},setTask:(t:any)=>{current=t;},setProfiles:(v:any)=>{profiles=v;},setExternalActions:(v:any[])=>{externalActions=v;},rejectApproval:(v:any)=>{approvalConflict=v;},unavailable:()=>{unavailable=true;},poll:async()=>{for(const fn of intervals)fn();await new Promise(r=>setImmediate(r));}};
}
test('shipped dashboard renders review scopes and preserves list buttons while polling',async()=>{
  const ui=await operatorDashboard();assert.ok(ui.get('autonomous-list').textContent.includes('<img'));const button=ui.get('autonomous-list').querySelectorAll('button')[0];await ui.refresh();assert.equal(ui.get('autonomous-list').querySelectorAll('button')[0],button);
  await ui.select();assert.match(ui.get('autonomous-model').textContent,/fixture-model-only/);assert.match(ui.get('autonomous-tools').textContent,/Bash/);assert.match(ui.get('autonomous-web').textContent,/example.com/);assert.match(ui.get('autonomous-credentials').textContent,/subscription-ref/);assert.equal(ui.get('autonomous-goal').textContent,spec.goal);assert.ok(!ui.calls.some(c=>c.path.endsWith('/approve')));
});
test('only explicit submit with reason approves the reviewed current revision',async()=>{
  const ui=await operatorDashboard();await ui.select();await ui.get('autonomous-decision-form').dispatch('submit',{submitter:{value:'approve'}});assert.ok(!ui.calls.some(c=>c.path.endsWith('/approve')));
  ui.get('autonomous-reason').value='User reviewed revision 3';await ui.get('autonomous-decision-form').dispatch('submit',{submitter:{value:'approve'}});
  assert.deepEqual(ui.calls.find(c=>c.path.endsWith('/approve'))?.body,{revision:3,reason:'User reviewed revision 3'});
});
test('revision change clears old approval reason and submit rechecks canonical revision',async()=>{
  const ui=await operatorDashboard();await ui.select();ui.get('autonomous-reason').value='old review';ui.setTask({...draft(),revision:4});await ui.get('autonomous-decision-form').dispatch('submit',{submitter:{value:'approve'}});
  assert.ok(!ui.calls.some(c=>c.path.endsWith('/approve')));assert.equal(ui.get('autonomous-reason').value,'');assert.match(ui.get('autonomous-error').textContent,/revision|다시/);
});
test('unknown model cost and quota usage placeholders are not displayed as measured zero',async()=>{
  const ui=await operatorDashboard();ui.setTask({...draft(),runs:[{costMicros:null,usageUnavailable:true,usage:{inputTokens:0,outputTokens:0}}]});await ui.select();assert.match(ui.get('autonomous-model-cost').textContent,/미확정/);assert.match(ui.get('autonomous-usage').textContent,/미측정/);assert.ok(!ui.get('autonomous-usage').textContent.includes('입력 0'));
});
test('503 is isolated from old task form and never falls back to local autonomous API',async()=>{
  const ui=await operatorDashboard();ui.unavailable();await ui.refresh();assert.match(ui.get('autonomous-error').textContent,/연결|사용/);assert.ok(!ui.get('autonomous-error').textContent.includes('OPERATOR_CANARY'));assert.equal(ui.get('create-submit').disabled,false);assert.ok(!ui.calls.some(c=>c.path.startsWith('/v1/')));
});
test('all external references remain visible while unavailable target metadata blocks approval',async()=>{
  const ui=await operatorDashboard(),current=draft();current.spec.externalProfiles=['aws-ref','hf-ref','gh-ref'] as never;ui.setTask(current);await ui.select();for(const ref of current.spec.externalProfiles)assert.ok(ui.get('autonomous-profiles').textContent.includes(ref));assert.match(ui.get('autonomous-profiles').textContent,/미확인|미제공/);assert.equal(ui.get('autonomous-approve').disabled,true);
});
test('polling preserves typed reason and pagination uses server cursor only',async()=>{
  const ui=await operatorDashboard();await ui.select();ui.get('autonomous-reason').value='still reviewing';await ui.poll();assert.equal(ui.get('autonomous-reason').value,'still reviewing');await ui.get('autonomous-next').dispatch('click');assert.ok(ui.calls.some(c=>c.path.includes('cursor=next-page')));assert.ok(!ui.calls.some(c=>c.body));
});

test('all configured profile targets and ceilings render before explicit approval',async()=>{
  const ui=await operatorDashboard(),current=draft();current.spec.externalProfiles=['aws-ref','hf-ref','gh-ref'] as never;ui.setTask(current);
  ui.setProfiles({profiles:[{id:'aws-ref',profileHash:'a'.repeat(64),provider:'aws',enabled:true,target:{accountId:'123456789012',region:'ap-northeast-2',workloadId:'fixed'},upperBoundMicros:100,operations:['aws.spot.start']},{id:'hf-ref',profileHash:'b'.repeat(64),provider:'hf',enabled:true,target:{repository:'owner/model',revision:'main'},upperBoundMicros:100,operations:['hf.model.commit']},{id:'gh-ref',profileHash:'c'.repeat(64),provider:'github',enabled:true,target:{repository:'owner/repo',branch:'hivemind/task'},upperBoundMicros:100,operations:['github.branch.push']}]});
  await ui.select();assert.match(ui.get('autonomous-profiles').textContent,/owner\/model/);assert.match(ui.get('autonomous-profiles').textContent,/owner\/repo/);assert.match(ui.get('autonomous-profiles').textContent,/123456789012/);assert.equal(ui.get('autonomous-approve').disabled,false);
  ui.get('autonomous-reason').value='Reviewed all three fixed targets';await ui.get('autonomous-decision-form').dispatch('submit',{submitter:{value:'approve'}});assert.deepEqual(ui.calls.find(c=>c.path.endsWith('/approve'))?.body.externalProfileHashes,{'aws-ref':'a'.repeat(64),'hf-ref':'b'.repeat(64),'gh-ref':'c'.repeat(64)});
});

test('profile hash change after review requires another explicit click and reason',async()=>{
  const ui=await operatorDashboard(),current=draft();current.spec.externalProfiles=['aws-ref'] as never;ui.setTask(current);
  const metadata=(hash:string)=>({profiles:[{id:'aws-ref',profileHash:hash,provider:'aws',enabled:true,target:{accountId:'123456789012',region:'ap-northeast-2',workloadId:'fixed'},upperBoundMicros:100,operations:['aws.spot.start']}]});
  ui.setProfiles(metadata('a'.repeat(64)));await ui.select();ui.get('autonomous-reason').value='reviewed first target';ui.setProfiles(metadata('b'.repeat(64)));
  await ui.get('autonomous-decision-form').dispatch('submit',{submitter:{value:'approve'}});assert.ok(!ui.calls.some(c=>c.path.endsWith('/approve')));assert.equal(ui.get('autonomous-reason').value,'');assert.ok(ui.get('autonomous-profiles').textContent.includes('b'.repeat(64)));
});

test('accepted action is never described as a confirmed zero charge',async()=>{
  const ui=await operatorDashboard();ui.setTask({...draft(),counts:{acceptedActions:1},actions:[{id:'accepted',status:'accepted',actualCostMicros:0}]});await ui.select();assert.match(ui.get('autonomous-spent').textContent,/미확정/);
});

test('selected review reads summary plus a bounded runs page and never a full task',async()=>{
  const ui=await operatorDashboard();await ui.select();assert.ok(ui.calls.some(c=>c.path.endsWith('?view=summary')));assert.ok(ui.calls.some(c=>c.path.endsWith('/history?kind=runs&limit=20')));assert.ok(!ui.calls.some(c=>c.path==='/api/cloudflare/autonomous-tasks/autonomous-1'));
});

test('409 approval refreshes changed target without automatically posting again',async()=>{
  const ui=await operatorDashboard(),current=draft();current.spec.externalProfiles=['aws-ref'] as never;ui.setTask(current);
  const metadata=(hash:string)=>({profiles:[{id:'aws-ref',profileHash:hash,provider:'aws',enabled:true,target:{accountId:'123456789012',region:'ap-northeast-2',workloadId:'fixed'},upperBoundMicros:100,operations:['aws.spot.start']}]});
  ui.setProfiles(metadata('a'.repeat(64)));await ui.select();ui.get('autonomous-reason').value='reviewed first target';ui.rejectApproval(metadata('b'.repeat(64)));
  await ui.get('autonomous-decision-form').dispatch('submit',{submitter:{value:'approve'}});assert.equal(ui.calls.filter(c=>c.path.endsWith('/approve')).length,1);assert.equal(ui.get('autonomous-reason').value,'');assert.ok(ui.get('autonomous-profiles').textContent.includes('b'.repeat(64)));
});

test('late-owned external resource ID remains visible with empty main history as bounded text only',async()=>{
  const ui=await operatorDashboard();ui.setExternalActions([{resourceId:'i-1234abcd<img src=x>',cleanupStatus:'pending',ownershipToken:'NEVER_OWNERSHIP',idempotencyKey:'NEVER_IDEMPOTENCY',credential:'NEVER_CREDENTIAL'}]);await ui.select();
  const text=ui.get('autonomous-cleanup').textContent;assert.match(text,/i-1234abcd<img src=x>/);assert.match(text,/현재 페이지/);assert.match(text,/다음 페이지/);assert.ok(!text.includes('NEVER_'));
  assert.ok(ui.calls.some(c=>c.path.endsWith('/external-actions?limit=20')));assert.ok(!ui.calls.some(c=>c.body));
  ui.setExternalActions([{resourceId:'i-'+'a'.repeat(1000),cleanupStatus:'pending'}]);await ui.select();assert.ok(!ui.get('autonomous-cleanup').textContent.includes('a'.repeat(257)));
});

test('read-only invoice audit shows immutable external revision and operator source rather than current revision/provider measurement',async()=>{
  const ui=await operatorDashboard();ui.setExternalActions([{requestId:'reused-request',revision:1,resourceId:'i-1234abcd',cleanupStatus:'cleaned',billingSource:'operator_attested',evidenceRef:'invoice-fixture',attestedAt:1800000000000,verifiedCostMicros:375}]);await ui.select();
  const text=ui.get('autonomous-cleanup').textContent;assert.match(text,/revision 1/);assert.match(text,/운영자/);assert.match(text,/provider API 측정 아님/);assert.match(text,/invoice-fixture/);assert.ok(!ui.calls.some(c=>c.path.endsWith('/billing')));
  ui.setExternalActions([{resourceId:'i-abcd1234',cleanupStatus:'pending'}]);await ui.select();assert.match(ui.get('autonomous-cleanup').textContent,/revision 미보고/);
});

test('action audit shows approval-time target even without resourceId and never swaps in current registry target',async()=>{
  const ui=await operatorDashboard(),current=draft();current.spec.externalProfiles=['reused-profile'] as never;ui.setTask(current);ui.setProfiles({profiles:[{id:'reused-profile',provider:'hf',enabled:true,profileHash:'b'.repeat(64),target:{repository:'owner/current',revision:'main'},upperBoundMicros:100,operations:['hf.model.commit']}]});
  ui.setExternalActions([{requestId:'old-action',revision:1,profileId:'reused-profile',approvedTarget:{repository:'owner/old',revision:'old-revision',credential:'NEVER_CREDENTIAL'},approvedProfileHash:'a'.repeat(64)}]);await ui.select();
  const audit=ui.get('autonomous-cleanup').textContent;assert.match(audit,/승인 당시 대상/);assert.match(audit,/owner\/old/);assert.ok(audit.includes('a'.repeat(64)));assert.ok(!audit.includes('owner/current'));assert.ok(!audit.includes('NEVER_'));assert.match(ui.get('autonomous-profiles').textContent,/owner\/current/);assert.ok(!ui.calls.some(c=>c.body));
  ui.setExternalActions([{requestId:'missing-proof',revision:2,profileId:'reused-profile'}]);await ui.select();assert.match(ui.get('autonomous-cleanup').textContent,/승인 당시 대상 미보고/);assert.ok(!ui.get('autonomous-cleanup').textContent.includes('owner/current'));
});

test('R9 dashboard shows exact published artifact and commit as text without provider authority or arbitrary message',async()=>{
  const ui=await operatorDashboard();ui.setExternalActions([{requestId:'published',revision:1,parameterHash:'a'.repeat(64),parameters:{artifactDigest:'b'.repeat(64),expectedHead:'c'.repeat(40),message:'NEVER_MESSAGE'},providerResult:{kind:'hf_commit',oid:'d'.repeat(64),credential:'NEVER_CREDENTIAL'}}]);await ui.select();const text=ui.get('autonomous-cleanup').textContent;
  for(const value of ['a'.repeat(64),'b'.repeat(64),'c'.repeat(40),'d'.repeat(64),'hf_commit'])assert.ok(text.includes(value));assert.ok(!text.includes('NEVER_'));assert.ok(!ui.calls.some(c=>c.body));
  ui.setExternalActions([{requestId:'invalid',parameterHash:'bad',parametersSubset:{artifactDigest:'NEVER_DIGEST'},providerResult:{kind:'aws_instance',id:'NEVER_ID'}}]);await ui.select();assert.ok(!ui.get('autonomous-cleanup').textContent.includes('NEVER_'));
});

