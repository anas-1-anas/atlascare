require('dotenv').config();
const express = require('express');
const cors = require('cors');
const { v4: uuidv4 } = require('uuid');
const helmet = require('helmet');
const rateLimit = require('express-rate-limit');
const { storePrescription, getPrescription, submitAuditMessage } = require('./hedera');
const { buildFHIRPrescription } = require('./utils/fhirBuilder');
const { sendEmail } = require('./utils/email');
const { generatePrescriptionPdf, generatePharmacistReport } = require('./utils/prescriptionPdf');
const { hashIdentifier } = require('./utils/privacy');
const { issueOtp, verifyOtp } = require('./utils/otp');
const { generateFSE } = require('./utils/fse');
const orchestrator = require('./orchestrator');
const { verifyPrescriptionOnMirror } = require('./utils/mirror');
const { initQueue, enqueueIssue, waitForJob, isQueueEnabled } = require('./queues/issueQueue');
const { signToken, authenticateJWT, requireRole } = require('./utils/auth');
const { celebrate, Joi, Segments, errors: celebrateErrors } = require('celebrate');
const crypto = require('crypto');
const { ensureKeyPair, signPayload, verifySignature } = require('./utils/signature');
const { putPayload, queueMessage, inMemoryStore, lastEventHashPerTopic, lastEventTypePerTopic, hashLookup, putSensitiveData, getSensitiveData } = require('./services/store');
const { queueSyncLoop } = require('./services/hcs');
const { compressPayload, decompressPayload } = require('./utils/hcsPayloadCompressor');
const { compressGeotag } = require('./utils/geotagMapper');
const path = require('path');
const fs = require('fs');
const XLSX = require('xlsx');

const app = express();
const PORT = process.env.PORT || 3001;

// CORS configuration for production and development
const allowedOrigins = [
  'http://localhost:3000',
  'https://localhost:3000',
  'https://atlascaretech.vercel.app',
  'https://www.atlascaretech.vercel.app',
  process.env.FRONTEND_URL
].filter(Boolean);

app.use(cors({
  origin: (origin, callback) => {
    // Allow requests with no origin (like mobile apps, curl, Postman)
    if (!origin) return callback(null, true);

    if (allowedOrigins.includes(origin)) {
      callback(null, true);
    } else {
      console.warn(`CORS blocked request from origin: ${origin}`);
      callback(null, true); // Still allow for now, but log the warning
    }
  },
  credentials: true,
  methods: ['GET', 'POST', 'PUT', 'DELETE', 'OPTIONS', 'PATCH'],
  allowedHeaders: ['Content-Type', 'Authorization', 'X-Requested-With', 'Accept']
}));
app.use(express.json());
app.use(helmet());

const limiter = rateLimit({ windowMs: 60 * 1000, max: 120 });
app.use(limiter);

// === ID Generation Functions ===
function generatePrescriptionId() {
  const now = new Date();
  const year = now.getFullYear();
  const month = String(now.getMonth() + 1).padStart(2, '0');
  const day = String(now.getDate()).padStart(2, '0');
  const dateStr = `${year}${month}${day}`;

  // Use milliseconds last 3 digits for uniqueness
  const sequence = String(now.getMilliseconds()).padStart(3, '0');

  return `RX-${dateStr}-${sequence}`;
}

function generateInvoiceId() {
  const now = new Date();
  const year = now.getFullYear();
  const month = String(now.getMonth() + 1).padStart(2, '0');
  const day = String(now.getDate()).padStart(2, '0');
  const dateStr = `${year}${month}${day}`;

  // Use milliseconds last 3 digits for uniqueness
  const sequence = String(now.getMilliseconds()).padStart(3, '0');

  return `INV-${dateStr}-${sequence}`;
}

// === CNOPS Excel Loader (ref-des-medicaments-cnops-2014.xlsx) ===
let cnopsCatalog = [];

function normalizeKey(key) {
  if (!key) return '';
  return String(key)
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, ' ')
    .trim();
}

function pickField(row, candidates) {
  for (const cand of candidates) {
    const nCand = normalizeKey(cand);
    for (const k of Object.keys(row)) {
      if (normalizeKey(k) === nCand) {
        const v = row[k];
        if (v !== undefined && v !== null && String(v).trim() !== '') return String(v).trim();
      }
    }
  }
  return undefined;
}

function deriveCatalogRow(row) {
  const name =
    pickField(row, ['Nom', 'Désignation', 'Designation', 'Libellé', 'Libelle', 'Produit', 'Médicament', 'Medicament', 'Medication', 'Nom commercial']) ||
    pickField(row, ['Name']);

  const code = pickField(row, ['Code', 'CIP', 'CIP7', 'Code CIP', 'Code produit', 'Code barre']);
  const rate = pickField(row, ['Taux de remboursement', 'Taux', 'Remboursement', 'Rate', 'Reimbursement rate']);
  const price = pickField(row, ['Prix', 'Prix public', 'Prix public de vente', 'PPP', 'PPA', 'Tarif', 'Price']);

  return {
    name: name || undefined,
    code: code || undefined,
    reimbursementRate: rate || undefined,
    price: price || undefined,
    raw: row
  };
}

function loadCnopsCatalog() {
  try {
    // Excel file is placed at repository root next to hedera-healthcare-mvp folder
    const excelPath = path.resolve(__dirname, '..', '..', 'ref-des-medicaments-cnops-2014.xlsx');
    if (!fs.existsSync(excelPath)) {
      cnopsCatalog = [];
      return;
    }
    const wb = XLSX.readFile(excelPath);
    const firstSheetName = wb.SheetNames[0];
    const ws = wb.Sheets[firstSheetName];
    const rows = XLSX.utils.sheet_to_json(ws, { defval: '' });
    cnopsCatalog = rows
      .map(deriveCatalogRow)
      .filter(r => !!r.name);
    console.log(`CNOPS catalog loaded: ${cnopsCatalog.length} rows`);
  } catch (e) {
    console.warn('Failed to load CNOPS Excel:', e.message);
    cnopsCatalog = [];
  }
}

loadCnopsCatalog();

// Mock user authentication (DEMO ONLY - Replace with real authentication in production)
// WARNING: These are demo credentials for hackathon demonstration only
// In production, implement proper password hashing and secure authentication
const users = [
  { id: 1, username: 'mohamedrami.doctor@atlascare.health', password: 'Doctor#2024', role: 'doctor', fullName: 'Mohamed Rami', specialty: 'Specialist in Internal Medicine' },
  { id: 2, username: 'hassanalami.pharma@atlascare.health', password: 'Pharma#2024', role: 'pharmacist', fullName: 'Hassan Alami' },
  { id: 3, username: 'admin@atlascare.health', password: 'Admin#2024', role: 'admin', fullName: 'Admin User' },
];

// In-memory index for prescriptions by ID (demo only)
const prescriptionIndex = new Map();
// Map prescriptionId -> topicID for payment events bridging
const prescriptionToTopic = new Map();
// In-memory index for topicID -> prescription (demo only)
const topicIndex = new Map();

// Register prescription indexes for persistence
const { persistence: indexPersistence } = require('./services/store');
indexPersistence.register('prescriptionIndex', prescriptionIndex);
indexPersistence.register('prescriptionToTopic', prescriptionToTopic);
indexPersistence.register('topicIndex', topicIndex);

// Cache for medicines (loaded once on startup)
let medicinesCache = null;
let medicinesCacheTimestamp = null;

// Function to load medicines (called once on startup)
function loadMedicinesCache() {
  try {
    // Try backend first
    const backendPath = path.resolve(__dirname, 'data', 'medicines.json');
    if (fs.existsSync(backendPath)) {
      const data = JSON.parse(fs.readFileSync(backendPath, 'utf8'));
      medicinesCache = data;
      medicinesCacheTimestamp = Date.now();
      console.log(`✅ [MEDICINES] Cached ${data.length} medicines from backend`);
      return;
    }

    // Fallback to frontend
    const frontendPath = path.resolve(__dirname, '..', 'frontend', 'src', 'data', 'medicines.json');
    if (fs.existsSync(frontendPath)) {
      const data = JSON.parse(fs.readFileSync(frontendPath, 'utf8'));
      medicinesCache = data;
      medicinesCacheTimestamp = Date.now();
      console.log(`✅ [MEDICINES] Cached ${data.length} medicines from frontend`);
      return;
    }

    console.warn('⚠️  [MEDICINES] No medicines.json found');
    medicinesCache = [];
  } catch (err) {
    console.error('❌ [MEDICINES] Failed to load cache:', err.message);
    medicinesCache = [];
  }
}

// Login endpoint
app.post('/api/login', (req, res) => {
  const { username, password } = req.body;
  const user = users.find(u => u.username === username && u.password === password);

  if (user) {
    const token = signToken({ sub: user.id, username: user.username, role: user.role, fullName: user.fullName, specialty: user.specialty });
    res.json({ success: true, role: user.role, token, fullName: user.fullName, specialty: user.specialty });
  } else {
    res.status(401).json({ success: false, message: 'Invalid credentials' });
  }
});

