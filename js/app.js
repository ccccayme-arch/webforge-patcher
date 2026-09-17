import { Utils } from './utils.js';
import { BootImage } from './boot-image.js';
import { USBBridge } from './usb-bridge.js';
import { VBMeta } from './vbmeta.js';
import { OdinBridge } from './odin.js';
import { RamdiskPatcher } from './ramdisk-patcher.js';
import { AIAssistant } from './ai-assistant.js';
import { BootValidator } from './boot-validator.js';
import { DeviceDoctor } from './doctor.js';

class WebForgeApp {
  constructor() {
    this.bridge = null;
    this.bootImage = null;
    this.vbmetaImage = null;
    this.loadedFile = null;
    this.magiskFiles = null;
    this.magiskApk = null;
    this.deviceCodes = null;
    this.deviceInfo = null;
    this.deviceVars = null;  // Full getvar dump for AI
    this.patchMode = 'magisk';
    this.use16KB = false;
    this.ai = null;
    this.odinTarFile = null;
    this.odinBridge = null;
    this.aiAnalysis = null;
    this.doctor = new DeviceDoctor();
    this._init();
  }

  async _init() {
    Utils.log('WebForge Patcher initializing...');
    if (!USBBridge.isSupported()) this._showWarning('WebUSB not supported. Use Chrome/Edge on desktop or Android.');
    try {
      const resp = await fetch('./data/codes.json');
      this.deviceCodes = await resp.json();
      Utils.log('Device codes loaded');
    } catch (err) { Utils.log('Failed to load codes.json', 'warn'); }
    if ('serviceWorker' in navigator) {
      navigator.serviceWorker.register('./service-worker.js')
        .then(() => Utils.log('Service Worker registered'))
        .catch((e) => Utils.log(`SW registration failed: ${e}`, 'warn'));
    }

    // Init AI from localStorage key
    const savedKey = localStorage.getItem('webforge_groq_key');
    if (savedKey) {
      this.ai = new AIAssistant(savedKey);
      Utils.log('AI assistant loaded from saved key');
    }

    this._bindUI();
  }

  _bindUI() {
    document.querySelectorAll('.tab').forEach(tab => tab.addEventListener('click', () => this._switchTab(tab.dataset.tab)));
    this.doctor.bind();

    // Boot image file
    const fileInput = document.getElementById('file-input');
    if (fileInput) fileInput.addEventListener('change', (e) => this._loadFile(e.target.files[0]));
    const dropZone = document.getElementById('file-drop');
    if (dropZone) {
      dropZone.addEventListener('click', () => fileInput?.click());
      dropZone.addEventListener('dragover', (e) => { e.preventDefault(); dropZone.classList.add('dragover'); });
      dropZone.addEventListener('dragleave', () => dropZone.classList.remove('dragover'));
      dropZone.addEventListener('drop', (e) => { e.preventDefault(); dropZone.classList.remove('dragover'); if (e.dataTransfer.files[0]) this._loadFile(e.dataTransfer.files[0]); });
    }

    // Magisk APK file
    const apkInput = document.getElementById('apk-input');
    if (apkInput) apkInput.addEventListener('change', (e) => this._loadAPK(e.target.files[0]));
    const apkDrop = document.getElementById('apk-drop');
    if (apkDrop) {
      apkDrop.addEventListener('click', () => apkInput?.click());
      apkDrop.addEventListener('dragover', (e) => { e.preventDefault(); apkDrop.classList.add('dragover'); });
      apkDrop.addEventListener('dragleave', () => apkDrop.classList.remove('dragover'));
      apkDrop.addEventListener('drop', (e) => { e.preventDefault(); apkDrop.classList.remove('dragover'); if (e.dataTransfer.files[0]) this._loadAPK(e.dataTransfer.files[0]); });
    }

    // Patch mode toggles
    document.querySelectorAll('input[name="patch-mode"]').forEach(input => input.addEventListener('change', (e) => {
      this.patchMode = e.target.value;
      this._updateGodModeVisibility();
    }));

    // 16KB toggle
    const toggle16k = document.getElementById('toggle-16k');
    if (toggle16k) toggle16k.addEventListener('change', (e) => {
      this.use16KB = e.target.checked;
      if (this.bootImage) this.bootImage.setPageSize(this.use16KB ? 16384 : 4096);
    });

    // Action buttons
    document.getElementById('btn-connect-fb')?.addEventListener('click', () => this._connectFastboot());
    document.getElementById('btn-connect-odin')?.addEventListener('click', () => this._connectOdin());
    document.getElementById('btn-disconnect')?.addEventListener('click', () => this._disconnect());
    document.getElementById('btn-patch')?.addEventListener('click', () => this._patchImage());
    document.getElementById('btn-flash')?.addEventListener('click', () => this._flashDevice());
    document.getElementById('btn-download-patched')?.addEventListener('click', () => this._downloadPatched());
    document.getElementById('btn-flash-vbmeta')?.addEventListener('click', () => this._flashVbmeta());

    // Fastboot advanced controls
    document.getElementById('btn-boot-temp')?.addEventListener('click', () => this._bootTemp());
    document.getElementById('btn-get-slot')?.addEventListener('click', () => this._getSlot());
    document.getElementById('btn-switch-slot')?.addEventListener('click', () => this._switchSlot());
    document.getElementById('btn-unlock')?.addEventListener('click', () => this._unlockBootloader());
    document.getElementById('btn-reboot')?.addEventListener('click', () => this._rebootDevice());
    document.getElementById('btn-reboot-bootloader')?.addEventListener('click', () => this._rebootBootloader());
    document.getElementById('btn-reboot-recovery')?.addEventListener('click', () => this._rebootRecovery());
    document.getElementById('btn-continue-boot')?.addEventListener('click', () => this._continueBoot());

    // AI: analyze buttons
    document.getElementById('btn-ai-analyze')?.addEventListener('click', () => this._aiAnalyze());
    document.getElementById('btn-ai-diagnose')?.addEventListener('click', () => this._aiDiagnoseLast());
    document.getElementById('btn-save-groq-key')?.addEventListener('click', () => this._saveGroqKey());
    document.getElementById('btn-ai-send')?.addEventListener('click', () => this._aiSendChat());
    const aiInput = document.getElementById('ai-input');
    if (aiInput) aiInput.addEventListener('keydown', (e) => { if (e.key === 'Enter') this._aiSendChat(); });

    // Odin file
    const odinInput = document.getElementById("odin-file-input");
    if (odinInput) odinInput.addEventListener("change", (e) => this._loadOdinFile(e.target.files[0]));
    const odinDrop = document.getElementById("odin-file-drop");
    if (odinDrop) {
      odinDrop.addEventListener("click", () => odinInput?.click());
      odinDrop.addEventListener("dragover", (e) => { e.preventDefault(); odinDrop.classList.add("dragover"); });
      odinDrop.addEventListener("dragleave", () => odinDrop.classList.remove("dragover"));
      odinDrop.addEventListener("drop", (e) => { e.preventDefault(); odinDrop.classList.remove("dragover"); if (e.dataTransfer.files[0]) this._loadOdinFile(e.dataTransfer.files[0]); });
    }
    document.getElementById("btn-flash-odin")?.addEventListener("click", () => this._flashOdin());

    // Odin advanced controls
    document.getElementById('btn-odin-disconnect')?.addEventListener('click', () => this._disconnectOdin());
    document.getElementById('btn-odin-interrogate')?.addEventListener('click', () => this._odinInterrogate());
    document.getElementById('btn-odin-erase-userdata')?.addEventListener('click', () => this._odinFactoryReset());
    document.getElementById('btn-abort-odin')?.addEventListener('click', () => this._odinAbort());
    document.getElementById('btn-odin-reboot')?.addEventListener('click', () => this._odinReboot());
    document.getElementById('btn-odin-continue')?.addEventListener('click', () => this._odinContinue());

    // Global events
    window.addEventListener('webforge:log', (e) => this._addLog(e.detail.msg, e.detail.level));
    window.addEventListener('webforge:flash-progress', (e) => this._updateProgress(e.detail.partition, e.detail.progress));
    window.addEventListener('webforge:flash-progress', (e) => this._updateOdinProgress(e.detail));
  }

