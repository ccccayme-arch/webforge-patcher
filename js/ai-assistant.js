// WebForge Patcher — AI Assistant (Groq-powered)
// Uses Groq's fast LLM inference for:
// 1. Smart device detection & patching strategy recommendation
// 2. Error diagnosis when flashing fails
// 3. Boot image analysis and compatibility checking
// 4. Interactive chat with device-specific rooting knowledge
//
// Includes offline fallback knowledge base for common scenarios.
// Groq API: https://console.groq.com/docs
// Model: llama-3.3-70b-versatile (fast, capable, good for structured output)

import { Utils } from './utils.js';

const GROQ_API_URL = 'https://api.groq.com/openai/v1/chat/completions';
const GROQ_MODEL = 'llama-3.3-70b-versatile';

// ============================================================
// Local Knowledge Base (offline fallback, no API needed)
// ============================================================

// Brand-specific rooting knowledge
const BRAND_KNOWLEDGE = {
  google: {
    name: 'Google Pixel',
    unlockMethod: 'fastboot flashing unlock',
    unlockNotes: 'Pixel devices have the easiest unlock process. Run "fastboot flashing unlock" and confirm on device screen. This wipes all data.',
    bootMethod: 'init_boot',
    initBootNote: 'Pixel 8+ and Android 13+ use init_boot for ramdisk. Flash patched init_boot, not boot.',
    knownIssues: ['Pixel 6/7 may need both boot and vendor_boot patched on older firmware'],
    pageSizeNote: 'Pixel 8+ with Android 15 may use 16KB pages',
  },
  samsung: {
    name: 'Samsung Galaxy',
    unlockMethod: 'Not available via fastboot — use Download Mode + Odin',
    unlockNotes: 'Samsung does not support fastboot unlock. Bootloader unlock is region-dependent. US Snapdragon models (Verizon/AT&T) typically CANNOT be unlocked. International Exynos models can be unlocked via Download Mode.',
    bootMethod: 'vendor_boot',
    initBootNote: 'Samsung uses Odin protocol, not fastboot. Flash .tar.md5 files via WebOdin tab.',
    knownIssues: [
      'US carrier models (S23/S24/S25) usually have locked bootloaders — Knox void',
      'Knox tripped permanently after rooting — voids warranty',
      'Samsung uses vendor_boot for ramdisk on Android 13+',
    ],
    pageSizeNote: 'Galaxy S24+ with One UI 6.1+ may use 16KB pages',
  },
  oneplus: {
    name: 'OnePlus',
    unlockMethod: 'fastboot oem unlock',
    unlockNotes: 'OnePlus allows easy bootloader unlock via "fastboot oem unlock". Confirm on device. Wipes data.',
    bootMethod: 'boot',
    initBootNote: 'OnePlus 11+ with Android 13+ may use init_boot. Check getvar partition-type:init_boot.',
    knownIssues: ['OnePlus 12 may need both boot and vendor_boot patched'],
    pageSizeNote: 'OnePlus 12 with Android 15 may use 16KB pages',
  },
  xiaomi: {
    name: 'Xiaomi',
    unlockMethod: 'Mi Unlock Tool (PC required)',
    unlockNotes: 'Xiaomi requires the Mi Unlock desktop tool and a 7-day (168 hour) waiting period after requesting unlock. Account binding required in Developer Options. Cannot unlock via fastboot alone.',
    bootMethod: 'boot',
    initBootNote: 'Xiaomi 13+ with HyperOS/Android 14+ may use init_boot.',
    knownIssues: [
      '7-day unlock wait period — plan ahead',
      'HyperOS may add additional root detection',
      'Some Xiaomi devices have anti-rollback (ARB) — do NOT downgrade',
    ],
    pageSizeNote: 'Xiaomi 14 with HyperOS 2 may use 16KB pages',
  },
  motorola: {
    name: 'Motorola',
    unlockMethod: 'Motorola Bootloader Unlock (website)',
    unlockNotes: 'Motorola requires an unlock key from https://en-us.support.motorola.com/app/standalone/bootloader/unlock-your-device-a. Submit device ID, receive key via email, then "fastboot oem unlock UNIQUE_KEY".',
    bootMethod: 'boot',
    initBootNote: 'Motorola Edge 40+ may use init_boot on Android 14+.',
    knownIssues: ['Motorola unlock key process takes 24-48 hours via email'],
    pageSizeNote: 'Standard 4KB pages on most Motorola devices',
  },
  nothing: {
    name: 'Nothing',
    unlockMethod: 'fastboot flashing unlock',
    unlockNotes: 'Nothing Phone supports standard fastboot unlock. Run "fastboot flashing unlock" and confirm on device.',
    bootMethod: 'boot',
    initBootNote: 'Nothing Phone 2+ with Android 14+ may use init_boot.',
    knownIssues: ['Nothing OS is relatively stock Android — rooting usually straightforward'],
    pageSizeNote: 'Standard 4KB pages',
  },
  sony: {
    name: 'Sony Xperia',
    unlockMethod: 'Sony Bootloader Unlock (website)',
    unlockNotes: 'Sony requires an unlock key from https://developer.sonymobile.com/unlockbootloader/. Submit IMEI, receive key, then "fastboot oem unlock KEY". Some carrier models cannot be unlocked.',
    bootMethod: 'boot',
    initBootNote: 'Xperia 1 V+ may use init_boot on Android 14+.',
    knownIssues: [
      'Sony unlock process requires IMEI submission',
      'Some region-locked models cannot be unlocked',
      'Camera apps may break after rooting (DRM keys lost)',
    ],
    pageSizeNote: 'Standard 4KB pages',
  },
  fairphone: {
    name: 'Fairphone',
    unlockMethod: 'fastboot flashing unlock',
    unlockNotes: 'Fairphone has the most open policy — bootloader unlock is straightforward via "fastboot flashing unlock". No special tools needed.',
    bootMethod: 'boot',
    initBootNote: 'Fairphone 5 with Android 13+ uses init_boot.',
    knownIssues: ['Fairphone is very rooter-friendly with minimal issues'],
    pageSizeNote: 'Fairphone 5 may use 16KB pages with Android 15',
  },
  asus: {
    name: 'ASUS',
    unlockMethod: 'ASUS Unlock Tool (device-specific)',
    unlockNotes: 'ASUS requires an unlock app or tool depending on model. Zenfone: download ASUS Unlock Tool. ROG Phone: may need official unlock file. Check ASUS support site.',
    bootMethod: 'boot',
    initBootNote: 'Zenfone 11 with Android 14+ may use init_boot.',
    knownIssues: [
      'ASUS unlock process varies by model — check support site',
      'Zenfone 10 had unlock tool discontinued then reinstated',
    ],
    pageSizeNote: 'Standard 4KB pages',
  },
};

