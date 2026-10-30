'use strict';

// Keep the original scales, wave choices and independent input sources.
const NOTE_FREQUENCIES = { C4:261.63, D4:293.66, E4:329.63, G4:392, A4:440, C5:523.25, D5:587.33, E5:659.25 };
const SYNTH_CONFIG = {
  english:{waveforms:['sine','triangle'], initialWaveform:'sine', pan:-0.5, level:0.88},
  japanese:{waveforms:['square','sawtooth'], initialWaveform:'square', pan:0.5, level:0.46},
};
const state = {
  perspective:50, effects:{distortion:0.45,delay:0.35,reverb:0.35,chorus:0.4},
  english:{volume:0.8,attack:0.028,release:0.24,pan:-0.5},
  japanese:{volume:0.8,attack:0.028,release:0.24,pan:0.5},
  bpm:120,master:0.7,
};
const DRUMS = ['kick','snare','hat','clap'];
const keyButtons = [...document.querySelectorAll('.key')];
const waveformButtons = [...document.querySelectorAll('.wave-option')];
const perspectiveSlider = document.querySelector('#tone');
const buttonByCode = new Map(keyButtons.map((b,i)=>[['KeyA','KeyS','KeyD','KeyF','KeyJ','KeyK','KeyL','Semicolon'][i],b]));
const statusElement = document.querySelector('#audio-status');
let engine;

function smooth(parameter, value, context) {
  parameter.setTargetAtTime(value, context.currentTime, 0.035);
}
function createDistortionCurve(amount=34) {
  const curve = new Float32Array(8192);
  for(let i=0;i<curve.length;i++) {
    const x=i*2/(curve.length-1)-1;
    curve[i]=Math.tanh(x*(1+amount/8))/Math.tanh(1+amount/8);
  }
  return curve;
}
function createReverbImpulse(context,duration=1.7,decay=2.6) {
  const count=Math.floor(context.sampleRate*duration);
  const impulse=context.createBuffer(2,count,context.sampleRate);
  for(let ch=0;ch<2;ch++) {
    const data=impulse.getChannelData(ch);
    for(let i=0;i<count;i++) data[i]=(Math.random()*2-1)*Math.pow(1-i/count,decay);
  }
  return impulse;
}

class EffectsChain {
  constructor(context,impulse) {
    this.context=context;
    this.input=context.createGain();
    this.output=context.createGain();
    this.cleanGain=context.createGain();
    this.distortion=context.createWaveShaper();
    this.drive=context.createGain();
    this.distortionGain=context.createGain();
    this.delay=context.createDelay(1);
    this.delayFeedback=context.createGain();
    this.delayFilter=context.createBiquadFilter();
    this.delayGain=context.createGain();
    this.reverb=context.createConvolver();
    this.reverbGain=context.createGain();
    this.chorusDelay=context.createDelay(0.05);
    this.chorusGain=context.createGain();
    this.modulationOscillator=context.createOscillator();
    this.modulationDepth=context.createGain();
    this.distortion.curve=createDistortionCurve();
    this.distortion.oversample='4x';
    this.delay.delayTime.value=0.27;
    this.delayFilter.type='lowpass';this.delayFilter.frequency.value=3500;
    this.reverb.buffer=impulse;
    this.chorusDelay.delayTime.value=0.016;
    this.modulationOscillator.frequency.value=0.65;
    this.modulationDepth.gain.value=0;
    [this.distortionGain,this.delayGain,this.reverbGain,this.chorusGain,this.delayFeedback].forEach(node=>node.gain.value=0);
    // Independent parallel sends: turning any effect off silences that branch.
    this.input.connect(this.cleanGain).connect(this.output);
    this.input.connect(this.drive).connect(this.distortion).connect(this.distortionGain).connect(this.output);
    this.input.connect(this.delay).connect(this.delayGain).connect(this.output);
    this.delay.connect(this.delayFilter).connect(this.delayFeedback).connect(this.delay);
    this.input.connect(this.reverb).connect(this.reverbGain).connect(this.output);
    this.input.connect(this.chorusDelay).connect(this.chorusGain).connect(this.output);
    this.modulationOscillator.connect(this.modulationDepth).connect(this.chorusDelay.delayTime);
    this.modulationOscillator.start();
  }
  setAmounts(amounts) {
    const {distortion:d,delay:t,reverb:r,chorus:c}=amounts;
    smooth(this.cleanGain.gain,1-d*0.5-c*0.2,this.context);
    smooth(this.drive.gain,1+d*9,this.context);
    smooth(this.distortionGain.gain,d*0.2,this.context);
    smooth(this.delayGain.gain,t*0.32,this.context);
    smooth(this.delayFeedback.gain,t*0.48,this.context);
    smooth(this.reverbGain.gain,r*0.4,this.context);
    smooth(this.chorusGain.gain,c*0.32,this.context);
    smooth(this.modulationDepth.gain,c*0.004,this.context);
  }
}

