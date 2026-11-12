import './fixtures/electron-stub.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

let Database;
try { Database = (await import('better-sqlite3')).default; new Database(':memory:').close(); } catch { Database = undefined; }
async function setup(t) {
  if (!Database) { t.skip('Run with scripts/run-electron-node-test.mjs for the native SQLite binding'); return; }
  const db = new Database(':memory:'); db.pragma('foreign_keys = ON');
  const database = await import('../dist-electron/cli/db.js'); database.migrate(db); database.setDbForTest(db);
  const conversations = await import('../dist-electron/cli/conversations.js');
  const queue = await import('../dist-electron/cli/messageQueue.js'); queue.resetMessageQueueLeasesForTests();
  const {runAsCaller} = await import('../dist-electron/cli/callerContext.js');
  const as = (user,fn) => runAsCaller(user,fn);
  const create = (id='chat',user='alice',kind='default') => as(user,()=>conversations.createConversation({id,title:id,agentId:'agent',agentName:'Agent',adapter:'codex-acp',kind}));
  const change = command => as('alice',()=>queue.changeMessageQueue({conversationId:'chat',...command},1));
  const enqueue = (id,extra={}) => change({action:'enqueue',entry:{id,prompt:id,attachments:[],...extra}});
  const claim = (sessionId,queueId,windowId=1) => as('alice',()=>queue.claimConversationSend({conversationId:'chat',sessionId,queueId},windowId));
  const snapshot = () => as('alice',()=>queue.getMessageQueue('chat'));
  const persist = (entry,sessionId) => as('alice',()=>{
    conversations.appendMessage({id:entry.userMessageId,conversationId:'chat',role:'user',status:'sent',content:entry.prompt,attachments:entry.attachments});
    conversations.appendMessage({id:entry.assistantMessageId,conversationId:'chat',role:'assistant',status:'running',content:'[]',taskId:sessionId});
  });
  const complete = (sessionId,exitCode=0) => {
    queue.conversationSendEvent('chat',sessionId,{type:'done',exitCode});
    let message=db.prepare("SELECT id FROM conversation_messages WHERE task_id = ? AND role = 'assistant'").get(sessionId);
    if(!message){message={id:`terminal-${sessionId}`};as('alice',()=>conversations.appendMessage({id:message.id,conversationId:'chat',role:'assistant',status:'running',content:'[]',taskId:sessionId}));}
    conversations.updateMessage({id:message.id,status:exitCode===0?'done':'failed'});
    queue.acknowledgeConversationSend(message.id);
  };
  const accept = (sessionId,windowId=1) => as('alice',()=>queue.acceptConversationSend({conversationId:'chat',sessionId},windowId));
  create();
  t.after(()=>{queue.resetMessageQueueLeasesForTests();database.setDbForTest(null);db.close();});
  return {db,database,conversations,queue,as,create,change,enqueue,claim,snapshot,persist,accept,complete};
}

test('outbox persists ordered snapshots without adding unsent messages to the transcript',async t=>{
  const c=await setup(t);if(!c)return;
  const skills=[{id:'skill',name:'Review',description:'Review code',version:'1',source:'builtin',rootPath:'/skills/review',contentHash:'hash'}];
  c.enqueue('one',{messageSkills:skills,approvalMode:'ask',configOptionOverrides:{model:'model-a'}}); c.enqueue('two');
  const q=c.snapshot();assert.deepEqual(q.entries.map(e=>e.id),['one','two']);
  assert.deepEqual(q.entries[0].messageSkills,skills);assert.equal(q.entries[0].approvalMode,'ask');assert.equal(q.entries[0].configOptionOverrides.model,'model-a');
  assert.equal(c.db.prepare('SELECT COUNT(*) n FROM conversation_messages').get().n,0);
  const repeated=c.enqueue('one',{messageSkills:skills,approvalMode:'ask',configOptionOverrides:{model:'model-a'}});
  assert.equal(repeated.entries[0].userMessageId,q.entries[0].userMessageId);assert.equal(repeated.entries.length,2);
  assert.throws(()=>c.enqueue('one',{prompt:'different'}),/id_conflict/);
});

