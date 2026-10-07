const NOTE_FREQUENCIES = {
  C4: 261.63,
  D4: 293.66,
  E4: 329.63,
  G4: 392.0,
  A4: 440.0,
  C5: 523.25,
  D5: 587.33,
  E5: 659.25,
};

const SYNTH_CONFIG = {
  english: {
    waveforms: ["sine", "triangle"],
    initialWaveform: "sine",
    pan: -0.5,
    level: 0.88,
  },
  japanese: {
    waveforms: ["square", "sawtooth"],
    initialWaveform: "square",
    pan: 0.5,
    level: 0.46,
  },
};

const keyButtons = [...document.querySelectorAll(".key")];
const waveformButtons = [...document.querySelectorAll(".wave-option")];
const perspectiveSlider = document.querySelector("#tone");
const buttonByKeyboardKey = new Map(
  keyButtons.map((button) => [button.dataset.key.toLowerCase(), button]),
);

let audioContext;
let masterGain;
let synths;

function createDistortionCurve(amount = 34) {
  const samples = 44100;
  const curve = new Float32Array(samples);
  const degrees = Math.PI / 180;

  for (let index = 0; index < samples; index += 1) {
    const input = (index * 2) / samples - 1;
    curve[index] = ((3 + amount) * input * 20 * degrees) / (Math.PI + amount * Math.abs(input));
  }

  return curve;
}

function createReverbImpulse(context, duration = 1.7, decay = 2.6) {
  const frameCount = Math.floor(context.sampleRate * duration);
  const impulse = context.createBuffer(2, frameCount, context.sampleRate);

  for (let channel = 0; channel < impulse.numberOfChannels; channel += 1) {
    const data = impulse.getChannelData(channel);
    for (let index = 0; index < frameCount; index += 1) {
      const envelope = Math.pow(1 - index / frameCount, decay);
      data[index] = (Math.random() * 2 - 1) * envelope;
    }
  }

  return impulse;
}

class EffectsChain {
  constructor(context) {
    this.context = context;
    this.input = context.createGain();
    this.output = context.createGain();
    this.cleanGain = context.createGain();
    this.chorusDelay = context.createDelay(0.05);
    this.filter = context.createBiquadFilter();
    this.distortion = context.createWaveShaper();
    this.distortionGain = context.createGain();
    this.delay = context.createDelay(0.8);
    this.delayFeedback = context.createGain();
    this.delayGain = context.createGain();
    this.reverb = context.createConvolver();
    this.reverbGain = context.createGain();
    this.modulationOscillator = context.createOscillator();
    this.modulationDepth = context.createGain();

    this.filter.type = "lowpass";
    this.filter.Q.value = 1.1;
    this.distortion.curve = createDistortionCurve();
    this.distortion.oversample = "4x";
    this.delay.delayTime.value = 0.27;
    this.reverb.buffer = createReverbImpulse(context);
    this.modulationOscillator.type = "sine";
    this.modulationOscillator.frequency.value = 0.42;

    this.input.connect(this.cleanGain);
    this.cleanGain.connect(this.output);

    this.input.connect(this.chorusDelay);
    this.chorusDelay.connect(this.filter);
    this.filter.connect(this.distortion);
    this.distortion.connect(this.distortionGain);
    this.distortionGain.connect(this.output);

    this.distortion.connect(this.delay);
    this.delay.connect(this.delayGain);
    this.delayGain.connect(this.output);
    this.delay.connect(this.delayFeedback);
    this.delayFeedback.connect(this.delay);

    this.distortion.connect(this.reverb);
    this.reverb.connect(this.reverbGain);
    this.reverbGain.connect(this.output);

    this.modulationOscillator.connect(this.modulationDepth);
    this.modulationDepth.connect(this.chorusDelay.delayTime);
    this.modulationOscillator.start();
    this.setDirtyAmount(0.5, true);
  }