class PolySynth {
  constructor(context,config,panel,destination,impulse,settings) {
    this.context=context;this.config=config;this.panel=panel;this.settings=settings;
    this.waveform=config.initialWaveform;this.voices=new Map();this.tails=new Set();
    this.effects=new EffectsChain(context,impulse);
    this.pan=context.createStereoPanner();this.output=context.createGain();
    this.effects.output.connect(this.pan).connect(this.output).connect(destination);
    this.pan.pan.value=settings.pan;
    this.output.gain.value=settings.volume*config.level;
  }
  updateSettings() {
    smooth(this.output.gain,this.settings.volume*this.config.level,this.context);
    smooth(this.pan.pan,this.settings.pan,this.context);
  }
  setWaveform(waveform) {
    if(!this.config.waveforms.includes(waveform)) return;
    this.waveform=waveform;
    [...this.voices.values(),...this.tails].forEach(v=>v.oscillator.type=waveform);
  }
  noteOn(note,source) {
    const existing=this.voices.get(note);
    if(existing){existing.sources.add(source);return;}
    const now=this.context.currentTime;
    const oscillator=this.context.createOscillator(),envelope=this.context.createGain();
    oscillator.type=this.waveform;oscillator.frequency.value=NOTE_FREQUENCIES[note];
    envelope.gain.setValueAtTime(0,now);
    envelope.gain.linearRampToValueAtTime(0.15,now+this.settings.attack);
    envelope.gain.linearRampToValueAtTime(0.105,now+this.settings.attack+0.12);
    oscillator.connect(envelope).connect(this.effects.input);
    const voice={oscillator,envelope,sources:new Set([source]),start:now,attack:this.settings.attack};
    oscillator.onended=()=>{oscillator.disconnect();envelope.disconnect();this.tails.delete(voice);this.updateActivity();};
    this.voices.set(note,voice);oscillator.start(now);this.updateActivity();
  }
  noteOff(note,source) {
    const voice=this.voices.get(note);if(!voice)return;
    voice.sources.delete(source);if(voice.sources.size)return;
    const now=this.context.currentTime,elapsed=now-voice.start;
    // Analytic envelope level also handles release during the attack in older browsers.
    const level=elapsed<voice.attack?0.15*elapsed/voice.attack:elapsed<voice.attack+0.12?0.15-0.045*(elapsed-voice.attack)/0.12:0.105;
    voice.envelope.gain.cancelScheduledValues(now);
    voice.envelope.gain.setValueAtTime(Math.max(0,level),now);
    voice.envelope.gain.linearRampToValueAtTime(0,now+this.settings.release);
    voice.oscillator.stop(now+this.settings.release+0.01);
    this.tails.add(voice);this.voices.delete(note);this.updateActivity();
  }
  updateActivity(){this.panel.classList.toggle('is-sounding',this.voices.size+this.tails.size>0);}
  releaseAll(){this.voices.forEach((v,n)=>[...v.sources].forEach(s=>this.noteOff(n,s)));}
}

