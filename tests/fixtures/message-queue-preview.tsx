// Real ChatView + store + runner. The native transport is simulated; no real agents or user data.
import './skill-commands-preview';
import { useEffect, useState } from 'react';
import { createRoot } from 'react-dom/client';
import { ChatView } from '../../src/components/CLI/ChatView';
import { ConversationList } from '../../src/components/CLI/ConversationList';
import { useConversationStore } from '../../src/store/conversationStore';
import { useMessageQueueStore } from '../../src/store/messageQueueStore';
import type { ConversationMessage, CliEvent, CliRunArgs } from '../../src/services/cli/types';
import type { ConversationSendClaim, MessageQueueCommand, MessageQueueSnapshot, QueuedMessage } from '../../electron/shared/messageQueueTypes';
import i18next from '../../src/i18n';

const id=useConversationStore.getState().activeId!;
const conversation=useConversationStore.getState().conversations.find(c=>c.id===id)!;
const now=new Date().toISOString();
const saved=new Map<string,ConversationMessage>();
const listeners=new Map<string,(event:CliEvent)=>void>();
const scheduledTimers=new Set<ReturnType<typeof setTimeout>>();
const entry=(key:string,prompt:string):QueuedMessage=>({id:key,prompt,attachments:[],conversationId:id,userMessageId:`user-${key}`,assistantMessageId:`assistant-${key}`,createdAt:now,sending:false,approvalMode:'auto',configOptionOverrides:{model:'GPT-5'}});
let queue:MessageQueueSnapshot;
let held:ConversationSendClaim|undefined;
let initial=true;
const clone=<T,>(value:T):T=>JSON.parse(JSON.stringify(value));
function seed(){
  scheduledTimers.forEach(clearTimeout);scheduledTimers.clear();held=undefined;initial=true;saved.clear();
  const user:ConversationMessage={id:'fixture-user',conversationId:id,role:'user',status:'sent',content:'帮我优化登录页交互',createdAt:now,updatedAt:now};
  const assistant:ConversationMessage={id:'fixture-assistant',conversationId:id,role:'assistant',status:'running',content:'[]',agentId:conversation.agentId,agentName:conversation.agentName,adapter:conversation.adapter,taskId:'fixture-running',createdAt:now,updatedAt:now};
  saved.set(user.id,user);saved.set(assistant.id,assistant);
  useConversationStore.setState({activeId:id,messages:{[id]:[user,assistant]},live:{[id]:{messageId:assistant.id,taskSessionId:'fixture-running',items:[{kind:'text',role:'assistant',content:'正在检查登录表单与错误提示…'}],status:'running'}}});
  queue={conversationId:id,paused:false,busy:true,entries:[entry('mobile','顺便补上移动端适配'),entry('keyboard','然后检查键盘操作与焦点状态')]};
  useMessageQueueStore.setState({queues:{[id]:clone(queue)}});
}
function finish(failed=false){
  queue.busy=false;held=undefined;
  if(failed){queue.paused=true;queue.reason='failed';}
  const live=useConversationStore.getState().live[id];
  if(!live)return;
  if(initial){
    initial=false;
    const content=JSON.stringify([{kind:'text',role:'assistant',content:failed?'连接中断，待发消息已保留。':'登录表单检查完成。'}]);
    useConversationStore.setState(state=>({live:{},messages:{...state.messages,[id]:(state.messages[id]??[]).map(message=>message.id===live.messageId?{...message,status:failed?'failed':'done',content}:message)}}));
  }else{
    if(failed)listeners.get(live.taskSessionId)?.({type:'error',message:'模拟连接中断'});
    listeners.get(live.taskSessionId)?.({type:'done',exitCode:failed?1:0});
  }
  useMessageQueueStore.setState({queues:{[id]:clone(queue)}});
}
const native=window.freebuddy!.cli;
const methods={
  ...native,
  listMessageQueues:async()=>queue.entries.length?[clone(queue)]:[],
  getMessageQueue:async()=>clone(queue),
  changeMessageQueue:async(command:MessageQueueCommand)=>{
    if(command.action==='enqueue')queue.entries.push({...clone(command.entry),conversationId:id,userMessageId:`user-${command.entry.id}`,assistantMessageId:`assistant-${command.entry.id}`,createdAt:now,sending:false});
    if(command.action==='remove')queue.entries=queue.entries.filter(item=>item.id!==command.id);
    if(command.action==='pause'){queue.paused=true;queue.reason=command.error?'failed':'manual';queue.error=command.error;}
    if(command.action==='resume'){queue.paused=false;queue.reason=undefined;queue.error=undefined;}
    if(command.action==='edit')queue.editingId=command.id;
    if(command.action==='cancelEdit')queue.editingId=undefined;
    if(command.action==='save'){queue.entries=queue.entries.map(item=>item.id===command.id?{...item,prompt:command.prompt}:item);queue.editingId=undefined;}
    return clone(queue);
  },
  claimConversationSend:async(input:ConversationSendClaim)=>{
    if(held?.sessionId===input.sessionId)return true;
    if(queue.busy||queue.editingId||(input.queueId&&(queue.paused||queue.entries[0]?.id!==input.queueId)))return false;
    held=input;queue.busy=true;if(input.queueId)queue.entries[0].sending=true;return true;
  },
  releaseConversationSend:async()=>{},
  appendMessage:async(input:ConversationMessage)=>{const message={...input,createdAt:now,updatedAt:now};saved.set(input.id,message);return message;},
  listMessage:async(messageId:string)=>saved.get(messageId),
  listMessageFileEdits:async()=>({edits:[],hasMore:false,nextCursor:0}),
  updateMessage:async(input:Partial<ConversationMessage>&{id:string})=>{const current=saved.get(input.id);if(current)saved.set(input.id,{...current,...input});},
  onEvent:(sessionId:string,listener:(event:CliEvent)=>void)=>{listeners.set(sessionId,listener);return()=>listeners.delete(sessionId);},
  run:async(args:CliRunArgs)=>{
    const queueId=held?.queueId;if(queueId)queue.entries=queue.entries.filter(item=>item.id!==queueId);
    initial=false;queue.busy=true;
    listeners.get(args.sessionId)?.({type:'started',pid:12345});
    listeners.get(args.sessionId)?.({type:'items',items:[{kind:'text',role:'assistant',content:`正在处理：${args.prompt}`} ]});
    const timer=setTimeout(()=>{scheduledTimers.delete(timer);finish();},8000);scheduledTimers.add(timer);
    return{sessionId:args.sessionId};
  },
  kill:async()=>{
    queue.paused=true;queue.reason='stopped';queue.busy=false;held=undefined;scheduledTimers.forEach(clearTimeout);scheduledTimers.clear();
    const live=useConversationStore.getState().live[id];
    if(initial){initial=false;useConversationStore.setState(state=>({live:{},messages:{...state.messages,[id]:(state.messages[id]??[]).map(message=>message.role==='assistant'&&message.status==='running'?{...message,status:'killed',content:'[]'}:message)}}));}
    else if(live)listeners.get(live.taskSessionId)?.({type:'done',exitCode:130});
    useMessageQueueStore.setState({queues:{[id]:clone(queue)}});return true;
  }
};
window.freebuddy!.cli=methods as never;seed();
function Preview(){
  const[theme,setTheme]=useState('light');
  useEffect(()=>{void useMessageQueueStore.getState().refresh();},[]);
  return <div style={{height:'100dvh',display:'flex',flexDirection:'column',background:'var(--fb-home-bg-primary)'}}>
    <style>{`.queue-fixture { --fb-detail-width: 0px; } .queue-fixture .chat-view {height:100%} .queue-fixture-toolbar {display:flex;align-items:center;gap:10px;padding:10px 20px;border-bottom:1px solid var(--fb-border);font-size:12px;flex-wrap:wrap} @media(max-width:700px){.queue-fixture-sidebar{display:none}.queue-fixture .chat-composer{left:auto;right:auto;width:calc(100vw - 28px)}}`}</style>
    <nav className="queue-fixture-toolbar"><span>真实会话组件 · 本地测试</span><button onClick={()=>finish()}>完成当前回复</button><button onClick={()=>finish(true)}>模拟失败</button><button onClick={seed}>重置</button><button onClick={()=>{const next=theme==='light'?'dark':'light';setTheme(next);document.documentElement.dataset.theme=next}}>切换主题</button><button onClick={()=>void i18next.changeLanguage(i18next.language==='zh-CN'?'en':'zh-CN')}>中 / EN</button></nav>
    <main className="queue-fixture" style={{minHeight:0,flex:1,display:'flex'}}><aside className="queue-fixture-sidebar" style={{width:272,flexShrink:0,borderRight:'1px solid var(--fb-border)'}}><ConversationList/></aside><div style={{position:'relative',flex:1,minWidth:0,minHeight:0}}><ChatView/></div></main>
  </div>;
}
const root=createRoot(document.getElementById('root')!);root.render(<Preview/>);
import.meta.hot?.dispose(()=>{scheduledTimers.forEach(clearTimeout);root.unmount();});
