/* 
   debug.js — developer tooling for ZONE STORM RACING GX
   ---------------------------------------------------------------------------
   The debug bar, the diagnostic text modal and the entry point to the
   Algorithm Tool, lifted out of drive.js.

   WHY THIS IS A SEPARATE FILE
   None of this ships value to a player: it is inspection and cheat tooling.
   Keeping it in drive.js meant every change to a debug button risked touching
   the 780 KB file that also contains the renderer and the physics — and it
   made that file harder to read for anyone looking for the game.
   Removing it from race.html removes the entire feature, cleanly.

   HOW IT CONNECTS
   Everything here talks to the game through the public window objects —
   DriveMode, DriveDebug, WorldTour, UpgradeShop, WorldMap — and never reaches
   into engine internals. Where the shell needs to call back in (the L3 x10
   toggle), the functions are published on window, exactly as the inline
   onclick= handlers in race.html require.

   The Algorithm Tool itself stays in drive.js: it reads the live generator
   parameters as the track is built, so it is genuinely part of the engine
   rather than an inspector of it. This file only opens it.
    */

(function(global){
'use strict';

/* Rolling error log, shown in the diagnostic. Installed here so a failure that
   happens before the modal is ever opened is still captured. */
var _dbErrors=[];
/* Accessor into drive.js's shell state. Every key the tooling reads must exist
   in BOTH the real bridge and this fallback — a missing one throws only when
   that particular button is pressed, which is how three separate crashes
   reached the browser. dbgtest.js now exercises every entry point to catch
   them here instead. */
var _BRIDGE_FALLBACK={
  screen:function(){return null;},   demoOn:function(){return false;},
  gpActive:function(){return false;},gpRace:function(){return 0;},
  winActive:function(){return false;},
  contSeed:function(){return 0;},    contSel:function(){return 0;},
  carIdx:function(){return 0;},      leagueIdx:function(){return 0;},
  tourActive:function(){return false;}, wmOpen:function(){return false;},
  gpTimes:function(){return [];},    setGpTimes:function(){},
  setGpActive:function(){},
  league:function(){return null;},   setLeague:function(){},
  LEAGUES:function(){return [];},    CARS:function(){return [];},
  leagueSeeds:function(){return [];},recPut:function(){},
  showLeagueWin:function(){},        showScreen:function(){},
  fmt:function(m){return String(m);},gpuSnow:function(){return null;}
};
function B(){
  var b=global.ZSDebugBridge;
  if(!b)return _BRIDGE_FALLBACK;
  /* Any key the real bridge forgot falls back rather than throwing. */
  for(var k in _BRIDGE_FALLBACK)
    if(typeof b[k]!=='function')b[k]=_BRIDGE_FALLBACK[k];
  return b;
}
try{
  global.addEventListener('error',function(e){
    _dbErrors.push((e.message||'?')+' @'+(e.filename||'?')+':'+(e.lineno||0));
    if(_dbErrors.length>50)_dbErrors.shift();
  });
}catch(e){}

/* Live frame timing, sampled continuously so the modal can show real numbers
   rather than a frozen snapshot from whenever it was opened. */
var _liveFps=0,_liveFrameMs=0,_lfLast=0,_lfCount=0,_lfAcc=0;
(function _liveTick(ts){
  try{ requestAnimationFrame(_liveTick); }catch(e){ return; }
  if(_lfLast){
    var d=ts-_lfLast;
    _lfAcc+=d;_lfCount++;
    if(_lfAcc>=400){
      _liveFrameMs=_lfAcc/_lfCount;
      _liveFps=1000/Math.max(0.001,_liveFrameMs);
      _lfAcc=0;_lfCount=0;
      var m=document.getElementById('zs-db-textmodal');
      if(m&&m.style.display==='block')_dbRenderText();
    }
  }
  _lfLast=ts;
})(0);

/* L3 x10 opens the bar. Counted here rather than in the shell's pad poll so
   the whole feature lives in one file. */
var _l3Count=0,_l3Last=0;
(function watchL3(){
  try{ requestAnimationFrame(watchL3); }catch(e){ return; }
  try{
    var pads=navigator.getGamepads?navigator.getGamepads():[];
    for(var i=0;i<pads.length;i++){
      var p=pads[i]; if(!p||!p.connected)continue;
      var down=!!(p.buttons[10]&&p.buttons[10].pressed);
      if(down&&!_l3Prev){
        var now=performance.now();
        if(now-_l3Last>1500)_l3Count=0;
        _l3Last=now;_l3Count++;
        if(_l3Count>=10){_l3Count=0;_dbBtns();_dbToggle();}
      }
      _l3Prev=down;
      return;
    }
  }catch(e){}
})();
var _l3Prev=false;

function _dbCollapse(){
  const b=document.getElementById('zs-db');
  b.classList.toggle('collapsed');
  document.getElementById('zs-db-title').textContent=
    (b.classList.contains('collapsed')?'▶ DEBUG MODE':'▼ DEBUG MODE');
}

function _dbToggle(){
  /* (22) Toggle via a body class so CSS specificity cannot re-show it. */
  try{ document.body.classList.toggle('zs-debug-on'); }catch(e){}
  const el=document.getElementById('zs-db');
  el.style.display=(el.style.display==='block')?'none':'block';
}

/* Toggles the motion anomaly detector and reports on stop. Wired to a button
   because the situations worth watching — a demo shot, a crowded first corner —
   are ones the player is in the middle of and cannot pause to type into a
   console. */
var _dbMWOn=false;
function _dbMotionWatch(){
  try{
    _dbMWOn=!_dbMWOn;
    /* No showDbMsg in this scope — a bare identifier would throw a
       ReferenceError rather than short-circuit, which is the same trap that
       produced three crashes earlier in this project. The watcher announces
       itself on the console anyway. */
    if(_dbMWOn){ window.ZS_watch(); }
    else window.ZS_watch(false);
  }catch(e){ try{console.warn('motion watch unavailable',e);}catch(_){ } }
}
try{ window._dbMotionWatch=_dbMotionWatch; }catch(e){}

function _dbBtns(){
  const B=(l,f)=>'<button class="zs-db-btn" onclick="'+f+'">'+l+'</button>';
  document.getElementById('zs-db-btns').innerHTML=
    B('Debug Text','_dbShowText()')+
    B('Copy Debug Text','_dbCopyText()')+
    B('Max Speed','try{DriveDebug.maxSpeed()}catch(e){}')+
    B('Goal','try{DriveDebug.skipToEnd()}catch(e){}')+
    /* Algorithm Tool button removed from the bar (its logic remains in drive.js).
       Best Courses and Trash Track Analysis keep feeding the generator. */
    /* (11) Racing-specific test tools. */
    B('League Win','_dbWinLeague()')+
    B('GndPlane','_dbToggleGP()')+
    B('Viewpoint','_dbSwitchView()')+
    /* Live readout of WHICH viewpoint is active. Cycling blind through 35
       entries makes it impossible to report which one shows a fault. */
    '<span id="zs-db-view" style="color:#39ff14;font-weight:bold;'
      +'padding:0 8px;white-space:nowrap;text-shadow:0 0 6px #39ff1466">CHASE</span>'+
    /* (item 49) Motion watcher. Labelled by what it FINDS rather than by what
       it is, so it is obvious what to press when something looks wrong. */
    B('Watch Blink/Jump','_dbMotionWatch()')+
    B('CPU Drive','_dbAutoPlay()')+
    /* Edge-case sentinel: arm it, play/watch the demo, then read the report. */
    B('Diag Start','try{console.log(ZSDiag.start())}catch(e){}')+
    B('Diag Report','_dbDiagReport()')+
    B('Diag Record','try{console.log(ZSDiag.record(true))}catch(e){}')+
    B('Diag Timeline','_dbDiagTimeline()')+
    B('Unlock Random WT Track','_dbUnlockRandom()')+
    B('Unlock Continent Tracks','_dbUnlockContinent()')+
    /* (7) Save-state tools. */
    B('Add Funds','_dbAddFunds()')+
    B('Reset Cities','_dbLockAll()')+
    B('Unlock WT','_dbUnlockAll()')+
    B('Reset Lap Times','_dbResetTimes()')+
    B('Add Turbo','_dbAddTurbo()')+
    B('Reset Shop','_dbResetShop()')+
    '<span id="zs-db-demoshot" style="color:#39ff14;font-size:7px;white-space:nowrap;margin-left:8px"></span>';
}

/* Update the demo shot number display every frame. Called from the engine's
   frame loop via ZS_dbUpdateDemoShot(n). */
var _dbLastShot=-1;
function _dbUpdateDemoShot(n){
  try{
    var el=document.getElementById('zs-db-demoshot');
    if(!el)return;
    if(n==null||n<0){el.textContent='';_dbLastShot=-1;return;}
    if(n!==_dbLastShot){
      _dbLastShot=n;
      el.textContent='Demo Shot: '+n;
    }
  }catch(e){}
}
global.ZS_dbUpdateDemoShot=_dbUpdateDemoShot;

function _dbResetShop(){
  try{
    if(window.UpgradeShop&&window.UpgradeShop.resetMachine){
      window.UpgradeShop.resetMachine();
      /* resetMachine now zeroes credits inside world.js, nothing extra needed here */
      window.DriveMode.notify('\u21ba MACHINE RESET TO DEFAULT',true);
    }
  }catch(e){console.warn(e);}
}

function _dbAddTurbo(){
  try{
    if(window.DriveDebug&&window.DriveDebug.addTurbo)window.DriveDebug.addTurbo();
    else if(window.DriveMode&&window.DriveMode.addTurbo)window.DriveMode.addTurbo();
    window.DriveMode.notify('\u26a1 +1 TURBO',true);
  }catch(e){console.warn(e);}
}

function _dbAddFunds(){
  try{
    /* (6) Writing straight to localStorage did nothing visible: UpgradeShop
       holds its state in memory and only reads storage once, so the running
       instance never saw the change. Going through its own API keeps the live
       object and the save in step. */
    if(window.UpgradeShop&&window.UpgradeShop.addCredits){
      window.UpgradeShop.addCredits(1000000);
    }
    if(typeof CS!=='undefined'&&CS)CS.funds=(CS.funds||0)+1000000;
    window.DriveMode.notify('\u2b50 +1,000,000 CREDITS',true);
  }catch(e){console.warn(e);}
}

function _dbLockAll(){
  try{
    var W=window.WorldTour; if(!W)return;
    var raw=localStorage.getItem('zsgx_worldtour_v1');
    var o=raw?JSON.parse(raw):null;
    if(!o||!o.home){ window.DriveMode.notify('NO WORLD TOUR SAVE',false); return; }
    /* Home stays unlocked — locking everything including the start would leave
       the mode unplayable. */
    /* (1) THE WILDCARDS SURVIVED THE RESET.
       Clearing `unlocked` alone left `unlockedPrefixes` intact, and a single
       prefix stands for an entire continent — so everything unlocked in bulk
       stayed unlocked and the counter never fell. Both must be cleared. */
    o.unlocked={};
    o.unlocked[o.home.id]=1;
    o.unlockedPrefixes=[];
    o.completed={};
    localStorage.setItem('zsgx_worldtour_v1',JSON.stringify(o));
    /* (2) Drop WorldTour's in-memory copy, or it will persist the pre-reset
       state on the next write and undo this entirely. */
    try{ if(W.invalidateSave)W.invalidateSave(); }catch(e){}
    location.reload();
  }catch(e){console.warn(e);}
}

function _dbUnlockAll(){
  /* (6) THIS SILENTLY UNLOCKED A FRACTION.
     The old version walked only the first 6 countries of each continent, and
     within those only 4 states and 4 municipalities — a few thousand of the
     81,742 tracks — while reporting success. It also wrote one key per
     settlement, which exceeds the storage quota long before finishing.
     Every continent is now unlocked with a wildcard prefix, processed one at a
     time with the progress reported between them so the page keeps painting. */
  try{
    var W=global.WorldTour;
    if(!W||!W.unlockContinent){ _dbNotify('WORLD TOUR NOT LOADED',false); return; }
    var conts=W.continents().filter(function(c){return c.countries>0;});
    var bar=_dbProgress('UNLOCKING ALL TRACKS');
    var i=0,done=0,failed=false;
    (function step(){
      if(i>=conts.length){
        bar.done();
        if(failed){
          _dbNotify('\u2717 STORAGE FULL \u00b7 UNLOCK NOT SAVED',false);
          return;
        }
        _dbNotify('\u2713 UNLOCKED '+done.toLocaleString()+' TRACKS WORLDWIDE',true);
        return;
      }
      var c=conts[i++];
      bar.set(i/conts.length, c.name+'  \u00b7  '+done.toLocaleString()+' so far');
      W.unlockContinent(c.id,null,function(total,saved){
        if(saved===false)failed=true;
        done+=total;
        /* Yield between continents so the browser can repaint the bar. */
        setTimeout(step,0);
      });
    })();
  }catch(e){ console.warn(e); _dbNotify('UNLOCK FAILED \u00b7 '+e.message,false); }
}
function _dbResetTimes(){
  try{
    localStorage.removeItem('zsgx_records_v1');
    var raw=localStorage.getItem('zsgx_worldtour_v1');
    if(raw){ var o=JSON.parse(raw); o.best={};
      localStorage.setItem('zsgx_worldtour_v1',JSON.stringify(o));
    /* (2) Drop WorldTour's in-memory copy, or it will persist the pre-reset
       state on the next write and undo this entirely. */
    try{ if(W.invalidateSave)W.invalidateSave(); }catch(e){} }
    window.DriveMode.notify('\u21ba LAP TIMES RESET',true);
  }catch(e){console.warn(e);}
}

function _dbDiagShow(t){
  try{
    var el=document.getElementById('zs-db-textbody');
    if(el){ el.textContent=t; document.getElementById('zs-db-textmodal').style.display='block'; }
    else console.log(t);
  }catch(e){ console.error('diag show failed',e); }
}
global._dbDiagShow=_dbDiagShow;

function _dbDiagReport(){
  try{
    _dbDiagShow(global.ZSDiag?global.ZSDiag.full():'ZSDiag not loaded');
  }catch(e){ console.error('diag report failed',e); }
}
global._dbDiagReport=_dbDiagReport;

function _dbWinLeague(){
  try{
    /* This read LEAGUES()[0] and threw the result away, so the fallback it
       exists for never happened and leagueSeeds() below was handed a null
       league. Actually select it. */
    if(!B().league())B().setLeague(B().LEAGUES()[0]);
    B().leagueSeeds(B().league()).map(function(sd){
      var t=70000+Math.random()*40000;
      B().recPut(sd,t,t/3);
      return {seed:sd,total:t,best:t/3};
    });
    B().setGpActive(false);
    try{window.DriveMode.exit();}catch(e){}
    B().showLeagueWin();
  }catch(e){console.warn(e);}
}

/* Named handler, not an inline expression. B() emits onclick="..." so any
   double quote in the body closes the attribute early — that is the
   "Unexpected end of input" this button was throwing. Every other entry in
   this bar calls a function for the same reason. */
/* Same fault as GndPlane had: double quotes inside an onclick attribute
   close it early. Wrapped in a function so the quotes never reach the HTML. */
function _dbDiagTimeline(){
  try{ _dbDiagShow(global.ZSDiag?global.ZSDiag.timeline('drawX',10):'ZSDiag not loaded'); }
  catch(e){ console.error('timeline failed',e); }
}
global._dbDiagTimeline=_dbDiagTimeline;

function _dbToggleGP(){
  try{
    /* Default is OFF, so the first press turns it ON. */
    var on=(global.ZS_GROUNDPLANE!==true);
    global.ZS_GROUNDPLANE=on;
    var lbl=on?'ground plane ON':'ground plane OFF';
    if(global.DriveMode&&global.DriveMode.toast)global.DriveMode.toast(lbl);
    console.log('[ZS] '+lbl);
  }catch(e){ console.error('GndPlane toggle failed',e); }
}
global._dbToggleGP=_dbToggleGP;

function _dbSwitchView(){
  try{
    _dbView=(_dbView+1)%DEMO_VIEWS.length;
    var v=DEMO_VIEWS[_dbView];
    window.DriveMode.setCamera(v.cam);
    window.DriveMode.setView(v);
    if(window.DriveMode.toast)window.DriveMode.toast(v.name);
    var _lbl=document.getElementById('zs-db-view');
    if(_lbl)_lbl.textContent=v.name+' ('+(_dbView+1)+'/'+DEMO_VIEWS.length+')';
  }catch(e){}
}

function _dbAutoPlay(){
  try{
    var on=window.DriveDebug.attract(true);
    if(on&&window.DriveMode&&window.DriveMode.showHandoff)window.DriveMode.showHandoff();
  }catch(e){}
}

function _dbUnlockRandom(){
  try{
    var W=window.WorldTour; if(!W)return;
    var cs=W.continents().filter(function(c){return c.countries>0;});
    var c=cs[Math.floor(Math.random()*cs.length)];
    var co=W.countriesOf(c.id);   co=co[Math.floor(Math.random()*co.length)];
    var st=W.statesOf(co.id);     st=st[Math.floor(Math.random()*st.length)];
    var m=W.municipalitiesOf(st.id); m=m[Math.floor(Math.random()*m.length)];
    var ss=W.settlementsOf(m.id);
    var pick=ss[Math.floor(Math.random()*ss.length)];
    W.unlock(pick.id);
  }catch(e){console.warn(e);}
}

function _dbUnlockContinent(){
  /* (9) Uses the wildcard unlock so the write is one small entry rather than
     tens of thousands of keys, and walks the tree in slices with a progress
     bar so the page never freezes. */
  try{
    var W=global.WorldTour, M=global.WorldMap;
    if(!W||!W.unlockContinent){ _dbNotify('WORLD TOUR NOT LOADED',false); return; }
    var contId=(M&&M.state.path[0]&&M.state.path[0].id)||
               (M&&M.state.items[M.state.sel]&&M.state.items[M.state.sel].id);
    if(!contId){ _dbNotify('OPEN A CONTINENT FIRST',false); return; }
    contId=String(contId).split('/')[0];
    var bar=_dbProgress('UNLOCKING '+contId.toUpperCase());
    W.unlockContinent(contId,
      function(frac,soFar){ bar.set(frac,soFar.toLocaleString()+' tracks'); },
      function(total,saved){
        bar.done();
        /* (4) Report a failed WRITE distinctly from a completed walk: the bar
           finishing said nothing about whether the result persisted, which is
           how a quota failure looked like success. */
        if(saved===false){
          _dbNotify('\u2717 STORAGE FULL \u00b7 UNLOCK NOT SAVED',false);
          return;
        }
        _dbNotify('\u2713 UNLOCKED '+total.toLocaleString()+' TRACKS IN '+contId.toUpperCase(),true);
      });
  }catch(e){ console.warn(e); _dbNotify('UNLOCK FAILED \u00b7 '+e.message,false); }
}

/* Simple full-width progress bar, used by any long debug operation. */
function _dbProgress(label){
  var el=document.getElementById('zs-db-progress');
  if(!el){
    el=document.createElement('div');
    el.id='zs-db-progress';
    document.body.appendChild(el);
  }
  el.style.display='block';
  el.innerHTML='<div class="p-label"></div><div class="p-track"><div class="p-fill"></div></div>';
  var lab=el.querySelector('.p-label'), fill=el.querySelector('.p-fill');
  lab.textContent=label;
  return {
    set:function(frac,note){
      fill.style.width=Math.round(Math.max(0,Math.min(1,frac))*100)+'%';
      lab.textContent=label+'   '+(note||'');
    },
    done:function(){ setTimeout(function(){ el.style.display='none'; },700); }
  };
}
function _dbNotify(msg,ok){
  try{ if(global.DriveMode&&global.DriveMode.notify)global.DriveMode.notify(msg,ok); }
  catch(e){ console.log(msg); }
}
function _dbRace(){try{window.DriveMode.start(0,0);}catch(e){}}

function _dbReset(){try{window.DriveMode.exit();}catch(e){}B().showScreen('title');}

function _dbBuildText(){
  const L=[],pad=(k,v)=>L.push(String(k).padEnd(24)+' '+v);
  const sec=t=>{L.push('');L.push('── '+t+' ── ');};
  L.push('ZONE STORM RACING GX — FULL DIAGNOSTIC');
  L.push(new Date().toISOString());

  sec('SHELL');
  pad('screen',B().screen()); pad('demo running',B().demoOn());
  pad('grand prix active',B().gpActive()); pad('race index',B().gpRace());
  pad('league',B().league()?B().league().name+' ('+B().league().id+')':'-');
  pad('league seeds',B().league()?B().leagueSeeds(B().league()).join(', '):'-');
  pad('win screen',B().winActive());
  /* Guarded: the diagnostic must render even before a car has been chosen,
     or the whole modal fails on a single missing field. */
  const c=B().CARS()[B().carIdx()]||null;
  pad('machine',c?(c.name+' / '+c.id):'(none selected)');
  pad('  stats',c?('power '+c.power+'  speed '+c.speed+
      '  weight '+c.weight+'  accel '+c.accel):'-');
  pad('  design',JSON.stringify((c&&c.design||{})));
  pad('viewport',innerWidth+'x'+innerHeight+' dpr '+(devicePixelRatio||1));
  pad('userAgent',navigator.userAgent);

  sec('STORED RECORDS');
  try{
    /* recLoad lives inside drive.js's shell block and is block-scoped, so the
       bare identifier is not visible here. */
    const r=(window.ZS_recLoad?window.ZS_recLoad():
             (window.DriveShell&&window.DriveShell.recLoad?window.DriveShell.recLoad():{}));
    if(r.leagues)for(const k in r.leagues)pad('  league '+k,B().fmt(r.leagues[k]));
    if(r.tracks){let n=0;for(const k in r.tracks){if(n++>=20){pad('  ...','more');break;}
      pad('  track '+k,'total '+B().fmt(r.tracks[k].total)+'  lap '+B().fmt(r.tracks[k].bestLap));}}
    if(!r.leagues&&!r.tracks)pad('records','none stored');
  }catch(e){pad('records','error '+e.message);}

  sec('RACE ENGINE STATE');
  try{
    const st=window.DriveDebug&&window.DriveDebug._state?window.DriveDebug._state():null;
    if(st)for(const k in st)pad('  '+k,JSON.stringify(st[k]));
    else pad('engine','inactive');
  }catch(e){pad('engine','error '+e.message);}

  sec('INPUT');
  try{
    const pads=navigator.getGamepads?navigator.getGamepads():[];let any=false;
    for(const p of pads){
      if(!p||!p.connected)continue;any=true;
      pad('pad',p.id); pad('  mapping',p.mapping||'-');
      const ang=(x,y)=>{let d=Math.atan2(-y,x)*180/Math.PI;if(d<0)d+=360;return d.toFixed(1);};
      const lx=p.axes[0]||0,ly=p.axes[1]||0,rx=p.axes[2]||0,ry=p.axes[3]||0;
      pad('  L-STICK','x '+lx.toFixed(3)+'  y '+ly.toFixed(3)+
        '  angle '+ang(lx,ly)+'\u00b0  dist '+Math.min(1,Math.hypot(lx,ly)).toFixed(3));
      pad('  R-STICK','x '+rx.toFixed(3)+'  y '+ry.toFixed(3)+
        '  angle '+ang(rx,ry)+'\u00b0  dist '+Math.min(1,Math.hypot(rx,ry)).toFixed(3));
      pad('  all axes',p.axes.map(a=>a.toFixed(3)).join(', '));
      pad('  buttons',p.buttons.map((b,i)=>b.pressed?i:null).filter(v=>v!==null).join(',')||'none');
      pad('  triggers',(p.buttons[6]?p.buttons[6].value.toFixed(2):'-')+' / '+
                       (p.buttons[7]?p.buttons[7].value.toFixed(2):'-'));
    }
    if(!any)pad('pad','none connected');
  }catch(e){pad('pad','error '+e.message);}

  sec('GPU');
  try{
    var _pix=innerWidth*innerHeight*(devicePixelRatio||1)*(devicePixelRatio||1);
    var _f=Math.max(1,_liveFps);
    pad('resolution',innerWidth+'x'+innerHeight+' @'+(devicePixelRatio||1)+
        'x   ('+(_pix/1e6).toFixed(2)+' MPix)');
    pad('fill rate',((_pix*_f)/1e6).toFixed(1)+' MPix/s');
    pad('bandwidth (est)',((_pix*_f*8)/1e9).toFixed(2)+' GB/s');
  }catch(e){}
  /* GPU Snow */
  try{
    var _sn=B()&&B().gpuSnow?B().gpuSnow():null;
    if(_sn&&_sn.stats){
      var _st=_sn.stats();
      pad('GPU Snow particles',_st.active.toLocaleString()+' / '+_st.max.toLocaleString()+'  (1 draw call)');
      var _stride=8;
      var _mb=(_st.max*_stride*4)/1048576;
      pad('GPU Snow VBO',_mb.toFixed(2)+' MB  ('+_st.max.toLocaleString()+' x '+_stride+' floats)');
    } else pad('GPU Snow','inactive');
  }catch(e){ pad('GPU Snow','unavailable'); }
  /* GPU Rain */
  try{
    var _rn=B()&&B().gpuRain?B().gpuRain():null;
    if(_rn&&_rn.stats){
      var _rs=_rn.stats();
      pad('GPU Rain particles',_rs.active.toLocaleString()+' / '+_rs.max.toLocaleString()+'  (1 draw call)');
      var _rstride=7;
      var _rmb=(_rs.max*_rstride*4)/1048576;
      pad('GPU Rain VBO',_rmb.toFixed(2)+' MB  ('+_rs.max.toLocaleString()+' x '+_rstride+' floats)');
      pad('GPU Rain intensity',_rs.intensity.toFixed(2)+'  squall '+_rs.squall.toFixed(2));
    } else pad('GPU Rain','inactive');
  }catch(e){ pad('GPU Rain','unavailable'); }
  /* GPU Sand */
  try{
    var _sd=B()&&B().gpuSand?B().gpuSand():null;
    if(_sd&&_sd.stats){
      var _ss=_sd.stats();
      pad('GPU Sand particles',_ss.active.toLocaleString()+' / '+_ss.max.toLocaleString()+'  (1 draw call)');
      var _sstride=7;
      var _smb=(_ss.max*_sstride*4)/1048576;
      pad('GPU Sand VBO',_smb.toFixed(2)+' MB  ('+_ss.max.toLocaleString()+' x '+_sstride+' floats)');
      pad('GPU Sand intensity',(_ss.intensity!=null?_ss.intensity.toFixed(2):'?')+
          '  turbulence '+(_ss.turb!=null?_ss.turb.toFixed(2):'?'));
    } else pad('GPU Sand','inactive');
  }catch(e){ pad('GPU Sand','unavailable'); }
  /* GPU Buildings (buildings.js) */
  try{
    var _bCache=window.Buildings?'loaded':'NOT LOADED';
    var _bDrawn=0;
    try{_bDrawn=(window.DriveDebug&&window.DriveDebug._state)?
      (window.DriveDebug._dm&&window.DriveDebug._dm._bldJsDrawn)||0:0;}catch(e){}
    try{if(window.DriveMode&&window.DriveMode.diag)
      _bDrawn=window.DriveMode.diag().bldJsDrawn||0;}catch(e){}
    pad('GPU Buildings',_bCache);
    pad('GPU Buildings drawn/frame',_bDrawn);
    pad('GPU Buildings cache',window.Buildings?window.Buildings._cacheSize?
      window.Buildings._cacheSize():'(check _c.size)':'N/A');
  }catch(e){ pad('GPU Buildings','unavailable'); }

  sec('PERFORMANCE');
  pad('fps',_liveFps.toFixed(1)+'   (frame '+_liveFrameMs.toFixed(2)+' ms)');
  pad('frame budget','16.67 ms @60  \u00b7  '+((_liveFrameMs/16.67)*100).toFixed(0)+'% used');
  try{
    if(performance.memory){
      var mu=performance.memory.usedJSHeapSize/1048576;
      var mt=performance.memory.totalJSHeapSize/1048576;
      var ml=performance.memory.jsHeapSizeLimit/1048576;
      pad('heap used',mu.toFixed(1)+' MB');
      pad('heap allocated',mt.toFixed(1)+' MB   (headroom '+(mt-mu).toFixed(1)+' MB)');
      pad('heap limit',ml.toFixed(0)+' MB   ('+((mu/ml)*100).toFixed(1)+'% consumed)');
    } else pad('heap','unavailable (Chrome only)');
    var _segB=0;
    try{ _segB=(window.DriveMode.diag().segments||0)*520; }catch(e){}
    pad('track segments',(_segB/1048576).toFixed(2)+' MB (est)');
    try{ if(navigator.deviceMemory)pad('device RAM',navigator.deviceMemory+' GB'); }catch(e){}
    try{ if(navigator.hardwareConcurrency)pad('CPU threads',navigator.hardwareConcurrency); }catch(e){}
  }catch(e){}

  sec('TRACK CORE');
  try{
    const d=window.DriveMode&&window.DriveMode.diag?window.DriveMode.diag():null;
    if(!d){pad('diag','unavailable');}
    else{
      pad('SEED',d.seed); pad('track name',d.trackName); pad('character',d.character);
      pad('segments',d.segments); pad('track length',d.trackLength);
      pad('lap',d.lap+' / '+d.laps); pad('rivals',d.rivals);
      pad('speed',d.speed+'  ('+d.kmh+' km/h)');
      pad('power',d.power+' / '+d.powerCap); pad('turbo charges',d.turboCharges);
      pad('position x/z',d.x+' / '+d.z);
      pad('camera mode',d.camMode); pad('cam dist',d.camDist);
      /* Orbit axes — all seven values the demo/cinematic camera can move on.
         The old display only showed az, zoom and surface pitch; the other four
         (lift, orbitPitch, roll, Z-traverse, X-offset) were invisible. */
      pad('orbit az',d.orbitAz+' rad');
      pad('orbit zoom',d.orbitZoom);
      pad('orbit lift',d.orbitLift);
      pad('orbit pitch',d.orbitPitch);
      pad('orbit roll',d.orbitRoll+' rad');
      pad('orbit Z-trav',d.orbitZ+' segs');
      pad('orbit X-off',d.orbitX);
      pad('surface pitch',d.pitch);
      pad('horizon Y',d.horizonY!=null?d.horizonY+' px':'—');
      pad('car road pin K',d.carRoadK);
      pad('car road Y',d.carRoadY!=null?d.carRoadY+' px':'—');
      pad('car scale K',d.carScaleK);
      pad('car road K smooth',d.carRoadKSm);
      L.push('');L.push('  FEATURES PRESENT');
      const f=d.features||{};const fk=Object.keys(f).filter(k=>f[k]);
      pad('    count',fk.length);
      fk.forEach(k=>pad('    '+k,f[k]));
      sec('TRACK PARAMETERS');
      L.push('  FULL PARAMETER SET ('+Object.keys(d.params||{}).length+')');
      const ps=d.params||{};
      Object.keys(ps).sort().forEach(k=>pad('    '+k,ps[k]));

      /* (1) Theme and scenery are their own tile: they answer a different
         question from track geometry and were unreadable interleaved. */
      sec('THEME & SCENERY');
      /* (4) Name the background effects actually running, so a striking sky can
         be identified without reading the raw flags. */
      pad('  BACKGROUND FX',(function(){
        try{
          var d2=window.DriveMode.diag();
          var t2=d2.theme||{}, out=[];
          if(t2.aurora)out.push('AURORA');
          var F2=(theme&&theme.skyFx)||{};
          var NAMES={steve:'STEVE',airglow:'AIRGLOW',pillars:'LIGHT PILLARS',
            zodiacal:'ZODIACAL LIGHT',noctilucent:'NOCTILUCENT CLOUDS',
            gegenschein:'GEGENSCHEIN',volcanic:'VOLCANIC TWILIGHT',
            sprites:'SPRITES',crownFlash:'CROWN FLASH'};
          for(var k2 in NAMES)if(F2[k2])out.push(NAMES[k2]);
          /* (2) Name the specific fluid mode rather than a bare "FLUID", so
             the diagnostic says which of the four is running. */
          try{
            if(window.WaterFX&&window.WaterFX.active())
              out.push('FLUID ('+(window.WaterFX.mode()||'?')+')');
          }catch(e){}
          if(t2.snow)out.push('SNOW ('+(theme.snowClass||'normal')+')');
          if(t2.rain)out.push('RAIN');
          if(t2.heavyFog)out.push('HEAVY FOG');
          return out.length?out.join(', '):'none';
        }catch(e){return 'error';}
      })());
      if(d.theme)for(const tk in d.theme)pad('  '+tk,JSON.stringify(d.theme[tk]));
      L.push('');L.push('  ZONES');
      (d.zones||[]).forEach((z,i)=>pad('    zone '+i,JSON.stringify(z)));
      L.push('');L.push('  EFFECTS');
      if(d.effects)for(const ek in d.effects)pad('    '+ek,JSON.stringify(d.effects[ek]));
    }
  }catch(e){pad('diag','error '+e.message);}

  return L.join('\n');
}

function _dbShowText(){
  _dbRenderText();
  document.getElementById('zs-db-textmodal').style.display='block';
}

function _dbRenderText(){
  var raw=_dbBuildText();
  var lines=raw.split('\n');
  var tiles=[],cur=null;
  for(var i=0;i<lines.length;i++){
    var L=lines[i];
    var m=L.match(/^\u2500\u2500\s*(.+?)\s*\u2500\u2500/);
    if(m){ cur={title:m[1],rows:[]}; tiles.push(cur); continue; }
    if(!cur){ continue; }
    if(!L.trim())continue;
    // "key<spaces>value" -> two columns; anything else spans both.
    /* (5) The key was capped at ~24 characters, so long names such as
       `_feat_mirrorstraight` never matched and the row fell through to the
       single-column branch — the value was present in the copied text but
       invisible in the tiles. The cap is removed; the two-space separator is
       what distinguishes key from value. */
    var mm=L.match(/^(\s*\S.*?)\s{2,}(.+)$/);
    if(mm)cur.rows.push([mm[1].trim(),mm[2].trim()]);
    else cur.rows.push([L.trim(),'']);
  }
  var html=tiles.map(function(t){
    return '<div class="dbg-tile"><h4>'+esc(t.title)+'</h4><table>'+
      t.rows.map(function(r){
        return r[1]!==''
          ? '<tr><td>'+esc(r[0])+'</td><td>'+esc(r[1])+'</td></tr>'
          : '<tr><td colspan="2">'+esc(r[0])+'</td></tr>';
      }).join('')+'</table></div>';
  }).join('');
  /* (2) PRESERVE SCROLL POSITION.
     The live refresh replaces innerHTML wholesale, which destroys every
     tile's scrollTop — so any attempt to read the bottom of the track
     parameters was yanked back to the top a few times a second.
     Positions are captured by tile title before the rewrite and restored
     after, keyed by title rather than index so a changing section count
     cannot misalign them. */
  var _keep={};
  try{
    var _old=document.getElementById('zs-db-textbody').querySelectorAll('.dbg-tile');
    for(var _i=0;_i<_old.length;_i++){
      var _h=_old[_i].querySelector('h4');
      if(_h)_keep[_h.textContent]=_old[_i].scrollTop;
    }
  }catch(e){}
  var _body=document.getElementById('zs-db-textbody');
  var _outerTop=_body?_body.scrollTop:0;
  _body.innerHTML=html||('<pre>'+esc(raw)+'</pre>');
  try{
    var _neu=_body.querySelectorAll('.dbg-tile');
    for(var _j=0;_j<_neu.length;_j++){
      var _h2=_neu[_j].querySelector('h4');
      if(_h2&&_keep[_h2.textContent]!=null)_neu[_j].scrollTop=_keep[_h2.textContent];
    }
    _body.scrollTop=_outerTop;
  }catch(e){}
}

function esc(t){
  return String(t).replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;');
}

function _dbCopyText(){
  const t=_dbBuildText();
  try{navigator.clipboard.writeText(t);}catch(e){
    const ta=document.createElement('textarea');ta.value=t;document.body.appendChild(ta);
    ta.select();try{document.execCommand('copy');}catch(e2){}ta.remove();}
}

/* Live stick readout inside the bar. */
setInterval(function(){
  /* #zs-db is hidden by `#zs-db{display:none!important}` and revealed by
     `body.zs-debug-on #zs-db{display:flex!important}` — both stylesheet rules,
     so the element's INLINE style.display is always '' and the old
     `bar.style.display==='none'` test never once matched. The result was a
     navigator.getGamepads() call plus a DOM text write ~7x a second for the
     whole session, writing into #zs-stick-dbg which race.css hides anyway. */
  if(!document.body||!document.body.classList.contains('zs-debug-on'))return;
  var el=document.getElementById('zs-stick-dbg');
  if(!el)return;
  try{
    var pads=navigator.getGamepads?navigator.getGamepads():[];
    for(var i=0;i<pads.length;i++){
      var p=pads[i]; if(!p||!p.connected)continue;
      var ang=function(x,y){var d=Math.atan2(-y,x)*180/Math.PI;if(d<0)d+=360;return d.toFixed(0);};
      var lx=p.axes[0]||0,ly=p.axes[1]||0,rx=p.axes[2]||0,ry=p.axes[3]||0;
      el.textContent='L '+lx.toFixed(2)+','+ly.toFixed(2)+'  '+ang(lx,ly)+'\u00b0\n'+
                     'R '+rx.toFixed(2)+','+ry.toFixed(2)+'  '+ang(rx,ry)+'\u00b0';
      return;
    }
    el.textContent='no pad';
  }catch(e){}
},140);

/* Published for the inline onclick= handlers in race.html, which resolve
   against window and cannot see module scope. */
[['_dbBtns',_dbBtns],['_dbToggle',_dbToggle],['_dbCollapse',_dbCollapse],
 ['_dbShowText',_dbShowText],['_dbRenderText',_dbRenderText],
 ['_dbCopyText',_dbCopyText],['_dbRace',_dbRace],['_dbReset',_dbReset],
 ['_dbAddFunds',_dbAddFunds],['_dbLockAll',_dbLockAll],
 ['_dbUnlockAll',_dbUnlockAll],['_dbResetTimes',_dbResetTimes],
 ['_dbAddTurbo',_dbAddTurbo],['_dbResetShop',_dbResetShop],
 ['_dbWinLeague',_dbWinLeague],['_dbSwitchView',_dbSwitchView],
 ['_dbAutoPlay',_dbAutoPlay],['_dbUnlockRandom',_dbUnlockRandom],
 ['_dbUnlockContinent',_dbUnlockContinent]
].forEach(function(p){ try{ global[p[0]]=p[1]; }catch(e){} });

/* Build the button row as soon as the markup exists. */
try{
  if(document.readyState==='complete'||document.readyState==='interactive')_dbBtns();
  else global.addEventListener('DOMContentLoaded',function(){_dbBtns();});
}catch(e){}

})(typeof window!=='undefined'?window:globalThis);

