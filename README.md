# GleaMeet Extension

Chrome extension for private real-time behavioral coaching during Zoom web, Google Meet, and Microsoft Teams web meetings.

Latest public build: **v1.0.80**

- Latest download: [gleameet-extension.zip](https://github.com/rajivchandrasekaran-paintrobot/gleameet-extension/raw/main/gleameet-extension.zip)
- Versioned download: [gleameet-extension-1.0.80.zip](https://github.com/rajivchandrasekaran-paintrobot/gleameet-extension/raw/main/gleameet-extension-1.0.80.zip)

## Installation

1. Download [gleameet-extension.zip](https://github.com/rajivchandrasekaran-paintrobot/gleameet-extension/raw/main/gleameet-extension.zip)
2. Unzip the file
3. Open Chrome and go to `chrome://extensions`
4. Enable **Developer mode** using the top-right toggle
5. Click **Load unpacked**
6. Select the `public` folder inside the unzipped download
7. Pin the GleaMeet extension from Chrome's puzzle-piece extensions menu

If you are updating an existing install, remove or reload the old GleaMeet extension in `chrome://extensions`, then load the new `public` folder.

## How To Use

1. Open a supported meeting in Chrome:
   - Zoom web: `zoom.us/wc/...` or `app.zoom.us/wc/...`
   - Google Meet: `meet.google.com/...`
   - Microsoft Teams web: `teams.microsoft.com/...`
2. Click the GleaMeet extension icon.
3. Sign in with Google when prompted.
4. Optional: turn on **Use only my voice** before starting coaching if you do not want GleaMeet to use other participants' audio or captions.
5. Click **Start Coaching**.
6. Coaching prompts appear privately on your meeting page. Other participants cannot see them.
7. Use **Stop Coaching** to pause coaching while keeping the meeting open.
8. Use **End Meeting** when you want GleaMeet to generate the post-meeting report.

## Privacy Modes

GleaMeet supports two capture modes:

- **Full meeting**: uses your microphone plus available meeting audio/captions so prompts can consider the broader conversation.
- **Use only my voice**: uses only your own microphone input for coaching prompts. Other participants are not recorded or used for prompt generation in this mode.

The capture mode is selected in the popup before starting coaching.

## Supported Platforms

| Platform | Status |
| --- | --- |
| Zoom web client | Supported |
| Google Meet | Supported |
| Microsoft Teams web | Supported |

Desktop Zoom and desktop Teams are not the primary target for this extension build. Use the browser/web meeting versions.

## Recent Changes

### v1.0.80

- Added a long-session audio capture watchdog.
- If mic or tab capture stops, errors, or loses its live audio track during active coaching, GleaMeet now asks the background worker to restart capture for the same meeting.
- This targets cases where prompts work early in a long call and then stop because transcription quietly stopped.

### v1.0.79

- Added a popup reload control for recovery when Chrome's extension service worker gets stale.
- Added a small reload button in the popup header.
- Added a larger **Reload Extension** button in the **Not in a meeting** state.
- The reload button calls Chrome's real extension reload path, not just a UI refresh.

### v1.0.78

- Persisted the last ready meeting context separately from the active coaching session.
- Helps GleaMeet stay ready after ending coaching or ending the GleaMeet report session while the actual Zoom, Meet, or Teams call remains open.
- Restores ready meeting state after the popup closes/reopens or the Manifest V3 background worker restarts.

### v1.0.74-v1.0.77

- Improved stop/resume coaching behavior so capture restarts cleanly after pausing.
- Hardened prompt delivery so generated prompts are not lost before the frontend acknowledges them.
- Prevented stale popup/background status from shutting down active transcription or prompt capture.
- Kept the meeting available for restart after ending the GleaMeet coaching session while the browser meeting is still active.

### Earlier July 2026 fixes

- Improved Zoom web meeting detection for `app.zoom.us/wc/.../join` URLs.
- Added `tabs` and `scripting` permissions so the extension can reliably rediscover already-open meeting tabs after reload.
- Improved Google Meet and Teams detection.
- Added retry/ack behavior for live prompt delivery.
- Added the **Use only my voice** privacy option.

## Troubleshooting

If the popup says **Not in a meeting** while a supported browser meeting is clearly open:

1. Make sure the meeting is open in Chrome, not only the desktop app.
2. Click **Reload Extension** in the GleaMeet popup.
3. Reopen the popup from Chrome's puzzle-piece extensions menu.
4. If needed, go to `chrome://extensions`, click reload on GleaMeet, then reopen the meeting tab.

If prompts stop showing:

1. Confirm the popup says **Active** or **Ready**.
2. Stop Coaching, then Start Coaching again.
3. If that does not recover, click **Reload Extension** and start coaching again.
