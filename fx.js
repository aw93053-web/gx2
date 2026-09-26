/* 
   FX.JS — CONSOLIDATED EFFECTS LAYER
   
   One file replacing seven that previously loaded separately:

     gpusnow.js    GPU snowfall        WebGL2, one instanced draw call
     gpurain.js    GPU rainfall        WebGL2, velocity-stretched streaks
     gpusand.js    GPU sandstorm       WebGL2, three particle classes
     mountain.js   procedural ranges   baked once per track, drawn as strips
     tunnelfx.js   tunnel bore patterns
     water.js      fluid simulation    (the heaviest module here)
     waterfx.js    water surface effects

   WHY ONE FILE
   Seven <script> tags is seven round trips before the game can start, and the
   modules are always loaded together — none is optional at runtime, and the
   engine probes for all of them during the first frame. Concatenating removes
   the request overhead without changing any of the code: every module keeps
   its own IIFE, so the internal scoping is exactly as it was and nothing new
   is exposed on window beyond the globals each already published.

   ORDER MATTERS. water.js must precede waterfx.js, which reads its exports.
   The embedded texture below must precede water.js, which consumes it. The
   GPU particle layers and mountain.js are independent of everything else.

   GLOBALS PUBLISHED (unchanged from the separate files):
     window.GPUSnow, window.GPURain, window.GPUSand,
     window.Mountains, window.TunnelFX, window.WaterFX
   plus whatever water.js exports for the fluid simulation.

   The seven original files are superseded and can be deleted from the server.
    */

/* ── EMBEDDED DITHER TEXTURE (was LDR_LLL1_0.png) 
   64x64 8-bit RGBA blue-noise, used by the fluid simulation's final blit to
   break up colour banding in the gradients.

   Inlined as a data URI so the file can be removed from the server. It is
   7,115 bytes of PNG, 9,488 characters of Base64 — a rounding error against
   this file's total size, and it removes a network request that previously
   404'd on every load because the asset was never deployed. createTextureAsync
   accepts any URL, and a data URI is a URL, so the consuming code is unchanged
   apart from which string it is handed. */
const FX_DITHER_PNG =
  'data:image/png;base64,' +
  'iVBORw0KGgoAAAANSUhEUgAAAEAAAABACAYAAACqaXHeAAAbkklEQVR4nD3bZdhVVRMG4KVY2Ah2t2Jid3diYRd2d7fYYAvYIAaC' +
  'Cioo2I2BYHd3d+f43XNd870/99l7rYknZu1z3rbmmmvGb7/9FmPHjo077rgjlltuuejbt2/stttucfbZZ8fxxx8fq622Whx00EEx' +
  'fvz4mHXWWeONN96Iyy+/PPbZZ5/4888/Y7PNNsv7Pv744+jQoUNstdVW8cUXX8TAgQNjscUWix9//DEOPPDAWGihheKkk06KnXfe' +
  'OZ5++umYd95547PPPov77rsv/v3333juuefi0ksvjammmiq23XbbOOuss+LXX3+NJ554ImN7//33Y+WVV46ddtopzjjjjBgyZEh0' +
  '69YtRo0aFX369Mm9V1pppbjxxhszzmeffTamnHLKjOfxxx+PiSaaKAYMGJD3W8O6bejQofnwTDPNFKecckom6k9wL774Ymy++ebx' +
  'yCOPxJ133hnnn39+3HzzzTHFFFPEuuuuG6effnrcfffduZnAl1hiiXjooYfCmmuttVYmIrlNNtkkWmu54XXXXZefXXLJJXHrrbfG' +
  'vvvum4kKfPfdd8/1Pv/88xg0aFAcccQRMc8888SGG24YE044YXz77bd5/f77749JJpkkfvrpp3jzzTdjzjnnzHjE+fPPP2fxrC++' +
  '33//Pff54IMPcq+vvvoqpp9++nzuqKOOivb1119nFT101VVXZRctNs0008RNN92UDyjOkksuGT169IhjjjkmA3nsscdihx12yEDe' +
  'eeedrPp+++0XXbp0yQIee+yxGcRLL70Up512Wmy33XZhL5svs8wy8csvv0SnTp0yuWuvvTb3mHTSSePkk0+ORRZZJNZYY4148MEH' +
  'M9Bdd901Tj311JhxxhkTJYsvvngcdthhcfHFF8c222wTe++9d3zyyScZG5Ttv//+8e6772ah5QatimRtz3puxRVXjMknnzyajqnM' +
  'K6+8khDq2rVrdkonXNfZCSaYIN577734+++/Y5VVVsmu6CR4q/iqq64azz//fJx55pmx/fbbx5NPPhnzzz9/rLDCCpno7LPPHsOG' +
  'DctADj/88Ezs5ZdfTsSNGDEiC/r6669nUUEeCmeZZZb4/vvvE01LL710NgeNtthii/jjjz9ittlmy/vFM3z48Ljiiiuic+fOGQe6' +
  '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';


/* 
   GPU SNOWFALL   (was gpusnow.js)
   ---------------------------------------------------------------------------
   Stateless WebGL2 particle field. Positions are derived in the vertex shader
   from u_time, so the per-frame CPU cost is a handful of uniforms and one draw
   call regardless of flake count.
    */
/* 
   GPU SNOW — WebGL 2.0 particle pipeline
   ---------------------------------------------------------------------------
   Replaces the CPU particle loop. All motion — fall, wind, sway, wrap-around —
   happens in the vertex shader, so the main thread does nothing per frame
   beyond setting a handful of uniforms and issuing one draw call.

   WHY THIS SHAPE
   The CPU version computed a position per particle per frame in JavaScript and
   issued a fill per flake. That cost scales linearly with particle count and
   caps out in the low thousands. Here the per-particle attributes are uploaded
   ONCE at init, and each frame the shader derives position from `u_time`. The
   cost per frame is therefore independent of particle count: 50,000 flakes and
   500 cost the same on the CPU side.

   Wrap-around uses mod() on the derived position rather than a stored one,
   which is what makes the whole thing stateless — no feedback buffer, no
   double-buffering, no readback.

   The public interface matches the previous effect (create/resize/draw/destroy
   plus setIntensity/setStorm), so callers need no changes. If WebGL 2 is
   unavailable, `create` returns null and the caller keeps its canvas path.
    */

(function(global){
'use strict';

var VERT = [
'#version 300 es',
'precision highp float;',
/* Per-particle, uploaded once. */
'in vec2  a_seed;        // stable random pair, 0..1',
'in vec3  a_vel;         // fall speed, drift, mass',
'in vec3  a_sway;        // amplitude, frequency, phase',
'',
'uniform float u_time;',
'uniform vec2  u_bounds;    // viewport in pixels',
'uniform vec2  u_wind;      // steady wind vector, px/s',
'uniform float u_storm;     // 0 calm .. 1 blizzard',
'uniform float u_gust;      // gust envelope, -1..1',
'',
'out float v_alpha;',
'out float v_depth;',
'',
'void main(){',
/* Depth: near flakes fall faster, are larger and brighter. Derived from the
   seed so it is stable for the life of the particle. */
'  float depth = 0.25 + a_seed.y * 0.75;',
'  // (1) Storm multiplies fall speed heavily: at full storm flakes cross the',
'  // screen in well under a second, which is what reads as violent rather',
'  // than merely dense.',
'  float fall  = a_vel.x * depth * (1.0 + u_storm * 6.0);',
'',
/* Horizontal: steady wind, plus a sway that scales hard with the storm value.
   In a blizzard the sway dominates, which is what makes the motion read as
   violent rather than merely fast. */
'  float t = u_time;',
'  // Two sway octaves so the path is irregular, not a clean sine. In a storm',
'  // the second octave dominates and the motion becomes genuinely chaotic.',
'  float sway = sin(t * a_sway.y + a_sway.z) * a_sway.x * (1.0 + u_storm * 7.0)',
'             + sin(t * a_sway.y * 3.7 + a_sway.z * 2.1) * a_sway.x',
'               * u_storm * 5.0;',
'  // Gusts shove the whole field sideways together.',
'  float gust = u_gust * (60.0 + u_storm * 620.0) * depth;',
'  float drift = a_vel.y * (1.0 + u_storm * 1.5);',
'',
/* ═══ SEED ACROSS THE WRAP DOMAIN, NOT THE SCREEN 
   Start positions were spread uniformly over 0..bounds, but the wrap below maps
   into a domain 800px wider (bounds + 800, offset -400). A uniform spread over
   a NARROWER interval is not uniform once folded into a wider one, so the field
   carried a permanent density gradient across the screen — measured at 44%
   more flakes on one third than another, which is the thin left side.

   Seeding over the same interval the mod maps into makes the distribution
   uniform by construction, and it stays uniform because the wrap is a bijection
   on that interval. */
'  float x = a_seed.x * (u_bounds.x + 800.0) - 400.0',
'          + sway + gust + (u_wind.x + drift) * t * depth;',
'  float y = a_seed.y * (u_bounds.y + 200.0) - 100.0 + (fall + u_wind.y) * t;',
'',
/* Stateless wrap: mod() on the derived coordinate, so a particle leaving one
   edge reappears at the other with no stored state to update. */
'  // Wrap margins widened: at storm strength a flake can travel far outside',
'  // the viewport between frames, and a tight margin made them pop.',
'  x = mod(x + 400.0, u_bounds.x + 800.0) - 400.0;',
'  y = mod(y + 100.0, u_bounds.y + 200.0) - 100.0;',
'',
/* Clip space. */
'  vec2 clip = vec2( (x / u_bounds.x) * 2.0 - 1.0,',
'                    1.0 - (y / u_bounds.y) * 2.0 );',
'  gl_Position = vec4(clip, 0.0, 1.0);',
'',
/* Size and brightness follow depth, and a blizzard smears the flakes larger. */
'  gl_PointSize = (1.0 + depth * 2.6) * (1.0 + u_storm * 1.4);',
'  v_alpha = (0.30 + depth * 0.55) * (0.65 + u_storm * 0.35);',
'  v_depth = depth;',
'}'
].join('\n');

var FRAG = [
'#version 300 es',
'precision mediump float;',
'in float v_alpha;',
'in float v_depth;',
'out vec4 fragColor;',
'void main(){',
/* Round, soft-edged flake from the point coordinate — cheaper than a texture
   and avoids a bind per draw. */
'  vec2 d = gl_PointCoord - vec2(0.5);',
'  float r = dot(d, d);',
'  if (r > 0.25) discard;',
'  float soft = 1.0 - smoothstep(0.06, 0.25, r);',
'  vec3 tint = mix(vec3(0.78,0.85,0.95), vec3(1.0), v_depth);',
'  fragColor = vec4(tint, v_alpha * soft);',
'}'
].join('\n');

function compile(gl,type,src){
  var sh=gl.createShader(type);
  gl.shaderSource(sh,src);
  gl.compileShader(sh);
  if(!gl.getShaderParameter(sh,gl.COMPILE_STATUS)){
    console.warn('GPU snow shader failed:',gl.getShaderInfoLog(sh));
    gl.deleteShader(sh);
    return null;
  }
  return sh;
}

/* `count` is the ceiling. Fewer are drawn when intensity is low, by shortening
   the draw range — no buffer rebuild is needed to change density. */
function create(canvas,count){
  var gl=null;
  try{ gl=canvas.getContext('webgl2',{alpha:true,antialias:false,premultipliedAlpha:false}); }
  catch(e){ gl=null; }
  if(!gl)return null;                    // caller falls back to canvas 2D

  var vs=compile(gl,gl.VERTEX_SHADER,VERT);
  var fs=compile(gl,gl.FRAGMENT_SHADER,FRAG);
  if(!vs||!fs)return null;
  var prog=gl.createProgram();
  gl.attachShader(prog,vs);gl.attachShader(prog,fs);
  gl.linkProgram(prog);
  if(!gl.getProgramParameter(prog,gl.LINK_STATUS)){
    console.warn('GPU snow link failed:',gl.getProgramInfoLog(prog));
    return null;
  }

  var N=Math.max(64,count||50000);

  /* Attributes generated once. Interleaving them in a single VBO keeps the
     upload to one call and the per-frame state to one bind. */
  var stride=8;                          // seed(2) + vel(3) + sway(3)
  var data=new Float32Array(N*stride);
  for(var i=0;i<N;i++){
    var o=i*stride;
    data[o  ]=Math.random();                       // seed.x
    data[o+1]=Math.random();                       // seed.y (also depth)
    data[o+2]=40+Math.random()*120;                // fall speed px/s
    data[o+3]=(Math.random()-0.5)*40;              // lateral drift
    data[o+4]=0.4+Math.random()*1.2;               // mass (reserved)
    data[o+5]=4+Math.random()*26;                  // sway amplitude
    data[o+6]=0.4+Math.random()*2.6;               // sway frequency
    data[o+7]=Math.random()*6.283;                 // sway phase
  }
  var vbo=gl.createBuffer();
  gl.bindBuffer(gl.ARRAY_BUFFER,vbo);
  gl.bufferData(gl.ARRAY_BUFFER,data,gl.STATIC_DRAW);

  var vao=gl.createVertexArray();
  gl.bindVertexArray(vao);
  var B=Float32Array.BYTES_PER_ELEMENT, S=stride*B;
  function attr(name,size,off){
    var loc=gl.getAttribLocation(prog,name);
    if(loc<0)return;
    gl.enableVertexAttribArray(loc);
    gl.vertexAttribPointer(loc,size,gl.FLOAT,false,S,off*B);
  }
  attr('a_seed',2,0);
  attr('a_vel', 3,2);
  attr('a_sway',3,5);
  gl.bindVertexArray(null);

  var U={
    time:gl.getUniformLocation(prog,'u_time'),
    bounds:gl.getUniformLocation(prog,'u_bounds'),
    wind:gl.getUniformLocation(prog,'u_wind'),
    storm:gl.getUniformLocation(prog,'u_storm'),
    gust:gl.getUniformLocation(prog,'u_gust')
  };

  var state={
    gl:gl, prog:prog, vao:vao, vbo:vbo, max:N,
    active:N, storm:0, wind:[0,0], t:0, t0:0
  };

  return {
    /* Density without touching the buffer: draw fewer vertices. */
    setIntensity:function(f){
      state.active=Math.max(0,Math.min(N,Math.round(N*Math.max(0,Math.min(1,f)))));
    },
    /* 0 calm .. 1 blizzard. Drives speed, sway and flake size in the shader. */
    setStorm:function(v){ state.storm=Math.max(0,Math.min(1,v||0)); },
    setWind:function(x,y){ state.wind[0]=x||0; state.wind[1]=y||0; },
    /* (2) Restart the clock. Without this a layer that has been hidden for a
       while resumes at a huge t: every particle's derived position jumps, and
       because the field is stateless that jump looks like a static field
       rather than motion resuming. Called whenever snow starts on a track. */
    restart:function(){ state.t0=0; state.t=0; },
    resize:function(w,h){
      canvas.width=w;canvas.height=h;
      gl.viewport(0,0,w,h);
    },
    draw:function(dt){
      /* (2) Time comes from the wall clock, not an accumulated dt.
         The caller passed a fixed 1/60 every frame, so if draw() was skipped
         or called at an irregular rate the field advanced in lockstep with
         CALL COUNT rather than with real time — and any frame that did not
         reach this line froze the snow entirely. A clock cannot desynchronise
         from the animation the way an accumulator can. */
      var nowS=(typeof performance!=='undefined'&&performance.now)
                 ?performance.now()/1000:Date.now()/1000;
      if(!state.t0)state.t0=nowS;
      state.t=nowS-state.t0;
      if(dt&&dt<0)state.t+=dt;   // reserved for manual stepping in tests
      gl.viewport(0,0,canvas.width,canvas.height);
      gl.clearColor(0,0,0,0);
      gl.clear(gl.COLOR_BUFFER_BIT);
      gl.enable(gl.BLEND);
      gl.blendFunc(gl.SRC_ALPHA,gl.ONE_MINUS_SRC_ALPHA);
      gl.useProgram(prog);
      gl.bindVertexArray(vao);
      gl.uniform1f(U.time,state.t);
      gl.uniform2f(U.bounds,canvas.width,canvas.height);
      gl.uniform2f(U.wind,state.wind[0],state.wind[1]);
      gl.uniform1f(U.storm,state.storm);
      /* Gusts are a slow compound sine — one uniform, applied to every
         particle in the shader, so a storm surges as a whole rather than
         each flake wandering independently. */
      gl.uniform1f(U.gust,
        Math.sin(state.t*0.37)*0.6+Math.sin(state.t*0.13+1.7)*0.4);
      /* THE ENTIRE FIELD IN ONE CALL. */
      gl.drawArrays(gl.POINTS,0,state.active);
      gl.bindVertexArray(null);
    },
    stats:function(){
      return {max:N,active:state.active,storm:state.storm,drawCalls:1};
    },
    destroy:function(){
      try{
        gl.deleteBuffer(vbo);gl.deleteVertexArray(vao);gl.deleteProgram(prog);
      }catch(e){}
    }
  };
}

global.GPUSnow={create:create,VERT:VERT,FRAG:FRAG};

})(typeof window!=='undefined'?window:globalThis);


/* 
   GPU RAINFALL   (was gpurain.js)
   ---------------------------------------------------------------------------
   Instanced quads stretched along each drop's velocity, so streak length follows
   actual speed. Ceiling 750,000 drops; the drawn count follows rainfall
   intensity cubically, so a drizzle costs a few thousand.
    */
/* 
   GPU RAIN — WebGL 2.0 raindrop pipeline
   ---------------------------------------------------------------------------
   WHY THIS EXISTS
   The canvas rain drew every drop as a straight line of fixed length and slant.
   Scattering the positions did not help, because the thing that read as a
   pattern was that every stroke was PARALLEL and the same size. Adding random
   directions to a fifth of them fixed the parallelism and traded it for a
   different artifact: drops visibly travelling the wrong way.

   Real rain does not read through direction variety. It reads through:

     * DEPTH. Near drops are large, fast, blurred and few. Far drops are small,
       slow, dim and many. A single layer at one scale cannot look like rain no
       matter how it is jittered.
     * VELOCITY STREAKING. A drop is a point; the streak is motion blur over
       the exposure. So streak LENGTH must follow the drop's own speed, not be
       a constant. This is the single biggest cue and the canvas version had it
       backwards — a fixed length with varying speed.
     * SOFT ENDS. A motion-blurred streak is bright in the middle and fades at
       both ends. Hard-ended lines read as scratches on the lens.
     * IMPACTS. Rain that never lands is snow. A thin band of splashes near the
       bottom sells contact with the world.

   All four are per-drop work, which is why this is on the GPU: the same
   stateless approach as gpusnow.js, with position derived in the vertex shader
   from `u_time` so the per-frame CPU cost is a handful of uniforms and one
   draw call regardless of drop count.

   Geometry is instanced quads rather than points: a streak needs to be longer
   than it is wide and oriented along its velocity, which gl.POINTS cannot do.
    */