/* 
   SELF-TEST HARNESS   (was smoke-test.js — items 13 and 14)
   
   Folded in from the standalone file. It lives here because everything it
   inspects is already reachable from the debug bridge, and a separate file
   meant a second set of references to keep in step with drive.js — which is
   exactly what went stale last time.

   Two ways to run it:

     node debug.js              headless, under a DOM stub (see the tail)
     ZS_selfTest()              in the browser console, against the live game

   WHAT IT CHECKS, AND WHY THOSE THINGS
   Every check here exists because that class of bug actually shipped:

     * CROSS-SCOPE REFERENCES. drive.js is several IIFEs plus a shell block, and
       `function` declarations inside a block are block-scoped. Three separate
       crashes came from calling something across that boundary — `dm is not
       defined`, `_hideWeatherLayers is not defined`, `now is not defined`. The
       bridge probes call every published entry point so a broken one fails
       here instead of when a player presses a button.

     * TRACK GENERATION INVARIANTS. Generated tracks had unjumpable gaps, and
       an infinite loop in brake-zone placement froze the browser with no
       error. Both are cheap to assert over a batch of seeds and impossible to
       spot by reading.

     * PLAYER / RIVAL INTERACTION. Contact damage was frame-rate dependent,
       rivals could exceed the player's own top speed, and the collision box
       and sprite width drifted apart. These are pure arithmetic and can be
       checked exactly.

     * MENUS. The exit-to-title path has broken four separate ways. It is
       driven directly rather than reasoned about.

   WHAT IT DOES NOT CHECK
   Conditional draw branches. A stub canvas reaches drawRival only when a rival
   is on screen AND boosting, so the `now is not defined` bug in that function
   would NOT have been caught here. Stated plainly so a passing run is not read
   as more coverage than it is.
    */