  _updateGodModeVisibility() {
    const apkCard = document.getElementById('apk-card');
    if (!apkCard) return;
    apkCard.classList.toggle('hidden', this.patchMode !== 'magisk');
  }

  _switchTab(tabName) {
    document.querySelectorAll('.tab').forEach(t => t.classList.remove('active'));
    document.querySelectorAll('.panel').forEach(p => p.classList.remove('active'));
    document.querySelector(`.tab[data-tab="${tabName}"]`)?.classList.add('active');
    document.getElementById(`panel-${tabName}`)?.classList.add('active');
  }

  // ============================================================
  // USB CONNECTION
  // ============================================================

  async _connectFastboot() {
    try {
      this.bridge = new USBBridge();
      await this.bridge.requestDevice();
      await this.bridge.connect();

      // Grab all useful getvar data for AI
      const [product, serial, secure, unlocked, maxDownload, currentSlot, batteryLevel] = await Promise.all([
        this.bridge.getVar('product').catch(() => 'unknown'),
        this.bridge.getVar('serialno').catch(() => 'unknown'),
        this.bridge.getVar('secure').catch(() => 'unknown'),
        this.bridge.getVar('unlocked').catch(() => 'unknown'),
        this.bridge.getVar('max-download-size').catch(() => 'unknown'),
        this.bridge.getVar('current-slot').catch(() => 'unknown'),
        this.bridge.getVar('battery-soc-ok').catch(() => 'unknown'),
      ]);

      this.deviceInfo = { product, serial, secure, unlocked };
      this.deviceVars = { product, serial, secure, unlocked, maxDownload, currentSlot, batteryLevel };
      this._updateDeviceInfo();

      // Enable fastboot buttons
      ['btn-boot-temp', 'btn-get-slot', 'btn-switch-slot', 'btn-unlock', 'btn-reboot', 'btn-reboot-bootloader', 'btn-reboot-recovery', 'btn-continue-boot'].forEach(id => {
        document.getElementById(id)?.removeAttribute('disabled');
      });

      Utils.log(`Device: ${product} (secure=${secure}, unlocked=${unlocked})`);
      Utils.toast('Fastboot device connected', 'success');
      Utils.setStatus('fb-status-dot', 'connected');

      if (secure === 'yes' && unlocked !== 'yes') {
        this._showWarning('Bootloader is LOCKED. Unlock via "Unlock Bootloader" button or "fastboot flashing unlock" first.');
      }

      // Auto-run local device lookup (instant, no API needed)
      if (this.deviceCodes) {
        const localMatch = this.ai?.localDeviceLookup(product, this.deviceCodes);
        if (localMatch) {
          Utils.log('Device identified: ' + (localMatch.deviceName || localMatch.brandName) + ' (' + localMatch.brand + ')');
          if (localMatch.knownIssues?.length) {
            for (const issue of localMatch.knownIssues) Utils.log('  ⚠ ' + issue, 'warn');
          }
        }
      }

      // Auto-run AI analysis if Groq key is set
      if (this.ai) {
        this._aiAnalyzeDevice(this.deviceVars);
      } else if (this.deviceCodes) {
        // No AI key — show local analysis
        this._showLocalDeviceAnalysis(product);
      }
    } catch (err) {
      Utils.log(err.message, 'error');
      this._showError(err.message);
    if (err.message.length < 80) Utils.toast(err.message, 'error', 4000);
      if (this.ai) this._aiDiagnose(err.message, { action: 'fastboot_connect' });
    }
  }