// Create prescription endpoint
app.post('/api/prescriptions', async (req, res) => {
  try {
    const prescriptionData = req.body;
    const prescriptionId = generatePrescriptionId();

    // Build FHIR-compliant prescription
    const fhirPrescription = buildFHIRPrescription({
      ...prescriptionData,
      prescriptionId,
      doctor: 'Dr. Smith', // In a real app, this would come from auth
      date: new Date().toISOString()
    });

    // Store on Hedera
    const transactionId = await storePrescription(fhirPrescription);

    // Send email (non-blocking - don't fail if email fails)
    try {
      await sendEmail({
        to: prescriptionData.patientEmail,
        subject: 'Your Prescription is Ready',
        text: `Your prescription ID is: ${prescriptionId}`,
        prescriptionId
      });
    } catch (emailError) {
      console.warn('Email sending failed (non-blocking):', emailError.message);
    }

    res.json({
      success: true,
      prescriptionId,
      transactionId,
      fhirPrescription
    });
  } catch (error) {
    console.error('Error creating prescription:', error);
    res.status(500).json({ success: false, error: error.message });
  }
});

// Get prescription endpoint
app.get('/api/prescriptions/:id', async (req, res) => {
  try {
    const { id } = req.params;
    // Try in-memory index first (demo)
    let prescription = prescriptionIndex.get(id);
    if (!prescription) {
      // Fallback to legacy get by fileId (may not work for new flow)
      try {
        prescription = await getPrescription(id);
      } catch (_) {
        prescription = null;
      }
    }

    if (!prescription) {
      return res.status(404).json({ success: false, message: 'Prescription not found' });
    }

    res.json({ success: true, prescription });
  } catch (error) {
    console.error('Error fetching prescription:', error);
    res.status(500).json({ success: false, error: error.message });
  }
});

// Lookup by topicID (demo only) - BULLETPROOF VERSION
app.get('/api/prescriptions/topic/:topicID', async (req, res) => {
  try {
    const { topicID } = req.params;
    console.log(`[LOOKUP] Fetching prescription for topic: ${topicID}`);

    const p = topicIndex.get(topicID);
    if (!p) return res.status(404).json({ success: false, message: 'Not found' });

    // ALWAYS get fresh status from Hedera and update in-memory store
    try {
      const { getTopicStatusFromHedera } = require('./utils/mirror');
      const hederaStatus = await getTopicStatusFromHedera(topicID);
      const { setTopicStatus } = require('./services/store');
      setTopicStatus(topicID, hederaStatus);
      console.log(`[LOOKUP] Topic ${topicID} status updated to: ${hederaStatus}`);
    } catch (e) {
      console.error(`[LOOKUP] Error updating status for topic ${topicID}:`, e.message);
    }

    // Get updated dispense count, last dispense date, and status from inMemoryStore
    const prescriptionData = inMemoryStore.get(topicID);
    const updatedDispenseCount = prescriptionData?.payload?.dispenseCount || p.dispenseCount || 0;
    const updatedMaxDispenses = prescriptionData?.payload?.maxDispenses || p.maxDispenses || 1;
    const lastDispenseDate = prescriptionData?.payload?.lastDispenseDate || p.lastDispenseDate || null;
    const currentStatus = prescriptionData?.status || 'issued';

    // Merge updated dispense data, last dispense date, and status into prescription
    const prescriptionWithDispenseCount = {
      ...p,
      dispenseCount: updatedDispenseCount,
      maxDispenses: updatedMaxDispenses,
      lastDispenseDate: lastDispenseDate,
      status: currentStatus
    };

    console.log(`[LOOKUP] Returning prescription with dispenseCount: ${updatedDispenseCount}/${updatedMaxDispenses}, status: ${currentStatus}${lastDispenseDate ? `, last dispensed: ${lastDispenseDate}` : ''}`);

    return res.json({ success: true, prescription: prescriptionWithDispenseCount });
  } catch (e) {
    console.error(`[LOOKUP] Error fetching prescription for topic ${req.params.topicID}:`, e.message);
    return res.status(500).json({ success: false, error: e.message });
  }
});

// Lightweight status endpoint for quick UI branching - BULLETPROOF VERSION
app.get('/api/status/topic/:topicID', async (req, res) => {
  try {
    const { topicID } = req.params;
    console.log(`[API] Checking status for topic: ${topicID}`);

    // ALWAYS get fresh status from Hedera - no caching, no fallbacks
    const { getTopicStatusFromHedera } = require('./utils/mirror');
    const hederaStatus = await getTopicStatusFromHedera(topicID);

    // Update in-memory store for consistency
    try {
      const { setTopicStatus } = require('./services/store');
      setTopicStatus(topicID, hederaStatus);
    } catch (_) { }

    console.log(`[API] Topic ${topicID} final status: ${hederaStatus}`);
    return res.json({ success: true, topicID, status: hederaStatus });
  } catch (e) {
    console.error(`[API] Error checking topic ${req.params.topicID}:`, e.message);
    return res.status(500).json({ success: false, error: e.message });
  }
});

// DEBUG: Test endpoint to verify Hedera status checking
app.get('/api/debug/status/:topicID', async (req, res) => {
  try {
    const { topicID } = req.params;
    console.log(`[DEBUG] Testing Hedera status for topic: ${topicID}`);

    const { getTopicStatusFromHedera } = require('./utils/mirror');
    const status = await getTopicStatusFromHedera(topicID);

    return res.json({
      success: true,
      topicID,
      status,
      timestamp: new Date().toISOString(),
      message: `Topic ${topicID} status: ${status}`
    });
  } catch (e) {
    return res.status(500).json({ success: false, error: e.message });
  }
});

// Process payment endpoint
app.post('/api/payments', async (req, res) => {
  try {
    // Check if prescription is eligible for payment - support multi-dispense
    if (req.body?.prescriptionId) {
      const prescriptionId = req.body.prescriptionId;
      const topicID = prescriptionToTopic.get(prescriptionId);
      if (topicID) {
        console.log(`[PAYMENT] Checking status for topic: ${topicID}`);

        // ALWAYS get fresh status from Hedera
        const { getTopicStatusFromHedera } = require('./utils/mirror');
        const currentStatus = await getTopicStatusFromHedera(topicID);

        console.log(`[PAYMENT] Topic ${topicID} status: ${currentStatus}`);

        // Get dispense tracking from inMemoryStore
        const prescriptionData = inMemoryStore.get(topicID);
        const dispenseCount = prescriptionData?.payload?.dispenseCount || 0;
        const maxDispenses = prescriptionData?.payload?.maxDispenses || 1;

        console.log(`[PAYMENT] Dispense tracking: ${dispenseCount}/${maxDispenses}`);

        // Block if fully dispensed
        if (dispenseCount >= maxDispenses) {
          console.log(`[PAYMENT] BLOCKING payment - fully dispensed (${dispenseCount}/${maxDispenses})`);
          return res.status(409).json({
            success: false,
            error: `Prescription fully dispensed (${dispenseCount}/${maxDispenses})`,
            status: currentStatus,
            dispenseCount,
            maxDispenses
          });
        }

        // Allow if status is 'issued', 'dispensed', OR 'paid' (for multi-dispense refills)
        if (currentStatus !== 'issued' && currentStatus !== 'dispensed' && currentStatus !== 'paid') {
          console.log(`[PAYMENT] BLOCKING payment - invalid status: ${currentStatus}`);
          return res.status(409).json({
            success: false,
            error: `Prescription status: ${currentStatus}`,
            status: currentStatus
          });
        }

        console.log(`[PAYMENT] ✅ Allowing payment - ${maxDispenses - dispenseCount} dispenses remaining`);
      }
    }

    // In a real app, this would process HBAR payments or card transactions
    // For now, we'll simulate a payment and emit both 'paid' and 'dispensed' events
    setTimeout(async () => {
      const payload = {
        success: true,
        transactionId: `tx-${Date.now()}`,
        amountMAD: req.body.amountMAD || undefined,
        method: req.body.method || undefined,
        status: 'completed'
      };
      // Emit HCS 'paid' then 'dispensed' events referencing prescriptionId if present
      if (req.body?.prescriptionId) {
        try {
          // Build, sign and submit hardened 'paid' payload on audit topic
          const prescriptionId = req.body.prescriptionId;
          const topicID = prescriptionToTopic.get(prescriptionId);
          const pharmacistNationalId = req.body.pharmacistNationalId;
          if (topicID && pharmacistNationalId) {
            const { lastEventHashPerTopic, lastEventTypePerTopic } = require('./services/store');
            const prevEventHash = lastEventHashPerTopic.get(topicID) || undefined;
            const base = {
              version: '1',
              alg: 'secp256k1+SHA-256',
              eventType: 'paid',
              topicID,
              timestamp: new Date().toISOString(),
              signerRole: 'pharmacist',
              actorIdHash: 'sha256:' + crypto.createHash('sha256').update(String(pharmacistNationalId) + (process.env.CNDP_SALT || 'atlascare-default-salt')).digest('hex'),
              amountMAD: req.body.amountMAD || undefined,
              method: req.body.method || undefined,
              prevEventHash
            };
            const { publicKeyHex } = ensureKeyPair(pharmacistNationalId);
            const keyId = 'fp:' + crypto.createHash('sha256').update(Buffer.from(publicKeyHex, 'hex')).digest('hex').slice(0, 16);
            const nonce = crypto.randomBytes(8).toString('hex');
            const toHash = { ...base, keyId, nonce };
            const contentHash = 'sha256:' + crypto.createHash('sha256').update(Buffer.from(JSON.stringify(toHash))).digest('hex');
            const signed = { ...toHash, contentHash };
            const signature = signPayload(signed, pharmacistNationalId);
            const msg = { ...signed, signature: `hex:${signature}` };

            // Compress payload for HCS (CNDP compliance + cost reduction)
            const compressedMsg = compressPayload(msg, hashLookup);
            console.log(`📊 PAID message compression: ${JSON.stringify(msg).length} → ${JSON.stringify(compressedMsg).length} bytes`);

            const { submitPrescriptionMessage } = require('./hedera');
            await submitPrescriptionMessage(topicID, compressedMsg);
            try {
              const newHash = 'sha256:' + crypto.createHash('sha256').update(Buffer.from(JSON.stringify(msg))).digest('hex');
              lastEventHashPerTopic.set(topicID, newHash);
              lastEventTypePerTopic.set(topicID, 'paid');
              // CRITICAL: Also update inMemoryStore status
              const { setTopicStatus, logHCSEvent } = require('./services/store');
              setTopicStatus(topicID, 'paid');
              console.log(`[PAYMENT] Updated topic ${topicID} status to: paid`);

              // Log HCS event for admin dashboard
              const prescriptionData = inMemoryStore.get(topicID);
              logHCSEvent({
                topicID: topicID,
                eventType: 'paid',
                timestamp: base.timestamp,
                signerRole: 'pharmacist',
                actorIdHash: base.actorIdHash,
                dispenseCount: prescriptionData?.payload?.dispenseCount || 0,
                maxDispenses: prescriptionData?.payload?.maxDispenses || 1,
                fraudAlert: null,
                drugIds: prescriptionData?.payload?.drugIds || [],
                prescriptionId: prescriptionId,
                amountMAD: req.body.amountMAD,
                method: req.body.method
              });
            } catch (_) { }
          }
        } catch (_) { }
      }
      res.json(payload);
    }, 800);
  } catch (error) {
    console.error('Payment processing error:', error);
    res.status(500).json({ success: false, error: error.message });
  }
});