(function(global){
'use strict';

var VERT = [
'#version 300 es',
'precision highp float;',
/* Per-vertex: the unit quad, reused for every drop. */
'in vec2 a_corner;        // (-0.5..0.5, 0..1) along the streak',
/* Per-instance, uploaded once. */
'in vec4 a_seed;          // x,y start 0..1 | depth | phase',
'in vec3 a_var;           // fall speed | drift | thickness',
'',
'uniform float u_time;',
'uniform vec2  u_bounds;',
'uniform float u_intensity;   // 0 none .. 1 downpour',
'uniform float u_wind;        // steady lateral wind, px/s',
'uniform float u_gust;        // gust envelope -1..1',
'uniform float u_turb;        // 0 calm .. 1 wild, from the track storm value',
'',
'out float v_alpha;',
'out float v_along;       // 0 tail .. 1 head, for the soft ends',
'out float v_depth;',
'',
'void main(){',
/* Depth drives everything. Squared so the distribution is weighted toward the
   far layers — a sky full of near drops looks like a car wash, not rain. */
'  float d = a_seed.z * a_seed.z;',
'  float depth = 0.18 + d * 0.82;',
'',
/* Fall speed scales hard with depth AND with intensity. */
'  float fall = a_var.x * (0.35 + depth * 1.65) * (0.55 + u_intensity * 1.15);',
/* TURBULENCE. On a calm track the only lateral motion is the steady wind, so
   drops fall in near-parallel lines and look like rain on a still evening. As
   the track storm value rises, two chaotic terms open up: a slow one that
   swings the drop across the frame and a fast one that makes the path ragged.
   Both are seeded per drop, so neighbouring drops are never in phase — a
   single shared term would move the whole field as one sheet, which reads as
   a wobbling texture rather than as weather. */
'  float ph = a_seed.w * 6.2831;',
'  float turb = ( sin(u_time * 0.9  + ph * 3.1) * 34.0',
'              + sin(u_time * 2.7  + ph * 7.9) * 15.0 ) * u_turb',
'            + sin(u_time * 5.3 + ph * 11.3) * 7.0 * u_turb * u_turb;',
'  float drift = (a_var.y + u_wind + u_gust * 140.0 * (0.35 + u_turb)) * depth',
'              + turb * depth;',
'',
'  float t = u_time + a_seed.w * 90.0;',
/* Seeded across the WRAP domain rather than the screen — see the same note in
   gpusnow.js. A uniform spread over 0..bounds folded into a bounds+1200 wrap
   leaves a standing density gradient across the frame. */
'  float x = a_seed.x * (u_bounds.x + 1200.0) - 600.0 + drift * t;',
'  float y = a_seed.y * (u_bounds.y + 400.0) - 200.0 + fall * t;',
'',
/* Stateless wrap, generous margins so a fast near drop never pops at an edge. */
'  x = mod(x + 600.0, u_bounds.x + 1200.0) - 600.0;',
'  y = mod(y + 200.0, u_bounds.y + 400.0) - 200.0;',
'',
/* THE STREAK. Length follows the drop's own velocity, which is what makes the
   blur read as speed rather than as a decorative dash. The vector is the
   actual velocity, so a drop blown sideways leans the way it is travelling —
   direction is a consequence of the physics, never randomised on its own. */
'  vec2 vel = vec2(drift, fall);',
'  float sp = length(vel);',
'  vec2 dir = sp > 0.001 ? vel / sp : vec2(0.0, 1.0);',
/* SIZE SPREAD. Widened hard so the depth layers are genuinely different
   objects rather than the same drop at slightly different scales. A far drop
   is a short thin scratch; a near one is a long fat streak several times its
   size. That contrast is most of what sells depth — a field of similar-sized
   drops reads flat no matter how they move. */
'  float len = clamp(sp * 0.030, 2.5, 220.0) * (0.16 + depth * depth * 2.1);',
'  float wid = a_var.z * (0.10 + depth * depth * 3.2);',
'',
'  vec2 side = vec2(-dir.y, dir.x);',
/* a_corner.y runs 0 at the tail to 1 at the head; the quad is built BEHIND the
   drop so the streak trails it. */
'  vec2 pos = vec2(x, y) - dir * len * a_corner.y + side * wid * a_corner.x;',
'',
'  vec2 clip = vec2( (pos.x / u_bounds.x) * 2.0 - 1.0,',
'                    1.0 - (pos.y / u_bounds.y) * 2.0 );',
'  gl_Position = vec4(clip, 0.0, 1.0);',
'',
/* Far drops are dimmer, and the whole field fades out as intensity drops so
   rain can taper to nothing instead of switching off. */
'  v_alpha = (0.10 + depth * 0.34) * smoothstep(0.0, 0.22, u_intensity);',
'  v_along = a_corner.y;',
'  v_depth = depth;',
'}'
].join('\n');

var FRAG = [
'#version 300 es',
'precision mediump float;',
'in float v_alpha;',
'in float v_along;',
'in float v_depth;',
'out vec4 fragColor;',
'void main(){',
/* Soft at both ends. A motion-blurred streak has no hard terminator; square
   ends are what made the canvas version look like scratches. The head is
   brighter and tighter than the tail, because that is where the drop was most
   recently. */
'  float head = smoothstep(0.0, 0.35, v_along);',
'  float tail = 1.0 - smoothstep(0.72, 1.0, v_along);',
'  float a = v_alpha * head * tail;',
/* Rain is not white. It is the sky refracted through water, so it takes a
   cold cast, and near drops carry more of it than far ones. */
'  vec3 tint = mix(vec3(0.62,0.70,0.86), vec3(0.86,0.92,1.0), v_depth);',
'  fragColor = vec4(tint, a);',
'}'
].join('\n');

function compile(gl,type,src){
  var sh=gl.createShader(type);
  gl.shaderSource(sh,src);gl.compileShader(sh);
  if(!gl.getShaderParameter(sh,gl.COMPILE_STATUS)){
    console.warn('GPU rain shader failed:',gl.getShaderInfoLog(sh));
    gl.deleteShader(sh);return null;
  }
  return sh;
}

function create(canvas,count){
  var gl=null;
  try{ gl=canvas.getContext('webgl2',{alpha:true,antialias:false,premultipliedAlpha:false}); }
  catch(e){ gl=null; }
  if(!gl)return null;                       // caller keeps its canvas path

  var vs=compile(gl,gl.VERTEX_SHADER,VERT);
  var fs=compile(gl,gl.FRAGMENT_SHADER,FRAG);
  if(!vs||!fs)return null;
  var prog=gl.createProgram();
  gl.attachShader(prog,vs);gl.attachShader(prog,fs);
  gl.linkProgram(prog);
  if(!gl.getProgramParameter(prog,gl.LINK_STATUS)){
    console.warn('GPU rain link failed:',gl.getProgramInfoLog(prog));
    return null;
  }

  /* ═══ FIELD CEILING 
     750,000 drops. The per-drop attribute block is 7 floats, so the VBO is
     750000 * 7 * 4 = 21 MB, uploaded ONCE and never touched again — well
     inside the VRAM budget of any GPU that supports WebGL 2 at all.

     Per frame the CPU cost is unchanged: five uniforms and one
     drawArraysInstanced. The GPU cost is 750k instances of a four-vertex
     quad with a branch-free vertex shader and a fragment shader that does two
     smoothsteps — geometry-bound, not fill-bound, because the streaks are a
     couple of pixels wide.

     This is the CEILING, not the working count. See setIntensity: a drizzle
     draws a small fraction of it. */
  var N=Math.max(64,count||750000);

  /* The unit quad, shared by every drop. Two triangles as a strip. */
  var quad=new Float32Array([-0.5,0, 0.5,0, -0.5,1, 0.5,1]);
  var qbo=gl.createBuffer();
  gl.bindBuffer(gl.ARRAY_BUFFER,qbo);
  gl.bufferData(gl.ARRAY_BUFFER,quad,gl.STATIC_DRAW);

  /* Per-drop attributes, generated once and never touched again. */
  var stride=7;                              // seed(4) + var(3)
  var data=new Float32Array(N*stride);
  for(var i=0;i<N;i++){
    var o=i*stride;
    data[o  ]=Math.random();                 // start x
    data[o+1]=Math.random();                 // start y
    data[o+2]=Math.random();                 // depth basis
    data[o+3]=Math.random();                 // time phase
    data[o+4]=420+Math.random()*520;         // fall speed px/s
    data[o+5]=(Math.random()-0.5)*70;        // own drift
    data[o+6]=0.7+Math.random()*1.6;         // thickness
  }
  var ibo=gl.createBuffer();
  gl.bindBuffer(gl.ARRAY_BUFFER,ibo);
  gl.bufferData(gl.ARRAY_BUFFER,data,gl.STATIC_DRAW);

  var vao=gl.createVertexArray();
  gl.bindVertexArray(vao);
  var B=Float32Array.BYTES_PER_ELEMENT;
  var cLoc=gl.getAttribLocation(prog,'a_corner');
  if(cLoc>=0){
    gl.bindBuffer(gl.ARRAY_BUFFER,qbo);
    gl.enableVertexAttribArray(cLoc);
    gl.vertexAttribPointer(cLoc,2,gl.FLOAT,false,0,0);
  }
  gl.bindBuffer(gl.ARRAY_BUFFER,ibo);
  function inst(name,size,off){
    var loc=gl.getAttribLocation(prog,name);
    if(loc<0)return;
    gl.enableVertexAttribArray(loc);
    gl.vertexAttribPointer(loc,size,gl.FLOAT,false,stride*B,off*B);
    gl.vertexAttribDivisor(loc,1);           // one value per DROP, not vertex
  }
  inst('a_seed',4,0);
  inst('a_var', 3,4);
  gl.bindVertexArray(null);

  var U={
    time:gl.getUniformLocation(prog,'u_time'),
    bounds:gl.getUniformLocation(prog,'u_bounds'),
    intensity:gl.getUniformLocation(prog,'u_intensity'),
    wind:gl.getUniformLocation(prog,'u_wind'),
    gust:gl.getUniformLocation(prog,'u_gust'),
    turb:gl.getUniformLocation(prog,'u_turb')
  };

  var st={
    active:N, intensity:0.5, target:0.5, wind:0, t:0, t0:0, sq:0,
    budget:1, density:1, turb:0.25
  };

  return {
    /* Drop COUNT, separate from intensity. Lets a weak machine thin the field
       without changing how heavy the weather looks. */
    setDensity:function(f){ st.density=Math.max(0,Math.min(1,f)); },
    /* 0 none .. 1 downpour. Set a target; draw() eases toward it. */
    setIntensity:function(v){ st.target=Math.max(0,Math.min(1,v||0)); },
    /* Hard ceiling on the fraction of the field that may be drawn, for weak
       hardware. Multiplies the intensity-derived count rather than replacing
       it, so a capped machine still shows the difference between drizzle and
       downpour — just less of both. */
    setBudget:function(f){ st.budget=Math.max(0.02,Math.min(1,f||1)); },
    setWind:function(x){ st.wind=x||0; },
    /* 0 calm .. 1 wild. Drives the chaotic lateral terms in the shader, so a
       stormy track's rain thrashes while a mild one falls almost straight. */
    setTurbulence:function(v){ st.turb=Math.max(0,Math.min(1,v||0)); },
    restart:function(){ st.t0=0; st.t=0; },
    resize:function(w,h){ canvas.width=w;canvas.height=h;gl.viewport(0,0,w,h); },
    draw:function(){
      /* Wall clock, not an accumulated dt — the same reasoning as gpusnow:
         an accumulator advances with CALL COUNT rather than real time, so a
         skipped frame freezes the field. */
      var nowS=(typeof performance!=='undefined'&&performance.now)
                 ?performance.now()/1000:Date.now()/1000;
      if(!st.t0)st.t0=nowS;
      st.t=nowS-st.t0;

      /* ═══ RANDOM INTENSITY 
         Real rain is not steady. It arrives in squalls: it thickens, holds,
         eases off, and picks up again over tens of seconds, and that variation
         is a large part of why it reads as weather rather than as an effect
         that has been switched on.

         Three sine terms at deliberately non-harmonic periods (roughly 23s,
         9s and 3.7s). Non-harmonic matters: harmonic periods re-align and the
         pattern audibly repeats, whereas these three never return to the same
         phase relationship within any session length. The result is squared,
         which biases toward the lighter end and makes heavy bursts occasional
         rather than the average.

         The band is centred on whatever the caller asked for, so a track set
         to light drizzle varies within drizzle rather than becoming a storm. */
      var squall=(Math.sin(st.t*0.273)*0.5
                 +Math.sin(st.t*0.694+1.7)*0.32
                 +Math.sin(st.t*1.687+4.1)*0.18);
      squall=squall*0.5+0.5;                 // -1..1 -> 0..1
      st.sq=squall*squall;
      var want=Math.max(0,Math.min(1,st.target*(0.45+st.sq*1.05)));
      /* Eased, never snapped: rain that changes weight in one frame reads as
         a bug. Roughly a two second constant. */
      st.intensity+=(want-st.intensity)*0.012;

      /* ═══ DROP COUNT FOLLOWS INTENSITY, CUBICALLY 
         Perceived rainfall is roughly the CUBE of visual intensity: going from
         drizzle to downpour is not twice as many drops, it is orders of
         magnitude. A linear map spends most of the budget on light rain, where
         it is wasted, and leaves nothing extra for the storm that needs it.

         Cubed, with a floor so the lightest rain is still a coherent field
         rather than a handful of strays:

           intensity 0.05 (mist)      ~  3,800 drops
           intensity 0.30 (light)     ~ 23,000
           intensity 0.60 (steady)    ~166,000
           intensity 1.00 (downpour)   750,000

         Multiplied by the caller's density (quality scalar) and the budget cap
         so a weak GPU scales the whole curve down without losing the contrast
         between light and heavy. */
      var frac=Math.max(0.005,st.intensity*st.intensity*st.intensity);
      st.active=Math.max(64,Math.min(N,
        Math.round(N*frac*st.density*st.budget)));

      gl.viewport(0,0,canvas.width,canvas.height);
      gl.clearColor(0,0,0,0);
      gl.clear(gl.COLOR_BUFFER_BIT);
      gl.enable(gl.BLEND);
      gl.blendFunc(gl.SRC_ALPHA,gl.ONE_MINUS_SRC_ALPHA);
      gl.useProgram(prog);
      gl.bindVertexArray(vao);
      gl.uniform1f(U.time,st.t);
      gl.uniform2f(U.bounds,canvas.width,canvas.height);
      gl.uniform1f(U.intensity,st.intensity);
      gl.uniform1f(U.wind,st.wind);
      /* Gusts move the whole field together, so a squall arrives as one body
         of air rather than as drops each wandering independently. */
      gl.uniform1f(U.turb,st.turb);
      /* Gust magnitude also grows with turbulence, so a squall on a stormy
         track arrives as a hard shove and on a calm one as a gentle lean. */
      gl.uniform1f(U.gust,
        Math.sin(st.t*0.41)*0.6+Math.sin(st.t*0.17+2.3)*0.4);
      /* THE ENTIRE FIELD IN ONE CALL. */
      gl.drawArraysInstanced(gl.TRIANGLE_STRIP,0,4,st.active);
      gl.bindVertexArray(null);
    },
    stats:function(){
      return {max:N,active:st.active,turb:+st.turb.toFixed(3),
              intensity:+st.intensity.toFixed(3),
              squall:+st.sq.toFixed(3),drawCalls:1};
    },
    destroy:function(){
      try{
        gl.deleteBuffer(qbo);gl.deleteBuffer(ibo);
        gl.deleteVertexArray(vao);gl.deleteProgram(prog);
      }catch(e){}
    }
  };
}

global.GPURain={create:create,VERT:VERT,FRAG:FRAG};

})(typeof window!=='undefined'?window:globalThis);


/* 
   GPU SANDSTORM   (was gpusand.js)
   ---------------------------------------------------------------------------
   Three particle classes (fine dust 90%, grains 9%, debris 1%) with per-particle
   curl-like turbulence and a ground saltation sheet. Tuned for storms rather
   than being rain in a different colour.
    */
/* 
   GPU SAND — WebGL 2.0 sandstorm pipeline
   ---------------------------------------------------------------------------
   Same stateless architecture as gpusnow.js and gpurain.js: per-particle
   attributes uploaded once, position derived in the vertex shader from
   `u_time`, one instanced draw call per frame regardless of particle count.

   WHY THIS IS NOT JUST RAIN IN BROWN
   Rain reads as rain because every drop does the same thing. A sandstorm reads
   as a storm because almost nothing does:

   * THREE SIZE CLASSES, not one. Fine dust (90%) is small, slow, barely
     visible individually and forms the atmospheric body of the storm. Sand
     grains (9%) are faster and sharper. Debris (1%) is large, tumbling and
     largely ignores the turbulence that throws the dust around. The class is
     derived from the particle's own seed, so it costs nothing per frame.

   * CURL-LIKE TURBULENCE, not a shared gust. Each particle samples a cheap
     value-noise field at its OWN position and time, so neighbouring particles
     diverge and the field swirls. A single shared gust term — which is what
     the snow layer uses, correctly, for snow — moves everything together and
     reads as a sheet sliding sideways.

   * SALTATION. Real sand bounces along the ground rather than falling through
     the air uniformly. Density is boosted near the ground line and those
     particles are given a strong horizontal bias, which is what produces the
     low streaking sheet a storm has and rain does not.

   * VELOCITY STRETCHING. Particles are quads stretched along their own
     velocity vector, so a fast grain is a streak and a drifting dust mote is
     a dot — motion blur that follows the physics instead of a fixed shape.

   * DENSITY-VARYING OPACITY. Opacity is modulated by a low-frequency noise
     term so the storm forms dense clots separated by clearer patches, rather
     than a homogeneous haze at one alpha.

   Mie-style forward scattering is approximated rather than integrated: the
   tint warms toward the sun direction and darkens away from it, which is the
   visible consequence of forward scattering without a volumetric raymarch.
   A full depth-buffer soft-particle pass is deliberately not attempted — this
   layer composites over a 2D canvas and has no scene depth to compare against.
    */

(function(global){
'use strict';

var VERT = [
'#version 300 es',
'precision highp float;',
'in vec2 a_corner;        // unit quad, x -0.5..0.5, y 0..1 along the streak',
'in vec4 a_seed;          // x,y start | class basis | phase',
'in vec3 a_var;           // base speed | drift | size',
'',
'uniform float u_time;',
'uniform vec2  u_bounds;',
'uniform float u_intensity;   // 0 calm .. 1 full storm',
'uniform float u_wind;        // steady wind, px/s',
'uniform float u_gust;        // slow shared surge, -1..1',
'uniform float u_ground;      // ground line, 0 top .. 1 bottom of viewport',
'uniform float u_sun;         // sun x position, 0..1, for the warm bias',
'',
'out float v_alpha;',
'out float v_along;',
'out float v_warm;',
'out float v_grit;',
'',
/* Cheap 2D value noise. A full simplex implementation is more than this needs:
   the field only has to be smooth and non-repeating over the few seconds a
   particle is on screen. */
'float h21(vec2 p){',
'  return fract(sin(dot(p, vec2(127.1, 311.7))) * 43758.5453);',
'}',
'float vnoise(vec2 p){',
'  vec2 i = floor(p), f = fract(p);',
'  f = f*f*(3.0-2.0*f);',
'  float a = h21(i), b = h21(i+vec2(1,0));',
'  float c = h21(i+vec2(0,1)), d = h21(i+vec2(1,1));',
'  return mix(mix(a,b,f.x), mix(c,d,f.x), f.y);',
'}',
'',
'void main(){',
/* CLASS. Cubed so the distribution is heavily weighted to fine dust: about
   90% below 0.55, 9% grains, 1% debris. */
'  float cb = a_seed.z;',
'  float klass = cb*cb*cb;              // 0 dust .. 1 debris',
'  float depth = 0.20 + a_seed.w * 0.80;',
'',
/* SALTATION. Particles seeded low are pulled lower still and biased sideways,
   which concentrates them into a fast ground sheet. */
'  float lowBias = smoothstep(0.55, 1.0, a_seed.y);',
'',
'  float t = u_time + a_seed.w * 40.0;',
'',
/* Base drift: everything moves with the wind, scaled by depth and by class —
   debris is heavy and lags, dust is carried. */
'  float carry = mix(1.25, 0.45, klass);',
'  float vx = (u_wind + a_var.y) * depth * carry * (0.5 + u_intensity * 1.4)',
'           + u_gust * 180.0 * depth * carry',
'           + lowBias * u_wind * 0.9;',
/* Debris falls; dust barely does. */
'  float vy = a_var.x * mix(0.10, 1.30, klass) * (0.4 + u_intensity * 0.9)',
'           + lowBias * 40.0;',
'',
'  float x = a_seed.x * (u_bounds.x + 1400.0) - 700.0 + vx * t;',
'  float y = a_seed.y * (u_bounds.y + 400.0) - 200.0 + vy * t;',
'',
/* TURBULENCE. Sampled at the particle's own position, so the field swirls
   instead of translating. Dust is thrown hard, debris almost not at all. */
'  float turbAmt = mix(1.4, 0.18, klass) * u_intensity;',
'  vec2 np = vec2(x, y) * 0.0016;',
'  float n1 = vnoise(np + vec2(t * 0.22, 0.0)) - 0.5;',
'  float n2 = vnoise(np * 2.7 + vec2(0.0, t * 0.30)) - 0.5;',
'  x += (n1 * 340.0 + n2 * 130.0) * turbAmt * depth;',
'  y += (n2 * 200.0 - n1 * 90.0) * turbAmt * depth;',
'',
'  x = mod(x + 700.0, u_bounds.x + 1400.0) - 700.0;',
'  y = mod(y + 200.0, u_bounds.y + 400.0) - 200.0;',
'',
/* VELOCITY STRETCH. Length follows actual speed, so the same particle is a dot
   when drifting and a streak when the gust takes it. */
'  vec2 vel = vec2(vx + n1 * 300.0 * turbAmt, vy);',
'  float sp = length(vel);',
'  vec2 dir = sp > 0.001 ? vel / sp : vec2(1.0, 0.0);',
'  float base = a_var.z * mix(0.04, 0.30, klass) * (0.35 + depth * 1.5);',
'  float len = base * (1.0 + sp * 0.014);',
'  float wid = base * 0.55;',
'  vec2 side = vec2(-dir.y, dir.x);',
'  vec2 pos = vec2(x, y) - dir * len * a_corner.y + side * wid * a_corner.x;',
'',
'  vec2 clip = vec2((pos.x / u_bounds.x) * 2.0 - 1.0,',
'                   1.0 - (pos.y / u_bounds.y) * 2.0);',
'  gl_Position = vec4(clip, 0.0, 1.0);',
'',
/* DENSITY CLOTS. A slow, large-scale noise term gates opacity so the storm has
   thick and thin regions rather than one uniform veil. */
'  float clot = vnoise(vec2(x, y) * 0.0006 + vec2(t * 0.05, t * 0.03));',
'  float dens = mix(0.45, 1.35, clot);',
'',
/* Dust is faint individually and gets its presence from sheer count; debris is
   solid. Everything fades out with intensity so a storm can taper away. */
'  float aBase = mix(0.055, 0.62, klass);',
'  v_alpha = aBase * dens * (0.25 + depth * 0.85)',
'          * smoothstep(0.0, 0.18, u_intensity);',
/* Ground sheet is denser and more opaque. */
'  v_alpha *= (1.0 + lowBias * 0.9);',
'',
/* Forward scattering: particles between the viewer and the sun glow. */
'  v_warm = 1.0 - clamp(abs((x / u_bounds.x) - u_sun) * 1.6, 0.0, 1.0);',
'  v_along = a_corner.y;',
'  v_grit  = klass;',
'}'
].join('\n');

var FRAG = [
'#version 300 es',
'precision mediump float;',
'in float v_alpha;',
'in float v_along;',
'in float v_warm;',
'in float v_grit;',
'out vec4 fragColor;',
'void main(){',
/* Soft along the streak, as with rain: a hard-ended particle reads as a
   scratch. Dust is softer than debris, which has a defined edge. */
'  float soft = mix(0.45, 0.05, v_grit);',
'  float head = smoothstep(0.0, soft + 0.02, v_along);',
'  float tail = 1.0 - smoothstep(1.0 - soft - 0.02, 1.0, v_along);',
'  float a = v_alpha * head * tail;',
'  if (a < 0.002) discard;',
/* Palette: pale ochre dust through to dark umber debris, warmed toward the
   sun. Self-shadowing is approximated by darkening the heavier classes, which
   are the ones that would sit inside a dense clot. */
'  vec3 dust   = vec3(0.86, 0.72, 0.48);',
'  vec3 heavy  = vec3(0.44, 0.31, 0.17);',
'  vec3 tint   = mix(dust, heavy, v_grit);',
'  vec3 sunlit = vec3(1.00, 0.82, 0.46);',
'  tint = mix(tint, sunlit, v_warm * 0.55);',
'  fragColor = vec4(tint, a);',
'}'
].join('\n');

function compile(gl,type,src){
  var sh=gl.createShader(type);
  gl.shaderSource(sh,src);gl.compileShader(sh);
  if(!gl.getShaderParameter(sh,gl.COMPILE_STATUS)){
    console.warn('GPU sand shader failed:',gl.getShaderInfoLog(sh));
    gl.deleteShader(sh);return null;
  }
  return sh;
}

function create(canvas,count){
  var gl=null;
  try{ gl=canvas.getContext('webgl2',{alpha:true,antialias:false,premultipliedAlpha:false}); }
  catch(e){ gl=null; }
  if(!gl)return null;

  var vs=compile(gl,gl.VERTEX_SHADER,VERT);
  var fs=compile(gl,gl.FRAGMENT_SHADER,FRAG);
  if(!vs||!fs)return null;
  var prog=gl.createProgram();
  gl.attachShader(prog,vs);gl.attachShader(prog,fs);
  gl.linkProgram(prog);
  if(!gl.getProgramParameter(prog,gl.LINK_STATUS)){
    console.warn('GPU sand link failed:',gl.getProgramInfoLog(prog));
    return null;
  }

  /* Fewer than rain: sand particles are larger on average and the fine dust
     gets its body from opacity stacking rather than from raw count. */
  var N=Math.max(64,count||420000);

  var quad=new Float32Array([-0.5,0, 0.5,0, -0.5,1, 0.5,1]);
  var qbo=gl.createBuffer();
  gl.bindBuffer(gl.ARRAY_BUFFER,qbo);
  gl.bufferData(gl.ARRAY_BUFFER,quad,gl.STATIC_DRAW);

  var stride=7;                          // seed(4) + var(3)
  var data=new Float32Array(N*stride);
  for(var i=0;i<N;i++){
    var o=i*stride;
    data[o  ]=Math.random();             // start x, across the wrap domain
    data[o+1]=Math.random();             // start y — high values become the
                                         //   ground sheet via lowBias
    data[o+2]=Math.random();             // class basis (cubed in the shader)
    data[o+3]=Math.random();             // depth + phase
    data[o+4]=30+Math.random()*180;      // base fall speed
    data[o+5]=(Math.random()-0.5)*120;   // own lateral drift
    data[o+6]=0.8+Math.random()*2.4;     // size
  }
  var ibo=gl.createBuffer();
  gl.bindBuffer(gl.ARRAY_BUFFER,ibo);
  gl.bufferData(gl.ARRAY_BUFFER,data,gl.STATIC_DRAW);

  var vao=gl.createVertexArray();
  gl.bindVertexArray(vao);
  var B=Float32Array.BYTES_PER_ELEMENT;
  var cLoc=gl.getAttribLocation(prog,'a_corner');
  if(cLoc>=0){
    gl.bindBuffer(gl.ARRAY_BUFFER,qbo);
    gl.enableVertexAttribArray(cLoc);
    gl.vertexAttribPointer(cLoc,2,gl.FLOAT,false,0,0);
  }
  gl.bindBuffer(gl.ARRAY_BUFFER,ibo);
  function inst(name,size,off){
    var loc=gl.getAttribLocation(prog,name);
    if(loc<0)return;
    gl.enableVertexAttribArray(loc);
    gl.vertexAttribPointer(loc,size,gl.FLOAT,false,stride*B,off*B);
    gl.vertexAttribDivisor(loc,1);
  }
  inst('a_seed',4,0);
  inst('a_var', 3,4);
  gl.bindVertexArray(null);

  var U={
    time:gl.getUniformLocation(prog,'u_time'),
    bounds:gl.getUniformLocation(prog,'u_bounds'),
    intensity:gl.getUniformLocation(prog,'u_intensity'),
    wind:gl.getUniformLocation(prog,'u_wind'),
    gust:gl.getUniformLocation(prog,'u_gust'),
    ground:gl.getUniformLocation(prog,'u_ground'),
    sun:gl.getUniformLocation(prog,'u_sun')
  };

  var st={active:N, intensity:0.4, target:0.4, wind:-260,
          t:0, t0:0, sq:0, budget:1, density:1, ground:0.62, sun:0.5, turb:0.5};

  return {
    setDensity:function(f){ st.density=Math.max(0,Math.min(1,f)); },
    setBudget:function(f){ st.budget=Math.max(0.02,Math.min(1,f||1)); },
    /* 0 haze .. 1 full sandstorm. */
    setIntensity:function(v){ st.target=Math.max(0,Math.min(1,v||0)); },
    setWind:function(x){ st.wind=(x==null?-260:x); },
    /* Turbulence 0..1 — scales how violently the wind gusts swirl the sand.
       Stored in st.turb and applied as a gust-amplitude multiplier in draw().
       Matches the GPURain API so callers can treat both layers identically. */
    setTurbulence:function(v){ st.turb=Math.max(0,Math.min(1,v==null?0.5:v)); },
    /* Where the ground sits, so the saltation sheet lands on the road rather
       than floating. */
    setGround:function(g){ st.ground=Math.max(0,Math.min(1,g||0.62)); },
    /* Sun x in 0..1, for the forward-scatter warm bias. */
    setSun:function(x){ st.sun=Math.max(0,Math.min(1,x==null?0.5:x)); },
    restart:function(){ st.t0=0; st.t=0; },
    resize:function(w,h){ canvas.width=w;canvas.height=h;gl.viewport(0,0,w,h); },
    draw:function(){
      var nowS=(typeof performance!=='undefined'&&performance.now)
                 ?performance.now()/1000:Date.now()/1000;
      if(!st.t0)st.t0=nowS;
      st.t=nowS-st.t0;

      /* ═══ STORM CELLS 
         A sandstorm arrives in fronts. Four non-harmonic terms over periods of
         roughly 41s, 17s, 7s and 2.6s give an intensity that surges and lulls
         across all of those scales at once, so a wall of sand can roll through
         and then thin out without the pattern ever repeating.

         Raised to the 1.6 power rather than squared: sand hangs in the air far
         longer than rain falls, so the lulls should not go as close to zero. */
      var cell=(Math.sin(st.t*0.153)*0.42
               +Math.sin(st.t*0.369+1.3)*0.28
               +Math.sin(st.t*0.897+3.1)*0.19
               +Math.sin(st.t*2.417+0.7)*0.11);
      cell=cell*0.5+0.5;
      st.sq=Math.pow(cell,1.6);
      var want=Math.max(0,Math.min(1,st.target*(0.40+st.sq*1.15)));
      /* Rise faster than it falls. At a flat 0.010 it took about seven seconds
         to reach steady state, so driving into a desert showed almost nothing
         for the first several seconds and the storm only appeared once the
         player had stopped looking for it. Gusts should arrive quickly and
         settle slowly — that is also how wind actually behaves. */
      st.intensity+=(want-st.intensity)*(want>st.intensity?0.045:0.010);

      /* Count follows intensity on a 1.75 power, NOT cubed.
         Cubing is right for rain, where a drizzle genuinely is a few sparse
         drops. Suspended dust is the opposite: its whole character is a
         continuous haze, and cubing collapsed the common case into nothing.
         A calm desert asks for intensity ~0.24, which cubed is 0.0138 — about
         500 particles out of 420,000 once density and budget scaling are
         applied, i.e. invisible. At 1.75 the same request yields ~0.086.
         The exponent only lifts the LOW and MID range: at full intensity both
         curves give 1.0, so the worst-case particle count and therefore the
         peak GPU cost are completely unchanged. */
      var frac=Math.max(0.004,Math.pow(st.intensity,1.75));
      st.active=Math.max(64,Math.min(N,
        Math.round(N*frac*st.density*st.budget)));

      gl.viewport(0,0,canvas.width,canvas.height);
      gl.clearColor(0,0,0,0);
      gl.clear(gl.COLOR_BUFFER_BIT);
      gl.enable(gl.BLEND);
      gl.blendFunc(gl.SRC_ALPHA,gl.ONE_MINUS_SRC_ALPHA);
      gl.useProgram(prog);
      gl.bindVertexArray(vao);
      gl.uniform1f(U.time,st.t);
      gl.uniform2f(U.bounds,canvas.width,canvas.height);
      gl.uniform1f(U.intensity,st.intensity);
      gl.uniform1f(U.wind,st.wind);
      gl.uniform1f(U.ground,st.ground);
      gl.uniform1f(U.sun,st.sun);
      gl.uniform1f(U.gust,
        (Math.sin(st.t*0.29)*0.55+Math.sin(st.t*0.11+2.1)*0.45)*st.turb);
      gl.drawArraysInstanced(gl.TRIANGLE_STRIP,0,4,st.active);
      gl.bindVertexArray(null);
    },
    stats:function(){
      return {max:N,active:st.active,
              intensity:+st.intensity.toFixed(3),turb:+st.turb.toFixed(3),
              squall:+st.sq.toFixed(3),drawCalls:1};
    },
    destroy:function(){
      try{
        gl.deleteBuffer(qbo);gl.deleteBuffer(ibo);
        gl.deleteVertexArray(vao);gl.deleteProgram(prog);
      }catch(e){}
    }
  };
}

global.GPUSand={create:create,VERT:VERT,FRAG:FRAG};

})(typeof window!=='undefined'?window:globalThis);