  async _connectOdin() {
    try {
      this.odinBridge = new OdinBridge();
      await this.odinBridge.requestDevice();
      await this.odinBridge.connect();
      await this.odinBridge.initSession();
      this.bridge = this.odinBridge; // also set as main bridge for shared UI
      Utils.log('Samsung Odin device connected');
      Utils.toast('Odin device connected', 'success');
      Utils.setStatus('odin-status-dot', 'connected');
      // Enable Odin buttons
      ['btn-odin-disconnect', 'btn-odin-interrogate', 'btn-odin-erase-userdata', 'btn-odin-reboot', 'btn-odin-continue'].forEach(id => {
        document.getElementById(id)?.removeAttribute('disabled');
      });
      // Auto-interrogate for device info
      try {
        const info = await this.odinBridge.getDeviceInfo();
        if (info) {
          this.deviceInfo = { product: info.model, serial: info.serial, secure: '—', unlocked: '—' };
          this._updateDeviceInfo();
          this._displayOdinDeviceInfo(info);
        }
      } catch (e) { Utils.log('Auto device info failed — click Read Device Info', 'debug'); }
    } catch (err) { Utils.log(err.message, 'error'); this._showError(err.message);
    if (err.message.length < 80) Utils.toast(err.message, 'error', 4000); }
  }

  async _disconnectOdin() {
    if (this.odinBridge) {
      try { await this.odinBridge.disconnect(); } catch (e) {}
      this.odinBridge = null;
      this.bridge = null;
      Utils.log('Odin device disconnected');
      Utils.setStatus('odin-status-dot', 'disconnected');
      Utils.toast('Odin device disconnected', 'info');
      ['btn-odin-disconnect', 'btn-odin-interrogate', 'btn-odin-erase-userdata', 'btn-odin-reboot', 'btn-odin-continue', 'btn-flash-odin', 'btn-abort-odin'].forEach(id => {
        document.getElementById(id)?.setAttribute('disabled', '');
      });
      document.getElementById('odin-device-card')?.classList.add('hidden');
      document.getElementById('odin-pit-card')?.classList.add('hidden');
    }
  }

  async _odinInterrogate() {
    if (!this.odinBridge) return;
    try {
      Utils.log('Interrogating Samsung device...');
      const result = await this.odinBridge.interrogate();
      if (result.deviceInfo) this._displayOdinDeviceInfo(result.deviceInfo);
      if (result.pit && result.pit.partitions.length > 0) this._displayOdinPIT(result.pit);
      this._showSuccess('Device interrogation complete');
    } catch (err) {
      Utils.log('Interrogation failed: ' + err.message, 'error');
      this._showError(err.message);
    if (err.message.length < 80) Utils.toast(err.message, 'error', 4000);
    }
  }

  _displayOdinDeviceInfo(info) {
    const card = document.getElementById('odin-device-card');
    const container = document.getElementById('odin-device-info');
    if (!card || !container) return;
    const rows = [
      ['Model', info.model || '—'],
      ['Firmware', info.firmware || '—'],
      ['Bootloader', info.bootloader || '—'],
      ['Serial', info.serial || '—'],
      ['Region', info.region || '—'],
    ];
    container.innerHTML = rows.map(([l, v]) => '<div class="row"><span class="label">' + l + '</span><span class="value">' + v + '</span></div>').join('');
    card.classList.remove('hidden');
  }

  _displayOdinPIT(pit) {
    const card = document.getElementById('odin-pit-card');
    const list = document.getElementById('odin-pit-list');
    if (!card || !list) return;
    const rows = pit.partitions.map(p => {
      const sizeMB = (p.blockCount * p.blockSize / 1024 / 1024).toFixed(1);
      const writable = p.writable ? '✓' : '✗';
      return '<div class="row"><span class="label">' + writable + ' ' + p.name + '</span><span class="value">' + sizeMB + 'MB</span></div>';
    });
    list.innerHTML = '<div class="device-info">' + rows.join('') + '</div>';
    card.classList.remove('hidden');
  }