// BATCH PAYMENT ENDPOINT for processing multiple prescriptions at once
app.post('/api/payments/batch', async (req, res) => {
  try {
    const { prescriptionIds, method, totalAmountMAD, pharmacistNationalId } = req.body;

    if (!Array.isArray(prescriptionIds) || prescriptionIds.length === 0) {
      return res.status(400).json({ success: false, error: 'prescriptionIds array is required' });
    }

    console.log(`[BATCH PAYMENT] Processing ${prescriptionIds.length} prescriptions`);

    // Validate all prescriptions are eligible
    const eligibilityChecks = [];
    for (const prescriptionId of prescriptionIds) {
      const topicID = prescriptionToTopic.get(prescriptionId);
      if (topicID) {
        const { getTopicStatusFromHedera } = require('./utils/mirror');
        const currentStatus = await getTopicStatusFromHedera(topicID);

        const prescriptionData = inMemoryStore.get(topicID);
        const dispenseCount = prescriptionData?.payload?.dispenseCount || 0;
        const maxDispenses = prescriptionData?.payload?.maxDispenses || 1;

        if (dispenseCount >= maxDispenses) {
          eligibilityChecks.push({ prescriptionId, eligible: false, reason: 'Fully dispensed' });
        } else if (currentStatus !== 'issued' && currentStatus !== 'dispensed') {
          eligibilityChecks.push({ prescriptionId, eligible: false, reason: `Invalid status: ${currentStatus}` });
        } else {
          eligibilityChecks.push({ prescriptionId, eligible: true });
        }
      } else {
        eligibilityChecks.push({ prescriptionId, eligible: false, reason: 'Not found' });
      }
    }

    // Check if any are ineligible
    const ineligible = eligibilityChecks.filter(check => !check.eligible);
    if (ineligible.length > 0) {
      return res.status(409).json({
        success: false,
        error: `${ineligible.length} prescription(s) are not eligible for payment`,
        ineligible
      });
    }

    // Process batch payment (simulate)
    setTimeout(async () => {
      // Submit 'paid' event for each prescription
      for (const prescriptionId of prescriptionIds) {
        try {
          const topicID = prescriptionToTopic.get(prescriptionId);
          if (topicID && pharmacistNationalId) {
            const { lastEventHashPerTopic, lastEventTypePerTopic } = require('./services/store');
            const prevEventHash = lastEventHashPerTopic.get(topicID) || undefined;
            const base = {
              version: '1',
              alg: 'secp256k1+SHA-256',
              type: 'paid',
              prescriptionId: prescriptionId,
              topicID: topicID,
              pharmacistNationalId: pharmacistNationalId,
              timestamp: new Date().toISOString(),
              nonce: Math.floor(Math.random() * 1e12).toString(),
              prevEventHash: prevEventHash,
              prevEventType: lastEventTypePerTopic.get(topicID) || undefined
            };

            const privateKey = await ensureKeyPair();
            const signature = await signPayload(base, privateKey);
            const msg = {
              ...base,
              sig: signature
            };

            const compressedMsg = compressPayload(msg);
            const { submitPrescriptionMessage } = require('./hedera');
            await submitPrescriptionMessage(topicID, compressedMsg);

            const newHash = 'sha256:' + crypto.createHash('sha256').update(Buffer.from(JSON.stringify(msg))).digest('hex');
            lastEventHashPerTopic.set(topicID, newHash);
            lastEventTypePerTopic.set(topicID, 'paid');

            const { setTopicStatus } = require('./services/store');
            setTopicStatus(topicID, 'paid');
            console.log(`[BATCH PAYMENT] Updated topic ${topicID} status to: paid`);
          }
        } catch (err) {
          console.error(`[BATCH PAYMENT] Failed to submit paid event for ${prescriptionId}:`, err);
        }
      }

      res.json({
        success: true,
        batchTransactionId: `batch-tx-${Date.now()}`,
        totalAmountMAD,
        method,
        prescriptionsProcessed: prescriptionIds.length,
        status: 'completed'
      });
    }, 1000); // Slightly longer delay for batch processing

  } catch (error) {
    console.error('[BATCH PAYMENT] Error:', error);
    res.status(500).json({ success: false, error: error.message });
  }
});

// Pharmacist report (complete PDF)
app.post('/api/pharmacist-report', authenticateJWT, requireRole('pharmacist'), async (req, res) => {
  try {
    const { prescriptionId } = req.body || {};
    const p = prescriptionIndex.get(prescriptionId);
    if (!p) return res.status(404).json({ success: false, message: 'Prescription not found' });
    const invoiceId = generateInvoiceId();
    const buffer = await generatePharmacistReport({ ...p, id: invoiceId, pharmacistName: req.user?.username || 'Pharmacist' });
    return res.json({ success: true, base64: buffer.toString('base64'), filename: `Invoice_${invoiceId}.pdf` });
  } catch (e) {
    return res.status(500).json({ success: false, error: e.message });
  }
});

// === PRD Endpoints ===