test('manual, scheduled and queue sends share the same authoritative claim',async t=>{
  const c=await setup(t);if(!c)return;
  assert.equal(c.claim('manual'),true);c.accept('manual');c.enqueue('one');c.enqueue('two');
  assert.equal(c.claim('scheduled'),false);assert.equal(c.claim('queue','one',2),false);
  c.complete('manual');
  assert.equal(c.claim('queue','one',1),true);assert.equal(c.claim('other','one',2),false);
  assert.throws(()=>c.accept('queue'),/not_persisted/);
  c.persist(c.snapshot().entries[0],'queue');c.accept('queue');
  assert.deepEqual(c.snapshot().entries.map(e=>e.id),['two']);
  assert.equal(c.claim('scheduled'),false);
  c.complete('queue');
  assert.equal(c.claim('next','two'),true);
});

test('stale completion cannot release a newer run, and terminal errors pause even with exit zero',async t=>{
  const c=await setup(t);if(!c)return;
  c.claim('first');c.accept('first');c.enqueue('queued');
  c.queue.conversationSendEvent('chat','stale',{type:'done',exitCode:0});assert.equal(c.snapshot().busy,true);
  c.queue.conversationSendEvent('chat','first',{type:'error',message:'connection lost'});
  c.complete('first');
  assert.equal(c.snapshot().paused,true);assert.equal(c.claim('next','queued'),false);
  c.change({action:'resume'});assert.equal(c.claim('next','queued'),true);
  c.queue.conversationSendEvent('chat','first',{type:'done',exitCode:0});assert.equal(c.snapshot().busy,true);
});

test('stopping during preparation prevents delayed launch and retains the queued item',async t=>{
  const c=await setup(t);if(!c)return;
  c.enqueue('one');assert.equal(c.claim('preparing','one'),true);
  c.queue.cancelConversationSend('preparing');
  assert.throws(()=>c.accept('preparing'),/not_claimed/);assert.equal(c.snapshot().paused,true);
  c.queue.releaseConversationSend({conversationId:'chat',sessionId:'preparing'},1);
  assert.equal(c.snapshot().entries[0].sending,false);assert.equal(c.snapshot().entries.length,1);
});

test('editing holds dispatch across windows, preserves order and uses an exclusive edit lease',async t=>{
  const c=await setup(t);if(!c)return;
  c.enqueue('one');c.enqueue('two');
  const original=c.snapshot().entries.map(e=>e.userMessageId);
  c.change({action:'edit',id:'two',token:'editor'});assert.equal(c.claim('dispatch','one'),false);
  assert.throws(()=>c.as('alice',()=>c.queue.changeMessageQueue({conversationId:'chat',action:'edit',id:'two',token:'other'},2)),/editing/);
  assert.throws(()=>c.change({action:'remove',id:'one'}),/editing/);
  c.change({action:'save',id:'two',token:'editor',prompt:'updated second'});
  const q=c.snapshot();assert.deepEqual(q.entries.map(e=>e.userMessageId),original);assert.equal(q.entries[1].prompt,'updated second');
  assert.equal(c.claim('dispatch','one'),true);
});

test('restart pauses persisted entries, clears claims, and enqueue receipts survive dispatch',async t=>{
  const c=await setup(t);if(!c)return;
  c.enqueue('one');c.claim('preparing','one');
  const before=c.snapshot().entries[0];
  c.database.recoverMessageQueues(c.db);c.queue.resetMessageQueueLeasesForTests();
  let q=c.snapshot();assert.equal(q.paused,true);assert.equal(q.reason,'restart');assert.equal(q.entries[0].sending,false);assert.equal(q.entries[0].userMessageId,before.userMessageId);
  c.change({action:'resume'});c.claim('dispatch','one');c.persist(q.entries[0],'dispatch');c.accept('dispatch');
  c.complete('dispatch');
  assert.equal(c.enqueue('one').entries.length,0,'lost-response retries cannot re-enqueue already accepted work');
});

