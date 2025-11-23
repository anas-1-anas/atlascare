const PDFDocument = require('pdfkit');
const QRCode = require('qrcode');
const fs = require('fs');
const path = require('path');

async function generatePrescriptionPdf(prescription, options = {}) {
  const doc = new PDFDocument({ size: 'A4', margin: 48, info: { Title: 'AtlasCare Prescription', Author: 'AtlasCare' } });

  const chunks = [];
  doc.on('data', (d) => chunks.push(Buffer.from(d)));

  // Try to load AtlasCare logo from common roots
  let logoPath = null;
  const candidates = [
    path.resolve(__dirname, '..', '..', 'Logo-V2.png'),
    path.resolve(__dirname, '..', '..', 'Logo.png'),
    path.resolve(__dirname, '..', 'Logo-V2.png'),
    path.resolve(__dirname, '..', 'Logo.png'),
    path.resolve(process.cwd(), 'Logo-V2.png'),
    path.resolve(process.cwd(), 'Logo.png')
  ];
  for (const p of candidates) { if (!logoPath && fs.existsSync(p)) logoPath = p; }

  // Header with logo (left) and title/IDs (right) - invoice style alignment
  const headerTopY = doc.y;
  const pageWidth = doc.page.width;
  const leftMargin = 48;
  const rightMargin = 48;

  // Logo on left
  if (logoPath) {
    try { doc.image(logoPath, leftMargin, headerTopY, { width: 120 }); } catch (_) { }
  }

  // Title and IDs right-aligned
  const rightX = pageWidth - 240;
  try { doc.font('Helvetica-Bold'); } catch (_) { }
  doc.fontSize(26).fillColor('#1e40af').text('Medical', rightX, headerTopY, { width: 200, align: 'right', lineBreak: false });
  doc.fontSize(26).fillColor('#1e40af').text('Prescription', rightX, headerTopY + 28, { width: 200, align: 'right', lineBreak: false });
  try { doc.font('Helvetica'); } catch (_) { }
  const issuance = new Date(prescription.date || Date.now()).toLocaleString();
  doc.fontSize(9).fillColor('#374151').text(`ID: ${prescription.id || prescription.prescriptionId || 'N/A'}`, rightX, headerTopY + 60, { width: 200, align: 'right' });
  doc.fontSize(9).fillColor('#374151').text(`Date: ${issuance}`, rightX, headerTopY + 73, { width: 200, align: 'right' });

  // Horizontal divider
  doc.y = headerTopY + 95;
  doc.strokeColor('#1e40af').lineWidth(2).moveTo(leftMargin, doc.y).lineTo(pageWidth - rightMargin, doc.y).stroke();
  doc.moveDown(0.3);

  // Helper to draw titled section card with colors (fixed height to avoid double-drawing)
  const sectionCard = (title, draw, bgColor = '#f8fafc', borderColor = '#e2e8f0', titleColor = '#1e40af', minHeight = 50) => {
    doc.moveDown(0.2);
    const cardX = 48, cardW = doc.page.width - 96;
    const startY = doc.y;

    // Title with colored background
    doc.save();
    doc.rect(cardX, startY, cardW, 18).fill(titleColor);
    doc.fillColor('#ffffff').fontSize(10).text(title, cardX + 8, startY + 5);
    doc.restore();

    const titleH = 18;
    const boxY = startY + titleH;
    const innerPad = 8;

    // Draw background box
    doc.save();
    doc.roundedRect(cardX, boxY, cardW, minHeight, 8).fill(bgColor).stroke(borderColor);
    doc.restore();

    // Draw content once
    doc.fontSize(9).fillColor('#111827');
    const contentStartY = boxY + innerPad;
    doc.x = cardX + innerPad;
    doc.y = contentStartY;
    draw(cardX + innerPad, contentStartY, cardW - innerPad * 2);

    // Move cursor after card
    doc.y = boxY + minHeight + 2;
  };

  // Doctor block - compact height
  sectionCard('Doctor Information', () => {
    doc.text(`Name: Dr. ${prescription.doctor || 'Mohamed Rami'}`);
    doc.text(`Specialty: ${prescription.doctorSpecialty || 'Specialist in Internal Medicine'}`);
    doc.text(`Address: ${prescription.doctorAddress || '456 Medical Plaza, Casablanca, Morocco'}`);
    doc.text(`Contact: ${prescription.doctorPhone || '+212 5XX-XXXXXX'}`);
    doc.text(`Email: ${prescription.doctorEmail || 'dr.rami@atlascare.ma'}`);
    doc.text(`INPE: ${prescription.doctorINPE || 'DR-' + (prescription.nationalId || '009811233')}`);
  }, '#f0f9ff', '#1e40af', '#1e40af', 85);

  // Patient information block - compact height
  sectionCard('Patient Information', () => {
    doc.text(`Name: ${prescription.patientName || ''}`);
    if (prescription.patientId) doc.text(`ID: ${prescription.patientId}`);
    if (prescription.age) doc.text(`Age: ${prescription.age}`);
    if (prescription.patientEmail) doc.text(`Email: ${prescription.patientEmail}`);
  }, '#e0f2fe', '#1e40af', '#1e40af', 55);

  // Diagnosis block - compact height
  sectionCard('Diagnosis', () => {
    doc.text(prescription.diagnosis || 'N/A');
  }, '#dbeafe', '#1e40af', '#1e40af', 35);

  // Medications list block (each as its own colored card)
  doc.moveDown(0.2);
  // Section title with blue background
  const medTitleY = doc.y;
  doc.save();
  doc.rect(48, medTitleY, doc.page.width - 96, 18).fill('#1e40af');
  doc.fillColor('#ffffff').fontSize(10).text('Prescribed Medications', 48 + 8, medTitleY + 5);
  doc.restore();
  doc.y = medTitleY + 20;
  const items = Array.isArray(prescription.medications) ? prescription.medications : [];
  if (!items.length) {
    doc.moveDown(0.15).fontSize(10).fillColor('#111827').text('No medications');
  } else {
    items.forEach((m, idx) => {
      doc.moveDown(0.15);
      const cardX = 48, cardW = doc.page.width - 96;
      const innerPad = 8;
      const boxY = doc.y;

      // Calculate dynamic height based on content
      let contentHeight = 8; // Top padding

      // Medication name
      const nameText = `${idx + 1}. ${m.name || ''}`;
      contentHeight += 13; // Name line height
      contentHeight += 3; // Spacing

      // Dosage, duration, frequency
      const dosageText = [m.dosage && `${m.dosage} ${m.unit || ''}`].filter(Boolean).join(' ');
      const line1 = dosageText ? `Dosage: ${dosageText}` : null;
      const line2 = (m.duration ? `Duration: ${m.duration} ${m.durationUnit || ''}` : null);
      const line3 = (m.frequency ? `Frequency: ${m.frequency} time(s) per day` : null);
      if (line1) contentHeight += 11;
      if (line2) contentHeight += 11;
      if (line3) contentHeight += 11;

      // Instructions (calculate wrapped height)
      if (m.instructions && m.instructions.trim()) {
        contentHeight += 2; // Small spacing
        const instructionText = `Instructions: ${m.instructions}`;
        const instructionHeight = doc.heightOfString(instructionText, {
          width: cardW - (innerPad * 2),
          fontSize: 8
        });
        contentHeight += instructionHeight;
      }

      contentHeight += 6; // Bottom padding
      const cardH = Math.max(38, contentHeight); // Minimum 38px height

      // Blue gradient colors for medication cards
      const colors = ['#f0f9ff', '#e0f2fe', '#dbeafe', '#bfdbfe'];
      const borders = ['#1e40af', '#1e40af', '#1e40af', '#1e40af'];
      const bgColor = colors[idx % colors.length];
      const borderColor = borders[idx % borders.length];

      doc.save();
      doc.roundedRect(cardX, boxY, cardW, cardH, 8).fill(bgColor).stroke(borderColor);
      doc.restore();

      doc.fontSize(10).fillColor('#111827');
      doc.x = cardX + innerPad;
      doc.y = boxY + innerPad;

      doc.fontSize(10).fillColor('#1f2937').text(nameText);
      doc.moveDown(0.1);
      doc.fontSize(8).fillColor('#475569');

      if (line1) doc.text(line1);
      if (line2) doc.text(line2);
      if (line3) doc.text(line3);

      // Add instructions if available
      if (m.instructions && m.instructions.trim()) {
        doc.moveDown(0.05);
        doc.fontSize(7).fillColor('#6b7280').text(`Instructions: ${m.instructions}`, {
          width: cardW - (innerPad * 2),
          lineBreak: true
        });
      }

      doc.y = boxY + cardH;
    });
  }

  // QR code block bottom-right (compact size)
  console.log('[PDF] options object:', JSON.stringify(options));
  console.log('[PDF] options.qrData:', JSON.stringify(options.qrData));
  console.log('[PDF] prescription.id:', prescription.id);

  const qrPayload = options.qrData || { prescriptionId: prescription.id || prescription.prescriptionId };
  console.log('[PDF] Final QR Payload for prescription:', prescription.id, 'QR Data:', JSON.stringify(qrPayload));

  // Ensure we're using the correct format
  if (!qrPayload.t && !qrPayload.v) {
    console.error('[PDF] WARNING: QR payload missing topicID (t field)! Using fallback format.');
    console.error('[PDF] This QR code will NOT work with the pharmacist portal!');
  }

  const qrPng = await QRCode.toBuffer(JSON.stringify(qrPayload), { width: 80, margin: 1, color: { dark: '#000000', light: '#FFFFFF' } });
  doc.moveDown(0.2);
  const qrStartY = doc.y + 2;
  const qrX = doc.page.width - 48 - 80;
  doc.image(qrPng, qrX, qrStartY, { width: 80 });
  doc.fontSize(7).fillColor('#64748b').text('Scan to verify', qrX, qrStartY + 82, { width: 80, align: 'center' });

  // Footer - just draw it where we are
  doc.moveDown(0.2);
  const footerY = doc.y;
  doc.strokeColor('#e2e8f0').lineWidth(1).moveTo(leftMargin, footerY).lineTo(pageWidth - rightMargin, footerY).stroke();
  doc.fontSize(8).fillColor('#64748b').text('AtlasCare Medical Center • 123 Medical Street, Casablanca • contact@atlascare.ma', leftMargin, footerY + 8, { width: pageWidth - (leftMargin + rightMargin), align: 'center' });
  doc.fontSize(7).fillColor('#94a3b8').text('This prescription is electronically generated and valid without signature.', leftMargin, footerY + 22, { width: pageWidth - (leftMargin + rightMargin), align: 'center' });

  doc.end();
  await new Promise((resolve) => doc.on('end', resolve));
  return Buffer.concat(chunks);
}