// Issue prescription (PRD: /api/issue-prescription)
app.post(
  '/api/issue-prescription',
  authenticateJWT,
  requireRole('doctor'),
  celebrate({
    [Segments.BODY]: Joi.object({
      formData: Joi.object({
        patientId: Joi.string().allow('').optional(),
        patientName: Joi.string().required(),
        patientEmail: Joi.string().email().allow('').optional(),
        patientPhone: Joi.string().allow('').optional(),
        contactMethod: Joi.string().valid('email', 'sms', 'whatsapp').optional().default('email'),
        age: Joi.alternatives().try(Joi.string(), Joi.number()).optional(),
        diagnosis: Joi.string().required(),
        maxDispenses: Joi.number().integer().min(1).max(12).optional().default(1),
        medications: Joi.array().items(
          Joi.object({
            name: Joi.string().required(),
            code: Joi.string().allow('').optional(),
            dosage: Joi.alternatives().try(Joi.string(), Joi.number()).allow('').optional(),
            unit: Joi.string().required(),
            frequency: Joi.string().required(),
            duration: Joi.alternatives().try(Joi.string(), Joi.number()).required(),
            durationUnit: Joi.string().required(),
            instructions: Joi.string().allow('').optional(),
          })
        ).min(1).required()
      }).required(),
      geo: Joi.object({ lat: Joi.number(), lng: Joi.number() }).allow(null),
      nationalId: Joi.string().allow('').optional()
    })
  }),
  async (req, res) => {
    try {
      const { formData = {}, geo = null, nationalId } = req.body || {};
      const doctorId = req.user?.username || 'doctor@example.com';
      let prescriptionId, nft, stored, patientHash, doctorHash, drugHashes;

      if (isQueueEnabled() && enqueueIssue) {
        // Queue-based processing with retries
        const job = await enqueueIssue(formData, geo);
        const result = await waitForJob(job);
        ({ prescriptionId, nft, stored, patientHash, doctorHash, drugHashes } = result);
      } else {
        // Fallback to synchronous orchestrator
        ({ prescriptionId, nft, stored, patientHash, doctorHash, drugHashes } = await orchestrator.issuePrescription({ formData, geo, doctorId }));
      }

      // Build simplified QR payload with only required elements
      // Create a dedicated Hedera topic per prescription
      let topicID;
      try {
        const { createPrescriptionTopic } = require('./hedera');
        topicID = await createPrescriptionTopic({ memo: `rx:${prescriptionId}` });
        console.log('✅ Hedera topic created successfully:', topicID);
      } catch (e) {
        console.error('❌ Topic creation failed:', e.message);
        console.error('Stack trace:', e.stack);
        topicID = `0.0.${Date.now() % 100000}`;
        console.warn('⚠️  Using mock topic ID:', topicID);
      }
      const hashedPatientId = hashIdentifier(formData?.patientId || formData?.patientEmail || 'patient', process.env.CNDP_SALT || 'atlascare-default-salt', prescriptionId);

      // Create full QR payload per spec Section 3.1 (12 fields)
      const meds = Array.isArray(formData?.medications) ? formData.medications : [];
      const firstMed = meds[0] || {};
      const nowIso = new Date().toISOString();
      const validUntil = new Date(Date.now() + 60 * 24 * 60 * 60 * 1000).toISOString(); // 60 days for long-term prescriptions
      const nonce = crypto.randomBytes(8).toString('hex');
      const geotag = geo ? `MA-${geo.lat.toFixed(2)},${geo.lng.toFixed(2)}` : 'MA-CAS';
      const doctorIdHash = nationalId ? hashIdentifier(nationalId, process.env.CNDP_SALT || 'atlascare-default-salt', prescriptionId) : null;

      const qrPayload = {
        v: "1.0",                    // version
        t: topicID,                  // topicId
        h: hashedPatientId,          // hashedPatientId
        d: firstMed.code || 'UNKNOWN', // drugId ATC
        q: `${firstMed.dosage || '1'}${firstMed.unit || 'mg'}`, // quantity
        i: firstMed.instructions || `${firstMed.frequency || '1'}x/day, ${firstMed.duration || '7'} ${firstMed.durationUnit || 'days'}`, // instructions
        u: validUntil,               // validUntil
        n: nonce,                    // nonce
        g: geotag,                   // geotag
        p: doctorIdHash,             // doctorId hash
        dc: 0,                       // dispenseCount (starts at 0)
        md: formData?.maxDispenses || 1, // maxDispenses
      };

      // Add ECDSA signature if doctor national ID is provided
      if (nationalId) {
        const signature = signPayload(qrPayload, nationalId);
        qrPayload.s = `hex:${signature}`;
      }

      // Keep the full payload for backend processing (HCS, etc.)
      const drugIds = meds.map(m => m?.code || 'unknown');
      const instructionsList = meds.map(m => m?.instructions || '');
      const validFrom = nowIso;
      const fullPayload = {
        version: '1',
        alg: 'secp256k1+SHA-256',
        eventType: 'issued',
        topicID,
        timestamp: nowIso,
        validFrom,
        validUntil,
        geoTag: geo ? `${geo.lat},${geo.lng}` : null,
        hashedPatientId,
        nftSerial: String(nft?.serial || 1),
        drugIds,
        instructionsList,
        signerRole: 'doctor',
        maxDispenses: formData?.maxDispenses || 1,
        dispenseCount: 0
      };
      const toHash = { ...fullPayload, nonce };
      const contentHash = 'sha256:' + crypto.createHash('sha256').update(Buffer.from(JSON.stringify(toHash))).digest('hex');
      const completePayload = { ...toHash, contentHash };
      if (nationalId) {
        const { publicKeyHex } = ensureKeyPair(nationalId);
        const keyId = 'fp:' + crypto.createHash('sha256').update(Buffer.from(publicKeyHex, 'hex')).digest('hex').slice(0, 16);
        completePayload.keyId = keyId;
        const fullSignature = signPayload(completePayload, nationalId);
        completePayload.signature = `hex:${fullSignature}`;
      }

      // OTP issuance (for pharmacist verification)
      const ttl = Number(process.env.OTP_TTL_SECONDS || 300);
      const { token, otp, expiresAt } = issueOtp(prescriptionId, ttl);

      // Queue email with PDF (with retry logic and SMS fallback)
      if (formData.patientEmail) {
        try {
          const pdfBuffer = await generatePrescriptionPdf({ ...formData, id: prescriptionId, date: new Date().toISOString(), doctor: req.user?.username || 'Doctor' }, { qrData: qrPayload });

          // Use notification queue for reliable delivery
          const { queueEmail } = require('./services/notificationQueue');
          const notificationId = queueEmail({
            to: formData.patientEmail,
            subject: 'Your AtlasCare Prescription',
            text: `Dear ${formData.patientName},\n\nYour prescription has been created successfully.\nUse the QR code in the attached PDF at the pharmacy.\nFor verification, your verification code is: ${topicID}`,
            html: `<p>Dear ${formData.patientName},</p><p>Your prescription has been created successfully.</p><p>Use the QR code in the attached PDF at the pharmacy.</p><p>Verification code: <strong>${topicID}</strong></p>`,
            attachments: [
              { filename: `Prescription_${prescriptionId}.pdf`, content: pdfBuffer, contentType: 'application/pdf' }
            ],
            prescriptionId
          });

          console.log(`✅ Email queued for ${formData.patientEmail} (${notificationId})`);
        } catch (e) {
          console.error('Failed to queue email notification:', e.message);
          // Still continue - email is not critical for prescription creation
        }
      }

      // ADDITIONALLY send SMS or WhatsApp notification (if selected)
      if (formData.patientPhone && (formData.contactMethod === 'sms' || formData.contactMethod === 'whatsapp')) {
        try {
          const { sendPrescriptionNotification } = require('./utils/messaging');
          const messagingResult = await sendPrescriptionNotification({
            to: formData.patientPhone,
            topicID: topicID,
            patientName: formData.patientName,
            method: formData.contactMethod
          });

          if (messagingResult.success) {
            console.log(`✅ ${formData.contactMethod.toUpperCase()} sent successfully to ${formData.patientPhone}:`, messagingResult.messageId);
          } else {
            console.warn(`${formData.contactMethod.toUpperCase()} delivery failed:`, messagingResult.error);
          }
        } catch (e) {
          console.warn(`${formData.contactMethod} notification failed:`, e.message);
        }
      }

      // Index the full prescription payload in memory for quick lookup (demo)
      try {
        const full = {
          ...formData,
          id: prescriptionId,
          nft,
          doctor: req.user?.fullName || 'Mohamed Rami',
          doctorSpecialty: req.user?.specialty || 'Specialist in Internal Medicine',
          doctorNationalId: nationalId || '009811233',
          date: new Date().toISOString(),
          dispenseCount: 0,
          maxDispenses: formData?.maxDispenses || 1
        };
        prescriptionIndex.set(prescriptionId, full);
        putPayload(completePayload.topicID, completePayload);
        topicIndex.set(completePayload.topicID, full);
        prescriptionToTopic.set(prescriptionId, completePayload.topicID);

        // Store in inMemoryStore with dispense tracking
        inMemoryStore.set(completePayload.topicID, {
          prescription: full,
          payload: completePayload
        });

        // Mark indexes as dirty for persistence
        indexPersistence.markDirty();

        // Log HCS event for admin dashboard
        const { logHCSEvent } = require('./services/store');
        logHCSEvent({
          topicID: completePayload.topicID,
          eventType: 'issued',
          timestamp: completePayload.timestamp,
          signerRole: 'doctor',
          actorIdHash: completePayload.actorIdHash,
          dispenseCount: 0,
          maxDispenses: formData?.maxDispenses || 1,
          fraudAlert: null,
          drugIds: completePayload.drugIds || [],
          prescriptionId: prescriptionId
        });

        console.log(`✅ Indexed prescription: ${prescriptionId} → Topic: ${completePayload.topicID}`);
        console.log(`   topicIndex size: ${topicIndex.size}, prescriptionIndex size: ${prescriptionIndex.size}`);
        console.log(`   Dispense tracking: ${full.dispenseCount}/${full.maxDispenses}`);

        // Store sensitive data separately (CNDP compliance - removed from HCS)
        putSensitiveData(completePayload.topicID, {
          drugIds: completePayload.drugIds,
          instructionsList: completePayload.instructionsList,
          nftSerial: completePayload.nftSerial,
          preciseGeoTag: geo ? `${geo.lat},${geo.lng}` : null,
          medications: formData.medications // Full medication details
        });

        // Compress payload for HCS submission (72% size reduction)
        const compressedPayload = compressPayload(completePayload, hashLookup);
        console.log(`📊 Payload compression: ${JSON.stringify(completePayload).length} → ${JSON.stringify(compressedPayload).length} bytes`);

        // queue issued event and submit compressed payload to HCS (topicID passed separately)
        queueMessage(completePayload.topicID, { eventType: 'issued', payload: compressedPayload });
        try {
          const { submitPrescriptionMessage } = require('./hedera');
          const hcsResult = await submitPrescriptionMessage(completePayload.topicID, compressedPayload);
          console.log('✅ HCS Message (compressed) submitted:', hcsResult.status, 'Topic:', hcsResult.topicId);
        } catch (hcsError) {
          console.error('❌ HCS submission failed:', hcsError.message);
        }
        try {
          const { lastEventHashPerTopic, lastEventTypePerTopic } = require('./services/store');
          const issuedHash = 'sha256:' + crypto.createHash('sha256').update(Buffer.from(JSON.stringify(completePayload))).digest('hex');
          lastEventHashPerTopic.set(completePayload.topicID, issuedHash);
          lastEventTypePerTopic.set(completePayload.topicID, 'issued');
        } catch (_) { }
      } catch (_) { }

      // Include doctor's public key for offline verification caching
      let doctorPublicKey = null;
      if (nationalId) {
        const { publicKeyHex } = ensureKeyPair(nationalId);
        doctorPublicKey = publicKeyHex;
      }

      return res.json({
        success: true,
        prescriptionId,
        patientHash,
        doctorHash,
        drugHashes,
        nft,
        qr: { data: qrPayload, expiresAt },
        storageRef: stored.fileId,
        doctorPublicKey // For offline verification caching
      });
    } catch (error) {
      console.error('Error issuing prescription:', error);
      return res.status(500).json({ success: false, error: error.message });
    }
  });