  async _odinFactoryReset() {
    if (!this.odinBridge) return;
    if (!confirm('Erase userdata and cache? This will factory reset the device.')) return;
    try {
      await this.odinBridge.factoryReset();
      this._showSuccess('Factory reset complete');
    } catch (err) {
      Utils.log('Factory reset failed: ' + err.message, 'error');
      this._showError(err.message);
    if (err.message.length < 80) Utils.toast(err.message, 'error', 4000);
    }
  }

  async _odinReboot() {
    if (!this.odinBridge) return;
    try {
      await this.odinBridge.reboot();
      this._showSuccess('Device rebooting...');
      this._disconnectOdin();
    } catch (err) { this._showError(err.message);
    if (err.message.length < 80) Utils.toast(err.message, 'error', 4000); }
  }

  async _odinContinue() {
    if (!this.odinBridge) return;
    try {
      await this.odinBridge.bootContinue();
      this._showSuccess('Device continuing boot...');
      this._disconnectOdin();
    } catch (err) { this._showError(err.message);
    if (err.message.length < 80) Utils.toast(err.message, 'error', 4000); }
  }

  _odinAbort() {
    if (this.odinBridge) {
      this.odinBridge.abortFlash();
      document.getElementById('btn-abort-odin')?.setAttribute('disabled', '');
    }
  }

  _updateOdinProgress(detail) {
    const fill = document.getElementById('odin-progress-fill');
    const text = document.getElementById('odin-progress-text');
    if (!fill || !text) return;
    if (detail.progress !== undefined) {
      fill.style.width = detail.progress + '%';
      if (detail.bytes && detail.total) {
        text.textContent = detail.partition + ': ' + detail.progress + '% (' + (detail.bytes / 1048576).toFixed(1) + '/' + (detail.total / 1048576).toFixed(1) + ' MB)';
      } else {
        text.textContent = detail.partition + ': ' + detail.progress + '%';
      }
    }
  }

  async _disconnect() {
    if (this.bridge) {
      // If it's an Odin bridge, use the Odin disconnect path
      if (this.bridge === this.odinBridge) { await this._disconnectOdin(); return; }
      await this.bridge.disconnect();
      this.bridge = null;
      this.deviceInfo = null;
      Utils.setStatus('fb-status-dot', 'disconnected');
      Utils.toast('Device disconnected', 'info');
      this.deviceVars = null;
      this._updateDeviceInfo();
      ['btn-boot-temp', 'btn-get-slot', 'btn-switch-slot', 'btn-unlock', 'btn-reboot', 'btn-reboot-bootloader', 'btn-reboot-recovery', 'btn-continue-boot', 'btn-flash', 'btn-flash-vbmeta'].forEach(id => {
        document.getElementById(id)?.setAttribute('disabled', '');
      });
    }
  }

  async _loadOdinFile(file) {
    if (!file) return;
    Utils.log(`Loading Odin file: ${file.name} (${(file.size / 1024 / 1024).toFixed(2)} MB)...`);
    if (file.size > 1024 * 1024 * 1024) { this._showError("File over 1GB. Browser cannot handle this."); return; }
    const arrayBuffer = await file.arrayBuffer();
    this.odinTarFile = new Uint8Array(arrayBuffer);
    document.querySelector('#odin-file-drop .filename')?.textContent = file.name;
    document.getElementById('btn-flash-odin')?.removeAttribute('disabled');
    Utils.log('Odin file loaded and ready to flash');
  }

  async _flashOdin() {
    if (!this.odinBridge) { this._showError('No Odin device connected'); return; }
    if (!this.odinTarFile) { this._showError('No .tar.md5 file loaded'); return; }
    document.getElementById('btn-abort-odin')?.removeAttribute('disabled');
    document.getElementById('btn-flash-odin')?.setAttribute('disabled', '');
    try {
      const result = await this.odinBridge.flashTarMD5(this.odinTarFile);
      if (result.failed > 0) {
        this._showError('Flash complete with ' + result.failed + ' failure(s)');
      } else {
        this._showSuccess('Odin flash complete! (' + result.flashed + ' partitions)');
      }
      document.getElementById('btn-odin-reboot')?.removeAttribute('disabled');
      document.getElementById('btn-odin-continue')?.removeAttribute('disabled');
    } catch (err) {
      Utils.log(`Odin flash failed: ${err.message}`, 'error');
      this._showError(err.message);
    if (err.message.length < 80) Utils.toast(err.message, 'error', 4000);
      if (this.ai) this._aiDiagnose(err.message, { action: 'odin_flash' });
    } finally {
      document.getElementById('btn-abort-odin')?.setAttribute('disabled', '');
      document.getElementById('btn-flash-odin')?.removeAttribute('disabled');
    }
  }

  // ============================================================
  // FILE LOADING
  // ============================================================