(function(global){
'use strict';

function runSelfTest(opts){
  var quiet=!!(opts&&opts.quiet);
  var pass=0, fail=0, notes=[];
  function ok(name,cond,detail){
    if(cond){pass++; if(!quiet)console.log('  ok    '+name);}
    else{fail++; notes.push(name+(detail?('  -> '+detail):''));
         console.warn('  FAIL  '+name+(detail?('  -> '+detail):''));}
  }
  function section(t){ if(!quiet)console.log('\n['+t+']'); }

  /* ── 1. MODULES AND BRIDGE  */
  section('modules');
  ['GPUSnow','GPURain','GPUSand','Mountains','TunnelFX','WaterFX']
    .forEach(function(g){ ok('fx.js publishes '+g, !!global[g]); });
  ['WorldTour','WorldMap','WorldRewards','UpgradeShop','WorldTourFlow']
    .forEach(function(g){ ok('world.js publishes '+g, !!global[g]); });
  /* FX_DITHER_PNG is a top-level `const` in fx.js, which is script-scoped and
     therefore NOT a property of window — checking global.FX_DITHER_PNG fails
     even when the constant is present and working. Its consumer is the fluid
     simulation inside the same file, which resolves it lexically. So the test
     asserts what is observable: that fx.js loaded and published the module
     that uses it. */
  ok('fluid module loaded (consumes embedded dither texture)', !!global.WaterFX);

  section('bridge entry points');
  [['DriveMode.seed',function(){return global.DriveMode.seed();}],
   ['DriveMode.isActive',function(){return global.DriveMode.isActive();}],
   ['DriveMode.resetDemoClock',function(){return global.DriveMode.resetDemoClock();}],
   ['ZS_hideWeatherLayers',function(){return global.ZS_hideWeatherLayers();}],
   ['ZS_continueOpen',function(){return global.ZS_continueOpen();}],
   ['ZS_recLoad',function(){return global.ZS_recLoad();}],
   ['ZS_gpuSnow',function(){return global.ZS_gpuSnow();}],
   ['ZS_gpuRain',function(){return global.ZS_gpuRain();}]
  ].forEach(function(p){
    var e=null;
    try{ p[1](); }catch(err){ e=err; }
    ok(p[0]+' callable', !e, e&&(e.constructor.name+': '+e.message));
  });

  /* ── 2. MENUS  */
  section('menus / exit paths');
  [['ZS_onExitToTitle',global.ZS_onExitToTitle],
   ['ZS_returnToTitle',global.ZS_returnToTitle]].forEach(function(p){
    var e=null;
    try{ if(typeof p[1]==='function')p[1](); else throw new Error('not a function'); }
    catch(err){ e=err; }
    ok(p[0]+' runs', !e, e&&e.message);
  });
  /* After a return to title the title screen must be the visible one, whatever
     the teardown did — this is the invariant four separate bugs violated. */
  try{
    var t=document.getElementById('scr-title');
    var gp=document.getElementById('scr-gp');
    /* Under a DOM stub classList may be a no-op, so a missing class proves
       nothing. Only assert when the element genuinely tracks classes. */
    var _tracks=!!(t&&t.classList&&typeof t.classList.contains==='function'&&
                   (function(){try{t.classList.add('__probe');
                     var v=t.classList.contains('__probe');
                     t.classList.remove('__probe');return v;}catch(e){return false;}})());
    if(_tracks)ok('title active after exit', t.classList.contains('active'));
    else if(!quiet)console.log('  skip  title active after exit (stub classList)');
    ok('machine-select hidden after exit', !gp||!gp.classList.contains('active'));
  }catch(e){ ok('screen state readable', false, e.message); }

  /* ── 3. TRACK GENERATION  */
  section('track generation');
  var DM=global.DriveMode, seeds=[696242372,4217510562,11565775,1347589815,
                                  2856766732,3744275796,125656505,556784891];
  var built=0, gapFails=0, shortTracks=0, hung=false;
  var t0=(global.performance&&performance.now)?performance.now():Date.now();
  seeds.forEach(function(sd){
    try{
      if(!DM||!DM.buildTrackForTest){return;}
      var segs=DM.buildTrackForTest(sd);
      if(!segs||!segs.length){shortTracks++;return;}
      built++;
      /* Every gap run must have a real ramp (>=2 segments) before it, or the
         hole is lethal with no counterplay. */
      for(var i=0;i<segs.length;i++){
        if(!segs[i]||!segs[i].gap)continue;
        var j=i; while(j<segs.length&&segs[j]&&segs[j].gap)j++;
        var r=0;
        for(var k=i-1;k>=0&&k>i-9;k--){
          if(segs[k]&&segs[k].ramp)r++;
          else if(r>0)break; else if(i-k>3)break;
        }
        if(r<2)gapFails++;
        i=j;
      }
    }catch(e){ shortTracks++; }
  });
  var t1=(global.performance&&performance.now)?performance.now():Date.now();
  if(t1-t0>15000)hung=true;
  if(built>0){
    ok('all gaps are jumpable', gapFails===0, gapFails+' unjumpable gap run(s)');
    ok('generation terminates', !hung, 'took '+Math.round(t1-t0)+'ms');
    ok('no empty tracks', shortTracks===0, shortTracks+' failed to build');
    /* Road width must not step between neighbouring segments, or the two
       visibly fail to meet — see the smoothing pass in buildTrack. */
    var wJump=0,wMax=0;
    try{
      for(var si=0;si<seeds.length;si++){
        var sg=DM.buildTrackForTest(seeds[si]);
        if(!sg)continue;
        for(var k=0;k<sg.length-1;k++){
          var dd=Math.abs((sg[k].narrowAmt||0)-(sg[k+1].narrowAmt||0));
          if(dd>0.05)wJump++;
          if(dd>wMax)wMax=dd;
        }
      }
    }catch(e){}
    /* Every ramp must be launchable. A run of one segment fails _isRealRamp,
       so the flag is there and the jump is not — which reads as "ramps do
       nothing" rather than as a bug. */
    var rampBad=0,rampTot=0;
    try{
      for(var ri2=0;ri2<seeds.length;ri2++){
        var rs=DM.buildTrackForTest(seeds[ri2]);
        if(!rs)continue;
        for(var q=0;q<rs.length;q++){
          if(!rs[q].ramp)continue;
          var e2=q; while(e2<rs.length&&rs[e2].ramp)e2++;
          rampTot++;
          var okr=false;
          for(var m=q;m<e2;m++)if(rs[m]._rampOK)okr=true;
          if(!okr)rampBad++;
          q=e2;
        }
      }
    }catch(e){}
    ok('every ramp can launch', rampBad===0,
       rampBad+' of '+rampTot+' ramp run(s) too short to launch');
    ok('road width is continuous', wJump===0,
       wJump+' step(s), worst '+wMax.toFixed(3));
  } else {
    notes.push('track generation not exercised (no buildTrackForTest hook)');
    if(!quiet)console.log('  skip  track generation (no test hook exposed)');
  }

  /* ── 4. PLAYER / RIVAL INTERACTION  */
  /* ── 3b. CULLING HORIZONS (item 20) 
     Every "not rendered on time" report has turned out to be a horizon that
     moved, not a machine that was too slow. These assert that the horizon is
     stable across conditions and that nothing culls nearer than the road. */
  section('culling');
  var H=null;
  try{ H=(global.DriveMode&&global.DriveMode.horizons)?global.DriveMode.horizons():null; }catch(e){}
  if(H){
    ok('horizon holds across quality',
       H.spanPct<=0.40,
       'varies '+(H.spanPct*100).toFixed(0)+'% between best and worst conditions');
    ok('worst-case horizon is usable',
       H.worst>=200, H.worst+' segments');
    ok('props reach at least as far as the road',
       H.propHorizon>=H.best, H.propHorizon+' vs road '+H.best);
    ok('prop fade ends at the queue cutoff',
       H.fadeMatchesCutoff===true,
       'a prop dropped before its fade reaches zero pops');
  } else if(!quiet)console.log('  skip  culling (DriveMode.horizons unavailable)');

  section('demo shots');
  var S=null;
  try{ S=(global.DriveMode&&global.DriveMode.demoShots)?global.DriveMode.demoShots():null; }catch(e){}
  if(S){
    ok('shot and rate tables are the same length', S.shots===S.rates,
       S.shots+' shots vs '+S.rates+' rates');
    ok('full shot set present', S.shots>=100, S.shots+' shots');
  } else if(!quiet)console.log('  skip  demo shots (hook unavailable)');

  section('motion detector');
  ok('detector is present', typeof global.ZS_watch==='function');
  ok('sample hook is present', typeof global.ZS_motionSample==='function');
  if(typeof global.ZS_watch==='function'){
    /* Feed it a known teleport and a known-clean run: a detector that cannot
       catch a synthetic bug will not catch a real one, and one that fires on
       clean input is worse than none. */
    var _w=console.warn, _l=console.log, quietN=0;
    console.warn=function(){}; console.log=function(){};
    global.ZS_watch();
    for(var f=0;f<40;f++)global.ZS_motionSample('t',{x:(f%2?100:900),y:400,w:100,
      alpha:1,roadX:0,rail:1.03,seg:f,fresh:true,speed:0.9,airborne:false});
    var bad=global.ZS_watchReport(); global.ZS_watch(false);
    global.ZS_watch();
    for(var g=0;g<200;g++)global.ZS_motionSample('t',{x:640+Math.sin(g/30)*40,y:400,
      w:100,alpha:1,roadX:0.2,rail:1.03,seg:g,fresh:true,speed:0.9,airborne:false});
    var good=global.ZS_watchReport(); global.ZS_watch(false);
    console.warn=_w; console.log=_l;
    ok('detects a synthetic teleport', Object.keys(bad.counts).length>0);
    ok('silent on clean motion', Object.keys(good.counts).length===0,
       Object.keys(good.counts).join(','));
  }

  section('demo camera reach');
  var BR=null;
  try{ BR=(global.DriveMode&&global.DriveMode.backReach)?global.DriveMode.backReach():null; }catch(e){}
  if(BR){
    /* A shot whose Z-traverse exceeds the back-projection range leaves the
       player's segment unprojected, and the car is then drawn from stale
       coordinates — it blinks between two positions. */
    ok('every shot projects back as far as the car',
       !BR.worst, BR.worst?('shot '+BR.worst.shot+' traverses '+BR.worst.ztrav+
       ' but projects back only '+BR.worst.back):'');
  } else if(!quiet)console.log('  skip  demo camera reach (hook unavailable)');

  section('demo formation');
  var F=null;
  try{ F=(global.DriveMode&&global.DriveMode.demoFormation)?global.DriveMode.demoFormation():null; }catch(e){}
  if(F){
    /* Lane and depth must not correlate, or the pack sits on a diagonal — and
       a diagonal viewed from behind is a single-file line, which is what makes
       the cars bunch and jitter. */
    /* n=2 is exempt: with two cars any arrangement is perfectly correlated,
       so the assertion is meaningless rather than failing. */
    ok('lane does not correlate with depth', F.n<3||F.corr<0.6,
       'correlation '+F.corr.toFixed(3)+' (1.0 = perfect diagonal)');
    ok('lanes remain evenly spaced', F.minLaneGap>0.15,
       'closest pair '+F.minLaneGap.toFixed(3));
  } else if(!quiet)console.log('  skip  demo formation (hook unavailable)');

  section('player / rival');
  var C=null;
  try{ C=(global.DriveMode&&global.DriveMode.tuning)?global.DriveMode.tuning():null; }catch(e){}
  if(C){
    /* Sprite width and collision box must scale together, or contact happens
       where nothing is touching. */
    ok('hit box matches sprite width',
       Math.abs((C.boxXHard/C.boxX)-(0.42/0.30))<0.02,
       'boxXHard/boxX = '+(C.boxXHard/C.boxX).toFixed(3));
    /* A rival must never be able to outrun the player's own ceiling. */
    ok('rival ceiling <= player ceiling',
       C.rivalCeil<=C.playerCeil+1e-6,
       C.rivalCeil.toFixed(0)+' vs '+C.playerCeil.toFixed(0));
    /* Contact damage is a rate per second, not per frame — it must not depend
       on refresh rate. */
    ok('contact damage is dt-scaled', C.contactDmgIsRate===true);
    /* Machine stats must stay on their shared budget, or one car is strictly
       better than the others. */
    ok('car stat budgets equal', C.carBudgets.every(function(b){return b===C.carBudgets[0];}),
       C.carBudgets.join(','));
  } else {
    if(!quiet)console.log('  skip  tuning constants (DriveMode.tuning unavailable)');
  }

  section('result');
  console.log(fail?(fail+' FAILED, '+pass+' passed'):(pass+' checks passed'));
  if(notes.length&&!quiet)notes.forEach(function(n){console.log('  note: '+n);});
  return {pass:pass,fail:fail,notes:notes};
}

global.ZS_selfTest=runSelfTest;

/* Headless entry: `node debug.js` sets up a DOM stub, loads the game files and
   runs the suite. In a browser this block does nothing. */
if(typeof module!=='undefined'&&module.exports&&typeof window==='undefined'){
  module.exports={runSelfTest:runSelfTest};
}

})(typeof window!=='undefined'?window:globalThis);