/* 
   PROCEDURAL MOUNTAIN RANGES   (was mountain.js)
   ---------------------------------------------------------------------------
   Four noise-generated ranges baked once per track into offscreen strips, then
   drawn as two drawImage calls per layer (the second covers the horizontal
   wrap). Adapted from procedural_mountains.html; snow caps removed.
    */
/* 
   PROCEDURAL MOUNTAINS — backdrop ranges for the racing engine
   ---------------------------------------------------------------------------
   Adapted from procedural_mountains.html. The generation maths (value-noise
   hash, six-octave fBm, the shape/peak curve) is carried over intact; what
   changed is everything around it, because a standalone PNG exporter and a
   scrolling game backdrop have different requirements.

   WHAT WAS CHANGED AND WHY

   * Snow removed entirely. `snowLine()` and both snow options are gone, as
     requested — the ranges are silhouettes now.

   * BAKED ONCE, NOT PER FRAME. The original generates a full scene on every
     call. Six octaves of noise across ~600 points per range is far too much to
     run 60 times a second, so each range is rendered once into an offscreen
     canvas at track build time and afterwards is a single drawImage per layer.

   * HORIZONTALLY SEAMLESS. The original draws a fixed-width panorama; a
     backdrop that scrolls has to wrap. The noise is sampled on a CIRCLE rather
     than a line — x maps to an angle, so the last sample is the first sample
     and the tile joins itself with no seam. That is the one substantive change
     to the generation maths and it is unavoidable for a scrolling background.

   * HORIZON ALIGNMENT. The generator measures `horizon` as a fraction of its
     own image height. The engine's horizon is a fraction of the VIEWPORT, and
     the two only agree by accident. Each strip is baked so that its horizon
     line sits at a known offset from the bottom of the strip, and the caller
     draws the strip with that line placed on the engine's horizon. That way a
     range meets the ground exactly where the road converges, at any viewport
     size, and the alignment does not depend on the strip's own dimensions.

   * PALETTE FROM THE TRACK. Colours are supplied by the caller so a range
     picks up the biome hue and the night/day state, instead of the fixed blue
     mountain palette the standalone tool uses.
    */

(function(global){
'use strict';

/* ── Noise: unchanged from the source, other than being seed-parameterised
      rather than reading an instance field.  */
function makeNoise(seed){
  function hash(x){
    var n = x + seed * 374761393;
    n = (n ^ (n >>> 13)) * 1274126177;
    n = n ^ (n >>> 16);
    return (n >>> 0) / 4294967295;
  }
  function smooth(t){ return t*t*(3-2*t); }
  function noise1D(x){
    var x0 = Math.floor(x), x1 = x0 + 1;
    var r0 = hash(x0), r1 = hash(x1);
    var t = smooth(x - x0);
    return r0 + (r1 - r0) * t;
  }
  /* Six octaves, same weights as the original. */
  function fbm(x, scale){
    var value=0, amp=1, freq=1, total=0;
    for(var i=0;i<6;i++){
      value += noise1D(x*freq*(scale||1))*amp;
      total += amp;
      freq *= 2;
      amp  *= 0.5;
    }
    return value/total;
  }
  return fbm;
}

/* ── One range of peaks, as a seamless height profile 
   Returns heights in 0..1. `depth` scales the peaks so far ranges are lower,
   exactly as the original's `depth` parameter does.

   The circular sampling is the seam fix: instead of feeding x directly to the
   noise, x becomes an angle and the sample point is a position on a circle of
   circumference `period`. A full lap around the circle returns to the start,
   so profile[0] and profile[n-1] are the same height by construction rather
   than by luck. */
function heightProfile(fbm, count, depth, offset, period){
  var out = new Float32Array(count);
  for(var i=0;i<count;i++){
    var a = (i/(count-1)) * Math.PI * 2;
    var cx = Math.cos(a)*period, cy = Math.sin(a)*period;
    /* Three bands, same weights and exponent as the original. The second
       coordinate is folded in so the two halves of the circle cannot mirror
       each other, which a purely radial sample would make them do. */
    var large  = fbm(cx*0.16 + cy*0.05 + depth*37 + offset, 0.7);
    var medium = fbm(cx*0.44 + cy*0.13 + depth*73 + offset, 0.9);
    var fine   = fbm(cx*1.52 + cy*0.41 + depth*113 + offset, 1.0);

    var shape = large*0.68 + medium*0.24 + fine*0.08;
    shape = Math.pow(shape, 1.65);

    /* Peak boost — the original's dramatic-summit rule, kept as is. */
    var peak = fbm(cx*0.10 + cy*0.03 + depth*91 + offset, 1);
    if(peak > 0.72) shape += (peak - 0.72) * 2.5;

    /* Clamp AFTER the depth scale, not before. Clamping the raw shape first
       and then multiplying meant a near range (depth > 1) could end up LOWER
       on average than a mid one, because the clamp had already flattened its
       tallest peaks before depth was applied — measured, depth 1.22 came out
       shorter than depth 1.0, so the nearest ridge sat behind the one it was
       supposed to be in front of. */
    out[i] = Math.min(1, shape * depth);
  }
  return out;
}

/* ── Bake one range into a strip 
   `horizonFromBottom` is how far above the strip's bottom edge the horizon
   line sits. The caller uses the same number to place the strip, which is what
   keeps the range welded to the road's vanishing point. */
function bakeRange(opts){
  var w = Math.max(64, opts.width|0);
  var h = Math.max(32, opts.height|0);
  var cv, ctx;
  try{
    cv = document.createElement('canvas');
    cv.width = w; cv.height = h;
    ctx = cv.getContext('2d');
  }catch(e){ return null; }
  if(!ctx) return null;

  var fbm = makeNoise(opts.seed|0);
  /* One point every 4px, as the original. Fewer looks polygonal on a wide
     strip; more costs bake time for detail below a pixel. */
  var count = Math.ceil(w/4)+1;
  var prof = heightProfile(fbm, count, opts.depth, opts.offset||0, opts.period||6);

  var horizonY = h - (opts.horizonFromBottom||0);
  var maxH = opts.peakHeight;

  /* ═══ THE SEAM 
     The height profile wraps exactly — verified, first and last samples are
     bit-identical. But the SILHOUETTE is a filled polygon whose outer vertices
     land on x=0 and x=w, and two strips drawn w apart share that column. The
     canvas antialiases each edge to roughly half coverage, so the two halves
     do not add back to one and the sky shows through as a pale vertical line.

     Overdrawing by a pixel on each side fixes it: the polygon is built from
     -1 to w+1 so the fill is fully opaque across the whole strip width and the
     join is covered by solid pixels from both neighbours. The extra column
     repeats the wrapped profile, so nothing is distorted — it is the same
     terrain, drawn slightly wider than it is sampled. */
  var OVER = 1;
  ctx.beginPath();
  ctx.moveTo(-OVER, h);
  ctx.lineTo(-OVER, horizonY - prof[count-2]*maxH);
  for(var i=0;i<count;i++){
    var x = (i/(count-1))*w;
    ctx.lineTo(x, horizonY - prof[i]*maxH);
  }
  ctx.lineTo(w+OVER, horizonY - prof[1]*maxH);
  ctx.lineTo(w+OVER, h);
  ctx.closePath();
  ctx.fillStyle = opts.color;
  ctx.fill();

  /* Shading facets. The original's detail pass, kept because it is what stops
     a silhouette reading as a flat cut-out, but only on the near ranges — on a
     distant one it is invisible and costs bake time for nothing. */
  if(opts.detailOpacity > 0){
    ctx.globalAlpha = opts.detailOpacity;
    ctx.fillStyle = opts.shadeColor || '#000';
    for(var j=1;j<count-1;j+=2){
      if(prof[j] < 0.25) continue;
      var xa=(j/(count-1))*w, xb=((j+1)/(count-1))*w;
      var ya=horizonY-prof[j]*maxH, yb=horizonY-prof[j+1]*maxH;
      ctx.beginPath();
      ctx.moveTo(xa,ya);
      ctx.lineTo(xb, yb + Math.abs(yb-ya)*0.5);
      ctx.lineTo(xb,h);
      ctx.lineTo(xa,h);
      ctx.closePath();
      ctx.fill();
    }
    ctx.globalAlpha = 1;
  }

  return {canvas:cv, width:w, height:h, horizonFromBottom:(opts.horizonFromBottom||0)};
}

/* ── Public: build the full set of ranges for a track 
   Four layers to match the parallax rates the engine already uses. Depths and
   colours run from far and pale to near and dark, which is the aerial
   perspective the original scene builds by hand. */
function build(cfg){
  var seed   = (cfg.seed|0);
  var vw     = Math.max(320, cfg.viewW|0);
  var vh     = Math.max(240, cfg.viewH|0);
  var night  = !!cfg.night;
  var hue    = (cfg.hue==null?210:cfg.hue);

  /* Strip is wider than the viewport so one wrap covers a full scroll without
     the join ever being on screen twice. */
  var stripW = Math.round(vw*1.6);
  /* Peak height is expressed against the VIEWPORT, not the strip, so a range
     is the same size on screen whatever strip dimensions are chosen. */
  var peakBase = vh * (cfg.mountainHeight==null?0.30:cfg.mountainHeight);
  var stripH = Math.ceil(peakBase*1.25) + 40;
  var hfb = 24;                       // horizon sits 24px above the strip base

  function col(l,s){ 
    return 'hsl('+((hue%360+360)%360)+','+s+'%,'+l+'%)';
  }

  /* ── LAYER COUNT: 3-30, DRIVEN BY THE SEED ─────────────────────────────
     This was a hardcoded array of exactly four ranges, so every track in the
     game had a backdrop of identical depth however different its terrain.
     The count is now derived from the seed, and the per-layer properties are
     interpolated across whatever count comes out rather than being written
     out by hand — depth, scroll rate and colour all remain continuous, so a
     30-layer backdrop reads as genuine aerial perspective rather than as the
     4-layer one repeated.

     cfg.layers lets the caller ask for a specific count (the track generator
     does); without it the seed decides. Distribution is deliberately skewed
     toward the lower half: a 30-layer range is a spectacle precisely because
     it is rare, and every layer costs a baked strip and a draw call. */
  var _lr = (function(s){                    // small independent PRNG
    s=(s^0x9e3779b9)>>>0;
    return function(){ s^=s<<13;s>>>=0; s^=s>>17; s^=s<<5;s>>>=0; return s/4294967296; };
  })(seed+0x5f3759df);
  var nL;
  if(cfg.layers!=null){
    nL = Math.max(3, Math.min(30, cfg.layers|0));
  } else {
    var _roll=_lr();
    nL = (_roll<0.62) ? (3+Math.floor(_lr()*5))      // 3-7   common
       : (_roll<0.90) ? (8+Math.floor(_lr()*8))      // 8-15  occasional
       :                (16+Math.floor(_lr()*15));   // 16-30 rare
  }

  var layers = [];
  for(var _i=0;_i<nL;_i++){
    /* t spans 0..1 from the most distant range to the nearest. With nL=4 the
       endpoints and spacing reproduce the original four almost exactly, so
       existing tracks are not visually reshuffled by this change. */
    var t = (nL===1) ? 0 : _i/(nL-1);
    layers.push({
      depth: 0.55 + t*0.67,
      /* Offsets must not fall on a regular grid or the ridges line up into
         visible vertical banding. Prime-ish stride plus jitter keeps each
         range's noise field independent. */
      offset: 17 + Math.round(t*134) + Math.round(_lr()*23),
      rate: 0.10 + t*0.26,
      color: night ? col(6+t*7, 26+t*4) : col(58-t*33, 16+t*14),
      /* Distant ranges stay flat silhouettes; detail fades in with proximity. */
      detailOpacity: (t<0.20) ? 0 : (night ? (0.06+t*0.06) : (0.08+t*0.10))
    });
  }

  var out=[];
  for(var i=0;i<layers.length;i++){
    var L=layers[i];
    var baked = bakeRange({
      seed: seed + i*7919,
      width: stripW,
      height: stripH,
      depth: L.depth,
      offset: L.offset,
      peakHeight: peakBase,
      horizonFromBottom: hfb,
      color: L.color,
      shadeColor: night?'#05070c':'#202832',
      detailOpacity: L.detailOpacity,
      period: 6 + i*1.7
    });
    if(!baked) return null;
    baked.rate = L.rate;
    out.push(baked);
  }
  return {layers:out, seed:seed, viewW:vw, viewH:vh};
}

/* ── Draw one frame 
   `horizonY` is the engine's own horizon in screen pixels; each strip is
   positioned so its baked horizon line lands exactly there. `shift` is the
   parallax offset in pixels, already scaled by the caller.

   Two draws per layer, offset by one strip width, so the wrap is covered
   without a conditional — cheaper than testing whether a seam is on screen and
   impossible to get wrong at the edges. */
function draw(ctx, set, horizonY, shift, alpha){
  if(!set) return;
  for(var i=0;i<set.layers.length;i++){
    var L=set.layers[i];
    /* Rounded to whole pixels. A fractional x makes the browser resample the
       strip, which softens the silhouette AND smears the join across two
       columns instead of one — so a sub-pixel offset reintroduces the seam the
       overdraw above removes. */
    var x=Math.round(-(((shift*L.rate)%L.width)+L.width)%L.width);
    var y=Math.round(horizonY-(L.height-L.horizonFromBottom));
    if(alpha!=null&&alpha!==1){ ctx.save(); ctx.globalAlpha=alpha; }
    ctx.drawImage(L.canvas, x, y);
    ctx.drawImage(L.canvas, x+L.width, y);
    if(alpha!=null&&alpha!==1) ctx.restore();
  }
}

global.Mountains={build:build, draw:draw, layerCount:function(m){return (m&&m.layers&&m.layers.length)|0;}, _bakeRange:bakeRange, _heightProfile:heightProfile, _makeNoise:makeNoise};

})(typeof window!=='undefined'?window:globalThis);


/* 
   FLUID SIMULATION   (was water.js)
   ---------------------------------------------------------------------------
   The largest module here. Consumes FX_DITHER_PNG above for its final blit.
    */
/* 
   water.js — WebGL fluid effect for ZONE STORM RACING GX
   ---------------------------------------------------------------------------
   Based on Pavel Dobryakov's WebGL-Fluid-Simulation (MIT, 2017). The solver is
   unchanged; what has been rebuilt around it is the interface.

   WHAT WAS REMOVED, AND WHY
   dat.GUI was used in exactly ONE function — startGUI() — which built a
   developer control panel with sliders for the simulation constants. Nothing
   else in the file referenced it. The game drives those constants from the
   track generator rather than from a mouse-driven DOM panel, and that panel
   would clash with the controller-first UI, so both startGUI() and the dat.GUI
   dependency are gone. The library is NOT needed.

   WHAT CHANGED
   The original was a page-level demo: it grabbed the first <canvas> in the
   document, bound its own pointer listeners, and ran a global loop. All three
   are wrong inside a game. Water.create() now takes a canvas, returns an
   instance, and exposes:

     splat(x,y,dx,dy,[color])   inject dye and velocity at a point (0..1 space)
     autoOval(t, opts)          drive the fluid along an oval path with no input
     setPalette(name)           'water' | 'aurora' | 'fire' | 'ice' | 'random'
     tint(r,g,b)                force a single dye colour
     resize(), step(dt), destroy()

   Quality is fixed at DYE 1024 / SIM 256 as specified.
    */

(function(global){
'use strict';
/* All pointer and key listeners are bound to the fluid's OWN canvas rather than
   to window/document. The demo bound them globally, which inside a game means
   every instance intercepts input the game needs and leaks handlers that are
   never removed. */

function createWater(_WATER_CANVAS, opts){
opts = opts || {};

/*
MIT License

Copyright (c) 2017 Pavel Dobryakov

Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all
copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
SOFTWARE.
*/

'use strict';



// Simulation section

const canvas = _WATER_CANVAS;
resizeCanvas();

let config = {
    SIM_RESOLUTION: 128,
    DYE_RESOLUTION: 1024,
    CAPTURE_RESOLUTION: 512,
    DENSITY_DISSIPATION: 1,
    VELOCITY_DISSIPATION: 0.2,
    PRESSURE: 0.8,
    /* 20 pressure iterations is the demo's quality setting, where the fluid is
       the ONLY thing on screen. In a racing game it is one layer among many, so
       it is the first thing that should give. 8 is visually near-identical for
       a background effect and cuts the dominant per-step cost by 60%. */
    PRESSURE_ITERATIONS: 8,
    CURL: 30,
    SPLAT_RADIUS: 0.25,
    SPLAT_FORCE: 6000,
    SHADING: true,
    COLORFUL: true,
    COLOR_UPDATE_SPEED: 10,
    PAUSED: false,
    BACK_COLOR: { r: 0, g: 0, b: 0 },
    TRANSPARENT: false,
    BLOOM: true,
    BLOOM_ITERATIONS: 8,
    BLOOM_RESOLUTION: 256,
    BLOOM_INTENSITY: 0.8,
    BLOOM_THRESHOLD: 0.6,
    BLOOM_SOFT_KNEE: 0.7,
    SUNRAYS: true,
    SUNRAYS_RESOLUTION: 196,
    SUNRAYS_WEIGHT: 1.0,
}

function pointerPrototype () {
    this.id = -1;
    this.texcoordX = 0;
    this.texcoordY = 0;
    this.prevTexcoordX = 0;
    this.prevTexcoordY = 0;
    this.deltaX = 0;
    this.deltaY = 0;
    this.down = false;
    this.moved = false;
    this.color = [30, 0, 300];
}

let pointers = [];
let splatStack = [];
pointers.push(new pointerPrototype());

const { gl, ext } = getWebGLContext(canvas);

if (isMobile()) {
    config.DYE_RESOLUTION = 512;
}
if (!ext.supportLinearFiltering) {
    config.DYE_RESOLUTION = 512;
    config.SHADING = false;
    config.BLOOM = false;
    config.SUNRAYS = false;
}


function getWebGLContext (canvas) {
    const params = { alpha: true, depth: false, stencil: false, antialias: false, preserveDrawingBuffer: false };

    let gl = canvas.getContext('webgl2', params);
    const isWebGL2 = !!gl;
    if (!isWebGL2)
        gl = canvas.getContext('webgl', params) || canvas.getContext('experimental-webgl', params);

    let halfFloat;
    let supportLinearFiltering;
    if (isWebGL2) {
        gl.getExtension('EXT_color_buffer_float');
        supportLinearFiltering = gl.getExtension('OES_texture_float_linear');
    } else {
        halfFloat = gl.getExtension('OES_texture_half_float');
        supportLinearFiltering = gl.getExtension('OES_texture_half_float_linear');
    }

    gl.clearColor(0.0, 0.0, 0.0, 1.0);

    const halfFloatTexType = isWebGL2 ? gl.HALF_FLOAT : halfFloat.HALF_FLOAT_OES;
    let formatRGBA;
    let formatRG;
    let formatR;

    if (isWebGL2)
    {
        formatRGBA = getSupportedFormat(gl, gl.RGBA16F, gl.RGBA, halfFloatTexType);
        formatRG = getSupportedFormat(gl, gl.RG16F, gl.RG, halfFloatTexType);
        formatR = getSupportedFormat(gl, gl.R16F, gl.RED, halfFloatTexType);
    }
    else
    {
        formatRGBA = getSupportedFormat(gl, gl.RGBA, gl.RGBA, halfFloatTexType);
        formatRG = getSupportedFormat(gl, gl.RGBA, gl.RGBA, halfFloatTexType);
        formatR = getSupportedFormat(gl, gl.RGBA, gl.RGBA, halfFloatTexType);
    }

    /* The original demo reported WebGL support to Google Analytics here via a
       global `ga`. That global does not exist in this game, so the call threw a
       ReferenceError and aborted context creation — the fluid never
       initialised. Removed rather than stubbed: the game should not be phoning
       an analytics endpoint at all. */

    return {
        gl,
        ext: {
            formatRGBA,
            formatRG,
            formatR,
            halfFloatTexType,
            supportLinearFiltering
        }
    };
}

function getSupportedFormat (gl, internalFormat, format, type)
{
    if (!supportRenderTextureFormat(gl, internalFormat, format, type))
    {
        switch (internalFormat)
        {
            case gl.R16F:
                return getSupportedFormat(gl, gl.RG16F, gl.RG, type);
            case gl.RG16F:
                return getSupportedFormat(gl, gl.RGBA16F, gl.RGBA, type);
            default:
                return null;
        }
    }

    return {
        internalFormat,
        format
    }
}

function supportRenderTextureFormat (gl, internalFormat, format, type) {
    let texture = gl.createTexture();
    gl.bindTexture(gl.TEXTURE_2D, texture);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.NEAREST);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.NEAREST);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
    gl.texImage2D(gl.TEXTURE_2D, 0, internalFormat, 4, 4, 0, format, type, null);

    let fbo = gl.createFramebuffer();
    gl.bindFramebuffer(gl.FRAMEBUFFER, fbo);
    gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, texture, 0);

    let status = gl.checkFramebufferStatus(gl.FRAMEBUFFER);
    return status == gl.FRAMEBUFFER_COMPLETE;
}

function isMobile () {
    return /Mobi|Android/i.test(navigator.userAgent);
}

function captureScreenshot () {
    let res = getResolution(config.CAPTURE_RESOLUTION);
    let target = createFBO(res.width, res.height, ext.formatRGBA.internalFormat, ext.formatRGBA.format, ext.halfFloatTexType, gl.NEAREST);
    render(target);

    let texture = framebufferToTexture(target);
    texture = normalizeTexture(texture, target.width, target.height);

    let captureCanvas = textureToCanvas(texture, target.width, target.height);
    let datauri = captureCanvas.toDataURL();
    downloadURI('fluid.png', datauri);
    URL.revokeObjectURL(datauri);
}

function framebufferToTexture (target) {
    gl.bindFramebuffer(gl.FRAMEBUFFER, target.fbo);
    let length = target.width * target.height * 4;
    let texture = new Float32Array(length);
    gl.readPixels(0, 0, target.width, target.height, gl.RGBA, gl.FLOAT, texture);
    return texture;
}

function normalizeTexture (texture, width, height) {
    let result = new Uint8Array(texture.length);
    let id = 0;
    for (let i = height - 1; i >= 0; i--) {
        for (let j = 0; j < width; j++) {
            let nid = i * width * 4 + j * 4;
            result[nid + 0] = clamp01(texture[id + 0]) * 255;
            result[nid + 1] = clamp01(texture[id + 1]) * 255;
            result[nid + 2] = clamp01(texture[id + 2]) * 255;
            result[nid + 3] = clamp01(texture[id + 3]) * 255;
            id += 4;
        }
    }
    return result;
}

function clamp01 (input) {
    return Math.min(Math.max(input, 0), 1);
}

function textureToCanvas (texture, width, height) {
    let captureCanvas = document.createElement('canvas');
    let ctx = captureCanvas.getContext('2d');
    captureCanvas.width = width;
    captureCanvas.height = height;

    let imageData = ctx.createImageData(width, height);
    imageData.data.set(texture);
    ctx.putImageData(imageData, 0, 0);

    return captureCanvas;
}

function downloadURI (filename, uri) {
    let link = document.createElement('a');
    link.download = filename;
    link.href = uri;
    document.body.appendChild(link);
    link.click();
    document.body.removeChild(link);
}

class Material {
    constructor (vertexShader, fragmentShaderSource) {
        this.vertexShader = vertexShader;
        this.fragmentShaderSource = fragmentShaderSource;
        this.programs = [];
        this.activeProgram = null;
        this.uniforms = [];
    }