  async _loadFile(file) {
    if (!file) return;
    Utils.log(`Loading: ${file.name} (${(file.size / 1024 / 1024).toFixed(2)} MB)...`);
    const arrayBuffer = await file.arrayBuffer();
    const data = new Uint8Array(arrayBuffer);
    this.loadedFile = file;
    document.querySelector('#file-drop .filename')?.textContent = file.name;

    try {
      // Check if it's a Samsung tar (Odin mode)
      if (file.name.endsWith('.tar.md5') || file.name.endsWith('.tar.lz4') || file.name.endsWith('.tar')) {
        Utils.log('Detected: Samsung tar archive (Odin mode)');
        this.odinTarFile = data;
        document.getElementById('btn-flash-odin')?.removeAttribute('disabled');
        Utils.log('Odin file ready — switch to WebOdin tab to flash');
        return;
      }

      // Parse as boot image
      this.bootImage = BootImage.parse(data);
      this._displayBootInfo();
      document.getElementById('btn-patch')?.removeAttribute('disabled');

      // Set page size toggle based on detected page size
      if (this.bootImage.pageSize === 16384) {
        const toggle = document.getElementById('toggle-16k');
        if (toggle) { toggle.checked = true; this.use16KB = true; }
      }

      // If the image already has a ramdisk, check if it's an init_boot
      const isInitBoot = file.name.includes('init_boot') || file.name.includes('initboot');
      if (isInitBoot && this.deviceVars) {
        Utils.log('init_boot image detected — will flash to init_boot partition', 'debug');
      }
    } catch (err) {
      Utils.log(`Parse failed: ${err.message}`, 'error');
      this._showError(err.message);
    if (err.message.length < 80) Utils.toast(err.message, 'error', 4000);
    }
  }

  async _loadAPK(file) {
    if (!file) return;
    Utils.log(`Loading Magisk APK: ${file.name}...`);
    const arrayBuffer = await file.arrayBuffer();
    this.magiskApk = new Uint8Array(arrayBuffer);
    document.querySelector('#apk-drop .filename')?.textContent = file.name;

    // Extract Magisk files from APK (ZIP)
    try {
      this.magiskFiles = await RamdiskPatcher.extractFromAPK(this.magiskApk);
      Utils.log('Magisk binaries extracted');
    } catch (err) {
      Utils.log(`APK extraction failed: ${err.message}`, 'error');
      this._showError(err.message);
    if (err.message.length < 80) Utils.toast(err.message, 'error', 4000);
    }
  }

  _displayBootInfo() {
    if (!this.bootImage) return;
    const container = document.getElementById('boot-info');
    const card = document.getElementById('boot-info-card');
    if (!container || !card) return;
    const s = this.bootImage.summary();
    const ramdiskFmt = s.ramdiskFormat === 'gzip' ? 'gzip' : s.ramdiskFormat === 'lz4' ? 'lz4' : 'raw';
    const pageKB = (s.pageSize / 1024).toFixed(0);
    container.innerHTML = `
      <div class="device-info">
        <div class="row"><span class="label">Type</span><span class="value">${s.isVendorBoot ? 'vendor_boot' : 'boot'}</span></div>
        <div class="row"><span class="label">Header</span><span class="value">v${s.version}</span></div>
        <div class="row"><span class="label">Page Size</span><span class="value">${pageKB}KB${s.pageSize === 16384 ? ' (Android 15)' : ''}</span></div>
        <div class="row"><span class="label">Kernel</span><span class="value">${(s.kernelSize / 1024).toFixed(0)} KB</span></div>
        <div class="row"><span class="label">Ramdisk</span><span class="value">${(s.ramdiskSize / 1024).toFixed(0)} KB (${ramdiskFmt})</span></div>
        ${s.secondSize > 0 ? `<div class="row"><span class="label">Second</span><span class="value">${(s.secondSize / 1024).toFixed(0)} KB</span></div>` : ''}
        ${s.dtbSize > 0 ? `<div class="row"><span class="label">DTB</span><span class="value">${(s.dtbSize / 1024).toFixed(0)} KB</span></div>` : ''}
      </div>`;
    card.classList.remove('hidden');
  }

  // ============================================================
  // PATCHING (God Mode)
  // ============================================================

  async _patchImage() {
    if (!this.bootImage) { this._showError('No boot image loaded'); return; }
    try {
      // Disable AVB / dm-verity via cmdline
      if (this.bootImage.isVendorBoot) {
        this.bootImage.patchVendorCmdline();
      } else {
        this.bootImage.patchCmdline();
      }

      // Generate empty vbmeta
      this.vbmetaImage = VBMeta.createEmpty();
      document.getElementById('btn-flash-vbmeta')?.removeAttribute('disabled');

      // Magisk injection
      if (this.patchMode === 'magisk') {
        if (!this.magiskFiles) {
          Utils.log('No Magisk APK loaded — skipping root injection (cmdline patch only)', 'warn');
        } else {
          Utils.log('Injecting Magisk into ramdisk (God Mode)...');
          const patcher = await RamdiskPatcher.fromBootImage(this.bootImage);

          // Inject Magisk binaries and services
          await patcher.injectMagisk(this.magiskFiles, {
            keepVerity: false,
            keepEncrypted: false,
          });

          // Disable dm-verity in fstab
          patcher.patchFstab();

          // Rebuild ramdisk (CPIO + compress)
          const newRamdisk = await patcher.build();
          this.bootImage.setRamdisk(newRamdisk);
          Utils.log(`Ramdisk repacked (${(newRamdisk.byteLength / 1024).toFixed(0)} KB)`);
        }
      }

      // Rebuild boot image
      this.bootImage._patchedData = this.bootImage.build();
      Utils.log(`Patched image: ${(this.bootImage._patchedData.byteLength / 1024 / 1024).toFixed(2)} MB`);
      Utils.toast('Image patched successfully', 'success');

      // Enable download and flash buttons
      document.getElementById('btn-download-patched')?.removeAttribute('disabled');
      document.getElementById('btn-flash')?.removeAttribute('disabled');

      this._showSuccess('Boot image patched! Ready to flash or download.');
    } catch (err) {
      Utils.log(`Patch failed: ${err.message}`, 'error');
      Utils.toast('Patch failed: ' + err.message, 'error', 5000);
      this._showError(err.message);
    if (err.message.length < 80) Utils.toast(err.message, 'error', 4000);
      if (this.ai) this._aiDiagnose(err.message, { action: 'patch', mode: this.patchMode });
    }
  }