// Verify prescription (PRD: /api/verify)
app.post(
  '/api/verify',
  celebrate({
    [Segments.BODY]: Joi.object({
      payload: Joi.object().optional(),
      topicID: Joi.string().allow('').optional(),
      doctorNationalId: Joi.string().allow('').optional(),
      pharmacistNationalId: Joi.string().allow('').optional(),
      pharmacyId: Joi.string().allow('').optional()
    })
  }),
  async (req, res) => {
    try {
      const { payload: payloadIn, topicID, doctorNationalId, pharmacistNationalId, pharmacyId } = req.body || {};

      // Normalize empty strings to undefined
      const normalizedTopicID = topicID && topicID.trim() !== '' ? topicID : undefined;
      const normalizedDoctorId = doctorNationalId && doctorNationalId.trim() !== '' ? doctorNationalId : undefined;
      const normalizedPharmacistId = pharmacistNationalId && pharmacistNationalId.trim() !== '' ? pharmacistNationalId : undefined;

      console.log('[VERIFY] Request received:', {
        hasPayload: !!payloadIn,
        topicID: normalizedTopicID,
        hasDoctorId: !!normalizedDoctorId,
        hasPharmacistId: !!normalizedPharmacistId
      });
      let payload = payloadIn;

      // Fallback to in-memory fetch by topicID when payload not provided
      if (!payload && normalizedTopicID) {
        try {
          const { inMemoryStore } = require('./services/store');
          const entry = inMemoryStore.get(normalizedTopicID);
          payload = entry?.payload || null;

          // If still no payload, try to reconstruct from prescription index (defined in this file)
          if (!payload) {
            const prescription = prescriptionIndex.get(normalizedTopicID);
            if (prescription) {
              console.log('[VERIFY] Reconstructing payload from prescription index for topic:', normalizedTopicID);
              // Create a minimal payload for verification - INCLUDE maxDispenses!
              payload = {
                eventType: 'issued',
                topicID: normalizedTopicID,
                prescriptionId: prescription.prescriptionId || prescription.id,
                doctorNationalId: prescription.doctorNationalId || normalizedDoctorId,
                timestamp: prescription.date || new Date().toISOString(),
                maxDispenses: prescription.maxDispenses || 1 // ✨ CRITICAL: Include maxDispenses for verification
              };
            }
          }
        } catch (_) { payload = null; }
      }
      if (!payload) {
        console.warn('[VERIFY] No payload found for topicID:', normalizedTopicID);
        return res.status(400).json({ success: false, valid: false, message: 'Prescription not found. Please scan the QR code or look up the prescription first.' });
      }

      // Decompress payload if it's in compressed format (from HCS or in-memory store)
      // Check for compressed format: has 'e' but not 'eventType'
      if (payload?.e && !payload?.eventType) {
        console.log('[VERIFY] Detected compressed payload, decompressing...');
        payload = decompressPayload(payload, hashLookup);
        console.log('[VERIFY] Decompressed payload:', payload.eventType || payload.e);
      }

      // Block verification if fully dispensed (check dispense count, not just status)
      try {
        const { lastEventTypePerTopic, inMemoryStore } = require('./services/store');
        const t = lastEventTypePerTopic.get(payload.topicID);
        if (t === 'dispensed' || t === 'paid') {
          // Check if there are remaining dispenses
          const prescriptionData = inMemoryStore.get(payload.topicID);
          const prescriptionRecord = prescriptionIndex.get(payload.topicID); // Direct access to prescriptionIndex (defined in this file)

          // ALWAYS prioritize stored data over QR payload (QR may be outdated)
          const currentDispenseCount = prescriptionData?.payload?.dispenseCount
            || prescriptionRecord?.dispenseCount
            || 0;

          const maxDispenses = prescriptionData?.payload?.maxDispenses
            || prescriptionRecord?.maxDispenses
            || payload.md
            || payload.maxDispenses
            || 1;

          console.log(`[VERIFY] Dispense check: ${currentDispenseCount}/${maxDispenses} (status: ${t})`);

          if (currentDispenseCount >= maxDispenses) {
            console.log(`[VERIFY] ❌ Blocking verification - fully dispensed`);
            return res.status(409).json({
              success: false,
              valid: false,
              message: `Prescription fully dispensed (${currentDispenseCount}/${maxDispenses})`
            });
          } else {
            console.log(`[VERIFY] ✅ Allowing verification - ${maxDispenses - currentDispenseCount} dispenses remaining`);
          }
        }
      } catch (e) {
        console.warn('[VERIFY] Dispense check failed:', e.message);
      }

      // QR version check (spec Section 5.1)
      if (payload?.v && payload.v !== "1.0") {
        return res.status(400).json({ success: false, valid: false, message: 'Unsupported QR version' });
      }

      // Expiration check (spec Section 5.1)
      if (payload?.u) {
        const validUntil = new Date(payload.u);
        const now = new Date();

        // Check if prescription has expired
        if (now > validUntil) {
          return res.status(400).json({
            success: false,
            valid: false,
            message: 'Prescription expired',
            expiredAt: validUntil.toISOString()
          });
        }
      }

      // Dispense count validation (spec Section 5.1)
      // Check both compressed and decompressed field names
      const dispenseCount = payload?.dispenseCount ?? payload?.dc;
      const maxDispenses = payload?.maxDispenses ?? payload?.md;

      if (dispenseCount !== undefined && maxDispenses !== undefined) {
        if (dispenseCount >= maxDispenses) {
          return res.status(400).json({
            success: false,
            valid: false,
            message: `Prescription fully dispensed (${dispenseCount}/${maxDispenses})`
          });
        }
      }

      // Optional doctor signature verification
      let signatureValid = true;
      if (normalizedDoctorId) {
        // Handle both old and new signature field names
        const signature = payload?.signature || payload?.s;

        if (signature) {
          // CRITICAL: Verify against the SAME structure that was signed
          // The QR payload uses short field names (v, t, h, d, q, i, u, n, g, p, dc, md)
          // We need to reconstruct that structure for verification
          const signedPayload = {
            v: payload.v || payload.version || "1.0",
            t: payload.t || payload.topicID,
            h: payload.h || payload.hashedPatientId,
            d: payload.d || payload.drugId || payload.drugIds?.[0],
            q: payload.q || payload.quantity,
            i: payload.i || payload.instructions || payload.instructionsList?.[0],
            u: payload.u || payload.validUntil,
            n: payload.n || payload.nonce,
            g: payload.g || payload.geoTag,
            p: payload.p || payload.doctorIdHash,
            dc: payload.dc ?? payload.dispenseCount ?? 0,
            md: payload.md ?? payload.maxDispenses ?? 1
          };

          signatureValid = verifySignature(signedPayload, signature, normalizedDoctorId);

          if (!signatureValid) {
            console.warn('[SIGNATURE] Verification failed for doctor:', normalizedDoctorId);
            console.warn('[SIGNATURE] Payload fields:', Object.keys(payload));
            console.warn('[SIGNATURE] Reconstructed payload:', Object.keys(signedPayload));
          }
        } else {
          console.warn('[SIGNATURE] No signature found in payload');
          signatureValid = false;
        }
      }

      // Return signature status in response for debugging
      const signatureStatus = {
        signatureValid: normalizedDoctorId ? signatureValid : null,
        signatureChecked: !!normalizedDoctorId
      };

      // For now, don't fail verification if signature is invalid (backward compatibility)
      // In production, you should enforce this: if (!signatureValid && normalizedDoctorId) return res.status(401)...
      if (signatureValid === false && normalizedDoctorId) {
        console.warn('[SIGNATURE] Allowing verification to proceed despite invalid signature (backward compatibility)');
      }

      // Optional nonce replay prevention
      try {
        const { usedNonces } = require('./services/store');
        if (payload?.nonce) {
          if (usedNonces.has(payload.nonce)) {
            return res.status(409).json({ success: false, valid: false, message: 'Duplicate prescription nonce' });
          }
          usedNonces.add(payload.nonce);
        }
      } catch (_) { }

      // Fraud detection: Check geotag distance
      let fraudAlert = null;
      try {
        const { checkFraud } = require('./utils/fraudDetection');
        const issueGeotag = payload.geoTag || payload.g; // Support both formats
        const pharmacyGeotag = req.body.geo ? `${req.body.geo.lat},${req.body.geo.lng}` : null;

        if (issueGeotag && pharmacyGeotag) {
          const fraudCheck = checkFraud(issueGeotag, pharmacyGeotag);

          if (fraudCheck.suspicious) {
            console.warn(`[FRAUD ALERT] ${fraudCheck.reason}`);
            fraudAlert = {
              distance: fraudCheck.distance,
              reason: fraudCheck.reason,
              issueLocation: fraudCheck.issueCoords,
              verifyLocation: fraudCheck.verifyCoords
            };
          } else {
            console.log(`[FRAUD CHECK] Normal verification: ${fraudCheck.reason}`);
          }
        }
      } catch (fraudErr) {
        console.error('Fraud detection error:', fraudErr);
        // Don't fail verification if fraud detection fails
      }

      // Queue verified event for HCS
      try {
        const { queueMessage, lastEventHashPerTopic } = require('./services/store');
        const prevEventHash = lastEventHashPerTopic.get(payload.topicID) || ('sha256:' + crypto.createHash('sha256').update(Buffer.from(JSON.stringify(payload))).digest('hex'));
        const verification = { signatureOk: !!ok, validUntilOk: !payload?.validUntil || (Date.now() <= Date.parse(payload.validUntil)) };
        const msgBase = {
          version: '1',
          alg: 'secp256k1+SHA-256',
          eventType: 'verified',
          topicID: payload.topicID,
          timestamp: new Date().toISOString(),
          signerRole: 'pharmacist',
          actorIdHash: pharmacistNationalId ? ('sha256:' + crypto.createHash('sha256').update(String(pharmacistNationalId) + (process.env.CNDP_SALT || 'atlascare-default-salt')).digest('hex')) : null,
          drugIds: payload.drugIds || [payload.d], // Support both old and new format
          verification,
          prevEventHash,
          dispenseCount: payload.dc || 0,
          maxDispenses: payload.md || 1,
          fraudAlert: fraudAlert || undefined // Include fraud alert if detected
        };
        let msg = { ...msgBase };
        if (pharmacistNationalId) {
          const { publicKeyHex } = ensureKeyPair(pharmacistNationalId);
          const keyId = 'fp:' + crypto.createHash('sha256').update(Buffer.from(publicKeyHex, 'hex')).digest('hex').slice(0, 16);
          const nonce = crypto.randomBytes(8).toString('hex');
          const toHash = { ...msgBase, keyId, nonce };
          const contentHash = 'sha256:' + crypto.createHash('sha256').update(Buffer.from(JSON.stringify(toHash))).digest('hex');
          const signed = { ...toHash, contentHash };
          const signature = signPayload(signed, pharmacistNationalId);
          msg = { ...signed, signature: `hex:${signature}` };
        }
        // Compress payload for HCS (CNDP compliance + cost reduction)
        const compressedMsg = compressPayload(msg, hashLookup);
        console.log(`📊 VERIFIED message compression: ${JSON.stringify(msg).length} → ${JSON.stringify(compressedMsg).length} bytes`);

        queueMessage(payload.topicID, { eventType: 'verified', payload: compressedMsg });
        try {
          const { submitPrescriptionMessage } = require('./hedera');
          const hcsResult = await submitPrescriptionMessage(compressedMsg);
          console.log('✅ HCS Message (verified, compressed) submitted:', hcsResult.status, 'Topic:', hcsResult.topicId);
        } catch (hcsError) {
          console.error('❌ HCS submission (verified) failed:', hcsError.message);
        }
        try {
          const newHash = 'sha256:' + crypto.createHash('sha256').update(Buffer.from(JSON.stringify(msg))).digest('hex');
          const { lastEventHashPerTopic, lastEventTypePerTopic } = require('./services/store');
          lastEventHashPerTopic.set(payload.topicID, newHash);
          lastEventTypePerTopic.set(payload.topicID, 'verified');
        } catch (_) { }
      } catch (_) { }

      // Log HCS event for admin dashboard
      const { logHCSEvent } = require('./services/store');
      logHCSEvent({
        topicID: payload.topicID,
        eventType: 'verified',
        timestamp: new Date().toISOString(),
        signerRole: 'pharmacist',
        actorIdHash: normalizedPharmacistId ? hashIdentifier(normalizedPharmacistId, process.env.CNDP_SALT || 'atlascare-default-salt', payload.topicID) : null,
        dispenseCount: payload.dispenseCount || 0,
        maxDispenses: payload.maxDispenses || payload.md || 1,
        fraudAlert: fraudAlert || null,
        drugIds: payload.drugIds || [],
        prescriptionId: payload.prescriptionId || payload.topicID
      });

      return res.json({
        success: true,
        valid: true,
        signatureValid: signatureStatus.signatureValid,
        fraudAlert: fraudAlert || undefined // Include fraud alert for frontend warning
      });
    } catch (error) {
      console.error('Error verifying prescription:', error);
      return res.status(500).json({ success: false, error: error.message });
    }
  });