    setKeywords (keywords) {
        let hash = 0;
        for (let i = 0; i < keywords.length; i++)
            hash += hashCode(keywords[i]);

        let program = this.programs[hash];
        if (program == null)
        {
            let fragmentShader = compileShader(gl.FRAGMENT_SHADER, this.fragmentShaderSource, keywords);
            program = createProgram(this.vertexShader, fragmentShader);
            this.programs[hash] = program;
        }

        if (program == this.activeProgram) return;

        this.uniforms = getUniforms(program);
        this.activeProgram = program;
    }

    bind () {
        gl.useProgram(this.activeProgram);
    }
}

class Program {
    constructor (vertexShader, fragmentShader) {
        this.uniforms = {};
        this.program = createProgram(vertexShader, fragmentShader);
        this.uniforms = getUniforms(this.program);
    }

    bind () {
        gl.useProgram(this.program);
    }
}

function createProgram (vertexShader, fragmentShader) {
    let program = gl.createProgram();
    gl.attachShader(program, vertexShader);
    gl.attachShader(program, fragmentShader);
    gl.linkProgram(program);

    if (!gl.getProgramParameter(program, gl.LINK_STATUS))
        console.trace(gl.getProgramInfoLog(program));

    return program;
}

function getUniforms (program) {
    let uniforms = [];
    let uniformCount = gl.getProgramParameter(program, gl.ACTIVE_UNIFORMS);
    for (let i = 0; i < uniformCount; i++) {
        let uniformName = gl.getActiveUniform(program, i).name;
        uniforms[uniformName] = gl.getUniformLocation(program, uniformName);
    }
    return uniforms;
}

function compileShader (type, source, keywords) {
    source = addKeywords(source, keywords);

    const shader = gl.createShader(type);
    gl.shaderSource(shader, source);
    gl.compileShader(shader);

    if (!gl.getShaderParameter(shader, gl.COMPILE_STATUS))
        console.trace(gl.getShaderInfoLog(shader));

    return shader;
};

function addKeywords (source, keywords) {
    if (keywords == null) return source;
    let keywordsString = '';
    keywords.forEach(keyword => {
        keywordsString += '#define ' + keyword + '\n';
    });
    return keywordsString + source;
}

const baseVertexShader = compileShader(gl.VERTEX_SHADER, `
    precision highp float;

    attribute vec2 aPosition;
    varying vec2 vUv;
    varying vec2 vL;
    varying vec2 vR;
    varying vec2 vT;
    varying vec2 vB;
    uniform vec2 texelSize;

    void main () {
        vUv = aPosition * 0.5 + 0.5;
        vL = vUv - vec2(texelSize.x, 0.0);
        vR = vUv + vec2(texelSize.x, 0.0);
        vT = vUv + vec2(0.0, texelSize.y);
        vB = vUv - vec2(0.0, texelSize.y);
        gl_Position = vec4(aPosition, 0.0, 1.0);
    }
`);

const blurVertexShader = compileShader(gl.VERTEX_SHADER, `
    precision highp float;

    attribute vec2 aPosition;
    varying vec2 vUv;
    varying vec2 vL;
    varying vec2 vR;
    uniform vec2 texelSize;

    void main () {
        vUv = aPosition * 0.5 + 0.5;
        float offset = 1.33333333;
        vL = vUv - texelSize * offset;
        vR = vUv + texelSize * offset;
        gl_Position = vec4(aPosition, 0.0, 1.0);
    }
`);

const blurShader = compileShader(gl.FRAGMENT_SHADER, `
    precision mediump float;
    precision mediump sampler2D;

    varying vec2 vUv;
    varying vec2 vL;
    varying vec2 vR;
    uniform sampler2D uTexture;

    void main () {
        vec4 sum = texture2D(uTexture, vUv) * 0.29411764;
        sum += texture2D(uTexture, vL) * 0.35294117;
        sum += texture2D(uTexture, vR) * 0.35294117;
        gl_FragColor = sum;
    }
`);

const copyShader = compileShader(gl.FRAGMENT_SHADER, `
    precision mediump float;
    precision mediump sampler2D;

    varying highp vec2 vUv;
    uniform sampler2D uTexture;

    void main () {
        gl_FragColor = texture2D(uTexture, vUv);
    }
`);

const clearShader = compileShader(gl.FRAGMENT_SHADER, `
    precision mediump float;
    precision mediump sampler2D;

    varying highp vec2 vUv;
    uniform sampler2D uTexture;
    uniform float value;

    void main () {
        gl_FragColor = value * texture2D(uTexture, vUv);
    }
`);

const colorShader = compileShader(gl.FRAGMENT_SHADER, `
    precision mediump float;

    uniform vec4 color;

    void main () {
        gl_FragColor = color;
    }
`);

const checkerboardShader = compileShader(gl.FRAGMENT_SHADER, `
    precision highp float;
    precision highp sampler2D;

    varying vec2 vUv;
    uniform sampler2D uTexture;
    uniform float aspectRatio;

    #define SCALE 25.0

    void main () {
        vec2 uv = floor(vUv * SCALE * vec2(aspectRatio, 1.0));
        float v = mod(uv.x + uv.y, 2.0);
        v = v * 0.1 + 0.8;
        gl_FragColor = vec4(vec3(v), 1.0);
    }
`);

const displayShaderSource = `
    precision highp float;
    precision highp sampler2D;

    varying vec2 vUv;
    varying vec2 vL;
    varying vec2 vR;
    varying vec2 vT;
    varying vec2 vB;
    uniform sampler2D uTexture;
    uniform sampler2D uBloom;
    uniform sampler2D uSunrays;
    uniform sampler2D uDithering;
    uniform vec2 ditherScale;
    uniform vec2 texelSize;

    vec3 linearToGamma (vec3 color) {
        color = max(color, vec3(0));
        return max(1.055 * pow(color, vec3(0.416666667)) - 0.055, vec3(0));
    }

    void main () {
        vec3 c = texture2D(uTexture, vUv).rgb;

    #ifdef SHADING
        vec3 lc = texture2D(uTexture, vL).rgb;
        vec3 rc = texture2D(uTexture, vR).rgb;
        vec3 tc = texture2D(uTexture, vT).rgb;
        vec3 bc = texture2D(uTexture, vB).rgb;

        float dx = length(rc) - length(lc);
        float dy = length(tc) - length(bc);

        vec3 n = normalize(vec3(dx, dy, length(texelSize)));
        vec3 l = vec3(0.0, 0.0, 1.0);

        float diffuse = clamp(dot(n, l) + 0.7, 0.7, 1.0);
        c *= diffuse;
    #endif

    #ifdef BLOOM
        vec3 bloom = texture2D(uBloom, vUv).rgb;
    #endif

    #ifdef SUNRAYS
        float sunrays = texture2D(uSunrays, vUv).r;
        c *= sunrays;
    #ifdef BLOOM
        bloom *= sunrays;
    #endif
    #endif

    #ifdef BLOOM
        float noise = texture2D(uDithering, vUv * ditherScale).r;
        noise = noise * 2.0 - 1.0;
        bloom += noise / 255.0;
        bloom = linearToGamma(bloom);
        c += bloom;
    #endif

        float a = max(c.r, max(c.g, c.b));
        gl_FragColor = vec4(c, a);
    }
`;

const bloomPrefilterShader = compileShader(gl.FRAGMENT_SHADER, `
    precision mediump float;
    precision mediump sampler2D;

    varying vec2 vUv;
    uniform sampler2D uTexture;
    uniform vec3 curve;
    uniform float threshold;

    void main () {
        vec3 c = texture2D(uTexture, vUv).rgb;
        float br = max(c.r, max(c.g, c.b));
        float rq = clamp(br - curve.x, 0.0, curve.y);
        rq = curve.z * rq * rq;
        c *= max(rq, br - threshold) / max(br, 0.0001);
        gl_FragColor = vec4(c, 0.0);
    }
`);

const bloomBlurShader = compileShader(gl.FRAGMENT_SHADER, `
    precision mediump float;
    precision mediump sampler2D;

    varying vec2 vL;
    varying vec2 vR;
    varying vec2 vT;
    varying vec2 vB;
    uniform sampler2D uTexture;

    void main () {
        vec4 sum = vec4(0.0);
        sum += texture2D(uTexture, vL);
        sum += texture2D(uTexture, vR);
        sum += texture2D(uTexture, vT);
        sum += texture2D(uTexture, vB);
        sum *= 0.25;
        gl_FragColor = sum;
    }
`);

const bloomFinalShader = compileShader(gl.FRAGMENT_SHADER, `
    precision mediump float;
    precision mediump sampler2D;

    varying vec2 vL;
    varying vec2 vR;
    varying vec2 vT;
    varying vec2 vB;
    uniform sampler2D uTexture;
    uniform float intensity;

    void main () {
        vec4 sum = vec4(0.0);
        sum += texture2D(uTexture, vL);
        sum += texture2D(uTexture, vR);
        sum += texture2D(uTexture, vT);
        sum += texture2D(uTexture, vB);
        sum *= 0.25;
        gl_FragColor = sum * intensity;
    }
`);

const sunraysMaskShader = compileShader(gl.FRAGMENT_SHADER, `
    precision highp float;
    precision highp sampler2D;

    varying vec2 vUv;
    uniform sampler2D uTexture;

    void main () {
        vec4 c = texture2D(uTexture, vUv);
        float br = max(c.r, max(c.g, c.b));
        c.a = 1.0 - min(max(br * 20.0, 0.0), 0.8);
        gl_FragColor = c;
    }
`);

const sunraysShader = compileShader(gl.FRAGMENT_SHADER, `
    precision highp float;
    precision highp sampler2D;

    varying vec2 vUv;
    uniform sampler2D uTexture;
    uniform float weight;

    #define ITERATIONS 16

    void main () {
        float Density = 0.3;
        float Decay = 0.95;
        float Exposure = 0.7;

        vec2 coord = vUv;
        vec2 dir = vUv - 0.5;

        dir *= 1.0 / float(ITERATIONS) * Density;
        float illuminationDecay = 1.0;

        float color = texture2D(uTexture, vUv).a;

        for (int i = 0; i < ITERATIONS; i++)
        {
            coord -= dir;
            float col = texture2D(uTexture, coord).a;
            color += col * illuminationDecay * weight;
            illuminationDecay *= Decay;
        }

        gl_FragColor = vec4(color * Exposure, 0.0, 0.0, 1.0);
    }
`);

const splatShader = compileShader(gl.FRAGMENT_SHADER, `
    precision highp float;
    precision highp sampler2D;

    varying vec2 vUv;
    uniform sampler2D uTarget;
    uniform float aspectRatio;
    uniform vec3 color;
    uniform vec2 point;
    uniform float radius;

    void main () {
        vec2 p = vUv - point.xy;
        p.x *= aspectRatio;
        vec3 splat = exp(-dot(p, p) / radius) * color;
        vec3 base = texture2D(uTarget, vUv).xyz;
        gl_FragColor = vec4(base + splat, 1.0);
    }
`);

const advectionShader = compileShader(gl.FRAGMENT_SHADER, `
    precision highp float;
    precision highp sampler2D;

    varying vec2 vUv;
    uniform sampler2D uVelocity;
    uniform sampler2D uSource;
    uniform vec2 texelSize;
    uniform vec2 dyeTexelSize;
    uniform float dt;
    uniform float dissipation;

    vec4 bilerp (sampler2D sam, vec2 uv, vec2 tsize) {
        vec2 st = uv / tsize - 0.5;

        vec2 iuv = floor(st);
        vec2 fuv = fract(st);

        vec4 a = texture2D(sam, (iuv + vec2(0.5, 0.5)) * tsize);
        vec4 b = texture2D(sam, (iuv + vec2(1.5, 0.5)) * tsize);
        vec4 c = texture2D(sam, (iuv + vec2(0.5, 1.5)) * tsize);
        vec4 d = texture2D(sam, (iuv + vec2(1.5, 1.5)) * tsize);

        return mix(mix(a, b, fuv.x), mix(c, d, fuv.x), fuv.y);
    }

    void main () {
    #ifdef MANUAL_FILTERING
        vec2 coord = vUv - dt * bilerp(uVelocity, vUv, texelSize).xy * texelSize;
        vec4 result = bilerp(uSource, coord, dyeTexelSize);
    #else
        vec2 coord = vUv - dt * texture2D(uVelocity, vUv).xy * texelSize;
        vec4 result = texture2D(uSource, coord);
    #endif
        float decay = 1.0 + dissipation * dt;
        gl_FragColor = result / decay;
    }`,
    ext.supportLinearFiltering ? null : ['MANUAL_FILTERING']
);

const divergenceShader = compileShader(gl.FRAGMENT_SHADER, `
    precision mediump float;
    precision mediump sampler2D;

    varying highp vec2 vUv;
    varying highp vec2 vL;
    varying highp vec2 vR;
    varying highp vec2 vT;
    varying highp vec2 vB;
    uniform sampler2D uVelocity;

    void main () {
        float L = texture2D(uVelocity, vL).x;
        float R = texture2D(uVelocity, vR).x;
        float T = texture2D(uVelocity, vT).y;
        float B = texture2D(uVelocity, vB).y;

        vec2 C = texture2D(uVelocity, vUv).xy;
        if (vL.x < 0.0) { L = -C.x; }
        if (vR.x > 1.0) { R = -C.x; }
        if (vT.y > 1.0) { T = -C.y; }
        if (vB.y < 0.0) { B = -C.y; }

        float div = 0.5 * (R - L + T - B);
        gl_FragColor = vec4(div, 0.0, 0.0, 1.0);
    }
`);

const curlShader = compileShader(gl.FRAGMENT_SHADER, `
    precision mediump float;
    precision mediump sampler2D;

    varying highp vec2 vUv;
    varying highp vec2 vL;
    varying highp vec2 vR;
    varying highp vec2 vT;
    varying highp vec2 vB;
    uniform sampler2D uVelocity;

    void main () {
        float L = texture2D(uVelocity, vL).y;
        float R = texture2D(uVelocity, vR).y;
        float T = texture2D(uVelocity, vT).x;
        float B = texture2D(uVelocity, vB).x;
        float vorticity = R - L - T + B;
        gl_FragColor = vec4(0.5 * vorticity, 0.0, 0.0, 1.0);
    }
`);

const vorticityShader = compileShader(gl.FRAGMENT_SHADER, `
    precision highp float;
    precision highp sampler2D;

    varying vec2 vUv;
    varying vec2 vL;
    varying vec2 vR;
    varying vec2 vT;
    varying vec2 vB;
    uniform sampler2D uVelocity;
    uniform sampler2D uCurl;
    uniform float curl;
    uniform float dt;

    void main () {
        float L = texture2D(uCurl, vL).x;
        float R = texture2D(uCurl, vR).x;
        float T = texture2D(uCurl, vT).x;
        float B = texture2D(uCurl, vB).x;
        float C = texture2D(uCurl, vUv).x;

        vec2 force = 0.5 * vec2(abs(T) - abs(B), abs(R) - abs(L));
        force /= length(force) + 0.0001;
        force *= curl * C;
        force.y *= -1.0;

        vec2 velocity = texture2D(uVelocity, vUv).xy;
        velocity += force * dt;
        velocity = min(max(velocity, -1000.0), 1000.0);
        gl_FragColor = vec4(velocity, 0.0, 1.0);
    }
`);

const pressureShader = compileShader(gl.FRAGMENT_SHADER, `
    precision mediump float;
    precision mediump sampler2D;

    varying highp vec2 vUv;
    varying highp vec2 vL;
    varying highp vec2 vR;
    varying highp vec2 vT;
    varying highp vec2 vB;
    uniform sampler2D uPressure;
    uniform sampler2D uDivergence;

    void main () {
        float L = texture2D(uPressure, vL).x;
        float R = texture2D(uPressure, vR).x;
        float T = texture2D(uPressure, vT).x;
        float B = texture2D(uPressure, vB).x;
        float C = texture2D(uPressure, vUv).x;
        float divergence = texture2D(uDivergence, vUv).x;
        float pressure = (L + R + B + T - divergence) * 0.25;
        gl_FragColor = vec4(pressure, 0.0, 0.0, 1.0);
    }
`);

const gradientSubtractShader = compileShader(gl.FRAGMENT_SHADER, `
    precision mediump float;
    precision mediump sampler2D;

    varying highp vec2 vUv;
    varying highp vec2 vL;
    varying highp vec2 vR;
    varying highp vec2 vT;
    varying highp vec2 vB;
    uniform sampler2D uPressure;
    uniform sampler2D uVelocity;

    void main () {
        float L = texture2D(uPressure, vL).x;
        float R = texture2D(uPressure, vR).x;
        float T = texture2D(uPressure, vT).x;
        float B = texture2D(uPressure, vB).x;
        vec2 velocity = texture2D(uVelocity, vUv).xy;
        velocity.xy -= vec2(R - L, T - B);
        gl_FragColor = vec4(velocity, 0.0, 1.0);
    }
`);

const blit = (() => {
    gl.bindBuffer(gl.ARRAY_BUFFER, gl.createBuffer());
    gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([-1, -1, -1, 1, 1, 1, 1, -1]), gl.STATIC_DRAW);
    gl.bindBuffer(gl.ELEMENT_ARRAY_BUFFER, gl.createBuffer());
    gl.bufferData(gl.ELEMENT_ARRAY_BUFFER, new Uint16Array([0, 1, 2, 0, 2, 3]), gl.STATIC_DRAW);
    gl.vertexAttribPointer(0, 2, gl.FLOAT, false, 0, 0);
    gl.enableVertexAttribArray(0);

    return (target, clear = false) => {
        if (target == null)
        {
            gl.viewport(0, 0, gl.drawingBufferWidth, gl.drawingBufferHeight);
            gl.bindFramebuffer(gl.FRAMEBUFFER, null);
        }
        else
        {
            gl.viewport(0, 0, target.width, target.height);
            gl.bindFramebuffer(gl.FRAMEBUFFER, target.fbo);
        }
        if (clear)
        {
            gl.clearColor(0.0, 0.0, 0.0, 1.0);
            gl.clear(gl.COLOR_BUFFER_BIT);
        }
        // CHECK_FRAMEBUFFER_STATUS();
        gl.drawElements(gl.TRIANGLES, 6, gl.UNSIGNED_SHORT, 0);
    }
})();

function CHECK_FRAMEBUFFER_STATUS () {
    let status = gl.checkFramebufferStatus(gl.FRAMEBUFFER);
    if (status != gl.FRAMEBUFFER_COMPLETE)
        console.trace("Framebuffer error: " + status);
}

let dye;
let velocity;
let divergence;
let curl;
let pressure;
let bloom;
let bloomFramebuffers = [];
let sunrays;
let sunraysTemp;

/* The demo loaded a dithering texture from LDR_LLL1_0.png, an asset that does
   not ship with the game. In a browser the fetch merely 404s, but the call also
   uses `new Image()`, and any failure here aborts createWater entirely — which
   is why no instance was ever produced.
   Dithering only removes faint banding in the final blit, so a 1x1 neutral
   stand-in is used and the feature degrades to "no dithering". */
let ditheringTexture = (function(){
  /* (item 12) The texture is now embedded as a data URI in this file, so there
     is no LDR_LLL1_0.png on the server and no fetch to 404. createTextureAsync
     takes a URL and a data URI is a URL, so the call site is unchanged — the
     image simply resolves from memory and synchronously enough that the
     dithering is available on the first frame instead of a few hundred
     milliseconds in. The 1x1 fallback below is kept for the case where the
     constant is somehow missing. */
  try{ return createTextureAsync(
    (typeof FX_DITHER_PNG!=='undefined'&&FX_DITHER_PNG)||'LDR_LLL1_0.png'); }
  catch(e){
    var tex = gl.createTexture();
    gl.bindTexture(gl.TEXTURE_2D, tex);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.REPEAT);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.REPEAT);
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGB, 1, 1, 0, gl.RGB,
                  gl.UNSIGNED_BYTE, new Uint8Array([128,128,128]));
    return { texture: tex, width: 1, height: 1,
             attach(id){ gl.activeTexture(gl.TEXTURE0 + id);
                         gl.bindTexture(gl.TEXTURE_2D, tex); return id; } };
  }
})();

const blurProgram            = new Program(blurVertexShader, blurShader);
const copyProgram            = new Program(baseVertexShader, copyShader);
const clearProgram           = new Program(baseVertexShader, clearShader);
const colorProgram           = new Program(baseVertexShader, colorShader);
const checkerboardProgram    = new Program(baseVertexShader, checkerboardShader);
const bloomPrefilterProgram  = new Program(baseVertexShader, bloomPrefilterShader);
const bloomBlurProgram       = new Program(baseVertexShader, bloomBlurShader);
const bloomFinalProgram      = new Program(baseVertexShader, bloomFinalShader);
const sunraysMaskProgram     = new Program(baseVertexShader, sunraysMaskShader);
const sunraysProgram         = new Program(baseVertexShader, sunraysShader);
const splatProgram           = new Program(baseVertexShader, splatShader);
const advectionProgram       = new Program(baseVertexShader, advectionShader);
const divergenceProgram      = new Program(baseVertexShader, divergenceShader);
const curlProgram            = new Program(baseVertexShader, curlShader);
const vorticityProgram       = new Program(baseVertexShader, vorticityShader);
const pressureProgram        = new Program(baseVertexShader, pressureShader);
const gradienSubtractProgram = new Program(baseVertexShader, gradientSubtractShader);

const displayMaterial = new Material(baseVertexShader, displayShaderSource);

function initFramebuffers () {
    let simRes = getResolution(config.SIM_RESOLUTION);
    let dyeRes = getResolution(config.DYE_RESOLUTION);

    const texType = ext.halfFloatTexType;
    const rgba    = ext.formatRGBA;
    const rg      = ext.formatRG;
    const r       = ext.formatR;
    const filtering = ext.supportLinearFiltering ? gl.LINEAR : gl.NEAREST;

    gl.disable(gl.BLEND);

    if (dye == null)
        dye = createDoubleFBO(dyeRes.width, dyeRes.height, rgba.internalFormat, rgba.format, texType, filtering);
    else
        dye = resizeDoubleFBO(dye, dyeRes.width, dyeRes.height, rgba.internalFormat, rgba.format, texType, filtering);

    if (velocity == null)
        velocity = createDoubleFBO(simRes.width, simRes.height, rg.internalFormat, rg.format, texType, filtering);
    else
        velocity = resizeDoubleFBO(velocity, simRes.width, simRes.height, rg.internalFormat, rg.format, texType, filtering);

    divergence = createFBO      (simRes.width, simRes.height, r.internalFormat, r.format, texType, gl.NEAREST);
    curl       = createFBO      (simRes.width, simRes.height, r.internalFormat, r.format, texType, gl.NEAREST);
    pressure   = createDoubleFBO(simRes.width, simRes.height, r.internalFormat, r.format, texType, gl.NEAREST);

    initBloomFramebuffers();
    initSunraysFramebuffers();
}

function initBloomFramebuffers () {
    let res = getResolution(config.BLOOM_RESOLUTION);

    const texType = ext.halfFloatTexType;
    const rgba = ext.formatRGBA;
    const filtering = ext.supportLinearFiltering ? gl.LINEAR : gl.NEAREST;

    bloom = createFBO(res.width, res.height, rgba.internalFormat, rgba.format, texType, filtering);

    bloomFramebuffers.length = 0;
    for (let i = 0; i < config.BLOOM_ITERATIONS; i++)
    {
        let width = res.width >> (i + 1);
        let height = res.height >> (i + 1);

        if (width < 2 || height < 2) break;

        let fbo = createFBO(width, height, rgba.internalFormat, rgba.format, texType, filtering);
        bloomFramebuffers.push(fbo);
    }
}

function initSunraysFramebuffers () {
    let res = getResolution(config.SUNRAYS_RESOLUTION);

    const texType = ext.halfFloatTexType;
    const r = ext.formatR;
    const filtering = ext.supportLinearFiltering ? gl.LINEAR : gl.NEAREST;

    sunrays     = createFBO(res.width, res.height, r.internalFormat, r.format, texType, filtering);
    sunraysTemp = createFBO(res.width, res.height, r.internalFormat, r.format, texType, filtering);
}

function createFBO (w, h, internalFormat, format, type, param) {
    gl.activeTexture(gl.TEXTURE0);
    let texture = gl.createTexture();
    gl.bindTexture(gl.TEXTURE_2D, texture);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, param);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, param);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
    gl.texImage2D(gl.TEXTURE_2D, 0, internalFormat, w, h, 0, format, type, null);

    let fbo = gl.createFramebuffer();
    gl.bindFramebuffer(gl.FRAMEBUFFER, fbo);
    gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, texture, 0);
    gl.viewport(0, 0, w, h);
    gl.clear(gl.COLOR_BUFFER_BIT);

    let texelSizeX = 1.0 / w;
    let texelSizeY = 1.0 / h;

    return {
        texture,
        fbo,
        width: w,
        height: h,
        texelSizeX,
        texelSizeY,
        attach (id) {
            gl.activeTexture(gl.TEXTURE0 + id);
            gl.bindTexture(gl.TEXTURE_2D, texture);
            return id;
        }
    };
}

