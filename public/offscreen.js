"use strict";
(() => {
  // src/offscreen.ts
  var micRecorder = null;
  var micInterval = null;
  var micSessionId = null;
  var tabRecorder = null;
  var tabInterval = null;
  var tabAudioCtx = null;
  var tabSessionId = null;
  var expectedRecorderStops = /* @__PURE__ */ new WeakSet();
  var flushResolvers = /* @__PURE__ */ new Map();
  chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
    if (message.type === "START_MIC_CAPTURE") {
      const { meetingSessionId, sessionToken, apiBase } = message;
      if (micRecorder && micSessionId === meetingSessionId && isRecorderHealthy(micRecorder)) {
        return;
      }
      stopMicCapture();
      navigator.mediaDevices.getUserMedia({
        audio: {
          echoCancellation: false,
          // Don't interfere with meeting's echo cancellation
          noiseSuppression: false,
          autoGainControl: false
        }
      }).then((stream) => {
        const { recorder, interval } = startRecording(stream, "mic", meetingSessionId, sessionToken, apiBase);
        micRecorder = recorder;
        micInterval = interval;
        micSessionId = meetingSessionId;
        console.log("[Evolvio Offscreen] Mic capture started");
      }).catch((err) => {
        console.warn("[Evolvio Offscreen] Mic capture failed:", err.message);
        chrome.runtime.sendMessage({
          type: "AUDIO_CAPTURE_STOPPED",
          stream: "mic",
          meetingSessionId,
          reason: `mic-start-failed:${err?.name || "unknown"}`
        }).catch(() => {
        });
      });
    }
    if (message.type === "START_TAB_CAPTURE") {
      const { meetingSessionId, sessionToken, apiBase, streamId } = message;
      if (tabRecorder && tabSessionId === meetingSessionId && isRecorderHealthy(tabRecorder)) {
        return;
      }
      stopTabCapture();
      navigator.mediaDevices.getUserMedia({
        audio: {
          mandatory: {
            chromeMediaSource: "tab",
            chromeMediaSourceId: streamId
          }
        },
        video: false
      }).then((tabStream) => {
        const audioCtx = new AudioContext();
        tabAudioCtx = audioCtx;
        const source = audioCtx.createMediaStreamSource(tabStream);
        source.connect(audioCtx.destination);
        const dest = audioCtx.createMediaStreamDestination();
        source.connect(dest);
        const { recorder, interval } = startRecording(dest.stream, "tab", meetingSessionId, sessionToken, apiBase);
        tabRecorder = recorder;
        tabInterval = interval;
        tabSessionId = meetingSessionId;
        console.log("[Evolvio Offscreen] Tab audio split: speakers + recorder both active");
      }).catch((err) => {
        console.warn("[Evolvio Offscreen] Tab capture failed:", err.message);
        chrome.runtime.sendMessage({
          type: "AUDIO_CAPTURE_STOPPED",
          stream: "tab",
          meetingSessionId,
          reason: `tab-start-failed:${err?.name || "unknown"}`
        }).catch(() => {
        });
      });
    }
    if (message.type === "STOP_MIC_CAPTURE") {
      stopMicCapture();
      console.log("[Evolvio Offscreen] Mic capture stopped");
    }
    if (message.type === "STOP_TAB_CAPTURE") {
      stopTabCapture();
      console.log("[Evolvio Offscreen] Tab capture stopped");
    }
    if (message.type === "FLUSH_AUDIO_CAPTURE") {
      Promise.all([
        flushRecorder(micRecorder, 6e3),
        flushRecorder(tabRecorder, 6e3)
      ]).then(() => sendResponse({ ok: true })).catch((err) => sendResponse({ ok: false, error: err?.message || String(err) }));
      return true;
    }
  });
  function settleFlushes(recorder) {
    const resolvers = flushResolvers.get(recorder) || [];
    flushResolvers.delete(recorder);
    resolvers.forEach((resolve) => resolve());
  }
  function flushRecorder(recorder, timeoutMs) {
    if (!recorder || recorder.state !== "recording") return Promise.resolve();
    return new Promise((resolve) => {
      let timer;
      const done = () => {
        clearTimeout(timer);
        const resolvers2 = flushResolvers.get(recorder) || [];
        const index = resolvers2.indexOf(done);
        if (index >= 0) resolvers2.splice(index, 1);
        if (resolvers2.length === 0) flushResolvers.delete(recorder);
        resolve();
      };
      timer = setTimeout(done, timeoutMs);
      const resolvers = flushResolvers.get(recorder) || [];
      resolvers.push(done);
      flushResolvers.set(recorder, resolvers);
      try {
        recorder.requestData();
      } catch (_) {
        done();
      }
    });
  }
  function isRecorderHealthy(recorder) {
    return recorder.state === "recording" && recorder.stream.active && recorder.stream.getAudioTracks().some((track) => track.readyState === "live");
  }
  function stopMicCapture() {
    if (micInterval) {
      clearInterval(micInterval);
      micInterval = null;
    }
    if (micRecorder) {
      expectedRecorderStops.add(micRecorder);
      if (micRecorder.state === "recording") {
        try {
          micRecorder.stop();
        } catch (_) {
        }
      }
      micRecorder.stream.getTracks().forEach((t) => t.stop());
      micRecorder = null;
    }
    micSessionId = null;
  }
  function stopTabCapture() {
    if (tabInterval) {
      clearInterval(tabInterval);
      tabInterval = null;
    }
    if (tabRecorder) {
      expectedRecorderStops.add(tabRecorder);
      if (tabRecorder.state === "recording") {
        try {
          tabRecorder.stop();
        } catch (_) {
        }
      }
      tabRecorder.stream.getTracks().forEach((t) => t.stop());
      tabRecorder = null;
    }
    if (tabAudioCtx) {
      tabAudioCtx.close().catch(() => {
      });
      tabAudioCtx = null;
    }
    tabSessionId = null;
  }
  function startRecording(stream, streamType, meetingSessionId, sessionToken, apiBase) {
    const recorder = new MediaRecorder(stream, { mimeType: "audio/webm" });
    let chunkStartedAt = Date.now();
    let stopReported = false;
    let interval = null;
    let lastTranscriptTextAt = Date.now();
    let chunksSinceText = 0;
    let consecutiveUploadFailures = 0;
    let consecutiveEmptyTranscripts = 0;
    let consecutiveTinyChunks = 0;
    let lastDataAvailableAt = Date.now();
    const reportUnexpectedStop = (reason) => {
      if (stopReported || expectedRecorderStops.has(recorder)) return;
      stopReported = true;
      if (interval) {
        clearInterval(interval);
        interval = null;
      }
      chrome.runtime.sendMessage({
        type: "AUDIO_CAPTURE_STOPPED",
        stream: streamType,
        meetingSessionId,
        reason
      }).catch(() => {
      });
      try {
        if (recorder.state === "recording") recorder.stop();
      } catch (_) {
      }
      stream.getTracks().forEach((track) => {
        try {
          track.stop();
        } catch (_) {
        }
      });
    };
    recorder.onerror = () => reportUnexpectedStop("recorder-error");
    recorder.onstop = () => reportUnexpectedStop("recorder-stopped");
    stream.getAudioTracks().forEach((track) => {
      track.addEventListener("ended", () => reportUnexpectedStop("track-ended"));
      track.addEventListener("mute", () => {
        setTimeout(() => {
          if (track.muted && recorder.state === "recording") {
            reportUnexpectedStop("track-muted");
          }
        }, 3e4);
      });
    });
    recorder.ondataavailable = async (e) => {
      try {
        lastDataAvailableAt = Date.now();
        if (!e.data || e.data.size < 1e3) {
          consecutiveTinyChunks++;
          chunksSinceText++;
          if (consecutiveTinyChunks >= 12 && chunksSinceText >= 12 && Date.now() - lastTranscriptTextAt > 12e4) {
            reportUnexpectedStop("audio-chunks-too-small");
          }
          return;
        }
        consecutiveTinyChunks = 0;
        const blob = e.data;
        const chunkEndedAt = Date.now();
        const chunkStart = chunkStartedAt;
        chunkStartedAt = Date.now();
        const form = new FormData();
        form.append("audio", blob, "chunk.webm");
        form.append("stream", streamType);
        form.append("meeting_session_id", meetingSessionId);
        const response = await fetch(`${apiBase}/audio/transcribe`, {
          method: "POST",
          headers: { Authorization: `Bearer ${sessionToken}` },
          body: form
        }).catch(() => null);
        if (!response?.ok) {
          consecutiveUploadFailures++;
          if (consecutiveUploadFailures >= 3) {
            reportUnexpectedStop("transcription-upload-failed");
          }
          return;
        }
        consecutiveUploadFailures = 0;
        const result = await response.json().catch(() => null);
        if (!result?.text) {
          consecutiveEmptyTranscripts++;
          chunksSinceText++;
          if (consecutiveEmptyTranscripts >= 6 && chunksSinceText >= 6 && Date.now() - lastTranscriptTextAt > 6e4) {
            reportUnexpectedStop("transcription-stalled");
          }
          return;
        }
        consecutiveEmptyTranscripts = 0;
        consecutiveTinyChunks = 0;
        chunksSinceText = 0;
        lastTranscriptTextAt = Date.now();
        chrome.runtime.sendMessage({
          type: "AUDIO_TRANSCRIPT_RESULT",
          text: result.text,
          stream: streamType,
          startOffsetMs: chunkStart,
          endOffsetMs: chunkEndedAt,
          eventTimeMs: chunkEndedAt
        }).catch(() => {
        });
      } finally {
        settleFlushes(recorder);
      }
    };
    recorder.start();
    interval = setInterval(() => {
      const liveAudioTrack = stream.getAudioTracks().some((track) => track.readyState === "live");
      if (recorder.state !== "recording" || !stream.active || !liveAudioTrack) {
        reportUnexpectedStop("health-check-failed");
        return;
      }
      if (Date.now() - lastDataAvailableAt > 12e4) {
        reportUnexpectedStop("no-audio-chunks");
        return;
      }
      try {
        recorder.requestData();
      } catch (_) {
        reportUnexpectedStop("request-data-failed");
      }
    }, 1e4);
    return { recorder, interval };
  }
})();
