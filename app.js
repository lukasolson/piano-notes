const DETECTED_NOTE_NAMES = ["C", "C#", "D", "D#", "E", "F", "F#", "G", "G#", "A", "A#", "B"];
const TARGET_NOTE_NAMES = [
  "C",
  "C#",
  "Db",
  "D",
  "D#",
  "Eb",
  "E",
  "F",
  "F#",
  "Gb",
  "G",
  "G#",
  "Ab",
  "A",
  "A#",
  "Bb",
  "B",
];
const NOTE_TO_PITCH_CLASS = {
  C: 0,
  "C#": 1,
  Db: 1,
  D: 2,
  "D#": 3,
  Eb: 3,
  E: 4,
  F: 5,
  "F#": 6,
  Gb: 6,
  G: 7,
  "G#": 8,
  Ab: 8,
  A: 9,
  "A#": 10,
  Bb: 10,
  B: 11,
};
const CLEF_CONFIG = {
  treble: {
    symbol: "𝄞",
    bottomLine: "E4",
    minMidi: 60, // One line below (C4)
    maxMidi: 81, // One line above (A5)
  },
  bass: {
    symbol: "𝄢",
    bottomLine: "G2",
    minMidi: 40, // One line below (E2)
    maxMidi: 60, // One line above (C4)
  },
};
const NOTE_ORDER = ["C", "D", "E", "F", "G", "A", "B"];
const STAFF_PITCH_CLASS_SPELLINGS = {
  0: ["C"],
  1: ["C#", "Db"],
  2: ["D"],
  3: ["D#", "Eb"],
  4: ["E"],
  5: ["F"],
  6: ["F#", "Gb"],
  7: ["G"],
  8: ["G#", "Ab"],
  9: ["A"],
  10: ["A#", "Bb"],
  11: ["B"],
};
const CONSISTENCY_HZ_TOLERANCE = 4;
const CONSISTENCY_MIN_DURATION_MS = 200;
const SILENCE_FRAMES_REQUIRED = 8;
const MIN_VALID_FREQUENCY = 40;
const MAX_VALID_FREQUENCY = 2000;

const appEl = document.getElementById("app");
const targetNoteEl = document.getElementById("targetNote");
const staffWrapperEl = document.getElementById("staffWrapper");
const targetStaffEl = document.getElementById("targetStaff");
const displayModeEl = document.getElementById("displayMode");
const clefControlsEl = document.getElementById("clefControls");
const clefModeEl = document.getElementById("clefMode");
const modeDescriptionEl = document.getElementById("modeDescription");
const detectedNoteEl = document.getElementById("detectedNote");
const detectedFrequencyEl = document.getElementById("detectedFrequency");
const streakCountEl = document.getElementById("streakCount");
const accuracyValueEl = document.getElementById("accuracyValue");
const speedValueEl = document.getElementById("speedValue");
const startButton = document.getElementById("startButton");
const hintEl = document.getElementById("hint");

let targetNote = null;
let noteQueue = [];
let displayMode = "name";
let clefMode = "treble";
let audioContext = null;
let analyser = null;
let source = null;
let stream = null;
let isListening = false;
let isLocked = false;
let streakCount = 0;
let totalAttempts = 0;
let correctAttempts = 0;
let totalCorrectResponseMs = 0;
let targetShownAtMs = null;
let animationFrameId = null;
let waitingForSilenceAfterCorrect = false;
let silentFrameCount = 0;
let consistencyStartMs = null;
let consistencyMidi = null;
let consistencyFrequency = null;
let consistencyNoteName = null;

function updateStreakDisplay() {
  streakCountEl.textContent = String(streakCount);
}

function updatePerformanceDisplay() {
  const accuracy = totalAttempts > 0 ? (correctAttempts / totalAttempts) * 100 : 0;
  accuracyValueEl.textContent = `${accuracy.toFixed(0)}%`;

  if (correctAttempts > 0) {
    const avgSeconds = totalCorrectResponseMs / correctAttempts / 1000;
    speedValueEl.textContent = `${avgSeconds.toFixed(2)} s/note`;
  } else {
    speedValueEl.textContent = "-- s/note";
  }
}

