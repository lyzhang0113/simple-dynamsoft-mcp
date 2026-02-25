const ragLogState = {
  config: false,
  providerChain: false,
  localEmbedderInit: false,
  providerReady: new Set(),
  providerFirstUse: new Set(),
  fallbackUse: new Set()
};

function logRag(message) {
  console.error(`[rag] ${message}`);
}

function logRagConfigOnce(ragConfig) {
  if (ragLogState.config) return;
  ragLogState.config = true;
  logRag(
    `config provider=${ragConfig.provider} fallback=${ragConfig.fallback} prewarm=${ragConfig.prewarm} rebuild=${ragConfig.rebuild} ` +
    `cache_dir=${ragConfig.cacheDir} prebuilt_auto_download=${ragConfig.prebuiltIndexAutoDownload} ` +
    `prebuilt_url_override=${ragConfig.prebuiltIndexUrl ? "set" : "empty"} prebuilt_url_local=${ragConfig.prebuiltIndexUrlLocal ? "set" : "empty"} ` +
    `prebuilt_url_gemini=${ragConfig.prebuiltIndexUrlGemini ? "set" : "empty"} ` +
    `prebuilt_timeout_ms=${ragConfig.prebuiltIndexTimeoutMs} gemini_retry_max_attempts=${ragConfig.geminiRetryMaxAttempts} ` +
    `gemini_retry_base_delay_ms=${ragConfig.geminiRetryBaseDelayMs} gemini_retry_max_delay_ms=${ragConfig.geminiRetryMaxDelayMs} ` +
    `gemini_request_throttle_ms=${ragConfig.geminiRequestThrottleMs}`
  );
}

function logProviderChainOnce(providers) {
  if (ragLogState.providerChain) return;
  ragLogState.providerChain = true;
  logRag(`provider chain=${providers.join(" -> ")}`);
}

function logProviderReadyOnce(name) {
  if (ragLogState.providerReady.has(name)) return;
  ragLogState.providerReady.add(name);
  logRag(`provider ready name=${name}`);
}

function logProviderSelectedOnce(name) {
  if (ragLogState.providerFirstUse.has(name)) return;
  ragLogState.providerFirstUse.add(name);
  logRag(`provider selected name=${name}`);
}

function logFallbackSelectedOnce(name, primary) {
  if (ragLogState.fallbackUse.has(name)) return;
  ragLogState.fallbackUse.add(name);
  logRag(`fallback engaged selected=${name} primary=${primary}`);
}

function markLocalEmbedderInit() {
  if (ragLogState.localEmbedderInit) return false;
  ragLogState.localEmbedderInit = true;
  return true;
}

export {
  logRag,
  logRagConfigOnce,
  logProviderChainOnce,
  logProviderReadyOnce,
  logProviderSelectedOnce,
  logFallbackSelectedOnce,
  markLocalEmbedderInit
};
