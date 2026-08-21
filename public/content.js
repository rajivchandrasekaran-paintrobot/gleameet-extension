"use strict";
(() => {
  // src/utils/event-factory.ts
  function generateUUID() {
    return "xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx".replace(/[xy]/g, (c) => {
      const r = Math.random() * 16 | 0;
      const v = c === "x" ? r : r & 3 | 8;
      return v.toString(16);
    });
  }
  function createEvent(meetingSessionId, userId, platform, eventType, payload, captureConfidence = null) {
    return {
      event_id: generateUUID(),
      meeting_session_id: meetingSessionId,
      user_id: userId,
      platform,
      event_type: eventType,
      event_time_utc: (/* @__PURE__ */ new Date()).toISOString(),
      source: "extension",
      capture_confidence: captureConfidence,
      payload
    };
  }

  // src/utils/platform.ts
  function detectPlatformFromUrl(url) {
    if (url.includes("meet.google.com")) return "google_meet";
    if (url.includes("teams.microsoft.com") || url.includes("teams.live.com")) return "teams";
    if (url.includes("zoom.us") || url.includes("app.zoom.us")) return "zoom";
    return null;
  }
  function getPlatformCapabilities(platform) {
    switch (platform) {
      case "google_meet":
        return {
          supportsDomSpeechSignals: true,
          supportsDomCaptions: true,
          supportsMicSpeechDetection: true,
          supportsTabAudioCapture: true
        };
      case "teams":
      case "zoom":
        return {
          supportsDomSpeechSignals: false,
          supportsDomCaptions: false,
          supportsMicSpeechDetection: true,
          supportsTabAudioCapture: true
        };
      default:
        return {
          supportsDomSpeechSignals: false,
          supportsDomCaptions: false,
          supportsMicSpeechDetection: false,
          supportsTabAudioCapture: false
        };
    }
  }

  // src/utils/transcript-attribution.ts
  var RECENT_CONTEXT_WINDOW_MS = 15e3;
  var MAX_CONTEXT_ENTRIES = 20;
  var MIN_OVERLAP_TOKENS = 4;
  var STRONG_OVERLAP_SCORE = 0.72;
  function normalizeText(text) {
    return text.toLowerCase().replace(/[^a-z0-9\s]/g, " ").replace(/\s+/g, " ").trim();
  }
  function tokenize(text) {
    return normalizeText(text).split(" ").filter((token) => token.length >= 2);
  }
  function computeOverlapScore(a, b) {
    const normalizedA = normalizeText(a);
    const normalizedB = normalizeText(b);
    if (!normalizedA || !normalizedB) return 0;
    if (normalizedA === normalizedB) return 1;
    if (normalizedA.length >= 12 && normalizedB.includes(normalizedA)) return 0.95;
    if (normalizedB.length >= 12 && normalizedA.includes(normalizedB)) return 0.95;
    const tokensA = tokenize(a);
    const tokensB = tokenize(b);
    if (tokensA.length === 0 || tokensB.length === 0) return 0;
    const setA = new Set(tokensA);
    const setB = new Set(tokensB);
    let shared = 0;
    for (const token of setA) {
      if (setB.has(token)) shared++;
    }
    if (shared < Math.min(MIN_OVERLAP_TOKENS, setA.size, setB.size)) return 0;
    return shared / Math.max(Math.min(setA.size, setB.size), 1);
  }
  var TranscriptAttributionTracker = class {
    recentContext = [];
    classifySegment(params) {
      const text = params.text.trim();
      if (!text) return null;
      this.pruneContext(params.timestampMs);
      const attribution = this.buildAttribution(params);
      const payload = {
        text,
        speaker: attribution.final_speaker,
        start_offset_ms: params.startOffsetMs,
        end_offset_ms: params.endOffsetMs,
        attribution
      };
      this.rememberContext({
        speaker: payload.speaker,
        source: params.source,
        text,
        ts: params.timestampMs
      });
      return payload;
    }
    buildAttribution(params) {
      if (params.candidateSpeaker === "other") {
        return {
          source: params.source,
          candidate_speaker: "other",
          final_speaker: "other",
          passes_user_attribution: false,
          reason: "non_user_context"
        };
      }
      if (params.source === "mic") {
        return {
          source: params.source,
          candidate_speaker: "user",
          final_speaker: "user",
          passes_user_attribution: true,
          reason: "trusted_mic_capture"
        };
      }
      const overlapMatch = this.findBestNonUserOverlap(params.text, params.timestampMs);
      if (overlapMatch && overlapMatch.score >= STRONG_OVERLAP_SCORE) {
        return {
          source: params.source,
          candidate_speaker: "user",
          final_speaker: "other",
          passes_user_attribution: false,
          reason: "overlap_with_recent_non_user_context",
          overlap_score: Number(overlapMatch.score.toFixed(2)),
          matched_source: overlapMatch.entry.source
        };
      }
      return {
        source: params.source,
        candidate_speaker: "user",
        final_speaker: "user",
        passes_user_attribution: true,
        reason: "self_declared"
      };
    }
    findBestNonUserOverlap(text, timestampMs) {
      let best = null;
      for (const entry of this.recentContext) {
        if (entry.speaker !== "other") continue;
        if (timestampMs - entry.ts > RECENT_CONTEXT_WINDOW_MS) continue;
        const score = computeOverlapScore(text, entry.text);
        if (!best || score > best.score) {
          best = { entry, score };
        }
      }
      return best;
    }
    rememberContext(entry) {
      this.recentContext.push(entry);
      if (this.recentContext.length > MAX_CONTEXT_ENTRIES) {
        this.recentContext.splice(0, this.recentContext.length - MAX_CONTEXT_ENTRIES);
      }
    }
    pruneContext(timestampMs) {
      const cutoff = timestampMs - RECENT_CONTEXT_WINDOW_MS;
      while (this.recentContext.length > 0 && this.recentContext[0].ts < cutoff) {
        this.recentContext.shift();
      }
    }
  };

  // src/content/content-script.ts
  var DEFAULT_CAPTURE_MODE = "user_voice_only";
  var state = {
    meetingDetected: false,
    meetingSessionId: null,
    userId: null,
    platform: null,
    status: "off",
    currentPrompt: null,
    promptDismissTimer: null,
    mutationObserver: null,
    speechObserver: null,
    captionObserver: null,
    userSpeaking: false,
    lastSpeechEmitMs: 0,
    eventsEmitted: 0,
    diagnosticInterval: null,
    selfNames: /* @__PURE__ */ new Set(),
    captureMode: DEFAULT_CAPTURE_MODE,
    promptsMutedByUser: false,
    signalCaptureSessionId: null
  };
  function resolveCaptureMode(value, fallback = DEFAULT_CAPTURE_MODE) {
    return value === "full_meeting" || value === "user_voice_only" ? value : fallback;
  }
  var CAPTION_SELECTORS = [
    // 2025/2026 Meet caption area — the bottom overlay with live text
    '[jsname="tgaKEf"]',
    // Caption text node
    'div[class*="TBMuR"]',
    // Caption container
    'div[class*="CNusmb"]',
    // Caption block
    "div.a4cQT",
    // Captions wrapper
    // Speaker + text containers
    "[data-message-id]",
    // Timestamped captions
    // Fallbacks
    '[jscontroller="D1tHje"] span',
    'div[class*="iOzk7"] span'
  ];
  var SPEECH_THROTTLE_MS = 500;
  var transcriptAttribution = new TranscriptAttributionTracker();
  function rememberSelfName(name) {
    const normalized = (name || "").trim();
    if (!normalized) return;
    if (/^you$/i.test(normalized)) return;
    if (normalized.length < 2) return;
    state.selfNames.add(normalized.toLowerCase());
  }
  function refreshSelfIdentityHints() {
    const candidates = /* @__PURE__ */ new Set();
    document.querySelectorAll("[aria-label]").forEach((el) => {
      const label = (el.getAttribute("aria-label") || "").trim();
      if (!label) return;
      const youParen = label.match(/^(.*?)\s*\(\s*you\s*\)$/i);
      const youDash = label.match(/^(.*?)\s*[—-]\s*you$/i);
      const youComma = label.match(/^you\s*,\s*(.*?)$/i);
      const direct = youParen?.[1] || youDash?.[1] || youComma?.[1];
      if (direct) candidates.add(direct.trim());
    });
    document.querySelectorAll("*").forEach((el) => {
      const text = (el.textContent || "").trim();
      if (!text || text.length > 80) return;
      if (/\bYou\b/i.test(text)) {
        const prev = el.previousElementSibling?.textContent?.trim();
        const next = el.nextElementSibling?.textContent?.trim();
        if (prev && prev !== "You") candidates.add(prev);
        if (next && next !== "You") candidates.add(next);
      }
    });
    candidates.forEach(rememberSelfName);
  }
  function isLikelySelfCaption(el) {
    const container = el.closest("[class]");
    const nearby = [
      container?.previousElementSibling?.textContent,
      container?.parentElement?.previousElementSibling?.textContent,
      container?.getAttribute?.("aria-label") || null,
      el.getAttribute?.("aria-label") || null
    ].map((v) => (v || "").trim()).filter(Boolean);
    for (const value of nearby) {
      if (/^you$/i.test(value) || /\(\s*you\s*\)$/i.test(value) || /\byou\b/i.test(value)) {
        return true;
      }
      const normalized = value.toLowerCase();
      for (const selfName of state.selfNames) {
        if (normalized === selfName || normalized.includes(selfName)) return true;
      }
    }
    return !!el.closest("[data-self-name]") || !!el.closest('[data-is-self="true"]');
  }
  function getPlatform() {
    return detectPlatformFromUrl(window.location.href);
  }
  function detectMeeting() {
    const url = window.location.href;
    const platform = getPlatform();
    if (!platform) return false;
    if (platform === "google_meet" && /meet\.google\.com\/[a-z]+-[a-z]+-[a-z]+/i.test(url)) {
      const hasVideo = !!document.querySelector("video");
      const hasCallControls = !!document.querySelector("[data-is-muted]") || !!document.querySelector('[aria-label*="Leave"]') || !!document.querySelector('[aria-label*="leave"]') || !!document.querySelector('[aria-label*="microphone" i]') || !!document.querySelector('[aria-label*="camera" i]') || !!document.querySelector('[aria-label*="captions" i]') || !!document.querySelector('[aria-label*="raise hand" i]') || !!document.querySelector('[data-tooltip*="Leave" i]') || !!document.querySelector('[data-tooltip*="microphone" i]') || !!document.querySelector('[data-tooltip*="camera" i]');
      const hasParticipantTiles = !!document.querySelector("[data-participant-id]") || !!document.querySelector("[data-self-name]") || !!document.querySelector('[data-is-self="true"]');
      return hasVideo || hasCallControls || hasParticipantTiles;
    }
    if (platform === "teams") {
      const decodedUrl = decodeURIComponent(url);
      const inCallUrl = url.includes("/callingv2") || url.includes("/meet/") || url.includes("/_#/callingv2") || url.includes("/calling") || url.includes("launcher.html") || url.includes("/l/meetup-join") || url.includes("/light-meetings/launch") || url.includes("lightExperience=true") || url.includes("anon=true") || url.includes("type=meet") || decodedUrl.includes("/meet/") || // encoded meet URLs
      decodedUrl.includes("/_#/meet") || // encoded hash URLs
      decodedUrl.includes("/callingv2") || decodedUrl.includes("/light-meetings/launch");
      const endedUi = !!document.querySelector('[data-tid="call-ended-screen"]') || /meeting has ended|call ended|you left the meeting/i.test(document.body.textContent || "");
      const hasCallUi = !!document.querySelector('[data-tid="calling-screen"]') || !!document.querySelector('[data-tid="hangup-btn"]') || !!document.querySelector('[data-tid="toggle-mute"]') || !!document.querySelector('[data-tid="toggle-video"]') || !!document.querySelector('[data-tid="prejoin-join-button"]') || !!document.querySelector('button[aria-label*="Leave"]') || !!document.querySelector('button[aria-label*="leave"]') || !!document.querySelector('[class*="calling"]') || !!document.querySelector('[id*="calling"]');
      const titleLooksMeetingLike = document.title.toLowerCase().includes("meeting") || document.title.toLowerCase().includes("call");
      return !endedUi && (inCallUrl || hasCallUi || !!document.querySelector("video") && titleLooksMeetingLike);
    }
    if (platform === "zoom") {
      const decodedUrl = decodeURIComponent(url);
      const zoomPath = (() => {
        try {
          return new URL(url).pathname;
        } catch (_err) {
          return decodedUrl;
        }
      })();
      const hasWebClientMeetingUrl = /\/wc\/\d+(?:\/(?:join|start|meeting))?(?:\/|$)/i.test(zoomPath);
      const hasMeetingUrl = hasWebClientMeetingUrl || url.includes("/join");
      const hasMeetingUi = !!document.querySelector(".meeting-app") || !!document.querySelector("#wc-container-right") || !!document.querySelector(".footer-button-base__button-label") || !!document.querySelector('[aria-label*="Leave"]') || !!document.querySelector('[aria-label*="leave"]') || !!document.querySelector('[aria-label*="mute"]') || !!document.querySelector('[class*="footer"] button') || !!document.querySelector("video");
      const visibleEndedScreen = Array.from(document.querySelectorAll('.zm-modal-body-title, .zm-modal-body-content, [role="dialog"]')).some((el) => isVisibleElement(el) && /ended|left|removed/i.test(el.textContent || ""));
      if (hasMeetingUi) return hasMeetingUrl;
      return hasMeetingUrl && hasWebClientMeetingUrl && !visibleEndedScreen;
    }
    return false;
  }
  function isLikelyMeetingUrl(url = window.location.href) {
    const platform = detectPlatformFromUrl(url);
    if (!platform) return false;
    const decodedUrl = decodeURIComponent(url);
    let path = decodedUrl;
    try {
      path = new URL(url).pathname;
    } catch (_err) {
    }
    if (platform === "google_meet") {
      return /meet\.google\.com\/[a-z]+-[a-z]+-[a-z]+/i.test(decodedUrl);
    }
    if (platform === "zoom") {
      return /\/wc\/\d+(?:\/(?:join|start|meeting))?(?:\/|$)/i.test(path);
    }
    if (platform === "teams") {
      return decodedUrl.includes("/meet/") || decodedUrl.includes("/callingv2") || decodedUrl.includes("/light-meetings/launch") || decodedUrl.includes("/l/meetup-join") || decodedUrl.includes("type=meet") || decodedUrl.includes("lightExperience=true");
    }
    return false;
  }
  function shouldTrustLikelyMeetingUrl() {
    return isLikelyMeetingUrl() && (state.meetingDetected || state.status === "active" || state.status === "muted");
  }
  function shouldRediscoverMeetingFromUrl() {
    return isLikelyMeetingUrl() && getPlatform() === "zoom";
  }
  function isExplicitTeardownReason(reason) {
    return reason === "meeting-ended" || reason === "coaching-ended-by-user" || reason === "tracked-tab-removed" || reason === "tracked-tab-left-meeting-url";
  }
  function shouldIgnoreStaleStatusDowngrade(message) {
    const statusReason = message.statusReason;
    if (isExplicitTeardownReason(statusReason)) return false;
    const incomingStatus = message.status;
    const clearsSession = message.meetingSessionId === null;
    const downgradesStatus = incomingStatus === "off" || incomingStatus === "ready" || incomingStatus === "error";
    if (!downgradesStatus && !clearsSession) return false;
    const hasLiveSession = !!state.meetingSessionId || !!state.signalCaptureSessionId;
    const stillLooksInMeeting = detectMeeting() || shouldTrustLikelyMeetingUrl() || shouldRediscoverMeetingFromUrl();
    return hasLiveSession && stillLooksInMeeting;
  }
  function hasVisibleMeetingEndSignal() {
    const platform = getPlatform();
    const bodyText = document.body.textContent || "";
    if (platform === "zoom") {
      return Array.from(document.querySelectorAll('.zm-modal-body-title, .zm-modal-body-content, [role="dialog"]')).some((el) => isVisibleElement(el) && /ended|left|removed/i.test(el.textContent || ""));
    }
    if (platform === "teams") {
      return !!document.querySelector('[data-tid="call-ended-screen"]') || /meeting has ended|call ended|you left the meeting/i.test(bodyText);
    }
    if (platform === "google_meet") {
      return /you left the meeting|return to home screen|rejoin|meeting has ended/i.test(bodyText);
    }
    return false;
  }
  function isVisibleElement(el) {
    const element = el;
    const style = window.getComputedStyle(element);
    if (style.display === "none" || style.visibility === "hidden" || style.opacity === "0") {
      return false;
    }
    const rect = element.getBoundingClientRect();
    return rect.width > 0 && rect.height > 0;
  }
  var meetingEndDebounceTimer = null;
  function cancelMeetingEndDebounce() {
    if (!meetingEndDebounceTimer) return;
    clearTimeout(meetingEndDebounceTimer);
    meetingEndDebounceTimer = null;
  }
  function scheduleMeetingEndDebounce() {
    if (meetingEndDebounceTimer) return;
    const debounceMs = state.status === "active" || state.status === "muted" ? 15e3 : 5e3;
    meetingEndDebounceTimer = setTimeout(() => {
      meetingEndDebounceTimer = null;
      const visibleEndSignal = hasVisibleMeetingEndSignal();
      if (!detectMeeting() && (!shouldTrustLikelyMeetingUrl() || visibleEndSignal)) {
        onMeetingEnded(visibleEndSignal);
      }
    }, debounceMs);
  }
  function startMeetingDetection() {
    if ((detectMeeting() || shouldRediscoverMeetingFromUrl()) && !state.meetingDetected) {
      onMeetingDetected();
    }
    state.mutationObserver = new MutationObserver(() => {
      const inMeeting = detectMeeting() || shouldRediscoverMeetingFromUrl();
      if (inMeeting && !state.meetingDetected) {
        cancelMeetingEndDebounce();
        onMeetingDetected();
      } else if (inMeeting) {
        cancelMeetingEndDebounce();
      } else if (!inMeeting && state.meetingDetected) {
        scheduleMeetingEndDebounce();
      }
    });
    state.mutationObserver.observe(document.body, {
      childList: true,
      subtree: true
    });
  }
  function onMeetingDetected() {
    const platform = getPlatform();
    if (!platform) return;
    state.meetingDetected = true;
    state.platform = platform;
    if (state.status === "off") {
      state.status = "ready";
    }
    chrome.runtime.sendMessage({ type: "MEETING_DETECTED", platform }).catch(() => {
    });
    injectStatusIndicator();
    console.log("[Evolvio] Meeting detected");
  }
  function onMeetingEnded(visibleEndSignal = hasVisibleMeetingEndSignal()) {
    state.meetingDetected = false;
    if (state.status === "active" || state.status === "muted" || state.status === "ready") {
      chrome.runtime.sendMessage({
        type: "MEETING_ENDED",
        visibleEndSignal,
        likelyMeetingUrl: isLikelyMeetingUrl()
      }).catch(() => {
      });
    }
    state.status = "off";
    state.meetingSessionId = null;
    state.platform = null;
    stopSignalCapture();
    removeOverlay();
    removeStatusIndicator();
    console.log("[Evolvio] Meeting ended");
  }
  async function recoverActiveSessionContext() {
    if (state.meetingSessionId && state.userId) return true;
    const status = await chrome.runtime.sendMessage({ type: "GET_STATUS" }).catch(() => null);
    if (status?.meetingSessionId) {
      state.meetingSessionId = status.meetingSessionId;
    }
    if (status?.userId) {
      state.userId = status.userId;
    }
    if (status?.platform) {
      state.platform = status.platform;
    }
    state.captureMode = resolveCaptureMode(status?.captureMode, state.captureMode);
    return !!state.meetingSessionId && !!state.userId;
  }
  function sendCaptureDiagnostic(reason, detail) {
    chrome.runtime.sendMessage({
      type: "CAPTURE_DIAGNOSTIC",
      reason,
      platform: state.platform ?? getPlatform(),
      meetingSessionId: state.meetingSessionId,
      userId: state.userId,
      captureMode: state.captureMode,
      detail
    }).catch(() => {
    });
  }
  async function startSignalCapture() {
    if (!await recoverActiveSessionContext()) {
      sendCaptureDiagnostic("capture_context_missing", {
        hasMeetingSessionId: !!state.meetingSessionId,
        hasUserId: !!state.userId
      });
      return;
    }
    if (state.signalCaptureSessionId === state.meetingSessionId) return;
    const platform = state.platform ?? getPlatform();
    if (!platform) {
      sendCaptureDiagnostic("platform_missing");
      return;
    }
    const capabilities = getPlatformCapabilities(platform);
    if (capabilities.supportsDomSpeechSignals) {
      observeSpeechIndicators();
    }
    if (capabilities.supportsDomCaptions) {
      observeCaptions();
    }
    if (!capabilities.supportsDomSpeechSignals && capabilities.supportsMicSpeechDetection) {
      console.log(`[Evolvio] ${platform}: using mic-first signal capture; DOM-only Meet signals disabled`);
      startMicrophoneDetection();
    }
    if (platform === "google_meet" && state.captureMode === "user_voice_only") {
      startPageMicrophoneCapture();
    } else {
      chrome.runtime.sendMessage({
        type: "START_AUDIO_CAPTURE",
        meetingSessionId: state.meetingSessionId,
        captureMode: state.captureMode
      }).catch((err) => {
        sendCaptureDiagnostic("start_audio_capture_message_failed", { message: err?.message || String(err) });
      });
    }
    state.signalCaptureSessionId = state.meetingSessionId;
    sendCoachingActiveHeartbeat();
    emitEvent("session_state_changed", {
      previous_state: "ready",
      new_state: "active",
      reason: "coaching_enabled",
      platform
    });
    state.diagnosticInterval = setInterval(() => {
      const captionEls = platform === "google_meet" ? CAPTION_SELECTORS.flatMap((sel) => Array.from(document.querySelectorAll(sel))).length : 0;
      console.log(`[Evolvio] Diagnostics [${platform}]: events_emitted=${state.eventsEmitted}, speech_active=${state.userSpeaking}, recognition_running=${!!recognition}, capture_mode=${state.captureMode}, caption_elements_found=${captionEls}`);
      sendCoachingActiveHeartbeat();
    }, 1e4);
  }
  function sendCoachingActiveHeartbeat() {
    if (!state.meetingSessionId || !state.userId) return;
    chrome.runtime.sendMessage({
      type: "COACHING_ACTIVE",
      meetingSessionId: state.meetingSessionId,
      userId: state.userId,
      platform: state.platform ?? getPlatform(),
      captureMode: state.captureMode
    }).catch(() => {
    });
  }
  function blobToDataUrl(blob) {
    return new Promise((resolve, reject) => {
      const reader = new FileReader();
      reader.onload = () => resolve(String(reader.result || ""));
      reader.onerror = () => reject(reader.error || new Error("blob-read-failed"));
      reader.readAsDataURL(blob);
    });
  }
  var pageMicRecorder = null;
  var pageMicInterval = null;
  var pageMicSessionId = null;
  var pageMicChunkStartedAt = 0;
  function stopPageMicrophoneCapture() {
    if (pageMicInterval) {
      clearInterval(pageMicInterval);
      pageMicInterval = null;
    }
    if (pageMicRecorder) {
      try {
        if (pageMicRecorder.state === "recording") pageMicRecorder.stop();
      } catch (_) {
      }
      pageMicRecorder.stream.getTracks().forEach((track) => {
        try {
          track.stop();
        } catch (_) {
        }
      });
    }
    pageMicRecorder = null;
    pageMicSessionId = null;
    pageMicChunkStartedAt = 0;
  }
  async function startPageMicrophoneCapture() {
    if (!state.meetingSessionId) return;
    if (pageMicRecorder && pageMicSessionId === state.meetingSessionId && pageMicRecorder.state === "recording") {
      return;
    }
    stopPageMicrophoneCapture();
    const meetingSessionId = state.meetingSessionId;
    try {
      const stream = await navigator.mediaDevices.getUserMedia({
        audio: {
          echoCancellation: false,
          noiseSuppression: false,
          autoGainControl: false
        }
      });
      const recorder = new MediaRecorder(stream, { mimeType: "audio/webm" });
      pageMicRecorder = recorder;
      pageMicSessionId = meetingSessionId;
      pageMicChunkStartedAt = Date.now();
      recorder.onstart = () => sendCaptureDiagnostic("page_mic_capture_started");
      recorder.onerror = () => sendCaptureDiagnostic("page_mic_capture_error");
      recorder.onstop = () => {
        if (pageMicSessionId === meetingSessionId) {
          sendCaptureDiagnostic("page_mic_capture_stopped");
        }
      };
      stream.getAudioTracks().forEach((track) => {
        track.addEventListener("ended", () => sendCaptureDiagnostic("page_mic_track_ended"));
        track.addEventListener("mute", () => sendCaptureDiagnostic("page_mic_track_muted"));
      });
      recorder.ondataavailable = async (event) => {
        if (!event.data || event.data.size < 1e3 || !state.meetingSessionId) return;
        const chunkEndedAt = Date.now();
        const chunkStartedAt = pageMicChunkStartedAt || chunkEndedAt;
        pageMicChunkStartedAt = Date.now();
        try {
          await chrome.runtime.sendMessage({
            type: "PAGE_MIC_AUDIO_CHUNK",
            meetingSessionId,
            dataUrl: await blobToDataUrl(event.data),
            mimeType: event.data.type || "audio/webm",
            startOffsetMs: chunkStartedAt,
            endOffsetMs: chunkEndedAt,
            eventTimeMs: chunkEndedAt
          });
        } catch (err) {
          sendCaptureDiagnostic("page_mic_chunk_send_failed", { message: err?.message || String(err) });
        }
      };
      recorder.start();
      pageMicInterval = setInterval(() => {
        if (!pageMicRecorder || pageMicRecorder.state !== "recording") {
          sendCaptureDiagnostic("page_mic_not_recording");
          stopPageMicrophoneCapture();
          return;
        }
        try {
          pageMicRecorder.requestData();
        } catch (err) {
          sendCaptureDiagnostic("page_mic_request_data_failed", { message: err?.message || String(err) });
        }
      }, 1e4);
    } catch (err) {
      sendCaptureDiagnostic("page_mic_start_failed", {
        name: err?.name,
        message: err?.message || String(err)
      });
      chrome.runtime.sendMessage({
        type: "START_AUDIO_CAPTURE",
        meetingSessionId,
        captureMode: state.captureMode
      }).catch(() => {
      });
    }
  }
  function stopSignalCapture(options = {}) {
    const stopAudio = options.stopAudio ?? true;
    const shouldDismissPrompt = options.dismissPrompt ?? true;
    const stoppedSessionId = state.signalCaptureSessionId;
    state.signalCaptureSessionId = null;
    stopPageMicrophoneCapture();
    if (stopAudio) {
      chrome.runtime.sendMessage({ type: "STOP_AUDIO_CAPTURE", meetingSessionId: stoppedSessionId }).catch(() => {
      });
    }
    if (state.speechObserver) {
      state.speechObserver.disconnect();
      state.speechObserver = null;
    }
    if (state.captionObserver) {
      state.captionObserver.disconnect();
      state.captionObserver = null;
    }
    if (state.diagnosticInterval) {
      clearInterval(state.diagnosticInterval);
      state.diagnosticInterval = null;
    }
    state.userSpeaking = false;
    stopMicrophoneDetection();
    if (shouldDismissPrompt) {
      dismissCurrentPrompt();
    }
  }
  function observeSpeechIndicators() {
    if (state.speechObserver) {
      state.speechObserver.disconnect();
    }
    startMicrophoneDetection();
    state.speechObserver = new MutationObserver(() => {
    });
    state.speechObserver.observe(document.body, { childList: true, subtree: false });
  }
  var recognition = null;
  var recognitionShouldRun = false;
  function stopMicrophoneDetection() {
    recognitionShouldRun = false;
    if (!recognition) return;
    try {
      recognition.onend = null;
      recognition.stop?.();
      recognition.abort?.();
    } catch (_err) {
    }
    recognition = null;
  }
  function startMicrophoneDetection() {
    const SpeechRecognition = window.SpeechRecognition || window.webkitSpeechRecognition;
    if (!SpeechRecognition) {
      console.warn("[Evolvio] SpeechRecognition not available");
      sendCaptureDiagnostic("speech_recognition_unavailable");
      return;
    }
    stopMicrophoneDetection();
    recognitionShouldRun = true;
    function startRecognition() {
      if (!recognitionShouldRun) return;
      recognition = new SpeechRecognition();
      recognition.continuous = true;
      recognition.interimResults = true;
      recognition.lang = "en-US";
      recognition.onstart = () => {
        console.log("[Evolvio] Speech recognition active");
        sendCaptureDiagnostic("speech_recognition_started");
      };
      recognition.onspeechstart = () => {
        const now = Date.now();
        if (!state.userSpeaking && now - state.lastSpeechEmitMs > SPEECH_THROTTLE_MS) {
          state.userSpeaking = true;
          state.lastSpeechEmitMs = now;
          emitEvent("speech_started", { speaker: "user", offset_ms: now }, 0.9);
        }
      };
      recognition.onspeechend = () => {
        const now = Date.now();
        if (state.userSpeaking) {
          state.userSpeaking = false;
          state.lastSpeechEmitMs = now;
          emitEvent("speech_ended", { speaker: "user", offset_ms: now }, 0.9);
        }
      };
      recognition.onresult = (event) => {
        for (let i = event.resultIndex; i < event.results.length; i++) {
          const result = event.results[i];
          const text = result[0].transcript.trim();
          if (!text) continue;
          if (result.isFinal && !isWhisperRecentlyActive()) {
            emitTranscriptSegment(text, "user", "web_speech", 0.9);
          }
        }
      };
      recognition.onerror = (event) => {
        if (event.error === "no-speech") return;
        console.warn("[Evolvio] Speech recognition error:", event.error);
        sendCaptureDiagnostic("speech_recognition_error", { error: event.error });
        if (recognitionShouldRun && ["audio-capture", "network", "aborted"].includes(event.error)) {
          setTimeout(() => {
            try {
              startRecognition();
            } catch (e) {
            }
          }, 1e3);
        }
      };
      recognition.onend = () => {
        if (!recognitionShouldRun) return;
        setTimeout(() => {
          try {
            startRecognition();
          } catch (e) {
            setTimeout(() => {
              try {
                startRecognition();
              } catch (_) {
              }
            }, 3e3);
          }
        }, 1e3);
      };
      try {
        recognition.start();
      } catch (e) {
        console.warn("[Evolvio] Could not start speech recognition:", e);
        sendCaptureDiagnostic("speech_recognition_start_failed", { message: e?.message || String(e) });
      }
    }
    startRecognition();
  }
  function observeCaptions() {
    if (state.captionObserver) {
      state.captionObserver.disconnect();
    }
    state.captionObserver = new MutationObserver(() => {
      refreshSelfIdentityHints();
      const seen = /* @__PURE__ */ new Set();
      for (const selector of CAPTION_SELECTORS) {
        try {
          document.querySelectorAll(selector).forEach((el) => seen.add(el));
        } catch (e) {
        }
      }
      for (const el of seen) {
        const text = el.textContent?.trim();
        if (!text || text.length < 10 || el.getAttribute("data-evolvio-captured")) continue;
        if (/^[A-Z][a-zA-Z\s,]+\([A-Z][a-zA-Z\s]+\)$/.test(text)) continue;
        const wordCount = text.split(/\s+/).filter((w) => w.length > 0).length;
        if (wordCount < 5) continue;
        el.setAttribute("data-evolvio-captured", "1");
        const isSelf = isLikelySelfCaption(el);
        const speaker = isSelf ? "user" : "other";
        if (state.captureMode === "user_voice_only" && !isSelf) {
          continue;
        }
        console.log(`[Evolvio] Caption captured (${speaker}): ${text.slice(0, 80)}`);
        emitTranscriptSegment(text, speaker, "caption", 0.3);
      }
    });
    state.captionObserver.observe(document.body, {
      childList: true,
      subtree: true,
      characterData: true
    });
  }
  function emitEvent(eventType, payload, captureConfidence = null) {
    if (!state.meetingSessionId || !state.userId || !state.platform) return;
    state.eventsEmitted++;
    const event = createEvent(
      state.meetingSessionId,
      state.userId,
      state.platform,
      eventType,
      payload,
      captureConfidence
    );
    chrome.runtime.sendMessage({ type: "INGEST_EVENT", event }).catch(() => {
    });
  }
  function emitTranscriptSegment(text, candidateSpeaker, source, captureConfidence, timing) {
    const eventTimeMs = timing?.eventTimeMs ?? Date.now();
    const endOffsetMs = timing?.endOffsetMs ?? eventTimeMs;
    const startOffsetMs = timing?.startOffsetMs ?? endOffsetMs;
    const payload = transcriptAttribution.classifySegment({
      text,
      source,
      candidateSpeaker,
      timestampMs: eventTimeMs,
      startOffsetMs,
      endOffsetMs
    });
    if (!payload) return;
    emitEvent("transcript_segment", payload, captureConfidence);
  }
  var lastWhisperTranscriptAt = 0;
  function markWhisperActive() {
    lastWhisperTranscriptAt = Date.now();
  }
  function isWhisperRecentlyActive() {
    return Date.now() - lastWhisperTranscriptAt < 3e4;
  }
  var EVOLVIO_UI_HOST_ID = "gleameet-ui-host";
  function getUiRoot() {
    let host = document.getElementById(EVOLVIO_UI_HOST_ID);
    if (!host) {
      host = document.createElement("div");
      host.id = EVOLVIO_UI_HOST_ID;
      host.style.all = "initial";
      host.style.position = "fixed";
      host.style.inset = "0";
      host.style.pointerEvents = "none";
      host.style.zIndex = "2147483647";
      (document.documentElement || document.body).appendChild(host);
    }
    const root = host.shadowRoot ?? host.attachShadow({ mode: "open" });
    if (!root.getElementById("gleameet-ui-style")) {
      const style = document.createElement("style");
      style.id = "gleameet-ui-style";
      style.textContent = `
      :host { all: initial; }
      #gleameet-overlay {
        position: fixed;
        right: 24px;
        bottom: 24px;
        z-index: 2147483647;
        pointer-events: none;
        font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif;
      }
      #gleameet-overlay * { pointer-events: auto; box-sizing: border-box; }
      .gleameet-prompt {
        background: rgba(255, 255, 255, 0.96);
        color: #1a1a2e;
        border: 1px solid rgba(0, 102, 204, 0.2);
        border-radius: 12px;
        padding: 14px 18px;
        max-width: 320px;
        box-shadow: 0 4px 24px rgba(0, 0, 0, 0.18);
        backdrop-filter: blur(12px);
        animation: gleameet-slide-in 0.3s ease-out;
        margin-top: 8px;
      }
      .gleameet-prompt-header {
        display: flex;
        justify-content: space-between;
        align-items: center;
        gap: 8px;
        margin-bottom: 6px;
      }
      .gleameet-prompt-label {
        font-size: 10px;
        font-weight: 600;
        text-transform: uppercase;
        letter-spacing: 0.5px;
        color: #0066cc;
      }
      .gleameet-prompt-law-code {
        font-size: 10px;
        font-weight: 700;
        font-family: "SF Mono", Menlo, Consolas, monospace;
        color: #ffffff;
        background: #0066cc;
        border-radius: 4px;
        padding: 1px 6px;
        letter-spacing: 0.3px;
        flex-shrink: 0;
      }
      .gleameet-prompt-dismiss {
        appearance: none;
        border: none;
        background: transparent;
        color: #8b8ba0;
        cursor: pointer;
        font-size: 16px;
        line-height: 1;
        padding: 0 2px;
      }
      .gleameet-prompt-text {
        font-size: 15px;
        font-weight: 600;
        line-height: 1.35;
        margin-bottom: 4px;
      }
      .gleameet-prompt-rationale {
        font-size: 12px;
        color: #6b6b80;
        line-height: 1.3;
      }
      .gleameet-status {
        position: fixed;
        top: 12px;
        right: 12px;
        display: flex;
        align-items: center;
        gap: 6px;
        padding: 4px 10px;
        border-radius: 16px;
        font: 500 11px -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif;
        color: #1a1a2e;
        background: rgba(255, 255, 255, 0.92);
        backdrop-filter: blur(8px);
        box-shadow: 0 2px 8px rgba(0, 0, 0, 0.12);
      }
      .gleameet-status-dot {
        width: 6px;
        height: 6px;
        border-radius: 50%;
      }
      .gleameet-status.active .gleameet-status-dot { background: #00804a; }
      .gleameet-status.muted .gleameet-status-dot { background: #cc7a00; }
      .gleameet-status.ready .gleameet-status-dot { background: #0066cc; }
      .gleameet-status.error .gleameet-status-dot { background: #cc0000; }
      @keyframes gleameet-slide-in {
        from { opacity: 0; transform: translateY(12px); }
        to { opacity: 1; transform: translateY(0); }
      }
    `;
      root.appendChild(style);
    }
    return root;
  }
  function createOverlay() {
    const root = getUiRoot();
    let overlay = root.getElementById("gleameet-overlay");
    if (!overlay) {
      overlay = document.createElement("div");
      overlay.id = "gleameet-overlay";
      root.appendChild(overlay);
    }
    return overlay;
  }
  function removeOverlay() {
    const overlay = getUiRoot().getElementById("gleameet-overlay");
    if (overlay) overlay.remove();
  }
  function showPrompt(prompt) {
    dismissCurrentPrompt();
    state.currentPrompt = prompt;
    const overlay = createOverlay();
    const promptEl = document.createElement("div");
    promptEl.className = "gleameet-prompt";
    promptEl.setAttribute("data-prompt-id", prompt.prompt_id);
    const header = document.createElement("div");
    header.className = "gleameet-prompt-header";
    const label = document.createElement("span");
    label.className = "gleameet-prompt-label";
    label.textContent = `Coach \xB7 ${prompt.prompt_type}`;
    const lawCode = document.createElement("span");
    lawCode.className = "gleameet-prompt-law-code";
    lawCode.textContent = prompt.law_id;
    lawCode.title = `Law: ${prompt.law_id}`;
    const dismissBtn = document.createElement("button");
    dismissBtn.className = "gleameet-prompt-dismiss";
    dismissBtn.textContent = "\xD7";
    dismissBtn.title = "Dismiss";
    dismissBtn.addEventListener("click", () => dismissPrompt(prompt.prompt_id));
    header.appendChild(label);
    header.appendChild(lawCode);
    header.appendChild(dismissBtn);
    const text = document.createElement("div");
    text.className = "gleameet-prompt-text";
    text.textContent = prompt.short_text;
    promptEl.appendChild(header);
    promptEl.appendChild(text);
    if (prompt.rationale_text) {
      const rationale = document.createElement("div");
      rationale.className = "gleameet-prompt-rationale";
      rationale.textContent = prompt.rationale_text;
      promptEl.appendChild(rationale);
    }
    overlay.innerHTML = "";
    overlay.appendChild(promptEl);
    ackPrompt(prompt.prompt_id, "shown");
    state.promptDismissTimer = setTimeout(() => {
      dismissPrompt(prompt.prompt_id);
    }, 15e3);
  }
  function dismissCurrentPrompt() {
    if (state.currentPrompt) {
      dismissPrompt(state.currentPrompt.prompt_id);
    }
  }
  function dismissPrompt(promptId) {
    const overlay = getUiRoot().getElementById("gleameet-overlay");
    if (overlay) {
      const el = overlay.querySelector(`[data-prompt-id="${promptId}"]`);
      if (el) el.remove();
    }
    if (state.promptDismissTimer) {
      clearTimeout(state.promptDismissTimer);
      state.promptDismissTimer = null;
    }
    if (state.currentPrompt?.prompt_id === promptId) {
      ackPrompt(promptId, "dismissed");
      state.currentPrompt = null;
    }
  }
  function ackPrompt(promptId, action) {
    chrome.runtime.sendMessage({
      type: "ACK_PROMPT",
      promptId,
      meetingSessionId: state.meetingSessionId,
      action
    }).catch(() => {
    });
  }
  function injectStatusIndicator() {
    removeStatusIndicator();
    const root = getUiRoot();
    const indicator = document.createElement("div");
    indicator.id = "gleameet-status";
    indicator.className = `gleameet-status ${state.status}`;
    const dot = document.createElement("span");
    dot.className = "gleameet-status-dot";
    const label = document.createElement("span");
    label.textContent = `Evolvio: ${state.status}`;
    indicator.appendChild(dot);
    indicator.appendChild(label);
    root.appendChild(indicator);
  }
  function removeStatusIndicator() {
    const indicator = getUiRoot().getElementById("gleameet-status");
    if (indicator) indicator.remove();
  }
  function updateStatusIndicator() {
    const indicator = getUiRoot().getElementById("gleameet-status");
    if (indicator) {
      indicator.className = `gleameet-status ${state.status}`;
      const label = indicator.querySelector("span:last-child");
      if (label) label.textContent = `Evolvio: ${state.status}`;
    }
  }
  chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
    switch (message.type) {
      case "STATUS_UPDATE": {
        const previousStatus = state.status;
        if (shouldIgnoreStaleStatusDowngrade(message)) {
          state.meetingDetected = true;
          state.status = state.promptsMutedByUser ? "muted" : "active";
          state.platform = state.platform ?? message.platform ?? getPlatform();
          updateStatusIndicator();
          sendCoachingActiveHeartbeat();
          break;
        }
        const explicitTeardown = isExplicitTeardownReason(message.statusReason);
        const incomingMuted = message.status === "muted" && message.promptsMutedByUser === true;
        state.status = incomingMuted ? "muted" : message.status === "muted" ? "active" : message.status;
        state.promptsMutedByUser = incomingMuted;
        state.meetingDetected = message.meetingDetected ?? state.meetingDetected;
        if (message.meetingSessionId || explicitTeardown) {
          state.meetingSessionId = message.meetingSessionId ?? null;
        }
        state.platform = message.platform ?? state.platform ?? getPlatform();
        state.captureMode = resolveCaptureMode(message.captureMode, state.captureMode);
        updateStatusIndicator();
        if ((previousStatus === "active" || previousStatus === "muted") && (state.status === "ready" || state.status === "off" || state.status === "error") && explicitTeardown) {
          stopSignalCapture();
        }
        break;
      }
      case "SHOW_PROMPT":
        if (message.meetingSessionId) {
          state.meetingSessionId = message.meetingSessionId;
        }
        if (message.userId) {
          state.userId = message.userId;
        }
        state.platform = message.platform ?? state.platform ?? getPlatform();
        state.captureMode = resolveCaptureMode(message.captureMode, state.captureMode);
        if (!state.promptsMutedByUser && (state.meetingSessionId || detectMeeting() || shouldTrustLikelyMeetingUrl())) {
          state.meetingDetected = true;
          if (state.status !== "active") {
            state.status = "active";
            updateStatusIndicator();
          }
          chrome.runtime.sendMessage({
            type: "COACHING_ACTIVE",
            meetingSessionId: state.meetingSessionId,
            userId: state.userId,
            platform: state.platform ?? getPlatform(),
            captureMode: state.captureMode
          }).catch(() => {
          });
          showPrompt(message.prompt);
        } else if (!detectMeeting() && !shouldTrustLikelyMeetingUrl()) {
          dismissCurrentPrompt();
        }
        break;
      case "COACHING_STARTED":
        if (message.forceRestartCapture && state.signalCaptureSessionId === message.meetingSessionId) {
          stopSignalCapture({ stopAudio: false, dismissPrompt: false });
        } else if (state.signalCaptureSessionId && state.signalCaptureSessionId !== message.meetingSessionId) {
          stopSignalCapture();
        }
        state.meetingSessionId = message.meetingSessionId;
        state.userId = message.userId;
        state.platform = message.platform ?? getPlatform();
        state.captureMode = resolveCaptureMode(message.captureMode);
        state.status = "active";
        state.promptsMutedByUser = false;
        state.meetingDetected = true;
        updateStatusIndicator();
        startSignalCapture();
        break;
      case "COACHING_PAUSED":
        if (!message.meetingSessionId || message.meetingSessionId === state.meetingSessionId) {
          state.status = "ready";
          updateStatusIndicator();
          stopSignalCapture();
        }
        break;
      case "WHISPER_ACTIVE":
        markWhisperActive();
        break;
      case "AUDIO_TRANSCRIPT_RESULT": {
        const stream = message.stream;
        if (state.captureMode === "user_voice_only" && stream !== "mic") {
          break;
        }
        markWhisperActive();
        const candidateSpeaker = stream === "mic" ? "user" : state.platform === "google_meet" && state.userSpeaking ? "user" : "other";
        emitTranscriptSegment(
          message.text || "",
          candidateSpeaker,
          stream,
          stream === "mic" ? 0.85 : candidateSpeaker === "user" ? 0.8 : 0.75,
          {
            startOffsetMs: message.startOffsetMs,
            endOffsetMs: message.endOffsetMs,
            eventTimeMs: message.eventTimeMs
          }
        );
        break;
      }
      case "DISMISS_ALL_PROMPTS":
        dismissCurrentPrompt();
        break;
      case "GET_CONTENT_STATUS":
        if (!state.meetingDetected && shouldRediscoverMeetingFromUrl()) {
          onMeetingDetected();
        }
        sendResponse({
          meetingDetected: state.meetingDetected || detectMeeting() || shouldTrustLikelyMeetingUrl() || shouldRediscoverMeetingFromUrl(),
          platform: state.platform ?? getPlatform(),
          status: state.status,
          meetingSessionId: state.meetingSessionId,
          userId: state.userId,
          captureMode: state.captureMode,
          promptsMutedByUser: state.promptsMutedByUser
        });
        return true;
    }
    sendResponse({ ok: true });
    return true;
  });
  function showConsentDialog() {
    return new Promise((resolve) => {
      const backdrop = document.createElement("div");
      backdrop.id = "gleameet-consent-backdrop";
      backdrop.style.cssText = `
      position: fixed; inset: 0; z-index: 2147483647;
      background: rgba(0,0,0,0.5); display: flex;
      align-items: center; justify-content: center;
    `;
      const dialog = document.createElement("div");
      dialog.style.cssText = `
      background: white; border-radius: 12px; padding: 24px;
      max-width: 420px; width: 90%; font-family: -apple-system, BlinkMacSystemFont, sans-serif;
      box-shadow: 0 8px 32px rgba(0,0,0,0.2);
    `;
      dialog.innerHTML = `
      <h2 style="margin: 0 0 12px; font-size: 18px; color: #1a1a2e;">Enable Meeting Coach</h2>
      <p style="margin: 0 0 8px; font-size: 13px; color: #6b6b80; line-height: 1.5;">
        Evolvio will privately coach you during this meeting. By enabling:
      </p>
      <ul style="margin: 0 0 16px; padding-left: 20px; font-size: 13px; color: #6b6b80; line-height: 1.6;">
        <li>Coaching is <strong>private to you only</strong></li>
        <li>Meeting timing and conversation signals will be captured</li>
        <li>Live prompts may appear during the meeting</li>
        <li>You can mute or stop coaching at any time</li>
        <li>You can delete meeting data after the session</li>
      </ul>
      <div style="display: flex; gap: 8px; justify-content: flex-end;">
        <button id="gleameet-consent-cancel" style="
          padding: 8px 16px; border: 1px solid #e0e0e8; border-radius: 6px;
          background: white; color: #6b6b80; cursor: pointer; font-size: 13px;
        ">Not Now</button>
        <button id="gleameet-consent-accept" style="
          padding: 8px 16px; border: none; border-radius: 6px;
          background: #0066cc; color: white; cursor: pointer; font-size: 13px; font-weight: 500;
        ">Enable Coaching</button>
      </div>
    `;
      backdrop.appendChild(dialog);
      document.body.appendChild(backdrop);
      document.getElementById("gleameet-consent-accept").addEventListener("click", () => {
        backdrop.remove();
        resolve(true);
      });
      document.getElementById("gleameet-consent-cancel").addEventListener("click", () => {
        backdrop.remove();
        resolve(false);
      });
    });
  }
  window.__gleameet_showConsent = showConsentDialog;
  startMeetingDetection();
  var lastUrl = window.location.href;
  setInterval(() => {
    if (window.location.href !== lastUrl) {
      lastUrl = window.location.href;
      state.platform = getPlatform();
    }
    const inMeeting = detectMeeting() || shouldRediscoverMeetingFromUrl();
    if (inMeeting && !state.meetingDetected) {
      cancelMeetingEndDebounce();
      onMeetingDetected();
    } else if (inMeeting) {
      cancelMeetingEndDebounce();
    } else if (!inMeeting && state.meetingDetected) {
      scheduleMeetingEndDebounce();
    }
  }, 1e3);
})();