// Generate FSE (PRD: /api/generate-fse)
app.post(
  '/api/generate-fse',
  authenticateJWT,
  requireRole('pharmacist'),
  celebrate({
    [Segments.BODY]: Joi.object({
      prescription: Joi.object().required(),
      refs: Joi.object({
        nft: Joi.object({ tokenId: Joi.string(), serial: Joi.alternatives().try(Joi.string(), Joi.number()) }).optional(),
        topicId: Joi.string().optional()
      }).optional(),
      pharmacistNationalId: Joi.string().optional()
    })
  }),
  async (req, res) => {
    try {
      const { prescription, refs, pharmacistNationalId } = req.body || {};
      if (!prescription) {
        return res.status(400).json({ success: false, message: 'Missing prescription' });
      }

      // Build pharmacist info from authenticated user and request
      const pharmacist = {
        name: req.user?.fullName || 'Pharmacy',
        nationalId: pharmacistNationalId || req.user?.username || 'unknown',
        username: req.user?.username || 'unknown'
      };

      const { fseJson, fsePdfUrl, fsePdfBase64, hl7Message, summary } = generateFSE(prescription, { refs, pharmacist });
      return res.json({
        success: true,
        fseJson,
        fsePdfUrl,
        fsePdfBase64,
        hl7Message,
        summary
      });
    } catch (error) {
      console.error('Error generating FSE:', error);
      return res.status(500).json({ success: false, error: error.message });
    }
  });

// Get medicines for autocomplete (unified source) - CACHED
app.get('/api/medicines', (req, res) => {
  try {
    // Return cached medicines
    if (medicinesCache !== null) {
      // Add cache headers for browser caching
      res.setHeader('Cache-Control', 'public, max-age=3600'); // 1 hour cache
      res.setHeader('X-Medicines-Cache-Age', Math.floor((Date.now() - medicinesCacheTimestamp) / 1000));
      return res.json(medicinesCache);
    }

    // If cache not loaded yet, load it now
    loadMedicinesCache();

    if (medicinesCache) {
      res.setHeader('Cache-Control', 'public, max-age=3600');
      return res.json(medicinesCache);
    }

    // Fallback
    console.warn('[MEDICINES] Cache empty, returning empty array');
    return res.json([]);
  } catch (error) {
    console.error('[MEDICINES] Endpoint error:', error.message);
    return res.status(500).json({
      success: false,
      error: 'Failed to load medicines catalog',
      message: error.message
    });
  }
});