  // ============================================================
  // FLASHING
  // ============================================================

  async _flashDevice() {
    if (!this.bridge) { this._showError('No device connected'); return; }
    if (!this.bootImage?._patchedData) { this._showError('No patched image. Patch first.'); return; }

    // Smart partition auto-detection
    const partition = this._detectTargetPartition();
    Utils.log(`Target partition: ${partition}`);

    try {
      // Validate image before flashing
      const validation = BootValidator.validate(this.bootImage._patchedData);
      Utils.log(BootValidator.summarize(validation));
      if (!validation.valid) {
        this._showError('Image validation failed: ' + validation.errors.join('; '));
        return;
      }
      for (const w of validation.warnings) {
        Utils.log('⚠️ ' + w, 'warn');
      }
      const compat = BootValidator.checkPartitionCompatibility(validation.info, partition);
      if (!compat.safe) {
        this._showError('Partition mismatch: ' + compat.reason);
        return;
      }
      await this.bridge.flashPartition(partition, this.bootImage._patchedData);
      this._showSuccess(`${partition} flashed successfully!`);
    } catch (err) {
      Utils.log(`Flash failed: ${err.message}`, 'error');
      Utils.toast('Flash failed: ' + err.message, 'error', 5000);
      this._showError(err.message);
    if (err.message.length < 80) Utils.toast(err.message, 'error', 4000);
      if (this.ai) this._aiDiagnose(err.message, { action: 'flash', partition });
    }
  }

  /**
   * Smart partition auto-detection based on image type and device capabilities.
   * Determines whether to flash to boot, init_boot, or vendor_boot.
   */
  _detectTargetPartition() {
    // If AI has a recommendation, use it (highest confidence)
    if (this.aiAnalysis?.device?.bootMethod) {
      Utils.log(`AI recommends: ${this.aiAnalysis.device.bootMethod}`, 'debug');
      return this.aiAnalysis.device.bootMethod;
    }

    // Vendor boot images always go to vendor_boot
    if (this.bootImage.isVendorBoot) return 'vendor_boot';

    // Check filename hint (init_boot.img → init_boot partition)
    if (this.loadedFile?.name?.includes('init_boot') || this.loadedFile?.name?.includes('initboot')) {
      Utils.log('Filename indicates init_boot', 'debug');
      return 'init_boot';
    }

    // For standard boot images, check if device supports init_boot (Android 13+)
    // init_boot was introduced in Android 13 — devices that support it separate
    // the ramdisk into init_boot, leaving boot with just the kernel.
    if (this.deviceVars) {
      const hasInitBoot = this.deviceVars['partition-type:init_boot'] ||
                          this.deviceVars['partition-size:init_boot'];
      if (hasInitBoot && this.bootImage.ramdisk && this.bootImage.ramdisk.byteLength > 0) {
        Utils.log('Device has init_boot partition — flashing ramdisk there', 'debug');
        return 'init_boot';
      }
    }

    // Default: boot partition
    return 'boot';
  }

  async _bootTemp() {
    if (!this.bridge) { this._showError('No device connected'); return; }
    if (!this.bootImage?._patchedData) { this._showError('No patched image. Patch first.'); return; }
    Utils.log('Temporarily booting patched image (not writing to flash)...');
    try {
      await this.bridge.bootTemp(this.bootImage._patchedData);
      this._showSuccess('Temporary boot sent! Check device screen.');
    } catch (err) {
      Utils.log('Boot temp failed: ' + err.message, 'error');
      Utils.toast('Boot failed: ' + err.message, 'error', 5000);
      this._showError(err.message);
    if (err.message.length < 80) Utils.toast(err.message, 'error', 4000);
    }
  }

  async _getSlot() {
    if (!this.bridge) { this._showError('No device connected'); return; }
    try {
      const current = await this.bridge.getCurrentSlot();
      const info = document.getElementById('slot-info');
      if (info) info.textContent = 'Current slot: ' + current;
      Utils.log('Current slot: ' + current);
    } catch (err) { this._showError(err.message);
    if (err.message.length < 80) Utils.toast(err.message, 'error', 4000); }
  }

  async _switchSlot() {
    if (!this.bridge) { this._showError('No device connected'); return; }
    try {
      const slot = await this.bridge.switchToInactiveSlot();
      const info = document.getElementById('slot-info');
      if (info) info.textContent = 'Switched to slot: ' + slot;
      this._showSuccess('Active slot set to ' + slot);
    } catch (err) { this._showError(err.message);
    if (err.message.length < 80) Utils.toast(err.message, 'error', 4000); }
  }