function createDoubleFBO (w, h, internalFormat, format, type, param) {
    let fbo1 = createFBO(w, h, internalFormat, format, type, param);
    let fbo2 = createFBO(w, h, internalFormat, format, type, param);

    return {
        width: w,
        height: h,
        texelSizeX: fbo1.texelSizeX,
        texelSizeY: fbo1.texelSizeY,
        get read () {
            return fbo1;
        },
        set read (value) {
            fbo1 = value;
        },
        get write () {
            return fbo2;
        },
        set write (value) {
            fbo2 = value;
        },
        swap () {
            let temp = fbo1;
            fbo1 = fbo2;
            fbo2 = temp;
        }
    }
}

function resizeFBO (target, w, h, internalFormat, format, type, param) {
    let newFBO = createFBO(w, h, internalFormat, format, type, param);
    copyProgram.bind();
    gl.uniform1i(copyProgram.uniforms.uTexture, target.attach(0));
    blit(newFBO);
    return newFBO;
}

function resizeDoubleFBO (target, w, h, internalFormat, format, type, param) {
    if (target.width == w && target.height == h)
        return target;
    target.read = resizeFBO(target.read, w, h, internalFormat, format, type, param);
    target.write = createFBO(w, h, internalFormat, format, type, param);
    target.width = w;
    target.height = h;
    target.texelSizeX = 1.0 / w;
    target.texelSizeY = 1.0 / h;
    return target;
}

function createTextureAsync (url) {
    let texture = gl.createTexture();
    gl.bindTexture(gl.TEXTURE_2D, texture);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.REPEAT);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.REPEAT);
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGB, 1, 1, 0, gl.RGB, gl.UNSIGNED_BYTE, new Uint8Array([255, 255, 255]));

    let obj = {
        texture,
        width: 1,
        height: 1,
        attach (id) {
            gl.activeTexture(gl.TEXTURE0 + id);
            gl.bindTexture(gl.TEXTURE_2D, texture);
            return id;
        }
    };

    let image = new Image();
    image.onload = () => {
        obj.width = image.width;
        obj.height = image.height;
        gl.bindTexture(gl.TEXTURE_2D, texture);
        gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGB, gl.RGB, gl.UNSIGNED_BYTE, image);
    };
    image.src = url;

    return obj;
}

function updateKeywords () {
    let displayKeywords = [];
    if (config.SHADING) displayKeywords.push("SHADING");
    if (config.BLOOM) displayKeywords.push("BLOOM");
    if (config.SUNRAYS) displayKeywords.push("SUNRAYS");
    displayMaterial.setKeywords(displayKeywords);
}

updateKeywords();
initFramebuffers();
/* The demo seeded itself with 5-25 random full-brightness blobs so the page
   was never blank. The game decides what belongs on screen — for a tunnel
   pattern this bootstrap WAS the visible effect, since each blob carries
   thousands of times the dye of a pattern point. Callers that want a seeded
   field call burst() explicitly. */

let lastUpdateTime = Date.now();
let colorUpdateTimer = 0.0;
/* The original ran its own perpetual rAF loop, started the instant the module
   initialised. Inside a game that means a FULL fluid simulation — advection,
   pressure iterations, several framebuffer passes — running every frame
   forever, whether or not the effect is on screen. That is what dropped races
   to ~2 FPS.
   The loop is removed. The host calls step() when it wants a frame, so the
   simulation costs nothing while hidden. */

function update () {
    const dt = calcDeltaTime();
    if (resizeCanvas())
        initFramebuffers();
    updateColors(dt);
    applyInputs();
    if (!config.PAUSED)
        step(dt);
    render(null);
    /* No self-requeue: pacing belongs to the host. */
}

function calcDeltaTime () {
    let now = Date.now();
    let dt = (now - lastUpdateTime) / 1000;
    dt = Math.min(dt, 0.016666);
    lastUpdateTime = now;
    return dt;
}

function resizeCanvas () {
    /* RESOLUTION SCALE. The host sets canvas._zsScale to render the fluid below
       the display resolution — a blurred background wash gains nothing from 1:1
       pixels, and this is the single biggest lever on fragment cost.
       A fallback to the window size matters because clientWidth is 0 whenever
       the element is display:none, which would otherwise allocate every
       framebuffer at 0x0 and render nothing at all. */
    var _sc = canvas._zsScale || 1;
    var _cw = canvas.clientWidth  || window.innerWidth  || 800;
    var _ch = canvas.clientHeight || window.innerHeight || 600;
    let width  = Math.max(2, Math.round(scaleByPixelRatio(_cw) * _sc));
    let height = Math.max(2, Math.round(scaleByPixelRatio(_ch) * _sc));
    if (canvas.width != width || canvas.height != height) {
        canvas.width = width;
        canvas.height = height;
        return true;
    }
    return false;
}

function updateColors (dt) {
    if (!config.COLORFUL) return;

    colorUpdateTimer += dt * config.COLOR_UPDATE_SPEED;
    if (colorUpdateTimer >= 1) {
        colorUpdateTimer = wrap(colorUpdateTimer, 0, 1);
        pointers.forEach(p => {
            p.color = generateColor();
        });
    }
}

function applyInputs () {
    if (splatStack.length > 0)
        multipleSplats(splatStack.pop());

    pointers.forEach(p => {
        if (p.moved) {
            p.moved = false;
            splatPointer(p);
        }
    });
}

function step (dt) {
    gl.disable(gl.BLEND);

    curlProgram.bind();
    gl.uniform2f(curlProgram.uniforms.texelSize, velocity.texelSizeX, velocity.texelSizeY);
    gl.uniform1i(curlProgram.uniforms.uVelocity, velocity.read.attach(0));
    blit(curl);

    vorticityProgram.bind();
    gl.uniform2f(vorticityProgram.uniforms.texelSize, velocity.texelSizeX, velocity.texelSizeY);
    gl.uniform1i(vorticityProgram.uniforms.uVelocity, velocity.read.attach(0));
    gl.uniform1i(vorticityProgram.uniforms.uCurl, curl.attach(1));
    gl.uniform1f(vorticityProgram.uniforms.curl, config.CURL);
    gl.uniform1f(vorticityProgram.uniforms.dt, dt);
    blit(velocity.write);
    velocity.swap();

    divergenceProgram.bind();
    gl.uniform2f(divergenceProgram.uniforms.texelSize, velocity.texelSizeX, velocity.texelSizeY);
    gl.uniform1i(divergenceProgram.uniforms.uVelocity, velocity.read.attach(0));
    blit(divergence);

    clearProgram.bind();
    gl.uniform1i(clearProgram.uniforms.uTexture, pressure.read.attach(0));
    gl.uniform1f(clearProgram.uniforms.value, config.PRESSURE);
    blit(pressure.write);
    pressure.swap();

    pressureProgram.bind();
    gl.uniform2f(pressureProgram.uniforms.texelSize, velocity.texelSizeX, velocity.texelSizeY);
    gl.uniform1i(pressureProgram.uniforms.uDivergence, divergence.attach(0));
    for (let i = 0; i < config.PRESSURE_ITERATIONS; i++) {
        gl.uniform1i(pressureProgram.uniforms.uPressure, pressure.read.attach(1));
        blit(pressure.write);
        pressure.swap();
    }

    gradienSubtractProgram.bind();
    gl.uniform2f(gradienSubtractProgram.uniforms.texelSize, velocity.texelSizeX, velocity.texelSizeY);
    gl.uniform1i(gradienSubtractProgram.uniforms.uPressure, pressure.read.attach(0));
    gl.uniform1i(gradienSubtractProgram.uniforms.uVelocity, velocity.read.attach(1));
    blit(velocity.write);
    velocity.swap();

    advectionProgram.bind();
    gl.uniform2f(advectionProgram.uniforms.texelSize, velocity.texelSizeX, velocity.texelSizeY);
    if (!ext.supportLinearFiltering)
        gl.uniform2f(advectionProgram.uniforms.dyeTexelSize, velocity.texelSizeX, velocity.texelSizeY);
    let velocityId = velocity.read.attach(0);
    gl.uniform1i(advectionProgram.uniforms.uVelocity, velocityId);
    gl.uniform1i(advectionProgram.uniforms.uSource, velocityId);
    gl.uniform1f(advectionProgram.uniforms.dt, dt);
    gl.uniform1f(advectionProgram.uniforms.dissipation, config.VELOCITY_DISSIPATION);
    blit(velocity.write);
    velocity.swap();

    if (!ext.supportLinearFiltering)
        gl.uniform2f(advectionProgram.uniforms.dyeTexelSize, dye.texelSizeX, dye.texelSizeY);
    gl.uniform1i(advectionProgram.uniforms.uVelocity, velocity.read.attach(0));
    gl.uniform1i(advectionProgram.uniforms.uSource, dye.read.attach(1));
    gl.uniform1f(advectionProgram.uniforms.dissipation, config.DENSITY_DISSIPATION);
    blit(dye.write);
    dye.swap();
}

function render (target) {
    if (config.BLOOM)
        applyBloom(dye.read, bloom);
    if (config.SUNRAYS) {
        applySunrays(dye.read, dye.write, sunrays);
        blur(sunrays, sunraysTemp, 1);
    }

    if (target == null || !config.TRANSPARENT) {
        gl.blendFunc(gl.ONE, gl.ONE_MINUS_SRC_ALPHA);
        gl.enable(gl.BLEND);
    }
    else {
        gl.disable(gl.BLEND);
    }

    if (!config.TRANSPARENT)
        drawColor(target, normalizeColor(config.BACK_COLOR));
    if (target == null && config.TRANSPARENT)
        drawCheckerboard(target);
    drawDisplay(target);
}

function drawColor (target, color) {
    colorProgram.bind();
    gl.uniform4f(colorProgram.uniforms.color, color.r, color.g, color.b, 1);
    blit(target);
}

function drawCheckerboard (target) {
    checkerboardProgram.bind();
    gl.uniform1f(checkerboardProgram.uniforms.aspectRatio, canvas.width / canvas.height);
    blit(target);
}

function drawDisplay (target) {
    let width = target == null ? gl.drawingBufferWidth : target.width;
    let height = target == null ? gl.drawingBufferHeight : target.height;

    displayMaterial.bind();
    if (config.SHADING)
        gl.uniform2f(displayMaterial.uniforms.texelSize, 1.0 / width, 1.0 / height);
    gl.uniform1i(displayMaterial.uniforms.uTexture, dye.read.attach(0));
    if (config.BLOOM) {
        gl.uniform1i(displayMaterial.uniforms.uBloom, bloom.attach(1));
        gl.uniform1i(displayMaterial.uniforms.uDithering, ditheringTexture.attach(2));
        let scale = getTextureScale(ditheringTexture, width, height);
        gl.uniform2f(displayMaterial.uniforms.ditherScale, scale.x, scale.y);
    }
    if (config.SUNRAYS)
        gl.uniform1i(displayMaterial.uniforms.uSunrays, sunrays.attach(3));
    blit(target);
}

function applyBloom (source, destination) {
    if (bloomFramebuffers.length < 2)
        return;

    let last = destination;

    gl.disable(gl.BLEND);
    bloomPrefilterProgram.bind();
    let knee = config.BLOOM_THRESHOLD * config.BLOOM_SOFT_KNEE + 0.0001;
    let curve0 = config.BLOOM_THRESHOLD - knee;
    let curve1 = knee * 2;
    let curve2 = 0.25 / knee;
    gl.uniform3f(bloomPrefilterProgram.uniforms.curve, curve0, curve1, curve2);
    gl.uniform1f(bloomPrefilterProgram.uniforms.threshold, config.BLOOM_THRESHOLD);
    gl.uniform1i(bloomPrefilterProgram.uniforms.uTexture, source.attach(0));
    blit(last);

    bloomBlurProgram.bind();
    for (let i = 0; i < bloomFramebuffers.length; i++) {
        let dest = bloomFramebuffers[i];
        gl.uniform2f(bloomBlurProgram.uniforms.texelSize, last.texelSizeX, last.texelSizeY);
        gl.uniform1i(bloomBlurProgram.uniforms.uTexture, last.attach(0));
        blit(dest);
        last = dest;
    }

    gl.blendFunc(gl.ONE, gl.ONE);
    gl.enable(gl.BLEND);

    for (let i = bloomFramebuffers.length - 2; i >= 0; i--) {
        let baseTex = bloomFramebuffers[i];
        gl.uniform2f(bloomBlurProgram.uniforms.texelSize, last.texelSizeX, last.texelSizeY);
        gl.uniform1i(bloomBlurProgram.uniforms.uTexture, last.attach(0));
        gl.viewport(0, 0, baseTex.width, baseTex.height);
        blit(baseTex);
        last = baseTex;
    }

    gl.disable(gl.BLEND);
    bloomFinalProgram.bind();
    gl.uniform2f(bloomFinalProgram.uniforms.texelSize, last.texelSizeX, last.texelSizeY);
    gl.uniform1i(bloomFinalProgram.uniforms.uTexture, last.attach(0));
    gl.uniform1f(bloomFinalProgram.uniforms.intensity, config.BLOOM_INTENSITY);
    blit(destination);
}

function applySunrays (source, mask, destination) {
    gl.disable(gl.BLEND);
    sunraysMaskProgram.bind();
    gl.uniform1i(sunraysMaskProgram.uniforms.uTexture, source.attach(0));
    blit(mask);

    sunraysProgram.bind();
    gl.uniform1f(sunraysProgram.uniforms.weight, config.SUNRAYS_WEIGHT);
    gl.uniform1i(sunraysProgram.uniforms.uTexture, mask.attach(0));
    blit(destination);
}

function blur (target, temp, iterations) {
    blurProgram.bind();
    for (let i = 0; i < iterations; i++) {
        gl.uniform2f(blurProgram.uniforms.texelSize, target.texelSizeX, 0.0);
        gl.uniform1i(blurProgram.uniforms.uTexture, target.attach(0));
        blit(temp);

        gl.uniform2f(blurProgram.uniforms.texelSize, 0.0, target.texelSizeY);
        gl.uniform1i(blurProgram.uniforms.uTexture, temp.attach(0));
        blit(target);
    }
}

function splatPointer (pointer) {
    let dx = pointer.deltaX * config.SPLAT_FORCE;
    let dy = pointer.deltaY * config.SPLAT_FORCE;
    splat(pointer.texcoordX, pointer.texcoordY, dx, dy, pointer.color);
}

function multipleSplats (amount) {
    for (let i = 0; i < amount; i++) {
        const color = generateColor();
        color.r *= 10.0;
        color.g *= 10.0;
        color.b *= 10.0;
        const x = Math.random();
        const y = Math.random();
        const dx = 1000 * (Math.random() - 0.5);
        const dy = 1000 * (Math.random() - 0.5);
        splat(x, y, dx, dy, color);
    }
}

function splat (x, y, dx, dy, color) {
    splatProgram.bind();
    gl.uniform1i(splatProgram.uniforms.uTarget, velocity.read.attach(0));
    gl.uniform1f(splatProgram.uniforms.aspectRatio, canvas.width / canvas.height);
    gl.uniform2f(splatProgram.uniforms.point, x, y);
    gl.uniform3f(splatProgram.uniforms.color, dx, dy, 0.0);
    gl.uniform1f(splatProgram.uniforms.radius, correctRadius(config.SPLAT_RADIUS / 100.0));
    blit(velocity.write);
    velocity.swap();

    gl.uniform1i(splatProgram.uniforms.uTarget, dye.read.attach(0));
    gl.uniform3f(splatProgram.uniforms.color, color.r, color.g, color.b);
    blit(dye.write);
    dye.swap();
}

function correctRadius (radius) {
    let aspectRatio = canvas.width / canvas.height;
    if (aspectRatio > 1)
        radius *= aspectRatio;
    return radius;
}

canvas.addEventListener('mousedown', e => {
    let posX = scaleByPixelRatio(e.offsetX);
    let posY = scaleByPixelRatio(e.offsetY);
    let pointer = pointers.find(p => p.id == -1);
    if (pointer == null)
        pointer = new pointerPrototype();
    updatePointerDownData(pointer, -1, posX, posY);
});

canvas.addEventListener('mousemove', e => {
    let pointer = pointers[0];
    if (!pointer.down) return;
    let posX = scaleByPixelRatio(e.offsetX);
    let posY = scaleByPixelRatio(e.offsetY);
    updatePointerMoveData(pointer, posX, posY);
});

canvas.addEventListener('mouseup', () => {
    updatePointerUpData(pointers[0]);
});

canvas.addEventListener('touchstart', e => {
    e.preventDefault();
    const touches = e.targetTouches;
    while (touches.length >= pointers.length)
        pointers.push(new pointerPrototype());
    for (let i = 0; i < touches.length; i++) {
        let posX = scaleByPixelRatio(touches[i].pageX);
        let posY = scaleByPixelRatio(touches[i].pageY);
        updatePointerDownData(pointers[i + 1], touches[i].identifier, posX, posY);
    }
});

canvas.addEventListener('touchmove', e => {
    e.preventDefault();
    const touches = e.targetTouches;
    for (let i = 0; i < touches.length; i++) {
        let pointer = pointers[i + 1];
        if (!pointer.down) continue;
        let posX = scaleByPixelRatio(touches[i].pageX);
        let posY = scaleByPixelRatio(touches[i].pageY);
        updatePointerMoveData(pointer, posX, posY);
    }
}, false);

canvas.addEventListener('touchend', e => {
    const touches = e.changedTouches;
    for (let i = 0; i < touches.length; i++)
    {
        let pointer = pointers.find(p => p.id == touches[i].identifier);
        if (pointer == null) continue;
        updatePointerUpData(pointer);
    }
});

canvas.addEventListener('keydown', e => {
    if (e.code === 'KeyP')
        config.PAUSED = !config.PAUSED;
    if (e.key === ' ')
        /* was parseInt(float): that stringifies first, so a value below 1e-6
           renders as "9.5e-7" and parses to 9 instead of 0. */
        splatStack.push(Math.floor(Math.random() * 20) + 5);
});

function updatePointerDownData (pointer, id, posX, posY) {
    pointer.id = id;
    pointer.down = true;
    pointer.moved = false;
    pointer.texcoordX = posX / canvas.width;
    pointer.texcoordY = 1.0 - posY / canvas.height;
    pointer.prevTexcoordX = pointer.texcoordX;
    pointer.prevTexcoordY = pointer.texcoordY;
    pointer.deltaX = 0;
    pointer.deltaY = 0;
    pointer.color = generateColor();
}

function updatePointerMoveData (pointer, posX, posY) {
    pointer.prevTexcoordX = pointer.texcoordX;
    pointer.prevTexcoordY = pointer.texcoordY;
    pointer.texcoordX = posX / canvas.width;
    pointer.texcoordY = 1.0 - posY / canvas.height;
    pointer.deltaX = correctDeltaX(pointer.texcoordX - pointer.prevTexcoordX);
    pointer.deltaY = correctDeltaY(pointer.texcoordY - pointer.prevTexcoordY);
    pointer.moved = Math.abs(pointer.deltaX) > 0 || Math.abs(pointer.deltaY) > 0;
}

function updatePointerUpData (pointer) {
    pointer.down = false;
}

function correctDeltaX (delta) {
    let aspectRatio = canvas.width / canvas.height;
    if (aspectRatio < 1) delta *= aspectRatio;
    return delta;
}

function correctDeltaY (delta) {
    let aspectRatio = canvas.width / canvas.height;
    if (aspectRatio > 1) delta /= aspectRatio;
    return delta;
}

function generateColor () {
    let c = HSVtoRGB(Math.random(), 1.0, 1.0);
    c.r *= 0.15;
    c.g *= 0.15;
    c.b *= 0.15;
    return c;
}

function HSVtoRGB (h, s, v) {
    let r, g, b, i, f, p, q, t;
    i = Math.floor(h * 6);
    f = h * 6 - i;
    p = v * (1 - s);
    q = v * (1 - f * s);
    t = v * (1 - (1 - f) * s);

    switch (i % 6) {
        case 0: r = v, g = t, b = p; break;
        case 1: r = q, g = v, b = p; break;
        case 2: r = p, g = v, b = t; break;
        case 3: r = p, g = q, b = v; break;
        case 4: r = t, g = p, b = v; break;
        case 5: r = v, g = p, b = q; break;
    }

    return {
        r,
        g,
        b
    };
}

function normalizeColor (input) {
    let output = {
        r: input.r / 255,
        g: input.g / 255,
        b: input.b / 255
    };
    return output;
}

function wrap (value, min, max) {
    let range = max - min;
    if (range == 0) return min;
    return (value - min) % range + min;
}

function getResolution (resolution) {
    let aspectRatio = gl.drawingBufferWidth / gl.drawingBufferHeight;
    if (aspectRatio < 1)
        aspectRatio = 1.0 / aspectRatio;

    let min = Math.round(resolution);
    let max = Math.round(resolution * aspectRatio);

    if (gl.drawingBufferWidth > gl.drawingBufferHeight)
        return { width: max, height: min };
    else
        return { width: min, height: max };
}

function getTextureScale (texture, width, height) {
    return {
        x: width / texture.width,
        y: height / texture.height
    };
}

function scaleByPixelRatio (input) {
    let pixelRatio = window.devicePixelRatio || 1;
    return Math.floor(input * pixelRatio);
}

function hashCode (s) {
    if (s.length == 0) return 0;
    let hash = 0;
    for (let i = 0; i < s.length; i++) {
        hash = (hash << 5) - hash + s.charCodeAt(i);
        hash |= 0; // Convert to 32bit integer
    }
    return hash;
};

/* ── PUBLIC INSTANCE 
   The solver above runs on its own rAF loop in the original. Here `step` is
   called by the host so the game controls pacing and can pause the effect
   without leaving a stray loop running. */
var _paletteName='water';
var PALETTES={
  /* Deep blues and cyans for water scenery. */
  water:  function(){ return {r:0.05+Math.random()*0.10, g:0.25+Math.random()*0.35, b:0.60+Math.random()*0.40}; },
  /* Greens and violets, to sit alongside the aurora. */
  aurora: function(){ var v=Math.random()<0.5;
                      return v?{r:0.10,g:0.70+Math.random()*0.30,b:0.35}
                              :{r:0.45+Math.random()*0.35,g:0.10,b:0.75}; },
  fire:   function(){ return {r:0.80+Math.random()*0.20, g:0.20+Math.random()*0.35, b:0.02}; },
  ice:    function(){ return {r:0.45+Math.random()*0.20, g:0.75+Math.random()*0.20, b:0.95}; },
  random: function(){ var c=generateColor(); return c; }
};
function paletteColour(){
  var f=PALETTES[_paletteName]||PALETTES.water;
  var c=f();
  /* The solver expects roughly 0..0.15 magnitudes; brighter values blow out. */
  return {r:c.r*0.15, g:c.g*0.15, b:c.b*0.15};
}

var _ovalPrev=null;

return {
  /* Inject at normalised coordinates. dx/dy are velocity, not position. */
  /* `radius` is optional and temporary: the default SPLAT_RADIUS (0.25) covers
     a quarter of the screen, which is right for a mouse-drawn wash but merges
     any structured pattern into one blob — a 30-point ring has ~0.06 between
     neighbours, so every blob overlapped its neighbours four times over.
     Patterns pass a small radius; the previous value is always restored so a
     caller cannot leak its setting into the next one. */
  splat:function(x,y,dx,dy,color,radius){
    try{
      var prev=config.SPLAT_RADIUS;
      if(radius!=null)config.SPLAT_RADIUS=radius;
      splat(x*canvas.width, (1-y)*canvas.height, dx, -dy, color||paletteColour());
      config.SPLAT_RADIUS=prev;
    }catch(e){}
  },
  /* Direct access for callers that want to set it for a whole frame. */
  splatRadius:function(v){ if(v!=null)config.SPLAT_RADIUS=v; return config.SPLAT_RADIUS; },
  /* (1) AUTONOMOUS MOTION.
     Traces a pointer around an oval lying on its side, so the fluid stirs
     itself with no user input. Velocity is the DIFFERENCE between successive
     points, which is what makes the dye follow the path rather than pooling. */
  autoOval:function(t, o){
    o=o||{};
    var w=(o.width==null?0.80:o.width);      // 80% of the screen by default
    var h=(o.height==null?w*0.42:o.height);
    var cx=(o.cx==null?0.5:o.cx), cy=(o.cy==null?0.5:o.cy);
    var speed=(o.speed==null?0.55:o.speed);
    var a=t*speed;
    var x=cx+Math.cos(a)*w*0.5;
    var y=cy+Math.sin(a)*h*0.5;
    if(_ovalPrev){
      var dx=(x-_ovalPrev[0])*canvas.width*(o.force==null?6:o.force);
      var dy=(y-_ovalPrev[1])*canvas.height*(o.force==null?6:o.force);
      try{ splat(x*canvas.width,(1-y)*canvas.height,dx,-dy,paletteColour()); }catch(e){}
    }
    _ovalPrev=[x,y];
  },
  setPalette:function(n){ if(PALETTES[n])_paletteName=n; },
  tint:function(r,g,b){
    PALETTES.fixed=function(){return {r:r,g:g,b:b};};
    _paletteName='fixed';
  },
  burst:function(n){ try{ multipleSplats(n||8); }catch(e){} },
  /* Empty the dye and velocity fields. A pattern needs a clean surface: dye
     left over from a previous mode blends with it and turns a crisp shape into
     the generic wash. */
  clear:function(){
    try{
      clearProgram.bind();
      gl.uniform1i(clearProgram.uniforms.uTexture, dye.read.attach(0));
      gl.uniform1f(clearProgram.uniforms.value, 0);
      blit(dye.write); dye.swap();
      gl.uniform1i(clearProgram.uniforms.uTexture, velocity.read.attach(0));
      gl.uniform1f(clearProgram.uniforms.value, 0);
      blit(velocity.write); velocity.swap();
    }catch(e){}
  },
  step:function(){ try{ update(); }catch(e){} },
  /* initFramebuffers() runs UNCONDITIONALLY, and that is deliberate.
     Gating it on resizeCanvas()'s return value looked like a free saving and
     caused a regression: the canvas element and the simulation targets are
     sized independently, so a canvas whose width already happens to be right
     while its framebuffers were allocated during a spell at display:none
     reports "no change" and never gets rebuilt. The sim then stays at its 2px
     floor and draws a small box into the corner of a full-screen element.
     Rebuilding whenever asked is what made this self-healing, and the cost is
     already controlled by fit(), which only calls resize() when the backing
     store genuinely disagrees with the layout. */
  resize:function(){ try{ resizeCanvas(); initFramebuffers(); }catch(e){} },
  config:config,
  canvas:canvas,
  /* THE THING THAT ACTUALLY DETERMINES WHAT IS DRAWN.
     The canvas element and the simulation targets are sized independently,
     and the recurring "small box in the corner" is the case where the canvas
     is correct while the dye buffer was allocated during a spell at
     display:none. A host checking only canvas.width sees nothing wrong and
     never asks for a rebuild, so the sim stays at its 2px floor forever.
     Publishing the dye resolution lets fit() test the real thing. */
  simSize:function(){ try{ return dye?[dye.width,dye.height]:null; }catch(e){ return null; } }
};

}  /* end createWater */