test('queue data and mutation are scoped to the conversation owner',async t=>{
  const c=await setup(t);if(!c)return;
  c.enqueue('private');c.create('bob-chat','bob');
  c.as('bob',()=>c.queue.changeMessageQueue({conversationId:'bob-chat',action:'enqueue',entry:{id:'bob-item',prompt:'bob',attachments:[]}},2));
  assert.throws(()=>c.as('bob',()=>c.queue.getMessageQueue('chat')),/not_found/);
  assert.throws(()=>c.as('bob',()=>c.queue.changeMessageQueue({conversationId:'chat',action:'resume'},2)),/not_found/);
  assert.throws(()=>c.as('bob',()=>c.queue.claimConversationSend({conversationId:'chat',sessionId:'intruder'},2)),/not_found/);
  assert.deepEqual(c.as('bob',()=>c.queue.listMessageQueues()).map(q=>q.conversationId),['bob-chat']);
});

test('an expired preparation lease pauses and releases the unsent item',async t=>{
  const c=await setup(t);if(!c)return;
  c.enqueue('one');c.claim('abandoned','one');const now=Date.now;
  try{Date.now=()=>now()+60_000;const q=c.snapshot();assert.equal(q.paused,true);assert.equal(q.reason,'interrupted');assert.equal(q.entries[0].sending,false);assert.equal(q.busy,false);}finally{Date.now=now;}
});

test('managed attachment references include queued items and are released on removal',async t=>{
  const c=await setup(t);if(!c)return;
  const root=fs.mkdtempSync(path.join(os.tmpdir(),'freebuddy-queue-'));
  globalThis.__freebuddyElectronGetPath=()=>root;
  const attachments=await import('../dist-electron/cli/attachments.js');
  const directory=attachments.getManagedAttachmentsDir();const file=path.join(directory,'pending.txt');fs.writeFileSync(file,'queued notes');
  try{
    c.enqueue('file',{attachments:[{id:'file',kind:'document',name:'pending.txt',path:file,managed:true}]});
    assert.equal(attachments.countManagedAttachmentReferences(file),1);
    assert.equal(attachments.discardManagedAttachmentIfUnreferenced(file),false);assert.equal(fs.existsSync(file),true);
    c.change({action:'remove',id:'file'});assert.equal(attachments.countManagedAttachmentReferences(file),0);assert.equal(fs.existsSync(file),false);
  }finally{delete globalThis.__freebuddyElectronGetPath;fs.rmSync(root,{recursive:true,force:true});}
});

test('archived or team conversations cannot enqueue and deleted conversations cascade outbox rows',async t=>{
  const c=await setup(t);if(!c)return;
  c.enqueue('one');c.create('team','alice','delegation');
  assert.throws(()=>c.change({conversationId:'team',action:'enqueue',entry:{id:'team-item',prompt:'team',attachments:[]}}),/unsupported/);
  c.conversations.archiveConversation('chat',true);assert.equal(c.claim('archived','one'),false);
  c.as('alice',()=>c.conversations.deleteConversation('chat'));
  assert.equal(c.db.prepare('SELECT COUNT(*) n FROM conversation_message_queue').get().n,0);
  assert.equal(c.db.prepare('SELECT COUNT(*) n FROM conversation_queue_receipts').get().n,0);
});

test('claims cannot reuse task ids or overwrite another session ownership binding',async t=>{
  const c=await setup(t);if(!c)return;
  c.create('other-chat','alice');assert.equal(c.claim('reserved'),true);
  assert.equal(c.as('alice',()=>c.queue.claimConversationSend({conversationId:'other-chat',sessionId:'reserved'},1)),false);
  c.db.prepare(`INSERT INTO cli_tasks(id,agent_id,agent_name,adapter,status,prompt,created_at,updated_at) VALUES ('persisted','agent','Agent','codex-acp','done','work','now','now')`).run();
  assert.equal(c.as('alice',()=>c.queue.claimConversationSend({conversationId:'other-chat',sessionId:'persisted'},1)),false);
  const owners=await import('../dist-electron/cli/sessionOwners.js');owners.recordSessionOwner('other-user-session','bob');
  try{assert.equal(c.as('alice',()=>c.queue.claimConversationSend({conversationId:'other-chat',sessionId:'other-user-session'},1)),false);assert.equal(owners.getSessionOwner('other-user-session'),'bob');}finally{owners.clearSessionOwner('other-user-session');}
});