class PerspectiveController {
  constructor(synths){this.synths=synths;}
  // The global settings remain untouched; only the effective amounts are derived.
  static effectiveAmounts(perspective,effects) {
    const dirty={english:perspective/100,japanese:1-perspective/100};
    return Object.fromEntries(Object.entries(dirty).map(([name,factor])=>[name,Object.fromEntries(Object.entries(effects).map(([fx,value])=>[fx,value*factor]))]));
  }
  update(){const amounts=PerspectiveController.effectiveAmounts(state.perspective,state.effects);Object.entries(this.synths).forEach(([name,synth])=>synth.effects.setAmounts(amounts[name]));}
}

class MasterOutput {
  constructor(context){
    this.context=context;this.input=context.createGain();this.compressor=context.createDynamicsCompressor();
    this.compressor.threshold.value=-18;this.compressor.knee.value=18;this.compressor.ratio.value=5;
    this.compressor.attack.value=0.005;this.compressor.release.value=0.2;
    this.input.gain.value=state.master;
    this.input.connect(this.compressor).connect(context.destination);
    this.splitter=context.createChannelSplitter(2);this.compressor.connect(this.splitter);
    this.analysers=[context.createAnalyser(),context.createAnalyser()];
    this.buffers=this.analysers.map((a,i)=>{a.fftSize=512;this.splitter.connect(a,i);return new Float32Array(a.fftSize);});
    this.meters=[document.querySelector('#meter-left'),document.querySelector('#meter-right')];
  }
  updateMeters(){this.analysers.forEach((a,i)=>{a.getFloatTimeDomainData(this.buffers[i]);const rms=Math.sqrt(this.buffers[i].reduce((sum,v)=>sum+v*v,0)/this.buffers[i].length);this.meters[i].value=Math.min(1,rms*5);});}
}

class DrumMachine {
  constructor(context,destination,impulse){
    this.context=context;this.output=context.createGain();this.output.gain.value=0.65;this.output.connect(destination);
    this.noise=context.createBuffer(1,context.sampleRate,context.sampleRate);
    const data=this.noise.getChannelData(0);for(let i=0;i<data.length;i++)data[i]=Math.random()*2-1;
    this.space=context.createConvolver();this.space.buffer=impulse;
    this.spaceGain=context.createGain();this.spaceGain.gain.value=0.12;
    this.space.connect(this.spaceGain).connect(this.output);
    this.active=new Set();
  }
  track(source,nodes,time,duration){
    this.active.add(source);
    source.onended=()=>{source.disconnect();nodes.forEach(n=>n.disconnect());this.active.delete(source);};
    source.start(time);source.stop(time+duration);
  }
  kick(time=this.context.currentTime){
    const o=this.context.createOscillator(),g=this.context.createGain();
    o.frequency.setValueAtTime(150,time);o.frequency.exponentialRampToValueAtTime(45,time+0.14);
    g.gain.setValueAtTime(0,time);g.gain.linearRampToValueAtTime(0.8,time+0.003);g.gain.exponentialRampToValueAtTime(0.0001,time+0.38);
    o.connect(g).connect(this.output);this.track(o,[g],time,0.4);
  }
  noiseHit(time,duration,frequency,type,level,clap=false){
    const n=this.context.createBufferSource(),f=this.context.createBiquadFilter(),g=this.context.createGain();
    n.buffer=this.noise;f.type=type;f.frequency.value=frequency;f.Q.value=0.7;
    g.gain.setValueAtTime(0,time);
    if(clap){
      for(let i=0;i<3;i++){const t=time+i*0.018;g.gain.setValueAtTime(0,t);g.gain.linearRampToValueAtTime(level,t+0.002);g.gain.exponentialRampToValueAtTime(0.01,t+0.016);}
      g.gain.setValueAtTime(level*0.6,time+0.054);g.gain.exponentialRampToValueAtTime(0.0001,time+duration);
    }else{g.gain.linearRampToValueAtTime(level,time+0.002);g.gain.exponentialRampToValueAtTime(0.0001,time+duration);}
    n.connect(f).connect(g).connect(this.output);if(clap)g.connect(this.space);
    this.track(n,[f,g],time,duration+0.01);
  }
  snare(time=this.context.currentTime){
    this.noiseHit(time,0.18,1500,'highpass',0.42);
    const o=this.context.createOscillator(),g=this.context.createGain();o.type='triangle';o.frequency.value=180;
    g.gain.setValueAtTime(0,time);g.gain.linearRampToValueAtTime(0.22,time+0.002);g.gain.exponentialRampToValueAtTime(0.0001,time+0.12);
    o.connect(g).connect(this.output);this.track(o,[g],time,0.14);
  }
  hat(time=this.context.currentTime){this.noiseHit(time,0.055,7000,'highpass',0.25);}
  clap(time=this.context.currentTime){this.noiseHit(time,0.24,1400,'bandpass',0.48,true);}
  play(name,time){this[name](time);}
  cancelScheduled(){this.active.forEach(s=>{try{s.stop(this.context.currentTime);}catch{/* Already ended. */}});}
}