/* Quality fixed per spec: high dye resolution, 256 simulation grid. */
function create(canvas,opts){
  try{
    var inst=createWater(canvas,opts);
    if(inst&&inst.config){
      /* 'High' quality per spec. DYE at 512 rather than 1024: the effect is a
         soft background wash, and 1024 quadruples the fill cost of every dye
         pass for detail that is not visible behind the road, the HUD and the
         other layers. SIM stays at 256 as specified — that is what governs the
         motion, which IS visible. */
      inst.config.DYE_RESOLUTION=512;
      inst.config.SIM_RESOLUTION=256;
      inst.resize();
    }
    return inst;
  }catch(e){ console.warn('water.js init failed:',e); return null; }
}

global.Water={create:create};

})(typeof window!=='undefined'?window:globalThis);


/* 
   WATER SURFACE EFFECTS   (was waterfx.js)
   ---------------------------------------------------------------------------
   Depends on water.js and must load after it.
    */
/* 
   waterfx.js — fluid effect integration for ZONE STORM RACING GX
   ---------------------------------------------------------------------------
   Drives water.js at the four places the game uses it:

     1. CAR SELECT   background stirred along a sideways oval, 80% of screen
     2. WATER TRACKS blue fluid on tracks the generator gave water scenery
     3. TUNNELS      the world outside the bore, agitated as you pass through
     4. SKY          combined with aurora / airglow and the rest

   WHY A MANAGER RATHER THAN FOUR INSTANCES
   Each fluid instance holds a WebGL context with several float framebuffers.
   Browsers cap live contexts (typically ~16) and each one costs real VRAM, so
   four independent sims would be wasteful and could fail outright on weaker
   hardware. There is exactly ONE instance here; the four uses differ only in
   palette, placement and how the fluid is stirred. Switching use re-tints and
   re-parents the same canvas.

   The canvas is also never destroyed once created — tearing down and rebuilding
   a WebGL context on every screen change is slow and leaks on some drivers.
    */

(function(global){
'use strict';

var _inst=null, _cv=null, _mode=null, _t=0, _raf=0, _dead=false,
    _suppressed=false, _suppressOwner=null;

/* Quality is fixed per spec: high dye resolution, 256 simulation grid. Both are
   set inside Water.create, so nothing here needs to repeat them. */
function ensure(){
  if(_dead)return null;
  if(_inst)return _inst;
  try{
    if(!global.Water){ _dead=true; return null; }
    _cv=document.createElement('canvas');
    _cv.id='zs-waterfx';
    /* THE EFFECT COULD NEVER RENDER.
       water.js sizes itself from canvas.clientWidth/clientHeight — the CSS
       layout size. The canvas was created with display:none, so both were 0,
       every framebuffer was allocated 0x0, and no amount of simulation could
       produce a visible pixel.
       It is therefore created VISIBLE and laid out first, then hidden only
       after the instance exists and its buffers are sized. */
    /* `will-change` promotes the layer so the compositor keeps it on the GPU
       instead of re-uploading each frame. Without it a full-screen canvas is
       re-composited every frame even when its contents have not changed. */
    /* THE SMALL SQUARE IN THE CORNER.
       `inset:0` alone does not stretch a <canvas>: the element keeps its
       intrinsic backing-store size unless CSS width/height say otherwise. With
       _zsScale halving the backing store to e.g. 960x540, the canvas rendered
       at exactly that size in the top-left instead of filling the viewport.
       Explicit 100% width/height scales the (deliberately smaller) backing
       store up to fill the screen, which is the whole point of rendering at
       half resolution. */
    _cv.style.cssText='position:fixed;left:0;top:0;width:100vw;height:100vh;'+
                      'pointer-events:none;display:block;opacity:0;'+
                      'will-change:transform;transform:translateZ(0)';
    document.body.appendChild(_cv);
    /* Half-resolution backing store, applied INSIDE water.js via _zsScale.
       Setting _cv.width here did nothing: resizeCanvas overwrites it from
       clientWidth on the very next frame. */
    _cv._zsScale=0.5;
    _inst=global.Water.create(_cv,{});
    if(!_inst){ _dead=true; _cv.remove(); _cv=null; return null; }
    /* Now that the buffers are sized from a real layout, park it hidden. */
    _cv.style.display='none';
    _cv.style.opacity='';
    return _inst;
  }catch(e){ _dead=true; return null; }
}

/* Keep the backing store matched to the window, or the sim renders at a stale
   resolution and appears stretched. */
function fit(){
  /* UNCONDITIONAL. Every attempt to be clever here — checking window size,
     tracking _lastW, throttling with a timer, testing the dye buffer — has
     produced a regression. The water effect has broken four times, and three
     of those were caused by one of those optimisations removing a safety
     margin that turned out to be load-bearing.
     resize() calls resizeCanvas() which is already a no-op when the size has
     not changed. The only real cost of calling it unnecessarily is one WebGL
     viewport call. That is cheaper than the fourth regression. */
  if(!_cv||!_inst)return;
  try{ _inst.resize(); }catch(e){}
}

/* THE EFFECT WAS INVISIBLE.
   The game canvas sits at z-index 2000000, so the in-race modes at 1999997-8
   were painted BEHIND it and could never be seen — the sim was running and
   compositing at full cost while contributing nothing.
   All in-race modes now sit above the game canvas and below the HUD overlay,
   with `mix-blend-mode:screen` so they add light rather than covering the
   road. Screen blending is also why the alphas can be higher without the
   track becoming unreadable. */
var MODES={
  /* Background uses sit BEHIND their content: z-index 1 for the car-select
     screen (.screen is at 20) and 1499 for the world map (canvas at 1500,
     which is why that canvas also needs a transparent background).
     Both are BLUE — the aurora palette read green/violet and did not look like
     water at all. */
  carselect:{ palette:'water', z:'1',    alpha:'1', blend:'normal' },
  worldmap: { palette:'water', z:'1499', alpha:'1', blend:'normal' },
  /* (2) Water-scenery tracks. */
  /* In-race alphas raised: at 0.6 with screen blending over a bright road the
     effect was present but effectively invisible. */
  water:    { palette:'water',  z:'2000002', alpha:'0.95', blend:'screen' },
  /* (3) Tunnel exterior, brighter because it is seen through an opening. */
  /* THE ROAD MUST STAY CLEAR.
     The fluid canvas covers the whole viewport, so a tunnel pattern painted
     over the track surface as well as the walls — the one place it must never
     be, because the player is reading the road. `mask` fades the layer out
     below the horizon, so the effect lives on the bore walls and ceiling and
     stops before the tarmac. */
  /* (2) NO MASK, NO BLEND MODE.
     `mix-blend-mode` needs its element to share a stacking context with what
     it blends against, and a fixed, z-indexed, masked element creates its own
     — so the layer was compositing against the page rather than the game, and
     the mask plus blend together produced nothing visible.
     Plain alpha compositing is predictable and always shows. The road is
     already protected by the FLOOR_Y clamp, which discards any point below the
     horizon before it ever reaches the simulation, so the mask was redundant
     as well as harmful. */
  tunnel:   { palette:'water',  z:'2000002', alpha:'0.92', blend:'normal' },
  /* (4) Sky layer, alongside the aurora. */
  sky:      { palette:'water',  z:'2000002', alpha:'0.85', blend:'screen' }
};

function setMode(name){
  if(_suppressed)return false;
  var w=ensure(); if(!w)return false;
  var m=MODES[name]; if(!m)return false;
  /* Tunnel patterns alter dissipation for line art; every other mode is a
     soft wash and needs the library defaults back. */
  try{
    if(w.config&&name!=="tunnel"){
      w.config.DENSITY_DISSIPATION=1;
      w.config.VELOCITY_DISSIPATION=0.2;
      /* The washes are meant to glow, so the post-processing returns. */
      w.config.BLOOM=true;
      w.config.SUNRAYS=true;
      w.config.SHADING=true;
      w.config.COLORFUL=true;
    }
  }catch(e){}
  if(_mode!==name){
    _mode=name;
    try{ w.setPalette(m.palette); }catch(e){}
    /* setProperty with 'important' so no stylesheet rule can bury the layer —
       a global `#zs-waterfx{z-index:1!important}` did exactly that during
       races, placing the fluid two million layers beneath the game canvas. */
    _cv.style.setProperty('z-index',m.z,'important');
    _cv.style.opacity=m.alpha;
    _cv.style.mixBlendMode=m.blend||'normal';
    /* Both spellings: WebKit still requires the prefixed property. */
    try{
      _cv.style.webkitMaskImage=m.mask||'none';
      _cv.style.maskImage=m.mask||'none';
    }catch(e){}
    /* THIS IS WHY THE PATTERNS WERE NEVER VISIBLE.
       burst() calls multipleSplats(), which injects ten RANDOM-coloured blobs
       at 10x brightness and the full 0.25 radius. Against a pattern point at
       0.55 brightness and 0.010 radius that is roughly 11,000 times the dye —
       so the entry burst simply became the whole effect, and what showed was
       the stock water.js look rather than any pattern.
       The seeding burst is only useful for the soft washes on the menu
       screens. A tunnel pattern draws its own shape immediately and needs a
       clean field to draw it on. */
    if(name!=='tunnel'){
      try{ w.burst(10); }catch(e){}
    } else {
      /* Clear anything the previous mode left behind, so a pattern starts on
         an empty field rather than over a menu wash. */
      try{ if(w.clear)w.clear(); }catch(e){}
    }
  }
  _cv.style.display='block';
  _cv.style.visibility='visible';
  /* FORCE a full re-evaluation of the backing store on every entry to a mode.
     fit() short-circuits on an unchanged window, which is right for the
     per-frame case but wrong here: entering a screen is exactly the moment the
     canvas may have been sized while collapsed. Going straight from the title
     to the World Tour map on a fresh load did this — that path builds the
     instance while the element has no usable layout, and because innerWidth
     never changed afterwards nothing ever corrected it, so the sim stayed at
     its 2px floor and drew into the corner. Grand Prix escaped it only because
     its own rAF loop happens to call fit() before the first paint.
     Clearing _lastW costs one comparison and guarantees the check actually
     runs; resize() itself is now a no-op when the size is already correct. */
  _cv._lastW=-1; _cv._lastH=-1;
  fit();
  return true;
}
/* `visibility` rather than `display`: display:none collapses the element's
   layout box, so clientWidth/clientHeight go to 0 and the next resize would
   rebuild the framebuffers at zero size. visibility:hidden keeps the box. */
function hide(){ if(_cv){_cv.style.visibility='hidden';} }
function active(){ return !!(_cv&&_cv.style.visibility==='visible'); }

/* ── DRIVERS 
   Each use stirs the fluid differently. None requires user input. */

/* (1) A pointer tracing a sideways oval at 80% of screen width. */
/* CONTINUOUS MOTION.
   One autoOval splat per frame injects less dye than dissipation removes, so
   the effect bloomed once and faded to nothing — that is the "plays once and
   stops". Three offset emitters keep it alive indefinitely, and a periodic
   burst reseeds it so it never settles into a static pattern. */
var _burstAt=0, _stickX=0.5, _stickY=0.5;
/* (12) FULL-VIEWPORT COVERAGE.
   autoOval traces an ellipse, so it only ever seeds the band it sweeps —
   with height 0.52 that left the top and bottom ~24% of the screen with no
   dye at all, which is why the effect appeared only along two edges.
   A perimeter emitter walks the full rectangle so every edge and corner gets
   fed, and a wandering interior point covers the middle. Together they reach
   the whole viewport regardless of the oval's shape. */
function feedEdges(w,t,force){
  var f=force||6;
  /* Walk the perimeter: 0-1 top, 1-2 right, 2-3 bottom, 3-4 left. */
  var u=(t*0.23)%4;
  var ex,ey,vx,vy;
  if(u<1){        ex=u;        ey=0.02; vx=0;    vy= 420; }
  else if(u<2){   ex=0.98;     ey=u-1;  vx=-420; vy=0;    }
  else if(u<3){   ex=1-(u-2);  ey=0.98; vx=0;    vy=-420; }
  else {          ex=0.02;     ey=1-(u-3); vx= 420; vy=0; }
  w.splat(ex,ey,vx*f/6,vy*f/6);
  /* Second emitter half a lap ahead, so opposite edges are fed at once. */
  var u2=(u+2)%4;
  var gx,gy,wx,wy;
  if(u2<1){       gx=u2;       gy=0.02; wx=0;    wy= 420; }
  else if(u2<2){  gx=0.98;     gy=u2-1; wx=-420; wy=0;    }
  else if(u2<3){  gx=1-(u2-2); gy=0.98; wx=0;    wy=-420; }
  else {          gx=0.02;     gy=1-(u2-3); wx= 420; wy=0; }
  w.splat(gx,gy,wx*f/6,wy*f/6);
  /* Interior wanderer on incommensurable periods so the centre never
     develops a static pattern. */
  var ix=0.5+Math.sin(t*0.17)*0.42+Math.sin(t*0.091+1.3)*0.06;
  var iy=0.5+Math.cos(t*0.13)*0.42+Math.sin(t*0.067+2.1)*0.06;
  w.splat(ix,iy,Math.cos(t*0.17)*260,-Math.sin(t*0.13)*260);
}
function feed(w,t,o){
  w.autoOval(t,o);
  feedEdges(w,t,o.force);
  w.autoOval(t*0.73+2.1,{width:o.width*0.62,height:o.height*1.4,cx:0.5,cy:0.5,
                         speed:-(o.speed||0.6)*0.8,force:(o.force||7)*0.8});
  w.autoOval(t*1.31+4.7,{width:o.width*0.34,height:o.height*0.5,cx:0.5,cy:0.5,
                         speed:(o.speed||0.6)*1.6,force:(o.force||7)*0.6});
  if(t-_burstAt>4){ _burstAt=t; try{ w.burst(5); }catch(e){} }
}
/* Right analog stick pushes the fluid directly. */
function applyStick(w){
  try{
    var pads=navigator.getGamepads?navigator.getGamepads():[];
    for(var i=0;i<pads.length;i++){
      var p=pads[i]; if(!p||!p.connected)continue;
      var rx=p.axes[2]||0, ry=p.axes[3]||0;
      if(Math.abs(rx)<0.14&&Math.abs(ry)<0.14)continue;
      /* The stick POSITION maps directly to a screen point rather than
         integrating a drift: integrating meant a held stick ran the emitter
         into a corner and stuck there. */
      _stickX=Math.max(0.04,Math.min(0.96,0.5+rx*0.46));
      _stickY=Math.max(0.04,Math.min(0.96,0.5+ry*0.46));
      var mag=Math.min(1,Math.hypot(rx,ry));
      w.splat(_stickX,1-_stickY,rx*1500*mag,-ry*1500*mag);
      return;
    }
  }catch(e){}
}
function driveCarSelect(dt){
  var w=ensure(); if(!w)return;
  _t+=dt;
  /* Full viewport, since this is a background rather than a framed effect.
     The oval's HEIGHT is what decides how far up and down the screen dye is
     actually injected, and at 0.44 it only ever reached the middle 44% —
     the comment said full viewport but the geometry did not. feedEdges walks
     the perimeter so the extreme edges got a trickle, leaving the effect
     visible as a band across the centre with dead ground above and below. */
  feed(w,_t,{width:1.00,height:0.94,cx:0.5,cy:0.5,speed:0.6,force:9});
  applyStick(w);
  w.step();
}
function driveWorldMap(dt){
  var w=ensure(); if(!w)return;
  _t+=dt;
  /* Same reason as carSelect above: 0.52 covered only the middle half. */
  feed(w,_t,{width:1.00,height:0.96,cx:0.5,cy:0.5,speed:0.34,force:7});
  applyStick(w);
  w.step();
}

/* (2) Water tracks: two counter-rotating currents, so the surface churns
   rather than circling, plus a nudge that follows the car's lateral position
   so the fluid reacts to the driving. */
function driveWater(dt,carX,speed){
  var w=ensure(); if(!w)return;
  _t+=dt;
  /* Same continuous feed as the background uses, or the effect fades out
     mid-race exactly as it did on the menus. */
  feed(w,_t,{width:0.95,height:0.34,cx:0.5,cy:0.58,speed:0.45,force:8});
  if(speed>0.05){
    var x=0.5+(carX||0)*0.28;
    w.splat(x,0.30,(Math.random()-0.5)*400,-260*Math.min(1,speed));
  }
  w.step();
}

/* (3) Tunnel exterior: agitated from the sides, as though the bore were
   cutting through a body of water. */
/* TUNNEL SURFACE.
   Slow and wandering rather than the fast side-jets it had before: inside a
   bore the fluid should read as a still body of water the tunnel passes
   through, disturbed gently, not as a pressure washer.
   The motion is driven by three incommensurable sine terms — their periods
   share no common multiple, so the path never repeats exactly and the movement
   looks random without needing an RNG that would make it jitter. */
/* (7) TUNNEL INTERIOR.
   The emitters used to sit at the screen edges, which is where the bore mouth
   projects when you are OUTSIDE it — so the effect was hidden behind the
   tunnel wall exactly when the player was inside and could have seen it.
   They now run down the centre band, which is the inner surface ahead of the
   car, with a slow drift so it reads as water sheeting along the bore. */
/* ═══ TUNNEL WALL PATTERNS 
   Ten motifs painted onto the INSIDE SURFACE of the bore, so the player is
   surrounded by them while driving through.

   THE GEOMETRY IS THE WHOLE POINT
   An earlier version scattered splats around the screen, which read as
   coloured blobs rather than as anything on a wall. Every pattern here instead
   works in TUNNEL SPACE — an angle around the bore (theta) and a distance
   ahead (depth) — and is projected to the screen by `wall()`. Because the
   projection converges on the vanishing point, a shape drawn at constant theta
   automatically follows the curve of the wall and recedes correctly, which is
   what makes it look painted onto the surface rather than floating in front
   of it.

   CONTINUITY
   Every emitter runs on every frame and is always in motion: patterns advance
   with `t` rather than being re-seeded, so dye is laid down in unbroken lines.
   Nothing here bursts.

   ONE HUE PER TUNNEL
   The solver blends whatever it is given; several hues at once turn to mud in
   about a second. Each pattern uses a single hue from the track seed and
   varies only brightness, which is also what makes them read as neon. */

var TUNNEL_PATTERNS=[
  'pulseRings','spiralVortex','warpLines','hexGrid','rippleWaves',
  'twistedHelix','cyclone','barberPole','corkscrewRings','pinwheel'
];
var CX=0.5, CY=0.42;      // vanishing point: centre of the bore ahead
var FLOOR_Y=0.56;         // road begins here; nothing may be drawn below it

/* TUNNEL-SPACE PROJECTION.
   theta: angle around the bore, 0 = right, running counter-clockwise.
   depth: 0 at the vanishing point, 1 at the mouth around the camera.
   The radius grows with depth so the wall opens out toward the viewer, and
   the vertical axis is squashed because the bore is wider than it is tall. */
function wall(theta,depth){
  var r=0.045+depth*depth*0.62;          // quadratic: perspective, not linear
  var x=CX+Math.cos(theta)*r;
  var y=CY+Math.sin(theta)*r*0.66;
  return [x,y];
}
/* Velocity tangent to the wall, so dye is dragged ALONG the surface rather
   than pushed off it. */
function wallFlow(theta,mag){
  return [-Math.sin(theta)*mag, -Math.cos(theta)*mag];
}
function _tunnelHue(seed){ return ((seed>>>0)%360)/360; }
function _neon(h,bright){
  var c=hslToRgb(h,0.92,0.35+0.30*(bright==null?1:bright));
  return {r:c[0]*0.55, g:c[1]*0.55, b:c[2]*0.55};
}
var PAT_R=0.010;
/* Emit one point on the wall, dropping anything that would land on the road. */
function wallSplat(w,theta,depth,mag,col){
  var p=wall(theta,depth);
  if(p[1]>FLOOR_Y)return;
  var v=wallFlow(theta,mag);
  w.splat(p[0],p[1],v[0],v[1],col,PAT_R);
}

/* 1. PULSE RINGS — full rings of light sweeping down the bore toward you. */
function _pPulseRings(w,t,h){
  for(var i=0;i<6;i++){
    var d=((t*0.30+i/6)%1);
    var col=_neon(h,0.35+(1-d)*0.65);
    for(var a=0;a<42;a++)wallSplat(w,(a/42)*Math.PI*2,d,120,col);
  }
}
/* 2. SPIRAL VORTEX — ribbons corkscrewing along the wall. */
function _pSpiralVortex(w,t,h){
  for(var b=0;b<3;b++){
    for(var i=0;i<30;i++){
      var d=i/30;
      var th=d*Math.PI*3.2+b*(Math.PI*2/3)-t*1.5;
      wallSplat(w,th,d,300,_neon(h,0.4+(1-d)*0.6));
    }
  }
}
/* 3. WARP LINES — streaks running the length of the bore, rushing past. */
function _pWarpLines(w,t,h){
  for(var i=0;i<16;i++){
    var th=(i/16)*Math.PI*2;
    /* Each streak occupies a moving window of depth, so it reads as a line
       travelling toward the camera rather than a static spoke. */
    var head=((t*0.55+i*0.0625)%1);
    for(var k=0;k<7;k++){
      var d=head-k*0.035;
      if(d<0)continue;
      wallSplat(w,th,d,60,_neon(h,(1-k/7)*(0.3+(1-d)*0.7)));
    }
  }
}
/* 4. HEX GRID — honeycomb on the wall with a pulse rolling down it. */
function _pHexGrid(w,t,h){
  for(var ring=0;ring<7;ring++){
    var d=0.10+ring*0.13;
    var n=10+ring*2;
    var pulse=Math.max(0,1-Math.abs(((t*0.35)%1)-d)*5);
    for(var a=0;a<n;a++){
      var th=(a/n)*Math.PI*2+(ring%2)*(Math.PI/n);
      wallSplat(w,th,d,50,_neon(h,0.25+pulse*0.75));
    }
  }
}
/* 5. RIPPLE WAVES — rings expanding out of the vanishing point. */
function _pRippleWaves(w,t,h){
  for(var i=0;i<5;i++){
    var d=((t*0.26+i/5)%1);
    var fade=Math.sin(d*Math.PI);
    for(var a=0;a<40;a++)wallSplat(w,(a/40)*Math.PI*2,d,90,_neon(h,fade));
  }
}
/* 6. TWISTED HELIX — two strands winding around one another down the bore. */
function _pTwistedHelix(w,t,h){
  for(var strand=0;strand<2;strand++){
    for(var i=0;i<34;i++){
      var d=i/34;
      var th=d*Math.PI*2.6+strand*Math.PI-t*1.2;
      wallSplat(w,th,d,320,_neon(h,strand?0.55:1));
    }
  }
}
/* 7. CYCLONE — a dense band whirling around the perimeter. */
function _pCyclone(w,t,h){
  for(var i=0;i<44;i++){
    var th=(i/44)*Math.PI*2+t*2.4;
    /* Depth undulates, so the band sweeps forward and back along the bore. */
    var d=0.34+Math.sin(t*0.8+i*0.30)*0.26;
    wallSplat(w,th,d,460,_neon(h,0.45+0.55*Math.sin(i*0.5+t*2)));
  }
}
/* 8. BARBER POLE — wide angled bands rotating around the wall. */
function _pBarberPole(w,t,h){
  for(var band=0;band<4;band++){
    for(var i=0;i<26;i++){
      var d=i/26;
      var th=(band/4)*Math.PI*2+d*Math.PI*1.5+t*1.6;
      wallSplat(w,th,d,260,_neon(h,band%2?0.30:1));
    }
  }
}
/* 9. CORKSCREW RINGS — rings tumbling off-axis as they come at you. */
function _pCorkscrewRings(w,t,h){
  for(var i=0;i<4;i++){
    var d=((t*0.28+i/4)%1);
    var tilt=Math.sin(t*1.6+i*1.7)*0.34;      // wobble about the bore axis
    for(var a=0;a<34;a++){
      var th=(a/34)*Math.PI*2;
      /* Tilt modulates the ring's depth around its circumference, which is
         what makes it look thrown rather than sliding flat. */
      var dd=Math.max(0,Math.min(1,d+Math.cos(th)*tilt*0.12));
      wallSplat(w,th,dd,140,_neon(h,0.35+(1-d)*0.65));
    }
  }
}
/* 10. PINWHEEL — spokes on the wall, counter-rotating layers, moire. */
function _pPinwheel(w,t,h){
  for(var layer=0;layer<2;layer++){
    var dir=layer?-1:1;
    for(var spoke=0;spoke<10;spoke++){
      for(var i=1;i<=18;i++){
        var d=i/18;
        var th=(spoke/10)*Math.PI*2+dir*t*0.75+d*0.5*dir;
        wallSplat(w,th,d,150,_neon(h,layer?0.45:1));
      }
    }
  }
}
var _PATTERN_FN={
  pulseRings:_pPulseRings, spiralVortex:_pSpiralVortex, warpLines:_pWarpLines,
  hexGrid:_pHexGrid, rippleWaves:_pRippleWaves, twistedHelix:_pTwistedHelix,
  cyclone:_pCyclone, barberPole:_pBarberPole,
  corkscrewRings:_pCorkscrewRings, pinwheel:_pPinwheel
};
var _tunPattern=null, _tunHue=0, _tunSeed=-1;

/* `solve` lets the host skip the expensive pressure solve on alternate frames
   while dye is still injected every frame — that is what keeps the flow
   unbroken without paying the full simulation cost each time. */
function driveTunnel(dt,progress,seed,solve){
  var w=ensure(); if(!w)return;
  _t+=dt;
  if(seed!=null&&seed!==_tunSeed){
    _tunSeed=seed;
    _tunPattern=TUNNEL_PATTERNS[(seed>>>0)%TUNNEL_PATTERNS.length];
    _tunHue=_tunnelHue((seed>>>0)*2654435761);
  }
  if(!_tunPattern){ _tunPattern=TUNNEL_PATTERNS[0]; _tunHue=0.55; }
  /* Line art, not a wash: dye must hold its shape between frames and velocity
     must not smear it across the wall. */
  try{
    if(w.config){
      w.config.DENSITY_DISSIPATION=0.22;
      w.config.VELOCITY_DISSIPATION=2.2;
      /* (1) THE MULTIPLE COLOURS.
         BLOOM and SUNRAYS are post-processes that bleed bright areas outward
         and tint them; SHADING adds directional lighting from the velocity
         field. Together they turned a single-hue pattern into a smear of
         several colours and washed the line work away — which is why no
         pattern was distinguishable.
         For line art all three must be off: what should reach the screen is
         exactly the dye that was injected. */
      w.config.BLOOM=false;
      w.config.SUNRAYS=false;
      w.config.SHADING=false;
      w.config.COLORFUL=false;      // stops pointer hues cycling in
    }
  }catch(e){}
  (_PATTERN_FN[_tunPattern]||_pPulseRings)(w,_t,_tunHue);
  if(solve!==false)w.step();
}
/* Which motif is running, for the diagnostic readout. */
function tunnelPattern(){ return _tunPattern; }

/* (4) Sky: slow, wide and gentle so it reads as atmosphere behind the aurora
   rather than as a competing effect. */
function driveSky(dt,hue){
  var w=ensure(); if(!w)return;
  _t+=dt;
  if(hue!=null){
    var h=(hue%360)/360, c=hslToRgb(h,0.75,0.55);
    try{ w.tint(c[0]*0.12,c[1]*0.12,c[2]*0.12); }catch(e){}
  }
  feed(w,_t*0.35,{width:1.1,height:0.30,cx:0.5,cy:0.24,speed:0.25,force:6});
  w.step();
}

function hslToRgb(h,s,l){
  var a=s*Math.min(l,1-l);
  var f=function(n){
    var k=(n+h*12)%12;
    return l-a*Math.max(-1,Math.min(Math.min(k-3,9-k),1));
  };
  return [f(0),f(8),f(4)];
}

global.WaterFX={
  ensure:ensure, setMode:setMode, hide:hide, active:active, fit:fit,
  carSelect:driveCarSelect, worldMap:driveWorldMap,
  water:driveWater, tunnel:driveTunnel, sky:driveSky,
  tunnelPattern:tunnelPattern, TUNNEL_PATTERNS:TUNNEL_PATTERNS,
  /* (2) Which mode is running, for the diagnostic readout. */
  mode:function(){ return _mode; },
  /* Screens that must not show the fluid set this rather than calling hide()
     once, which a per-frame driver would immediately undo. */
  /* (5) SUPPRESSION IS SCOPED, NOT GLOBAL.
     A screen that set suppress(true) and then closed by any route other than
     its own back button left the flag on permanently — setMode() refused every
     later request and the water, tunnel and sky effects silently never
     appeared again. The owner is recorded, so only the screen that set it can
     clear it, and clearScreen() releases it unconditionally when a race
     starts. */
  suppress:function(v,owner){
    if(v){ _suppressed=true; _suppressOwner=owner||'?'; hide(); }
    else if(!owner||owner===_suppressOwner){ _suppressed=false; _suppressOwner=null; }
  },
  /* Called when a race begins: nothing menu-side may hold the effect off. */
  clearSuppress:function(){ _suppressed=false; _suppressOwner=null; },
  suppressed:function(){ return _suppressed; },
  available:function(){ return !_dead&&!!global.Water; },
  canvas:function(){ return _cv; }
};

})(typeof window!=='undefined'?window:globalThis);