  setDirtyAmount(amount, immediate = false) {
    const value = Math.min(1, Math.max(0, amount));
    const now = this.context.currentTime;
    const timeConstant = immediate ? 0.001 : 0.045;
    const setValue = (parameter, target) => {
      parameter.cancelScheduledValues(now);
      parameter.setTargetAtTime(target, now, timeConstant);
    };

    setValue(this.cleanGain.gain, 0.92 - value * 0.62);
    setValue(this.distortionGain.gain, 0.015 + value * 0.28);
    setValue(this.delayGain.gain, value * 0.13);
    setValue(this.delayFeedback.gain, 0.08 + value * 0.3);
    setValue(this.reverbGain.gain, 0.012 + value * 0.18);
    setValue(this.filter.frequency, 7600 - value * 5600);
    setValue(this.filter.Q, 0.8 + value * 2.6);
    setValue(this.chorusDelay.delayTime, 0.006 + value * 0.009);
    setValue(this.modulationDepth.gain, 0.0002 + value * 0.0042);
    setValue(this.output.gain, 1 - value * 0.08);
  }
}

class PolySynth {
  constructor(context, config, panel) {
    this.context = context;
    this.waveforms = config.waveforms;
    this.waveform = config.initialWaveform;
    this.voices = new Map();
    this.panel = panel;
    this.effects = new EffectsChain(context);
    this.pan = context.createStereoPanner();
    this.output = context.createGain();

    this.pan.pan.value = config.pan;
    this.output.gain.value = config.level;
    this.effects.output.connect(this.pan);
    this.pan.connect(this.output);
    this.output.connect(masterGain);
  }

  setWaveform(waveform) {
    if (!this.waveforms.includes(waveform)) return;
    this.waveform = waveform;
    this.voices.forEach((voice) => {
      voice.oscillator.type = waveform;
    });
  }

  setDirtyAmount(amount, immediate = false) {
    this.effects.setDirtyAmount(amount, immediate);
  }

  noteOn(note, source) {
    const existingVoice = this.voices.get(note);
    if (existingVoice) {
      existingVoice.sources.add(source);
      return;
    }

    const now = this.context.currentTime;
    const oscillator = this.context.createOscillator();
    const envelope = this.context.createGain();

    oscillator.type = this.waveform;
    oscillator.frequency.value = NOTE_FREQUENCIES[note];
    envelope.gain.setValueAtTime(0.0001, now);
    envelope.gain.exponentialRampToValueAtTime(0.16, now + 0.028);
    envelope.gain.exponentialRampToValueAtTime(0.105, now + 0.19);

    oscillator.connect(envelope);
    envelope.connect(this.effects.input);
    oscillator.start(now);

    this.voices.set(note, {
      oscillator,
      envelope,
      sources: new Set([source]),
    });
    this.panel.classList.add("is-sounding");
  }

  noteOff(note, source) {
    const voice = this.voices.get(note);
    if (!voice) return;

    voice.sources.delete(source);
    if (voice.sources.size > 0) return;

    const now = this.context.currentTime;
    const currentLevel = Math.max(voice.envelope.gain.value, 0.0001);
    voice.envelope.gain.cancelScheduledValues(now);
    voice.envelope.gain.setValueAtTime(currentLevel, now);
    voice.envelope.gain.exponentialRampToValueAtTime(0.0001, now + 0.24);
    voice.oscillator.stop(now + 0.26);
    this.voices.delete(note);

    if (this.voices.size === 0) this.panel.classList.remove("is-sounding");
  }

  releaseAll() {
    this.voices.forEach((voice, note) => {
      [...voice.sources].forEach((source) => this.noteOff(note, source));
    });
  }
}

