import { useState, useEffect, useRef } from 'react';
// Medicines will be fetched from backend to ensure single source of truth
import * as enc from '../utils/encryptedStorage';
import { useNavigate } from 'react-router-dom';
import { useTranslation } from 'react-i18next';
import QRCodeDisplay from '../components/QRCodeDisplay';
import PrescriptionSummary from '../components/PrescriptionSummary';
import PrescriptionTemplates from '../components/PrescriptionTemplates';
import StepIndicator from '../components/StepIndicator';
import SuccessCelebration from '../components/SuccessCelebration';
import { FiPlus, FiTrash2, FiAlertCircle, FiCheckCircle, FiSave, FiX, FiChevronDown, FiChevronUp, FiUser, FiMail, FiPhone, FiCalendar, FiFileText, FiSearch, FiInfo, FiTrendingUp } from 'react-icons/fi';
import useDocumentTitle from '../hooks/useDocumentTitle';
import { Button, Card, Badge, Skeleton, Alert } from '../components/ui';

const DoctorForm = () => {
  const { t } = useTranslation();
  const [step, setStep] = useState(1); // 1: Input & Review, 2: Success (QR Generated)
  const [medicines, setMedicines] = useState([]);
  const [suggestions, setSuggestions] = useState([]);
  const [isLoading, setIsLoading] = useState(false);
  const [error, setError] = useState('');
  const [searchLoading, setSearchLoading] = useState(false);

  // Collapsible sections state
  const [sectionsExpanded, setSectionsExpanded] = useState({
    patientInfo: true,
    medications: true,
    costs: true
  });

  const [prescriptionData, setPrescriptionData] = useState({
    patientId: '',
    patientName: '',
    patientEmail: '',
    patientPhone: '',
    contactMethod: 'email',
    age: '',
    diagnosis: '',
    maxDispenses: 1,
    medications: [{
      name: '',
      dosage: '',
      unit: 'mg',
      frequency: '1',
      duration: '7',
      durationUnit: 'days',
      instructions: ''
    }]
  });
  const [createdPrescription, setCreatedPrescription] = useState(null);
  const [revoking, setRevoking] = useState(false);
  const [revokeError, setRevokeError] = useState('');
  const [revoked, setRevoked] = useState(false);
  const [cnss, setCnss] = useState({ approved: false, code: null });
  const [cnssLoading, setCnssLoading] = useState(false);
  const [geo, setGeo] = useState(null);
  const [cnopsDetails, setCnopsDetails] = useState([]);
  const [activeSuggestIndex, setActiveSuggestIndex] = useState(null);
  const [realTimeTotals, setRealTimeTotals] = useState({ total: 0, covered: 0, patient: 0 });
  const searchTimeoutRef = useRef(null);
  const autoSaveTimeoutRef = useRef(null);
  const [doctorNationalId, setDoctorNationalId] = useState('009811233');
  const [lastSaved, setLastSaved] = useState(null);
  const [hasFormData, setHasFormData] = useState(false);
  const navigate = useNavigate();

  // Dynamic title based on current step
  const getStepTitle = () => {
    switch (step) {
      case 1: return t('doctor.newPrescription');
      case 2: return t('doctor.prescriptionCreated');
      default: return t('doctor.newPrescription');
    }
  };

  useDocumentTitle(getStepTitle());

  // Keyboard shortcut: Cmd/Ctrl + Enter to submit
  useEffect(() => {
    const handleKeyDown = (e) => {
      if ((e.metaKey || e.ctrlKey) && e.key === 'Enter' && step === 1) {
        e.preventDefault();
        const form = document.querySelector('form');
        if (form && !isLoading) {
          const patientComplete = prescriptionData.patientName && prescriptionData.patientId &&
            prescriptionData.age && prescriptionData.diagnosis &&
            (prescriptionData.contactMethod === 'email' ? prescriptionData.patientEmail : prescriptionData.patientPhone);
          const medicationsComplete = prescriptionData.medications.some(m => m.name);
          if (patientComplete && medicationsComplete) {
            form.requestSubmit();
          }
        }
      }
    };
    window.addEventListener('keydown', handleKeyDown);
    return () => window.removeEventListener('keydown', handleKeyDown);
  }, [step, isLoading, prescriptionData]);

  // Template selection handler
  const handleTemplateSelect = (template) => {
    setPrescriptionData(prev => ({
      ...prev,
      diagnosis: template.diagnosis,
      maxDispenses: template.maxDispenses,
      medications: template.medications.map(med => ({ ...med }))
    }));
    setHasFormData(true);
  };

  // Clear template handler
  const handleClearTemplate = () => {
    setPrescriptionData(prev => ({
      ...prev,
      diagnosis: '',
      medications: [{ name: '', code: '', dosage: '', unit: 'tablet', frequency: '', duration: '', durationUnit: 'days', instructions: '' }]
    }));
  };

  // Auto-save functionality
  useEffect(() => {
    if (autoSaveTimeoutRef.current) {
      clearTimeout(autoSaveTimeoutRef.current);
    }

    // Check if there's any meaningful data
    const hasData = prescriptionData.patientName ||
      prescriptionData.diagnosis ||
      prescriptionData.medications.some(m => m.name);

    setHasFormData(hasData);

    if (hasData && step === 1) {
      autoSaveTimeoutRef.current = setTimeout(() => {
        try {
          localStorage.setItem('prescription_draft', JSON.stringify({
            data: prescriptionData,
            timestamp: new Date().toISOString()
          }));
          setLastSaved(new Date());
        } catch (e) {
          console.warn('Failed to auto-save:', e);
        }
      }, 30000); // Auto-save every 30 seconds
    }

    return () => {
      if (autoSaveTimeoutRef.current) {
        clearTimeout(autoSaveTimeoutRef.current);
      }
    };
  }, [prescriptionData, step]);

  // Load draft on mount (only once per session)
  useEffect(() => {
    // Check if we've already asked about the draft in this session
    const draftAsked = sessionStorage.getItem('draft_asked');
    if (draftAsked) return; // Don't ask again in this session

    try {
      const draft = localStorage.getItem('prescription_draft');
      if (draft) {
        const { data, timestamp } = JSON.parse(draft);
        // Only load if draft is less than 24 hours old
        const draftAge = Date.now() - new Date(timestamp).getTime();
        if (draftAge < 24 * 60 * 60 * 1000) {
          // Mark that we've asked about the draft in this session
          sessionStorage.setItem('draft_asked', 'true');

          const shouldLoad = window.confirm(
            t('doctor.draftFoundMessage') ||
            'A draft prescription was found. Would you like to continue editing it?'
          );
          if (shouldLoad) {
            setPrescriptionData(data);
            setHasFormData(true);
          } else {
            localStorage.removeItem('prescription_draft');
          }
        } else {
          localStorage.removeItem('prescription_draft');
        }
      }
    } catch (e) {
      console.warn('Failed to load draft:', e);
    }
  }, [t]);

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

  const computeSubtitle = (m) => {
    const raw = m?.raw || {};
    const fromRaw = pickRawField(raw, ['Libellé', 'Libelle', 'Désignation', 'Designation', 'Description', 'Composition', 'Forme', 'Forms', 'Presentation', 'Présentation']);
    if (fromRaw) return fromRaw;
    if (Array.isArray(m?.forms) && m.forms.length) return m.forms.join(', ');
    return '';
  };

  const formatPrice = (price) => {
    if (!price) return '';
    const p = String(price).match(/\d+[\.,]?\d*/)?.[0] || String(price);
    return `${p} MAD`;
  };

  const formatRate = (rate) => {
    if (!rate) return '';
    const r = String(rate).match(/\d+\.?\d*/)?.[0];
    if (!r) return '';
    return `${r}% covered`;
  };

  const extractPrice = (obj) => {
    if (obj?.price) return obj.price;
    const raw = obj?.raw || obj?.sourceRaw || {};
    const direct = pickRawField(raw, ['Prix public de vente', 'Prix public', 'Prix', 'PPP', 'PPA', 'Tarif', 'Price', 'PRIX', 'PRIX PUBLIC']);
    if (direct) return direct;
    // Heuristic scan across all raw fields for likely price values
    let best = null;
    for (const [k, v] of Object.entries(raw)) {
      const keyNorm = normalizeKey(k);
      if (!v && v !== 0) continue;
      const valStr = String(v);
      const numMatch = valStr.match(/\d+[\.,]?\d*/);
      if (!numMatch) continue;
      const num = parseFloat(numMatch[0].replace(',', '.'));
      if (isNaN(num)) continue;
      // Prefer keys that mention price or tariff
      const isPriceKey = /(prix|price|tarif|ppa|ppp|montant)/.test(keyNorm);
      if (isPriceKey && num > 0 && num < 100000) {
        best = valStr;
        break;
      }
      if (!best && num > 0 && num < 100000) {
        best = valStr;
      }
    }
    return best || undefined;
  };

  const extractRate = (obj) => {
    if (obj?.reimbursementRate) return obj.reimbursementRate;
    const raw = obj?.raw || obj?.sourceRaw || {};
    const direct = pickRawField(raw, ['Taux de remboursement', 'Taux', 'Remboursement', 'Rate', 'Reimbursement rate', 'TAUX']);
    if (direct) return direct;
    // Heuristic scan: look for percentage-like fields or 0-100 numbers with relevant keys
    let best = null;
    for (const [k, v] of Object.entries(raw)) {
      const keyNorm = normalizeKey(k);
      if (!v && v !== 0) continue;
      const valStr = String(v);
      const pct = valStr.match(/\d{1,3}(?:\.\d+)?\s*%/);
      if (pct) {
        best = pct[0];
        break;
      }
      const numMatch = valStr.match(/\b\d{1,3}(?:\.\d+)?\b/);
      if (!numMatch) continue;
      const num = parseFloat(numMatch[0]);
      const isRateKey = /(taux|rate|rembours)/.test(keyNorm);
      if (isRateKey && num >= 0 && num <= 100) {
        best = `${num}%`;
        break;
      }
      if (!best && num >= 0 && num <= 100) {
        best = `${num}%`;
      }
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

  // Load medicines from backend unified endpoint
  const [medicinesLoading, setMedicinesLoading] = useState(true);
  useEffect(() => {
    let mounted = true;
    (async () => {
      try {
        setMedicinesLoading(true);
        const resp = await fetch('/api/medicines');
        const data = await resp.json();
        if (mounted) setMedicines(Array.isArray(data) ? data : []);
      } catch (_) {
        if (mounted) setMedicines([]);
      } finally {
        if (mounted) setMedicinesLoading(false);
      }
    })();
    return () => { mounted = false; };
  }, []);

  // Real-time totals calculation
  useEffect(() => {
    const totals = (prescriptionData.medications || []).reduce((acc, m) => {
      if (!m.name) return acc;
      const found = (medicines || []).find(x =>
        (x.code && m.code && x.code === m.code) ||
        (x.name && m.name && x.name.toLowerCase() === m.name.toLowerCase())
      ) || {};
      const price = getPriceNumber(extractPrice(found));
      const rate = getRateNumber(extractRate(found));
      const covered = price * (rate / 100);
      acc.total += price;
      acc.covered += covered;
      return acc;
    }, { total: 0, covered: 0 });
    const patient = Math.max(0, totals.total - totals.covered);
    setRealTimeTotals({
      total: Number(totals.total.toFixed(2)),
      covered: Number(totals.covered.toFixed(2)),
      patient: Number(patient.toFixed(2))
    });
  }, [prescriptionData.medications, medicines]);

  const handleInputChange = (e) => {
    const { name, value } = e.target;
    setPrescriptionData(prev => ({
      ...prev,
      [name]: value
    }));
  };

  const handleMedicationChange = (index, e) => {
    const { name, value } = e.target;
    const updatedMedications = [...prescriptionData.medications];
    updatedMedications[index] = {
      ...updatedMedications[index],
      [name]: value
    };

    setPrescriptionData(prev => ({
      ...prev,
      medications: updatedMedications
    }));
  };

  const handleMedicineSearch = (index, value) => {
    setActiveSuggestIndex(index);
    const q = (value || '').trim();
    if (searchTimeoutRef.current) {
      clearTimeout(searchTimeoutRef.current);
    }
    if (q.length < 1) {
      setSuggestions([]);
      setSearchLoading(false);
      return;
    }
    setSearchLoading(true);
    searchTimeoutRef.current = setTimeout(() => {
      try {
        const qNorm = q.toLowerCase();
        const mapped = (medicines || [])
          .filter(m => {
            const words = String(m.name || '').toLowerCase().split(/\s+/).filter(Boolean);
            const tokens = qNorm.split(' ').filter(Boolean);
            return tokens.every(t => words.some(w => w.startsWith(t)));
          })
          .slice(0, 10)
          .map(m => ({ name: m.name, code: m.code, price: m.price, reimbursementRate: m.reimbursementRate, forms: m.forms, subtitle: computeSubtitle(m), raw: m.raw }));
        setSuggestions(mapped);
        setSearchLoading(false);
      } catch (_) {
        setSuggestions([]);
        setSearchLoading(false);
      }
    }, 200);
  };

  const selectMedicine = (index, medicine) => {
    const updatedMedications = [...prescriptionData.medications];
    updatedMedications[index] = {
      ...updatedMedications[index],
      name: medicine.name,
      code: medicine.code
    };

    setPrescriptionData(prev => ({
      ...prev,
      medications: updatedMedications
    }));

    setSuggestions([]);
    setSearchLoading(false);
  };



  const addMedication = () => {
    setPrescriptionData(prev => ({
      ...prev,
      medications: [
        ...prev.medications,
        {
          name: '',
          dosage: '',
          unit: 'mg',
          frequency: '1',
          duration: '7',
          durationUnit: 'days',
          instructions: ''
        }
      ]
    }));
  };

  const removeMedication = (index) => {
    if (prescriptionData.medications.length === 1) return;

    const updatedMedications = prescriptionData.medications.filter((_, i) => i !== index);
    setPrescriptionData(prev => ({
      ...prev,
      medications: updatedMedications
    }));
  };

  const handleSubmit = async (e) => {
    e.preventDefault();
    setIsLoading(true);
    setError('');

    try {
      // Attempt to capture geolocation with user consent
      let currentGeo = geo;
      if (!currentGeo && navigator.geolocation) {
        try {
          currentGeo = await new Promise((resolve, reject) => {
            navigator.geolocation.getCurrentPosition(
              (pos) => resolve({ lat: pos.coords.latitude, lng: pos.coords.longitude }),
              () => resolve(null),
              { enableHighAccuracy: false, timeout: 3000 }
            );
          });
          setGeo(currentGeo);
        } catch (_) {
          // ignore geo errors
        }
      }

      // CNSS Approval in background (non-blocking)
      const token = localStorage.getItem('auth_token');
      setCnssLoading(true);
      fetch('/api/cnss-approve', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          ...(token ? { Authorization: `Bearer ${token}` } : {})
        },
        body: JSON.stringify({ formData: prescriptionData })
      })
        .then(res => res.json())
        .then(data => {
          if (data.success && data.approved) {
            setCnss({ approved: true, code: data.approvalCode });
          }
          setCnssLoading(false);
        })
        .catch(() => setCnssLoading(false));

      // Create prescription directly (skip Step 2)
      const response = await fetch('/api/issue-prescription', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', ...(token ? { Authorization: `Bearer ${token}` } : {}) },
        body: JSON.stringify({ formData: prescriptionData, geo: currentGeo, ...(doctorNationalId ? { nationalId: doctorNationalId } : {}) })
      });
      const data = await response.json();

      if (!response.ok || !data.success) {
        throw new Error(data?.error || 'Failed to create prescription');
      }

      const created = {
        id: data.prescriptionId,
        ...prescriptionData,
        date: new Date().toISOString(),
        nft: data.nft,
        storageRef: data.storageRef,
        qr: data.qr
      };

      console.log('[DOCTOR FORM] API Response data.qr:', JSON.stringify(data.qr));
      console.log('[DOCTOR FORM] Created prescription object:', JSON.stringify(created.qr));

      setCreatedPrescription(created);
      setStep(2); // Go directly to success step

      // Clear draft and session flag after successful creation
      localStorage.removeItem('prescription_draft');
      sessionStorage.removeItem('draft_asked');

      // Save to history
      try {
        await enc.pushToArray('prescriptions', {
          id: created.id,
          date: created.date,
          patientName: prescriptionData.patientName,
          diagnosis: prescriptionData.diagnosis,
          medications: (prescriptionData.medications || []).map(m => ({
            name: m.name,
            dosage: m.dosage,
            unit: m.unit
          }))
        });
      } catch (_) { }
    } catch (err) {
      console.error('Error creating prescription:', err);
      setError(err.message || 'An error occurred while creating the prescription. Please try again.');
    } finally {
      setIsLoading(false);
    }
  };

  // No API details lookup (kept simple)

  const renderStep1 = () => (
    <form onSubmit={handleSubmit} className="space-y-8">
      {/* Template Selector & Auto-save indicator */}
      <div className="relative z-[200] bg-white/90 backdrop-blur rounded-2xl shadow-lg ring-1 ring-slate-900/5 p-6 hover:shadow-xl transition-all duration-300">
        <div className="flex items-center justify-between">
          <div className="flex items-center gap-3">
            <div className="flex items-center gap-2 text-sm font-medium text-slate-700">
              <FiFileText className="h-5 w-5 text-emerald-500" />
              <span>Quick Start:</span>
            </div>
            <PrescriptionTemplates
              onSelectTemplate={handleTemplateSelect}
              disabled={hasFormData && prescriptionData.medications.some(m => m.name)}
            />
            {prescriptionData.medications.some(m => m.name) && (
              <button
                type="button"
                onClick={handleClearTemplate}
                className="inline-flex items-center gap-1.5 px-3 py-2 text-xs font-semibold rounded-lg text-red-600 bg-red-50 hover:bg-red-100 border border-red-200 transition-all hover:scale-105"
                title="Clear medications and start fresh"
              >
                <FiX className="h-3.5 w-3.5" />
                Clear Template
              </button>
            )}
          </div>
          {lastSaved && (
            <div className="flex items-center gap-2 px-3 py-1.5 text-xs text-emerald-700 bg-emerald-50 rounded-lg border border-emerald-200 animate-pulse">
              <FiCheckCircle className="h-3.5 w-3.5" />
              <span className="font-medium">Saved {lastSaved.toLocaleTimeString()}</span>
            </div>
          )}
        </div>
      </div>

      {/* Patient Information Section - Collapsible */}
      <div className="relative z-10 bg-white/90 backdrop-blur rounded-2xl shadow-xl ring-1 ring-slate-900/5 overflow-hidden transition-all duration-300 hover:shadow-2xl">
        <button
          type="button"
          onClick={() => toggleSection('patientInfo')}
          className="w-full px-8 py-6 flex items-center justify-between bg-gradient-to-r from-emerald-50 to-teal-50 hover:from-emerald-100 hover:to-teal-100 transition-all"
        >
          <div className="flex items-center gap-4">
            <div className="flex items-center justify-center w-10 h-10 rounded-full bg-white shadow-md">
              <span className="text-lg font-bold text-emerald-600">1</span>
            </div>
            <div className="text-left">
              <h2 className="text-xl font-bold text-slate-900 flex items-center gap-2">
                <FiUser className="h-5 w-5 text-emerald-600" />
                {t('doctor.patientInfo')}
              </h2>
              <p className="text-sm text-slate-600 mt-0.5">Patient demographics and contact information</p>
            </div>
          </div>
          <div className="flex items-center gap-3">
            {isSectionComplete('patientInfo') && (
              <div className="flex items-center gap-1.5 px-3 py-1.5 bg-green-100 text-green-700 rounded-full text-xs font-semibold">
                <FiCheckCircle className="h-4 w-4" />
                <span>Complete</span>
              </div>
            )}
            {sectionsExpanded.patientInfo ? (
              <FiChevronUp className="h-6 w-6 text-slate-400" />
            ) : (
              <FiChevronDown className="h-6 w-6 text-slate-400" />
            )}
          </div>
        </button>

        <div className={`transition-all duration-300 ease-in-out ${sectionsExpanded.patientInfo ? 'max-h-[2000px] opacity-100' : 'max-h-0 opacity-0'} overflow-hidden`}>
          <div className="px-8 py-6">
            <div className="grid grid-cols-1 md:grid-cols-2 gap-6">
              {/* Doctor National ID */}
              <div className="group">
                <label htmlFor="doctorNationalId" className="flex items-center gap-2 text-xs font-semibold uppercase tracking-wide text-slate-600 mb-2">
                  <FiUser className="h-4 w-4 text-emerald-500" />
                  Doctor National ID
                </label>
                <div className="relative">
                  <input
                    type="text"
                    id="doctorNationalId"
                    name="doctorNationalId"
                    value={doctorNationalId}
                    onChange={(e) => setDoctorNationalId(e.target.value)}
                    className="block w-full rounded-xl border-0 ring-1 ring-slate-300 focus:ring-2 focus:ring-emerald-500 hover:ring-emerald-300 shadow-sm py-3 px-3 placeholder-slate-400 transition-all h-12"
                    placeholder="e.g. AB123456"
                  />
                  {doctorNationalId && (
                    <FiCheckCircle className="absolute right-3 top-1/2 -translate-y-1/2 h-5 w-5 text-green-500" />
                  )}
                </div>
              </div>

              {/* Patient ID */}
              <div className="group">
                <label htmlFor="patientId" className="flex items-center gap-2 text-xs font-semibold uppercase tracking-wide text-slate-600 mb-2">
                  <FiFileText className="h-4 w-4 text-emerald-500" />
                  {t('doctor.patientId')}
                </label>
                <div className="relative">
                  <input
                    type="text"
                    id="patientId"
                    name="patientId"
                    value={prescriptionData.patientId}
                    onChange={handleInputChange}
                    className="block w-full rounded-xl border-0 ring-1 ring-slate-300 focus:ring-2 focus:ring-emerald-500 hover:ring-emerald-300 shadow-sm py-3 px-3 placeholder-slate-400 transition-all h-12"
                    placeholder="e.g. M123456"
                    required
                  />
                  {prescriptionData.patientId && (
                    <FiCheckCircle className="absolute right-3 top-1/2 -translate-y-1/2 h-5 w-5 text-green-500" />
                  )}
                </div>
              </div>

              {/* Patient Name */}
              <div className="group">
                <label htmlFor="patientName" className="flex items-center gap-2 text-xs font-semibold uppercase tracking-wide text-slate-600 mb-2">
                  <FiUser className="h-4 w-4 text-emerald-500" />
                  {t('doctor.patientName')}
                </label>
                <div className="relative">
                  <input
                    type="text"
                    id="patientName"
                    name="patientName"
                    value={prescriptionData.patientName}
                    onChange={handleInputChange}
                    className="block w-full rounded-xl border-0 ring-1 ring-slate-300 focus:ring-2 focus:ring-emerald-500 hover:ring-emerald-300 shadow-sm py-3 px-3 placeholder-slate-400 transition-all h-12"
                    placeholder="e.g. Ahmed Hassan"
                    required
                  />
                  {prescriptionData.patientName && (
                    <FiCheckCircle className="absolute right-3 top-1/2 -translate-y-1/2 h-5 w-5 text-green-500" />
                  )}
                </div>
              </div>

              {/* Patient Email */}
              <div className="group">
                <label htmlFor="patientEmail" className="flex items-center gap-2 text-xs font-semibold uppercase tracking-wide text-slate-600 mb-2">
                  <FiMail className="h-4 w-4 text-emerald-500" />
                  {t('doctor.patientEmail')}
                </label>
                <div className="relative">
                  <input
                    type="email"
                    id="patientEmail"
                    name="patientEmail"
                    value={prescriptionData.patientEmail}
                    onChange={handleInputChange}
                    className="block w-full rounded-xl border-0 ring-1 ring-slate-300 focus:ring-2 focus:ring-emerald-500 hover:ring-emerald-300 shadow-sm py-3 px-3 placeholder-slate-400 transition-all h-12"
                    placeholder="patient@email.com"
                    required={prescriptionData.contactMethod === 'email'}
                  />
                  {prescriptionData.patientEmail && (
                    <FiCheckCircle className="absolute right-3 top-1/2 -translate-y-1/2 h-5 w-5 text-green-500" />
                  )}
                </div>
              </div>

              {/* Contact Method */}
              <div className="md:col-span-2">
                <label className="flex items-center gap-2 text-xs font-semibold uppercase tracking-wide text-slate-600 mb-3">
                  <FiPhone className="h-4 w-4 text-emerald-500" />
                  Contact Method
                </label>
                <div className="flex gap-4">
                  <label className="flex items-center gap-2 cursor-pointer px-4 py-3 rounded-xl bg-slate-50 hover:bg-emerald-50 transition-all border-2 border-transparent has-[:checked]:border-emerald-500 has-[:checked]:bg-emerald-50">
                    <input
                      type="radio"
                      name="contactMethod"
                      value="email"
                      checked={prescriptionData.contactMethod === 'email'}
                      onChange={handleInputChange}
                      className="w-4 h-4 text-emerald-600 focus:ring-emerald-500"
                    />
                    <span className="text-sm font-medium text-slate-700">Email</span>
                  </label>
                  <label className="flex items-center gap-2 cursor-pointer px-4 py-3 rounded-xl bg-slate-50 hover:bg-emerald-50 transition-all border-2 border-transparent has-[:checked]:border-emerald-500 has-[:checked]:bg-emerald-50">
                    <input
                      type="radio"
                      name="contactMethod"
                      value="sms"
                      checked={prescriptionData.contactMethod === 'sms'}
                      onChange={handleInputChange}
                      className="w-4 h-4 text-emerald-600 focus:ring-emerald-500"
                    />
                    <span className="text-sm font-medium text-slate-700">SMS</span>
                  </label>
                  <label className="flex items-center gap-2 cursor-pointer px-4 py-3 rounded-xl bg-slate-50 hover:bg-emerald-50 transition-all border-2 border-transparent has-[:checked]:border-emerald-500 has-[:checked]:bg-emerald-50">
                    <input
                      type="radio"
                      name="contactMethod"
                      value="whatsapp"
                      checked={prescriptionData.contactMethod === 'whatsapp'}
                      onChange={handleInputChange}
                      className="w-4 h-4 text-emerald-600 focus:ring-emerald-500"
                    />
                    <span className="text-sm font-medium text-slate-700">WhatsApp</span>
                  </label>
                </div>
              </div>

              {/* Phone Number */}
              {(prescriptionData.contactMethod === 'sms' || prescriptionData.contactMethod === 'whatsapp') && (
                <div className="md:col-span-2 group animate-fadeIn">
                  <label htmlFor="patientPhone" className="flex items-center gap-2 text-xs font-semibold uppercase tracking-wide text-slate-600 mb-2">
                    <FiPhone className="h-4 w-4 text-emerald-500" />
                    Phone Number
                  </label>
                  <div className="relative">
                    <input
                      type="tel"
                      id="patientPhone"
                      name="patientPhone"
                      value={prescriptionData.patientPhone}
                      onChange={handleInputChange}
                      placeholder="+212612345678"
                      className="block w-full rounded-xl border-0 ring-1 ring-slate-300 focus:ring-2 focus:ring-emerald-500 hover:ring-emerald-300 shadow-sm py-3 px-3 placeholder-slate-400 transition-all h-12"
                      required
                    />
                    {prescriptionData.patientPhone && (
                      <FiCheckCircle className="absolute right-3 top-1/2 -translate-y-1/2 h-5 w-5 text-green-500" />
                    )}
                  </div>
                  <p className="mt-1 text-xs text-slate-500 flex items-center gap-1">
                    <FiInfo className="h-3 w-3" />
                    Include country code (e.g., +212 for Morocco)
                  </p>
                </div>
              )}

              {/* Age */}
              <div className="group">
                <label htmlFor="age" className="flex items-center gap-2 text-xs font-semibold uppercase tracking-wide text-slate-600 mb-2">
                  <FiCalendar className="h-4 w-4 text-emerald-500" />
                  {t('doctor.age')}
                </label>
                <div className="relative">
                  <input
                    type="text"
                    id="age"
                    name="age"
                    value={prescriptionData.age}
                    onChange={handleInputChange}
                    placeholder="e.g. 45"
                    className="block w-full rounded-xl border-0 ring-1 ring-slate-300 focus:ring-2 focus:ring-emerald-500 hover:ring-emerald-300 shadow-sm py-3 px-3 placeholder-slate-400 transition-all h-12"
                    required
                  />
                  {prescriptionData.age && (
                    <FiCheckCircle className="absolute right-3 top-1/2 -translate-y-1/2 h-5 w-5 text-green-500" />
                  )}
                </div>
              </div>

              {/* Max Dispenses */}
              <div className="group">
                <label htmlFor="maxDispenses" className="flex items-center gap-2 text-xs font-semibold uppercase tracking-wide text-slate-600 mb-2">
                  <FiTrendingUp className="h-4 w-4 text-emerald-500" />
                  {t('doctor.maxDispenses')}
                  <button type="button" className="group/tooltip relative">
                    <FiInfo className="h-3.5 w-3.5 text-slate-400 hover:text-emerald-500" />
                    <span className="invisible group-hover/tooltip:visible absolute left-6 -top-2 w-48 px-3 py-2 text-xs bg-slate-800 text-white rounded-lg shadow-lg z-10">
                      Number of times this prescription can be refilled
                    </span>
                  </button>
                </label>
                <div className="relative">
                  <input
                    type="number"
                    id="maxDispenses"
                    name="maxDispenses"
                    min="1"
                    max="12"
                    value={prescriptionData.maxDispenses}
                    onChange={handleInputChange}
                    className="block w-full rounded-xl border-0 ring-1 ring-slate-300 focus:ring-2 focus:ring-emerald-500 hover:ring-emerald-300 shadow-sm py-3 px-3 placeholder-slate-400 transition-all h-12"
                    required
                  />
                  {prescriptionData.maxDispenses && (
                    <FiCheckCircle className="absolute right-3 top-1/2 -translate-y-1/2 h-5 w-5 text-green-500" />
                  )}
                </div>
                <p className="mt-1 text-xs text-slate-500">{t('doctor.maxDispensesHelp')}</p>
              </div>
            </div>

            {/* Diagnosis */}
            <div className="mt-6 group">
              <label htmlFor="diagnosis" className="flex items-center gap-2 text-xs font-semibold uppercase tracking-wide text-slate-600 mb-2">
                <FiFileText className="h-4 w-4 text-emerald-500" />
                {t('doctor.diagnosis')}
                <span className="ml-auto text-xs text-slate-400">{prescriptionData.diagnosis.length} / 500</span>
              </label>
              <div className="relative">
                <textarea
                  id="diagnosis"
                  name="diagnosis"
                  rows={3}
                  maxLength={500}
                  value={prescriptionData.diagnosis}
                  onChange={handleInputChange}
                  className="block w-full rounded-xl border-0 ring-1 ring-slate-300 focus:ring-2 focus:ring-emerald-500 hover:ring-emerald-300 shadow-sm py-3 px-3 placeholder-slate-400 transition-all resize-none"
                  placeholder="Enter detailed diagnosis..."
                  required
                />
                {prescriptionData.diagnosis && (
                  <FiCheckCircle className="absolute right-3 top-3 h-5 w-5 text-green-500" />
                )}
              </div>
            </div>
          </div>
        </div>
      </div>

      {/* Medications Section - Collapsible */}
      <div className="relative z-10 bg-white/90 backdrop-blur rounded-2xl shadow-xl ring-1 ring-slate-900/5 overflow-hidden transition-all duration-300 hover:shadow-2xl">
        <button
          type="button"
          onClick={() => toggleSection('medications')}
          className="w-full px-8 py-6 flex items-center justify-between bg-gradient-to-r from-teal-50 to-emerald-50 hover:from-teal-100 hover:to-emerald-100 transition-all"
        >
          <div className="flex items-center gap-4">
            <div className="flex items-center justify-center w-10 h-10 rounded-full bg-white shadow-md">
              <span className="text-lg font-bold text-emerald-600">2</span>
            </div>
            <div className="text-left">
              <h2 className="text-xl font-bold text-slate-900 flex items-center gap-2">
                <FiFileText className="h-5 w-5 text-emerald-600" />
                {t('doctor.medications')}
              </h2>
              <p className="text-sm text-slate-600 mt-0.5">{prescriptionData.medications.length} medication(s) • Click to {sectionsExpanded.medications ? 'collapse' : 'expand'}</p>
            </div>
          </div>
          <div className="flex items-center gap-3">
            {isSectionComplete('medications') && (
              <div className="flex items-center gap-1.5 px-3 py-1.5 bg-green-100 text-green-700 rounded-full text-xs font-semibold">
                <FiCheckCircle className="h-4 w-4" />
                <span>Complete</span>
              </div>
            )}
            {sectionsExpanded.medications ? (
              <FiChevronUp className="h-6 w-6 text-slate-400" />
            ) : (
              <FiChevronDown className="h-6 w-6 text-slate-400" />
            )}
          </div>
        </button>

        <div className={`transition-all duration-300 ease-in-out ${sectionsExpanded.medications ? 'max-h-[5000px] opacity-100' : 'max-h-0 opacity-0'} overflow-hidden`}>
          <div className="px-8 py-6">
            <div className="flex justify-between items-center mb-6">
              <p className="text-sm text-slate-600">Add all medications for this prescription</p>
              <button
                type="button"
                onClick={addMedication}
                className="inline-flex items-center gap-2 px-4 py-2.5 text-sm font-semibold rounded-xl text-white bg-gradient-to-r from-emerald-500 to-teal-400 hover:from-emerald-400 hover:to-teal-300 shadow-lg ring-1 ring-white/10 hover:scale-105 transition-all"
              >
                <FiPlus className="h-4 w-4" /> {t('doctor.addMedication')}
              </button>
            </div>

            {prescriptionData.medications.map((med, index) => (
              <div key={index} className="relative group mb-6 last:mb-0 animate-fadeIn">
                {/* Medication Card with Shadow and Hover Effect */}
                <div className="ring-1 ring-slate-200 rounded-2xl p-6 bg-gradient-to-br from-white to-slate-50/50 shadow-md hover:shadow-xl hover:ring-emerald-300 transition-all duration-300">
                  {/* Card Header with Badge */}
                  <div className="flex items-center justify-between mb-5 pb-4 border-b border-slate-200">
                    <div className="flex items-center gap-3">
                      <div className="flex items-center justify-center w-8 h-8 rounded-full bg-gradient-to-br from-emerald-500 to-teal-400 shadow-md">
                        <span className="text-sm font-bold text-white">{index + 1}</span>
                      </div>
                      <span className="text-sm font-semibold text-slate-700">Medication {index + 1}</span>
                      {med.name && (
                        <div className="flex items-center gap-1 px-2 py-1 bg-green-100 text-green-700 rounded-full text-xs font-medium">
                          <FiCheckCircle className="h-3 w-3" />
                          <span>Set</span>
                        </div>
                      )}
                    </div>
                    {index > 0 && (
                      <button
                        type="button"
                        onClick={() => removeMedication(index)}
                        className="inline-flex items-center gap-1.5 px-3 py-1.5 text-xs font-semibold rounded-lg text-red-600 bg-red-50 hover:bg-red-100 border border-red-200 transition-all hover:scale-105 opacity-0 group-hover:opacity-100"
                        title="Remove medication"
                      >
                        <FiTrash2 className="h-3.5 w-3.5" />
                        Remove
                      </button>
                    )}
                  </div>

                  {/* Card Content */}
                  <div className="space-y-5">
                    {/* Medication Search - Enhanced */}
                    <div className="relative">
                      <label htmlFor={`medication-${index}`} className="flex items-center gap-2 text-sm font-semibold text-slate-700 mb-2">
                        <FiSearch className="h-4 w-4 text-emerald-500" />
                        {t('doctor.medication')}
                      </label>
                      <div className="relative">
                        <div className="absolute top-1/2 -translate-y-1/2 pointer-events-none z-10" style={{ left: '12px' }}>
                          {searchLoading && activeSuggestIndex === index ? (
                            <svg className="animate-spin text-emerald-600" style={{ width: '16px', height: '16px' }} viewBox="0 0 24 24">
                              <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4" fill="none" />
                              <path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8v4a4 4 0 00-4 4H4z" />
                            </svg>
                          ) : (
                            <FiSearch style={{ width: '16px', height: '16px' }} className="text-slate-500" />
                          )}
                        </div>
                        <input
                          type="text"
                          id={`medication-${index}`}
                          name="name"
                          value={med.name}
                          onChange={(e) => {
                            handleMedicationChange(index, e);
                            handleMedicineSearch(index, e.target.value);
                            setSearchLoading(true);
                          }}
                          style={{ paddingLeft: '44px', paddingRight: '44px' }}
                          className="block w-full h-12 rounded-xl border-0 ring-1 ring-slate-300 focus:ring-2 focus:ring-emerald-500 hover:ring-emerald-300 placeholder-slate-400 transition-all shadow-sm text-slate-900"
                          placeholder="Type to search medications..."
                          required
                        />
                        {med.name && (
                          <FiCheckCircle className="absolute right-3 top-1/2 -translate-y-1/2 h-5 w-5 text-green-500" />
                        )}
                      </div>
                      {activeSuggestIndex === index && suggestions.length > 0 && (
                        <ul className="absolute z-[200] mt-2 w-full bg-white border border-slate-200 rounded-xl shadow-2xl max-h-96 overflow-auto animate-fadeIn">
                          <li className="px-4 py-3 text-xs text-slate-700 border-b border-slate-100 sticky top-0 bg-gradient-to-r from-emerald-50 to-teal-50 font-medium flex items-center justify-between">
                            <span>Found {suggestions.length} medication(s)</span>
                            <span className="text-[10px] text-slate-500">↑ ↓ to navigate • Enter to select</span>
                          </li>
                          {suggestions.map((suggestion, i) => {
                            const priceText = formatPrice(extractPrice(suggestion));
                            const rateText = formatRate(extractRate(suggestion));
                            return (
                              <li
                                key={i}
                                className="px-4 py-3 hover:bg-emerald-50 cursor-pointer border-b border-slate-50"
                                onClick={() => selectMedicine(index, suggestion)}
                              >
                                <div className="flex flex-col">
                                  <div className="text-slate-900 font-bold uppercase tracking-wide">{suggestion.name}</div>
                                  {suggestion.subtitle && (
                                    <div className="mt-1 text-[11px] text-slate-600 uppercase leading-snug">{suggestion.subtitle}</div>
                                  )}
                                  <div className="mt-2 flex items-center justify-between">
                                    {priceText && (
                                      <span className="inline-flex items-center px-2.5 py-0.5 rounded-full text-xs font-semibold bg-blue-100 text-blue-800">{priceText}</span>
                                    )}
                                    {rateText && (
                                      <span className="inline-flex items-center px-2.5 py-0.5 rounded-full text-xs font-semibold bg-green-100 text-green-800">{rateText}</span>
                                    )}
                                  </div>
                                </div>
                              </li>
                            );
                          })}
                        </ul>
                      )}
                    </div>

                    {/* Frequency, Duration, Unit - Enhanced Grid */}
                    <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
                      <div className="group">
                        <label htmlFor={`frequency-${index}`} className="flex items-center gap-2 text-sm font-semibold text-slate-700 mb-2">
                          <FiTrendingUp className="h-4 w-4 text-emerald-500" />
                          {t('doctor.frequency')}
                        </label>
                        <input
                          type="text"
                          id={`frequency-${index}`}
                          name="frequency"
                          value={med.frequency}
                          onChange={(e) => handleMedicationChange(index, e)}
                          className="block w-full h-12 rounded-xl border-0 ring-1 ring-slate-300 focus:ring-2 focus:ring-emerald-500 hover:ring-emerald-300 px-3 transition-all shadow-sm"
                          placeholder="e.g. 1, 2, 3"
                        />
                      </div>
                      <div className="group">
                        <label htmlFor={`duration-${index}`} className="flex items-center gap-2 text-sm font-semibold text-slate-700 mb-2">
                          <FiCalendar className="h-4 w-4 text-emerald-500" />
                          {t('doctor.duration')}
                        </label>
                        <input
                          type="text"
                          inputMode="numeric"
                          pattern="[0-9]*"
                          id={`duration-${index}`}
                          name="duration"
                          value={med.duration}
                          onChange={(e) => handleMedicationChange(index, e)}
                          className="block w-full h-12 rounded-xl border-0 ring-1 ring-slate-300 focus:ring-2 focus:ring-emerald-500 hover:ring-emerald-300 px-3 transition-all shadow-sm"
                          placeholder="7"
                          required
                        />
                      </div>
                      <div className="group">
                        <label className="flex items-center gap-2 text-sm font-semibold text-slate-700 mb-2">
                          <FiFileText className="h-4 w-4 text-emerald-500" />
                          {t('doctor.unit')}
                        </label>
                        <select
                          name="durationUnit"
                          value={med.durationUnit}
                          onChange={(e) => handleMedicationChange(index, e)}
                          className="block w-full h-12 rounded-xl border-0 ring-1 ring-slate-300 focus:ring-2 focus:ring-emerald-500 hover:ring-emerald-300 px-3 transition-all shadow-sm"
                        >
                          <option value="days">days</option>
                          <option value="weeks">weeks</option>
                          <option value="months">months</option>
                        </select>
                      </div>
                    </div>

                    {/* Instructions */}
                    <div className="group">
                      <label htmlFor={`instructions-${index}`} className="flex items-center gap-2 text-sm font-semibold text-slate-700 mb-2">
                        <FiInfo className="h-4 w-4 text-emerald-500" />
                        {t('doctor.instructions')}
                      </label>
                      <input
                        type="text"
                        id={`instructions-${index}`}
                        name="instructions"
                        value={med.instructions}
                        onChange={(e) => handleMedicationChange(index, e)}
                        className="block w-full h-12 rounded-xl border-0 ring-1 ring-slate-300 focus:ring-2 focus:ring-emerald-500 hover:ring-emerald-300 px-3 placeholder-slate-400 transition-all shadow-sm"
                        placeholder={t('doctor.instructionsPlaceholder') || 'e.g. Take with food, avoid alcohol'}
                      />
                    </div>
                  </div>
                </div>
              </div>
            ))}
          </div>
        </div>
      </div>

      {/* Cost Breakdown - Premium Card */}
      {prescriptionData.medications.some(m => m.name) && (
        <div className="relative z-10 bg-gradient-to-br from-blue-50 via-indigo-50 to-purple-50 rounded-2xl shadow-xl ring-1 ring-blue-900/10 overflow-hidden animate-fadeIn">
          <div className="px-8 py-6">
            <div className="flex items-center justify-between mb-6">
              <h3 className="text-lg font-bold text-slate-900 flex items-center gap-2">
                <FiTrendingUp className="h-5 w-5 text-blue-600" />
                Estimated Costs
              </h3>
              <button type="button" className="group/tooltip relative">
                <FiInfo className="h-4 w-4 text-slate-400 hover:text-blue-600 transition-colors" />
                <span className="invisible group-hover/tooltip:visible absolute right-0 -top-2 w-56 px-3 py-2 text-xs bg-slate-800 text-white rounded-lg shadow-lg z-10">
                  Real-time calculation based on CNSS coverage rates
                </span>
              </button>
            </div>

            {/* Cost Cards Grid */}
            <div className="grid grid-cols-1 md:grid-cols-3 gap-4 mb-5">
              {/* Total Cost */}
              <div className="relative group bg-white rounded-xl p-5 shadow-md hover:shadow-lg transition-all border border-blue-100">
                <div className="flex flex-col items-center">
                  <div className="text-xs font-semibold uppercase tracking-wide text-slate-500 mb-2">Total Cost</div>
                  <div className="text-3xl font-bold bg-gradient-to-r from-blue-600 to-indigo-600 bg-clip-text text-transparent">
                    {realTimeTotals.total.toFixed(2)}
                  </div>
                  <div className="text-xs text-slate-500 mt-1 font-medium">MAD</div>
                </div>
                <div className="absolute inset-0 bg-gradient-to-r from-blue-400/10 to-indigo-400/10 rounded-xl opacity-0 group-hover:opacity-100 transition-opacity pointer-events-none" />
              </div>

              {/* Covered Amount */}
              <div className="relative group bg-white rounded-xl p-5 shadow-md hover:shadow-lg transition-all border border-green-100">
                <div className="flex flex-col items-center">
                  <div className="text-xs font-semibold uppercase tracking-wide text-slate-500 mb-2">CNSS Covered</div>
                  <div className="text-3xl font-bold bg-gradient-to-r from-green-600 to-emerald-600 bg-clip-text text-transparent">
                    {realTimeTotals.covered.toFixed(2)}
                  </div>
                  <div className="text-xs text-slate-500 mt-1 font-medium">MAD</div>
                </div>
                <div className="absolute inset-0 bg-gradient-to-r from-green-400/10 to-emerald-400/10 rounded-xl opacity-0 group-hover:opacity-100 transition-opacity pointer-events-none" />
              </div>

              {/* Patient Pays */}
              <div className="relative group bg-white rounded-xl p-5 shadow-md hover:shadow-lg transition-all border border-amber-100">
                <div className="flex flex-col items-center">
                  <div className="text-xs font-semibold uppercase tracking-wide text-slate-500 mb-2">Patient Pays</div>
                  <div className="text-3xl font-bold bg-gradient-to-r from-amber-600 to-orange-600 bg-clip-text text-transparent">
                    {realTimeTotals.patient.toFixed(2)}
                  </div>
                  <div className="text-xs text-slate-500 mt-1 font-medium">MAD</div>
                </div>
                <div className="absolute inset-0 bg-gradient-to-r from-amber-400/10 to-orange-400/10 rounded-xl opacity-0 group-hover:opacity-100 transition-opacity pointer-events-none" />
              </div>
            </div>

            {/* Coverage Progress Bar */}
            {realTimeTotals.total > 0 && (
              <div className="bg-white rounded-xl p-4 shadow-sm border border-slate-200">
                <div className="flex items-center justify-between mb-2">
                  <span className="text-xs font-semibold text-slate-700">Coverage Breakdown</span>
                  <span className="text-xs font-bold text-emerald-600">
                    {((realTimeTotals.covered / realTimeTotals.total) * 100).toFixed(0)}% Covered
                  </span>
                </div>
                <div className="h-3 bg-slate-200 rounded-full overflow-hidden">
                  <div
                    className="h-full bg-gradient-to-r from-green-500 to-emerald-500 transition-all duration-500 ease-out rounded-full"
                    style={{ width: `${(realTimeTotals.covered / realTimeTotals.total) * 100}%` }}
                  />
                </div>
              </div>
            )}

            {/* CNSS Status */}
            {cnssLoading && (
              <div className="mt-4 flex items-center justify-center gap-2 px-4 py-3 bg-blue-100 rounded-xl text-sm text-blue-700 font-medium">
                <svg className="animate-spin h-4 w-4" viewBox="0 0 24 24">
                  <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4" fill="none" />
                  <path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8v4a4 4 0 00-4 4H4z" />
                </svg>
                Checking CNSS approval...
              </div>
            )}
            {cnss.approved && (
              <div className="mt-4 flex items-center justify-center gap-2 px-4 py-3 bg-green-100 rounded-xl text-sm text-green-700 font-medium">
                <FiCheckCircle className="h-4 w-4" />
                CNSS Approved: {cnss.code}
              </div>
            )}
          </div>
        </div>
      )}

      {/* Submit Section - Enhanced */}
      <div className="bg-white/90 backdrop-blur rounded-2xl shadow-xl ring-1 ring-slate-900/5 p-6 sticky bottom-4 z-10">
        <div className="flex flex-col sm:flex-row items-center justify-between gap-4">
          {/* Confidence Indicator */}
          <div className="flex items-center gap-3">
            {isSectionComplete('patientInfo') && isSectionComplete('medications') ? (
              <div className="flex items-center gap-2 px-4 py-2 bg-green-100 text-green-700 rounded-xl font-medium text-sm">
                <FiCheckCircle className="h-5 w-5" />
                <span>Ready to submit</span>
              </div>
            ) : (
              <div className="flex items-center gap-2 px-4 py-2 bg-amber-100 text-amber-700 rounded-xl font-medium text-sm">
                <FiAlertCircle className="h-5 w-5" />
                <span>Complete all required fields</span>
              </div>
            )}
            <div className="hidden sm:block text-xs text-slate-500">
              <kbd className="px-2 py-1 bg-slate-100 rounded border border-slate-300 font-mono">Cmd</kbd> +
              <kbd className="ml-1 px-2 py-1 bg-slate-100 rounded border border-slate-300 font-mono">Enter</kbd>
              <span className="ml-2">to submit</span>
            </div>
          </div>

          {/* Action Buttons */}
          <div className="flex items-center gap-3 w-full sm:w-auto">
            <button
              type="button"
              onClick={() => navigate('/')}
              className="flex-1 sm:flex-none px-6 py-3 border-2 border-slate-300 rounded-xl text-sm font-semibold text-slate-700 hover:bg-slate-50 hover:border-slate-400 transition-all focus:outline-none focus:ring-2 focus:ring-slate-400"
            >
              {t('common.cancel')}
            </button>
            <button
              type="submit"
              disabled={isLoading || (!isSectionComplete('patientInfo') || !isSectionComplete('medications'))}
              className={`flex-1 sm:flex-none inline-flex items-center justify-center gap-2 px-8 py-3 text-sm font-bold rounded-xl text-white bg-gradient-to-r from-emerald-500 to-teal-400 shadow-lg ring-1 ring-white/10 transition-all ${isLoading || (!isSectionComplete('patientInfo') || !isSectionComplete('medications'))
                ? 'opacity-60 cursor-not-allowed'
                : 'hover:from-emerald-400 hover:to-teal-300 hover:shadow-xl hover:scale-105'
                }`}
            >
              {isLoading ? (
                <>
                  <svg className="animate-spin h-5 w-5" viewBox="0 0 24 24">
                    <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4" fill="none" />
                    <path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8v4a4 4 0 00-4 4H4z" />
                  </svg>
                  Creating Prescription...
                </>
              ) : (
                <>
                  <FiCheckCircle className="h-5 w-5" />
                  {t('doctor.createPrescription') || 'Create Prescription'}
                </>
              )}
            </button>
          </div>
        </div>
      </div>
    </form>
  );


  const downloadPdf = async () => {
    try {
      const token = localStorage.getItem('auth_token');
      const resp = await fetch(`/api/prescriptions/${createdPrescription.id}/pdf`, { headers: { ...(token ? { Authorization: `Bearer ${token}` } : {}) } });
      const data = await resp.json();
      if (!resp.ok || !data.success) throw new Error(data?.error || 'Failed to download PDF');
      const byteCharacters = atob(data.base64);
      const byteNumbers = new Array(byteCharacters.length);
      for (let i = 0; i < byteCharacters.length; i++) byteNumbers[i] = byteCharacters.charCodeAt(i);
      const blob = new Blob([new Uint8Array(byteNumbers)], { type: 'application/pdf' });
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = data.filename || `Prescription_${createdPrescription.id}.pdf`;
      document.body.appendChild(a);
      a.click();
      a.remove();
      URL.revokeObjectURL(url);
    } catch (e) {
      alert(e.message);
    }
  };

  const handlePrint = async () => {
    try {
      const token = localStorage.getItem('auth_token');
      const resp = await fetch(`/api/prescriptions/${createdPrescription.id}/pdf`, { headers: { ...(token ? { Authorization: `Bearer ${token}` } : {}) } });
      const data = await resp.json();
      if (!resp.ok || !data.success) throw new Error(data?.error || 'Failed to load PDF for printing');

      // Create blob and open print dialog
      const byteCharacters = atob(data.base64);
      const byteNumbers = new Array(byteCharacters.length);
      for (let i = 0; i < byteCharacters.length; i++) byteNumbers[i] = byteCharacters.charCodeAt(i);
      const blob = new Blob([new Uint8Array(byteNumbers)], { type: 'application/pdf' });
      const url = URL.createObjectURL(blob);

      // Open in new window and trigger print
      const printWindow = window.open(url, '_blank');
      if (printWindow) {
        printWindow.addEventListener('load', () => {
          printWindow.print();
        });
      }

      // Clean up after a delay
      setTimeout(() => URL.revokeObjectURL(url), 10000);
    } catch (e) {
      alert(e.message);
    }
  };

  const handleRevoke = async () => {
    if (!confirm('Are you sure you want to revoke this prescription? This action cannot be undone.')) {
      return;
    }

    setRevoking(true);
    setRevokeError('');

    try {
      const token = localStorage.getItem('auth_token');
      const resp = await fetch('/api/cancel', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          ...(token ? { Authorization: `Bearer ${token}` } : {})
        },
        body: JSON.stringify({
          prescriptionId: createdPrescription.id,
          topicID: createdPrescription.qr?.data?.t,
          reason: 'Revoked by doctor'
        })
      });

      const data = await resp.json();
      if (!resp.ok || !data.success) {
        throw new Error(data?.error || 'Failed to revoke prescription');
      }

      setRevoked(true);
      alert('Prescription revoked successfully');
    } catch (e) {
      setRevokeError(e.message);
      alert(`Failed to revoke: ${e.message}`);
    } finally {
      setRevoking(false);
    }
    qrData = { qrData }
    onCreateAnother = {() => {
  setStep(1);
  setCreatedPrescription(null);
  setCnss({ approved: false, code: null });
  setPrescriptionData({
    patientId: '',
    patientName: '',
    patientEmail: '',
    patientPhone: '',
    contactMethod: 'email',
    age: '',
    diagnosis: '',
    maxDispenses: 1,
    medications: [{
      name: '',
      dosage: '',
      unit: 'mg',
      frequency: '1',
      duration: '7',
      durationUnit: 'days',
      instructions: ''
    }]
  });
  setError('');
  setRevokeError('');
  setRevoked(false);

  // Clear draft and session flag for new prescription
  localStorage.removeItem('prescription_draft');
  sessionStorage.removeItem('draft_asked');
}}
onViewHistory = {() => navigate('/history')}
onDownload = { downloadPdf }
onPrint = { handlePrint }
onRevoke = { handleRevoke }
  />
    );
  };

