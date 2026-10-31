(async () => {
  const token = document.querySelector('meta[name="analytics-event-token"]')?.content;
  if (!token) return;

  // A person touches, clicks, types, scrolls with a wheel or moves a pointer; page loads alone
  // are mostly crawlers. Only the first trusted interaction is reported, while the token lasts.
  const interacted = new Promise(resolve => {
    const kinds = ['pointerdown', 'pointermove', 'keydown', 'touchstart', 'wheel'];
    const options = { capture: true, passive: true };
    let expiry;
    const stop = () => {
      clearTimeout(expiry);
      for (const kind of kinds) removeEventListener(kind, listener, options);
    };
    const listener = event => {
      if (!event.isTrusted) return;
      if (event.type === 'pointermove' && !event.movementX && !event.movementY) return;
      stop();
      resolve(true);
    };
    expiry = setTimeout(() => {
      stop();
      resolve(false);
    }, 9 * 60_000);
    for (const kind of kinds) addEventListener(kind, listener, options);
  });

  const context = {
    screen: {
      width: screen.width,
      height: screen.height,
      availWidth: screen.availWidth,
      availHeight: screen.availHeight,
      colorDepth: screen.colorDepth,
      pixelDepth: screen.pixelDepth
    },
    viewport: { width: window.innerWidth, height: window.innerHeight },
    devicePixelRatio: window.devicePixelRatio,
    language: navigator.language,
    languages: Array.from(navigator.languages || []),
    timezone: Intl.DateTimeFormat().resolvedOptions().timeZone,
    hardwareConcurrency: navigator.hardwareConcurrency,
    deviceMemory: navigator.deviceMemory,
    maxTouchPoints: navigator.maxTouchPoints
  };

  if (navigator.connection) {
    context.network = {
      effectiveType: navigator.connection.effectiveType,
      downlink: navigator.connection.downlink,
      rtt: navigator.connection.rtt,
      saveData: navigator.connection.saveData
    };
  }

  if (navigator.userAgentData) {
    context.userAgentData = {
      brands: navigator.userAgentData.brands,
      mobile: navigator.userAgentData.mobile,
      platform: navigator.userAgentData.platform
    };
    if (typeof navigator.userAgentData.getHighEntropyValues === 'function') {
      try {
        const highEntropyKeys = [
          'architecture', 'bitness', 'formFactors', 'fullVersionList', 'model',
          'platformVersion', 'uaFullVersion', 'wow64'
        ];
        const browserValues = await navigator.userAgentData.getHighEntropyValues(highEntropyKeys);
        context.userAgentData.highEntropy = {};
        for (const key of highEntropyKeys) {
          if (Object.prototype.hasOwnProperty.call(browserValues, key)) {
            context.userAgentData.highEntropy[key] = browserValues[key];
          }
        }
      } catch {
        // Browser declined optional high-entropy values; base context remains valid.
      }
    }
  }

  async function send(body) {
    const retrySchedule = [0, 1000, 2000, 4000, 8000];
    let waitMs = 0;
    for (let attempt = 0; attempt < retrySchedule.length; attempt += 1) {
      if (waitMs > 0) await new Promise(resolve => setTimeout(resolve, waitMs));
      let response;
      try {
        response = await fetch('/api/analytics/client-context', {
          method: 'POST',
          credentials: 'omit',
          keepalive: true,
          headers: {
            'Content-Type': 'application/json',
            'X-Analytics-Event-Token': token
          },
          body: JSON.stringify(body)
        });
      } catch {
        return false;
      }
      if (response.status !== 425) return response.ok;
      const retryAfter = Number(response.headers.get('Retry-After'));
      const serverDelay = Number.isFinite(retryAfter) && retryAfter > 0 ? retryAfter * 1000 : 0;
      waitMs = Math.max(retrySchedule[attempt + 1] || 0, serverDelay);
    }
    return false;
  }

  if (!(await send({ context }))) return;
  if (!(await interacted)) return;
  await send({ context, interaction: { webdriver: navigator.webdriver === true } });
})().catch(() => {});