// Common error patterns for instant local diagnosis
const ERROR_PATTERNS = [
  {
    match: /No (Fastboot|Odin) interface found/i,
    diagnosis: 'Device is not in the correct mode for USB communication.',
    fixes: [
      'Ensure device is powered off',
      'Press and hold Volume Down + Power to enter Fastboot mode',
      'For Samsung: Volume Down + Bixby + Power for Download Mode',
      'Confirm USB cable is data-capable (not charge-only)',
      'Try a different USB port or cable',
    ],
    severity: 'medium',
  },
  {
    match: /No device selected/i,
    diagnosis: 'User cancelled the device selection dialog or no device was detected.',
    fixes: [
      'Click the Connect button again',
      'Ensure the device is connected via USB',
      'Check that the device is in Fastboot/Download mode',
      'Try reconnecting the USB cable',
    ],
    severity: 'low',
  },
  {
    match: /bootloader is (LOCKED|locked)/i,
    diagnosis: 'Bootloader is locked. You cannot flash patched images to a locked device.',
    fixes: [
      'Unlock the bootloader first (this wipes all data)',
      'Use the "Unlock Bootloader" button in the Flash tab',
      'For Samsung: use Download Mode + Odin instead',
      'For Xiaomi: use Mi Unlock Tool (7-day wait)',
      'For Motorola: request unlock key from Motorola website',
    ],
    severity: 'high',
  },
  {
    match: /MD5 verification FAILED/i,
    diagnosis: 'The .tar.md5 archive is corrupted or incomplete.',
    fixes: [
      'Re-download the firmware file',
      'Verify the file size matches the expected size',
      'Check your internet connection during download',
      'Try a different download source',
    ],
    severity: 'high',
  },
  {
    match: /LZ4 decompression failed/i,
    diagnosis: 'The LZ4 compressed file is corrupted or uses an unsupported format.',
    fixes: [
      'Verify the file is a valid Samsung .lz4 firmware',
      'Re-download the firmware',
      'Some older .lz4 formats may not be supported — try .tar.md5 instead',
    ],
    severity: 'medium',
  },
  {
    match: /download (size )?mismatch/i,
    diagnosis: 'The device refused the download because the size doesn\'t match what it expects.',
    fixes: [
      'The image may be too large for the device\'s max-download-size',
      'Try splitting the image or using a smaller partition',
      'Check if the image is for the correct device model',
    ],
    severity: 'high',
  },
  {
    match: /File too small to be a boot image/i,
    diagnosis: 'The loaded file is too small to be a valid Android boot image.',
    fixes: [
      'Ensure you selected a boot.img, init_boot.img, or vendor_boot.img file',
      'The file may be corrupted — try re-extracting it',
      'Some devices use .bin extension instead of .img',
    ],
    severity: 'medium',
  },
  {
    match: /Unknown boot image magic/i,
    diagnosis: 'The file does not have a valid Android boot image header.',
    fixes: [
      'This may not be a boot image — check the file type',
      'Samsung boot images in .tar.md5 should be flashed via WebOdin, not Patch tab',
      'Try extracting the boot.img from inside a .tar archive first',
    ],
    severity: 'medium',
  },
  {
    match: /USB (OUT|IN) failed/i,
    diagnosis: 'USB communication error during data transfer.',
    fixes: [
      'Try a different USB cable (use a high-quality data cable)',
      'Try a different USB port (prefer USB 2.0 over hubs)',
      'Avoid USB hubs — connect directly to the computer',
      'Reconnect the device and try again',
    ],
    severity: 'medium',
  },
  {
    match: /Groq API error/i,
    diagnosis: 'The AI assistant could not be reached.',
    fixes: [
      'Check your internet connection',
      'Verify your Groq API key is valid and has credits',
      'AI features are optional — core flashing works without AI',
    ],
    severity: 'low',
  },
  {
    match: /Flash .* failed after .* attempts/i,
    diagnosis: 'The flash operation failed repeatedly even with retry logic.',
    fixes: [
      'The device may have rejected the image — verify it\'s for the correct model',
      'Check if the bootloader is unlocked',
      'Try a different USB cable or port',
      'On Samsung devices, try Odin mode instead of Fastboot',
      'Ensure the image passes validation before flashing',
    ],
    severity: 'high',
  },
  {
    match: /Flash aborted by user/i,
    diagnosis: 'The flash operation was cancelled by the user.',
    fixes: ['Flash was aborted — no action needed. The device should be in its previous state.'],
    severity: 'low',
  },
  {
    match: /Memory|OOM|out of memory/i,
    diagnosis: 'The browser ran out of memory processing the image.',
    fixes: [
      'The image is too large for browser-based flashing',
      'Only boot/init_boot/vendor_boot/vbmeta should be flashed (max ~128MB)',
      'Do NOT attempt to flash system.img, vendor.img, or large partitions',
      'Close other browser tabs to free memory',
      'Try restarting the browser',
    ],
    severity: 'high',
  },
];