class StepSequencer {
  constructor(context,drums){
    this.context=context;this.drums=drums;this.playing=false;this.timer=null;this.step=0;this.nextTime=0;this.queue=[];this.currentStep=-1;
    this.pattern=DRUMS.map(()=>Array(16).fill(false));
    [[0,4,8,12],[4,12],[0,2,4,6,8,10,12,14],[12]].forEach((steps,row)=>steps.forEach(s=>this.pattern[row][s]=true));
  }
  start(){
    if(this.playing)return;
    this.playing=true;this.step=0;this.nextTime=this.context.currentTime+0.04;
    this.schedule();this.timer=setInterval(()=>this.schedule(),25);
  }
  schedule(){
    while(this.nextTime<this.context.currentTime+0.1){
      const hits=[];
      DRUMS.forEach((name,row)=>{if(this.pattern[row][this.step]){this.drums.play(name,this.nextTime);hits.push(name);}});
      this.queue.push({step:this.step,time:this.nextTime,hits});
      this.nextTime+=60/state.bpm/4;this.step=(this.step+1)%16;
    }
  }
  stop(){this.playing=false;clearInterval(this.timer);this.timer=null;this.queue=[];this.currentStep=-1;this.drums.cancelScheduled();drawStep(-1);}
  updateVisuals(){
    while(this.queue.length&&this.queue[0].time<=this.context.currentTime){
      const item=this.queue.shift();this.currentStep=item.step;drawStep(item.step);item.hits.forEach(flashDrum);
    }
  }
}

class AudioEngine {
  constructor(){
    const AudioContextClass=window.AudioContext||window.webkitAudioContext;
    if(!AudioContextClass)throw new Error('Web Audio API недоступен в этом браузере');
    this.context=new AudioContextClass();this.master=new MasterOutput(this.context);
    const impulse=createReverbImpulse(this.context);
    this.synths=Object.fromEntries(Object.entries(SYNTH_CONFIG).map(([name,config])=>[name,new PolySynth(this.context,config,document.querySelector(`[data-synth-panel="${name}"]`),this.master.input,impulse,state[name])]));
    this.perspective=new PerspectiveController(this.synths);this.perspective.update();
    this.drums=new DrumMachine(this.context,this.master.input,impulse);this.sequencer=new StepSequencer(this.context,this.drums);
    this.frame=()=>{this.master.updateMeters();this.sequencer.updateVisuals();this.animation=requestAnimationFrame(this.frame);};this.frame();
    this.context.onstatechange=()=>{statusElement.textContent=this.context.state==='running'?'AUDIO ON / LOCAL SYNTHESIS':'AUDIO PAUSED / Нажмите ноту';};
  }
  resume(){if(this.context.state==='suspended')this.context.resume().catch(()=>{statusElement.textContent='Не удалось включить звук';});}
}
function initializeAudio(){
  try{if(!engine)engine=new AudioEngine();engine.resume();return engine;}
  catch(error){statusElement.textContent=error.message;return null;}
}