/* 
   TUNNEL BORE PATTERNS   (was tunnelfx.js)
   ---------------------------------------------------------------------------
   Ten patterns; a track shows three of them, cycled by position along the road.
    */
/* 
   tunnelfx.js — animated patterns on the interior of a tunnel
   ---------------------------------------------------------------------------
   WHY THIS IS NOT PART OF waterfx.js
   The previous attempts drove these patterns through the fluid simulation.
   That was the wrong tool and no amount of tuning was going to fix it: a fluid
   solver ADVECTS dye through a velocity field. It has no concept of a surface,
   of UV coordinates, or of scrolling a texture — so every shape it was given
   immediately began to dissipate and drift, which is why the patterns never
   looked like anything painted on a wall.

   This module implements what the effect actually requires, following the
   standard approach for texturing a tube interior:

   1. CYLINDRICAL UV PARAMETERIZATION
      The bore is a cylinder around the view axis. Every point on its inner
      surface is addressed by two coordinates:
        u = theta / 2pi   the azimuthal angle around the circumference, 0..1
        v = axial distance down the tunnel
      Patterns are authored in (u,v) space, which is flat and seamless, and
      know nothing about perspective.

   2. UV SCROLLING FOR FORWARD MOTION
      Travelling through the tunnel is simulated by translating the sampling
      coordinate rather than moving geometry:
        v_sampled = v * scale - t * velocity
      This is what produces the sense of rushing forward, and it costs nothing.

   3. SEAMLESS WRAPPING
      u wraps at 1.0 (the circumference closes on itself) and v wraps at the
      pattern's period. Every pattern is authored so its edges match, so the
      scroll never shows a seam.

   4. TRUE PERSPECTIVE PROJECTION
      A point at axial depth d projects to screen radius r = FOCAL / d — the
      reciprocal relationship real perspective has, not the quadratic
      approximation used previously. This is what makes the wall appear to
      recede to a vanishing point and rush past at the edges, and it is the
      single biggest reason this reads as a tunnel rather than as a pattern
      drawn on glass.

   5. INTERIOR SURFACE, NOT EXTERIOR
      We are inside the cylinder looking along it, so nearer rings are drawn
      LAST (painter's order back to front) and the surface is only drawn where
      it is above the road line.
    */