/* 
   MOTION ANOMALY DETECTOR   (item 49)
   
   Finding "the car blinks" has cost several rounds each time, because the
   symptom is a description and the cause is always a number. This turns the
   description into the number.

   ARM IT:   ZS_watch()        start, log to console as anomalies occur
             ZS_watch(false)   stop and print a summary
             ZS_watchReport()  summary without stopping

   WHAT IT WATCHES, AND WHY EACH ONE
   Every check here corresponds to a bug that actually shipped:

     TELEPORT   screen x or y jumps further in one frame than the machine
                could possibly have moved. This is the signature of a sprite
                placed from stale coordinates — the player-blink bug, where the
                car alternated between a fresh position and one left over from
                whichever frame last projected its segment.

     OSCILLATION  position reverses direction repeatedly within a short window.
                A car settling after a bump reverses once; one caught between
                two forces reverses every frame. Counting sign changes
                separates the two, which eyeballing cannot.

     SIZE JUMP  drawn width changes by more than a fraction in one frame. The
                rival-scale bug: projected width diverges as a car approaches
                the camera plane, so it ballooned and shrank frame to frame.

     BLINK      alpha or presence flips between frames. A sprite that is drawn,
                then not drawn, then drawn again is blinking in the literal
                sense, and is usually a visibility gate on an oscillating value.

     OFF ROAD   |roadX| exceeds the rail for this segment. Reported with what
                the machine was doing — speed, airborne, which segment — so the
                cause is identifiable rather than just the fact.

     STALE      the segment the sprite was positioned from was not projected
                this frame. This is the upstream cause of TELEPORT and is worth
                reporting separately: it says WHY the jump happened.

   THRESHOLDS are expressed in fractions of the viewport or of the car's own
   width, not pixels, so they hold at any resolution. They are deliberately
   loose enough that normal racing never trips them — the detector is useless
   if it cries wolf, and a quiet run has to mean something.
    */
