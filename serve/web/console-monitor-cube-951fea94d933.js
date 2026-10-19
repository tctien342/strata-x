/* Read-only monitor renderer. Existing app poll owns all network access. */
(() => {
  "use strict";
  const colors = [[43,53,49],[64,111,80],[220,176,105],[139,238,178]];
  const finite = value => value != null && Number.isFinite(Number(value));
  const clamp = (value, max = 100) => Math.max(0, Math.min(max, value));
  function groupMatrix(data, group, layerGroup=1) {
    if (!data || !Number.isInteger(data.layers) || !Number.isInteger(data.experts) || data.layers < 1 || data.experts < 1 ||
        !Number.isInteger(group) || group < 1 || !Number.isInteger(layerGroup) || layerGroup < 1 || data.states?.length !== data.layers * data.experts) return null;
    const cols = Math.ceil(data.experts / group), cells = [], counts = [0,0,0,0];
    const transfers = new Set(data.recent_transfers || []);
    const rows=Math.ceil(data.layers/layerGroup);
    for (let row = 0; row < rows; row++) for (let col = 0; col < cols; col++) {
      const bins = [0,0,0,0], first = col * group, end = Math.min(first + group, data.experts);
      const layerFirst=row*layerGroup,layerEnd=Math.min(layerFirst+layerGroup,data.layers);
      let transfer = false;
      for (let layer=layerFirst;layer<layerEnd;layer++) for (let e = first; e < end; e++) {
        const index = layer * data.experts + e, state = Number(data.states[index]);
        if (!Number.isInteger(state) || state < 0 || state > 3) return null;
        bins[state]++; counts[state]++; transfer ||= transfers.has(index);
      }
      const total = (end - first)*(layerEnd-layerFirst), state = bins[2] ? 2 : bins[3] ? 3 : bins[1] ? 1 : 0;
      const opacity = state === 0 ? .45 : .18 + .82 * bins[state] / total;
      cells.push({row,col,first,end:end-1,layerFirst,layerEnd:layerEnd-1,bins,state,opacity,transfer});
    }
    return {cells,counts,cols,rows,group,total:data.layers * data.experts};
  }
  function cubeGrid(data) {
    const grid=groupMatrix(data,Math.max(1,Math.ceil((data?.experts||0)/128)),1);
    if(!grid)return null;
    const side=Math.ceil(Math.cbrt(grid.cells.length)),slots=side**3,step=4/side;
    grid.side=side;
    const occupied=new Map();
    const position=slot=>{
      const x=(slot%side+.5)*step-2,y=2-(Math.floor(slot/side)%side+.5)*step,z=(Math.floor(slot/(side*side))+.5)*step-2;
      return {x,y,z,radius:Math.hypot(x,y,z)};
    };
    grid.positions=grid.cells.map((_,i)=>{
      const slot=Math.floor(i*slots/grid.cells.length);occupied.set(slot,i);
      return position(slot);
    });
    grid.fillers=[];
    for(let slot=0;slot<slots;slot++) {
      if(occupied.has(slot))continue;
      const p=position(slot),x=slot%side,y=Math.floor(slot/side)%side,z=Math.floor(slot/(side*side));
      const neighbors=[x>0?slot-1:-1,x<side-1?slot+1:-1,y>0?slot-side:-1,y<side-1?slot+side:-1,z>0?slot-side*side:-1,z<side-1?slot+side*side:-1];
      let source=neighbors.map(n=>occupied.get(n)).find(i=>i!==undefined);
      if(source===undefined) {
        let closest=Infinity;
        grid.positions.forEach((q,i)=>{const distance=(p.x-q.x)**2+(p.y-q.y)**2+(p.z-q.z)**2;if(distance<closest){closest=distance;source=i;}});
      }
      grid.fillers.push({...p,source});
    }
    return grid;
  }
  function cubePhase(metrics) {
    const slots=metrics?.slots||[];
    if(slots.some(s=>s.state==="reading")||metrics?.live?.state==="reading")return "prefill";
    if(slots.some(s=>s.state==="generating")||metrics?.live?.state==="generating")return "decode";
    return "idle";
  }
  function mergeExpertStates(data) {
    const aux=data?.auxiliary;
    if(!aux || aux.layers!==data.layers || aux.experts!==data.experts ||
       aux.states?.length!==data.layers*data.experts || data.states?.length!==aux.states.length) return data;
    const states=[];
    for(let i=0;i<data.states.length;i++) {
      const main=Number(data.states[i]),raw=Number(aux.states[i]);
      if(!Number.isInteger(main)||main<0||main>3||!Number.isInteger(raw)||raw<0||raw>3)return data;
      const other=aux.paused&&raw===3?1:raw;
      states.push(main===3||other===3?3:main===1||other===1?1:main===2||other===2?2:0);
    }
    return {...data,states:states.join("")};
  }
  function aggregateHardware(hw) {
    const cards=hw.gpus||[];
    if(!cards.length)return hw;
    const result={...hw};
    for(const key of ["mem_used","mem_total","power","power_limit","pcie_rx_mb","pcie_tx_mb","util","temp"]) {
      const values=cards.map(g=>g[key]);
      result["gpu_"+key]=values.every(finite)?key==="temp"?Math.max(...values.map(Number)):
        values.reduce((sum,v)=>sum+Number(v),0)/(key==="util"?cards.length:1):null;
    }
    return result;
  }
  function recordHardware(history,time,hw) {
    if(!finite(time))return;
    const second=Math.floor(Number(time));
    if(history.second!==null&&second<=history.second)return;
    const gap=Math.min(60,second-(history.second??second-1));
    for(const key of ["gpu_util","gpu_mem_used","gpu_temp","gpu_power"]) {
      const values=history[key]||Array(60).fill(null);
      history[key]=values.slice(gap).concat(Array(gap-1).fill(null),finite(hw[key])?Number(hw[key]):null);
    }
    history.second=second;
  }
  function expertCapacity(engine) {
    const main=finite(engine.expert_slots)?Number(engine.expert_slots):null;
    const aux=finite(engine.aux_expert_slots)?Number(engine.aux_expert_slots):0;
    return {main,aux,total:main===null?null:main+aux};
  }
  function requestOutcome(finish) {
    const tag=({length:"LIMIT",error:"ERROR",disconnect:"DISCONNECT",cancel:"CANCEL",cancelled:"CANCEL"})[finish]||"DONE";
    return {tag,tone:tag==="ERROR"?"error":tag==="DONE"?"normal":"warn"};
  }
  function contextFill(slot, limit) {
    const used = Math.max(0,Number(slot?.prompt_tokens) || 0) + Math.max(0,Number(slot?.generated) || 0);
    return {used,limit:Number(limit)||0,percent:limit > 0 ? clamp(100 * used / limit) : 0};
  }
  function chartPoints(values, scale) {
    return (values || []).map(v => finite(v) && scale > 0 ? clamp(100 * Number(v) / scale) : null);
  }
  if (typeof module === "object" && module.exports) { module.exports = {cubeGrid,cubePhase,groupMatrix,mergeExpertStates,aggregateHardware,recordHardware,expertCapacity,requestOutcome,contextFill,chartPoints}; return; }
  const $ = id => document.getElementById(id);
  const fmt = (v,d=0) => finite(v) ? Number(v).toLocaleString(undefined,{maximumFractionDigits:d,minimumFractionDigits:d}) : "—";
  const esc = v => String(v).replace(/[&<>"']/g,c=>({"&":"&amp;","<":"&lt;",">":"&gt;",'"':"&quot;","'":"&#39;"}[c]));
  const gib = v => finite(v) ? fmt(Number(v)/1073741824,1) : "—";
  const text = (id,value) => { $(id).textContent=value; };
  const reduced = matchMedia("(prefers-reduced-motion: reduce)");
  const panel = $("view-monitor"), canvas = $("moe-grid");
  let latest=null, matrix=null, expertData=null, group=1, layerGroup=1, cursor=null, visible=false, offline=false;
  let cube=null;
  let from=[], target=[], painted=[], started=0, frame=0, lastDraw=0;
  const layout={width:0,height:0,x:30,y:19,dx:1,dy:1};
  let gaugeValues={};
  const series=[
    {key:"tok_s",label:"Decode",color:"#99edba",scale:100,unit:"t/s"},
    {key:"prefill_tok_s_mean",label:"Prefill",color:"#60bdba",scale:2000,unit:"t/s"},
    {key:"gpu_util",label:"GPU load",color:"#e3d09e",scale:100,unit:"%"},
    {key:"gpu_mem_used",label:"VRAM",color:"#829fe2",unit:"GiB"},
    {key:"gpu_temp",label:"Temp",color:"#d58b79",scale:90,unit:"°C"},
    {key:"gpu_power",label:"Power",color:"#c1a8cf",unit:"W"},
  ];
  const gauges=$("telemetry-gauges");
  const gaugeTicks=Array.from({length:60},(_,i)=>{
    const angle=Math.PI-i/59*Math.PI,point=r=>`${(60+r*Math.cos(angle)).toFixed(2)} ${(62-r*Math.sin(angle)).toFixed(2)}`;
    const line=`M ${point(44)} L ${point(51)}`;
    return `<path class="gauge-track" d="${line}"/><path class="gauge-tick" d="${line}"/>`;
  }).join("");
  gauges.innerHTML=series.map((s,i)=>`<div class="telemetry-gauge" data-series="${s.key}" style="--gauge-color:${s.color}" role="img">
    <span class="gauge-label">0${i+1} / ${s.label.toUpperCase()}</span><div class="gauge-surface">
      <svg viewBox="0 0 120 76" aria-hidden="true">${gaugeTicks}<text class="gauge-value" x="60" y="48" text-anchor="middle">—</text><text class="gauge-unit" x="60" y="59" text-anchor="middle">${s.unit}</text></svg></div><span class="gauge-scale">—</span></div>`).join("");
  function sizeCanvas(element) {
    const rect=element.getBoundingClientRect(), dpr=Math.min(devicePixelRatio||1,2);
    const width=Math.max(1,rect.width),height=Math.max(1,rect.height);
    if(element.width!==Math.round(width*dpr)||element.height!==Math.round(height*dpr)){
      element.width=Math.round(width*dpr);element.height=Math.round(height*dpr);
    }
    const ctx=element.getContext("2d");ctx.setTransform(dpr,0,0,dpr,0,0);
    return {ctx,width,height};
  }
  function drawMatrix(values=target) {
    if(cube || !visible || document.hidden || !matrix || offline) return;
    const {ctx,width,height}=sizeCanvas(canvas);
    Object.assign(layout,{width,height,dx:(width-34)/matrix.cols,dy:(height-24)/matrix.rows});
    ctx.clearRect(0,0,width,height); ctx.font="8px ui-monospace, Menlo, monospace";ctx.fillStyle="#52735f";
    const labelStep=Math.max(1,Math.ceil(matrix.cols/8));
    for(let c=0;c<matrix.cols;c+=labelStep) ctx.fillText("E"+String(c*group).padStart(3,"0"),layout.x+c*layout.dx,10);
    for(let r=0;r<matrix.rows;r+=Math.max(1,Math.ceil(8/layerGroup))) ctx.fillText("L"+String(r*layerGroup).padStart(2,"0"),0,layout.y+(r+.8)*layout.dy);
    const size=Math.max(1,Math.min(layout.dx,layout.dy)-1.5),sx=size,sy=size;
    for(let i=0;i<matrix.cells.length;i++){
      const cell=matrix.cells[i], color=values[i]||target[i];
      const x=layout.x+cell.col*layout.dx+(layout.dx-sx)/2,y=layout.y+cell.row*layout.dy+(layout.dy-sy)/2;
      ctx.fillStyle=`rgba(${color[0]},${color[1]},${color[2]},${color[3]})`;
      ctx.fillRect(x,y,sx,sy);
      if(cell.transfer){ctx.strokeStyle="#caa56e";ctx.lineWidth=.6;ctx.strokeRect(x,y,sx,sy);}
      if(cursor?.row===cell.row && cursor?.col===cell.col){ctx.strokeStyle="#def6e6";ctx.lineWidth=1;ctx.strokeRect(x-.5,y-.5,sx+1,sy+1);}
    }
    const devices=expertData.devices||[];
    for(let r=1;r<expertData.layers;r++) if(devices[r]!==devices[r-1]){
      ctx.strokeStyle="#526c5a";ctx.setLineDash([2,3]);ctx.beginPath();ctx.moveTo(layout.x,layout.y+r/layerGroup*layout.dy-.8);ctx.lineTo(width,layout.y+r/layerGroup*layout.dy-.8);ctx.stroke();ctx.setLineDash([]);
    }
    painted=values;
  }
  function animate(now) {
    frame=0;
    if(!visible||offline||document.hidden) return;
    const progress=clamp((now-started)/350,1),ease=1-Math.pow(1-progress,3);
    if(now-lastDraw>=32 || progress===1){
      drawMatrix(target.map((v,i)=>v.map((n,j)=>(from[i]?.[j]??n)+(n-(from[i]?.[j]??n))*ease)));lastDraw=now;
    }
    if(progress<1) frame=requestAnimationFrame(animate);
  }
  function renderMatrix(data) {
    data=mergeExpertStates(data);
    expertData=data;
    const rect=canvas.getBoundingClientRect();
    layerGroup=Math.max(1,Math.ceil((data?.layers||48)/Math.max(8,Math.floor((rect.height-24)/5))));
    const pixel=Math.max(4,(rect.height-24)/Math.ceil((data?.layers||48)/layerGroup));
    group=1;while(data && Math.ceil(data.experts/group)>Math.max(16,Math.floor((rect.width-34)/pixel))) group*=2;
    const next=cube?cubeGrid(data):groupMatrix(data,group,layerGroup);
    if(cube){group=next?.group||1;layerGroup=1;cube.update(next,cubePhase(latest),visible&&!offline,latest.slots?.some(s=>s.state==="reading")&&latest.slots?.some(s=>s.state==="generating"));}
    cancelAnimationFrame(frame);frame=0;
    matrix=next;$("moe-empty").hidden=!!next;
    if(!next){ text("moe-live","UNAVAILABLE");for(let i=0;i<4;i++)text("moe-count-"+i,"—");return; }
    for(let i=0;i<4;i++)text("moe-count-"+i,fmt(next.counts[i]));
    text("moe-live",data.paused?"SNAPSHOT PAUSED":latest.live.state==="idle"?"IDLE CACHE":"LIVE ROUTING");
    text("matrix-shape",`${fmt(next.total)} EXPERTS / ${data.layers} × ${data.experts}`);
    text("moe-range",`${layerGroup} LAYER${layerGroup>1?"S":""} × ${group} EXPERT${group>1?"S":""} / CELL`);
    canvas.setAttribute("aria-label",`All ${next.total} experts, ${data.layers} layers, ${layerGroup} layers and ${group} experts per cell. Arrow keys inspect groups.`);
    canvas.dataset.experts=next.total;canvas.dataset.group=group;canvas.dataset.layers=data.layers;canvas.dataset.cells=next.cells.length;
    from=painted;
    target=next.cells.map(c=>[...colors[c.state],c.opacity]);
    const changed=painted.length!==target.length || target.some((v,i)=>v.some((n,j)=>n!==painted[i]?.[j]));
    if(cube)painted=target;
    else if(!changed || !painted.length || painted.length!==target.length || reduced.matches || !visible || document.hidden){painted=target;drawMatrix();}
    else {started=performance.now();frame=requestAnimationFrame(animate);}
    if(cursor){cursor.row=clamp(cursor.row,next.rows-1);cursor.col=clamp(cursor.col,next.cols-1);describeCell();}
  }
  function describeCell() {
    if(!matrix||!cursor)return;
    const c=matrix.cells[cursor.row*matrix.cols+cursor.col];
    const devices=[...new Set((expertData.devices||[]).slice(c.layerFirst,c.layerEnd+1))].map(stage=>latest.hardware?.gpus?.[stage]?.index??`stage ${stage+1}`);
    const aux=expertData.auxiliary;
    if(aux?.layers===expertData.layers&&aux.experts===expertData.experts&&aux.states?.length===matrix.total) {
      let resident=false;
      for(let l=c.layerFirst;l<=c.layerEnd;l++)for(let e=c.first;e<=c.end;e++)resident||=Number(aux.states[l*expertData.experts+e])>0;
      const gpu=latest.hardware?.gpus?.find(g=>g.role==="auxiliary");
      if(resident&&gpu&&!devices.includes(gpu.index))devices.push(gpu.index);
    }
    text("moe-detail",`L${c.layerFirst}–${c.layerEnd} · E${c.first}–${c.end} · GPU ${devices.join("/")} · ${c.bins[3]} active / ${c.bins[1]} idle / ${c.bins[2]} loading / ${c.bins[0]} absent`);
  }
  canvas.addEventListener("pointermove",event=>{
    if(cube||!matrix||offline)return;
    const rect=canvas.getBoundingClientRect();
    const col=Math.floor((event.clientX-rect.left-layout.x)/layout.dx),row=Math.floor((event.clientY-rect.top-layout.y)/layout.dy);
    if(col<0||row<0||col>=matrix.cols||row>=matrix.rows)return;
    if(cursor?.row===row&&cursor?.col===col)return;
    cursor={row,col};describeCell();drawMatrix(painted);
  });
  canvas.addEventListener("keydown",event=>{
    if(!matrix||offline||!["ArrowLeft","ArrowRight","ArrowUp","ArrowDown"].includes(event.key))return;
    event.preventDefault();cursor||={row:0,col:0};
    cursor.row=clamp(cursor.row+(event.key==="ArrowDown"?1:event.key==="ArrowUp"?-1:0),matrix.rows-1);
    cursor.col=clamp(cursor.col+(event.key==="ArrowRight"?1:event.key==="ArrowLeft"?-1:0),matrix.cols-1);
    describeCell();drawMatrix(painted);
  });
  function drawGauges() {
    if(!latest||!visible||document.hidden)return;
    const hw=latest.hardware||{};
    series.forEach((s,i)=>{
      const card=gauges.children[i],value=offline?null:gaugeValues[s.key];
      let scale=s.key==="gpu_mem_used"?hw.gpu_mem_total:s.key==="gpu_power"?hw.gpu_power_limit:s.scale;
      if(["tok_s","prefill_tok_s_mean"].includes(s.key)&&finite(value))scale=Math.max(scale,Number(value));
      const valid=finite(value)&&finite(scale)&&Number(scale)>0;
      const display=s.key==="gpu_mem_used"?gib(value):fmt(value,s.key==="tok_s"?1:0);
      const maximum=s.key==="gpu_mem_used"?gib(scale):fmt(scale);
      card.querySelector(".gauge-value").textContent=display;
      card.querySelector(".gauge-scale").textContent=`0 — ${maximum} ${s.unit}`;
      const filled=valid?clamp(Number(value)/Number(scale)*100)/100*60:0;
      card.querySelectorAll(".gauge-tick").forEach((tick,index)=>{tick.style.opacity=String(clamp(filled-index,1));});
      card.setAttribute("aria-label",offline?`${s.label}: telemetry offline`:`${s.label}: ${display} ${s.unit}; full scale ${maximum} ${s.unit}`);
    });
  }
  const slotGrid=$("slot-grid");
  slotGrid.innerHTML=[0,1].map(i=>`<article class="console-slot" data-state="unavailable" aria-label="Slot ${i+1}">
    <div class="console-slot-head"><span>SLOT 0${i+1}</span><span class="slot-state">Offline</span></div><div class="slot-request-id">Awaiting telemetry</div>
    <div class="slot-rate"><span class="slot-phase" aria-hidden="true"><i></i><i></i><i></i></span><strong>—</strong><span class="slot-rate-label">DECODE TOK/S</span></div><div class="slot-small-stats"><span class="slot-output">— OUT</span><span class="slot-prefill">PF —</span></div>
    <div class="slot-context-label"><span>CONTEXT</span><span class="slot-context-percent">—</span></div><div class="slot-context-track" role="progressbar" aria-label="Slot ${i+1} logical context fill" aria-valuemin="0"><i></i></div>
    <div class="slot-context-count">— / — TOKENS</div><div class="slot-idle-note">Idle VRAM can cache experts after 2 min</div></article>`).join("");
  function renderSlots(slots,limit,queued) {
    const active=(slots||[]).filter(s=>["reading","waiting","generating"].includes(s.state)).length;
    text("slot-summary",`${active} / 2${queued?` · ${queued} QUEUED`:""}`);
    [...slotGrid.children].forEach((card,i)=>{
      const s=slots?.[i],state=s?.state||"unavailable",fill=contextFill(s,limit);
      card.dataset.state=state;
      const set=(selector,value)=>{card.querySelector(selector).textContent=value;};
      set(".slot-state",{idle:"Idle",waiting:"Queued",reading:"Prefill",generating:"Decode",unavailable:"Offline"}[state]||state);
      set(".slot-request-id",s?.request_id?`REQ ${String(s.request_id).slice(-8)}`:"AVAILABLE");
      set(".slot-rate strong",state==="idle"?"IDLE":state==="reading"?"PREFILL":state==="waiting"?"QUEUED":fmt(s?.tok_s,1));
      set(".slot-rate-label",state==="idle"?(s?.request_id&&finite(s?.tok_s)?`LAST ${fmt(s.tok_s,1)} TOK/S`:"AVAILABLE"):
        state==="reading"?(finite(s?.prefill_tok_s)?`${fmt(s.prefill_tok_s)} TOK/S`:"READING PROMPT"):
        state==="waiting"?"WAITING":state==="unavailable"?"UNAVAILABLE":"DECODE TOK/S");
      set(".slot-output",`${fmt(s?.generated)} OUT`);set(".slot-prefill",`PF ${fmt(s?.prefill_tok_s)}`);
      set(".slot-context-percent",s?`${fmt(fill.percent,1)}%`:"—");
      set(".slot-context-count",s?`${fmt(fill.used)} / ${fmt(fill.limit)}`:"— / —");
      const meter=card.querySelector(".slot-context-track");
      meter.setAttribute("aria-valuemax",fill.limit);meter.setAttribute("aria-valuenow",Math.min(fill.used,fill.limit));
      meter.setAttribute("aria-valuetext",`${fmt(fill.percent,1)} percent logical context; ${fmt(fill.used)} tokens${state==="idle"?", last retained conversation":""}`);
      meter.firstElementChild.style.width=fill.percent+"%";
      card.title=`${state==="idle"?"Retained last-request":"Current request"} context = prompt + generated. Reused tokens are already in prompt. Logical context ${fmt(limit)}; resident KV ${fmt(latest?.engine?.kv_resident)}. Request idle does not prove VRAM-loan state.`;
      card.querySelector(".slot-idle-note").hidden=state!=="idle";
    });
  }
  let events=[],seen=new Set(),seenOrder=[],previousSlots=new Map(),filter="all",page=0,rows=6,historyAll=false;
  function addEvent(event) {
    if(seen.has(event.key))return;
    seen.add(event.key);seenOrder.push(event.key);
    if(seenOrder.length>512)seen.delete(seenOrder.shift());
    events.push(event);events.sort((a,b)=>b.time-a.time);events=events.slice(0,160);
  }
  function logMetrics(m) {
    (m.requests||[]).forEach(r=>addEvent({key:`request:${r.time}:${r.prompt_tokens}:${r.finish}`,time:r.time,type:"request",
      ...requestOutcome(r.finish),
      message:`${fmt(r.prompt_tokens)} prompt · ${fmt(r.reused)} reused · ${fmt(r.output_tokens)} out · PF ${fmt(r.prefill_tok_s)} / DEC ${fmt(r.decode_tok_s,1)} tok/s · ${fmt(r.duration_s,1)}s`}));
    (m.slots||[]).forEach(s=>{
      const signature=`${s.request_id}:${s.state}`,old=previousSlots.get(s.id);
      if(old && old!==signature)addEvent({key:`slot:${s.id}:${signature}:${m.time}`,time:m.time,type:"slot",tag:s.state.toUpperCase(),tone:"normal",
        message:`SLOT ${String(Number(s.id)+1).padStart(2,"0")} · req ${String(s.request_id||"—").slice(-8)} · ${fmt(s.generated||0)} out · ${fmt(s.reused||0)} reused`});
      previousSlots.set(s.id,signature);
    });
    drawEvents();
  }
  function drawEvents() {
    const list=events.filter(e=>filter==="all"||e.type===filter),pages=Math.max(1,Math.ceil(list.length/rows));
    page=Math.min(page,pages-1);const shown=list.slice(page*rows,(page+1)*rows),container=$("event-lines");
    const old=new Map([...container.children].map(n=>[n.dataset.key,n]));
    const nodes=shown.map(e=>{
      let node=old.get(e.key);
      if(!node){
        node=document.createElement("div");node.className="event-line";node.dataset.key=e.key;node.dataset.tone=e.tone;
        if(latest && e.time>=latest.time-3 && !reduced.matches){
          node.classList.add("event-enter");node.addEventListener("animationend",()=>node.classList.remove("event-enter"),{once:true});
        }
        const time=new Date(e.time*1000).toLocaleTimeString([],{hour12:false});
        node.innerHTML=`<time>${esc(time)}</time><span class="event-tag">${esc(e.tag)}</span><span class="event-message">${esc(e.message)}</span>`;
        node.title=e.message;
      }return node;
    });
    container.replaceChildren(...nodes);
    if(!nodes.length){const empty=document.createElement("div");empty.className="event-empty";empty.textContent="No observed events yet.";container.appendChild(empty);}
    text("event-page",`${String(page+1).padStart(2,"0")} / ${String(pages).padStart(2,"0")}`);
    $("event-newer").disabled=page===0;$("event-older").disabled=page===pages-1;
    const total=latest?.totals;
    text("event-summary",`${historyAll?"FULL HISTORY":"RECENT"} · ${fmt(list.length)} EVENTS · ${fmt(total?.requests||0)} REQUESTS · ${fmt(total?.output_tokens||0)} OUTPUT TOKENS`);
  }
  for(const button of document.querySelectorAll("[data-log-filter]"))button.onclick=()=>{
    filter=button.dataset.logFilter;page=0;
    for(const b of document.querySelectorAll("[data-log-filter]"))b.setAttribute("aria-pressed",String(b===button));drawEvents();
  };
  $("event-newer").onclick=()=>{page=Math.max(0,page-1);drawEvents();};
  $("event-older").onclick=()=>{page++;drawEvents();};
  function render(m,all=false) {
    const hardware=aggregateHardware(m.hardware||{});
    m={...m,hardware};
    const reconnect=offline;offline=false;latest=m;historyAll=all;panel.dataset.offline="false";
    const hw=m.hardware||{},eng=m.engine||{},slots=m.slots||[],active=slots.filter(s=>["generating","reading","waiting"].includes(s.state));
    const last=m.requests?.[0],prefill=slots.find(s=>s.state==="reading")||active.slice().sort((a,b)=>(a.elapsed_s||0)-(b.elapsed_s||0)).find(s=>s.prefill_tok_s!=null);
    text("matrix-model",(eng.model||"STRATA ENGINE").replace(/^qwen3\.8-flash-next-iq3_s$/i,"qwen3.8-flash-next-gsq-rco-iq3_s").toUpperCase());text("console-version",eng.version?"v"+eng.version:"—");
    text("telemetry-status",m.live.state==="generating"?"DECODING":m.live.state==="reading"?"PREFILL":m.live.state==="unloaded"?"UNLOADED":"IDLE");
    const decoding=slots.filter(s=>s.state==="generating");
    const speed=decoding.length?decoding.reduce((sum,s)=>sum+(s.tok_s||0),0):last?.decode_tok_s;
    text("console-decode",fmt(speed,1));text("decode-caption",decoding.length?"DECODE / LIVE":"DECODE / LAST");
    text("console-prefill",fmt(prefill?prefill.prefill_tok_s:last?.prefill_tok_s));text("prefill-caption",prefill?"PREFILL / REQUEST":"PREFILL / LAST");
    gaugeValues={tok_s:speed,prefill_tok_s_mean:prefill?prefill.prefill_tok_s:last?.prefill_tok_s,gpu_util:hw.gpu_util,gpu_mem_used:hw.gpu_mem_used,gpu_temp:hw.gpu_temp,gpu_power:hw.gpu_power};
    text("console-power",fmt(hw.gpu_power)+" W");text("console-cpu",fmt(hw.cpu)+"%");text("console-ram",gib(hw.ram_used)+" GiB");text("console-disk",fmt(hw.disk_read_mb,1)+" MB/s");
    text("console-pcie",`PCIe ×${(hw.gpus||[]).map(g=>g.pcie_width||"—").join("/")||"—"} · RX ${fmt(hw.gpu_pcie_rx_mb,1)} MB/s`);
    $("console-pcie").title=(hw.gpus||[]).map(g=>`GPU ${g.index}: GEN${g.pcie_gen||"—"} ×${g.pcie_width||"—"}`).join(" · ");
    const capacity=expertCapacity(eng);
    text("console-experts",`${fmt(capacity.total)} EXPERTS SLOTS${capacity.aux?` (+${fmt(capacity.aux)} LITE)`:""}`);
    $("console-experts").title=`${fmt(capacity.main)} main + ${fmt(capacity.aux)} auxiliary3060Ti slots. Capacity includes duplicate cached copies; matrix counts unique experts.`;
    $("gpu-vitals").innerHTML=(hw.gpus||[]).map(g=>`<div class="gpu-vital"><span>GPU ${esc(g.index)}</span><div class="gpu-vital-meter"><i style="width:${clamp(Number(g.util)||0)}%"></i></div><span class="gpu-vital-util">${fmt(g.util)}%</span><span title="VRAM used in GiB">${gib(g.mem_used)}G</span><span>${fmt(g.temp)}°</span><span title="GPU power">${fmt(g.power)}W</span><span class="gpu-vital-rx">RX ${fmt(g.pcie_rx_mb,1)} MB/s</span></div>`).join("");
    text("console-connection",`METRICS ONLINE · ${m.slot_queued||0} QUEUED`);text("console-clock",new Date(m.time*1000).toLocaleTimeString([],{hour12:false}));
    $("req-all").setAttribute("aria-pressed",String(all));$("req-all").textContent=all?"Recent":`History ${fmt(m.requests_kept)}`;
    if(reconnect)addEvent({key:"online:"+m.time,time:m.time,type:"connection",tag:"ONLINE",tone:"normal",message:"Telemetry connection restored"});
    renderSlots(m.slots,eng.max_context||eng.context,m.slot_queued);renderMatrix(m.experts);drawGauges();logMetrics(m);
  }
  function unavailable(message) {
    if(!offline)addEvent({key:"offline:"+Date.now(),time:Date.now()/1000,type:"connection",tag:"OFFLINE",tone:"error",message});
    offline=true;cube?.visibility(false);panel.dataset.offline="true";cancelAnimationFrame(frame);frame=0;
    text("console-connection","TELEMETRY OFFLINE · LAST VALUES STALE");text("telemetry-status","OFFLINE");text("moe-live","UNAVAILABLE");
    text("console-decode","—");text("console-prefill","—");renderSlots(null,latest?.engine?.max_context||0,0);text("slot-summary","UNAVAILABLE");drawGauges();drawEvents();
  }
  function visibility(on) {
    visible=on;cube?.visibility(on&&!offline);cancelAnimationFrame(frame);frame=0;
    if(on&&latest&&!offline){renderMatrix(latest.experts);drawGauges();}
  }
  const observer=new ResizeObserver(()=>{
    rows=Math.max(1,Math.floor($("event-lines").clientHeight/(innerWidth<=700?19:innerHeight<=800?21:23)));
    if(visible&&latest&&!offline){renderMatrix(latest.experts);drawGauges();}drawEvents();
  });
  observer.observe(canvas.parentElement);observer.observe(gauges);observer.observe($("event-lines"));
  document.addEventListener("visibilitychange",()=>{if(document.hidden){cancelAnimationFrame(frame);frame=0;}else if(visible&&latest&&!offline){renderMatrix(latest.experts);drawGauges();}});
  reduced.addEventListener("change",()=>{cancelAnimationFrame(frame);frame=0;if(matrix)drawMatrix();});
  function cubeReady() {
    if(cube||!window.StrataExpertCube)return;
    cube=window.StrataExpertCube.create($("moe-cube"),(index)=>{
      if(!matrix)return;
      cursor={row:Math.floor(index/matrix.cols),col:index%matrix.cols};describeCell();
    });
    if(!cube)return;
    canvas.hidden=true;panel.querySelector(".residency-panel").classList.add("cube-enabled");
    text("moe-detail","Drag to orbit · scroll to zoom · arrows inspect");
    if(latest&&!offline)renderMatrix(latest.experts);
  }
  window.addEventListener("strata-cube-ready",cubeReady);
  cubeReady();
  window.StrataMonitor={render,unavailable,visibility};
})();