  async _unlockBootloader() {
    if (!this.bridge) { this._showError('No device connected'); return; }
    if (!confirm('WARNING: Unlocking the bootloader will WIPE ALL DATA on the device.\n\nContinue?')) return;
    try {
      await this.bridge.unlockBootloader();
      this._showSuccess('Unlock command sent. Check device screen for confirmation.');
    } catch (err) {
      Utils.log('Unlock failed: ' + err.message, 'error');
    Utils.toast('Unlock failed: ' + err.message, 'error', 5000);
      this._showError(err.message);
    if (err.message.length < 80) Utils.toast(err.message, 'error', 4000);
    }
  }

  async _rebootDevice() {
    if (!this.bridge) { this._showError('No device connected'); return; }
    try { await this.bridge.reboot(); this._showSuccess('Rebooting...'); }
    catch (err) { this._showError(err.message);
    if (err.message.length < 80) Utils.toast(err.message, 'error', 4000); }
  }

  async _rebootBootloader() {
    if (!this.bridge) { this._showError('No device connected'); return; }
    try { await this.bridge.rebootBootloader(); this._showSuccess('Rebooting to bootloader...'); }
    catch (err) { this._showError(err.message);
    if (err.message.length < 80) Utils.toast(err.message, 'error', 4000); }
  }

  async _rebootRecovery() {
    if (!this.bridge) { this._showError('No device connected'); return; }
    try { await this.bridge.rebootRecovery(); this._showSuccess('Rebooting to recovery...'); }
    catch (err) { this._showError(err.message);
    if (err.message.length < 80) Utils.toast(err.message, 'error', 4000); }
  }

  async _continueBoot() {
    if (!this.bridge) { this._showError('No device connected'); return; }
    try { await this.bridge.continueBoot(); this._showSuccess('Continuing boot...'); }
    catch (err) { this._showError(err.message);
    if (err.message.length < 80) Utils.toast(err.message, 'error', 4000); }
  }

  async _flashVbmeta() {
    if (!this.bridge || !this.vbmetaImage) { this._showError('No device or vbmeta image'); return; }
    try {
      await this.bridge.erasePartition('vbmeta');
      await this.bridge.flashPartition('vbmeta', this.vbmetaImage);
      Utils.log('vbmeta flashed with verification disabled');
      this._showSuccess('vbmeta flashed successfully!');
    } catch (err) { Utils.log(`vbmeta flash failed: ${err.message}`, 'error'); this._showError(err.message);
    if (err.message.length < 80) Utils.toast(err.message, 'error', 4000); }
  }

  // ============================================================
  // DOWNLOAD
  // ============================================================