// Native ranges work with pointer, touch and keyboard and expose their values to AT.
function addRange(parent,{id,label,min,max,step=1,value,format,onInput}){
  const wrapper=document.createElement('label');wrapper.className='control';wrapper.htmlFor=id;
  const line=document.createElement('span');line.append(document.createTextNode(label));
  const output=document.createElement('output');output.htmlFor=id;output.value=format(value);line.append(output);
  const input=document.createElement('input');Object.assign(input,{id,type:'range',min,max,step,value});
  input.addEventListener('input',()=>{const v=Number(input.value);output.value=format(v);input.setAttribute('aria-valuetext',format(v));onInput(v);});
  input.setAttribute('aria-valuetext',format(value));wrapper.append(line,input);parent.append(wrapper);
}
for(const name of ['english','japanese']){
  const parent=document.querySelector(`[data-controls="${name}"]`);
  const configs=[
    {param:'volume',label:'VOLUME',min:0,max:1,step:0.01,format:v=>`${Math.round(v*100)}%`},
    {param:'pan',label:'PAN',min:-1,max:1,step:0.01,format:v=>v===0?'C':`${v<0?'L':'R'} ${Math.round(Math.abs(v)*100)}`},
    {param:'attack',label:'ATTACK',min:0.005,max:1.5,step:0.001,format:v=>`${v.toFixed(3)}s`},
    {param:'release',label:'RELEASE',min:0.05,max:3,step:0.01,format:v=>`${v.toFixed(2)}s`},
  ];
  configs.forEach(config=>addRange(parent,{...config,id:`${name}-${config.param}`,value:state[name][config.param],onInput:v=>{state[name][config.param]=v;initializeAudio()?.synths[name].updateSettings();}}));
}
Object.entries(state.effects).forEach(([name,value])=>addRange(document.querySelector('#effect-controls'),{id:`effect-${name}`,label:name.toUpperCase(),min:0,max:1,step:0.01,value,format:v=>`${Math.round(v*100)}%`,onInput:v=>{state.effects[name]=v;initializeAudio()?.perspective.update();}}));

const pattern=[[0,4,8,12],[4,12],[0,2,4,6,8,10,12,14],[12]];
const sequencerElement=document.querySelector('#sequencer');sequencerElement.append(document.createElement('span'));
for(let step=0;step<16;step++){const n=document.createElement('span');n.className='step-number';n.textContent=String(step+1).padStart(2,'0');sequencerElement.append(n);}
DRUMS.forEach((name,row)=>{
  const pad=document.createElement('button');pad.className='drum-pad';pad.dataset.drum=name;pad.textContent=name.toUpperCase();pad.setAttribute('aria-label',`Сыграть ${name}`);
  pad.addEventListener('click',()=>{const audio=initializeAudio();if(audio){audio.drums.play(name);flashDrum(name);}});sequencerElement.append(pad);
  for(let step=0;step<16;step++){
    const cell=document.createElement('button');cell.className='step';cell.dataset.row=row;cell.dataset.step=step;
    cell.classList.toggle('is-on',pattern[row].includes(step));cell.setAttribute('aria-pressed',String(pattern[row].includes(step)));cell.setAttribute('aria-label',`${name}, шаг ${step+1}`);
    cell.addEventListener('click',()=>{const audio=initializeAudio();if(!audio)return;const on=audio.sequencer.pattern[row][step]=!audio.sequencer.pattern[row][step];cell.classList.toggle('is-on',on);cell.setAttribute('aria-pressed',String(on));});
    sequencerElement.append(cell);
  }
});
const stepButtons=[...document.querySelectorAll('.step')];
function drawStep(step){stepButtons.forEach(b=>b.classList.toggle('is-current',Number(b.dataset.step)===step));}
const drumFlashTimers=new Map();
function flashDrum(name){const pad=document.querySelector(`[data-drum="${name}"]`);pad.classList.add('is-hit');clearTimeout(drumFlashTimers.get(name));drumFlashTimers.set(name,setTimeout(()=>pad.classList.remove('is-hit'),100));}