export class AIAssistant {
  constructor(apiKey) {
    this.apiKey = apiKey;
    this.conversationHistory = [];
  }

  // ============================================================
  // CORE API CALL
  // ============================================================

  async _call(messages, options = {}) {
    if (!this.apiKey) throw new Error('No Groq API key configured');

    const body = {
      model: options.model || GROQ_MODEL,
      messages,
      temperature: options.temperature ?? 0.3,
      max_tokens: options.maxTokens ?? 1000,
      response_format: options.jsonMode ? { type: 'json_object' } : undefined,
    };

    const resp = await fetch(GROQ_API_URL, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${this.apiKey}`,
      },
      body: JSON.stringify(body),
    });

    if (!resp.ok) {
      const error = await resp.text();
      throw new Error(`Groq API error (${resp.status}): ${error}`);
    }

    const data = await resp.json();
    return data.choices[0]?.message?.content || '';
  }

  /**
   * Parse JSON safely with fallback.
   */
  _safeParseJSON(text) {
    try {
      return JSON.parse(text);
    } catch (e) {
      // Try to extract JSON from markdown code blocks
      const match = text.match(/```(?:json)?\s*([\s\S]*?)```/);
      if (match) {
        try { return JSON.parse(match[1]); } catch (e2) {}
      }
      return null;
    }
  }

  // ============================================================
  // LOCAL DEVICE LOOKUP (instant, no API call)
  // ============================================================

  /**
   * Look up a device in the local codes.json database.
   * Returns brand info or null if not found.
   */
  localDeviceLookup(productName, deviceCodes = null) {
    if (!deviceCodes || !productName) return null;

    const product = productName.toLowerCase().trim();

    // Navigate the codes.json structure: { devices: { brand: { codenames: { codename: name } } } }
    const brands = deviceCodes.devices || deviceCodes;

    // Search all brands for matching codename
    for (const [brandKey, brandData] of Object.entries(brands)) {
      if (!brandData || typeof brandData !== 'object') continue;
      const codenames = brandData.codenames || {};

      // Handle dict-style codenames: { codename: "Device Name" }
      for (const [codename, deviceName] of Object.entries(codenames)) {
        const code = codename.toLowerCase();
        const name = (deviceName || '').toLowerCase();
        if (code === product || name.includes(product) ||
            product.includes(code) || product.startsWith(code)) {
          return {
            brand: brandKey,
            brandName: brandData.name || brandKey,
            deviceName,
            codename,
            ...BRAND_KNOWLEDGE[brandKey],
          };
        }
      }

      // Handle array-style devices (legacy fallback)
      if (Array.isArray(brandData.devices)) {
        for (const device of brandData.devices) {
          const codename = (device.codename || '').toLowerCase();
          const name = (device.name || '').toLowerCase();
          if (codename === product || name.includes(product) ||
              product.includes(codename) || product.startsWith(codename)) {
            return {
              brand: brandKey,
              brandName: brandData.name || brandKey,
              deviceName: device.name,
              codename: device.codename,
              ...BRAND_KNOWLEDGE[brandKey],
            };
          }
        }
      }
    }

    // Try partial brand match (e.g., "pixel" in product name)
    for (const [brandKey, brandData] of Object.entries(brands)) {
      if (!brandData || typeof brandData !== 'object') continue;
      if (product.includes(brandKey) || (brandData.name && product.includes(brandData.name.toLowerCase()))) {
        return { brand: brandKey, brandName: brandData.name, ...BRAND_KNOWLEDGE[brandKey] };
      }
    }

    return null;
  }

  // ============================================================
  // LOCAL ERROR DIAGNOSIS (instant, no API call)
  // ============================================================

  /**
   * Match an error against known patterns for instant diagnosis.
   * Returns a diagnosis object or null if no match.
   */
  localDiagnoseError(error) {
    for (const pattern of ERROR_PATTERNS) {
      if (pattern.match.test(error)) {
        return {
          diagnosis: pattern.diagnosis,
          likelyCause: pattern.diagnosis,
          fixes: pattern.fixes,
          isDeviceIssue: true,
          isBrowserIssue: false,
          severity: pattern.severity,
          source: 'local',
        };
      }
    }
    return null;
  }

  // ============================================================
  // SMART DEVICE DETECTION
  // ============================================================

  /**
   * Analyze a connected fastboot device and recommend a patching strategy.
   * First checks local database, then enhances with Groq if available.
   */
  async analyzeDevice(deviceVars, imageSummary = null, deviceCodes = null) {
    // Step 1: Instant local lookup
    const localMatch = this.localDeviceLookup(deviceVars.product, deviceCodes);
    if (localMatch) {
      Utils.log(`AI: Local match: ${localMatch.deviceName || localMatch.brandName}`);
    }

    // Step 2: Build base analysis from local knowledge
    const baseAnalysis = this._buildLocalAnalysis(deviceVars, localMatch);

    // Step 3: Enhance with Groq if API key is available
    if (this.apiKey) {
      try {
        const enhanced = await this._groqAnalyzeDevice(deviceVars, localMatch, imageSummary);
        if (enhanced) return { ...baseAnalysis, ...enhanced, localMatch: !!localMatch };
      } catch (err) {
        Utils.log(`AI: Groq enhancement failed, using local analysis: ${err.message}`, 'debug');
      }
    }

    return baseAnalysis;
  }

  _buildLocalAnalysis(deviceVars, localMatch) {
    const product = deviceVars.product || 'unknown';
    const isUnlocked = deviceVars.unlocked === 'yes';
    const isSecure = deviceVars.secure === 'yes';
    const hasInitBoot = deviceVars['partition-type:init_boot'] || deviceVars['partition-size:init_boot'];

    // Determine boot method
    let bootMethod = 'boot';
    if (localMatch?.bootMethod) bootMethod = localMatch.bootMethod;
    else if (hasInitBoot) bootMethod = 'init_boot';

    // Determine page size
    let pageSize = 4096;
    if (localMatch?.pageSizeNote?.includes('16KB')) {
      // Check if device is likely Android 15+
      if (deviceVars.os_version) {
        const osNum = parseInt(deviceVars.os_version);
        if (osNum >= 15) pageSize = 16384;
      }
    }

    return {
      device: {
        name: localMatch?.deviceName || localMatch?.brandName || product,
        brand: localMatch?.brandName || 'Unknown',
        bootMethod,
        rootable: isUnlocked || !isSecure,
      },
      recommendation: localMatch?.unlockNotes || (isSecure && !isUnlocked
        ? 'Bootloader is locked. Unlock required before flashing.'
        : 'Device ready for flashing.'),
      warnings: localMatch?.knownIssues || (isSecure && !isUnlocked ? ['Bootloader is LOCKED'] : []),
      bootMethod,
      needsVbmetaDisable: true,
      needs16KB: pageSize === 16384,
      isAndroid13Plus: !!hasInitBoot,
      source: localMatch ? 'local+fallback' : 'heuristic',
    };
  }

  async _groqAnalyzeDevice(deviceVars, localMatch, imageSummary) {
    const localContext = localMatch
      ? `\nLocal database match: ${localMatch.deviceName || localMatch.brandName} (${localMatch.brand})\nBrand knowledge: ${JSON.stringify({ bootMethod: localMatch.bootMethod, unlockMethod: localMatch.unlockMethod, knownIssues: localMatch.knownIssues, pageSizeNote: localMatch.pageSizeNote })}`
      : '\nNo local database match found.';

    const prompt = `You are an Android rooting and flashing expert assistant for the WebForge Patcher tool.
Analyze this Fastboot device info and recommend the optimal patching strategy.

Device variables from fastboot getvar:
${JSON.stringify(deviceVars, null, 2)}
${localContext}
${imageSummary ? `\nBoot image being patched:\n${JSON.stringify(imageSummary, null, 2)}` : ''}

Respond with a JSON object containing:
{
  "deviceName": "Human-readable device name",
  "manufacturer": "Manufacturer name",
  "androidVersion": "Estimated Android version (or 'unknown')",
  "pageSize": "Likely page size (4096 or 16384)",
  "bootMethod": "Which partition to patch: 'boot', 'init_boot', or 'vendor_boot'",
  "needsVbmetaDisable": true/false,
  "needs16KB": true/false,
  "isAndroid13Plus": true/false,
  "warnings": ["array of important warnings about this device"],
  "recommendedSteps": ["ordered list of recommended patching steps"],
  "compatibilityNotes": "Any notes about device-specific quirks or compatibility issues"
}

Be precise and conservative. If you're unsure about something, say "unknown" rather than guessing.`;

    Utils.log('AI: Analyzing device with Groq...');

    const result = await this._call(
      [{ role: 'user', content: prompt }],
      { jsonMode: true, temperature: 0.2, maxTokens: 800 }
    );

    const parsed = this._safeParseJSON(result);
    if (parsed) {
      Utils.log(`AI: Device identified as ${parsed.deviceName} (${parsed.manufacturer})`);
      return parsed;
    }
    return null;
  }

  // ============================================================
  // BOOT IMAGE ANALYSIS
  // ============================================================

  /**
   * Analyze a parsed boot image and get AI recommendations.
   */
  async analyzeBootImage(imageSummary, deviceInfo = null) {
    const prompt = `You are an Android boot image expert for the WebForge Patcher tool.
Analyze this boot image and provide patching recommendations.

Boot image summary:
${JSON.stringify(imageSummary, null, 2)}

${deviceInfo ? `Connected device:\n${JSON.stringify(deviceInfo, null, 2)}` : 'No device connected.'}

Respond with JSON:
{
  "imageType": "boot | init_boot | vendor_boot | recovery",
  "versionSupported": true/false,
  "ramdiskAnalysis": "Description of ramdisk format and implications",
  "patchingFeasible": true/false,
  "recommendedPartition": "Which partition this image should be flashed to",
  "pageAlignmentNote": "Any notes about page alignment (especially 16KB)",
  "risks": ["array of potential risks"],
  "recommendations": ["array of specific recommendations for this image"]
}`;

    Utils.log('AI: Analyzing boot image with Groq...');

    try {
      const result = await this._call(
        [{ role: 'user', content: prompt }],
        { jsonMode: true, temperature: 0.3, maxTokens: 600 }
      );
      return this._safeParseJSON(result) || null;
    } catch (err) {
      Utils.log(`AI boot analysis failed: ${err.message}`, 'warn');
      return null;
    }
  }

  // ============================================================
  // ERROR DIAGNOSIS (local first, then Groq)
  // ============================================================

  /**
   * Diagnose a flashing or patching error.
   * First checks local error patterns, then enhances with Groq.
   */
  async diagnoseError(error, context = {}) {
    // Step 1: Instant local pattern match
    const localDiag = this.localDiagnoseError(error);
    if (localDiag) {
      Utils.log('AI: Error matched local pattern — instant diagnosis');
      // Still try Groq for additional context if available
      if (this.apiKey) {
        try {
          const groqDiag = await this._groqDiagnoseError(error, context);
          if (groqDiag) {
            return { ...localDiag, groqNotes: groqDiag.diagnosis, additionalFixes: groqDiag.fixes };
          }
        } catch (e) { /* local diagnosis is sufficient */ }
      }
      return localDiag;
    }

    // Step 2: No local match — use Groq if available
    if (this.apiKey) {
      try {
        return await this._groqDiagnoseError(error, context);
      } catch (err) {
        Utils.log(`AI diagnosis failed: ${err.message}`, 'warn');
        return null;
      }
    }

    // Step 3: No API key, no local match — return generic guidance
    return {
      diagnosis: 'Unknown error. No local pattern match and no Groq API key configured.',
      likelyCause: 'Unknown',
      fixes: [
        'Check the Log tab for detailed error information',
        'Verify device is in the correct mode (Fastboot/Download)',
        'Try a different USB cable or port',
        'Set up a Groq API key in the AI tab for detailed error diagnosis',
      ],
      isDeviceIssue: false,
      isBrowserIssue: false,
      severity: 'medium',
      source: 'fallback',
    };
  }

  async _groqDiagnoseError(error, context = {}) {
    const prompt = `You are an Android flashing troubleshooting expert for the WebForge Patcher tool.

Error encountered:
${error}

Context:
${JSON.stringify(context, null, 2)}

Provide a concise diagnosis and fix. Respond with JSON:
{
  "diagnosis": "Short explanation of what went wrong",
  "likelyCause": "Most probable cause",
  "fixes": ["Ordered list of steps to fix the issue"],
  "isDeviceIssue": true/false,
  "isBrowserIssue": true/false,
  "severity": "low | medium | high | critical"
}`;

    Utils.log('AI: Diagnosing error with Groq...');

    const result = await this._call(
      [{ role: 'user', content: prompt }],
      { jsonMode: true, temperature: 0.4, maxTokens: 500 }
    );
    return this._safeParseJSON(result);
  }

  // ============================================================
  // CHAT ASSISTANT (for interactive help in the PWA)
  // ============================================================

  /**
   * General-purpose chat for user questions about rooting/flashing.
   * Includes device context and brand-specific knowledge.
   */
  async chat(userMessage, deviceContext = null, imageContext = null) {
    const systemPrompt = `You are the WebForge Patcher AI assistant. You help users with Android rooting, flashing, and boot image patching.

Key rules:
- Be concise, technical, and safe
- Always warn about risks (bricking, data loss, security)
- Never recommend flashing system partitions from a browser due to memory limits
- Focus on boot, init_boot, vendor_boot, and vbmeta partitions
- For Samsung devices, recommend Odin mode, not fastboot
- Remind users to backup before any modification

Device-specific knowledge:
- Google Pixel: Easy unlock via "fastboot flashing unlock". Pixel 8+ uses init_boot on Android 13+.
- Samsung: No fastboot unlock. Use Download Mode + Odin. US models often locked. Knox void.
- OnePlus: Easy unlock via "fastboot oem unlock". Good rooting support.
- Xiaomi: Requires Mi Unlock tool + 7-day wait. Watch for anti-rollback.
- Motorola: Requires unlock key from Motorola website (24-48hr email).
- Nothing: Standard fastboot unlock, straightforward rooting.
- Sony: Requires IMEI submission to Sony developer site. DRM keys lost.
- Fairphone: Most open device, easy unlock, very rooter-friendly.
- ASUS: Model-specific unlock process, check support site.

Android 15 notes:
- 16KB page size support is critical for newer devices
- Page size is read from the boot image header dynamically
- Older tools that hardcode 4096 will produce broken images on 16KB devices

${deviceContext ? `Current device context:\n${JSON.stringify(deviceContext, null, 2)}` : ''}
${imageContext ? `Current boot image:\n${JSON.stringify(imageContext, null, 2)}` : ''}`;

    this.conversationHistory.push({ role: 'user', content: userMessage });

    // Keep history to last 10 messages to manage token usage
    if (this.conversationHistory.length > 10) {
      this.conversationHistory = this.conversationHistory.slice(-10);
    }

    const messages = [
      { role: 'system', content: systemPrompt },
      ...this.conversationHistory,
    ];

    try {
      const result = await this._call(messages, { temperature: 0.5, maxTokens: 600 });
      this.conversationHistory.push({ role: 'assistant', content: result });
      return result;
    } catch (err) {
      Utils.log(`AI chat failed: ${err.message}`, 'warn');
      return 'Sorry, I could not reach the AI assistant. Please check your internet connection and API key.';
    }
  }

  // ============================================================
  // AUTO-PILOT: Full automated analysis
  // ============================================================

  /**
   * Run a full automated analysis when a device + boot image are loaded.
   * Combines device detection + image analysis into one recommendation.
   */
  async fullAnalysis(deviceVars, imageSummary, deviceCodes = null) {
    Utils.log('AI: Running full auto-pilot analysis...');

    const [deviceAnalysis, imageAnalysis] = await Promise.all([
      this.analyzeDevice(deviceVars, imageSummary, deviceCodes).catch(() => null),
      this.analyzeBootImage(imageSummary, deviceVars).catch(() => null),
    ]);

    if (!deviceAnalysis && !imageAnalysis) return null;

    return {
      device: deviceAnalysis,
      image: imageAnalysis,
      recommendation: this._buildRecommendation(deviceAnalysis, imageAnalysis),
    };
  }

  _buildRecommendation(device, image) {
    const steps = [];

    if (device?.warnings?.length) {
      steps.push(`⚠ ${device.warnings.join('; ')}`);
    }

    const partition = image?.recommendedPartition || device?.bootMethod || 'boot';
    steps.push(`Patch and flash the ${partition} partition`);

    if (device?.needsVbmetaDisable || image?.risks?.some(r => r.includes('verity') || r.includes('AVB'))) {
      steps.push('Flash empty vbmeta.img to disable AVB verification');
    }

    if (device?.needs16KB) {
      steps.push('Enable 16KB page size toggle before patching');
    }

    steps.push('Reboot device and verify root with a root checker app');

    return steps;
  }
}

// Export knowledge base for testing
export { BRAND_KNOWLEDGE, ERROR_PATTERNS };