  _downloadPatched() {
    if (!this.bootImage?._patchedData) { this._showError('No patched image to download'); return; }
    const blob = new Blob([this.bootImage._patchedData], { type: 'application/octet-stream' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = this.loadedFile?.name?.replace('.img', '_patched.img') || 'patched_boot.img';
    a.click();
    URL.revokeObjectURL(url);
    Utils.log('Patched image downloaded');
    Utils.toast('Download started', 'success');
  }

  // ============================================================
  // AI
  // ============================================================

  _saveGroqKey() {
    const input = document.getElementById('groq-key-input');
    if (!input?.value) return;
    localStorage.setItem('webforge_groq_key', input.value);
    this.ai = new AIAssistant(input.value);
    Utils.log('Groq API key saved');
    Utils.toast('API key saved', 'success', 2000);
    this._showSuccess('AI assistant enabled');
    document.getElementById('ai-key-card')?.classList.add('hidden');
  }

  async _aiAnalyze() {
    if (!this.ai) { this._showError('Set Groq API key first'); return; }
    if (!this.deviceVars) { this._showError('Connect a device first'); return; }
    await this._aiAnalyzeDevice(this.deviceVars);
  }

  async _aiAnalyzeDevice(vars) {
    if (!this.ai) return;
    Utils.log('AI analyzing device...');
    try {
      const analysis = await this.ai.analyzeDevice(vars, this.bootImage?.summary(), this.deviceCodes);
      this.aiAnalysis = analysis;
      this._displayAIAnalysis(analysis);
    } catch (err) {
      Utils.log('AI analysis failed: ' + err.message, 'warn');
    }
  }

  _showLocalDeviceAnalysis(productName) {
    if (!this.ai || !this.deviceCodes) return;
    const match = this.ai.localDeviceLookup(productName, this.deviceCodes);
    if (!match) return;
    const analysis = {
      device: {
        name: match.deviceName || match.brandName,
        brand: match.brandName,
        bootMethod: match.bootMethod,
        rootable: this.deviceInfo.unlocked === 'yes',
      },
      recommendation: match.unlockNotes,
      warnings: match.knownIssues || [],
      bootMethod: match.bootMethod,
      needsVbmetaDisable: true,
      source: 'local',
    };
    this.aiAnalysis = analysis;
    this._displayAIAnalysis(analysis);
  }

  _displayAIAnalysis(analysis) {
    const container = document.getElementById('ai-analysis');
    if (!container) return;
    let html = '<div class="device-info">';
    if (analysis.device) {
      const dev = analysis.device;
      if (dev.name) html += `<div class="row"><span class="label">Device</span><span class="value">${dev.name}</span></div>`;
      if (dev.brand) html += `<div class="row"><span class="label">Brand</span><span class="value">${dev.brand}</span></div>`;
      if (dev.bootMethod) html += `<div class="row"><span class="label">Patch Target</span><span class="value">${dev.bootMethod}</span></div>`;
      if (dev.rootable !== undefined) html += `<div class="row"><span class="label">Rootable</span><span class="value">${dev.rootable ? 'Yes' : 'No'}</span></div>`;
    }
    if (analysis.recommendation) {
      html += `<div class="row"><span class="label">Strategy</span><span class="value" style="text-align:left">${analysis.recommendation}</span></div>`;
    }
    if (analysis.warnings?.length > 0) {
      html += `<div class="row"><span class="label">⚠️ Warnings</span><span class="value" style="text-align:left;color:var(--warn)">${analysis.warnings.join('; ')}</span></div>`;
    }
    html += '</div>';
    container.innerHTML = html;
  }

  async _aiDiagnoseLast() {
    if (!this.ai) { this._showError('Set Groq API key first'); return; }
    if (!this._lastError) { this._showError('No error to diagnose yet'); return; }
    await this._aiDiagnose(this._lastError, { action: 'manual' });
  }

  async _aiDiagnose(error, context) {
    if (!this.ai) return;
    this._lastError = error;
    try {
      const diagnosis = await this.ai.diagnoseError(error, context, this.deviceVars);
      const card = document.getElementById('ai-diagnosis-card');
      const container = document.getElementById('ai-diagnosis');
      if (card && container) {
        container.innerHTML = `<div class="ai-diagnosis-text">${diagnosis}</div>`;
        card.classList.remove('hidden');
      }
    } catch (e) {
      Utils.log('AI diagnosis failed: ' + e.message, 'warn');
    }
  }

  async _aiSendChat() {
    const input = document.getElementById('ai-input');
    if (!input?.value) return;
    const msg = input.value;
    input.value = '';
    this._addAIChat('You', msg);
    if (!this.ai) { this._addAIChat('AI', 'Set Groq API key first.'); return; }
    try {
      const reply = await this.ai.chat(msg, this.deviceVars, this.bootImage?.summary());
      this._addAIChat('AI', reply);
    } catch (err) {
      this._addAIChat('AI', 'Error: ' + err.message);
    }
  }

  _addAIChat(role, msg) {
    const container = document.getElementById('ai-chat');
    if (!container) return;
    const entry = document.createElement('div');
    entry.className = 'log-entry ' + (role === 'AI' ? 'info' : 'debug');
    entry.innerHTML = `<strong>${role}:</strong> ${msg}`;
    container.appendChild(entry);
    container.scrollTop = container.scrollHeight;
  }

  // ============================================================
  // UI HELPERS
  // ============================================================

  _updateDeviceInfo() {
    const container = document.getElementById('device-info');
    if (!container) return;
    if (!this.deviceInfo) {
      container.innerHTML = '<p class="placeholder-text">No device connected</p>';
      document.getElementById('btn-flash')?.setAttribute('disabled', '');
      document.getElementById('btn-flash-vbmeta')?.setAttribute('disabled', '');
      return;
    }
    const locked = this.deviceInfo.secure === 'yes' && this.deviceInfo.unlocked !== 'yes';
    const unlockBadge = locked
      ? '<span style="color:var(--error);font-size:0.7rem">⛔ LOCKED</span>'
      : '<span style="color:var(--success);font-size:0.7rem">✓ UNLOCKED</span>';
    container.innerHTML = `
      <div class="device-info">
        <div class="row"><span class="label">Status</span><span class="value">${unlockBadge}</span></div>
        <div class="row"><span class="label">Product</span><span class="value">${this.deviceInfo.product || 'Unknown'}</span></div>
        <div class="row"><span class="label">Serial</span><span class="value">${this.deviceInfo.serial || '—'}</span></div>
        <div class="row"><span class="label">Secure</span><span class="value">${this.deviceInfo.secure || '—'}</span></div>
        <div class="row"><span class="label">Unlocked</span><span class="value">${this.deviceInfo.unlocked || '—'}</span></div>
      </div>`;
    document.getElementById('btn-flash')?.removeAttribute('disabled');
    document.getElementById('btn-flash-vbmeta')?.removeAttribute('disabled');
  }

  _addLog(msg, level) {
    const container = document.getElementById('log-container');
    if (!container) return;
    const entry = document.createElement('div');
    entry.className = `log-entry ${level}`;
    entry.textContent = msg;
    container.appendChild(entry);
    container.scrollTop = container.scrollHeight;
    while (container.children.length > 200) container.removeChild(container.firstChild);
  }

  _updateProgress(partition, progress) {
    const bar = document.getElementById('progress-fill');
    const text = document.getElementById('progress-text');
    if (bar) bar.style.width = `${progress}%`;
    if (text) {
      if (progress === 100) {
        text.textContent = `${partition}: complete`;
      } else {
        text.textContent = `Flashing ${partition}: ${progress}%`;
      }
    }
  }

  _showWarning(msg) {
    const existing = document.querySelector('.warning');
    if (existing) existing.remove();
    const div = document.createElement('div');
    div.className = 'warning';
    div.innerHTML = `<strong>⚠ Warning:</strong> ${msg}`;
    document.querySelector('.container')?.insertBefore(div, document.querySelector('.container').firstChild);
  }

  _showError(msg) {
    this._addLog(msg, 'error');
    Utils.toast(msg, 'error', 5000);
  }

  _showSuccess(msg) {
    this._addLog(msg, 'info');
    Utils.toast(msg, 'success', 4000);
  }
}

// Boot
new WebForgeApp();
