(async () => {
  const token = document.querySelector('meta[name="analytics-event-token"]')?.content;
  if (!token) return;

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
        body: JSON.stringify({ context })
      });
    } catch {
      return;
    }
    if (response.status !== 425) return;
    const retryAfter = Number(response.headers.get('Retry-After'));
    const serverDelay = Number.isFinite(retryAfter) && retryAfter > 0 ? retryAfter * 1000 : 0;
    waitMs = Math.max(retrySchedule[attempt + 1] || 0, serverDelay);
  }
})().catch(() => {});