(function(global){
'use strict';

/* ── PROJECTION 
   FOCAL sets how quickly the bore opens out toward the viewer. NEAR is the
   closest depth drawn: at very small d the radius explodes toward infinity,
   so the near plane keeps the geometry finite. */
var FOCAL = 0.085;
var NEAR  = 0.16;
var FAR   = 2.60;

var VP_X  = 0.5;      // vanishing point, normalised screen coordinates
var VP_Y  = 0.42;
var ASPECT_Y = 0.72;  // bore is wider than tall, matching the road's framing
var FLOOR_Y  = 0.58;  // road begins here; nothing is drawn below it
var FLOOR_Y_DEFAULT = 0.58;
/* Bore alignment (see setBore): when the game passes its tunnel geometry, the
   rings are drawn ON the tunnel's own wall — the deepest ring matches the
   bore's far opening exactly, nearer rings grow by true perspective, and each
   ring's centre travels from screen centre (near) to the opening's centre
   (deep) so the pattern follows the tunnel through its curves. */
var _bore = null;
var _tq = 1;   // quality 0..1 from the game (setQuality)

/* Project a point on the cylinder wall to the screen.
   theta: angle around the bore.  d: axial depth ahead of the camera. */
function project(theta, d){
  if(_bore){
    var dd = Math.max(NEAR, d);
    var sc = _bore.rx / (FOCAL / FAR);                 // deepest ring == far opening
    var rb = FOCAL / dd * sc;
    var w = (1/dd - 1/NEAR) / (1/FAR - 1/NEAR);        // 0 near .. 1 deep
    var cx = 0.5 + (_bore.cx - 0.5) * w;
    var cy = VP_Y + (_bore.cy - VP_Y) * w;
    var asp = _bore.ry / Math.max(1e-4, _bore.rx);
    return [ cx + Math.cos(theta) * rb, cy + Math.sin(theta) * rb * asp, rb ];
  }
  var r = FOCAL / Math.max(NEAR, d);
  /* (4) The bore's axis is displaced by the road's curvature, scaled by depth
     squared — the same way a curved road's centreline sweeps further off-axis
     the further ahead you look. Subtracting the machine's own offset keeps the
     walls anchored to the road rather than to the camera. */
  var bend = _curve * d * d * 0.055 - _carX * 0.045;
  return [ VP_X + bend + Math.cos(theta) * r,
           VP_Y + Math.sin(theta) * r * ASPECT_Y,
           r ];
}

/* ── PATTERNS 
   Each is a function of (u, v) returning brightness 0..1, where u is the
   normalised angle around the bore and v is the scrolled axial coordinate.
   Authored to tile seamlessly on both axes.

   Because they are pure functions of surface coordinates, the perspective and
   the scrolling are handled entirely by the projection above — a pattern never
   needs to know where the camera is. */
/* Fractional part that stays in 0..1 for NEGATIVE inputs too: the depth
   coordinate goes negative as patterns scroll, and JS % keeps the sign. */
function _fr(x){ return x-Math.floor(x); }
var PATTERNS = {
  /* ═══ 32 ADDITIONAL PATTERNS (48 in total, three times the original set).
     Each is fn(u,v,S): u = angle around the bore (0..1), v = depth along it,
     S = shared state (t time, speed, curve). Kept to a few cheap trig ops
     because every ring point evaluates its pattern each frame. */
  galaxyArms: function(u,v,S){ var a=u*6.2832, r=Math.log(1+Math.abs(v)*2.2), k=Math.sin(3*a-r*9.0+(S?S.t:0)*0.6); return k>0.45?(k-0.45)/0.55:0; },
  drosteRecursion: function(u,v,S){ var q=_fr(u*4+Math.log(1+Math.abs(v))*3.2-(S?S.t:0)*0.25), w=_fr(v*2.5); return (q<0.16||w<0.05)?1:0; },
  hypnoBands: function(u,v,S){ var s=Math.sin((v*6+u*2)*6.2832-(S?S.t:0)*2.2); return s>0.55?1:0; },
  triSpiral: function(u,v){ var d=(u*3-v*1.6); d-=Math.floor(d); return d<0.12?1-d/0.12:0; },
  counterMoire: function(u,v){ var a=Math.sin((u*14+v*5)*6.2832), b=Math.sin((u*14-v*5.4)*6.2832); return Math.max(0,a*b); },
  kaleidoMirror: function(u,v,S){ var s=u*6; s-=Math.floor(s); s=s<0.5?s:1-s; var k=Math.sin((s*3+v*2.4)*6.2832+(S?S.t:0)*0.8); return k>0.4?(k-0.4)/0.6:0; },
  rosePetals: function(u,v,S){ var a=u*6.2832, r=Math.abs(Math.cos(4*a+(S?S.t:0)*0.4)), w=_fr(v*1.8), d=Math.abs(w-r); return d<0.16?1-d/0.16:0; },
  irisPulse: function(u,v,S){ var p=_fr(v*1.5+(S?S.t:0)*0.3), s=Math.sin(u*6.2832*24)*0.5+0.5; return (p<0.35&&s>0.6)?1-p/0.35:0; },
  wovenLattice: function(u,v){ var x=u*16, y=v*8, cx=Math.floor(x), cy=Math.floor(y), fx=x-cx, fy=y-cy;
    var over=((cx+cy)&1)?(Math.abs(fy-0.5)<0.28):(Math.abs(fx-0.5)<0.28); return over?0.95:((Math.abs(fx-0.5)<0.28||Math.abs(fy-0.5)<0.28)?0.35:0); },
  hexRosette: function(u,v){ var x=u*18, y=v*10.4, gy=Math.floor(y), ox=(gy&1)?0.5:0, fx=x+ox-Math.floor(x+ox)-0.5, fy=y-gy-0.5, d=Math.sqrt(fx*fx+fy*fy);
    return (Math.abs(d-0.32)<0.07)?1:(d<0.08?0.8:0); },
  fishScales: function(u,v){ var x=u*20, y=v*9, gy=Math.floor(y), ox=(gy&1)?0.5:0, fx=x+ox-Math.floor(x+ox)-0.5, fy=y-gy, d=Math.sqrt(fx*fx+fy*fy*1.6);
    return (d>0.44&&d<0.56)?1:0; },
  brickBore: function(u,v){ var y=v*10, gy=Math.floor(y), x=u*14+((gy&1)?0.5:0); return ((y-gy)<0.12||(x-Math.floor(x))<0.06)?1:0; },
  tartan: function(u,v){ var a=Math.abs(Math.sin(u*6.2832*9)), b=Math.abs(Math.sin(v*6.2832*4.5)); return (a>0.92?0.7:0)+(b>0.92?0.7:0)+((a>0.6&&b>0.6)?0.3:0); },
  gearTeeth: function(u,v,S){ var w=_fr(v*3), tooth=Math.sin((u*40+(S?S.t:0)*1.5+Math.floor(v*3)*0.5)*6.2832)>0?1:0; return (w<0.22&&tooth)?1:(w<0.08?0.6:0); },
  quasiCrystal: function(u,v,S){ var x=u*18, y=v*8, t=S?S.t*0.5:0, s=0; for(var i=0;i<5;i++){ var a=i*0.6283; s+=Math.cos(x*Math.cos(a)+y*Math.sin(a)+t); } s/=5; return s>0.12?Math.min(1,(s-0.12)*1.8):0; },
  threeSource: function(u,v,S){ var t=S?S.t:0, s=Math.sin((u*9+v*3)*6.2832-t*2)+Math.sin((u*9-v*3)*6.2832-t*2.3)+Math.sin((v*7)*6.2832-t*1.7); return s>1.4?Math.min(1,(s-1.4)*1.1):0; },
  plasmaField: function(u,v,S){ var t=S?S.t:0, s=Math.sin(u*25+t)+Math.sin(v*11-t*1.3)+Math.sin((u*9+v*6)*2.1+t*0.7); s=(s+3)/6; return Math.max(0,Math.sin(s*18.85)); },
  dnaHelix: function(u,v,S){ var ph=v*2.0*6.2832+(S?S.t:0)*0.6, a=u*6.2832, d1=Math.abs(Math.sin((a-ph)*0.5)), d2=Math.abs(Math.sin((a-ph-3.1416)*0.5));
    var strand=(d1<0.10||d2<0.10)?1:0, rung=(_fr(v*14)<0.10&&Math.sin(a-ph)>-0.2)?0.6:0; return Math.max(strand,rung); },
  lightningArcs: function(u,v,S){ var t=Math.floor((S?S.t:0)*6), x=u*10+Math.sin(v*23+t*1.7)*0.35+Math.sin(v*57+t*2.9)*0.15; x-=Math.floor(x); return x<0.05?1:(x<0.1?0.35:0); },
  auroraCurtains: function(u,v,S){ var t=S?S.t:0, s=Math.sin(u*6.2832*7+Math.sin(v*3+t*0.7)*2.2); return s>0.3?((s-0.3)/0.7)*(0.6+0.4*Math.sin(v*6.2832*2-t)):0; },
  chevronFlow: function(u,v,S){ var s=u*8; s-=Math.floor(s); var c=v*4-Math.abs(s-0.5)*1.2-(S?S.t:0)*0.4; c-=Math.floor(c); return c<0.2?1-c/0.2:0; },
  lanternSlots: function(u,v){ var x=u*12, y=v*5, fx=x-Math.floor(x), fy=y-Math.floor(y); return (Math.abs(fx-0.5)<0.18&&Math.abs(fy-0.5)<0.3)?1:0; },
  crystalFacets: function(u,v){ var x=u*10, y=v*6, a=Math.abs((x-Math.floor(x))-0.5)+Math.abs((y-Math.floor(y))-0.5); return (a>0.44&&a<0.5)?1:((a<0.12)?0.5:0); },
  lissajousKnot: function(u,v,S){ var a=u*6.2832, t=S?S.t*0.5:0, y=(Math.sin(3*a+t)*0.5+0.5), w=_fr(v*2), d=Math.abs(w-y); return d<0.12?1-d/0.12:0; },
  sparkleDust: function(u,v,S){ var cx=Math.floor(u*60), cy=Math.floor(v*30), h=Math.sin(cx*12.9898+cy*78.233)*43758.5453; h-=Math.floor(h);
    var tw=0.5+0.5*Math.sin((S?S.t:0)*4+h*40); return h>0.9?tw:0; },
  orbitDots: function(u,v,S){ var t=S?S.t:0, row=Math.floor(v*6), x=(u+row*0.17+t*0.08*((row&1)?1:-1))*10, fx=x-Math.floor(x)-0.5, fy=(v*6-row)-0.5; return (fx*fx+fy*fy)<0.04?1:0; },
  rippleLens: function(u,v,S){ var d=Math.sin(u*6.2832*3)*0.25+v, s=Math.sin(d*6.2832*5-(S?S.t:0)*3); return s>0.7?(s-0.7)/0.3:0; },
  ringEchoes: function(u,v,S){ var b=_fr(v*1.2-(S?S.t:0)*0.2); var e=0; for(var k=0;k<3;k++){ var dd=Math.abs(b-k*0.12); if(dd<0.02)e=1-k*0.3; } return e; },
  sacredCircles: function(u,v){ var x=u*8, y=v*4.6, best=1; for(var i=-1;i<=1;i++)for(var j=-1;j<=1;j++){ var cx=Math.floor(x)+0.5+i*0.5, cy=Math.floor(y)+0.5+j*0.5, dx=x-cx, dy=y-cy; best=Math.min(best,Math.abs(Math.sqrt(dx*dx+dy*dy)-0.5)); } return best<0.022?1:0; },
  zigzagCurrent: function(u,v,S){ var z=v*8, tri=Math.abs((z-Math.floor(z))-0.5)*2, x=u*6+tri*0.5+(S?S.t:0)*0.3; x-=Math.floor(x); return x<0.1?1:0; },
  scanPrism: function(u,v,S){ var band=Math.floor(u*7), w=_fr(v*3+band*0.37-(S?S.t:0)*0.5); return w<0.14?(1-band/10):0; },
  starBurst: function(u,v,S){ var a=u*48, spoke=Math.abs(a-Math.floor(a)-0.5), p=_fr(v*2+(S?S.t:0)*0.4); return (spoke<0.08&&p<0.5)?1-p*2:((p<0.05)?0.6:0); },
  /* Rings at regular axial intervals, sweeping toward the viewer. */
  pulseRings: function(u,v){
    var band = v - Math.floor(v);
    return band < 0.16 ? 1 - band / 0.16 : 0;
  },
  /* A single ribbon winding around the bore as it advances. */
  spiralVortex: function(u,v){
    var d = (u - v * 0.5);
    d -= Math.floor(d);
    return d < 0.14 ? 1 - d / 0.14 : 0;
  },
  /* Streaks running along the axis: constant u, continuous in v. */
  warpLines: function(u,v){
    var s = u * 12;
    var near = Math.abs(s - Math.round(s));
    if(near > 0.26) return 0;
    /* Broken into dashes so motion is legible as it scrolls. */
    var dash = v * 1.1; dash -= Math.floor(dash);
    return dash < 0.72 ? (1 - near / 0.26) : 0;
  },
  /* Honeycomb: offset rows of cells with a pulse travelling down the axis. */
  hexGrid: function(u,v){
    var row = Math.floor(v * 3);
    var uu = u * 12 + (row % 2) * 0.5;
    var du = Math.abs(uu - Math.round(uu));
    var dv = Math.abs(v * 3 - Math.round(v * 3));
    var cell = (du < 0.30 && dv < 0.30) ? 1 : 0;
    var pulse = 0.35 + 0.65 * Math.max(0, Math.sin(v * 1.4));
    return cell * pulse;
  },
  /* Rings again, but softly faded so they read as waves rather than edges. */
  rippleWaves: function(u,v){
    return Math.pow(Math.max(0, Math.sin(v * Math.PI * 2)), 3);
  },
  /* Two ribbons half a turn apart, winding together. */
  twistedHelix: function(u,v){
    var a = (u - v * 0.75);       a -= Math.floor(a);
    var b = (u + 0.5 - v * 0.75); b -= Math.floor(b);
    var ba = a < 0.11 ? 1 - a / 0.11 : 0;
    var bb = b < 0.11 ? (1 - b / 0.11) * 0.6 : 0;
    return Math.max(ba, bb);
  },
  /* A dense band of fine streaks all leaning the same way. */
  cyclone: function(u,v){
    var s = (u * 26 - v * 5);
    var f = s - Math.floor(s);
    return f < 0.42 ? (0.45 + 0.55 * Math.sin(v * 3)) * (1 - f / 0.42) : 0;
  },
  /* Wide diagonal bands: the classic barber-pole illusion. */
  barberPole: function(u,v){
    var s = (u * 4 - v * 1.1);
    var f = s - Math.floor(s);
    return f < 0.5 ? 1 : 0.18;
  },
  /* Rings whose axial position varies with angle, so each one is tilted. */
  corkscrewRings: function(u,v){
    var tilt = Math.sin(u * Math.PI * 2) * 0.22;
    var band = (v + tilt); band -= Math.floor(band);
    return band < 0.15 ? 1 - band / 0.15 : 0;
  },
  /* Radial spokes that rotate slowly, forming moire against the rings. */
  pinwheel: function(u,v){
    var s = u * 14 + v * 0.35;
    var f = Math.abs(s - Math.round(s));
    return f < 0.19 ? 1 - f / 0.19 : 0;
  },

  /* ── REACTIVE PATTERNS ───────────────────────────────────────────────────
     These use the third argument. They are not variations on the geometry
     above; they express motion the old two-argument contract could not
     produce at all, because the only thing that changed between frames was v.
     All of them degrade to something sensible if S is missing.              */

  /* Rings that breathe: width oscillates in time, independent of the scroll,
     so the surface pulses rather than merely passing by. */
  breathRings: function(u,v,S){
    var t = S ? S.t : 0;
    var wdt = 0.10 + 0.09 * (0.5 + 0.5 * Math.sin(t * 1.7));
    var band = v - Math.floor(v);
    return band < wdt ? 1 - band / wdt : 0;
  },

  /* A ribbon whose winding direction REVERSES with the road. On a left-hand
     bend it coils one way, on a right-hand bend the other, and it unwinds to
     straight streaks on a straight — the tunnel showing the corner before the
     camera does. */
  curveCoil: function(u,v,S){
    var c = S ? S.curve : 0;
    var d = (u - v * (0.18 + c * 0.55));
    d -= Math.floor(d);
    return d < 0.13 ? 1 - d / 0.13 : 0;
  },

  /* Spokes that spin up with speed and hold still at rest, so the bore's
     rotation is a direct readout of how fast the machine is travelling. */
  speedSpin: function(u,v,S){
    var sp = S ? S.speed : 0, t = S ? S.t : 0;
    var s = u * 10 + t * (0.15 + sp * 2.2);
    var f = Math.abs(s - Math.round(s));
    return f < 0.17 ? 1 - f / 0.17 : 0;
  },

  /* A bright meridian that tracks the machine around the bore, so the wall
     directly beside the player lights up as they move across the road. */
  chaseBand: function(u,v,S){
    var cx = S ? S.carX : 0;
    var target = 0.5 + cx * 0.25;
    var d = Math.abs(u - target);
    d = Math.min(d, 1 - d);                 // shortest way round the circle
    return d < 0.16 ? Math.pow(1 - d / 0.16, 1.6) : 0;
  },

  /* Two ring trains at slightly different rates, so they drift in and out of
     phase and produce a slow travelling beat that never repeats exactly. */
  interference: function(u,v,S){
    var t = S ? S.t : 0;
    var a = Math.sin((v + t * 0.05) * Math.PI * 2);
    var b = Math.sin((v * 1.07 - t * 0.03) * Math.PI * 2);
    var m = (a + b) * 0.5;
    return Math.pow(Math.max(0, m), 2.2);
  },

  /* Cells that flicker on and off in a fixed pseudo-random order — a lattice
     that reads as powered rather than painted. */
  dataGrid: function(u,v,S){
    var t = S ? S.t : 0;
    var cu = Math.floor(u * 16), cv = Math.floor(v * 4);
    var du = Math.abs(u * 16 - cu - 0.5), dv = Math.abs(v * 4 - cv - 0.5);
    if(du > 0.34 || dv > 0.34) return 0;
    var h = Math.sin(cu * 12.9898 + cv * 78.233) * 43758.5453;
    h -= Math.floor(h);
    return (Math.sin(t * 1.9 + h * 6.283) > -0.1) ? 1 : 0.10;
  }
};

/* ── COMPOSITION ────────────────────────────────────────────────────────────
   The registry above is a fixed list, so the seed could only ever pick one of
   N looks. Combining two patterns with an operator turns that into N x N x
   |ops|, and the results are not just overlays: intersection carves one
   pattern out of another, and difference produces edges that neither input
   contains. This is the cheapest available source of genuine variety.

   Composites are built once at selection time, not per sample, and the
   returned closure keeps the two-argument-plus-state signature so nothing
   downstream knows the difference.                                          */
var COMPOSE_OPS = {
  /* Both visible — the union. Softest, safest combination. */
  over:  function(a,b){ return a > b ? a : b; },
  /* Only where both agree: one pattern becomes a stencil for the other. */
  mask:  function(a,b){ return a * b; },
  /* Edges where exactly one is lit; produces outlines neither input has. */
  edge:  function(a,b){ var d = a - b; return d < 0 ? -d : d; },
  /* Second pattern erodes the first. */
  carve: function(a,b){ var r = a - b * 0.85; return r > 0 ? r : 0; },
  /* Average, weighted toward the first so it stays dominant. */
  blend: function(a,b){ return a * 0.62 + b * 0.38; }
};

function makeComposite(nameA, nameB, opName){
  var fa = PATTERNS[nameA], fb = PATTERNS[nameB], op = COMPOSE_OPS[opName];
  if(!fa || !fb || !op) return null;
  return function(u, v, S){
    /* The second pattern is sampled on a rotated, offset coordinate so the
       two do not simply sit on top of each other and cancel into mush. */
    var r = op(fa(u, v, S), fb(u + 0.37, v * 1.23 + 0.5, S));
    return r > 1 ? 1 : (r < 0 ? 0 : r);
  };
}
/* Captured before any composite is installed onto PATTERNS, so __composite
   can never be picked as a base pattern or as a composite partner. */
var PATTERN_NAMES = Object.keys(PATTERNS);

/* ── FLUID MOTION ON THE CYLINDER SURFACE 
   The patterns above are rigid geometry. What makes water look like water is
   that its surface ADVECTS — every point carries its neighbours along, so
   shapes stretch, curl and drift instead of holding still.

   Rather than injecting splats into water.js and reading them back (a GPU
   round trip per frame, and the reason the earlier attempts dissolved), the
   same behaviour is produced directly in UV space: a coarse velocity field
   over the cylinder surface DISPLACES the coordinate at which the pattern is
   sampled. The pattern stays crisp — it is still a clean function — but the
   surface it is painted on flows.

   The field uses the two properties that give water.js its character:

     ADVECTION  the field carries itself downstream, so disturbances travel
                rather than sitting where they started.
     VORTICITY  curl is injected continuously, which is what produces the
                swirling eddies a purely divergent field never develops.

   It is deliberately coarse (a 16x12 lattice sampled with bilinear
   interpolation). The displacement only needs to be smooth and organic; detail
   comes from the pattern, not from the flow. */
var FW = 16, FH = 12;                 // field lattice: u around, v along
var _fu = new Float32Array(FW*FH);    // velocity, u component
var _fv = new Float32Array(FW*FH);    // velocity, v component
var _fInit = false;

function fieldInit(seed){
  var r = (seed>>>0) || 1;
  var rnd = function(){ r = (r*1664525+1013904223)>>>0; return r/4294967296; };
  for(var i=0;i<FW*FH;i++){
    _fu[i] = (rnd()-0.5)*0.6;
    _fv[i] = (rnd()-0.5)*0.6;
  }
  _fInit = true;
}

/* One step of the flow. Advection is semi-Lagrangian, as in water.js: each
   cell looks BACK along its own velocity and takes the value it finds there,
   which is unconditionally stable at any timestep. */
var _tu = new Float32Array(FW*FH), _tv = new Float32Array(FW*FH);
function fieldStep(dt, t, energy){
  var i,x,y;
  for(y=0;y<FH;y++){
    for(x=0;x<FW;x++){
      var i0=y*FW+x;
      /* Trace backwards. u wraps (the bore closes on itself); v clamps. */
      var px = x - _fu[i0]*dt*6.0;
      var py = y - _fv[i0]*dt*6.0;
      px = ((px%FW)+FW)%FW;
      py = py<0?0:(py>FH-1?FH-1:py);
      var x0=Math.floor(px), y0=Math.floor(py);
      var fx=px-x0, fy=py-y0;
      var x1=(x0+1)%FW, y1=Math.min(FH-1,y0+1);
      var a=y0*FW+x0, b=y0*FW+x1, c=y1*FW+x0, d2=y1*FW+x1;
      _tu[i0]=(_fu[a]*(1-fx)+_fu[b]*fx)*(1-fy)+(_fu[c]*(1-fx)+_fu[d2]*fx)*fy;
      _tv[i0]=(_fv[a]*(1-fx)+_fv[b]*fx)*(1-fy)+(_fv[c]*(1-fx)+_fv[d2]*fx)*fy;
    }
  }
  /* Vorticity: add a curl-shaped impulse that wanders over the surface, so the
     field keeps generating new eddies instead of settling. Speed feeds the
     strength — the faster the machine, the more agitated the walls. */
  var swirl = 0.7 + (energy||0)*1.6;
  var cx = (Math.sin(t*0.37)*0.5+0.5)*FW;
  var cy = (Math.cos(t*0.29)*0.5+0.5)*FH;
  for(y=0;y<FH;y++){
    for(x=0;x<FW;x++){
      var dx=x-cx, dy=y-cy;
      var r2=dx*dx+dy*dy+2.5;
      var w=swirl/r2;
      i=y*FW+x;
      /* Perpendicular to the radius = rotation about the centre. */
      _tu[i]+= -dy*w*dt*3.0;
      _tv[i]+=  dx*w*dt*3.0;
      /* Mild damping keeps the field bounded without killing its motion. */
      _tu[i]*=0.995; _tv[i]*=0.995;
    }
  }
  _fu.set(_tu); _fv.set(_tv);
}

/* Sample the field at a surface coordinate, bilinearly. Returns the
   displacement to apply to (u,v) before evaluating the pattern. */
function fieldAt(u,v,out){
  var px=(((u%1)+1)%1)*FW;
  var py=Math.max(0,Math.min(FH-1,(((v*0.25)%1)+1)%1*FH));
  var x0=Math.floor(px), y0=Math.floor(py);
  var fx=px-x0, fy=py-y0;
  var x1=(x0+1)%FW, y1=Math.min(FH-1,y0+1);
  var a=y0*FW+x0, b=y0*FW+x1, c=y1*FW+x0, d=y1*FW+x1;
  out[0]=(_fu[a]*(1-fx)+_fu[b]*fx)*(1-fy)+(_fu[c]*(1-fx)+_fu[d]*fx)*fy;
  out[1]=(_fv[a]*(1-fx)+_fv[b]*fx)*(1-fy)+(_fv[c]*(1-fx)+_fv[d]*fx)*fy;
}

/* ── RENDERER  */
var _cv=null, _ctx=null, _t=0, _seed=-1, _name=null, _hue=0, _dead=false;
var _disp=[0,0];
/* (4) The bore follows the road. `_curve` shifts the vanishing point sideways
   so the tunnel bends with the track instead of pointing straight ahead, and
   `_carX` accounts for the machine's position across the road — the walls
   should swing past differently when hugging the inside of a bend. Both are
   eased, so a change of segment cannot snap the whole tunnel sideways. */
var _curve=0, _carX=0, _curveTgt=0, _carTgt=0;
/* Active palette function, chosen from the seed alongside the pattern. */
var _pal=null, _palName='flat', _compName=null;
/* How strongly the flow distorts the pattern. Large enough to read as liquid
   motion, small enough that the pattern never loses its identity. */
var FLOW_U=0.035, FLOW_V=0.16;

function ensure(){
  if(_dead) return false;
  if(_cv) return true;
  try{
    _cv = document.createElement('canvas');
    _cv.id = 'zs-tunnelfx';
    /* Plain alpha compositing, no blend mode and no mask: both create their own
       stacking context, which is what stopped the previous version from ever
       appearing. */
    _cv.style.cssText =
      'position:fixed;left:0;top:0;width:100vw;height:100vh;'+
      'pointer-events:none;display:none;z-index:2000002';
    document.body.appendChild(_cv);
    _ctx = _cv.getContext('2d');
    if(!_ctx){ _dead = true; return false; }
    return true;
  }catch(e){ _dead = true; return false; }
}

function hslCss(h,l,a){
  return 'hsla('+Math.round(h*360)+',92%,'+Math.round(l*100)+'%,'+a.toFixed(3)+')';
}

/* Draw one ring of the cylinder at axial depth d, sampling the pattern around
   its circumference. Rings are the natural primitive here: they are constant
   in v, so one pattern evaluation per angular step covers the whole band. */
/* ── PATTERN STATE ─────────────────────────────────────────────────────────
   Patterns used to be pure f(u,v). Every one of them could therefore only
   express a single kind of motion — a uniform scroll down the axis — because
   the only thing that changed between frames was v. Meanwhile the module was
   already tracking and easing _t, _curve and _carX and passing none of them
   in, so a tunnel looked identical on a hairpin and on a straight.

   This object carries that state to the pattern and palette functions. It is
   a single module-level instance, mutated in place once per frame and never
   reallocated: a pattern is evaluated 96 rings x 64-110 segments, so roughly
   7,000-10,000 times per frame, and allocating anything here would dominate
   the frame's garbage.

     t      seconds, already speed-scaled by the caller
     speed  0..1 normalised machine speed
     curve  eased track curvature, signed — left/right
     acurve |curve|, precomputed since most patterns want magnitude
     carX   eased lateral position of the machine, -1..1
     d      depth of the ring being drawn, NEAR..FAR
     near   1 at the camera, 0 at the far plane                              */
var _PS = { t:0, speed:0, curve:0, acurve:0, carX:0, d:0, near:0 };

/* ── PALETTES ──────────────────────────────────────────────────────────────
   Every ring used to be stroked with one hue for the whole tunnel, so the bore
   was monochrome by construction and the seed could only choose WHICH single
   colour. A palette gets the same information the pattern does and returns a
   hue and a saturation, which lets colour carry depth, energy and the shape of
   the track rather than just identifying the tunnel.

   Contract: pal(hue, bright, S) -> writes [hue, sat] into _PC and returns it.
   _PC is reused for the same reason _PS is — this runs per stroked run.       */
var _PC = [0, 0];
var PALETTES = {
  /* The original behaviour, kept as the default so an unseeded tunnel looks
     exactly as it did before any of this existed. */
  flat: function(h, b, S){ _PC[0]=h; _PC[1]=0.45+b*0.35; return _PC; },

  /* Depth ramp: the far end of the bore drifts around the wheel while the near
     rings hold the base hue, so distance reads as colour as well as size. */
  depthRamp: function(h, b, S){
    _PC[0] = h + (1 - S.near) * 0.17;
    _PC[1] = 0.40 + b * 0.40;
    return _PC;
  },

  /* Complementary accent: bright parts of the pattern sit on the base hue and
     dim parts fall to its opposite, so the surface reads as two interleaved
     materials rather than one glowing line. */
  duotone: function(h, b, S){
    _PC[0] = (b > 0.55) ? h : h + 0.5;
    _PC[1] = 0.35 + b * 0.45;
    return _PC;
  },

  /* Reacts to the road. Curvature pushes the hue toward the warm end and
     lifts saturation, so a corner is visibly hotter than a straight — the
     track's shape driving the tunnel's colour rather than the seed alone. */
  corner: function(h, b, S){
    var k = Math.min(1, S.acurve * 0.42);
    _PC[0] = h - k * 0.16;
    _PC[1] = 0.38 + b * 0.34 + k * 0.22;
    return _PC;
  },

  /* Speed shifts the whole bore toward the blue end as the machine winds up,
     which reads as the light itself blueshifting. */
  velocity: function(h, b, S){
    _PC[0] = h + S.speed * 0.20;
    _PC[1] = 0.34 + b * 0.34 + S.speed * 0.24;
    return _PC;
  },

  /* Slow counter-rotating drift through the wheel, independent of the
     pattern's own motion, so long tunnels never settle into one look. */
  aurora: function(h, b, S){
    _PC[0] = h + Math.sin(S.t * 0.21 + S.near * 2.3) * 0.13;
    _PC[1] = 0.42 + b * 0.38;
    return _PC;
  }
};
var PALETTE_NAMES = Object.keys(PALETTES);

/* Full 32-bit avalanche (the standard xorshift-multiply finaliser, applied
   twice). A single multiply-and-shift is NOT enough here: multiplication mixes
   the low bits worst of all, and every selection below reads exactly those
   bits through `%`. Deriving the palette and composite streams with one round
   left them correlated with the pattern stream and badly non-uniform —
   measured 58.7% of tunnels landing on one palette out of six, and a 38%
   composite gate firing 64.5% of the time. */
function _mix32(x){
  x = x >>> 0;
  x ^= x >>> 16; x = Math.imul(x, 0x7feb352d) >>> 0;
  x ^= x >>> 15; x = Math.imul(x, 0x846ca68b) >>> 0;
  x ^= x >>> 16;
  return x >>> 0;
}

function drawRing(ctx, vw, vh, fn, d, vCoord, hue, segments){
  var pts = null, lastB = 0;
  /* Per-ring, not per-segment: these are constant across the ring. */
  _PS.d = d;
  _PS.near = Math.max(0, Math.min(1, 1 - (d - NEAR) / (FAR - NEAR)));
  for(var i=0; i<=segments; i++){
    var u = i / segments;
    var theta = u * Math.PI * 2;
    /* FLUID DISPLACEMENT: the pattern is sampled at a coordinate carried by
       the flow, so the shape ripples and curls the way a liquid surface does
       while remaining a clean, legible pattern. */
    fieldAt(u, vCoord, _disp);
    /* Third argument is the shared, reused state object. Patterns written
       against the old two-argument contract simply ignore it. */
    var b = fn(u + _disp[0]*FLOW_U, vCoord + _disp[1]*FLOW_V, _PS);
    var p = project(theta, d);
    var x = p[0] * vw, y = p[1] * vh;
    /* Below the horizon is road, not wall. */
    var onWall = p[1] <= FLOOR_Y;
    if(b > 0.02 && onWall){
      if(!pts){ pts = [[x,y]]; lastB = b; }
      else pts.push([x,y]);
    } else if(pts){
      strokeRun(ctx, pts, lastB, d, hue);
      pts = null;
    }
  }
  if(pts) strokeRun(ctx, pts, lastB, d, hue);
}

/* Stroke a contiguous lit run. Nearer rings are brighter and thicker, which is
   what conveys depth without any lighting model. */
function strokeRun(ctx, pts, bright, d, hue){
  if(pts.length < 2) return;
  var near = Math.max(0, Math.min(1, 1 - (d - NEAR) / (FAR - NEAR)));
  var alpha = bright * (0.20 + near * 0.80);
  if(alpha < 0.015) return;
  /* Colour now comes from the selected palette rather than a fixed
     hue/saturation pair. _pal is resolved once when the tunnel is shown. */
  var pc = (_pal || PALETTES.flat)(hue, bright, _PS);
  ctx.strokeStyle = hslCss(pc[0], pc[1], alpha);
  ctx.lineWidth = (0.6 + near * 3.4) * (_int > 1 ? 1.7 : 1);
  ctx.beginPath();
  ctx.moveTo(pts[0][0], pts[0][1]);
  for(var i=1;i<pts.length;i++) ctx.lineTo(pts[i][0], pts[i][1]);
  ctx.stroke();
}

var _int = 1, _forceP = null, _forceC = null, _spdMul = 1, _forceKey = '';
function show(seed){
  if(!ensure()) return;
  /* A forced pattern / palette (Super Racing Track Lab) re-resolves the
     tunnel's look when the choice changes, not only when the seed does. */
  var fk = (_forceP||'') + '|' + (_forceC||'');
  if(fk !== _forceKey){ _forceKey = fk; _seed = null; }
  if(seed != null && seed !== _seed){
    _seed = seed;
    /* ═══ THE INDEX WAS THE SEED'S LAST DECIMAL DIGIT 
       `(seed >>> 0) % 10` with ten patterns selects on the low decimal digit
       of the seed. That is the least random part of most seed schemes — track
       seeds here are generated by adding a fixed stride to a base, so whole
       families of courses land on the same two or three digits and the same
       two or three patterns, however many are defined.

       The seed is now avalanched first (xorshift-multiply, the standard
       finalising mix) so every bit of the input affects the index, and the
       modulo samples a well-mixed value rather than one decimal digit. */
    var _h = (seed>>>0);
    _h ^= _h >>> 16; _h = Math.imul(_h, 0x7feb352d) >>> 0;
    _h ^= _h >>> 15; _h = Math.imul(_h, 0x846ca68b) >>> 0;
    _h ^= _h >>> 16;
    _name = PATTERN_NAMES[(_h >>> 0) % PATTERN_NAMES.length];
    _hue  = ((Math.imul(_h, 2654435761)) >>> 0) % 360 / 360;

    /* Palette and composition are drawn from INDEPENDENT streams of the same
       avalanched seed. Reusing _h directly would correlate them with the
       pattern choice, so a given pattern would always arrive with the same
       colour treatment and the extra axes would add far less variety than
       their count suggests. */
    var _h2 = _mix32(_h ^ 0x9e3779b9);
    var _h3 = _mix32(_h ^ 0x27d4eb2f);

    _palName = PALETTE_NAMES[_h2 % PALETTE_NAMES.length];
    _pal     = PALETTES[_palName];

    /* Roughly two tunnels in five are composites. Kept a minority on purpose:
       a composite is busier than either input, so making it the common case
       would flatten the difference between tunnels rather than widen it. The
       partner is chosen from the BASE list only, so composites never nest. */
    _compName = null;
    if(((_h3 >>> 8) % 100) < 38){
      var opNames = Object.keys(COMPOSE_OPS);
      var bName = PATTERN_NAMES[(_h3 >>> 7) % PATTERN_NAMES.length];
      var oName = opNames[(_h3 >>> 3) % opNames.length];
      if(bName !== _name){
        var comp = makeComposite(_name, bName, oName);
        if(comp){
          PATTERNS.__composite = comp;
          _compName = _name + '+' + bName + ':' + oName;
          _name = '__composite';
        }
      }
    }
  }
  if(_forceP && PATTERNS[_forceP]){ _name = _forceP; _compName = null; }
  if(_forceC && PALETTES[_forceC]){ _palName = _forceC; _pal = PALETTES[_forceC]; }
  if(!_name){ _name = PATTERN_NAMES[0]; _hue = 0.55; }
  if(!_pal){ _pal = PALETTES.flat; _palName = 'flat'; }
  if(!_fInit) fieldInit(seed || 1);
  _cv.style.display = 'block';
}
function hide(){ if(_cv) _cv.style.display = 'none'; }

/* One frame. `speed` is the machine's normalised speed, which scales how fast
   the surface scrolls past — the tunnel rushes when you do. */
function frame(dt, speed){
  if(!ensure() || !_name) return;
  var vw = innerWidth, vh = innerHeight;
  if(_cv.width !== vw || _cv.height !== vh){ _cv.width = vw; _cv.height = vh; }
  /* Ease toward the target so the bore bends smoothly with the road. */
  _curve += (_curveTgt - _curve) * Math.min(1, dt * 4);
  _carX  += (_carTgt  - _carX ) * Math.min(1, dt * 6);
  _t += dt * (0.35 + (speed || 0) * 1.5) * (_int > 1 ? 1.45 : 1) * _spdMul;
  /* Advance the flow once per frame, capped so a long frame cannot make the
     surface lurch. */
  fieldStep(Math.min(0.05, dt), _t, speed || 0);

  /* Refresh the shared pattern state once per frame. */
  _PS.t=_t; _PS.speed=speed||0; _PS.curve=_curve;
  _PS.acurve=Math.abs(_curve); _PS.carX=_carX;

  var ctx = _ctx, fn = PATTERNS[_name];
  ctx.clearRect(0,0,vw,vh);
  ctx.lineCap = 'round';

  /* HARD CLIP — THE ROAD IS NEVER PAINTED, WITHOUT EXCEPTION.
     Testing each point against FLOOR_Y is not sufficient: a stroke joins two
     points, and a segment between two above-floor points can still bow below
     the line — as can any part of a wide stroke, since line width extends
     perpendicular to the path. A clip region is enforced by the rasteriser
     itself, so no drawing operation of any kind can cross it regardless of
     what the pattern asks for. */
  ctx.save();
  ctx.beginPath();
  /* One pixel short of the line: a clip rectangle includes its final row, so
     clipping exactly at FLOOR_Y still lit the first row of road. */
  ctx.rect(0, 0, vw, Math.floor(FLOOR_Y * vh) - 1);
  ctx.clip();

  /* Rings are stepped in RECIPROCAL depth so they are evenly spaced on screen
     rather than bunching at the vanishing point — the same reason perspective
     projections interpolate 1/z. Drawn far to near: we are inside the tube. */
  /* 96 rings rather than 46: at the lower count only two or three pattern
     bands fell inside the visible depth range at any instant, so most patterns
     showed a couple of lonely rings instead of a continuous surface. */
  /* Scaled by the game's quality level (setQuality): a struggling machine
     draws fewer rings/points instead of dropping to single-digit frame rates. */
  var RINGS = Math.max(40, Math.round(96 * _tq));
  for(var i = RINGS; i >= 1; i--){
    var f = i / RINGS;
    var d = NEAR + (FAR - NEAR) * (f * f);
    /* Axial scale of 3.2 puts several pattern periods inside the visible
       range, which is what makes the wall look textured rather than banded.
       Subtracting time scrolls the surface toward the viewer. */
    var vCoord = d * 3.2 - _t;
    var segs = Math.max(40, Math.round((d < 0.7 ? 110 : 64) * (0.55 + 0.45 * _tq)));     // more detail on the near, larger rings
    drawRing(ctx, vw, vh, fn, d, vCoord, _hue, segs);
  }
  /* INTENSE TUNNELS (request 4 item 8): the finished frame is added onto
     itself — exactly double the light, still inside the road clip — with
     thicker strokes (strokeRun) and a faster flow (above). */
  if(_int > 1){
    ctx.globalCompositeOperation = 'lighter';
    ctx.globalAlpha = Math.min(1, _int - 1);
    ctx.drawImage(_cv, 0, 0);
    ctx.globalAlpha = 1;
    ctx.globalCompositeOperation = 'source-over';
  }
  ctx.restore();
}

global.TunnelFX = {
  show: show, hide: hide, frame: frame,
  /* 1 = normal, 2 = twice as intense (see the end of frame()). */
  setIntensity: function(k){ _int = Math.max(1, Math.min(2, +k || 1)); },
  /* Forced pattern / palette names (null = automatic) and a flow-speed factor. */
  setForce: function(p, c, spd){ _forceP = p && p !== 'auto' ? p : null; _forceC = c && c !== 'auto' ? c : null;
    _spdMul = Math.max(0.1, Math.min(5, +spd || 1)); },
  setCurve: function(curve, carX){ _curveTgt=curve||0; _carTgt=carX||0; },
  /* Fade the wall in and out at the tunnel's ends (0..1), so the pattern
     grows with the bore instead of popping on and off. */
  /* Stacking: normally above the game (2000002); in the attract demo it must sit
     under the title screen, so the game passes 2000000 (above the game canvas
     by document order, below the title at 2000001). */
  setQuality: function(q){ _tq = Math.max(0.35, Math.min(1, +q || 1)); },
  setLayer: function(z){ if(_cv){ var v=String(z); if(_cv.style.zIndex!==v)_cv.style.zIndex=v; } },
  setOpacity: function(a){ if(_cv){ var v=Math.max(0,Math.min(1,+a||0)); if(_cv.style.opacity!==String(v))_cv.style.opacity=String(v); } },
  /* o = {cx,cy,rx,ry,floor} in normalised screen units, or null to restore
     the free-floating projection. */
  setBore: function(o){
    if(o&&isFinite(o.cx)&&isFinite(o.cy)&&o.rx>0&&o.ry>0){
      _bore={cx:o.cx,cy:o.cy,rx:o.rx,ry:o.ry};
      FLOOR_Y=(isFinite(o.floor)&&o.floor>0.2&&o.floor<0.98)?o.floor:FLOOR_Y_DEFAULT;
    } else { _bore=null; FLOOR_Y=FLOOR_Y_DEFAULT; }
  },
  pattern: function(){ return _compName || _name; },
  patterns: PATTERN_NAMES,
  palette: function(){ return _palName; },
  palettes: PALETTE_NAMES,
  composeOps: Object.keys(COMPOSE_OPS),
  /* Full visual identity of the current tunnel, for debug/telemetry. */
  describe: function(){
    return { pattern:_compName||_name, base:_compName?_compName.split('+')[0]:_name,
             composite:!!_compName, palette:_palName,
             hue:+(_hue||0).toFixed(3), seed:_seed };
  },
  available: function(){ return !_dead; }
};

})(typeof window!=='undefined'?window:globalThis);
