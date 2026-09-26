/* 
   WORLD.JS — CONSOLIDATED WORLD TOUR
   
   One file replacing five that previously loaded separately:

     worldtour.js     world generation, settlements, city names
     worldmap.js      the map screen and its rendering
     worldrewards.js  rewards, and the IndexedDB lap-time store
     upgradeshop.js   the machine upgrade shop and its credit economy
     worldflow.js     screen flow, race launch, result handling

   LOAD ORDER IS LOAD-BEARING and is preserved from race.html. worldflow reads
   both WorldRewards and UpgradeShop when a race finishes, so both must precede
   it. worldmap and worldflow each publish WorldTourRace — the later definition
   wins, exactly as it did with separate script tags. Each module keeps its own
   IIFE, so internal scoping is untouched.

   HOW BIG THE WORLD IS
   81,742 racetracks. They are not stored: a settlement is generated
   deterministically from its index, so the whole world is a pure function of an
   integer and costs nothing until it is looked at.

   HOW NAMES ARE LOADED
   From city.csv.gz — a gzipped SINGLE-LINE CSV of `name,` values, about 407 KB.
   It is fetched once, inflated with DecompressionStream('gzip'), and parsed
   into an array, after which every lookup is an index into memory.

   THE ID IS THE POSITION. Nothing stores an index, because the order carries
   it. Ids are 1-based and the array is 0-based, so lookups subtract one — a
   detail worth knowing because getting it wrong yields real, plausible names
   that are all off by one, which is far harder to notice than a crash.

   This format replaced `number,name` per line, which paid for its own index in
   decimal plus a newline on every record. Measured on the real data:

       number,name   1,760 KB raw   604 KB gzipped
       name,         1,292 KB raw   407 KB gzipped     33% smaller

   Before that it was a 157 MB JSON queried with an HTTP Range request per
   name, which needed range support on the host, a round trip per settlement
   label, and a fuzzy fallback because byte offsets could only be estimated.

   Quoted fields are honoured so a name containing a comma cannot shift every
   id after it. No name in the current data needs quoting; the handling is
   there because that failure would be silent and total.

   If the file is missing or DecompressionStream is unavailable, generated
   names are used and the map stays fully playable.

   GLOBALS PUBLISHED (unchanged): window.WorldTour, window.WorldMap,
   window.WorldRewards, window.UpgradeShop, window.WorldTourFlow,
   window.WorldTourRace

   The five original files are superseded and can be deleted from the server.
    */

/* 
   WORLD GENERATION AND CITY NAMES   (was worldtour.js)
   ---------------------------------------------------------------------------
   Deterministic settlement generation plus the single-line CSV name loader
   described above.
    */
/* 
   WORLD TOUR — data model, name access and persistence
   ---------------------------------------------------------------------------
   Stage 1 of the World Tour build. No rendering here: this file owns the
   hierarchy, the settlement assignment, the race-configuration table and the
   saved progress. It is testable headlessly, which is why it comes first.

   THE CENTRAL CONSTRAINT
   citynames.json is 157 MB / 4,051,110 records (~40 bytes each). Parsing it
   would materialise roughly 247 MB of JavaScript objects, so it can never be
   loaded eagerly in a browser tab. Every design decision below follows from
   that:

     • The hierarchy is GENERATED, not stored. Continents, countries, states
       and municipalities are derived deterministically from a seed, so the
       whole world exists as maths and costs nothing until it is looked at.
     • A settlement's NAME is the only thing that comes from the file, and it
       is fetched by byte range for the handful currently on screen.
     • Nothing is held in memory except the branch the player is looking at.

   The world is identical on every device and every run because every level is
   a pure function of its parent's id — no world data is persisted, only the
   player's progress through it.
    */

(function(global){
'use strict';

/* ── DETERMINISTIC RNG 
   A hash-based generator rather than a stateful stream: any node can be
   generated on demand without walking the tree from the root, which is what
   makes lazy expansion possible. */
function hash32(str){
  let h=2166136261>>>0;
  for(let i=0;i<str.length;i++){h^=str.charCodeAt(i);h=Math.imul(h,16777619)>>>0;}
  return h>>>0;
}
function rngFor(key){
  let s=hash32(key)||1;
  return function(){s^=s<<13;s^=s>>>17;s^=s<<5;s>>>=0;return s/4294967296;};
}
function pick(r,arr){return arr[Math.floor(r()*arr.length)%arr.length];}
function intR(r,lo,hi){return lo+Math.floor(r()*(hi-lo+1));}

/* ── SETTLEMENT TYPES 
   Counts are the real-world distribution supplied in the brief. They are used
   as WEIGHTS, so the generated world has the same shape as the real one: a
   handful of megacities and millions of hamlets, rather than an even spread
   that would make every municipality feel identical.

   Villages take the top of their stated 2.0-2.5M range so the counts sum to
   exactly 4,051,110 — the record count in citynames.json. Every settlement in
   the world therefore has a name available. */
var TYPES=[
  {id:'megacity', label:'Megacity',        count:35,      popMin:10000000, popMax:38000000},
  {id:'large',    label:'Large City',      count:575,     popMin:1000000,  popMax:9999999},
  {id:'mid',      label:'Mid-Sized City',  count:1000,    popMin:500000,   popMax:999999},
  {id:'small',    label:'Small City',      count:4500,    popMin:100000,   popMax:499999},
  {id:'town',     label:'Town',            count:45000,   popMin:1000,     popMax:99999},
  {id:'village',  label:'Village',         count:2500000, popMin:100,      popMax:999},
  {id:'hamlet',   label:'Hamlet',          count:1500000, popMin:10,       popMax:99}
];
var TOTAL_SETTLEMENTS=TYPES.reduce(function(a,t){return a+t.count;},0);
/* (4) Records in the trimmed citynames.json. Must match the file exactly: an
   index past the end yields a 416 and falls back to a generated name. */
var NAME_COUNT=81742;

/* Cumulative table for weighted selection — built once. */
var _cum=(function(){
  var out=[],run=0;
  for(var i=0;i<TYPES.length;i++){run+=TYPES[i].count;out.push(run);}
  return out;
})();
/* (2) THE LAP VARIETY PROBLEM.
   Sampling the true distribution gives 98.9% hamlets and villages — both 2-lap
   races. The counts are correct for a real world, but the effect is that a
   player sees the same race shape essentially forever, and the lap/turbo table
   may as well not exist.
   The roll is therefore WARPED: `pow(v, 2.4)` pushes the value toward 0, which
   is where the larger settlements sit in the cumulative table. The world still
   contains 4,051,110 settlements in the stated proportions — this changes only
   which of them a player is likely to be offered, so bigger races appear often
   enough to be worth building a lap table for. */
function typeForRoll(v){
  var warped=Math.pow(Math.max(0,Math.min(1,v)),2.4);
  var t=warped*TOTAL_SETTLEMENTS;
  for(var i=0;i<_cum.length;i++)if(t<_cum[i])return TYPES[i];
  return TYPES[TYPES.length-1];
}

/* ── RACE CONFIGURATION 
   The brief gives lap counts, turbo charges and relative track lengths. The
   lengths are expressed as chained percentages from the smallest upward, so
   they are resolved once here into absolute multipliers rather than being
   recomputed — and a change to one link correctly moves everything above it.

     Hamlet   1.00  (base)
     Village  1.05  (5% longer than Hamlet)
     Town     1.05 x Village
     Small    1.10 x Town
     Mid      1.10 x Small
     Large    1.25 x Mid
     Megacity 1.10 x Large                                                  */
var RACE_CFG=(function(){
  var hamlet =1.00;
  var village=hamlet *1.05;
  var town   =village*1.05;
  var small  =town   *1.10;
  var mid    =small  *1.10;
  var large  =mid    *1.25;
  var mega   =large  *1.10;
  return {
    hamlet  :{laps:2,turbo:1,lenMul:hamlet },
    village :{laps:2,turbo:1,lenMul:village},
    town    :{laps:3,turbo:1,lenMul:town   },
    small   :{laps:3,turbo:1,lenMul:small  },
    mid     :{laps:4,turbo:2,lenMul:mid    },
    large   :{laps:4,turbo:2,lenMul:large  },
    megacity:{laps:5,turbo:3,lenMul:mega   }
  };
})();
function raceConfigFor(typeId){
  return RACE_CFG[typeId]||RACE_CFG.hamlet;
}

var CONTINENTS=[
  {id:'valoria',   name:'VALORIA',    areaShare:0.298, countries:49, cx:0.62, cy:0.34, scale:1.00},
  {id:'karnath',   name:'KARNATH',    areaShare:0.203, countries:54, cx:0.46, cy:0.58, scale:0.86},
  {id:'olenthia',  name:'OLENTHIA',   areaShare:0.163, countries:23, cx:0.22, cy:0.30, scale:0.78},
  {id:'sundara',   name:'SUNDARA',    areaShare:0.120, countries:12, cx:0.28, cy:0.66, scale:0.68},
  {id:'brackmoor', name:'BRACKMOOR',  areaShare:0.098, countries:44, cx:0.50, cy:0.22, scale:0.62},
  {id:'auster',    name:'AUSTER',     areaShare:0.070, countries:3,  cx:0.50, cy:0.83, scale:0.38},
  {id:'meridia',   name:'MERIDIA',    areaShare:0.048, countries:13, cx:0.82, cy:0.74, scale:0.44}
];


var COUNTRY_PARTS_A=['NOR','VAL','KAR','SUN','BRAC','MER','OLN','THAL','ZEN','QUIR',
  'DRAV','ESK','FAL','GORM','HALD','IVER','JAR','KEL','LOM','MYR','NEB','ORV','PEL',
  'RHOS','SYL','TOR','ULM','VEX','WYN','YAR','ZOL','ASH','BREN','CIND','DUSK','EMBER'];
var COUNTRY_PARTS_B=['IA','ANIA','ESH','MARK','LAND','STAN','VIA','ORA','UNE','ATH',
  'ENDE','ISLE','GARD','HOLM','REACH','FELL','WATCH','MERE','VALE','CREST'];
var STATE_PARTS=['NORTH','SOUTH','EAST','WEST','UPPER','LOWER','INNER','OUTER','NEW',
  'OLD','GREAT','LITTLE','HIGH','DEEP','FAR','MID'];
var STATE_ROOTS=['MARCH','SHIRE','PROVINCE','REACH','HOLD','DOWNS','WEALD','FEN',
  'MOOR','RIDGE','BASIN','DELTA','PLAIN','HIGHLAND','COAST','GATE'];
var MUNI_ROOTS=['BOROUGH','DISTRICT','COMMUNE','PARISH','WARD','CANTON','PREFECTURE',
  'COUNTY','HUNDRED','RIDING'];

/* ── LAZY HIERARCHY 
   Each level is a pure function of its parent id. Nothing is cached beyond a
   small LRU, because regenerating is cheaper than holding the world in memory
   and guarantees identical results everywhere. */
function continents(){return CONTINENTS.slice();}

function countriesOf(contId){
  var c=null;
  for(var i=0;i<CONTINENTS.length;i++)if(CONTINENTS[i].id===contId)c=CONTINENTS[i];
  if(!c||!c.countries)return [];
  var out=[];
  for(var k=0;k<c.countries;k++){
    var key=contId+'/c'+k, r=rngFor(key);
    out.push({
      id:key,
      name:pick(r,COUNTRY_PARTS_A)+pick(r,COUNTRY_PARTS_B),
      parent:contId,
      states:intR(r,4,12),
      /* Position within the continent, used by the map renderer later. */
      px:0.14+r()*0.72, py:0.14+r()*0.72,
      size:0.5+r()*0.9
    });
  }
  return out;
}

function statesOf(countryId){
  var r0=rngFor(countryId), n=intR(r0,4,12), out=[];
  for(var k=0;k<n;k++){
    var key=countryId+'/s'+k, r=rngFor(key);
    out.push({
      id:key,
      name:pick(r,STATE_PARTS)+' '+pick(r,STATE_ROOTS),
      parent:countryId,
      munis:intR(r,3,9),
      px:0.14+r()*0.72, py:0.14+r()*0.72,
      size:0.5+r()*0.9
    });
  }
  return out;
}

function municipalitiesOf(stateId){
  var r0=rngFor(stateId), n=intR(r0,3,9), out=[];
  for(var k=0;k<n;k++){
    var key=stateId+'/m'+k, r=rngFor(key);
    out.push({
      id:key,
      name:pick(r,STATE_PARTS)+' '+pick(r,MUNI_ROOTS),
      parent:stateId,
      settlements:intR(r,4,14),
      px:0.16+r()*0.68, py:0.16+r()*0.68,
      size:0.5+r()*0.9
    });
  }
  return out;
}

/* Settlements carry the properties that drive the race: type, population and
   a track seed. The NAME is resolved separately and asynchronously, because
   that is the only part that touches the 157 MB file. */
function settlementsOf(muniId){
  var r0=rngFor(muniId), n=intR(r0,4,14), out=[];
  for(var k=0;k<n;k++){
    var key=muniId+'/t'+k, r=rngFor(key);
    var type=typeForRoll(r());
    var pop=type.popMin+Math.floor(r()*(type.popMax-type.popMin));
    out.push({
      id:key,
      /* Index into citynames.json. Spread across the whole file so nearby
         settlements do not draw consecutive names. */
      /* (4) NAMES INDEX INTO THE TRIMMED FILE.
         This used TOTAL_SETTLEMENTS (4,051,110) — the type-weighting sum — so
         indices spread across a 158 MB file of which 98% was never read. The
         world contains 81,742 settlements, so the modulus is now NAME_COUNT
         and citynames.json holds exactly that many records: 158 MB -> ~3.2 MB.
         Existing saves will show different names for the same places, which is
         the accepted cost of the reduction. */
      nameIndex:hash32(key)%NAME_COUNT,
      name:null,                       // filled by resolveNames()
      type:type.id, typeLabel:type.label,
      population:pop,
      parent:muniId,
      trackSeed:hash32(key+':track')>>>0,
      race:raceConfigFor(type.id),
      px:0.18+r()*0.64, py:0.18+r()*0.64
    });
  }
  return out;
}

/* ── NAME RESOLUTION 
   Only the names currently on screen are ever fetched — at most a few dozen.

   Strategy, in order of preference:
     1. HTTP Range request for the byte window around the record. Works when
        the file is served by anything that honours Range (all static servers
        do), and transfers a few KB instead of 157 MB.
     2. Full fetch, used only if Range is refused. Guarded behind an explicit
        opt-in because it would stall a browser tab.
     3. A deterministic generated name, so the game still works with no file
        present at all — which is what makes this testable and what stops a
        missing asset breaking the mode.

   Successful lookups are cached in IndexedDB, so a settlement is fetched once
   per device however often it is revisited. */
var _nameCache={};            // in-memory LRU for the current session
var _nameCacheOrder=[];
var NAME_CACHE_MAX=4000;

function _cachePut(idx,name){
  if(_nameCache[idx]===undefined){
    _nameCacheOrder.push(idx);
    if(_nameCacheOrder.length>NAME_CACHE_MAX)delete _nameCache[_nameCacheOrder.shift()];
  }
  _nameCache[idx]=name;
}

/* Fallback name generator. Deterministic on the index, so a settlement keeps
   the same name across sessions even without the file. */
var FB_A=['NOVA','PORT','FORT','LAKE','MOUNT','SAINT','NEW','OLD','GRAND','SILVER',
  'IRON','AMBER','CRYSTAL','EMBER','FROST','STORM','SUN','MOON','STAR','RIVER'];
var FB_B=['HAVEN','RIDGE','FORD','GATE','FIELD','BROOK','STEAD','WICK','THORPE',
  'BURY','CREST','HOLLOW','REACH','SPRING','FALLS','POINT','BEND','MOOR','VALE','WATCH'];
function fallbackName(idx){
  var r=rngFor('name:'+idx);
  var a=pick(r,FB_A), b=pick(r,FB_B);
  return (r()<0.25)?(a+' '+b):(a.charAt(0)+a.slice(1).toLowerCase()+b.toLowerCase());
}

/* ═══ CITY NAME SOURCE: SINGLE-LINE GZIPPED CSV 
   city.csv.gz — one line, values in the form `name,` repeated, and the ID IS
   THE POSITION. Nothing stores an index because the order carries it.

   WHY THIS IS SMALLER
   The previous file was `number,name` per line. Every record therefore paid
   for its own index in decimal plus a newline: an id near 81,000 costs five
   digits, a comma and a line ending — roughly seven bytes of pure overhead per
   settlement, about 550 KB across the set before compression. Gzip removes
   much of that redundancy, but not all of it, and none of the parsing cost.
   Dropping the index entirely is strictly better: fewer bytes, fewer fields to
   split, and no integer parse per record.

   THE COMMA PROBLEM, AND WHY QUOTING IS HANDLED
   A comma-delimited single line cannot represent a name that itself contains a
   comma — and these do: "Frankfurt am Main, Hesse". Splitting naively on every
   comma would silently shift every subsequent id by one, which is the worst
   possible failure here because the ids are POSITIONAL. One unquoted comma
   anywhere in the file would misname every settlement after it, and nothing
   would look broken enough to notice.

   So the parser honours double-quoted fields: a quoted value may contain
   commas, and a doubled quote inside one is a literal quote. That is standard
   CSV quoting, so any exporter producing correct CSV will round-trip. If the
   file happens to contain no quoted fields the parser costs nothing extra.

   Names are held in a plain ARRAY rather than a Map. The id is the index, so
   an array is both the natural structure and the faster lookup, and it avoids
   a hash entry per settlement.

   Decompression uses DecompressionStream('gzip'), the standard Web API, with
   no library. If it or the file is unavailable the loader falls back to
   generated names and the map stays fully playable. */
var _cityNames=null;        // Array<string>, index === settlement id
var _cityLoad=null;         // in-flight promise, so callers share one fetch
var _cityFailed=false;

/* Splits the single-line CSV, honouring quoted fields. Written as a character
   scan rather than a regex or String.split: the file is ~81,000 values and a
   regex with alternation over that is markedly slower, while split(',') cannot
   respect quotes at all. */
function _parseCityCsv(text){
  var out=[], buf='', i=0, n=text.length, inQ=false;
  for(;i<n;i++){
    var ch=text.charCodeAt(i);
    if(inQ){
      if(ch===34){                       // closing quote, or an escaped one
        if(i+1<n&&text.charCodeAt(i+1)===34){ buf+='"'; i++; }
        else inQ=false;
      } else buf+=text[i];
      continue;
    }
    if(ch===34){ inQ=true; continue; }
    if(ch===44){ out.push(buf); buf=''; continue; }   // field separator
    /* Newlines are treated as whitespace, not as records: the file is one
       line by design, but a trailing newline or a wrapped export must not
       introduce a phantom entry and shift every id after it. */
    if(ch===10||ch===13)continue;
    buf+=text[i];
  }
  /* A trailing `name,` leaves an empty buffer, which is correct and must NOT
     be pushed — doing so would append a blank settlement and make the array
     one longer than the world. */
  if(buf.length)out.push(buf);
  return out;
}

/* Public: resolves once, then every later call is a cache hit. */
function loadCityNames(){
  if(_cityNames)return Promise.resolve(_cityNames);
  if(_cityFailed)return Promise.resolve(null);
  if(_cityLoad)return _cityLoad;
  if(typeof fetch!=='function'){_cityFailed=true;return Promise.resolve(null);}

  _cityLoad=fetch('city.csv.gz')
    .then(function(res){
      if(!res.ok)throw new Error('city.csv.gz '+res.status);
      /* If the server already applied Content-Encoding: gzip the body arrives
         decompressed and there is nothing left to inflate — piping it through
         DecompressionStream would then fail on a non-gzip stream. Detect that
         by checking the magic bytes rather than trusting headers. */
      return res.arrayBuffer();
    })
    .then(function(buf){
      var bytes=new Uint8Array(buf);
      var gzipped=(bytes.length>2&&bytes[0]===0x1f&&bytes[1]===0x8b);
      if(!gzipped)return new TextDecoder('utf-8').decode(bytes);
      if(typeof DecompressionStream!=='function')
        throw new Error('DecompressionStream unavailable');
      var stream=new Blob([bytes]).stream()
        .pipeThrough(new DecompressionStream('gzip'));
      return new Response(stream).text();
    })
    .then(function(text){
      _cityNames=_parseCityCsv(text);
      _cityLoad=null;
      return _cityNames;
    })
    .catch(function(e){
      /* Not fatal: fallbackName() generates a plausible name from the index,
         so the world is still fully playable without the file. */
      try{console.warn('city names unavailable, using generated names:',e);}catch(_){}
      _cityFailed=true;_cityLoad=null;
      return null;
    });
  return _cityLoad;
}

function resolveName(idx){
  if(_nameCache[idx]!==undefined)return Promise.resolve(_nameCache[idx]);
  /* Once the table is in memory this is synchronous in all but name — the
     promise resolves on the microtask queue, so a screenful of markers no
     longer costs a screenful of network requests. */
  if(_cityNames){
    /* ═══ THE IDS ARE 1-BASED, THE ARRAY IS 0-BASED 
       The old file carried an explicit number per row and those numbers run
       1..81742, so every lookup here passes a 1-based id. Dropping the number
       makes the POSITION the id — and position 0 holds id 1.

       Without the -1 every settlement would show the name of the next one
       along. That is the failure this format is most exposed to, and it is
       almost invisible: the map would be full of real, plausible names, just
       consistently wrong by one. Worth the explicit note. */
    var _p=idx-1;
    var hit=(_p>=0&&_p<_cityNames.length)?_cityNames[_p]:null;
    var v=hit||fallbackName(idx);
    _cachePut(idx,v);
    return Promise.resolve(v);
  }
  if(_cityFailed){
    var fb=fallbackName(idx);_cachePut(idx,fb);return Promise.resolve(fb);
  }
  return loadCityNames().then(function(arr){
    var _p2=idx-1;   // 1-based id -> 0-based position; see the note above
    var out=(arr&&_p2>=0&&_p2<arr.length&&arr[_p2])||fallbackName(idx);
    _cachePut(idx,out);
    return out;
  });
}
/* Resolve a screenful at once. */
function resolveNames(list){
  return Promise.all(list.map(function(s){
    return resolveName(s.nameIndex).then(function(n){s.name=n;return s;});
  }));
}

/* ── PROGRESS 
   Only the player's progress is stored — the world regenerates. That keeps the
   save tiny (a few unlocked ids and completions) no matter how much of the
   4-million-settlement world has been visited. */
var SAVE_KEY='zsgx_worldtour_v1';
var _save=null;

/* (2) EXTERNAL WRITES MUST INVALIDATE THE CACHE.
   `_save` is held in memory, so anything that writes localStorage directly —
   the debug reset does — left this copy stale. A later unlock then persisted
   the OLD object, silently undoing the reset, and a reset after an unlock
   appeared to do nothing. Callers use invalidate() after writing behind our
   back. */
function invalidateSave(){ _save=null; }
function loadSave(){
  if(_save)return _save;
  try{
    var raw=(typeof localStorage!=='undefined')?localStorage.getItem(SAVE_KEY):null;
    _save=raw?JSON.parse(raw):null;
  }catch(e){_save=null;}
  if(!_save)_save={home:null,unlocked:{},completed:{},best:{}};
  return _save;
}
function persist(){
  /* (4) THE SILENT FAILURE.
     This swallowed every exception, including QuotaExceededError. Earlier
     builds wrote one localStorage key per settlement, so a save from that era
     can leave the origin at its quota — and then every write here failed with
     no sign, which is exactly "the bar runs but nothing unlocks".
     The error is now surfaced, and one recovery is attempted: older per-track
     keys are the only thing large enough to be worth clearing, and they are
     obsolete now that unlocks are stored as prefixes. */
  try{
    if(typeof localStorage==='undefined')return true;
    localStorage.setItem(SAVE_KEY,JSON.stringify(_save));
    return true;
  }catch(e){
    console.warn('World Tour save failed:',e&&e.name,e&&e.message);
    try{
      var freed=0;
      for(var i=localStorage.length-1;i>=0;i--){
        var k=localStorage.key(i);
        /* Legacy per-settlement unlock keys; the prefix list replaces them. */
        if(k&&(k.indexOf('zsgx_unlocked_')===0||k.indexOf('zsgx_wt_track_')===0)){
          localStorage.removeItem(k); freed++;
        }
      }
      if(freed){
        console.warn('Cleared '+freed+' obsolete keys; retrying save.');
        localStorage.setItem(SAVE_KEY,JSON.stringify(_save));
        return true;
      }
    }catch(e2){ console.error('World Tour save could not recover:',e2); }
    return false;
  }
}

/* The player starts at a random municipality, and its first settlement is
   renamed FREEDOM CITY. Chosen once and stored, so the starting point is
   stable for that player but different between players. */
/* (1) FIXED STARTING POINT.
   The home settlement was chosen at random, so every player began somewhere
   different and no two sessions could be compared or discussed. It is now a
   named, deterministic location:

     OLENTHIA / ZENVALE / DEEP SHIRE / SOUTH HUNDRED

   Resolved by NAME rather than by index, so a future change to the generator
   that shifts ordering cannot silently relocate the start. If any level of the
   path is missing the random pick is used as a fallback, which keeps the mode
   playable rather than failing outright. */
var HOME_PATH={continent:'olenthia',country:'ZENVALE',
               state:'DEEP SHIRE',muni:'SOUTH HUNDRED'};
function findByName(list,name){
  for(var i=0;i<list.length;i++)if(list[i].name===name)return list[i];
  return null;
}
function homeSettlement(){
  var s=loadSave();
  if(s.home)return s.home;
  var cont=null,country=null,state=null,muni=null;
  try{
    for(var i=0;i<CONTINENTS.length;i++)
      if(CONTINENTS[i].id===HOME_PATH.continent)cont=CONTINENTS[i];
    if(cont)country=findByName(countriesOf(cont.id),HOME_PATH.country);
    if(country)state=findByName(statesOf(country.id),HOME_PATH.state);
    if(state)muni=findByName(municipalitiesOf(state.id),HOME_PATH.muni);
  }catch(e){}
  if(!muni){
    /* Fallback: the named path could not be resolved. */
    var r=rngFor('home:'+Date.now()+':'+Math.random());
    var withCountries=CONTINENTS.filter(function(c){return c.countries>0;});
    cont=pick(r,withCountries);
    var cs=countriesOf(cont.id);        country=pick(r,cs);
    var st=statesOf(country.id);        state=pick(r,st);
    var ms=municipalitiesOf(state.id);  muni=pick(r,ms);
  }
  var ss=settlementsOf(muni.id);
  var home=ss[0];
  s.home={id:home.id,muni:muni.id,state:state.id,country:country.id,continent:cont.id};
  s.unlocked[home.id]=1;
  persist();
  ensureContinentEntries();
  return s.home;
}
/* FREEDOM CITY is a label on the home settlement, not a name lookup. */
function displayName(st){
  var s=loadSave();
  if(s.home&&s.home.id===st.id)return 'FREEDOM CITY';
  return st.name||fallbackName(st.nameIndex);
}

/* (3) Every continent has one settlement the player can reach by pressing A
   repeatedly from the world view: first country, first state, first
   municipality, first settlement. Unlocked on demand so no save data is
   needed and the guarantee holds even for a save made before this existed. */
function continentEntryId(contId){
  var cs=countriesOf(contId); if(!cs.length)return null;
  var st=statesOf(cs[0].id);  if(!st.length)return null;
  var ms=municipalitiesOf(st[0].id); if(!ms.length)return null;
  var ss=settlementsOf(ms[0].id);    if(!ss.length)return null;
  return ss[0].id;
}
function ensureContinentEntries(){
  var s=loadSave(), changed=false;
  for(var i=0;i<CONTINENTS.length;i++){
    if(!CONTINENTS[i].countries)continue;
    var id=continentEntryId(CONTINENTS[i].id);
    if(id&&!s.unlocked[id]){s.unlocked[id]=1;changed=true;}
  }
  if(changed)persist();
}
/* (2) Does anything under this node contain an unlocked track? Used by the
   map to mark branches worth entering, so the player is never hunting blind
   through four levels. Only the first-child spine is checked plus explicit
   unlocks, which is enough to be accurate without walking millions of nodes. */
function branchHasUnlocked(id){
  var s=loadSave();
  for(var k in s.unlocked){ if(k.indexOf(id+'/')===0)return true; }
  /* (4) WILDCARD PREFIXES WERE INVISIBLE HERE.
     This scanned only literal keys, so after a bulk unlock — which stores one
     prefix instead of tens of thousands of keys — every continent, country and
     state still drew as locked even though its settlements were open.
     A branch counts as unlocked if a prefix covers it (the prefix is a parent
     of this branch) OR if it covers something inside it (the prefix is a
     child, e.g. a continent unlock seen from the world view). */
  var pre=s.unlockedPrefixes||[];
  for(var i=0;i<pre.length;i++){
    var p=pre[i];
    if(String(id).indexOf(p)===0)return true;       // prefix covers this id
    if(p.indexOf(String(id)+'/')===0)return true;   // prefix lies within it
  }
  return false;
}
function branchCompleted(id){
  var s=loadSave();
  for(var k in s.completed){ if(k.indexOf(id+'/')===0)return true; }
  return false;
}
// Explicit unlock, used by the debug tools and by progression.
function unlock(id){ var s=loadSave(); s.unlocked[id]=1; persist(); }

/* ── (9) BULK UNLOCK 
   Unlocking a continent one settlement at a time froze the browser: each call
   wrote the entire save to localStorage, so a 20,000-settlement continent
   performed 20,000 full serialisations of a growing object.

   Two changes make it viable:

     1. WILDCARD UNLOCKS. Rather than storing tens of thousands of individual
        ids, a single prefix entry marks an entire branch as unlocked. Storing
        every settlement as its own key would need roughly 85 MB, which is far
        beyond the localStorage quota — that is why entries were silently lost
        and continents such as Meridia and Auster never persisted.
     2. CHUNKED WALK. The tree is walked in slices with the progress reported
        between them, so the page keeps painting and the caller can show a bar.

   isUnlocked() consults the wildcard list, so a prefix unlock behaves exactly
   like having unlocked each settlement individually. */
function unlockBranch(prefix){
  var s=loadSave();
  if(!s.unlockedPrefixes)s.unlockedPrefixes=[];
  /* Drop any existing prefix that this one already covers, so the list cannot
     grow without bound as broader unlocks arrive. */
  s.unlockedPrefixes=s.unlockedPrefixes.filter(function(p){
    return p.indexOf(prefix)!==0;
  });
  if(s.unlockedPrefixes.indexOf(prefix)<0)s.unlockedPrefixes.push(prefix);
  return persist();
}
/* Count settlements under a branch without unlocking them, for the progress
   bar's denominator. */
function countBranch(contId,onProgress,done){
  var cos=countriesOf(contId), i=0, total=0;
  function slice(){
    var end=Math.min(cos.length,i+2);
    for(;i<end;i++){
      var sts=statesOf(cos[i].id);
      for(var a=0;a<sts.length;a++){
        var ms=municipalitiesOf(sts[a].id);
        for(var b=0;b<ms.length;b++)total+=settlementsOf(ms[b].id).length;
      }
    }
    if(onProgress)onProgress(i/cos.length,total);
    if(i<cos.length)setTimeout(slice,0);   // yield so the page can paint
    else if(done)done(total);
  }
  slice();
}
/* Unlock an entire continent. Returns immediately; progress arrives by
   callback and the write itself is a single prefix entry. */
function unlockContinent(contId,onProgress,done){
  countBranch(contId,onProgress,function(total){
    var saved=unlockBranch(contId+'/');
    if(done)done(total,saved);
  });
}
function isUnlocked(id){
  var s=loadSave();
  if(s.unlocked[id])return true;
  /* (9) A prefix entry unlocks everything beneath it. */
  var pre=s.unlockedPrefixes;
  if(pre)for(var i=0;i<pre.length;i++)
    if(String(id).indexOf(pre[i])===0)return true;
  return false;
}
function isCompleted(id){
  var s=loadSave();
  return !!s.completed[id];
}
/* Winning unlocks the two NEAREST settlements in the same municipality, so
   progress spreads outward geographically rather than jumping around. */
function completeRace(settlementId,totalMs){
  var s=loadSave();
  s.completed[settlementId]=1;
  if(!s.best[settlementId]||totalMs<s.best[settlementId])s.best[settlementId]=totalMs;
  var muniId=settlementId.slice(0,settlementId.lastIndexOf('/'));
  var sibs=settlementsOf(muniId);
  var me=null;
  for(var i=0;i<sibs.length;i++)if(sibs[i].id===settlementId)me=sibs[i];
  var newly=[];
  if(me){
    var locked=sibs.filter(function(x){return !s.unlocked[x.id];});
    locked.sort(function(a,b){
      var da=(a.px-me.px)*(a.px-me.px)+(a.py-me.py)*(a.py-me.py);
      var db=(b.px-me.px)*(b.px-me.px)+(b.py-me.py)*(b.py-me.py);
      return da-db;
    });
    for(var k=0;k<Math.min(2,locked.length);k++){
      s.unlocked[locked[k].id]=1;
      newly.push(locked[k].id);
    }
  }
  /* Every win opens something. When the municipality is already fully open,
     the road continues into the next municipality of the same state (then
     the next state of the country) that still has locked settlements. */
  if(!newly.length){
    try{
      var stateId=muniId.slice(0,muniId.lastIndexOf('/'));
      var ctryId=stateId.slice(0,stateId.lastIndexOf('/'));
      var states=statesOf(ctryId), order=[];
      var si=0; for(var a=0;a<states.length;a++)if(states[a].id===stateId)si=a;
      for(var b=0;b<states.length;b++)order.push(states[(si+b)%states.length].id);
      outer: for(var c=0;c<order.length;c++){
        var ms=municipalitiesOf(order[c]), mi=0;
        for(var d=0;d<ms.length;d++)if(ms[d].id===muniId)mi=d;
        for(var e2=0;e2<ms.length;e2++){
          var mm=ms[(mi+e2)%ms.length]; if(mm.id===muniId)continue;
          var ss=settlementsOf(mm.id);
          for(var f=0;f<ss.length;f++)if(!s.unlocked[ss[f].id]){ s.unlocked[ss[f].id]=1; newly.push(ss[f].id); break outer; }
        }
      }
    }catch(err){}
  }
  persist();
  return newly;
}
var _worldTotal=0, _contTotals={};
/* Settlements in one continent, cached — used by both the progress bar and the
   unlocked count. */
function continentTotal(contId){
  if(_contTotals[contId]!=null)return _contTotals[contId];
  var n=0, cos=countriesOf(contId);
  for(var a=0;a<cos.length;a++){
    var sts=statesOf(cos[a].id);
    for(var b=0;b<sts.length;b++){
      var ms=municipalitiesOf(sts[b].id);
      for(var d=0;d<ms.length;d++)n+=settlementsOf(ms[d].id).length;
    }
  }
  _contTotals[contId]=n;
  return n;
}
function worldTotal(){
  if(_worldTotal)return _worldTotal;
  var n=0;
  for(var i=0;i<CONTINENTS.length;i++){
    var c=CONTINENTS[i];
    if(!c.countries)continue;
    var cos=countriesOf(c.id);
    for(var a=0;a<cos.length;a++){
      var sts=statesOf(cos[a].id);
      for(var b=0;b<sts.length;b++){
        var ms=municipalitiesOf(sts[b].id);
        for(var d=0;d<ms.length;d++)n+=settlementsOf(ms[d].id).length;
      }
    }
  }
  _worldTotal=n;
  return n;
}
function stats(){
  var s=loadSave();
  /* (9) A wildcard prefix stands for every settlement beneath it, so counting
     literal keys would report a handful after unlocking a whole continent.
     Each prefix contributes its branch's real settlement count. */
  var wild=0;
  var pre=s.unlockedPrefixes||[];
  for(var i=0;i<pre.length;i++){
    var contId=String(pre[i]).split('/')[0];
    wild+=continentTotal(contId);
  }
  return {
    completed:Object.keys(s.completed).length,
    unlocked:Math.min(worldTotal(),Object.keys(s.unlocked).length+wild),
    /* (9) The REAL number of settlements the hierarchy produces. The 4,051,110
       figure is the type-weighting table's sum, not a count of what exists —
       walking the tree yields 81,742. Reporting the weighting total told the
       player they had unlocked a fraction of a world that was never built.
       Counted once and cached: the walk is deterministic, so the answer cannot
       change within a session. */
    total:worldTotal()
  };
}
function resetProgress(){_save=null;try{localStorage.removeItem(SAVE_KEY);}catch(e){}}

global.WorldTour={
  /* Exposed so the shell can warm the table during the title screen rather
     than stalling the first map draw on a 618 KB fetch. */
  loadCityNames:loadCityNames,
  TYPES:TYPES, TOTAL_SETTLEMENTS:TOTAL_SETTLEMENTS, RACE_CFG:RACE_CFG,
  continents:continents, countriesOf:countriesOf, statesOf:statesOf,
  municipalitiesOf:municipalitiesOf, settlementsOf:settlementsOf,
  raceConfigFor:raceConfigFor, typeForRoll:typeForRoll,
  resolveName:resolveName, resolveNames:resolveNames, fallbackName:fallbackName,
  displayName:displayName, homeSettlement:homeSettlement,
  isUnlocked:isUnlocked, isCompleted:isCompleted, completeRace:completeRace,
  stats:stats, worldTotal:worldTotal, continentTotal:continentTotal,
  invalidateSave:invalidateSave, resetProgress:resetProgress, _hash32:hash32,
  unlockBranch:unlockBranch, unlockContinent:unlockContinent, countBranch:countBranch,
  branchHasUnlocked:branchHasUnlocked, branchCompleted:branchCompleted, unlock:unlock,
  ensureContinentEntries:ensureContinentEntries, continentEntryId:continentEntryId,
  /* Explicitly unlocked settlement ids (Tour Progression picks featured towns from these). */
  unlockedIds:function(){ return Object.keys(loadSave().unlocked||{}); }
};

})(typeof window!=='undefined'?window:globalThis);

/*
   TOUR PROGRESSION   (plan part 2 — docs/ENGINE_AND_PROGRESSION_PLAN.md)
   ---------------------------------------------------------------------------
   81,742 towns is a problem of SAMENESS, not of size: without landmarks the
   hundredth race feels like the first. This module gives the world landmarks
   and gives the player reasons to go and find them, without adding or
   removing a single track:

     SIGNATURES  ~40% of municipalities keep a local racing tradition (one of
                 24): GLACIER MILE races on ice, SKYWAY floats over the sky,
                 BANKED BOWL banks every bend, NEON NIGHTS races after dark.
                 Every town in the municipality carries it — generator
                 overrides, a palette, a time of day — so a PLACE is
                 remembered, not a seed.
     LEGENDS     1 town in ~211 is a LEGEND: an absurd, maximal track in a
                 legendary palette. Hidden on the map (a faint sparkle) until
                 a rumour, a Legend Compass or a Mystery Crate reveals it.
     PASSPORT    Winning in a tradition's municipality stamps it. Milestones
                 (3/6/10/15/20/24 stamps) pay out and unlock Tour Stock.
     STREAKS     Consecutive wins raise a multiplier to x2.0; a loss resets it.
     FEATURED    Three unlocked towns a day pay double and drop a crate.
     RUMOURS     A third of wins reveal something nearby: a legend's town, or
                 a tradition not yet stamped. The map marks it until visited.
     TOUR STOCK  A shop tab that grows with the passport: turbo canisters,
                 credit magnets, legend compasses, mystery crates.

   Everything about the world (which town is what) is a pure function of the
   town's id, exactly like the rest of the World Tour; only the player's
   progress is saved.
    */
(function(global){
'use strict';
var W=global.WorldTour; if(!W)return;
var h32=W._hash32;
var KEY='zs_tour_progress_v1';

/* The 24 traditions. `algo` are generator overrides (the same keys the Super
   Racing edit tile uses), `tod` a time of day (0.5 noon, 0.76 golden hour,
   0.95 night). */
var SIGS=[
 {id:'glacier',  name:'GLACIER MILE',     col:'#aee8ff', desc:'Frozen roads. Plan the line; the ice will not forgive.',
  algo:{_forceBiome:'glacier',_surfaceOdds:1,_surfaceShare:0.42,_forceSurface:'ice',_forceFeat:['icerink']}},
 {id:'skyway',   name:'SKYWAY',           col:'#6af0ff', desc:'The road leaves the ground and runs over open sky.',
  algo:{_skyHighwayOdds:1,_forceFeat:['skyhighway'],_feat_skyhighway:6}},
 {id:'bowl',     name:'BANKED BOWL',      col:'#ffb347', desc:'Every long bend is banked. Keep it pinned.',
  algo:{_bankOdds:0.95,_bankAmount:1.05,_forceFeat:['bankedoval'],_feat_bankedoval:6}},
 {id:'neon',     name:'NEON NIGHTS',      col:'#ff4fd8', desc:'Racing after midnight under the city glow.',
  algo:{_forceBiome:'neon',_forceNight:1}, tod:0.95},
 {id:'dust',     name:'DUST DEVILS',      col:'#e8b060', desc:'Sandstorms and sand on the racing line.',
  algo:{_forceBiome:'desert',_sandOdds:1,_stormForce:0.8,_surfaceOdds:1,_surfaceShare:0.3,_forceSurface:'sand'}},
 {id:'canyon',   name:'CANYON KINGS',     col:'#d07040', desc:'Sheer drops and climbs through red rock.',
  algo:{_forceBiome:'canyon',_forceFeat:['plunge','climb','cliffdrop']}},
 {id:'rainbow',  name:'RAINBOW RUN',      col:'#ff9ad0', desc:'Candy colours, no guard rails, no mercy.',
  algo:{_forceTheme:'PASTEL DRIFT',_forceFeat:['rainbowroad','rollerwave']}},
 {id:'storm',    name:'STORM CHASERS',    col:'#7a9ab8', desc:'The worst weather in the world, by choice.',
  algo:{_rainOdds:1,_stormForce:1}},
 {id:'golden',   name:'GOLDEN HOUR',      col:'#ffcf6a', desc:'Every race here starts as the sun goes down.',
  algo:{}, tod:0.76},
 {id:'midnight', name:'MIDNIGHT RUN',     col:'#6a5aff', desc:'Headlights only.',
  algo:{_forceNight:1}, tod:0.97},
 {id:'lakes',    name:'FROZEN LAKES',     col:'#dff6ff', desc:'Snowfall over black ice.',
  algo:{_forceBiome:'arctic',_snowOdds:1,_surfaceOdds:1,_surfaceShare:0.5,_forceSurface:'ice'}},
 {id:'lava',     name:'LAVA FIELDS',      col:'#ff5a1f', desc:'Roads laid across cooling lava crust.',
  algo:{_forceBiome:'volcano',_surfaceOdds:1,_surfaceShare:0.35,_forceSurface:'lava'}},
 {id:'corkscrew',name:'CORKSCREW VALLEY', col:'#9aff6a', desc:'Helixes and loops, one after another.',
  algo:{_forceFeat:['corkscrew','verticalloop'],_feat_corkscrew:8,_feat_verticalloop:5}},
 {id:'tunnels',  name:'TUNNEL TOWN',      col:'#9a9ab8', desc:'Half the lap is underground.',
  algo:{_forceFeat:['tunnel','underpass'],_feat_tunnel:9}},
 {id:'chrome',   name:'CHROME CITY',      col:'#c8d8e8', desc:'Steel grating streets between the towers.',
  algo:{_forceBiome:'city',_surfaceOdds:1,_surfaceShare:0.35,_forceSurface:'metal'}},
 {id:'ghost',    name:'GHOST TOWN',       col:'#a070ff', desc:'Something moves in the dead trees.',
  algo:{_forceBiome:'haunted',_forceNight:1}, tod:0.9},
 {id:'aurora',   name:'AURORA ROAD',      col:'#60ffb0', desc:'Northern lights over the tundra.',
  algo:{_forceBiome:'tundra',_forceNight:1,_snowOdds:1}, tod:0.93},
 {id:'rally',    name:'JUNGLE RALLY',     col:'#2ad06a', desc:'Mud, kinks and crests under the canopy.',
  algo:{_forceBiome:'jungle',_surfaceOdds:1,_surfaceShare:0.4,_forceSurface:'dirt',_forceFeat:['dirtrally']}},
 {id:'sandsea',  name:'SAND SEA',         col:'#f0d890', desc:'Dunes to the horizon, sand underfoot.',
  algo:{_forceBiome:'desert',_surfaceOdds:1,_surfaceShare:0.5,_forceSurface:'sand'}},
 {id:'absurd',   name:'ABSURDIA',         col:'#ff2a6a', desc:'Local planning permission was never sought.',
  algo:{_absurdOdds:1,_forceFeat:['zigzagstorm','turbotornado','spiralstair','blindsnap']}},
 {id:'speed',    name:'SPEED TEMPLE',     col:'#ffe14a', desc:'Long straights, few corners, flat out.',
  algo:{straightBias:6,curveBias:0.45,boostDensity:6,_forceFeat:['straightaway','openrun']}},
 {id:'trials',   name:'TECHNICAL TRIALS', col:'#6ad0ff', desc:'Hairpins and chicanes. Brakes matter here.',
  algo:{curveBias:5.5,technicality:4,_forceFeat:['hairpin','chicanewall']}},
 {id:'islands',  name:'ISLAND HOPPERS',   col:'#40e0d0', desc:'Bridges and jumps between the islands.',
  algo:{_forceBiome:'islands',_forceFeat:['bridge','airgap']}},
 {id:'fog',      name:'FOG VALLEY',       col:'#b8c0c8', desc:'You will hear the corner before you see it.',
  algo:{_fogOdds:1,_fogDensity:1.6}}
];
var LEGEND_PALETTES=['PASTEL DRIFT','SYNTHWAVE GRID','GOLD CIRCUIT','INFERNO CORE','CYBER VIOLET','AURORA DRIFT'];
var LEGEND_FEATS=['cliffdrop','rollerwave','skyhighway','slingshot','spiralstair','blindsnap','zigzagstorm','turbotornado','bankedoval','verticalloop'];
var MILESTONES=[[3,5000,'TOUR STOCK: LEGEND COMPASS'],[6,12000,'TOUR STOCK: MYSTERY CRATE'],[10,30000,'TOUR STOCK: GOLDEN TICKET'],
                [15,60000,'TITLE: GLOBETROTTER'],[20,120000,'TITLE: TOUR VETERAN'],[24,250000,'TITLE: MASTER OF TRADITIONS']];
/* Tour Stock: `need` is the number of passport stamps that unlocks it. */
var STOCK=[
 {id:'canister',name:'TURBO CANISTER', cost:1500, need:0, desc:'+1 turbo charge at the start of your next race.'},
 {id:'magnet',  name:'CREDIT MAGNET',  cost:4000, need:0, desc:'Your next 3 wins pay x1.5 credits.'},
 {id:'compass', name:'LEGEND COMPASS', cost:12000,need:3, desc:'Reveals the nearest hidden legend.'},
 {id:'crate',   name:'MYSTERY CRATE',  cost:6000, need:6, desc:'Credits, a legend or a tradition. Who knows?'},
 {id:'ticket',  name:'GOLDEN TICKET',  cost:25000,need:10,desc:'Your next win counts as featured (x2, crate).'}
];

var _s=null;
function load(){
  if(_s)return _s;
  try{ var r=localStorage.getItem(KEY); _s=r?JSON.parse(r):null; }catch(e){ _s=null; }
  if(!_s||typeof _s!=='object')_s={};
  var d={stamps:{},seen:{},revealed:{},legendsWon:{},streak:0,bestStreak:0,rumours:[],
         stock:{},magnetLeft:0,ticket:0,milestones:{},titles:[],featDay:'',featIds:[],featDone:{},wins:0};
  for(var k in d)if(_s[k]==null)_s[k]=d[k];
  return _s;
}
function save(){ try{ localStorage.setItem(KEY,JSON.stringify(_s)); }catch(e){} }
function reset(){ _s=null; try{ localStorage.removeItem(KEY); }catch(e){} }

function parts(id){ var p=String(id).split('/'); return {
  cont:p[0], country:p.slice(0,2).join('/'), state:p.slice(0,3).join('/'), muni:p.slice(0,4).join('/') }; }
function sigFor(muniId){
  if(!muniId)return null;
  var h=h32(muniId+':sig');
  if(h%100>=40)return null;
  return SIGS[(h>>>7)%SIGS.length];
}
function isLegend(stId){ return (h32(String(stId)+':legend')%211)===0; }
function nameOfMuni(muniId){
  try{ var st=parts(muniId+'/x').state; var ms=W.municipalitiesOf(st);
    for(var i=0;i<ms.length;i++)if(ms[i].id===muniId)return ms[i].name; }catch(e){}
  return 'A DISTANT MUNICIPALITY';
}
function nameOfState(stateId){
  try{ var co=parts(stateId+'/x/x').country; var ss=W.statesOf(co);
    for(var i=0;i<ss.length;i++)if(ss[i].id===stateId)return ss[i].name; }catch(e){}
  return 'A FAR STATE';
}

/* Race options for a settlement: its tradition and, if it is one, its legend. */
function raceOpts(st){
  if(!st||!st.id)return null;
  var muni=st.parent||parts(st.id).muni, sig=sigFor(muni), leg=isLegend(st.id);
  if(!sig&&!leg)return null;
  var algo={}, tod=null, k;
  if(sig){ for(k in sig.algo)algo[k]=sig.algo[k]; if(sig.tod!=null)tod=sig.tod; }
  if(leg){
    var h=h32(st.id+':lg');
    algo._absurdOdds=1; algo._bankOdds=0.7; algo._skyHighwayOdds=0.7;
    algo._forceTheme=LEGEND_PALETTES[h%LEGEND_PALETTES.length];
    var ff=(algo._forceFeat||[]).slice();
    for(var i=0;i<4;i++){ var f=LEGEND_FEATS[(h>>>(i*5))%LEGEND_FEATS.length]; if(ff.indexOf(f)<0)ff.push(f); }
    algo._forceFeat=ff;
    if(tod==null)tod=[0.5,0.76,0.95][(h>>>20)%3];
  }
  return {algo:algo, tod:tod, legend:leg, sig:sig?sig.id:null};
}

/* ── FEATURED TOWNS: three a day from the player's unlocked towns. */
function dayKey(){ var d=new Date(); return d.getFullYear()+'-'+(d.getMonth()+1)+'-'+d.getDate(); }
function featuredIds(){
  var s=load(), key=dayKey();
  if(s.featDay===key&&s.featIds&&s.featIds.length)return s.featIds;
  var ids=[]; try{ ids=(W.unlockedIds?W.unlockedIds():[]).slice(); }catch(e){}
  ids.sort();
  var out=[], h=h32('featured:'+key);
  for(var i=0;i<ids.length&&out.length<3;i++){
    var c=ids[(h+i*2654435761)%ids.length>>>0];
    if(c&&out.indexOf(c)<0)out.push(c);
  }
  s.featDay=key; s.featIds=out; s.featDone={}; save();
  return out;
}
function isFeatured(stId){ return featuredIds().indexOf(stId)>=0&&!load().featDone[stId]; }

/* ── DISCOVERY: find hidden legends / unstamped traditions near a town. */
function settlementsIn(prefixId,level){
  var out=[];
  try{
    var states=(level==='country')?W.statesOf(prefixId):null;
    var countries=(level==='cont')?W.countriesOf(prefixId):null;
    var addState=function(stId){ var ms=W.municipalitiesOf(stId);
      for(var i=0;i<ms.length;i++){ var ts=W.settlementsOf(ms[i].id); for(var j=0;j<ts.length;j++)out.push(ts[j]); } };
    if(states)for(var a=0;a<states.length;a++)addState(states[a].id);
    if(countries)for(var b=0;b<countries.length;b++){ var ss=W.statesOf(countries[b].id); for(var c=0;c<ss.length;c++)addState(ss[c].id); }
  }catch(e){}
  return out;
}
function nearestHiddenLegend(fromId){
  var s=load(), P=parts(fromId);
  var pools=[settlementsIn(P.country,'country'),settlementsIn(P.cont,'cont')];
  for(var p=0;p<pools.length;p++){
    var best=null;
    for(var i=0;i<pools[p].length;i++){ var t=pools[p][i];
      if(isLegend(t.id)&&!s.revealed[t.id]&&!s.legendsWon[t.id]){ best=t; if(t.id.indexOf(P.state)===0)break; } }
    if(best)return best;
  }
  return null;
}
function revealLegend(t){
  var s=load(); s.revealed[t.id]=1;
  var P=parts(t.id);
  var txt='RUMOUR · A LEGEND WAITS IN '+nameOfMuni(P.muni).toUpperCase()+', '+nameOfState(P.state).toUpperCase();
  s.rumours.unshift({id:t.id,muni:P.muni,text:txt}); s.rumours=s.rumours.slice(0,12); save();
  return txt;
}
function revealTradition(fromId){
  var s=load(), P=parts(fromId);
  try{
    var ms=W.municipalitiesOf(P.state);
    for(var i=0;i<ms.length;i++){ var g=sigFor(ms[i].id);
      if(g&&!s.stamps[g.id]&&ms[i].id!==P.muni){
        s.seen[g.id]=1;
        var txt='RUMOUR · THE '+g.name+' TRADITION LIVES IN '+String(ms[i].name).toUpperCase();
        s.rumours.unshift({muni:ms[i].id,text:txt,sig:g.id}); s.rumours=s.rumours.slice(0,12); save();
        return txt; }
    }
  }catch(e){}
  return null;
}
function rumourAt(muniId){ var r=load().rumours; for(var i=0;i<r.length;i++)if(r[i].muni===muniId)return r[i]; return null; }
function visitMuni(muniId){
  var g=sigFor(muniId), s=load(), ch=false;
  if(g&&!s.seen[g.id]){ s.seen[g.id]=1; ch=true; }
  var before=s.rumours.length;
  s.rumours=s.rumours.filter(function(r){ return !(r.muni===muniId&&!r.id); });
  if(ch||s.rumours.length!==before)save();
  return g;
}

function addCredits(n){ try{ if(n>0&&global.UpgradeShop)global.UpgradeShop.addCredits(Math.round(n)); }catch(e){} }
function stampCount(){ return Object.keys(load().stamps).length; }

/* ── THE RESULT: returns the events the victory screen animates. */
function onWin(st,baseCredits){
  var s=load(), ev=[], P=parts(st.id), total=0, base=Math.max(0,baseCredits||0);
  s.wins++;
  s.streak++; if(s.streak>s.bestStreak)s.bestStreak=s.streak;
  var mult=1+Math.min(1,(s.streak-1)*0.1);
  if(s.streak>=2){ var sb=Math.round(base*(mult-1)); total+=sb; ev.push({kind:'streak',streak:s.streak,mult:mult,bonus:sb}); }
  var feat=isFeatured(st.id)||s.ticket>0;
  if(feat){
    if(s.ticket>0&&!isFeatured(st.id))s.ticket--;
    s.featDone[st.id]=1; total+=base; s.stock.crate=(s.stock.crate||0)+1;
    ev.push({kind:'featured',bonus:base});
  }
  if(s.magnetLeft>0){ s.magnetLeft--; var mb=Math.round(base*0.5); total+=mb; ev.push({kind:'magnet',bonus:mb,left:s.magnetLeft}); }
  var g=sigFor(P.muni);
  if(g){ s.seen[g.id]=1;
    if(!s.stamps[g.id]){ s.stamps[g.id]=Date.now(); var n=stampCount();
      ev.push({kind:'stamp',sig:g,n:n,of:SIGS.length});
      for(var m=0;m<MILESTONES.length;m++){ var M=MILESTONES[m];
        if(n>=M[0]&&!s.milestones[M[0]]){ s.milestones[M[0]]=1; total+=M[1];
          if(/^TITLE: /.test(M[2]))s.titles.push(M[2].slice(7));
          ev.push({kind:'milestone',text:M[2],bonus:M[1],at:M[0]}); } } } }
  if(isLegend(st.id)&&!s.legendsWon[st.id]){
    s.legendsWon[st.id]=1; s.revealed[st.id]=1; total+=50000;
    ev.push({kind:'legend',bonus:50000,count:Object.keys(s.legendsWon).length});
  }
  s.rumours=s.rumours.filter(function(r){ return r.id!==st.id&&r.muni!==P.muni; });
  /* A third of wins (and every legend) whisper about something nearby. */
  var rr=h32(st.id+':rum:'+s.wins)%100;
  if(rr<34||isLegend(st.id)){
    var txt=null;
    if(rr%2===0){ var L=nearestHiddenLegend(st.id); if(L)txt=revealLegend(L); }
    if(!txt)txt=revealTradition(st.id);
    if(txt)ev.push({kind:'rumour',text:txt});
  }
  save();
  addCredits(total);
  ev.total=total+base; ev.base=base;
  return ev;
}
function onLoss(){
  var s=load(), was=s.streak; s.streak=0; save();
  return was>=3?[{kind:'streakLost',streak:was}]:[];
}

/* ── MAP DECORATION */
function markerInfo(st){
  var s=load(), P=parts(st.id), g=sigFor(st.parent||P.muni), leg=isLegend(st.id);
  return {sig:g, legend:leg?(s.legendsWon[st.id]?'won':(s.revealed[st.id]?'revealed':'hidden')):null,
          featured:isFeatured(st.id), rumour:!!(leg&&s.revealed[st.id]&&!s.legendsWon[st.id])};
}
function status(){
  var s=load();
  return {stamps:stampCount(),of:SIGS.length,legends:Object.keys(s.legendsWon).length,
          revealed:Object.keys(s.revealed).length,streak:s.streak,bestStreak:s.bestStreak,
          mult:1+Math.min(1,Math.max(0,s.streak)*0.1),featured:featuredIds().filter(function(id){return !s.featDone[id];}).length,
          rumours:s.rumours.slice(0,5),titles:s.titles.slice()};
}

/* ── TOUR STOCK */
function stockOpen(item){ return stampCount()>=item.need; }
function credits(){ try{ return global.UpgradeShop?global.UpgradeShop.credits():0; }catch(e){ return 0; } }
function spend(n){ try{ return !!(global.UpgradeShop&&global.UpgradeShop.spendCredits&&global.UpgradeShop.spendCredits(n)); }catch(e){} return false; }
function buy(id,fromId){
  var it=null; for(var i=0;i<STOCK.length;i++)if(STOCK[i].id===id)it=STOCK[i];
  if(!it)return 'UNKNOWN';
  if(!stockOpen(it))return 'NEEDS '+it.need+' STAMPS';
  if(!spend(it.cost))return 'NOT ENOUGH CREDITS';
  var s=load();
  if(id==='magnet')s.magnetLeft+=3;
  else if(id==='ticket')s.ticket++;
  else s.stock[id]=(s.stock[id]||0)+1;
  save();
  if(id==='compass')return useCompass(fromId)||'NO HIDDEN LEGEND NEARBY';
  if(id==='crate')return openCrate(fromId);
  return it.name+' BOUGHT';
}
function consume(id){ var s=load(); if((s.stock[id]||0)>0){ s.stock[id]--; save(); return true; } return false; }
function useCompass(fromId){
  if(!consume('compass'))return null;
  var from=fromId||(W.homeSettlement&&W.homeSettlement()&&W.homeSettlement().id);
  var L=from?nearestHiddenLegend(from):null;
  return L?revealLegend(L):null;
}
function openCrate(fromId){
  if(!consume('crate'))return null;
  var s=load(), roll=h32('crate:'+s.wins+':'+Date.now())%100;
  var from=fromId||(W.homeSettlement&&W.homeSettlement()&&W.homeSettlement().id);
  if(roll<25&&from){ var L=nearestHiddenLegend(from); if(L)return 'CRATE · '+revealLegend(L); }
  if(roll<50&&from){ var t=revealTradition(from); if(t)return 'CRATE · '+t; }
  var amt=2000+(roll*337)%28000; addCredits(amt);
  return 'CRATE · +'+amt.toLocaleString()+' CR';
}
function turboBonus(){ return consume('canister')?1:0; }

global.TourProgress={
  SIGS:SIGS, STOCK:STOCK, MILESTONES:MILESTONES,
  sigFor:sigFor, isLegend:isLegend, isFeatured:isFeatured, featuredIds:featuredIds,
  raceOpts:raceOpts, onWin:onWin, onLoss:onLoss, markerInfo:markerInfo, status:status,
  visitMuni:visitMuni, rumourAt:rumourAt, buy:buy, stockOpen:stockOpen, turboBonus:turboBonus,
  stampCount:stampCount, load:load, reset:reset, parts:parts, credits:credits,
  _nearestHiddenLegend:nearestHiddenLegend
};
})(typeof window!=='undefined'?window:globalThis);

/* NOTE: this WorldTour module was present THREE times in this file, byte for
   byte identical. Each copy re-declared the whole closure and then overwrote
   global.WorldTour, so only the last one was ever reachable while all three
   were parsed and compiled at startup. The two dead copies are removed.
   Their orphaned _save / _cityNames closures are gone with them. */



/* 
   THE MAP SCREEN   (was worldmap.js)
   ---------------------------------------------------------------------------
   Rendering, camera and interaction for the world map.
    */
/* 
   WORLD TOUR — map rendering and navigation (stage 2)
   ---------------------------------------------------------------------------
   Draws the five levels of the World Tour map and handles controller
   navigation between them:

     WORLD  -> 7 continents
     CONT   -> countries
     COUNTRY-> states
     STATE  -> municipalities
     MUNI   -> settlements (each one a race track)

   All geometry is VECTOR and GENERATED. Outlines come from a seeded radial
   polygon with fractal detail, so a continent has a recognisable, stable shape
   without any stored coordinate data — and every shape is fictional, matching
   no real landmass. The same routine draws every level, which is why zooming
   in feels continuous rather than like five different screens.

   Selection is a light-blue pulsating border on the outline, per the brief.
    */

(function(global){
'use strict';

var W=global.WorldTour;
if(!W)return;

/* ── WEB MERCATOR PROJECTION (EPSG:3857) 
   Landmasses are defined in lon/lat and projected the same way a real map is,
   which is what makes the world read as a world rather than as scattered
   blobs. Latitude is clamped to +/-85.051129 because tan() diverges at the
   poles. */
function projectWebMercator(lon,lat){
  var clamped=Math.max(-85.051129,Math.min(85.051129,lat));
  var rad=clamped*Math.PI/180;
  return [(lon+180)/360, 0.5-Math.log(Math.tan(Math.PI/4+rad/2))/(2*Math.PI)];
}

/* Fictional continents given real-world-like extents. Each is a coarse lon/lat
   ring; detail is added by the fractal displacement below, so the silhouette
   is recognisable without being any real coastline. */
var LANDMASS={
  valoria:  [[25,72],[75,70],[135,65],[170,45],[150,20],[120,10],[95,8],[75,22],[45,38],[28,55]],
  karnath:  [[-18,35],[12,37],[35,30],[45,10],[38,-12],[22,-32],[10,-34],[-10,-18],[-16,8],[-20,22]],
  olenthia: [[-165,68],[-120,70],[-80,62],[-60,45],[-72,28],[-95,20],[-118,32],[-140,55]],
  sundara:  [[-78,10],[-58,6],[-42,-8],[-38,-28],[-55,-48],[-70,-38],[-78,-18],[-82,-2]],
  brackmoor:[[-10,58],[8,62],[28,60],[34,48],[22,40],[2,42],[-8,48]],
  auster:   [[-160,-68],[-90,-72],[-35,-59],[80,-72],[150,-68],[111,-78],[-105,-84],[-148,-88]],
  meridia:  [[112,-12],[140,-14],[154,-26],[148,-40],[128,-36],[114,-30],[110,-20]]
};

/* ── CONTIGUOUS SUBDIVISION 
   Administrative maps are CONTIGUOUS: neighbouring units share an edge exactly,
   with no gaps and no overlap. Independent radial blobs can never do that,
   which is why the earlier map read as scattered shapes rather than a country.

   The fix is to stop generating regions and start SUBDIVIDING the parent. A
   parent polygon is cut by a line into two children, recursively, until the
   requested number of regions exists. Because every cut is shared by exactly
   the two pieces it creates, adjacency is guaranteed by construction — the
   border between two states IS the same list of points in both.

   Cut positions and angles are seeded, so a country's internal layout is
   stable and identical on every device. */

/* Clip a convex-ish polygon by the line through (px,py) with normal (nx,ny).
   Returns the side where the dot product is negative. Standard
   Sutherland–Hodgman: walk the edges, keep inside points, and insert the
   crossing point wherever an edge changes side. That inserted point is what
   both children share, so the seam is exact. */
function clipHalf(poly,px,py,nx,ny){
  var out=[],n=poly.length;
  for(var i=0;i<n;i++){
    var a=poly[i], b=poly[(i+1)%n];
    var da=(a[0]-px)*nx+(a[1]-py)*ny;
    var db=(b[0]-px)*nx+(b[1]-py)*ny;
    if(da<=0)out.push(a);
    if((da<0&&db>0)||(da>0&&db<0)){
      var t=da/(da-db);
      out.push([a[0]+(b[0]-a[0])*t, a[1]+(b[1]-a[1])*t]);
    }
  }
  return out;
}
function polyBounds(poly){
  var minX=1e9,minY=1e9,maxX=-1e9,maxY=-1e9;
  for(var i=0;i<poly.length;i++){
    if(poly[i][0]<minX)minX=poly[i][0];
    if(poly[i][0]>maxX)maxX=poly[i][0];
    if(poly[i][1]<minY)minY=poly[i][1];
    if(poly[i][1]>maxY)maxY=poly[i][1];
  }
  return {minX:minX,minY:minY,maxX:maxX,maxY:maxY,w:maxX-minX,h:maxY-minY};
}
function polyCentroid(poly){
  var x=0,y=0;
  for(var i=0;i<poly.length;i++){x+=poly[i][0];y+=poly[i][1];}
  return [x/poly.length,y/poly.length];
}
function polyArea(poly){
  var a=0;
  for(var i=0;i<poly.length;i++){
    var p=poly[i],q=poly[(i+1)%poly.length];
    a+=p[0]*q[1]-q[0]*p[1];
  }
  return Math.abs(a/2);
}
/* Split `poly` into `count` contiguous pieces. Always cuts the LARGEST piece,
   which keeps the regions comparable in size instead of producing one huge
   region and a row of slivers. */
function subdivide(poly,count,seedKey){
  var r=rngFor('sub:'+seedKey);
  var parts=[poly];
  var guard=0;
  while(parts.length<count&&guard++<count*4){
    // largest piece
    var bi=0,ba=-1;
    for(var i=0;i<parts.length;i++){
      var a=polyArea(parts[i]);
      if(a>ba){ba=a;bi=i;}
    }
    var tgt=parts[bi];
    var c=polyCentroid(tgt);
    // Cut through a point near the centroid at a seeded angle. Offsetting the
    // cut point stops every region becoming a neat pie slice.
    /* CUT ACROSS THE LONG AXIS, NOT AT RANDOM.
       A random angle will sometimes slice a long thin region lengthwise,
       making both halves thinner still. Repeat that four levels deep and every
       region degenerates into a diagonal sliver — which is exactly what the
       state and municipality maps were doing.
       Cutting perpendicular to the region's longest extent keeps children
       closer to square, so subdivision stays stable at any depth. */
    var bb=polyBounds(tgt);
    var wide=(bb.w>=bb.h);
    /* Normal points along the long axis, so the cut line runs across it. */
    var baseAng=wide?0:Math.PI/2;
    var ang=baseAng+(r()-0.5)*0.6;        // +/-17 deg of variation
    var ext=Math.sqrt(ba)||1;
    /* Offset only along the cut direction, so the split stays near the middle
       of the long axis rather than shaving a sliver off one end. */
    var off=(r()-0.5)*0.22;
    var px=c[0]+(wide?off*bb.w:0), py=c[1]+(wide?0:off*bb.h);
    var nx=Math.cos(ang), ny=Math.sin(ang);
    var A=clipHalf(tgt,px,py,nx,ny);
    var B=clipHalf(tgt,px,py,-nx,-ny);
    if(A.length<3||B.length<3)continue;
    // Reject cuts that produce a sliver: a region thinner than 12% of its
    // parent is unusable as a map area and, once re-fitted to the viewport,
    // collapses the whole level into a diagonal streak.
    var aA=polyArea(A), aB=polyArea(B);
    if(Math.min(aA,aB)<ba*0.12)continue;
    parts.splice(bi,1,A,B);
  }
  return parts;
}

/* Regions for a level, cached. The parent's polygon is the input, so children
   always tile their parent exactly. */
var _regionCache={};
function regionsFor(parentPoly,count,key){
  var ck=key+'|'+count;
  if(_regionCache[ck])return _regionCache[ck];
  var parts=subdivide(parentPoly,count,key);
  _regionCache[ck]=parts;
  return parts;
}

/* ── SHAPE GENERATION 
   A closed polygon built by walking angles around a centre, with the radius
   perturbed by summed sine octaves. Low octaves give the broad continental
   form, high octaves give coastline detail. Seeded on the node id, so a place
   looks the same every visit. */
function outlineFor(id,points,rough,aspect){
  var r=rngFor(id), pts=[], n=points||64;
  var a0=r()*Math.PI*2;
  /* Three octaves with independent phases; amplitudes fall off so the shape
     stays readable rather than becoming noise. */
  var f1=1+Math.floor(r()*3), p1=r()*6.283, a1=0.26+r()*0.20;
  var f2=3+Math.floor(r()*4), p2=r()*6.283, a2=0.13+r()*0.10;
  var f3=7+Math.floor(r()*6), p3=r()*6.283, a3=(rough||1)*(0.05+r()*0.05);
  for(var i=0;i<n;i++){
    var t=i/n, a=a0+t*Math.PI*2;
    var rad=1
      +Math.sin(a*f1+p1)*a1
      +Math.sin(a*f2+p2)*a2
      +Math.sin(a*f3+p3)*a3;
    rad=Math.max(0.35,rad);
    pts.push([Math.cos(a)*rad*(aspect||1), Math.sin(a)*rad]);
  }
  return pts;
}
function rngFor(key){
  var h=2166136261>>>0;
  for(var i=0;i<key.length;i++){h^=key.charCodeAt(i);h=Math.imul(h,16777619)>>>0;}
  var s=h||1;
  return function(){s^=s<<13;s^=s>>>17;s^=s<<5;s>>>=0;return s/4294967296;};
}

/* Cache outlines: they never change, and regenerating 64 points per node per
   frame would be wasteful at the settlement level. */
var _shapeCache={};
function shape(id,points,rough,aspect){
  var k=id+'|'+(points||64);
  if(!_shapeCache[k])_shapeCache[k]=outlineFor(id,points,rough,aspect);
  return _shapeCache[k];
}

/* Landmass ring in normalised Mercator space, subdivided and displaced so the
   coastline has detail rather than being a straight-edged polygon. */
var _ringCache={};
function mercatorRing(id,vw,vh){
  var k=id+'|'+vw+'x'+vh;
  if(_ringCache[k])return _ringCache[k];
  var base=LANDMASS[id];
  if(!base)return null;
  var r=rngFor('coast:'+id), out=[];
  for(var i=0;i<base.length;i++){
    var a=base[i], b=base[(i+1)%base.length];
    // 8 subdivisions per edge, each nudged perpendicular for coastline noise.
    for(var t=0;t<8;t++){
      var f=t/8;
      var lon=a[0]+(b[0]-a[0])*f, lat=a[1]+(b[1]-a[1])*f;
      var dx=b[0]-a[0], dy=b[1]-a[1];
      var len=Math.sqrt(dx*dx+dy*dy)||1;
      var amp=(r()-0.5)*len*0.16;
      lon+=(-dy/len)*amp; lat+=(dx/len)*amp;
      var uv=projectWebMercator(lon,lat);
      /* Same inward fit for the projected rings. */
      out.push([vw*0.5+(uv[0]-0.5)*vw*0.80, vh*0.5+(uv[1]-0.5)*vh*0.74]);
    }
  }
  _ringCache[k]=out;
  return out;
}
function traceRing(ctx,pts){
  ctx.beginPath();
  for(var i=0;i<pts.length;i++){
    if(i===0)ctx.moveTo(pts[i][0],pts[i][1]); else ctx.lineTo(pts[i][0],pts[i][1]);
  }
  ctx.closePath();
}
function tracePoly(ctx,pts,cx,cy,sx,sy){
  ctx.beginPath();
  for(var i=0;i<pts.length;i++){
    var x=cx+pts[i][0]*sx, y=cy+pts[i][1]*sy;
    if(i===0)ctx.moveTo(x,y); else ctx.lineTo(x,y);
  }
  ctx.closePath();
}

/* ── TERRAIN 
   Each region gets a biome derived from its position and seed, then a fill and
   a scatter of marks. Latitude drives the choice — ice near the poles, desert
   near the tropics, temperate between — so the map reads as a planet rather
   than as coloured cells. */
var BIOMES={
  water:    {fill:'#0a2a44',mark:'#1d4f74',pat:'wave'},
  grass:    {fill:'#12331c',mark:'#1e5730',pat:'tuft'},
  forest:   {fill:'#0d2a17',mark:'#1a4d28',pat:'tree'},
  dirt:     {fill:'#2b2015',mark:'#4a3822',pat:'speck'},
  sand:     {fill:'#3a3018',mark:'#6b5a2e',pat:'dune'},
  rock:     {fill:'#242832',mark:'#3d4552',pat:'crag'},
  mountain: {fill:'#1e2430',mark:'#5a6675',pat:'peak'},
  ice:      {fill:'#26384a',mark:'#9fd4e8',pat:'shard'}
};
var BIOME_KEYS=['water','grass','forest','dirt','sand','rock','mountain','ice'];

function biomeFor(id,cy,vh){
  var r=rngFor('biome:'+id);
  var lat=Math.abs((cy/vh)-0.5)*2;          // 0 equator .. 1 pole
  var roll=r();
  if(lat>0.78)return roll<0.62?'ice':'mountain';
  if(lat>0.55)return roll<0.30?'mountain':(roll<0.62?'rock':'forest');
  if(lat<0.20)return roll<0.32?'sand':(roll<0.58?'dirt':'grass');
  if(roll<0.14)return 'water';
  if(roll<0.42)return 'grass';
  if(roll<0.64)return 'forest';
  if(roll<0.80)return 'dirt';
  return roll<0.92?'rock':'mountain';
}

/* Terrain marks inside a clipped region. Deterministic per region so the
   ground does not shimmer between frames. */
function drawTerrain(ctx,poly,id,bio,t){
  var B=BIOMES[bio]||BIOMES.grass;
  var minX=1e9,minY=1e9,maxX=-1e9,maxY=-1e9;
  for(var i=0;i<poly.length;i++){
    if(poly[i][0]<minX)minX=poly[i][0];
    if(poly[i][0]>maxX)maxX=poly[i][0];
    if(poly[i][1]<minY)minY=poly[i][1];
    if(poly[i][1]>maxY)maxY=poly[i][1];
  }
  var w=maxX-minX,h=maxY-minY;
  if(w<8||h<8)return;
  var r=rngFor('terr:'+id);
  var n=Math.min(70,Math.max(8,Math.round(w*h/900)));
  ctx.save();
  traceRing(ctx,poly);ctx.clip();
  ctx.fillStyle=B.mark;ctx.strokeStyle=B.mark;ctx.lineWidth=1;
  for(var k=0;k<n;k++){
    var x=minX+r()*w, y=minY+r()*h, sc=2+r()*3;
    if(B.pat==='wave'){
      // Water ripples drift, which is the one motion the eye expects here.
      ctx.globalAlpha=0.5;
      ctx.beginPath();
      ctx.arc(x,y+Math.sin(t*0.6+k)*1.5,sc*1.4,Math.PI*0.15,Math.PI*0.85);
      ctx.stroke();
    } else if(B.pat==='tree'){
      ctx.globalAlpha=0.75;
      ctx.beginPath();ctx.moveTo(x,y+sc);ctx.lineTo(x-sc*0.6,y+sc);
      ctx.lineTo(x,y-sc);ctx.lineTo(x+sc*0.6,y+sc);ctx.closePath();ctx.fill();
    } else if(B.pat==='peak'||B.pat==='crag'){
      ctx.globalAlpha=0.8;
      ctx.beginPath();ctx.moveTo(x-sc,y+sc*0.7);ctx.lineTo(x,y-sc);
      ctx.lineTo(x+sc,y+sc*0.7);ctx.closePath();ctx.fill();
    } else if(B.pat==='dune'){
      ctx.globalAlpha=0.55;
      ctx.beginPath();ctx.arc(x,y,sc*1.6,Math.PI,Math.PI*2);ctx.stroke();
    } else if(B.pat==='shard'){
      ctx.globalAlpha=0.7;
      ctx.beginPath();ctx.moveTo(x,y-sc);ctx.lineTo(x+sc*0.5,y);
      ctx.lineTo(x,y+sc);ctx.lineTo(x-sc*0.5,y);ctx.closePath();ctx.fill();
    } else if(B.pat==='tuft'){
      ctx.globalAlpha=0.6;
      ctx.beginPath();ctx.moveTo(x,y+sc);ctx.lineTo(x,y-sc*0.8);ctx.stroke();
      ctx.beginPath();ctx.moveTo(x-sc*0.5,y+sc);ctx.lineTo(x,y-sc*0.3);ctx.stroke();
    } else {
      ctx.globalAlpha=0.5;
      ctx.fillRect(x,y,sc*0.8,sc*0.8);
    }
  }
  ctx.globalAlpha=1;
  ctx.restore();
}

/* ── MAP STATE 
   `path` is the breadcrumb from world down to the current level. Keeping it as
   a stack means Back is just a pop, and the player always returns to exactly
   the municipality they came from — which point 10 of the brief requires. */
var MapState={
  level:'world',                  // world | cont | country | state | muni
  path:[],                        // [{level,id,name}]
  items:[],                       // nodes at this level
  sel:0,
  zoom:0,                         // 0..1 transition progress
  zoomFrom:null,
  _t:0
};

var LEVEL_ORDER=['world','cont','country','state','muni'];

function itemsForLevel(){
  var p=MapState.path;
  switch(MapState.level){
    case 'world':   return W.continents();
    case 'cont':    return W.countriesOf(p[p.length-1].id);
    case 'country': return W.statesOf(p[p.length-1].id);
    case 'state':   return W.municipalitiesOf(p[p.length-1].id);
    case 'muni':    return W.settlementsOf(p[p.length-1].id);
  }
  return [];
}

function enter(){
  var it=MapState.items[MapState.sel];
  if(!it)return false;
  if(MapState.level==='muni'){
    /* Settlements are leaves: selecting one launches its race rather than
       descending further. */
    if(typeof global.WorldTourRace==='function')global.WorldTourRace(it);
    return true;
  }
  var next=LEVEL_ORDER[LEVEL_ORDER.indexOf(MapState.level)+1];
  MapState.path.push({level:MapState.level,id:it.id,name:it.name,
                      idx:MapState.sel,sibs:MapState.items.length});
  MapState.level=next;
  MapState.items=itemsForLevel();
  MapState.sel=0;
  /* (1) Preselect the branch containing the player's start at EVERY level, not
     just the continent. Defaulting to index 0 below the top meant the named
     path was only honoured on the first screen and the player still had to
     hunt for the one unlocked settlement. */
  try{
    var h=W.homeSettlement&&W.homeSettlement();
    if(h){
      var want=(MapState.level==='cont')?h.country
             :(MapState.level==='country')?h.state
             :(MapState.level==='state')?h.muni
             :(MapState.level==='muni')?h.id:null;
      if(want)for(var q=0;q<MapState.items.length;q++)
        if(MapState.items[q].id===want){MapState.sel=q;break;}
    }
  }catch(e){}
  MapState.zoom=0;                          // triggers the zoom-in transition
  if(MapState.level==='muni')W.resolveNames(MapState.items);
  return true;
}
function back(){
  if(!MapState.path.length)return false;
  var prev=MapState.path.pop();
  MapState.level=prev.level;
  MapState.items=itemsForLevel();
  /* Restore the selection the player left from, so backing out lands where
     they expect instead of at the first item. */
  for(var i=0;i<MapState.items.length;i++)
    if(MapState.items[i].id===prev.id)MapState.sel=i;
  MapState.zoom=1;
  return true;
}
function nav(d){
  if(!MapState.items.length)return;
  MapState.sel=(MapState.sel+d+MapState.items.length)%MapState.items.length;
}
/* (1) DIRECTIONAL NAVIGATION.
   Cycling through an index is fine for a list but wrong for a map — the next
   item in the array is rarely the one next to you on screen. This picks the
   nearest region in the pressed direction, scoring by angle first and distance
   second, so pressing right goes to the region on the right. */
var _navPos={};
function navDir(dx,dy){
  var items=MapState.items;
  if(!items.length)return;
  var cur=_navPos[MapState.sel];
  if(!cur)return nav(dx+dy>0?1:-1);
  /* (2) Two passes with a widening cone. The single 0.35 cutoff (~70 degrees)
     rejected regions that were plainly up or down but slightly offset, leaving
     presses that did nothing — the most common complaint about map movement.
     A tight cone is tried first so the obvious neighbour still wins; if
     nothing qualifies the cone opens to almost 180 degrees, and only then does
     it fall back to index order. Movement therefore ALWAYS goes somewhere. */
  function search(minAlong){
    var best=-1,bestScore=1e18;
    for(var i=0;i<items.length;i++){
      if(i===MapState.sel)continue;
      var p=_navPos[i]; if(!p)continue;
      var ox=p[0]-cur[0], oy=p[1]-cur[1];
      var dist=Math.sqrt(ox*ox+oy*oy); if(dist<1)continue;
      var along=(ox*dx+oy*dy)/dist;
      if(along<minAlong)continue;
      /* Distance penalised by how far off-axis the target is, so a near
         neighbour slightly off to the side still beats a distant exact one. */
      var score=dist/Math.max(0.15,along*along);
      if(score<bestScore){bestScore=score;best=i;}
    }
    return best;
  }
  var best=search(0.55);
  if(best<0)best=search(0.15);
  if(best<0)best=search(-0.20);
  if(best<0){
    /* Nothing in that direction at all — step through the list so the press is
       never silently swallowed. */
    MapState.sel=(MapState.sel+((dx+dy)>0?1:-1)+items.length)%items.length;
    return;
  }
  MapState.sel=best;
}
function resetMap(){
  MapState.level='world';MapState.path=[];MapState.sel=0;
  MapState.items=itemsForLevel();MapState.zoom=1;
  /* (1) Open on the continent that actually contains the player's start,
     rather than always on the first in the list. Landing on a continent with
     nothing unlocked gives a new player no visible way forward. */
  try{
    var h=W.homeSettlement&&W.homeSettlement();
    if(h&&h.continent){
      for(var i=0;i<MapState.items.length;i++)
        if(MapState.items[i].id===h.continent){MapState.sel=i;break;}
    }
  }catch(e){}
}

/* ── DRAWING 
   One routine for every level. Continents use their declared positions and
   area shares; deeper levels use the per-node px/py/size the model generates,
   so a country's states are laid out inside it rather than at random. */
/* The polygon the current level lives inside. At continent level that is the
   parent continent's own Mercator outline, so a country map keeps the shape of
   the landmass rather than becoming a generic rectangle. Deeper levels inherit
   the piece their parent occupied. */
/* Fit a polygon to the viewport, preserving its shape. Descending a level
   should ZOOM IN on the region, not keep drawing it at world scale — at world
   scale a continent's 54 countries are a few pixels each. */
/* Rescale a polygon so its bounding box is square, preserving relative shape
   within it. Applied between levels so distortion cannot accumulate. */
function normaliseAspect(poly){
  if(!poly||poly.length<3)return poly;
  var b=polyBounds(poly);
  if(b.w<1e-6||b.h<1e-6)return poly;
  var t=Math.max(b.w,b.h);
  var sx=t/b.w, sy=t/b.h;
  /* Damped: full correction would flatten genuine regional character. */
  sx=1+(sx-1)*0.65; sy=1+(sy-1)*0.65;
  return poly.map(function(pt){
    return [b.minX+(pt[0]-b.minX)*sx, b.minY+(pt[1]-b.minY)*sy];
  });
}
function fitPoly(poly,vw,vh){
  if(!poly||poly.length<3)return poly;
  var minX=1e9,minY=1e9,maxX=-1e9,maxY=-1e9;
  for(var i=0;i<poly.length;i++){
    if(poly[i][0]<minX)minX=poly[i][0];
    if(poly[i][0]>maxX)maxX=poly[i][0];
    if(poly[i][1]<minY)minY=poly[i][1];
    if(poly[i][1]>maxY)maxY=poly[i][1];
  }
  var w=maxX-minX||1, h=maxY-minY||1;
  var pad=0.86;
  var sc=Math.min(vw*pad/w, vh*pad/h);
  var ox=(vw-w*sc)/2-minX*sc, oy=(vh-h*sc)/2-minY*sc;
  var out=[];
  for(var j=0;j<poly.length;j++)out.push([poly[j][0]*sc+ox, poly[j][1]*sc+oy]);
  return out;
}
function parentPoly(vw,vh){
  var p=MapState.path;
  if(!p.length)return null;
  if(p.length===1){
    return fitPoly(mercatorRing(p[0].id,vw,vh)||framePoly(vw,vh),vw,vh);
  }
  /* Rebuild the ancestry: each level's polygon is a piece of the one above. */
  var poly=fitPoly(mercatorRing(p[0].id,vw,vh)||framePoly(vw,vh),vw,vh);
  for(var i=1;i<p.length;i++){
    var parts=regionsFor(poly,siblingCountAt(i),p[i-1].id);
    poly=parts[Math.min(indexAt(i),parts.length-1)]||poly;
    /* Normalise the piece to a square-ish box before it becomes the parent of
       the next level. Without this the aspect distortion compounds with depth:
       a slightly elongated country yields elongated states, which yield
       extremely elongated municipalities. */
    poly=normaliseAspect(poly);
  }
  return poly;
}
function framePoly(vw,vh){
  var m=Math.min(vw,vh)*0.06;
  return [[m,m],[vw-m,m],[vw-m,vh-m],[m,vh-m]];
}
/* How many siblings existed at depth i, and which one was chosen. Stored on
   the path when descending so the ancestry can be replayed exactly. */
function siblingCountAt(i){
  var e=MapState.path[i];
  return (e&&e.sibs)||8;
}
function indexAt(i){
  var e=MapState.path[i];
  return (e&&e.idx)||0;
}
/* Child polygon for item i at the current level. */
/* Children are subdivided from the parent AS FITTED to the viewport, and the
   whole set is fitted together afterwards. Fitting each child individually —
   which the earlier version effectively did by re-fitting the parent at every
   lookup — pushed siblings off screen and left only one visible. */
var _fitCache={};
function regionPoly(i,count,vw,vh){
  var key=(MapState.path.length?MapState.path[MapState.path.length-1].id:'root')
          +'|'+count+'|'+vw+'x'+vh;
  var set=_fitCache[key];
  if(!set){
    var pp=parentPoly(vw,vh);
    if(!pp)return null;
    var parts=regionsFor(pp,count,
      MapState.path.length?MapState.path[MapState.path.length-1].id:'root');
    /* Fit the union of all children with ONE transform, so their shared
       borders stay shared and the level fills the screen. */
    var minX=1e9,minY=1e9,maxX=-1e9,maxY=-1e9;
    parts.forEach(function(pg){pg.forEach(function(pt){
      if(pt[0]<minX)minX=pt[0]; if(pt[0]>maxX)maxX=pt[0];
      if(pt[1]<minY)minY=pt[1]; if(pt[1]>maxY)maxY=pt[1];
    });});
    var w=maxX-minX||1,h=maxY-minY||1,pad=0.82;
    var sc=Math.min(vw*pad/w,vh*pad/h);
    var ox=(vw-w*sc)/2-minX*sc, oy=(vh-h*sc)/2-minY*sc;
    set=parts.map(function(pg){
      return pg.map(function(pt){return [pt[0]*sc+ox,pt[1]*sc+oy];});
    });
    _fitCache[key]=set;
  }
  return set[Math.min(i,set.length-1)]||null;
}


/* ═══ POLE OF INACCESSIBILITY 
   The label anchor used to be the vertex average blended with the bounding-box
   centre. For a CONCAVE ring — a crescent, a horseshoe, a long bent hundred —
   both of those land OUTSIDE the polygon, which is why some settlement names
   were drawn off their own shape.

   This finds the interior point furthest from any edge (the "pole of
   inaccessibility") with a coarse-to-fine grid search. It is guaranteed to be
   inside the polygon and sits in the visually widest part of it, which is
   exactly where a label belongs. */
function _pipInRing(px,py,ring){
  var inside=false;
  for(var i=0,j=ring.length-1;i<ring.length;j=i++){
    var xi=ring[i][0],yi=ring[i][1],xj=ring[j][0],yj=ring[j][1];
    if(((yi>py)!==(yj>py))&&(px<(xj-xi)*(py-yi)/((yj-yi)||1e-9)+xi))inside=!inside;
  }
  return inside;
}
function _distToRing(px,py,ring){
  var best=Infinity;
  for(var i=0,j=ring.length-1;i<ring.length;j=i++){
    var x1=ring[i][0],y1=ring[i][1],x2=ring[j][0],y2=ring[j][1];
    var dx=x2-x1,dy=y2-y1,L2=dx*dx+dy*dy;
    var tt=L2?Math.max(0,Math.min(1,((px-x1)*dx+(py-y1)*dy)/L2)):0;
    var qx=x1+tt*dx-px, qy=y1+tt*dy-py;
    var d=Math.sqrt(qx*qx+qy*qy);
    if(d<best)best=d;
  }
  return best;
}
function ringLabelPoint(ring){
  if(!ring||ring.length<3)return null;
  var minX=Infinity,maxX=-Infinity,minY=Infinity,maxY=-Infinity;
  for(var i=0;i<ring.length;i++){
    var p=ring[i];
    if(p[0]<minX)minX=p[0]; if(p[0]>maxX)maxX=p[0];
    if(p[1]<minY)minY=p[1]; if(p[1]>maxY)maxY=p[1];
  }
  var bw=maxX-minX, bh=maxY-minY;
  if(bw<=0||bh<=0)return null;
  var bx=(minX+maxX)/2, by=(minY+maxY)/2;
  var best=null, bestD=-1;
  /* Coarse pass: 12x12 grid over the bounding box. */
  for(var gx=1;gx<12;gx++)for(var gy=1;gy<12;gy++){
    var px=minX+bw*gx/12, py=minY+bh*gy/12;
    if(!_pipInRing(px,py,ring))continue;
    var d=_distToRing(px,py,ring);
    if(d>bestD){bestD=d;best=[px,py];}
  }
  if(!best)return null;
  /* Fine pass: shrinking local search around the coarse winner. */
  var step=Math.min(bw,bh)/12;
  for(var it2=0;it2<4;it2++){
    step*=0.5;
    for(var ox=-1;ox<=1;ox++)for(var oy=-1;oy<=1;oy++){
      if(!ox&&!oy)continue;
      var nx=best[0]+ox*step, ny=best[1]+oy*step;
      if(!_pipInRing(nx,ny,ring))continue;
      var nd=_distToRing(nx,ny,ring);
      if(nd>bestD){bestD=nd;best=[nx,ny];}
    }
  }
  return best;
}

function draw(ctx,vw,vh,dt){
  MapState._t+=dt;
  ctx.save();
  /* (12) CLEAR, DO NOT PAINT BLACK.
     Filling with opaque #000 every frame hid the fluid layer sitting behind
     this canvas — which is why the effect only showed at the screen edges
     where the map's own gradients happened to be translucent.
     clearRect leaves the canvas transparent, so the fluid shows through
     everywhere the map does not draw, surrounding the continent, country,
     state and municipality shapes. A light wash keeps text readable. */
  ctx.clearRect(0,0,vw,vh);
  /* (6) Opaque enough to hide the title screen behind it, translucent enough
     that the fluid still reads through. */
  ctx.fillStyle='rgba(0,3,10,0.62)';ctx.fillRect(0,0,vw,vh);

  /* (1) PLANET FRAMING. At world level a soft limb and atmospheric rim are
     drawn behind the landmasses so the map reads as a globe surface rather
     than shapes on a void. */
  if(MapState.level==='world'){
    var pg=ctx.createRadialGradient(vw*0.5,vh*0.5,Math.min(vw,vh)*0.10,
                                    vw*0.5,vh*0.5,Math.min(vw,vh)*0.62);
    /* (12) Translucent so the fluid reads through the planet body as well as
       around it — an opaque gradient hid the effect at world level entirely. */
    pg.addColorStop(0,'rgba(6,38,63,0.72)');
    pg.addColorStop(0.72,'rgba(3,18,31,0.66)');
    pg.addColorStop(1,'rgba(0,0,0,0.55)');
    ctx.fillStyle=pg;ctx.fillRect(0,0,vw,vh);
    ctx.strokeStyle='rgba(90,190,255,0.20)';ctx.lineWidth=2;
    ctx.beginPath();ctx.ellipse(vw*0.5,vh*0.5,vw*0.47,vh*0.46,0,0,Math.PI*2);ctx.stroke();
    /* Latitude/longitude graticule — cheap, and it sells the sphere. */
    ctx.strokeStyle='rgba(80,170,220,0.10)';ctx.lineWidth=1;
    for(var gy=1;gy<6;gy++){
      var yy=vh*(gy/6);
      ctx.beginPath();ctx.moveTo(0,yy);ctx.lineTo(vw,yy);ctx.stroke();
    }
    for(var gx=1;gx<9;gx++){
      var xx=vw*(gx/9);
      ctx.beginPath();ctx.moveTo(xx,0);ctx.lineTo(xx,vh);ctx.stroke();
    }
  }

  /* (1) RACING CHECKERBOARD FRAME. Two rows of squares along every edge,
     scrolling slowly so the screen always has motion in it. */
  drawCheckerFrame(ctx,vw,vh,MapState._t);

  if(MapState.zoom<1)MapState.zoom=Math.min(1,MapState.zoom+dt*2.2);
  var ease=1-Math.pow(1-MapState.zoom,3);

  var items=MapState.items;
  var isWorld=(MapState.level==='world');
  var pulse=0.5+0.5*Math.sin(MapState._t*3.2);

  /* Zoom-in: the level grows from small to full as it arrives, so descending
     reads as flying into the map rather than a cut. */
  var gz=0.82+ease*0.18;
  ctx.translate(vw/2,vh/2);ctx.scale(gz,gz);ctx.translate(-vw/2,-vh/2);
  ctx.globalAlpha=ease;

  for(var i=0;i<items.length;i++){
    var it=items[i];
    var selD=(i===MapState.sel);

    /* Position + size. Continents are placed on a world layout; everything
       else uses its generated position inside the parent. */
    var cx,cy,rad;
    if(isWorld){
      /* (5) Pull the layout inward so the landmasses sit inside the oval that
         represents the planet, instead of overrunning its edges. */
      cx=vw*0.5+(it.cx-0.5)*vw*0.80;
      cy=vh*0.5+(it.cy-0.5)*vh*0.74;
      rad=Math.sqrt(it.areaShare)*Math.min(vw,vh)*0.62;
    } else {
      cx=it.px*vw; cy=it.py*vh;
      var base=Math.min(vw,vh)*(MapState.level==='muni'?0.055:0.10);
      rad=base*(it.size||1);
    }

    var isSettlement=(MapState.level==='muni');
    if(isSettlement){
      /* (1) The municipality's own outline is drawn once, before the markers,
         so the settlements sit visibly INSIDE their region instead of floating
         on an empty screen with no sense of where they are. */
      if(i===0){
        var mp=parentPoly(vw,vh);
        if(mp&&mp.length>2){
          mp=fitPoly(mp,vw,vh);
          MapState._muniPoly=mp;
          var mb=biomeFor(MapState.path[MapState.path.length-1].id,vh*0.5,vh);
          traceRing(ctx,mp);
          ctx.fillStyle=BIOMES[mb].fill;ctx.fill();
          drawTerrain(ctx,mp,MapState.path[MapState.path.length-1].id,mb,MapState._t);
          traceRing(ctx,mp);
          ctx.strokeStyle='rgba(120,240,150,0.85)';ctx.lineWidth=3;
          ctx.shadowColor='rgba(120,240,150,0.5)';ctx.shadowBlur=8;
          ctx.stroke();ctx.shadowBlur=0;
        }
      }
      /* (2) VORONOI CELLS. Each settlement owns the part of the municipality
         nearest to it, drawn as faint boundaries. That is what actually
         communicates "this area belongs to this settlement" — markers alone
         look like scattered dots on a shape.
         Computed by sampling: for every point on a coarse grid, find the
         nearest settlement, and draw a boundary wherever neighbouring samples
         disagree. Cheap, and it needs no polygon clipping. */
      if(i===0&&MapState._muniPoly){
        var vb=polyBounds(MapState._muniPoly);
        /* (10) Finer sampling: at 1/34 the cells were too coarse for a name to sit
   reliably inside its own territory. */
var stp=Math.max(4,Math.round(Math.min(vb.w,vb.h)/56));
        var pts=[];
        for(var q=0;q<items.length;q++){
          var qa=((q%8)/Math.min(8,items.length))*Math.PI*2+Math.floor(q/8)*0.6;
          var qr=(0.22+Math.floor(q/8)/Math.max(1,Math.ceil(items.length/8))*0.52);
          pts.push([vb.minX+vb.w*(0.5+Math.cos(qa)*qr*0.78),
                    vb.minY+vb.h*(0.5+Math.sin(qa)*qr*0.72)]);
        }
        ctx.save();
        traceRing(ctx,MapState._muniPoly);ctx.clip();
        ctx.strokeStyle='rgba(150,255,190,0.22)';ctx.lineWidth=1;
        var near=function(px,py){
          var b=0,bd=1e18;
          for(var z=0;z<pts.length;z++){
            var dx2=pts[z][0]-px, dy2=pts[z][1]-py, d2=dx2*dx2+dy2*dy2;
            if(d2<bd){bd=d2;b=z;}
          }
          return b;
        };
        for(var gy2=vb.minY;gy2<vb.minY+vb.h;gy2+=stp){
          for(var gx2=vb.minX;gx2<vb.minX+vb.w;gx2+=stp){
            var c0=near(gx2,gy2);
            if(near(gx2+stp,gy2)!==c0){
              ctx.beginPath();ctx.moveTo(gx2+stp/2,gy2-stp/2);
              ctx.lineTo(gx2+stp/2,gy2+stp/2);ctx.stroke();
            }
            if(near(gx2,gy2+stp)!==c0){
              ctx.beginPath();ctx.moveTo(gx2-stp/2,gy2+stp/2);
              ctx.lineTo(gx2+stp/2,gy2+stp/2);ctx.stroke();
            }
          }
        }
        ctx.restore();
      }
      /* (1) Settlements are laid out on a jittered ring inside the region so
         they cannot overlap. A raw random position collides constantly once a
         municipality holds a dozen of them. */
      if(MapState._muniPoly){
        var mpb=polyBounds(MapState._muniPoly);
        var total=items.length;
        var ringN=Math.ceil(total/8);
        var band=Math.floor(i/8), inBand=i%8;
        var per=Math.min(8,total-band*8);
        var aa=(inBand/per)*Math.PI*2+band*0.6;
        var rr=(0.22+band/Math.max(1,ringN)*0.52);
        cx=mpb.minX+mpb.w*(0.5+Math.cos(aa)*rr*0.78);
        cy=mpb.minY+mpb.h*(0.5+Math.sin(aa)*rr*0.72);
      }
      drawSettlement(ctx,it,cx,cy,rad,selD,pulse,i);
      continue;
    }

    /* World level draws real Mercator landmasses; every level below draws a
       CONTIGUOUS subdivision of its parent, so states tile their country and
       municipalities tile their state with shared borders. */
    var ring=isWorld?mercatorRing(it.id,vw,vh):regionPoly(i,items.length,vw,vh);
    if(ring&&ring.length>2){
      traceRing(ctx,ring);
      var sx2=0,sy2=0;
      for(var q=0;q<ring.length;q++){sx2+=ring[q][0];sy2+=ring[q][1];}
      cx=sx2/ring.length; cy=sy2/ring.length;
      /* (2) Auster is a long polar band, so its centroid sits above the visible
         mass and the label floated clear of the landmass. Nudged down to land
         on it. */
      if(it.id==='auster')cy+=30;
      /* (10) The centroid of a concave polygon can fall outside it, which put
         some country names on empty space. Nudging toward the polygon's
         bounding-box centre keeps the label on the landmass it belongs to. */
      /* Concave-safe label anchor: the point furthest from any edge, which
         is always inside the ring. Falls back to the old centroid/bbox blend
         only if the search fails (degenerate ring). */
      var _lp=ringLabelPoint(ring);
      if(_lp){ cx=_lp[0]; cy=_lp[1]; }
      else{
        var _bb=polyBounds(ring);
        cx=cx*0.55+(_bb.minX+_bb.w/2)*0.45;
        cy=cy*0.55+(_bb.minY+_bb.h/2)*0.45;
      }
    } else {
      var pts=shape(it.id||it.name,48,0.8,1);
      tracePoly(ctx,pts,cx,cy,rad,rad*0.78);
    }
    var bio=biomeFor(it.id||it.name,cy,vh);
    ctx.fillStyle=BIOMES[bio].fill;
    ctx.fill();
    if(ring&&ring.length>2)drawTerrain(ctx,ring,it.id||it.name,bio,MapState._t);
    if(selD&&ring&&ring.length>2){
      /* Wash only when there is a real polygon. Tracing a 1-point "ring" reset
         the current path, which is why the region outlines disappeared below
         world level. */
      traceRing(ctx,ring);
      ctx.fillStyle='rgba(120,210,255,0.14)';ctx.fill();
    }
    /* Re-trace before stroking: drawTerrain clips and restores, and the wash
       above consumes the path, so the outline needs its own path. */
    if(ring&&ring.length>2)traceRing(ctx,ring);
    else tracePoly(ctx,shape(it.id||it.name,48,0.8,1),cx,cy,rad,rad*0.78);
    /* (9) Thicker outlines in light green; selection stays light blue so the
       two readings never compete. */
    ctx.strokeStyle=selD?'rgba(140,220,255,'+(0.65+pulse*0.35).toFixed(2)+')'
                        :'rgba(120,240,150,0.85)';
    ctx.lineWidth=selD?(4+pulse*2.5):2.5;
    if(selD){ctx.shadowColor='#7fd0ff';ctx.shadowBlur=16+pulse*18;}
    else {ctx.shadowColor='rgba(120,240,150,0.5)';ctx.shadowBlur=6;}
    ctx.stroke();
    ctx.shadowBlur=0;

    /* Label. Selected labels are brighter and slightly larger so the eye goes
       straight to them without needing a separate cursor. */
    ctx.font=(selD?'bold ':'')+Math.max(10,Math.round(Math.min(vw,vh)*(selD?0.026:0.021)))+"px 'Germania One','Press Start 2P',serif";
    ctx.textAlign='center';ctx.textBaseline='middle';
    /* (2) Availability marking. A branch containing unlocked tracks is drawn
       in amber, one already won in green, and a branch with nothing available
       is dimmed — so the player can see at a glance which way to go without
       descending four levels to find out. */
    var hasOpen=W.branchHasUnlocked(it.id), hasWon=W.branchCompleted(it.id);
    _navPos[i]=[cx,cy];
    ctx.fillStyle=selD?'#ffffff':(hasWon?'#39ff14':(hasOpen?'#ffd23a':'#44606f'));
    ctx.fillText(it.name,cx,cy);
    if(hasOpen||hasWon){
      ctx.font=Math.max(8,Math.round(Math.min(vw,vh)*0.014))+"px 'Press Start 2P',monospace";
      ctx.fillStyle=hasWon?'rgba(57,255,20,0.9)':'rgba(255,210,58,0.9)';
      ctx.fillText(hasWon?'\u2713 WON':'\u25c6 OPEN',cx,cy+Math.min(vw,vh)*0.030);
    }
  }

  ctx.restore();
  drawHud(ctx,vw,vh);
}

/* Settlements are markers, not landmasses: a dot sized by settlement type,
   green once completed (point 10), dim while still locked. */
function drawSettlement(ctx,st,cx,cy,rad,selD,pulse,idx){
  if(idx!=null)_navPos[idx]=[cx,cy];
  var done=W.isCompleted(st.id), open=W.isUnlocked(st.id);
  /* (2) Marker size reads the settlement's class at a glance, so the lap count
     is legible from the map without opening the detail panel. The spread is
     widened — the old range was too compressed to distinguish a town from a
     village. */
  var sizeByType={megacity:1.60,large:1.25,mid:1.00,small:0.78,
                  town:0.60,village:0.44,hamlet:0.32};
  var r=rad*(sizeByType[st.type]||0.4);

  if(selD){
    ctx.beginPath();ctx.arc(cx,cy,r*(1.9+pulse*0.5),0,Math.PI*2);
    ctx.strokeStyle='rgba(120,210,255,'+(0.45+pulse*0.5).toFixed(2)+')';
    ctx.lineWidth=2+pulse*2;
    ctx.shadowColor='#7fd0ff';ctx.shadowBlur=12+pulse*14;
    ctx.stroke();ctx.shadowBlur=0;
  }
  /* (5) Unlocked-but-unraced markers breathe and emit a slow halo, so the
     places the player can actually go announce themselves. */
  if(open&&!done){
    var bt=(MapState._t*1.4+cx*0.01)%1;
    ctx.beginPath();ctx.arc(cx,cy,r*(1+bt*1.7),0,Math.PI*2);
    ctx.strokeStyle='rgba(255,210,58,'+((1-bt)*0.55).toFixed(2)+')';
    ctx.lineWidth=2;ctx.stroke();
  }
  var beat=open&&!done?(1+Math.sin(MapState._t*2.6+cx*0.02)*0.12):1;
  ctx.beginPath();ctx.arc(cx,cy,r*beat,0,Math.PI*2);
  ctx.fillStyle=done?'#39ff14':(open?'#ffd23a':'#33424e');
  ctx.fill();
  if(done){ctx.shadowColor='#39ff14';ctx.shadowBlur=10;ctx.fill();ctx.shadowBlur=0;}
  /* TOUR PROGRESSION markers: tradition ring, legends, featured towns. */
  try{
    var TPm=global.TourProgress, mi=TPm?TPm.markerInfo(st):null, tt=MapState._t;
    if(mi){
      if(mi.sig){ ctx.beginPath(); ctx.arc(cx,cy,r*1.32,0,Math.PI*2);
        ctx.strokeStyle=mi.sig.col; ctx.globalAlpha=0.85; ctx.lineWidth=Math.max(1.5,r*0.16); ctx.stroke(); ctx.globalAlpha=1; }
      if(mi.legend==='revealed'||mi.legend==='won'){
        ctx.save(); ctx.translate(cx,cy); ctx.rotate(tt*0.8);
        for(var sp=0;sp<8;sp++){ ctx.rotate(Math.PI/4);
          ctx.fillStyle=mi.legend==='won'?'#ffd23a':'hsl('+((tt*90+sp*45)%360|0)+',90%,62%)';
          ctx.beginPath(); ctx.moveTo(r*1.45,0); ctx.lineTo(r*2.25,-r*0.18); ctx.lineTo(r*2.25,r*0.18); ctx.closePath(); ctx.fill(); }
        ctx.restore();
        ctx.font=Math.max(6,Math.round(r*0.55))+"px 'Press Start 2P',monospace"; ctx.textAlign='center';
        ctx.fillStyle='#ffd23a'; ctx.fillText(mi.legend==='won'?'LEGEND \u2713':'LEGEND',cx,cy-r*2.9);
      } else if(mi.legend==='hidden'){
        var tw2=(tt*0.33+(cx*0.013))%1;           // a brief twinkle every few seconds
        if(tw2<0.12){ var a2=Math.sin(tw2/0.12*Math.PI); ctx.strokeStyle='rgba(255,240,180,'+(0.8*a2).toFixed(2)+')';
          ctx.lineWidth=1.5; ctx.beginPath(); ctx.moveTo(cx-r*1.8*a2,cy); ctx.lineTo(cx+r*1.8*a2,cy);
          ctx.moveTo(cx,cy-r*1.8*a2); ctx.lineTo(cx,cy+r*1.8*a2); ctx.stroke(); }
      }
      if(mi.featured){ var fy2=cy-r*2.1-Math.sin(tt*3)*2, fr=Math.max(4,r*0.55);
        ctx.fillStyle='#ffd23a'; ctx.beginPath();
        for(var k2=0;k2<10;k2++){ var ang=-Math.PI/2+k2*Math.PI/5, rr2=(k2%2)?fr*0.45:fr;
          ctx.lineTo(cx+Math.cos(ang)*rr2,fy2+Math.sin(ang)*rr2); }
        ctx.closePath(); ctx.fill();
        ctx.font=Math.max(5,Math.round(fr*0.9))+"px 'Press Start 2P',monospace"; ctx.textAlign='left';
        ctx.fillText('x2',cx+fr*1.2,fy2); }
    }
  }catch(e){}

  /* Larger settlements carry their lap count inside the dot. */
  if(r>9&&st.race&&st.race.laps>=3){
    ctx.font='bold '+Math.max(7,Math.round(r*0.95))+"px 'Press Start 2P',monospace";
    ctx.textAlign='center';ctx.textBaseline='middle';
    ctx.fillStyle='rgba(0,0,0,0.75)';
    ctx.fillText(String(st.race.laps),cx,cy);
    ctx.textBaseline='top';
  }
  /* (1) 35% smaller: at the previous size long names overlapped neighbouring
     markers, which the screenshot shows clearly. */
  ctx.font=Math.max(11,Math.round(r*0.86))+"px 'Germania One','Press Start 2P',serif";   // +30% (request 4 item 3)
  ctx.textAlign='center';ctx.textBaseline='top';
  ctx.fillStyle=selD?'#bfe8ff':(open?'#8fa8b8':'#4a5a66');
  /* (4) Name centred ON the marker rather than hanging below it, so it sits
     inside the polygon the settlement occupies. Drawn with a dark outline so
     it stays readable over both the terrain fill and the marker itself. */
  ctx.textBaseline='middle';
  ctx.lineWidth=3;
  ctx.strokeStyle='rgba(0,4,10,0.85)';
  ctx.strokeText(W.displayName(st),cx,cy);
  ctx.fillText(W.displayName(st),cx,cy);
  ctx.textBaseline='top';
}

/* ── HUD 
   Breadcrumb, progress counters and the selected settlement's details. Kept to
   the frame edges so the map itself stays uncluttered. */
/* Checkerboard border in the racing tradition. Offset animates, so the frame
   crawls like a start/finish line rather than sitting static. */
function drawCheckerFrame(ctx,vw,vh,t){
  var c=Math.max(10,Math.round(Math.min(vw,vh)*0.022));
  var off=Math.floor((t*18)%(c*2));
  ctx.save();
  for(var x=-c*2;x<vw+c*2;x+=c){
    for(var row=0;row<2;row++){
      var on=((Math.floor((x+off)/c)+row)%2)===0;
      ctx.fillStyle=on?'rgba(235,235,235,0.90)':'rgba(12,12,14,0.90)';
      ctx.fillRect(x+off%c,row*c,c,c);
      ctx.fillRect(x-off%c,vh-(row+1)*c,c,c);
    }
  }
  for(var y=-c*2;y<vh+c*2;y+=c){
    for(var col=0;col<2;col++){
      var on2=((Math.floor((y+off)/c)+col)%2)===0;
      ctx.fillStyle=on2?'rgba(235,235,235,0.90)':'rgba(12,12,14,0.90)';
      ctx.fillRect(col*c,y+off%c,c,c);
      ctx.fillRect(vw-(col+1)*c,y-off%c,c,c);
    }
  }
  ctx.restore();
}

function drawHud(ctx,vw,vh){
  var s=W.stats();
  ctx.save();
  ctx.font="9px 'Press Start 2P',monospace";
  ctx.textBaseline='top';

  /* Breadcrumb, top-left. */
  var crumb='WORLD';
  for(var i=0;i<MapState.path.length;i++)crumb+='  \u203a  '+MapState.path[i].name;
  /* (8) Centred on the line and 20% larger than the other HUD text. */
  /* (2) The trail is the primary orientation cue, so it gets a plate of its
     own, a larger face, and a leading marker that names what it is. */
  var cf=Math.max(13,Math.round(Math.min(vw,vh)*0.030));
  ctx.font=cf+"px 'Germania One','Press Start 2P',serif";
  ctx.textAlign='center';ctx.textBaseline='middle';
  var tw=ctx.measureText(crumb).width;
  /* (2) Branding shares the breadcrumb plate. Measured first so the box is
     sized for both, keeping the trail centred within its own half. */
  /* (3) One line, one style: two stacked lines in different colours read as
     two labels rather than a single logo. */
  /* (4) Branding at the breadcrumb size rather than 60% of it. */
  var bf=Math.max(13,Math.round(cf*1.00));
  ctx.font=bf+"px 'Germania One','Press Start 2P',serif";
  var brand='ZONE STORM RACING GX';
  var brw=ctx.measureText(brand).width+22;
  ctx.font=cf+"px 'Germania One','Press Start 2P',serif";
  var bx=vw/2-(tw+brw)/2-22, bw=tw+brw+44, by=vh*0.045, bh=cf*1.9;
  /* (8) No border or end-caps: a plain plate reads cleaner behind the fluid. */
  ctx.fillStyle='rgba(3,14,24,0.80)';
  ctx.fillRect(bx,by,bw,bh);
  /* Logo block on the left of the plate, trail to the right of it. */
  ctx.textAlign='left';
  ctx.font=bf+"px 'Germania One','Press Start 2P',serif";
  /* (5) The t-logo fire treatment is a CSS gradient animation, which cannot
     apply to canvas text. The same effect is reproduced here by cycling the
     fill through the logo's palette on the same period, so the branding reads
     as the title screen's logo rather than as plain text. */
  var _fp=(MapState._t*0.42)%1;
  var _fk=0.5+0.5*Math.sin(_fp*Math.PI*2);
  var _g1=ctx.createLinearGradient(bx+16,by+4,bx+16,by+bh-4);
  _g1.addColorStop(0,'#8a1a00');
  _g1.addColorStop(Math.max(0.05,Math.min(0.95,0.35+_fk*0.30)),'#ff6a00');
  _g1.addColorStop(Math.max(0.10,Math.min(0.99,0.62+_fk*0.26)),'#fff2c0');
  _g1.addColorStop(1,'#8a1a00');
  /* The whole logo takes the animated gradient — RACING GX was flat green,
     which broke the treatment mid-word. */
  /* (8) ONE BASELINE FOR BOTH.
     The logo drew with textBaseline='middle' and then reset to 'top' BEFORE
     the breadcrumb was drawn — so the trail was positioned from its top edge
     while the logo was positioned from its centre. Both used the same y, which
     is why the logo sat visibly higher.
     The baseline is now set once and left alone until both are painted. */
  ctx.textBaseline='middle';
  ctx.fillStyle=_g1;
  ctx.fillText(brand,bx+16,by+bh/2);
  ctx.textAlign='center';
  ctx.font=cf+"px 'Germania One','Press Start 2P',serif";
  ctx.fillStyle='#dff3ff';
  ctx.fillText(crumb,bx+brw+(bw-brw)/2,by+bh/2);
  ctx.textBaseline='top';
  ctx.font="9px 'Press Start 2P',monospace";

  /* Counters sit on their own plate directly under the breadcrumb, in the
     same family and styling, so the two read as one navigation header rather
     than as unrelated corner text. */
  /* (9) "UNLOCKED X of 81,742" — a fraction of what exists, not of a
     weighting figure the world never contained. */
  /* ═══ ONE PROGRESS PLATE (request 3 item 3). WON / UNLOCKED on the first
     row, the tour's passport, legends, streak and featured count on the
     second, and the latest rumour on a third — one rectangle instead of a
     second strip floating over the map. */
  var stats='WON '+s.completed+'   ·   UNLOCKED '+
            s.unlocked.toLocaleString()+' of '+s.total.toLocaleString();
  var S2=null; try{ S2=global.TourProgress?global.TourProgress.status():null; }catch(e){ S2=null; }
  var row2=S2?('PASSPORT '+S2.stamps+'/'+S2.of+'   ·   LEGENDS '+S2.legends+'   ·   STREAK x'+S2.mult.toFixed(1)+'   ·   ★ '+S2.featured+' FEATURED TODAY'):'';
  var row3=(S2&&S2.rumours&&S2.rumours.length)?('“'+S2.rumours[0].text+'”'):'';
  var sf=Math.max(10,Math.round(Math.min(vw,vh)*0.021));
  var sf2=Math.max(9,Math.round(sf*0.78)), sf3=Math.max(8,Math.round(sf*0.66));
  ctx.textAlign='center';ctx.textBaseline='middle';
  ctx.font=sf+"px 'Germania One','Press Start 2P',serif";
  var sw=ctx.measureText(stats).width;
  ctx.font=sf2+"px 'Germania One','Press Start 2P',serif";
  if(row2)sw=Math.max(sw,ctx.measureText(row2).width);
  ctx.font=sf3+"px 'Press Start 2P',monospace";
  if(row3){ while(row3.length>12&&ctx.measureText(row3).width>vw*0.8)row3=row3.slice(0,-2); sw=Math.max(sw,ctx.measureText(row3).width); }
  var sbh=sf*1.8+(row2?sf2*1.6:0)+(row3?sf3*1.9:0);
  var sbx=vw/2-sw/2-18, sbw=sw+36, sby=by+bh+6;
  ctx.fillStyle='rgba(3,14,24,0.80)';
  ctx.fillRect(sbx,sby,sbw,sbh);
  ctx.strokeStyle='rgba(120,240,150,0.55)';ctx.lineWidth=1.5;
  ctx.strokeRect(sbx,sby,sbw,sbh);
  var ry=sby+sf*0.9;
  ctx.font=sf+"px 'Germania One','Press Start 2P',serif";
  ctx.fillStyle='#9fd8b0';
  ctx.fillText(stats,vw/2,ry);
  if(row2){
    ry+=sf*0.9+sf2*0.8;
    ctx.strokeStyle='rgba(120,240,150,0.18)';ctx.lineWidth=1;
    ctx.beginPath();ctx.moveTo(sbx+14,ry-sf2*0.8);ctx.lineTo(sbx+sbw-14,ry-sf2*0.8);ctx.stroke();
    ctx.font=sf2+"px 'Germania One','Press Start 2P',serif";
    ctx.fillStyle='#ffd23a';
    ctx.fillText(row2,vw/2,ry);
    ry+=sf2*0.8;
  }
  if(row3){
    ry+=sf3*0.95;
    ctx.font=sf3+"px 'Press Start 2P',monospace";
    ctx.fillStyle='#7fd0ff';
    ctx.fillText(row3,vw/2,ry);
  }
  var _plateBottom=sby+sbh;
  ctx.textBaseline='top';

  /* Selected settlement detail, bottom-left. */
  var it=MapState.items[MapState.sel];
  if(it&&MapState.level==='muni'){
    ctx.textAlign='left';
    ctx.font="12px 'Press Start 2P',monospace";   // +30% (request 4 item 3)
    ctx.fillStyle='#bfe8ff';
    /* (7) Lines spaced 22px apart rather than 16, for readability. */
    ctx.fillText(W.displayName(it),116,vh-178);
    ctx.fillStyle='#8fa8b8';
    ctx.fillText(it.typeLabel+'   POP '+it.population.toLocaleString(),116,vh-150);
    ctx.fillStyle='#6f8fa0';
    ctx.fillText(it.race.laps+' LAPS   '+it.race.turbo+' TURBO'+
      (W.isCompleted(it.id)?'   \u2713 WON':(W.isUnlocked(it.id)?'':'   LOCKED')),116,vh-122);
  }

  /* TOUR PROGRESSION: the municipality's tradition, under the progress plate. */
  try{
    var TPh=global.TourProgress;
    if(TPh&&MapState.level==='muni'&&MapState.path.length){
      var muniId=MapState.path[MapState.path.length-1].id, g=TPh.visitMuni(muniId);
      if(g){
        var tby=Math.round(_plateBottom+20), txt2='TRADITION · '+g.name+'  —  '+g.desc;
        ctx.font="10px 'Press Start 2P',monospace"; ctx.textAlign='center'; ctx.textBaseline='middle';
        var bw2=ctx.measureText(txt2).width+30, pls=0.6+0.4*Math.sin(MapState._t*2.2);
        ctx.fillStyle='rgba(0,8,16,0.82)'; ctx.fillRect(vw/2-bw2/2,tby-13,bw2,26);
        ctx.strokeStyle=g.col; ctx.globalAlpha=pls; ctx.lineWidth=2; ctx.strokeRect(vw/2-bw2/2,tby-13,bw2,26); ctx.globalAlpha=1;
        ctx.fillStyle=g.col; ctx.fillText(txt2,vw/2,tby);
      }
    }
  }catch(e){}
  ctx.textAlign='center';
  ctx.fillStyle='#4a6a80';
  /* (1) Control hints removed: they sat over the checkerboard border. */
  ctx.restore();
}

global.WorldMap={
  /* True when some region sits below the selection, so the shell knows whether
     Down should navigate the map or move to the shop button. */
  hasBelow:function(){
    var cur=_navPos[MapState.sel]; if(!cur)return false;
    for(var i=0;i<MapState.items.length;i++){
      if(i===MapState.sel)continue;
      var p=_navPos[i]; if(!p)continue;
      if(p[1]-cur[1]>8&&Math.abs(p[0]-cur[0])<Math.abs(p[1]-cur[1])*2.2)return true;
    }
    return false;
  },
  state:MapState, draw:draw, nav:nav, navDir:navDir, enter:enter, back:back, reset:resetMap,
  items:function(){return MapState.items;},
  selected:function(){return MapState.items[MapState.sel];},
  level:function(){return MapState.level;},
  /* Screen position of an item on the current level, from the last draw. */
  posOf:function(id){ for(var i=0;i<MapState.items.length;i++)if(MapState.items[i].id===id)return _navPos[i]||null; return null; },
  selectId:function(id){ for(var i=0;i<MapState.items.length;i++)if(MapState.items[i].id===id){MapState.sel=i;return true;} return false; }
};

})(typeof window!=='undefined'?window:globalThis);


/* 
   REWARDS AND LAP-TIME STORE   (was worldrewards.js)
   ---------------------------------------------------------------------------
   Combinatorial podium rewards plus the IndexedDB store for race and lap
   times.
    */
/* 
   WORLD TOUR — REWARD SYSTEM
   ---------------------------------------------------------------------------
   Four million races needs rewards that arrive often without becoming noise.
   The design principle here is ESCALATING RARITY: something happens on almost
   every race, but what happens gets rarer and larger as the player commits to
   a region. A win always gives at least a small acknowledgement; a fifth win
   in the same municipality gives a title; a country cleared gives a permanent
   emblem.

   Four layers, deliberately on different clocks so they never all fire at once
   and never all go quiet:

     1. INSTANT   — every win. Small, immediate, never repeated verbatim.
     2. REGIONAL  — thresholds inside a municipality / state / country.
     3. MASTERY   — clearing a region outright. Rare, permanent, named.
     4. DISCOVERY — low-chance finds tied to the settlement's own character,
                    so a hamlet in one country yields something a megacity in
                    another never will.

   Rewards are cosmetic or titular rather than performance-affecting, so no
   amount of grinding unbalances the racing.
    */

(function(global){
'use strict';

var W=global.WorldTour;
if(!W)return;

/* ── DETERMINISTIC PICKER  */
function hash32(str){
  var h=2166136261>>>0;
  for(var i=0;i<str.length;i++){h^=str.charCodeAt(i);h=Math.imul(h,16777619)>>>0;}
  return h>>>0;
}
function rngFor(key){
  var s=hash32(key)||1;
  return function(){s^=s<<13;s^=s>>>17;s^=s<<5;s>>>=0;return s/4294967296;};
}
function pick(r,a){return a[Math.floor(r()*a.length)%a.length];}

/* ── LAYER 1: INSTANT 
   Flavour keyed to the settlement, so the same track always yields the same
   line and the world feels authored rather than random. Sixty variants is
   enough that repeats are rare in any one session. */
var INSTANT=[
  'THE CROWD CHANTS YOUR NAME','LOCAL RECORD SHATTERED','THE MAYOR SALUTES YOU',
  'CHILDREN COPY YOUR LIVERY','A STREET IS RENAMED FOR YOU','THE PIT CREW BOWS',
  'FIREWORKS OVER THE VALLEY','A STATUE IS COMMISSIONED','THE BELLS RING ALL NIGHT',
  'YOUR TIME GOES ON THE WALL','THE RIVALS SHAKE YOUR HAND','A HOLIDAY IS DECLARED',
  'THE RADIO PLAYS YOUR THEME','ENGINEERS STUDY YOUR LINE','A MURAL APPEARS BY DAWN',
  'THE GOVERNOR SENDS WORD','TRACKSIDE FLAGS FLY FOR YOU','A TOAST IN EVERY TAVERN',
  'THE ARCHIVE LOGS YOUR RUN','SCOUTS ASK FOR YOUR SECRET','A BRIDGE BEARS YOUR NUMBER',
  'THE MARSHALS APPLAUD','A SONG IS WRITTEN TONIGHT','THE CIRCUIT REMEMBERS',
  'YOUR MACHINE IS PHOTOGRAPHED','A PLAQUE IS SET AT TURN ONE','THE VALLEY ECHOES',
  'RIVAL TEAMS TAKE NOTES','THE STANDS REFUSE TO EMPTY','A PARADE FORMS UNBIDDEN',
  'THE OLD RECORD HOLDER NODS','LANTERNS LIT IN YOUR HONOUR','THE PRESS RUNS A SPECIAL',
  'A ROAD SIGN GAINS YOUR CREST','THE ANTHEM PLAYS TWICE','MECHANICS SALUTE THE PASS',
  'YOUR LAP IS BROADCAST AGAIN','A TROPHY CASE IS CLEARED','THE TOWN CLOCK STOPS',
  'DRIVERS STUDY THE FOOTAGE','A BANNER CROSSES MAIN STREET','THE HARBOUR HORNS SOUND',
  'SCHOOLS CLOSE FOR THE DAY','A NEW CORNER IS NAMED','THE CROWD WILL NOT LEAVE',
  'YOUR NUMBER IS RETIRED HERE','FLOWERS ON THE START LINE','THE STEWARDS STAND',
  'A LOCAL LEGEND IS BORN','THE MOUNTAIN ECHOES BACK','TELEMETRY GOES ON DISPLAY',
  'A FEAST IS LAID OUT','THE GRANDSTAND ROARS ONCE MORE','RIVALS CONCEDE THE LINE',
  'YOUR HELMET IS SKETCHED','THE FINISH TAPE IS FRAMED','A CHEER CARRIES FOR MILES',
  'THE TIMEKEEPERS DOUBLE-CHECK','A LEGEND TAKES ROOT HERE'
];

/* ── SPONSORS, LIVERIES, PARTS, RANKS 
   Six further reward CATEGORIES, so what arrives varies in kind and not only
   in wording. Each is drawn from a pool keyed to the region, which is what
   makes a Karnath sponsor different from a Valoria one and gives a continent
   its own identity across the thousands of races played inside it. */
var SPONSORS=['ORBITAL FUEL','NOVA TYRE','HELIX DYNAMICS','PALEWATER SHIPPING',
  'CINDER FORGE','ARC VOLTAICS','MERIDIAN SALT','DEEPLINE RAIL','KESTREL AERO',
  'VANTAGE OPTICS','IRONHOLM STEEL','SABLE CHEMICAL','LUMEN GRID','TIDEWORKS',
  'GRAVEN MOTORS','HALCYON DRIVE','ASHFALL MINING','QUILL AVIONICS','ZENITH CELLS',
  'BRACKEN AGRI','SOLSTICE POWER','THORN & SONS','VELVET TRANSIT','OXIDE LABS',
  'NORTHWIND CARGO','PRISM REFINERY','CANTOR ROBOTICS','DUSKLIGHT MEDIA'];
var LIVERIES=['MIDNIGHT SPLIT','TIGER STRIPE','CHECKER CROWN','AURORA FADE',
  'RUST PATINA','CHROME SPINE','CARBON WEAVE','SUNBURST','GLACIER CAMO',
  'MAGMA VEIN','PEARL DRIFT','STORM LATTICE','SAND WRAP','NEON PINSTRIPE',
  'OBSIDIAN MATTE','COPPER LEAF','TIDAL SCALE','EMBER TIP','FROSTBITE',
  'ROYAL SASH','CIRCUIT TRACE','DESERT DAZZLE','VOID GLOSS','HARVEST GOLD'];
var PARTS=['REACTIVE VANES','TWIN-CORE COIL','LOW-DRAG COWL','MAGNETIC SKIRT',
  'HEAT-SINK FINS','GYRO STABILISER','FEATHER CHASSIS','OVERRUN VALVE',
  'ADAPTIVE INTAKE','KINETIC RECLAIMER','SHOCK LATTICE','VECTOR THRUSTER',
  'PHASE DAMPER','ALLOY UNDERTRAY','PULSE IGNITER','DRAFT CATCHER'];
var RANKS=['ROOKIE','CONTENDER','PACESETTER','FRONT RUNNER','ACE','VETERAN',
  'CIRCUIT MASTER','GRAND ACE','LEGEND','IMMORTAL'];
/* (6) RESCALED FOR 81,742 TRACKS.
   The old ladder topped out at 3,000 wins — reachable in under 4% of the
   world, after which the rank never changed again for the remaining 78,000
   races. The final tier now sits at 40,000, roughly half the world, so the
   progression spans a real career rather than its opening.
   Early tiers are unchanged: the first hours should still feel like progress. */
var RANK_AT=[1,5,15,40,120,400,1400,5000,16000,40000];
var LANDMARKS=['A NEW GRANDSTAND','A FLOODLIT NIGHT SECTION','A PIT COMPLEX',
  'A SPECTATOR BRIDGE','A HILLSIDE VIEWING LAWN','A MUSEUM WING',
  'A DRIVERS’ MEMORIAL','A TROPHY HALL','A TEST LOOP','A KARTING SCHOOL'];
var WEATHER_FEATS=['FIRST WIN IN FOG','FIRST WIN IN A STORM','FIRST NIGHT WIN',
  'FIRST WIN IN SNOW','FIRST WIN UNDER AURORA','FIRST WIN AT NOON'];
var CREW=['A CHIEF ENGINEER JOINS YOU','A LEGENDARY MECHANIC SIGNS ON',
  'A STRATEGIST OFFERS SERVICE','A TEST DRIVER PLEDGES LOYALTY',
  'A FABRICATOR OPENS A WORKSHOP','A TELEMETRY ANALYST ENLISTS'];

/* ── LAYER 3: MASTERY TITLES 
   Titles are built from the region's own name, so "CHAMPION OF NORTH MARCH"
   is specific to that state and cannot appear anywhere else. That specificity
   is what makes a title feel earned rather than issued. */
var TITLE_FORMS=[
  'CHAMPION OF {R}','PRIDE OF {R}','THE {R} RECORD','SOVEREIGN OF {R}',
  'UNDEFEATED IN {R}','THE {R} STANDARD','MASTER OF {R}','LEGEND OF {R}'
];

/* ── LAYER 4: DISCOVERIES 
   Rare finds whose flavour is drawn from the settlement type, so what turns up
   in a hamlet is never what turns up in a megacity. */
var DISCOVERY={
  hamlet:  ['A FORGOTTEN SHORTCUT','AN OLD RACING GHOST','A HIDDEN SPRING',
            'A RUSTED TROPHY','THE FIRST MILESTONE'],
  village: ['A VILLAGE PENNANT','AN ANCIENT WHEEL','A SMUGGLER\u2019S LANE',
            'A WEATHERED CREST','A HERITAGE ENGINE'],
  town:    ['THE TOWN KEY','A CLOCKTOWER RELIC','A GUILD SEAL',
            'AN OLD RACE POSTER','THE FOUNDER\u2019S GOGGLES'],
  small:   ['A CIVIC MEDAL','A PROTOTYPE FIN','THE ARCHIVE TAPE',
            'A DESIGNER\u2019S SKETCH','A RETIRED NUMBER PLATE'],
  mid:     ['A FACTORY BLUEPRINT','THE CITY BANNER','A TEST-TRACK LOG',
            'AN ENGINEER\u2019S NOTEBOOK','A CHROME PROTOTYPE'],
  large:   ['THE METRO CROWN','A CHAMPIONSHIP RING','THE GRAND ARCHIVE KEY',
            'A CONCEPT MACHINE','THE CITY\u2019S OWN LIVERY'],
  megacity:['THE SOVEREIGN CUP','A ONE-OFF POWERPLANT','THE MASTER BLUEPRINT',
            'THE CONTINENTAL SEAL','THE FOUNDER\u2019S MACHINE']
};

/* ── (2) FUNDS AND PART REWARDS 
   Rewards that give something concrete rather than a title: credits, and new
   parts or capacity for the Machine Editor. Names are deliberately absurd —
   over millions of races a straight-faced list becomes wallpaper, whereas
   something odd is still worth reading on the four-hundredth win. */
var FUND_PRIZES=[
  ['A SUITCASE OF UNMARKED CREDITS',900],  ['THE MAYOR’S LUNCH BUDGET',450],
  ['SPONSORSHIP FROM A SOUP CONCERN',1200],['A BET SETTLED IN YOUR FAVOUR',700],
  ['SALVAGE RIGHTS TO TURN THREE',1600],   ['A GRATEFUL BAKER’S SAVINGS',300],
  ['DAMAGES FROM A RIVAL TEAM',2400],      ['THE LOST-AND-FOUND JACKPOT',180],
  ['A TAX REBATE NOBODY EXPECTED',1100],   ['PROCEEDS OF A CHARITY RAFFLE',640],
  ['AN INHERITANCE FROM A FAN',3200],      ['VENDING MACHINE OVERFLOW',95],
  ['THE PIT CREW’S POKER WINNINGS',820],['A SETTLEMENT OVER A POTHOLE',1450],
  ['ROYALTIES ON YOUR OWN LIKENESS',2100], ['A BRIBE YOU DECLINED, THEN KEPT',1750],
  ['THE TOWN FOUNTAIN’S COINS',260],   ['ADVERTISING ON YOUR REAR WING',1350],
  ['A GRANT FOR GOING VERY FAST',2800],    ['LOOSE CHANGE FROM THE GRANDSTAND',140],
  ['COMPENSATION FOR A RUINED HAT',210],   ['A WAGER ON YOUR OWN DEFEAT',3600],
  ['THE SCRAPYARD’S FINDER FEE',560],  ['A MYSTERIOUS ENVELOPE',1900],
  ['PROFITS FROM A COMMEMORATIVE MUG',480],['THE RACE STEWARD’S APOLOGY FUND',990],
  ['A CROWDFUNDED THANK-YOU',1550],        ['UNCLAIMED PRIZE FROM 40 YEARS AGO',4200],
  ['A DIVIDEND FROM THE TYRE GUILD',760],  ['SOMEONE ELSE’S APPEARANCE FEE',2650],
  /* (6) Twenty more, drawn against 81,742 races rather than a few hundred. */
  ['RECOVERED FROM A SOFA, SOMEHOW',75],   ['THE PIGEON SPONSORSHIP DEAL',540],
  ['DAMAGES: ONE STARTLED COW',880],       ['A GRANT FOR EXISTING LOUDLY',1250],
  ['THE ANNUAL BOLLARD SETTLEMENT',430],   ['PROFITS FROM YOUR OWN FAN CLUB',1680],
  ['A LEGACY FROM A MYSTERIOUS AUNT',3400],['THE SANDWICH FUND, LIQUIDATED',160],
  ['ROYALTIES ON A LAUGH TRACK',720],      ['COMPENSATION FOR TIME LOST',1950],
  ['THE SCRUTINEER LOOKED AWAY',2200],     ['A CROWD-SOURCED APOLOGY',390],
  ['WINNINGS FROM A RIGGED RAFFLE',1120],  ['THE HAT-PASSING WENT WELL',280],
  ['ONE VERY GRATEFUL LOCAL COUNCIL',2750],['UNEXPLAINED BANK ERROR (YOURS)',4600],
  ['THE ROADSIDE SHRINE COLLECTION',340],  ['A BOUNTY ON A RIVAL, UNCLAIMED',1830],
  ['PAYMENT IN A CURRENCY NOBODY USES',95],['THE VICTORY LAP SPONSORSHIP',2380]
];
/* Machine parts: each grants a new shape option or raises a cap in the editor,
   so winning changes what can be BUILT, not merely what is owned. */
var PART_PRIZES=[
  ['THE FORKED PRONG','nose','A nose that cannot decide'],
  ['THE SPOON','nose','Blunt. Aerodynamically insulting'],
  ['THE HALBERD','nose','Long enough to be a hazard'],
  ['THE SNUB','nose','Barely a nose at all'],
  ['THE DRILL','nose','Threaded, for reasons unexplained'],
  ['THE ANVIL','nose','Heavy at the front. Deliberately'],
  ['SCISSOR FINS','fins','They open. Nobody knows why'],
  ['THE PEACOCK ARRAY','fins','Seven fins. Purely for display'],
  ['DROOPING FINS','fins','Sad, but surprisingly effective'],
  ['THE TRIDENT','fins','Three prongs of questionable use'],
  ['CATHEDRAL FINS','fins','Gothic. Slightly too tall'],
  ['THE WHISK','fins','Aerates the air behind you'],
  ['GILL VENTS','vents','Breathes like something aquatic'],
  ['THE CHEESE GRATER','vents','Ventilation taken to excess'],
  ['PINHOLE ARRAY','vents','A hundred tiny holes'],
  ['THE ACCORDION','vents','Expands under load. Musically'],
  ['THE PIPE ORGAN','thrusters','Six nozzles. It hums'],
  ['THE CANNON','thrusters','One nozzle. Very large'],
  ['THE CANDELABRA','thrusters','Five, arranged decoratively'],
  ['THE KETTLE','thrusters','Whistles at top speed'],
  ['THE TRUMPET INTAKE','intake','Flared. Announces your arrival'],
  ['THE LETTERBOX','intake','A slot. Post nothing through it'],
  ['THE VACUUM','intake','Inhales alarmingly'],
  ['THE NOSTRILS','intake','Two. Unsettlingly organic'],
  ['THE BALLGOWN','skirt','Sweeps the track behind you'],
  ['THE HOVERSKIRT','skirt','Barely touches anything'],
  ['THE PLOUGH','skirt','Clears debris. And spectators'],
  ['THE TUTU','skirt','Frilled. Aerodynamically baffling'],
  ['THE BUBBLE DOME','canopy','Panoramic. Terrifying'],
  ['THE ARROW SLIT','canopy','You can see almost nothing'],
  ['THE FISHBOWL','canopy','Distorts everything pleasantly'],
  ['THE VISOR','canopy','Sleek. Slightly menacing'],
  /* (6) Sixteen further shapes: the pool is drawn against 81,742 races now. */
  ['THE CORKSCREW','nose','It rotates. Nobody asked it to'],
  ['THE DOORSTOP','nose','Wedge-shaped. Aggressively so'],
  ['THE BEAK','nose','Ornithologically concerning'],
  ['THE PLECTRUM','nose','Strums the air at speed'],
  ['THE WEATHERVANE','fins','Points somewhere. Not forward'],
  ['THE VENETIAN BLIND','fins','Adjustable. Rarely adjusted'],
  ['THE HARP','fins','Twelve strings of downforce'],
  ['THE PARASOL','fins','Provides shade at 400 km/h'],
  ['THE COLANDER','vents','Drains absolutely everything'],
  ['THE HONEYCOMB','vents','Structurally smug'],
  ['THE BAGPIPE','thrusters','Drones ominously on the straight'],
  ['THE CHIMNEY STACK','thrusters','Emits something. Best not ask'],
  ['THE FUNNEL','intake','Wide at one end. Wide at the other'],
  ['THE SNORKEL','intake','For tunnels that flooded'],
  ['THE PETTICOAT','skirt','Layered. Utterly impractical'],
  ['THE PORTHOLE','canopy','You see one twelfth of the track']
];
/* Capacity grants: raise how far a parameter can be pushed. */
var CAP_PRIZES=[
  ['FIN LICENCE, CLASS II','fins','+2 maximum fins'],
  ['VENT PERMIT, UNRESTRICTED','vents','+3 maximum vents'],
  ['THRUSTER CERTIFICATION','thrusters','+2 maximum thrusters'],
  ['OVERSIZE LOAD PAPERWORK','width','Wider bodies permitted'],
  ['HEIGHT WAIVER','height','Taller bodies permitted'],
  ['NOSE EXTENSION VARIANCE','noseLen','Longer noses permitted'],
  ['SKIRT DEREGULATION','skirtDrop','Deeper skirts permitted'],
  ['INTAKE EXEMPTION','intakeSz','Larger intakes permitted']
];

/* ── STORAGE  */
var KEY='zsgx_rewards_v1';
var _r=null;
function load(){
  if(_r)return _r;
  try{ _r=JSON.parse(localStorage.getItem(KEY)||'null'); }catch(e){ _r=null; }
  if(!_r)_r={titles:[],finds:[],emblems:[],counts:{},seen:0,
             sponsors:[],liveries:[],parts:[],crew:[],caps:[],rank:null};
  /* Older saves predate the newer categories. */
  ['sponsors','liveries','parts','crew','caps'].forEach(function(k){ if(!_r[k])_r[k]=[]; });
  return _r;
}
function save(){ try{ localStorage.setItem(KEY,JSON.stringify(_r)); }catch(e){} }

/* Region ids are prefixes of the settlement id, so counting wins per region is
   a string operation rather than a tree walk. */
function regionsOf(id){
  var p=id.split('/');
  return {
    continent:p[0],
    country:p.slice(0,2).join('/'),
    state:p.slice(0,3).join('/'),
    muni:p.slice(0,4).join('/')
  };
}
function bump(key){
  var r=load();
  r.counts[key]=(r.counts[key]||0)+1;
  return r.counts[key];
}

/* Thresholds chosen so something lands roughly every third race early on, then
   stretches out — frequent enough to feel responsive, spaced enough that the
   larger awards keep their weight. */
/* (6) Regional tiers reach further: a municipality holds a dozen settlements,
   a state hundreds, so 100 was exhausted almost immediately. */
var TIERS=[3,5,10,25,50,100,250,600,1500,4000];

function nameOf(level,id){
  try{
    if(level==='muni'){
      var st=id.slice(0,id.lastIndexOf('/'));
      var ms=W.municipalitiesOf(st);
      for(var i=0;i<ms.length;i++)if(ms[i].id===id)return ms[i].name;
    }
    if(level==='state'){
      var co=id.slice(0,id.lastIndexOf('/'));
      var ss=W.statesOf(co);
      for(var j=0;j<ss.length;j++)if(ss[j].id===id)return ss[j].name;
    }
    if(level==='country'){
      var ct=id.split('/')[0];
      var cs=W.countriesOf(ct);
      for(var k=0;k<cs.length;k++)if(cs[k].id===id)return cs[k].name;
    }
    if(level==='continent'){
      var all=W.continents();
      for(var m=0;m<all.length;m++)if(all[m].id===id)return all[m].name;
    }
  }catch(e){}
  return id;
}

/* ── AWARD 
   Called once per won race. Returns the list of rewards to display; the caller
   decides how to present them. At most three are returned even if more
   qualify, so a single race never buries the player in notifications. */

/* 
   COMBINATORIAL PODIUM REWARDS   (item 15)
   ---------------------------------------------------------------------------
   The World Tour covers roughly 81,742 racetracks. The old INSTANT pool held
   59 fixed phrases, so a player saw a repeat within the first hour and every
   reward after that was one they had already read. A pool cannot be written by
   hand at that scale — 81,742 hand-authored lines is not a realistic ask, and
   would still repeat on a second lap of the world.

   So rewards are COMPOSED rather than stored. Four independent fragment pools
   are combined, and the place name is woven in, which yields far more distinct
   lines than there are tracks:

       SUBJECT x DEED x TARGET x FLOURISH
       46 x 44 x 41 x 38  =  2,952,  272  combinations

   With the settlement name substituted into roughly half of them, effectively
   every race produces a line the player has not seen.

   The selection is SEEDED from the settlement id and the finishing place, not
   random, so the same result on the same track always reads the same — a
   reward that changes when you look at it again is not a reward.

   PLACEMENT MATTERS. First place draws from the grandiose end, second from the
   grudging middle, third from the faintly insulting tail. The fragments are
   ordered within each pool so a placement offset into the array is all that is
   needed; no separate pools to keep in step.
    */

/* Ordered grandiose -> grudging -> insulting. The placement offset slides a
   window along each array, so first place never draws a consolation phrase and
   third never draws a triumphant one. */
var RW_SUBJECT=[
 'THE ENTIRE GRANDSTAND','A VISITING ARCHDUKE','THE NATIONAL ORCHESTRA',
 'SEVENTEEN TELEVISION CREWS','THE MINISTER OF VELOCITY','A CHOIR OF ENGINEERS',
 'THE MAYOR AND ALL DEPUTIES','A FLEET OF CAMERA DRONES','THE RACING COMMISSION',
 'EVERY CHILD IN THE PREFECTURE','THE HARBOUR PILOTS GUILD','A DELEGATION OF PHYSICISTS',
 'THE LOCAL BRASS BAND','THREE RIVAL TEAM PRINCIPALS','THE WEATHER BUREAU',
 'A COMMITTEE OF ARCHIVISTS','THE NIGHT SHIFT AT THE FOUNDRY','SEVERAL CONFUSED TOURISTS',
 'THE STADIUM CAT','A MAN SELLING NOODLES','THE CLEANING STAFF',
 'TWO STEWARDS ON A BREAK','A PASSING CYCLIST','THE VENDING MACHINE',
 'NOBODY IN PARTICULAR','A SINGLE DISAPPOINTED PIGEON','YOUR OWN PIT CREW, RELUCTANTLY',
 'THE SCOREBOARD OPERATOR','AN INTERN WITH A CLIPBOARD','THE PARKING ATTENDANT',
 'A DOG THAT WANDERED IN','THE LOST PROPERTY OFFICE','SOMEONE ELSE ENTIRELY',
 'THE TRAFFIC WARDEN','A VERY TIRED MARSHAL','THE BACKUP GENERATOR',
 'AN AUTOMATED ANNOUNCEMENT','THE QUEUE FOR THE TOILETS','A BROKEN TURNSTILE',
 'THE SUGGESTION BOX','NOBODY, AUDIBLY','A SEAGULL WITH OPINIONS',
 'THE CATERING TENT','ONE CONFUSED OFFICIAL','THE RECYCLING BIN','A DAMP PROGRAMME'
];
var RW_DEED=[
 'ERECTS A STATUE OF','COMPOSES AN ANTHEM FOR','DECLARES A HOLIDAY FOR',
 'MINTS A COIN BEARING','NAMES A CONSTELLATION AFTER','TATTOOS THE LIVERY OF',
 'BUILDS A SHRINE TO','RENAMES THE RIVER AFTER','COMMISSIONS A MURAL OF',
 'ISSUES A POSTAGE STAMP OF','DEDICATES A BRIDGE TO','TEACHES SCHOOLCHILDREN ABOUT',
 'FOUNDS A MUSEUM FOR','WRITES A BALLAD CONCERNING','ORDERS FIREWORKS FOR',
 'PRINTS A PAMPHLET ABOUT','MENTIONS IN PASSING','MAKES A NOTE ABOUT',
 'FILES A REPORT ON','SHRUGS IN THE DIRECTION OF','NODS VAGUELY AT',
 'MISSPELLS THE NAME OF','FORGETS TO ANNOUNCE','LOSES THE PAPERWORK FOR',
 'DOUBLE-BOOKS THE TROPHY OF','QUIETLY DISPUTES','ASKS FOR IDENTIFICATION FROM',
 'BILLS FOR PARKING','SENDS A FORM LETTER TO','DEMANDS AN EXPLANATION FROM',
 'CONFISCATES THE HELMET OF','ISSUES A WARNING TO','MISPRONOUNCES',
 'REFUSES TO ACKNOWLEDGE','ACTIVELY AVOIDS','WRITES A COMPLAINT ABOUT',
 'SUES','BANS FROM THE CAR PARK','THROWS A SANDWICH AT',
 'LAUGHS OPENLY AT','REVOKES THE PARKING PERMIT OF','DEMANDS THE RETURN OF',
 'PRETENDS NOT TO KNOW','BILLS FOR TYRE WEAR'
];
var RW_TARGET=[
 'YOUR MACHINE','YOUR RACING LINE','YOUR BRAKING POINT','YOUR LEFT MIRROR',
 'YOUR ENGINE NOTE','YOUR VICTORY POSE','YOUR TYRE COMPOUND','YOUR HELMET DESIGN',
 'YOUR GEARBOX','YOUR PIT BOARD','YOUR LAP CHART','YOUR REACTION TIME',
 'YOUR STEERING WHEEL','YOUR SPONSOR DECAL','YOUR SEAT FOAM','YOUR SPARE VISOR',
 'YOUR FUEL MAP','YOUR WING ANGLE','YOUR TELEMETRY','YOUR RADIO ETIQUETTE',
 'YOUR CHOICE OF GLOVES','YOUR PARKING','YOUR PACE NOTES','YOUR APPROACH SPEED',
 'YOUR OVERTAKE','YOUR COOLDOWN LAP','YOUR SIGNATURE','YOUR EXPENSES CLAIM',
 'YOUR LUNCH ORDER','YOUR SPARE KEY','YOUR TROPHY CABINET','YOUR WARM-UP ROUTINE',
 'YOUR SUSPENSION SETUP','YOUR TOW ROPE','YOUR SPARE WHEEL NUT','YOUR LUCKY SOCK',
 'YOUR PIT LANE MANNERS','YOUR CHOICE OF MUSIC','YOUR HAIRCUT',
 'YOUR TIMEKEEPING','YOUR GENERAL DEMEANOUR'
];
var RW_FLOURISH=[
 'IN PERPETUITY','WITH FULL MILITARY HONOURS','BEFORE A WEEPING CROWD',
 'AND CANCELS ALL OTHER BUSINESS','TO THUNDEROUS APPLAUSE','IN SOLID BRONZE',
 'AT ENORMOUS PUBLIC EXPENSE','WITH A TWENTY-GUN SALUTE','AND DECLARES IT SACRED',
 'IN THE LOCAL DIALECT','ON A TUESDAY','FOR REASONS UNCLEAR',
 'WITHOUT ENTHUSIASM','IN A SMALL VOICE','AND IMMEDIATELY REGRETS IT',
 'THEN LEAVES','IN THE WRONG LANGUAGE','ON THE BACK OF A RECEIPT',
 'DURING A POWER CUT','WHILE LOOKING ELSEWHERE','IN CRAYON',
 'AND SPELLS IT WRONG','THEN ASKS FOR IT BACK','AT THE WRONG CIRCUIT',
 'TO AN EMPTY ROOM','AND LOSES INTEREST','BY ACCIDENT',
 'IN THE RAIN, ALONE','AND CHARGES YOU FOR IT','THEN DENIES IT HAPPENED',
 'WITH VISIBLE CONTEMPT','AND FILES IT UNDER MISCELLANEOUS','IN A BIN LINER',
 'THEN EMIGRATES','AND BLAMES THE WEATHER','ON A NAPKIN, BADLY',
 'AND NEVER SPEAKS OF IT AGAIN','IN A LANGUAGE NOBODY PRESENT SPEAKS'
];

/* Deterministic 32-bit mix, so the same track and placing always compose the
   same reward. Reusing hash32 alone would correlate the four pools (adjacent
   indices in all of them at once); the salt decorrelates them. */
function rwPick(pool,seedStr,place){
  /* Placement slides a window along the pool: 1st draws from the first third,
     2nd from the middle, 3rd from the last. */
  var third=Math.floor(pool.length/3);
  var base=Math.min(pool.length-1,(Math.max(1,Math.min(3,place))-1)*third);
  var span=(place>=3)?(pool.length-base):third;
  return pool[base+(hash32(seedStr)%Math.max(1,span))];
}

/* Public: the podium line for a finishing position. */
function podiumReward(settlement,place){
  var id=(settlement&&settlement.id)||0;
  var nm=(settlement&&settlement.name)||'';
  var k=id+':'+place+':';
  var parts=[
    rwPick(RW_SUBJECT ,k+'s',place),
    rwPick(RW_DEED    ,k+'d',place),
    rwPick(RW_TARGET  ,k+'t',place),
    rwPick(RW_FLOURISH,k+'f',place)
  ];
  var line=parts[0]+' '+parts[1]+' '+parts[2]+' '+parts[3];
  /* Woven in about half the time — always naming the town makes every line
     read the same shape, which defeats the point of composing them. */
  if(nm&&(hash32(k+'n')%2)===0)line=line.replace('YOUR MACHINE','YOUR MACHINE IN '+nm.toUpperCase());
  return line;
}

/* How many distinct lines this can produce, for the self-test. */
function rewardSpace(){
  return RW_SUBJECT.length*RW_DEED.length*RW_TARGET.length*RW_FLOURISH.length;
}

function award(settlement){
  var r=load(), out=[], reg=regionsOf(settlement.id);
  r.seen++;

  /* 1. INSTANT — always. */
  var rr=rngFor('inst:'+settlement.id);
  out.push({kind:'instant',text:pick(rr,INSTANT)});

  /* 2. REGIONAL — win counts crossing a tier. */
  var mc=bump('m:'+reg.muni);
  if(TIERS.indexOf(mc)>=0)
    out.push({kind:'regional',text:mc+' WINS IN '+nameOf('muni',reg.muni)});
  var sc=bump('s:'+reg.state);
  if(TIERS.indexOf(sc)>=0)
    out.push({kind:'regional',text:sc+' WINS ACROSS '+nameOf('state',reg.state)});
  var cc=bump('c:'+reg.country);
  if(TIERS.indexOf(cc)>=0)
    out.push({kind:'regional',text:cc+' WINS IN '+nameOf('country',reg.country)});

  /* 3. MASTERY — a title the first time a region reaches its top tier. */
  if(mc>=10){
    var t=TITLE_FORMS[hash32(reg.muni)%TITLE_FORMS.length]
            .replace('{R}',nameOf('muni',reg.muni));
    if(r.titles.indexOf(t)<0){r.titles.push(t);out.push({kind:'title',text:t});}
  }
  if(sc>=25){
    var ts=TITLE_FORMS[hash32(reg.state)%TITLE_FORMS.length]
            .replace('{R}',nameOf('state',reg.state));
    if(r.titles.indexOf(ts)<0){r.titles.push(ts);out.push({kind:'title',text:ts});}
  }
  if(cc>=50){
    var e=nameOf('country',reg.country)+' EMBLEM';
    if(r.emblems.indexOf(e)<0){r.emblems.push(e);out.push({kind:'emblem',text:e});}
  }

  /* 4. DISCOVERY — rare, and richer in larger settlements so the type of place
     the player chooses actually matters. */
  var odds={hamlet:0.04,village:0.05,town:0.07,small:0.09,mid:0.11,large:0.14,megacity:0.20};
  var dr=rngFor('disc:'+settlement.id+':'+r.seen);
  if(dr()<(odds[settlement.type]||0.05)){
    var pool=DISCOVERY[settlement.type]||DISCOVERY.hamlet;
    var find=pick(dr,pool)+' \u00b7 '+nameOf('country',reg.country);
    if(r.finds.indexOf(find)<0){r.finds.push(find);out.push({kind:'find',text:find});}
  }

  /* 5. SPONSOR — offered on a country-win cadence, so a sponsor is tied to a
     place the player has actually invested in. */
  if(cc===5||cc===20||cc===60){
    var sp=SPONSORS[hash32(reg.country+':'+cc)%SPONSORS.length];
    if(r.sponsors.indexOf(sp)<0){
      r.sponsors.push(sp);
      out.push({kind:'sponsor',text:sp+' SIGNS YOU'});
    }
  }
  /* 6. LIVERY — cosmetic, from the continent, so each continent dresses the
     machine differently. */
  if(mc===7||sc===15){
    var lv=LIVERIES[hash32(reg.continent+':'+r.liveries.length)%LIVERIES.length];
    if(r.liveries.indexOf(lv)<0){
      r.liveries.push(lv);
      out.push({kind:'livery',text:'LIVERY UNLOCKED \u00b7 '+lv});
    }
  }
  /* 7. PART — the rarest routine reward, from state mastery. */
  if(sc===10||sc===40){
    var pt=PARTS[hash32(reg.state+':'+sc)%PARTS.length];
    if(r.parts.indexOf(pt)<0){
      r.parts.push(pt);
      out.push({kind:'part',text:'PART ACQUIRED \u00b7 '+pt});
    }
  }
  /* 8. RANK — global career progression, so there is always a next milestone
     however scattered the player's racing is. */
  for(var ri=RANK_AT.length-1;ri>=0;ri--){
    if(r.seen>=RANK_AT[ri]){
      if(r.rank!==RANKS[ri]){
        r.rank=RANKS[ri];
        out.push({kind:'rank',text:'RANK \u00b7 '+RANKS[ri]});
      }
      break;
    }
  }
  /* 9. LANDMARK — the settlement itself grows as it is raced. */
  if(mc===4||mc===12||mc===30){
    var lm=LANDMARKS[hash32(reg.muni+':'+mc)%LANDMARKS.length];
    out.push({kind:'landmark',text:lm+' OPENS AT '+nameOf('muni',reg.muni)});
  }
  /* 10. CREW — occasional, keyed to country progress. */
  if(cc===12||cc===35){
    var cw=CREW[hash32(reg.country+':'+cc)%CREW.length];
    if(r.crew.indexOf(cw)<0){r.crew.push(cw);out.push({kind:'crew',text:cw});}
  }

  /* (2) FUNDS — the most common concrete reward, so most wins pay something
     beyond flavour. Scaled by settlement type via the caller's payout. */
  if(rr()<0.34){
    var fp=FUND_PRIZES[hash32(settlement.id+':f'+r.seen)%FUND_PRIZES.length];
    var amt=Math.round(fp[1]*(0.6+rr()*1.2));
    try{ if(global.UpgradeShop)global.UpgradeShop.addCredits(amt); }catch(e){}
    out.push({kind:'funds',text:fp[0]+'  +'+amt.toLocaleString()+' CR'});
  }
  /* (2) PARTS — new shapes for the Machine Editor. Rarer, and each is unique,
     so the editor's option list grows across a career. */
  if(rr()<0.10){
    var pp=PART_PRIZES[hash32(settlement.id+':p'+r.seen)%PART_PRIZES.length];
    if(r.parts.indexOf(pp[0])<0){
      r.parts.push(pp[0]);
      out.push({kind:'part',text:pp[0]+'  \u00b7  '+pp[2]});
    }
  }
  /* (2) CAPACITY — raises a ceiling in the editor. Rarest of the three. */
  if(rr()<0.045){
    var cp=CAP_PRIZES[hash32(settlement.id+':c'+r.seen)%CAP_PRIZES.length];
    if(r.caps.indexOf(cp[0])<0){
      r.caps.push(cp[0]);
      out.push({kind:'cap',text:cp[0]+'  \u00b7  '+cp[2]});
    }
  }

  save();
  /* Cap at three per race. With ten categories a milestone race can qualify
     for several at once, and showing them all would bury the player — the
     remainder still bank, they simply are not announced. */
  return out.slice(0,3);
}

function summary(){
  var r=load();
  return {wins:r.seen,rank:r.rank,titles:r.titles.slice(),finds:r.finds.slice(),
          emblems:r.emblems.slice(),sponsors:r.sponsors.slice(),
          liveries:r.liveries.slice(),parts:r.parts.slice(),crew:r.crew.slice(),
          caps:(r.caps||[]).slice()};
}
function reset(){ _r=null; try{localStorage.removeItem(KEY);}catch(e){} }

global.WorldRewards={award:award,summary:summary,reset:reset,
  podiumReward:podiumReward,rewardSpace:rewardSpace,
  timesPut:timesPut,timesGet:timesGet,
  timesPrefetch:timesPrefetch,timesCached:timesCached};

})(typeof window!=='undefined'?window:globalThis);

/* 
   LAP TIME STORE — IndexedDB   (items 15 and 16)
   ---------------------------------------------------------------------------
   Race and lap times for ~81,742 tracks, persisted.

   WHY IndexedDB AND NOT localStorage
   localStorage is where the rest of the save data lives, and for that it is the
   right choice: a few kilobytes, read synchronously during the first frame.
   Times are different. A player who works through even a fraction of the world
   accumulates tens of thousands of records, which is comfortably past the
   ~5 MB localStorage quota, and exceeding it throws on write — silently losing
   the save rather than just the times. IndexedDB has no practical size limit
   here and stores structured records without a JSON round trip.

   The store is keyed by settlement id so a lookup is a single indexed get,
   which matters for item 16: flipping a preview tile must show times
   immediately, not after a scan.

   EVERYTHING IS BEST-EFFORT. Private browsing modes disable IndexedDB
   entirely, and a failed open must not stop a race from finishing. Every
   entry point resolves rather than rejects, and the caller gets null. Times
   are a nice-to-have; the race is not.
    */
var TDB_NAME='zsgx_times', TDB_STORE='times', TDB_VER=1;
var _tdb=null, _tdbFailed=false, _tdbOpening=null;

function timesOpen(){
  if(_tdb)return Promise.resolve(_tdb);
  if(_tdbFailed)return Promise.resolve(null);
  if(_tdbOpening)return _tdbOpening;
  _tdbOpening=new Promise(function(res){
    var idb=null;
    try{ idb=(typeof indexedDB!=='undefined')?indexedDB:null; }catch(e){}
    if(!idb){_tdbFailed=true;res(null);return;}
    var rq;
    try{ rq=idb.open(TDB_NAME,TDB_VER); }catch(e){_tdbFailed=true;res(null);return;}
    rq.onupgradeneeded=function(ev){
      try{
        var db=ev.target.result;
        if(!db.objectStoreNames.contains(TDB_STORE))
          db.createObjectStore(TDB_STORE,{keyPath:'id'});
      }catch(e){}
    };
    rq.onsuccess=function(){ _tdb=rq.result; _tdbOpening=null; res(_tdb); };
    rq.onerror=function(){ _tdbFailed=true; _tdbOpening=null; res(null); };
    /* A blocked open never fires either handler — an older tab holding the
       previous version will hang this forever without a timeout. */
    setTimeout(function(){ if(!_tdb){_tdbFailed=true;_tdbOpening=null;res(null);} },3000);
  });
  return _tdbOpening;
}

/* Record a finished race. Keeps the BEST total and the best single lap ever
   set, plus the last few runs for the "recent" column on the flipped tile. */
function timesPut(settlementId,rec){
  return timesOpen().then(function(db){
    if(!db)return null;
    return new Promise(function(res){
      try{
        var tx=db.transaction(TDB_STORE,'readwrite');
        var st=tx.objectStore(TDB_STORE);
        var get=st.get(settlementId);
        get.onsuccess=function(){
          var cur=get.result||{id:settlementId,best:null,bestLap:null,recent:[],runs:0};
          cur.runs=(cur.runs|0)+1;
          if(rec.total!=null&&(cur.best==null||rec.total<cur.best))cur.best=rec.total;
          if(rec.bestLap!=null&&(cur.bestLap==null||rec.bestLap<cur.bestLap))cur.bestLap=rec.bestLap;
          cur.recent=(cur.recent||[]);
          cur.recent.unshift({t:rec.total,lap:rec.bestLap,place:rec.place,at:Date.now()});
          /* Five is enough to show a trend on the tile and keeps the record
             small — an unbounded array would grow without limit on a track the
             player grinds. */
          if(cur.recent.length>5)cur.recent.length=5;
          try{ st.put(cur); }catch(e){}
          res(cur);
        };
        get.onerror=function(){ res(null); };
      }catch(e){ res(null); }
    });
  }).catch(function(){ return null; });
}

/* Read one settlement's times. Used by the flipped preview tile (item 16). */
function timesGet(settlementId){
  return timesOpen().then(function(db){
    if(!db)return null;
    return new Promise(function(res){
      try{
        var st=db.transaction(TDB_STORE,'readonly').objectStore(TDB_STORE);
        var rq=st.get(settlementId);
        rq.onsuccess=function(){ res(rq.result||null); };
        rq.onerror=function(){ res(null); };
      }catch(e){ res(null); }
    });
  }).catch(function(){ return null; });
}

/* Warm a settlement's record into memory so the tile flip is instant. The map
   calls this for whatever is under the cursor; by the time Y is pressed the
   record is already here. */
var _timesCache={};
function timesPrefetch(settlementId){
  if(_timesCache[settlementId]!==undefined)return;
  _timesCache[settlementId]=null;
  timesGet(settlementId).then(function(r){ _timesCache[settlementId]=r; });
}
function timesCached(settlementId){
  var v=_timesCache[settlementId];
  return (v===undefined)?null:v;
}


/* 
   UPGRADE SHOP   (was upgradeshop.js)
   ---------------------------------------------------------------------------
   Machine upgrades, parts and the credit economy. worldflow awards credits
   through this on a race finish, so it must load before worldflow.
    */
/* 
   UPGRADE SHOP — ZONE STORM RACING GX
   ---------------------------------------------------------------------------
   Reached from the World Map. Spends the credits earned from World Tour wins
   on cosmetic and light-handling perks for the machine chosen at the start of
   the tour.

   Layout is a 3x3 grid with the CAR IN THE CENTRE — it is the thing being
   modified, so it holds the middle and the perks surround it. The car rotates
   in place using the same painter the selection screen uses, so what is shown
   here is exactly what is raced.

   Perks are deliberately small in effect. With four million races available,
   anything that meaningfully raised performance would either trivialise the
   game or force grinding; these change how the machine LOOKS and feels rather
   than how fast it is.
    */

(function(global){
'use strict';

var KEY='zsgx_shop_v1';
var _s=null;

function load(){
  if(_s)return _s;
  try{ _s=JSON.parse(localStorage.getItem(KEY)||'null'); }catch(e){ _s=null; }
  if(!_s)_s={credits:0,owned:{}};
  return _s;
}
function save(){ try{ localStorage.setItem(KEY,JSON.stringify(_s)); }catch(e){} }

/* Credits are awarded per win, scaled by settlement type — a megacity is worth
   far more than a hamlet, so the player has a reason to seek out the larger
   races rather than farming the nearest hamlet repeatedly. */
var PAYOUT={hamlet:40,village:60,town:110,small:220,mid:420,large:900,megacity:2200};
function awardCredits(settlement){
  var s=load();
  var base=PAYOUT[settlement.type]||40;
  s.credits+=base;
  save();
  return base;
}
function credits(){ return load().credits; }
/* Grant credits through the module so the in-memory state and the save stay
   in step — writing to localStorage directly leaves the live object stale. */
/* Math.round, not |0: the bitwise OR truncates to 32 bits, so any grant above
   ~2.1 billion wrapped negative and silently removed credits. */
function addCredits(n){ var s=load(); s.credits+=Math.max(0,Math.round(n)||0); save(); return s.credits; }
/* Spend credits outside the perk grid (Tour Stock). All-or-nothing. */
function spendCredits(n){ var s=load(); n=Math.max(0,Math.round(n)||0); if(s.credits<n)return false; s.credits-=n; save(); return true; }
function owns(id){ return !!load().owned[id]; }
/* (4) Everything the player has bought here, for the Rewards Archive. The
   archive only read WorldRewards, so perks, specials and machine upgrades —
   the things actually paid for — never appeared in it. */
function inventory(){
  var s=load(), out={perks:[],specials:[],upgrades:[]};
  for(var i=0;i<PERKS.length;i++)
    if(s.owned[PERKS[i].id])out.perks.push(PERKS[i].name);
  for(var j=0;j<SPECIALS.length;j++){
    var c=(s.specials&&s.specials[SPECIALS[j].id])||0;
    if(c>0)out.specials.push(SPECIALS[j].name+' x'+c);
  }
  /* Only parameters actually moved from the factory value are listed, so the
     entry means "you invested here" rather than repeating the whole spec. */
  var m=machine();
  for(var k=0;k<EDIT_PARAMS.length;k++){
    var p=EDIT_PARAMS[k];
    var n=(s.steps&&s.steps[p.id])||0;
    if(n>0)out.upgrades.push(p.name+'  \u00d7'+n);
  }
  return out;
}

/* ── PERKS 
   Eight perks ring the car. Each is a visual effect with at most a marginal
   handling nudge, so no combination breaks the racing. */
var PERKS=[
  {id:'trail',   name:'ION TRAIL',      cost:300,
   desc:'A burning wake behind the machine.',            fx:'trail'},
  {id:'glow',    name:'UNDERGLOW',      cost:250,
   desc:'Coloured light pooled beneath the chassis.',    fx:'glow'},
  {id:'sparks',  name:'GRIND SPARKS',   cost:400,
   desc:'Showers of sparks when you brush a rail.',      fx:'sparks'},
  {id:'chrome',  name:'MIRROR SHELL',   cost:650,
   desc:'A polished finish that catches the sky.',       fx:'chrome'},
  {id:'halo',    name:'BOOST HALO',     cost:800,
   desc:'A ring of light blooms on every turbo.',        fx:'halo'},
  {id:'ghost',   name:'PHASE ECHO',     cost:1200,
   desc:'A translucent double trails your line.',        fx:'ghost'},
  {id:'plates',  name:'ARMOUR PLATES',  cost:1500,
   desc:'Heavier shell. Shrugs off contact.',            fx:'plates', shield:0.08},
  {id:'vanes',   name:'AERO VANES',     cost:1800,
   desc:'Active vanes bite harder into corners.',        fx:'vanes',  grip:0.06}
];

/* ── (7) LIMITED-TIME ITEMS 
   Rare stock that rotates in and out, so the shop is worth revisiting rather
   than being a fixed list the player reads once. Bribe Racers is the first:
   it guarantees a win outright, so it is expensive, limited to one at a time,
   and only in stock for a window each hour. */
var SPECIALS=[
  {id:'bribe', name:'BRIBE RACERS', cost:25000, limit:1,
   desc:'Win the current race outright. Usable from the pause menu.'}
];
var SPECIAL_PERIOD=3600000;      // one hour
var SPECIAL_WINDOW=900000;       // in stock for 15 minutes of each hour

/* Availability is derived from the clock rather than stored, so it cannot be
   gamed by clearing the save and is identical however the game is restarted. */
function specialInStock(id){
  var t=Date.now()%SPECIAL_PERIOD;
  return t<SPECIAL_WINDOW;
}
function specialCount(id){ var s=load(); return (s.specials&&s.specials[id])||0; }
function buySpecial(id){
  var s=load();
  var sp=null;
  for(var i=0;i<SPECIALS.length;i++)if(SPECIALS[i].id===id)sp=SPECIALS[i];
  if(!sp)return 'UNKNOWN ITEM';
  if(!specialInStock(id))return 'OUT OF STOCK';
  if(!s.specials)s.specials={};
  if((s.specials[id]||0)>=sp.limit)return 'LIMIT REACHED';
  if(s.credits<sp.cost)return 'NEED '+sp.cost.toLocaleString()+' CR';
  s.credits-=sp.cost;
  s.specials[id]=(s.specials[id]||0)+1;
  save();
  return null;
}
/* Spend one. Called by the pause menu when the player uses it. */
function consumeSpecial(id){
  var s=load();
  if(!s.specials||!s.specials[id])return false;
  s.specials[id]--;
  save();
  return true;
}

function buy(id){
  var s=load();
  var p=null;
  for(var i=0;i<PERKS.length;i++)if(PERKS[i].id===id)p=PERKS[i];
  if(!p||s.owned[id]||s.credits<p.cost)return false;
  s.credits-=p.cost;
  s.owned[id]=1;
  save();
  return true;
}

/* ═══ (6) MACHINE EDITOR 
   The parameters from machine_parameter_editor.html, plus HEIGHT, made
   purchasable. Every one is a spend: the visual change is immediate, the
   performance gain is deliberately tiny.

   THE ECONOMY, AND WHY IT IS SHAPED THIS WAY
   With four million races the upgrade path has to absorb an enormous amount of
   play without ever letting the player outgrow the game. Two rules make that
   work:

     1. COST GROWS GEOMETRICALLY. Each step costs 1.55x the last, so the first
        few are cheap and the last few are enormous. A fully maxed machine runs
        to hundreds of millions of credits.
     2. THE CEILING IS +25% TOTAL, and CPU difficulty scales by exactly the same
        factor. So upgrading changes how the machine feels and looks, never how
        hard the game is — the racing stays a contest at every stage.

   Each parameter contributes at most 25%/N of the total gain, so no single
   stat can be rushed to dominance. */
/* (3) Every parameter maps to a real handling trait, and the mapping is a
   TRADE rather than a straight gain — which is what makes experimenting worth
   doing. A narrow tall machine cuts through the air (speed); a wide low one
   plants itself in corners (handling). Neither is better; they suit different
   tracks.

   `axis` names the trait, `dir` is which direction of travel helps it:
   +1 means raising the value helps, -1 means lowering it does.

   (4) `cosmetic:true` parameters never affect performance, so they stay cheap.
   Anything that does affect it is priced far higher — the player pays for
   advantage, not for looks. */
var EDIT_PARAMS=[
  /* (3) Ranges widened substantially. The old spans were exhausted in a few
     dozen steps, which over four million races leaves nothing to chase. Each
     now takes hundreds of steps to reach its extreme, and the cost curve makes
     the final stretch the real commitment. */
  {id:'width',    name:'BODY WIDTH',   min:0.40,max:2.20,def:1.00,step:0.01,
   axis:'handling', dir:+1, note:'Wider = better cornering, more drag'},
  {id:'height',   name:'BODY HEIGHT',  min:0.45,max:2.40,def:1.00,step:0.01,
   axis:'speed',    dir:+1, note:'Taller = higher top speed, less grip'},
  {id:'curve',    name:'BODY CURVE',   min:0.05,max:1.60,def:0.50,step:0.01,
   axis:'accel',    dir:+1, note:'Sleeker shell = quicker pickup'},
  {id:'fins',     name:'FINS',         min:0,   max:6,   def:3,   step:1,
   axis:'handling', dir:+1, note:'More downforce through corners'},
  {id:'sweep',    name:'FIN SWEEP',    min:0,   max:2.0, def:0.62,step:0.01,
   axis:'speed',    dir:+1, note:'Raked fins cut drag on the straight'},
  /* (14) Start at minimum: these genuinely affect shield and acceleration, so
     the player should buy them rather than be given them. */
  {id:'vents',    name:'VENTS',        min:0,   max:8,   def:0,   step:1,
   axis:'shield',   dir:+1, bigCost:true, note:'Cooling keeps the shield topped up'},
  {id:'thrusters',name:'THRUSTERS',    min:1,   max:4,   def:1,   step:1,
   axis:'accel',    dir:+1, bigCost:true, note:'More nozzles = harder launch'},
  {id:'intakeSz', name:'INTAKE SIZE',  min:0.30,max:2.60,def:1.00,step:0.02,
   axis:'accel',    dir:+1, note:'Bigger intake feeds the drive'},
  {id:'skirtDrop',name:'SKIRT DROP',   min:0.0, max:2.0, def:0.40,step:0.02,
   axis:'handling', dir:+1, note:'Lower skirt seals the ground effect'},
  {id:'canopySz', name:'CANOPY SIZE',  min:0.25,max:2.20,def:1.00,step:0.02,
   axis:'speed',    dir:-1, note:'Smaller canopy = less frontal area'},
  {id:'noseLen',  name:'NOSE LENGTH',  min:0.35,max:2.60,def:1.00,step:0.02,
   axis:'speed',    dir:+1, note:'Longer nose pierces the air'},
  {id:'hue',      name:'GLOW HUE',     min:0,   max:360, def:210, step:10,
   axis:null, cosmetic:true, note:'Thruster colour. Cosmetic only'},
  {id:'trimHue',  name:'ACCENT HUE',   min:0,   max:360, def:45,  step:8,
   axis:null, cosmetic:true, swatch:'accent', note:'Accent colour'},
  {id:'trimSat',  name:'ACCENT SAT',   min:0,   max:100, def:90,  step:4,
   axis:null, cosmetic:true, swatch:'accent', note:'Accent saturation'},
  {id:'trimLum',  name:'ACCENT LIGHT', min:25,  max:85,  def:68,  step:3,
   axis:null, cosmetic:true, swatch:'accent', note:'Accent lightness'},
  /* (2) Full body colour, as hue/saturation/lightness so a controller can
     reach every colour with three one-dimensional axes — a 2D colour square
     would need a pointer. */
  {id:'bodyHue',  name:'BODY HUE',     min:0,   max:360, def:215, step:8,
   axis:null, cosmetic:true, swatch:'body', note:'Hull hue'},
  {id:'bodySat',  name:'BODY SAT',     min:0,   max:100, def:78,  step:4,
   axis:null, cosmetic:true, swatch:'body', note:'Hull saturation'},
  {id:'bodyLum',  name:'BODY LIGHT',   min:18,  max:78,  def:52,  step:3,
   axis:null, cosmetic:true, swatch:'body', note:'Hull lightness'}
];
/* Body colour from the three cosmetic axes. */
function bodyColour(){
  var m=previewMachine();
  return 'hsl('+Math.round(m.bodyHue)+','+Math.round(m.bodySat)+'%,'+Math.round(m.bodyLum)+'%)';
}
function accentColour(){
  var m=previewMachine();
  return 'hsl('+Math.round(m.trimHue)+','+Math.round(m.trimSat)+'%,'+Math.round(m.trimLum)+'%)';
}
var MAX_TOTAL_GAIN=0.25;          // hard ceiling, matched by CPU scaling
var STEP_BASE=1200;               // first upgrade step
var STEP_MULT=1.035;   // (3) gentler per-step growth; the tail does the work               // geometric growth

function machine(){
  var s=load();
  if(!s.machine)s.machine={};
  /* (2) BACKFILL MISSING PARAMETERS.
     A save written before a parameter existed has no value for it, so reading
     it gave `undefined` — which then rendered as "undefined" in the editor and
     turned every axis rating into NaN once it entered the arithmetic. Filling
     any absent key with its default makes old saves forward-compatible, and
     the same guard covers any parameter added in future. */
  var changed=false;
  for(var i=0;i<EDIT_PARAMS.length;i++){
    var p=EDIT_PARAMS[i];
    var v=s.machine[p.id];
    if(v===undefined||v===null||typeof v!=='number'||isNaN(v)){
      s.machine[p.id]=p.def;changed=true;
    }
  }
  if(!s.steps){s.steps={};changed=true;}
  if(changed)save();
  return s.machine;
}
/* Cost of the NEXT step on a parameter. Geometric in the number already
   bought, which is what makes the tail so long. */
function stepCost(id){
  var s=load();
  var n=(s.steps&&s.steps[id])||0;
  var p=paramById(id);
  /* (4) Cosmetic changes are a flat, trivial cost — they buy no advantage, so
     charging for them would only discourage personalising the machine.
     Performance steps start 6x higher and grow geometrically. */
  if(p&&p.cosmetic)return 250;
  /* (14) Stat-critical parts are a major purchase, not an incremental tweak. */
  if(p&&p.bigCost)return 50000;
  var base=STEP_BASE*Math.pow(STEP_MULT,n);
  /* (3) The last 5% of any stat costs disproportionately more. Without this
     the curve is uniform and the extremes arrive too early; with it, a nearly
     maxed parameter is a genuine long-term goal rather than a formality. */
  if(p){
    var m=machine();
    var span=(p.max-p.min)||1;
    var frac=Math.abs(m[p.id]-p.def)/Math.max(Math.abs(p.max-p.def),Math.abs(p.def-p.min));
    if(frac>0.95)base*=14;
    else if(frac>0.85)base*=4.5;
    else if(frac>0.70)base*=2.0;
  }
  return Math.round(base);
}
function paramById(id){
  for(var i=0;i<EDIT_PARAMS.length;i++)if(EDIT_PARAMS[i].id===id)return EDIT_PARAMS[i];
  return null;
}
/* (3) Per-axis rating, 0..1, for the bars shown beside the car. Each axis sums
   the contributions of the parameters that feed it, in their helpful
   direction, so the display reflects the actual trade the player has made. */
/* (15) LIVE STATS.
   These read machine() — the COMMITTED values — so nothing moved until the
   player confirmed a purchase. The whole point of staging edits is to see
   their effect before paying, so both readouts now use previewMachine(),
   which includes anything currently staged. */
function axisRatings(){
  var m=(typeof previewMachine==='function')?previewMachine():machine();
  var out={speed:0,handling:0,accel:0,shield:0}, cnt={speed:0,handling:0,accel:0,shield:0};
  for(var i=0;i<EDIT_PARAMS.length;i++){
    var p=EDIT_PARAMS[i];
    if(!p.axis)continue;
    var span=(p.max-p.min)||1;
    var raw=m[p.id];
    if(typeof raw!=='number'||isNaN(raw))raw=p.def;   // never propagate NaN
    var norm=Math.max(0,Math.min(1,(raw-p.min)/span));
    var v=(p.dir>0)?norm:(1-norm);
    out[p.axis]+=v; cnt[p.axis]++;
  }
  for(var k in out)out[k]=cnt[k]?out[k]/cnt[k]:0.5;
  return out;
}
function stepsFor(id){ var s=load(); return (s.steps&&s.steps[id])||0; }
/* Buy one step, moving the parameter toward its extreme. */
function upgrade(id,dir){
  var s=load(), m=machine();
  var p=null;
  for(var i=0;i<EDIT_PARAMS.length;i++)if(EDIT_PARAMS[i].id===id)p=EDIT_PARAMS[i];
  if(!p)return 'BAD PARAM';
  var cost=stepCost(id);
  if(s.credits<cost)return 'NEED '+cost.toLocaleString()+' CR';
  var next=m[id]+p.step*(dir||1);
  if(next<p.min||next>p.max)return 'AT LIMIT';
  s.credits-=cost;
  m[id]=Math.round(next*100)/100;
  s.steps[id]=(s.steps[id]||0)+1;
  save();
  return null;
}
/* Total performance gain, 0..MAX_TOTAL_GAIN. Each parameter's distance from
   its default contributes an equal share, so the ceiling cannot be exceeded
   however the player distributes their spending. */
function performance(){
  var m=(typeof previewMachine==='function')?previewMachine():machine(), gain=0, n=0;
  for(var i=0;i<EDIT_PARAMS.length;i++){
    var p=EDIT_PARAMS[i];
    /* Cosmetic parameters contribute nothing. This tested a `stat` field that
       no longer exists after the axis rework, so every parameter was skipped
       and the reported gain was always 0%. */
    if(!p.axis||p.cosmetic)continue;
    n++;
    var span=Math.max(Math.abs(p.max-p.def),Math.abs(p.def-p.min))||1;
    gain+=Math.min(1,Math.abs(m[p.id]-p.def)/span);
  }
  return n?(gain/n)*MAX_TOTAL_GAIN:0;
}
/* CPU scaling matches the player's gain exactly, so difficulty is constant. */
function cpuScale(){ return 1+performance(); }

/* Design object for the sprite painter, merged from the purchased values. */
/* Design including unconfirmed edits, so the centre car previews live. */
/* (6) Perks that change how the machine LOOKS are attached to the design, so
   both the shop preview and the in-race painter can honour them. They were
   stored as owned but never travelled with the car, which is why buying a
   trail or an underglow changed nothing visible. */
function applyPerks(d){
  var s=load();
  d.perkTrail   = !!s.owned.trail;
  d.perkGlow    = !!s.owned.glow;
  d.perkSparks  = !!s.owned.sparks;
  d.perkMirror  = !!s.owned.mirror;
  d.perkHalo    = !!s.owned.halo;
  d.perkPhase   = !!s.owned.phase;
  d.perkArmour  = !!s.owned.armour;
  d.perkVanes   = !!s.owned.vanes;
  return d;
}
function previewDesign(baseDesign){
  var m=previewMachine(), d={};
  for(var k in baseDesign)d[k]=baseDesign[k];
  d.fins=Math.round(m.fins); d.finSweep=m.sweep;
  d.vents=Math.round(m.vents); d.thrusters=Math.round(m.thrusters);
  d.glowHue=Math.round(m.hue);
  d._width=m.width; d._height=m.height; d._curve=m.curve;
  d._canopy=m.canopySz; d._nose=m.noseLen; d._skirt=m.skirtDrop;
  return applyPerks(d);
}
function machineDesign(baseDesign){
  var m=machine();
  var d={};
  for(var k in baseDesign)d[k]=baseDesign[k];
  d.fins=Math.round(m.fins);
  d.finSweep=m.sweep;
  d.vents=Math.round(m.vents);
  d.thrusters=Math.round(m.thrusters);
  d.glowHue=Math.round(m.hue);
  d._width=m.width; d._height=m.height; d._curve=m.curve;
  /* (6) Races get the perks too, so a purchase is visible where it matters. */
  return applyPerks(d);
}

/* ── STATE  */
/* pane 0 = perks (top half), pane 1 = editor (bottom half) */
/* (2) Pending edits are held here, not written to the save. The car previews
   them live, but no credits move until the player confirms — and a second
   modal makes the spend deliberate rather than something done by accident
   while browsing. */
var Shop={ open:false, sel:0, t:0, flash:0, flashText:'', pane:0, esel:0, tab:0,
           pending:null, pendingCost:0, confirm:false, starT:0, starParam:null };

/* Machine values including any unconfirmed edits, for the live preview. */
function previewMachine(){
  var m=machine(), out={};
  for(var k in m)out[k]=m[k];
  if(Shop.pending)for(var j in Shop.pending)out[j]=Shop.pending[j];
  return out;
}
/* Stage one step without spending. Cost accumulates across staged changes. */
function stage(id,dir){
  var p=paramById(id); if(!p)return 'BAD PARAM';
  var cur=previewMachine()[id];
  var next=Math.round((cur+p.step*dir)*100)/100;
  if(next<p.min||next>p.max)return 'AT LIMIT';
  if(!Shop.pending)Shop.pending={};
  Shop.pending[id]=next;
  Shop.pendingCost+=stepCost(id);
  /* Star burst draws attention to the part that changed. */
  Shop.starParam=id; Shop.starT=1;
  return null;
}
function commitPending(){
  if(!Shop.pending)return 'NOTHING TO BUY';
  var s=load();
  if(s.credits<Shop.pendingCost)return 'NEED '+Shop.pendingCost.toLocaleString()+' CR';
  var m=machine();
  for(var k in Shop.pending){
    m[k]=Shop.pending[k];
    s.steps[k]=(s.steps[k]||0)+1;
  }
  s.credits-=Shop.pendingCost;
  save();
  Shop.pending=null;Shop.pendingCost=0;Shop.confirm=false;
  return null;
}
function cancelPending(){ Shop.pending=null;Shop.pendingCost=0;Shop.confirm=false; }
/* (4) Reset every purchased value to the factory machine. */
function resetMachine(){
  var s=load();
  /* (6) A FULL RESET, NOT A PARTIAL ONE.
     This cleared the machine parameters but left `owned` perks and `specials`
     untouched, so every purchased visual effect survived a "reset to default"
     and the car kept its trail, underglow and armour. Everything the player
     has acquired is cleared. */
  s.machine=null;
  s.steps={};
  s.owned={};
  s.specials={};
  s.credits=0;   // zero funds so a full reset is truly full
  save();
  machine();
  cancelPending();
}

/* (3) Two tabs: the shop itself and the rewards archive, switched with the
   shoulder buttons. The archive was a separate screen reached from the map,
   which meant two places to remember; it belongs beside the thing it explains
   the currency for. */
var TABS=['UPGRADE SHOP','REWARDS ARCHIVE','TOUR PASSPORT'];
function _tabLabel(){ return TABS[Shop.tab]||TABS[0]; }
function nextTab(d){
  Shop.tab=(Shop.tab+d+TABS.length)%TABS.length;
  try{ if(global.SFX&&global.SFX.nav)global.SFX.nav(); }catch(e){}
}
function openShop(){
  /* The GPU weather layers are body-level overlays at z-index 2000001 and are
     only hidden from inside the race renderer, which is not running here. Left
     visible they draw rain over the shop. Hidden by id: their handles live in
     the engine closure, which this file cannot reach. */
  try{
    var _r=document.getElementById('zs-gpurain'); if(_r)_r.style.display='none';
    var _s=document.getElementById('zs-gpusnow'); if(_s)_s.style.display='none';
  }catch(e){}
  Shop.open=true; Shop.sel=0; Shop.t=0;
  /* (15) The shop is a dense information screen; a moving fluid behind it
     competes with the numbers the player is there to read. */
  try{ if(global.WaterFX)global.WaterFX.hide(); }catch(e){}
}
function closeShop(){ Shop.open=false; }

/* ═══ TOUR PASSPORT TAB (plan part 2): the 24 traditions as stamps (a
   tradition's name stays hidden until a rumour or a visit reveals it), the
   player's legends / streak / featured towns, the next milestone, and the
   Tour Stock that grows with the passport. */
function drawTourTab(ctx,vw,vh,dt,top){
  var TP=global.TourProgress; if(!TP)return;
  var S=TP.status(), sv=TP.load(), SIG=TP.SIGS;
  var L=vw*0.05, gw=vw*0.52, cols=6, cw=gw/cols, rows=Math.ceil(SIG.length/cols), chh=Math.min(cw*0.9,(vh-top-80)/rows);
  ctx.save(); ctx.textAlign='center'; ctx.textBaseline='middle';
  ctx.font="11px 'Germania One',serif"; ctx.fillStyle='#bfe8ff';
  ctx.fillText('PASSPORT  \u00b7  '+S.stamps+' / '+S.of+' TRADITIONS',L+gw/2,top);
  for(var i=0;i<SIG.length;i++){
    var g=SIG[i], cx=L+(i%cols+0.5)*cw, cy=top+22+(Math.floor(i/cols)+0.5)*chh, R=Math.min(cw,chh)*0.36;
    var stamped=!!sv.stamps[g.id], seen=!!sv.seen[g.id];
    ctx.beginPath(); ctx.arc(cx,cy,R,0,Math.PI*2);
    ctx.fillStyle=stamped?'rgba(0,0,0,0.35)':'rgba(10,20,30,0.6)'; ctx.fill();
    ctx.lineWidth=stamped?3:1.2; ctx.strokeStyle=stamped?g.col:(seen?'rgba(160,190,210,0.6)':'rgba(70,90,110,0.5)'); ctx.stroke();
    if(stamped){ ctx.save(); ctx.translate(cx,cy); ctx.rotate(-0.2+Math.sin(Shop.t*1.3+i)*0.03);
      ctx.fillStyle=g.col; ctx.font=Math.max(6,Math.round(R*0.30))+"px 'Germania One',serif";
      var ws=g.name.split(' '); for(var w=0;w<ws.length;w++)ctx.fillText(ws[w],0,(w-(ws.length-1)/2)*R*0.36); ctx.restore(); }
    else { ctx.fillStyle=seen?'#8fa8b8':'#4a5a66'; ctx.font=Math.max(5,Math.round(R*(seen?0.22:0.5)))+"px 'Press Start 2P',monospace";
      if(seen){ var ws2=g.name.split(' '); for(var w2=0;w2<ws2.length;w2++)ctx.fillText(ws2[w2],cx,cy+(w2-(ws2.length-1)/2)*R*0.32); }
      else ctx.fillText('?',cx,cy); }
  }
  /* right column: career + milestones + stock */
  var RX=vw*0.62, RW=vw*0.33, y=top;
  ctx.textAlign='left'; ctx.font="9px 'Press Start 2P',monospace";
  var lines=[['LEGENDS CONQUERED',String(S.legends),'#ffd23a'],['LEGENDS REVEALED',String(S.revealed),'#ffe98a'],
             ['WIN STREAK',S.streak+'  (BEST '+S.bestStreak+')  x'+S.mult.toFixed(1),'#ff9a3a'],
             ['FEATURED TODAY',S.featured+' TOWN'+(S.featured===1?'':'S')+' \u00b7 x2','#ffd23a']];
  for(var j=0;j<lines.length;j++){ ctx.fillStyle='#6f8fa0'; ctx.fillText(lines[j][0],RX,y); ctx.fillStyle=lines[j][2]; ctx.textAlign='right'; ctx.fillText(lines[j][1],RX+RW,y); ctx.textAlign='left'; y+=18; }
  var nextM=null; for(var m=0;m<TP.MILESTONES.length;m++)if(S.stamps<TP.MILESTONES[m][0]){nextM=TP.MILESTONES[m];break;}
  y+=6;
  if(nextM){ var prev=0; for(var m2=0;m2<TP.MILESTONES.length;m2++)if(TP.MILESTONES[m2][0]<=S.stamps)prev=TP.MILESTONES[m2][0];
    var pk=(S.stamps-prev)/Math.max(1,nextM[0]-prev);
    ctx.fillStyle='#8fa8b8'; ctx.fillText('NEXT MILESTONE \u00b7 '+nextM[0]+' STAMPS \u00b7 +'+nextM[1].toLocaleString()+' CR',RX,y); y+=12;
    ctx.fillStyle='rgba(255,255,255,0.08)'; ctx.fillRect(RX,y,RW,8);
    var gl=0.6+0.4*Math.sin(Shop.t*4); ctx.fillStyle='rgba(255,210,58,'+gl.toFixed(2)+')'; ctx.fillRect(RX,y,RW*pk,8); y+=14;
    ctx.fillStyle='#ffe98a'; ctx.fillText(nextM[2],RX,y); y+=20;
  } else { ctx.fillStyle='#39ff14'; ctx.fillText('EVERY TRADITION STAMPED',RX,y); y+=24; }
  ctx.font="11px 'Germania One',serif"; ctx.fillStyle='#bfe8ff'; ctx.fillText('TOUR STOCK',RX,y); y+=18;
  var STK=TP.STOCK, cr=TP.credits();
  for(var k=0;k<STK.length;k++){
    var it=STK[k], open=TP.stockOpen(it), sel=(k===(Shop.tsel|0)), rh=Math.max(34,Math.min(46,(vh-y-40)/STK.length));
    var flashK=(sel&&Shop.tbuyT!=null)?Math.max(0,1-(Shop.t-Shop.tbuyT)*2.5):0;
    ctx.fillStyle=flashK>0?(Shop.tbuyOk?'rgba(57,255,20,'+(0.25*flashK).toFixed(2)+')':'rgba(255,80,60,'+(0.25*flashK).toFixed(2)+')'):(sel?'rgba(30,60,90,0.8)':'rgba(8,18,28,0.75)');
    ctx.fillRect(RX,y-4,RW,rh-6);
    if(sel){ ctx.strokeStyle='rgba(127,208,255,'+(0.6+0.4*Math.sin(Shop.t*3.4)).toFixed(2)+')'; ctx.lineWidth=2; ctx.strokeRect(RX,y-4,RW,rh-6); }
    ctx.font="10px 'Germania One',serif"; ctx.fillStyle=open?(sel?'#ffffff':'#bfe8ff'):'#4a5a66';
    ctx.fillText(it.name,RX+10,y+6);
    ctx.textAlign='right'; ctx.fillStyle=!open?'#8a5a5a':(cr>=it.cost?'#ffd23a':'#8a5a5a');
    ctx.fillText(open?(it.cost.toLocaleString()+' CR'):('\u{1F512} '+it.need+' STAMPS'),RX+RW-10,y+6);
    ctx.textAlign='left'; ctx.font="7px 'Press Start 2P',monospace"; ctx.fillStyle='#6f8fa0';
    var have=(it.id==='magnet')?sv.magnetLeft:(it.id==='ticket'?sv.ticket:(sv.stock[it.id]||0));
    ctx.fillText(it.desc+(have?('   OWNED '+have):''),RX+10,y+20);
    y+=rh;
  }
  ctx.restore();
}
/* Grid positions: 3x3 with the car at index 4 (centre). Perks fill the ring in
   reading order, skipping the middle. */
var RING=[0,1,2,3,5,6,7,8];

function input(btn){
  if(!Shop.open)return false;
  if(btn==='lb'){ nextTab(-1); return true; }
  if(btn==='rb'){ nextTab(1); return true; }
  /* TOUR PASSPORT tab: up/down choose Tour Stock, A buys. */
  if(Shop.tab===2){
    var STK=(global.TourProgress&&global.TourProgress.STOCK)||[];
    if(btn==='b'){ closeShop(); return true; }
    if(btn==='up'){ Shop.tsel=((Shop.tsel|0)+STK.length-1)%Math.max(1,STK.length); return true; }
    if(btn==='down'){ Shop.tsel=((Shop.tsel|0)+1)%Math.max(1,STK.length); return true; }
    if(btn==='a'&&STK.length){
      var it2=STK[Shop.tsel|0], from=null;
      try{ from=(global.WorldTourFlow&&global.WorldTourFlow.flow&&global.WorldTourFlow.flow.settlement&&global.WorldTourFlow.flow.settlement.id)||null; }catch(e){}
      var msg=global.TourProgress.buy(it2.id,from);
      flash(msg); Shop.tbuyT=Shop.t; Shop.tbuyOk=!/NOT ENOUGH|NEEDS|UNKNOWN|NO HIDDEN/.test(msg);
      return true;
    }
    return true;
  }
  /* The archive tab is a read-only view; only tab switching and back apply. */
  if(Shop.tab===1){
    if(btn==='b'){ closeShop(); return true; }
    return true;
  }
  if(btn==='b'){
    if(Shop.confirm){Shop.confirm=false;return true;}
    if(Shop.pending){cancelPending();flash('CHANGES DISCARDED');return true;}
    if(Shop.pane===1){Shop.pane=0;return true;}   // editor -> perks
    closeShop(); return true;
  }
  /* (6) EDITOR PANE. Left/right buy a step in each direction, so a controller
     alone can drive every value — the HTML editor's sliders would need a
     pointer. */
  if(Shop.pane===1){
    if(btn==='up'){
      if(Shop.esel===0){Shop.pane=0;}            // top row -> back to perks
      else Shop.esel--;
      return true;
    }
    if(btn==='down'){Shop.esel=Math.min(EDIT_PARAMS.length-1,Shop.esel+1);return true;}
    /* Confirmation modal owns input while it is up. */
    if(Shop.confirm){
      if(btn==='a'){ var ce=commitPending(); flash(ce||'UPGRADES INSTALLED'); }
      else if(btn==='b'){ Shop.confirm=false; }
      return true;
    }
    if(btn==='left'||btn==='right'){
      var err=stage(EDIT_PARAMS[Shop.esel].id,btn==='right'?1:-1);
      if(err)flash(err);
      return true;
    }
    if(btn==='a'){
      if(!Shop.pending)flash('USE \u2190 \u2192 TO ADJUST');
      else Shop.confirm=true;
      return true;
    }
    return true;
  }
  if(btn==='down'&&(RING[Shop.sel]>=6)){          // bottom row -> editor
    Shop.pane=1;Shop.esel=0;return true;
  }
  if(btn==='a'){
    var p=PERKS[Shop.sel];
    if(!p)return true;
    if(owns(p.id)){ flash('ALREADY OWNED'); }
    else if(credits()<p.cost){ flash('NOT ENOUGH CREDITS'); }
    else if(buy(p.id)){ flash(p.name+' INSTALLED'); }
    return true;
  }
  /* Movement follows the ring visually rather than by array order, so left and
     right go where the eye expects on a 3x3 layout. */
  var cell=RING[Shop.sel];
  var col=cell%3, row=Math.floor(cell/3);
  if(btn==='left')col--;
  else if(btn==='right')col++;
  else if(btn==='up')row--;
  else if(btn==='down')row++;
  else return true;
  col=(col+3)%3; row=(row+3)%3;
  var target=row*3+col;
  if(target===4){                       // centre holds the car, step past it
    if(btn==='left')col=(col+2)%3; else if(btn==='right')col=(col+1)%3;
    else if(btn==='up')row=(row+2)%3;  else row=(row+1)%3;
    target=row*3+col;
  }
  var idx=RING.indexOf(target);
  if(idx>=0)Shop.sel=idx;
  return true;
}
function flash(t){ Shop.flashText=t; Shop.flash=1.6; }

/* ── DRAW  */
function draw(ctx,vw,vh,dt){
  if(!Shop.open)return;
  Shop.t+=dt;
  if(Shop.flash>0)Shop.flash-=dt;

  ctx.save();
  ctx.fillStyle='rgba(0,2,8,0.94)';ctx.fillRect(0,0,vw,vh);

  /* (4) HEADER BAR. Branding, title and balance live inside one centred
     rectangle so they read as a single header instead of three items pushed to
     the corners. Geometry is computed here because the layout constants below
     depend on the same HEAD band. */
  var HEADB=Math.round(vh*0.10);
  var barH=Math.round(HEADB*0.78), barY=Math.round(HEADB*0.08);
  var barW=Math.min(vw*0.94,1240), barX=(vw-barW)/2;
  ctx.fillStyle='rgba(4,16,26,0.94)';
  ctx.fillRect(barX,barY,barW,barH);
  /* (15) No border: the plate reads cleanly against the dark background. */

  /* (5) Same size as the UPGRADE SHOP heading below, so the two read as a
     matched pair rather than a label and a title. */
  var bf=Math.max(15,Math.round(barH*0.46));
  var fk=0.5+0.5*Math.sin(Shop.t*2.6);
  var lx=barX+18, ly=barY+barH*0.14;
  var lg=ctx.createLinearGradient(lx,barY+barH*0.18,lx,barY+barH*0.82);
  lg.addColorStop(0,'#8a1a00');
  lg.addColorStop(Math.max(0.05,Math.min(0.95,0.35+fk*0.30)),'#ff6a00');
  lg.addColorStop(Math.max(0.10,Math.min(0.99,0.62+fk*0.26)),'#fff2c0');
  lg.addColorStop(1,'#8a1a00');
  /* (1) The logo is drawn ONCE, by the measured header below. This earlier
     draw was left behind when that layout was introduced, so two copies were
     painted at slightly different positions. */

  /* (4) ONE LINE, MEASURED AND PACKED.
     Logo, title, credits and performance were each positioned independently —
     left edge, centre, right edge — and overlapped as soon as any of them grew.
     They are now laid out left to right from measured widths, so they can
     never collide regardless of the numbers involved. */
  ctx.textBaseline='middle';
  var _cy=barY+barH/2;
  ctx.font=bf+"px 'Germania One','Press Start 2P',serif";
  var wLogo=ctx.measureText('ZONE STORM RACING GX').width;
  var fT=Math.max(14,Math.round(barH*0.42));
  ctx.font=fT+"px 'Germania One',serif";
  var wTitle=ctx.measureText(_tabLabel()).width;
  var fC=Math.max(12,Math.round(barH*0.36));
  ctx.font=fC+"px 'Germania One',serif";
  var crTxt=credits().toLocaleString()+' CR';
  var wCr=ctx.measureText(crTxt).width;
  var fP=Math.max(8,Math.round(barH*0.24));
  ctx.font=fP+"px 'Press Start 2P',monospace";
  var pfTxt='PERFORMANCE +'+(performance()*100).toFixed(1)+'% / MAX 25%';
  var wPf=ctx.measureText(pfTxt).width;

  /* (2) THEY STILL OVERLAPPED AT THE CENTRE.
     Splitting left/right is not enough on its own: if the four items together
     are wider than the bar, the left group runs into the right one no matter
     which edge each is anchored to. The whole row is measured first and every
     font scaled down together until it fits, so they cannot collide at any
     credit balance or window width. */
  var pad=Math.max(10,barW*0.018);
  var _need=wLogo+wTitle+wCr+wPf+pad*3+32;
  if(_need>barW){
    var _k=Math.max(0.55,barW/_need);
    bf=Math.max(9,Math.round(bf*_k));
    fT=Math.max(9,Math.round(fT*_k));
    fC=Math.max(9,Math.round(fC*_k));
    fP=Math.max(6,Math.round(fP*_k));
    /* Re-measure at the reduced sizes. */
    ctx.font=bf+"px 'Germania One','Press Start 2P',serif";
    wLogo=ctx.measureText('ZONE STORM RACING GX').width;
    ctx.font=fT+"px 'Germania One',serif";
    wTitle=ctx.measureText(_tabLabel()).width;
    ctx.font=fC+"px 'Germania One',serif";
    wCr=ctx.measureText(crTxt).width;
    ctx.font=fP+"px 'Press Start 2P',monospace";
    wPf=ctx.measureText(pfTxt).width;
  }
  ctx.textAlign='left';
  var cur=barX+16;
  ctx.font=bf+"px 'Germania One','Press Start 2P',serif";
  ctx.fillStyle=lg;
  ctx.fillText('ZONE STORM RACING GX',cur,_cy); cur+=wLogo+pad;
  ctx.font=fT+"px 'Germania One',serif";
  ctx.fillStyle='#dff3ff';
  ctx.fillText(_tabLabel(),cur,_cy);
  /* (4) 250px of clear space after the title before the numbers begin. The
     right group is anchored to the bar's edge, so this is enforced by capping
     how far left that group may start. */
  var _leftEnd=cur+wTitle+250;

  ctx.textAlign='right';
  var rgt=barX+barW-16;
  /* (6) The archive is not a shop: a credit balance and a performance figure
     mean nothing there, so the right-hand group is drawn only on the shop
     tab. */
  if(Shop.tab!==1){
    /* The performance figure now sits beside MACHINE EDITOR, where the values
       it summarises actually live — see the editor header below. */
    ctx.font=fC+"px 'Germania One',serif";
    ctx.fillStyle='#ffd23a';
    ctx.fillText(crTxt,Math.max(rgt,_leftEnd+wCr),_cy);
  }
  /* (3) A quiet hint that the shoulder buttons move between tabs — placed on
     the side the button would take you toward. */
  ctx.font="7px 'Press Start 2P',monospace";
  ctx.fillStyle='rgba(255,255,255,0.72)';
  ctx.textAlign='right';
  ctx.fillText('RB \u2192 '+TABS[(Shop.tab+1)%TABS.length],vw-76,barY+barH+9);
  ctx.textAlign='left';
  ctx.fillText('LB \u2190 '+TABS[(Shop.tab+TABS.length-1)%TABS.length],76,barY+barH+9);
  ctx.textAlign='left';
  ctx.textBaseline='top';



  /* (3) Layout is derived from the viewport rather than fixed fractions, so
     the shop fills the screen at any aspect and the two bands never collide.
     HEAD holds the branding row; PERKS and EDITOR split the remainder with a
     fixed gutter between them. */
  /* (3) Archive tab: hand off to worldflow's renderer, which already knows how
     to lay the table out, then stop. The header above is shared. */
  if(Shop.tab===2){
    try{ drawTourTab(ctx,vw,vh,dt,barY+barH+22); }catch(e){}
    ctx.textAlign='center';ctx.textBaseline='top';
    ctx.font="9px 'Press Start 2P',monospace";
    ctx.fillStyle='#4a6a80';
    ctx.fillText('\u25b2\u25bc STOCK     A  BUY     LB / RB  SWITCH TAB     B  BACK',vw/2,vh-20);
    ctx.restore();
    return;
  }
  if(Shop.tab===1){
    try{
      if(global.WorldTourFlow&&global.WorldTourFlow.drawArchiveBody)
        global.WorldTourFlow.drawArchiveBody(ctx,vw,vh,dt,barY+barH+10);
    }catch(e){}
    ctx.textAlign='center';ctx.textBaseline='top';
    ctx.font="9px 'Press Start 2P',monospace";
    ctx.fillStyle='#4a6a80';
    ctx.fillText('LB / RB  SWITCH TAB      B  BACK',vw/2,vh-20);
    ctx.restore();
    return;
  }

  var HEAD=Math.round(vh*0.10);
  var GUT=Math.round(vh*0.025);
  var FOOT=Math.round(vh*0.05);
  var body=vh-HEAD-FOOT-GUT;
  var perkH=Math.round(body*0.46), editH=body-perkH;
  var gw=vw*0.94, gx=(vw-gw)/2, gy=HEAD;
  var gh=perkH;
  var cw=gw/3, ch=gh/3;

  for(var k=0;k<RING.length;k++){
    var cell=RING[k];
    var col=cell%3, row=Math.floor(cell/3);
    var x=gx+col*cw+6, y=gy+row*ch+6, w=cw-12, h=ch-12;
    var p=PERKS[k];
    var sel=(k===Shop.sel);
    var have=owns(p.id), afford=credits()>=p.cost;

    ctx.fillStyle=have?'rgba(10,40,20,0.9)':'rgba(6,18,28,0.9)';
    ctx.fillRect(x,y,w,h);
    if(sel){
      var pulse=0.5+0.5*Math.sin(Shop.t*3.4);
      ctx.strokeStyle='rgba(127,208,255,'+(0.6+pulse*0.4).toFixed(2)+')';
      ctx.lineWidth=3+pulse*2;
      ctx.shadowColor='#7fd0ff';ctx.shadowBlur=12+pulse*14;
    } else {
      ctx.strokeStyle=have?'rgba(57,255,20,0.7)':'rgba(70,110,140,0.6)';
      ctx.lineWidth=1.5;
    }
    ctx.strokeRect(x,y,w,h);
    ctx.shadowBlur=0;

    ctx.textAlign='center';ctx.textBaseline='top';
    ctx.font=Math.max(9,Math.round(h*0.13))+"px 'Germania One',serif";
    ctx.fillStyle=have?'#39ff14':(sel?'#ffffff':'#9fb6c9');
    ctx.fillText(p.name,x+w/2,y+8);

    ctx.font=Math.max(7,Math.round(h*0.088))+"px 'Press Start 2P',monospace";
    ctx.fillStyle='#6f8fa0';
    wrapText(ctx,p.desc,x+w/2,y+h*0.36,w-16,Math.round(h*0.13));

    ctx.font=Math.max(8,Math.round(h*0.11))+"px 'Germania One',serif";
    ctx.fillStyle=have?'#39ff14':(afford?'#ffd23a':'#8a5a5a');
    ctx.fillText(have?'OWNED':(p.cost+' CR'),x+w/2,y+h-Math.round(h*0.20));
  }

  /* The machine occupies the centre cell, rotating. The cell is drawn OVERSIZE
     (overlapping its neighbours slightly) because an upgraded machine can be
     more than twice its default width or height.
     `ov` was referenced below without ever being declared, which threw inside
     the try/catch and silently removed the car — the regression. */
  /* (1) The car cell matches the perk tiles exactly. It was drawn oversize to
     accommodate an upgraded machine, but that broke the grid's rhythm — the
     sprite is scaled to fit instead, which keeps the layout uniform and still
     shows the whole car. */
  var mx=gx+cw, my=gy+ch;
  var ov=0;
  ctx.fillStyle='rgba(4,14,26,0.96)';
  ctx.fillRect(mx+6-ov,my+6-ov,cw-12+ov*2,ch-12+ov*2);
  ctx.strokeStyle='rgba(120,240,150,0.55)';ctx.lineWidth=2;
  ctx.strokeRect(mx+6-ov,my+6-ov,cw-12+ov*2,ch-12+ov*2);
  /* (5) Traits named in full, flanking the car: SPEED and HANDLING left,
     ACCELERATION and SHIELD right. Abbreviations in a header row were easy to
     miss and gave no sense of which value had just moved. */
  {
    var _a=axisRatings();
    /* (1) Anchored to the cell's own left and right edges (inset by 14px so
       nothing touches the border) rather than clustered near the middle. That
       frees the centre for the car and gives each value room to be read. */
    var lfX=mx+14, rtX=mx+cw-14;
    var labF=Math.max(8,Math.round(ch*0.085));
    var valF=Math.max(11,Math.round(ch*0.135));
    /* One per corner: two on the left edge, two on the right, each with its
       own row. Stacking two per side at the same height overlapped them. */
    /* Top pair nudged down 15px, bottom pair up 15px, so all four sit clear
       of the cell's edges. Alignment flips per side: left-hand values are
       left-aligned from the left edge, right-hand values right-aligned from
       the right edge. */
    var _in=15;
    /* (14) SPEED and ACCELERATION drop 8px so they clear the cell's top edge;
       HANDLING and SHIELD are unchanged. */
    var _d8=8;
    var pairs=[['SPEED',       _a.speed,   lfX,'left',  my+ch*0.06+_in+_d8],
               ['HANDLING',    _a.handling,lfX,'left',  my+ch*0.94-_in],
               ['ACCELERATION',_a.accel,   rtX,'right', my+ch*0.06+_in+_d8],
               ['SHIELD',      _a.shield,  rtX,'right', my+ch*0.94-_in]];
    for(var pi=0;pi<pairs.length;pi++){
      var pr2=pairs[pi];
      var py2=pr2[4];
      ctx.textAlign=pr2[3];ctx.textBaseline='middle';
      ctx.font=labF+"px 'Press Start 2P',monospace";
      ctx.fillStyle='#7fa8c0';
      ctx.fillText(pr2[0],pr2[2],py2-valF*0.62);
      ctx.font=valF+"px 'Germania One',serif";
      ctx.fillStyle='#39ff14';
      ctx.fillText((pr2[1]*100).toFixed(0),pr2[2],py2+valF*0.32);
      /* Small bar under each value so a change is visible at a glance. */
      var bw3=cw*0.26, bx3=(pr2[3]==='right')?(pr2[2]-bw3):pr2[2];
      ctx.fillStyle='#12283c';ctx.fillRect(bx3,py2+valF*0.78,bw3,4);
      ctx.fillStyle='#39ff14';ctx.fillRect(bx3,py2+valF*0.78,bw3*pr2[1],4);
    }
    ctx.textAlign='center';ctx.textBaseline='top';
  }
  try{
    var car=(global.GX_selectedCar&&global.GX_selectedCar())||null;
    if(car&&global.drawCarSprite){
      ctx.save();
      /* SQUARE BOX, OR THE MACHINE COMES OUT THE WRONG SHAPE.
         drawCarSprite derives the body from the box it is handed as
         w = box.w*0.30 and h = box.h*0.46 — two DIFFERENT fractions. The car
         select screen passes a square canvas (cv.width=cv.height=size), so
         those fractions yield the intended upright 1:1.53 machine. This screen
         passed the grid cell instead, which is wide and short, so 0.30 of the
         width came out large and 0.46 of the height came out small: the car
         was drawn both too wide and too flat, and did not match the machine
         anywhere else in the game.
         Taking the smaller of the cell's two dimensions restores a square box
         and therefore the correct proportions, at the largest size that still
         fits the tile. */
      var _pm=previewMachine();
      var _big=Math.max(_pm.width||1,(_pm.height||1));
      /* Only oversized machines are scaled back, and by the square root, so a
         bigger machine still reads as bigger. */
      var _fit=(_big>1.35)?Math.sqrt(1.35/_big):1;
      /* SIZE THE BOX SO THE MACHINE FILLS THE CELL.
         drawCarSprite only uses 0.30 of the box's width and 0.46 of its
         height, so simply handing it min(cellW, cellH) left the car occupying
         under half the tile — visibly smaller than the same machine on the
         car select screen, and the reported "height too small".
         The box is instead sized so the DRAWN BODY reaches ~88% of the cell,
         solving each axis for the fraction that axis actually uses and taking
         whichever is the binding constraint. The box stays square, so the
         1:1.53 proportion established above is untouched — this changes only
         how large the machine is, not its shape. */
      var _dz=previewDesign(car.design||{});
      var _cv2=(_dz&&_dz._curve!=null)?_dz._curve:0.5;
      var _wM=(_dz&&_dz._width !=null)?_dz._width :1;
      var _hM=(_dz&&_dz._height!=null)?_dz._height:1;
      var _byW=(0.88*(cw-12))/Math.max(0.01,0.30*_wM);
      var _byH=(0.88*(ch-12))/Math.max(0.01,0.46*_hM*(0.9+0.2*_cv2));
      var _box=Math.min(_byW,_byH)*_fit;
      /* Centre the square within the cell on both axes. */
      ctx.translate(mx+6+((cw-12)-_box)/2, my+6+((ch-12)-_box)/2);
      global.drawCarSprite(ctx,
        {col:bodyColour(),accentCol:accentColour(),design:_dz},
        _box,_box,Shop.t*0.9);
      ctx.restore();
    }
  }catch(e){ if(!Shop._carWarned){Shop._carWarned=true;console.warn('car preview:',e);} }

  if(Shop.flash>0){
    ctx.textAlign='center';ctx.textBaseline='middle';
    ctx.globalAlpha=Math.min(1,Shop.flash);
    ctx.font=Math.max(13,Math.round(Math.min(vw,vh)*0.032))+"px 'Germania One',serif";
    ctx.fillStyle='#ffd23a';
    ctx.fillText(Shop.flashText,vw/2,vh*0.90);
    ctx.globalAlpha=1;
  }

  /* ── EDITOR PANE  */
  var ey=HEAD+perkH+GUT, eh=editH;
  var ex=gx, ew=gw;
  ctx.fillStyle='rgba(3,12,20,0.92)';ctx.fillRect(ex,ey,ew,eh);
  ctx.strokeStyle=(Shop.pane===1)?'rgba(127,208,255,0.9)':'rgba(70,110,140,0.5)';
  ctx.lineWidth=(Shop.pane===1)?3:1.5;
  ctx.strokeRect(ex,ey,ew,eh);

  ctx.textAlign='left';ctx.textBaseline='top';
  ctx.font=Math.max(11,Math.round(vh*0.026))+"px 'Germania One',serif";
  ctx.fillStyle='#dff3ff';
  /* (5) Centred, with the parameter grid pushed clear beneath it. */
  ctx.textAlign='center';
  ctx.fillText('MACHINE EDITOR',ex+ew/2,ey+8);
  /* Performance beside the title, 25% smaller than the header figure was. */
  var _mw=ctx.measureText('MACHINE EDITOR').width;
  ctx.textAlign='left';
  ctx.font=Math.max(6,Math.round(fP*0.75))+"px 'Press Start 2P',monospace";
  ctx.fillStyle='#9fd8b0';
  ctx.fillText(pfTxt,ex+ew/2+_mw/2+18,ey+12);
  ctx.textAlign='right';
  ctx.font=Math.max(9,Math.round(vh*0.020))+"px 'Press Start 2P',monospace";
  ctx.fillStyle='#39ff14';
  var _ar=axisRatings();
  /* (5) Only the overall figure sits in the editor header; the four traits are
     drawn beside the car below, where there is room to name them in full. */
  /* (3) Moved into the header bar beside the credits — see below. */
  /* (3) The pending banner sits INSIDE the editor header rather than on its
     bottom edge, where it collided with the border of the panel below. */
  /* The pending banner sits in the FOOTER strip, clear of both the axis
     readout in the header and the panel border below. */
  if(Shop.pendingCost>0){
    var ptxt='PENDING '+Shop.pendingCost.toLocaleString()+' CR   \u00b7   A TO CONFIRM   \u00b7   B DISCARD';
    ctx.textAlign='center';ctx.textBaseline='middle';
    ctx.font=Math.max(9,Math.round(vh*0.020))+"px 'Press Start 2P',monospace";
    var pw3=ctx.measureText(ptxt).width+26;
    var pbh=Math.round(vh*0.034), pby=vh-FOOT+2;
    ctx.fillStyle='rgba(60,44,6,0.96)';
    ctx.fillRect(vw/2-pw3/2,pby,pw3,pbh);
    ctx.strokeStyle='rgba(255,210,58,0.85)';ctx.lineWidth=1.5;
    ctx.strokeRect(vw/2-pw3/2,pby,pw3,pbh);
    ctx.fillStyle='#ffd23a';
    ctx.fillText(ptxt,vw/2,pby+pbh/2);
    ctx.textBaseline='top';
  }

  /* Two columns of parameters so all eight fit without scrolling. */
  var cols=3, rows=Math.ceil(EDIT_PARAMS.length/cols);
  var rh=(eh-46)/rows;
  for(var e=0;e<EDIT_PARAMS.length;e++){
    var pr=EDIT_PARAMS[e];
    var colI=Math.floor(e/rows), rowI=e%rows;
    var rx=ex+12+colI*(ew/cols-6), ry=ey+38+32+rowI*rh, rw2=ew/cols-26;
    var esel=(Shop.pane===1&&e===Shop.esel);
    if(esel){
      var ep=0.5+0.5*Math.sin(Shop.t*3.4);
      ctx.fillStyle='rgba(20,60,90,'+(0.30+ep*0.25).toFixed(2)+')';
      ctx.fillRect(rx-6,ry-3,rw2+12,rh-6);
    }
    ctx.textAlign='left';
    /* (14) Same size as the perk tile body text above, so the two halves of
       the screen read as one design. */
    ctx.font=Math.max(6,Math.round(rh*0.22))+"px 'Press Start 2P',monospace";
    ctx.fillStyle=esel?'#ffffff':'#8fa8b8';
    ctx.fillText(pr.name,rx,ry+2);

    /* Fill bar showing distance travelled from the default. */
    var m2=previewMachine();
    var span=Math.max(Math.abs(pr.max-pr.def),Math.abs(pr.def-pr.min))||1;
    /* (14) THE SLIDERS READ BACKWARDS.
       This showed DISTANCE FROM DEFAULT, so moving a value toward its minimum
       filled the bar just as moving toward the maximum did — and for any
       parameter whose default sits above centre, the bar appeared inverted.
       A slider must show POSITION IN RANGE: empty at min, full at max. */
    var frac=Math.max(0,Math.min(1,(m2[pr.id]-pr.min)/((pr.max-pr.min)||1)));
    var bx2=rx+rw2*0.44, bw2=rw2*0.36, bh2=Math.max(5,rh*0.18);
    ctx.fillStyle='#12283c';ctx.fillRect(bx2,ry+2,bw2,bh2);
    ctx.fillStyle=esel?'#7fd0ff':'#39ff14';
    ctx.fillRect(bx2,ry+2,bw2*frac,bh2);

    ctx.textAlign='right';
    ctx.font=Math.max(6,Math.round(rh*0.20))+"px 'Press Start 2P',monospace";
    ctx.fillStyle='#cde';
    ctx.fillText(String(m2[pr.id]),rx+rw2,ry+2);
    /* (2) Live swatch on every colour row, so the value being adjusted is
       shown as the colour it produces rather than as a bare number. */
    if(pr.swatch){
      var sw=Math.max(9,rh*0.30);
      var col=(pr.swatch==='accent')?accentColour():bodyColour();
      ctx.fillStyle=col;
      ctx.fillRect(rx+rw2-sw-46,ry+1,sw,sw);
      ctx.strokeStyle=esel?'#ffffff':'rgba(160,190,210,0.7)';
      ctx.lineWidth=1;
      ctx.strokeRect(rx+rw2-sw-46,ry+1,sw,sw);
    }
    ctx.textAlign='left';
    ctx.fillStyle=esel?'#ffd23a':'#5f7f90';
    ctx.font=Math.max(6,Math.round(rh*0.18))+"px 'Press Start 2P',monospace";
    ctx.fillText('NEXT '+stepCost(pr.id).toLocaleString()+' CR',bx2,ry+2+bh2+3);
  }

  /* (2) Star burst beside the car marking the part just changed. */
  if(Shop.starT>0){
    Shop.starT-=dt*1.4;
    var sp2=paramById(Shop.starParam);
    if(sp2){
      /* Rough anchor per parameter, so the eye is drawn to the right area. */
      var anchor={width:[0.78,0.62],height:[0.5,0.18],curve:[0.5,0.40],
        fins:[0.24,0.60],sweep:[0.24,0.48],vents:[0.76,0.46],
        thrusters:[0.5,0.82],intakeSz:[0.5,0.55],skirtDrop:[0.5,0.74],
        canopySz:[0.5,0.44],noseLen:[0.5,0.14]}[Shop.starParam]||[0.5,0.5];
      var ax=mx+6+(cw-12)*anchor[0], ay=my+6+(ch-12)*anchor[1];
      var kk=Math.max(0,Shop.starT);
      ctx.save();ctx.translate(ax,ay);ctx.globalAlpha=kk;
      for(var sI=0;sI<5;sI++){
        var sa=Shop.t*2.2+sI*(Math.PI*2/5);
        var sr=6+(1-kk)*22;
        ctx.fillStyle='#ffd23a';
        ctx.beginPath();
        ctx.arc(Math.cos(sa)*sr,Math.sin(sa)*sr,2.2+kk*2,0,Math.PI*2);
        ctx.fill();
      }
      ctx.globalAlpha=1;ctx.restore();
    }
  }

  /* (2) Confirmation modal. */
  if(Shop.confirm){
    ctx.fillStyle='rgba(0,0,4,0.86)';ctx.fillRect(0,0,vw,vh);
    var bw2=Math.min(760,vw*0.78), bh2=Math.min(400,vh*0.56);
    var bx2=(vw-bw2)/2, by2=(vh-bh2)/2;
    ctx.fillStyle='rgba(4,16,26,0.98)';ctx.fillRect(bx2,by2,bw2,bh2);
    ctx.strokeStyle='#7fd0ff';ctx.lineWidth=3;ctx.strokeRect(bx2,by2,bw2,bh2);
    ctx.textAlign='center';ctx.textBaseline='middle';
    /* (1) Branding on the modal, with the same animated fire treatment used
       elsewhere, so the dialogue belongs to the game rather than looking like
       a system prompt. */
    var mbf=Math.max(13,Math.round(vh*0.030));
    var mfk=0.5+0.5*Math.sin(Shop.t*2.6);
    var mg=ctx.createLinearGradient(0,by2+bh2*0.10,0,by2+bh2*0.24);
    mg.addColorStop(0,'#8a1a00');
    mg.addColorStop(Math.max(0.05,Math.min(0.95,0.35+mfk*0.30)),'#ff6a00');
    mg.addColorStop(Math.max(0.10,Math.min(0.99,0.62+mfk*0.26)),'#fff2c0');
    mg.addColorStop(1,'#8a1a00');
    ctx.font=mbf+"px 'Germania One','Press Start 2P',serif";
    ctx.fillStyle=mg;
    ctx.fillText('ZONE STORM',vw/2,by2+bh2*0.13);
    ctx.fillStyle='#39ff14';
    ctx.fillText('RACING GX',vw/2,by2+bh2*0.13+mbf*1.15);
    ctx.strokeStyle='rgba(120,240,150,0.35)';ctx.lineWidth=1;
    ctx.beginPath();
    ctx.moveTo(bx2+bw2*0.18,by2+bh2*0.30);ctx.lineTo(bx2+bw2*0.82,by2+bh2*0.30);
    ctx.stroke();
    ctx.font=Math.max(19,Math.round(vh*0.048))+"px 'Germania One',serif";
    ctx.fillStyle='#ffd23a';
    ctx.fillText('CONFIRM UPGRADE',vw/2,by2+bh2*0.42);
    ctx.font=Math.max(12,Math.round(vh*0.028))+"px 'Press Start 2P',monospace";
    ctx.fillStyle='#dff3ff';
    ctx.fillText(Shop.pendingCost.toLocaleString()+' CR',vw/2,by2+bh2*0.58);
    ctx.font=Math.max(10,Math.round(vh*0.022))+"px 'Press Start 2P',monospace";
    ctx.fillStyle=(credits()>=Shop.pendingCost)?'#9fd8b0':'#ff8a7a';
    ctx.fillText('BALANCE '+credits().toLocaleString()+' CR',vw/2,by2+bh2*0.71);
    ctx.font=Math.max(10,Math.round(vh*0.022))+"px 'Press Start 2P',monospace";
    ctx.fillStyle='#4a6a80';
    ctx.fillText('A CONFIRM        B CANCEL',vw/2,by2+bh2*0.88);
  }

  ctx.textAlign='center';ctx.textBaseline='top';
  ctx.font="9px 'Press Start 2P',monospace";
  ctx.fillStyle='#4a6a80';
  /* (5) Control hint removed: the pending banner already says what to press
     when it matters, and the line crowded the editor. */
  ctx.restore();
}

function wrapText(ctx,text,cx,y,maxW,lh){
  var words=String(text).split(' '), line='', n=0;
  for(var i=0;i<words.length;i++){
    var test=line?(line+' '+words[i]):words[i];
    if(ctx.measureText(test).width>maxW&&line){
      ctx.fillText(line,cx,y+n*lh);line=words[i];n++;
      if(n>2)return;
    } else line=test;
  }
  if(line)ctx.fillText(line,cx,y+n*lh);
}

/* Perk effects the racing engine can query. */
function activeEffects(){
  var s=load(), out={shield:0,grip:0,fx:[]};
  for(var i=0;i<PERKS.length;i++){
    if(!s.owned[PERKS[i].id])continue;
    out.fx.push(PERKS[i].fx);
    if(PERKS[i].shield)out.shield+=PERKS[i].shield;
    if(PERKS[i].grip)out.grip+=PERKS[i].grip;
  }
  return out;
}

global.UpgradeShop={
  state:Shop, open:openShop, close:closeShop, draw:draw, input:input,
  credits:credits, awardCredits:awardCredits, addCredits:addCredits, spendCredits:spendCredits,
  inventory:inventory,
  SPECIALS:SPECIALS, specialInStock:specialInStock, specialCount:specialCount,
  buySpecial:buySpecial, consumeSpecial:consumeSpecial,
  machine:machine, machineDesign:machineDesign, upgrade:upgrade,
  resetMachine:resetMachine, previewMachine:previewMachine,
  stage:stage, commitPending:commitPending, cancelPending:cancelPending,
  stepCost:stepCost, stepsFor:stepsFor, performance:performance,
  cpuScale:cpuScale, EDIT_PARAMS:EDIT_PARAMS, axisRatings:axisRatings,
  paramById:paramById, bodyColour:bodyColour, accentColour:accentColour, buy:buy, owns:owns,
  PERKS:PERKS, activeEffects:activeEffects,
  reset:function(){_s=null;try{localStorage.removeItem(KEY);}catch(e){}}
};

})(typeof window!=='undefined'?window:globalThis);


/* 
   SCREEN FLOW AND RACE LAUNCH   (was worldflow.js)
   ---------------------------------------------------------------------------
   Drives the tour state machine and hands races to the engine. Reads both
   WorldRewards and UpgradeShop, so it loads last.
    */
/* 
   WORLD TOUR — race flow (stage 3)
   ---------------------------------------------------------------------------
   Connects the map to the racing engine:

     select settlement -> preview tile -> race -> victory -> green dot

   Nothing here is a new system; it is the wiring between worldtour.js (model),
   worldmap.js (map) and drive.js (engine). The map holds its own breadcrumb,
   so returning after a race lands on exactly the municipality the player left
   — which is what point 10 of the brief requires.
    */

(function(global){
'use strict';

var W=global.WorldTour, M=global.WorldMap;
if(!W||!M)return;

var Flow={
  mode:'map',        // map | preview | racing | victory
  settlement:null,
  result:null,
  t:0,
  dotAnim:0          // 0..1 green-dot reveal on return
};

/* ── PREVIEW TILE 
   The same shape as a Super Racing tile: minimap, name, and the facts that
   matter before committing. Drawn on the canvas rather than as DOM so it can
   sit over the map without a layout pass. */
/* Renders the reverse face of the preview tile (item 16): best total, best
   lap, and the last few attempts, read from IndexedDB.

   Everything here comes from timesCached, which is synchronous and returns
   null until the record arrives. Drawing "LOADING" for a frame is correct
   behaviour; blocking the map's animation loop on a database read is not. */
function drawPreviewTimes(ctx,x,y,w,h,st){
  var rec=null;
  try{ rec=global.WorldRewards&&global.WorldRewards.timesCached(st.id); }catch(e){}
  var fmt=function(ms){
    if(ms==null)return '\u2014';
    var m=Math.floor(ms/60000), s2=((ms%60000)/1000).toFixed(2);
    return m+':'+(s2.length<5?'0':'')+s2;
  };
  ctx.save();
  ctx.font='11px monospace'; ctx.textAlign='left'; ctx.textBaseline='top';
  ctx.fillStyle='#7fd';
  ctx.fillText('TRACK TIMES',x,y);
  ctx.font='10px monospace';
  /* An unplayed track still gets the full layout, with dashes where the
     numbers would be. Showing the shape of the record the player is about to
     create is more useful than a bare "no data", and it makes the flip
     obviously a flip rather than a no-op. */
  if(!rec)rec={best:null,bestLap:null,runs:0,recent:[]};
  ctx.fillStyle='#68a'; ctx.fillText('BEST',x,y+22);
  ctx.fillStyle='#ffd24d'; ctx.fillText(fmt(rec.best),x+70,y+22);
  ctx.fillStyle='#68a'; ctx.fillText('BEST LAP',x,y+38);
  ctx.fillStyle='#ffd24d'; ctx.fillText(fmt(rec.bestLap),x+70,y+38);
  ctx.fillStyle='#68a'; ctx.fillText('RUNS',x,y+54);
  ctx.fillStyle='#cde'; ctx.fillText(String(rec.runs||0),x+70,y+54);
  ctx.fillStyle='#68a'; ctx.fillText('RECENT',x,y+76);
  var rc=rec.recent||[];
  if(!rc.length){
    ctx.fillStyle='#456';
    ctx.fillText('\u2014  never raced',x,y+92);
  }
  for(var i=0;i<rc.length&&i<5;i++){
    var r=rc[i];
    ctx.fillStyle=(r.place===1)?'#ffd24d':(r.place<=3?'#cde':'#7a8b99');
    ctx.fillText((r.place?('P'+r.place):'  ')+'  '+fmt(r.t),x,y+92+i*14);
  }
  ctx.fillStyle='#456';
  ctx.fillText('Y \u21ba back',x,y+h-14);
  ctx.restore();
}

function drawPreview(ctx,vw,vh,dt){
  var st=Flow.settlement; if(!st)return;
  Flow.t+=dt;

  ctx.save();
  ctx.fillStyle='rgba(0,0,6,0.82)';ctx.fillRect(0,0,vw,vh);

  var w=Math.min(460,vw*0.72), h=Math.min(420,vh*0.78);
  var x=(vw-w)/2, y=(vh-h)/2;
  var pulse=0.5+0.5*Math.sin(Flow.t*3);

  /* ═══ THE FLIP IS ANIMATED (item 37) 
     The face swapped instantly, which does not read as a card turning over —
     it reads as the panel's contents being replaced, and a player who is not
     watching closely cannot tell the button did anything.

     Flow.flipT eases toward the target face and drives a horizontal scale
     about the panel's centre. At the halfway point the panel is edge-on and
     zero pixels wide, which is exactly when the face is swapped, so neither
     side is ever seen mirrored. That is the whole trick: a 2D scale on one
     axis is indistinguishable from a 3D rotation as long as the swap happens
     at the crossing.

     A little easing at the ends and a linear middle, so the card accelerates
     away and decelerates into its new face rather than moving at a constant
     rate, which looks mechanical. */
  Flow.flipTarget=Flow.previewFlipped?1:0;
  if(Flow.flipT===undefined)Flow.flipT=Flow.flipTarget;
  Flow.flipT+=(Flow.flipTarget-Flow.flipT)*Math.min(1,dt*9);
  var _fp=Flow.flipT;
  /* cos gives 1 at both faces and 0 edge-on, which is the projected width of a
     card rotating about its vertical axis. */
  var _sx=Math.abs(Math.cos(_fp*Math.PI));
  /* Below this the panel is a hairline; drawing its contents is wasted and the
     text would be illegibly squashed. */
  var _edgeOn=(_sx<0.06);
  /* The face shown follows the ANIMATION, not the target, so the swap lands at
     the crossing rather than on the button press. */
  var _showBack=(_fp>0.5);

  ctx.save();
  if(_sx<0.999){
    ctx.translate(x+w/2,0);
    ctx.scale(Math.max(0.001,_sx),1);
    ctx.translate(-(x+w/2),0);
  }

  ctx.fillStyle='rgba(4,16,26,0.96)';
  ctx.fillRect(x,y,w,h);
  ctx.strokeStyle='rgba(120,210,255,'+(0.55+pulse*0.35).toFixed(2)+')';
  ctx.lineWidth=2;ctx.strokeRect(x,y,w,h);

  ctx.textAlign='center';ctx.textBaseline='top';
  ctx.font="13px 'Press Start 2P',monospace";
  ctx.fillStyle='#bfe8ff';
  ctx.fillText(W.displayName(st),x+w/2,y+18);

  /* (item 16) Reverse face. The panel frame and the track name stay — flipping
     to a card with no title would leave the player unsure which track they are
     looking at — and everything below is replaced by the times. */
  /* TWO saves are open on these paths — the function's own at the top and the
     flip transform above — so both early exits must unwind both. Restoring
     once would leave the flip's horizontal scale on the context and every
     later draw in the frame would be squashed. */
  if(_edgeOn){ ctx.restore(); ctx.restore(); return; }   // hairline
  if(_showBack){
    drawPreviewTimes(ctx,x+22,y+56,w-44,h-70,st);
    ctx.restore(); ctx.restore();
    return;
  }

  ctx.font="9px 'Press Start 2P',monospace";
  ctx.fillStyle='#8fa8b8';
  ctx.fillText(st.typeLabel.toUpperCase(),x+w/2,y+44);
  ctx.fillStyle='#ffd23a';
  ctx.fillText('POPULATION  '+st.population.toLocaleString(),x+w/2,y+62);

  /* Minimap: the actual course shape, drawn from the engine's own track data
     so the preview cannot disagree with what the player is about to drive. */
  var mm=minimapFor(st.trackSeed);
  var ms=Math.min(w,h)*0.46, mx=x+w/2, my=y+h*0.46;
  if(mm&&mm.length>2){
    ctx.strokeStyle='#39ff14';ctx.lineWidth=2;
    ctx.beginPath();
    for(var i=0;i<mm.length;i++){
      var px=mx+(mm[i][0]-0.5)*ms, py=my+(mm[i][1]-0.5)*ms;
      if(i===0)ctx.moveTo(px,py); else ctx.lineTo(px,py);
    }
    ctx.closePath();ctx.stroke();
    /* Start marker, so the layout reads as a circuit rather than a squiggle. */
    ctx.fillStyle='#ffd23a';
    ctx.beginPath();ctx.arc(mx+(mm[0][0]-0.5)*ms,my+(mm[0][1]-0.5)*ms,4,0,Math.PI*2);ctx.fill();
  }

  ctx.font="9px 'Press Start 2P',monospace";
  ctx.fillStyle='#8fd6ff';
  ctx.fillText(st.race.laps+' LAPS      '+st.race.turbo+' TURBO BOOST'+(st.race.turbo>1?'S':''),
    x+w/2,y+h-72);

  var best=(W.stats()&&null);
  ctx.fillStyle=W.isCompleted(st.id)?'#39ff14':'#6f8fa0';
  ctx.fillText(W.isCompleted(st.id)?'\u2713 WON':(W.isUnlocked(st.id)?'READY':'LOCKED'),
    x+w/2,y+h-52);

  ctx.fillStyle='#4a6a80';
  ctx.fillText(W.isUnlocked(st.id)?'A  START RACE      B  BACK':'B  BACK',x+w/2,y+h-28);
  ctx.restore();   // flip transform
  ctx.restore();   // function's own save
}

/* Minimap points come from the engine, which already computes them for the
   Super Racing tiles. Cached per seed — building a track is not free. */
var _mmCache={};
function minimapFor(seed){
  if(_mmCache[seed]!==undefined)return _mmCache[seed];
  var pts=null;
  try{
    /* (1) Pass the settlement's own race config so the preview is generated
       with the same lap/length multipliers the race will use. */
    if(global.DriveMode&&global.DriveMode.minimap){
      var _st=Flow.settlement;
      pts=global.DriveMode.minimap(seed,
        _st?{worldTour:{laps:_st.race.laps,turbo:_st.race.turbo,
                        lenMul:_st.race.lenMul}}:undefined);
    }
  }catch(e){pts=null;}
  _mmCache[seed]=pts;
  return pts;
}

/* ── RACE LAUNCH 
   worldmap.js calls this when a settlement is confirmed. */
global.WorldTourRace=function(st){
  Flow.settlement=st;
  Flow.mode='preview';
  Flow.t=0;
};

/* (9) LAUNCH TRANSITION.
   Rather than cutting straight to the race, the preview tile sheds its border
   and text and the course outline alone zooms to 425% over 2.3 s, then the
   screen fades over 1.2 s before the race loads. The effect is that the player
   sees the shape of the track they are about to drive, large.
   Timings come from the spec and are held in one place so the sequence stays
   in step if any of them change. */
var ZOOM_MS=2300, FADE_MS=1200;
function startSettlementRace(){
  var st=Flow.settlement;
  if(!st||!W.isUnlocked(st.id))return;
  Flow.mode='zooming';
  Flow.zoomT=0;
  Flow.zoomFrom=null;
}
/* Draws the zoom-and-fade, then hands off to the race. */
function drawZoomIn(ctx,vw,vh,dt){
  Flow.zoomT+=dt*1000;
  var st=Flow.settlement; if(!st){beginSettlementRace();return;}

  ctx.save();
  /* (3) FULLY TRANSPARENT during the launch transition, so the only things on
     screen are the water.js background and the green course outline. Painting
     even a dark wash here would hide the fluid the transition is meant to
     show off. */
  ctx.clearRect(0,0,vw,vh);
  /* The stick drives the fluid while the transition plays. */
  try{
    if(global.WaterFX&&global.WaterFX.available()){
      global.WaterFX.setMode('worldmap');
      global.WaterFX.worldMap(dt);
    }
  }catch(e){}

  var mm=minimapFor(st.trackSeed);
  if(mm&&mm.length>2){
    /* Ease-out so the zoom decelerates into the fade rather than stopping
       abruptly at full size. */
    var k=Math.min(1,Flow.zoomT/ZOOM_MS);
    var e=1-Math.pow(1-k,3);
    var scale=1+(3.15-1)*e;                 // (10) 100% -> 315% (15% less than 370%)
    var base=Math.min(vw,vh)*0.46;
    var ms=base*scale;
    var cx=vw/2, cy=vh/2;

    ctx.strokeStyle='#39ff14';
    ctx.lineWidth=2+e*4;
    ctx.shadowColor='#39ff14';ctx.shadowBlur=8+e*22;
    ctx.beginPath();
    for(var i=0;i<mm.length;i++){
      var px=cx+(mm[i][0]-0.5)*ms, py=cy+(mm[i][1]-0.5)*ms;
      if(i===0)ctx.moveTo(px,py); else ctx.lineTo(px,py);
    }
    ctx.closePath();ctx.stroke();
    ctx.shadowBlur=0;

    /* Start marker, scaling with the outline. */
    ctx.fillStyle='#ffd23a';
    ctx.beginPath();
    ctx.arc(cx+(mm[0][0]-0.5)*ms,cy+(mm[0][1]-0.5)*ms,4+e*8,0,Math.PI*2);
    ctx.fill();
  }

  /* Fade begins only once the zoom has completed. */
  if(Flow.zoomT>ZOOM_MS){
    var f=Math.min(1,(Flow.zoomT-ZOOM_MS)/FADE_MS);
    ctx.fillStyle='rgba(0,0,4,'+f.toFixed(3)+')';
    ctx.fillRect(0,0,vw,vh);
    if(f>=1){ ctx.restore(); beginSettlementRace(); return; }
  }
  ctx.restore();
}
function beginSettlementRace(){
  var st=Flow.settlement;
  if(!st){Flow.mode='map';return;}
  Flow.mode='racing';
  var car=(global.GX_selectedCar&&global.GX_selectedCar())||null;
  try{
    /* TOUR PROGRESSION: the municipality's tradition (or the town's legend)
       travels with the race; a Turbo Canister from Tour Stock adds a charge. */
    var TP=global.TourProgress, tour=TP?TP.raceOpts(st):null, extraTurbo=TP?TP.turboBonus():0;
    global.DriveMode.start(st.trackSeed,{
      worldTour:{laps:st.race.laps,turbo:st.race.turbo+extraTurbo,lenMul:st.race.lenMul},
      settlement:{id:st.id,name:W.displayName(st),type:st.typeLabel,pop:st.population},
      car:car,
      tour:tour
    });
  }catch(e){console.warn('World Tour race failed',e);}
  watchResult(st);
}

/* Poll for the race ending rather than relying on a callback: the engine has
   several exit paths (finish, game over, quit) and polling covers all of them
   without drive.js needing to remember to fire an event on each. */
var _poll=null;
/* ═══ THE POLLER OUTLIVED THE RACE 
   watchResult starts a 'has the race ended' interval and only clears it once
   it SEES an ending. Leaving via the pause menu never produces that ending —
   the engine tears down and DriveDebug._state() goes null, which this poller
   treats as "not over yet" and keeps waiting for.

   So after "Return to Title Screen" the interval was still alive. The next
   time any race state appeared it fired, set Flow.mode='victory' and pulled
   the player back into the World Tour map — which is exactly the reported
   "goes to the world map instead of the title screen". The title teardown was
   working; something else was dragging the player off it afterwards.

   Cancelled explicitly whenever the tour is left. */
function stopWatchResult(){
  if(_poll){clearInterval(_poll);_poll=null;}
  Flow._recorded=false;
}
global.ZS_stopTourWatch=stopWatchResult;
function watchResult(st){
  if(_poll)clearInterval(_poll);
  _poll=setInterval(function(){
    var s=null;
    try{s=global.DriveDebug&&global.DriveDebug._state?global.DriveDebug._state():null;}catch(e){}
    if(!s||!s.over)return;

    var t={total:0,best:0};
    try{t=global.DriveMode.lapTimes();}catch(e){}
    var won=(s.place===1)||(s.podium&&s.podium.place===1);

    /* The engine's own result screen — the full standings with every rival —
       stays on screen first. Leaving the race running rather than exiting
       immediately is what makes that possible; a World Tour finish should look
       like any other race finish, not a stripped-down summary.
       The unlock is applied straight away so the map marker is already green
       by the time the player returns to it. */
    if(!Flow._recorded){
      Flow._recorded=true;
      Flow.result={won:won,total:t.total,best:t.best,newly:[]};
      /* ═══ PODIUM REWARD AND TIME RECORD (items 15, 16) 
         The finishing place decides both. A podium line is composed for 1st,
         2nd and 3rd — see podiumReward in the rewards module for why these are
         generated rather than drawn from a fixed pool — and anything outside
         the top three gets none, so the reward stays a reward.

         Times go to IndexedDB regardless of placement: a slow run is still the
         run that might be beaten next time, and the flipped preview tile shows
         recent attempts as well as the best. The write is fire-and-forget and
         resolves to null when IndexedDB is unavailable, so it can never hold
         up or fail the race summary. */
      try{
        /* The finishing place lives on the engine state `s`, not on the
           settlement `st` — st is the place on the map, not the result. */
        var _place=(s.place!=null)?s.place
                   :((s.podium&&s.podium.place!=null)?s.podium.place:(won?1:0));
        if(global.WorldRewards){
          if(_place>=1&&_place<=3)
            Flow.result.podium=global.WorldRewards.podiumReward(st,_place);
          global.WorldRewards.timesPut(st.id,{
            total:t.total, bestLap:t.best, place:_place
          });
        }
      }catch(e){}
      /* (6) A loss still pays out. With four million races a wasted attempt
         that yields nothing makes failure feel punitive; a small consolation
         keeps the economy moving without rewarding losing. */
      if(!won){
        try{
          var solace=100+Math.floor(Math.random()*401);   // 100..500
          if(global.UpgradeShop)global.UpgradeShop.addCredits(solace);
          Flow.result.consolation=solace;
        }catch(e){}
      }
      if(won){
        Flow.result.newly=W.completeRace(st.id,t.total);
        try{
          if(global.WorldRewards)Flow.result.rewards=global.WorldRewards.award(st);
          if(global.UpgradeShop)Flow.result.credits=global.UpgradeShop.awardCredits(st);
        }catch(e){}
        try{ if(global.TourProgress)Flow.result.tour=global.TourProgress.onWin(st,+Flow.result.credits||0); }catch(e){}
      } else {
        try{ if(global.TourProgress)Flow.result.tour=global.TourProgress.onLoss(); }catch(e){}
      }
      Flow._fx=[]; Flow._fxDone={};
    }
    /* Wait for the player to dismiss the standings. The engine clears `over`
       when it exits, which is the signal to show the World Tour summary. */
    if(global.DriveMode.isActive&&global.DriveMode.isActive())return;
    clearInterval(_poll);_poll=null;
    Flow.mode='victory';Flow.t=0;Flow.dotAnim=0;Flow._recorded=false;
    /* The engine's finish screen already offered A/X/B; honour the choice. */
    var after=null; try{ after=global.ZS_tourAfter||null; global.ZS_tourAfter=null; }catch(e){}
    if(after==='replay'){ Flow.t=1; victoryReplay(); }
    else if(after==='title'){
      Flow.t=1; victoryToTitle();
      try{ if(global.closeWorldMap)global.closeWorldMap(); }catch(e){}
    }
  },350);
}

/* ── VICTORY SEQUENCE 
   Short by design: the reward is the unlock and the green dot, not a long
   cutscene the player will see hundreds of times. */
/* ═══ TOUR CELEBRATION (plan part 2) — positive feedback you can feel.
   A tiny particle system (coins, confetti, sparks) plus timed reveals:
   the credit total rolls up and bursts into coins, a passport stamp slams
   down with a shockwave and a screen jolt, a legend lights golden rays,
   milestones slide in, rumours type themselves out. Each event fires once,
   so replays of the same screen are calm. */
function _fxBurst(x,y,n,cols,kind){
  var F=Flow._fx||(Flow._fx=[]);
  for(var i=0;i<n&&F.length<420;i++){
    var a=Math.random()*Math.PI*2, sp=90+Math.random()*260;
    F.push({x:x,y:y,vx:Math.cos(a)*sp,vy:Math.sin(a)*sp-120,life:1,decay:0.5+Math.random()*0.6,
      col:cols[i%cols.length],size:2+Math.random()*4,rot:Math.random()*6,vr:(Math.random()-0.5)*12,kind:kind});
  }
}
function _fxDraw(ctx,dt){
  var F=Flow._fx; if(!F||!F.length)return;
  for(var i=F.length-1;i>=0;i--){
    var p=F[i]; p.life-=dt*p.decay; if(p.life<=0){F.splice(i,1);continue;}
    p.vy+=520*dt; p.x+=p.vx*dt; p.y+=p.vy*dt; p.rot+=p.vr*dt;
    ctx.globalAlpha=Math.min(1,p.life*1.4); ctx.fillStyle=p.col;
    if(p.kind==='coin'){ ctx.beginPath(); ctx.ellipse(p.x,p.y,p.size*1.3*Math.abs(Math.cos(p.rot)),p.size*1.3,0,0,Math.PI*2); ctx.fill(); }
    else if(p.kind==='confetti'){ ctx.save(); ctx.translate(p.x,p.y); ctx.rotate(p.rot); ctx.fillRect(-p.size,-p.size*0.4,p.size*2,p.size*0.8); ctx.restore(); }
    else { ctx.fillRect(p.x-1,p.y-1,2+p.size*0.4,2+p.size*0.4); }
  }
  ctx.globalAlpha=1;
}
function _once(key){ var D=Flow._fxDone||(Flow._fxDone={}); if(D[key])return false; D[key]=1; return true; }
function _easeOutBack(k){ var c=1.9; return 1+(c+1)*Math.pow(k-1,3)+c*Math.pow(k-1,2); }
function drawTourCelebration(ctx,vw,vh,dt,listY){
  var r=Flow.result||{}, ev=r.tour||[], T=Flow.t;
  var legend=null; for(var q=0;q<ev.length;q++)if(ev[q].kind==='legend')legend=ev[q];
  /* golden rays behind everything for a legend */
  if(legend&&T>0.2){
    ctx.save(); ctx.translate(vw/2,vh*0.40); ctx.rotate(T*0.25);
    var ra=Math.min(1,(T-0.2)/0.8)*0.22;
    for(var i=0;i<16;i++){ ctx.rotate(Math.PI/8); ctx.fillStyle='rgba(255,210,58,'+ra.toFixed(3)+')';
      ctx.beginPath(); ctx.moveTo(0,0); ctx.lineTo(vw,-vw*0.08); ctx.lineTo(vw,vw*0.08); ctx.closePath(); ctx.fill(); }
    ctx.restore();
  }
  /* credit roll-up, left */
  var totalCr=(ev.total!=null?ev.total:(+r.credits||0))+(+r.consolation||0);
  if(r.won&&totalCr>0&&T>1.0){
    var k=Math.min(1,(T-1.0)/1.6), e=1-Math.pow(1-k,3), shown=Math.round(totalCr*e);
    var lx=vw*0.16, ly=vh*0.42;
    ctx.save(); ctx.textAlign='center'; ctx.textBaseline='middle';
    ctx.font="12px 'Press Start 2P',monospace"; ctx.fillStyle='#8fa8b8'; ctx.fillText('CREDITS',lx,ly-26);
    var pop=k>=1?1+0.12*Math.max(0,1-(T-2.6)*3):1;
    ctx.font=Math.round(29*pop)+"px 'Germania One','Press Start 2P',serif"; ctx.fillStyle='#ffd23a';
    ctx.shadowColor='#ffb000'; ctx.shadowBlur=10+8*(pop-1)*8;
    ctx.fillText('+'+shown.toLocaleString(),lx,ly); ctx.shadowBlur=0;
    if(k>=1&&_once('coins'))_fxBurst(lx,ly,46,['#ffd23a','#ffe98a','#e0a800'],'coin');
    ctx.restore();
  }
  /* streak flames under the title */
  var st=null; for(var q2=0;q2<ev.length;q2++)if(ev[q2].kind==='streak')st=ev[q2];
  if(st&&T>0.9){
    var n=Math.min(10,st.streak), fy=vh*0.40-44, fx0=vw/2-(n-1)*9;
    for(var f=0;f<n;f++){ var fl=0.7+0.3*Math.sin(T*14+f*1.7), fx=fx0+f*18;
      ctx.fillStyle='rgba(255,'+(90+f*14)+',30,0.9)'; ctx.beginPath(); ctx.moveTo(fx-5,fy); ctx.quadraticCurveTo(fx,fy-16*fl,fx+5,fy); ctx.closePath(); ctx.fill(); }
  }
  /* event lines, center column */
  var y=listY, t0=2.4, textEv=0, stampEv=null;
  ctx.save(); ctx.textAlign='center'; ctx.textBaseline='middle';
  for(var i2=0;i2<ev.length;i2++){
    var E=ev[i2], at=t0+textEv*0.9; if(E.kind==='stamp'){ stampEv={E:E,at:at}; }
    if(T<at){ textEv++; continue; }
    var a=Math.min(1,(T-at)/0.35), slide=(1-a)*40, txt='', col='#9fd8b0';
    if(E.kind==='streak'){ txt='WIN STREAK '+E.streak+'  \u00b7  x'+E.mult.toFixed(1)+'  +'+E.bonus.toLocaleString()+' CR'; col='#ff9a3a'; }
    else if(E.kind==='featured'){ txt='\u2605 FEATURED TOWN  \u00b7  DOUBLE CREDITS  \u00b7  +1 MYSTERY CRATE'; col='#ffd23a';
      if(_once('feat'+i2))_fxBurst(vw/2,y,24,['#ffd23a','#fff3b0'],'spark'); }
    else if(E.kind==='magnet'){ txt='CREDIT MAGNET x1.5  +'+E.bonus.toLocaleString()+' CR  ('+E.left+' LEFT)'; col='#7fd0ff'; }
    else if(E.kind==='stamp'){ txt='PASSPORT STAMP  \u00b7  '+E.sig.name+'  ('+E.n+'/'+E.of+')'; col=E.sig.col; }
    else if(E.kind==='milestone'){ txt='MILESTONE '+E.at+' STAMPS  \u00b7  +'+E.bonus.toLocaleString()+' CR  \u00b7  '+E.text; col='#ffe98a';
      if(_once('ms'+i2))_fxBurst(vw/2,y,40,['#ffe98a','#ff9ad0','#7fd0ff','#39ff14'],'confetti'); }
    else if(E.kind==='legend'){ txt='LEGEND CONQUERED  \u00b7  +'+E.bonus.toLocaleString()+' CR  \u00b7  LEGENDS: '+E.count; col='#ffd23a';
      if(_once('lg'+i2)){ _fxBurst(vw/2,vh*0.40,90,['#ffd23a','#fff3b0','#ffb000'],'coin'); _fxBurst(vw/2,vh*0.40,60,['#ff9ad0','#7fd0ff','#39ff14'],'confetti'); } }
    else if(E.kind==='rumour'){ var nch=Math.floor(Math.min(1,(T-at)/1.4)*E.text.length); txt=E.text.slice(0,nch)+(nch<E.text.length&&((T*8)|0)%2?'_':''); col='#7fd0ff'; }
    else if(E.kind==='streakLost'){ txt='STREAK OF '+E.streak+' LOST'; col='#ff7a6a'; }
    ctx.globalAlpha=a; ctx.fillStyle=col; ctx.font="13px 'Germania One','Press Start 2P',serif";
    ctx.fillText(txt,vw/2+slide,y); y+=29; textEv++;
  }
  ctx.restore();
  /* passport stamp slam, right */
  if(stampEv&&T>stampEv.at){
    var g=stampEv.E.sig, kk=Math.min(1,(T-stampEv.at)/0.45), sc=kk<1?(1+(1-_easeOutBack(kk))*-1.6+ (1-kk)*1.8):1;
    var sx=vw*0.84, sy=vh*0.42, R=Math.min(vw,vh)*0.10;
    if(kk>=1&&_once('slam')){ Flow._shake=0.35; _fxBurst(sx,sy,50,[g.col,'#ffffff'],'confetti'); }
    ctx.save(); ctx.translate(sx,sy); ctx.rotate(-0.22); ctx.scale(Math.max(0.2,sc),Math.max(0.2,sc));
    ctx.globalAlpha=Math.min(1,kk*1.4);
    ctx.strokeStyle=g.col; ctx.lineWidth=4; ctx.beginPath(); ctx.arc(0,0,R,0,Math.PI*2); ctx.stroke();
    ctx.lineWidth=1.5; ctx.beginPath(); ctx.arc(0,0,R*0.84,0,Math.PI*2); ctx.stroke();
    ctx.fillStyle=g.col; ctx.textAlign='center'; ctx.textBaseline='middle';
    var words=g.name.split(' ');
    ctx.font=Math.round(R*0.22)+"px 'Germania One',serif";
    for(var w=0;w<words.length;w++)ctx.fillText(words[w],0,(w-(words.length-1)/2)*R*0.26);
    ctx.font=Math.round(R*0.11)+"px 'Press Start 2P',monospace";
    ctx.fillText(stampEv.E.n+' / '+stampEv.E.of,0,R*0.62);
    ctx.restore();
    if(kk>=1&&T-stampEv.at<1.2){ var sw=(T-stampEv.at-0.45)/0.75;
      ctx.strokeStyle=g.col; ctx.globalAlpha=Math.max(0,1-sw); ctx.lineWidth=3;
      ctx.beginPath(); ctx.arc(sx,sy,R*(1+sw*1.6),0,Math.PI*2); ctx.stroke(); ctx.globalAlpha=1; }
  }
  _fxDraw(ctx,dt);
}
/* ── VICTORY SEQUENCE
   Short by design: the reward is the unlock and the green dot, not a long
   cutscene the player will see hundreds of times. */
function drawVictory(ctx,vw,vh,dt){
  Flow.t+=dt;
  var r=Flow.result||{};
  var st=Flow.settlement;
  var k=Math.min(1,Flow.t/0.6);

  ctx.save();
  /* stamp slam jolt */
  if(Flow._shake>0){ Flow._shake=Math.max(0,Flow._shake-dt); var sa=Flow._shake*18;
    ctx.translate((Math.random()-0.5)*sa,(Math.random()-0.5)*sa); }
  ctx.fillStyle='rgba(0,0,6,'+(0.55*k).toFixed(2)+')';
  ctx.fillRect(0,0,vw,vh);
  ctx.textAlign='center';ctx.textBaseline='middle';

  var cy=vh*0.40;
  ctx.font="26px 'Germania One','Press Start 2P',serif";
  ctx.fillStyle=r.won?'#39ff14':'#ff7a6a';
  ctx.globalAlpha=k;
  ctx.fillText(r.won?'1ST PLACE':'RACE OVER',vw/2,cy);

  if(Flow.t>0.7&&st){
    ctx.font="14px 'Germania One','Press Start 2P',serif";
    ctx.fillStyle='#bfe8ff';
    ctx.globalAlpha=Math.min(1,(Flow.t-0.7)/0.5);
    ctx.fillText(W.displayName(st)+'  \u00b7  '+fmt(r.total),vw/2,cy+42);
  }
  if(Flow.t>1.3&&!r.won&&r.consolation){
    ctx.font="13px 'Germania One','Press Start 2P',serif";
    ctx.fillStyle='#9fd8b0';
    ctx.globalAlpha=Math.min(1,(Flow.t-1.3)/0.5);
    ctx.fillText('+'+r.consolation+' CR  \u00b7  BETTER LUCK NEXT TIME',vw/2,cy+72);
    ctx.globalAlpha=1;
  }
  if(Flow.t>1.3&&r.won&&r.newly&&r.newly.length){
    ctx.font="13px 'Germania One','Press Start 2P',serif";
    ctx.fillStyle='#ffd23a';
    ctx.globalAlpha=Math.min(1,(Flow.t-1.3)/0.5);
    ctx.fillText(r.newly.length+' NEW ROUTE'+(r.newly.length>1?'S':'')+' UNLOCKED',vw/2,cy+72);
  }
  /* Rewards fade in after the unlock line, one per row. */
  if(Flow.t>1.8&&r.rewards&&r.rewards.length){
    ctx.font="13px 'Germania One','Press Start 2P',serif";
    for(var i=0;i<r.rewards.length;i++){
      var rt=1.8+i*0.45;
      if(Flow.t<rt)break;
      var rw=r.rewards[i];
      ctx.globalAlpha=Math.min(1,(Flow.t-rt)/0.4);
      ctx.fillStyle=(rw.kind==='title'||rw.kind==='emblem')?'#ffd23a'
                   :(rw.kind==='find'?'#7fd0ff':'#9fd8b0');
      ctx.fillText(rw.text,vw/2,cy+104+i*29);
    }
    ctx.globalAlpha=1;
  }
  /* TOUR CELEBRATION below the classic reward rows. */
  try{ drawTourCelebration(ctx,vw,vh,dt,cy+104+((r.rewards&&r.rewards.length)||0)*29+22); }catch(e){}
  if(Flow.t>2.2){
    /* (item 28) Labels come from padGlyph, which reports the connected pad's
       own lettering — the game was naming PlayStation buttons on an Xbox pad.
       Asked for by ACTION, so a prompt cannot drift out of step with what the
       button actually does. */
    var G=function(a){
      try{ return (global.ZS_padGlyph?global.ZS_padGlyph(a):null)||
                  ({confirm:'A',cancel:'B',alt:'X'})[a]; }
      catch(e){ return ({confirm:'A',cancel:'B',alt:'X'})[a]; }
    };
    ctx.font="12px 'Press Start 2P',monospace";
    ctx.fillStyle='#4a6a80';
    ctx.globalAlpha=1;
    /* (item 29) Three actions, not one. */
    ctx.fillText(G('confirm')+'  NEXT RACE (MAP)     '+
                 G('alt')+'  RACE AGAIN     '+
                 G('cancel')+'  TITLE SCREEN', vw/2, vh-40);
  }
  ctx.restore();
}
function fmt(ms){
  if(!ms||!isFinite(ms))return '--:--.--';
  var m=Math.floor(ms/60000), s=((ms%60000)/1000).toFixed(2);
  return m+':'+(s.length<5?'0':'')+s;
}

/* Returning from victory drops straight back onto the municipality the player
   came from — the map never lost it — and plays the marker animation. */
/* ═══ RESULT SCREEN ACTIONS (item 29) 
   Confirm advances to the next unfinished settlement, cancel returns to the
   sub-map the player came from, alt replays the race just run. Previously the
   only option was confirm, which returned to the map — so continuing a run
   meant navigating back to where you already were, every single race.

   The guard on Flow.t is kept on all three: it stops a button still held from
   the race's own result screen carrying through into this one and dismissing
   it before the player has seen it. */
function victoryReturnToMap(){
  if(Flow.t<0.8)return;
  Flow.mode='map';
  Flow.dotAnim=0;
  /* ═══ UNLOCK REVEAL (request 3 item 4). Back on the map, a trail of small
     white dots runs from the settlement just won to every settlement the win
     opened, each lighting up with a burst as the trail arrives. The first
     new settlement is selected, so the player sees the progress and then
     chooses where to race next — a win can open more than one route. */
  var r=Flow.result;
  if(r&&r.won&&r.newly&&r.newly.length&&Flow.settlement){
    Flow.reveal={from:Flow.settlement.id,ids:r.newly.slice(),t:0};
    try{ if(M.selectId)M.selectId(r.newly[0]); }catch(e){}
  } else Flow.reveal=null;
  Flow.result=null;
  Flow.previewFlipped=false;
}
/* B on the result screen: back to the title screen. Returns false so the
   shell runs its own World Tour exit (closeWorldMap). */
function victoryToTitle(){
  if(Flow.t<0.8)return true;
  Flow.mode='map'; Flow.result=null; Flow.reveal=null; Flow.previewFlipped=false;
  return false;
}
/* Kept under its old name: other call sites and the shell may reference it. */
function victoryContinue(){ victoryReturnToMap(); }

function victoryReplay(){
  if(Flow.t<0.8)return;
  var st=Flow.settlement;
  if(!st){ victoryReturnToMap(); return; }
  Flow.result=null;
  Flow.previewFlipped=false;
  startSettlementRace();
}

function victoryNext(){
  if(Flow.t<0.8)return;
  /* ═══ "NEXT LOGICAL SETTLEMENT" 
     My first attempt searched outward by settlement id, on the assumption that
     ids form a flat ordered list. They do not — the world is hierarchical, and
     ids are opaque keys, so id+1 is not a neighbour of id in any sense the
     player would recognise.

     The right list is the one the map is ALREADY showing: the siblings of the
     settlement just raced, which is exactly what WorldMap.items() returns while
     the player is inside a municipality. Scanning that forward from the current
     entry hands over the next track in the same region, wrapping once so the
     end of a region continues at its start rather than dead-ending.

     Falling back to the map is deliberate for the two cases where there is no
     good answer — every sibling already finished, or the map is not on a
     municipality — because that is precisely when the player needs to choose
     rather than be sent somewhere. */
  var next=null;
  try{
    var M=global.WorldMap;
    var list=(M&&M.items)?M.items():null;
    var here=(Flow.settlement&&Flow.settlement.id);
    if(list&&list.length&&here!=null){
      var at=-1;
      for(var i=0;i<list.length;i++)if(list[i]&&list[i].id===here){at=i;break;}
      for(var d=1;d<=list.length&&!next;d++){
        var c=list[(at+d+list.length)%list.length];
        if(c&&c.id!==here&&!W.isCompleted(c.id))next=c;
      }
    }
  }catch(e){ next=null; }
  if(!next){ victoryReturnToMap(); return; }
  try{
    Flow.settlement=next;
    Flow.result=null;
    Flow.previewFlipped=false;
    startSettlementRace();
  }catch(e){ victoryReturnToMap(); }
}

/* ── FRAME ENTRY 
   One call from the shell covers every World Tour state. */
function sfx(k){ try{ if(global.SFX&&global.SFX[k])global.SFX[k](); }catch(e){} }
function frame(ctx,vw,vh,dt){
  Flow.t+=dt;
  if(Flow.mode==='racing')return;          // the engine owns the screen
  M.draw(ctx,vw,vh,dt);
  if(Flow.reveal&&Flow.mode==='map'){
    Flow.reveal.t+=dt;
    try{ drawUnlockReveal(ctx,vw,vh); }catch(e){ Flow.reveal=null; }
  }
  if(Flow.mode==='zooming')drawZoomIn(ctx,vw,vh,dt);
  else if(Flow.mode==='history')drawHistory(ctx,vw,vh,dt);
  else if(Flow.mode==='preview')drawPreview(ctx,vw,vh,dt);
  else if(Flow.mode==='victory')drawVictory(ctx,vw,vh,dt);
  /* Shop draws last so it covers the map. */
  if(global.UpgradeShop&&global.UpgradeShop.state.open)
    global.UpgradeShop.draw(ctx,vw,vh,dt);
  else if(Flow.mode==='map')drawShopButton(ctx,vw,vh);
}

/* The marker swap: a ring expands and fades where the settlement sits, leaving
   the dot green. Drawn over the map so the change is noticed rather than being
   a colour the player has to spot. */
/* (9) Selectable Upgrade Shop button on the map, bottom-right, with the
   credit balance so the player can see affordability without entering. */
/* (1) Rewards archive: every title, emblem, sponsor, livery, part, crew member
   and discovery earned, grouped by kind. Scrolls rather than paginating, so a
   long career reads as one continuous record. */
function drawHistory(ctx,vw,vh,dt){
  /* (16) The archive is dense text; a moving fluid behind it competes with the
     data the player came to read. */
  /* (2) Suppressed for as long as the archive is open. Hiding it once was
     undone by the world-map loop on the next frame, so a flag is set that the
     loop honours. */
  try{ if(global.WaterFX){global.WaterFX.hide();global.WaterFX.suppress(true,'archive');} }catch(e){}
  var S={};
  try{ S=(global.WorldRewards&&global.WorldRewards.summary())||{}; }catch(e){}
  var INV={};
  try{ INV=(global.UpgradeShop&&global.UpgradeShop.inventory())||{}; }catch(e){}
  ctx.save();
  ctx.fillStyle='rgba(0,2,8,0.95)';ctx.fillRect(0,0,vw,vh);

  /* (4) Header plate carrying the branding and the title together, matching
     the world map and shop so every screen reads as the same product. */
  var hf=Math.max(13,Math.round(vh*0.030));
  var tf=Math.max(17,Math.round(vh*0.044));
  ctx.font=tf+"px 'Germania One',serif";
  var tW=ctx.measureText('REWARDS ARCHIVE').width;
  ctx.font=hf+"px 'Germania One',serif";
  var lW=ctx.measureText('ZONE STORM RACING GX').width;
  var hbW=Math.min(vw*0.92,tW+lW+110), hbH=Math.max(46,vh*0.095);
  var hbX=(vw-hbW)/2, hbY=vh*0.028;
  /* (16) No border: the header reads cleanly against the dark background. */

  var fk=0.5+0.5*Math.sin(Flow.t*2.6);
  var lg=ctx.createLinearGradient(0,hbY+hbH*0.18,0,hbY+hbH*0.82);
  lg.addColorStop(0,'#8a1a00');
  lg.addColorStop(Math.max(0.05,Math.min(0.95,0.35+fk*0.30)),'#ff6a00');
  lg.addColorStop(Math.max(0.10,Math.min(0.99,0.62+fk*0.26)),'#fff2c0');
  lg.addColorStop(1,'#8a1a00');
  ctx.textAlign='left';ctx.textBaseline='middle';
  ctx.font=hf+"px 'Germania One',serif";
  ctx.fillStyle=lg;
  ctx.fillText('ZONE STORM RACING GX',hbX+16,hbY+hbH/2);

  ctx.textAlign='right';
  ctx.font=tf+"px 'Germania One',serif";
  ctx.fillStyle='#dff3ff';
  ctx.fillText('REWARDS ARCHIVE',hbX+hbW-16,hbY+hbH/2);

  ctx.textAlign='center';ctx.textBaseline='top';
  ctx.font=Math.max(10,Math.round(vh*0.022))+"px 'Press Start 2P',monospace";
  ctx.fillStyle='#ffd23a';
  ctx.fillText('RANK '+(S.rank||'ROOKIE')+'   \u00b7   '+(S.wins||0)+' WINS',
               vw/2,hbY+hbH+4);

  /* (16) A TABLE, NOT A SCROLLING LIST.
     Every category is a row with its count and its entries, laid out on a
     fixed grid so the whole archive is visible at once. Long lists are
     summarised rather than allowed to push the table off screen — the count
     is what matters at a glance, and the newest entries are the interesting
     ones. */
  var groups=[
    ['TITLES',        S.titles||[],   '#ffd23a'],
    ['EMBLEMS',       S.emblems||[],  '#ff9a3a'],
    ['SPONSORS',      S.sponsors||[], '#7fd0ff'],
    ['LIVERIES',      S.liveries||[], '#ff8ad0'],
    ['PARTS',         S.parts||[],    '#9fd8b0'],
    ['CREW',          S.crew||[],     '#c0a8ff'],
    ['DISCOVERIES',   S.finds||[],    '#8fe8d0'],
    ['PERKS OWNED',   INV.perks||[],    '#ffb347'],
    ['SPECIAL ITEMS', INV.specials||[], '#ff6a9a'],
    ['MACHINE TUNING',INV.upgrades||[], '#7fffd4']
  ];

  var tX=vw*0.05, tW=vw*0.90;
  /* Clear of the rank line above, which sits just under the header plate. */
  var tY=hbY+hbH+Math.round(vh*0.095);
  var rowH=Math.max(20,(vh*0.92-tY)/groups.length);
  var labW=tW*0.22, cntW=tW*0.08;

  /* Header row. */
  ctx.font=Math.max(5,Math.round(rowH*0.195))+"px 'Press Start 2P',monospace";
  ctx.textAlign='left';ctx.textBaseline='middle';
  ctx.fillStyle='#5f7f90';
  ctx.fillText('CATEGORY',tX,tY-rowH*0.55);
  ctx.textAlign='right';
  ctx.fillText('#',tX+labW+cntW-8,tY-rowH*0.55);
  ctx.textAlign='left';
  ctx.fillText('EARNED',tX+labW+cntW+10,tY-rowH*0.55);
  ctx.strokeStyle='rgba(120,200,160,0.35)';ctx.lineWidth=1;
  ctx.beginPath();ctx.moveTo(tX,tY-rowH*0.28);ctx.lineTo(tX+tW,tY-rowH*0.28);ctx.stroke();

  for(var g=0;g<groups.length;g++){
    var name=groups[g][0], list=groups[g][1], col=groups[g][2];
    var ry=tY+g*rowH+rowH*0.5;
    /* Alternating band so the eye can track across a wide row. */
    if(g%2===0){
      ctx.fillStyle='rgba(255,255,255,0.030)';
      ctx.fillRect(tX,tY+g*rowH,tW,rowH);
    }
    ctx.textAlign='left';ctx.textBaseline='middle';
    ctx.font=Math.max(5,Math.round(rowH*0.195))+"px 'Press Start 2P',monospace";
    ctx.fillStyle=col;
    ctx.fillText(name,tX+4,ry);

    ctx.textAlign='right';
    ctx.font=Math.max(7,Math.round(rowH*0.255))+"px 'Germania One',serif";
    ctx.fillStyle=list.length?'#dff3ff':'#3f5a68';
    ctx.fillText(String(list.length),tX+labW+cntW-8,ry);

    /* Entries, truncated to what the row can hold. */
    ctx.textAlign='left';
    ctx.font=Math.max(5,Math.round(rowH*0.1725))+"px 'Press Start 2P',monospace";
    /* Hard right margin so a long entry cannot run off the table. */
    var avail=tW-labW-cntW-30;
    var txt='';
    if(!list.length)txt='\u2014';
    else {
      /* Newest first: the recent earn is the one worth reading. */
      var shown=list.slice(-6).reverse();
      for(var q=0;q<shown.length;q++){
        var next=txt?(txt+'  \u00b7  '+shown[q]):shown[q];
        if(ctx.measureText(next).width>avail||q>=6){
          var more=list.length-q;
          if(more>0)txt=txt?(txt+'  +'+more+' more'):(list.length+' entries');
          break;
        }
        txt=next;
      }
    }
    ctx.fillStyle=list.length?'#9fb6c9':'#33505f';
    ctx.fillText(txt,tX+labW+cntW+10,ry);
  }

  ctx.textAlign='center';
  ctx.font="9px 'Press Start 2P',monospace";
  ctx.fillStyle='#4a6a80';
  ctx.fillText('\u2191\u2193 SCROLL     B BACK',vw/2,vh-22);
  ctx.restore();
}

/* (2) Button naming follows the attached controller: Xbox uses Y, PlayStation
   uses Triangle, Nintendo swaps X and Y. Reading the pad id is the only signal
   the browser gives, so unknown pads fall back to the Xbox label. */
function _padLabel(xboxName){
  try{
    var pads=navigator.getGamepads?navigator.getGamepads():[];
    for(var i=0;i<pads.length;i++){
      var p=pads[i]; if(!p||!p.connected)continue;
      var id=(p.id||'').toLowerCase();
      /* (4) XBOX PADS WERE SHOWING PLAYSTATION GLYPHS.
         Sony's generic name is "Wireless Controller", so that was in the
         PlayStation pattern — but Microsoft's is "Xbox Wireless Controller",
         which contains the same words. Xbox is therefore checked FIRST and
         wins outright; the bare phrase only counts when nothing says Xbox. */
      if(/xbox|xinput|microsoft|045e/.test(id))return xboxName;
      if(/nintendo|switch|joy-con|pro controller/.test(id))
        return xboxName==='Y'?'X':'Y';
      if(/dualshock|dualsense|playstation|sony|054c|wireless controller/.test(id))
        return xboxName==='Y'?'\u25b3':'\u25a1';
      return xboxName;
    }
  }catch(e){}
  return xboxName;
}
function drawShopButton(ctx,vw,vh){
  var cr=0;
  try{ cr=global.UpgradeShop?global.UpgradeShop.credits():0; }catch(e){}
  /* (1) Wider and shorter so the credit figure never overflows. */
  /* (4) Half the width: the box holds one short line now, not three items. */
  var w=Math.min(330,vw*0.36), h=Math.max(28,vh*0.052);
  /* (8) Centred at the bottom, and highlighted when focused. */
  var x=(vw-w)/2, y=vh-h-40;
  var foc=!!Flow.shopFocus;
  var pl=0.5+0.5*Math.sin(Flow.t*3.2);
  ctx.save();
  ctx.fillStyle=foc?'rgba(12,40,26,0.95)':'rgba(4,16,26,0.92)';
  ctx.fillRect(x,y,w,h);
  ctx.strokeStyle=foc?'rgba(127,208,255,'+(0.6+pl*0.4).toFixed(2)+')'
                     :'rgba(255,210,58,0.85)';
  ctx.lineWidth=foc?(3+pl*2):2;
  if(foc){ctx.shadowColor='#7fd0ff';ctx.shadowBlur=12+pl*14;}
  ctx.strokeRect(x,y,w,h);
  ctx.shadowBlur=0;
  ctx.textAlign='center';ctx.textBaseline='middle';
  ctx.font=Math.max(10,Math.round(h*0.30))+"px 'Germania One',serif";
  ctx.fillStyle='#ffd23a';
  /* (2) One line only. The credits figure and rewards hint are gone: the shop
     shows the balance on entry, and the archive is a tab inside it now. */
  ctx.fillText('PRESS '+_padLabel('Y')+' FOR UPGRADE SHOP',x+w/2,y+h/2);
  ctx.font=Math.max(7,Math.round(h*0.20))+"px 'Press Start 2P',monospace";
  ctx.fillStyle='#9fd8b0';
  /* (2) Second line removed. */
  ctx.restore();
}

function drawUnlockReveal(ctx,vw,vh){
  var R=Flow.reveal; if(!R)return;
  var from=M.posOf?M.posOf(R.from):null;
  var T=R.t, anyOn=false, DOT=9, SPEED=26;          // dot spacing px, dots/s
  ctx.save();
  for(var n=0;n<R.ids.length;n++){
    var to=M.posOf?M.posOf(R.ids[n]):null;
    var t0=n*0.55;                                  // routes reveal one after another
    var lt=T-t0; if(lt<0){anyOn=true;continue;}
    if(!to){ continue; }                            // opened in another municipality
    var fx=from?from[0]:to[0], fy=from?from[1]:to[1]-60;
    var dx=to[0]-fx, dy=to[1]-fy, len=Math.max(1,Math.sqrt(dx*dx+dy*dy));
    var nx=-dy/len, ny=dx/len, bow=Math.min(60,len*0.18)*(n%2?-1:1);
    var nd=Math.max(2,Math.floor(len/DOT)), shown=Math.min(nd,Math.floor(lt*SPEED*(1+len/400)));
    for(var d=1;d<=shown;d++){
      var u=d/nd, b=4*u*(1-u)*bow;
      var px=fx+dx*u+nx*b, py=fy+dy*u+ny*b;
      var age=(shown-d)/SPEED;
      ctx.globalAlpha=Math.max(0.35,1-age*0.25);
      ctx.fillStyle='#ffffff';
      ctx.beginPath();ctx.arc(px,py,d===shown?3:1.8,0,Math.PI*2);ctx.fill();
    }
    if(shown<nd){ anyOn=true; continue; }
    var at=nd/(SPEED*(1+len/400)), bt=lt-at;       // arrival burst
    if(bt<1.6){
      anyOn=true;
      var k=Math.min(1,bt/1.2);
      ctx.globalAlpha=1-k;
      ctx.strokeStyle='#ffffff';ctx.lineWidth=2.5*(1-k)+0.5;
      ctx.beginPath();ctx.arc(to[0],to[1],8+k*46,0,Math.PI*2);ctx.stroke();
      for(var q=0;q<12;q++){
        var a=q*Math.PI/6+bt*0.8, rr=10+k*38;
        ctx.globalAlpha=(1-k)*0.9; ctx.fillStyle='#ffffff';
        ctx.beginPath();ctx.arc(to[0]+Math.cos(a)*rr,to[1]+Math.sin(a)*rr,1.8,0,Math.PI*2);ctx.fill();
      }
      if(bt<1.5){
        ctx.globalAlpha=Math.min(1,bt*4)*(1-Math.max(0,(bt-1.0)/0.5));
        ctx.font="12px 'Press Start 2P',monospace";ctx.textAlign='center';ctx.textBaseline='bottom';
        ctx.fillStyle='#ffffff';ctx.fillText('NEW TRACK UNLOCKED',to[0],to[1]-18-k*6);
      }
    }
  }
  ctx.restore();
  if(!anyOn&&T>1)Flow.reveal=null;
}
function drawDotBurst(ctx,vw,vh){
  var st=Flow.settlement; if(!st)return;
  var k=Flow.dotAnim;
  var p=(M.posOf&&M.posOf(st.id))||[st.px*vw,st.py*vh];
  var cx=p[0], cy=p[1];
  if(!isFinite(cx)||!isFinite(cy))return;
  ctx.save();
  ctx.strokeStyle='rgba(57,255,20,'+(1-k).toFixed(2)+')';
  ctx.lineWidth=3*(1-k)+1;
  ctx.beginPath();ctx.arc(cx,cy,10+k*70,0,Math.PI*2);ctx.stroke();
  ctx.fillStyle='rgba(57,255,20,'+(0.9*(1-k)).toFixed(2)+')';
  ctx.beginPath();ctx.arc(cx,cy,6*(1-k*0.4),0,Math.PI*2);ctx.fill();
  ctx.restore();
}

/* ── INPUT  */
function input(btn){
  /* (9) The Upgrade Shop overlays the map and owns input while open. */
  if(global.UpgradeShop&&global.UpgradeShop.state.open)
    return global.UpgradeShop.input(btn);
  /* (1) X opens the rewards archive. Everything earned accumulates over
     millions of races, so it needs a place to live that is not the result
     screen. */
  if(Flow.mode==='map'&&btn==='history'){ Flow.mode='history';Flow.hsel=0;sfx('select');return true; }
  if(Flow.mode==='history'){
    if(btn==='b'){
      Flow.mode='map';sfx('back');
      try{ if(global.WaterFX)global.WaterFX.suppress(false,'archive'); }catch(e){}
      return true;
    }
    if(btn==='up'){Flow.hsel=Math.max(0,(Flow.hsel||0)-1);sfx('nav');return true;}
    if(btn==='down'){Flow.hsel=(Flow.hsel||0)+1;sfx('nav');return true;}
    return true;
  }
  /* ═══ Y ON THE MAP OPENS THE SHOP (item 36) 
     Y is dispatched as 'y' first and falls back to 'shop' only if nothing
     claimed it — that is what lets the preview tile use Y for its flip. But the
     map branch below returns true for EVERY button, so 'y' was reported as
     handled, the fallback never fired, and the shop became unreachable.

     Handled here explicitly instead of relying on the fallback: 'y' and 'shop'
     are the same action on this screen, so both names map to it and the
     catch-all below can go on claiming whatever it likes. */
  if(Flow.mode==='map'&&(btn==='shop'||btn==='y')){
    if(global.UpgradeShop)global.UpgradeShop.open();
    sfx('select');
    return true;
  }
  if(Flow.mode==='zooming')return true;   // (9) transition owns the screen
  if(Flow.mode==='victory'){
    /* Xbox layout (request 3 item 4): A next race — via the map, so the
       unlock can be seen and chosen — X race again, B title screen. */
    if(btn==='a')victoryReturnToMap();
    else if(btn==='b')return victoryToTitle();
    else if(btn==='x')victoryReplay();
    else return false;
    return true;
  }
  if(Flow.mode==='preview'){
    /* Only claim buttons this screen actually uses. Returning true for
       everything would swallow 'y' on screens that do not handle it, and the
       map's Y-opens-the-shop fallback would then never fire. */
    if(btn!=='a'&&btn!=='b'&&btn!=='y')return false;
    if(btn==='a')startSettlementRace();
    else if(btn==='b'){Flow.mode='map';Flow.settlement=null;Flow.previewFlipped=false;}
    /* (item 16) Y flips the preview tile to its reverse face, which shows the
       best and recent times for this track from IndexedDB. A toggle rather
       than a hold, so the player can read it without keeping a button down. */
    else if(btn==='y'){
      /* (item 27) The flip is unconditional. It used to look dead on a track
         that had never been raced — not because the toggle was gated, but
         because the reverse face rendered nothing recognisable without a
         record, so flipping an unplayed tile appeared to do nothing at all.
         The face now always draws its headings and shows dashes, so the flip
         is visibly a flip whether or not there is anything to report. */
      Flow.previewFlipped=!Flow.previewFlipped;
      sfx('nav');
      /* Warm the record on the way in. timesCached is synchronous, so the
         draw below never waits on the database — if the fetch has not landed
         the face shows "loading" for a frame or two rather than blocking. */
      try{
        if(Flow.previewFlipped&&Flow.settlement&&global.WorldRewards)
          global.WorldRewards.timesPrefetch(Flow.settlement.id);
      }catch(e){}
    }
    return true;
  }
  if(Flow.mode==='map'){
    /* (8) The shop button is a focus target below the map. Pressing down from
       the map moves onto it; up returns to the regions. */
    if(Flow.shopFocus){
      if(btn==='up'){Flow.shopFocus=false;sfx('nav');return true;}
      if(btn==='a'){ if(global.UpgradeShop)global.UpgradeShop.open(); sfx('select'); return true; }
      if(btn==='b'){Flow.shopFocus=false;sfx('back');return true;}
      return true;
    }
    /* (1) Down only reaches the shop when there is nothing below on the map.
       Grabbing it unconditionally made the lowest row of regions unreachable
       in the country/state/municipality views. */
    if(btn==='down'&&!M.hasBelow()){Flow.shopFocus=true;sfx('nav');return true;}
    if(btn==='left'||btn==='right'||btn==='up'||btn==='down')sfx('nav');
    if(btn==='a')sfx('select');
    if(btn==='b')sfx('back');
    if(btn==='left')M.navDir(-1,0);
    else if(btn==='right')M.navDir(1,0);
    else if(btn==='up')M.navDir(0,-1);
    else if(btn==='down')M.navDir(0,1);
    else if(btn==='a')M.enter();
    else if(btn==='b')return M.back();     // false at world level -> exit mode
    return true;
  }
  return false;
}

/* (3) The archive table, drawn from a supplied top edge so the Upgrade Shop
   can render it under its own header as a tab. */
function drawArchiveBody(ctx,vw,vh,dt,topY){
  var S={},INV={};
  try{ S=(global.WorldRewards&&global.WorldRewards.summary())||{}; }catch(e){}
  try{ INV=(global.UpgradeShop&&global.UpgradeShop.inventory())||{}; }catch(e){}
  var groups=[
    ['TITLES',S.titles||[],'#ffd23a'],['EMBLEMS',S.emblems||[],'#ff9a3a'],
    ['SPONSORS',S.sponsors||[],'#7fd0ff'],['LIVERIES',S.liveries||[],'#ff8ad0'],
    ['PARTS',S.parts||[],'#9fd8b0'],['CREW',S.crew||[],'#c0a8ff'],
    ['DISCOVERIES',S.finds||[],'#8fe8d0'],
    ['PERKS OWNED',INV.perks||[],'#ffb347'],
    ['SPECIAL ITEMS',INV.specials||[],'#ff6a9a'],
    ['MACHINE TUNING',INV.upgrades||[],'#7fffd4']
  ];
  var tX=vw*0.05,tW=vw*0.90,tY=topY+Math.round(vh*0.05);
  var rowH=Math.max(18,(vh*0.90-tY)/groups.length);
  var labW=tW*0.22,cntW=tW*0.08;
  ctx.save();
  ctx.font=Math.max(5,Math.round(rowH*0.195))+"px 'Press Start 2P',monospace";
  ctx.textAlign='left';ctx.textBaseline='middle';
  ctx.fillStyle='#ffd23a';
  ctx.fillText('RANK '+(S.rank||'ROOKIE')+'   \u00b7   '+(S.wins||0)+' WINS',tX,topY+rowH*0.5);
  for(var g=0;g<groups.length;g++){
    var name=groups[g][0],list=groups[g][1],col=groups[g][2];
    var ry=tY+g*rowH+rowH*0.5;
    if(g%2===0){ ctx.fillStyle='rgba(255,255,255,0.030)';
                 ctx.fillRect(tX,tY+g*rowH,tW,rowH); }
    ctx.textAlign='left';
    ctx.font=Math.max(5,Math.round(rowH*0.195))+"px 'Press Start 2P',monospace";
    /* All table text white; category colour removed for uniformity. */
    ctx.fillStyle='#ffffff'; ctx.fillText(name,tX+4,ry);
    ctx.textAlign='right';
    ctx.font=Math.max(7,Math.round(rowH*0.255))+"px 'Germania One',serif";
    ctx.fillStyle=list.length?'#dff3ff':'#3f5a68';
    ctx.fillText(String(list.length),tX+labW+cntW-8,ry);
    ctx.textAlign='left';
    ctx.font=Math.max(5,Math.round(rowH*0.1725))+"px 'Press Start 2P',monospace";
    var avail=tW-labW-cntW-30, txt='';
    if(!list.length)txt='\u2014';
    else{
      var shown=list.slice(-6).reverse();
      for(var q=0;q<shown.length;q++){
        var next=txt?(txt+'  \u00b7  '+shown[q]):shown[q];
        if(ctx.measureText(next).width>avail||q>=6){
          var more=list.length-q;
          if(more>0)txt=txt?(txt+'  +'+more+' more'):(list.length+' entries');
          break;
        }
        txt=next;
      }
    }
    ctx.fillStyle=list.length?'#9fb6c9':'#33505f';
    ctx.fillText(txt,tX+labW+cntW+10,ry);
  }
  ctx.restore();
}

global.WorldTourFlow={
  drawArchiveBody:drawArchiveBody,
  flow:Flow, frame:frame, input:input, reset:function(){
    Flow.mode='map';Flow.settlement=null;Flow.result=null;Flow.dotAnim=0;
    M.reset();
    W.homeSettlement();                    // ensures a start point exists
  }
};

})(typeof window!=='undefined'?window:globalThis);

/* ════════════════════════════════════════════════════════════════════════════
   BUILDINGS — merged in from the former buildings.js.

   It was already a self-contained IIFE publishing exactly one global
   (window.Buildings) and sharing no state with anything in this file, so it
   is appended verbatim rather than interleaved: nothing here can collide with
   the WorldTour/WorldMap/UpgradeShop closures above, and the module keeps its
   own Rng, palettes and cache.

   LOAD ORDER: the only consumer is drive.js, which is loaded after this file
   in race.html, so window.Buildings is published before anything reads it.
   ════════════════════════════════════════════════════════════════════════════ */

/* 
   ZONE STORM RACING GX — Procedural Building Generator v3
   buildings.js · BUILD 2026.9 · 100+ BUILDING TYPES · SIDE FACE TEXTURE
    */
(function(global){'use strict';

function Rng(s){s=s>>>0;if(!s)s=1;return function(){s^=s<<13;s^=s>>17;s^=s<<5;return(s>>>0)/4294967296;};}

/* ── 16 PALETTES  */
/* ── MATERIAL CLASSIFICATION ───────────────────────────────────────────────
   The palette was picked uniformly at random, so a lone farm building was as
   likely to be blue-tinted curtain glass as a downtown tower was to be red
   brick — the 64 palettes cover brick, timber, stone, concrete, metal and
   glass perfectly well, but nothing connected them to what was being built.

   Each palette is classified from its OWN colours at load rather than by a
   hand-kept table, so adding a palette to PAL needs no second edit and the
   two can never drift apart. Warmth (red minus blue in the wall colour)
   separates fired/organic materials from mineral ones; luminance separates
   pale stone from dark metal and glass. */
var _PAL_MAT=null;
function _classifyPal(){
  _PAL_MAT=PAL.map(function(p){
    var w=p.w||'#888888';
    var r=parseInt(w.substr(1,2),16), g=parseInt(w.substr(3,2),16), b=parseInt(w.substr(5,2),16);
    var warm=(r-b)/255, lum=(Math.max(r,g,b)+Math.min(r,g,b))/2/255;
    if(warm>0.14) return 'brick';                 // brick, terracotta, timber
    if(lum<0.46)  return 'glass';                 // dark metal and curtain glass
    return 'stone';                               // stone, render, concrete
  });
}
/* Weights per tier. Nothing is ever zero: a rural stone chapel and the odd
   brick warehouse downtown are both real, and hard exclusions would make the
   scenery look sorted rather than settled. */
var _MAT_W={
  small: {brick:0.66, stone:0.29, glass:0.05},   // hamlets, farms, outbuildings
  medium:{brick:0.38, stone:0.46, glass:0.16},   // towns
  large: {brick:0.16, stone:0.40, glass:0.44},   // city blocks
  mega:  {brick:0.05, stone:0.25, glass:0.70}    // towers: glass and steel
};
function _pickPal(rng,tier,biome){
  if(!_PAL_MAT)_classifyPal();
  var w=_MAT_W[tier]||_MAT_W.medium;
  var br=w.brick, st=w.stone, gl=w.glass;
  /* Biome nudges the same weights rather than replacing them, so terrain and
     settlement size compose: a large building in a forest is still a large
     building, just more likely to be timber than curtain wall. */
  if(biome==='forest'||biome==='jungle'||biome==='alpine'||biome==='tundra'){
    br*=1.7; gl*=0.45;
  } else if(biome==='city'||biome==='neon'){
    gl*=1.8; br*=0.5;
  } else if(biome==='desert'||biome==='mesa'||biome==='canyon'||biome==='savanna'){
    st*=1.6; gl*=0.6;                            // adobe, stone, rendered block
  }
  var tot=br+st+gl, roll=rng()*tot;
  var want=(roll<br)?'brick':((roll<br+st)?'stone':'glass');
  /* Walk from a random start so the same material does not always resolve to
     the same palette, and fall through to any palette if a class is empty. */
  var n=PAL.length, off=~~(rng()*n);
  for(var i=0;i<n;i++){
    var j=(off+i)%n;
    if(_PAL_MAT[j]===want)return PAL[j];
  }
  return PAL[off];
}

const PAL=[
  {w:'#bdaeb2',wd:'#98898a',t:'#262626',g:'#3f4f4a',gd:'#303d38',d:'#28201a',a:'#76645a',r:'#2c2c30',b:'#a17e78'},
  {w:'#a3a8c2',wd:'#778d9c',t:'#424242',g:'#374556',gd:'#283344',d:'#28201a',a:'#635147',r:'#2a2a2e',b:null},
  {w:'#98603f',wd:'#743819',t:'#353535',g:'#2d4054',gd:'#1e2e42',d:'#19110b',a:'#6d5b51',r:'#404044',b:null},
  {w:'#b0b388',wd:'#87935e',t:'#434343',g:'#335253',gd:'#244041',d:'#28201a',a:'#58463c',r:'#57575b',b:'#94834e'},
  {w:'#d0c49b',wd:'#ab9b7b',t:'#313131',g:'#385253',gd:'#294041',d:'#1b130d',a:'#6f5d53',r:'#404044',b:'#b49461'},
  {w:'#696478',wd:'#4e3f51',t:'#3d3d3d',g:'#364659',gd:'#273447',d:'#1d150f',a:'#97857b',r:'#3e3e42',b:null},
  {w:'#b9bca0',wd:'#979c7c',t:'#242424',g:'#305052',gd:'#213e40',d:'#1c140e',a:'#938177',r:'#49494d',b:null},
  {w:'#df9f76',wd:'#b77a5b',t:'#424242',g:'#325055',gd:'#233e43',d:'#28201a',a:'#736157',r:'#414145',b:'#c36f3c'},
  {w:'#809ea5',wd:'#56737c',t:'#292929',g:'#3e4355',gd:'#2f3143',d:'#29211b',a:'#48362c',r:'#424246',b:null},
  {w:'#ebebdc',wd:'#d0bfb3',t:'#424242',g:'#325252',gd:'#234040',d:'#19110b',a:'#655349',r:'#454549',b:'#cfbba2'},
  {w:'#48586c',wd:'#213c43',t:'#333333',g:'#3e4e4e',gd:'#2f3c3c',d:'#1a120c',a:'#6f5d53',r:'#343438',b:null},
  {w:'#e7bec2',wd:'#ca9299',t:'#373737',g:'#334549',gd:'#243337',d:'#1d150f',a:'#88766c',r:'#2f2f33',b:'#cb8e88'},
  {w:'#a58298',wd:'#7d5a7b',t:'#434343',g:'#2f4658',gd:'#203446',d:'#29211b',a:'#76645a',r:'#37373b',b:null},
  {w:'#84654f',wd:'#634733',t:'#3c3c3c',g:'#2d454f',gd:'#1e333d',d:'#18100a',a:'#6b594f',r:'#2b2b2f',b:null},
  {w:'#ccc4a6',wd:'#a29981',t:'#242424',g:'#2b484a',gd:'#1c3638',d:'#261e18',a:'#5e4c42',r:'#3b3b3f',b:null},
  {w:'#8ba89a',wd:'#718e7d',t:'#2f2f2f',g:'#394b4e',gd:'#2a393c',d:'#19110b',a:'#4c3a30',r:'#545458',b:null},
  {w:'#d1c7be',wd:'#a69e93',t:'#393939',g:'#34414f',gd:'#252f3d',d:'#1c140e',a:'#58463c',r:'#4c4c50',b:null},
  {w:'#b1a5b3',wd:'#938089',t:'#3c3c3c',g:'#3b4149',gd:'#2c2f37',d:'#2a221c',a:'#857369',r:'#2a2a2e',b:null},
  {w:'#9d4f44',wd:'#80321e',t:'#393939',g:'#2b4354',gd:'#1c3142',d:'#160e0a',a:'#715f55',r:'#3a3a3e',b:null},
  {w:'#cba881',wd:'#b08b59',t:'#2c2c2c',g:'#334449',gd:'#243237',d:'#28201a',a:'#857369',r:'#2d2d31',b:null},
  {w:'#c5b5b4',wd:'#a9998d',t:'#232323',g:'#3a404d',gd:'#2b2e3b',d:'#18100a',a:'#8c7a70',r:'#2e2e32',b:null},
  {w:'#677975',wd:'#4d544a',t:'#252525',g:'#37535a',gd:'#284148',d:'#28201a',a:'#827066',r:'#3e3e42',b:null},
  {w:'#c3c2ad',wd:'#9fa285',t:'#333333',g:'#38484a',gd:'#293638',d:'#160e0a',a:'#7a685e',r:'#515155',b:null},
  {w:'#c89a88',wd:'#a27e64',t:'#282828',g:'#35404f',gd:'#262e3d',d:'#211913',a:'#645248',r:'#343438',b:null},
  {w:'#9a91a7',wd:'#6e7684',t:'#262626',g:'#2e464b',gd:'#1f3439',d:'#19110b',a:'#86746a',r:'#333337',b:'#7e616d'},
  {w:'#e3e7d9',wd:'#bfcbbc',t:'#303030',g:'#2b4055',gd:'#1c2e43',d:'#302822',a:'#635147',r:'#2c2c30',b:'#c7b79f'},
  {w:'#505856',wd:'#323d37',t:'#434343',g:'#2a414a',gd:'#1b2f38',d:'#2c241e',a:'#534137',r:'#4c4c50',b:'#3c281c'},
  {w:'#dde1b7',wd:'#beb98c',t:'#333333',g:'#353f53',gd:'#262d41',d:'#1c140e',a:'#97857b',r:'#39393d',b:null},
  {w:'#9ca190',wd:'#747c69',t:'#2b2b2b',g:'#373e4d',gd:'#282c3b',d:'#2d251f',a:'#6a584e',r:'#444448',b:null},
  {w:'#876340',wd:'#5e4319',t:'#3e3e3e',g:'#314456',gd:'#223244',d:'#211913',a:'#67554b',r:'#38383c',b:'#6b3316'},
  {w:'#cacfbb',wd:'#a6a597',t:'#363636',g:'#3e4e54',gd:'#2f3c42',d:'#2b231d',a:'#847268',r:'#3f3f43',b:null},
  {w:'#85969d',wd:'#616b74',t:'#3b3b3b',g:'#354855',gd:'#263643',d:'#29211b',a:'#816f65',r:'#313135',b:null},
  {w:'#dab9b1',wd:'#af9a85',t:'#414141',g:'#3b534e',gd:'#2c413c',d:'#211913',a:'#77655b',r:'#2e2e32',b:null},
  {w:'#abaea9',wd:'#889286',t:'#3a3a3a',g:'#344a51',gd:'#25383f',d:'#271f19',a:'#503e34',r:'#36363a',b:null},
  {w:'#a6504e',wd:'#833033',t:'#202020',g:'#33474e',gd:'#24353c',d:'#231b15',a:'#8a786e',r:'#505054',b:null},
  {w:'#cbb282',wd:'#a59665',t:'#2a2a2a',g:'#3f4051',gd:'#302e3f',d:'#261e18',a:'#948278',r:'#525256',b:null},
  {w:'#c7c1a9',wd:'#a29b81',t:'#212121',g:'#2b4557',gd:'#1c3345',d:'#29211b',a:'#49372d',r:'#47474b',b:null},
  {w:'#7c6c86',wd:'#5f4c61',t:'#292929',g:'#3e5448',gd:'#2f4236',d:'#2e2620',a:'#4d3b31',r:'#454549',b:'#603c4c'},
  {w:'#d7cba1',wd:'#bca678',t:'#3d3d3d',g:'#2e4c58',gd:'#1f3a46',d:'#271f19',a:'#8c7a70',r:'#3e3e42',b:null},
  {w:'#deb681',wd:'#c3985a',t:'#3e3e3e',g:'#38464f',gd:'#29343d',d:'#302822',a:'#917f75',r:'#3b3b3f',b:null},
  {w:'#999d95',wd:'#757f6b',t:'#323232',g:'#314652',gd:'#223440',d:'#201812',a:'#857369',r:'#2f2f33',b:'#7d6d5b'},
  {w:'#e4ead5',wd:'#bec0b6',t:'#3a3a3a',g:'#344f56',gd:'#253d44',d:'#231b15',a:'#47352b',r:'#37373b',b:null},
  {w:'#604970',wd:'#402c44',t:'#363636',g:'#334a55',gd:'#243843',d:'#271f19',a:'#857369',r:'#505054',b:null},
  {w:'#e5ccbf',wd:'#c6af93',t:'#383838',g:'#345354',gd:'#254142',d:'#2d251f',a:'#554339',r:'#47474b',b:null},
  {w:'#a87f8f',wd:'#8e5365',t:'#3b3b3b',g:'#2e4c4d',gd:'#1f3a3b',d:'#170f0a',a:'#614f45',r:'#424246',b:null},
  {w:'#95664b',wd:'#75422c',t:'#303030',g:'#2c4d48',gd:'#1d3b36',d:'#2d251f',a:'#857369',r:'#2d2d31',b:null},
  {w:'#d4c4aa',wd:'#a99885',t:'#2c2c2c',g:'#2a514c',gd:'#1b3f3a',d:'#1d150f',a:'#503e34',r:'#48484c',b:null},
  {w:'#a293af',wd:'#7e7288',t:'#272727',g:'#2f474b',gd:'#203539',d:'#28201a',a:'#433127',r:'#3d3d41',b:null},
  {w:'#cec6ad',wd:'#a4a184',t:'#333333',g:'#3f514b',gd:'#303f39',d:'#2f2721',a:'#88766c',r:'#2c2c30',b:null},
  {w:'#b1b1a6',wd:'#958f7a',t:'#3a3a3a',g:'#394155',gd:'#2a2f43',d:'#211913',a:'#917f75',r:'#47474b',b:null},
  {w:'#a9504b',wd:'#85352e',t:'#3d3d3d',g:'#375050',gd:'#283e3e',d:'#201812',a:'#5f4d43',r:'#2f2f33',b:'#8d2316'},
  {w:'#caa583',wd:'#b08561',t:'#212121',g:'#39484d',gd:'#2a363b',d:'#251d17',a:'#5b493f',r:'#404044',b:null},
  {w:'#d7c3a7',wd:'#bc978b',t:'#2c2c2c',g:'#2c4555',gd:'#1d3343',d:'#251d17',a:'#87756b',r:'#39393d',b:null},
  {w:'#777c6f',wd:'#4d594a',t:'#393939',g:'#404551',gd:'#31333f',d:'#2b231d',a:'#8a786e',r:'#414145',b:null},
  {w:'#d7c4b9',wd:'#bca298',t:'#3d3d3d',g:'#324750',gd:'#23353e',d:'#1d150f',a:'#4f3d33',r:'#58585c',b:'#bb947f'},
  {w:'#c9b871',wd:'#a39254',t:'#313131',g:'#3c4e51',gd:'#2d3c3f',d:'#19110b',a:'#58463c',r:'#3c3c40',b:'#ad8837'},
  {w:'#839186',wd:'#686962',t:'#222222',g:'#2b4f51',gd:'#1c3d3f',d:'#2c241e',a:'#503e34',r:'#525256',b:null},
  {w:'#ebd8cc',wd:'#d1b5af',t:'#3e3e3e',g:'#38484d',gd:'#29363b',d:'#170f0a',a:'#604e44',r:'#48484c',b:'#cfa892'},
  {w:'#4c616b',wd:'#224740',t:'#292929',g:'#2e5051',gd:'#1f3e3f',d:'#18100a',a:'#5f4d43',r:'#313135',b:null},
  {w:'#e0cccf',wd:'#c0aeb1',t:'#333333',g:'#3c4b51',gd:'#2d393f',d:'#28201a',a:'#8f7d73',r:'#2d2d31',b:null},
  {w:'#8c8b83',wd:'#68615c',t:'#2f2f2f',g:'#2f4f4a',gd:'#203d38',d:'#1b130d',a:'#402e24',r:'#444448',b:null},
  {w:'#966438',wd:'#714119',t:'#3d3d3d',g:'#2c534f',gd:'#1d413d',d:'#1e1610',a:'#907e74',r:'#4f4f53',b:null},
  {w:'#cad1ad',wd:'#afac85',t:'#313131',g:'#2e4049',gd:'#1f2e37',d:'#1b130d',a:'#67554b',r:'#505054',b:null},
  {w:'#a298ae',wd:'#797a8b',t:'#393939',g:'#324e59',gd:'#233c47',d:'#251d17',a:'#78665c',r:'#2f2f33',b:null}
];

/* ── 25 BUILDING CLASSES  */
/* Each class defines floor/bay ranges, roof styles, ground floor type,
   and feature flags. 25 classes × 4 variants each = 100 unique types. */
const CLS=[
  {n:'Detached House',f:[1,2],by:[2,3],fH:44,bW:38,sb:0,rf:['pitched','gable','hip'],gf:'entrance',bal:0,ac:0},
  {n:'Terraced House',f:[2,3],by:[2,3],fH:40,bW:32,sb:0,rf:['pitched','gable'],gf:'entrance',bal:.2,ac:0},
  {n:'Suburban Villa',f:[2,3],by:[3,5],fH:46,bW:40,sb:0,rf:['hip','mansard'],gf:'entrance',bal:.3,ac:0},
  {n:'Bungalow',f:[1,1],by:[3,5],fH:48,bW:40,sb:0,rf:['pitched','hip'],gf:'entrance',bal:0,ac:0},
  {n:'Townhouse',f:[3,4],by:[2,3],fH:38,bW:30,sb:0,rf:['flat','parapet'],gf:'entrance',bal:.4,ac:.1},
  {n:'Low-Rise Apt',f:[3,5],by:[3,6],fH:38,bW:30,sb:0,rf:['flat','parapet'],gf:'entrance',bal:.5,ac:.3},
  {n:'Mid-Rise Apt',f:[5,8],by:[4,7],fH:36,bW:28,sb:0,rf:['flat','parapet','terrace'],gf:'entrance',bal:.4,ac:.4},
  {n:'High-Rise Apt',f:[8,14],by:[4,7],fH:34,bW:26,sb:1,rf:['flat','mechanical'],gf:'entrance',bal:.3,ac:.5},
  {n:'Tower Block',f:[10,20],by:[4,8],fH:30,bW:24,sb:1,rf:['flat','mechanical'],gf:'entrance',bal:.2,ac:.5},
  {n:'Student Housing',f:[4,7],by:[5,8],fH:36,bW:28,sb:0,rf:['flat'],gf:'entrance',bal:.3,ac:.2},
  {n:'Retirement Home',f:[2,4],by:[4,6],fH:40,bW:34,sb:0,rf:['flat','hip'],gf:'entrance',bal:.2,ac:.1},
  {n:'Mansion',f:[2,3],by:[4,6],fH:48,bW:42,sb:0,rf:['hip','mansard','crown'],gf:'entrance',bal:.4,ac:0},
  {n:'Corner Shop',f:[1,2],by:[2,4],fH:42,bW:36,sb:0,rf:['flat','parapet'],gf:'store',bal:0,ac:0},
  {n:'Strip Mall',f:[1,2],by:[5,10],fH:44,bW:34,sb:0,rf:['flat','shed'],gf:'store',bal:0,ac:.2},
  {n:'Supermarket',f:[1,2],by:[7,12],fH:46,bW:36,sb:0,rf:['flat'],gf:'store',bal:0,ac:.3},
  {n:'Department Store',f:[3,5],by:[5,9],fH:40,bW:30,sb:0,rf:['flat','parapet'],gf:'store',bal:0,ac:.3},
  {n:'Office Block',f:[4,8],by:[4,7],fH:36,bW:28,sb:0,rf:['flat','parapet','mechanical'],gf:'entrance',bal:0,ac:.5},
  {n:'Office Tower',f:[12,25],by:[4,8],fH:30,bW:24,sb:2,rf:['flat','crown','spire'],gf:'entrance',bal:0,ac:.3},
  {n:'Corporate HQ',f:[20,40],by:[5,10],fH:28,bW:22,sb:3,rf:['spire','crown','helipad'],gf:'entrance',bal:0,ac:.2},
  {n:'Bank Building',f:[3,6],by:[3,5],fH:38,bW:30,sb:0,rf:['flat','crown'],gf:'entrance',bal:0,ac:.2},
  {n:'Law Firm',f:[5,10],by:[3,6],fH:34,bW:28,sb:1,rf:['flat','parapet'],gf:'entrance',bal:0,ac:.3},
  {n:'Coworking Space',f:[3,6],by:[4,7],fH:36,bW:30,sb:0,rf:['flat','terrace'],gf:'entrance',bal:.1,ac:.2},
  {n:'Convention Center',f:[2,4],by:[8,14],fH:44,bW:32,sb:0,rf:['flat','mechanical'],gf:'entrance',bal:0,ac:.4},
  {n:'Restaurant',f:[1,2],by:[2,4],fH:42,bW:36,sb:0,rf:['flat','parapet'],gf:'store',bal:0,ac:0},
  {n:'Small Workshop',f:[1,2],by:[3,5],fH:48,bW:40,sb:0,rf:['shed','sawtooth'],gf:'dock',bal:0,ac:0},
  {n:'Warehouse',f:[1,3],by:[5,10],fH:52,bW:36,sb:0,rf:['flat','shed'],gf:'dock',bal:0,ac:0},
  {n:'Factory',f:[2,4],by:[6,12],fH:48,bW:34,sb:0,rf:['sawtooth','flat','mechanical'],gf:'dock',bal:0,ac:.2},
  {n:'Power Station',f:[3,6],by:[5,8],fH:44,bW:32,sb:0,rf:['mechanical','flat'],gf:'dock',bal:0,ac:.6},
  {n:'Chemical Plant',f:[4,8],by:[4,7],fH:40,bW:30,sb:1,rf:['mechanical','flat'],gf:'dock',bal:0,ac:.8},
  {n:'Water Treatment',f:[2,3],by:[6,10],fH:46,bW:34,sb:0,rf:['flat'],gf:'dock',bal:0,ac:.4},
  {n:'Brewery',f:[2,4],by:[4,7],fH:44,bW:34,sb:0,rf:['flat','mechanical'],gf:'dock',bal:0,ac:.3},
  {n:'Printing Works',f:[2,3],by:[5,8],fH:44,bW:36,sb:0,rf:['sawtooth','flat'],gf:'dock',bal:0,ac:.2},
  {n:'Auto Repair',f:[1,2],by:[3,5],fH:48,bW:40,sb:0,rf:['shed','flat'],gf:'dock',bal:0,ac:0},
  {n:'Cold Storage',f:[1,3],by:[4,7],fH:50,bW:38,sb:0,rf:['flat'],gf:'dock',bal:0,ac:.5},
  {n:'Gas Station',f:[1,1],by:[3,5],fH:40,bW:36,sb:0,rf:['flat'],gf:'store',bal:0,ac:0},
  {n:'Parking Garage',f:[3,6],by:[5,8],fH:32,bW:28,sb:0,rf:['flat','terrace'],gf:'dock',bal:0,ac:0},
  {n:'Hotel',f:[6,15],by:[4,8],fH:34,bW:26,sb:1,rf:['flat','crown','terrace'],gf:'entrance',bal:.6,ac:.4},
  {n:'Hospital',f:[4,10],by:[5,9],fH:36,bW:28,sb:1,rf:['flat','mechanical','helipad'],gf:'entrance',bal:.1,ac:.5},
  {n:'School',f:[2,4],by:[5,8],fH:40,bW:34,sb:0,rf:['flat','pitched'],gf:'entrance',bal:0,ac:.1},
  {n:'Library',f:[2,4],by:[4,6],fH:40,bW:34,sb:0,rf:['flat','parapet'],gf:'entrance',bal:0,ac:.1},
  {n:'Shopping Mall',f:[2,4],by:[8,14],fH:44,bW:32,sb:0,rf:['flat','parapet'],gf:'store',bal:0,ac:.4},
  {n:'Cinema',f:[2,3],by:[4,6],fH:44,bW:36,sb:0,rf:['flat'],gf:'entrance',bal:0,ac:.2},
  {n:'Church',f:[1,3],by:[2,4],fH:50,bW:40,sb:0,rf:['pitched','spire'],gf:'entrance',bal:0,ac:0},
  {n:'Fire Station',f:[2,3],by:[3,5],fH:44,bW:38,sb:0,rf:['flat'],gf:'dock',bal:0,ac:.1},
  {n:'Police Station',f:[2,4],by:[3,5],fH:40,bW:34,sb:0,rf:['flat','parapet'],gf:'entrance',bal:0,ac:.2},
  {n:'Skyscraper A',f:[30,55],by:[5,10],fH:26,bW:20,sb:3,rf:['spire','crown','antenna'],gf:'entrance',bal:0,ac:.2},
  {n:'Skyscraper B',f:[25,45],by:[6,11],fH:28,bW:22,sb:2,rf:['tiered','crown','helipad'],gf:'entrance',bal:0,ac:.3},
  {n:'Mega Tower',f:[40,60],by:[6,12],fH:24,bW:20,sb:4,rf:['spire','antenna'],gf:'entrance',bal:0,ac:.2},
  {n:'Data Center',f:[2,4],by:[6,10],fH:42,bW:34,sb:0,rf:['flat','mechanical'],gf:'dock',bal:0,ac:.8},
  {n:'Sports Hall',f:[2,3],by:[6,10],fH:48,bW:36,sb:0,rf:['shed','flat'],gf:'entrance',bal:0,ac:.2},
];

/* ── HELPERS  */
function px(h){const v=parseInt(h.slice(1),16);return[(v>>16)&255,(v>>8)&255,v&255];}
function sh(h,f){const c=px(h);f=Math.max(0,Math.min(2,f));
  return'rgb('+Math.min(255,~~(c[0]*f))+','+Math.min(255,~~(c[1]*f))+','+Math.min(255,~~(c[2]*f))+')';}
function al(h,a){const c=px(h);return'rgba('+c[0]+','+c[1]+','+c[2]+','+a.toFixed(3)+')';}

function bricks(ctx,x,y,w,h,col,rng){
  const bh=6,bw=14;
  ctx.fillStyle=sh(col,0.88);ctx.fillRect(x,y,w,h);
  for(let row=0;row<h;row+=bh+1){
    const off=((~~(row/(bh+1)))%2)*bw/2;
    for(let bx=0;bx<w;bx+=bw+1){
      const rx=x+bx+off,ry=y+row;
      if(rx>=x+w)continue;
      ctx.fillStyle=sh(col,0.85+rng()*0.30);
      ctx.fillRect(rx,ry,Math.min(bw,x+w-rx),Math.min(bh,y+h-ry));
    }
  }
}

function win(ctx,x,y,w,h,P,arch,night,rng,opt){
  ctx.fillStyle=sh(P.wd,0.62);ctx.fillRect(x-1,y-1,w+2,h+2);
  /* litFrac is per BUILDING, not a fixed 0.55 for every one. A tower where
     nine windows in ten are lit and one where only a handful are read as
     completely different places at night, and it was previously the same
     coin-flip everywhere. */
  const _lf=(opt&&opt.litFrac!=null)?opt.litFrac:0.55;
  const lit=night&&rng()<_lf;
  if(lit){
    ctx.fillStyle='rgba('+(190+~~(rng()*65))+','+(160+~~(rng()*60))+','+(90+~~(rng()*50))+',0.88)';
  } else {
    /* Glass tint, per building: neutral, cool, warm, mirrored or dark. The
       glazing is the largest single area of most elevations, so tinting it is
       the cheapest change that alters a building's whole character. */
    const _tn=(opt&&opt.tint)|0;
    let _g0=night?P.gd:P.g, _g1=night?sh(P.gd,1.15):sh(P.g,1.12);
    if(_tn===1){ _g0=sh(_g0,0.92); _g1=sh(_g1,1.06); }        // cool
    else if(_tn===2){ _g0=sh(_g0,1.10); _g1=sh(_g1,1.18); }   // warm
    else if(_tn===3){ _g0=sh(_g0,1.28); _g1=sh(_g1,0.86); }   // mirrored
    else if(_tn===4){ _g0=sh(_g0,0.66); _g1=sh(_g1,0.74); }   // dark
    const gg=ctx.createLinearGradient(x,y,x,y+h);
    gg.addColorStop(0,_g0);gg.addColorStop(0.4,_g1);
    gg.addColorStop(1,_g0);ctx.fillStyle=gg;
  }
  ctx.fillRect(x,y,w,h);
  /* Pane grid: 1-3 divisions on each axis */
  const gN=(opt&&opt.grid)||2;
  ctx.fillStyle=sh(P.t,0.85);
  for(let gi=1;gi<gN;gi++)ctx.fillRect(x,y+~~(h*gi/gN),w,1);
  if(w>10)for(let gi=1;gi<gN;gi++)ctx.fillRect(x+~~(w*gi/gN),y,1,h);
  /* Shape variants beyond plain rect / arch */
  const shp=(opt&&opt.shape)||0;
  if(shp===2){                      // round-top
    ctx.fillStyle=sh(P.w,0.95);
    ctx.beginPath();ctx.moveTo(x-1,y+h*0.30);
    ctx.quadraticCurveTo(x+w/2,y-h*0.22,x+w+1,y+h*0.30);
    ctx.lineTo(x+w+1,y-1);ctx.lineTo(x-1,y-1);ctx.closePath();ctx.fill();
  } else if(shp===3){               // narrow slit — mask the outer thirds
    ctx.fillStyle=sh(P.w,0.95);
    ctx.fillRect(x,y,~~(w*0.30),h);
    ctx.fillRect(x+w-~~(w*0.30),y,~~(w*0.30),h);
  } else if(shp===4){               // bay window — projecting sill + shadow
    ctx.fillStyle=sh(P.t,1.20);
    ctx.fillRect(x-2,y+h,w+4,3);
    ctx.fillStyle='rgba(0,0,0,0.16)';
    ctx.fillRect(x-2,y+h+3,w+4,2);
  }
  if(arch){ctx.fillStyle=sh(P.w,0.95);ctx.beginPath();
    ctx.moveTo(x,y+3);ctx.quadraticCurveTo(x+w/2,y-4,x+w,y+3);
    ctx.lineTo(x+w,y);ctx.lineTo(x,y);ctx.closePath();ctx.fill();}
  ctx.fillStyle=sh(P.t,1.15);ctx.fillRect(x-1,y+h,w+2,2);
  if(lit&&rng()<0.30){ctx.fillStyle='rgba(240,230,210,0.35)';
    ctx.fillRect(x+1,y+1,w-2,~~(h*0.3+rng()*h*0.3));}
}

/* ── GRAMMAR  */
function gram(rng,pal,classHint){
  const ci=(classHint!=null&&classHint>=0&&classHint<CLS.length)?classHint:~~(rng()*CLS.length);
  const C=CLS[ci];
  const variant=~~(rng()*4);  // 4 variants per class = 100 types
  const floors=C.f[0]+~~(rng()*(C.f[1]-C.f[0]+1));
  const bays=C.by[0]+~~(rng()*(C.by[1]-C.by[0]+1));
  const fH=C.fH+~~((rng()-0.5)*10);
  const bW=C.bW+~~((rng()-0.5)*8);
  const setbacks=[];
  if(C.sb>0){const n=1+~~(rng()*C.sb);
    for(let i=0;i<n;i++){const at=~~(floors*(0.45+i*0.18))+~~(rng()*3);
      if(at<floors)setbacks.push({f:at,i:1+~~(rng()*2)});}
    setbacks.sort((a,b2)=>a.f-b2.f);}
  const roof=C.rf[~~(rng()*C.rf.length)];
  const arch=rng()<0.35;
  const wH=~~(fH*0.48),wW=~~(bW*0.50),wP=~~(bW*0.25),wT=~~(fH*0.20);
  const hasBr=!!pal.b&&rng()<0.50;
  const hasBal=rng()<C.bal;
  const hasAC=rng()<C.ac;
  const hasAnt=floors>10&&rng()<0.55;
  const hasLedge=rng()<0.40;
  const hasCornice=rng()<0.35;
  const hasAwn=C.gf==='store'&&rng()<0.60;
  const awnCol='rgb('+~~(60+rng()*140)+','+~~(30+rng()*70)+','+~~(20+rng()*60)+')';
  /* ═══ EXTENDED VISUAL AXES 
     Twelve further independent choices multiply the distinct appearances by
     roughly 20x on top of the 50 classes x 4 variants already present. */
  const facade   = ~~(rng()*6);      // 0 flat 1 pilaster 2 banded 3 panel 4 grid 5 ribbed
  const winShape = ~~(rng()*5);      // 0 rect 1 arch 2 round 3 slit 4 bay
  const winGrid  = 1+~~(rng()*3);    // panes per window 1-3
  const roofTrim = ~~(rng()*4);      // 0 none 1 rail 2 vents 3 tanks
  const baseTrim = ~~(rng()*4);      // 0 none 1 plinth 2 steps 3 planters
  const stainAmt = rng()*0.55;       // weathering streak strength
  const crackAmt = rng()*0.40;       // surface crack density
  const signage  = ~~(rng()*4);      // 0 none 1 band 2 vertical 3 rooftop
  const signHue  = ~~(rng()*360);
  const balType  = ~~(rng()*3);      // 0 slab 1 railing 2 glass
  const cornerCut= rng()<0.22;       // chamfered corner column
  const antennaN = ~~(rng()*4);      // roof mast count

  /* ═══ SECOND AXIS BLOCK ═══════════════════════════════════════════════════
     Seven further independent choices. The block above multiplies out to
     about 17,000 appearances; these take it past 100,000 — roughly the five
     times asked for — WITHOUT another fifty hand-written classes, because
     independent axes multiply where new classes only add.
     Each is cheap: they reuse the facade loop that already runs, so the extra
     cost is a handful of fills on a bitmap baked once and cached, not
     per-frame work. */
  const winTint  = ~~(rng()*5);      // 0 neutral 1 cool 2 warm 3 mirrored 4 dark
  const litFrac  = 0.10+rng()*0.75;  // share of windows lit at night
  const floorBand= ~~(rng()*4);      // 0 none 1 every 2nd 2 every 3rd 3 every 5th
  const ductRun  = rng()<0.30;       // exterior service duct up one bay
  const fireEsc  = rng()<0.24;       // fire escape zigzag
  const roofSlope= ~~(rng()*3);      // roof detail sub-variant
  const grimeTop = rng()<0.45;       // dirt gathers at the parapet
  return{ci,variant,floors,bays,fH,bW,setbacks,roof,arch,wH,wW,wP,wT,
    gf:C.gf,hasBr,hasBal,hasAC,hasAnt,hasLedge,hasCornice,hasAwn,awnCol,pal,cls:C,
    facade,winShape,winGrid,roofTrim,baseTrim,stainAmt,crackAmt,
    signage,signHue,balType,cornerCut,antennaN,
    winTint,litFrac,floorBand,ductRun,fireEsc,roofSlope,grimeTop};
}

/* ── RENDER FACE  */
function renderFace(g,rng,night,isSide){
  const PAD=4;
  const totalW=g.bays*g.bW+PAD*2;
  const rExtra=g.roof==='spire'?~~(g.fH*2.8):
    g.roof==='crown'?~~(g.fH*1.4):
    (g.roof==='pitched'||g.roof==='gable'||g.roof==='hip')?~~(g.fH*0.65):
    g.roof==='mansard'?~~(g.fH*0.5):16;
  const totalH=g.floors*g.fH+PAD+rExtra;
  const cv=document.createElement('canvas');
  cv.width=isSide?~~(totalW*0.35):totalW;
  cv.height=totalH;
  const ctx=cv.getContext('2d');
  const P=g.pal;
  const sunF=isSide?0.72:(0.86+rng()*0.14);  // side face is always darker
  const sideBays=isSide?Math.max(1,~~(g.bays*0.4)):g.bays;

  function bAt(f){let b2=sideBays;
    for(let i=0;i<g.setbacks.length;i++)if(f>=g.setbacks[i].f)b2=Math.max(1,b2-g.setbacks[i].i);
    return b2;}
  function fX(f){return PAD+((sideBays-bAt(f))*g.bW)/2;}
  function fW(f){return bAt(f)*g.bW;}

  for(let f=0;f<g.floors;f++){
    const y=totalH-PAD-(f+1)*g.fH;
    const fx=fX(f),fw=fW(f),fb=bAt(f);
    const ao=0.90+0.10*(f/Math.max(1,g.floors-1));

    if(g.hasBr)bricks(ctx,fx,y,fw,g.fH,P.b||P.w,rng);
    else{ctx.fillStyle=sh(P.w,ao*sunF);ctx.fillRect(fx,y,fw,g.fH);}

    ctx.fillStyle='rgba(0,0,0,0.08)';ctx.fillRect(fx,y+g.fH-1,fw,1);

    /* ── FACADE TREATMENT  */
    if(g.facade===1){            // pilasters between bays
      ctx.fillStyle=sh(P.w,ao*sunF*1.10);
      for(let b3=0;b3<=fb;b3++)ctx.fillRect(fx+b3*g.bW-1,y,2,g.fH);
    } else if(g.facade===2){     // horizontal banding
      ctx.fillStyle=sh(P.wd,0.86);
      ctx.fillRect(fx,y+~~(g.fH*0.30),fw,Math.max(1,~~(g.fH*0.05)));
    } else if(g.facade===3){     // recessed panels
      ctx.fillStyle=sh(P.wd,0.92);
      for(let b3=0;b3<fb;b3++)
        ctx.fillRect(fx+b3*g.bW+2,y+2,g.bW-4,g.fH-5);
    } else if(g.facade===4){     // fine grid
      ctx.fillStyle='rgba(0,0,0,0.06)';
      for(let gx=0;gx<fw;gx+=6)ctx.fillRect(fx+gx,y,1,g.fH);
    } else if(g.facade===5){     // vertical ribbing
      for(let gx=0;gx<fw;gx+=4){
        ctx.fillStyle=sh(P.w,ao*sunF*(((gx/4)|0)%2?1.06:0.94));
        ctx.fillRect(fx+gx,y,2,g.fH);
      }
    }

    /* ── WEATHERING: vertical stains below sills, hairline cracks  */
    if(g.stainAmt>0.10&&f>0){
      ctx.fillStyle='rgba(0,0,0,'+(g.stainAmt*0.16).toFixed(3)+')';
      for(let b3=0;b3<fb;b3++){
        if(((b3*7+f*3)%5)>2)continue;
        ctx.fillRect(fx+b3*g.bW+g.wP+2,y+g.wT+g.wH+2,
                     Math.max(1,~~(g.wW*0.30)),g.fH-g.wT-g.wH-2);
      }
    }
    if(g.crackAmt>0.15&&((f*11)%7)<2){
      ctx.strokeStyle='rgba(0,0,0,'+(g.crackAmt*0.22).toFixed(3)+')';
      ctx.lineWidth=1;ctx.beginPath();
      const cx0=fx+((f*29)%Math.max(1,fw));
      ctx.moveTo(cx0,y);
      ctx.lineTo(cx0+((f%2)?4:-4),y+g.fH*0.5);
      ctx.lineTo(cx0+((f%2)?1:-1),y+g.fH);
      ctx.stroke();
    }

    if(g.hasLedge&&f>0&&f%2===0){
      ctx.fillStyle=sh(P.t,1.05);ctx.fillRect(fx-1,y+g.fH-3,fw+2,3);}

    if(f===0){
      if(g.gf==='store'&&!isSide){
        const pH=~~(g.fH*0.74),pY=y+g.fH-pH-2;
        for(let b2=0;b2<fb;b2++){
          const bx=fx+b2*g.bW;
          ctx.fillStyle=night?al(P.g,0.90):P.g;
          ctx.fillRect(bx+2,pY,g.bW-4,pH);
          ctx.fillStyle=P.t;ctx.fillRect(bx+2+~~((g.bW-4)/2)-1,pY,2,pH);
          ctx.fillRect(bx+2,pY,g.bW-4,2);
          if(night&&rng()<0.7){ctx.fillStyle='rgba(255,240,180,0.10)';
            ctx.fillRect(bx+2,pY,g.bW-4,pH);}
        }
        const db=~~(fb/2),dx=fx+db*g.bW+~~(g.bW*0.22),dw=~~(g.bW*0.56),dh=~~(g.fH*0.60);
        ctx.fillStyle=P.d;ctx.fillRect(dx,y+g.fH-dh-2,dw,dh);
        ctx.fillStyle='#b0a890';ctx.fillRect(dx+dw-5,y+g.fH-dh/2-2,2,5);
        if(g.hasAwn){ctx.fillStyle=g.awnCol;
          ctx.beginPath();ctx.moveTo(dx-8,y+g.fH-dh-4);ctx.lineTo(dx+dw+8,y+g.fH-dh-4);
          ctx.lineTo(dx+dw+14,y+g.fH-dh+8);ctx.lineTo(dx-14,y+g.fH-dh+8);ctx.closePath();ctx.fill();
          ctx.fillStyle='rgba(0,0,0,0.12)';
          for(let s=0;s<dw+16;s+=8)ctx.fillRect(dx-8+s,y+g.fH-dh-4,4,12);}
      } else if(g.gf==='entrance'){
        const db=~~(fb/2),dx=fx+db*g.bW+~~(g.bW*0.12),dw=~~(g.bW*0.76),dh=~~(g.fH*0.56);
        ctx.fillStyle=P.d;ctx.fillRect(dx,y+g.fH-dh-2,dw,dh);
        ctx.fillStyle=sh(P.a||P.t,1.15);ctx.fillRect(dx-8,y+g.fH-dh-8,dw+16,5);
        for(let b2=0;b2<fb;b2++){if(b2===db)continue;
          win(ctx,fx+b2*g.bW+g.wP,y+g.wT+~~(g.fH*0.14),g.wW,~~(g.wH*0.68),P,g.arch,night,rng,{shape:g.winShape,grid:g.winGrid});}
      } else {
        for(let b2=0;b2<fb;b2++){
          const dx=fx+b2*g.bW+3,dw=g.bW-6,dh=~~(g.fH*0.76);
          ctx.fillStyle=sh(P.wd,0.68);ctx.fillRect(dx,y+g.fH-dh-2,dw,dh);
          for(let sl=0;sl<6;sl++){ctx.fillStyle=sh(P.wd,0.55);
            ctx.fillRect(dx,y+g.fH-dh-2+~~(dh*sl/6),dw,1);}
          ctx.fillStyle='#6a6a6a';ctx.fillRect(dx+dw/2-3,y+g.fH-dh/2,6,3);}
      }
      continue;
    }

    for(let b2=0;b2<fb;b2++){
      win(ctx,fx+b2*g.bW+g.wP,y+g.wT,g.wW,g.wH,P,g.arch,night,rng,
        {shape:g.winShape,grid:g.winGrid,tint:g.winTint,litFrac:g.litFrac});
      if(g.hasBal&&f>1&&f<g.floors-1&&b2%2===0&&rng()<0.38){
        const by=y+g.wT+g.wH+2;
        ctx.fillStyle=sh(P.t,0.88);ctx.fillRect(fx+b2*g.bW+g.wP-4,by,g.wW+8,3);
        ctx.strokeStyle=sh(P.t,0.65);ctx.lineWidth=1;
        ctx.strokeRect(fx+b2*g.bW+g.wP-4,by,g.wW+8,10);
        for(let rb=0;rb<5;rb++){const rx=fx+b2*g.bW+g.wP-3+rb*~~((g.wW+6)/4);
          ctx.beginPath();ctx.moveTo(rx,by);ctx.lineTo(rx,by+10);ctx.stroke();}
      }
      if(g.hasAC&&f>2&&b2===fb-1&&f%3===0){
        const aw=~~(g.bW*0.32),ah=~~(g.fH*0.22);
        ctx.fillStyle='#707070';ctx.fillRect(fx+b2*g.bW+g.wW+g.wP+2,y+g.wT+g.wH-ah,aw,ah);
        ctx.fillStyle='#4a4a4a';
        for(let gl=0;gl<4;gl++)ctx.fillRect(fx+b2*g.bW+g.wW+g.wP+4,y+g.wT+g.wH-ah+2+gl*~~(ah/5),aw-4,1);}

      /* ── SECOND-BLOCK DETAIL ─────────────────────────────────────────────
         Drawn inside the bay loop that already runs, so these cost a few
         fills each on a bitmap that is baked once and cached — not per-frame
         work. Each is gated on its own axis, so they combine rather than all
         appearing together. */
      /* Exterior service duct climbing one fixed bay, with brackets. */
      if(g.ductRun&&b2===((g.bays*3)|0)%Math.max(1,fb)&&f<g.floors-1){
        const dx=fx+b2*g.bW+2, dw=Math.max(2,~~(g.bW*0.13));
        ctx.fillStyle=sh(P.t,0.72); ctx.fillRect(dx,y,dw,g.fH);
        ctx.fillStyle=sh(P.t,0.55); ctx.fillRect(dx,y+~~(g.fH*0.5),dw+2,2);
      }
      /* Fire escape: a zigzag landing on alternate floors, city buildings. */
      if(g.fireEsc&&f>0&&f<g.floors&&b2===0&&(f&1)){
        const ex=fx+b2*g.bW+1, ew=~~(g.bW*0.78);
        ctx.strokeStyle=sh(P.t,0.60); ctx.lineWidth=1;
        ctx.beginPath();
        ctx.moveTo(ex,y+g.fH); ctx.lineTo(ex+ew,y+~~(g.fH*0.35));
        ctx.stroke();
        ctx.fillStyle=sh(P.t,0.68); ctx.fillRect(ex,y+~~(g.fH*0.30),ew,2);
      }
    }
    /* Horizontal floor band: a slab edge every Nth storey. Reads as concrete
       construction and breaks up a tall flat elevation. */
    if(g.floorBand){
      const _per=[0,2,3,5][g.floorBand];
      if(_per&&f>0&&f%_per===0){
        ctx.fillStyle=sh(P.w,0.86);
        ctx.fillRect(fX(f)-1,y+g.fH-3,fW(f)+2,3);
      }
    }
    for(let si=0;si<g.setbacks.length;si++){
      if(g.setbacks[si].f===f&&f>0){
        ctx.fillStyle=sh(P.t,0.90);ctx.fillRect(fX(f-1)-2,y-2,fW(f-1)+4,5);}}
  }

  /* Roof (skip for side face — side face is just the wall) */
  if(!isSide){
    const ry=totalH-PAD-g.floors*g.fH;
    const tfx=fX(g.floors-1),tfw=fW(g.floors-1);
    if(g.hasCornice){ctx.fillStyle=sh(P.w,1.08);ctx.fillRect(tfx-3,ry-4,tfw+6,4);
      ctx.fillStyle=sh(P.t,1.1);ctx.fillRect(tfx-4,ry-6,tfw+8,3);
      for(let dd=0;dd<tfw;dd+=6){ctx.fillStyle=sh(P.t,1.0);ctx.fillRect(tfx-3+dd,ry-4,3,3);}}
    if(g.roof==='pitched'||g.roof==='gable'||g.roof==='hip'){
      const pk=~~(g.fH*0.6);ctx.fillStyle=P.r;ctx.beginPath();
      ctx.moveTo(tfx-2,ry);ctx.lineTo(tfx+tfw/2,ry-pk);ctx.lineTo(tfx+tfw+2,ry);ctx.closePath();ctx.fill();
      ctx.fillStyle=sh(P.r,0.72);ctx.beginPath();ctx.moveTo(tfx+tfw/2,ry-pk);
      ctx.lineTo(tfx+tfw+2,ry);ctx.lineTo(tfx+tfw/2,ry);ctx.closePath();ctx.fill();
    } else if(g.roof==='spire'){
      const spH=~~(g.fH*2.8),spW=~~(tfw*0.10),cx=tfx+tfw/2;
      ctx.fillStyle=sh(P.t,0.92);ctx.fillRect(cx-spW*3,ry-8,spW*6,8);
      ctx.fillStyle=sh(P.w,1.15);ctx.beginPath();ctx.moveTo(cx-spW,ry-8);
      ctx.lineTo(cx,ry-spH);ctx.lineTo(cx+spW,ry-8);ctx.closePath();ctx.fill();
      ctx.fillStyle=night?'#ff4040':'#cc2020';ctx.beginPath();ctx.arc(cx,ry-spH,2,0,Math.PI*2);ctx.fill();
    } else if(g.roof==='crown'){
      const crH=~~(g.fH*1.3);ctx.fillStyle=sh(P.w,1.06);ctx.fillRect(tfx+3,ry-crH,tfw-6,crH);
      ctx.fillStyle=P.t;ctx.fillRect(tfx,ry-crH-4,tfw,4);
      ctx.fillStyle=sh(P.a||P.t,1.3);ctx.beginPath();
      ctx.moveTo(tfx+tfw/2-8,ry-crH-4);ctx.lineTo(tfx+tfw/2,ry-crH-12);
      ctx.lineTo(tfx+tfw/2+8,ry-crH-4);ctx.closePath();ctx.fill();
    } else if(g.roof==='sawtooth'){
      const sH=~~(g.fH*0.4),nT=Math.max(2,~~(tfw/18)),tW2=tfw/nT;
      for(let tt=0;tt<nT;tt++){const tx=tfx+tt*tW2;ctx.fillStyle=P.r;ctx.beginPath();
        ctx.moveTo(tx,ry);ctx.lineTo(tx,ry-sH);ctx.lineTo(tx+tW2,ry);ctx.closePath();ctx.fill();}
    } else if(g.roof==='mansard'){
      const mH=~~(g.fH*0.45);ctx.fillStyle=sh(P.r,0.9);ctx.beginPath();
      ctx.moveTo(tfx-2,ry);ctx.lineTo(tfx+6,ry-mH);ctx.lineTo(tfx+tfw-6,ry-mH);
      ctx.lineTo(tfx+tfw+2,ry);ctx.closePath();ctx.fill();
    } else if(g.roof==='mechanical'){
      ctx.fillStyle=sh(P.r,0.88);ctx.fillRect(tfx,ry-7,tfw,7);
      for(let bb=0;bb<3+~~(rng()*3);bb++){const bx=tfx+6+~~(rng()*(tfw-28)),bw=10+~~(rng()*14),bh=7+~~(rng()*10);
        ctx.fillStyle='#6a6a6a';ctx.fillRect(bx,ry-7-bh,bw,bh);}
    } else if(g.roof==='helipad'){
      ctx.fillStyle=sh(P.r,0.9);ctx.fillRect(tfx,ry-8,tfw,8);
      ctx.fillStyle='#e0e0e0';ctx.font='bold '+~~(tfw*0.12)+'px sans-serif';
      ctx.textAlign='center';ctx.fillText('H',tfx+tfw/2,ry-1);
    } else if(g.roof==='terrace'){
      ctx.fillStyle=sh(P.r,0.92);ctx.fillRect(tfx,ry-6,tfw,6);
      ctx.strokeStyle=sh(P.t,0.7);ctx.lineWidth=1;ctx.strokeRect(tfx+2,ry-12,tfw-4,6);
    } else if(g.roof==='antenna'){
      ctx.fillStyle=P.t;ctx.fillRect(tfx,ry-2,tfw,2);
      const ax=tfx+~~(tfw*0.5),ah=20+~~(rng()*30);
      ctx.strokeStyle='#5a5a5a';ctx.lineWidth=2;ctx.beginPath();
      ctx.moveTo(ax,ry-2);ctx.lineTo(ax,ry-2-ah);ctx.stroke();
      ctx.fillStyle=night?'#ff3030':'#cc2020';ctx.fillRect(ax-1,ry-2-ah-1,3,3);
    } else {ctx.fillStyle=P.t;ctx.fillRect(tfx,ry-2,tfw,2);}
    if(g.hasAnt&&g.roof!=='antenna'){
      const ax=tfx+~~(tfw*0.72),ah=15+~~(rng()*20);
      ctx.strokeStyle='#5a5a5a';ctx.lineWidth=2;ctx.beginPath();
      ctx.moveTo(ax,ry-10);ctx.lineTo(ax,ry-10-ah);ctx.stroke();
      ctx.fillStyle=night?'#ff3030':'#cc2020';ctx.fillRect(ax-1,ry-10-ah-1,3,3);}
  }

  /* ── ROOF TRIM / BASE TRIM / SIGNAGE (front face only)  */
  if(!isSide){
    const ry2=totalH-PAD-g.floors*g.fH;
    const tx2=fX(g.floors-1), tw2=fW(g.floors-1);
    if(g.roofTrim===1){                       // perimeter rail
      ctx.strokeStyle=sh(P.t,1.15);ctx.lineWidth=1;
      ctx.strokeRect(tx2+1.5,ry2-8.5,tw2-3,7);
      for(let rx=tx2+4;rx<tx2+tw2-2;rx+=7)ctx.fillRect(rx,ry2-8,1,7);
    } else if(g.roofTrim===2){                // vent stacks
      for(let v=0;v<3;v++){
        const vx=tx2+6+v*~~((tw2-12)/3);
        ctx.fillStyle=sh(P.t,0.9);ctx.fillRect(vx,ry2-11,5,11);
        ctx.fillStyle=sh(P.t,1.25);ctx.fillRect(vx-1,ry2-13,7,2);
      }
    } else if(g.roofTrim===3){                // water tanks
      for(let v=0;v<2;v++){
        const vx=tx2+8+v*~~((tw2-16)/2);
        ctx.fillStyle='#6a6258';ctx.fillRect(vx,ry2-14,10,10);
        ctx.fillStyle='#4a443c';ctx.fillRect(vx,ry2-14,10,2);
        ctx.fillStyle='#3a352f';ctx.fillRect(vx+1,ry2-4,2,4);
        ctx.fillRect(vx+7,ry2-4,2,4);
      }
    }
    for(let am=0;am<g.antennaN;am++){
      const ax2=tx2+tw2*(0.18+am*0.22);
      const ah2=8+((am*13)%16);
      ctx.strokeStyle='#5a5a5a';ctx.lineWidth=1;
      ctx.beginPath();ctx.moveTo(ax2,ry2-6);ctx.lineTo(ax2,ry2-6-ah2);ctx.stroke();
    }
    const by2=totalH-PAD;
    if(g.baseTrim===1){                       // plinth
      ctx.fillStyle=sh(P.wd,0.78);
      ctx.fillRect(fX(0)-2,by2-5,fW(0)+4,5);
    } else if(g.baseTrim===2){                // entry steps
      for(let st=0;st<3;st++){
        ctx.fillStyle=sh(P.w,0.92-st*0.05);
        ctx.fillRect(fX(0)+fW(0)*0.34-st*3,by2-3-st*2,fW(0)*0.32+st*6,3);
      }
    } else if(g.baseTrim===3){                // planters
      for(let pl=0;pl<3;pl++){
        const px2=fX(0)+6+pl*~~((fW(0)-12)/3);
        ctx.fillStyle='#5a4a38';ctx.fillRect(px2,by2-5,9,5);
        ctx.fillStyle='#3f6a34';ctx.fillRect(px2+1,by2-8,7,3);
      }
    }
    if(g.signage&&g.floors>1){
      const sc2='hsl('+g.signHue+',68%,'+(night?58:44)+'%)';
      if(g.signage===1){                      // horizontal band above ground
        const sy2=totalH-PAD-g.fH-4;
        ctx.fillStyle=sc2;ctx.fillRect(fX(0)+4,sy2,fW(0)-8,5);
        ctx.fillStyle='rgba(0,0,0,0.30)';
        for(let dx2=0;dx2<fW(0)-12;dx2+=5)ctx.fillRect(fX(0)+6+dx2,sy2+1,2,3);
      } else if(g.signage===2){               // vertical blade sign
        const sh2=Math.min(g.floors*g.fH*0.5,60);
        const sx3=(g.cornerCut?fX(0)+2:fX(0)+fW(0)-8);
        ctx.fillStyle=sc2;ctx.fillRect(sx3,totalH-PAD-g.fH-sh2,6,sh2);
        ctx.fillStyle='rgba(255,255,255,0.35)';
        for(let dy2=3;dy2<sh2-3;dy2+=7)ctx.fillRect(sx3+2,totalH-PAD-g.fH-sh2+dy2,2,4);
      } else if(g.signage===3){               // rooftop box sign
        ctx.fillStyle=sc2;
        ctx.fillRect(tx2+tw2*0.18,ry2-16,tw2*0.64,10);
        ctx.fillStyle='rgba(0,0,0,0.35)';
        ctx.fillRect(tx2+tw2*0.18,ry2-16,tw2*0.64,2);
      }
    }
    if(g.cornerCut){                          // chamfered corner column
      ctx.fillStyle=sh(P.w,1.12);
      ctx.fillRect(fX(0),totalH-PAD-g.floors*g.fH,3,g.floors*g.fH);
    }
  }

  /* AO */
  const aoG=ctx.createLinearGradient(0,totalH-PAD-g.fH*1.5,0,totalH-PAD);
  aoG.addColorStop(0,'rgba(0,0,0,0)');aoG.addColorStop(1,'rgba(0,0,0,0.18)');
  ctx.fillStyle=aoG;ctx.fillRect(0,totalH-PAD-g.fH*1.5,cv.width,g.fH*1.5);
  return cv;
}

/* ── CACHE  */
const _c=new Map();
function _evict(){if(_c.size>300){const it=_c.keys();let n=30;while(n-->0)_c.delete(it.next().value);}}

function _bmp(r){
  if(typeof createImageBitmap==='function'){
    try{createImageBitmap(r.canvas).then(b=>{r.bitmap=b;}).catch(()=>{});
      createImageBitmap(r.side).then(b=>{r.sideBitmap=b;}).catch(()=>{});
    }catch(e){}}
}

function generate(seed,tier,opts){
  tier=tier||'medium';opts=opts||{};
  /* biome is part of the key: the same seed and tier now yields different
     materials in different landscapes, so omitting it would serve a cached
     desert building on a forest track. */
  const k=seed+'_'+tier+'_'+(opts.night?1:0)+'_'+(opts.classHint!=null?opts.classHint:'x')
         +'_'+(opts.biome||'x');
  if(_c.has(k))return _c.get(k);
  const rng=Rng(seed);
  const pal=_pickPal(rng,tier,opts.biome);
  const g=gram(rng,pal,opts.classHint!=null?opts.classHint:null);
  /* Both faces use the SAME grammar (palette, floors, windows, brick) so
     the textures match at the vertical seam. The side face uses the same
     seed (not XORed) — the isSide flag controls the bay count reduction
     and darker sun factor, but colours and patterns are identical. */
  const front=renderFace(g,Rng(seed),!!opts.night,false);
  const side=renderFace(g,Rng(seed),!!opts.night,true);
  const r={canvas:front,side:side,bitmap:null,sideBitmap:null,
    width:front.width,height:front.height,sideW:side.width,sideH:side.height,
    tier,floors:g.floors,bays:g.bays,roof:g.roof,cls:g.cls.n,
    /* Which material class the palette belongs to, so the choice is
       inspectable from outside instead of being buried in the closure. */
    mat:(_PAL_MAT?_PAL_MAT[PAL.indexOf(pal)]:null)};
  _bmp(r);_c.set(k,r);_evict();return r;
}

function generateBatch(seed,n,opts){
  opts=opts||{};const r=[];for(let i=0;i<n;i++){
    const s=(seed*2654435761+i*1597334677)>>>0;
    r.push(generate(s,null,opts));}return r;
}

function generateBatchAsync(seed,n,opts,ms){
  opts=opts||{};ms=ms||4;
  return new Promise(res=>{const r=[];let i=0;
    (function step(){const t0=performance.now();
      while(i<n&&performance.now()-t0<ms){
        r.push(generate((seed*2654435761+i*1597334677)>>>0,null,opts));i++;}
      i<n?requestAnimationFrame(step):res(r);})();});
}

function generateSkyline(seed,opts){
  opts=opts||{};const w=opts.width||800,h=opts.height||300,n=opts.count||22,night=!!opts.night;
  const cv=document.createElement('canvas');cv.width=w;cv.height=h;
  const ctx=cv.getContext('2d');const rng=Rng(seed);let x=0;
  const blds=[];
  for(let i=0;i<n&&x<w+50;i++){
    const b=generate((seed*31+i*7919)>>>0,null,{night});
    const sc=0.20+rng()*0.70;
    const bw=~~(b.width*sc),bh=~~(b.height*sc);
    blds.push({src:b.bitmap||b.canvas,x,y:h-bh,w:bw,h:bh,d:rng()});
    x+=bw-~~(bw*0.08);}
  blds.sort((a,b2)=>a.d-b2.d);
  for(const b of blds){ctx.globalAlpha=1.0;ctx.drawImage(b.src,b.x,b.y,b.w,b.h);}
  ctx.globalAlpha=1;return{canvas:cv,width:w,height:h,count:n};
}

global.Buildings={generate,generateBatch,generateBatchAsync,generateSkyline,
  clearCache:()=>_c.clear(),_cacheSize:()=>_c.size,TIERS:CLS,PALETTES:PAL};
})(typeof window!=='undefined'?window:globalThis);
