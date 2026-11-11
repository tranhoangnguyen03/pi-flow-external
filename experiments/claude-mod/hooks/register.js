// Claude-facing adapter for the standalone experimental Node runner.
// Does not touch the existing Pi extension or its runtime.
const RUNNER = new URL("../runner/cli.mjs", import.meta.url).pathname;
const PANE = "flow_codex_runs_experimental";
const msg = e => e instanceof Error ? e.message : String(e);
const limit = (s,n=12000) => typeof s==='string' ? s.slice(0,n) : '';
const terminal = s => ['succeeded','failed','cancelled','interrupted_or_uncertain'].includes(s);

export function register(on) {
  let sessionId='', jobs=[], opened=false, timer, delegateName='',runsName='', pollBusy=false;
  let error='', lastSeen=new Map();
  const repaint=$=>$.ui.invalidate("ui.render");
  async function cli($,action,data={}) {
    const r=await $.process.run(["node",RUNNER,action],{stdin:JSON.stringify({...data,sessionId}),timeoutMs:15000});
    let obj;
    try{obj=JSON.parse(r.stdout.trim());}catch{throw new Error("Runner response was not JSON: "+limit(r.stderr,500));}
    if(!obj.ok||r.exitCode!==0)throw new Error(obj.error||r.stderr||"Runner failed");
    return obj.data;
  }
  async function refresh($, notify=true) {
    if(pollBusy || !sessionId)return;
    pollBusy=true;
    try {
      const rows=await cli($,'list');
      for(const row of rows){
        const before=lastSeen.get(row.runId);
        // Notify only when our polling observed the earlier active state.
        if(notify && before && !terminal(before) && terminal(row.state) && !row.collected) {
          $.ui.toast('Codex '+row.state+': '+row.runId);
        }
        lastSeen.set(row.runId,row.state);
      }
      jobs=rows;error='';
      $.ui.status(rows.some(x=>!terminal(x.state)) ? 'Flow: '+rows.filter(x=>!terminal(x.state)).length+' Codex run(s)' : undefined);
    }catch(e){error=msg(e);}
    finally{pollBusy=false; repaint($);}
  }
  async function open($) {
    opened=true;
    await $.ui.open({id:PANE,title:"Flow — Codex runs",focus:true,closeOnEscape:true,rows:18});
    await refresh($,false);
  }
  async function start($,task) {
    if(!task.trim())throw new Error("Usage: /external start <task>");
    const cwd=await $.session.cwd();
    const r=await cli($,'launch',{task:task.trim(),cwd});
    await open($);
    await refresh($,false);
    return r;
  }
  async function act($, action, id) {
    if(!id)throw new Error("A run ID is required");
    const out=await cli($,action,{runId:id});
    await refresh($,false);
    return out;
  }

  on("session.start",async($,e,next)=>{
    sessionId=await $.session.id();
    delegateName=(await $.tool.register({name:"delegate",description:"Launch one Codex explorer task in the current workspace. Read-only sandbox; no conversation context transferred. Returns a background run ID; later inspect or collect it.",inputSchema:{type:"object",properties:{task:{type:"string",minLength:1,maxLength:12000}},required:["task"],additionalProperties:false}})).tool;
    runsName=(await $.tool.register({name:"runs",description:"Inspect, list, collect or cancel experimental Codex runs owned by this Claude session.",inputSchema:{type:"object",properties:{action:{type:"string",enum:["list","inspect","collect","cancel"]},runId:{type:"string"}},required:["action"],additionalProperties:false}})).tool;
    await $.command.register({name:"external",description:"Experimental Codex delegations: start/runs/inspect/collect/cancel",argumentHint:"start <task> | runs | inspect <id> | collect <id> | cancel <id>"});
    // Use the engine clock; no global setInterval in Mod hooks.
    timer=$.clock.every(2000,()=>{void refresh($).catch(()=>{});});
    return next(e);
  });
  on("session.end",async($,e,next)=>{
    timer?.cancel();
    try{await cli($,'stop-session');}catch(err){$.ui.log("Flow cleanup: "+msg(err),{to:"debug"});}
    return next(e);
  });
  on("tool.call",async($,e,next)=>{
    if(e.tool!==delegateName && e.tool!==runsName)return next(e);
    try{
      let result;
      if(e.tool===delegateName){
        result=await start($,String(e.task||''));
      }else{
        const action=String(e.action||'');
        if(!["list","inspect","collect","cancel"].includes(action))return {deny:"Unknown action"};
        result=action==="list"?await cli($,'list'):await act($,action,String(e.runId||''));
      }
      return {result,context:["This is an experimental external worker. A run ID is not a completed answer; check the actual state and collect verified final text."]};
    }catch(err){return {deny:msg(err)};}
  });
  on("command.run",{command:"external"},async($,e)=>{
    const [action,...rest]=e.args.trim().split(/\s+/);
    const arg=rest.join(' ');
    try{
      if(action==='start'){const r=await start($,arg);return {text:'Codex launched: '+r.runId+' (readonly, background)'};}
      if(!action||action==='runs'){await open($);return {text:'Flow runs pane opened.'};}
      if(!['inspect','collect','cancel'].includes(action))return {text:'Usage: /external start <task> | runs | inspect/collect/cancel <run-id>'};
      const r=await act($,action,arg);
      await open($);
      return {text:JSON.stringify(r,null,2).slice(0,18000)};
    }catch(err){return {text:'Flow: '+msg(err)};}
  });
  on("ui.close",($,e,next)=>{if(e.id===PANE)opened=false;return next(e);});
  on("ui.render",{component:"Pane"},($,e,next)=>{
    if(e.requestId!==PANE)return next(e);
    const {Box,Text,Button}= $.ui.resolve(e);
    const items=[Text({bold:true,children:"Codex — readonly / external CLI"})];
    if(error)items.push(Text({children:"Error: "+limit(error,300)}));
    if(!jobs.length)items.push(Text({dimColor:true,children:"No runs yet. /external start <task>"}));
    for(const row of jobs.slice(0,10)){
      const id=row.runId;
      items.push(Text({children:id+'  '+row.state+'  '+(row.activity||'')}));
      items.push(Box({flexDirection:"row",children:[
        Button({key:'inspect_'+id,label:'Inspect',onPress:()=>{void act($,'inspect',id).then(x=>$.ui.log(JSON.stringify(x).slice(0,3000))).catch(x=>$.ui.toast(msg(x)));}}),
        Button({key:'collect_'+id,label:'Collect',onPress:()=>{void act($,'collect',id).then(x=>$.ui.log(x.finalAvailable?x.text:'Not completed')).catch(x=>$.ui.toast(msg(x)));}}),
        ...(!terminal(row.state)?[Button({key:'cancel_'+id,label:'Cancel',onPress:()=>{void act($,'cancel',id).catch(x=>$.ui.toast(msg(x)));}})]:[])
      ]}));
    }
    items.push(Button({key:"flow_refresh",label:"Refresh",hotkey:"r",onPress:()=>{void refresh($,false);}}));
    return Box({flexDirection:"column",padding:1,children:items});
  });
}
