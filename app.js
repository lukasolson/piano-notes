const NOTE_NAMES = ["C", "C#", "D", "D#", "E", "F", "F#", "G", "G#", "A", "A#", "B"];

const appEl = document.getElementById("app");
const targetNoteEl = document.getElementById("targetNote");
const detectedNoteEl = document.getElementById("detectedNote");
const detectedFrequencyEl = document.getElementById("detectedFrequency");
const streakCountEl = document.getElementById("streakCount");
const startButton = document.getElementById("startButton");
const hintEl = document.getElementById("hint");

let targetNote = null;
let audioContext = null;
let analyser = null;
let source = null;
let stream = null;
let isListening = false;
let isLocked = false;
let streakCount = 0;
let animationFrameId = null;
let waitingForSilenceAfterCorrect = false;
let silentFrameCount = 0;
const SILENCE_FRAMES_REQUIRED = 8;
const MIN_VALID_FREQUENCY = 40;
const MAX_VALID_FREQUENCY = 2000;

function updateStreakDisplay() {
  streakCountEl.textContent = String(streakCount);
}

function pickNextTargetNote() {
  const next = NOTE_NAMES[Math.floor(Math.random() * NOTE_NAMES.length)];
  targetNote = next;
  targetNoteEl.textContent = next;
}

function frequencyToMidi(frequency) {
  return Math.round(12 * Math.log2(frequency / 440) + 69);
}

function midiToNoteName(midi) {
  return NOTE_NAMES[((midi % 12) + 12) % 12];
}

function getPitchByAutocorrelation(buffer, sampleRate) {
  let rms = 0;
  for (let i = 0; i < buffer.length; i += 1) {
    rms += buffer[i] * buffer[i];
  }
  rms = Math.sqrt(rms / buffer.length);
  if (rms < 0.01) {
    return -1;
  }

  let start = 0;
  let end = buffer.length - 1;
  const threshold = 0.2;

  for (let i = 0; i < buffer.length / 2; i += 1) {
    if (Math.abs(buffer[i]) < threshold) {
      start = i;
      break;
    }
  }

  for (let i = 1; i < buffer.length / 2; i += 1) {
    if (Math.abs(buffer[buffer.length - i]) < threshold) {
      end = buffer.length - i;
      break;
    }
  }

  const trimmed = buffer.slice(start, end);
  const autocorrelation = new Array(trimmed.length).fill(0);

  for (let lag = 0; lag < trimmed.length; lag += 1) {
    for (let i = 0; i < trimmed.length - lag; i += 1) {
      autocorrelation[lag] += trimmed[i] * trimmed[i + lag];
    }
  }

  let d = 0;
  while (
    d + 1 < autocorrelation.length &&
    autocorrelation[d] > autocorrelation[d + 1]
  ) {
    d += 1;
  }

  let maxVal = -1;
  let maxIndex = -1;
  for (let i = d; i < autocorrelation.length; i += 1) {
    if (autocorrelation[i] > maxVal) {
      maxVal = autocorrelation[i];
      maxIndex = i;
    }
  }

  if (maxIndex <= 0) {
    return -1;
  }

  let betterLag = maxIndex;
  if (maxIndex > 0 && maxIndex < autocorrelation.length - 1) {
    const y1 = autocorrelation[maxIndex - 1];
    const y2 = autocorrelation[maxIndex];
    const y3 = autocorrelation[maxIndex + 1];
    const denominator = y1 - 2 * y2 + y3;
    if (denominator !== 0) {
      betterLag = maxIndex + 0.5 * (y1 - y3) / denominator;
    }
  }

  return sampleRate / betterLag;
}

function clearResultFlash() {
  appEl.classList.remove("result-correct", "result-incorrect");
}

function setResultFlash(isCorrect) {
  clearResultFlash();
  appEl.classList.add(isCorrect ? "result-correct" : "result-incorrect");
  setTimeout(() => {
    clearResultFlash();
  }, 1000);
}

function evaluateDetectedNote(detectedName) {
  if (isLocked || !targetNote) {
    return;
  }

  isLocked = true;
  const isCorrect = detectedName === targetNote;
  setResultFlash(isCorrect);

  if (isCorrect) {
    streakCount += 1;
    updateStreakDisplay();
    hintEl.textContent = "Correct! Release the key; next note appears after silence.";
    setTimeout(() => {
      waitingForSilenceAfterCorrect = true;
      silentFrameCount = 0;
    }, 1000);
  } else {
    streakCount = 0;
    updateStreakDisplay();
    hintEl.textContent = `Not quite. You played ${detectedName}. Try again.`;
    setTimeout(() => {
      isLocked = false;
    }, 1000);
  }
}

function listenFrame() {
  if (!isListening || !analyser || !audioContext) {
    return;
  }

  const buffer = new Float32Array(analyser.fftSize);
  analyser.getFloatTimeDomainData(buffer);
  const rawFrequency = getPitchByAutocorrelation(buffer, audioContext.sampleRate);
  const isValidFrequency =
    rawFrequency >= MIN_VALID_FREQUENCY && rawFrequency <= MAX_VALID_FREQUENCY;

  if (isValidFrequency) {
    silentFrameCount = 0;
    const midi = frequencyToMidi(rawFrequency);
    const noteName = midiToNoteName(midi);

    detectedNoteEl.textContent = noteName;
    detectedFrequencyEl.textContent = `${rawFrequency.toFixed(1)} Hz`;
    evaluateDetectedNote(noteName);
  } else {
    if (waitingForSilenceAfterCorrect) {
      silentFrameCount += 1;
      if (silentFrameCount >= SILENCE_FRAMES_REQUIRED) {
        waitingForSilenceAfterCorrect = false;
        pickNextTargetNote();
        hintEl.textContent = "Play the shown note on your instrument.";
        isLocked = false;
      }
    }

    if (!isLocked) {
      detectedNoteEl.textContent = "Listening...";
      detectedFrequencyEl.textContent = "-- Hz";
    }
  }

  animationFrameId = requestAnimationFrame(listenFrame);
}

async function startListening() {
  try {
    stream = await navigator.mediaDevices.getUserMedia({
      audio: {
        echoCancellation: true,
        noiseSuppression: true,
        autoGainControl: true,
      },
      video: false,
    });

    audioContext = new window.AudioContext();
    analyser = audioContext.createAnalyser();
    analyser.fftSize = 2048;
    source = audioContext.createMediaStreamSource(stream);
    source.connect(analyser);

    isListening = true;
    pickNextTargetNote();
    hintEl.textContent = "Play the shown note on your instrument.";
    startButton.disabled = true;
    startButton.textContent = "Microphone Active";
    listenFrame();
  } catch (error) {
    hintEl.textContent = "Microphone access failed. Please allow access and retry.";
    detectedNoteEl.textContent = "Permission denied";
    detectedFrequencyEl.textContent = "-- Hz";
    console.error(error);
  }
}

startButton.addEventListener("click", () => {
  if (!isListening) {
    streakCount = 0;
    updateStreakDisplay();
    startListening();
  }
});

window.addEventListener("beforeunload", () => {
  if (animationFrameId) {
    cancelAnimationFrame(animationFrameId);
  }
  if (stream) {
    stream.getTracks().forEach((track) => track.stop());
  }
  if (audioContext) {
    audioContext.close();
  }
});
