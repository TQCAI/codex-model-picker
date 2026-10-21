/* codex-model-picker history controls 0.3.0 */
function __codexHistoryActionsUI({threadId,turnId,hostId,useState,useRef,jsx,jsxs,Button,Tooltip}) {
  const [busy,setBusy]=useState(false),[error,setError]=useState(null),[confirming,setConfirming]=useState(null);
  const lock=useRef(false);
  if(!threadId||!turnId||(hostId!=null&&hostId!=='local'))return null;
  async function run(action) {
    if(lock.current)return;
    lock.current=true;setBusy(true);setError(null);setConfirming(null);
    try {
      if(typeof globalThis.__codexModelPickerHistory!=='function')throw Error('历史编辑组件未就绪，请重新打开聊天。');
      await globalThis.__codexModelPickerHistory({threadId,turnId,hostId:hostId??'local',action});
    }catch(e){setError(String(e?.message??e));}
    finally{lock.current=false;setBusy(false);}
  }
  function icon(action) {
    const paths=action==='delete'?['M3 6h18','M9 6V4h6v2','M5 6l1 14h12l1-14','M10 10v6','M14 10v6']:
      ['M3 4v6h6','M3 10a8 8 0 1 1 1.6 8.8'];
    return jsx('svg',{viewBox:'0 0 24 24',fill:'none',stroke:'currentColor',strokeWidth:1.6,strokeLinecap:'round',strokeLinejoin:'round',className:'icon-xs','aria-hidden':true,children:paths.map(d=>jsx('path',{d},d))});
  }
  const controls=['delete','rewind'].map(action=>{
    const label=action==='delete'?'删除本轮':'撤回到此轮之前';
    return jsx(Tooltip,{tooltipContent:label,children:jsx(Button,{color:'ghost',size:'icon',disabled:busy,'aria-label':label,'data-model-picker-history-action':action,onClick:()=>setConfirming(action),children:icon(action)})},action);
  });
  if(confirming)controls.push(jsxs('span',{
    role:'alertdialog','aria-label':confirming==='delete'?'删除本轮':'撤回后续对话',
    style:{position:'absolute',right:0,top:'100%',zIndex:1000,minWidth:260,padding:12,border:'1px solid color-mix(in srgb, currentColor 18%, transparent)',borderRadius:12,background:'var(--bg-primary, Canvas)',color:'var(--text-primary, CanvasText)',boxShadow:'0 8px 28px #0003'},
    children:[jsx('span',{className:'block text-sm',children:confirming==='delete'?'删除这轮提问和回复，保留后续轮次？':'撤回这轮及之后的全部对话？'}),
      jsx(Button,{color:'primary',size:'toolbar',autoFocus:true,onClick:()=>run(confirming),children:confirming==='delete'?'删除':'撤回'}),
      jsx(Button,{color:'ghost',size:'toolbar',onClick:()=>setConfirming(null),children:'取消'})]},'confirmation'));
  if(error)controls.push(jsx('span',{role:'alert',title:error,className:'text-xs text-danger',children:'操作失败：'+error},'error'));
  return jsxs('span',{className:'relative inline-flex items-center gap-0.5','aria-busy':busy,onKeyDown:e=>{if(e.key==='Escape'){e.stopPropagation();setConfirming(null)}},children:controls});
}