(function(global){
'use strict';

var MW={
  on:false, prev:{}, hist:{}, counts:{}, samples:0, started:0,
  /* One frame at 60fps at full speed moves the car a few percent of the
     screen. 25% is far beyond anything legitimate and well short of a
     wrap-around, so it catches teleports without flagging fast corners. */
  jumpX:0.25,        // fraction of viewport width
  jumpY:0.22,
  sizeJump:0.45,     // fraction of previous drawn width
  oscWindow:12,      // frames
  oscFlips:6,        // reversals within the window to count as oscillation
  logCap:40          // stop spamming after this many of each kind
};

function _vw(){ try{ return innerWidth||1280; }catch(e){ return 1280; } }
function _vh(){ try{ return innerHeight||720; }catch(e){ return 720; } }

function _bump(kind,who,detail){
  MW.counts[kind]=(MW.counts[kind]||0)+1;
  if(MW.counts[kind]<=MW.logCap){
    try{ console.warn('[motion] '+kind+'  '+who+'  '+detail); }catch(e){}
    if(MW.counts[kind]===MW.logCap){
      try{ console.warn('[motion] '+kind+': further reports suppressed'); }catch(e){}
    }
  }
}

function sample(who,s){
  if(!MW.on||!s)return;
  MW.samples++;
  var vw=_vw(), vh=_vh();
  var p=MW.prev[who];
  var h=MW.hist[who]||(MW.hist[who]={dx:[],seen:0});

  /* OFF ROAD — checked first because it does not need a previous frame, and
     because a car off the road usually explains everything after it. */
  if(s.rail!=null&&s.roadX!=null&&!s.airborne){
    var over=Math.abs(s.roadX)-s.rail;
    if(over>0.02){
      _bump('OFF-ROAD',who,
        'x='+s.roadX.toFixed(3)+' rail='+s.rail.toFixed(3)+
        ' over by '+over.toFixed(3)+'  seg='+s.seg+
        ' speed='+(s.speed*100).toFixed(0)+'%');
    }
  }
  /* STALE — the upstream cause of most teleports. */
  if(s.fresh===false)_bump('STALE-SEGMENT',who,'seg='+s.seg+' was not projected this frame');

  if(p){
    var dx=(s.x-p.x)/vw, dy=(s.y-p.y)/vh;
    if(Math.abs(dx)>MW.jumpX)
      _bump('TELEPORT-X',who,'moved '+(dx*100).toFixed(0)+'% of screen in one frame'+
        (s.fresh===false?' (segment was stale)':''));
    if(Math.abs(dy)>MW.jumpY)
      _bump('TELEPORT-Y',who,'moved '+(dy*100).toFixed(0)+'% of screen vertically in one frame');

    if(p.w>0.5){
      var dw=(s.w-p.w)/p.w;
      if(Math.abs(dw)>MW.sizeJump)
        _bump('SIZE-JUMP',who,'width '+p.w.toFixed(0)+' -> '+s.w.toFixed(0)+
          '  ('+(dw*100).toFixed(0)+'% in one frame)');
    }
    var a0=(p.alpha==null?1:p.alpha), a1=(s.alpha==null?1:s.alpha);
    if(Math.abs(a1-a0)>0.5)
      _bump('BLINK-ALPHA',who,'alpha '+a0.toFixed(2)+' -> '+a1.toFixed(2));

    /* OSCILLATION — count direction reversals in a sliding window. */
    h.dx.push(dx);
    if(h.dx.length>MW.oscWindow)h.dx.shift();
    if(h.dx.length===MW.oscWindow){
      var flips=0;
      for(var i=1;i<h.dx.length;i++){
        if(Math.abs(h.dx[i])<1e-6)continue;
        if(h.dx[i]*h.dx[i-1]<0)flips++;
      }
      if(flips>=MW.oscFlips&&!h.oscLogged){
        h.oscLogged=true;
        var amp=Math.max.apply(null,h.dx.map(Math.abs))*vw;
        _bump('OSCILLATION',who,flips+' direction reversals in '+MW.oscWindow+
          ' frames, amplitude '+amp.toFixed(1)+'px  (vibrating, not moving)');
      } else if(flips<2) h.oscLogged=false;   // settled; allow re-reporting
    }
  }
  /* PRESENCE — a body that stops being drawn and comes back. Tracked by frame
     number rather than by a flag, so it catches a sprite skipped by an early
     return as well as one drawn at zero alpha. */
  h.seen=MW.samples;
  MW.prev[who]={x:s.x,y:s.y,w:s.w,alpha:s.alpha,frame:MW.samples};
}

/* Presence gaps are found by sweeping, because a body that is not drawn cannot
   report that it was not drawn. Called from the report. */
function _presenceReport(){
  var out=[];
  for(var k in MW.prev){
    var gap=MW.samples-(MW.prev[k].frame||0);
    if(gap>2)out.push(k+' last drawn '+gap+' frames ago');
  }
  return out;
}

function watch(on){
  if(on===false){
    MW.on=false;
    report();
    return false;
  }
  MW.on=true; MW.prev={}; MW.hist={}; MW.counts={}; MW.samples=0;
  MW.started=(global.performance&&performance.now)?performance.now():Date.now();
  try{ console.log('[motion] watching. ZS_watch(false) to stop and summarise.'); }catch(e){}
  return true;
}

function report(){
  var now=(global.performance&&performance.now)?performance.now():Date.now();
  var secs=Math.max(0.001,(now-MW.started)/1000);
  var keys=Object.keys(MW.counts);
  try{
    console.log('[motion] '+MW.samples+' samples over '+secs.toFixed(1)+'s');
    if(!keys.length)console.log('[motion] no anomalies detected');
    else keys.forEach(function(k){
      console.log('   '+k.padEnd(16)+MW.counts[k]+
        '   ('+(MW.counts[k]/secs).toFixed(1)+'/s)');
    });
    var pr=_presenceReport();
    if(pr.length)pr.forEach(function(l){ console.log('   PRESENCE  '+l); });
  }catch(e){}
  return {samples:MW.samples,seconds:secs,counts:MW.counts};
}

global.ZS_motionSample=sample;
global.ZS_watch=watch;
global.ZS_watchReport=report;
/* Thresholds exposed so a specific hunt can be narrowed without an edit. */
global.ZS_watchTune=MW;

})(typeof window!=='undefined'?window:globalThis);