module.exports = { generatePrescriptionPdf };

// Clean professional invoice report
async function generatePharmacistReport(payload) {
  const { doctor, patientName, patientId, patientEmail, age, pharmacistName, medications = [], id, date, diagnosis } = payload || {};
  const doc = new PDFDocument({ size: 'A4', margin: 40, info: { Title: 'AtlasCare Invoice', Author: 'AtlasCare' } });
  const chunks = [];
  doc.on('data', (d) => chunks.push(Buffer.from(d)));

  // Load logo
  let logoPath = null;
  const candidates = [
    path.resolve(__dirname, '..', '..', 'Logo-V2.png'),
    path.resolve(__dirname, '..', '..', 'Logo.png'),
    path.resolve(__dirname, '..', 'Logo-V2.png'),
    path.resolve(__dirname, '..', 'Logo.png'),
    path.resolve(process.cwd(), 'Logo-V2.png'),
    path.resolve(process.cwd(), 'Logo.png')
  ];
  for (const p of candidates) { if (!logoPath && fs.existsSync(p)) logoPath = p; }

  // Header with logo and title - improved alignment
  const headerY = 40;
  const leftX = 40;
  const pageWidth = doc.page.width;

  // Logo on left
  if (logoPath) {
    try { doc.image(logoPath, leftX, headerY, { width: 120 }); } catch (_) { }
  }

  // Title and details - right aligned
  const rightX = pageWidth - 200;
  try { doc.font('Helvetica-Bold'); } catch (_) { }
  doc.fontSize(32).fillColor('#15803d').text('INVOICE', rightX, headerY, { width: 160, align: 'right' });
  try { doc.font('Helvetica'); } catch (_) { }
  doc.fontSize(11).fillColor('#374151').text(`Invoice #: ${id || 'INV-20251027-001'}`, rightX, headerY + 45, { width: 160, align: 'right' });
  doc.fontSize(11).fillColor('#374151').text(`Date: ${new Date(date || Date.now()).toLocaleDateString()}`, rightX, headerY + 63, { width: 160, align: 'right' });

  // Divider line
  doc.moveDown(1);
  doc.y = headerY + 90;
  doc.strokeColor('#15803d').lineWidth(2).moveTo(leftX, doc.y).lineTo(pageWidth - leftX, doc.y).stroke();

  // Move down after header
  doc.y = headerY + 105;

  // Helper function for info cards - reduced spacing
  const infoCard = (title, content, startY) => {
    const cardX = leftX;
    const cardW = pageWidth - (leftX * 2);
    const cardH = content.length * 14 + 32; // Reduced: line height from 17 to 14, base from 40 to 32

    // Title bar - reduced height
    doc.save();
    doc.rect(cardX, startY, cardW, 20).fill('#15803d'); // Reduced from 24
    doc.fillColor('#ffffff').fontSize(11).text(title, cardX + 10, startY + 5); // Reduced from 12, offset from 7
    doc.restore();

    // Content box
    doc.save();
    doc.roundedRect(cardX, startY + 20, cardW, cardH - 20, 0, 4).fill('#f9fafb').stroke('#d1d5db'); // Adjusted from 24
    doc.restore();

    // Content text - reduced font and spacing
    doc.fontSize(9).fillColor('#111827'); // Reduced from 10
    let yOffset = startY + 28; // Reduced from 36
    content.forEach(line => {
      doc.text(line, cardX + 12, yOffset);
      yOffset += 14; // Reduced from 17
    });

    return cardH;
  };

  // Vertical stacked layout with cards - reduced spacing
  let currentY = doc.y;

  // Patient Info Card
  const patientContent = [
    `Name: ${patientName || 'Saad hassim'}`,
    `ID: ${patientId || 'M561419'}`,
    `Age: ${age || '28'}`,
    patientEmail ? `Email: ${patientEmail}` : null
  ].filter(Boolean);
  const patientCardH = infoCard('BILL TO:', patientContent, currentY);
  currentY += patientCardH + 8; // Reduced from 15

  // Doctor Info Card
  const doctorContent = [
    `Doctor: Dr. ${doctor || 'Mohamed Rami'}`,
    `Specialty: ${payload.doctorSpecialty || 'Specialist in Internal Medicine'}`,
    `Address: ${payload.doctorAddress || '456 Medical Plaza, Casablanca, Morocco'}`,
    `Contact: ${payload.doctorPhone || '+212 5XX-XXXXXX'}`,
    `Email: ${payload.doctorEmail || 'dr.rami@atlascare.ma'}`,
    `INPE: ${payload.doctorINPE || 'DR-' + (payload.nationalId || '009811233')}`,
    diagnosis ? `Diagnosis: ${diagnosis}` : null
  ].filter(Boolean);
  const doctorCardH = infoCard('PRESCRIBED BY:', doctorContent, currentY);
  currentY += doctorCardH + 8; // Reduced from 15

  // Pharmacist Info Card
  const pharmacistContent = [
    `Pharmacist: ${pharmacistName || 'Mr. Alami'}`,
    `Address: ${payload.pharmacistAddress || '123 Pharmacy Street, Casablanca, Morocco'}`,
    `Contact: ${payload.pharmacistPhone || '+212 5XX-XXXXXX'}`,
    `Email: ${payload.pharmacistEmail || 'alami.pharma@atlascare.health'}`,
    `INPE: ${payload.pharmacistINPE || 'PHARM-12345'}`
  ];
  const pharmacistCardH = infoCard('DISPENSED BY:', pharmacistContent, currentY);
  currentY += pharmacistCardH + 12; // Reduced from 20

  // Set doc.y for next section
  doc.y = currentY;

  // Load medicines data (use same data as frontend with CNOPS prices)
  let medicinesData = [];
  try {
    // Try to load from frontend data first (has CNOPS data with prices)
    medicinesData = require('../../frontend/src/data/medicines.json') || [];
  } catch (_) {
    try {
      // Fallback to backend data
      medicinesData = require('../data/medicines.json') || [];
    } catch (_) {
      medicinesData = [];
    }
  }

  // Helper functions for price and rate extraction (same logic as frontend)
  const normalizeKey = (key) => (key || '')
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, ' ')
    .trim();

  const pickRawField = (raw, candidates) => {
    if (!raw) return undefined;
    const candNorm = candidates.map(normalizeKey);
    for (const k of Object.keys(raw)) {
      if (candNorm.includes(normalizeKey(k))) {
        const v = raw[k];
        if (v !== undefined && v !== null && String(v).trim() !== '') return String(v).trim();
      }
    }
    return undefined;
  };

  const extractPrice = (obj) => {
    if (obj?.price) return obj.price;
    const raw = obj?.raw || obj?.sourceRaw || {};

    // Priority 1: Direct CNOPS price fields
    if (raw.PPV && raw.PPV > 0) return raw.PPV;
    if (raw.PRIX_BR && raw.PRIX_BR > 0) return raw.PRIX_BR;

    // Priority 2: Look for price fields by name
    const direct = pickRawField(raw, ['Prix public de vente', 'Prix public', 'Prix', 'PPP', 'PPA', 'Tarif', 'Price', 'PRIX', 'PRIX PUBLIC']);
    if (direct) return direct;

    // Priority 3: Heuristic search
    let best = null;
    for (const [k, v] of Object.entries(raw)) {
      const keyNorm = normalizeKey(k);
      if (!v && v !== 0) continue;
      const valStr = String(v);
      const numMatch = valStr.match(/\d+[\.,]?\d*/);
      if (!numMatch) continue;
      const num = parseFloat(numMatch[0].replace(',', '.'));
      if (isNaN(num)) continue;
      const isPriceKey = /(prix|price|tarif|ppa|ppp|montant)/.test(keyNorm);
      if (isPriceKey && num > 0 && num < 100000) { best = valStr; break; }
      if (!best && num > 0 && num < 100000) { best = valStr; }
    }
    return best || undefined;
  };

  const extractRate = (obj) => {
    if (obj?.reimbursementRate) return obj.reimbursementRate;
    const raw = obj?.raw || obj?.sourceRaw || {};

    // Priority 1: Direct CNOPS reimbursement rate field
    if (raw.TAUX_REMBOURSEMENT) return raw.TAUX_REMBOURSEMENT;

    // Priority 2: Look for rate fields by name
    const direct = pickRawField(raw, ['Taux de remboursement', 'Taux', 'Remboursement', 'Rate', 'Reimbursement rate', 'TAUX']);
    if (direct) return direct;

    // Priority 3: Heuristic search
    let best = null;
    for (const [k, v] of Object.entries(raw)) {
      const keyNorm = normalizeKey(k);
      if (!v && v !== 0) continue;
      const valStr = String(v);
      const pct = valStr.match(/\d{1,3}(?:\.\d+)?\s*%/);
      if (pct) { best = pct[0]; break; }
      const numMatch = valStr.match(/\b\d{1,3}(?:\.\d+)?\b/);
      if (!numMatch) continue;
      const num = parseFloat(numMatch[0]);
      const isRateKey = /(taux|rate|rembours)/.test(keyNorm);
      if (isRateKey && num >= 0 && num <= 100) { best = `${num}%`; break; }
      if (!best && num >= 0 && num <= 100) { best = `${num}%`; }
    }
    return best || undefined;
  };

  const getPriceNumber = (p) => {
    if (!p) return 0;
    const m = String(p).match(/\d+[\.,]?\d*/);
    if (!m) return 0;
    return parseFloat(m[0].replace(',', '.')) || 0;
  };

  const getRateNumber = (r) => {
    if (!r) return 0;
    const m = String(r).match(/\d+(?:\.\d+)?/);
    if (!m) return 0;
    const v = parseFloat(m[0]);
    return isNaN(v) ? 0 : Math.min(100, Math.max(0, v));
  };

  const getPrice = (med) => {
    // First try to find in medicinesData
    const found = medicinesData.find(x =>
      (x.code && med.code && x.code === med.code) ||
      (x.name && med.name && x.name.toLowerCase() === med.name.toLowerCase())
    );

    if (found) {
      const priceText = extractPrice(found);
      const price = getPriceNumber(priceText);
      if (price > 0) return price;
    }

    // If not found in medicinesData, try to extract price from the medication object itself
    // (in case it has CNOPS data attached)
    if (med) {
      const priceText = extractPrice(med);
      const price = getPriceNumber(priceText);
      if (price > 0) return price;
    }

    // Fallback: use a reasonable default price based on medication type
    const defaultPrice = 15; // Default 15 MAD for medications without price data
    console.log(`No price found for medication: ${med.name || 'Unknown'} (code: ${med.code || 'N/A'}), using default: ${defaultPrice} MAD`);
    return defaultPrice;
  };

  const getRate = (med) => {
    // First try to find in medicinesData
    const found = medicinesData.find(x =>
      (x.code && med.code && x.code === med.code) ||
      (x.name && med.name && x.name.toLowerCase() === med.name.toLowerCase())
    );

    if (found) {
      const rateText = extractRate(found);
      const rate = getRateNumber(rateText);
      if (rate >= 0) return rate; // Return even if 0
    }

    // If not found in medicinesData, try to extract rate from the medication object itself
    if (med) {
      const rateText = extractRate(med);
      const rate = getRateNumber(rateText);
      if (rate >= 0) return rate; // Return even if 0
    }

    // Fallback: 0% coverage if no rate data found
    console.log(`No rate found for medication: ${med.name || 'Unknown'} (code: ${med.code || 'N/A'}), using 0% coverage`);
    return 0;
  };

  // Table header - properly sized to fit page width
  const tableY = doc.y;
  const colX = 40;
  // pageWidth is already declared at line 222, reusing it
  const tableW = pageWidth - 80; // 515 points (40px margin on each side)
  const colNameW = 170; // Medication names
  const colDosageW = 60;
  const colDurationW = 70;
  const colPriceW = 70;
  const colCoverageW = 70;
  const colPatientW = 70;
  const colPad = 6; // Reduced padding for better fit

  doc.save();
  doc.roundedRect(colX, tableY, tableW, 30, 6).fill('#065f46');
  doc.restore();

  doc.fontSize(10).fillColor('#fff');
  doc.text('Medicaments', colX + colPad, tableY + 10, { width: colNameW - colPad * 2 });
  doc.text('DOSAGE', colX + colNameW + colPad, tableY + 10, { width: colDosageW - colPad * 2, align: 'left' });
  doc.text('DURATION', colX + colNameW + colDosageW + colPad, tableY + 10, { width: colDurationW - colPad * 2, align: 'left' });
  doc.text('PRICE', colX + colNameW + colDosageW + colDurationW + colPad, tableY + 10, { width: colPriceW - colPad * 2, align: 'right' });
  doc.text('COVER', colX + colNameW + colDosageW + colDurationW + colPriceW + colPad, tableY + 10, { width: colCoverageW - colPad * 2, align: 'right' });
  doc.text('PATIENT', colX + colNameW + colDosageW + colDurationW + colPriceW + colCoverageW + colPad, tableY + 10, { width: colPatientW - colPad * 2, align: 'right' });

  // Calculate totals
  let totalAmount = 0, totalCoverage = 0, totalPatientShare = 0;

  // Table rows with better spacing
  let tableCurrentY = tableY + 30; // start after header
  (medications || []).forEach((med, idx) => {
    const price = Number(getPrice(med) || 0);
    const rate = Number(getRate(med) || 0);
    const coverage = Number(((price * rate) / 100).toFixed(2));
    const patientPays = Number(Math.max(price - coverage, 0).toFixed(2));

    totalAmount += price;
    totalCoverage += coverage;
    totalPatientShare += patientPays;

    // Compute dynamic row height based on wrapped medication name
    const nameText = med.name || 'Unknown Medication';
    const nameHeight = doc.heightOfString(nameText, { width: colNameW - colPad * 2, align: 'left' });
    const rowH = Math.max(22, nameHeight + colPad * 2);
    const rowY = tableCurrentY;

    // Row background
    doc.save();
    doc.rect(colX, rowY, tableW, rowH).fill(idx % 2 === 0 ? '#f8fafc' : '#ffffff');
    doc.restore();

    // Row content with column widths and wrapping for name
    doc.fontSize(10).fillColor('#111827');
    doc.text(nameText, colX + colPad, rowY + colPad, { width: colNameW - colPad * 2, align: 'left' });
    doc.fillColor('#334155');
    doc.text(`${med.dosage || '1'} ${med.unit || 'mg'}`, colX + colNameW + colPad, rowY + colPad, { width: colDosageW - colPad * 2 });
    doc.text(`${med.duration || '30'} ${med.durationUnit || 'days'}`, colX + colNameW + colDosageW + colPad, rowY + colPad, { width: colDurationW - colPad * 2 });
    doc.fillColor('#0f766e');
    doc.text(`${price.toFixed(2)}`, colX + colNameW + colDosageW + colDurationW + colPad, rowY + colPad, { width: colPriceW - colPad * 2, align: 'right' });
    doc.fillColor('#059669');
    doc.text(`${Math.round(rate)}%`, colX + colNameW + colDosageW + colDurationW + colPriceW + colPad, rowY + colPad, { width: colCoverageW - colPad * 2, align: 'right' });
    doc.fillColor('#b91c1c');
    doc.text(`${patientPays.toFixed(2)}`, colX + colNameW + colDosageW + colDurationW + colPriceW + colCoverageW + colPad, rowY + colPad, { width: colPatientW - colPad * 2, align: 'right' });

    tableCurrentY += rowH;
  });

  // Move down after medications table - reduced spacing
  doc.y = tableCurrentY + 20; // Reduced from 40

  // Compact totals section - right aligned, compact
  const totalsX = 380;
  const totalsY = doc.y;
  const totalsBoxW = 190;

  // Create a compact box for totals - reduced height
  doc.save();
  doc.rect(totalsX, totalsY, totalsBoxW, 70).fill('#f8fafc').stroke('#e2e8f0'); // Reduced from 80
  doc.restore();

  // Title - reduced font size and spacing
  doc.fontSize(11).fillColor('#065f46').text('TOTAL SUMMARY', totalsX + 10, totalsY + 6, { width: totalsBoxW - 20 }); // Reduced from 12, offset from 8

  // Compact totals - reduced spacing
  doc.fontSize(9).fillColor('#333'); // Reduced from 10
  doc.text(`Total Amount: ${totalAmount.toFixed(2)} MAD`, totalsX + 10, totalsY + 23, { width: totalsBoxW - 20 }); // Reduced from 28
  doc.text(`Insurance Coverage: ${totalCoverage.toFixed(2)} MAD`, totalsX + 10, totalsY + 36, { width: totalsBoxW - 20 }); // Reduced from 43

  // Highlight total due - with reduced spacing
  doc.save();
  doc.rect(totalsX + 5, totalsY + 51, totalsBoxW - 10, 14).fill('#10b981'); // Reduced from 60, height from 15
  doc.fillColor('#ffffff').fontSize(10).text(`TOTAL DUE: ${totalPatientShare.toFixed(2)} MAD`, totalsX + 10, totalsY + 54, { width: totalsBoxW - 20, align: 'center' }); // Reduced from 11, offset from 63
  doc.restore();

  // Move down after totals - reduced spacing
  doc.y = totalsY + 70; // Reduced from 80

  // Footer - just draw it where we are with minimal spacing
  doc.moveDown(0.1); // Reduced from 0.3
  const invoiceFooterY = doc.y;
  doc.strokeColor('#15803d').lineWidth(1).moveTo(leftX, invoiceFooterY).lineTo(pageWidth - leftX, invoiceFooterY).stroke();
  doc.fontSize(8).fillColor('#666').text('AtlasCare Medical Center • 123 Medical Street, Casablanca • contact@atlascare.ma', leftX, invoiceFooterY + 6, { width: pageWidth - (leftX * 2), align: 'center' }); // Reduced from 9, offset from 10
  doc.fontSize(7).fillColor('#999').text('This invoice is electronically generated and valid without signature.', leftX, invoiceFooterY + 18, { width: pageWidth - (leftX * 2), align: 'center' }); // Reduced from 8, offset from 25

  doc.end();
  await new Promise((resolve) => doc.on('end', resolve));
  return Buffer.concat(chunks);
}

module.exports.generatePharmacistReport = generatePharmacistReport;