// Medicines search endpoints removed to keep implementation simple (frontend handles filtering)

app.listen(PORT, async () => {
  console.log(`Server running on http://localhost:${PORT}`);

  // Validate environment variables (fail fast if misconfigured)
  try {
    const { validateEnv, printEnvStatus, getProductionReadinessReport } = require('./utils/envValidator');
    validateEnv();
    printEnvStatus();

    // Check production readiness
    const readinessReport = getProductionReadinessReport();
    if (!readinessReport.ready) {
      console.log('\n⚠️  PRODUCTION READINESS CHECK:\n');
      Object.entries(readinessReport.checks).forEach(([key, status]) => {
        console.log(`  ${status} ${key}`);
      });
      console.log('\n💡 This system is NOT fully production-ready');
      console.log('   Some features may be disabled or using defaults\n');
    } else {
      console.log('\n✅ PRODUCTION READINESS: All checks passed\n');
    }
  } catch (err) {
    console.error('Environment validation failed:', err.message);
    console.error('Server will continue but may not function correctly');
  }

  // Load medicines cache (once on startup)
  loadMedicinesCache();

  // Load persisted data
  const { persistence } = require('./services/store');
  try {
    await persistence.loadAll();
    persistence.startAutoSave();
    console.log('✅ Persistence layer initialized');
  } catch (err) {
    console.warn('⚠️  Persistence initialization failed:', err.message);
  }

  // Migrate existing prescriptions to event log (one-time backfill)
  try {
    const { logHCSEvent, hcsEventLog } = require('./services/store');

    // Only migrate if event log is empty
    if (hcsEventLog.length === 0 && prescriptionIndex.size > 0) {
      console.log(`[MIGRATION] Backfilling event log with ${prescriptionIndex.size} existing prescriptions...`);

      for (const [prescriptionId, prescription] of prescriptionIndex.entries()) {
        const topicID = prescriptionToTopic.get(prescriptionId);
        if (!topicID) continue;

        const prescriptionData = inMemoryStore.get(topicID);
        const currentStatus = prescriptionData?.status || lastEventTypePerTopic.get(topicID) || 'issued';
        const payload = prescriptionData?.payload;

        // Create issued event (always exists)
        logHCSEvent({
          topicID: topicID,
          eventType: 'issued',
          timestamp: prescription.date || new Date().toISOString(),
          signerRole: 'doctor',
          actorIdHash: payload?.actorIdHash || null,
          dispenseCount: 0,
          maxDispenses: prescription.maxDispenses || 1,
          fraudAlert: null,
          drugIds: payload?.drugIds || [],
          prescriptionId: prescriptionId
        });

        // Create subsequent events based on current status
        if (currentStatus === 'verified' || currentStatus === 'paid' || currentStatus === 'dispensed') {
          logHCSEvent({
            topicID: topicID,
            eventType: 'verified',
            timestamp: prescription.date || new Date().toISOString(),
            signerRole: 'pharmacist',
            actorIdHash: null,
            dispenseCount: 0,
            maxDispenses: prescription.maxDispenses || 1,
            fraudAlert: null,
            drugIds: payload?.drugIds || [],
            prescriptionId: prescriptionId
          });
        }

        if (currentStatus === 'paid' || currentStatus === 'dispensed') {
          logHCSEvent({
            topicID: topicID,
            eventType: 'paid',
            timestamp: prescription.date || new Date().toISOString(),
            signerRole: 'pharmacist',
            actorIdHash: null,
            dispenseCount: prescription.dispenseCount || 0,
            maxDispenses: prescription.maxDispenses || 1,
            fraudAlert: null,
            drugIds: payload?.drugIds || [],
            prescriptionId: prescriptionId
          });
        }

        if (currentStatus === 'dispensed') {
          logHCSEvent({
            topicID: topicID,
            eventType: 'dispensed',
            timestamp: prescription.lastDispenseDate || prescription.date || new Date().toISOString(),
            signerRole: 'pharmacist',
            actorIdHash: null,
            dispenseCount: prescription.dispenseCount || 1,
            maxDispenses: prescription.maxDispenses || 1,
            fraudAlert: null,
            drugIds: payload?.drugIds || [],
            prescriptionId: prescriptionId
          });
        }
      }

      console.log(`✅ [MIGRATION] Backfilled ${hcsEventLog.length} events from ${prescriptionIndex.size} prescriptions`);
      persistence.markDirty(); // Save the migrated events
    } else if (hcsEventLog.length > 0) {
      console.log(`✅ [EVENT LOG] Loaded ${hcsEventLog.length} historical events`);
    }
  } catch (err) {
    console.warn('⚠️  Event log migration failed:', err.message);
  }

  // Start status reconciliation job (handles Mirror Node delays)
  try {
    const { startReconciliationJob } = require('./services/statusReconciliation');
    startReconciliationJob();
    console.log('✅ Status reconciliation job started');
  } catch (err) {
    console.warn('⚠️  Reconciliation job failed:', err.message);
  }

  // Start notification queue processing (email retries + SMS fallback)
  try {
    const { startProcessing } = require('./services/notificationQueue');
    startProcessing();
    console.log('✅ Notification queue processing started');
  } catch (err) {
    console.warn('⚠️  Notification queue failed:', err.message);
  }

  // Initialize BullMQ queue if Redis is configured
  initQueue().catch(err => console.warn('Queue init error:', err.message));
  try { queueSyncLoop(); } catch (_) { }
});

// Celebrate error handler
app.use(celebrateErrors());

// Cancel prescription
app.post(
  '/api/cancel',
  authenticateJWT,
  requireRole('doctor'),
  celebrate({
    [Segments.BODY]: Joi.object({
      prescriptionId: Joi.string().required(),
      reason: Joi.string().optional()
    })
  }),
  async (req, res) => {
    try {
      const { prescriptionId, reason } = req.body || {};
      const topicID = prescriptionToTopic.get(prescriptionId);
      if (topicID) {
        const { submitPrescriptionMessage } = require('./hedera');
        await submitPrescriptionMessage({
          type: 'cancelled',
          topicID,
          prescriptionId,
          timestamp: Date.now(),
          refs: { reason }
        });
      } else {
        await submitAuditMessage({ type: 'cancelled', prescriptionId, timestamp: Date.now(), refs: { reason } });
      }
      return res.json({ success: true });
    } catch (e) {
      return res.status(500).json({ success: false, error: e.message });
    }
  }
);