/* 
   DEBUG BAR: CONTROLLER NAVIGATION   (item 52)
   
   The bar was mouse-only. On a pad — which is how the game is actually played
   — every debug tool was unreachable without putting the controller down.

   LB / RB step through the buttons, A activates the focused one, B hands focus
   back. Focus is CLAIMED by the first LB or RB press rather than being on by
   default: while the bar has focus, A must not also confirm on the title
   screen behind it, and taking focus only on an explicit press means the pad
   behaves normally until the player asks for the bar.

   The focus ring is drawn by a class rather than an inline style so it can be
   themed with the rest of the panel, and because inline styles on a button
   that is re-rendered would be lost on the next _dbBtns() call.
    */
(function(global){
'use strict';

var DBN={ active:false, idx:0 };

function _btns(){
  try{
    var host=document.getElementById('zs-db-btns');
    if(!host)return [];
    return Array.prototype.slice.call(host.querySelectorAll('button'));
  }catch(e){ return []; }
}

function _paint(){
  var bs=_btns();
  for(var i=0;i<bs.length;i++){
    if(DBN.active&&i===DBN.idx)bs[i].classList.add('zs-db-focus');
    else bs[i].classList.remove('zs-db-focus');
  }
  /* Keep the focused button in view: the bar scrolls horizontally and a
     focused button off screen is the same as no focus at all. */
  try{
    if(DBN.active&&bs[DBN.idx]&&bs[DBN.idx].scrollIntoView)
      bs[DBN.idx].scrollIntoView({block:'nearest',inline:'nearest'});
  }catch(e){}
}

/* True when the debug bar element is shown on screen.
   LB / RB must never consume the press while the bar is hidden. */
function _dbVisible(){
  try{
    var el=document.getElementById('zs-db');
    return !!(el&&el.style.display==='block');
  }catch(e){ return false; }
}

/* Returns true when the press was consumed. */
function dbNav(btn){
  var bs=_btns();
  if(!bs.length)return false;
  if(btn==='lb'||btn==='rb'){
    if(!_dbVisible()){
      DBN.active=false;
      return false;
    }
    if(!DBN.active){ DBN.active=true; DBN.idx=0; }
    else DBN.idx=(DBN.idx+(btn==='rb'?1:-1)+bs.length)%bs.length;
    _paint();
    return true;
  }
  if(!DBN.active)return false;          // A and B only ours once focused
  if(btn==='a'){
    try{ bs[DBN.idx].click(); }catch(e){}
    return true;
  }
  if(btn==='b'){
    DBN.active=false; _paint();
    return true;
  }
  return false;
}

global.ZS_dbNav=dbNav;
global.ZS_dbNavActive=function(){ return DBN.active; };

/* 
   DEMO CAR OUT-OF-BOUNDS DIAGNOSTIC
   
   Call ZS_demoCarDiag() once per frame while the demo is running.
   It reads the player's current state from DriveDebug, compares it against
   the road half-width for the current segment, and logs a structured record
   to the console whenever a violation is detected.

   To enable: open the browser console and run:
       window._demoCarDiagOn = true;
   To disable:
       window._demoCarDiagOn = false;

   Each console.warn entry looks like:
     [DEMO OOB] t=12.34s shot=5 P.x=1.14 rail=1.03 over=0.11
       narrow=0.00 squeeze=false seg=234 speed=0.91*MAX
       last_push: "MAGNET" | aim=-0.34 demoAim=-0.22 ...

   Copy the console output and paste it back so the root cause can be
   traced from the data. */
(function _installDemoCarDiag(){
  var _lastShot=-1,_lastPushTag='unknown',_violCount=0,_frameN=0;
  var _MAX_LOG=120;   // stop after this many entries to avoid console flood

  function _tag(label){ _lastPushTag=label; }
  /* Hook: call this from any code that moves P.x in demo mode so the
     diagnostic knows what caused the last push. */
  global.ZS_demoPushTag=_tag;

  function _tick(){
    if(!window._demoCarDiagOn)return;
    try{
      var db=window.DriveDebug;
      if(!db)return;
      var st=db._state&&db._state();
      if(!st||!st.attract)return;   // only in demo mode
      _frameN++;

      var P=st.P;
      if(!P)return;

      var seg=st.seg&&st.seg(P.z);
      if(!seg)return;

      var narrow=Math.min(seg.squeeze?0.80:0.42,(seg.narrowAmt||0));
      var rail=1.03*(1-narrow);
      var over=Math.abs(P.x)-rail;

      /* Shot index from demoClock */
      var shot=st.demoClock!==undefined?Math.floor(st.demoClock/7):-1;
      if(shot!==_lastShot){ _lastShot=shot; _violCount=0; }

      if(over>0.04){
        if(_violCount>=_MAX_LOG)return;
        _violCount++;
        console.warn(
          '[DEMO OOB]',
          't='+(st.demoClock!=null?st.demoClock.toFixed(2):'?')+'s',
          'shot='+shot,
          'P.x='+P.x.toFixed(3),
          'rail='+rail.toFixed(3),
          'over='+over.toFixed(3),
          '\n  narrow='+narrow.toFixed(3),
          'squeeze='+!!(seg.squeeze),
          'seg='+(seg.index||'?'),
          'speed='+(st.speed!=null?(st.speed/st.maxSpeed).toFixed(2):'?')+'*MAX',
          '\n  last_push="'+_lastPushTag+'"',
          'aim='+(P._demoSteerTo!=null?P._demoSteerTo.toFixed(3):'?'),
          'demoAim='+(P._demoAim!=null?P._demoAim.toFixed(3):'?'),
          'rx='+(P._rx!=null?P._rx.toFixed(3):'?'),
          '\n  railBounce='+(P._railBounce!=null?P._railBounce.toFixed(3):'?'),
          'railJitter='+(P._railJitter!=null?P._railJitter.toFixed(3):'?')
        );
      } else if(_frameN%180===0&&window._demoCarDiagVerbose){
        /* Periodic clean-state report every 3 seconds for context. */
        console.log(
          '[DEMO OK]',
          't='+(st.demoClock!=null?st.demoClock.toFixed(1):'?')+'s',
          'shot='+shot,
          'P.x='+P.x.toFixed(3)+'/'+rail.toFixed(3),
          'margin='+(rail-Math.abs(P.x)).toFixed(3)
        );
      }
    }catch(ex){
      if(_frameN<5)console.error('[DEMO DIAG ERROR]',ex);
    }
  }

  /* Chain the sentinel onto the hook the engine already calls every frame,
     so ZSDiag needs no separate wiring inside drive.js. Disabled it is one
     boolean test. */
  global.ZS_demoCarDiag=function(){
    try{ _tick.apply(null,arguments); }catch(e){}
    try{ if(global.ZSDiag)global.ZSDiag.tick(); }catch(e){}
  };
})();

})(typeof window!=='undefined'?window:globalThis);