test('dispatch errors persist in the queue and resume clears the error',async t=>{
  const c=await setup(t);if(!c)return;c.enqueue('one');
  c.change({action:'pause',error:'Reference conversation was deleted'});
  assert.equal(c.snapshot().paused,true);assert.equal(c.snapshot().reason,'failed');assert.equal(c.snapshot().error,'Reference conversation was deleted');
  c.change({action:'resume'});assert.equal(c.snapshot().paused,false);assert.equal(c.snapshot().error,undefined);
});

test('dispatch waits for persisted terminal output and respects renderer-parsed failures',async t=>{
  const c=await setup(t);if(!c)return;c.enqueue('one');c.claim('first','one');
  const first=c.snapshot().entries[0];c.persist(first,'first');c.accept('first');c.enqueue('two');
  c.queue.conversationSendEvent('chat','first',{type:'done',exitCode:0});
  assert.equal(c.snapshot().busy,true);assert.equal(c.claim('next','two'),false);
  c.queue.releaseConversationSend({conversationId:'chat',sessionId:'first'},1);assert.equal(c.snapshot().busy,true);
  c.conversations.updateMessage({id:first.assistantMessageId,status:'failed',content:'[{"kind":"error","terminal":true,"message":"parsed failure"}]'});
  c.queue.acknowledgeConversationSend(first.assistantMessageId);
  assert.equal(c.snapshot().busy,false);assert.equal(c.snapshot().paused,true);assert.equal(c.claim('next','two'),false);
});

test('an unacknowledged completed turn recovers its spinning placeholder and pauses pending prompts',async t=>{
  const c=await setup(t);if(!c)return;c.enqueue('one');c.claim('lost-renderer','one');
  const first=c.snapshot().entries[0];c.persist(first,'lost-renderer');c.accept('lost-renderer');c.enqueue('two');
  c.queue.conversationSendEvent('chat','lost-renderer',{type:'done',exitCode:0});
  const now=Date.now;
  try{Date.now=()=>now()+60_000;assert.equal(c.snapshot().paused,true);assert.equal(c.conversations.getMessage(first.assistantMessageId).status,'failed');assert.equal(c.snapshot().entries[0].id,'two');}finally{Date.now=now;}
});