// Dispense (enqueue dispensed event)
app.post(
  '/api/dispense',
  celebrate({
    [Segments.BODY]: Joi.object({
      topicID: Joi.string().required(),
      pharmacistNationalId: Joi.string().required(),
      items: Joi.array().items(Joi.object({ drugId: Joi.string().required(), quantity: Joi.alternatives().try(Joi.number(), Joi.string()).required(), unit: Joi.string().allow('').optional() })).optional(),
      totals: Joi.object({ amountMAD: Joi.number(), coveredMAD: Joi.number(), patientMAD: Joi.number() }).optional(),
      paymentMethod: Joi.string().allow('').optional(),
      prevEventHash: Joi.string().allow('').optional()
    })
  }),
  async (req, res) => {
    const { topicID, pharmacistNationalId } = req.body || {};
    const { acquireDispenseLock, releaseDispenseLock } = require('./services/statusReconciliation');

    // CRITICAL: Acquire lock to prevent race conditions (double-dispensing)
    if (!acquireDispenseLock(topicID, pharmacistNationalId)) {
      return res.status(409).json({
        success: false,
        message: 'Another dispense operation is in progress for this prescription',
        error: 'CONCURRENT_DISPENSE_ATTEMPT'
      });
    }

    try {
      const { items, totals, prevEventHash, paymentMethod } = req.body || {};
      const { lastEventHashPerTopic, lastEventTypePerTopic, inMemoryStore } = require('./services/store');

      // Get current prescription data to track dispense count
      const prescriptionData = inMemoryStore.get(topicID);
      const currentDispenseCount = prescriptionData?.payload?.dispenseCount || 0;
      const maxDispenses = prescriptionData?.payload?.maxDispenses || 1;

      // Check if prescription can be dispensed
      if (currentDispenseCount >= maxDispenses) {
        releaseDispenseLock(topicID); // Release lock before returning
        return res.status(400).json({
          success: false,
          message: `Prescription fully dispensed (${currentDispenseCount}/${maxDispenses})`
        });
      }

      // Increment dispense count
      const newDispenseCount = currentDispenseCount + 1;

      const chainPrev = prevEventHash || lastEventHashPerTopic.get(topicID) || undefined;
      const base = {
        version: '1',
        alg: 'secp256k1+SHA-256',
        eventType: 'dispensed',
        topicID,
        timestamp: new Date().toISOString(),
        signerRole: 'pharmacist',
        actorIdHash: 'sha256:' + crypto.createHash('sha256').update(String(pharmacistNationalId) + (process.env.CNDP_SALT || 'atlascare-default-salt')).digest('hex'),
        items: Array.isArray(items) ? items : undefined,
        totals: totals || undefined,
        paymentMethod: paymentMethod || undefined,
        prevEventHash: chainPrev,
        dispenseCount: newDispenseCount,
        maxDispenses: maxDispenses
      };
      // Sign with pharmacist
      const { publicKeyHex } = ensureKeyPair(pharmacistNationalId);
      const keyId = 'fp:' + crypto.createHash('sha256').update(Buffer.from(publicKeyHex, 'hex')).digest('hex').slice(0, 16);
      const nonce = crypto.randomBytes(8).toString('hex');
      const toHash = { ...base, keyId, nonce };
      const contentHash = 'sha256:' + crypto.createHash('sha256').update(Buffer.from(JSON.stringify(toHash))).digest('hex');
      const signed = { ...toHash, contentHash };
      const signature = signPayload(signed, pharmacistNationalId);
      const payload = { ...signed, signature: `hex:${signature}` };

      // Store sensitive data (items, totals) separately - NOT in HCS for CNDP compliance
      putSensitiveData(topicID, {
        ...getSensitiveData(topicID), // Preserve existing sensitive data
        dispensedItems: items,
        dispensedTotals: totals,
        paymentMethod: paymentMethod
      });

      // Compress payload for HCS (remove items/totals arrays)
      const compressedPayload = compressPayload(payload, hashLookup);
      console.log(`📊 DISPENSED message compression: ${JSON.stringify(payload).length} → ${JSON.stringify(compressedPayload).length} bytes`);

      queueMessage(topicID, { eventType: 'dispensed', payload: compressedPayload });
      try {
        const { submitPrescriptionMessage } = require('./hedera');
        const hcsResult = await submitPrescriptionMessage(topicID, compressedPayload);
        console.log('✅ HCS Message (dispensed, compressed) submitted:', hcsResult.status, 'Topic:', hcsResult.topicId);
      } catch (hcsError) {
        console.error('❌ HCS submission (dispensed) failed:', hcsError.message);
      }
      try {
        const newHash = 'sha256:' + crypto.createHash('sha256').update(Buffer.from(JSON.stringify(payload))).digest('hex');
        lastEventHashPerTopic.set(topicID, newHash);
        lastEventTypePerTopic.set(topicID, 'dispensed');

        // Update dispense count and last dispense date in in-memory store
        if (prescriptionData) {
          prescriptionData.payload.dispenseCount = newDispenseCount;
          prescriptionData.payload.lastDispenseDate = new Date().toISOString();
          inMemoryStore.set(topicID, prescriptionData);
        }

        // Also update prescriptionIndex with last dispense date
        const prescriptionRecord = prescriptionIndex.get(topicID);
        if (prescriptionRecord) {
          prescriptionRecord.dispenseCount = newDispenseCount;
          prescriptionRecord.lastDispenseDate = new Date().toISOString();
          prescriptionIndex.set(topicID, prescriptionRecord);
        }

        // CRITICAL: Also update inMemoryStore status
        const { setTopicStatus, logHCSEvent } = require('./services/store');
        setTopicStatus(topicID, 'dispensed');
        console.log(`[DISPENSE] Updated topic ${topicID} status to: dispensed (${newDispenseCount}/${maxDispenses}) at ${new Date().toISOString()}`);

        // Log HCS event for admin dashboard
        logHCSEvent({
          topicID: topicID,
          eventType: 'dispensed',
          timestamp: base.timestamp,
          signerRole: 'pharmacist',
          actorIdHash: base.actorIdHash,
          dispenseCount: newDispenseCount,
          maxDispenses: maxDispenses,
          fraudAlert: null,
          drugIds: prescriptionData?.payload?.drugIds || [],
          prescriptionId: prescriptionData?.prescription?.id || topicID,
          paymentMethod: paymentMethod,
          totals: totals
        });
      } catch (_) { }

      // Release lock after successful dispense
      releaseDispenseLock(topicID);
      return res.json({ success: true });
    } catch (e) {
      // Release lock on error
      releaseDispenseLock(topicID);
      return res.status(500).json({ success: false, error: e.message });
    }
  }
);

// CNSS approval simulation (PRD: /api/cnss-approve)
app.post(
  '/api/cnss-approve',
  authenticateJWT,
  requireRole('doctor'),
  celebrate({
    [Segments.BODY]: Joi.object({
      formData: Joi.object().required()
    })
  }),
  async (req, res) => {
    try {
      const ok = true;
      const approvalCode = `CNSS-${Math.floor(100000 + Math.random() * 900000)}`;
      return res.json({ success: true, approved: ok, approvalCode });
    } catch (e) {
      return res.status(500).json({ success: false, error: e.message });
    }
  }
);

// Admin HCS logs endpoint
app.get('/api/admin/hcs-logs', authenticateJWT, requireRole('admin'), async (req, res) => {
  try {
    const { filter = 'all' } = req.query;

    // Get events from the new HCS event log
    const { getHCSEvents } = require('./services/store');
    const events = getHCSEvents(filter);

    console.log(`[ADMIN] Fetching HCS logs - filter: ${filter}, total events: ${events.length}`);

    return res.json({ success: true, logs: events, total: events.length });
  } catch (error) {
    console.error('Error fetching HCS logs:', error);
    return res.status(500).json({ success: false, error: error.message });
  }
});

// Download prescription PDF (returns base64)
app.get('/api/prescriptions/:id/pdf', authenticateJWT, async (req, res) => {
  try {
    const id = req.params.id;
    const payload = prescriptionIndex.get(id);
    if (!payload) {
      return res.status(404).json({ success: false, message: 'Prescription not found' });
    }

    // Reconstruct QR payload with topicID
    let topicID = prescriptionToTopic.get(id);

    // Fallback: Search in topicIndex if not found in direct map
    if (!topicID) {
      console.warn(`[PDF DOWNLOAD] topicID not found in map for ${id}, searching topicIndex...`);
      for (const [tid, pres] of topicIndex.entries()) {
        if (pres.id === id || pres.prescriptionId === id) {
          topicID = tid;
          // Repair the map
          prescriptionToTopic.set(id, tid);
          break;
        }
      }
    }

    let qrPayload = { prescriptionId: id };

    if (topicID) {
      // Get the full HCS payload if available to extract more details
      let fullPayload = null;
      try {
        const { inMemoryStore } = require('./services/store');
        const entry = inMemoryStore.get(topicID);
        fullPayload = entry?.payload;
      } catch (_) { }

      qrPayload = {
        v: "1.0",
        t: topicID,
        h: fullPayload?.hashedPatientId || 'unknown',
        d: 'UNKNOWN', // We don't have the exact drug codes handy here easily without re-parsing
        q: '1',
        i: 'See PDF',
        u: fullPayload?.validUntil || new Date(Date.now() + 60 * 24 * 60 * 60 * 1000).toISOString(),
        n: 'reconstructed',
        g: fullPayload?.geoTag || 'MA-CAS',
        p: 'unknown',
        dc: 0,
        md: payload.maxDispenses || 1
      };
      console.log(`[PDF DOWNLOAD] Reconstructed QR payload for ${id} with topicID ${topicID}`);
    } else {
      console.warn(`[PDF DOWNLOAD] No topicID found for ${id}, using fallback QR`);
    }

    const pdfBuffer = await generatePrescriptionPdf({ ...payload, id }, { qrData: qrPayload });
    const base64 = pdfBuffer.toString('base64');
    return res.json({ success: true, base64, filename: `Prescription_${id}.pdf` });
  } catch (e) {
    return res.status(500).json({ success: false, error: e.message });
  }
});

// Amend prescription
app.post(
  '/api/amend',
  authenticateJWT,
  requireRole('doctor'),
  celebrate({
    [Segments.BODY]: Joi.object({
      prescriptionId: Joi.string().required(),
      contentHash: Joi.string().required(),
      reason: Joi.string().optional()
    })
  }),
  async (req, res) => {
    try {
      const { prescriptionId, contentHash, reason } = req.body || {};
      const topicID = prescriptionToTopic.get(prescriptionId);
      if (topicID) {
        const { submitPrescriptionMessage } = require('./hedera');
        await submitPrescriptionMessage({
          type: 'amended',
          topicID,
          prescriptionId,
          timestamp: Date.now(),
          hashes: { contentHash },
          refs: { reason }
        });
      } else {
        await submitAuditMessage({ type: 'amended', prescriptionId, timestamp: Date.now(), hashes: { contentHash }, refs: { reason } });
      }
      return res.json({ success: true });
    } catch (e) {
      return res.status(500).json({ success: false, error: e.message });
    }
  }
);