/* ════════════════════════════════════════════════════════════════════════════
   ZSDiag — EDGE-CASE SENTINEL

   Every class of bug below is one that actually reached a build of this game
   and survived because nothing was watching for it. The existing debug tools
   answer "what is the state right now"; this answers "what went wrong while I
   was not looking", which is the harder question during a demo loop or a long
   session where the interesting moment has already scrolled past.

   Design rules, learned from the failures it is meant to catch:
     - Never throw. A diagnostic that breaks the frame is worse than no
       diagnostic. Every probe is individually wrapped.
     - Deduplicate by signature and cap the log. An invariant that fails once
       fails every frame; 10,000 identical lines bury the second, different
       failure that actually explains the first.
     - Record CONTEXT at the moment of failure, not at the moment of reading.
       Post-hoc state is usually already recovered.
     - Cost nothing when off. Disabled it is one boolean test per frame.
   ════════════════════════════════════════════════════════════════════════════ */
(function(global){
'use strict';

var ON=false, N=0, LOG=[], SEEN={}, MAXLOG=400;
var _lastMs=0, _slow=[], _prevState=null, _baseline=null;

function _rec(kind,msg,ctx){
  var sig=kind+'|'+msg;
  if(SEEN[sig]){ SEEN[sig].n++; SEEN[sig].last=N; return; }
  if(LOG.length>=MAXLOG)return;
  var e={kind:kind,msg:msg,frame:N,n:1,last:N,ctx:ctx||null,t:Date.now()};
  SEEN[sig]=e; LOG.push(e);
  if(kind==='FATAL')console.error('[ZSDiag]',msg,ctx||'');
}

/* A number is only "fine" if it is finite AND inside the range the rest of the
   engine assumes. NaN is the dangerous one: it propagates silently through
   every arithmetic op and only surfaces as geometry vanishing, which is
   nowhere near where it started. */
function _num(path,v,lo,hi){
  if(typeof v!=='number'){ _rec('TYPE',path+' is not a number',{got:typeof v}); return false; }
  if(!isFinite(v)){ _rec('FATAL',path+' is '+(v!==v?'NaN':'Infinity'),{v:String(v)}); return false; }
  if(lo!=null&&(v<lo||v>hi)){ _rec('RANGE',path+' out of range',{v:+v.toFixed(4),lo:lo,hi:hi}); return false; }
  return true;
}

/* Physics and camera state. These are the values that, when they go bad, make
   the picture wrong somewhere completely unrelated. */
function _checkState(){
  var D=global.DriveDebug; if(!D||!D._state)return;
  var st; try{ st=D._state(); }catch(e){ _rec('FATAL','_state() threw',{e:String(e)}); return; }
  if(!st||!st.P)return;
  var P=st.P;
  _num('P.x',P.x,-40,40);
  _num('P.z',P.z);
  _num('P.speed',P.speed,-1,1e6);
  _num('P.vx',P.vx==null?0:P.vx,-500,500);
  _num('P.slip',P.slip==null?0:P.slip,0,4);
  _num('P.power',P.power,-1,1e5);
  if(st.cam){
    _num('carScaleK',st.cam.scaleK,0.01,12);
    /* A scale of exactly 0 means the machine is invisible, which reads as a
       crash rather than a rendering fault and gets misreported. */
    if(st.cam.scaleK===0)_rec('LOGIC','carScaleK is 0 — machine drawn at zero size',st.cam);
  }
  /* Teleports. A body that moves further in one frame than it could possibly
     travel has been assigned rather than integrated — the signature of a
     desync, a bad wrap, or a reset firing mid-frame. */
  if(_prevState&&st.speed!=null){
    var dz=Math.abs(P.z-_prevState.z);
    var maxStep=(Math.abs(st.maxSpeed||0)*0.05)+1;
    if(dz>maxStep&&dz<(_prevState.trackLen||1e9)*0.5)
      _rec('JUMP','P.z moved '+dz.toFixed(0)+' in one frame (max plausible '+maxStep.toFixed(0)+')',
           {from:+_prevState.z.toFixed(1),to:+P.z.toFixed(1),speed:st.speed});
    var dx=Math.abs(P.x-_prevState.x);
    if(dx>2.5)_rec('JUMP','P.x jumped '+dx.toFixed(2)+' half-widths in one frame',
                   {from:+_prevState.x.toFixed(3),to:+P.x.toFixed(3)});
  }
  _prevState={x:P.x,z:P.z,trackLen:null};

  /* Rivals: a stalled or impossibly fast field is the difference between a
     race and a parade, and it is invisible from inside the car. */
  /* Only once the field has had time to launch. The countdown holds rivals at
     a standstill while an attract-mode player is already at speed, so checking
     from frame zero reported a walkover on every single start. A warm-up of
     ~5s of frames plus a finished countdown removes that without hiding a
     field that is genuinely too slow. */
  if(st.rivals&&st.rivals.length&&st.speed>1000&&N>300&&(st.count==null||st.count<0)){
    var sum=0,stall=0;
    for(var i=0;i<st.rivals.length;i++){
      sum+=st.rivals[i].spd;
      if(st.rivals[i].spd<st.maxSpeed*0.15)stall++;
      _num('rival['+i+'].x',st.rivals[i].x,-40,40);
    }
    var ratio=(sum/st.rivals.length)/st.speed;
    if(ratio<0.45)_rec('BALANCE','rival field averaging '+(ratio*100).toFixed(0)+'% of player speed',
                       {mean:~~(sum/st.rivals.length),player:st.speed});
    if(stall===st.rivals.length)_rec('BALANCE','every rival below 15% of top speed',{n:stall});
  }
}

/* Renderer sanity. The horizon and draw distance drive the whole backdrop, so
   a step in either is visible as the world lurching. */
function _checkRender(){
  var M=global.DriveMode; if(!M||!M.diag)return;
  var d; try{ d=M.diag(); }catch(e){ return; }
  if(!d)return;
  if(d.horizonY!=null){
    _num('horizonY',d.horizonY,-4000,8000);
    if(_baseline&&_baseline.hz!=null){
      var j=Math.abs(d.horizonY-_baseline.hz);
      if(j>60)_rec('POP','horizon moved '+j.toFixed(0)+'px in one frame',
                   {from:+_baseline.hz.toFixed(0),to:+d.horizonY.toFixed(0)});
    }
  }
  if(d.dde!=null&&_baseline&&_baseline.dde!=null){
    var s=Math.abs(d.dde-_baseline.dde);
    if(s>240)_rec('POP','draw distance stepped '+s+' segments in one frame',
                  {from:_baseline.dde,to:d.dde});
  }
  _baseline={hz:d.horizonY,dde:d.dde};
}

/* Effects health. The tunnel and the fluid both fail QUIETLY: a bad pattern
   name or a canvas that lost its layout simply stops being visible, with no
   error anywhere. */
function _checkFX(){
  try{
    var T=global.TunnelFX;
    if(T&&T.available&&T.available()&&T.describe){
      var t=T.describe();
      if(!t.pattern)_rec('FX','TunnelFX active with no pattern selected',t);
      if(t.hue!=null&&(t.hue<0||t.hue>1))_rec('RANGE','tunnel hue outside 0..1',t);
    }
  }catch(e){}
  try{
    var wc=document.getElementById('zs-waterfx');
    if(wc&&wc.style.display!=='none'){
      /* The exact failure that made the fluid stop covering the background:
         something cleared the canvas's layout and it silently collapsed to its
         intrinsic size in normal flow. */
      if(wc.style.position!=='fixed')
        _rec('FX','water canvas lost position:fixed — background will not cover',
             {position:wc.style.position||'(empty)',w:wc.style.width||'(empty)'});
      if(!wc.style.width||!wc.style.height)
        _rec('FX','water canvas has no CSS size — collapsed to backing-store size',
             {w:wc.style.width||'(empty)',h:wc.style.height||'(empty)'});
    }
  }catch(e){}
}

/* Leak watch. Sampled rarely — the point is the TREND across a session, and
   counting nodes every frame would itself be the performance problem. */
function _checkLeaks(){
  try{
    var canv=document.getElementsByTagName('canvas').length;
    var nodes=document.getElementsByTagName('*').length;
    if(!_checkLeaks._c0){ _checkLeaks._c0=canv; _checkLeaks._n0=nodes; return; }
    if(canv>_checkLeaks._c0+12)
      _rec('LEAK','canvas count grew from '+_checkLeaks._c0+' to '+canv,{delta:canv-_checkLeaks._c0});
    if(nodes>_checkLeaks._n0*2+400)
      _rec('LEAK','DOM node count more than doubled ('+_checkLeaks._n0+' -> '+nodes+')',{delta:nodes-_checkLeaks._n0});
  }catch(e){}
}

/* Frame-time spikes, kept with the state that produced them. A spike is only
   actionable if you know which shot or screen was up when it happened. */
function _checkTiming(now){
  if(_lastMs){
    var dt=now-_lastMs;
    if(dt>55){
      var ctx={ms:+dt.toFixed(1),frame:N};
      try{ var s=global.DriveDebug&&global.DriveDebug._state();
           if(s){ ctx.shot=s.cam&&s.cam.shot; ctx.attract=s.attract; ctx.speed=s.speed; } }catch(e){}
      try{ var T=global.TunnelFX; if(T&&T.describe&&T.available&&T.available())ctx.tunnel=T.describe().pattern; }catch(e){}
      _slow.push(ctx); if(_slow.length>60)_slow.shift();
      if(dt>200)_rec('STALL','frame took '+dt.toFixed(0)+'ms',ctx);
    }
  }
  _lastMs=now;
}

function _tick(){
  if(!ON)return;
  N++;
  var now=(global.performance&&performance.now)?performance.now():Date.now();
  try{ _checkTiming(now); }catch(e){}
  try{ _checkState(); }catch(e){}
  try{ _checkRender(); }catch(e){}
  if(N%30===0){ try{ _checkFX(); }catch(e){} }
  if(N%600===0){ try{ _checkLeaks(); }catch(e){} }
}

function report(){
  var out=[];
  out.push('ZSDiag — '+N+' frames watched, '+LOG.length+' distinct issue(s)');
  out.push('');
  if(!LOG.length)out.push('  no issues detected');
  var order={FATAL:0,LOGIC:1,JUMP:2,RANGE:3,POP:4,BALANCE:5,FX:6,LEAK:7,STALL:8,TYPE:9};
  LOG.slice().sort(function(a,b){return (order[a.kind]||9)-(order[b.kind]||9)||a.frame-b.frame;})
    .forEach(function(e){
      out.push('['+e.kind+'] '+e.msg);
      out.push('    first frame '+e.frame+', seen '+e.n+'x, last frame '+e.last);
      if(e.ctx)out.push('    context: '+JSON.stringify(e.ctx));
    });
  if(_slow.length){
    out.push(''); out.push('Slowest frames (worst 8):');
    _slow.slice().sort(function(a,b){return b.ms-a.ms;}).slice(0,8).forEach(function(s){
      out.push('    '+s.ms+'ms  '+JSON.stringify(s));
    });
  }
  return out.join('\n');
}

global.ZSDiag={
  start:function(){ ON=true; N=0; LOG=[]; SEEN={}; _slow=[]; _prevState=null; _baseline=null;
                    _checkLeaks._c0=0; return 'ZSDiag watching'; },
  stop:function(){ ON=false; return report(); },
  running:function(){ return ON; },
  tick:_tick,
  report:report,
  issues:function(){ return LOG.slice(); },
  /* Deliberately callable when stopped, so a probe can be added anywhere in
     the engine without having to check the flag at the call site. */
  note:function(kind,msg,ctx){ _rec(kind||'NOTE',msg,ctx); }
};
})(typeof window!=='undefined'?window:globalThis);