test('actual IPC handlers acknowledge the outbox only after launch and release the lock after saving the answer',async t=>{
  const c=await setup(t);if(!c)return;
  const ts=(await import('typescript')).default;
  const source=ts.createSourceFile('ipc.ts',fs.readFileSync(new URL('../electron/cli/ipc.ts',import.meta.url),'utf8'),ts.ScriptTarget.Latest,true);
  const owners=await import('../dist-electron/cli/sessionOwners.js');
  let emit,finish;
  const win={webContents:{id:1}};
  const scope={...c.queue,
    requireOwnedConversation:c.conversations.requireOwnedConversation,
    senderWindow:()=>win, recordSessionOwner:owners.recordSessionOwner,clearSessionOwner:owners.clearSessionOwner,getCallerUserId:()=> 'alice',
    resolveWorkspaceRootsForConversation:()=>[],isolateRemoteCwdForCaller:async p=>p,
    listResolvedConversationContextPayloads:()=>[],BUTLERBUDDY_AGENT_ID:'butler',
    cliRun:(_contents,args,onEvent)=>{
      emit=onEvent;
      c.db.prepare(`INSERT INTO cli_tasks(id,agent_id,agent_name,adapter,status,prompt,created_at,updated_at) VALUES (?,'agent','Agent','codex-acp','running','work','now','now')`).run(args.sessionId);
      return new Promise(resolve=>{finish=()=>{c.db.prepare("UPDATE cli_tasks SET status = 'done' WHERE id = ?").run(args.sessionId);onEvent({type:'done',exitCode:0});owners.clearSessionOwner(args.sessionId);resolve();};});
    },
    callerCanAccessMessage:c.conversations.callerCanAccessMessage,updateMessage:c.conversations.updateMessage,
    safeSendToWebContents:()=>{},channelName:id=>id
  };
  async function handler(channel){
    let callback;
    function visit(node){if(ts.isCallExpression(node)&&node.expression.getText(source)==='registerHandler'&&ts.isStringLiteral(node.arguments[0])&&node.arguments[0].text===channel)callback=node.arguments[1];ts.forEachChild(node,visit);}
    visit(source);assert.ok(callback,`missing handler ${channel}`);
    const js=ts.transpileModule(`export default scope=>{const {${Object.keys(scope).join(',')}}=scope;return ${callback.getText(source)};}`,{compilerOptions:{module:ts.ModuleKind.ES2022,target:ts.ScriptTarget.ES2022}}).outputText;
    return(await import(`data:text/javascript;base64,${Buffer.from(js).toString('base64')}`)).default(scope);
  }
  const claimHandler=await handler('cli:claimConversationSend'),runHandler=await handler('cli:run'),updateHandler=await handler('cli:updateMessage');
  c.enqueue('first');c.enqueue('second');const first=c.snapshot().entries[0],event={sender:{id:1}};
  assert.equal(c.as('alice',()=>claimHandler(event,{conversationId:'chat',sessionId:'ipc-run',queueId:'first'})),true);
  c.persist(first,'ipc-run');
  const result=await c.as('alice',()=>runHandler(event,{conversationId:'chat',sessionId:'ipc-run',agentId:'agent',agentName:'Agent',adapter:'codex-acp',prompt:'first'}));
  assert.equal(result.sessionId,'ipc-run');assert.deepEqual(c.snapshot().entries.map(e=>e.id),['second']);
  emit({type:'items',items:[{kind:'text',role:'assistant',content:'finished answer'}]});finish();
  assert.equal(c.claim('next','second'),false,'output still needs to be persisted');
  c.as('alice',()=>updateHandler(event,{id:first.assistantMessageId,status:'done',content:'[{"kind":"text","role":"assistant","content":"finished answer"}]'}));
  assert.equal(c.claim('next','second'),true);
  assert.match(c.conversations.getMessage(first.assistantMessageId).content,/finished answer/);
});

test('resume waits for a cancelled preparation to release its claim',async t=>{
  const c=await setup(t);if(!c)return;c.enqueue('one');c.claim('cancelled','one');c.queue.cancelConversationSend('cancelled');
  assert.throws(()=>c.change({action:'resume'}),/waiting_for_finish/);
  c.queue.releaseConversationSend({conversationId:'chat',sessionId:'cancelled'},1);
  assert.equal(c.change({action:'resume'}).paused,false);
});

test('host queue capability includes completed runs even before the UI loads a workflow', async t => {
  const c = await setup(t); if (!c) return;
  assert.equal(c.conversations.getConversation('chat').messageQueueSupported, true);
  const workflows = await import('../dist-electron/cli/workflows.js');
  c.as('alice', () => workflows.createWorkflowRun({
    id: 'finished-workflow', conversationId: 'chat', name: 'Review', goal: 'done',
    status: 'completed', maxLoops: 1, planJson: '{"phases":[]}'
  }));
  const conversation = c.conversations.getConversation('chat');
  assert.equal(conversation.kind, 'default', 'capability does not depend on a persisted type change');
  assert.equal(conversation.messageQueueSupported, false);
  assert.equal(c.snapshot().supported, false);
  assert.throws(() => c.enqueue('blocked'), /message_queue_unsupported/);
});

