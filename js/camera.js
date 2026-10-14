// Handles camera access and raw frame sampling for PPG capture.

const Camera = (() => {
  let stream = null;
  let videoEl = null;
  let canvasEl = null;
  let ctx = null;

  async function start(videoElement, canvasElement) {
    videoEl = videoElement;
    canvasEl = canvasElement;
    ctx = canvasEl.getContext("2d");

    stream = await navigator.mediaDevices.getUserMedia({
      video: {
        facingMode: "environment",
        width: { ideal: 320 },
        height: { ideal: 240 },
      },
    });
    videoEl.srcObject = stream;
    await videoEl.play();

    const track = stream.getVideoTracks()[0];
    const capabilities = track.getCapabilities ? track.getCapabilities() : {};
    if (capabilities.torch) {
      await track.applyConstraints({ advanced: [{ torch: true }] });
    }

    // Lock auto-exposure and auto-white-balance once the flash is steady.
    // Both constantly re-adjust brightness/color in response to the scene,
    // which looks exactly like noise on top of the real pulse signal —
    // this is the single biggest source of camera-PPG noise per rPPG
    // implementations (e.g. yarppg), so locking them is the first fix.
    const lockable = {};
    if (capabilities.exposureMode && capabilities.exposureMode.includes("manual")) {
      lockable.exposureMode = "manual";
    }
    if (capabilities.whiteBalanceMode && capabilities.whiteBalanceMode.includes("manual")) {
      lockable.whiteBalanceMode = "manual";
    }
    if (capabilities.focusMode && capabilities.focusMode.includes("manual")) {
      lockable.focusMode = "manual";
    }
    if (Object.keys(lockable).length > 0) {
      try {
        await track.applyConstraints({ advanced: [lockable] });
      } catch {
        // Not all devices honor manual exposure/white-balance locks even
        // when they're listed as capabilities — fail silently and fall
        // back to auto mode rather than blocking capture.
      }
    }

    canvasEl.width = 64;
    canvasEl.height = 64;
  }

  function stop() {
    if (stream) {
      stream.getTracks().forEach((t) => t.stop());
      stream = null;
    }
  }

  // Returns the average green-channel intensity of the current frame center.
  function sampleFrame() {
    if (!videoEl || videoEl.readyState < 2) return null;
    ctx.drawImage(videoEl, 0, 0, canvasEl.width, canvasEl.height);
    const frame = ctx.getImageData(0, 0, canvasEl.width, canvasEl.height).data;

    let sum = 0;
    let count = 0;
    for (let i = 0; i < frame.length; i += 4) {
      sum += frame[i + 1]; // green channel
      count++;
    }
    return sum / count;
  }

  return { start, stop, sampleFrame };
})();
