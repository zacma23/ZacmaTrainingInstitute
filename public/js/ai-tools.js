/* Zacma Gemini AI Assistance Suite & Fayda National ID Scanner */
(function () {
  const aiScanSlots = {
    accFaydaFront: null,
    accFaydaBack: null,
    hubFaydaFront: null,
    hubFaydaBack: null,
    hubSlip: null,
  };

  let lastHubFaydaResult = null;
  let lastHubSlipResult = null;
  let lastSmsDraft = null;
  let activeAudioPlayer = null;

  // Live Camera state
  let cameraStream = null;
  let activeCameraSlot = '';
  let capturedCameraPayload = null;

  // Microphone recording state
  let activeRecorder = null;
  let activeRecorderStream = null;
  let activeRecorderChunks = [];
  let activeRecorderTarget = '';

  window.BirrAiPendingFayda = null;
  window.BirrAiPendingSlip = null;

  function showBoxError(elId, msg) {
    const el = document.getElementById(elId);
    if (!el) {
      if (msg) showToast(msg, 'error');
      return;
    }
    if (!msg) {
      el.style.display = 'none';
      el.textContent = '';
      return;
    }
    el.textContent = msg;
    el.style.display = 'block';
  }

  function formatConfidenceTag(conf) {
    const c = String(conf || 'MEDIUM').toUpperCase();
    const cls = c === 'HIGH' ? 'status-paid' : c === 'LOW' ? 'status-danger' : 'status-partial';
    return `<span class="status-tag ${cls}">Confidence: ${esc(c)}</span>`;
  }

  async function readFileAsAiPayload(file, maxDim = 1500, jpegQuality = 0.85) {
    if (!file) return null;
    const rawMime = String(file.type || '').toLowerCase();
    const isPdf = rawMime === 'application/pdf' || /\.pdf$/i.test(file.name || '');

    if (isPdf) {
      if (file.size > 3.0 * 1024 * 1024) {
        throw new Error('PDF file exceeds 3.0 MB limit (Vercel 4.5 MB request cap). Please upload a smaller PDF.');
      }
      const dataUrl = await new Promise((resolve, reject) => {
        const reader = new FileReader();
        reader.onload = () => resolve(String(reader.result || ''));
        reader.onerror = () => reject(new Error('Failed to read PDF file.'));
        reader.readAsDataURL(file);
      });
      const base64 = dataUrl.split(',')[1] || '';
      return {
        fileName: file.name || 'document.pdf',
        mimeType: 'application/pdf',
        data: base64,
        previewUrl: '',
        byteSize: file.size,
      };
    }

    if (!/^image\/(jpeg|jpg|png|webp)$/i.test(rawMime)) {
      throw new Error('Supported formats: JPG, PNG, WEBP, or PDF.');
    }

    const objectUrl = URL.createObjectURL(file);
    try {
      const img = await new Promise((resolve, reject) => {
        const image = new Image();
        image.onload = () => resolve(image);
        image.onerror = () => reject(new Error('Could not decode image file.'));
        image.src = objectUrl;
      });

      let width = img.naturalWidth || img.width;
      let height = img.naturalHeight || img.height;
      if (width > maxDim || height > maxDim) {
        const ratio = Math.min(maxDim / width, maxDim / height);
        width = Math.max(1, Math.round(width * ratio));
        height = Math.max(1, Math.round(height * ratio));
      }

      const canvas = document.createElement('canvas');
      canvas.width = width;
      canvas.height = height;
      const ctx = canvas.getContext('2d');
      ctx.drawImage(img, 0, 0, width, height);

      const outMime = rawMime === 'image/png' && file.size < 900 * 1024 ? 'image/png' : 'image/jpeg';
      const dataUrl = canvas.toDataURL(outMime, jpegQuality);
      const base64 = dataUrl.split(',')[1] || '';
      const approxBytes = Math.floor((base64.length * 3) / 4);

      return {
        fileName: (file.name || 'scan.jpg').replace(/\.\w+$/, outMime === 'image/png' ? '.png' : '.jpg'),
        mimeType: outMime,
        data: base64,
        previewUrl: dataUrl,
        byteSize: approxBytes,
      };
    } finally {
      URL.revokeObjectURL(objectUrl);
    }
  }

  function renderSlotPreview(previewElId, payload, emptyText) {
    const el = document.getElementById(previewElId);
    if (!el) return;
    if (!payload) {
      el.innerHTML = esc(emptyText);
      return;
    }
    const kb = Math.max(1, Math.round((payload.byteSize || (payload.data.length * 3) / 4) / 1024));
    if (payload.mimeType === 'application/pdf') {
      el.innerHTML = `<span>PDF ready: <strong>${esc(payload.fileName)}</strong> (${kb} KB)</span>`;
      return;
    }
    el.innerHTML = `
      <img src="data:${esc(payload.mimeType)};base64,${payload.data}" alt="Scan preview" />
      <span><strong>${esc(payload.fileName)}</strong> (${kb} KB)</span>
    `;
  }

  // ==================== FAYDA FORM POPULATION ====================
  function applyFaydaResultToAccountantForm(res, attachDocs = false) {
    if (!res) return;
    if (res.fullName) document.getElementById('accStFullName').value = res.fullName;
    if (res.nationalIdNumber) {
      const nidEl = document.getElementById('accStNationalId');
      if (nidEl) nidEl.value = res.nationalIdNumber;
    }
    if (res.gender) document.getElementById('accStGender').value = res.gender;
    if (res.phone && !document.getElementById('accStPhone').value.trim()) {
      document.getElementById('accStPhone').value = res.phone;
    } else if (res.phone) {
      document.getElementById('accStPhone').value = res.phone;
    }
    if (res.region) {
      const regEl = document.getElementById('accStRegion');
      if ([...regEl.options].some((o) => o.value === res.region)) regEl.value = res.region;
    }
    if (res.city) document.getElementById('accStCity').value = res.city;
    if (res.address) document.getElementById('accStAddress').value = res.address;

    const noteParts = [];
    if (res.documentType) noteParts.push(`${res.documentType} verified`);
    if (res.nationalIdNumber) noteParts.push(`ID: ${res.nationalIdNumber}`);
    if (res.fullNameAmharic) noteParts.push(`Amharic: ${res.fullNameAmharic}`);
    if (res.dateOfBirth) noteParts.push(`DOB: ${res.dateOfBirth}`);
    if (noteParts.length > 0) {
      document.getElementById('accDocsNote').value = noteParts.join(' · ');
    }

    if (attachDocs && Array.isArray(window.AppState?.accPendingDocs)) {
      const slots = [
        { key: 'accFaydaFront', label: 'fayda_id_front' },
        { key: 'accFaydaBack', label: 'fayda_id_back' },
      ];
      slots.forEach(({ key, label }) => {
        const fileObj = aiScanSlots[key];
        if (!fileObj || !fileObj.data) return;
        const approxBytes = Math.floor((fileObj.data.length * 3) / 4);
        if (approxBytes > 1.45 * 1024 * 1024) return;
        const fileName = `${label}_${Date.now()}.${fileObj.mimeType === 'application/pdf' ? 'pdf' : 'jpg'}`;
        if (window.AppState.accPendingDocs.length < 3) {
          window.AppState.accPendingDocs.push({
            fileName,
            mimeType: fileObj.mimeType,
            contentBase64: fileObj.data,
          });
        }
      });
      if (typeof window.renderAccDocChips === 'function') window.renderAccDocChips();
    }
  }

  function applyFaydaResultToAdminModal(res) {
    if (!res) return;
    if (res.fullName) document.getElementById('stFullName').value = res.fullName;
    if (res.nationalIdNumber) {
      const nidEl = document.getElementById('stNationalId');
      if (nidEl) nidEl.value = res.nationalIdNumber;
    }
    if (res.gender) document.getElementById('stGender').value = res.gender;
    if (res.phone) document.getElementById('stPhone').value = res.phone;
    if (res.region) {
      const regEl = document.getElementById('stRegion');
      if ([...regEl.options].some((o) => o.value === res.region)) regEl.value = res.region;
    }
    if (res.city) document.getElementById('stCity').value = res.city;
    if (res.address) document.getElementById('stAddress').value = res.address;
  }

  function renderFaydaSummaryHtml(res) {
    return `
      <div style="display:flex; justify-content:space-between; align-items:center; gap:8px; flex-wrap:wrap; margin-bottom:6px;">
        <strong>${esc(res.documentType || 'Fayda National ID')} ${res.isNationalIdDetected ? 'Verified' : '(Low Match — Check Details)'}</strong>
        ${formatConfidenceTag(res.confidence)}
      </div>
      <div style="display:grid; grid-template-columns:repeat(auto-fit, minmax(170px, 1fr)); gap:6px 12px;">
        <div><strong>Full Name:</strong> ${esc(res.fullName || '—')}</div>
        <div><strong>Amharic Name:</strong> ${esc(res.fullNameAmharic || '—')}</div>
        <div><strong>Fayda FCN/FIN:</strong> <span class="mono">${esc(res.nationalIdNumber || '—')}</span></div>
        <div><strong>Gender / DOB:</strong> ${esc(res.gender || '—')} ${res.dateOfBirth ? `/ ${esc(res.dateOfBirth)}` : ''}</div>
        <div><strong>Phone:</strong> <span class="mono">${esc(res.phone || '—')}</span></div>
        <div><strong>Region / City:</strong> ${esc(res.region || '—')} / ${esc(res.city || '—')}</div>
      </div>
      ${res.address ? `<div style="margin-top:4px;"><strong>Address:</strong> ${esc(res.address)}</div>` : ''}
      ${res.extractionNotes ? `<div style="margin-top:4px; color:#1e3a8a;"><strong>AI Notes:</strong> ${esc(res.extractionNotes)}</div>` : ''}
    `;
  }

  async function runFaydaScan({ frontFile, backFile, errorElId, resultElId, triggerBtn, onSuccess }) {
    showBoxError(errorElId, '');
    const resBox = document.getElementById(resultElId);
    if (!frontFile) {
      showBoxError(errorElId, 'Please upload or capture the front side (or digital PDF) of the Fayda National ID first.');
      return;
    }
    if (triggerBtn) triggerBtn.disabled = true;
    if (resBox) {
      resBox.style.display = 'block';
      resBox.innerHTML = '<strong>Scanning Fayda National ID with Gemini Vision...</strong>';
    }

    try {
      const data = await apiJson('/api/ai/scan-fayda-id', {
        method: 'POST',
        body: JSON.stringify({ frontFile, backFile }),
      });
      if (resBox) {
        resBox.innerHTML = renderFaydaSummaryHtml(data);
        resBox.style.display = 'block';
      }
      if (typeof onSuccess === 'function') onSuccess(data);
      showToast(
        data.isNationalIdDetected
          ? `Fayda ID extracted (${data.fullName || data.nationalIdNumber || 'Success'})`
          : 'Document scanned with warnings — please verify extracted fields.',
        data.isNationalIdDetected ? 'success' : 'error'
      );
    } catch (err) {
      if (resBox) resBox.style.display = 'none';
      showBoxError(errorElId, err.message || 'Fayda ID extraction failed.');
    } finally {
      if (triggerBtn) triggerBtn.disabled = false;
    }
  }

  // ==================== PAYMENT SLIP OCR ====================
  function renderSlipSummaryHtml(res) {
    return `
      <div style="display:flex; justify-content:space-between; align-items:center; gap:8px; flex-wrap:wrap; margin-bottom:6px;">
        <strong>${esc(res.providerOrBank || res.paymentMethod || 'Payment Slip')}</strong>
        ${formatConfidenceTag(res.confidence)}
      </div>
      <div style="display:grid; grid-template-columns:repeat(auto-fit, minmax(170px, 1fr)); gap:6px 12px;">
        <div><strong>Amount:</strong> <span class="mono">${fmtETB(res.amountPaid || 0)}</span></div>
        <div><strong>Method:</strong> ${esc(res.paymentMethod || 'Other')}</div>
        <div><strong>Date:</strong> <span class="mono">${esc(res.paymentDate || 'Not shown')}</span></div>
        <div><strong>Reference:</strong> <span class="mono">${esc(res.transactionReference || '—')}</span></div>
        <div><strong>Payer:</strong> ${esc(res.payerName || '—')}</div>
      </div>
      ${res.notes ? `<div style="margin-top:4px;"><strong>Notes:</strong> ${esc(res.notes)}</div>` : ''}
    `;
  }

  function applySlipToAdminForm(res) {
    if (!res) return;
    if (res.amountPaid > 0) {
      const amtEl = document.getElementById('payAmountInput');
      if (amtEl) {
        amtEl.value = Number(res.amountPaid).toFixed(2);
        amtEl.dispatchEvent(new Event('input', { bubbles: true }));
      }
    }
    if (res.paymentDate) {
      const dEl = document.getElementById('payDateInput');
      if (dEl) dEl.value = res.paymentDate;
    }
    if (res.paymentMethod) {
      const mEl = document.getElementById('payMethodSelect');
      if (mEl) mEl.value = res.paymentMethod;
    }
    if (res.transactionReference) {
      const rEl = document.getElementById('payReferenceInput');
      if (rEl) rEl.value = res.transactionReference;
    }
    const noteParts = [res.providerOrBank, res.payerName ? `Payer: ${res.payerName}` : ''].filter(Boolean);
    if (noteParts.length > 0) {
      const nEl = document.getElementById('payNotesInput');
      if (nEl && !nEl.value.trim()) nEl.value = noteParts.join(' · ');
    }
  }

  function applySlipToAccountantForm(res) {
    if (!res) return;
    if (res.amountPaid > 0) {
      const amtEl = document.getElementById('accPayAmountInput');
      if (amtEl) {
        amtEl.value = Number(res.amountPaid).toFixed(2);
        amtEl.dispatchEvent(new Event('input', { bubbles: true }));
      }
    }
    if (res.paymentDate) {
      const dEl = document.getElementById('accPayDateInput');
      if (dEl) dEl.value = res.paymentDate;
    }
    if (res.paymentMethod) {
      const mEl = document.getElementById('accPayMethodSelect');
      if (mEl) mEl.value = res.paymentMethod;
    }
    if (res.transactionReference) {
      const rEl = document.getElementById('accPayRefInput');
      if (rEl) rEl.value = res.transactionReference;
    }
    const noteParts = [res.providerOrBank, res.payerName ? `Payer: ${res.payerName}` : ''].filter(Boolean);
    if (noteParts.length > 0) {
      const nEl = document.getElementById('accPayNotesInput');
      if (nEl && !nEl.value.trim()) nEl.value = noteParts.join(' · ');
    }
  }

  async function runPaymentSlipOcr(filePayload, targetMode) {
    if (!filePayload) return;
    if (targetMode === 'hubSlip') {
      showBoxError('hubSlipErrorBox', '');
      const resBox = document.getElementById('hubSlipResultBox');
      const applyWrap = document.getElementById('hubSlipApplyWrap');
      if (resBox) {
        resBox.style.display = 'block';
        resBox.innerHTML = '<strong>Reading Telebirr / bank slip with Gemini Vision...</strong>';
      }
      if (applyWrap) applyWrap.style.display = 'none';
      try {
        const res = await apiJson('/api/ai/analyze-payment-slip', {
          method: 'POST',
          body: JSON.stringify({ file: filePayload }),
        });
        lastHubSlipResult = res;
        if (resBox) resBox.innerHTML = renderSlipSummaryHtml(res);
        if (applyWrap) applyWrap.style.display = 'block';
        showToast('Payment slip extracted successfully.', 'success');
      } catch (err) {
        if (resBox) resBox.style.display = 'none';
        showBoxError('hubSlipErrorBox', err.message || 'Slip OCR failed.');
      }
      return;
    }

    try {
      showToast('Scanning payment slip with Gemini AI...', 'success');
      const res = await apiJson('/api/ai/analyze-payment-slip', {
        method: 'POST',
        body: JSON.stringify({ file: filePayload }),
      });
      if (targetMode === 'adminPaySlip') applySlipToAdminForm(res);
      if (targetMode === 'accPaySlip') applySlipToAccountantForm(res);
      showToast(
        res.amountPaid > 0
          ? `Slip filled: ${fmtETB(res.amountPaid)} (${res.transactionReference || res.paymentMethod})`
          : 'Slip processed — verify extracted fields.',
        res.isPaymentDocument ? 'success' : 'error'
      );
    } catch (err) {
      showToast(err.message || 'Failed to read payment slip.', 'error');
    }
  }

  // ==================== LIVE CAMERA SCANNER ====================
  async function openCameraScanner(targetSlot) {
    activeCameraSlot = targetSlot;
    capturedCameraPayload = null;
    showBoxError('faydaCameraError', '');

    const titleMap = {
      accFaydaFront: 'Scan Fayda National ID — Front',
      accFaydaBack: 'Scan Fayda National ID — Back',
      adminFaydaFront: 'Scan Fayda National ID — Admin Quick Fill',
      hubFaydaFront: 'Scan Fayda National ID — Front',
      hubFaydaBack: 'Scan Fayda National ID — Back',
      adminPaySlip: 'Scan Telebirr / Bank Payment Slip',
      accPaySlip: 'Scan Telebirr / Bank Payment Slip',
      hubSlip: 'Scan Telebirr / Bank Payment Slip',
    };
    document.getElementById('faydaCameraTitle').textContent = titleMap[targetSlot] || 'Scan Document with Camera';

    const video = document.getElementById('faydaCameraVideo');
    const snap = document.getElementById('faydaCameraSnapshot');
    const capBtn = document.getElementById('faydaCameraCaptureBtn');
    const retBtn = document.getElementById('faydaCameraRetakeBtn');
    const useBtn = document.getElementById('faydaCameraUseBtn');

    video.style.display = 'block';
    snap.style.display = 'none';
    capBtn.style.display = 'inline-flex';
    retBtn.style.display = 'none';
    useBtn.style.display = 'none';

    openModal('faydaCameraModal');

    if (!navigator.mediaDevices || !navigator.mediaDevices.getUserMedia) {
      showBoxError('faydaCameraError', 'Camera access is not available in this browser context. Please use file Upload instead.');
      return;
    }

    try {
      cameraStream = await navigator.mediaDevices.getUserMedia({
        video: { facingMode: { ideal: 'environment' }, width: { ideal: 1600 }, height: { ideal: 1000 } },
        audio: false,
      });
      video.srcObject = cameraStream;
    } catch (err) {
      showBoxError('faydaCameraError', `Camera permission or device error: ${err.message || 'Unable to start camera.'}`);
    }
  }

  function stopCameraStream() {
    if (cameraStream) {
      cameraStream.getTracks().forEach((t) => t.stop());
      cameraStream = null;
    }
    const video = document.getElementById('faydaCameraVideo');
    if (video) video.srcObject = null;
  }

  function closeCameraScanner() {
    stopCameraStream();
    capturedCameraPayload = null;
    closeModal('faydaCameraModal');
  }

  function captureCameraSnapshot() {
    const video = document.getElementById('faydaCameraVideo');
    const canvas = document.getElementById('faydaCameraCanvas');
    const snap = document.getElementById('faydaCameraSnapshot');
    if (!video || !video.videoWidth) {
      showBoxError('faydaCameraError', 'Camera feed is not ready yet.');
      return;
    }

    const maxDim = 1500;
    let w = video.videoWidth;
    let h = video.videoHeight;
    if (w > maxDim || h > maxDim) {
      const ratio = Math.min(maxDim / w, maxDim / h);
      w = Math.round(w * ratio);
      h = Math.round(h * ratio);
    }

    canvas.width = w;
    canvas.height = h;
    canvas.getContext('2d').drawImage(video, 0, 0, w, h);

    const dataUrl = canvas.toDataURL('image/jpeg', 0.88);
    const base64 = dataUrl.split(',')[1] || '';
    capturedCameraPayload = {
      fileName: `camera_${activeCameraSlot}_${Date.now()}.jpg`,
      mimeType: 'image/jpeg',
      data: base64,
      previewUrl: dataUrl,
      byteSize: Math.floor((base64.length * 3) / 4),
    };

    snap.src = dataUrl;
    video.style.display = 'none';
    snap.style.display = 'block';
    document.getElementById('faydaCameraCaptureBtn').style.display = 'none';
    document.getElementById('faydaCameraRetakeBtn').style.display = 'inline-flex';
    document.getElementById('faydaCameraUseBtn').style.display = 'inline-flex';
  }

  function retakeCameraSnapshot() {
    capturedCameraPayload = null;
    document.getElementById('faydaCameraVideo').style.display = 'block';
    document.getElementById('faydaCameraSnapshot').style.display = 'none';
    document.getElementById('faydaCameraCaptureBtn').style.display = 'inline-flex';
    document.getElementById('faydaCameraRetakeBtn').style.display = 'none';
    document.getElementById('faydaCameraUseBtn').style.display = 'none';
  }

  async function confirmCameraSnapshot() {
    if (!capturedCameraPayload) return;
    const payload = capturedCameraPayload;
    const slot = activeCameraSlot;
    closeCameraScanner();

    if (slot === 'accFaydaFront') {
      aiScanSlots.accFaydaFront = payload;
      renderSlotPreview('accFaydaFrontPreview', payload, 'No file or snapshot selected yet.');
    } else if (slot === 'accFaydaBack') {
      aiScanSlots.accFaydaBack = payload;
      renderSlotPreview('accFaydaBackPreview', payload, 'Optional back side for Woreda/Region/FIN.');
    } else if (slot === 'hubFaydaFront') {
      aiScanSlots.hubFaydaFront = payload;
      renderSlotPreview('hubFaydaFrontPreview', payload, 'No file or snapshot selected.');
    } else if (slot === 'hubFaydaBack') {
      aiScanSlots.hubFaydaBack = payload;
      renderSlotPreview('hubFaydaBackPreview', payload, 'Optional back side for Woreda/Region/FIN.');
    } else if (slot === 'adminFaydaFront') {
      await runFaydaScan({
        frontFile: payload,
        backFile: null,
        errorElId: 'studentFormError',
        resultElId: 'adminFaydaStatusBox',
        onSuccess: applyFaydaResultToAdminModal,
      });
    } else if (slot === 'hubSlip') {
      aiScanSlots.hubSlip = payload;
      renderSlotPreview('hubSlipPreview', payload, 'Upload or scan a payment receipt to extract fields.');
      await runPaymentSlipOcr(payload, 'hubSlip');
    } else if (slot === 'adminPaySlip' || slot === 'accPaySlip') {
      await runPaymentSlipOcr(payload, slot);
    }
  }

  window.openCameraScanner = openCameraScanner;
  window.closeCameraScanner = closeCameraScanner;
  window.captureCameraSnapshot = captureCameraSnapshot;
  window.retakeCameraSnapshot = retakeCameraSnapshot;
  window.confirmCameraSnapshot = confirmCameraSnapshot;

  // ==================== TTS AUDIO & VOICE TRANSCRIPTION ====================
  async function speakTextWithTts(text, btnEl) {
    const clean = String(text || '').trim();
    if (!clean) return;
    const voiceName = document.getElementById('aiVoiceSelect')?.value || 'Kore';
    if (btnEl) btnEl.disabled = true;
    try {
      const res = await apiJson('/api/ai/tts', {
        method: 'POST',
        body: JSON.stringify({ text: clean, voiceName }),
      });
      if (activeAudioPlayer) {
        activeAudioPlayer.pause();
        activeAudioPlayer = null;
      }
      activeAudioPlayer = new Audio(`data:${res.mimeType || 'audio/wav'};base64,${res.audioBase64}`);
      await activeAudioPlayer.play();
      showToast(`Playing AI speech (${res.voiceName})`, 'success');
    } catch (err) {
      showToast(err.message || 'Could not generate speech audio.', 'error');
    } finally {
      if (btnEl) btnEl.disabled = false;
    }
  }

  async function blobToBase64(blob) {
    return new Promise((resolve, reject) => {
      const reader = new FileReader();
      reader.onload = () => resolve(String(reader.result || '').split(',')[1] || '');
      reader.onerror = () => reject(new Error('Failed to read audio stream.'));
      reader.readAsDataURL(blob);
    });
  }

  async function toggleMicRecording(targetMode, btnEl, errorBoxId) {
    if (activeRecorder && activeRecorder.state === 'recording') {
      activeRecorder.stop();
      return;
    }

    showBoxError(errorBoxId, '');
    if (!navigator.mediaDevices || !navigator.mediaDevices.getUserMedia || typeof MediaRecorder === 'undefined') {
      showBoxError(errorBoxId, 'Microphone recording is unavailable in this browser. Try uploading an audio file instead.');
      return;
    }

    try {
      activeRecorderStream = await navigator.mediaDevices.getUserMedia({ audio: true });
      const preferredMime = MediaRecorder.isTypeSupported('audio/webm') ? 'audio/webm' : '';
      activeRecorder = preferredMime ? new MediaRecorder(activeRecorderStream, { mimeType: preferredMime }) : new MediaRecorder(activeRecorderStream);
      activeRecorderChunks = [];
      activeRecorderTarget = targetMode;

      activeRecorder.ondataavailable = (e) => {
        if (e.data && e.data.size > 0) activeRecorderChunks.push(e.data);
      };

      activeRecorder.onstop = async () => {
        btnEl?.classList.remove('mic-recording');
        if (btnEl) {
          const span = btnEl.querySelector('span');
          if (span) span.textContent = targetMode === 'chat' ? 'Voice' : 'Record Microphone Note';
        }
        const mimeType = (activeRecorder?.mimeType || 'audio/webm').split(';')[0];
        if (activeRecorderStream) {
          activeRecorderStream.getTracks().forEach((t) => t.stop());
          activeRecorderStream = null;
        }
        const blob = new Blob(activeRecorderChunks, { type: mimeType });
        activeRecorder = null;
        if (blob.size < 200) return;

        try {
          if (btnEl) btnEl.disabled = true;
          const base64 = await blobToBase64(blob);
          const res = await apiJson('/api/ai/transcribe', {
            method: 'POST',
            body: JSON.stringify({ file: { mimeType, data: base64 } }),
          });
          if (activeRecorderTarget === 'chat') {
            const input = document.getElementById('chatMessageInput');
            if (input) {
              input.value = input.value.trim() ? `${input.value.trim()} ${res.transcript}` : res.transcript;
              input.focus();
            }
          } else {
            const box = document.getElementById('hubAudioTranscript');
            if (box) box.value = res.transcript;
          }
          showToast('Audio note transcribed cleanly.', 'success');
        } catch (err) {
          showBoxError(errorBoxId, err.message || 'Voice transcription failed.');
        } finally {
          if (btnEl) btnEl.disabled = false;
        }
      };

      activeRecorder.start();
      btnEl?.classList.add('mic-recording');
      if (btnEl) {
        const span = btnEl.querySelector('span');
        if (span) span.textContent = 'Stop Recording';
      }
    } catch (err) {
      showBoxError(errorBoxId, `Microphone permission denied or unavailable: ${err.message}`);
    }
  }

  // ==================== STREAMING & FUNCTION-CALLING CHAT ====================
  function renderEnhancedChatThread() {
    const thread = document.getElementById('chatThread');
    if (!thread || !window.AppState) return;

    if (!AppState.chatHistory || AppState.chatHistory.length === 0) {
      thread.innerHTML = `
        <div class="chat-msg model">
          <div class="chat-msg-meta">Zacma Gemini AI Assistant</div>
          <div class="chat-bubble">Selam! Ask me to look up live students, overdue ETB balances, courses, or pending approval queues using real-time MySQL function calling — or switch roles for bilingual SMS drafting and Google Search policy research.</div>
        </div>
      `;
      return;
    }

    thread.innerHTML = AppState.chatHistory
      .map((m, idx) => {
        const isUser = m.role === 'user';
        const who = isUser ? (AppState.user ? AppState.user.fullName : 'You') : m.roleLabel || 'Zacma AI Assistant';

        const toolHtml =
          !isUser && Array.isArray(m.toolsUsed) && m.toolsUsed.length > 0
            ? `<div class="chat-tool-badges">${m.toolsUsed.map((t) => `<span class="chat-tool-badge">tool: ${esc(t)}</span>`).join('')}</div>`
            : '';

        const sourcesHtml =
          !isUser && Array.isArray(m.sources) && m.sources.length > 0
            ? `<div class="ai-sources-list">${m.sources
                .map(
                  (s) =>
                    `<a class="ai-source-link" href="${esc(s.uri)}" target="_blank" rel="noopener noreferrer">${esc(s.title)}</a>`
                )
                .join('')}</div>`
            : '';

        const ttsBtnHtml =
          !isUser && m.text
            ? `<div class="chat-msg-actions"><button type="button" class="btn btn-secondary btn-xs chat-tts-btn" data-msg-idx="${idx}">Listen (TTS)</button></div>`
            : '';

        return `
          <div class="chat-msg ${isUser ? 'user' : 'model'}">
            <div class="chat-msg-meta">${esc(who)}</div>
            <div class="chat-bubble">${toolHtml}${esc(m.text || (m.streaming ? 'Thinking...' : ''))}${sourcesHtml}</div>
            ${ttsBtnHtml}
          </div>
        `;
      })
      .join('');

    thread.querySelectorAll('.chat-tts-btn').forEach((btn) => {
      btn.addEventListener('click', () => {
        const msg = AppState.chatHistory[Number(btn.dataset.msgIdx)];
        if (msg && msg.text) speakTextWithTts(msg.text, btn);
      });
    });

    thread.scrollTop = thread.scrollHeight;
  }

  async function submitEnhancedChatMessage(text) {
    const clean = String(text || '').trim();
    if (!clean || !window.AppState || AppState.chatBusy) return;

    const errBox = document.getElementById('chatErrorBox');
    if (errBox) errBox.style.display = 'none';

    const roleId = document.getElementById('chatRoleSelect')?.value || 'fee_advisor';
    const useStream = Boolean(document.getElementById('chatStreamToggle')?.checked);
    const priorHistory = AppState.chatHistory.map((m) => ({ role: m.role, text: m.text }));

    AppState.chatHistory.push({ role: 'user', text: clean });
    const modelIndex = AppState.chatHistory.length;
    AppState.chatHistory.push({
      role: 'model',
      text: '',
      roleLabel: document.getElementById('chatRoleSelect')?.selectedOptions[0]?.textContent || 'Zacma AI Assistant',
      toolsUsed: [],
      sources: [],
      streaming: true,
    });
    AppState.chatBusy = true;
    renderEnhancedChatThread();

    const sendBtn = document.getElementById('chatSendBtn');
    if (sendBtn) sendBtn.disabled = true;

    let finalReplyObj = null;

    try {
      if (useStream) {
        const token = typeof getToken === 'function' ? getToken() : '';
        const res = await fetch('/api/chat/stream', {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            ...(token ? { Authorization: `Bearer ${token}` } : {}),
          },
          body: JSON.stringify({ message: clean, history: priorHistory, roleId }),
        });

        if (res.status === 401 && typeof window.handleSessionExpired === 'function') {
          window.handleSessionExpired();
          throw new Error('Session expired.');
        }

        if (!res.ok || !res.body) {
          const errJson = await res.json().catch(() => ({}));
          throw new Error(errJson.error || `Stream failed (${res.status})`);
        }

        const reader = res.body.getReader();
        const decoder = new TextDecoder();
        let buffer = '';
        let currentEvent = 'message';

        while (true) {
          const { value, done } = await reader.read();
          if (done) break;
          buffer += decoder.decode(value, { stream: true });
          const lines = buffer.split(/\r?\n/);
          buffer = lines.pop() || '';

          for (const line of lines) {
            if (line.startsWith('event:')) {
              currentEvent = line.slice(6).trim();
            } else if (line.startsWith('data:')) {
              const payloadStr = line.slice(5).trim();
              if (!payloadStr) continue;
              let payload = {};
              try {
                payload = JSON.parse(payloadStr);
              } catch {
                continue;
              }
              const target = AppState.chatHistory[modelIndex];
              if (!target) continue;

              if (currentEvent === 'tool' && payload.name) {
                if (!target.toolsUsed.includes(payload.name)) {
                  target.toolsUsed.push(payload.name);
                  renderEnhancedChatThread();
                }
              } else if (currentEvent === 'chunk' && payload.text) {
                target.text += payload.text;
                renderEnhancedChatThread();
              } else if (currentEvent === 'done') {
                finalReplyObj = payload;
                target.text = payload.reply || target.text;
                target.roleLabel = payload.roleLabel || target.roleLabel;
                target.toolsUsed = payload.toolsUsed || target.toolsUsed;
                target.sources = payload.sources || [];
                target.streaming = false;
              } else if (currentEvent === 'error') {
                throw new Error(payload.error || 'Streaming failed.');
              }
            }
          }
        }
      } else {
        const res = await apiJson('/api/chat/message', {
          method: 'POST',
          body: JSON.stringify({ message: clean, history: priorHistory, roleId }),
        });
        finalReplyObj = res;
        AppState.chatHistory[modelIndex] = {
          role: 'model',
          text: res.reply,
          roleLabel: res.roleLabel || 'Zacma AI Assistant',
          toolsUsed: res.toolsUsed || [],
          sources: res.sources || [],
          streaming: false,
        };
      }

      if (window.BirrFirebase && window.BirrFirebase.getCurrentUser() && window.BirrFirebase.saveChatMessageToFirestore && finalReplyObj) {
        window.BirrFirebase
          .saveChatMessageToFirestore({
            role: 'user',
            assistantRoleId: roleId,
            content: clean,
            modelUsed: finalReplyObj.model || 'gemini-4-hydrogen',
          })
          .then(() =>
            window.BirrFirebase.saveChatMessageToFirestore({
              role: 'model',
              assistantRoleId: finalReplyObj.roleLabel || roleId,
              content: finalReplyObj.reply || AppState.chatHistory[modelIndex]?.text || '',
              modelUsed: finalReplyObj.model || 'gemini-4-hydrogen',
            })
          )
          .catch(() => {});
      }
    } catch (err) {
      AppState.chatHistory.splice(modelIndex, 1);
      AppState.chatHistory.pop();
      if (errBox) {
        errBox.textContent = err.message || 'Failed to get assistant response.';
        errBox.style.display = 'block';
      }
    } finally {
      AppState.chatBusy = false;
      if (sendBtn) sendBtn.disabled = false;
      renderEnhancedChatThread();
    }
  }

  // ==================== STATUS & INIT ====================
  async function loadAiSuiteStatus() {
    const badge = document.getElementById('aiStatusIndicator');
    if (!badge) return;
    try {
      const status = await apiJson('/api/ai/status');
      if (status.configured) {
        badge.className = 'status-tag status-paid';
        badge.textContent = `Gemini Ready (${status.models?.reasoningAndVision || 'gemini-4-hydrogen'})`;
      } else {
        badge.className = 'status-tag status-danger';
        badge.textContent = 'Gemini API Key Missing in Settings > Secrets';
      }
    } catch {
      badge.className = 'status-tag status-neutral';
      badge.textContent = 'AI Status Unavailable';
    }
  }

  function applyPendingFaydaIfAny(mode) {
    if (!window.BirrAiPendingFayda) return;
    const data = window.BirrAiPendingFayda;
    window.BirrAiPendingFayda = null;
    if (mode === 'accountant') {
      applyFaydaResultToAccountantForm(data, false);
      const resBox = document.getElementById('accFaydaResultBox');
      if (resBox) {
        resBox.innerHTML = renderFaydaSummaryHtml(data);
        resBox.style.display = 'block';
      }
    } else if (mode === 'admin') {
      applyFaydaResultToAdminModal(data);
      const resBox = document.getElementById('adminFaydaStatusBox');
      if (resBox) {
        resBox.innerHTML = renderFaydaSummaryHtml(data);
        resBox.style.display = 'block';
      }
    }
  }

  function applyPendingSlipIfAny(mode) {
    if (!window.BirrAiPendingSlip) return;
    const data = window.BirrAiPendingSlip;
    window.BirrAiPendingSlip = null;
    if (mode === 'admin') applySlipToAdminForm(data);
    if (mode === 'accountant') applySlipToAccountantForm(data);
  }

  function bindAiEventListeners() {
    // 1. AI Suite Tabs
    document.querySelectorAll('#aiSuiteTabs .tab-btn').forEach((btn) => {
      btn.addEventListener('click', () => {
        const tab = btn.dataset.aitab;
        document.querySelectorAll('#aiSuiteTabs .tab-btn').forEach((b) => b.classList.toggle('active', b === btn));
        document.querySelectorAll('.ai-tool-panel').forEach((p) => p.classList.toggle('active', p.id === `aiTab-${tab}`));
      });
    });

    // 2. Accountant Fayda Inputs & Buttons
    document.getElementById('accFaydaFrontInput')?.addEventListener('change', async (e) => {
      const file = e.target.files?.[0];
      if (!file) return;
      try {
        aiScanSlots.accFaydaFront = await readFileAsAiPayload(file);
        renderSlotPreview('accFaydaFrontPreview', aiScanSlots.accFaydaFront, 'No file or snapshot selected yet.');
        showBoxError('accFaydaErrorBox', '');
      } catch (err) {
        showBoxError('accFaydaErrorBox', err.message);
      }
      e.target.value = '';
    });

    document.getElementById('accFaydaBackInput')?.addEventListener('change', async (e) => {
      const file = e.target.files?.[0];
      if (!file) return;
      try {
        aiScanSlots.accFaydaBack = await readFileAsAiPayload(file);
        renderSlotPreview('accFaydaBackPreview', aiScanSlots.accFaydaBack, 'Optional back side for Woreda/Region/FIN.');
        showBoxError('accFaydaErrorBox', '');
      } catch (err) {
        showBoxError('accFaydaErrorBox', err.message);
      }
      e.target.value = '';
    });

    document.getElementById('accFaydaExtractBtn')?.addEventListener('click', () => {
      const autoAttach = Boolean(document.getElementById('accFaydaAutoAttach')?.checked);
      runFaydaScan({
        frontFile: aiScanSlots.accFaydaFront,
        backFile: aiScanSlots.accFaydaBack,
        errorElId: 'accFaydaErrorBox',
        resultElId: 'accFaydaResultBox',
        triggerBtn: document.getElementById('accFaydaExtractBtn'),
        onSuccess: (data) => applyFaydaResultToAccountantForm(data, autoAttach),
      });
    });

    document.getElementById('accFaydaClearBtn')?.addEventListener('click', () => {
      aiScanSlots.accFaydaFront = null;
      aiScanSlots.accFaydaBack = null;
      renderSlotPreview('accFaydaFrontPreview', null, 'No file or snapshot selected yet.');
      renderSlotPreview('accFaydaBackPreview', null, 'Optional back side for Woreda/Region/FIN.');
      showBoxError('accFaydaErrorBox', '');
      const resBox = document.getElementById('accFaydaResultBox');
      if (resBox) resBox.style.display = 'none';
    });

    document.getElementById('accAiRecommendCourseBtn')?.addEventListener('click', async () => {
      const profile = await askReasonModal({
        title: 'AI Course & Payment Plan Recommender',
        message: 'Describe the applicant background, career interest, schedule availability, or monthly ETB budget.',
        label: 'Applicant Profile & Budget *',
        placeholder: 'e.g., High school graduate interested in coding/web apps, can pay 2,000 ETB/month',
        okLabel: 'Recommend Course',
        danger: false,
        required: true,
      });
      if (!profile) return;

      const btn = document.getElementById('accAiRecommendCourseBtn');
      const resBox = document.getElementById('accFaydaResultBox');
      if (btn) btn.disabled = true;
      showBoxError('accFaydaErrorBox', '');
      try {
        const rec = await apiJson('/api/ai/recommend-course', {
          method: 'POST',
          body: JSON.stringify({ applicantProfile: profile }),
        });
        const crsSel = document.getElementById('accCourseId');
        if (crsSel && [...crsSel.options].some((o) => o.value === rec.recommendedCourseId)) {
          crsSel.value = rec.recommendedCourseId;
          crsSel.dispatchEvent(new Event('change', { bubbles: true }));
        }
        const planSel = document.getElementById('accPlanCode');
        if (planSel && [...planSel.options].some((o) => o.value === rec.recommendedPlanCode)) {
          planSel.value = rec.recommendedPlanCode;
        }
        if (resBox) {
          resBox.style.display = 'block';
          resBox.innerHTML = `
            <strong>AI Course Recommendation:</strong> ${esc(rec.recommendedCourseName)} &middot; Plan: <span class="mono">${esc(rec.recommendedPlanCode)}</span>
            ${rec.suggestedInitialDepositEtb ? ` &middot; Suggested Initial Deposit: <span class="mono">${fmtETB(rec.suggestedInitialDepositEtb)}</span>` : ''}
            <div style="margin-top:4px;">${esc(rec.rationale)}</div>
          `;
        }
        showToast(`Selected recommended course: ${rec.recommendedCourseName}`, 'success');
      } catch (err) {
        showBoxError('accFaydaErrorBox', err.message || 'Course recommendation failed.');
      } finally {
        if (btn) btn.disabled = false;
      }
    });

    // 3. Admin Modal Fayda Auto-Fill
    document.getElementById('adminFaydaFileInput')?.addEventListener('change', async (e) => {
      const file = e.target.files?.[0];
      e.target.value = '';
      if (!file) return;
      try {
        const payload = await readFileAsAiPayload(file);
        await runFaydaScan({
          frontFile: payload,
          backFile: null,
          errorElId: 'studentFormError',
          resultElId: 'adminFaydaStatusBox',
          onSuccess: applyFaydaResultToAdminModal,
        });
      } catch (err) {
        showBoxError('studentFormError', err.message);
      }
    });

    // 4. Inline Payment Slip OCR (Admin + Accountant)
    document.getElementById('adminPaySlipFile')?.addEventListener('change', async (e) => {
      const file = e.target.files?.[0];
      e.target.value = '';
      if (!file) return;
      try {
        const payload = await readFileAsAiPayload(file);
        await runPaymentSlipOcr(payload, 'adminPaySlip');
      } catch (err) {
        showToast(err.message, 'error');
      }
    });

    document.getElementById('accPaySlipFile')?.addEventListener('change', async (e) => {
      const file = e.target.files?.[0];
      e.target.value = '';
      if (!file) return;
      try {
        const payload = await readFileAsAiPayload(file);
        await runPaymentSlipOcr(payload, 'accPaySlip');
      } catch (err) {
        showToast(err.message, 'error');
      }
    });

    // 5. AI Hub Fayda Workbench
    document.getElementById('hubFaydaFrontInput')?.addEventListener('change', async (e) => {
      const file = e.target.files?.[0];
      e.target.value = '';
      if (!file) return;
      try {
        aiScanSlots.hubFaydaFront = await readFileAsAiPayload(file);
        renderSlotPreview('hubFaydaFrontPreview', aiScanSlots.hubFaydaFront, 'No file or snapshot selected.');
        showBoxError('hubFaydaErrorBox', '');
      } catch (err) {
        showBoxError('hubFaydaErrorBox', err.message);
      }
    });

    document.getElementById('hubFaydaBackInput')?.addEventListener('change', async (e) => {
      const file = e.target.files?.[0];
      e.target.value = '';
      if (!file) return;
      try {
        aiScanSlots.hubFaydaBack = await readFileAsAiPayload(file);
        renderSlotPreview('hubFaydaBackPreview', aiScanSlots.hubFaydaBack, 'Optional back side for Woreda/Region/FIN.');
        showBoxError('hubFaydaErrorBox', '');
      } catch (err) {
        showBoxError('hubFaydaErrorBox', err.message);
      }
    });

    document.getElementById('hubFaydaExtractBtn')?.addEventListener('click', () => {
      runFaydaScan({
        frontFile: aiScanSlots.hubFaydaFront,
        backFile: aiScanSlots.hubFaydaBack,
        errorElId: 'hubFaydaErrorBox',
        resultElId: 'hubFaydaResultBox',
        triggerBtn: document.getElementById('hubFaydaExtractBtn'),
        onSuccess: (data) => {
          lastHubFaydaResult = data;
          const btn = document.getElementById('hubFaydaApplyRegBtn');
          if (btn) btn.style.display = 'inline-flex';
        },
      });
    });

    document.getElementById('hubFaydaApplyRegBtn')?.addEventListener('click', () => {
      if (!lastHubFaydaResult) return;
      window.BirrAiPendingFayda = lastHubFaydaResult;
      const isAdmin = window.AppState?.user?.role === 'admin';
      if (isAdmin) {
        navigateTo('students');
        setTimeout(() => {
          document.getElementById('openNewStudentBtn')?.click();
          applyPendingFaydaIfAny('admin');
        }, 80);
      } else {
        navigateTo('acc-register');
      }
    });

    // 6. AI Hub Payment Slip Workbench
    document.getElementById('hubSlipInput')?.addEventListener('change', async (e) => {
      const file = e.target.files?.[0];
      e.target.value = '';
      if (!file) return;
      try {
        aiScanSlots.hubSlip = await readFileAsAiPayload(file);
        renderSlotPreview('hubSlipPreview', aiScanSlots.hubSlip, 'Upload or scan a payment receipt to extract fields.');
        await runPaymentSlipOcr(aiScanSlots.hubSlip, 'hubSlip');
      } catch (err) {
        showBoxError('hubSlipErrorBox', err.message);
      }
    });

    document.getElementById('hubSlipApplyBtn')?.addEventListener('click', () => {
      if (!lastHubSlipResult) return;
      window.BirrAiPendingSlip = lastHubSlipResult;
      const isAdmin = window.AppState?.user?.role === 'admin';
      navigateTo(isAdmin ? 'record-payment' : 'acc-submit-payment');
    });

    // 7. Chat Voice Mic + Composer + Clear + Quick Prompts
    document.getElementById('chatVoiceRecordBtn')?.addEventListener('click', () => {
      toggleMicRecording('chat', document.getElementById('chatVoiceRecordBtn'), 'chatErrorBox');
    });

    document.getElementById('chatComposerForm')?.addEventListener('submit', (e) => {
      e.preventDefault();
      const input = document.getElementById('chatMessageInput');
      const val = input ? input.value : '';
      if (input) input.value = '';
      submitEnhancedChatMessage(val);
    });

    document.getElementById('chatMessageInput')?.addEventListener('keydown', (e) => {
      if (e.key === 'Enter' && !e.shiftKey) {
        e.preventDefault();
        document.getElementById('chatComposerForm')?.requestSubmit();
      }
    });

    document.querySelectorAll('.chat-prompt-chip').forEach((chip) => {
      chip.addEventListener('click', () => submitEnhancedChatMessage(chip.dataset.prompt || ''));
    });

    document.getElementById('clearChatBtn')?.addEventListener('click', () => {
      if (window.AppState) AppState.chatHistory = [];
      showBoxError('chatErrorBox', '');
      if (window.BirrFirebase && window.BirrFirebase.getCurrentUser() && window.BirrFirebase.clearChatMessagesFromFirestore) {
        window.BirrFirebase.clearChatMessagesFromFirestore().catch(() => {});
      }
      renderEnhancedChatThread();
    });

    // 8. Grounded Web & URL Context Research
    document.getElementById('aiResearchForm')?.addEventListener('submit', async (e) => {
      e.preventDefault();
      const query = document.getElementById('aiResearchQuery')?.value.trim();
      const rawUrls = document.getElementById('aiResearchUrls')?.value || '';
      const urls = rawUrls
        .split(/\r?\n/)
        .map((s) => s.trim())
        .filter(Boolean);
      const btn = document.getElementById('aiResearchBtn');
      const out = document.getElementById('aiResearchOutput');
      showBoxError('aiResearchError', '');
      if (btn) btn.disabled = true;
      if (out) out.style.display = 'none';

      try {
        const res = await apiJson('/api/ai/research', {
          method: 'POST',
          body: JSON.stringify({ query, urls }),
        });
        if (out) {
          const srcHtml =
            res.sources && res.sources.length > 0
              ? `<div class="ai-sources-list">${res.sources
                  .map(
                    (s) =>
                      `<a class="ai-source-link" href="${esc(s.uri)}" target="_blank" rel="noopener noreferrer">${esc(s.title)}</a>`
                  )
                  .join('')}</div>`
              : '';
          out.innerHTML = `
            <div class="ai-result-box" style="background:var(--bg-subtle); border-color:var(--border-strong); color:var(--text-primary);">
              <div style="display:flex; justify-content:space-between; align-items:center; margin-bottom:6px;">
                <span class="chat-tool-badge">Mode: ${esc(res.mode)}</span>
                <button type="button" class="btn btn-secondary btn-xs" id="aiResearchSpeakBtn">Listen (TTS)</button>
              </div>
              <div style="white-space:pre-wrap;">${esc(res.answer)}</div>
              ${srcHtml}
            </div>
          `;
          out.style.display = 'block';
          document.getElementById('aiResearchSpeakBtn')?.addEventListener('click', (ev) => {
            speakTextWithTts(res.answer, ev.currentTarget);
          });
        }
      } catch (err) {
        showBoxError('aiResearchError', err.message || 'Grounded research failed.');
      } finally {
        if (btn) btn.disabled = false;
      }
    });

    // 9. AI Bilingual SMS / WhatsApp Composer
    document.getElementById('aiSmsDraftForm')?.addEventListener('submit', async (e) => {
      e.preventDefault();
      const audienceLabel = document.getElementById('aiSmsAudience')?.value || 'Overdue Balance Students';
      const language = document.getElementById('aiSmsLanguage')?.value || 'English';
      const tone = document.getElementById('aiSmsTone')?.value || 'Polite';
      const customTopic = document.getElementById('aiSmsTopic')?.value.trim() || '';
      const btn = document.getElementById('aiSmsDraftBtn');
      const resWrap = document.getElementById('aiSmsDraftResult');
      const preview = document.getElementById('aiSmsDraftPreview');

      showBoxError('aiSmsDraftError', '');
      if (btn) btn.disabled = true;
      try {
        const res = await apiJson('/api/ai/draft-message', {
          method: 'POST',
          body: JSON.stringify({ audienceLabel, language, tone, customTopic }),
        });
        lastSmsDraft = res;
        if (preview) {
          preview.innerHTML = `
            <div><strong>${esc(res.title)}</strong></div>
            <div style="margin-top:6px; white-space:pre-wrap;">${esc(res.message)}</div>
          `;
        }
        if (resWrap) resWrap.style.display = 'flex';
      } catch (err) {
        showBoxError('aiSmsDraftError', err.message || 'Could not draft SMS.');
      } finally {
        if (btn) btn.disabled = false;
      }
    });

    document.getElementById('aiSmsSpeakBtn')?.addEventListener('click', () => {
      if (lastSmsDraft?.message) {
        speakTextWithTts(lastSmsDraft.message, document.getElementById('aiSmsSpeakBtn'));
      }
    });

    document.getElementById('aiSmsSendPortalBtn')?.addEventListener('click', () => {
      if (!lastSmsDraft || typeof window.openSendStudentMessageModal !== 'function') return;
      const aud = document.getElementById('aiSmsAudience')?.value || '';
      const targetMode = aud.includes('Overdue') ? 'overdue' : aud.includes('All') ? 'all' : 'single';
      window.openSendStudentMessageModal({
        targetMode,
        title: lastSmsDraft.title,
        message: lastSmsDraft.message,
      });
    });

    // 10. Executive Financial & Risk Briefing (Admin)
    document.getElementById('aiExecBriefingBtn')?.addEventListener('click', async () => {
      const btn = document.getElementById('aiExecBriefingBtn');
      const out = document.getElementById('aiExecOutput');
      showBoxError('aiExecError', '');
      if (btn) btn.disabled = true;
      try {
        const res = await apiJson('/api/ai/executive-briefing', { method: 'POST', body: JSON.stringify({}) });
        if (out) {
          out.innerHTML = `
            <div class="ai-result-box">
              <div style="display:flex; justify-content:space-between; align-items:center; gap:8px; flex-wrap:wrap; margin-bottom:8px;">
                <strong>${esc(res.headline)}</strong>
                <span class="status-tag status-paid">Health Score: ${Number(res.healthScore || 0)}/100</span>
              </div>
              <div style="margin-bottom:8px;">
                <strong>Key Financial &amp; Operational Insights:</strong>
                <ul style="margin:4px 0 0 18px;">${(res.keyInsights || []).map((k) => `<li>${esc(k)}</li>`).join('')}</ul>
              </div>
              <div style="margin-bottom:8px;">
                <strong>Recommended Immediate Actions:</strong>
                <ul style="margin:4px 0 0 18px;">${(res.immediateActions || []).map((a) => `<li>${esc(a)}</li>`).join('')}</ul>
              </div>
              ${
                res.spokenSummary
                  ? `<button type="button" class="btn btn-secondary btn-xs" id="aiExecSpeakBtn">Listen to Executive Briefing (TTS)</button>`
                  : ''
              }
            </div>
          `;
          out.style.display = 'flex';
          document.getElementById('aiExecSpeakBtn')?.addEventListener('click', (ev) => {
            speakTextWithTts(res.spokenSummary, ev.currentTarget);
          });
        }
      } catch (err) {
        showBoxError('aiExecError', err.message || 'Executive briefing failed.');
      } finally {
        if (btn) btn.disabled = false;
      }
    });

    // 11. Dedicated Audio Note Transcriber (Insights Tab)
    document.getElementById('hubVoiceRecordBtn')?.addEventListener('click', () => {
      toggleMicRecording('hub', document.getElementById('hubVoiceRecordBtn'), 'hubAudioError');
    });

    document.getElementById('hubAudioUploadInput')?.addEventListener('change', async (e) => {
      const file = e.target.files?.[0];
      e.target.value = '';
      if (!file) return;
      showBoxError('hubAudioError', '');
      if (file.size > 4.2 * 1024 * 1024) {
        showBoxError('hubAudioError', 'Audio file exceeds 4.2 MB limit.');
        return;
      }
      try {
        const base64 = await blobToBase64(file);
        const res = await apiJson('/api/ai/transcribe', {
          method: 'POST',
          body: JSON.stringify({ file: { mimeType: file.type || 'audio/mp3', data: base64 } }),
        });
        document.getElementById('hubAudioTranscript').value = res.transcript;
        showToast('Audio file transcribed successfully.', 'success');
      } catch (err) {
        showBoxError('hubAudioError', err.message || 'Audio transcription failed.');
      }
    });

    document.getElementById('hubTranscriptSendChatBtn')?.addEventListener('click', () => {
      const text = document.getElementById('hubAudioTranscript')?.value.trim();
      if (!text) return;
      document.querySelector('#aiSuiteTabs .tab-btn[data-aitab="chat"]')?.click();
      const input = document.getElementById('chatMessageInput');
      if (input) {
        input.value = text;
        input.focus();
      }
    });

    document.getElementById('hubTranscriptTtsBtn')?.addEventListener('click', () => {
      const text = document.getElementById('hubAudioTranscript')?.value.trim();
      if (text) speakTextWithTts(text, document.getElementById('hubTranscriptTtsBtn'));
    });
  }

  document.addEventListener('DOMContentLoaded', bindAiEventListeners);

  window.BirrAiTools = {
    loadAiSuiteStatus,
    renderEnhancedChatThread,
    applyPendingFaydaIfAny,
    applyPendingSlipIfAny,
    clearAdminScanPreview: () => {
      const box = document.getElementById('adminFaydaStatusBox');
      if (box) box.style.display = 'none';
    },
    clearAccountantScanPreview: () => {
      aiScanSlots.accFaydaFront = null;
      aiScanSlots.accFaydaBack = null;
      renderSlotPreview('accFaydaFrontPreview', null, 'No file or snapshot selected yet.');
      renderSlotPreview('accFaydaBackPreview', null, 'Optional back side for Woreda/Region/FIN.');
      showBoxError('accFaydaErrorBox', '');
      const resBox = document.getElementById('accFaydaResultBox');
      if (resBox) resBox.style.display = 'none';
    },
  };
})();