// Show skeleton while medicines are loading on initial render
if (medicinesLoading && medicines.length === 0) {
  return (
    <div className="max-w-5xl mx-auto py-8 px-4 sm:px-6 lg:px-8">
      <div className="mb-8">
        <Skeleton className="h-10 w-64 mb-6" />
        <Skeleton className="h-4 w-96" />
      </div>
      <Skeleton.Form />
    </div>
  );
}

// Toggle section expansion
const toggleSection = (section) => {
  setSectionsExpanded(prev => ({ ...prev, [section]: !prev[section] }));
};

// Check if section is complete
const isSectionComplete = (section) => {
  if (section === 'patientInfo') {
    return prescriptionData.patientName && prescriptionData.patientId &&
      prescriptionData.age && prescriptionData.diagnosis &&
      (prescriptionData.contactMethod === 'email' ? prescriptionData.patientEmail : prescriptionData.patientPhone);
  }
  if (section === 'medications') {
    return prescriptionData.medications.some(m => m.name);
  }
  return false;
};

return (
  <div className="min-h-screen bg-gradient-to-br from-slate-50 via-emerald-50/30 to-teal-50/20">
    <div className="max-w-6xl mx-auto py-8 px-4 sm:px-6 lg:px-8">
      {step === 1 && (
        <div className="mb-8">
          <div className="text-center mb-6">
            <h1 className="text-4xl font-extrabold tracking-tight bg-gradient-to-r from-emerald-600 to-teal-500 bg-clip-text text-transparent mb-3">
              {t('doctor.newPrescription')}
            </h1>
            <p className="text-slate-600 text-sm">Create and submit prescriptions securely on Hedera blockchain</p>
          </div>
          <StepIndicator
            steps={['Create Prescription', 'Success']}
            currentStep={step}
          />
        </div>
      )}

      {step === 2 && (
        <div className="mb-8">
          <StepIndicator
            steps={['Create Prescription', 'Success']}
            currentStep={step}
          />
        </div>
      )}

      {error && (
        <Alert
          variant="danger"
          className="mb-6"
          title="Error Creating Prescription"
        >
          <div className="flex items-start justify-between gap-3">
            <span className="text-sm flex-1">{error}</span>
            <button
              onClick={() => {
                setError('');
                if (step === 1) {
                  // Retry form submission
                  const form = document.querySelector('form');
                  if (form) form.requestSubmit();
                }
              }}
              className="px-3 py-1 text-xs font-medium rounded-md bg-red-100 hover:bg-red-200 text-red-800 transition-colors"
            >
              Retry
            </button>
          </div>
        </Alert>
      )}

      {step === 1 ? renderStep1() : renderStep2()}
    </div>
  </div>
);
};

export default DoctorForm;