function resetPerformanceStats() {
  totalAttempts = 0;
  correctAttempts = 0;
  totalCorrectResponseMs = 0;
  updatePerformanceDisplay();
}

function formatNoteForDisplay(noteName) {
  return noteName.replace("b", "♭");
}

function parseScientificNote(note) {
  const match = /^([A-G])([#b]?)(-?\d+)$/.exec(note);
  if (!match) {
    return null;
  }
  return {
    letter: match[1],
    accidental: match[2] || "",
    octave: Number(match[3]),
  };
}

function noteToMidi(note) {
  const parsed = parseScientificNote(note);
  if (!parsed) {
    return null;
  }
  const pitchClass = NOTE_TO_PITCH_CLASS[`${parsed.letter}${parsed.accidental}`];
  if (pitchClass === undefined) {
    return null;
  }
  return (parsed.octave + 1) * 12 + pitchClass;
}

function midiToScientificNote(midi) {
  const pitchClass = ((midi % 12) + 12) % 12;
  const octave = Math.floor(midi / 12) - 1;
  return `${DETECTED_NOTE_NAMES[pitchClass]}${octave}`;
}

function scientificNoteFromSpellingAndMidi(noteSpelling, midi) {
  for (let octave = -1; octave <= 8; octave += 1) {
    const candidate = `${noteSpelling}${octave}`;
    if (noteToMidi(candidate) === midi) {
      return candidate;
    }
  }
  return midiToScientificNote(midi);
}

function frequencyToMidi(frequency) {
  return Math.round(12 * Math.log2(frequency / 440) + 69);
}

function midiToPitchClass(midi) {
  return ((midi % 12) + 12) % 12;
}

function noteNameToPitchClass(noteName) {
  return NOTE_TO_PITCH_CLASS[noteName] ?? null;
}

function diatonicIndex(letter, octave) {
  return octave * 7 + NOTE_ORDER.indexOf(letter);
}

function getClefBottomLineIndex(clefKey) {
  const bottom = parseScientificNote(CLEF_CONFIG[clefKey].bottomLine);
  return diatonicIndex(bottom.letter, bottom.octave);
}

function getActiveStaffClefs() {
  if (clefMode === "both") {
    return ["treble", "bass"];
  }
  return [clefMode];
}

function buildTargetPool() {
  if (displayMode === "name") {
    return TARGET_NOTE_NAMES.map((noteName) => ({
      mode: "name",
      noteName,
      displayText: formatNoteForDisplay(noteName),
      pitchClass: noteNameToPitchClass(noteName),
    }));
  }

  const pool = [];
  for (const activeClef of getActiveStaffClefs()) {
    const { minMidi, maxMidi } = CLEF_CONFIG[activeClef];
    for (let midi = minMidi; midi <= maxMidi; midi += 1) {
      const pitchClass = midiToPitchClass(midi);
      const spellings = STAFF_PITCH_CLASS_SPELLINGS[pitchClass] ?? [
        DETECTED_NOTE_NAMES[pitchClass],
      ];
      for (const spelling of spellings) {
        pool.push({
          mode: "staff",
          clef: activeClef,
          midi,
          noteName: scientificNoteFromSpellingAndMidi(spelling, midi),
        });
      }
    }
  }
  return pool;
}

function pickNextTargetNote() {
  if (noteQueue.length === 0) {
    noteQueue = buildTargetPool();
  }
  const randomIndex = Math.floor(Math.random() * noteQueue.length);
  const [next] = noteQueue.splice(randomIndex, 1);
  targetNote = next;
  targetShownAtMs = performance.now();

  if (displayMode === "name") {
    targetNoteEl.textContent = next.displayText;
    renderTargetStaff(null);
  } else {
    targetNoteEl.textContent = "--";
    renderTargetStaff(next.noteName, next.clef);
  }
}

function clearTargetNote() {
  targetNote = null;
  targetShownAtMs = null;
  targetNoteEl.textContent = "--";
  renderTargetStaff(null, null);
}

function renderTargetStaff(scientificNote, clefKey) {
  const activeClef = clefKey ?? (clefMode === "both" ? "treble" : clefMode);
  const staffLines = [25, 35, 45, 55, 65]
    .map(
      (y) =>
        `<line x1="30" y1="${y}" x2="205" y2="${y}" stroke="#cbd5e1" stroke-width="1.5" />`
    )
    .join("");
  const barLines = `
    <line x1="30" y1="25" x2="30" y2="65" stroke="#cbd5e1" stroke-width="1.5" />
    <line x1="205" y1="25" x2="205" y2="65" stroke="#cbd5e1" stroke-width="1.5" />
  `;
  const clefSymbol = CLEF_CONFIG[activeClef].symbol;
  const clef = `<text x="30" y="46" fill="#cbd5e1" font-size="70" dominant-baseline="middle">${clefSymbol}</text>`;

  if (!scientificNote || displayMode !== "staff") {
    targetStaffEl.innerHTML = `
      ${staffLines}
      ${barLines}
      ${clef}
    `;
    return;
  }

  const parsed = parseScientificNote(scientificNote);
  if (!parsed) {
    targetStaffEl.innerHTML = `${staffLines}${barLines}${clef}`;
    return;
  }

  const noteX = 148;
  const noteRadiusX = 8;
  const noteRadiusY = 6;
  const bottomIndex = getClefBottomLineIndex(activeClef);
  const noteIndex = diatonicIndex(parsed.letter, parsed.octave);
  const staffStepsFromBottom = noteIndex - bottomIndex;
  const noteY = 65 - staffStepsFromBottom * 5;

  const accidental =
    parsed.accidental === "#"
      ? `<text x="118" y="${noteY + 2}" fill="#f8fafc" font-size="22" font-weight="400" dominant-baseline="middle">#</text>`
      : parsed.accidental === "b"
        ? `<text x="120" y="${noteY + 2}" fill="#f8fafc" font-size="28" font-weight="400" dominant-baseline="middle">♭</text>`
        : "";

  const stem =
    noteY <= 45
      ? `<line x1="${noteX - 7}" y1="${noteY + 2}" x2="${noteX - 7}" y2="${noteY + 30}" stroke="#f8fafc" stroke-width="2" />`
      : `<line x1="${noteX + 7}" y1="${noteY - 2}" x2="${noteX + 7}" y2="${noteY - 30}" stroke="#f8fafc" stroke-width="2" />`;

  const needsLedger = noteY < 25 || noteY > 65;
  const isOnLine = staffStepsFromBottom % 2 === 0;
  const ledgerLine =
    needsLedger && isOnLine
      ? `<line x1="${noteX - 12}" y1="${noteY}" x2="${noteX + 12}" y2="${noteY}" stroke="#cbd5e1" stroke-width="1.5" />`
      : "";

  targetStaffEl.innerHTML = `
    ${staffLines}
    ${barLines}
    ${clef}
    ${ledgerLine}
    ${accidental}
    ${stem}
    <ellipse cx="${noteX}" cy="${noteY}" rx="${noteRadiusX}" ry="${noteRadiusY}" fill="#f8fafc" transform="rotate(-20 ${noteX} ${noteY})" />
  `;
}

function updatePracticeModeUI() {
  const usingStaff = displayMode === "staff";
  clefControlsEl.classList.toggle("hidden", !usingStaff);
  staffWrapperEl.classList.toggle("hidden", !usingStaff);
  targetNoteEl.classList.toggle("hidden", usingStaff);
  modeDescriptionEl.textContent = usingStaff
    ? "Play the exact written pitch (correct octave)."
    : "Play the shown note on a piano. Any octave counts.";
}

function resetConsistencyTracking() {
  consistencyStartMs = null;
  consistencyMidi = null;
  consistencyFrequency = null;
  consistencyNoteName = null;
}

function getConsistentDetection(detected, nowMs) {
  if (consistencyStartMs === null) {
    consistencyStartMs = nowMs;
    consistencyMidi = detected.midi;
    consistencyFrequency = detected.frequency;
    consistencyNoteName = detected.noteName;
    return null;
  }

  const isConsistent =
    consistencyMidi === detected.midi &&
    Math.abs(consistencyFrequency - detected.frequency) <= CONSISTENCY_HZ_TOLERANCE;

  if (!isConsistent) {
    consistencyStartMs = nowMs;
    consistencyMidi = detected.midi;
    consistencyFrequency = detected.frequency;
    consistencyNoteName = detected.noteName;
    return null;
  }

  if (nowMs - consistencyStartMs >= CONSISTENCY_MIN_DURATION_MS) {
    return {
      midi: consistencyMidi,
      noteName: consistencyNoteName,
      frequency: detected.frequency,
    };
  }

  return null;
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

function evaluateDetectedNote(detected) {
  if (isLocked || !targetNote) {
    return;
  }

  resetConsistencyTracking();
  isLocked = true;

  let isCorrect = false;
  if (displayMode === "name") {
    const detectedPitchClass = midiToPitchClass(detected.midi);
    isCorrect = detectedPitchClass === targetNote.pitchClass;
  } else {
    isCorrect = detected.midi === targetNote.midi;
  }

  totalAttempts += 1;
  if (isCorrect) {
    correctAttempts += 1;
    if (targetShownAtMs !== null) {
      totalCorrectResponseMs += performance.now() - targetShownAtMs;
    }
  }
  updatePerformanceDisplay();

  setResultFlash(isCorrect);

  if (isCorrect) {
    streakCount += 1;
    updateStreakDisplay();
    hintEl.textContent = "Correct! Release the key; next note appears after silence.";
    setTimeout(() => {
      clearTargetNote();
      resetConsistencyTracking();
      waitingForSilenceAfterCorrect = true;
      silentFrameCount = 0;
    }, 1000);
  } else {
    streakCount = 0;
    updateStreakDisplay();
    hintEl.textContent = `Not quite. You played ${detected.noteName}. Try again.`;
    setTimeout(() => {
      isLocked = false;
      resetConsistencyTracking();
    }, 1000);
  }
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
    const noteName =
      displayMode === "staff" ? midiToScientificNote(midi) : DETECTED_NOTE_NAMES[midiToPitchClass(midi)];
    const detected = { midi, noteName, frequency: rawFrequency };

    if (!isLocked && targetNote) {
      const consistent = getConsistentDetection(detected, performance.now());
      if (consistent) {
        detectedNoteEl.textContent = consistent.noteName;
        detectedFrequencyEl.textContent = `${consistent.frequency.toFixed(1)} Hz`;
        evaluateDetectedNote(consistent);
      } else {
        detectedNoteEl.textContent = "Listening...";
        detectedFrequencyEl.textContent = "-- Hz";
      }
    } else if (!isLocked) {
      detectedNoteEl.textContent = "Listening...";
      detectedFrequencyEl.textContent = "-- Hz";
    }
  } else {
    resetConsistencyTracking();
    if (waitingForSilenceAfterCorrect) {
      silentFrameCount += 1;
      if (silentFrameCount >= SILENCE_FRAMES_REQUIRED) {
        waitingForSilenceAfterCorrect = false;
        pickNextTargetNote();
        hintEl.textContent = "Play the shown note on your instrument.";
        isLocked = false;
        resetConsistencyTracking();
      }
    }

    if (!isLocked) {
      detectedNoteEl.textContent = "Listening...";
      detectedFrequencyEl.textContent = "-- Hz";
    }
  }

  animationFrameId = requestAnimationFrame(listenFrame);
}

function refreshTargetsForModeChange() {
  noteQueue = [];
  waitingForSilenceAfterCorrect = false;
  silentFrameCount = 0;
  isLocked = false;
  resetConsistencyTracking();
  clearTargetNote();
  detectedNoteEl.textContent = "Listening...";
  detectedFrequencyEl.textContent = "-- Hz";
  if (isListening) {
    pickNextTargetNote();
    hintEl.textContent = "Play the shown note on your instrument.";
  }
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

displayModeEl.addEventListener("change", () => {
  displayMode = displayModeEl.value;
  updatePracticeModeUI();
  refreshTargetsForModeChange();
});

clefModeEl.addEventListener("change", () => {
  clefMode = clefModeEl.value;
  if (displayMode === "staff") {
    refreshTargetsForModeChange();
  } else {
    renderTargetStaff(null, null);
  }
});

startButton.addEventListener("click", () => {
  if (!isListening) {
    streakCount = 0;
    updateStreakDisplay();
    resetPerformanceStats();
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

displayModeEl.value = displayMode;
clefModeEl.value = clefMode;
updatePracticeModeUI();
updatePerformanceDisplay();
renderTargetStaff(null, null);