function initializeAudio() {
  if (audioContext) {
    if (audioContext.state === "suspended") void audioContext.resume();
    return;
  }

  const AudioContextClass = window.AudioContext || window.webkitAudioContext;
  audioContext = new AudioContextClass();
  masterGain = audioContext.createGain();
  const compressor = audioContext.createDynamicsCompressor();

  masterGain.gain.value = 0.62;
  compressor.threshold.value = -16;
  compressor.knee.value = 18;
  compressor.ratio.value = 4;
  compressor.attack.value = 0.008;
  compressor.release.value = 0.22;
  masterGain.connect(compressor);
  compressor.connect(audioContext.destination);

  synths = {
    english: new PolySynth(
      audioContext,
      SYNTH_CONFIG.english,
      document.querySelector('[data-synth-panel="english"]'),
    ),
    japanese: new PolySynth(
      audioContext,
      SYNTH_CONFIG.japanese,
      document.querySelector('[data-synth-panel="japanese"]'),
    ),
  };

  updatePerspective(true);
  void audioContext.resume();
}

function updatePerspective(immediate = false) {
  const sliderValue = Number(perspectiveSlider.value) / 100;
  const englishDirtyAmount = sliderValue;
  const japaneseDirtyAmount = 1 - sliderValue;

  if (synths) {
    synths.english.setDirtyAmount(englishDirtyAmount, immediate);
    synths.japanese.setDirtyAmount(japaneseDirtyAmount, immediate);
  }

  if (sliderValue < 0.34) {
    perspectiveSlider.setAttribute("aria-valuetext", "English clean, Japanese dirty");
  } else if (sliderValue > 0.66) {
    perspectiveSlider.setAttribute("aria-valuetext", "English dirty, Japanese clean");
  } else {
    perspectiveSlider.setAttribute("aria-valuetext", "English и Japanese обработаны одинаково");
  }
}

function pressKey(button, source) {
  initializeAudio();
  synths[button.dataset.synth].noteOn(button.dataset.note, source);
  button.classList.add("is-active");
}

function releaseKey(button, source) {
  if (!synths) return;
  synths[button.dataset.synth].noteOff(button.dataset.note, source);
  const voiceStillActive = synths[button.dataset.synth].voices.has(button.dataset.note);
  if (!voiceStillActive) button.classList.remove("is-active");

}

keyButtons.forEach((button) => {
  button.addEventListener("pointerdown", (event) => {
    event.preventDefault();
    const source = `pointer-${event.pointerId}`;
    button.dataset.pointerSource = source;
    button.setPointerCapture(event.pointerId);
    pressKey(button, source);
  });

  const releasePointer = () => {
    const source = button.dataset.pointerSource;
    if (!source) return;
    releaseKey(button, source);
    delete button.dataset.pointerSource;
  };

  button.addEventListener("pointerup", releasePointer);
  button.addEventListener("pointercancel", releasePointer);
  button.addEventListener("lostpointercapture", releasePointer);
});

window.addEventListener("keydown", (event) => {
  if (event.repeat || event.target === perspectiveSlider) return;
  const keyboardKey = event.key.toLowerCase();
  const button = buttonByKeyboardKey.get(keyboardKey);
  if (!button) return;
  event.preventDefault();
  pressKey(button, `keyboard-${keyboardKey}`);
});

window.addEventListener("keyup", (event) => {
  const keyboardKey = event.key.toLowerCase();
  const button = buttonByKeyboardKey.get(keyboardKey);
  if (!button) return;
  event.preventDefault();
  releaseKey(button, `keyboard-${keyboardKey}`);
});

waveformButtons.forEach((button) => {
  button.addEventListener("click", () => {
    initializeAudio();
    const synthName = button.dataset.synth;
    synths[synthName].setWaveform(button.dataset.wave);

    waveformButtons
      .filter((option) => option.dataset.synth === synthName)
      .forEach((option) => {
        const isSelected = option === button;
        option.classList.toggle("is-selected", isSelected);
        option.setAttribute("aria-pressed", String(isSelected));
      });

  });
});

perspectiveSlider.addEventListener("pointerdown", initializeAudio);
perspectiveSlider.addEventListener("keydown", initializeAudio);
perspectiveSlider.addEventListener("input", () => updatePerspective(false));

window.addEventListener("blur", () => {
  if (!synths) return;
  Object.values(synths).forEach((synth) => synth.releaseAll());
  keyButtons.forEach((button) => button.classList.remove("is-active"));
});

updatePerspective(true);