test('migration repairs legacy team kinds without changing explicit kinds or the timeline', async t => {
  const c = await setup(t); if (!c) return;
  const workflows = await import('../dist-electron/cli/workflows.js');
  const delegation = await import('../dist-electron/cli/delegationRuns.js');
  for (const [id, kind] of [['legacy-team', 'default'], ['legacy-workflow', 'default'], ['document', 'doc-studio']]) {
    c.create(id, 'alice', kind);
    c.as('alice', () => workflows.createWorkflowRun({
      id: `workflow-${id}`, conversationId: id, name: id, goal: 'done',
      status: 'completed', maxLoops: 1, planJson: '{"phases":[]}'
    }));
  }
  c.as('alice', () => delegation.createDelegationRun({
    id: 'legacy-delegation', conversationId: 'legacy-team', goal: 'done', teamId: 'team', teamSnapshotJson: '{}'
  }));
  const before = c.conversations.getConversation('legacy-team');
  c.database.migrate(c.db); c.database.migrate(c.db);
  const repaired = c.conversations.getConversation('legacy-team');
  assert.equal(repaired.kind, 'delegation', 'delegation takes precedence over an older workflow');
  assert.equal(repaired.updatedAt, before.updatedAt);
  assert.equal(repaired.createdAt, before.createdAt);
  assert.equal(repaired.messageQueueSupported, false);
  assert.equal(c.conversations.getConversation('legacy-workflow').kind, 'workflow');
  assert.equal(c.conversations.getConversation('document').kind, 'doc-studio');
});

test('document conversion pauses pending prompts but leaves them editable and removable', async t => {
  const c = await setup(t); if (!c) return;
  c.enqueue('pending');
  c.as('alice', () => c.conversations.markDocStudioConversation('chat', '/tmp/queue-regression.docx'));
  assert.equal(c.db.prepare("SELECT paused FROM conversation_queue_state WHERE conversation_id = 'chat'").get().paused, 1);
  const state = c.snapshot();
  assert.equal(state.supported, false); assert.equal(state.paused, true); assert.equal(state.reason, 'unsupported');
  assert.equal(state.entries[0].prompt, 'pending');
  assert.throws(() => c.change({ action: 'resume' }), /message_queue_unsupported/);
  c.change({ action: 'edit', id: 'pending', token: 'editor' });
  c.change({ action: 'save', id: 'pending', token: 'editor', prompt: 'saved for later' });
  assert.equal(c.snapshot().entries[0].prompt, 'saved for later');
  c.change({ action: 'remove', id: 'pending' });
  assert.equal(c.snapshot().entries.length, 0);
});

test('a run attached to a queued chat pauses dispatch on the next snapshot', async t => {
  const c = await setup(t); if (!c) return;
  c.enqueue('pending');
  const delegation = await import('../dist-electron/cli/delegationRuns.js');
  c.as('alice', () => delegation.createDelegationRun({
    id: 'attached-team', conversationId: 'chat', goal: 'work', teamId: 'team', teamSnapshotJson: '{}'
  }));
  const state = c.as('alice', () => c.queue.listMessageQueues())[0];
  assert.equal(state.supported, false); assert.equal(state.paused, true); assert.equal(state.reason, 'unsupported');
  assert.equal(state.error, undefined, 'an unsupported conversation is a capability change, not a dispatch failure');
  assert.equal(state.entries.length, 1);
});

test('all archive callers pause pending messages and restoring does not auto-resume them', async t => {
  const c = await setup(t); if (!c) return;
  c.enqueue('pending');
  c.conversations.archiveConversation('chat', true);
  const row = c.db.prepare("SELECT paused, reason FROM conversation_queue_state WHERE conversation_id = 'chat'").get();
  assert.deepEqual(row, { paused: 1, reason: 'archived' });
  assert.equal(c.snapshot().supported, false);
  c.conversations.archiveConversation('chat', false);
  assert.equal(c.snapshot().supported, true); assert.equal(c.snapshot().paused, true);
  c.change({ action: 'resume' }); assert.equal(c.claim('restored-send', 'pending'), true);
});

test('a queued preparation cannot launch after the conversation changes kind', async t => {
  const c = await setup(t); if (!c) return;
  c.enqueue('pending'); assert.equal(c.claim('preparing', 'pending'), true);
  c.persist(c.snapshot().entries[0], 'preparing');
  c.as('alice', () => c.conversations.markDocStudioConversation('chat', '/tmp/queue-regression.docx'));
  assert.throws(() => c.accept('preparing'), /message_queue_unsupported/);
  c.queue.releaseConversationSend({ conversationId: 'chat', sessionId: 'preparing' }, 1);
  const state = c.snapshot();
  assert.equal(state.entries.length, 1); assert.equal(state.entries[0].sending, false); assert.equal(state.paused, true);
});