function pressKey(button,source){const audio=initializeAudio();if(!audio)return;audio.synths[button.dataset.synth].noteOn(button.dataset.note,source);button.classList.add('is-active');}
function releaseKey(button,source){if(!engine)return;const synth=engine.synths[button.dataset.synth];synth.noteOff(button.dataset.note,source);button.classList.toggle('is-active',synth.voices.has(button.dataset.note));}
keyButtons.forEach(button=>{
  button.setAttribute('aria-label',`${button.dataset.synth}, ${button.dataset.note}, клавиша ${button.dataset.key}`);
  button.addEventListener('pointerdown',event=>{if(event.button!==0)return;event.preventDefault();button.setPointerCapture(event.pointerId);pressKey(button,`pointer-${event.pointerId}`);});
  const release=event=>releaseKey(button,`pointer-${event.pointerId}`);
  ['pointerup','pointercancel','lostpointercapture'].forEach(type=>button.addEventListener(type,release));
  // Assistive technology can trigger click without pointerdown/keyup.
  button.addEventListener('click',event=>{if(event.detail===0){const source='accessible-click';pressKey(button,source);setTimeout(()=>releaseKey(button,source),220);}});
});
const heldCodes=new Map();
window.addEventListener('keydown',event=>{
  if(event.repeat||event.ctrlKey||event.metaKey||event.altKey)return;
  if(event.target.matches('input:not([type="range"]),textarea,select,[contenteditable="true"]'))return;
  if(event.code==='Space'&&!event.target.matches('button,input')){event.preventDefault();toggleTransport();return;}
  const button=buttonByCode.get(event.code);if(!button)return;
  event.preventDefault();heldCodes.set(event.code,button);pressKey(button,`keyboard-${event.code}`);
});
window.addEventListener('keyup',event=>{const button=heldCodes.get(event.code);if(!button)return;releaseKey(button,`keyboard-${event.code}`);heldCodes.delete(event.code);});
waveformButtons.forEach(button=>button.addEventListener('click',()=>{
  const audio=initializeAudio();if(!audio)return;audio.synths[button.dataset.synth].setWaveform(button.dataset.wave);
  waveformButtons.filter(b=>b.dataset.synth===button.dataset.synth).forEach(b=>{const selected=b===button;b.classList.toggle('is-selected',selected);b.setAttribute('aria-pressed',String(selected));});
}));
perspectiveSlider.addEventListener('input',()=>{state.perspective=Number(perspectiveSlider.value);document.querySelector('#perspective-value').value=`${100-state.perspective} / ${state.perspective}`;perspectiveSlider.setAttribute('aria-valuetext',`English processing ${state.perspective}%, Japanese processing ${100-state.perspective}%`);initializeAudio()?.perspective.update();});
perspectiveSlider.setAttribute('aria-valuetext','English processing 50%, Japanese processing 50%');
document.querySelector('#bpm').addEventListener('input',event=>{state.bpm=Number(event.target.value);document.querySelector('#bpm-value').value=`${state.bpm} BPM`;});
document.querySelector('#master').addEventListener('input',event=>{state.master=Number(event.target.value)/100;document.querySelector('#master-value').value=`${event.target.value}%`;const audio=initializeAudio();if(audio)smooth(audio.master.input.gain,state.master,audio.context);});
function syncTransport(){const playing=Boolean(engine?.sequencer.playing);const button=document.querySelector('#play');button.classList.toggle('is-playing',playing);button.setAttribute('aria-pressed',String(playing));}
function startTransport(){const audio=initializeAudio();if(!audio)return;audio.sequencer.start();syncTransport();}
function stopTransport(){engine?.sequencer.stop();syncTransport();}
function toggleTransport(){if(engine?.sequencer.playing)stopTransport();else startTransport();}
document.querySelector('#play').addEventListener('click',startTransport);
document.querySelector('#stop').addEventListener('click',stopTransport);
function releaseAll(){if(!engine)return;Object.values(engine.synths).forEach(s=>s.releaseAll());heldCodes.clear();keyButtons.forEach(b=>b.classList.remove('is-active'));}
window.addEventListener('blur',releaseAll);
document.addEventListener('visibilitychange',()=>{if(document.hidden){releaseAll();stopTransport();}});
window.addEventListener('pagehide',()=>{releaseAll();stopTransport();if(engine){cancelAnimationFrame(engine.animation);void engine.context.close();}});
