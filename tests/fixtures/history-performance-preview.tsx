// Local fixture: switch between historical messages and exercise deferred bodies.
import { useState } from "react";
import { createRoot } from "react-dom/client";
import i18next from "../../src/i18n";
import "../../styles.css";
import { MessageBubble } from "../../src/components/CLI/MessageBubble";
import { StreamItem, StreamToolInvocation } from "../../src/components/CLI/StreamItem";
import { useConversationStore } from "../../src/store/conversationStore";
import type { ConversationMessage } from "../../src/services/cli/types";

void i18next.changeLanguage("zh-CN");
window.freebuddy = {cli:{async listMessageFileEdits(){return {edits:[],nextCursor:0,hasMore:false};}}} as unknown as typeof window.freebuddy;
const histories = ["a","b"].map(conversationId => Array.from({length:10},(_,index):ConversationMessage => ({
  id:`${conversationId}-${index}`,conversationId,role:"assistant",status:"done",
  agentName:"DeepSeek",adapter:"dsh-acp",createdAt:"2026-10-14T12:00:00Z",updatedAt:"2026-10-14T12:00:00Z",
  content:JSON.stringify([
    ...Array.from({length:2000},()=>({kind:"thinking",append:true,content:"分析中。"})),
    {kind:"tool-call",id:"read",tool:"read",status:"completed",input:{path:"README.md"}},
    {kind:"tool-result",id:"read",tool:"read",content:"tool-result-body\n"+"read result\n".repeat(1000)},
    {kind:"text",role:"assistant",content:`会话 ${conversationId} 的第 ${index+1} 条结果。`}
  ])
})));

function Preview() {
  const [selected,setSelected] = useState(0);
  const [running,setRunning] = useState(true);
  return <main style={{padding:24,maxWidth:1000,margin:"auto"}}>
    <nav style={{display:"flex",gap:12,position:"sticky",top:0,background:"var(--fb-home-bg-primary)",zIndex:10}}>
      {["a","b"].map((id,index)=><button key={id} data-conversation={id} onClick={()=>{
        performance.mark("history-switch");setSelected(index);useConversationStore.setState({activeId:id});
      }}>会话 {id.toUpperCase()}</button>)}
      <span id="selected-history">{selected===0?"a":"b"}</span>
    </nav>
    <section id="standalone-details">
      <StreamItem item={{kind:"thinking",content:"deferred-thought-body\n"+"long thought\n".repeat(3000)}} />
      <StreamItem item={{kind:"tool-result",tool:"read",content:"deferred-result-body"}} />
      <StreamToolInvocation call={{kind:"tool-call",tool:"read",id:"demo",status:running?"running":"completed"}}
        results={[{kind:"tool-result",id:"demo",tool:"read",content:"running-tool-body"}]} />
      <button id="finish-tool" onClick={()=>setRunning(false)}>完成工具</button>
    </section>
    <section id="history-messages">{histories[selected].map(message=><MessageBubble key={message.id} message={message} />)}</section>
  </main>;
}
createRoot(document.getElementById("root")!).render(<Preview />);