/* ════════════════════════════════════════════════════════════════════════════
   ZSDiag — PART TWO: RECORDING, BISECTION AND EFFECT COVERAGE

   Part one answers "did something go wrong". These answer the three questions
   that came up repeatedly while actually debugging this engine and that no
   tool here could answer:

     "It stuttered — what did the last two seconds look like?"
        A ring buffer of per-frame samples, dumped as a table around the worst
        event. Reproducing an intermittent glitch is the expensive part; this
        removes the need to reproduce it at all.

     "Is this effect ever actually reached?"
        Sand fired on 2.7% of tracks and nobody knew, because an effect that
        never runs looks exactly like an effect that runs correctly and is
        subtle. Coverage counts settle that in one pass instead of by eye.

     "Which seeds break it?"
        A sweep that builds many tracks headlessly and reports the ones that
        produce bad numbers, so a bug becomes a seed you can load on demand.
   ════════════════════════════════════════════════════════════════════════════ */
(function(global){
'use strict';
if(!global.ZSDiag)return;

var RING=[], RINGMAX=240, RI=0, REC=false;

/* One compact sample per frame. Deliberately flat numbers rather than nested
   objects: 240 of these are live at once and the whole point is that recording
   must be cheap enough to leave on. */
function _sample(){
  if(!REC)return;
  var D=global.DriveDebug, M=global.DriveMode;
  var s=null,g=null;
  try{ s=D&&D._state(); }catch(e){}
  try{ g=M&&M.diag&&M.diag(); }catch(e){}
  if(!s)return;
  var P=s.P||{};
  RING[RI]={
    t:(global.performance&&performance.now)?+performance.now().toFixed(1):Date.now(),
    x:P.x!=null?+P.x.toFixed(4):null,
    rx:s.cam&&s.cam.rx!=null?s.cam.rx:null,
    drawX:s.cam&&s.cam.drawX!=null?s.cam.drawX:null,
    roadK:s.cam?s.cam.roadK:null,
    scaleK:s.cam?s.cam.scaleK:null,
    alpha:s.cam?s.cam.alpha:null,
    shot:s.cam?s.cam.shot:null,
    spd:s.speed,
    hz:g&&g.horizonY!=null?+g.horizonY.toFixed(1):null,
    dde:g?g.dde:null
  };
  RI=(RI+1)%RINGMAX;
  if(RING.length<RINGMAX)RING.length=Math.max(RING.length,RI||RINGMAX);
}

/* Ordered oldest-to-newest regardless of where the write head sits. */
function _ordered(){
  var out=[],i;
  for(i=0;i<RING.length;i++){
    var e=RING[(RI+i)%RING.length];
    if(e)out.push(e);
  }
  return out;
}

/* Dump the window around the largest single-frame change in a field. This is
   the view that found the demo stutter: it showed drawX jumping 47px while the
   interpolated physics beneath it moved by 0.0004, which localised the fault
   to the projection in one read. */
function timeline(field,span){
  field=field||'drawX'; span=span||10;
  var r=_ordered();
  if(r.length<3)return 'ZSDiag: nothing recorded — call ZSDiag.record() first';
  var worst=0,at=1;
  for(var i=1;i<r.length;i++){
    var a=r[i-1][field], b=r[i][field];
    if(typeof a!=='number'||typeof b!=='number')continue;
    var d=Math.abs(b-a);
    if(d>worst){worst=d;at=i;}
  }
  var keys=['t','x','rx','drawX','roadK','scaleK','alpha','shot','spd','hz','dde'];
  var out=['ZSDiag timeline — largest jump in '+field+': '+worst.toFixed(3)+
           ' at sample '+at+' of '+r.length,''];
  out.push('  '+keys.map(function(k){return k.padStart(9);}).join(''));
  for(var j=Math.max(0,at-span);j<Math.min(r.length,at+span);j++){
    var row=keys.map(function(k){
      var v=r[j][k];
      return (v==null?'-':(typeof v==='number'?(+v.toFixed(3)):v)+'').padStart(9);
    }).join('');
    out.push((j===at?'> ':'  ')+row);
  }
  out.push('');
  out.push('  Read it as: if the physics columns (x, rx) move smoothly while');
  out.push('  drawX jumps, the fault is in projection or pinning, not physics.');
  return out.join('\n');
}

/* ── EFFECT COVERAGE ──────────────────────────────────────────────────────
   Counts how many frames each effect was actually LIVE. An effect that is
   wired but never reached is indistinguishable from one that works subtly,
   and that ambiguity is exactly how a 2.7% trigger rate survives. */
var COV={};
function _cov(){
  function hit(k,on){ var c=COV[k]||(COV[k]={on:0,off:0}); if(on)c.on++; else c.off++; }
  try{
    var vis=function(id){ var e=document.getElementById(id);
      return !!(e&&e.style.display!=='none'&&e.style.visibility!=='hidden'); };
    hit('gpuSand', vis('zs-gpusand'));
    hit('gpuRain', vis('zs-gpurain'));
    hit('gpuSnow', vis('zs-gpusnow'));
    hit('waterFX', vis('zs-waterfx'));
    var T=global.TunnelFX;
    hit('tunnelFX', !!(T&&T.available&&T.available()&&
                       document.getElementById('zs-tunnelfx')&&
                       document.getElementById('zs-tunnelfx').style.display!=='none'));
  }catch(e){}
}

function coverage(){
  var out=['ZSDiag effect coverage — frames each effect was live:',''];
  var keys=Object.keys(COV);
  if(!keys.length)return 'ZSDiag: no coverage recorded — call ZSDiag.record() first';
  keys.sort();
  keys.forEach(function(k){
    var c=COV[k], tot=c.on+c.off, pct=tot?(100*c.on/tot):0;
    var flag=(c.on===0)?'   <- NEVER REACHED'
            :(pct<3?'   <- under 3%, effectively unseen':'');
    out.push('  '+k.padEnd(10)+String(c.on).padStart(7)+' / '+String(tot).padStart(7)+
             '  '+pct.toFixed(1).padStart(5)+'%'+flag);
  });
  return out.join('\n');
}

/* ── SEED SWEEP ───────────────────────────────────────────────────────────
   Builds N tracks and reports any that produce numbers the engine should
   never see. Turns "it broke once" into a specific seed. Synchronous and
   blocking by design — it is a deliberate diagnostic run, not a background
   task, and interleaving it with rendering would hide the very stalls it is
   looking for. */
function sweep(n,startSeed){
  n=Math.min(400,n||60);
  var M=global.DriveMode; if(!M||!M.start)return 'ZSDiag: DriveMode.start unavailable';
  var bad=[], biomes={}, t0=Date.now();
  for(var i=0;i<n;i++){
    var sd=((startSeed||1)+i)*2654435761>>>0;
    var issues=[];
    try{
      try{ M.exit(); }catch(e){}
      M.start(sd,0);
      var g=M.diag?M.diag():null;
      if(!g){ issues.push('diag() returned nothing'); }
      else{
        var th=g.theme||{};
        biomes[th.biome||'?']=(biomes[th.biome||'?']||0)+1;
        if(!(g.segments>0))issues.push('segments='+g.segments);
        if(!(g.trackLength>0))issues.push('trackLength='+g.trackLength);
        if(g.laps!=null&&!(g.laps>0))issues.push('laps='+g.laps);
        if(g.rivals!=null&&g.rivals<0)issues.push('rivals='+g.rivals);
        ['trackLength','segments','powerCap'].forEach(function(k){
          if(g[k]!=null&&typeof g[k]==='number'&&!isFinite(g[k]))
            issues.push(k+' not finite');
        });
      }
    }catch(e){ issues.push('threw: '+(e&&e.message||e)); }
    if(issues.length)bad.push({seed:sd,issues:issues});
  }
  var out=['ZSDiag seed sweep — '+n+' tracks in '+((Date.now()-t0)/1000).toFixed(1)+'s',''];
  out.push('  biome spread ('+Object.keys(biomes).length+' distinct):');
  Object.keys(biomes).sort(function(a,b){return biomes[b]-biomes[a];}).forEach(function(k){
    out.push('    '+String(biomes[k]).padStart(4)+'  '+k);
  });
  /* One biome dominating means the selector is stuck, which silently starves
     every biome-gated effect downstream. */
  var vals=Object.keys(biomes).map(function(k){return biomes[k];});
  if(vals.length===1)out.push('    *** only ONE biome across the whole sweep — selector is stuck');
  else if(Math.max.apply(null,vals)>n*0.5)out.push('    *** one biome exceeds half the sweep — check the selector');
  out.push('');
  out.push('  failing seeds: '+bad.length+' of '+n);
  bad.slice(0,20).forEach(function(b){
    out.push('    seed '+b.seed+' -> '+b.issues.join('; '));
  });
  return out.join('\n');
}

var _base=global.ZSDiag.tick;
global.ZSDiag.tick=function(){
  _base.apply(null,arguments);
  try{ _sample(); }catch(e){}
  try{ if(REC)_cov(); }catch(e){}
};
global.ZSDiag.record=function(on){
  REC=(on===undefined)?true:!!on;
  if(REC){ RING=[]; RI=0; COV={}; }
  return REC?'ZSDiag recording (ring of '+RINGMAX+' frames)':'ZSDiag recording stopped';
};
global.ZSDiag.timeline=timeline;
global.ZSDiag.coverage=coverage;
global.ZSDiag.sweep=sweep;
global.ZSDiag.samples=_ordered;
/* Everything, in the order you would want to read it. */
global.ZSDiag.full=function(){
  return [global.ZSDiag.report(),'',coverage(),'',timeline('drawX',8)].join('\n');
};
})(typeof window!=='undefined'?window:globalThis);
