import * as THREE from './three-r180.module.min.js';
import {EffectComposer} from './three-r180-EffectComposer.js';
import {RenderPass} from './three-r180-RenderPass.js';
import {UnrealBloomPass} from './three-r180-UnrealBloomPass.js';
import {OutputPass} from './three-r180-OutputPass.js';

// Receives the existing monitor poll; never polls or sends inference requests.
function create(canvas, inspect) {
  let renderer;
  try { renderer=new THREE.WebGLRenderer({canvas,alpha:true,antialias:true,powerPreference:'low-power'}); }
  catch { return null; }
  canvas.hidden=false;renderer.setPixelRatio(Math.min(devicePixelRatio||1,1.5));
  const scene=new THREE.Scene(),camera=new THREE.PerspectiveCamera(38,1,.1,40);
  scene.background=new THREE.Color(0x242b2c);renderer.setClearColor(0x101617,1);renderer.toneMapping=THREE.ACESFilmicToneMapping;renderer.toneMappingExposure=.8;
  const composer=new EffectComposer(renderer);composer.addPass(new RenderPass(scene,camera));
  const bloom=new UnrealBloomPass(new THREE.Vector2(1,1),.14,.12,1.2);composer.addPass(bloom);composer.addPass(new OutputPass());
  const volume=new THREE.Group();scene.add(volume);volume.rotation.set(.36,-.62,0);
  scene.add(new THREE.HemisphereLight(0xc4ecd8,0x13202a,1.2));
  const light=new THREE.DirectionalLight(0xc5ffe1,.8);light.position.set(3,5,6);scene.add(light);
  const rim=new THREE.DirectionalLight(0x65b9bd,.8);rim.position.set(-4,0,-4);scene.add(rim);
  const floor=new THREE.GridHelper(5.4,18,0x304f41,0x172c22);floor.position.y=-2.45;
  floor.material.transparent=true;floor.material.opacity=.26;scene.add(floor);
  const blueprint=new THREE.GridHelper(30,60,0x3c5b63,0x3c5b63);blueprint.rotation.x=Math.PI/2;blueprint.position.z=-4;
  blueprint.material.transparent=true;blueprint.material.opacity=.24;scene.add(blueprint);
  const palette=[0x718697,0x315b43,0xffc063,0x91efb9].map(c=>new THREE.Color(c));
  const cage=new THREE.LineSegments(new THREE.EdgesGeometry(new THREE.BoxGeometry(4.03,4.03,4.03)),
    new THREE.LineBasicMaterial({color:0x486e5b,transparent:true,opacity:.22}));volume.add(cage);
  const selection=new THREE.LineSegments(new THREE.EdgesGeometry(new THREE.BoxGeometry(1,1,1)),
    new THREE.LineBasicMaterial({color:0xe0fae8,depthTest:false}));volume.add(selection);selection.visible=false;
  const pointer=new THREE.Vector2(),ray=new THREE.Raycaster(),dummy=new THREE.Object3D();
  const reduced=matchMedia('(prefers-reduced-motion: reduce)'),button=document.getElementById('cube-rotate');
  const reset=document.getElementById('cube-zoom-reset'),summary=document.getElementById('cube-phase');
  let instances=[],mesh=null,matrix=null,target=[],current=[],alphas=null,active=null,waves=null,side=0,selected=0;
  let phase='idle',enabled=false,hover=false,focused=false,rotating=true,frame=0,lastRender=0,wave=0,zoom=1,drag=null,dirty=true;
  button.hidden=false;
  function resize() {
    const box=canvas.parentElement.getBoundingClientRect(),w=Math.max(1,box.width),h=Math.max(1,box.height);
    renderer.setSize(w,h,false);composer.setSize(w,h);camera.aspect=w/h;camera.position.z=10.2/zoom/Math.min(1,camera.aspect);
    camera.updateProjectionMatrix();dirty=true;wake();
  }
  function setZoom(value) {
    zoom=Math.max(.55,Math.min(2.5,value));reset.textContent=Math.round(zoom*100)+'%';canvas.dataset.zoom=zoom.toFixed(2);resize();
  }
  function rebuild(next) {
    if(mesh){volume.remove(mesh);mesh.geometry.dispose();mesh.material.dispose();}
    side=next.side;instances=next.positions.map((p,source)=>({...p,source})).concat(next.fillers);
    const geometry=new THREE.BoxGeometry(1,1,1);
    alphas=new THREE.InstancedBufferAttribute(new Float32Array(instances.length),1);geometry.setAttribute('cellOpacity',alphas);
    active=new THREE.InstancedBufferAttribute(new Float32Array(instances.length),1);geometry.setAttribute('cellActive',active);
    waves=new THREE.InstancedBufferAttribute(new Float32Array(instances.length),1);geometry.setAttribute('cellWave',waves);
    const material=new THREE.MeshStandardMaterial({transparent:true,depthWrite:false,metalness:.6,roughness:.28,emissive:0x062315,emissiveIntensity:.2});
    material.onBeforeCompile=shader=>{
      shader.vertexShader='attribute float cellOpacity; attribute float cellActive; attribute float cellWave; varying float vCellOpacity; varying float vCellActive; varying float vCellWave; varying vec3 vCellPoint;\n'+shader.vertexShader;
      shader.vertexShader=shader.vertexShader.replace('#include <begin_vertex>','#include <begin_vertex>\nvCellOpacity = cellOpacity; vCellActive = cellActive; vCellWave = cellWave; vCellPoint = position;');
      shader.fragmentShader='varying float vCellOpacity; varying float vCellActive; varying float vCellWave; varying vec3 vCellPoint;\n'+shader.fragmentShader;
      shader.fragmentShader=shader.fragmentShader.replace('#include <color_fragment>','#include <color_fragment>\n vec3 d = vec3(.5) - abs(vCellPoint);\n float edge = 1.0 - smoothstep(.015, .055, min(max(d.x,d.y), min(max(d.y,d.z),max(d.x,d.z))));\n diffuseColor.a *= mix(vCellOpacity, max(vCellOpacity, .22 + .2 * vCellActive + .12 * vCellWave), edge);');
      shader.fragmentShader=shader.fragmentShader.replace('#include <emissivemap_fragment>','#include <emissivemap_fragment>\n totalEmissiveRadiance += vColor * (edge * (1.2 + vCellActive * 2.0) + vCellActive * .15);\n totalEmissiveRadiance += vec3(.35, 1.0, .65) * vCellWave * (edge * .9 + .08);');
    };
    mesh=new THREE.InstancedMesh(geometry,material,instances.length);mesh.instanceMatrix.setUsage(THREE.DynamicDrawUsage);volume.add(mesh);
    for(let i=0;i<instances.length;i++) {
      const p=instances[i];dummy.position.set(p.x,p.y,p.z);dummy.scale.setScalar(4/side*.9);dummy.updateMatrix();
      mesh.setMatrixAt(i,dummy.matrix);mesh.setColorAt(i,palette[0]);
    }
    mesh.computeBoundingSphere();current=[];selection.visible=false;
  }
  function select(index,orient=false) {
    if(!matrix?.cells[index])return;
    selected=index;const p=matrix.positions[index];selection.position.set(p.x,p.y,p.z);selection.visible=true;
    if(orient)volume.rotation.set(.28,-Math.atan2(p.x,p.z),0);
    inspect(index);dirty=true;wake();
  }
  function update(next,state,on,mixed=false) {
    enabled=on;phase=state;matrix=next;
    summary.textContent=mixed?'PREFILL + DECODE / WAVE + LIVE ROUTING':state==='prefill'?'PREFILL / CELL WAVE':state==='decode'?'DECODE / LIVE ROUTING':'IDLE / CACHED RESIDENCY';
    canvas.parentElement.dataset.phase=state;canvas.dataset.mixed=String(!!mixed);
    if(!next){if(mesh)mesh.visible=false;visibility(false);return;}
    if(!mesh||current.length!==next.cells.length||mesh.count!==next.cells.length+next.fillers.length)rebuild(next);
    mesh.visible=true;
    target=next.cells.map(c=>({color:palette[c.state],alpha:c.state===0?.15:c.state===2?.24+.12*c.opacity:.1+.18*c.opacity,
      active:c.bins[3]/c.bins.reduce((a,b)=>a+b,0),size:.64}));
    if(!current.length)current=target.map(t=>({...t,color:t.color.clone()}));
    canvas.setAttribute('aria-label',`3D volume of ${next.total.toLocaleString()} experts, ${next.cells.length} real cube cells and ${next.fillers.length} decorative neighbor-following cells, ${next.group} experts per cell. Drag to orbit; scroll or plus/minus to zoom; arrow keys inspect; Space pauses rotation.`);
    Object.assign(canvas.dataset,{experts:next.total,cells:next.cells.length,decorative:next.fillers.length,rendered:instances.length,group:next.group,side:next.side,phase:state,geometry:'BoxGeometry'});
    dirty=true;wake();
  }
  function tick() {
    const now=performance.now();
    frame=0;if(!enabled||document.hidden||!matrix)return;
    let changing=false;
    if(now-lastRender>=33||dirty||reduced.matches) {
      // Reach 95% of the new state in about 750 ms; retarget from the current appearance.
      const elapsed=(now-(lastRender||now))/1000,dt=Math.min(.08,elapsed),blend=reduced.matches?1:1-Math.exp(-elapsed*4);
      wave=reduced.matches?0:wave+((phase==='prefill'?1:0)-wave)*(1-Math.exp(-elapsed*8));
      if(wave<.005&&phase!=='prefill')wave=0;
      const radius=(now/1000*1.05)%4.3,values=mesh.instanceMatrix.array;let min=1,max=0;
      for(let i=0;i<current.length;i++) {
        const c=current[i],t=target[i];c.color.lerp(t.color,blend);c.alpha+=(t.alpha-c.alpha)*blend;c.size+=(t.size-c.size)*blend;c.active+=(t.active-c.active)*blend;
        changing||=Math.abs(c.alpha-t.alpha)>.002||Math.abs(c.active-t.active)>.002||Math.abs(c.size-t.size)>.002||(c.color.r-t.color.r)**2+(c.color.g-t.color.g)**2+(c.color.b-t.color.b)**2>.00001;
      }
      for(let i=0;i<instances.length;i++) {
        const p=instances[i],c=current[p.source],radiusOfSource=matrix.positions[p.source].radius;
        const pulse=Math.exp(-Math.pow((radiusOfSource-radius)/.4,2)),size=4/side*Math.min(.92,c.size+wave*pulse*.3),offset=i*16;
        values[offset]=values[offset+5]=values[offset+10]=size;mesh.setColorAt(i,c.color);alphas.array[i]=c.alpha;active.array[i]=c.active;waves.array[i]=wave*pulse;
        min=Math.min(min,size);max=Math.max(max,size);
        if(i===selected)selection.scale.setScalar(size*1.13);
      }
      mesh.instanceMatrix.needsUpdate=true;mesh.instanceColor.needsUpdate=true;alphas.needsUpdate=true;active.needsUpdate=true;waves.needsUpdate=true;
      if(rotating&&!hover&&!focused&&!drag&&!reduced.matches)volume.rotation.y+=dt*.12;
      canvas.dataset.wave=wave>.01?'scaling-cells':'off';canvas.dataset.scaleRange=min.toFixed(3)+'/'+max.toFixed(3);canvas.dataset.transition=changing?'fading':'settled';
      composer.render();lastRender=now;dirty=false;
    } else {frame=requestAnimationFrame(tick);return;}
    if(!reduced.matches&&((rotating&&!hover&&!focused&&!drag)||changing||phase==='prefill'||wave>.005))frame=requestAnimationFrame(tick);
  }
  function wake(){if(enabled&&!document.hidden&&!frame){lastRender=performance.now();frame=requestAnimationFrame(tick);}}
  function visibility(on){enabled=on;cancelAnimationFrame(frame);frame=0;lastRender=0;dirty=true;if(on)wake();}
  function motionLabel(){button.disabled=reduced.matches;button.textContent=reduced.matches?'REDUCED MOTION':rotating?'AUTO ROTATE':'ROTATION PAUSED';button.setAttribute('aria-pressed',String(rotating&&!reduced.matches));}
  button.onclick=()=>{rotating=!rotating;motionLabel();dirty=true;wake();};motionLabel();
  document.getElementById('cube-zoom-in').onclick=()=>setZoom(zoom*1.2);
  document.getElementById('cube-zoom-out').onclick=()=>setZoom(zoom/1.2);
  reset.onclick=()=>{volume.rotation.set(.36,-.62,0);selection.visible=false;setZoom(1);};
  canvas.addEventListener('wheel',event=>{event.preventDefault();setZoom(zoom*Math.exp(-Math.max(-100,Math.min(100,event.deltaY))*.002));},{passive:false});
  canvas.addEventListener('pointerdown',event=>{drag={x:event.clientX,y:event.clientY};canvas.setPointerCapture(event.pointerId);});
  canvas.addEventListener('pointermove',event=>{
    if(!enabled||!mesh)return;
    if(drag){volume.rotation.y+=(event.clientX-drag.x)*.006;volume.rotation.x+=(event.clientY-drag.y)*.006;drag={x:event.clientX,y:event.clientY};dirty=true;wake();return;}
    const rect=canvas.getBoundingClientRect();pointer.set((event.clientX-rect.left)/rect.width*2-1,-(event.clientY-rect.top)/rect.height*2+1);
    ray.setFromCamera(pointer,camera);const hit=ray.intersectObject(mesh).find(hit=>hit.instanceId<matrix.cells.length);hover=!!hit;
    if(hit)select(hit.instanceId);else {selection.visible=false;dirty=true;wake();}
  });
  canvas.addEventListener('pointerup',()=>{drag=null;dirty=true;wake();});
  canvas.addEventListener('pointercancel',()=>{drag=null;dirty=true;wake();});
  canvas.addEventListener('pointerleave',()=>{hover=false;selection.visible=false;dirty=true;wake();});
  canvas.addEventListener('focus',()=>{focused=true;dirty=true;wake();});
  canvas.addEventListener('blur',()=>{focused=false;dirty=true;wake();});
  canvas.addEventListener('keydown',event=>{
    if(!matrix)return;
    if(event.code==='Space'){event.preventDefault();button.click();return;}
    if(['+','=','-'].includes(event.key)){event.preventDefault();setZoom(zoom*(event.key==='-'?1/1.2:1.2));return;}
    const moves={ArrowLeft:-1,ArrowRight:1,ArrowUp:-side,ArrowDown:side};if(!(event.key in moves))return;
    event.preventDefault();select(Math.max(0,Math.min(matrix.cells.length-1,selected+moves[event.key])),true);
  });
  document.addEventListener('visibilitychange',()=>{cancelAnimationFrame(frame);frame=0;lastRender=0;if(!document.hidden){dirty=true;wake();}});
  reduced.addEventListener('change',()=>{cancelAnimationFrame(frame);frame=0;motionLabel();dirty=true;wake();});
  new ResizeObserver(resize).observe(canvas.parentElement);resize();
  canvas.addEventListener('webglcontextlost',event=>{event.preventDefault();visibility(false);summary.textContent='3D CONTEXT LOST / RELOAD TO RESTORE';});
  return {update,visibility};
}
window.StrataExpertCube={create};window.dispatchEvent(new Event('strata-cube-ready'));
